use anyhow::{anyhow, ensure, Context, Result};
use relay_core::AppEvent;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, Window, WindowEvent,
};

use super::Desktop;

const TRAY_ID: &str = "relay-tray";
const SHOW_ID: &str = "relay-tray-show";
const EXIT_ID: &str = "relay-tray-exit";

fn report(app: &AppHandle, message: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = app.try_state::<Arc<Desktop>>() {
            state.diagnostic(message.clone()).await;
        }
        let _ = app.emit("relay:event", AppEvent::Diagnostic { message });
    });
}

fn restore_window(app: &AppHandle) -> Result<()> {
    let window = app.get_webview_window("main").ok_or_else(||anyhow!("主窗口不可用"))?;
    window.show()?;
    if window.is_minimized()? { window.unminimize()?; }
    window.set_focus()?;
    Ok(())
}

pub(super) fn show_window(app: &AppHandle) {
    if let Err(error) = restore_window(app) {
        report(app, format!("无法显示 Relay 窗口：{error}"));
    }
}

fn hide_window(app: &AppHandle) -> Result<()> {
    // 托盘创建成功后才允许隐藏，避免窗口失去恢复入口。
    ensure!(app.tray_by_id(TRAY_ID).is_some(), "系统托盘尚未就绪，请稍后重试");
    let window = app.get_webview_window("main").ok_or_else(||anyhow!("主窗口不可用"))?;
    window.hide()?;
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" { return; }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if let Err(error) = hide_window(window.app_handle()) {
            report(window.app_handle(), format!("无法收起到系统托盘：{error}"));
        }
    }
}

pub fn setup(app: &App) -> Result<()> {
    let show = MenuItem::with_id(app, SHOW_ID, "显示主窗口", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, EXIT_ID, "退出 Relay", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &exit])?;
    let icon = app.default_window_icon().cloned().ok_or_else(||anyhow!("未找到应用图标，无法创建系统托盘"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Relay · 点击显示窗口，右键打开菜单")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_ID => show_window(app),
            // 正式退出走现有 RunEvent::Exit 清理，不触发窗口关闭时的隐藏逻辑。
            EXIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event,
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
                | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. }
            ) {
                show_window(tray.app_handle());
            }
        })
        .build(app).context("无法创建系统托盘")?;
    Ok(())
}
