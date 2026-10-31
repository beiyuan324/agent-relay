//! Pairing URI control extension. PSKs never appear in relay URLs or ordinary settings.
use crate::{crypto, model::*, net};
use anyhow::{anyhow, ensure, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use url::Url;

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Address {pub name:String,pub url:String}
pub fn addresses(port:u16)->Vec<Address>{
    let mut addresses=Vec::new();
    if let Ok(interfaces)=if_addrs::get_if_addrs(){
        for interface in interfaces{
            if let std::net::IpAddr::V4(ip)=interface.ip(){
                if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified(){
                    addresses.push(Address{name:format!("{} · {}",interface.name,ip),url:format!("ws://{ip}:{port}")});
                }
            }
        }
    }
    addresses.sort_by(|a,b|a.url.cmp(&b.url));addresses.dedup_by(|a,b|a.url==b.url);addresses
}
pub fn invitation(config:&PairConfig,code:&str)->Result<String>{
    let mut uri=Url::parse("relay://connect")?;
    uri.query_pairs_mut().append_pair("v","1").append_pair("id",&config.id).append_pair("u",&config.endpoint).append_pair("k",code).append_pair("mode",if config.mode==ConnectionMode::Lan{"lan"}else{"relay"});
    Ok(uri.to_string())
}
pub fn parse_invitation(input:&str)->Result<(PairConfig,String)>{
    ensure!(input.len()<4096,"配对链接过长");
    let uri=Url::parse(input.trim()).map_err(|_|anyhow!("配对链接格式无效"))?;
    ensure!(uri.scheme()=="relay" && uri.host_str()==Some("connect"),"请输入 Relay 配对链接");
    let mut fields=std::collections::HashMap::new();
    for (key,value) in uri.query_pairs(){ensure!(fields.insert(key.to_string(),value.to_string()).is_none(),"配对链接含重复字段");}
    let field=|name:&str|fields.get(name).cloned().ok_or_else(||anyhow!("配对链接缺少必要字段"));
    ensure!(field("v")?=="1","配对链接版本不支持");
    let id=field("id")?;ensure!(uuid::Uuid::parse_str(&id).is_ok(),"设备配对标识无效");
    let code=field("k")?;
    ensure!(URL_SAFE_NO_PAD.decode(&code).is_ok_and(|b|b.len()==32) && code.len()==43,"配对密钥无效");
    let mode=match field("mode")?.as_str(){"lan"=>ConnectionMode::Lan,"relay"=>ConnectionMode::Relay,_=>return Err(anyhow!("连接方式无效"))};
    let endpoint=net::endpoint(&field("u")?,mode==ConnectionMode::Relay)?.to_string();
    Ok((PairConfig{id,endpoint,mode,role:Role::Initiator,peer:None,approved:false},code))
}
pub fn create_invitation(endpoint:&str,mode:ConnectionMode)->Result<(PairConfig,String,String)>{
    let endpoint=net::endpoint(endpoint,mode==ConnectionMode::Relay)?.to_string();
    let config=PairConfig{id:uuid::Uuid::new_v4().to_string(),endpoint,mode,role:Role::Responder,peer:None,approved:false};
    let code=crypto::new_code();let uri=invitation(&config,&code)?;Ok((config,code,uri))
}
