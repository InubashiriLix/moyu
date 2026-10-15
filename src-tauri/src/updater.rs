//! Explicit GitHub AppImage updates. Never elevate privileges or touch models.
use fs2::FileExt;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const API: &str = "https://api.github.com/repos/InubashiriLix/moyu/releases/latest";
const DOWNLOAD_BASE: &str = "https://github.com/InubashiriLix/moyu/releases/download/";
const MAX_IMAGE: u64 = 1024 * 1024 * 1024;
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    phase: String,
    current_version: String,
    latest_version: Option<String>,
    downloaded_bytes: u64,
    total_bytes: u64,
    path: Option<String>,
    error: Option<String>,
    can_install: bool,
    install_note: String,
}
#[derive(Clone, Deserialize)]
struct Asset {
    name: String,
    size: u64,
    digest: Option<String>,
    browser_download_url: String,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Clone)]
struct Update {
    version: String,
    asset: Asset,
    sha256: String,
}
struct Inner {
    root: PathBuf,
    appimage: Option<PathBuf>,
    state: Mutex<Status>,
    update: Mutex<Option<Update>>,
    busy: AtomicBool,
    cancel: AtomicBool,
    emit: Arc<dyn Fn(Status) + Send + Sync>,
}
#[derive(Clone)]
pub struct Updater(Arc<Inner>);
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn error(e: impl std::fmt::Display) -> String {
    format!("更新文件操作失败：{e}")
}
fn allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|h| {
            h == "api.github.com"
                || h == "github.com"
                || h == "githubusercontent.com"
                || h.ends_with(".githubusercontent.com")
        })
}
fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("Moyu/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() < 8 && allowed(a.url()) {
                a.follow()
            } else {
                a.error("不允许的更新重定向")
            }
        }))
        .build()
        .map_err(|_| "无法初始化更新连接".into())
}
fn select(release: Release, current: &str) -> Result<Option<Update>, String> {
    if release.draft || release.prerelease {
        return Err("更新渠道没有稳定版本".into());
    }
    let version = release.tag_name.strip_prefix('v').ok_or("版本号无效")?;
    let latest = semver::Version::parse(version).map_err(|_| "版本号无效")?;
    let current = semver::Version::parse(current).map_err(|_| "当前版本号无效")?;
    if !latest.pre.is_empty() {
        return Err("更新渠道不是稳定版本".into());
    }
    if latest <= current {
        return Ok(None);
    }
    let name = format!("Moyu_{version}_light_arch_x86_64.AppImage");
    let asset = release
        .assets
        .into_iter()
        .find(|a| a.name == name)
        .ok_or("此版本未提供兼容的 Linux x86_64 完整朗读包")?;
    if asset.size < 1024 || asset.size > MAX_IMAGE {
        return Err("更新包大小无效".into());
    }
    if asset.browser_download_url != format!("{DOWNLOAD_BASE}{}/{name}", release.tag_name) {
        return Err("更新包地址不属于本项目".into());
    }
    let sha256 = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .filter(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("GitHub 未提供更新包的 SHA-256，暂不允许下载")?
        .to_lowercase();
    Ok(Some(Update {
        version: version.into(),
        asset,
        sha256,
    }))
}
fn regular(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
}
fn digest(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(error)?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = file.read(&mut buf).map_err(error)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
impl Updater {
    pub fn new(
        root: PathBuf,
        appimage: Option<PathBuf>,
        emit: Arc<dyn Fn(Status) + Send + Sync>,
    ) -> Self {
        Self(Arc::new(Inner {
            root,
            appimage,
            state: Mutex::new(Status {
                phase: "idle".into(),
                current_version: env!("CARGO_PKG_VERSION").into(),
                ..Default::default()
            }),
            update: Mutex::new(None),
            busy: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            emit,
        }))
    }
    pub fn status(&self) -> Status {
        self.0.state.lock().unwrap().clone()
    }
    fn change(&self, f: impl FnOnce(&mut Status)) -> Status {
        let status = {
            let mut s = self.0.state.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        (self.0.emit)(status.clone());
        status
    }
    fn begin(&self) -> Result<Busy<'_>, String> {
        self.0
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "更新操作仍在进行，请稍候")?;
        self.0.cancel.store(false, Ordering::Release);
        Ok(Busy(&self.0.busy))
    }
    fn finish(&self, result: Result<(), String>) -> Result<Status, String> {
        if let Err(e) = result {
            self.change(|s| {
                s.phase = if self.0.cancel.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "error"
                }
                .into();
                s.error = Some(e.clone());
            });
            return Err(e);
        }
        Ok(self.status())
    }
    fn locked(&self) -> Result<File, String> {
        fs::create_dir_all(&self.0.root).map_err(error)?;
        let p = self.0.root.join(".lock");
        if p.is_symlink() {
            return Err("更新锁不能是符号链接".into());
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(p)
            .map_err(error)?;
        file.try_lock_exclusive()
            .map_err(|_| "另一个 Moyu 正在处理更新")?;
        Ok(file)
    }
    fn permissions(&self) -> (bool, String) {
        let Some(path) = &self.0.appimage else {
            return (
                false,
                "当前不是 AppImage 安装；可下载新版，按原安装方式更新。".into(),
            );
        };
        if !regular(path) {
            return (
                false,
                "当前程序路径不是普通文件，请手动安装下载的新版。".into(),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let Ok(meta) = fs::metadata(path) else {
                return (false, "无法读取当前安装权限。".into());
            };
            if fs::metadata(&self.0.root).is_ok_and(|m| m.uid() != meta.uid())
                || meta.mode() & 0o200 == 0
            {
                return (false, "当前 AppImage 由其他用户（例如 root）所有或只读。新版仍可下载到用户目录；请按原来的安装方式替换，程序不会自行使用 sudo。".into());
            }
        }
        let Some(parent) = path.parent() else {
            return (false, "无法确定安装目录。".into());
        };
        let probe = parent.join(format!(".moyu-update-permission-{}", std::process::id()));
        match OpenOptions::new().create_new(true).write(true).open(&probe) {
            Ok(_) => {
                let _ = fs::remove_file(probe);
                (
                    true,
                    "可原地更新；安装前保留旧版备份，安装后退出，重新打开生效。".into(),
                )
            }
            Err(_) => (
                false,
                "安装目录不可写；新版仍可下载到用户目录，请手动替换原程序。".into(),
            ),
        }
    }
    pub fn check(&self) -> Result<Status, String> {
        let _busy = self.begin()?;
        self.change(|s| {
            s.phase = "checking".into();
            s.error = None;
        });
        self.finish((|| {
            if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
                return Err("目前应用内更新仅提供 Linux x86_64 AppImage".into());
            }
            fs::create_dir_all(&self.0.root).map_err(error)?;
            let response = client()?
                .get(API)
                .send()
                .map_err(|_| "无法连接 GitHub 更新服务，请稍后重试")?;
            if !response.status().is_success() {
                return Err("GitHub 更新服务暂不可用或请求次数已达上限，请稍后重试".into());
            }
            let mut data = Vec::new();
            response
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut data)
                .map_err(|_| "读取更新信息失败")?;
            if data.len() > 2 * 1024 * 1024 {
                return Err("更新信息过大".into());
            }
            let release: Release = serde_json::from_slice(&data).map_err(|_| "更新信息格式无效")?;
            let update = select(release, env!("CARGO_PKG_VERSION"))?;
            let (can_install, note) = self.permissions();
            self.change(|s| {
                s.phase = if update.is_some() {
                    "available"
                } else {
                    "latest"
                }
                .into();
                s.latest_version = update.as_ref().map(|u| u.version.clone());
                s.total_bytes = update.as_ref().map_or(0, |u| u.asset.size);
                s.downloaded_bytes = 0;
                s.path = None;
                s.can_install = can_install;
                s.install_note = note;
            });
            *self.0.update.lock().unwrap() = update;
            Ok(())
        })())
    }
    pub fn cancel(&self) {
        self.0.cancel.store(true, Ordering::Release);
    }
    pub fn download(&self) -> Result<Status, String> {
        let _busy = self.begin()?;
        self.finish((|| {
            let update = self
                .0
                .update
                .lock()
                .unwrap()
                .clone()
                .ok_or("请先检查更新")?;
            let _lock = self.locked()?;
            let target = self.0.root.join(&update.asset.name);
            let partial = self
                .0
                .root
                .join(format!("{}.{}.part", update.asset.name, update.sha256));
            if target.is_symlink() || partial.is_symlink() {
                return Err("更新文件不能是符号链接".into());
            }
            if regular(&target)
                && fs::metadata(&target).map_err(error)?.len() == update.asset.size
                && digest(&target)? == update.sha256
            {
                self.ready(&target, &update);
                return Ok(());
            }
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&partial)
                .map_err(error)?;
            if file.metadata().map_err(error)?.len() > update.asset.size {
                file.set_len(0).map_err(error)?;
            }
            let remaining = update.asset.size - file.metadata().map_err(error)?.len();
            if fs2::available_space(&self.0.root).map_err(error)? < remaining + 16 * 1024 * 1024 {
                return Err("下载目录空间不足".into());
            }
            self.change(|s| {
                s.phase = "downloading".into();
                s.error = None;
                s.downloaded_bytes = update.asset.size - remaining;
            });
            let chunk = crate::models::schema::Chunk {
                offset: 0,
                size: update.asset.size,
                sha256: update.sha256.clone(),
                sources: vec![],
            };
            let http = client()?;
            for attempt in 0..3 {
                if self.0.cancel.load(Ordering::Acquire) {
                    return Err("下载已取消，已保留进度".into());
                }
                let received = file.metadata().map_err(error)?.len();
                if received == update.asset.size {
                    break;
                }
                let mut last = Instant::now() - Duration::from_secs(1);
                let mut last_received = received;
                let result = crate::models::transport::transfer(
                    &http,
                    &update.asset.browser_download_url,
                    &mut file,
                    &chunk,
                    received,
                    None,
                    &mut |bytes, _| {
                        last_received = bytes;
                        if self.0.cancel.load(Ordering::Acquire) {
                            return Err("下载已取消，已保留进度".into());
                        }
                        if last.elapsed() >= Duration::from_millis(250) {
                            self.change(|s| s.downloaded_bytes = bytes);
                            last = Instant::now();
                        }
                        Ok(())
                    },
                );
                file.set_len(last_received).map_err(error)?;
                if let Err(e) = result {
                    if attempt == 2 || self.0.cancel.load(Ordering::Acquire) {
                        return Err(e);
                    }
                } else {
                    break;
                }
            }
            file.sync_all().map_err(error)?;
            drop(file);
            if self.0.cancel.load(Ordering::Acquire) {
                return Err("下载已取消，已保留进度".into());
            }
            self.change(|s| s.phase = "verifying".into());
            if fs::metadata(&partial).map_err(error)?.len() != update.asset.size
                || digest(&partial)? != update.sha256
            {
                fs::remove_file(&partial).map_err(error)?;
                return Err("更新包 SHA-256 校验失败，损坏文件已清理，请重新下载".into());
            }
            fs::rename(&partial, &target).map_err(error)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).map_err(error)?;
            }
            self.ready(&target, &update);
            Ok(())
        })())
    }
    fn ready(&self, target: &Path, update: &Update) {
        let (can_install, note) = self.permissions();
        self.change(|s| {
            s.phase = "ready".into();
            s.path = Some(target.to_string_lossy().into());
            s.downloaded_bytes = update.asset.size;
            s.error = None;
            s.can_install = can_install;
            s.install_note = note;
        });
    }
    pub fn install(&self) -> Result<Status, String> {
        let _busy = self.begin()?;
        self.finish((|| {
            let _lock = self.locked()?;
            if self.status().phase != "ready" {
                return Err("请先下载并校验更新包".into());
            }
            let (allowed, note) = self.permissions();
            if !allowed {
                return Err(note);
            }
            let update = self
                .0
                .update
                .lock()
                .unwrap()
                .clone()
                .ok_or("更新信息已失效")?;
            let target = self.0.appimage.as_ref().ok_or("当前不是 AppImage")?;
            let source = self.0.root.join(&update.asset.name);
            install_file(&source, target, &update.sha256, update.asset.size)?;
            self.change(|s| s.phase = "installed".into());
            Ok(())
        })())
    }
}
fn install_file(
    source: &Path,
    target: &Path,
    expected: &str,
    size: u64,
) -> Result<PathBuf, String> {
    if !regular(source) || !regular(target) {
        return Err("安装路径必须为普通文件，不能是符号链接".into());
    }
    let parent = target.parent().ok_or("安装目录无效")?;
    if fs2::available_space(parent).map_err(error)? < size + 16 * 1024 * 1024 {
        return Err("安装目录空间不足".into());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(error)?
        .as_nanos();
    let temp = parent.join(format!(".moyu-update-{}-{stamp}", std::process::id()));
    let backup = parent.join(format!(
        "{}.moyu-backup-{stamp}",
        target
            .file_name()
            .ok_or("安装文件名无效")?
            .to_string_lossy()
    ));
    let result = (|| {
        let mut input = File::open(source).map_err(error)?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(error)?;
        let copied = std::io::copy(&mut (&mut input).take(size + 1), &mut output).map_err(error)?;
        output.flush().map_err(error)?;
        output.sync_all().map_err(error)?;
        drop(output);
        if copied != size || digest(&temp)? != expected {
            return Err("安装前校验失败；原程序未改动".into());
        }
        let mut magic = [0; 4];
        File::open(&temp)
            .map_err(error)?
            .read_exact(&mut magic)
            .map_err(error)?;
        if magic != *b"\x7fELF" {
            return Err("更新文件不是 Linux 可执行文件".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o755)).map_err(error)?;
        }
        if !regular(target) {
            return Err("安装路径已变化，请重新检查更新".into());
        }
        // A same-directory hard link keeps the old inode and never overwrites a backup.
        fs::hard_link(target, &backup).map_err(error)?;
        if let Err(e) = fs::rename(&temp, target) {
            let _ = fs::remove_file(&backup);
            return Err(error(e));
        }
        let _ = File::open(parent).and_then(|f| f.sync_all());
        Ok(backup)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
#[tauri::command]
pub fn update_status(updater: tauri::State<Updater>) -> Status {
    updater.status()
}
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Updater>().check())
        .await
        .map_err(error)?
}
#[tauri::command]
pub async fn update_download(app: tauri::AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Updater>().download())
        .await
        .map_err(error)?
}
#[tauri::command]
pub fn update_cancel(updater: tauri::State<Updater>) {
    updater.cancel();
}
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<Status, String> {
    let handle = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || handle.state::<Updater>().install())
        .await
        .map_err(error)??;
    app.exit(0);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "moyu-update-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn release(version: &str) -> Release {
        let name = format!("Moyu_{version}_light_arch_x86_64.AppImage");
        Release {
            tag_name: format!("v{version}"),
            draft: false,
            prerelease: false,
            assets: vec![Asset {
                name: name.clone(),
                size: 4096,
                digest: Some(format!("sha256:{}", "a".repeat(64))),
                browser_download_url: format!("{DOWNLOAD_BASE}v{version}/{name}"),
            }],
        }
    }
    fn manager(t: &Temp, target: Option<PathBuf>) -> Updater {
        let root = t.0.join("updates");
        fs::create_dir_all(&root).unwrap();
        Updater::new(root, target, Arc::new(|_| {}))
    }
    #[test]
    fn only_newer_stable_compatible_release_is_selected() {
        assert!(select(release("0.4.1"), "0.4.0").unwrap().is_some());
        assert!(select(release("0.4.1"), "0.4.1").unwrap().is_none());
        assert!(select(release("0.4.0"), "0.4.1").unwrap().is_none());
        assert!(select(release("0.4.2-beta.1"), "0.4.1").is_err());
        let mut r = release("0.4.2");
        r.draft = true;
        assert!(select(r, "0.4.1").is_err());
        let mut r = release("0.4.2");
        r.assets[0].name = "Moyu.dmg".into();
        assert!(select(r, "0.4.1").is_err());
    }
    #[test]
    fn update_requires_project_url_and_valid_digest() {
        let mut r = release("0.4.2");
        r.assets[0].digest = None;
        assert!(select(r, "0.4.1").is_err());
        let mut r = release("0.4.2");
        r.assets[0].browser_download_url = "https://example.com/evil".into();
        assert!(select(r, "0.4.1").is_err());
        let mut r = release("0.4.2");
        r.assets[0].size = MAX_IMAGE + 1;
        assert!(select(r, "0.4.1").is_err());
        for u in [
            "http://github.com/a",
            "https://github.com.evil.com/a",
            "https://user:password@github.com/a",
        ] {
            assert!(!allowed(&reqwest::Url::parse(u).unwrap()));
        }
    }
    #[test]
    fn atomic_install_keeps_old_program_backup_and_sets_executable() {
        let t = Temp::new();
        let old = t.0.join("old.AppImage");
        let new = t.0.join("new.AppImage");
        fs::write(&old, b"old program").unwrap();
        fs::write(&new, b"\x7fELFnew program").unwrap();
        let backup = install_file(
            &new,
            &old,
            &digest(&new).unwrap(),
            fs::metadata(&new).unwrap().len(),
        )
        .unwrap();
        assert_eq!(fs::read(&backup).unwrap(), b"old program");
        assert_eq!(fs::read(&old).unwrap(), fs::read(&new).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&old).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
    }
    #[test]
    fn bad_checksum_and_non_executable_leave_original_untouched() {
        let t = Temp::new();
        let old = t.0.join("old.AppImage");
        let new = t.0.join("new.AppImage");
        fs::write(&old, b"original").unwrap();
        fs::write(&new, b"bad download").unwrap();
        assert!(install_file(&new, &old, &"0".repeat(64), 12).is_err());
        assert!(install_file(&new, &old, &digest(&new).unwrap(), 12).is_err());
        assert_eq!(fs::read(&old).unwrap(), b"original");
        assert_eq!(fs::read_dir(&t.0).unwrap().count(), 2);
    }
    #[test]
    #[cfg(unix)]
    fn read_only_root_owned_and_symlink_installs_are_not_replaced() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let t = Temp::new();
        let old = t.0.join("reader");
        fs::write(&old, b"original").unwrap();
        fs::set_permissions(&old, fs::Permissions::from_mode(0o444)).unwrap();
        let u = manager(&t, Some(old.clone()));
        assert!(!u.permissions().0);
        let root_owned = manager(&t, Some(PathBuf::from("/usr/bin/true")));
        assert!(!root_owned.permissions().0);
        let link = t.0.join("link");
        symlink(&old, &link).unwrap();
        assert!(!manager(&t, Some(link)).permissions().0);
        assert_eq!(fs::read(&old).unwrap(), b"original");
    }
    #[test]
    fn concurrent_actions_and_unverified_install_are_rejected() {
        let t = Temp::new();
        let u = manager(&t, None);
        let guard = u.begin().unwrap();
        assert!(u.begin().is_err());
        drop(guard);
        assert!(u.install().is_err());
    }
    #[test]
    fn download_recovers_when_server_ignores_range_then_disconnects() {
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        let bytes = b"\x7fELFthe full update payload";
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            for attempt in 0..2 {
                let (mut stream, _) = server.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    request.push_str(&line);
                }
                if attempt == 0 {
                    assert!(request.to_lowercase().contains("range: bytes=8-"));
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    )
                    .unwrap();
                    stream.write_all(&bytes[..4]).unwrap();
                } else {
                    assert!(request.to_lowercase().contains("range: bytes=4-"));
                    write!(stream,"HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes 4-{}/{}\r\nConnection: close\r\n\r\n",bytes.len()-4,bytes.len()-1,bytes.len()).unwrap();
                    stream.write_all(&bytes[4..]).unwrap();
                }
            }
        });
        let t = Temp::new();
        let u = manager(&t, None);
        let update = Update {
            version: "0.4.2".into(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
            asset: Asset {
                name: "test.AppImage".into(),
                size: bytes.len() as u64,
                digest: None,
                browser_download_url: format!("http://{address}/image"),
            },
        };
        let partial =
            u.0.root
                .join(format!("{}.{}.part", update.asset.name, update.sha256));
        fs::write(partial, &bytes[..8]).unwrap();
        *u.0.update.lock().unwrap() = Some(update);
        assert_eq!(u.download().unwrap().phase, "ready");
        assert_eq!(fs::read(u.0.root.join("test.AppImage")).unwrap(), bytes);
        thread.join().unwrap();
    }
    #[test]
    #[ignore = "downloads the latest real GitHub AppImage and verifies its published SHA-256"]
    fn real_github_update_download() {
        let response = client().unwrap().get(API).send().unwrap();
        assert!(response.status().is_success());
        let r: Release = response.json().unwrap();
        let update = select(r, "0.0.0").unwrap().unwrap();
        let t = Temp::new();
        let u = manager(&t, None);
        *u.0.update.lock().unwrap() = Some(update.clone());
        let status = u.download().unwrap();
        assert_eq!(status.phase, "ready");
        let p = PathBuf::from(status.path.unwrap());
        assert_eq!(digest(&p).unwrap(), update.sha256);
        assert_eq!(fs::metadata(p).unwrap().len(), update.asset.size);
    }
}
