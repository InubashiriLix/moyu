mod books;
mod state;

use books::Book;
use serde::Serialize;
use state::{Position, Preferences, Recent, SavedState, Store};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

struct NativeState {
    shortcut: Mutex<Option<Shortcut>>,
    shortcut_error: Mutex<Option<String>>,
    wayland: bool,
    open_path: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    saved: SavedState,
    platform: String,
    wayland: bool,
    shortcut_error: Option<String>,
    warning: Option<String>,
    open_path: Option<String>,
}

#[tauri::command]
fn bootstrap(
    store: tauri::State<Store>,
    native: tauri::State<NativeState>,
) -> Result<Bootstrap, String> {
    Ok(Bootstrap {
        saved: store.saved.lock().map_err(|e| e.to_string())?.clone(),
        platform: std::env::consts::OS.into(),
        wayland: native.wayland,
        shortcut_error: native
            .shortcut_error
            .lock()
            .map_err(|e| e.to_string())?
            .clone(),
        warning: store.warning.clone(),
        open_path: native.open_path.lock().map_err(|e| e.to_string())?.take(),
    })
}

#[tauri::command]
async fn open_book(
    app: tauri::AppHandle,
    path: String,
    encoding: Option<String>,
) -> Result<Book, String> {
    let book =
        tauri::async_runtime::spawn_blocking(move || books::open(&path, encoding.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
    let store = app.state::<Store>();
    let mut saved = store.saved.lock().map_err(|e| e.to_string())?;
    saved.last_book = Some(book.id.clone());
    saved.recents.retain(|r| r.id != book.id);
    saved.recents.insert(
        0,
        Recent {
            id: book.id.clone(),
            path: book.path.clone(),
            title: book.title.clone(),
            encoding: book.encoding.clone(),
            opened_at: state::now(),
        },
    );
    saved.recents.truncate(20);
    let recent_ids: Vec<String> = saved.recents.iter().map(|r| r.id.clone()).collect();
    saved.progress.retain(|id, _| recent_ids.contains(id));
    store.persist(&saved)?;
    Ok(book)
}

#[tauri::command]
fn save_progress(store: tauri::State<Store>, id: String, position: Position) -> Result<(), String> {
    let mut saved = store.saved.lock().map_err(|e| e.to_string())?;
    saved.progress.insert(id, position);
    store.persist(&saved)
}

fn install_shortcut(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let native = app.state::<NativeState>();
    if native.wayland {
        return Ok(());
    }
    let next: Shortcut = label
        .parse()
        .map_err(|_| "快捷键格式无效，例如 Ctrl+Alt+M。".to_owned())?;
    let mut current = native.shortcut.lock().map_err(|e| e.to_string())?;
    if current.as_ref() == Some(&next) {
        return Ok(());
    }
    app.global_shortcut()
        .register(next)
        .map_err(|e| format!("快捷键注册失败，可能已被占用：{e}"))?;
    if let Some(previous) = current.take() {
        if let Err(e) = app.global_shortcut().unregister(previous) {
            let _ = app.global_shortcut().unregister(next);
            *current = Some(previous);
            return Err(format!("无法替换快捷键：{e}"));
        }
    }
    *current = Some(next);
    *native.shortcut_error.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
fn save_preferences(
    app: tauri::AppHandle,
    mut preferences: Preferences,
) -> Result<Preferences, String> {
    preferences.normalize();
    let store = app.state::<Store>();
    let previous_shortcut = store
        .saved
        .lock()
        .map_err(|e| e.to_string())?
        .preferences
        .shortcut
        .clone();
    // A conflicting global key must not prevent unrelated appearance settings
    // from being saved; retry registration when the user changes the binding.
    if preferences.shortcut != previous_shortcut {
        install_shortcut(&app, &preferences.shortcut)?;
    }
    if !app.state::<NativeState>().wayland {
        if let Some(window) = app.get_webview_window("main") {
            window
                .set_always_on_top(preferences.always_on_top)
                .map_err(|e| e.to_string())?;
        }
    }
    let mut saved = store.saved.lock().map_err(|e| e.to_string())?;
    saved.preferences = preferences.clone();
    store.persist(&saved)?;
    Ok(preferences)
}

fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    remember_geometry(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("reader-hiding", ());
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn show(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        // The compositor controls activation under Wayland. A denied focus request
        // must never undo a successful show.
        let _ = window.set_focus();
        let _ = window.emit("reader-shown", ());
    }
    Ok(())
}

fn toggle(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().map_err(|e| e.to_string())? {
            hide(app)
        } else {
            show(app)
        }
    } else {
        Ok(())
    }
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) -> Result<(), String> {
    hide(&app)
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    remember_geometry(&app);
    app.exit(0);
}

fn argument_action(args: &[String]) -> &'static str {
    if args.iter().any(|s| s == "--hide") {
        "hide"
    } else if args.iter().any(|s| s == "--toggle") {
        "toggle"
    } else {
        "show"
    }
}

fn file_argument(args: &[String], cwd: &str) -> Option<String> {
    let value = args.iter().skip(1).find(|s| !s.starts_with('-'))?;
    let path = std::path::Path::new(value);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::path::Path::new(cwd).join(path)
    };
    Some(path.to_string_lossy().into_owned())
}

fn capture_geometry(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let store = app.state::<Store>();
    if let Ok(mut saved) = store.saved.lock() {
        let scale = window.scale_factor().unwrap_or(1.0);
        if let Ok(size) = window.inner_size() {
            saved.geometry.width = (size.width as f64 / scale).max(180.0);
            saved.geometry.height = (size.height as f64 / scale).max(120.0);
        }
        if !app.state::<NativeState>().wayland {
            if let Ok(position) = window.outer_position() {
                saved.geometry.x = Some(position.x);
                saved.geometry.y = Some(position.y);
            }
        }
    };
}

fn remember_geometry(app: &tauri::AppHandle) {
    capture_geometry(app);
    let store = app.state::<Store>();
    if let Ok(saved) = store.saved.lock() {
        if let Err(e) = store.persist(&saved) {
            eprintln!("{e}");
        }
    };
}

pub fn run() {
    let open_path = file_argument(
        &std::env::args().collect::<Vec<_>>(),
        &std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy(),
    );
    let wayland = cfg!(target_os = "linux")
        && std::env::var("WAYLAND_DISPLAY").is_ok()
        && std::env::var("GDK_BACKEND").map_or(true, |s| s != "x11");
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let result = match argument_action(&args) {
                "hide" => hide(app),
                "toggle" => toggle(app),
                _ => show(app),
            };
            if let Err(e) = result {
                eprintln!("{e}");
            }
            if let Some(path) = file_argument(&args, &cwd) {
                let _ = app.emit("reader-open-file", path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(NativeState {
            shortcut: Mutex::new(None),
            shortcut_error: Mutex::new(None),
            wayland,
            open_path: Mutex::new(open_path),
        });
    if !wayland {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Err(e) = toggle(app) {
                            eprintln!("{e}");
                        }
                    }
                })
                .build(),
        );
    }
    builder
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            open_book,
            save_progress,
            save_preferences,
            hide_window,
            quit
        ])
        .setup(move |app| {
            // The single-instance plugin forwards a secondary --hide before setup.
            // A first --hide exits without constructing a window or registering keys.
            if argument_action(&std::env::args().collect::<Vec<_>>()) == "hide" {
                app.handle().exit(0);
                return Ok(());
            }
            let store = Store::load(app.path().app_data_dir()?);
            let saved = store.saved.lock().unwrap().clone();
            app.manage(store);
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Moyu")
            .decorations(false)
            .transparent(true)
            .resizable(true)
            .inner_size(saved.geometry.width, saved.geometry.height)
            .min_inner_size(180.0, 120.0)
            .visible(false)
            .always_on_top(!wayland && saved.preferences.always_on_top)
            .build()?;
            if !wayland {
                if let (Some(x), Some(y)) = (saved.geometry.x, saved.geometry.y) {
                    // Keep the reader recoverable after disconnecting a monitor.
                    if window.available_monitors()?.iter().any(|m| {
                        let p = m.position();
                        let s = m.size();
                        x >= p.x
                            && y >= p.y
                            && x < p.x + s.width as i32 - 40
                            && y < p.y + s.height as i32 - 40
                    }) {
                        window.set_position(tauri::PhysicalPosition::new(x, y))?;
                    }
                }
            }
            if let Err(e) = install_shortcut(app.handle(), &saved.preferences.shortcut) {
                *app.state::<NativeState>().shortcut_error.lock().unwrap() = Some(e);
            }
            #[cfg(target_os = "macos")]
            {
                use tauri::{
                    menu::{Menu, MenuItem},
                    tray::TrayIconBuilder,
                };
                let restore = MenuItem::with_id(app, "restore", "显示 / 隐藏", true, None::<&str>)?;
                let exit = MenuItem::with_id(app, "quit", "退出 Moyu", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&restore, &exit])?;
                TrayIconBuilder::new()
                    .icon(tauri::image::Image::from_bytes(include_bytes!(
                        "../icons/tray.png"
                    ))?)
                    .icon_as_template(true)
                    .tooltip("Moyu · 摸鱼阅读")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "restore" => {
                            let _ = toggle(app);
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
            }
            window.show()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)
            ) && window.app_handle().try_state::<Store>().is_some()
            {
                capture_geometry(window.app_handle());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = hide(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("无法启动 Moyu")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if app.try_state::<Store>().is_some() {
                    remember_geometry(app);
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                let _ = show(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_dispatch_is_explicit() {
        assert_eq!(argument_action(&["moyu".into(), "--hide".into()]), "hide");
        assert_eq!(
            argument_action(&["moyu".into(), "--toggle".into()]),
            "toggle"
        );
        assert_eq!(argument_action(&["moyu".into(), "--show".into()]), "show");
        assert_eq!(
            file_argument(&["moyu".into(), "novel.epub".into()], "/books"),
            Some("/books/novel.epub".into())
        );
        assert_eq!(
            file_argument(&["moyu".into(), "--toggle".into()], "/books"),
            None
        );
    }
}
