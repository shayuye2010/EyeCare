use std::{
    sync::{
        atomic::{AtomicIsize, Ordering},
        Mutex,
    },
    thread,
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;

static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);

#[derive(Default)]
struct OverlayState(Mutex<OverlaySession>);

#[derive(Default)]
struct OverlaySession {
    labels: Vec<String>,
    action_sent: bool,
}

fn hide_main_window_native() -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindowAsync, SW_HIDE};
        let hwnd = MAIN_HWND.load(Ordering::Relaxed);
        if hwnd == 0 {
            return Err("主窗口句柄尚未就绪".to_string());
        }
        thread::Builder::new()
            .name("eyecare-hide-main".to_string())
            .spawn(move || unsafe {
                ShowWindowAsync(hwnd as _, SW_HIDE);
            })
            .map(|_| ())
            .map_err(|error| format!("隐藏主窗口调度失败: {error}"))
    }

    #[cfg(not(windows))]
    Err("当前平台不支持托盘隐藏".to_string())
}

#[tauri::command]
fn hide_main_window(
    app: AppHandle,
) -> Result<(), String> {
    let _ = app;
    hide_main_window_native()
}

#[tauri::command]
fn minimize_to_tray(
    app: AppHandle,
) -> Result<(), String> {
    hide_main_window(app)
}

#[tauri::command]
fn quit_app(app: AppHandle) -> Result<(), String> {
    let _ = cleanup_orphan_overlays(&app);
    // Exit every EyeCare host process so the floating timer cannot outlive
    // the main interface after the user explicitly closes the application.
    thread::Builder::new()
        .name("eyecare-quit".to_string())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/IM", "eyecare.exe", "/T"])
                    .status();
                return;
            }
            #[cfg(not(windows))]
            app.exit(0);
        })
        .map(|_| ())
        .map_err(|error| format!("退出调度失败: {error}"))
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    let _ = window.unminimize();
    if let Ok(position) = window.outer_position() {
        if position.x < -10_000 || position.y < -10_000 {
            window
                .center()
                .map_err(|error| format!("恢复主窗口位置失败: {error}"))?;
        }
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    if let Err(error) = app.emit_to("main", "main-window-shown", ()) {
        eprintln!("发送主窗口恢复事件失败: {error}");
    }
    Ok(())
}

const FLOATING_LABEL: &str = "floating";
const FLOATING_SIZE: f64 = 72.0;
const FLOATING_WINDOW_WIDTH: f64 = 136.0;
const FLOATING_MARGIN: f64 = 24.0;

#[tauri::command]
fn show_floating(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(FLOATING_LABEL) {
        window
            .show()
            .map_err(|error| format!("显示悬浮窗口失败: {error}"))?;
        window
            .set_always_on_top(true)
            .map_err(|error| format!("设置悬浮窗口置顶失败: {error}"))?;
        return Ok(());
    }

    let monitor = app
        .primary_monitor()
        .map_err(|error| format!("获取主显示器失败: {error}"))?
        .ok_or_else(|| "未找到主显示器，无法创建悬浮窗口".to_string())?;
    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err("主显示器缩放比例无效，无法定位悬浮窗口".to_string());
    }

    // Monitor bounds are physical pixels while the builder position/size are
    // logical pixels. Convert both consistently so high-DPI displays are not
    // offset from the work-area corner.
    let x = (f64::from(work_area.position.x) + f64::from(work_area.size.width)
        - (FLOATING_WINDOW_WIDTH * scale_factor)
        - FLOATING_MARGIN * scale_factor)
        / scale_factor;
    let y = (f64::from(work_area.position.y) + f64::from(work_area.size.height)
        - (FLOATING_SIZE * scale_factor)
        - FLOATING_MARGIN * scale_factor)
        / scale_factor;
    if !x.is_finite() || !y.is_finite() {
        return Err("悬浮窗口位置计算失败".to_string());
    }

    let _window = WebviewWindowBuilder::new(
        &app,
        FLOATING_LABEL,
        WebviewUrl::App("floating.html".into()),
    )
    .title("EyeCare 悬浮计时")
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .always_on_top(true)
    .focused(false)
    .focusable(true)
    .visible(true)
    .skip_taskbar(true)
    .resizable(false)
    .inner_size(FLOATING_WINDOW_WIDTH, FLOATING_SIZE)
    .position(x, y)
    .build()
    .map_err(|error| format!("创建悬浮窗口失败: {error}"))?;

    Ok(())
}

#[tauri::command]
fn hide_floating(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(FLOATING_LABEL) {
        window
            .hide()
            .map_err(|error| format!("隐藏悬浮窗口失败: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn close_floating(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(FLOATING_LABEL) {
        window
            .destroy()
            .map_err(|error| format!("销毁悬浮窗口失败: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())
    } else {
        manager.disable().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn is_fullscreen_app(app: AppHandle) -> bool {
    #[cfg(windows)]
    {
        return windows_fullscreen_app(&app);
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        false
    }
}

#[cfg(windows)]
fn windows_fullscreen_app(_app: &AppHandle) -> bool {
    use windows_sys::Win32::{
        Foundation::{RECT, TRUE},
        Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        },
        UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
        },
    };

    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_null() || IsWindowVisible(foreground) != TRUE {
            return false;
        }

        // Do not treat EyeCare's own main or overlay windows as a user's fullscreen app.
        let mut process_id = 0u32;
        if GetWindowThreadProcessId(foreground, &mut process_id) == 0 {
            return false;
        }
        if process_id == std::process::id() {
            return false;
        }

        let mut rect = RECT::default();
        if GetWindowRect(foreground, &mut rect) == 0 {
            return false;
        }
        let monitor = MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return false;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return false;
        }

        let monitor_rect = info.rcMonitor;
        let same_bounds = rect.left <= monitor_rect.left
            && rect.top <= monitor_rect.top
            && rect.right >= monitor_rect.right
            && rect.bottom >= monitor_rect.bottom;
        if !same_bounds {
            return false;
        }

        // A maximized borderless window can have monitor bounds too. Treat it as
        // fullscreen only when it has no visible standard frame/menu-sized inset.
        rect.left == monitor_rect.left
            && rect.top == monitor_rect.top
            && rect.right == monitor_rect.right
            && rect.bottom == monitor_rect.bottom
    }
}

#[tauri::command]
fn show_break_overlays(
    app: AppHandle,
    style: String,
    overlays: State<'_, OverlayState>,
) -> Result<bool, String> {
    if style != "fullscreen" {
        return Ok(false);
    }

    let mut session = overlays
        .0
        .lock()
        .map_err(|_| "遮罩状态锁失败".to_string())?;
    retain_live_labels(&app, &mut session.labels);
    if !session.labels.is_empty() {
        return Ok(true);
    }
    session.action_sent = false;

    let monitors = app
        .available_monitors()
        .map_err(|error| error.to_string())?;
    if monitors.is_empty() {
        return Err("未找到可用显示器，无法创建休息遮罩".to_string());
    }

    let mut created: Vec<String> = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let label = format!("break-overlay-{index}");
        let position = monitor.position();
        let size = monitor.size();
        let scale_factor = monitor.scale_factor();
        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            let _ = destroy_labels(&app, &created);
            return Err(format!(
                "显示器缩放比例无效，无法创建休息遮罩: {scale_factor}"
            ));
        }
        let window =
            match WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("overlay.html".into()))
                .title("EyeCare 休息提醒")
                .decorations(false)
                .shadow(false)
                .transparent(false)
                .always_on_top(true)
                .focused(false)
                .focusable(true)
                .visible(false)
                .skip_taskbar(true)
                .resizable(false)
                .inner_size(
                    size.width as f64 / scale_factor,
                    size.height as f64 / scale_factor,
                )
                .position(
                    position.x as f64 / scale_factor,
                    position.y as f64 / scale_factor,
                )
                .build()
            {
                Ok(window) => window,
                Err(error) => {
                    let cleanup_error = destroy_labels(&app, &created).err();
                    return Err(match cleanup_error {
                        Some(cleanup_error) => {
                            format!(
                                "创建休息遮罩失败: {error}; 清理已创建窗口失败: {cleanup_error}"
                            )
                        }
                        None => format!("创建休息遮罩失败: {error}"),
                    });
                }
            };

        if let Err(error) = window.show().and_then(|_| window.set_always_on_top(true)) {
            let destroy_error = window.destroy().err();
            let cleanup_error = destroy_labels(&app, &created).err();
            let details = [
                destroy_error.map(|error| format!("当前窗口: {error}")),
                cleanup_error.map(|error| format!("已创建窗口: {error}")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            return Err(if details.is_empty() {
                format!("显示休息提醒失败: {error}")
            } else {
                format!(
                    "显示休息提醒失败: {error}; 清理失败: {}",
                    details.join("; ")
                )
            });
        }
        created.push(label);
    }

    session.labels = created;
    Ok(true)
}

#[tauri::command]
fn close_break_overlays(app: AppHandle, overlays: State<'_, OverlayState>) -> Result<(), String> {
    close_break_overlays_inner(&app, &overlays, true)
}

#[tauri::command]
fn break_action(
    app: AppHandle,
    action: String,
    overlays: State<'_, OverlayState>,
) -> Result<(), String> {
    if !matches!(action.as_str(), "snooze" | "skip" | "done") {
        return Err("未知的休息动作".to_string());
    }

    // Multiple monitor overlays can send the same action. Claim it once, while
    // still closing every live overlay and reporting close failures.
    let should_emit = {
        let mut session = overlays
            .0
            .lock()
            .map_err(|_| "遮罩状态锁失败".to_string())?;
        retain_live_labels(&app, &mut session.labels);
        if session.action_sent {
            false
        } else {
            session.action_sent = true;
            true
        }
    };

    if let Err(error) = close_break_overlays_inner(&app, &overlays, false) {
        if should_emit {
            if let Ok(mut session) = overlays.0.lock() {
                session.action_sent = false;
            }
        }
        return Err(error);
    }
    if should_emit {
        app.emit_to("main", "break-action", action)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn close_break_overlays_inner(
    app: &AppHandle,
    overlays: &State<'_, OverlayState>,
    reset_action: bool,
) -> Result<(), String> {
    let mut session = overlays
        .0
        .lock()
        .map_err(|_| "遮罩状态锁失败".to_string())?;
    retain_live_labels(app, &mut session.labels);
    let current = std::mem::take(&mut session.labels);
    let mut remaining = Vec::new();

    for label in current {
        if let Some(window) = app.get_webview_window(&label) {
            // Destroy directly so a CloseRequested handler cannot veto the
            // cleanup and leave an always-on-top window behind.
            if window.destroy().is_err() {
                remaining.push(label);
            }
        }
    }

    session.labels = remaining;
    if session.labels.is_empty() {
        if reset_action {
            session.action_sent = false;
        }
        Ok(())
    } else {
        Err("部分休息遮罩关闭失败".to_string())
    }
}

fn retain_live_labels<R: tauri::Runtime>(app: &AppHandle<R>, labels: &mut Vec<String>) {
    labels.retain(|label| app.get_webview_window(label).is_some());
}

fn destroy_labels<R: tauri::Runtime>(app: &AppHandle<R>, labels: &[String]) -> Result<(), String> {
    let mut failures = Vec::new();
    for label in labels {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.destroy() {
                failures.push(format!("{label}: {error}"));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("销毁窗口失败: {}", failures.join("; ")))
    }
}

fn cleanup_orphan_overlays<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let labels: Vec<String> = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, _)| {
            (label.starts_with("break-overlay-") || label == FLOATING_LABEL).then_some(label)
        })
        .collect();
    destroy_labels(app, &labels)
}

fn tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    let rest = MenuItem::with_id(app, "rest", "立即休息", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停/继续计时", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 EyeCare", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &rest, &pause, &quit])?;
    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(tauri::include_image!("icons/icon.ico"))
        .tooltip("EyeCare 亮睛睛")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(error) = show_main_window(tray.app_handle().clone()) {
                    eprintln!("托盘左键恢复主窗口失败: {error}");
                }
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Err(error) = show_main_window(app.clone()) {
                    eprintln!("托盘打开主界面失败: {error}");
                }
            }
            "rest" => {
                let shown = match show_main_window(app.clone()) {
                    Ok(()) => true,
                    Err(error) => {
                        eprintln!("托盘立即休息恢复主窗口失败: {error}");
                        false
                    }
                };
                if let Err(error) = app.emit("tray-rest", shown) {
                    eprintln!("发送托盘休息事件失败: {error}");
                }
            }
            "pause" => {
                if let Err(error) = app.emit("tray-pause", ()) {
                    eprintln!("发送托盘暂停事件失败: {error}");
                }
            }
            "quit" => {
                if let Err(error) = quit_app(app.clone()) {
                    eprintln!("托盘退出失败: {error}");
                }
            }
            _ => {}
        })
        .build(app)?;
    Ok(tray)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Err(error) = cleanup_orphan_overlays(app) {
                eprintln!("单实例启动时清理窗口失败: {error}");
            }
            if let Err(error) = show_main_window(app.clone()) {
                eprintln!("恢复主窗口失败: {error}");
            }
        }))
        .manage(OverlayState::default())
        .invoke_handler(tauri::generate_handler![
            hide_main_window,
            minimize_to_tray,
            quit_app,
            show_main_window,
            show_floating,
            hide_floating,
            close_floating,
            set_autostart,
            is_fullscreen_app,
            show_break_overlays,
            close_break_overlays,
            break_action
        ])
        .setup(|app| {
            if let Err(error) = cleanup_orphan_overlays(app.handle()) {
                eprintln!("启动时清理窗口失败: {error}");
            }
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                match window.hwnd() {
                    Ok(hwnd) => MAIN_HWND.store(hwnd.0 as isize, Ordering::Relaxed),
                    Err(error) => eprintln!("缓存主窗口句柄失败: {error}"),
                }
            }
            app.manage(tray(app.handle())?);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == FLOATING_LABEL {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("隐藏悬浮窗口失败: {error}");
                    }
                } else if window.label().starts_with("break-overlay-") {
                    api.prevent_close();
                    let app = window.app_handle();
                    let overlays = app.state::<OverlayState>();
                    if let Err(error) = close_break_overlays_inner(&app, &overlays, true) {
                        eprintln!("关闭休息遮罩失败: {error}");
                    }
                    if let Err(error) = app.emit_to("main", "break-overlay-closed", ()) {
                        eprintln!("发送休息遮罩关闭事件失败: {error}");
                    }
                } else if window.label() == "main" {
                    // The close control means exit. Minimize is the explicit tray path.
                    api.prevent_close();
                    let app = window.app_handle();
                    if let Err(error) = quit_app(app.clone()) {
                        eprintln!("关闭主窗口时退出失败: {error}");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("运行 EyeCare 失败");
}
