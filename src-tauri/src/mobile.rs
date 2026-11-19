use anyhow::{anyhow, Result};
use jni::{objects::{GlobalRef, JClass, JString, JValue}, sys::{jboolean, jstring}, JNIEnv, JavaVM};
use relay_core::AppEvent;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, OnceLock}};
use tauri::plugin::{Builder, TauriPlugin};

static VM: OnceLock<JavaVM> = OnceLock::new();
static CLASS: OnceLock<GlobalRef> = OnceLock::new();
static FOREGROUND: AtomicBool = AtomicBool::new(true);
pub fn foreground() -> bool { FOREGROUND.load(Ordering::Acquire) }

pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("mobile").setup(|_, api| {
        api.register_android_plugin("app.agentrelay.mobile", "RelayPlugin")?;
        Ok(())
    }).build()
}
pub fn call(action: &str, value: Value) -> Result<Value> {
    let mut env = VM.get().ok_or_else(|| anyhow!("安卓运行环境尚未就绪"))?.attach_current_thread()?;
    let class = JClass::from(env.new_local_ref(CLASS.get().ok_or_else(|| anyhow!("安卓桥接尚未就绪"))?.as_obj())?);
    let request = env.new_string(json!({"action":action,"value":value}).to_string())?;
    let response = env.call_static_method(class, "call", "(Ljava/lang/String;)Ljava/lang/String;", &[JValue::Object(&request)])?.l()?;
    let response: String = env.get_string(&JString::from(response))?.into();
    let response: Value = serde_json::from_str(&response)?;
    if response["ok"] != true { return Err(anyhow!("{}", response["error"].as_str().unwrap_or("安卓系统操作失败"))); }
    Ok(response["value"].clone())
}
pub fn data_dir() -> Result<PathBuf> { Ok(PathBuf::from(call("dataPath", Value::Null)?.as_str().ok_or_else(||anyhow!("应用目录无效"))?)) }
pub fn device_name() -> Result<String> { Ok(call("deviceName", Value::Null)?.as_str().ok_or_else(||anyhow!("设备名称无效"))?.into()) }
pub fn read_secret(id: &str) -> Result<String> { Ok(call("readSecret", json!({"id":id}))?.as_str().ok_or_else(||anyhow!("系统凭据不可用"))?.into()) }
pub fn write_secret(id: &str, code: &str) -> Result<()> { call("writeSecret", json!({"id":id,"code":code}))?; Ok(()) }
pub fn delete_secret(id: &str) -> Result<()> { call("deleteSecret", json!({"id":id}))?; Ok(()) }
pub fn start_background() -> Result<()> { call("startBackground", Value::Null)?; Ok(()) }
pub fn notify(event: &AppEvent) {
    let relevant = match event {
        AppEvent::Codex { message, .. } => message.get("id").is_some() || matches!(message["method"].as_str(), Some("turn/completed"|"relay/approvalResolved"|"serverRequest/resolved")),
        AppEvent::Device { device } => device.state == "pending",
        _ => false,
    };
    if relevant {
        if let Err(error) = call("event", serde_json::to_value(event).expect("应用事件可序列化")) {
            eprintln!("安卓通知失败：{error}");
        }
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_agentrelay_mobile_RelayNative_configure(env: JNIEnv, class: JClass) {
    let vm = env.get_java_vm().expect("JavaVM");
    let class = env.new_global_ref(class).expect("安卓应用类");
    let _ = VM.set(vm); let _ = CLASS.set(class);
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_agentrelay_mobile_RelayNative_boot(env: JNIEnv, _: JClass) -> jstring {
    let result = data_dir().and_then(|path| tauri::async_runtime::block_on(super::initialize(path.join("settings.json"))).map(|_|()));
    let value = result.err().map(|error|error.to_string()).unwrap_or_default();
    env.new_string(value).expect("启动结果").into_raw()
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_agentrelay_mobile_RelayNative_visibility(mut env: JNIEnv, _: JClass, visible: jboolean, target: JString) {
    FOREGROUND.store(visible != 0, Ordering::Release);
    if visible != 0 {
        let target: String = env.get_string(&target).map(Into::into).unwrap_or_default();
        let value = serde_json::from_str::<Value>(&target).unwrap_or(Value::Null);
        super::emit("relay:resume", value);
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_agentrelay_mobile_RelayNative_sendEvent(mut env: JNIEnv, _: JClass, name: JString, data: JString) {
    let result = (|| -> Result<()> {
        let name: String = env.get_string(&name)?.into();
        let data: String = env.get_string(&data)?.into();
        super::emit(&name, serde_json::from_str::<Value>(&data)?);
        Ok(())
    })();
    if let Err(error) = result { eprintln!("安卓事件无效：{error}"); }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_agentrelay_mobile_RelayNative_networkChanged(_: JNIEnv, _: JClass) {
    if let Some(state) = super::RUNTIME.get().cloned() {
        tauri::async_runtime::spawn(async move {
            for device in state.host.views().await {
                if !matches!(device.state.as_str(),"pending"|"replaced"|"credentialMissing"|"waiting") {
                    if let Err(error)=state.host.reconnect(&device.id).await { state.diagnostic(error.to_string()).await; }
                }
            }
        });
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_agentrelay_mobile_RelayNative_active(_: JNIEnv, _: JClass, active: jboolean) {
    if let Some(state)=super::RUNTIME.get().cloned() {
        tauri::async_runtime::spawn(async move {
            state.host.set_active(active != 0).await;
            if active == 0 {
                if let Err(error)=state.workbench.pause_all("后台连接已停止，请同步会话后继续").await { state.diagnostic(error.to_string()).await; }
            }
        });
    }
}
