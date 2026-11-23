//! Puts the wallpaper window behind the desktop icons.
//!
//! The classic trick wallpaper engines use: ask Explorer (Progman) to spawn a
//! WorkerW window between the icons and the wallpaper, then parent our window
//! into it. Windows 11 24H2 moved that WorkerW to be a child of Progman, so we
//! look in both places.

use std::ffi::c_void;

use tauri::WebviewWindow;
use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, FindWindowW, GetSystemMetrics, SendMessageTimeoutW, SetParent,
    SetWindowPos, SystemParametersInfoW, SMTO_NORMAL, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SPIF_SENDCHANGE, SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER, SWP_NOACTIVATE, SWP_NOZORDER,
    SWP_SHOWWINDOW, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

/// Undocumented Progman message that creates the WorkerW layer.
const SPAWN_WORKERW: u32 = 0x052C;

unsafe extern "system" fn find_icons_host(top: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Option<HWND>);
    // The top-level window holding the icons (SHELLDLL_DefView)...
    if FindWindowExW(Some(top), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok() {
        // ...is followed by the WorkerW we draw into.
        if let Ok(worker) = FindWindowExW(None, Some(top), w!("WorkerW"), PCWSTR::null()) {
            *out = Some(worker);
        }
    }
    BOOL(1) // keep enumerating
}

fn find_wallpaper_layer(progman: HWND) -> Option<HWND> {
    let mut found: Option<HWND> = None;
    unsafe {
        let _ = EnumWindows(Some(find_icons_host), LPARAM(&mut found as *mut _ as isize));
    }
    if found.is_some() {
        return found;
    }
    // Windows 11 24H2 and later: WorkerW lives inside Progman.
    unsafe { FindWindowExW(Some(progman), None, w!("WorkerW"), PCWSTR::null()).ok() }
}

pub fn attach_behind_icons(window: &WebviewWindow) -> Result<(), String> {
    // Tauri may link a different `windows` crate version, so pass the raw handle across.
    let raw = window.hwnd().map_err(|e| format!("no window handle: {e}"))?.0 as *mut c_void;
    let ours = HWND(raw);

    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null())
            .map_err(|e| format!("could not find the desktop (Progman): {e}"))?;
        let mut result = 0usize;
        SendMessageTimeoutW(progman, SPAWN_WORKERW, WPARAM(0xD), LPARAM(0x1), SMTO_NORMAL, 1000, Some(&mut result));

        let layer = find_wallpaper_layer(progman).unwrap_or(progman);
        SetParent(ours, Some(layer)).map_err(|e| format!("could not attach to the desktop: {e}"))?;

        // Cover every monitor. Child coordinates are relative to the layer, which
        // starts at the virtual screen's top-left corner.
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        SetWindowPos(ours, None, 0, 0, width, height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)
            .map_err(|e| format!("could not size the wallpaper: {e}"))?;
    }
    Ok(())
}

/// Re-applies the user's own wallpaper so our last frame doesn't stay painted
/// on the desktop after Wallsong quits.
pub fn restore_wallpaper() {
    unsafe {
        let mut path = [0u16; 260];
        let read = SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            path.len() as u32,
            Some(path.as_mut_ptr() as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        if read.is_ok() {
            let _ = SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, Some(path.as_mut_ptr() as *mut c_void), SPIF_SENDCHANGE);
        }
    }
}
