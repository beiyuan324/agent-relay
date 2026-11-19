use anyhow::{anyhow, Context, Result};
use relay_core::{host::Host, relay, workbench::{Workbench, QueuedMessage}, AppEvent, ConnectionMode, Settings};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::{HashSet, VecDeque}, io::Write, path::PathBuf, sync::{Arc, OnceLock}};
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;

#[cfg(not(target_os = "android"))]
mod tray;
#[cfg(not(target_os = "android"))]
mod updater;
#[cfg(target_os = "android")]
mod mobile;
#[cfg(target_os = "android")]
#[path = "mobile_updater.rs"]
mod updater;

static RUNTIME: OnceLock<Arc<Desktop>> = OnceLock::new();
static INITIALIZING: Mutex<()> = Mutex::const_new(());
static APP: std::sync::Mutex<Option<tauri::AppHandle>> = std::sync::Mutex::new(None);

struct Desktop {
    host: Arc<Host>,
    workbench: Arc<Workbench>,
    path: PathBuf,
    mutation: Mutex<()>,
    saved: Mutex<Option<Vec<u8>>>,
    diagnostics: Mutex<VecDeque<String>>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Capabilities { local_execution: bool, host_sharing: bool, background_connection: bool }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Snapshot {
    settings: Settings,
    devices: Vec<relay_core::DeviceView>,
    addresses: Vec<relay::Address>,
    diagnostics: Vec<String>,
    listener_error: Option<String>,
    capabilities: Capabilities,
}
impl Desktop {
    async fn save(&self)->Result<()> {
        let mut saved=self.saved.lock().await;
        let bytes=serde_json::to_vec_pretty(&self.host.snapshot().await)?;
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
        *saved=Some(bytes); Ok(())
    }
    async fn add_pair(&self,config:relay_core::PairConfig,code:String)->Result<String,String> {
        let id=config.id.clone();
        write_secret(&id,&code).map_err(error)?;
        if let Err(failure)=self.host.add(config,code).await {
            let _=delete_secret(&id);return Err(error(failure));
        }
        if let Err(failure)=self.save().await {
            let _=self.host.remove(&id).await;
            let _=delete_secret(&id);return Err(error(failure));
        }
        #[cfg(target_os = "android")]
        mobile::start_background().map_err(error)?;
        Ok(id)
    }
    async fn snapshot(&self)->Snapshot {
        let settings=self.host.snapshot().await;
        Snapshot {addresses:relay::addresses(settings.listen_port),settings,devices:self.host.views().await,diagnostics:self.diagnostics.lock().await.iter().cloned().collect(),listener_error:self.host.listener_error().await,
            capabilities: Capabilities { local_execution: !cfg!(target_os="android"), host_sharing: !cfg!(target_os="android"), background_connection: cfg!(target_os="android") }}
    }
    async fn diagnostic(&self,message:String) {
        let mut diagnostics=self.diagnostics.lock().await;
        if diagnostics.len()>=100{diagnostics.pop_front();}
        diagnostics.push_back(message);
    }
}
#[cfg(not(target_os="android"))]
fn credential(id:&str)->Result<keyring::Entry> {
    keyring::Entry::new("app.agent-relay.desktop",id).map_err(|_|anyhow!("无法访问系统凭据存储"))
}
fn read_secret(id:&str)->Result<String> {
    #[cfg(target_os="android")] { mobile::read_secret(id) }
    #[cfg(not(target_os="android"))] { credential(id)?.get_password().map_err(|_|anyhow!("系统凭据不可用")) }
}
fn write_secret(id:&str,code:&str)->Result<()> {
    #[cfg(target_os="android")] { mobile::write_secret(id,code) }
    #[cfg(not(target_os="android"))] { credential(id)?.set_password(code).map_err(|_|anyhow!("无法保存配对密钥到系统凭据存储")) }
}
fn delete_secret(id:&str)->Result<()> {
    #[cfg(target_os="android")] { mobile::delete_secret(id) }
    #[cfg(not(target_os="android"))] {
        match credential(id)?.delete_credential() {
            Ok(())|Err(keyring::Error::NoEntry)=>Ok(()),
            Err(_)=>Err(anyhow!("设备已断开，但系统凭据删除失败，请在凭据管理器中删除此配对项")),
        }
    }
}
fn error(error:anyhow::Error)->String{error.to_string()}
fn emit<T: Serialize+Clone>(name:&str,event:T) {
    #[cfg(target_os="android")]
    if !mobile::foreground() { return; }
    if let Some(app)=APP.lock().unwrap().as_ref() { let _=app.emit(name,event); }
}
async fn initialize(path:PathBuf)->Result<Arc<Desktop>> {
    let _guard=INITIALIZING.lock().await;
    if let Some(state)=RUNTIME.get() {return Ok(state.clone());}
    let settings=match std::fs::read(&path) {
        Ok(bytes)=>serde_json::from_slice::<Settings>(&bytes).context("设置文件损坏。原文件已保留，请修复或重命名后重新启动")?,
        Err(error)if error.kind()==std::io::ErrorKind::NotFound=>Settings::default(),
        Err(error)=>return Err(error.into()),
    };
    #[cfg(target_os="android")]
    let settings={
        let mut settings=settings;
        settings.sharing=false; settings.codex_path.clear();
        if settings.identity.name == "localhost" || settings.identity.name == "这台电脑" { settings.identity.name=mobile::device_name()?; }
        settings
    };
    let devices=settings.devices.clone();
    let host=Host::new(settings);
    let workspace_path=if cfg!(target_os="android"){Some(path.with_file_name("workbench.json"))}else{None};
    let workbench=Workbench::new(host.clone(),workspace_path)?;
    let state=Arc::new(Desktop {host:host.clone(),workbench:workbench.clone(),path,mutation:Mutex::new(()),saved:Mutex::new(None),diagnostics:Mutex::new(VecDeque::new())});
    let mut events=host.events.subscribe();
    let event_state=state.clone();
    tauri::async_runtime::spawn(async move {
        let mut prompted_pairs=HashSet::new();
        loop {
            match events.recv().await {
                Ok(AppEvent::Persist)=>{
                    let _guard=event_state.mutation.lock().await;
                    if let Err(error)=event_state.save().await {
                        let message=error.to_string();event_state.diagnostic(message.clone()).await;
                        emit("relay:event",AppEvent::Diagnostic{message});
                    }
                },
                Ok(event)=>{
                    if let AppEvent::Diagnostic{message}=&event { event_state.diagnostic(message.clone()).await; }
                    if let AppEvent::Device{device}=&event {
                        if device.state=="pending" && !device.approved && device.peer.is_some() && prompted_pairs.insert(device.id.clone()) {
                            #[cfg(not(target_os="android"))]
                            if let Some(app)=APP.lock().unwrap().as_ref() {tray::show_window(app);}
                        }
                    }
                    #[cfg(target_os="android")]
                    mobile::notify(&event);
                    emit("relay:event",event);
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{
                    let message="事件流需要重新同步，请刷新当前会话".to_string();
                    event_state.diagnostic(message.clone()).await;
                    emit("relay:event",AppEvent::Diagnostic{message});
                },
                Err(_)=>break,
            }
        }
    });
    let mut queue_events=workbench.events.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match queue_events.recv().await {
                Ok(snapshot)=>emit("relay:queue",snapshot),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{
                    emit("relay:queue",workbench.snapshot().await);
                },
                Err(_)=>break,
            }
        }
    });
    state.workbench.start();
    host.start().await;
    #[cfg(target_os="android")]
    if devices.iter().any(|config| config.mode==ConnectionMode::Lan && config.role==relay_core::Role::Responder) {
        if mobile::call("lanStatus",Value::Null)?==true { host.start_listener().await; }
        else { state.diagnostic("局域网访问权限未开启，请打开设备详情授权并重新连接".into()).await; }
    }
    for config in devices {
        let code=read_secret(&config.id).unwrap_or_default();
        host.add(config,code).await?;
    }
    RUNTIME.set(state.clone()).map_err(|_|anyhow!("应用运行时已初始化"))?;
    Ok(state)
}
#[tauri::command]
async fn snapshot(state:State<'_,Arc<Desktop>>)->Result<Snapshot,String>{Ok(state.snapshot().await)}
#[tauri::command]
async fn detect_codex()->Result<Value,String>{
    #[cfg(not(target_os="android"))] {
        let installation=tauri::async_runtime::spawn_blocking(||relay_core::discovery::detect("")).await.map_err(|_|"Codex 自动检测未完成，请重试".to_string())?.map_err(error)?;
        serde_json::to_value(installation).map_err(|error|error.to_string())
    }
    #[cfg(target_os="android")] { Err("请在执行电脑上配置 Codex".into()) }
}
#[tauri::command]
async fn codex_call(state:State<'_,Arc<Desktop>>,device:String,method:String,params:Value)->Result<Value,String>{
    let thread=params["threadId"].as_str();
    if matches!(method.as_str(),"turn/interrupt"|"thread/archive") {
        if let Some(thread)=thread { state.workbench.pause(&relay_core::workbench::key(&device,thread),"操作已暂停待发队列".into()).await.map_err(error)?; }
    }
    if matches!(method.as_str(),"thread/compact/start"|"review/start"|"thread/fork"|"thread/archive") {
        if let Some(thread)=thread {
            if state.workbench.has_queue(&relay_core::workbench::key(&device,thread)).await {return Err("请先处理待发消息后执行此操作".into());}
        }
    }
    state.host.call(&device,&method,params).await.map_err(error)
}
async fn ensure_lan_permission()->Result<(),String>{
    #[cfg(target_os="android")] {
        let allowed=tauri::async_runtime::spawn_blocking(||mobile::call("lan",Value::Null)).await.map_err(|error|error.to_string())?.map_err(error)?;
        if allowed!=true {return Err("允许局域网访问后才能连接此电脑".into());}
    }
    Ok(())
}
#[tauri::command]
async fn create_invitation(state:State<'_,Arc<Desktop>>,endpoint:String,mode:ConnectionMode)->Result<Value,String>{
    if mode==ConnectionMode::Lan {ensure_lan_permission().await?;}
    let _guard=state.mutation.lock().await;
    if mode==ConnectionMode::Lan {
        state.host.start_listener().await;
        if let Some(error)=state.host.listener_error().await{return Err(error);}
    }
    if state.host.views().await.len()>=32{return Err("最多保存 32 对设备，请先移除不用的邀请".into());}
    let (config,code,uri)=relay::create_invitation(&endpoint,mode).map_err(error)?;
    let id=state.add_pair(config,code).await?;
    Ok(json!({"id":id,"uri":uri}))
}
#[tauri::command]
async fn join_invitation(state:State<'_,Arc<Desktop>>,uri:String)->Result<String,String>{
    let _guard=state.mutation.lock().await;
    let (config,code)=relay::parse_invitation(&uri).map_err(error)?;
    if config.mode==ConnectionMode::Lan {ensure_lan_permission().await?;}
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
    let deleted=delete_secret(&id).map_err(error);
    state.save().await.map_err(error)?;deleted
}
#[tauri::command]
async fn reconnect_device(state:State<'_,Arc<Desktop>>,id:String)->Result<(),String>{
    let _guard=state.mutation.lock().await;
    if state.host.views().await.iter().any(|device|device.id==id && device.mode==ConnectionMode::Lan){
        ensure_lan_permission().await?;
        if state.host.snapshot().await.devices.iter().any(|config|config.id==id && config.role==relay_core::Role::Responder) { state.host.start_listener().await; }
    }
    state.host.reconnect(&id).await.map_err(error)?;state.save().await.map_err(error)
}
#[tauri::command]
async fn set_sharing(state:State<'_,Arc<Desktop>>,enabled:bool)->Result<(),String>{
    if cfg!(target_os="android"){return Err("手机用于远程操作，请在执行电脑上开启共享".into());}
    let _guard=state.mutation.lock().await;
    state.host.share(enabled).await;state.save().await.map_err(error)
}
#[tauri::command]
async fn save_settings(state:State<'_,Arc<Desktop>>,codex_path:String,relay_url:String,theme:String,name:String)->Result<(),String>{
    let _guard=state.mutation.lock().await;
    state.host.update_settings(codex_path,relay_url,theme,name).await.map_err(error)?;state.save().await.map_err(error)
}
#[tauri::command]
async fn workbench_snapshot(state:State<'_,Arc<Desktop>>)->Result<relay_core::workbench::Snapshot,String>{Ok(state.workbench.snapshot().await)}
#[tauri::command]
async fn save_draft(state:State<'_,Arc<Desktop>>,key:String,draft:Value,thread:Option<Value>)->Result<(),String>{state.workbench.save_draft(key,draft,thread).await.map_err(error)}
#[tauri::command]
async fn queue_enqueue(state: State<'_, Arc<Desktop>>, device: String, thread: Value, item: QueuedMessage, draft: Option<relay_core::workbench::DraftTransition>) -> Result<relay_core::workbench::Snapshot, String> {
    state.workbench.enqueue(device, thread, item, draft).await.map_err(error)
}
#[tauri::command]
async fn queue_remove(state: State<'_, Arc<Desktop>>, key: String, id: String, restore_draft: Option<String>) -> Result<QueuedMessage, String> {
    state.workbench.remove(&key, &id, restore_draft).await.map_err(error)
}
#[tauri::command]
async fn queue_pause(state:State<'_,Arc<Desktop>>,key:String,reason:String)->Result<(),String>{state.workbench.pause(&key,reason).await.map_err(error)}
#[tauri::command]
async fn queue_resume(state:State<'_,Arc<Desktop>>,key:String,retry:Option<String>)->Result<(),String>{state.workbench.resume(&key,retry).await.map_err(error)}

#[tauri::command]
async fn mobile_action(action:String,value:Option<Value>)->Result<Value,String>{
    #[cfg(target_os="android")] { tauri::async_runtime::spawn_blocking(move||mobile::call(&action,value.unwrap_or(Value::Null))).await.map_err(|error|error.to_string())?.map_err(error) }
    #[cfg(not(target_os="android"))] { let _=(action,value);Err("此操作仅适用于安卓应用".into()) }
}
#[cfg(any(not(target_os="android"),test))]
fn settings_path(config_dir: PathBuf, platform: &str) -> PathBuf {
    let subdirectory = match platform {"windows"=>"agent-relay/Relay/config","macos"=>"app.agent-relay.Relay",_=>"relay"};
    config_dir.join(subdirectory).join("settings.json")
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder=tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(not(target_os="android"))]
    let builder=builder.plugin(tauri_plugin_updater::Builder::new().build()).on_window_event(tray::on_window_event);
    #[cfg(target_os="android")]
    let builder=builder.plugin(mobile::init());
    builder.setup(|app|{
        *APP.lock().unwrap()=Some(app.handle().clone());
        #[cfg(target_os="android")]
        let path=mobile::data_dir()?.join("settings.json");
        #[cfg(not(target_os="android"))]
        let path=settings_path(app.path().config_dir().context("无法定位用户设置目录")?,std::env::consts::OS);
        let state=tauri::async_runtime::block_on(initialize(path))?;
        app.manage(state);
        #[cfg(not(target_os="android"))] {
            app.manage(updater::Updates::new(app.package_info().version.to_string()));
            tray::setup(app)?;
        }
        Ok(())
    })
    .invoke_handler(tauri::generate_handler![snapshot,detect_codex,codex_call,create_invitation,join_invitation,approve_device,remove_device,reconnect_device,set_sharing,save_settings,workbench_snapshot,save_draft,queue_enqueue,queue_remove,queue_pause,queue_resume,mobile_action,updater::update_status,updater::check_for_updates,updater::download_update,updater::install_update])
    .build(tauri::generate_context!()).expect("Relay 无法启动")
    .run(|app,event|{
        #[cfg(not(target_os="android"))]
        if let tauri::RunEvent::Exit=event {
            if let Some(state)=app.try_state::<Arc<Desktop>>(){
                tauri::async_runtime::block_on(async {
                    state.host.shutdown().await;
                    let _guard=state.mutation.lock().await;
                    if let Err(error)=state.save().await {eprintln!("退出时保存设置失败：{error}");}
                });
            }
        }
        #[cfg(target_os="android")] let _=(app,event);
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
        let host = Host::new(Settings::default());
        Desktop { workbench: relay_core::workbench::Workbench::new(host.clone(), None).unwrap(), host, path, mutation: Mutex::new(()),
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
