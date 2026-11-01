use anyhow::{anyhow, bail, ensure, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::{io::{AsyncRead, AsyncWrite}, sync::mpsc};
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use tokio_util::sync::CancellationToken;
use url::Url;

#[derive(Debug)]
pub enum Wire { Text(String), Binary(Vec<u8>), Close(u16) }
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
    let (control_tx, mut control_rx) = mpsc::channel::<Message>(8);
    let stop = cancel.child_token();
    let writer_stop = stop.clone();
    let (mut writer, mut reader) = socket.split();
    tokio::spawn(async move {
        let _stop = writer_stop.clone().drop_guard();
        loop {
            let msg = tokio::select! {
                biased;
                _ = writer_stop.cancelled() => break,
                msg = control_rx.recv() => { let Some(msg) = msg else { break }; msg },
                next = send_rx.recv() => match next {
                    Some(Wire::Text(s)) => Message::Text(s.into()),
                    Some(Wire::Binary(b)) => Message::Binary(b.into()),
                    _ => break,
                },
            };
            let sent = tokio::select! {
                _ = writer_stop.cancelled() => break,
                result = tokio::time::timeout(Duration::from_secs(15), writer.send(msg)) => result,
            };
            if !matches!(sent, Ok(Ok(()))) { break; }
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), writer.close()).await;
    });
    tokio::spawn(async move {
        let _stop = stop.clone().drop_guard();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last = Instant::now();
        loop {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = recv_tx.closed() => break,
                _ = heartbeat.tick() => {
                    if last.elapsed() > Duration::from_secs(45) { break; }
                    if control_tx.try_send(Message::Ping(vec![].into())).is_err() { break; }
                }
                next = reader.next() => {
                    last = Instant::now();
                    let wire = match next {
                        Some(Ok(Message::Text(s))) => Some(Wire::Text(s.to_string())),
                        Some(Ok(Message::Binary(b))) => Some(Wire::Binary(b.to_vec())),
                        Some(Ok(Message::Ping(b))) => {
                            if control_tx.try_send(Message::Pong(b)).is_err() { break; } None
                        },
                        Some(Ok(Message::Pong(_))) => None,
                        Some(Ok(Message::Close(frame))) => {
                            let _ = recv_tx.try_send(Wire::Close(frame.map_or(1000, |frame|frame.code.into())));
                            break;
                        },
                        _ => break,
                    };
                    if let Some(wire) = wire { if recv_tx.try_send(wire).is_err() { break; } }
                }
            }
        }
    });
    Transport { outgoing, incoming }
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::protocol::Role;

    #[tokio::test]
    async fn reads_incoming_frames_while_outgoing_socket_is_backpressured() {
        let (local, peer) = tokio::io::duplex(64);
        let socket = WebSocketStream::from_raw_socket(local, Role::Client, None).await;
        let mut peer = WebSocketStream::from_raw_socket(peer, Role::Server, None).await;
        let cancel = CancellationToken::new();
        let mut transport = bridge(socket, cancel.clone());
        transport.outgoing.send(Wire::Binary(vec![1; 8192])).await.unwrap();
        tokio::task::yield_now().await;
        peer.send(Message::Text("still readable".into())).await.unwrap();
        let incoming = tokio::time::timeout(Duration::from_secs(2), transport.incoming.recv()).await.unwrap();
        assert!(matches!(incoming, Some(Wire::Text(value)) if value == "still readable"));
        cancel.cancel();
    }

    #[tokio::test]
    async fn forwards_replacement_close_code() {
        let (local, peer) = tokio::io::duplex(4096);
        let socket = WebSocketStream::from_raw_socket(local, Role::Client, None).await;
        let mut peer = WebSocketStream::from_raw_socket(peer, Role::Server, None).await;
        let mut transport = bridge(socket, CancellationToken::new());
        peer.close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
            code: 4000.into(), reason: "replaced".into(),
        })).await.unwrap();
        let incoming = tokio::time::timeout(Duration::from_secs(2), transport.incoming.recv()).await.unwrap();
        assert!(matches!(incoming, Some(Wire::Close(4000))));
    }

    #[tokio::test]
    async fn dropping_transport_stops_the_socket() {
        let (local, peer) = tokio::io::duplex(4096);
        let socket = WebSocketStream::from_raw_socket(local, Role::Client, None).await;
        let mut peer = WebSocketStream::from_raw_socket(peer, Role::Server, None).await;
        drop(bridge(socket, CancellationToken::new()));
        let message = tokio::time::timeout(Duration::from_secs(2), peer.next()).await.unwrap();
        assert!(matches!(message, Some(Ok(Message::Close(_))) | None));
    }
}
