//! Wallsong native core.
//!
//! Windows:
//! - `wallpaper` sits behind the desktop icons on the main screen. It shows the
//!   clock, lyrics, glow and video, and hosts Wallsong's own player (YouTube Music).
//! - `wall-1`, `wall-2`... do the same on your other screens, mirroring the main one,
//!   each set in Settings > Displays to everything, video, lyrics or off.
//! - `overlay` is the control layer: a see-through window as big as the screen,
//!   above the icons and below your apps. It only catches the mouse over its own
//!   pieces (player bar, list, cards); everywhere else clicks go to the desktop.
//!
//! Background workers:
//! - `media`   reads what other apps are playing (Windows media session).
//! - `audio`   captures what the speakers play and emits `beat`.
//! - `desktop` handles window layering behind and on the desktop.
//! - `shelf`   sends the battery every 10 s, and at once when the charger goes in or out.
//! - the icon guard, a second wallsong.exe started through Explorer, gives the
//!   desktop icons back however this process ends (see main.rs).

mod lyrics;
mod meta;
mod settings;
mod weather;
mod ytmusic;

#[cfg(windows)]
mod audio;
/// Public so main.rs can run the icon guard (`wallsong.exe --icon-guard <pid>`).
#[cfg(windows)]
pub mod desktop;
#[cfg(windows)]
mod media;
#[cfg(windows)]
mod shelf;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};

use settings::Settings;

/// Every window must use the same browser arguments, or WebView2 refuses to open it.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// Parts of the control layer that catch the mouse, in physical screen pixels.
static HIT_REGIONS: Mutex<Vec<(f64, f64, f64, f64)>> = Mutex::new(Vec::new());
/// Keep-awake is on in Settings, and music is playing.
static KEEP_AWAKE: AtomicBool = AtomicBool::new(false);
static PLAYING: AtomicBool = AtomicBool::new(false);
/// "Hide desktop icons while Wallsong runs" is on.
static HIDE_ICONS: AtomicBool = AtomicBool::new(false);
/// Serialises hiding and showing the icons, so quitting can't race the keeper thread.
static ICONS_LOCK: Mutex<()> = Mutex::new(());
/// How often the hidden icons are hidden again (Explorer re-shows them after F5 or a restart).
const ICONS_KEEPER_INTERVAL: Duration = Duration::from_secs(3);

/// The tray's "Desktop icons: ..." item, relabelled when the setting changes.
struct IconsMenuItem(MenuItem<Wry>);

/// Settings > Controls > Desktop icons is "In the Dock" (the default).
fn icons_in_dock(settings: &Value) -> bool {
    settings["general"]["desktopIcons"].as_str() != Some("desktop")
}

/// The desktop icons are hidden when they live in the Dock. With the old player
/// bar instead of the Dock there'd be no way to reach them, so they stay put.
fn hide_icons_setting(settings: &Value) -> bool {
    icons_in_dock(settings) && settings["controls"]["bottom"].as_str() != Some("bar")
}

fn icons_menu_label(in_dock: bool) -> &'static str {
    if in_dock {
        "Desktop icons: in the Dock"
    } else {
        "Desktop icons: on the desktop"
    }
}

/// The icon guard has been started this run (at most one per run).
#[cfg(windows)]
static ICON_GUARD_STARTED: AtomicBool = AtomicBool::new(false);

/// Starts the icon guard: `wallsong.exe --icon-guard <our pid>`, hidden. It waits for
/// this process to end, however it ends (End task, a dev rebuild, a crash), then
/// shows the desktop icons again (see main.rs). At most one per run; it can stay
/// when the icons go back on the desktop.
///
/// Explorer starts it, so it isn't Wallsong's child: `cargo run` (under `tauri dev`)
/// keeps its children in a job object that dies with cargo on every rebuild, and
/// End task can take a whole process tree. If Explorer can't, it's started directly,
/// detached and without a window.
#[cfg(windows)]
fn start_icon_guard() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows::Win32::System::Threading::{CREATE_NO_WINDOW, DETACHED_PROCESS};

    if ICON_GUARD_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let pid = std::process::id().to_string();
    let started = std::env::current_exe().map_err(|e| e.to_string()).and_then(|exe| {
        desktop::launch_through_explorer(exe.to_string_lossy().into_owned(), format!("--icon-guard {pid}")).or_else(|e| {
            log::warn!("Explorer couldn't start the desktop icon guard ({e}); starting it directly");
            Command::new(&exe)
                .args(["--icon-guard", &pid])
                .creation_flags(CREATE_NO_WINDOW.0 | DETACHED_PROCESS.0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                // Dropping the Child releases our handle to the guard; it runs on by itself.
                .map(drop)
                .map_err(|e| e.to_string())
        })
    });
    if let Err(e) = started {
        // Try again the next time the icons are hidden.
        ICON_GUARD_STARTED.store(false, Ordering::SeqCst);
        log::warn!("couldn't start the desktop icon guard: {e}");
    }
}

/// Ctrl+C, Ctrl+Break, closing the terminal, logging off or shutting down:
/// show the desktop icons, then let Windows end Wallsong as usual.
#[cfg(windows)]
unsafe extern "system" fn on_console_event(event: u32) -> windows::core::BOOL {
    use windows::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT};
    if matches!(event, CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT) {
        apply_icons(false);
    }
    // Not handled here: the default handler still ends the process.
    windows::core::BOOL(0)
}

/// Records the setting and hides or shows the icons to match.
fn apply_icons(hide: bool) {
    // The guard is in place before anything is hidden.
    #[cfg(windows)]
    if hide {
        start_icon_guard();
    }
    let _guard = ICONS_LOCK.lock();
    HIDE_ICONS.store(hide, Ordering::SeqCst);
    #[cfg(windows)]
    if let Err(e) = desktop::set_desktop_icons_visible(!hide) {
        log::warn!("couldn't {} the desktop icons: {e}", if hide { "hide" } else { "show" });
    }
}

/// Re-hides the icons every few seconds while the setting is on.
fn start_icon_keeper() {
    std::thread::spawn(|| loop {
        std::thread::sleep(ICONS_KEEPER_INTERVAL);
        let _guard = ICONS_LOCK.lock();
        if HIDE_ICONS.load(Ordering::SeqCst) {
            #[cfg(windows)]
            let _ = desktop::set_desktop_icons_visible(false);
        }
    });
}

// ---------- screens ----------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayInfo {
    /// Stable name Windows gives the screen, e.g. \\.\DISPLAY2.
    key: String,
    label: String,
    width: u32,
    height: u32,
    primary: bool,
}

fn monitor_key(m: &Monitor) -> String {
    m.name().cloned().unwrap_or_else(|| format!("{}x{}@{},{}", m.size().width, m.size().height, m.position().x, m.position().y))
}

fn monitors(app: &AppHandle) -> (Option<Monitor>, Vec<Monitor>) {
    let primary = app.primary_monitor().ok().flatten();
    let all = app.available_monitors().unwrap_or_default();
    (primary, all)
}

fn display_list(app: &AppHandle) -> Vec<DisplayInfo> {
    let (primary, all) = monitors(app);
    let primary_key = primary.as_ref().map(monitor_key);
    all.iter()
        .enumerate()
        .map(|(i, m)| {
            let key = monitor_key(m);
            let is_primary = Some(&key) == primary_key.as_ref();
            DisplayInfo {
                label: format!("Display {} ({}×{}){}", i + 1, m.size().width, m.size().height, if is_primary { " · main" } else { "" }),
                width: m.size().width,
                height: m.size().height,
                primary: is_primary,
                key,
            }
        })
        .collect()
}

fn find_monitor(app: &AppHandle, key: &str) -> Option<Monitor> {
    monitors(app).1.into_iter().find(|m| monitor_key(m) == key)
}

#[cfg(windows)]
fn rect_of(m: &Monitor) -> desktop::Rect {
    desktop::Rect { x: m.position().x, y: m.position().y, width: m.size().width as i32, height: m.size().height as i32 }
}

/// Which screen a window belongs to: the main wallpaper is on the primary screen,
/// mirrors carry their screen in their label's lookup table.
static MIRROR_DISPLAYS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

pub fn mirror_labels() -> Vec<String> {
    MIRROR_DISPLAYS.lock().map(|t| t.iter().map(|(l, _)| l.clone()).collect()).unwrap_or_default()
}

fn display_of_window(app: &AppHandle, label: &str) -> Option<String> {
    match label {
        "wallpaper" => monitors(app).0.as_ref().map(monitor_key),
        "overlay" => app.state::<Settings>().get()["controlsDisplay"].as_str().map(str::to_string).or_else(|| monitors(app).0.as_ref().map(monitor_key)),
        _ => MIRROR_DISPLAYS.lock().ok()?.iter().find(|(l, _)| l == label).map(|(_, k)| k.clone()),
    }
}

/// Opens or closes a mirror wallpaper on each extra screen, as Settings > Displays says.
fn apply_displays(app: &AppHandle, settings: &Value) {
    let (primary, all) = monitors(app);
    let primary_key = primary.as_ref().map(monitor_key);
    let mut wanted: Vec<(String, Monitor)> = vec![];
    for m in all {
        let key = monitor_key(&m);
        if Some(&key) == primary_key.as_ref() {
            continue;
        }
        let role = settings["displays"][&key].as_str().unwrap_or("lyrics");
        if role != "off" {
            wanted.push((key, m));
        }
    }

    let mut table = MIRROR_DISPLAYS.lock().map(|t| t.clone()).unwrap_or_default();
    // Close mirrors whose screen is gone or switched off.
    table.retain(|(label, key)| {
        let keep = wanted.iter().any(|(k, _)| k == key);
        if !keep {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.close();
            }
        }
        keep
    });
    for (key, m) in wanted {
        if table.iter().any(|(_, k)| *k == key) {
            continue;
        }
        let label = (1..)
            .map(|i| format!("wall-{i}"))
            .find(|l| !table.iter().any(|(t, _)| t == l) && app.get_webview_window(l).is_none())
            .unwrap_or_else(|| "wall-x".into());
        let url = format!("index.html?view=mirror&display={}", urlencoding::encode(&key));
        match WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
            .title("Wallsong")
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .additional_browser_args(BROWSER_ARGS)
            .build()
        {
            Ok(window) => {
                #[cfg(windows)]
                if let Err(e) = desktop::attach_behind_icons(&window, rect_of(&m)) {
                    log::warn!("couldn't put the mirror behind the icons on {key}: {e}");
                }
                #[cfg(not(windows))]
                {
                    let _ = window.set_position(*m.position());
                    let _ = window.set_size(*m.size());
                    let _ = window.show();
                }
                table.push((label, key));
            }
            Err(e) => log::warn!("couldn't open a wallpaper on {key}: {e}"),
        }
    }
    if let Ok(mut t) = MIRROR_DISPLAYS.lock() {
        *t = table;
    }
}

/// Places the control layer over the screen chosen in Settings (the main one by default).
fn layout_overlay(app: &AppHandle, settings: &Value) -> tauri::Result<()> {
    let Some(overlay) = app.get_webview_window("overlay") else { return Ok(()) };
    let monitor = settings["controlsDisplay"]
        .as_str()
        .and_then(|key| find_monitor(app, key))
        .or_else(|| monitors(app).0)
        .or_else(|| monitors(app).1.into_iter().next());
    if let Some(m) = monitor {
        overlay.set_position(PhysicalPosition::new(m.position().x, m.position().y))?;
        // One pixel short of the screen, so Windows doesn't mistake it for a
        // full-screen app (that would hide the taskbar and mute notifications).
        overlay.set_size(PhysicalSize::new(m.size().width, m.size().height.saturating_sub(1)))?;
    }
    Ok(())
}

/// Native side of a settings change.
fn apply_settings(app: &AppHandle, old: Option<&Value>, value: &Value) {
    #[cfg(windows)]
    {
        let source_changed = old.map_or(true, |o| o["source"] != value["source"]);
        if source_changed {
            let source = value["source"].as_str().unwrap_or("auto");
            media::set_pinned(match source {
                "auto" => None,
                // Wallsong-only: follow nothing else.
                "wallsong" => Some("\u{0}wallsong-only".into()),
                app_id => Some(app_id.to_string()),
            });
        }
    }
    let awake_changed = old.map_or(true, |o| o["keepAwake"] != value["keepAwake"]);
    if awake_changed {
        KEEP_AWAKE.store(value["keepAwake"].as_bool().unwrap_or(true), Ordering::Relaxed);
    }

    let icons_changed = old.map_or(true, |o| hide_icons_setting(o) != hide_icons_setting(value));
    if icons_changed {
        apply_icons(hide_icons_setting(value));
    }

    let dock_icons_changed = old.map_or(true, |o| icons_in_dock(o) != icons_in_dock(value));
    if dock_icons_changed {
        if let Some(item) = app.try_state::<IconsMenuItem>() {
            let _ = item.0.set_text(icons_menu_label(icons_in_dock(value)));
        }
    }

    let displays_changed = old.map_or(true, |o| o["displays"] != value["displays"]);
    if displays_changed {
        apply_displays(app, value);
    }

    let overlay_changed = old.map_or(true, |o| o["controlsDisplay"] != value["controlsDisplay"]);
    if overlay_changed {
        let _ = layout_overlay(app, value);
    }
}

/// Saves a partial settings change, tells every window, and applies the native parts.
fn change_settings(app: &AppHandle, patch: &Value) -> Result<Value, String> {
    let old_value = app.state::<Settings>().get();
    let value = app.state::<Settings>().update(patch)?;
    let _ = app.emit("settings", &value);
    apply_settings(app, Some(&old_value), &value);
    Ok(value)
}

// ---------- the control layer ----------

/// Keeps the control layer directly above the desktop icons (and below your apps).
fn settle_overlay(overlay: &WebviewWindow) {
    #[cfg(windows)]
    desktop::settle_above_icons(overlay);
    #[cfg(not(windows))]
    let _ = overlay;
}

fn show_overlay(app: &AppHandle, event: &str) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.show();
        let _ = overlay.set_focus();
        let _ = app.emit_to("overlay", event, ());
    }
}

/// Lets the mouse through everywhere except over the control layer's own pieces.
fn start_hit_testing(app: AppHandle) {
    std::thread::spawn(move || {
        let mut interactive: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(30));
            let Some(overlay) = app.get_webview_window("overlay") else { continue };
            #[cfg(windows)]
            let cursor = desktop::cursor();
            #[cfg(not(windows))]
            let cursor: Option<(i32, i32)> = None;
            let inside = match cursor {
                Some((x, y)) => {
                    let (x, y) = (x as f64, y as f64);
                    HIT_REGIONS.lock().map(|r| r.iter().any(|(l, t, w, h)| x >= *l && x < l + w && y >= *t && y < t + h)).unwrap_or(false)
                }
                // Without a cursor position (other OS), keep the layer clickable.
                None => true,
            };
            if interactive != Some(inside) {
                let _ = overlay.set_ignore_cursor_events(!inside);
                interactive = Some(inside);
            }
        }
    });
}

/// Keeps the screen on while music plays, if Settings says so.
fn start_keep_awake() {
    std::thread::spawn(|| loop {
        if KEEP_AWAKE.load(Ordering::Relaxed) && PLAYING.load(Ordering::Relaxed) {
            #[cfg(windows)]
            desktop::keep_awake_tick();
        }
        std::thread::sleep(Duration::from_secs(20));
    });
}

/// Watches whether the wallpaper is covered by a fullscreen app or window, and pauses animations and beats.
#[cfg(windows)]
fn start_visibility_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_covered: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let mon_rect = monitors(&app).0.or_else(|| monitors(&app).1.into_iter().next()).map(|m| rect_of(&m));
            let covered = mon_rect.map(|r| desktop::is_monitor_covered(r)).unwrap_or(false);

            if last_covered != Some(covered) {
                last_covered = Some(covered);
                audio::set_covered(covered);
                let _ = app.emit_to("wallpaper", "visibility", json!({ "covered": covered }));
                for label in mirror_labels() {
                    let _ = app.emit_to(&label, "visibility", json!({ "covered": covered }));
                }
            }
        }
    });
}

// ---------- tray and hotkey ----------

fn quit(app: &AppHandle) {
    // Desktop icons come back before anything else.
    apply_icons(false);
    for (label, window) in app.webview_windows() {
        let _ = label;
        let _ = window.hide();
    }
    #[cfg(windows)]
    desktop::restore_wallpaper();
    app.exit(0);
}

fn build_tray(app: &tauri::App, initial: &Value) -> tauri::Result<()> {
    let search = MenuItem::with_id(app, "search", "Search music (Ctrl+Alt+Space)", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "controls", "Show or hide controls", true, None::<&str>)?;
    let icons = MenuItem::with_id(app, "icons", icons_menu_label(icons_in_dock(initial)), true, None::<&str>)?;
    let devtools = MenuItem::with_id(app, "devtools", "Open devtools", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Wallsong", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&search, &settings, &toggle, &icons, &devtools, &quit_item])?;
    app.manage(IconsMenuItem(icons));
    let mut tray = TrayIconBuilder::with_id("wallsong")
        .tooltip("Wallsong")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "search" => show_overlay(app, "open-search"),
            "settings" => show_overlay(app, "open-settings"),
            "devtools" => {
                #[cfg(feature = "devtools")]
                for label in ["wallpaper", "overlay"] {
                    if let Some(w) = app.get_webview_window(label) {
                        w.open_devtools();
                    }
                }
            }
            "icons" => {
                // Same path as a change made in Settings: save, tell every window, apply.
                // Off the UI thread, like the settings_set command (applying may open windows).
                let next = if icons_in_dock(&app.state::<Settings>().get()) { "desktop" } else { "dock" };
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = change_settings(&app, &json!({ "general": { "desktopIcons": next } })) {
                        log::warn!("couldn't change the desktop icons setting: {e}");
                    }
                });
            }
            "controls" => {
                if let Some(overlay) = app.get_webview_window("overlay") {
                    if overlay.is_visible().unwrap_or(false) {
                        let _ = overlay.hide();
                    } else {
                        let _ = overlay.show();
                        settle_overlay(&overlay);
                    }
                }
            }
            "quit" => quit(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn register_hotkey(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
    let search = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if event.state() == ShortcutState::Pressed && shortcut == &search {
                    show_overlay(app, "open-search");
                }
            })
            .build(),
    )?;
    // Another app may already own the shortcut; Wallsong still works without it.
    if let Err(e) = app.global_shortcut().register(search) {
        log::warn!("Ctrl+Alt+Space is taken by another app: {e}");
    }
    Ok(())
}

// ---------- commands the windows call ----------

/// Play/pause/next/previous on whatever other app is playing.
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

/// Apps currently talking to Windows' media controls, for the source menu.
#[tauri::command]
fn media_sessions() -> Value {
    #[cfg(windows)]
    {
        json!(media::sessions())
    }
    #[cfg(not(windows))]
    {
        json!([])
    }
}

#[tauri::command]
async fn yt_search(query: String) -> Result<ytmusic::SearchResults, String> {
    ytmusic::search(&query).await
}

#[tauri::command]
async fn yt_suggest(input: String) -> Result<Value, String> {
    let (queries, items) = ytmusic::suggestions(&input).await?;
    Ok(json!({ "queries": queries, "items": items }))
}

#[tauri::command]
async fn yt_up_next(video_id: String) -> Result<Vec<ytmusic::MusicItem>, String> {
    ytmusic::up_next(&video_id).await
}

#[tauri::command]
async fn yt_find_video(title: String, artist: String) -> Result<Option<ytmusic::MusicItem>, String> {
    ytmusic::find_music_video(&title, &artist).await
}

#[tauri::command]
async fn yt_videos(title: String, artist: String) -> Result<Vec<ytmusic::MusicItem>, String> {
    ytmusic::find_videos(&title, &artist).await
}

#[tauri::command]
async fn yt_artist(browse_id: String) -> Result<ytmusic::ArtistPage, String> {
    ytmusic::artist(&browse_id).await
}

#[tauri::command]
async fn yt_album(browse_id: String) -> Result<ytmusic::AlbumPage, String> {
    ytmusic::album(&browse_id).await
}

/// Lyrics for a song Wallsong itself is playing.
#[tauri::command]
async fn fetch_lyrics(key: String, title: String, artist: String, album: String, duration_ms: u64) -> Option<lyrics::Lyrics> {
    let (title, artist) = meta::clean(&title, &artist);
    lyrics::fetch(&key, &title, &artist, &album, duration_ms).await
}

static IMAGE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static IMAGE_CACHE: Mutex<VecDeque<(String, String)>> = Mutex::new(VecDeque::new());

/// Downloads album art and returns it as a data URL, so the page can read its
/// colours (pages may not read pixels of images from other sites).
#[tauri::command]
async fn fetch_image(url: String) -> Result<String, String> {
    use base64::Engine;
    if !url.starts_with("https://") {
        return Err("only https images".into());
    }
    if let Ok(guard) = IMAGE_CACHE.lock() {
        if let Some((_, cached)) = guard.iter().find(|(k, _)| k == &url) {
            return Ok(cached.clone());
        }
    }
    let client = match IMAGE_CLIENT.get() {
        Some(c) => c,
        None => {
            let c = reqwest::Client::builder()
                .pool_max_idle_per_host(6)
                .tcp_keepalive(Duration::from_secs(30))
                .timeout(Duration::from_secs(8))
                .build()
                .map_err(|e| e.to_string())?;
            let _ = IMAGE_CLIENT.set(c);
            IMAGE_CLIENT.get().ok_or("image client init failed")?
        }
    };
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|m| m.starts_with("image/"))
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 8_000_000 {
        return Err("image too large".into());
    }
    let data_url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
    if let Ok(mut guard) = IMAGE_CACHE.lock() {
        if guard.len() >= 64 {
            guard.pop_front();
        }
        guard.push_back((url, data_url.clone()));
    }
    Ok(data_url)
}

#[tauri::command]
fn settings_get(settings: State<Settings>) -> Value {
    settings.get()
}

/// Saves a partial change, tells every window, and applies the native parts.
/// Async so it may open windows (mirror wallpapers) without blocking the UI thread.
#[tauri::command]
async fn settings_set(app: AppHandle, patch: Value) -> Result<Value, String> {
    change_settings(&app, &patch)
}

#[tauri::command]
fn displays(app: AppHandle) -> Vec<DisplayInfo> {
    display_list(&app)
}

/// Which screen the calling window is on, so it can read its own role.
#[tauri::command]
fn my_display(app: AppHandle, window: WebviewWindow) -> Option<String> {
    display_of_window(&app, window.label())
}

/// The control layer reports where its pieces are (CSS pixels, relative to the window).
#[tauri::command]
fn overlay_regions(window: WebviewWindow, rects: Vec<[f64; 4]>) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let physical = rects
        .into_iter()
        .map(|[x, y, w, h]| (origin.x as f64 + x * scale, origin.y as f64 + y * scale, w * scale, h * scale))
        .collect();
    *HIT_REGIONS.lock().map_err(|_| "regions locked")? = physical;
    Ok(())
}

/// The player card's own window (Keep above all windows) has nowhere to search:
/// bring the control layer forward with search open, like Ctrl+Alt+Space.
#[tauri::command]
fn open_search(app: AppHandle) {
    show_overlay(&app, "open-search");
}

/// The player tells the core when music plays, for keep-awake.
#[tauri::command]
fn set_playing(playing: bool) {
    PLAYING.store(playing, Ordering::Relaxed);
}

// ---------- the Dock: desktop items, battery, Recycle Bin, work area ----------

#[cfg(not(windows))]
const ONLY_WINDOWS: &str = "This only works on Windows";

/// Your Desktop and the Public Desktop, merged, folders first, with their icons.
#[tauri::command]
async fn shelf_desktop() -> Result<Value, String> {
    #[cfg(windows)]
    {
        Ok(json!(shelf::on_com_thread(shelf::desktop).await?))
    }
    #[cfg(not(windows))]
    {
        Ok(json!([]))
    }
}

/// The path of your own Desktop folder (for "Open in File Explorer").
#[tauri::command]
async fn shelf_desktop_dir() -> Result<String, String> {
    #[cfg(windows)]
    {
        shelf::on_com_thread(shelf::desktop_dir).await?.ok_or_else(|| "couldn't find your Desktop folder".into())
    }
    #[cfg(not(windows))]
    {
        Err(ONLY_WINDOWS.into())
    }
}

/// One folder, for browsing inside the Desktop panel.
#[tauri::command]
async fn shelf_folder(path: String) -> Result<Value, String> {
    #[cfg(windows)]
    {
        Ok(json!(shelf::on_com_thread(move || shelf::folder(&path)).await??))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(json!([]))
    }
}

/// Opens a file, folder, shortcut or app (or the Recycle Bin, or Calendar).
#[tauri::command]
async fn shelf_open(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        shelf::on_com_thread(move || shelf::open(&path)).await?
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(ONLY_WINDOWS.into())
    }
}

/// Shows an item selected in File Explorer.
#[tauri::command]
async fn shelf_reveal(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        shelf::reveal(&path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(ONLY_WINDOWS.into())
    }
}

/// The icon for one pinned path.
#[tauri::command]
async fn shelf_app_icon(path: String) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        shelf::on_com_thread(move || shelf::app_icon(&path)).await
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(None)
    }
}

#[tauri::command]
fn battery() -> Value {
    #[cfg(windows)]
    {
        json!(shelf::battery())
    }
    #[cfg(not(windows))]
    {
        json!({ "hasBattery": false, "percent": 0, "charging": false, "pluggedIn": false, "minutesLeft": null })
    }
}

#[tauri::command]
async fn recycle_bin() -> Result<Value, String> {
    #[cfg(windows)]
    {
        Ok(json!(shelf::on_com_thread(shelf::recycle_bin).await??))
    }
    #[cfg(not(windows))]
    {
        Err(ONLY_WINDOWS.into())
    }
}

// ---------- the always-on-top player card ("Keep above all windows") ----------

/// The control layer's position and scale: the mini window is placed in its coordinates
/// (CSS pixels from the overlay's top-left), so both windows agree where the card is.
fn overlay_frame(app: &AppHandle) -> Result<(PhysicalPosition<i32>, f64), String> {
    let overlay = app.get_webview_window("overlay").ok_or("the control layer isn't open")?;
    let origin = overlay.inner_position().map_err(|e| e.to_string())?;
    let scale = overlay.scale_factor().map_err(|e| e.to_string())?;
    Ok((origin, scale))
}

/// Opens (or moves and resizes) the card's own always-on-top window.
/// Sizes and position are CSS pixels relative to the control layer.
#[tauri::command]
async fn mini_open(app: AppHandle, width: f64, height: f64, x: f64, y: f64) -> Result<(), String> {
    let (origin, scale) = overlay_frame(&app)?;
    let position = PhysicalPosition::new(origin.x + (x * scale).round() as i32, origin.y + (y * scale).round() as i32);
    let size = PhysicalSize::new((width * scale).round().max(1.0) as u32, (height * scale).round().max(1.0) as u32);
    let window = match app.get_webview_window("mini") {
        Some(w) => w,
        None => WebviewWindowBuilder::new(&app, "mini", WebviewUrl::App("index.html?view=mini".into()))
            .title("Wallsong player")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .additional_browser_args(BROWSER_ARGS)
            .build()
            .map_err(|e| format!("couldn't open the player window: {e}"))?,
    };
    window.set_size(size).map_err(|e| e.to_string())?;
    window.set_position(position).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resizes the card's window (layout changes), keeping its top-left corner.
#[tauri::command]
async fn mini_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let (_, scale) = overlay_frame(&app)?;
    let window = app.get_webview_window("mini").ok_or("the player window isn't open")?;
    window
        .set_size(PhysicalSize::new((width * scale).round().max(1.0) as u32, (height * scale).round().max(1.0) as u32))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn mini_close(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("mini") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Where the card's window is, for saving its spot after a drag:
/// [x, y] of its top-left plus the control layer's [width, height], all in its CSS pixels.
#[tauri::command]
fn mini_place(app: AppHandle) -> Result<[f64; 4], String> {
    let (origin, scale) = overlay_frame(&app)?;
    let overlay_size = app.get_webview_window("overlay").ok_or("the control layer isn't open")?.inner_size().map_err(|e| e.to_string())?;
    let at = app.get_webview_window("mini").ok_or("the player window isn't open")?.outer_position().map_err(|e| e.to_string())?;
    Ok([
        (at.x - origin.x) as f64 / scale,
        (at.y - origin.y) as f64 / scale,
        overlay_size.width as f64 / scale,
        overlay_size.height as f64 / scale,
    ])
}

/// Weather now and today for a place (Open-Meteo).
#[tauri::command]
async fn weather(lat: f64, lon: f64) -> Result<weather::Weather, String> {
    weather::forecast(lat, lon).await
}

/// Cities matching what you typed (Open-Meteo geocoding).
#[tauri::command]
async fn weather_find(city: String) -> Result<Vec<weather::Place>, String> {
    weather::find(&city).await
}

/// The control layer's screen minus the taskbar, in CSS pixels relative to the
/// overlay window: [x, y, width, height]. The Dock sits just above the taskbar.
#[tauri::command]
fn work_area(app: AppHandle) -> Result<[f64; 4], String> {
    let overlay = app.get_webview_window("overlay").ok_or("the control layer isn't open")?;
    let scale = overlay.scale_factor().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let origin = overlay.inner_position().map_err(|e| e.to_string())?;
        let rect = shelf::work_area(desktop::hwnd_of(&overlay)?).ok_or("couldn't read the screen's work area")?;
        Ok([
            (rect.left - origin.x) as f64 / scale,
            (rect.top - origin.y) as f64 / scale,
            (rect.right - rect.left) as f64 / scale,
            (rect.bottom - rect.top) as f64 / scale,
        ])
    }
    #[cfg(not(windows))]
    {
        let size = overlay.inner_size().map_err(|e| e.to_string())?;
        Ok([0.0, 0.0, size.width as f64 / scale, size.height as f64 / scale])
    }
}

pub fn run() {
    // If Wallsong crashes, give the desktop icons back before the usual panic report.
    #[cfg(windows)]
    {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let _ = desktop::set_desktop_icons_visible(true);
            default_hook(info);
        }));
        // Ctrl+C or closing the terminal (`npm run tauri dev`) gives them back too.
        if let Err(e) = unsafe { windows::Win32::System::Console::SetConsoleCtrlHandler(Some(on_console_event), true) } {
            log::warn!("couldn't watch for Ctrl+C: {e}");
        }
    }

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            media_control,
            media_sessions,
            yt_search,
            yt_suggest,
            yt_up_next,
            yt_find_video,
            yt_videos,
            yt_artist,
            yt_album,
            fetch_lyrics,
            fetch_image,
            settings_get,
            settings_set,
            displays,
            my_display,
            overlay_regions,
            open_search,
            set_playing,
            shelf_desktop,
            shelf_desktop_dir,
            shelf_folder,
            shelf_open,
            shelf_reveal,
            shelf_app_icon,
            battery,
            recycle_bin,
            work_area,
            weather,
            weather_find,
            mini_open,
            mini_resize,
            mini_close,
            mini_place
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = Settings::load(&handle);
            let initial = settings.get();
            app.manage(settings);

            // Desktop icons on the desktop: show them now, in case an older build
            // (or one that was killed) left them hidden.
            if !hide_icons_setting(&initial) {
                apply_icons(false);
            }

            let wallpaper = app
                .get_webview_window("wallpaper")
                .ok_or("the wallpaper window is missing from tauri.conf.json")?;
            let overlay = app.get_webview_window("overlay").ok_or("the overlay window is missing from tauri.conf.json")?;
            build_tray(app, &initial)?;
            register_hotkey(app)?;

            layout_overlay(&handle, &initial)?;
            #[cfg(windows)]
            if let Err(e) = desktop::own_by_desktop(&overlay) {
                log::warn!("couldn't attach the controls to the desktop: {e}");
            }
            overlay.show()?;
            let _ = overlay.set_ignore_cursor_events(true);
            settle_overlay(&overlay);
            // When you click away from the controls, they drop back behind your apps.
            let overlay_for_events = overlay.clone();
            overlay.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    settle_overlay(&overlay_for_events);
                }
            });
            start_hit_testing(handle.clone());
            start_keep_awake();
            start_icon_keeper();

            #[cfg(windows)]
            {
                let main = monitors(&handle).0.or_else(|| monitors(&handle).1.into_iter().next()).ok_or("no screen found")?;
                desktop::attach_behind_icons(&wallpaper, rect_of(&main))?;
                media::start(handle.clone());
                audio::start(handle.clone());
                shelf::start_battery_watch(handle.clone());
                start_visibility_watch(handle.clone());
            }

            #[cfg(not(windows))]
            {
                // Lets you preview the UI on another OS; native features are off.
                wallpaper.show()?;
            }

            apply_settings(&handle, None, &initial);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Wallsong failed to start");

    app.run(|_app, event| {
        // Any normal way out (tray Quit, app.exit, the last window closing) shows the icons.
        if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
            apply_icons(false);
        }
    });
}
