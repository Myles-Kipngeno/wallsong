//! Window layering on the Windows desktop.
//!
//! - Wallpaper windows go *behind* the desktop icons. The classic trick wallpaper
//!   engines use: ask Explorer (Progman) to spawn a WorkerW window between the
//!   icons and the wallpaper, then parent our window into it. Windows 11 24H2
//!   moved that WorkerW to be a child of Progman, so we look in both places.
//! - The control layer goes *on* the desktop: above the icons, below your apps.
//!   It is owned by the window that holds the icons, and is slotted into the
//!   z-order directly above that window, so icons never draw over it and
//!   "Show desktop" (Win+D) leaves it alone like the icons.
//! - The desktop icons themselves can be hidden while Wallsong runs. Only the
//!   icon list view is hidden (ShowWindow), never Explorer's "Show desktop
//!   icons" setting. However Wallsong ends, something shows them again: quitting,
//!   a crash (panic hook), Ctrl+C or a closed terminal (console handler), and for
//!   End task or a dev rebuild, the icon guard (a second wallsong.exe that waits
//!   for the first to end). Explorer also shows the list again when it restarts.

use std::ffi::c_void;

use tauri::WebviewWindow;
use windows::core::{w, Interface, BOOL, BSTR, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IDispatch, IServiceProvider, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Power::{SetThreadExecutionState, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromRect, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::Shell::{
    IShellBrowser, IShellDispatch2, IShellFolderViewDual, IShellView, IShellWindows, SHGetSetSettings, ShellWindows, CSIDL_DESKTOP, SHELLSTATEA,
    SID_STopLevelBrowser, SSF_HIDEICONS, SVGIO_BACKGROUND, SWC_DESKTOP, SWFO_NEEDDISPATCH,
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, FindWindowW, GetClassNameW, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindow, GetWindowRect,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, SendMessageTimeoutW,
    SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow, SystemParametersInfoW, GWLP_HWNDPARENT, GW_HWNDPREV, HWND_TOP,
    SMTO_NORMAL, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SPIF_SENDCHANGE, SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOW, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

/// Undocumented Progman message that creates the WorkerW layer.
const SPAWN_WORKERW: u32 = 0x052C;

/// A rectangle in physical screen pixels.
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub fn hwnd_of(window: &WebviewWindow) -> Result<HWND, String> {
    // Tauri may link a different `windows` crate version, so pass the raw handle across.
    let raw = window.hwnd().map_err(|e| format!("no window handle: {e}"))?.0 as *mut c_void;
    Ok(HWND(raw))
}

struct Found {
    /// The top-level window holding the icons (SHELLDLL_DefView).
    icons: Option<HWND>,
    /// The WorkerW that follows it, where wallpapers draw.
    layer: Option<HWND>,
}

unsafe extern "system" fn find_icons_host(top: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Found);
    if FindWindowExW(Some(top), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok() {
        out.icons = Some(top);
        if let Ok(worker) = FindWindowExW(None, Some(top), w!("WorkerW"), PCWSTR::null()) {
            out.layer = Some(worker);
        }
    }
    BOOL(1) // keep enumerating
}

/// Looks through the top-level windows for the one holding the icons
/// (SHELLDLL_DefView) and the WorkerW after it. On Windows 11 24H2 the icons
/// host is Progman itself.
fn search_desktop() -> Found {
    let mut found = Found { icons: None, layer: None };
    unsafe {
        let _ = EnumWindows(Some(find_icons_host), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

fn desktop_windows() -> Result<(HWND, Found), String> {
    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null())
            .map_err(|e| format!("could not find the desktop (Progman): {e}"))?;
        let mut result = 0usize;
        SendMessageTimeoutW(progman, SPAWN_WORKERW, WPARAM(0xD), LPARAM(0x1), SMTO_NORMAL, 1000, Some(&mut result));
        let mut found = search_desktop();
        if found.layer.is_none() {
            // Windows 11 24H2 and later: WorkerW lives inside Progman.
            found.layer = FindWindowExW(Some(progman), None, w!("WorkerW"), PCWSTR::null()).ok();
        }
        Ok((progman, found))
    }
}

/// Puts a window behind the desktop icons, covering `rect` (physical screen pixels).
pub fn attach_behind_icons(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    let ours = hwnd_of(window)?;
    let (progman, found) = desktop_windows()?;
    let layer = found.layer.unwrap_or(progman);
    unsafe {
        SetParent(ours, Some(layer)).map_err(|e| format!("could not attach to the desktop: {e}"))?;
        // Child coordinates are relative to the layer, which starts at the
        // virtual screen's top-left corner (it can be negative with a monitor on the left).
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        SetWindowPos(ours, None, rect.x - vx, rect.y - vy, rect.width, rect.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)
            .map_err(|e| format!("could not size the wallpaper: {e}"))?;
    }
    Ok(())
}

/// Makes the desktop own a window (so it survives Win+D), then slots it in
/// directly above the icons.
pub fn own_by_desktop(window: &WebviewWindow) -> Result<(), String> {
    let ours = hwnd_of(window)?;
    let (progman, found) = desktop_windows()?;
    let owner = found.icons.unwrap_or(progman);
    unsafe {
        SetWindowLongPtrW(ours, GWLP_HWNDPARENT, owner.0 as isize);
    }
    settle_above_icons(window);
    Ok(())
}

/// Puts a window directly above the window holding the icons: under every app,
/// but never under the icons. (HWND_BOTTOM could push it below them.)
pub fn settle_above_icons(window: &WebviewWindow) {
    let Ok(ours) = hwnd_of(window) else { return };
    let Some(icons) = search_desktop().icons else { return };
    unsafe {
        // The window directly above the icons host in the z-order.
        let above = GetWindow(icons, GW_HWNDPREV).ok().filter(|h| !h.is_invalid());
        if above == Some(ours) {
            return; // already in place
        }
        // Inserting "after" P puts us right under P, so directly above the icons.
        let insert_after = above.unwrap_or(HWND_TOP);
        let _ = SetWindowPos(ours, Some(insert_after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// Explorer's own "Show desktop icons" (right-click the desktop, View) is off.
/// Wallsong never overrides that choice when it shows the icons again. Read from
/// Explorer's settings rather than remembered, so it holds in the icon guard and
/// when repairing icons an older build left hidden.
fn explorer_hides_icons() -> bool {
    let mut state = SHELLSTATEA::default();
    unsafe { SHGetSetSettings(Some(&mut state), SSF_HIDEICONS, false) };
    // fHideIcons is bit 12 of SHELLSTATE's first bit field.
    let bits = state._bitfield1;
    bits & (1 << 12) != 0
}

/// The desktop's icon list view (SysListView32 "FolderView" inside SHELLDLL_DefView).
fn icon_list_view() -> Result<HWND, String> {
    let host = search_desktop().icons.ok_or("could not find the window holding the desktop icons")?;
    unsafe {
        let defview = FindWindowExW(Some(host), None, w!("SHELLDLL_DefView"), PCWSTR::null())
            .map_err(|e| format!("could not find the desktop view (SHELLDLL_DefView): {e}"))?;
        FindWindowExW(Some(defview), None, w!("SysListView32"), w!("FolderView"))
            .map_err(|e| format!("could not find the desktop icon list (FolderView): {e}"))
    }
}

/// Hides or shows the desktop icons. Cheap to call repeatedly, from any thread
/// or process: it only acts when the icons aren't already in the wanted state.
pub fn set_desktop_icons_visible(visible: bool) -> Result<(), String> {
    let list = icon_list_view()?;
    unsafe {
        let shown = IsWindowVisible(list).as_bool();
        if visible {
            // Hidden by Wallsong (this run, an earlier one, or one that was killed),
            // unless you turned the icons off in Explorer yourself.
            if !shown && !explorer_hides_icons() {
                let _ = ShowWindow(list, SW_SHOW);
            }
        } else if shown {
            let _ = ShowWindow(list, SW_HIDE);
        }
    }
    Ok(())
}

/// Asks the running Explorer to start a program, hidden, exactly as if it had
/// been opened from the desktop (Explorer's own ShellExecute, reached through
/// the desktop's automation object). The program becomes Explorer's child, not
/// Wallsong's, so it outlives anything that ends Wallsong's whole process tree:
/// End task on the Wallsong row, or cargo's job object, which `tauri dev`
/// kills on every rebuild.
fn shell_execute_from_explorer(file: &str, args: &str) -> windows::core::Result<()> {
    unsafe {
        let shell_windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
        let mut hwnd = 0i32;
        let desktop: IDispatch =
            shell_windows.FindWindowSW(&VARIANT::from(CSIDL_DESKTOP as i32), &VARIANT::default(), SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)?;
        let browser: IShellBrowser = desktop.cast::<IServiceProvider>()?.QueryService(&SID_STopLevelBrowser)?;
        let view: IShellView = browser.QueryActiveShellView()?;
        let folder: IShellFolderViewDual = view.GetItemObject::<IDispatch>(SVGIO_BACKGROUND)?.cast()?;
        let shell: IShellDispatch2 = folder.Application()?.cast()?;
        shell.ShellExecute(&BSTR::from(file), &VARIANT::from(args), &VARIANT::from(""), &VARIANT::from(""), &VARIANT::from(SW_HIDE.0))
    }
}

/// `shell_execute_from_explorer` on a short-lived thread of its own, so COM
/// is set up there and never touches the caller's thread.
pub fn launch_through_explorer(file: String, args: String) -> Result<(), String> {
    std::thread::spawn(move || {
        let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
        let result = shell_execute_from_explorer(&file, &args).map_err(|e| e.to_string());
        if com {
            unsafe { CoUninitialize() };
        }
        result
    })
    .join()
    .map_err(|_| "the launcher thread panicked".to_string())?
}

/// Mouse position in physical screen pixels.
pub fn cursor() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

/// Resets Windows' idle timer so the screen doesn't sleep. Call every few seconds.
pub fn keep_awake_tick() {
    unsafe {
        SetThreadExecutionState(ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
    }
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

fn window_class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

/// True if `hwnd` is the Windows desktop shell window (Progman or Explorer's WorkerW),
/// checked without sending messages or enumerating all top-level windows.
fn is_desktop_window(hwnd: HWND) -> bool {
    let class = window_class_name(hwnd);
    if class == "Progman" {
        return true;
    }
    if class != "WorkerW" {
        return false;
    }
    unsafe {
        if FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok() {
            return true;
        }
        if let Ok(progman) = FindWindowW(w!("Progman"), PCWSTR::null()) {
            let mut fg_pid = 0u32;
            let mut prog_pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut fg_pid));
            GetWindowThreadProcessId(progman, Some(&mut prog_pid));
            if fg_pid != 0 && fg_pid == prog_pid {
                return true;
            }
        }
    }
    false
}

/// Returns true if the wallpaper monitor is covered by a fullscreen/busy notification
/// or by a foreground window that covers the whole monitor or its work area (e.g. a
/// maximised browser), excluding the desktop and Wallsong windows.
pub fn is_monitor_covered(mon: Rect) -> bool {
    unsafe {
        // 1. Check SHQueryUserNotificationState (fullscreen 3D game or busy state)
        if let Ok(state) = SHQueryUserNotificationState() {
            if state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_BUSY {
                return true;
            }
        }

        // 2. Check foreground window
        let fg = GetForegroundWindow();
        if fg.is_invalid() || !IsWindowVisible(fg).as_bool() || IsIconic(fg).as_bool() {
            return false;
        }

        // Check if foreground window belongs to Wallsong
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid == std::process::id() {
            return false;
        }

        // Check if it's the desktop itself
        if is_desktop_window(fg) {
            return false;
        }

        let mon_win_rect = RECT {
            left: mon.x,
            top: mon.y,
            right: mon.x + mon.width,
            bottom: mon.y + mon.height,
        };
        let wall_mon = MonitorFromRect(&mon_win_rect, MONITOR_DEFAULTTOPRIMARY);
        let fg_mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);

        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let has_work = GetMonitorInfoW(wall_mon, &mut mi).as_bool();

        // Check whether the window covers the full monitor rect or maximised work area on the wallpaper monitor
        let mut rect = RECT::default();
        if GetWindowRect(fg, &mut rect).is_ok() {
            let covers_full = rect.left <= mon.x
                && rect.top <= mon.y
                && rect.right >= mon.x + mon.width
                && rect.bottom >= mon.y + mon.height;
            if covers_full {
                return true;
            }
            if has_work && fg_mon == wall_mon {
                if IsZoomed(fg).as_bool() {
                    return true;
                }
                let work = mi.rcWork;
                let covers_work = rect.left <= work.left + 2
                    && rect.top <= work.top + 2
                    && rect.right >= work.right - 2
                    && rect.bottom >= work.bottom - 2;
                if covers_work {
                    return true;
                }
            }
        }

        false
    }
}

#[cfg(test)]
mod tests {
    /// Touches the real desktop: run by hand with `cargo test --lib explorer -- --ignored`.
    #[test]
    #[ignore = "asks the running Explorer to start a program"]
    fn explorer_starts_a_program() {
        let result = super::launch_through_explorer(r"C:\Windows\System32\timeout.exe".into(), "/t 4 /nobreak".into());
        println!("launch_through_explorer: {result:?}");
        assert!(result.is_ok());
    }
}
