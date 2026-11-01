use crate::{crypto::Handshake, model::{Control, MAX_MESSAGE}, net::{self, Transport, Wire}};
use anyhow::{anyhow, bail, ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::{collections::HashMap, time::{Duration, Instant}};

pub async fn handshake(transport: &mut Transport, code: &str, initiator: bool) -> Result<(crate::crypto::Cipher,crate::crypto::Cipher)> {
    let handshake = Handshake::new();
    if initiator { net::send_json(&transport.outgoing,&handshake.hello()).await?; }
    let peer = next_handshake(transport).await?;
    let keys = handshake.derive(&peer,code,initiator)?;
    if initiator {
        keys.verify(&peer,true)?;
        net::send_json(&transport.outgoing,&keys.confirm()).await?;
    } else {
        net::send_json(&transport.outgoing,&keys.responder_hello(&handshake)).await?;
        let confirm = next_handshake(transport).await?;
        ensure!(confirm["t"] == "ok","握手确认顺序无效"); keys.verify(&confirm,false)?;
    }
    Ok(keys.streams(initiator))
}
async fn next_handshake(transport: &mut Transport) -> Result<Value> {
    match tokio::time::timeout(Duration::from_secs(20),transport.incoming.recv()).await? {
        Some(Wire::Text(s)) if s.len() < 4096 => Ok(serde_json::from_str(&s)?),
        _=>bail!("握手中断或格式不兼容"),
    }
}
pub async fn send(outgoing: &tokio::sync::mpsc::Sender<Wire>, cipher: &mut crate::crypto::Cipher, control: &Control) -> Result<()> {
    let bytes = serde_json::to_vec(control)?;
    ensure!(bytes.len() <= MAX_MESSAGE,"消息超过 32 MiB 限制");
    if bytes.len() <= 128 * 1024 { return send_bytes(outgoing,cipher,&bytes).await; }
    let id = uuid::Uuid::new_v4().to_string();
    let total = bytes.len().div_ceil(128 * 1024);
    for (index,chunk) in bytes.chunks(128 * 1024).enumerate() {
        let frame = Control::Fragment { id:id.clone(),index,total,b:STANDARD.encode(chunk) };
        send_bytes(outgoing,cipher,&serde_json::to_vec(&frame)?).await?;
    }
    Ok(())
}
async fn send_bytes(outgoing: &tokio::sync::mpsc::Sender<Wire>, cipher: &mut crate::crypto::Cipher, bytes: &[u8]) -> Result<()> {
    let wire = Wire::Binary(cipher.seal(bytes)?);
    tokio::time::timeout(Duration::from_secs(15),outgoing.send(wire)).await.map_err(|_|anyhow!("设备发送超时"))?.map_err(|_|anyhow!("设备连接已断开"))
}
struct Parts { next:usize,total:usize,bytes:Vec<u8>,started:Instant }
#[derive(Default)]
pub struct Assembler { parts: HashMap<String,Parts> }
impl Assembler {
    pub fn consume(&mut self, control: Control) -> Result<Option<Control>> {
        let Control::Fragment {id,index,total,b} = control else { return Ok(Some(control)) };
        ensure!(!self.parts.values().any(|p|p.started.elapsed()>Duration::from_secs(60)),"分片消息已超时");
        ensure!(total > 0 && total <= 256 && index < total,"分片数量无效");
        if !self.parts.contains_key(&id) {
            ensure!(index == 0 && self.parts.is_empty(),"分片顺序无效");
            self.parts.insert(id.clone(),Parts {next:0,total,bytes:vec![],started:Instant::now()});
        }
        let part = self.parts.get_mut(&id).unwrap();
        ensure!(part.next == index && part.total == total,"分片顺序无效");
        ensure!(b.len() <= 180_000,"分片过大");
        let bytes = STANDARD.decode(b)?;
        ensure!(bytes.len() <= 128*1024 && part.bytes.len()+bytes.len()<=MAX_MESSAGE,"消息过大");
        part.bytes.extend(bytes); part.next+=1;
        if part.next < total { return Ok(None); }
        let part = self.parts.remove(&id).unwrap();
        let control: Control = serde_json::from_slice(&part.bytes)?;
        ensure!(!matches!(control,Control::Fragment{..}),"不允许嵌套分片");
        Ok(Some(control))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn encrypted_fragmented_messages_round_trip_and_reject_replay() {
        let (a_out, b_in) = tokio::sync::mpsc::channel(512);
        let (b_out, a_in) = tokio::sync::mpsc::channel(512);
        let mut a = Transport { outgoing: a_out, incoming: a_in };
        let mut b = Transport { outgoing: b_out, incoming: b_in };
        let code = crate::crypto::new_code();
        let (a_keys, b_keys) = tokio::join!(handshake(&mut a, &code, true), handshake(&mut b, &code, false));
        let (mut sender, _) = a_keys.unwrap();
        let (_, mut receiver) = b_keys.unwrap();
        let control = Control::Event { message: json!({"text":"你好".repeat(100_000)}) };
        send(&a.outgoing, &mut sender, &control).await.unwrap();
        let mut assembler = Assembler::default();
        let mut frames = 0;
        let restored = loop {
            let Wire::Binary(frame) = b.incoming.recv().await.unwrap() else { panic!("expected ciphertext"); };
            let plaintext = receiver.open(&frame).unwrap();
            assert!(receiver.open(&frame).is_err(), "replayed ciphertext must be rejected");
            frames += 1;
            if let Some(control) = assembler.consume(serde_json::from_slice(&plaintext).unwrap()).unwrap() { break control; }
        };
        assert!(frames > 1);
        assert_eq!(serde_json::to_value(restored).unwrap(), serde_json::to_value(control).unwrap());
    }

    #[test]
    fn rejects_out_of_order_or_nested_fragments() {
        let mut assembler = Assembler::default();
        assert!(assembler.consume(Control::Fragment { id:"x".into(), index:1, total:2, b:STANDARD.encode(b"x") }).is_err());
        let nested = serde_json::to_vec(&Control::Fragment { id:"nested".into(), index:0, total:1, b:String::new() }).unwrap();
        assert!(Assembler::default().consume(Control::Fragment { id:"outer".into(), index:0, total:1, b:STANDARD.encode(nested) }).is_err());
    }

    #[tokio::test]
    async fn handshake_rejects_a_different_pairing_secret() {
        let (a_out, b_in) = tokio::sync::mpsc::channel(8);
        let (b_out, a_in) = tokio::sync::mpsc::channel(8);
        let mut a = Transport { outgoing:a_out, incoming:a_in };
        let mut b = Transport { outgoing:b_out, incoming:b_in };
        let (initiator, _) = tokio::join!(
            handshake(&mut a, "secret-a", true),
            tokio::time::timeout(Duration::from_millis(100), handshake(&mut b, "secret-b", false)),
        );
        assert!(initiator.is_err());
    }
}
