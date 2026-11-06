use anyhow::{anyhow, Context, Result};
use relay_core::{host::Host, relay, AppEvent, ConnectionMode, Settings};
use serde::Serialize;
use serde_json::Value;
use std::{collections::{HashSet, VecDeque}, io::Write, path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;

mod tray;
mod updater;

struct Desktop {
    host: Arc<Host>,
    path: PathBuf,
    mutation: Mutex<()>,
    saved: Mutex<Option<Vec<u8>>>,
    diagnostics: Mutex<VecDeque<String>>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Snapshot {
    settings: Settings,
    devices: Vec<relay_core::DeviceView>,
    addresses: Vec<relay::Address>,
    diagnostics: Vec<String>,
    listener_error: Option<String>,
}
impl Desktop {
    async fn save(&self)->Result<()> {
        let mut saved=self.saved.lock().await;
        let settings=self.host.snapshot().await;
        let bytes=serde_json::to_vec_pretty(&settings)?;
        if saved.as_ref()==Some(&bytes){return Ok(());}
        let path=self.path.clone();
        let bytes=tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let parent=path.parent().ok_or_else(||anyhow!("设置目录无效"))?;
            std::fs::create_dir_all(parent)?;
            let mut file=tempfile::NamedTempFile::new_in(parent)?;
            file.write_all(&bytes)?;
            file.as_file().sync_all()?;
            file.persist(&path).map_err(|_|anyhow!("无法原子保存设置，请检查目录权限"))?;
            Ok(bytes)
        }).await??;
        *saved=Some(bytes);
        Ok(())
    }
    async fn add_pair(&self,config:relay_core::PairConfig,code:String)->Result<String,String> {
        let id=config.id.clone();
        credential(&id).and_then(|entry|entry.set_password(&code).map_err(|_|anyhow!("无法保存配对密钥到系统凭据存储"))).map_err(error)?;
        if let Err(failure)=self.host.add(config,code).await {
            let _=credential(&id).and_then(|e|e.delete_credential().map_err(Into::into));return Err(error(failure));
        }
        if let Err(failure)=self.save().await {
            let _=self.host.remove(&id).await;
            let _=credential(&id).and_then(|e|e.delete_credential().map_err(Into::into));return Err(error(failure));
        }
        Ok(id)
    }
    async fn snapshot(&self)->Snapshot {
        let settings=self.host.snapshot().await;
        Snapshot {addresses:relay::addresses(settings.listen_port),settings,devices:self.host.views().await,diagnostics:self.diagnostics.lock().await.iter().cloned().collect(),listener_error:self.host.listener_error().await}
    }
    async fn diagnostic(&self,message:String) {
        let mut diagnostics=self.diagnostics.lock().await;
        if diagnostics.len()>=100{diagnostics.pop_front();}
        diagnostics.push_back(message);
    }
}
fn credential(id:&str)->Result<keyring::Entry> {
    keyring::Entry::new("app.agent-relay.desktop",id).map_err(|_|anyhow!("无法访问系统凭据存储"))
}
fn error(error:anyhow::Error)->String{error.to_string()}

#[tauri::command]
async fn snapshot(state:State<'_,Arc<Desktop>>)->Result<Snapshot,String>{Ok(state.snapshot().await)}

#[tauri::command]
async fn detect_codex()->Result<relay_core::discovery::CodexInstallation,String>{
    tauri::async_runtime::spawn_blocking(||relay_core::discovery::detect("")).await
        .map_err(|_|"Codex 自动检测未完成，请重试".to_string())?.map_err(error)
}

#[tauri::command]
async fn codex_call(state:State<'_,Arc<Desktop>>,device:String,method:String,params:Value)->Result<Value,String>{
    state.host.call(&device,&method,params).await.map_err(error)
}
#[tauri::command]
async fn create_invitation(state:State<'_,Arc<Desktop>>,endpoint:String,mode:ConnectionMode)->Result<Value,String>{
    let _guard=state.mutation.lock().await;
    if mode==ConnectionMode::Lan {
        if let Some(error)=state.host.listener_error().await{return Err(error);}
    }
    if state.host.views().await.len()>=32{return Err("最多保存 32 对设备，请先移除不用的邀请".into());}
    let (config,code,uri)=relay::create_invitation(&endpoint,mode).map_err(error)?;
    let id=state.add_pair(config,code).await?;
    Ok(serde_json::json!({"id":id,"uri":uri}))
}
#[tauri::command]
async fn join_invitation(state:State<'_,Arc<Desktop>>,uri:String)->Result<String,String>{
    let _guard=state.mutation.lock().await;
    let (config,code)=relay::parse_invitation(&uri).map_err(error)?;
    let id=config.id.clone();
    if state.host.views().await.iter().any(|device|device.id==id){return Err("此配对已经添加，请在设备详情中重新连接".into());}
    if state.host.views().await.len()>=32{return Err("最多保存 32 对设备".into());}
    state.add_pair(config,code).await
}
#[tauri::command]
async fn approve_device(state:State<'_,Arc<Desktop>>,id:String)->Result<(),String>{
    let _guard=state.mutation.lock().await;
    state.host.approve(&id).await.map_err(error)?;state.save().await.map_err(error)
}
#[tauri::command]
async fn remove_device(state:State<'_,Arc<Desktop>>,id:String)->Result<(),String>{
    let _guard=state.mutation.lock().await;
    state.host.remove(&id).await.map_err(error)?;
    let deleted=match credential(&id).and_then(|entry|match entry.delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>Ok(()),Err(_)=>Err(anyhow!("设备已断开，但系统凭据删除失败，请在凭据管理器中删除此配对项"))}){Ok(())=>Ok(()),Err(e)=>Err(error(e))};
    state.save().await.map_err(error)?;deleted
}
#[tauri::command]
async fn reconnect_device(state:State<'_,Arc<Desktop>>,id:String)->Result<(),String>{
    let _guard=state.mutation.lock().await;
    state.host.reconnect(&id).await.map_err(error)?;state.save().await.map_err(error)
}
#[tauri::command]
async fn set_sharing(state:State<'_,Arc<Desktop>>,enabled:bool)->Result<(),String>{
    let _guard=state.mutation.lock().await;
    state.host.share(enabled).await;state.save().await.map_err(error)
}
#[tauri::command]
async fn save_settings(state:State<'_,Arc<Desktop>>,codex_path:String,relay_url:String,theme:String,name:String)->Result<(),String>{
    let _guard=state.mutation.lock().await;
    state.host.update_settings(codex_path,relay_url,theme,name).await.map_err(error)?;state.save().await.map_err(error)
}

// 保留既有配置目录命名，让升级后的应用继续读取原设置。
fn settings_path(config_dir: PathBuf, platform: &str) -> PathBuf {
    let subdirectory = match platform {
        "windows" => "agent-relay/Relay/config",
        "macos" => "app.agent-relay.Relay",
        _ => "relay",
    };
    config_dir.join(subdirectory).join("settings.json")
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(tray::on_window_event)
        .setup(|app|{
            let config_dir=app.path().config_dir().context("无法定位用户设置目录")?;
            let path=settings_path(config_dir,std::env::consts::OS);
            let settings=match std::fs::read(&path) {
                Ok(bytes)=>serde_json::from_slice::<Settings>(&bytes).context("设置文件损坏。原文件已保留，请修复或重命名后重新启动")?,
                Err(error)if error.kind()==std::io::ErrorKind::NotFound=>Settings::default(),
                Err(error)=>return Err(error.into()),
            };
            let devices=settings.devices.clone();
            let host=Host::new(settings);
            let state=Arc::new(Desktop{host:host.clone(),path,mutation:Mutex::new(()),saved:Mutex::new(None),diagnostics:Mutex::new(VecDeque::new())});
            app.manage(state.clone());
            app.manage(updater::Updates::new(app.package_info().version.to_string()));
            tray::setup(app)?;
            let handle=app.handle().clone();
            tauri::async_runtime::block_on(async move {
                // Subscribe before listeners or reconnection tasks can emit state.
                let mut events=host.events.subscribe();
                let (persist,mut saves)=tokio::sync::mpsc::channel::<()>(1);
                let save_state=state.clone();let save_handle=handle.clone();
                tauri::async_runtime::spawn(async move {
                    while saves.recv().await.is_some() {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        while saves.try_recv().is_ok() {}
                        let _guard=save_state.mutation.lock().await;
                        if save_state.save().await.is_err(){
                            let message="无法保存设备状态，请检查设置目录权限".to_string();
                            save_state.diagnostic(message.clone()).await;
                            let _=save_handle.emit("relay:event",AppEvent::Diagnostic{message});
                        }
                    }
                });
                let event_state=state.clone();let event_handle=handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut prompted_pairs=HashSet::new();
                    loop {
                        match events.recv().await {
                            Ok(AppEvent::Persist)=>{let _=persist.try_send(());},
                            Ok(event)=>{
                                if let AppEvent::Diagnostic{message}=&event{event_state.diagnostic(message.clone()).await;}
                                if let AppEvent::Device{device}=&event {
                                    if device.state=="pending" && !device.approved && device.peer.is_some() && prompted_pairs.insert(device.id.clone()) {
                                        tray::show_window(&event_handle);
                                    }
                                }
                                let _=event_handle.emit("relay:event",event);
                            },
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{
                                let message="桌面事件流需要重新同步，请刷新当前会话".to_string();
                                event_state.diagnostic(message.clone()).await;
                                let _=event_handle.emit("relay:event",AppEvent::Diagnostic{message});
                            },
                            Err(_)=>break,
                        }
                    }
                });
                let startup_guard=state.mutation.lock().await;
                host.start().await;
                for config in devices {
                    let code=credential(&config.id).and_then(|e|e.get_password().map_err(|_|anyhow!("系统凭据不可用"))).unwrap_or_default();
                    host.add(config,code).await?;
                }
                drop(startup_guard);
                Ok::<(),anyhow::Error>(())
            })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![snapshot,detect_codex,codex_call,create_invitation,join_invitation,approve_device,remove_device,reconnect_device,set_sharing,save_settings,updater::update_status,updater::check_for_updates,updater::download_update,updater::install_update])
        .build(tauri::generate_context!())
        .expect("Relay 无法启动")
        .run(|app,event|{
            if let tauri::RunEvent::Exit=event {
                if let Some(state)=app.try_state::<Arc<Desktop>>(){
                    tauri::async_runtime::block_on(async {
                        state.host.shutdown().await;
                        let _guard=state.mutation.lock().await;
                        if let Err(error)=state.save().await {eprintln!("退出时保存设置失败：{error}");}
                    });
                }
            }
        });
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_path_preserves_platform_layouts() {
        let root=PathBuf::from("用户 配置");
        for (platform, suffix) in [
            ("windows", "agent-relay/Relay/config/settings.json"),
            ("macos", "app.agent-relay.Relay/settings.json"),
            ("linux", "relay/settings.json"),
        ] {
            assert_eq!(settings_path(root.clone(),platform),root.join(suffix));
        }
    }

    fn desktop(path: PathBuf) -> Desktop {
        Desktop { host: Host::new(Settings::default()), path, mutation: Mutex::new(()),
            saved: Mutex::new(None), diagnostics: Mutex::new(VecDeque::new()) }
    }

    #[tokio::test]
    async fn settings_save_is_atomic_and_skips_identical_snapshots() {
        let directory=tempfile::tempdir().unwrap();
        let state=desktop(directory.path().join("settings.json"));
        state.save().await.unwrap();
        let initial=std::fs::read(&state.path).unwrap();
        let timestamp=std::time::UNIX_EPOCH+std::time::Duration::from_secs(1_000_000);
        std::fs::File::options().write(true).open(&state.path).unwrap().set_modified(timestamp).unwrap();
        let before=std::fs::metadata(&state.path).unwrap().modified().unwrap();
        state.save().await.unwrap();
        assert_eq!(std::fs::metadata(&state.path).unwrap().modified().unwrap(),before);
        assert_eq!(std::fs::read(&state.path).unwrap(),initial);
        state.host.update_settings(String::new(),String::new(),"dark".into(),"Updated device".into()).await.unwrap();
        state.save().await.unwrap();
        let settings:Settings=serde_json::from_slice(&std::fs::read(&state.path).unwrap()).unwrap();
        assert_eq!(settings.identity.name,"Updated device");
        assert_eq!(settings.theme,"dark");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(),1);
    }

    #[tokio::test]
    async fn failed_persistence_can_be_retried_without_changing_settings() {
        let directory=tempfile::tempdir().unwrap();
        let state=desktop(directory.path().join("settings.json"));
        std::fs::create_dir(&state.path).unwrap();
        assert!(state.save().await.is_err());
        assert!(state.saved.lock().await.is_none());
        std::fs::remove_dir(&state.path).unwrap();
        state.save().await.unwrap();
        assert!(serde_json::from_slice::<Settings>(&std::fs::read(&state.path).unwrap()).is_ok());
    }
}
