use crate::{hide, show, voice};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

pub struct TrayControls {
    toggle_voice: MenuItem<tauri::Wry>,
    stop_voice: MenuItem<tauri::Wry>,
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "tray-show", "显示阅读窗口", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "tray-hide", "隐藏阅读窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(
        app,
        "tray-settings",
        "设置 / 模型 / 更新",
        true,
        None::<&str>,
    )?;
    let toggle_voice = MenuItem::with_id(
        app,
        "tray-voice-toggle",
        "暂停 / 继续朗读",
        false,
        None::<&str>,
    )?;
    let stop_voice = MenuItem::with_id(app, "tray-voice-stop", "停止朗读", false, None::<&str>)?;
    let exit = MenuItem::with_id(app, "tray-quit", "退出 Moyu", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &hide_item,
            &settings,
            &separator,
            &toggle_voice,
            &stop_voice,
            &exit,
        ],
    )?;
    let icon = if cfg!(target_os = "macos") {
        include_bytes!("../icons/tray.png").as_slice()
    } else {
        include_bytes!("../icons/32x32.png").as_slice()
    };
    TrayIconBuilder::with_id("moyu")
        .icon(tauri::image::Image::from_bytes(icon)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Moyu · 摸鱼阅读")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => {
                let _ = show(app);
            }
            "tray-hide" => {
                let _ = hide(app);
            }
            "tray-settings" => {
                let _ = show(app);
                let _ = app.emit("reader-open-settings", ());
            }
            "tray-voice-toggle" | "tray-voice-stop" => {
                let app = app.clone();
                let action = if event.id.as_ref() == "tray-voice-stop" {
                    "stop"
                } else {
                    "toggle"
                };
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = app.state::<voice::VoiceService>().control_current(action) {
                        eprintln!("{error}");
                    }
                });
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    app.manage(TrayControls {
        toggle_voice,
        stop_voice,
    });
    Ok(())
}

pub fn update_voice(app: &tauri::AppHandle, phase: &str) {
    if let Some(controls) = app.try_state::<TrayControls>() {
        let active = matches!(phase, "loading" | "buffering" | "playing" | "paused");
        let _ = controls.toggle_voice.set_enabled(active);
        let _ = controls.toggle_voice.set_text(if phase == "paused" {
            "继续朗读"
        } else {
            "暂停朗读"
        });
        let _ = controls.stop_voice.set_enabled(active);
    }
}
