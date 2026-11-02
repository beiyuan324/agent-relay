use crate::{codex::Codex, crypto, model::*, net::{self, Transport, Wire}, remote, tunnel};
use anyhow::{anyhow, bail, ensure, Result};
use serde_json::Value;
use std::{collections::HashMap, sync::{Arc, Mutex as StdMutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tokio::{net::TcpListener, sync::{broadcast, mpsc, oneshot, Mutex, RwLock, Semaphore}};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

struct Connection {
    outgoing: mpsc::Sender<Control>,
    pending: StdMutex<HashMap<String,oneshot::Sender<Result<Value,String>>>>,
    ready: AtomicBool,
    cancel: CancellationToken,
    requests: Arc<Semaphore>,
}
struct Peer {
    config: RwLock<PairConfig>,
    code: Zeroizing<String>,
    view: RwLock<DeviceView>,
    cancel: CancellationToken,
    session_lock: Mutex<()>,
    connection: RwLock<Option<Arc<Connection>>>,
}
pub struct Host {
    pub codex: Arc<Codex>,
    pub events: broadcast::Sender<AppEvent>,
    settings: RwLock<Settings>,
    peers: RwLock<HashMap<String,Arc<Peer>>>,
    cancel: CancellationToken,
    listener_error: RwLock<Option<String>>,
}
impl Host {
    pub fn new(settings: Settings) -> Arc<Self> {
        let (events, _) = broadcast::channel(2048);
        Arc::new(Self {codex:Codex::new(settings.codex_path.clone()),events,settings:RwLock::new(settings),peers:RwLock::new(HashMap::new()),cancel:CancellationToken::new(),listener_error:RwLock::new(None)})
    }
    pub async fn start(self: &Arc<Self>) {
        let host = self.clone();
        tokio::spawn(async move {
            let mut events = host.codex.events.subscribe();
            loop {
                tokio::select! {
                    _ = host.cancel.cancelled()=>break,
                    event = events.recv()=>match event {
                        Ok(message)=>{let _=host.events.send(AppEvent::Codex{device:"local".into(),message});},
                        Err(broadcast::error::RecvError::Lagged(_))=>{let _=host.events.send(AppEvent::Diagnostic{message:"本机事件过快，请刷新会话以同步历史".into()});},
                        Err(_)=>break,
                    }
                }
            }
        });
        let host=self.clone();
        tokio::spawn(async move {
            let port=host.settings.read().await.listen_port;
            let listener=match TcpListener::bind(("0.0.0.0",port)).await {
                Ok(listener)=>listener,
                Err(_)=>{let message=format!("局域网端口 {port} 无法监听。请关闭占用程序后重启 Relay，异地连接仍可使用。");*host.listener_error.write().await=Some(message.clone());let _=host.events.send(AppEvent::Diagnostic{message});return;}
            };
            loop {
                let accepted=tokio::select!{_=host.cancel.cancelled()=>break,result=listener.accept()=>result};
                let Ok((stream,_))=accepted else {continue};
                let host=host.clone();
                tokio::spawn(async move {
                    let route=Arc::new(StdMutex::new(String::new()));
                    let capture=route.clone();
                    let config=tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(1024*1024)).max_frame_size(Some(1024*1024));
                    let socket=tokio::time::timeout(Duration::from_secs(10),tokio_tungstenite::accept_hdr_async_with_config(stream,move |request:&Request,response:Response| {
                        *capture.lock().unwrap_or_else(|e|e.into_inner())=request.uri().path().to_string(); Ok(response)
                    },Some(config))).await;
                    let Ok(Ok(socket))=socket else {return};
                    let path=route.lock().unwrap_or_else(|e|e.into_inner()).clone();
                    let peers:Vec<_>=host.peers.read().await.values().cloned().collect();
                    for peer in peers {
                        let cfg=peer.config.read().await.clone();
                        if !peer.code.is_empty() && cfg.mode==ConnectionMode::Lan && cfg.role==Role::Responder && crypto::routing_token(&peer.code).is_ok_and(|token|path==format!("/c/{token}/__alma_e2e__")) {
                            host.session(peer.clone(),net::bridge(socket,peer.cancel.child_token()),false).await;return;
                        }
                    }
                });
            }
        });
    }
    pub async fn add(self:&Arc<Self>, config:PairConfig, code:String) -> Result<()> {
        ensure!(!self.peers.read().await.contains_key(&config.id),"此设备邀请已经添加");
        let peer=Arc::new(Peer{view:RwLock::new(DeviceView::from(&config)),config:RwLock::new(config.clone()),code:Zeroizing::new(code),cancel:self.cancel.child_token(),session_lock:Mutex::new(()),connection:RwLock::new(None)});
        self.peers.write().await.insert(config.id.clone(),peer.clone());
        if peer.code.is_empty() {
            self.update(&peer,"credentialMissing",Some("系统凭据不可用，请取消配对后重新添加设备".into())).await;
        } else if config.role==Role::Initiator {
            let host=self.clone();tokio::spawn(async move {host.client_loop(peer).await;});
        } else if config.mode==ConnectionMode::Relay {
            let host=self.clone();tokio::spawn(async move {host.agent_loop(peer).await;});
        } else {self.update(&peer, "waiting",None).await;}
        Ok(())
    }
    async fn client_loop(self:Arc<Self>,peer:Arc<Peer>) {
        let mut backoff=1;
        loop {
            if peer.cancel.is_cancelled(){break;}
            self.update(&peer,"connecting",None).await;
            let config=peer.config.read().await.clone();
            let result:Result<Transport>=async {
                let mut url=net::endpoint(&config.endpoint,config.mode==ConnectionMode::Relay)?;
                url.set_path(&format!("/c/{}/__alma_e2e__",crypto::routing_token(&peer.code)?));
                net::connect(url,peer.cancel.child_token()).await
            }.await;
            match result {
                Ok(transport)=>{backoff=1;self.clone().session(peer.clone(),transport,true).await;}
                Err(error)=>self.update(&peer,"offline",Some(error.to_string())).await,
            }
            tokio::select!{_=peer.cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(backoff))=>{}}
            backoff=(backoff*2).min(30);
        }
    }
    async fn agent_loop(self:Arc<Self>,peer:Arc<Peer>) {
        let mut backoff=1;
        loop {
            if peer.cancel.is_cancelled(){break;}
            self.update(&peer,"connecting",None).await;
            let config=peer.config.read().await.clone();
            let name=self.settings.read().await.identity.name.clone();
            let (incoming,mut rx)=mpsc::channel::<Transport>(4);
            let host=self.clone();let session_peer=peer.clone();
            let accept=tokio::spawn(async move {while let Some(transport)=rx.recv().await {let host=host.clone();let peer=session_peer.clone();tokio::spawn(async move{host.session(peer,transport,false).await;});}});
            let mut registered=false;
            let result={
                let ready=async {registered=true;self.update(&peer,"waiting",None).await;};
                let register=tunnel::register(&config.endpoint,&peer.code,&name,incoming,ready,peer.cancel.child_token());
                tokio::pin!(register);
                tokio::select! {
                    _=peer.cancel.cancelled()=>{accept.abort();return;},
                    result=&mut register=>result,
                }
            };
            accept.abort();
            if peer.cancel.is_cancelled(){break;}
            if result.as_ref().is_err_and(|e|e.to_string()=="replaced") {self.update(&peer,"replaced",Some("此配对已被另一实例注册，请手动重新连接".into())).await;break;}
            if registered{backoff=1;}
            let message=result.err().map(|error|error.to_string()).unwrap_or_else(||"中继连接已断开，正在等待重连".into());
            self.update(&peer,"offline",Some(message)).await;
            tokio::select!{_=peer.cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(backoff))=>{}}
            backoff=(backoff*2).min(30);
        }
    }
    async fn update(&self,peer:&Peer,state:&str,error:Option<String>) {
        let mut view=peer.view.write().await;
        let changed=view.state!=state || view.error!=error;
        view.state=state.into();view.error=error;
        let diagnostic=if changed{view.error.as_ref().map(|error|format!("配对 {}：{error}",view.id))}else{None};
        let _=self.events.send(AppEvent::Device{device:view.clone()});
        drop(view);
        if let Some(message)=diagnostic{let _=self.events.send(AppEvent::Diagnostic{message});}
    }
    async fn publish(&self,peer:&Peer) {let _=self.events.send(AppEvent::Device{device:peer.view.read().await.clone()});}
    async fn session(self:Arc<Self>,peer:Arc<Peer>,mut transport:Transport,initiator:bool) {
        let Ok(_guard)=peer.session_lock.try_lock() else{return};
        if peer.cancel.is_cancelled(){return;}
        self.update(&peer,"handshaking",None).await;
        let result:Result<()>=async {
            let (mut send_cipher,mut receive_cipher)=tokio::select! {
                _=peer.cancel.cancelled()=>return Ok(()),
                result=tokio::time::timeout(Duration::from_secs(45),remote::handshake(&mut transport,&peer.code,initiator))=>result.map_err(|_|anyhow!("设备加密握手超时"))??,
            };
            let cfg=peer.config.read().await.clone();
            let id=cfg.id.clone();
            let (outgoing,mut outbound)=mpsc::channel::<Control>(128);
            let connection=Arc::new(Connection{outgoing,pending:StdMutex::new(HashMap::new()),ready:AtomicBool::new(false),cancel:peer.cancel.child_token(),requests:Arc::new(Semaphore::new(16))});
            *peer.connection.write().await=Some(connection.clone());
            let settings=self.settings.read().await;
            let hello=Control::Hello{version:CONTROL_VERSION,identity:settings.identity.clone(),approved:cfg.approved,sharing:settings.sharing};
            drop(settings);
            remote::send(&transport.outgoing,&mut send_cipher,&hello).await?;
            let wire_outgoing=transport.outgoing.clone();
            let writer_cancel=connection.cancel.clone();
            let writer_host=self.clone();let writer_connection=connection.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _=writer_cancel.cancelled()=>break,
                        frame=outbound.recv()=>{
                            let Some(frame)=frame else{break};
                            if matches!(&frame,Control::Event{..}|Control::Response{result:Some(_),..}) && (!writer_host.settings.read().await.sharing || !writer_connection.ready.load(Ordering::Acquire)){continue;}
                            if remote::send(&wire_outgoing,&mut send_cipher,&frame).await.is_err(){writer_cancel.cancel();break;}
                        }
                    }
                }
            });
            let mut local_events=self.codex.events.subscribe();
            let mut heartbeat=tokio::time::interval(Duration::from_secs(15));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last=Instant::now();
            let mut hello_received=false;
            let identity_deadline=tokio::time::sleep(Duration::from_secs(15));
            tokio::pin!(identity_deadline);
            let mut assembler=remote::Assembler::default();
            loop {
                tokio::select! {
                    _=connection.cancel.cancelled()=>break,
                    _=&mut identity_deadline,if !hello_received=>bail!("设备身份交换超时，请检查另一台电脑的 Relay 状态"),
                    _=heartbeat.tick()=>{
                        ensure!(last.elapsed()<Duration::from_secs(50),"设备心跳超时");
                        connection.outgoing.try_send(Control::Ping).map_err(|_|anyhow!("设备发送队列已满"))?;
                    }
                    event=local_events.recv()=>{
                        match event {
                            Ok(message) if connection.ready.load(Ordering::Acquire) && self.settings.read().await.sharing=>{
                                connection.outgoing.try_send(Control::Event{message}).map_err(|_|anyhow!("事件流背压超限"))?;
                            },
                            Err(broadcast::error::RecvError::Lagged(_))=>bail!("事件流背压超限，请重连并刷新会话"),
                            _=>{}
                        }
                    }
                    incoming=transport.incoming.recv()=>{
                        let bytes=match incoming {
                            Some(Wire::Binary(bytes))=>bytes,
                            Some(Wire::Close(4404))=>bail!("中继未找到邀请电脑，请确认邀请电脑正在运行 Relay 且使用同一配对链接"),
                            _=>bail!("设备连接已断开"),
                        };
                        let plaintext=receive_cipher.open(&bytes)?;
                        let control=assembler.consume(serde_json::from_slice(&plaintext)?)?;
                        last=Instant::now();
                        let Some(control)=control else{continue};
                        match control {
                            Control::Hello{version,identity,approved,sharing}=>{
                                ensure!(!hello_received && version==CONTROL_VERSION,"控制协议版本或顺序不兼容");
                                ensure!(uuid::Uuid::parse_str(&identity.id).is_ok() && !identity.name.trim().is_empty() && identity.name.len()<=200,"设备身份无效");
                                ensure!(identity.id!=self.settings.read().await.identity.id,"不能连接本机");
                                let mut config=peer.config.write().await;
                                if let Some(expected)=config.peer.as_ref(){ensure!(expected.id==identity.id,"配对设备身份已改变，请重新配对");}
                                config.peer=Some(identity.clone());
                                let mut view=peer.view.write().await;view.peer=Some(identity);view.peer_approved=approved;view.peer_sharing=sharing;view.approved=config.approved;
                                view.state=if config.approved && approved{"connected"}else{"pending"}.into();
                                connection.ready.store(config.approved && approved,Ordering::Release);
                                hello_received=true;drop(config);drop(view);
                                let _=self.events.send(AppEvent::Persist);self.publish(&peer).await;
                            }
                            Control::Trust{approved}=>{
                                ensure!(hello_received,"缺少设备身份");
                                let local=peer.config.read().await.approved;
                                let mut view=peer.view.write().await;view.peer_approved=approved;view.state=if local&&approved{"connected"}else{"pending"}.into();
                                connection.ready.store(local&&approved,Ordering::Release);drop(view);self.publish(&peer).await;
                            }
                            Control::Sharing{enabled}=>{
                                ensure!(hello_received,"缺少设备身份");peer.view.write().await.peer_sharing=enabled;self.publish(&peer).await;
                                if !enabled {
                                    for(_,tx)in connection.pending.lock().unwrap_or_else(|e|e.into_inner()).drain(){let _=tx.send(Err("对方已暂停共享；请重新读取会话确认提交状态".into()));}
                                }
                            }
                            Control::Request{id:request_id,method,params}=>{
                                ensure!(connection.ready.load(Ordering::Acquire),"设备尚未获得双方确认");
                                if !self.settings.read().await.sharing {
                                    connection.outgoing.try_send(Control::Response{id:request_id,result:None,error:Some("此电脑已暂停共享".into())}).map_err(|_|anyhow!("设备请求队列已满"))?;continue;
                                }
                                let permit=connection.requests.clone().try_acquire_owned();
                                let Ok(permit)=permit else{
                                    connection.outgoing.try_send(Control::Response{id:request_id,result:None,error:Some("执行电脑当前请求过多，请稍后重试".into())}).map_err(|_|anyhow!("设备请求队列已满"))?;
                                    continue;
                                };
                                let host=self.clone();let connection=connection.clone();
                                tokio::spawn(async move {
                                    let _permit=permit;
                                    // Finish accepted calls even if the peer disconnects, so local
                                    // approval and turn bookkeeping reaches a consistent state.
                                    let result=host.codex.call(&method,params).await;
                                    if connection.cancel.is_cancelled() || !host.settings.read().await.sharing || !connection.ready.load(Ordering::Acquire){return;}
                                    let frame=match result{Ok(value)=>Control::Response{id:request_id,result:Some(value),error:None},Err(error)=>Control::Response{id:request_id,result:None,error:Some(error.to_string())}};
                                    let _=connection.outgoing.send(frame).await;
                                });
                            }
                            Control::Response{id:request_id,result,error}=>{
                                ensure!(connection.ready.load(Ordering::Acquire),"设备尚未获得双方确认");
                                if let Some(tx)=connection.pending.lock().unwrap_or_else(|e|e.into_inner()).remove(&request_id){let _=tx.send(match error{Some(error)=>Err(error),None=>Ok(result.unwrap_or(Value::Null))});}
                            }
                            Control::Event{message}=>{
                                ensure!(connection.ready.load(Ordering::Acquire) && peer.view.read().await.peer_sharing,"设备未共享");
                                let _=self.events.send(AppEvent::Codex{device:id.clone(),message});
                            }
                            Control::Ping=>{connection.outgoing.try_send(Control::Pong).map_err(|_|anyhow!("设备发送队列已满"))?;}
                            Control::Pong=>{}
                            Control::Fragment{..}=>unreachable!(),
                        }
                    }
                }
            }
            Ok(())
        }.await;
        if let Some(connection)=peer.connection.write().await.take(){
            connection.ready.store(false,Ordering::Release);connection.cancel.cancel();
            for(_,tx)in connection.pending.lock().unwrap_or_else(|e|e.into_inner()).drain(){let _=tx.send(Err("设备已断开；不会自动重发，请刷新会话确认提交状态".into()));}
        }
        let mut view=peer.view.write().await;view.peer_approved=false;view.peer_sharing=false;drop(view);
        let error=result.err().map(|error|error.to_string());
        if !peer.cancel.is_cancelled() && peer.view.read().await.state!="replaced"{self.update(&peer,"offline",error).await;}
    }
    pub async fn call(&self,device:&str,method:&str,params:Value)->Result<Value>{
        if device=="local"{return self.codex.call(method,params).await;}
        let peer=self.peers.read().await.get(device).cloned().ok_or_else(||anyhow!("设备不存在"))?;
        let connection=peer.connection.read().await.clone().ok_or_else(||anyhow!("设备未连接"))?;
        ensure!(connection.ready.load(Ordering::Acquire),"需要双方确认配对");
        ensure!(peer.view.read().await.peer_sharing,"对方已暂停共享");
        let id=uuid::Uuid::new_v4().to_string();let(tx,rx)=oneshot::channel();
        {
            let mut pending=connection.pending.lock().unwrap_or_else(|e|e.into_inner());
            ensure!(pending.len()<128,"等待中的设备请求过多");pending.insert(id.clone(),tx);
        }
        let frame=Control::Request{id:id.clone(),method:method.into(),params};
        if !matches!(tokio::time::timeout(Duration::from_secs(10),connection.outgoing.send(frame)).await,Ok(Ok(()))){
            connection.pending.lock().unwrap_or_else(|e|e.into_inner()).remove(&id);bail!("设备请求未能发送");
        }
        let result=tokio::time::timeout(Duration::from_secs(100),rx).await;
        connection.pending.lock().unwrap_or_else(|e|e.into_inner()).remove(&id);
        match result {Ok(Ok(value))=>value.map_err(|e|anyhow!(e)),_=>bail!("设备请求超时或中断；不会自动重发，请刷新会话确认提交结果")}
    }
    pub async fn approve(&self,id:&str)->Result<()> {
        let peer=self.peers.read().await.get(id).cloned().ok_or_else(||anyhow!("设备不存在"))?;
        ensure!(peer.view.read().await.peer.is_some(),"请等待对方连接并显示设备身份");
        peer.config.write().await.approved=true;
        let mut view=peer.view.write().await;view.approved=true;view.state=if view.peer_approved{"connected"}else{"pending"}.into();
        if let Some(connection)=peer.connection.read().await.as_ref(){connection.ready.store(view.peer_approved,Ordering::Release);if connection.outgoing.try_send(Control::Trust{approved:true}).is_err(){connection.cancel.cancel();}}
        drop(view);self.publish(&peer).await;let _=self.events.send(AppEvent::Persist);Ok(())
    }
    pub async fn remove(&self,id:&str)->Result<()> {
        if let Some(peer)=self.peers.write().await.remove(id){peer.cancel.cancel();if let Some(connection)=peer.connection.read().await.as_ref(){connection.cancel.cancel();}}
        let _=self.events.send(AppEvent::Persist);Ok(())
    }
    pub async fn reconnect(self:&Arc<Self>,id:&str)->Result<()> {
        let peer=self.peers.read().await.get(id).cloned().ok_or_else(||anyhow!("设备不存在"))?;
        ensure!(!peer.code.is_empty(),"系统凭据不可用，请重新配对");
        let config=peer.config.read().await.clone();let code=peer.code.to_string();
        self.remove(id).await?;self.add(config,code).await
    }
    pub async fn snapshot(&self)->Settings {
        let mut settings=self.settings.read().await.clone();
        let peers:Vec<_>=self.peers.read().await.values().cloned().collect();
        settings.devices.clear();for peer in peers{settings.devices.push(peer.config.read().await.clone());}
        settings.devices.sort_by(|a,b|a.id.cmp(&b.id));settings
    }
    pub async fn views(&self)->Vec<DeviceView> {
        let peers:Vec<_>=self.peers.read().await.values().cloned().collect();
        let mut views=Vec::new();for peer in peers{views.push(peer.view.read().await.clone());}views.sort_by(|a,b|a.id.cmp(&b.id));views
    }
    pub async fn update_settings(&self,codex_path:String,relay_url:String,theme:String,name:String)->Result<()> {
        ensure!(matches!(theme.as_str(),"system"|"light"|"dark"),"外观设置无效");
        ensure!(!name.trim().is_empty() && name.len()<=200,"设备名称无效");
        if !relay_url.is_empty(){net::endpoint(&relay_url,true)?;}
        let mut settings=self.settings.write().await;
        let changed=settings.codex_path!=codex_path;
        settings.codex_path=codex_path.clone();settings.relay_url=relay_url;settings.theme=theme;settings.identity.name=name.trim().into();drop(settings);
        if changed{self.codex.set_path(codex_path).await;}
        let _=self.events.send(AppEvent::Persist);Ok(())
    }
    pub async fn share(&self,enabled:bool) {
        self.settings.write().await.sharing=enabled;
        let peers:Vec<_>=self.peers.read().await.values().cloned().collect();
        for peer in peers {
            if let Some(connection)=peer.connection.read().await.as_ref(){
                if connection.outgoing.try_send(Control::Sharing{enabled}).is_err(){connection.cancel.cancel();}
            }
        }
        let _=self.events.send(AppEvent::Persist);
    }
    pub async fn listener_error(&self)->Option<String>{self.listener_error.read().await.clone()}
    pub async fn shutdown(&self){self.cancel.cancel();self.codex.shutdown().await;}
}
