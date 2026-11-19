//! 用于安卓界面与后台验收的独立假电脑，不读取或启动真实 Codex。
use anyhow::Result;
use relay_core::{model::*, net::{self,Wire}, relay, remote};
use serde_json::{json,Value};
use std::{path::PathBuf,sync::Arc};
use tokio::{net::TcpListener,sync::{mpsc,Mutex},time::{sleep,Duration}};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Data { turns:Vec<Value>, pending:Vec<Value>, active:Option<String>, archived:bool }
fn thread(data:&Data)->Value {json!({"id":"fixture-thread","name":"移动端体验验收","cwd":"/fixture","projectId":"fixture-project","status":{"type":if data.active.is_some(){"active"}else{"idle"}},"turns":data.turns})}
async fn finish(data:Arc<Mutex<Data>>,out:mpsc::Sender<Control>,turn:String) {
    let completed={
        let mut data=data.lock().await;
        if data.active.as_ref()!=Some(&turn){return;}
        let entry=data.turns.iter_mut().find(|entry|entry["id"]==turn).unwrap();
        entry["status"]=json!("completed");
        entry["items"].as_array_mut().unwrap().push(json!({"id":format!("{turn}-reply"),"type":"agentMessage","phase":"final_answer","text":"验收完成。消息、队列与审批均在电脑端处理。\n\n- 共享同一套通信与界面组件\n- 后台运行后仍可继续接收结果\n- 中文、代码和表格可以正常阅读\n\n```typescript\nconst relay = '随时继续工作';\n```"}));
        let completed=entry.clone();data.active=None;completed
    };
    let _=out.send(Control::Event{message:json!({"method":"turn/completed","params":{"threadId":"fixture-thread","turn":completed}})}).await;
}
#[tokio::main]
async fn main()->Result<()> {
    let path=std::env::args().nth(1).map(PathBuf::from).expect("提供邀请输出文件路径");
    let listener=TcpListener::bind("0.0.0.0:47421").await?;
    let (config,code,uri)=relay::create_invitation("ws://127.0.0.1:47421",ConnectionMode::Lan)?;
    std::fs::write(path,uri)?;
    let identity=Identity{id:uuid::Uuid::new_v4().to_string(),name:"移动端验收电脑".into(),platform:"test".into()};
    let data=Arc::new(Mutex::new(Data {turns:vec![json!({"id":"history","status":"completed","items":[{"id":"u","type":"userMessage","content":[{"type":"text","text":"检查移动端工作台"}]},{"id":"a","type":"agentMessage","phase":"final_answer","text":"## 欢迎继续工作\n\n这是独立的验收会话，不会操作真实项目。你可以发送消息、测试队列，并发送包含「审批」的文字检查审批通知。\n\n| 功能 | 状态 |\n| --- | --- |\n| 中文输入 | 可用 |\n| 消息队列 | 可用 |\n| 后台连接 | 可用 |"}]})],..Data::default()}));
    println!("验收电脑监听 47421，邀请已写入指定文件。");
    loop {
        let (stream,_)=listener.accept().await?;
        let code=code.clone();let identity=identity.clone();let data=data.clone();let config=config.clone();
        tokio::spawn(async move {
            let result:Result<()>=async {
                let socket=tokio_tungstenite::accept_async(stream).await?;
                let cancel=CancellationToken::new();
                let mut transport=net::bridge(socket,cancel);
                let (mut send,mut receive)=remote::handshake(&mut transport,&code,false).await?;
                let (out,mut updates)=mpsc::channel(128);
                remote::send(&transport.outgoing,&mut send,&Control::Hello{version:CONTROL_VERSION,identity,approved:true,sharing:true}).await?;
                loop {
                    let incoming=tokio::select!{
                        update=updates.recv()=>{if let Some(update)=update{remote::send(&transport.outgoing,&mut send,&update).await?;}continue;},
                        incoming=transport.incoming.recv()=>incoming,
                    };
                    let Some(Wire::Binary(bytes))=incoming else{break};
                    let control:Control=serde_json::from_slice(&receive.open(&bytes)?)?;
                    let (id,method,params)=match control {
                        Control::Request{id,method,params}=>(id,method,params),
                        Control::Ping=>{remote::send(&transport.outgoing,&mut send,&Control::Pong).await?;continue;},
                        _=>continue,
                    };
                    println!("RPC {method}");
                    let response=match method.as_str() {
                        "relay/environment"=>json!({"installed":true,"account":{"requiresOpenaiAuth":false,"account":{"type":"apiKey"}}}),
                        "relay/projects"=>json!({"data":[{"id":"fixture-project","name":"安卓验收","rootPaths":["/fixture"],"native":true}],"assignments":{"fixture-thread":"fixture-project"},"workspaceRootHints":{},"legacyAssignments":false,"nativeProjects":true}),
                        "thread/list"=>{let d=data.lock().await;json!({"data":if d.archived==params["archived"].as_bool().unwrap_or(false){vec![thread(&d)]}else{vec![]},"nextCursor":null})},
                        "thread/resume"|"thread/read"|"thread/start"=>json!({"thread":thread(&*data.lock().await),"model":"fixture","reasoningEffort":"medium"}),
                        "thread/turns/list"=>json!({"data":data.lock().await.turns.iter().rev().cloned().collect::<Vec<_>>(),"nextCursor":null}),
                        "model/list"=>json!({"data":[{"id":"fixture","model":"fixture","displayName":"验收模型","isDefault":true,"defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium"},{"reasoningEffort":"high"}]}]}),
                        "relay/pending"=>json!({"requests":data.lock().await.pending}),
                        "relay/prompts"|"app/list"|"mcpServerStatus/list"=>json!({"data":[]}),
                        "skills/list"=>json!({"data":[{"cwd":"/fixture","skills":[]}]}),
                        "fuzzyFileSearch"=>json!({"files":[]}),
                        "collaborationMode/list"=>json!({"data":[{"mode":"default","settings":{"model":"fixture"}},{"mode":"plan","settings":{"model":"fixture","reasoning_effort":"medium","developer_instructions":null}}]}),
                        "thread/goal/get"=>json!({"goal":null}),
                        "thread/name/set"=>json!({}),
                        "thread/archive"|"thread/unarchive"=>{
                            let archived=method=="thread/archive";data.lock().await.archived=archived;
                            out.send(Control::Event{message:json!({"method":if archived{"thread/archived"}else{"thread/unarchived"},"params":{"threadId":"fixture-thread"}})}).await?;json!({})
                        },
                        "turn/start"=>{
                            let text=params["input"].as_array().unwrap().iter().filter_map(|part|part["text"].as_str()).collect::<Vec<_>>().join("\n");
                            let turn=uuid::Uuid::new_v4().to_string();
                            let entry=json!({"id":turn,"status":"inProgress","items":[{"id":format!("{turn}-user"),"type":"userMessage","content":[{"type":"text","text":text}]}]});
                            {let mut d=data.lock().await;d.active=Some(turn.clone());d.turns.push(entry.clone());}
                            out.send(Control::Event{message:json!({"method":"turn/started","params":{"threadId":"fixture-thread","turn":entry}})}).await?;
                            let shared=data.clone();let output=out.clone();let token=turn.clone();
                            tokio::spawn(async move {
                                sleep(Duration::from_secs(4)).await;
                                if text.contains("审批") {
                                    let request=json!({"id":format!("approval-{token}"),"method":"item/commandExecution/requestApproval","params":{"threadId":"fixture-thread","turnId":token,"command":"printf '仅模拟审批，不会执行命令'","cwd":"/fixture"}});
                                    shared.lock().await.pending.push(request.clone());
                                    let _=output.send(Control::Event{message:request}).await;
                                } else {
                                    sleep(Duration::from_secs(8)).await;
                                    finish(shared,output,token).await;
                                }
                            });
                            json!({"turn":{"id":turn,"status":"inProgress","items":[]}})
                        },
                        "relay/approval"=>{
                            let mut d=data.lock().await;d.pending.retain(|request|request["id"]!=params["id"]);let turn=d.active.clone();drop(d);
                            out.send(Control::Event{message:json!({"method":"relay/approvalResolved","params":{"id":params["id"]}})}).await?;
                            if let Some(turn)=turn {tokio::spawn(finish(data.clone(),out.clone(),turn));}
                            json!({})
                        },
                        "turn/interrupt"=>{let mut d=data.lock().await;d.active=None;json!({})},
                        _=>json!({}),
                    };
                    remote::send(&transport.outgoing,&mut send,&Control::Response{id,result:Some(response),error:None}).await?;
                }
                let _=config;
                Ok(())
            }.await;
            if let Err(error)=result {eprintln!("验收连接结束：{error}");}
        });
    }
}
