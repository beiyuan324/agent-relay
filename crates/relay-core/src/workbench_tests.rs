use super::*;
use crate::{crypto, model::*, net::{self, Wire}, remote};
use tokio::{net::TcpListener, sync::mpsc, time::{sleep, timeout, Duration}};
use tokio_util::sync::CancellationToken;

fn item(id: &str) -> QueuedMessage {
    QueuedMessage { id: id.into(), draft: json!({"text":"你好 @文件","mentions":[{"kind":"file","path":"/项目/a.ts","start":3,"end":6}]}),
        input: vec![json!({"type":"text","text":"你好"})], model:"model".into(), effort:"high".into(),
        collaboration_mode:None, service_tier:None, status:"queued".into(), error:None }
}
async fn until(mut condition: impl AsyncFnMut() -> bool) {
    timeout(Duration::from_secs(5), async { while !condition().await {sleep(Duration::from_millis(5)).await;} }).await.unwrap();
}
#[tokio::test]
async fn restores_drafts_and_pauses_unknown_submissions() {
    let dir=tempfile::tempdir().unwrap();
    let path=dir.path().join("workbench.json");
    let host=Host::new(Settings::default());
    let bench=Workbench::new(host.clone(),Some(path.clone())).unwrap();
    bench.save_draft(key("peer","thread"),json!({"text":"中文草稿","mentions":[]}),Some(json!({"id":"thread","relayDraft":true,"cwd":"/draft-project"}))).await.unwrap();
    bench.enqueue("peer".into(),json!({"id":"thread"}),item("first"),None).await.unwrap();
    {
        let mut state=bench.state.lock().await;
        state.snapshot.queues.get_mut(&key("peer","thread")).unwrap().items[0].status="sending".into();
        bench.publish(&mut state).unwrap();
    }
    let restored=Workbench::new(host,Some(path)).unwrap().snapshot().await;
    assert_eq!(restored.drafts[&key("peer","thread")]["text"],"中文草稿");
    assert_eq!(restored.draft_threads[&key("peer","thread")]["cwd"],"/draft-project");
    let queue=&restored.queues[&key("peer","thread")];
    assert!(queue.paused.is_some());
    assert_eq!(queue.items[0].status,"failed");
    assert!(queue.items[0].error.as_ref().unwrap().contains("未知"));
    assert_eq!(queue.items[0].draft["mentions"][0]["path"],"/项目/a.ts");
}
#[tokio::test]
async fn failed_persistence_does_not_accept_or_send_the_message() {
    let dir=tempfile::tempdir().unwrap();
    let path=dir.path().join("workbench.json");
    let bench=Workbench::new(Host::new(Settings::default()),Some(path.clone())).unwrap();
    std::fs::create_dir(path).unwrap();
    assert!(bench.enqueue("peer".into(),json!({"id":"thread"}),item("first"),None).await.is_err());
    assert!(bench.snapshot().await.queues.is_empty());
}
#[tokio::test]
async fn cannot_remove_a_message_being_submitted() {
    let bench=Workbench::new(Host::new(Settings::default()),None).unwrap();
    bench.enqueue("peer".into(),json!({"id":"thread"}),item("first"),None).await.unwrap();
    bench.state.lock().await.snapshot.queues.get_mut(&key("peer","thread")).unwrap().items[0].status="sending".into();
    assert!(bench.remove(&key("peer","thread"),"first",None).await.is_err());
    assert_eq!(bench.snapshot().await.queues[&key("peer","thread")].items.len(),1);
}
#[derive(Clone,Copy)]
enum Scenario { Fast, Approval, StaleApproval, Lost }
struct Fixture { host:Arc<Host>, bench:Arc<Workbench>, turns:Arc<Mutex<Vec<Value>>>, controls:mpsc::Sender<Control>, cancel:CancellationToken }
async fn fixture(scenario:Scenario)->Fixture {
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint=format!("ws://{}",listener.local_addr().unwrap());
    let code=crypto::new_code();
    let server_code=code.clone();
    let turns=Arc::new(Mutex::new(Vec::new()));
    let recorded=turns.clone();
    let cancel=CancellationToken::new();
    let server_cancel=cancel.clone();
    let (controls,mut commands)=mpsc::channel::<Control>(8);
    tokio::spawn(async move {
        let (stream,_)=listener.accept().await.unwrap();
        let socket=tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut transport=net::bridge(socket,server_cancel.clone());
        let (mut send,mut receive)=remote::handshake(&mut transport,&server_code,false).await.unwrap();
        remote::send(&transport.outgoing,&mut send,&Control::Hello {version:CONTROL_VERSION,identity:Identity{id:uuid::Uuid::new_v4().to_string(),name:"验收电脑".into(),platform:"test".into()},approved:true,sharing:true}).await.unwrap();
        let mut first_pending=true;
        loop {
            let incoming=tokio::select! {
                _=server_cancel.cancelled()=>break,
                command=commands.recv()=>{
                    if let Some(command)=command {remote::send(&transport.outgoing,&mut send,&command).await.unwrap();}
                    continue;
                },
                incoming=transport.incoming.recv()=>incoming,
            };
            let Some(Wire::Binary(bytes))=incoming else {break};
            let control:Control=serde_json::from_slice(&receive.open(&bytes).unwrap()).unwrap();
            let (id,method,params)=match control {
                Control::Request{id,method,params}=>(id,method,params),
                Control::Ping=>{remote::send(&transport.outgoing,&mut send,&Control::Pong).await.unwrap();continue;},
                _=>continue,
            };
            let response=match method.as_str() {
                "thread/resume"=>json!({"thread":{"id":params["threadId"],"status":{"type":"idle"}}}),
                "thread/start"=>json!({"thread":{"id":"created","status":{"type":"idle"}}}),
                "relay/pending"=>{
                    let request=json!({"id":"approval","method":"item/commandExecution/requestApproval","params":{"threadId":"thread"}});
                    if first_pending && matches!(scenario,Scenario::Approval|Scenario::StaleApproval) {
                        first_pending=false;
                        let message=if matches!(scenario,Scenario::Approval){request.clone()}else{json!({"method":"relay/approvalResolved","params":{"id":"approval"}})};
                        remote::send(&transport.outgoing,&mut send,&Control::Event{message}).await.unwrap();
                        json!({"requests":[request]})
                    } else {json!({"requests":[]})}
                },
                "turn/start"=>{
                    recorded.lock().await.push(params.clone());
                    if matches!(scenario,Scenario::Lost){server_cancel.cancel();break;}
                    let turn_id=format!("turn-{}",recorded.lock().await.len());
                    for (method,status) in [("turn/started","inProgress"),("turn/completed","completed")] {
                        remote::send(&transport.outgoing,&mut send,&Control::Event{message:json!({"method":method,"params":{"threadId":params["threadId"],"turn":{"id":turn_id,"status":status,"items":[]}}})}).await.unwrap();
                    }
                    json!({"turn":{"id":turn_id,"status":"inProgress","items":[]}})
                },
                _=>json!({}),
            };
            remote::send(&transport.outgoing,&mut send,&Control::Response{id,result:Some(response),error:None}).await.unwrap();
        }
    });
    let host=Host::new(Settings::default());
    let bench=Workbench::new(host.clone(),None).unwrap();
    bench.start();
    host.add(PairConfig{id:"peer".into(),endpoint,mode:ConnectionMode::Lan,role:Role::Initiator,peer:None,approved:true},code).await.unwrap();
    until(async || host.views().await[0].state=="connected").await;
    Fixture{host,bench,turns,controls,cancel}
}
#[tokio::test]
async fn native_queue_drains_without_a_webview_when_completion_precedes_response() {
    let f=fixture(Scenario::Fast).await;
    for id in ["first","second"] {f.bench.enqueue("peer".into(),json!({"id":"thread"}),item(id),None).await.unwrap();}
    until(async || f.bench.snapshot().await.queues.is_empty()).await;
    assert_eq!(f.turns.lock().await.len(),2);
    assert_eq!(f.turns.lock().await[0]["effort"],"high");
    f.cancel.cancel();f.host.shutdown().await;
}
#[tokio::test]
async fn waits_for_approval_then_continues_once() {
    let f=fixture(Scenario::Approval).await;
    f.bench.enqueue("peer".into(),json!({"id":"thread"}),item("first"),None).await.unwrap();
    until(async || f.bench.state.lock().await.sessions.get(&key("peer","thread")).is_some_and(|session|session.blocked)).await;
    assert!(f.turns.lock().await.is_empty());
    f.controls.send(Control::Event{message:json!({"method":"relay/approvalResolved","params":{"id":"approval"}})}).await.unwrap();
    until(async || f.bench.snapshot().await.queues.is_empty()).await;
    assert_eq!(f.turns.lock().await.len(),1);
    f.cancel.cancel();f.host.shutdown().await;
}
#[tokio::test]
async fn ignores_an_approval_snapshot_resolved_before_its_response() {
    let f=fixture(Scenario::StaleApproval).await;
    f.bench.enqueue("peer".into(),json!({"id":"thread"}),item("first"),None).await.unwrap();
    until(async || f.bench.snapshot().await.queues.is_empty()).await;
    assert_eq!(f.turns.lock().await.len(),1);
    f.cancel.cancel();f.host.shutdown().await;
}
#[tokio::test]
async fn migrates_a_new_thread_and_its_entire_queue() {
    let f=fixture(Scenario::Fast).await;
    for id in ["first","second"] {f.bench.enqueue("peer".into(),json!({"id":"draft","relayDraft":true,"relayDraftId":"draft","cwd":"/project"}),item(id),None).await.unwrap();}
    until(async || f.bench.snapshot().await.queues.is_empty()).await;
    assert_eq!(f.turns.lock().await.len(),2);
    assert!(f.turns.lock().await.iter().all(|turn|turn["threadId"]=="created"));
    assert_eq!(f.bench.snapshot().await.created[&key("peer","draft")]["thread"]["id"],"created");
    f.cancel.cancel();f.host.shutdown().await;
}
#[tokio::test]
async fn unknown_submission_is_failed_and_never_replayed() {
    let f=fixture(Scenario::Lost).await;
    f.bench.enqueue("peer".into(),json!({"id":"thread"}),item("first"),None).await.unwrap();
    until(async || f.bench.snapshot().await.queues[&key("peer","thread")].items[0].status=="failed").await;
    assert!(f.bench.snapshot().await.queues[&key("peer","thread")].paused.is_some());
    assert_eq!(f.turns.lock().await.len(),1);
    f.host.shutdown().await;
}
