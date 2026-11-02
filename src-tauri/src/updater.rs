use serde::Serialize;
use std::{sync::{Mutex as StdMutex, MutexGuard}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

use super::Desktop;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    revision: u64,
    phase: String,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    last_checked: Option<u64>,
    error: Option<String>,
}

struct UpdateData {
    status: UpdateStatus,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

pub struct Updates {
    operation: Mutex<()>,
    data: StdMutex<UpdateData>,
}

impl Updates {
    pub fn new(version: String) -> Self {
        Self {
            operation: Mutex::new(()),
            data: StdMutex::new(UpdateData {
                status: UpdateStatus {
                    revision: 0,
                    phase: if cfg!(debug_assertions) { "development" } else { "idle" }.into(),
                    current_version: version,
                    version: None,
                    notes: None,
                    downloaded: 0,
                    total: None,
                    last_checked: None,
                    error: None,
                },
                update: None,
                bytes: None,
            }),
        }
    }

    fn data(&self) -> MutexGuard<'_, UpdateData> {
        self.data.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn publish(&self, app: &AppHandle, change: impl FnOnce(&mut UpdateData)) -> UpdateStatus {
        let mut data = self.data();
        change(&mut data);
        data.status.revision += 1;
        let status = data.status.clone();
        drop(data);
        let _ = app.emit("relay:update", &status);
        status
    }

    pub fn status(&self) -> UpdateStatus { self.data().status.clone() }

    async fn check(&self, app: &AppHandle) -> UpdateStatus {
        if cfg!(debug_assertions) { return self.status(); }
        let Ok(_operation) = self.operation.try_lock() else { return self.status(); };
        if self.data().bytes.is_some() { return self.status(); }
        self.publish(app, |data| {
            data.status.phase = "checking".into();
            data.status.error = None;
        });
        let result = async {
            let exit_app = app.clone();
            app.updater_builder()
                .timeout(Duration::from_secs(20))
                .on_before_exit(move || before_exit(&exit_app))
                .build()?.check().await
        }.await;
        self.publish(app, |data| {
            data.status.last_checked = SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|time| time.as_secs() * 1000);
            match result {
                Ok(update) => {
                    data.status.phase = if update.is_some() { "available" } else { "upToDate" }.into();
                    data.status.version = update.as_ref().map(|update| update.version.clone());
                    data.status.notes = update.as_ref().and_then(|update| update.body.clone());
                    data.status.downloaded = 0;
                    data.status.total = None;
                    data.update = update;
                }
                Err(error) => {
                    data.status.phase = if data.update.is_some() { "available" } else { "error" }.into();
                    data.status.error = Some(format!("无法检查更新：{error}。请检查网络后重试。"));
                }
            }
        })
    }
}

#[tauri::command]
pub fn update_status(updates: State<'_, Updates>) -> UpdateStatus { updates.status() }

#[tauri::command]
pub async fn check_for_updates(app: AppHandle, updates: State<'_, Updates>) -> Result<UpdateStatus, String> {
    Ok(updates.check(&app).await)
}

#[tauri::command]
pub async fn download_update(app: AppHandle, updates: State<'_, Updates>) -> Result<UpdateStatus, String> {
    if cfg!(debug_assertions) { return Err("开发模式不下载安装更新，请使用正式安装版。".into()); }
    let _operation = updates.operation.try_lock().map_err(|_| "正在处理更新，请稍后重试")?;
    if updates.data().bytes.is_some() { return Ok(updates.status()); }
    let mut update = updates.data().update.clone().ok_or("请先检查是否有新版本")?;
    update.timeout = Some(Duration::from_secs(300));
    updates.publish(&app, |data| {
        data.status.phase = "downloading".into();
        data.status.error = None;
        data.status.downloaded = 0;
        data.status.total = None;
    });
    let mut last_progress = Instant::now();
    let result = update.download(|chunk, total| {
        let mut data = updates.data();
        data.status.downloaded = data.status.downloaded.saturating_add(chunk as u64);
        data.status.total = total;
        drop(data);
        if last_progress.elapsed() >= Duration::from_millis(100) {
            updates.publish(&app, |_| {});
            last_progress = Instant::now();
        }
    }, || {}).await;
    Ok(updates.publish(&app, |data| match result {
        Ok(bytes) => {
            data.status.phase = "ready".into();
            data.status.downloaded = bytes.len() as u64;
            data.bytes = Some(bytes);
        }
        Err(error) => {
            data.status.phase = "available".into();
            data.status.downloaded = 0;
            data.status.total = None;
            data.status.error = Some(format!("更新下载或签名验证失败：{error}。可重试下载。"));
        }
    }))
}

#[tauri::command]
pub async fn install_update(app: AppHandle, updates: State<'_, Updates>, desktop: State<'_, std::sync::Arc<Desktop>>) -> Result<UpdateStatus, String> {
    if cfg!(debug_assertions) { return Err("开发模式不安装更新。".into()); }
    let _operation = updates.operation.try_lock().map_err(|_| "正在处理更新，请稍后重试")?;
    // Block new work from both the local window and remote peers until installation exits.
    let _work = desktop.host.prepare_update().await.map_err(|error| error.to_string())?;
    let _settings = desktop.mutation.lock().await;
    desktop.save().await.map_err(|error| format!("安装前保存设置失败：{error}"))?;
    let update = updates.data().update.clone().ok_or("请先检查更新")?;
    let bytes = updates.data().bytes.take().ok_or("请先下载并验证更新")?;
    updates.publish(&app, |data| {
        data.status.phase = "installing".into();
        data.status.error = None;
    });
    // Windows installer exits the process. Use a blocking worker so its shutdown hook can
    // finish the async save/shutdown path without nesting a runtime on a runtime thread.
    let result = tauri::async_runtime::spawn_blocking(move || update.install(&bytes)).await;
    match result {
        Ok(Ok(())) => {
            // Other desktop platforms need a relaunch; Windows has already exited.
            drop(_settings);
            drop(_work);
            app.restart();
        }
        result => {
            let detail = match result {
                Ok(Err(error)) => error.to_string(),
                Err(error) => error.to_string(),
                _ => unreachable!(),
            };
            Ok(updates.publish(&app, |data| {
                data.status.phase = "available".into();
                data.status.downloaded = 0;
                data.status.total = None;
                data.status.error = Some(format!("安装更新失败：{detail}。请重新打开 Relay 后重试。"));
            }))
        }
    }
}

pub fn before_exit(app: &AppHandle) {
    if let Some(desktop) = app.try_state::<std::sync::Arc<Desktop>>() {
        tauri::async_runtime::block_on(desktop.host.shutdown());
    }
    app.cleanup_before_exit();
}
