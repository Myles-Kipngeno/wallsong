//! Wallsong native core.
//!
//! Three background workers feed the wallpaper window with events:
//! - `media`   reads what is playing from the Windows media session (SMTC)
//!             and emits `track`, `position` and `lyrics`.
//! - `audio`   captures what the speakers play (WASAPI loopback) and emits `beat`.
//! - `desktop` parents the wallpaper window behind the desktop icons.

mod lyrics;
mod meta;

#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod media;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

fn quit(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("wallpaper") {
        let _ = window.hide();
    }
    #[cfg(windows)]
    desktop::restore_wallpaper();
    app.exit(0);
}

/// The wallpaper sits behind the icons and can't be clicked, so the tray
/// icon (by the clock) is how you quit.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let quit_item = MenuItem::with_id(app, "quit", "Quit Wallsong", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit_item])?;
    let mut tray = TrayIconBuilder::with_id("wallsong")
        .tooltip("Wallsong")
        .menu(&menu)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                quit(app);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Play/pause/next/previous on whatever app is playing.
#[tauri::command]
async fn media_control(action: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        media::control(&action)
    }
    #[cfg(not(windows))]
    {
        let _ = action;
        Err("Media control only works on Windows".into())
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![media_control])
        .setup(|app| {
            let window = app
                .get_webview_window("wallpaper")
                .ok_or("the wallpaper window is missing from tauri.conf.json")?;
            build_tray(app)?;

            #[cfg(windows)]
            {
                desktop::attach_behind_icons(&window)?;
                media::start(app.handle().clone());
                audio::start(app.handle().clone());
            }

            #[cfg(not(windows))]
            {
                // Lets you preview the UI on another OS; native features are off.
                window.show()?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Wallsong failed to start");
}
