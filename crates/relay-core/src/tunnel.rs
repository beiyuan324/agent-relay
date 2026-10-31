//! relay-kit agent-side wmsg multiplexing. The client connects directly to /c/<rt>/__alma_e2e__.
use crate::{crypto, net::{self, Transport, Wire}};
use anyhow::{anyhow, bail, ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, time::{Duration, Instant}};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

enum Out { Frame(String,Wire), Closed(String) }
pub async fn register(endpoint: &str, code: &str, name: &str, incoming: mpsc::Sender<Transport>, cancel: CancellationToken) -> Result<()> {
    let mut url = net::endpoint(endpoint,true)?;
    url.set_path("/agent"); url.query_pairs_mut().append_pair("th",&crypto::token_hash(code)?);
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(1024*1024)).max_frame_size(Some(1024*1024));
    let (socket, _) = tokio::time::timeout(Duration::from_secs(20),tokio_tungstenite::connect_async_with_config(url.as_str(),Some(config),false)).await.map_err(|_|anyhow!("中继连接超时"))?.map_err(|_|anyhow!("无法连接 Workers 中继"))?;
    let (mut writer, mut reader) = socket.split();
    writer.send(Message::Text(json!({"t":"register","tokenHash":crypto::token_hash(code)?,"name":name}).to_string().into())).await?;
    let first = tokio::time::timeout(Duration::from_secs(15),reader.next()).await?;
    ensure!(matches!(first,Some(Ok(Message::Text(ref s))) if serde_json::from_str::<Value>(s).is_ok_and(|v|v["t"]=="registered")), "中继未确认注册");
    let (commands, mut command_rx) = mpsc::channel::<Out>(64);
    let mut tunnels: HashMap<String,mpsc::Sender<Wire>> = HashMap::new();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last = Instant::now();
    let result: Result<()> = async {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = heartbeat.tick() => {
                    ensure!(last.elapsed() < Duration::from_secs(45),"中继心跳超时");
                    writer.send(Message::Ping(vec![].into())).await?;
                }
                command = command_rx.recv() => {
                    let Some(command) = command else { break };
                    let value = match command {
                        Out::Frame(id,Wire::Text(s)) if tunnels.contains_key(&id) => json!({"t":"wmsg","id":id,"s":s}),
                        Out::Frame(id,Wire::Binary(b)) if tunnels.contains_key(&id) => json!({"t":"wmsg","id":id,"b":STANDARD.encode(b)}),
                        Out::Closed(id) => { tunnels.remove(&id); json!({"t":"wclose","id":id,"code":1000}) },
                        _ => continue,
                    };
                    writer.send(Message::Text(value.to_string().into())).await?;
                }
                message = reader.next() => {
                    last = Instant::now();
                    let message = match message {
                        Some(Ok(Message::Text(s))) => s,
                        Some(Ok(Message::Ping(b))) => { writer.send(Message::Pong(b)).await?; continue; },
                        Some(Ok(Message::Pong(_))) => continue,
                        Some(Ok(Message::Close(frame))) => {
                            if frame.is_some_and(|v|u16::from(v.code)==4000) { bail!("replaced"); }
                            bail!("中继连接已关闭");
                        },
                        _=>bail!("中继连接已中断"),
                    };
                    let frame: Value = serde_json::from_str(&message)?;
                    let id = frame["id"].as_str().unwrap_or_default().to_string();
                    match frame["t"].as_str().unwrap_or_default() {
                        "wopen" => {
                            if frame["path"] != "/__alma_e2e__" || !tunnels.is_empty() {
                                writer.send(Message::Text(json!({"t":"wclose","id":id,"code":4003,"reason":"busy"}).to_string().into())).await?; continue;
                            }
                            let (outgoing, mut outgoing_rx) = mpsc::channel(64);
                            let (receive, incoming_rx) = mpsc::channel(64);
                            tunnels.insert(id.clone(),receive);
                            writer.send(Message::Text(json!({"t":"wopened","id":id}).to_string().into())).await?;
                            incoming.send(Transport {outgoing,incoming:incoming_rx}).await.map_err(|_|anyhow!("设备连接已停止"))?;
                            let commands = commands.clone(); let stop = cancel.clone(); let tunnel_id = id.clone();
                            tokio::spawn(async move {
                                loop {
                                    tokio::select! {
                                        _ = stop.cancelled() => break,
                                        wire = outgoing_rx.recv() => {
                                            let Some(wire) = wire else { break };
                                            if commands.send(Out::Frame(tunnel_id.clone(),wire)).await.is_err() { return; }
                                        }
                                    }
                                }
                                let _ = commands.send(Out::Closed(tunnel_id)).await;
                            });
                        }
                        "wmsg" => {
                            if let Some(tx) = tunnels.get(&id) {
                                let wire = if let Some(s) = frame["s"].as_str() { Wire::Text(s.into()) }
                                else { Wire::Binary(STANDARD.decode(frame["b"].as_str().ok_or_else(||anyhow!("中继帧无效"))?)?) };
                                tx.try_send(wire).map_err(|_|anyhow!("中继通道背压超限"))?;
                            }
                        }
                        "wclose"|"werr" => { tunnels.remove(&id); }
                        "error" => bail!("中继拒绝连接"),
                        _=>{}
                    }
                }
            }
        }
        Ok(())
    }.await;
    tunnels.clear();
    let _ = writer.send(Message::Close(None)).await;
    result
}
