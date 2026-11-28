// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `wallsong.exe --icon-guard <pid>` is the desktop icon guard Wallsong starts
    // next to itself. It never opens the app: it waits for Wallsong to end,
    // however it ends, gives the desktop icons back, and exits.
    #[cfg(windows)]
    if let Some(pid) = icon_guard_arg() {
        guard_icons(pid);
        return;
    }
    wallsong_lib::run()
}

/// `Some(pid)` when started as the icon guard. With the flag but no usable pid,
/// there's nothing to wait for: `Some(None)` still keeps the app from starting.
#[cfg(windows)]
fn icon_guard_arg() -> Option<Option<u32>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--icon-guard") {
        return None;
    }
    Some(args.next().and_then(|pid| pid.parse().ok()))
}

#[cfg(windows)]
fn guard_icons(pid: Option<u32>) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Console::FreeConsole;
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};

    let Some(pid) = pid else { return };
    unsafe {
        // Dev builds are console programs: drop the (hidden) console Explorer gave us.
        let _ = FreeConsole();
        // If Wallsong is already gone, OpenProcess fails and the icons come back straight away.
        if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(handle, INFINITE);
            let _ = CloseHandle(handle);
        }
    }
    let _ = wallsong_lib::desktop::set_desktop_icons_visible(true);
}
