//! Wire compatible with relay-kit 25a142d, relay-e2e/v1.
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, ensure, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hkdf::Hkdf;
use p256::{ecdh::EphemeralSecret, elliptic_curve::{rand_core::{OsRng, RngCore}, sec1::ToEncodedPoint}, PublicKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub const PROTOCOL: &str = "relay-e2e/v1";

pub fn new_code() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn routing_token(code: &str) -> Result<String> {
    let hkdf = Hkdf::<Sha256>::new(Some(b"relay-e2e/v1/routing"), code.as_bytes());
    let mut out = [0u8; 16];
    hkdf.expand(b"", &mut out).map_err(|_| anyhow!("密钥派生失败"))?;
    Ok(URL_SAFE_NO_PAD.encode(out))
}

pub fn token_hash(code: &str) -> Result<String> {
    Ok(Sha256::digest(routing_token(code)?.as_bytes()).iter().map(|v| format!("{v:02x}")).collect())
}

pub struct Handshake {
    secret: EphemeralSecret,
    public: Vec<u8>,
    nonce: [u8; 16],
}
pub struct SessionKeys {
    pub c2s: Zeroizing<[u8; 32]>,
    pub s2c: Zeroizing<[u8; 32]>,
    confirm_r: Zeroizing<[u8; 32]>,
    confirm_i: Zeroizing<[u8; 32]>,
}
impl Handshake {
    pub fn new() -> Self {
        let secret = EphemeralSecret::random(&mut OsRng);
        let public = PublicKey::from(&secret).to_encoded_point(false).as_bytes().to_vec();
        let mut nonce = [0u8; 16];
        OsRng.fill_bytes(&mut nonce);
        Self { secret, public, nonce }
    }
    pub fn hello(&self) -> Value {
        json!({"t":"hi","epk":URL_SAFE_NO_PAD.encode(&self.public),"n":URL_SAFE_NO_PAD.encode(self.nonce)})
    }
    pub fn derive(&self, peer: &Value, code: &str, initiator: bool) -> Result<SessionKeys> {
        ensure!(peer["t"] == "hi", "握手消息无效");
        let public = URL_SAFE_NO_PAD.decode(peer["epk"].as_str().ok_or_else(|| anyhow!("缺少公钥"))?)?;
        let nonce = URL_SAFE_NO_PAD.decode(peer["n"].as_str().ok_or_else(|| anyhow!("缺少随机数"))?)?;
        ensure!(public.len() == 65 && public[0] == 4 && nonce.len() == 16, "握手参数长度无效");
        let remote = PublicKey::from_sec1_bytes(&public)?;
        let shared = self.secret.diffie_hellman(&remote);
        let mut transcript = Sha256::new();
        transcript.update(PROTOCOL.as_bytes());
        if initiator {
            transcript.update(&self.public); transcript.update(&public);
            transcript.update(self.nonce); transcript.update(&nonce);
        } else {
            transcript.update(&public); transcript.update(&self.public);
            transcript.update(&nonce); transcript.update(self.nonce);
        }
        let transcript = transcript.finalize();
        let hkdf = Hkdf::<Sha256>::new(Some(code.as_bytes()), shared.raw_secret_bytes().as_slice());
        let derive = |label: &[u8]| -> Result<Zeroizing<[u8; 32]>> {
            let mut info = label.to_vec(); info.extend_from_slice(&transcript);
            let mut out = Zeroizing::new([0u8; 32]);
            hkdf.expand(&info, out.as_mut()).map_err(|_| anyhow!("密钥派生失败"))?;
            Ok(out)
        };
        Ok(SessionKeys { c2s: derive(b"c2s|")?, s2c: derive(b"s2c|")?, confirm_r: derive(b"confirm-r|")?, confirm_i: derive(b"confirm-i|")? })
    }
}
impl SessionKeys {
    pub fn responder_hello(&self, handshake: &Handshake) -> Value {
        let mut hello = handshake.hello();
        hello["cr"] = json!(URL_SAFE_NO_PAD.encode(self.confirm_r.as_slice()));
        hello
    }
    pub fn confirm(&self) -> Value {
        json!({"t":"ok","ci":URL_SAFE_NO_PAD.encode(self.confirm_i.as_slice())})
    }
    pub fn verify(&self, peer: &Value, initiator: bool) -> Result<()> {
        let (field, expected) = if initiator { ("cr", &self.confirm_r) } else { ("ci", &self.confirm_i) };
        let actual = URL_SAFE_NO_PAD.decode(peer[field].as_str().ok_or_else(|| anyhow!("缺少握手确认"))?)?;
        ensure!(bool::from(actual.as_slice().ct_eq(expected.as_slice())), "配对认证失败");
        Ok(())
    }
    pub fn streams(&self, initiator: bool) -> (Cipher, Cipher) {
        let (send, recv) = if initiator { (&self.c2s, &self.s2c) } else { (&self.s2c, &self.c2s) };
        (Cipher::new(send.as_slice()), Cipher::new(recv.as_slice()))
    }
}

pub struct Cipher {
    key: Aes256Gcm,
    next: u64,
    last: Option<u64>,
}
impl Cipher {
    fn new(key: &[u8]) -> Self { Self { key: Aes256Gcm::new_from_slice(key).expect("AES-256 key length"), next: 0, last: None } }
    pub fn seal(&mut self, bytes: &[u8]) -> Result<Vec<u8>> {
        let counter = self.next;
        self.next = self.next.checked_add(1).ok_or_else(|| anyhow!("加密计数器已耗尽"))?;
        let mut iv = [0u8; 12]; iv[4..].copy_from_slice(&counter.to_be_bytes());
        let encrypted = self.key.encrypt(Nonce::from_slice(&iv), bytes).map_err(|_| anyhow!("加密失败"))?;
        let mut frame = iv.to_vec(); frame.extend(encrypted); Ok(frame)
    }
    pub fn open(&mut self, frame: &[u8]) -> Result<Vec<u8>> {
        ensure!(frame.len() >= 28 && frame[..4] == [0u8; 4], "加密帧格式无效");
        let counter = u64::from_be_bytes(frame[4..12].try_into()?);
        if self.last.is_some_and(|v| counter <= v) { bail!("检测到重放帧，连接已作废"); }
        let plain = self.key.decrypt(Nonce::from_slice(&frame[..12]), &frame[12..]).map_err(|_| anyhow!("密文认证失败"))?;
        self.last = Some(counter); Ok(plain)
    }
}
