use super::*;
use schema::{Artifact, Chunk, Source};
use std::{
    io::{BufRead, BufReader},
    net::TcpListener,
};
static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "moyu-model-test-{}-{}",
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
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn entry(data: &[u8], sources: Vec<Source>) -> CatalogEntry {
    CatalogEntry {
        id: "model-test".into(),
        label: "test".into(),
        kind: "model".into(),
        variant: "f16".into(),
        revision: "rev1".into(),
        enabled: !sources.is_empty(),
        experimental: false,
        files: vec![Artifact {
            name: "model.gguf".into(),
            size: data.len() as u64,
            sha256: digest(data),
            chunks: vec![Chunk {
                offset: 0,
                size: data.len() as u64,
                sha256: digest(data),
                sources,
            }],
        }],
    }
}
fn manager(root: &Path, e: CatalogEntry) -> ModelManager {
    ModelManager::new(
        root.to_path_buf(),
        Catalog {
            schema_version: 1,
            entries: vec![e],
        },
        Arc::new(|_| {}),
    )
    .unwrap()
}
struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<String>>>,
}
impl Server {
    fn new(data: Vec<u8>, code: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/chunk", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let end = stop.clone();
        let log = requests.clone();
        thread::spawn(move || {
            while !end.load(Ordering::Relaxed) {
                if let Ok((mut stream, _)) = listener.accept() {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        request.push_str(&line);
                    }
                    log.lock().unwrap().push(request.clone());
                    let start = request
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("range: bytes=")
                                .and_then(|s| {
                                    s.split_once('-').and_then(|(s, _)| s.parse::<usize>().ok())
                                })
                        })
                        .unwrap_or(0)
                        .min(data.len());
                    let body = &data[start..];
                    let head = if code != 200 {
                        format!("HTTP/1.1 {code} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    } else if start > 0 {
                        format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{}/{}\r\nContent-Length: {}\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n",data.len()-1,data.len(),body.len())
                    } else {
                        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n",body.len())
                    };
                    let _ = stream.write_all(head.as_bytes());
                    if code == 200 {
                        let _ = stream.write_all(body);
                    }
                } else {
                    thread::sleep(Duration::from_millis(5));
                }
            }
        });
        Self {
            url,
            stop,
            requests,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}
fn wait_ready(m: &ModelManager) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let s = &m.statuses()[0];
        if s.phase == "ready" {
            return;
        }
        assert_ne!(s.phase, "error", "{:?}", s.error);
        assert!(Instant::now() < deadline, "phase {}", s.phase);
        thread::sleep(Duration::from_millis(20));
    }
}
#[test]
fn revision_upgrade_reuses_verified_files_and_fetches_only_changed_artifacts() {
    let t = Temp::new();
    let source = t.0.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("model.gguf"), b"unchanged library").unwrap();
    fs::write(source.join("nv-worker"), b"old worker").unwrap();
    let mut old = entry(b"unchanged library", vec![]);
    old.kind = "backend".into();
    let mut worker = entry(b"old worker", vec![]).files.remove(0);
    worker.name = "nv-worker".into();
    old.files.push(worker);
    let root = t.0.join("manager");
    let m = manager(&root, old.clone());
    m.import(&old.id, &source).unwrap();
    let old_path = m.installed_path(&old.id).unwrap();
    drop(m);
    let server = Server::new(b"new worker".to_vec(), 200);
    let mut new = old.clone();
    new.revision = "rev2".into();
    new.enabled = true;
    new.files[0].chunks[0].sources = vec![Source {
        id: "test".into(),
        url: server.url.clone(),
    }];
    let mut worker = entry(
        b"new worker",
        vec![Source {
            id: "test".into(),
            url: server.url.clone(),
        }],
    )
    .files
    .remove(0);
    worker.name = "nv-worker".into();
    new.files[1] = worker;
    let m = manager(&root, new.clone());
    assert!(m.statuses()[0].update_available);
    m.download(&new.id).unwrap();
    wait_ready(&m);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let installed = m.installed_path(&new.id).unwrap();
    assert_eq!(
        fs::read(installed.join("model.gguf")).unwrap(),
        b"unchanged library"
    );
    assert_eq!(
        fs::read(installed.join("nv-worker")).unwrap(),
        b"new worker"
    );
    assert_eq!(fs::read(old_path.join("nv-worker")).unwrap(), b"old worker");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_ne!(
            fs::metadata(installed.join("model.gguf")).unwrap().ino(),
            fs::metadata(old_path.join("model.gguf")).unwrap().ino()
        );
    }
    assert!(!manager(&root, new).statuses()[0].update_available);
}

#[test]
fn revision_upgrade_rejects_corrupt_local_chunks() {
    let t = Temp::new();
    let source = t.0.join("source");
    fs::create_dir(&source).unwrap();
    let bytes = b"valid model";
    fs::write(source.join("model.gguf"), bytes).unwrap();
    let old = entry(bytes, vec![]);
    let root = t.0.join("manager");
    let m = manager(&root, old.clone());
    m.import(&old.id, &source).unwrap();
    fs::write(
        m.installed_path(&old.id).unwrap().join("model.gguf"),
        b"bad model!!",
    )
    .unwrap();
    drop(m);
    let server = Server::new(bytes.to_vec(), 200);
    let mut new = entry(
        bytes,
        vec![Source {
            id: "test".into(),
            url: server.url.clone(),
        }],
    );
    new.revision = "rev2".into();
    let m = manager(&root, new.clone());
    m.download(&new.id).unwrap();
    wait_ready(&m);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(
        fs::read(m.installed_path(&new.id).unwrap().join("model.gguf")).unwrap(),
        bytes
    );
}
#[test]
fn imports_are_atomic_and_survive_restart() {
    let t = Temp::new();
    let source = t.0.join("source");
    fs::create_dir(&source).unwrap();
    let data = b"valid model";
    fs::write(source.join("model.gguf"), data).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(source.join("model.gguf"), fs::Permissions::from_mode(0o444)).unwrap();
    }
    let e = entry(data, vec![]);
    let root = t.0.join("manager");
    let m = manager(&root, e.clone());
    assert!(m.download(&e.id).is_err());
    m.import(&e.id, &source).unwrap();
    assert_eq!(
        fs::read(m.installed_path(&e.id).unwrap().join("model.gguf")).unwrap(),
        data
    );
    let reopened = manager(&root, e);
    assert_eq!(reopened.statuses()[0].phase, "ready");
    #[cfg(unix)]
    assert!(fs::metadata(source.join("model.gguf"))
        .unwrap()
        .permissions()
        .readonly());
}
#[test]
fn bad_import_never_becomes_ready() {
    let t = Temp::new();
    let source = t.0.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("model.gguf"), b"wrong model").unwrap();
    let e = entry(b"valid model", vec![]);
    let m = manager(&t.0.join("manager"), e.clone());
    assert!(m.import(&e.id, &source).is_err());
    assert!(m.installed_path(&e.id).is_none());
    assert!(!t.0.join("manager/installed/model-test/rev1").exists());
}
#[test]
fn resumes_partial_chunk_and_fails_over_sources() {
    let t = Temp::new();
    let data = vec![19u8; 150000];
    let bad = Server::new(vec![], 404);
    let good = Server::new(data.clone(), 200);
    let e = entry(
        &data,
        vec![
            Source {
                id: "bad".into(),
                url: bad.url.clone(),
            },
            Source {
                id: "good".into(),
                url: good.url.clone(),
            },
        ],
    );
    let root = t.0.join("manager");
    let m = manager(&root, e.clone());
    let job = &m.0.jobs[&e.id];
    fs::create_dir_all(m.staging(&e).join("payload")).unwrap();
    fs::write(m.staging(&e).join("payload/model.gguf"), &data[..70000]).unwrap();
    job.journal.lock().unwrap().parts[0][0].received = 70000;
    job.journal.lock().unwrap().phase = "downloading".into();
    m.save(&e, job).unwrap();
    drop(m);
    let reopened = manager(&root, e.clone());
    wait_ready(&reopened);
    assert_eq!(
        fs::read(reopened.installed_path(&e.id).unwrap().join("model.gguf")).unwrap(),
        data
    );
    assert_eq!(bad.requests.lock().unwrap().len(), 3);
    assert!(good
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.to_lowercase().contains("range: bytes=70000-")));
}
#[test]
fn paused_job_does_not_resume_on_restart() {
    let t = Temp::new();
    let data = b"test";
    let server = Server::new(data.to_vec(), 200);
    let e = entry(
        data,
        vec![Source {
            id: "local".into(),
            url: server.url.clone(),
        }],
    );
    let root = t.0.join("manager");
    let m = manager(&root, e.clone());
    fs::create_dir_all(m.staging(&e)).unwrap();
    m.control(&e.id, "pause").unwrap();
    drop(m);
    let m = manager(&root, e.clone());
    thread::sleep(Duration::from_millis(100));
    assert!(server.requests.lock().unwrap().is_empty());
    m.control(&e.id, "resume").unwrap();
    wait_ready(&m);
}
#[test]
fn unsafe_catalog_and_urls_are_rejected() {
    let mut e = entry(b"ok", vec![]);
    e.files[0].name = "../outside".into();
    assert!(Catalog {
        schema_version: 1,
        entries: vec![e]
    }
    .validate()
    .is_err());
    for url in [
        "http://huggingface.co/a",
        "https://evil.example/a",
        "https://user:secret@huggingface.co/a",
    ] {
        assert!(!allowed(&reqwest::Url::parse(url).unwrap()));
    }
}

#[test]
fn second_file_failure_does_not_install_first_file() {
    let t = Temp::new();
    let source = t.0.join("source");
    fs::create_dir(&source).unwrap();
    let mut e = entry(b"weights", vec![]);
    let mut tokenizer = e.files[0].clone();
    tokenizer.name = "tokenizer.gguf".into();
    e.files.push(tokenizer);
    fs::write(source.join("model.gguf"), b"weights").unwrap();
    fs::write(source.join("tokenizer.gguf"), b"invalid").unwrap();
    let m = manager(&t.0.join("manager"), e.clone());
    assert!(m.import(&e.id, &source).is_err());
    assert!(m.installed_path(&e.id).is_none());
    assert!(!t.0.join("manager/installed/model-test/rev1").exists());
    assert_eq!(fs::read(source.join("model.gguf")).unwrap(), b"weights");
}

#[test]
fn cancellation_cleans_staging_and_does_not_restart() {
    let t = Temp::new();
    let server = Server::new(vec![], 404);
    let e = entry(
        b"data",
        vec![Source {
            id: "local".into(),
            url: server.url.clone(),
        }],
    );
    let root = t.0.join("manager");
    let m = manager(&root, e.clone());
    m.download(&e.id).unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    while server.requests.lock().unwrap().is_empty() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(10));
    }
    m.control(&e.id, "cancel").unwrap();
    while m.0.jobs[&e.id].running.load(Ordering::Acquire) {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!m.staging(&e).join("payload").exists());
    let count = server.requests.lock().unwrap().len();
    drop(m);
    let reopened = manager(&root, e);
    thread::sleep(Duration::from_millis(100));
    assert_eq!(reopened.statuses()[0].phase, "cancelled");
    assert_eq!(server.requests.lock().unwrap().len(), count);
}

#[test]
fn another_manager_cannot_modify_a_locked_installation() {
    let t = Temp::new();
    let source = t.0.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("model.gguf"), b"data").unwrap();
    let e = entry(
        b"data",
        vec![Source {
            id: "local".into(),
            url: "http://127.0.0.1:9/chunk".into(),
        }],
    );
    let root = t.0.join("manager");
    let first = manager(&root, e.clone());
    let second = manager(&root, e.clone());
    let guard = first.lock(&e).unwrap();
    assert!(second.download(&e.id).is_err());
    assert!(second.import(&e.id, &source).is_err());
    assert!(second.control(&e.id, "cancel").is_err());
    assert!(!second.staging(&e).join("journal.json").exists());
    drop(guard);
    second.import(&e.id, &source).unwrap();
    assert!(second.installed_path(&e.id).is_some());
}

#[test]
fn interrupted_local_import_does_not_start_network_downloads() {
    let t = Temp::new();
    let server = Server::new(vec![], 404);
    let e = entry(
        b"data",
        vec![Source {
            id: "local".into(),
            url: server.url.clone(),
        }],
    );
    let m = manager(&t.0, e.clone());
    fs::create_dir_all(m.staging(&e)).unwrap();
    {
        let mut j = m.0.jobs[&e.id].journal.lock().unwrap();
        j.origin = "import".into();
        j.phase = "verifying".into();
    }
    m.save(&e, &m.0.jobs[&e.id]).unwrap();
    drop(m);
    let reopened = manager(&t.0, e);
    thread::sleep(Duration::from_millis(100));
    assert!(server.requests.lock().unwrap().is_empty());
    assert_eq!(reopened.statuses()[0].phase, "error");
}

#[test]
fn progress_callback_can_cancel_import_without_deadlocking() {
    let t = Temp::new();
    let source = t.0.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("model.gguf"), b"data").unwrap();
    let e = entry(
        b"data",
        vec![Source {
            id: "local".into(),
            url: "http://127.0.0.1:9/chunk".into(),
        }],
    );
    let slot: Arc<Mutex<Option<ModelManager>>> = Arc::new(Mutex::new(None));
    let handle = slot.clone();
    let m = ModelManager::new(
        t.0.join("manager"),
        Catalog {
            schema_version: 1,
            entries: vec![e.clone()],
        },
        Arc::new(move |status| {
            if status.phase == "checking" {
                let manager = handle.lock().unwrap().clone().unwrap();
                assert!(!manager.statuses().is_empty());
                manager.control(&status.id, "cancel").unwrap();
                assert!(manager
                    .download(&status.id)
                    .unwrap_err()
                    .contains("正在取消"));
            }
        }),
    )
    .unwrap();
    *slot.lock().unwrap() = Some(m.clone());
    m.import(&e.id, &source).unwrap();
    assert_eq!(m.statuses()[0].phase, "cancelled");
    assert!(m.installed_path(&e.id).is_none());
    assert!(!m.staging(&e).join("payload").exists());
    *slot.lock().unwrap() = None;
}

#[test]
#[ignore = "downloads the real tokenizer using the release catalog"]
fn real_catalog_download_and_install() {
    let catalog: Catalog = serde_json::from_str(include_str!("../../model-catalog.json")).unwrap();
    let mut e = catalog
        .entries
        .into_iter()
        .find(|e| e.variant == "f16")
        .unwrap();
    e.files.retain(|f| f.name.contains("tokenizer"));
    e.id = "tokenizer-network-test".into();
    assert!(e.enabled);
    let t = Temp::new();
    let m = manager(&t.0, e.clone());
    m.download(&e.id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        let status = &m.statuses()[0];
        assert_ne!(status.phase, "error", "{:?}", status.error);
        if status.phase == "ready" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "phase {}: {:?}",
            status.phase,
            status.error
        );
        thread::sleep(Duration::from_millis(100));
    }
    let path = m.installed_path(&e.id).unwrap();
    let mut file = File::open(path.join(&e.files[0].name)).unwrap();
    assert_eq!(
        hash_range(&mut file, 0, e.files[0].size).unwrap(),
        e.files[0].sha256
    );
    println!("Real tokenizer download and SHA-256 installation verified");
}

#[test]
#[ignore = "requires local CUDA component, models, native engine and NVIDIA GPU"]
fn real_cuda_component_import_and_synthesis() {
    let catalog: Catalog = serde_json::from_str(include_str!("../../model-catalog.json")).unwrap();
    let e = catalog
        .entries
        .into_iter()
        .find(|e| e.kind == "backend" && e.variant == "cuda")
        .unwrap();
    let t = Temp::new();
    let m = manager(&t.0, e.clone());
    let source = std::env::var("MOYU_CUDA_COMPONENT_DIR").expect("MOYU_CUDA_COMPONENT_DIR");
    m.import(&e.id, Path::new(&source)).unwrap();
    let installed = m.installed_path(&e.id).unwrap();
    let output = std::process::Command::new(installed.join("nv-worker"))
        .arg("--probe")
        .env_remove("LD_LIBRARY_PATH")
        .output()
        .unwrap();
    assert!(output.status.success());
    let info: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(info["backend"], "cuda");
    assert_eq!(info["available"], true);
    crate::voice::set_models(m, t.0.clone());
    let result = crate::voice::bundle_check(PathBuf::new(), true).unwrap();
    assert_eq!(result["backend"]["effectiveBackend"], "cuda");
    assert!(result["metrics"]["audioSeconds"].as_f64().unwrap() > 0.0);
    println!("Installed CUDA component import, probe and real synthesis verified");
}
