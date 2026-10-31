use anyhow::{anyhow, bail, ensure, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::{io::{AsyncRead, AsyncWrite}, sync::mpsc};
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use tokio_util::sync::CancellationToken;
use url::Url;

#[derive(Debug)]
pub enum Wire { Text(String), Binary(Vec<u8>) }
pub struct Transport {
    pub outgoing: mpsc::Sender<Wire>,
    pub incoming: mpsc::Receiver<Wire>,
}
pub fn endpoint(input: &str, relay: bool) -> Result<Url> {
    let mut url = Url::parse(input.trim()).map_err(|_|anyhow!("连接地址格式无效"))?;
    ensure!(url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none(), "连接地址不能包含账号、查询参数或片段");
    ensure!(url.path().is_empty() || url.path() == "/", "请输入中继或电脑的根地址");
    let scheme = match url.scheme() { "http"|"ws" => "ws", "https"|"wss" => "wss", _ => bail!("连接地址必须使用 http(s) 或 ws(s)") };
    url.set_scheme(scheme).map_err(|_|anyhow!("连接协议无效"))?;
    let host = url.host_str().ok_or_else(||anyhow!("缺少主机地址"))?;
    if relay { ensure!(scheme == "wss" || matches!(host,"localhost"|"127.0.0.1"|"::1"), "异地中继必须使用 HTTPS/WSS"); }
    Ok(url)
}
pub fn bridge<S>(socket: WebSocketStream<S>, cancel: CancellationToken) -> Transport
where S: AsyncRead + AsyncWrite + Send + Unpin + 'static {
    let (outgoing, mut send_rx) = mpsc::channel::<Wire>(64);
    let (recv_tx, incoming) = mpsc::channel(64);
    tokio::spawn(async move {
        let (mut writer, mut reader) = socket.split();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last = Instant::now();
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = heartbeat.tick() => {
                    if last.elapsed() > Duration::from_secs(45) { break; }
                    if writer.send(Message::Ping(vec![].into())).await.is_err() { break; }
                }
                next = send_rx.recv() => {
                    let Some(next) = next else { break };
                    let msg = match next { Wire::Text(s)=>Message::Text(s.into()),Wire::Binary(b)=>Message::Binary(b.into()) };
                    if writer.send(msg).await.is_err() { break; }
                }
                next = reader.next() => {
                    last = Instant::now();
                    let wire = match next {
                        Some(Ok(Message::Text(s)))=>Some(Wire::Text(s.to_string())),
                        Some(Ok(Message::Binary(b)))=>Some(Wire::Binary(b.to_vec())),
                        Some(Ok(Message::Ping(b)))=> { if writer.send(Message::Pong(b)).await.is_err() { break; } None },
                        Some(Ok(Message::Pong(_)))=>None,
                        _=>break,
                    };
                    if let Some(wire) = wire { if recv_tx.try_send(wire).is_err() { break; } }
                }
            }
        }
        let _ = writer.send(Message::Close(None)).await;
    });
    Transport { outgoing,incoming }
}
pub async fn connect(url: Url, cancel: CancellationToken) -> Result<Transport> {
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(1024 * 1024)).max_frame_size(Some(1024 * 1024));
    let (socket, _) = tokio::time::timeout(Duration::from_secs(20),tokio_tungstenite::connect_async_with_config(url.as_str(),Some(config),false)).await.map_err(|_|anyhow!("连接超时"))?.map_err(|_|anyhow!("无法连接设备，请检查地址、网络及防火墙"))?;
    Ok(bridge(socket,cancel))
}
pub async fn send_json(out: &mpsc::Sender<Wire>, value: &Value) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(15),out.send(Wire::Text(serde_json::to_string(value)?))).await.map_err(|_|anyhow!("连接发送超时"))?.map_err(|_|anyhow!("连接已断开"))
}
