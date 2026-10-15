pub mod schema;
mod transport;

use fs2::FileExt;
use schema::{Catalog, CatalogEntry, DownloadStatus};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Default, Serialize, Deserialize)]
struct Part {
    received: u64,
    verified: bool,
    etag: Option<String>,
    source: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Journal {
    #[serde(default = "download_origin")]
    origin: String,
    revision: String,
    phase: String,
    parts: Vec<Vec<Part>>,
}
fn download_origin() -> String {
    "download".into()
}
struct Job {
    persist: Mutex<()>,
    state: Mutex<DownloadStatus>,
    journal: Mutex<Journal>,
    control: AtomicU8,
    running: AtomicBool,
}
struct Inner {
    root: PathBuf,
    catalog: Catalog,
    jobs: HashMap<String, Arc<Job>>,
    emit: Arc<dyn Fn(DownloadStatus) + Send + Sync>,
}
#[derive(Clone)]
pub struct ModelManager(Arc<Inner>);
fn error(e: impl std::fmt::Display) -> String {
    format!("模型文件处理失败：{e}")
}
fn durable_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let tmp = path.with_extension("json.next");
    let mut file = File::create(&tmp).map_err(error)?;
    file.write_all(&serde_json::to_vec(value).map_err(error)?)
        .map_err(error)?;
    file.sync_all().map_err(error)?;
    fs::rename(tmp, path).map_err(error)?;
    File::open(path.parent().ok_or("无效文件目录")?)
        .and_then(|f| f.sync_all())
        .map_err(error)
}
#[cfg(test)]
mod tests;
fn hash_range(file: &mut File, offset: u64, size: u64) -> Result<String, String> {
    file.seek(SeekFrom::Start(offset)).map_err(error)?;
    let mut remaining = size;
    let mut sha = Sha256::new();
    let mut buffer = [0u8; 65536];
    while remaining > 0 {
        let n = file
            .read(&mut buffer[..remaining.min(65536) as usize])
            .map_err(error)?;
        if n == 0 {
            return Err("文件不完整".into());
        }
        sha.update(&buffer[..n]);
        remaining -= n as u64;
    }
    Ok(format!("{:x}", sha.finalize()))
}
fn allowed(url: &reqwest::Url) -> bool {
    if cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1") {
        return true;
    }
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && [
            "github.com",
            "githubusercontent.com",
            "githubassets.com",
            "huggingface.co",
            "hf-mirror.com",
            "hf.co",
            "xethub.hf.co",
            "modelscope.cn",
            "modelscope.ai",
            "aliyuncs.com",
        ]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}
impl ModelManager {
    pub fn new(
        root: PathBuf,
        catalog: Catalog,
        emit: Arc<dyn Fn(DownloadStatus) + Send + Sync>,
    ) -> Result<Self, String> {
        catalog.validate()?;
        fs::create_dir_all(root.join(".downloads")).map_err(error)?;
        fs::create_dir_all(root.join(".locks")).map_err(error)?;
        let mut jobs = HashMap::new();
        let mut resume = Vec::new();
        for e in &catalog.entries {
            let empty = Journal {
                origin: "download".into(),
                revision: e.revision.clone(),
                phase: "not_installed".into(),
                parts: e
                    .files
                    .iter()
                    .map(|a| vec![Part::default(); a.chunks.len()])
                    .collect(),
            };
            let mut journal = fs::read(root.join(".downloads").join(&e.id).join("journal.json"))
                .ok()
                .and_then(|v| serde_json::from_slice::<Journal>(&v).ok())
                .filter(|j| {
                    j.revision == e.revision
                        && j.parts.len() == e.files.len()
                        && j.parts
                            .iter()
                            .zip(&e.files)
                            .all(|(p, a)| p.len() == a.chunks.len())
                })
                .unwrap_or(empty);
            let mut status = DownloadStatus::new(e);
            let dest = root.join("installed").join(&e.id).join(&e.revision);
            if dest.join(".installed.json").is_file()
                && e.files.iter().all(|a| {
                    fs::symlink_metadata(dest.join(&a.name))
                        .is_ok_and(|m| m.is_file() && m.len() == a.size)
                })
            {
                status.phase = "ready".into();
                status.downloaded_bytes = status.total_bytes;
                status.path = Some(dest.to_string_lossy().into());
                journal.phase = "ready".into();
            } else {
                status.phase = journal.phase.clone();
                status.downloaded_bytes = journal.parts.iter().flatten().map(|p| p.received).sum();
                if [
                    "downloading",
                    "checking",
                    "verifying",
                    "installing",
                    "waiting_network",
                ]
                .contains(&status.phase.as_str())
                {
                    if journal.origin == "import" {
                        status.phase = "error".into();
                        status.error = Some("上次本地导入未完成，请重新选择模型目录".into());
                    } else {
                        resume.push(e.id.clone());
                    }
                }
                if status.phase == "ready" {
                    status.phase = "not_installed".into();
                }
            }
            let control = if status.phase == "paused" {
                1
            } else if status.phase == "cancelled" {
                2
            } else {
                0
            };
            jobs.insert(
                e.id.clone(),
                Arc::new(Job {
                    persist: Mutex::new(()),
                    state: Mutex::new(status),
                    journal: Mutex::new(journal),
                    control: AtomicU8::new(control),
                    running: AtomicBool::new(false),
                }),
            );
        }
        let manager = Self(Arc::new(Inner {
            root,
            catalog,
            jobs,
            emit,
        }));
        for id in resume {
            let _ = manager.download(&id);
        }
        Ok(manager)
    }
    pub fn catalog(&self) -> Vec<CatalogEntry> {
        self.0.catalog.entries.clone()
    }
    pub fn statuses(&self) -> Vec<DownloadStatus> {
        self.0
            .catalog
            .entries
            .iter()
            .map(|e| self.0.jobs[&e.id].state.lock().unwrap().clone())
            .collect()
    }
    fn entry(&self, id: &str) -> Result<CatalogEntry, String> {
        self.0
            .catalog
            .entries
            .iter()
            .find(|e| e.id == id)
            .cloned()
            .ok_or("未知模型组件".into())
    }
    fn staging(&self, e: &CatalogEntry) -> PathBuf {
        self.0.root.join(".downloads").join(&e.id)
    }
    fn save(&self, e: &CatalogEntry, job: &Job) -> Result<(), String> {
        let _guard = job.persist.lock().map_err(|_| "下载进度锁不可用")?;
        durable_json(
            &self.staging(e).join("journal.json"),
            &*job.journal.lock().unwrap(),
        )
    }
    fn phase(
        &self,
        e: &CatalogEntry,
        job: &Job,
        phase: &str,
        reason: Option<String>,
    ) -> Result<(), String> {
        job.journal.lock().unwrap().phase = phase.into();
        {
            let mut state = job.state.lock().unwrap();
            state.phase = phase.into();
            state.error = reason;
        }
        self.save(e, job)?;
        self.emit(job);
        Ok(())
    }
    pub fn installed_path(&self, id: &str) -> Option<PathBuf> {
        let job = self.0.jobs.get(id)?;
        let state = job.state.lock().ok()?;
        if state.phase == "ready" {
            state.path.as_ref().map(PathBuf::from)
        } else {
            None
        }
    }
    fn emit(&self, job: &Job) {
        let snapshot = job.state.lock().unwrap().clone();
        (self.0.emit)(snapshot);
    }
    pub fn download(&self, id: &str) -> Result<(), String> {
        let e = self.entry(id)?;
        if !e.enabled {
            return Err("下载渠道尚未发布或验证，可先导入本地模型".into());
        }
        let job = self.0.jobs[id].clone();
        if self.installed_path(id).is_some() {
            return Ok(());
        }
        if job.running.load(Ordering::Acquire) {
            if job.control.load(Ordering::Acquire) == 2 {
                return Err("正在取消并清理文件，请稍后重试".into());
            }
            if job.control.swap(0, Ordering::AcqRel) == 1 {
                self.phase(&e, &job, "downloading", None)?;
            }
            return Ok(());
        }
        let lock = self.lock(&e)?;
        job.control.store(0, Ordering::Release);
        job.journal.lock().unwrap().origin = "download".into();
        if job.running.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let manager = self.clone();
        thread::spawn(move || {
            manager.run(e, job, lock);
        });
        Ok(())
    }
    pub fn control(&self, id: &str, action: &str) -> Result<(), String> {
        let e = self.entry(id)?;
        let job = &self.0.jobs[id];
        if self.installed_path(id).is_some() {
            return Err("该模型已安装，无需暂停或取消".into());
        }
        let _lock = if action != "resume" && !job.running.load(Ordering::Acquire) {
            Some(self.lock(&e)?)
        } else {
            None
        };
        fs::create_dir_all(self.staging(&e)).map_err(error)?;
        match action {
            "pause" => {
                job.control.store(1, Ordering::Release);
                self.phase(&e, job, "paused", None)
            }
            "cancel" => {
                job.control.store(2, Ordering::Release);
                if !job.running.load(Ordering::Acquire) {
                    let payload = self.staging(&e).join("payload");
                    if payload.is_dir() {
                        fs::remove_dir_all(payload).map_err(error)?;
                    }
                    for parts in &mut job.journal.lock().unwrap().parts {
                        for part in parts {
                            *part = Part::default();
                        }
                    }
                    job.state.lock().unwrap().downloaded_bytes = 0;
                }
                self.phase(&e, job, "cancelled", None)
            }
            "resume" => self.download(id),
            _ => Err("未知下载操作".into()),
        }
    }
    fn check(&self, e: &CatalogEntry, job: &Job) -> Result<(), String> {
        loop {
            match job.control.load(Ordering::Acquire) {
                0 => return Ok(()),
                2 => return Err("cancelled".into()),
                _ => {
                    if job.state.lock().unwrap().phase != "paused" {
                        self.phase(e, job, "paused", None)?;
                    }
                    thread::sleep(Duration::from_millis(200));
                }
            }
        }
    }
    fn lock(&self, e: &CatalogEntry) -> Result<File, String> {
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.0.root.join(".locks").join(format!("{}.lock", e.id)))
            .map_err(error)?;
        f.try_lock_exclusive()
            .map_err(|_| "另一个 Moyu 正在处理该模型".to_owned())?;
        Ok(f)
    }
    fn run(&self, e: CatalogEntry, job: Arc<Job>, _lock: File) {
        let result = (|| {
            fs::create_dir_all(self.staging(&e).join("payload")).map_err(error)?;
            self.fetch(&e, &job)
        })();
        if let Err(reason) = result {
            let phase = if job.control.load(Ordering::Acquire) == 2 {
                "cancelled"
            } else {
                "error"
            };
            let _ = self.phase(
                &e,
                &job,
                phase,
                if phase == "error" { Some(reason) } else { None },
            );
            if phase == "cancelled" {
                let payload = self.staging(&e).join("payload");
                if payload.is_dir() {
                    let _ = fs::remove_dir_all(payload);
                }
                for parts in &mut job.journal.lock().unwrap().parts {
                    for p in parts {
                        *p = Part::default();
                    }
                }
                job.state.lock().unwrap().downloaded_bytes = 0;
                let _ = self.save(&e, &job);
                self.emit(&job);
            }
        }
        job.running.store(false, Ordering::Release);
    }
    fn fetch(&self, e: &CatalogEntry, job: &Job) -> Result<(), String> {
        self.phase(e, job, "checking", None)?;
        let payload = self.staging(e).join("payload");
        let needed = e.files.iter().map(|a| a.size).sum::<u64>();
        let allocated = e
            .files
            .iter()
            .filter_map(|a| fs::metadata(payload.join(&a.name)).ok())
            .map(|m| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    m.blocks() * 512
                }
                #[cfg(not(unix))]
                {
                    m.len()
                }
            })
            .sum::<u64>();
        if fs2::available_space(&payload).map_err(error)?
            < needed.saturating_sub(allocated) + 64 * 1024 * 1024
        {
            return Err("磁盘可用空间不足".into());
        }
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::custom(|a| {
                if a.previous().len() >= 8 {
                    a.error("too many redirects")
                } else if allowed(a.url()) {
                    a.follow()
                } else {
                    a.error("unapproved redirect")
                }
            }))
            .build()
            .map_err(|_| "无法初始化下载连接")?;
        for (fi, a) in e.files.iter().enumerate() {
            self.check(e, job)?;
            let path = payload.join(&a.name);
            if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("暂存文件不能是符号链接".into());
            }
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(path)
                .map_err(error)?;
            file.set_len(a.size).map_err(error)?;
            for (ci, c) in a.chunks.iter().enumerate() {
                let saved = job.journal.lock().unwrap().parts[fi][ci].clone();
                if saved.verified && hash_range(&mut file, c.offset, c.size)? == c.sha256 {
                    continue;
                }
                {
                    let mut j = job.journal.lock().unwrap();
                    let p = &mut j.parts[fi][ci];
                    p.verified = false;
                    if p.received > c.size {
                        *p = Part::default();
                    }
                }
                loop {
                    self.check(e, job)?;
                    let mut complete = false;
                    for source in &c.sources {
                        if !reqwest::Url::parse(&source.url).is_ok_and(|u| allowed(&u)) {
                            continue;
                        }
                        for _attempt in 0..3 {
                            self.check(e, job)?;
                            self.phase(e, job, "downloading", None)?;
                            let p = job.journal.lock().unwrap().parts[fi][ci].clone();
                            let etag = if p.source.as_deref() == Some(&source.id) {
                                p.etag.as_deref()
                            } else {
                                None
                            };
                            let mut since = Instant::now();
                            let mut syncfile = file.try_clone().map_err(error)?;
                            let outcome = transport::transfer(
                                &client,
                                &source.url,
                                &mut file,
                                c,
                                p.received,
                                etag,
                                &mut |bytes, tag| {
                                    if job.control.load(Ordering::Acquire) != 0 {
                                        return Err("interrupted".into());
                                    }
                                    if bytes == 0
                                        || since.elapsed() > Duration::from_millis(500)
                                        || bytes == c.size
                                    {
                                        syncfile.flush().map_err(error)?;
                                        syncfile.sync_data().map_err(error)?;
                                        {
                                            let mut j = job.journal.lock().unwrap();
                                            j.parts[fi][ci] = Part {
                                                received: bytes,
                                                verified: false,
                                                etag: tag,
                                                source: Some(source.id.clone()),
                                            };
                                        }
                                        self.save(e, job)?;
                                        self.progress(e, job, &source.id);
                                        since = Instant::now();
                                    }
                                    Ok(())
                                },
                            );
                            file.sync_data().map_err(error)?;
                            self.save(e, job)?;
                            if outcome.is_ok()
                                && hash_range(&mut file, c.offset, c.size)? == c.sha256
                            {
                                job.journal.lock().unwrap().parts[fi][ci].verified = true;
                                self.save(e, job)?;
                                complete = true;
                                break;
                            }
                            if outcome.is_ok() {
                                job.journal.lock().unwrap().parts[fi][ci] = Part::default();
                                self.save(e, job)?;
                            }
                            if job.control.load(Ordering::Acquire) != 0 {
                                self.check(e, job)?;
                            }
                        }
                        if complete {
                            break;
                        }
                    }
                    if complete {
                        break;
                    }
                    self.phase(
                        e,
                        job,
                        "waiting_network",
                        Some("下载源暂时不可用，将自动重试；已保留进度".into()),
                    )?;
                    for _ in 0..150 {
                        self.check(e, job)?;
                        thread::sleep(Duration::from_millis(200));
                    }
                }
            }
            self.phase(e, job, "verifying", None)?;
            if hash_range(&mut file, 0, a.size)? != a.sha256 {
                return Err("完整文件 SHA-256 校验失败".into());
            }
            file.sync_all().map_err(error)?;
        }
        self.install(e, job)
    }
    fn progress(&self, e: &CatalogEntry, job: &Job, source: &str) {
        let bytes = job
            .journal
            .lock()
            .unwrap()
            .parts
            .iter()
            .flatten()
            .map(|p| p.received)
            .sum();
        let mut state = job.state.lock().unwrap();
        state.downloaded_bytes = bytes;
        state.source = Some(source.into());
        state.error = None;
        drop(state);
        self.emit(job);
        let _ = e;
    }
    fn install(&self, e: &CatalogEntry, job: &Job) -> Result<(), String> {
        self.check(e, job)?;
        self.phase(e, job, "installing", None)?;
        let payload = self.staging(e).join("payload");
        #[cfg(unix)]
        if e.kind == "backend" {
            use std::os::unix::fs::PermissionsExt;
            let worker = payload.join("nv-worker");
            if worker.is_file() {
                fs::set_permissions(worker, fs::Permissions::from_mode(0o755)).map_err(error)?;
            }
        }
        durable_json(&payload.join(".installed.json"), e)?;
        let parent = self.0.root.join("installed").join(&e.id);
        fs::create_dir_all(&parent).map_err(error)?;
        let dest = parent.join(&e.revision);
        if dest.exists() {
            return Err("安装目标已存在，未覆盖现有文件".into());
        }
        fs::rename(payload, &dest).map_err(error)?;
        File::open(&parent)
            .and_then(|f| f.sync_all())
            .map_err(error)?;
        {
            let mut state = job.state.lock().unwrap();
            state.downloaded_bytes = state.total_bytes;
            state.path = Some(dest.to_string_lossy().into());
        }
        self.phase(e, job, "ready", None)
    }
    pub fn import(&self, id: &str, directory: &Path) -> Result<(), String> {
        let e = self.entry(id)?;
        let job = self.0.jobs[id].clone();
        if self.installed_path(id).is_some() {
            return Ok(());
        }
        if job.running.load(Ordering::Acquire) {
            return Err("该模型正在下载或导入".into());
        }
        let _lock = self.lock(&e)?;
        if job.running.swap(true, Ordering::AcqRel) {
            return Err("该模型正在下载或导入".into());
        }
        job.control.store(0, Ordering::Release);
        job.journal.lock().unwrap().origin = "import".into();
        let result = (|| {
            let payload = self.staging(&e).join("payload");
            fs::create_dir_all(&payload).map_err(error)?;
            self.phase(&e, &job, "checking", None)?;
            if fs2::available_space(&payload).map_err(error)?
                < e.files.iter().map(|a| a.size).sum::<u64>() + 64 * 1024 * 1024
            {
                return Err("磁盘可用空间不足".into());
            }
            for (fi, a) in e.files.iter().enumerate() {
                self.check(&e, &job)?;
                let source = directory.join(&a.name);
                let meta = fs::symlink_metadata(&source).map_err(error)?;
                if !meta.is_file() || meta.len() != a.size {
                    return Err(format!("本地模型文件无效：{}", a.name));
                }
                let target = payload.join(&a.name);
                if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
                    return Err("暂存路径无效".into());
                }
                fs::copy(source, &target).map_err(error)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&target, fs::Permissions::from_mode(0o600))
                        .map_err(error)?;
                }
                self.check(&e, &job)?;
                let mut file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(target)
                    .map_err(error)?;
                self.phase(&e, &job, "verifying", None)?;
                if hash_range(&mut file, 0, a.size)? != a.sha256 {
                    return Err(format!("本地文件校验失败：{}", a.name));
                }
                file.sync_all().map_err(error)?;
                for (ci, c) in a.chunks.iter().enumerate() {
                    job.journal.lock().unwrap().parts[fi][ci] = Part {
                        received: c.size,
                        verified: true,
                        ..Default::default()
                    };
                }
                self.save(&e, &job)?;
            }
            self.install(&e, &job)
        })();
        if let Err(reason) = &result {
            if job.control.load(Ordering::Acquire) == 2 {
                let payload = self.staging(&e).join("payload");
                if payload.is_dir() {
                    let _ = fs::remove_dir_all(payload);
                }
                for parts in &mut job.journal.lock().unwrap().parts {
                    for p in parts {
                        *p = Part::default();
                    }
                }
                job.state.lock().unwrap().downloaded_bytes = 0;
                let _ = self.phase(&e, &job, "cancelled", None);
                job.running.store(false, Ordering::Release);
                return Ok(());
            }
            let _ = self.phase(&e, &job, "error", Some(reason.clone()));
        }
        job.running.store(false, Ordering::Release);
        result
    }
}
