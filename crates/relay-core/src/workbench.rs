use crate::{host::Host, AppEvent};
use anyhow::{anyhow, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, io::Write, path::PathBuf, sync::{Arc, atomic::{AtomicU64, Ordering}}};
use tokio::sync::{broadcast, Mutex, Notify};

pub fn key(device: &str, thread: &str) -> String { json!([device, thread]).to_string() }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub draft: Value,
    pub input: Vec<Value>,
    pub model: String,
    pub effort: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Deserialize)]
pub struct DraftTransition {
    key: String,
    expected: Value,
    next: Value,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub device: String,
    pub thread_id: String,
    pub thread: Value,
    pub items: Vec<QueuedMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<String>,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub queues: HashMap<String, Queue>,
    pub drafts: HashMap<String, Value>,
    #[serde(default)]
    pub draft_threads: HashMap<String, Value>,
    pub created: HashMap<String, Value>,
}
#[derive(Default)]
struct Session { synced: bool, running: bool, blocked: bool, sequence: u64, epoch: u64 }
#[derive(Default)]
struct State {
    snapshot: Snapshot,
    sessions: HashMap<String, Session>,
    approval_sequence: u64,
    approval_updates: HashMap<(String,String),(u64,Option<Value>)>,
}
pub struct Workbench {
    host: Arc<Host>,
    state: Mutex<State>,
    path: Option<PathBuf>,
    wake: Notify,
    settled: Notify,
    processed: AtomicU64,
    pub events: broadcast::Sender<Snapshot>,
}
impl Workbench {
    pub fn new(host: Arc<Host>, path: Option<PathBuf>) -> Result<Arc<Self>> {
        let mut snapshot: Snapshot = match path.as_ref().map(std::fs::read) {
            Some(Ok(bytes)) => serde_json::from_slice(&bytes).context("草稿和待发消息文件损坏，原文件已保留")?,
            Some(Err(error)) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => Snapshot::default(),
        };
        for queue in snapshot.queues.values_mut() {
            queue.paused = Some("已恢复待发消息，请同步会话后继续".into());
            for item in &mut queue.items {
                if item.status == "sending" {
                    item.status = "failed".into();
                    item.error = Some("上次发送结果未知，请查看会话后决定是否重试".into());
                }
            }
        }
        let (events, _) = broadcast::channel(64);
        Ok(Arc::new(Self { host, state: Mutex::new(State { snapshot, ..State::default() }), path, wake: Notify::new(), settled: Notify::new(), processed: AtomicU64::new(0), events }))
    }
    pub fn start(self: &Arc<Self>) {
        let mut events = self.host.events.subscribe();
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        let sequence=match &event {AppEvent::Codex{message,..}=>message["relaySequence"].as_u64().unwrap_or(0),_=>0};
                        if let Err(error)=this.observe(event).await {this.report(error);}
                        this.processed.fetch_max(sequence, Ordering::AcqRel);
                        this.settled.notify_waiters();
                    },
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Err(error) = this.pause_all("事件流已中断，请重新同步后继续").await { this.report(error); }
                        this.processed.store(this.host.event_sequence.load(Ordering::Acquire), Ordering::Release);
                        this.settled.notify_waiters();
                    },
                    Err(_) => break,
                }
            }
        });
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                this.wake.notified().await;
                while let Some(queue) = this.next().await {
                    if let Err(error) = this.dispatch(queue.clone()).await {
                        let mut state = this.state.lock().await;
                        if let Some(current) = state.snapshot.queues.values_mut().find(|current| current.items.iter().any(|item| item.id == queue.items[0].id)) {
                            if let Some(item) = current.items.first_mut() {
                                if item.status == "sending" { item.status = "failed".into(); item.error = Some(error.to_string()); }
                            }
                            current.paused = Some(error.to_string());
                        }
                        if let Err(save_error) = this.publish(&mut state) { this.report(save_error); }
                    }
                }
            }
        });
    }
    async fn synchronize_events(&self) {
        let target=self.host.event_sequence.load(Ordering::Acquire);
        loop {
            let notified=self.settled.notified();
            if self.processed.load(Ordering::Acquire)>=target {break;}
            notified.await;
        }
    }
    fn report(&self, error: anyhow::Error) {
        let _ = self.host.events.send(AppEvent::Diagnostic { message: error.to_string(), device: None });
    }
    fn publish(&self, state: &mut State) -> Result<()> {
        state.snapshot.revision += 1;
        state.snapshot.queues.retain(|_, queue| !queue.items.is_empty());
        if let Some(path) = &self.path {
            let parent = path.parent().ok_or_else(|| anyhow!("草稿目录无效"))?;
            std::fs::create_dir_all(parent)?;
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            serde_json::to_writer(&mut file, &state.snapshot)?;
            file.flush()?;
            file.as_file().sync_all()?;
            file.persist(path).map_err(|error| anyhow!("无法保存草稿和待发消息：{error}"))?;
        }
        let _ = self.events.send(state.snapshot.clone());
        Ok(())
    }
    pub async fn snapshot(&self) -> Snapshot { self.state.lock().await.snapshot.clone() }
    fn store_draft(snapshot: &mut Snapshot, draft_key: String, draft: Value, thread: Option<Value>) {
        if draft["text"].as_str().is_some_and(|text| !text.is_empty()) {
            if let Some(mut thread) = thread.filter(|thread| thread["relayDraft"] == true) {
                thread["preview"] = draft["text"].clone();
                snapshot.draft_threads.insert(draft_key.clone(), thread);
            }
            snapshot.drafts.insert(draft_key, draft);
        } else {
            snapshot.drafts.remove(&draft_key);
            snapshot.draft_threads.remove(&draft_key);
        }
    }
    pub async fn save_draft(&self, draft_key: String, draft: Value, thread: Option<Value>) -> Result<()> {
        let mut state = self.state.lock().await;
        let previous = state.snapshot.clone();
        Self::store_draft(&mut state.snapshot, draft_key, draft, thread);
        if let Err(error) = self.publish(&mut state) {
            state.snapshot = previous;
            return Err(error);
        }
        Ok(())
    }
    pub async fn enqueue(&self, device: String, thread: Value, mut item: QueuedMessage, draft: Option<DraftTransition>) -> Result<Snapshot> {
        let id = thread["id"].as_str().ok_or_else(|| anyhow!("缺少会话标识"))?.to_owned();
        ensure!(item.draft["text"].as_str().is_some_and(|text| !text.trim().is_empty()) && !item.input.is_empty(), "消息不能为空");
        ensure!(item.collaboration_mode.is_none() || !item.model.is_empty(), "请选择模型后再使用协作模式");
        let mut state = self.state.lock().await;
        let thread = state.snapshot.created.get(&key(&device, &id)).map(|created| created["thread"].clone()).unwrap_or(thread);
        let id = thread["id"].as_str().ok_or_else(|| anyhow!("缺少会话标识"))?.to_owned();
        let queue_key = key(&device, &id);
        let previous=state.snapshot.clone();
        let queue = state.snapshot.queues.entry(queue_key).or_insert_with(|| Queue { device, thread_id: id, thread, ..Queue::default() });
        ensure!(!queue.items.iter().any(|row| row.id == item.id), "消息已经在队列中");
        item.status = "queued".into(); item.error = None;
        queue.items.push(item);
        if let Some(draft) = draft {
            if state.snapshot.drafts.get(&draft.key) == Some(&draft.expected) {
                Self::store_draft(&mut state.snapshot, draft.key, draft.next, None);
            }
        }
        if let Err(error)=self.publish(&mut state) {state.snapshot=previous;return Err(error);}
        self.wake.notify_one();
        Ok(state.snapshot.clone())
    }
    pub async fn remove(&self, queue_key: &str, id: &str, restore_draft: Option<String>) -> Result<QueuedMessage> {
        let mut state = self.state.lock().await;
        if let Some(key) = &restore_draft {
            ensure!(!state.snapshot.drafts.contains_key(key), "输入框已有草稿，请先处理后再编辑待发消息");
        }
        let previous = state.snapshot.clone();
        let queue = state.snapshot.queues.get_mut(queue_key).ok_or_else(|| anyhow!("待发消息不存在"))?;
        let index = queue.items.iter().position(|item| item.id == id).ok_or_else(|| anyhow!("待发消息不存在"))?;
        ensure!(queue.items[index].status != "sending", "消息正在发送，请先查看提交结果");
        let item = queue.items.remove(index);
        if let Some(key) = restore_draft {
            let thread = queue.thread.clone();
            Self::store_draft(&mut state.snapshot, key, item.draft.clone(), Some(thread));
        }
        if let Err(error) = self.publish(&mut state) {
            state.snapshot = previous;
            return Err(error);
        }
        Ok(item)
    }
    pub async fn pause(&self, queue_key: &str, reason: String) -> Result<()> {
        let mut state = self.state.lock().await;
        if let Some(queue) = state.snapshot.queues.get_mut(queue_key) {
            if queue.paused.as_ref() == Some(&reason) { return Ok(()); }
            queue.paused = Some(reason);
            self.publish(&mut state)?;
        }
        Ok(())
    }
    pub async fn resume(&self, queue_key: &str, retry: Option<String>) -> Result<()> {
        let mut state = self.state.lock().await;
        let previous=state.snapshot.clone();
        let queue = state.snapshot.queues.get_mut(queue_key).ok_or_else(|| anyhow!("待发消息不存在"))?;
        if let Some(id) = retry {
            let item = queue.items.iter_mut().find(|item| item.id == id).ok_or_else(|| anyhow!("待发消息不存在"))?;
            ensure!(item.status == "failed", "此消息不需要重试");
            item.status = "queued".into(); item.error = None;
        }
        queue.paused = None;
        let session = state.sessions.entry(queue_key.into()).or_default();
        session.synced = false; session.running = false; session.blocked = false;
        if let Err(error)=self.publish(&mut state) {state.snapshot=previous;return Err(error);}
        self.wake.notify_one();
        Ok(())
    }
    pub async fn has_queue(&self, queue_key: &str) -> bool { self.state.lock().await.snapshot.queues.contains_key(queue_key) }
    pub async fn pause_all(&self, reason: &str) -> Result<()> {
        let mut state = self.state.lock().await;
        for queue in state.snapshot.queues.values_mut() { queue.paused = Some(reason.into()); }
        for session in state.sessions.values_mut() { session.synced = false; session.running = false; session.blocked = false; session.epoch += 1; }
        self.publish(&mut state)
    }
    async fn next(&self) -> Option<Queue> {
        let views = self.host.views().await;
        let state = self.state.lock().await;
        state.snapshot.queues.iter().find(|(key, queue)| {
            queue.paused.is_none() && queue.items.first().is_some_and(|item| item.status == "queued")
                && !state.sessions.get(*key).is_some_and(|session| session.running || session.blocked)
                && (queue.device == "local" || views.iter().any(|view| view.id == queue.device && view.state == "connected" && view.peer_sharing))
        }).map(|(_, queue)| queue.clone())
    }
    async fn observe(&self, event: AppEvent) -> Result<()> {
        let mut state = self.state.lock().await;
        let mut changed = false;
        match event {
            AppEvent::Device { device } => {
                if device.state != "connected" || !device.peer_sharing {
                    for (queue_key, queue) in &mut state.snapshot.queues {
                        if queue.device == device.id { queue.paused = Some("连接已中断或共享已暂停，请同步会话后继续".into()); changed = true; }
                        let _ = queue_key;
                    }
                    for (queue_key, session) in &mut state.sessions {
                        if serde_json::from_str::<Vec<String>>(queue_key).is_ok_and(|keys| keys[0] == device.id) { session.synced = false; session.running = false; session.blocked = false; session.epoch += 1; }
                    }
                }
            },
            AppEvent::Codex { device, message } => {
                let method = message["method"].as_str().unwrap_or("");
                if let Some(id)=message.get("id") {
                    state.approval_sequence+=1;
                    let sequence=state.approval_sequence;
                    state.approval_updates.insert((device.clone(),id.as_str().map(str::to_owned).unwrap_or_else(||id.to_string())),(sequence,Some(message.clone())));
                    return Ok(());
                }
                if matches!(method,"relay/approvalResolved"|"serverRequest/resolved") {
                    state.approval_sequence+=1;
                    let sequence=state.approval_sequence;
                    let id=message["params"].get("id").or_else(||message["params"].get("requestId")).and_then(Value::as_str).unwrap_or("").to_owned();
                    state.approval_updates.insert((device.clone(),id),(sequence,None));
                }
                if matches!(method, "relay/approvalResolved" | "serverRequest/resolved") {
                    for (queue_key, session) in &mut state.sessions {
                        if serde_json::from_str::<Vec<String>>(queue_key).is_ok_and(|keys| keys[0] == device) { session.blocked = false; }
                    }
                }
                if !matches!(method, "relay/codexExited" | "turn/started" | "turn/completed" | "thread/status/changed" | "relay/approvalResolved" | "serverRequest/resolved" | "thread/closed" | "thread/archived") { return Ok(()); }
                if method == "relay/codexExited" {
                    for queue in state.snapshot.queues.values_mut().filter(|queue| queue.device == device) {
                        queue.paused = Some("Codex 已退出，请重新接续会话后继续".into()); changed = true;
                    }
                    for (queue_key, session) in &mut state.sessions {
                        if serde_json::from_str::<Vec<String>>(queue_key).is_ok_and(|keys| keys[0] == device) { session.epoch += 1; session.synced = false; }
                    }
                }
                if let Some(thread) = message["params"]["threadId"].as_str().or_else(|| message["params"]["thread"]["id"].as_str()) {
                    let queue_key = key(&device, thread);
                    let session = state.sessions.entry(queue_key.clone()).or_default();
                    match method {
                        "turn/started" => { session.running = true; session.sequence += 1; },
                        "turn/completed" => { session.running = false; session.sequence += 1; },
                        "thread/status/changed" => { session.running = message["params"]["status"]["type"] == "active"; session.sequence += 1; },
                        "thread/closed" | "thread/archived" => { session.synced = false; session.epoch += 1; },
                        _ => {},
                    }
                    let failure = method == "turn/completed" && message["params"]["turn"]["status"].as_str().is_some_and(|status| status != "completed");
                    if failure || method == "thread/closed" || method == "thread/archived" {
                        if let Some(queue) = state.snapshot.queues.get_mut(&queue_key) { queue.paused = Some("回合已停止、失败或会话已关闭，请查看会话后继续".into()); changed = true; }
                    }
                }
                if !matches!(method, "turn/started" | "turn/completed" | "thread/status/changed" | "relay/approvalResolved" | "serverRequest/resolved" | "thread/closed" | "thread/archived") { return Ok(()); }
            },
            _ => return Ok(()),
        }
        if changed { self.publish(&mut state)?; }
        drop(state);
        self.wake.notify_one();
        Ok(())
    }
    async fn dispatch(&self, mut queue: Queue) -> Result<()> {
        let mut queue_key = key(&queue.device, &queue.thread_id);
        let (epoch, sequence, synced) = {
            let mut state = self.state.lock().await;
            let session = state.sessions.entry(queue_key.clone()).or_default();
            (session.epoch, session.sequence, session.synced)
        };
        if !synced && queue.thread["relayDraft"] != true {
            let response = self.host.call(&queue.device, "thread/resume", json!({"threadId":queue.thread_id})).await?;
            self.synchronize_events().await;
            ensure!(response["thread"].is_object(), "会话接续返回无效数据");
            let mut state = self.state.lock().await;
            let session = state.sessions.entry(queue_key.clone()).or_default();
            ensure!(session.epoch == epoch, "连接或会话已变化，请重新读取后继续");
            if session.sequence == sequence { session.running = response["thread"]["status"]["type"] == "active"; }
            session.synced = true;
            if session.running { return Ok(()); }
        }
        let since=self.state.lock().await.approval_sequence;
        let pending = self.host.call(&queue.device, "relay/pending", json!({})).await?;
        self.synchronize_events().await;
        ensure!(pending["requests"].is_array(), "无法确认待处理审批");
        let mut requests:HashMap<String,Value>=pending["requests"].as_array().unwrap().iter().map(|request|(request["id"].as_str().map(str::to_owned).unwrap_or_else(||request["id"].to_string()),request.clone())).collect();
        let item = {
            let mut state=self.state.lock().await;
            for ((device,id),(sequence,request)) in &state.approval_updates {
                if device==&queue.device && *sequence>since { if let Some(request)=request {requests.insert(id.clone(),request.clone());} else {requests.remove(id);} }
            }
            if requests.values().any(|request| request["params"]["threadId"].as_str().is_none_or(|id| id == queue.thread_id)) {
                state.sessions.entry(queue_key).or_default().blocked=true;
                return Ok(());
            }
            let session = state.sessions.entry(queue_key.clone()).or_default();
            ensure!(session.epoch == epoch, "连接或会话已变化，请重新读取后继续");
            if session.running { return Ok(()); }
            let Some(current) = state.snapshot.queues.get_mut(&queue_key) else { return Ok(()); };
            if current.paused.is_some() { return Ok(()); }
            let Some(item) = current.items.first_mut().filter(|item| item.id == queue.items[0].id && item.status == "queued") else { return Ok(()); };
            item.status = "sending".into();
            let item = item.clone();
            self.publish(&mut state)?;
            item
        };
        if queue.thread["relayDraft"] == true {
            let mut params = json!({"cwd":queue.thread["cwd"]});
            if !item.model.is_empty() { params["model"] = json!(item.model); }
            if let Some(project) = queue.thread.get("projectId") { params["projectId"] = project.clone(); }
            let response = self.host.call(&queue.device, "thread/start", params).await?;
            self.synchronize_events().await;
            let id = response["thread"]["id"].as_str().ok_or_else(|| anyhow!("新会话返回无效标识"))?.to_owned();
            let mut state = self.state.lock().await;
            ensure!(state.sessions.get(&queue_key).is_none_or(|session| session.epoch == epoch), "Codex 已退出，请重新读取会话确认创建结果");
            let old_key = queue_key.clone();
            queue_key = key(&queue.device, &id);
            let mut migrated = state.snapshot.queues.remove(&old_key).ok_or_else(|| anyhow!("新会话队列已移除"))?;
            migrated.thread_id = id.clone();
            migrated.thread = response["thread"].clone();
            migrated.thread["relayDraft"] = json!(false);
            migrated.thread["relayHistoryPending"] = json!(true);
            migrated.thread["relayDraftId"] = queue.thread["relayDraftId"].clone();
            state.snapshot.created.insert(old_key.clone(), json!({"device":queue.device,"from":queue.thread_id,"thread":migrated.thread,"response":response}));
            state.snapshot.draft_threads.remove(&old_key);
            // 草稿沿用 relayDraftId，与输入框在首次创建会话后的稳定标识一致。
            let session = state.sessions.remove(&old_key).unwrap_or_default();
            state.sessions.insert(queue_key.clone(), session);
            queue = migrated.clone();
            state.snapshot.queues.insert(queue_key.clone(), migrated);
            self.publish(&mut state)?;
        }
        let mut params = json!({"threadId":queue.thread_id,"input":item.input});
        if !item.model.is_empty() { params["model"] = json!(item.model); }
        if !item.effort.is_empty() { params["effort"] = json!(item.effort); }
        if let Some(mode) = item.collaboration_mode {
            params["collaborationMode"] = json!({"mode":mode,"settings":{"model":item.model,"reasoning_effort":if item.effort.is_empty() { Value::Null } else { json!(item.effort) },"developer_instructions":null}});
        }
        if let Some(tier) = item.service_tier { params["serviceTier"] = json!(tier); }
        let sequence = self.state.lock().await.sessions.entry(queue_key.clone()).or_default().sequence;
        let response = self.host.call(&queue.device, "turn/start", params).await;
        self.synchronize_events().await;
        let mut state = self.state.lock().await;
        match response {
            Ok(response) if response["turn"]["id"].is_string() => {
                let session = state.sessions.entry(queue_key.clone()).or_default();
                ensure!(session.epoch == epoch, "发送时连接已变化，请查看会话确认提交结果");
                if session.sequence == sequence { session.running = response["turn"]["status"] != "completed"; }
                if let Some(draft_id) = queue.thread["relayDraftId"].as_str() {
                    if let Some(created) = state.snapshot.created.get_mut(&key(&queue.device, draft_id)) {
                        created["thread"]["relayHistoryPending"] = json!(false);
                    }
                }
                if let Some(current) = state.snapshot.queues.get_mut(&queue_key) {
                    current.thread["relayHistoryPending"] = json!(false);
                    current.items.retain(|row| row.id != item.id);
                }
            },
            result => {
                let error = match result { Err(error) => error.to_string(), _ => "未收到回合确认，请查看会话后决定是否重试".into() };
                if let Some(current) = state.snapshot.queues.get_mut(&queue_key) {
                    current.paused = Some(error.clone());
                    if let Some(row) = current.items.iter_mut().find(|row| row.id == item.id) { row.status = "failed".into(); row.error = Some(error); }
                }
            },
        }
        self.publish(&mut state)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "workbench_tests.rs"]
mod tests;
