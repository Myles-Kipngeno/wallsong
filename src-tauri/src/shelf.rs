//! The Dock's view of Windows: your desktop items with their real icons, opening
//! and revealing them, the battery, the Recycle Bin, and where the taskbar is.
//!
//! Icons come from the shell's system image list (the same pictures Explorer
//! shows), converted to small PNG data URLs. Shell calls need COM, so every
//! command that touches the shell runs on a worker thread that initialises it
//! (see `on_com_thread`).

use std::collections::HashMap;
use std::ffi::c_void;
use std::os::windows::fs::MetadataExt;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetMonitorInfoW, GetObjectW, MonitorFromWindow, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HBITMAP, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
use windows::Win32::UI::Shell::{
    SHGetFileInfoW, SHGetImageList, SHGetKnownFolderPath, SHQueryRecycleBinW, ShellExecuteW, FOLDERID_Desktop, FOLDERID_PublicDesktop,
    KF_FLAG_DEFAULT, SHFILEINFOW, SHGFI_SYSICONINDEX, SHIL_EXTRALARGE, SHIL_JUMBO, SHQUERYRBINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO, SW_SHOWNORMAL};

/// One thing on the desktop or in a folder.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// "folder", "shortcut", "file" or "app".
    pub kind: String,
    /// The item's Windows icon as a data:image/png;base64 URL.
    pub icon: Option<String>,
    pub modified_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub has_battery: bool,
    pub percent: u8,
    /// Windows says it's charging (BatteryFlag & 8), or it's on mains power below 100%.
    pub charging: bool,
    /// On mains power (ACLineStatus == 1).
    pub plugged_in: bool,
    /// Minutes of battery left (BatteryLifeTime / 60), on battery power when Windows knows.
    pub minutes_left: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleBin {
    pub items: u64,
    pub bytes: u64,
}

/// Icons are sent at most this big (px); the Dock never shows them larger.
const ICON_PX: u32 = 96;
/// A folder shows at most this many items in the Desktop panel.
pub const FOLDER_LIMIT: usize = 500;
/// Targets that aren't files but may still be opened.
const SPECIAL_TARGETS: [&str; 2] = ["shell:RecycleBinFolder", "outlookcal:"];

const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;

// ---------- COM ----------

/// Initialises COM (single-threaded apartment) for as long as it lives.
struct Com(bool);

impl Com {
    fn init() -> Self {
        // S_FALSE (already initialised) also needs a matching CoUninitialize; a failure doesn't.
        Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// Runs shell work on a blocking worker thread with COM set up, off the UI thread.
pub async fn on_com_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _com = Com::init();
        work()
    })
    .await
    .map_err(|e| format!("the desktop helper stopped: {e}"))
}

// ---------- listing ----------

/// Hidden and system files, and desktop.ini, stay out of the Dock, as they do on the desktop.
pub fn is_listed(file_name: &str, attributes: u32) -> bool {
    attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) == 0 && !file_name.eq_ignore_ascii_case("desktop.ini")
}

fn extension(file_name: &str) -> String {
    Path::new(file_name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// "folder", "shortcut" (.lnk, .url), "app" (.exe) or "file".
pub fn kind_of(file_name: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "folder";
    }
    match extension(file_name).as_str() {
        "lnk" | "url" => "shortcut",
        "exe" | "appref-ms" => "app",
        _ => "file",
    }
}

/// Shortcuts show their own name without ".lnk" / ".url"; everything else keeps its full name.
pub fn display_name(file_name: &str, is_dir: bool) -> String {
    if kind_of(file_name, is_dir) == "shortcut" {
        if let Some(stem) = Path::new(file_name).file_stem().and_then(|s| s.to_str()) {
            return stem.to_string();
        }
    }
    file_name.to_string()
}

/// Folders first, then by name (ignoring case), like Explorer.
pub fn sort_items(items: &mut [ShelfItem]) {
    items.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name)));
}

fn list_dir(dir: &Path, out: &mut Vec<ShelfItem>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !is_listed(&file_name, meta.file_attributes()) {
            continue;
        }
        let is_dir = meta.is_dir();
        let modified_ms = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        out.push(ShelfItem {
            name: display_name(&file_name, is_dir),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            kind: kind_of(&file_name, is_dir).to_string(),
            icon: None,
            modified_ms,
        });
    }
}

fn known_folder(id: &windows::core::GUID) -> Option<String> {
    unsafe {
        let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let path = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const c_void));
        path
    }
}

/// Your Desktop folder.
pub fn desktop_dir() -> Option<String> {
    known_folder(&FOLDERID_Desktop)
}

/// Your Desktop and the Public Desktop together, with icons. Call on a COM thread.
pub fn desktop() -> Vec<ShelfItem> {
    let mut items = Vec::new();
    for id in [&FOLDERID_Desktop, &FOLDERID_PublicDesktop] {
        if let Some(dir) = known_folder(id) {
            list_dir(Path::new(&dir), &mut items);
        }
    }
    sort_items(&mut items);
    add_icons(&mut items);
    items
}

/// One folder's items (at most FOLDER_LIMIT), with icons. Call on a COM thread.
pub fn folder(path: &str) -> Result<Vec<ShelfItem>, String> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(format!("{path} isn't a folder (it may have been moved or deleted)"));
    }
    let mut items = Vec::new();
    list_dir(dir, &mut items);
    sort_items(&mut items);
    items.truncate(FOLDER_LIMIT);
    add_icons(&mut items);
    Ok(items)
}

fn add_icons(items: &mut [ShelfItem]) {
    for item in items {
        item.icon = icon_for(&item.path, item.modified_ms);
    }
}

// ---------- icons ----------

/// Icons by (path, modified time): a changed file gets a fresh icon.
static ICON_CACHE: Mutex<Option<HashMap<(String, u64), Option<String>>>> = Mutex::new(None);

static DISK_ICON_DIR: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();

fn disk_icon_cache_dir() -> Option<&'static std::path::PathBuf> {
    DISK_ICON_DIR
        .get_or_init(|| {
            let local = std::env::var_os("LOCALAPPDATA")?;
            let path = std::path::PathBuf::from(local).join("app.wallsong.desktop").join("cache").join("icons");
            let _ = std::fs::create_dir_all(&path);
            Some(path)
        })
        .as_ref()
}

fn disk_icon_file(path: &str, modified_ms: u64) -> Option<std::path::PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    modified_ms.hash(&mut hasher);
    let filename = format!("{:016x}.txt", hasher.finish());
    disk_icon_cache_dir().map(|d| d.join(filename))
}

/// The icon for one path, from the memory or disk cache when it hasn't changed. Call on a COM thread.
pub fn icon_for(path: &str, modified_ms: u64) -> Option<String> {
    let key = (path.to_string(), modified_ms);
    if let Some(hit) = ICON_CACHE.lock().ok().and_then(|c| c.as_ref().and_then(|m| m.get(&key).cloned())) {
        return hit;
    }
    if let Some(file) = disk_icon_file(path, modified_ms) {
        if let Ok(cached_data) = std::fs::read_to_string(&file) {
            let hit = Some(cached_data);
            if let Ok(mut cache) = ICON_CACHE.lock() {
                let map = cache.get_or_insert_with(HashMap::new);
                map.insert(key.clone(), hit.clone());
            }
            return hit;
        }
    }
    let icon = unsafe { shell_icon(path) }.and_then(|hicon| {
        let rgba = unsafe { icon_rgba(hicon) };
        unsafe {
            let _ = DestroyIcon(hicon);
        }
        let (w, h, px) = rgba?;
        let (w, h, px) = crop_small_icon(w, h, px);
        let (w, h, px) = shrink(w, h, &px, ICON_PX);
        png_data_url(w, h, &px)
    });
    if let Some(ref ic) = icon {
        if let Some(file) = disk_icon_file(path, modified_ms) {
            let _ = std::fs::write(file, ic);
        }
    }
    if let Ok(mut cache) = ICON_CACHE.lock() {
        let map = cache.get_or_insert_with(HashMap::new);
        if map.len() > 4000 {
            map.clear();
        }
        map.insert(key, icon.clone());
    }
    icon
}

/// The icon of a single path (a pinned app or folder). Call on a COM thread.
pub fn app_icon(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let modified_ms = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    icon_for(path, modified_ms)
}

/// The largest icon Windows has for a path: 256 px (jumbo), else 48 px.
unsafe fn shell_icon(path: &str) -> Option<HICON> {
    let mut info = SHFILEINFOW::default();
    let found = SHGetFileInfoW(
        &HSTRING::from(path),
        FILE_FLAGS_AND_ATTRIBUTES(0),
        Some(&mut info),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_SYSICONINDEX,
    );
    if found == 0 {
        return None;
    }
    for list in [SHIL_JUMBO, SHIL_EXTRALARGE] {
        if let Ok(images) = SHGetImageList::<IImageList>(list as i32) {
            if let Ok(icon) = images.GetIcon(info.iIcon, ILD_TRANSPARENT.0) {
                if !icon.is_invalid() {
                    return Some(icon);
                }
            }
        }
    }
    None
}

fn top_down_header(width: i32, height: i32) -> BITMAPINFO {
    BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // negative: top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    }
}

/// Reads a bitmap as 32-bit BGRA, top row first.
unsafe fn read_bitmap(bitmap: HBITMAP, width: i32, height: i32) -> Option<Vec<u8>> {
    let mut px = vec![0u8; (width * height * 4) as usize];
    let mut header = top_down_header(width, height);
    let dc = GetDC(None);
    let lines = GetDIBits(dc, bitmap, 0, height as u32, Some(px.as_mut_ptr() as *mut c_void), &mut header, DIB_RGB_COLORS);
    ReleaseDC(None, dc);
    (lines != 0).then_some(px)
}

/// An icon as RGBA pixels. Frees the bitmaps GetIconInfo makes (the caller frees the icon).
unsafe fn icon_rgba(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
    let mut info = ICONINFO::default();
    GetIconInfo(icon, &mut info).ok()?;
    let result = (|| {
        if info.hbmColor.is_invalid() {
            return None; // black-and-white icon: nothing on the desktop uses these any more
        }
        let mut bm = BITMAP::default();
        if GetObjectW(info.hbmColor.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut BITMAP as *mut c_void)) == 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        if w <= 0 || h <= 0 {
            return None;
        }
        let mut px = read_bitmap(info.hbmColor, w, h)?;
        // Old-style icons carry no alpha: the mask says which pixels are see-through.
        if px.chunks_exact(4).all(|p| p[3] == 0) {
            match read_bitmap(info.hbmMask, w, h) {
                Some(mask) => {
                    for (p, m) in px.chunks_exact_mut(4).zip(mask.chunks_exact(4)) {
                        p[3] = if m[0] == 0 { 255 } else { 0 };
                    }
                }
                None => px.chunks_exact_mut(4).for_each(|p| p[3] = 255),
            }
        }
        for p in px.chunks_exact_mut(4) {
            p.swap(0, 2); // BGRA -> RGBA
        }
        Some((w as u32, h as u32, px))
    })();
    if !info.hbmColor.is_invalid() {
        let _ = DeleteObject(info.hbmColor.into());
    }
    if !info.hbmMask.is_invalid() {
        let _ = DeleteObject(info.hbmMask.into());
    }
    result
}

/// Items without a 256 px icon come back from the jumbo list as their small icon
/// drawn in the top-left corner of a 256 px square. Cut that square back out.
pub fn crop_small_icon(w: u32, h: u32, px: Vec<u8>) -> (u32, u32, Vec<u8>) {
    if w < 128 || w != h {
        return (w, h, px);
    }
    let (mut right, mut bottom) = (0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            if px[((y * w + x) * 4 + 3) as usize] != 0 {
                right = right.max(x + 1);
                bottom = bottom.max(y + 1);
            }
        }
    }
    let used = right.max(bottom);
    if used == 0 || used > w / 2 {
        return (w, h, px);
    }
    // Back to the standard size the small icon was drawn at, keeping its own padding.
    let size = [16, 20, 24, 32, 40, 48, 64, 96, 128].into_iter().find(|s| *s >= used).unwrap_or(used);
    let mut out = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        let start = ((y * w) * 4) as usize;
        out.extend_from_slice(&px[start..start + (size * 4) as usize]);
    }
    (size, size, out)
}

/// Shrinks to at most `max` px with a box filter (never enlarges).
pub fn shrink(w: u32, h: u32, px: &[u8], max: u32) -> (u32, u32, Vec<u8>) {
    if w <= max && h <= max {
        return (w, h, px.to_vec());
    }
    let scale = (w.max(h) as f64) / max as f64;
    let (nw, nh) = (((w as f64) / scale).round().max(1.0) as u32, ((h as f64) / scale).round().max(1.0) as u32);
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        let (y0, y1) = (((y as f64) * scale) as u32, ((((y + 1) as f64) * scale).ceil() as u32).min(h));
        for x in 0..nw {
            let (x0, x1) = (((x as f64) * scale) as u32, ((((x + 1) as f64) * scale).ceil() as u32).min(w));
            // Average with alpha weighting, so see-through pixels don't darken the edges.
            let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = ((sy * w + sx) * 4) as usize;
                    let pa = px[i + 3] as u64;
                    r += px[i] as u64 * pa;
                    g += px[i + 1] as u64 * pa;
                    b += px[i + 2] as u64 * pa;
                    a += pa;
                    n += 1;
                }
            }
            let o = ((y * nw + x) * 4) as usize;
            if a > 0 {
                out[o] = (r / a) as u8;
                out[o + 1] = (g / a) as u8;
                out[o + 2] = (b / a) as u8;
                out[o + 3] = (a / n.max(1)) as u8;
            }
        }
    }
    (nw, nh, out)
}

fn png_data_url(w: u32, h: u32, rgba: &[u8]) -> Option<String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
        writer.finish().ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

// ---------- opening ----------

/// Opens a file, folder, shortcut or app the way double-clicking it would.
/// Only existing paths, plus the Recycle Bin and the Calendar app. Call on a COM thread.
pub fn open(target: &str) -> Result<(), String> {
    if !SPECIAL_TARGETS.contains(&target) && !Path::new(target).exists() {
        return Err(format!("{target} no longer exists"));
    }
    let result = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(target), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    // ShellExecute reports success with a value above 32.
    let code = result.0 as isize;
    if code > 32 {
        Ok(())
    } else {
        Err(format!("Windows couldn't open {target} (code {code})"))
    }
}

/// Opens File Explorer with the item selected.
pub fn reveal(path: &str) -> Result<(), String> {
    if path.contains('"') || !Path::new(path).exists() {
        return Err(format!("{path} no longer exists"));
    }
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{path}\""))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("couldn't start File Explorer: {e}"))
}

// ---------- battery, Recycle Bin, work area ----------

/// `GetSystemPowerStatus` "doesn't know" value for BatteryLifeTime.
const UNKNOWN_LIFE_TIME: u32 = 0xFFFF_FFFF;
/// The battery goes to the windows this often…
const BATTERY_REFRESH: Duration = Duration::from_secs(10);
/// …and straight away when the charger goes in or out, checked this often.
const PLUG_POLL: Duration = Duration::from_secs(2);

/// The battery, from `GetSystemPowerStatus`'s fields (kept apart for tests).
pub fn battery_from(ac_line_status: u8, battery_flag: u8, life_percent: u8, life_time: u32) -> Battery {
    // 128: no system battery. 255: Windows can't tell.
    let has_battery = battery_flag != 128 && battery_flag != 255;
    // 255: percent unknown.
    let known = life_percent <= 100;
    let percent = if known { life_percent } else { 0 };
    // ACLineStatus 0: on battery, 1: plugged in, 255: unknown.
    let plugged_in = ac_line_status == 1;
    let on_battery = ac_line_status == 0;
    Battery {
        has_battery,
        percent,
        charging: has_battery && (battery_flag & 8 != 0 || (plugged_in && known && percent < 100)),
        plugged_in,
        minutes_left: (has_battery && on_battery && life_time != UNKNOWN_LIFE_TIME).then_some(life_time / 60),
    }
}

pub fn battery() -> Battery {
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
        return battery_from(255, 255, 255, UNKNOWN_LIFE_TIME);
    }
    battery_from(status.ACLineStatus, status.BatteryFlag, status.BatteryLifePercent, status.BatteryLifeTime)
}

/// Sends the battery to the windows ("battery" event) every 10 s, and at once when
/// the charger is plugged in or pulled out (looked at every 2 s, on this same thread).
pub fn start_battery_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_plugged: Option<bool> = None;
        let mut last_sent: Option<Instant> = None;
        loop {
            let now = battery();
            let plug_changed = last_plugged.is_some_and(|was| was != now.plugged_in);
            if plug_changed || last_sent.is_none_or(|at| at.elapsed() >= BATTERY_REFRESH) {
                let _ = app.emit("battery", &now);
                last_sent = Some(Instant::now());
            }
            last_plugged = Some(now.plugged_in);
            std::thread::sleep(PLUG_POLL);
        }
    });
}

pub fn recycle_bin() -> Result<RecycleBin, String> {
    let mut info = SHQUERYRBINFO { cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32, ..Default::default() };
    unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info) }.map_err(|e| format!("couldn't read the Recycle Bin: {e}"))?;
    Ok(RecycleBin { items: info.i64NumItems.max(0) as u64, bytes: info.i64Size.max(0) as u64 })
}

/// The work area (screen minus taskbar) of the monitor a window is on, in physical pixels.
pub fn work_area(window: HWND) -> Option<RECT> {
    unsafe {
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        GetMonitorInfoW(monitor, &mut info).as_bool().then_some(info.rcWork)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, is_dir: bool) -> ShelfItem {
        ShelfItem { name: name.into(), path: format!("C:\\Desktop\\{name}"), is_dir, kind: kind_of(name, is_dir).into(), icon: None, modified_ms: 0 }
    }

    #[test]
    fn folders_first_then_names_ignoring_case() {
        let mut items = vec![item("zeta.txt", false), item("Projects", true), item("alpha.lnk", false), item("archive", true), item("Beta.url", false)];
        sort_items(&mut items);
        let names: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["archive", "Projects", "alpha.lnk", "Beta.url", "zeta.txt"]);
    }

    #[test]
    fn hides_hidden_system_and_desktop_ini() {
        assert!(is_listed("Notes.txt", 0x20)); // archive bit only
        assert!(!is_listed("secret.txt", FILE_ATTRIBUTE_HIDDEN));
        assert!(!is_listed("thumbs.db", FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_HIDDEN));
        assert!(!is_listed("desktop.ini", 0));
        assert!(!is_listed("Desktop.INI", 0x20));
        assert!(is_listed("Projects", 0x10)); // a plain folder
    }

    #[test]
    fn shortcuts_drop_their_extension() {
        assert_eq!(display_name("Docker Desktop.lnk", false), "Docker Desktop");
        assert_eq!(display_name("YouTube Music.url", false), "YouTube Music");
        assert_eq!(display_name("report.pdf", false), "report.pdf");
        assert_eq!(display_name("my.folder.lnk", true), "my.folder.lnk");
        assert_eq!(kind_of("setup.EXE", false), "app");
        assert_eq!(kind_of("Brave.lnk", false), "shortcut");
        assert_eq!(kind_of("Projects", true), "folder");
        assert_eq!(kind_of("notes.md", false), "file");
    }

    #[test]
    fn crops_a_small_icon_out_of_the_jumbo_square() {
        // A 48 px icon drawn top-left in a 256 px canvas (content 40 px across).
        let mut px = vec![0u8; 256 * 256 * 4];
        for y in 4..44 {
            for x in 4..44 {
                px[(y * 256 + x) * 4 + 3] = 255;
            }
        }
        let (w, h, out) = crop_small_icon(256, 256, px);
        assert_eq!((w, h), (48, 48));
        assert_eq!(out.len(), 48 * 48 * 4);
        // A real 256 px icon is left alone.
        let full = vec![255u8; 256 * 256 * 4];
        assert_eq!(crop_small_icon(256, 256, full).0, 256);
    }

    #[test]
    fn battery_charging() {
        // Windows' charging flag (8), plugged in, 76%.
        let b = battery_from(1, 8 | 1, 76, UNKNOWN_LIFE_TIME);
        assert_eq!(b, Battery { has_battery: true, percent: 76, charging: true, plugged_in: true, minutes_left: None });
        // Plugged in below 100% counts as charging even without the flag.
        assert!(battery_from(1, 1, 90, UNKNOWN_LIFE_TIME).charging);
    }

    #[test]
    fn battery_plugged_in_and_full() {
        let b = battery_from(1, 1, 100, UNKNOWN_LIFE_TIME);
        assert_eq!(b, Battery { has_battery: true, percent: 100, charging: false, plugged_in: true, minutes_left: None });
    }

    #[test]
    fn battery_on_battery_with_time_left() {
        // 54%, 2 h 10 min left (7800 s), flag 0 (neither high nor low).
        let b = battery_from(0, 0, 54, 7800);
        assert_eq!(b, Battery { has_battery: true, percent: 54, charging: false, plugged_in: false, minutes_left: Some(130) });
    }

    #[test]
    fn battery_time_unknown_or_no_battery() {
        // On battery, but Windows doesn't know the time yet.
        assert_eq!(battery_from(0, 2, 18, UNKNOWN_LIFE_TIME).minutes_left, None);
        // Plugged in: no "time left", even if Windows reports one.
        assert_eq!(battery_from(1, 1, 60, 3600).minutes_left, None);
        // A desktop PC (no battery) and an unknown state: no battery, nothing charging.
        let desktop = battery_from(1, 128, 255, UNKNOWN_LIFE_TIME);
        assert_eq!(desktop, Battery { has_battery: false, percent: 0, charging: false, plugged_in: true, minutes_left: None });
        assert!(!battery_from(255, 255, 255, UNKNOWN_LIFE_TIME).has_battery);
    }

    #[test]
    fn shrinks_but_never_enlarges() {
        let px = vec![200u8; 256 * 256 * 4];
        let (w, h, out) = shrink(256, 256, &px, 96);
        assert_eq!((w, h), (96, 96));
        assert_eq!(&out[0..4], &[200, 200, 200, 200]);
        assert_eq!(shrink(48, 48, &vec![0u8; 48 * 48 * 4], 96).0, 48);
    }
}
