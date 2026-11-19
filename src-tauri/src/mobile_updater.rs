use serde_json::Value;
async fn action(name: &'static str) -> Result<Value,String> {
    tauri::async_runtime::spawn_blocking(move || super::mobile::call(name,Value::Null)).await
        .map_err(|error|error.to_string())?.map_err(|error|error.to_string())
}
#[tauri::command]
pub async fn update_status()->Result<Value,String>{action("updateStatus").await}
#[tauri::command]
pub async fn check_for_updates()->Result<Value,String>{action("checkUpdates").await}
#[tauri::command]
pub async fn download_update()->Result<Value,String>{action("downloadUpdate").await}
#[tauri::command]
pub async fn install_update()->Result<Value,String>{action("installUpdate").await}
