//! A single owner thread serializes the native ABI; GPU/audio never enter IPC.
use crate::{
    books::Book,
    state::{Position, Preferences, Store},
};
use libloading::Library;
use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::PathBuf,
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager};

#[repr(C)]
#[derive(Clone, Copy)]
struct Config {
    models: *const c_char,
    model: *const c_char,
    speaker: *const c_char,
    cache: *const c_char,
    output: *const c_char,
    threads: c_int,
    playback: c_int,
    cache_enabled: c_int,
    idle: c_int,
    preroll: f64,
    buffer: f64,
    seed: i64,
}
#[repr(C)]
struct Request {
    text: *const c_char,
    preceding: *const c_char,
    following: *const c_char,
    speaker: *const c_char,
    instruction: *const c_char,
    automatic: c_int,
}
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct PlaybackPosition {
    consumed: u64,
    begin: usize,
    end: usize,
    rate: c_int,
    valid: c_int,
    buffering: c_int,
}
type Session = *mut c_void;
type Create = unsafe extern "C" fn(
    *const Config,
    Option<unsafe extern "C" fn(*const f32, usize, c_int, *mut c_void) -> c_int>,
    Option<unsafe extern "C" fn(usize, usize, *mut c_void)>,
    Option<unsafe extern "C" fn(*const c_char, *mut c_void)>,
    *mut c_void,
) -> Session;

struct Engine {
    session: Session,
    submit: unsafe extern "C" fn(Session, *const Request) -> c_int,
    pause: unsafe extern "C" fn(Session),
    resume: unsafe extern "C" fn(Session),
    stop: unsafe extern "C" fn(Session),
    wait: unsafe extern "C" fn(Session) -> c_int,
    state: unsafe extern "C" fn(Session) -> c_int,
    position: unsafe extern "C" fn(Session) -> PlaybackPosition,
    error: unsafe extern "C" fn(Session) -> *const c_char,
    destroy: unsafe extern "C" fn(Session),
    metrics: unsafe extern "C" fn(Session) -> Metrics,
    _library: Library,
    identity: (String, String),
}
#[repr(C)]
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metrics {
    wall_seconds: f64,
    first_pcm_seconds: f64,
    load_seconds: f64,
    synthesis_seconds: f64,
    audio_seconds: f64,
    cache_hits: usize,
    underrun_samples: usize,
    cold_start: c_int,
    cancelled: c_int,
}
static BUNDLE: OnceLock<PathBuf> = OnceLock::new();
pub fn set_bundle(root: PathBuf) {
    let _ = BUNDLE.set(root.join("voice"));
}
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            (self.destroy)(self.session);
        }
    }
}
unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, String> {
    library
        .get::<T>(name)
        .map(|s| *s)
        .map_err(|e| format!("朗读引擎接口不兼容，请重新构建引擎：{e}"))
}
fn directory(explicit: &str, env: &str, development: &str, suffix: &str) -> PathBuf {
    if !explicit.trim().is_empty() {
        return explicit.into();
    }
    if let Some(value) = std::env::var_os(env) {
        return value.into();
    }
    if let Some(root) = BUNDLE.get() {
        let bundled = root.join(suffix);
        if bundled.is_dir() {
            return bundled;
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(development);
    if cfg!(debug_assertions) && dev.is_dir() {
        return dev;
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")
        });
    data.join("novel-voice").join(suffix)
}
fn paths(p: &Preferences) -> (PathBuf, PathBuf) {
    (
        directory(
            &p.voice_engine_dir,
            "MOYU_NV_ENGINE_DIR",
            "../../novel-voice/build/bin",
            "runtime",
        ),
        directory(
            &p.voice_models_dir,
            "MOYU_NV_MODELS_DIR",
            "../../novel-voice/models/gguf",
            "models/gguf",
        ),
    )
}
impl Engine {
    fn load(p: &Preferences) -> Result<Self, String> {
        Self::load_with_playback(p, true)
    }
    fn load_with_playback(p: &Preferences, playback: bool) -> Result<Self, String> {
        if !cfg!(target_os = "linux") {
            return Err("本版朗读需要 Linux 和 NVIDIA CUDA，阅读功能仍可使用。".into());
        }
        let (runtime, models) = paths(p);
        if !runtime.join("nv-worker").is_file() {
            return Err("找不到朗读工作程序，请在朗读设置中选择引擎目录。".into());
        }
        for file in [
            "qwen3-tts-1.7b-customvoice-f16.gguf",
            "qwen3-tts-tokenizer-f16.gguf",
        ] {
            if !models.join(file).is_file() {
                return Err(format!("缺少模型 {file}，请在朗读设置中选择模型目录。"));
            }
        }
        let path = CString::new(models.to_string_lossy().as_bytes())
            .map_err(|_| "模型路径含无效字符。")?;
        unsafe {
            let library = Library::new(runtime.join("libnovel_voice.so"))
                .map_err(|e| format!("无法加载朗读引擎，请检查引擎目录及依赖：{e}"))?;
            let abi: unsafe extern "C" fn() -> c_int =
                symbol(&library, b"nv_engine_abi_version\0")?;
            if abi() != 1 {
                return Err("朗读引擎版本不兼容，请重新构建。".into());
            }
            let defaults: unsafe extern "C" fn() -> Config =
                symbol(&library, b"nv_default_config\0")?;
            let create: Create = symbol(&library, b"nv_create\0")?;
            let mut config = defaults();
            config.models = path.as_ptr();
            config.playback = playback as c_int;
            if !playback {
                config.cache_enabled = 0;
            }
            let submit = symbol(&library, b"nv_submit\0")?;
            let pause = symbol(&library, b"nv_pause\0")?;
            let resume = symbol(&library, b"nv_resume\0")?;
            let stop = symbol(&library, b"nv_stop\0")?;
            let wait = symbol(&library, b"nv_wait\0")?;
            let state = symbol(&library, b"nv_get_state\0")?;
            let position = symbol(&library, b"nv_get_playback_position\0")?;
            let error = symbol(&library, b"nv_last_error\0")?;
            let destroy = symbol(&library, b"nv_destroy\0")?;
            let metrics = symbol(&library, b"nv_get_metrics\0")?;
            let session = create(&config, None, None, None, std::ptr::null_mut());
            if session.is_null() {
                return Err("无法创建朗读会话。".into());
            }
            Ok(Self {
                session,
                submit,
                pause,
                resume,
                stop,
                wait,
                state,
                position,
                error,
                destroy,
                metrics,
                identity: (
                    runtime.to_string_lossy().into(),
                    models.to_string_lossy().into(),
                ),
                _library: library,
            })
        }
    }
    fn stop_and_wait(&self) {
        unsafe {
            (self.stop)(self.session);
            (self.wait)(self.session);
        }
    }
    fn prepare_start(&self) {
        unsafe {
            if matches!((self.state)(self.session), 1 | 2) {
                (self.stop)(self.session);
            }
            (self.wait)(self.session);
        }
    }
    fn start(&self, text: &str, preceding: &str, p: &Preferences) -> Result<(), String> {
        let text = CString::new(text).map_err(|_| "正文含无效字符。")?;
        let preceding = CString::new(preceding).map_err(|_| "正文含无效字符。")?;
        let speaker = CString::new(p.voice_speaker.as_str()).map_err(|_| "声音名称无效。")?;
        let request = Request {
            text: text.as_ptr(),
            preceding: preceding.as_ptr(),
            following: std::ptr::null(),
            speaker: speaker.as_ptr(),
            instruction: std::ptr::null(),
            automatic: p.voice_automatic as c_int,
        };
        if unsafe { (self.submit)(self.session, &request) } == 0 {
            Err("无法开始朗读，请停止后重试。".into())
        } else {
            Ok(())
        }
    }
}
/// Headless release verification: no GTK, window, audio device or downloads.
pub fn bundle_check(resource_root: PathBuf, smoke: bool) -> Result<serde_json::Value, String> {
    set_bundle(resource_root);
    let p = Preferences::default();
    let (runtime, models) = paths(&p);
    let engine = Engine::load_with_playback(&p, false)?;
    let mut result =
        serde_json::json!({"runtime":runtime,"models":models,"abiVersion":1,"offline":true});
    if smoke {
        engine.start("清晨的雨停了。她轻声说：“我们出发吧。”", "", &p)?;
        let state = unsafe { (engine.wait)(engine.session) };
        if state != 3 {
            return Err(unsafe {
                CStr::from_ptr((engine.error)(engine.session))
                    .to_string_lossy()
                    .into_owned()
            });
        }
        let metrics = unsafe { (engine.metrics)(engine.session) };
        if metrics.audio_seconds <= 0.0 {
            return Err("引擎未生成有效音频。".into());
        }
        result["metrics"] = serde_json::to_value(metrics).map_err(|e| e.to_string())?;
    }
    Ok(result)
}

#[derive(Clone, Default, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub request_id: u64,
    pub book_id: String,
    pub chapter: usize,
    pub phase: String,
    pub paragraph_start: Option<usize>,
    pub paragraph_end: Option<usize>,
    pub offset: Option<usize>,
    pub error: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub request_id: u64,
    pub book_id: String,
    pub position: Position,
}
enum Action {
    Book(Book),
    Start(StartRequest, Preferences),
    Control(u64, String),
    Status,
    Shutdown,
}
struct Message {
    action: Action,
    reply: mpsc::Sender<Result<VoiceStatus, String>>,
}
pub struct VoiceService {
    sender: mpsc::Sender<Message>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}
impl VoiceService {
    pub fn new(app: tauri::AppHandle) -> Self {
        let (sender, receiver) = mpsc::channel();
        let thread = thread::spawn(move || {
            run(receiver, move |state| {
                let _ = app.emit("voice-status", state);
            })
        });
        Self {
            sender,
            thread: Mutex::new(Some(thread)),
        }
    }
    fn call(&self, action: Action) -> Result<VoiceStatus, String> {
        let (reply, rx) = mpsc::channel();
        self.sender
            .send(Message { action, reply })
            .map_err(|_| "朗读服务已关闭。")?;
        rx.recv().map_err(|_| "朗读服务已关闭。")?
    }
    pub fn set_book(&self, book: Book) -> Result<(), String> {
        self.call(Action::Book(book)).map(|_| ())
    }
    pub fn shutdown(&self) {
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(handle) = thread.take() {
                let _ = self.call(Action::Shutdown);
                let _ = handle.join();
            }
        }
    }
}
impl Drop for VoiceService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// Positions use UTF-16 in Moyu, byte offsets in the engine. A byte-range table
// is built once per request, with one row per original paragraph, not per char.
#[derive(Debug)]
struct Paragraph {
    byte_start: usize,
    byte_end: usize,
    start: usize,
    end: usize,
}
fn paragraphs(text: &str) -> Vec<Paragraph> {
    let mut result = Vec::new();
    let mut byte = 0;
    let mut utf16 = 0;
    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches('\n');
        let len = body.encode_utf16().count();
        if !body.trim().is_empty() {
            result.push(Paragraph {
                byte_start: byte,
                byte_end: byte + body.len(),
                start: utf16,
                end: utf16 + len,
            });
        }
        byte += line.len();
        utf16 += line.encode_utf16().count();
    }
    result
}
fn selected(rows: &[Paragraph], offset: usize) -> Option<&Paragraph> {
    rows.iter()
        .find(|row| offset < row.end)
        .or_else(|| rows.last())
}
fn run(receiver: mpsc::Receiver<Message>, emit: impl Fn(&VoiceStatus)) {
    let mut engine: Option<Engine> = None;
    let mut book: Option<Book> = None;
    let mut status = VoiceStatus {
        phase: "idle".into(),
        ..Default::default()
    };
    let mut rows = Vec::new();
    let mut origin = 0;
    let mut last = status.clone();
    loop {
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(message) => {
                let result = (|| -> Result<(), String> {
                    match message.action {
                        Action::Shutdown => {
                            if let Some(e) = &engine {
                                e.stop_and_wait();
                            }
                            let _ = message.reply.send(Ok(status.clone()));
                            return Err("__shutdown".into());
                        }
                        Action::Book(next) => {
                            if let Some(e) = &engine {
                                e.stop_and_wait();
                            }
                            book = Some(next);
                            rows.clear();
                            status.phase = "idle".into();
                            status.paragraph_start = None;
                            status.paragraph_end = None;
                            status.offset = None;
                            status.error = None;
                        }
                        Action::Start(request, p) => {
                            if request.request_id <= status.request_id {
                                return Ok(());
                            }
                            if let Some(e) = &engine {
                                e.prepare_start();
                            }
                            status = VoiceStatus {
                                request_id: request.request_id,
                                book_id: request.book_id.clone(),
                                chapter: request.position.chapter,
                                phase: "loading".into(),
                                ..Default::default()
                            };
                            let current = book
                                .as_ref()
                                .filter(|b| b.id == request.book_id)
                                .ok_or("书籍已切换，请重新开始朗读。")?;
                            let chapter = current
                                .chapters
                                .get(request.position.chapter)
                                .ok_or("章节不存在。")?;
                            rows = paragraphs(&chapter.text);
                            let row = selected(&rows, request.position.offset)
                                .ok_or("本章没有可朗读的正文。")?;
                            origin = row.byte_start;
                            let (runtime, models) = paths(&p);
                            let identity = (
                                runtime.to_string_lossy().into_owned(),
                                models.to_string_lossy().into_owned(),
                            );
                            if engine.as_ref().is_some_and(|e| e.identity != identity) {
                                engine = None;
                            }
                            if engine.is_none() {
                                engine = Some(Engine::load(&p)?);
                            }
                            let context = &chapter.text[..origin];
                            let context_start = context
                                .char_indices()
                                .rev()
                                .nth(120)
                                .map(|(b, _)| b)
                                .unwrap_or(0);
                            engine.as_ref().unwrap().start(
                                &chapter.text[origin..],
                                &context[context_start..],
                                &p,
                            )?;
                        }
                        Action::Control(id, action) => {
                            if action == "stop" && id >= status.request_id {
                                status.request_id = id;
                                if let Some(e) = &engine {
                                    e.stop_and_wait();
                                }
                                status.phase = "stopped".into();
                                status.paragraph_start = None;
                                status.paragraph_end = None;
                                status.offset = None;
                                status.error = None;
                            } else if id == status.request_id {
                                let e = engine.as_ref().ok_or("尚未开始朗读，请使用 gr。")?;
                                unsafe {
                                    match action.as_str() {
                                        "toggle" => {
                                            if (e.state)(e.session) == 2 {
                                                (e.resume)(e.session)
                                            } else if (e.state)(e.session) == 1 {
                                                (e.pause)(e.session)
                                            } else {
                                                return Err("尚未开始朗读，请使用 gr。".into());
                                            }
                                        }
                                        "pause" => (e.pause)(e.session),
                                        "resume" => (e.resume)(e.session),
                                        _ => return Err("未知朗读操作。".into()),
                                    }
                                }
                            }
                        }
                        Action::Status => {}
                    }
                    Ok(())
                })();
                if result.as_ref().is_err_and(|e| e == "__shutdown") {
                    break;
                }
                if let Err(error) = &result {
                    if status.phase == "loading" {
                        status.phase = "error".into();
                        status.error = Some(error.clone());
                    }
                }
                update(&engine, &rows, origin, &mut status, book.as_ref());
                let _ = message.reply.send(result.map(|_| status.clone()));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                update(&engine, &rows, origin, &mut status, book.as_ref())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if status != last {
            emit(&status);
            last = status.clone();
        }
    }
}
fn update(
    engine: &Option<Engine>,
    rows: &[Paragraph],
    origin: usize,
    status: &mut VoiceStatus,
    book: Option<&Book>,
) {
    if !["loading", "buffering", "playing", "paused"].contains(&status.phase.as_str()) {
        return;
    }
    let Some(e) = engine else {
        return;
    };
    unsafe {
        let state = (e.state)(e.session);
        let p = (e.position)(e.session);
        status.phase = match state {
            1 if p.valid == 0 => "loading",
            1 if p.buffering != 0 => "buffering",
            1 => "playing",
            2 => "paused",
            3 => "completed",
            4 => "stopped",
            5 => "error",
            _ => "idle",
        }
        .into();
        if p.valid != 0 {
            let byte = origin + p.begin;
            if let Some(row) = rows
                .get(
                    rows.partition_point(|r| r.byte_start <= byte)
                        .saturating_sub(1),
                )
                .filter(|r| byte < r.byte_end)
            {
                status.paragraph_start = Some(row.start);
                status.paragraph_end = Some(row.end);
                status.offset = book
                    .and_then(|b| b.chapters.get(status.chapter))
                    .and_then(|c| c.text.get(row.byte_start..byte))
                    .map(|text| row.start + text.encode_utf16().count());
            }
        }
        if state == 5 {
            let error = (e.error)(e.session);
            status.error = Some(if error.is_null() {
                "朗读失败。".into()
            } else {
                CStr::from_ptr(error).to_string_lossy().into_owned()
            });
        }
        if state == 4 {
            status.paragraph_start = None;
            status.paragraph_end = None;
            status.offset = None;
        }
    }
}

#[tauri::command]
pub async fn voice_start(
    app: tauri::AppHandle,
    request: StartRequest,
) -> Result<VoiceStatus, String> {
    let preferences = app
        .state::<Store>()
        .saved
        .lock()
        .map_err(|e| e.to_string())?
        .preferences
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<VoiceService>()
            .call(Action::Start(request, preferences))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn voice_control(
    app: tauri::AppHandle,
    request_id: u64,
    action: String,
) -> Result<VoiceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<VoiceService>()
            .call(Action::Control(request_id, action))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn voice_status(app: tauri::AppHandle) -> Result<VoiceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<VoiceService>().call(Action::Status))
        .await
        .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paragraph_offsets_are_original_utf16() {
        let rows = paragraphs("\n甲😀乙\n\n  丙。\n");
        assert_eq!((rows[0].start, rows[0].end), (1, 5));
        assert_eq!((rows[1].start, rows[1].end), (7, 11));
        assert_eq!(selected(&rows, 3).unwrap().byte_start, 1);
        assert_eq!(selected(&rows, 5).unwrap().start, 7);
        assert_eq!(selected(&rows, 999).unwrap().start, 7);
        assert!(selected(&paragraphs(" \n\n"), 0).is_none());
    }
    #[test]
    fn long_paragraph_is_not_a_display_block() {
        let text = format!("{}\n后段", "字".repeat(1400));
        let rows = paragraphs(&text);
        assert_eq!(selected(&rows, 900).unwrap().start, 0);
        assert_eq!(rows.len(), 2);
    }
    fn send(sender: &mpsc::Sender<Message>, action: Action) -> Result<VoiceStatus, String> {
        let (reply, rx) = mpsc::channel();
        sender.send(Message { action, reply }).unwrap();
        rx.recv_timeout(Duration::from_secs(10)).unwrap()
    }
    #[test]
    fn actor_rejects_stale_requests_and_wrong_books_without_loading() {
        let (sender, rx) = mpsc::channel();
        let thread = thread::spawn(move || run(rx, |_| {}));
        let book = Book {
            id: "book".into(),
            path: "/test".into(),
            title: "测试".into(),
            encoding: "UTF-8".into(),
            chapters: vec![],
        };
        send(&sender, Action::Book(book)).unwrap();
        assert_eq!(
            send(&sender, Action::Control(8, "stop".into()))
                .unwrap()
                .phase,
            "stopped"
        );
        let stale = StartRequest {
            request_id: 7,
            book_id: "book".into(),
            position: Position::default(),
        };
        assert_eq!(
            send(&sender, Action::Start(stale, Preferences::default()))
                .unwrap()
                .request_id,
            8
        );
        let invalid = StartRequest {
            request_id: 9,
            book_id: "different".into(),
            position: Position::default(),
        };
        assert!(
            send(&sender, Action::Start(invalid, Preferences::default()))
                .unwrap_err()
                .contains("书籍已切换")
        );
        assert_eq!(send(&sender, Action::Status).unwrap().phase, "error");
        send(&sender, Action::Shutdown).unwrap();
        thread.join().unwrap();
    }
    #[test]
    #[ignore = "requires the real local CUDA engine, models and an audio device"]
    fn real_engine_ffi_playback_and_actor() {
        let preferences = Preferences::default();
        {
            let engine = Engine::load(&preferences).unwrap();
            let text = "夜里，窗外的雨停了。\n她轻声说：“我们走吧。”";
            engine.start(text, "", &preferences).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            unsafe {
                assert_eq!((engine.position)(engine.session).consumed, 0);
                while (engine.position)(engine.session).valid == 0 {
                    assert!(
                        (engine.state)(engine.session) != 5,
                        "{}",
                        CStr::from_ptr((engine.error)(engine.session)).to_string_lossy()
                    );
                    assert!(std::time::Instant::now() < deadline);
                    thread::sleep(Duration::from_millis(50));
                }
                (engine.pause)(engine.session);
                thread::sleep(Duration::from_millis(100));
                let paused = (engine.position)(engine.session).consumed;
                thread::sleep(Duration::from_millis(250));
                assert_eq!((engine.position)(engine.session).consumed, paused);
                (engine.resume)(engine.session);
                while (engine.state)(engine.session) == 1 {
                    assert!(std::time::Instant::now() < deadline);
                    thread::sleep(Duration::from_millis(50));
                }
                assert_eq!((engine.state)(engine.session), 3);
                let position = (engine.position)(engine.session);
                assert_eq!(position.begin, text.find('她').unwrap());
                assert!(position.consumed > 24000);
                engine.start(text, "", &preferences).unwrap();
                assert_eq!((engine.position)(engine.session).valid, 0);
                let stop = std::time::Instant::now();
                engine.stop_and_wait();
                assert!(stop.elapsed() < Duration::from_secs(1));
            }
        }
        let (sender, rx) = mpsc::channel();
        let thread = thread::spawn(move || run(rx, |_| {}));
        let text = "甲😀乙，雨停了。\n她轻声说：“我们走吧。”";
        let start = text[..text.find('她').unwrap()].encode_utf16().count();
        let book = Book {
            id: "native".into(),
            path: "/native".into(),
            title: "实测".into(),
            encoding: "UTF-8".into(),
            chapters: vec![
                crate::books::Chapter {
                    id: "1".into(),
                    title: "第一章".into(),
                    text: text.into(),
                },
                crate::books::Chapter {
                    id: "2".into(),
                    title: "第二章".into(),
                    text: "这一章不应被朗读。".into(),
                },
            ],
        };
        send(&sender, Action::Book(book)).unwrap();
        let request = StartRequest {
            request_id: 1,
            book_id: "native".into(),
            position: Position {
                chapter: 0,
                offset: start + 4,
            },
        };
        send(&sender, Action::Start(request, preferences)).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut observed = false;
        loop {
            let status = send(&sender, Action::Status).unwrap();
            assert_ne!(status.phase, "error", "{:?}", status.error);
            if status.paragraph_start.is_some() {
                assert_eq!(status.paragraph_start, Some(start));
                assert_eq!(status.chapter, 0);
                observed = true;
            }
            if status.phase == "completed" {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(Duration::from_millis(100));
        }
        assert!(observed);
        let restart = StartRequest {
            request_id: 2,
            book_id: "native".into(),
            position: Position {
                chapter: 0,
                offset: start,
            },
        };
        assert_ne!(
            send(&sender, Action::Start(restart, Preferences::default()))
                .unwrap()
                .phase,
            "error"
        );
        assert_eq!(
            send(&sender, Action::Control(3, "stop".into()))
                .unwrap()
                .phase,
            "stopped"
        );
        send(&sender, Action::Shutdown).unwrap();
        thread.join().unwrap();
    }
}
