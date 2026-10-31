use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CONTROL_VERSION: u32 = 1;
pub const MAX_MESSAGE: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity { pub id: String, pub name: String, pub platform: String }
impl Default for Identity {
    fn default() -> Self {
        Self { id: uuid::Uuid::new_v4().to_string(), name: hostname::get().map(|v| v.to_string_lossy().into_owned()).unwrap_or_else(|_| "这台电脑".into()), platform: std::env::consts::OS.into() }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Role { Initiator, Responder }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionMode { Lan, Relay }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairConfig {
    pub id: String,
    pub endpoint: String,
    pub mode: ConnectionMode,
    pub role: Role,
    pub peer: Option<Identity>,
    pub approved: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub identity: Identity,
    pub codex_path: String,
    pub relay_url: String,
    pub listen_port: u16,
    pub sharing: bool,
    pub theme: String,
    pub devices: Vec<PairConfig>,
}
impl Default for Settings {
    fn default() -> Self {
        Self { identity: Identity::default(), codex_path: String::new(), relay_url: String::new(), listen_port: 47321, sharing: false, theme: "system".into(), devices: vec![] }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub peer: Option<Identity>,
    pub mode: ConnectionMode,
    pub endpoint: String,
    pub state: String,
    pub approved: bool,
    pub peer_approved: bool,
    pub peer_sharing: bool,
    pub error: Option<String>,
}
impl From<&PairConfig> for DeviceView {
    fn from(p: &PairConfig) -> Self {
        Self { id:p.id.clone(),peer:p.peer.clone(),mode:p.mode.clone(),endpoint:p.endpoint.clone(),state:"offline".into(),approved:p.approved,peer_approved:false,peer_sharing:false,error:None }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AppEvent {
    Device { device: DeviceView },
    Codex { device: String, message: Value },
    Diagnostic { message: String },
    Persist,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Control {
    Hello { version: u32, identity: Identity, approved: bool, sharing: bool },
    Trust { approved: bool },
    Sharing { enabled: bool },
    Request { id: String, method: String, params: Value },
    Response { id: String, result: Option<Value>, error: Option<String> },
    Event { message: Value },
    Ping,
    Pong,
    Fragment { id: String, index: usize, total: usize, b: String },
}
