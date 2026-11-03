use anyhow::{anyhow, bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, path::{Path, PathBuf}, sync::{Arc, Mutex as StdMutex}, time::Duration};
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, process::Command, sync::{broadcast, mpsc, oneshot, Mutex}};
use tokio_util::sync::CancellationToken;
pub use crate::discovery::discover;

type Pending = StdMutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>;
pub struct Codex {
    installation: Mutex<Installation>,
    client: Mutex<Option<Arc<Client>>>,
    pub events: broadcast::Sender<Value>,
}
struct Installation { configured: String, executable: Option<PathBuf> }
struct WriteJob { data: Vec<u8>, done: oneshot::Sender<Result<(), String>> }
struct PendingRequest<'a> { pending: &'a Pending, id: String }
impl Drop for PendingRequest<'_> {
    fn drop(&mut self) { lock(self.pending).remove(&self.id); }
}
struct Approval { rpc_id: Value, message: Value }
struct Client {
    writer: mpsc::Sender<WriteJob>,
    pending: Pending,
    approvals: StdMutex<HashMap<String, Approval>>,
    active: StdMutex<HashMap<String, String>>,
    unmaterialized: StdMutex<HashMap<String, Value>>,
    archived: StdMutex<HashSet<String>>,
    resume_lock: Mutex<()>,
    start_locks: StdMutex<HashMap<String, Arc<Mutex<()>>>>,
    ended: CancellationToken,
    process_exited: CancellationToken,
}
fn lock<T>(m: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> { m.lock().unwrap_or_else(|e| e.into_inner()) }

async fn write_loop<W: tokio::io::AsyncWrite + Unpin>(mut stdin: W, mut writes: mpsc::Receiver<WriteJob>, writer_stop: CancellationToken) {
    loop {
        let job = tokio::select! {
            _ = writer_stop.cancelled() => break,
            job = writes.recv() => { let Some(job) = job else { break }; job },
        };
        // A caller can stop waiting, but a started JSON line is always written in full.
        let result = tokio::select! {
            _ = writer_stop.cancelled() => break,
            result = tokio::time::timeout(Duration::from_secs(15), stdin.write_all(&job.data)) => result,
        };
        let result = match result {
            Ok(Ok(())) => Ok(()),
            _ => Err("Codex 写入失败或超时；请刷新会话确认提交结果".to_string()),
        };
        let failed = result.is_err();
        let _ = job.done.send(result);
        if failed { writer_stop.cancel(); break; }
    }
}

impl Codex {
    pub fn new(path: String) -> Arc<Self> {
        let (events, _) = broadcast::channel(1024);
        Arc::new(Self { installation: Mutex::new(Installation { configured: path, executable: None }), client: Mutex::new(None), events })
    }
    pub async fn set_path(&self, path: String) {
        let mut slot = self.client.lock().await;
        *self.installation.lock().await = Installation { configured: path, executable: None };
        if let Some(client) = slot.take() { client.ended.cancel(); }
    }
    pub async fn shutdown(&self) {
        let client = self.client.lock().await.take();
        if let Some(client) = client {
            client.ended.cancel();
            let _ = tokio::time::timeout(Duration::from_secs(5), client.process_exited.cancelled()).await;
        }
    }
    pub async fn has_pending_work(&self) -> bool {
        let slot = self.client.lock().await;
        slot.as_ref().is_some_and(|client| !client.ended.is_cancelled()
            && (!lock(&client.active).is_empty() || !lock(&client.approvals).is_empty() || !lock(&client.pending).is_empty()))
    }
    async fn executable(&self) -> Result<PathBuf> {
        let mut installation = self.installation.lock().await;
        if let Some(path) = &installation.executable { return Ok(path.clone()); }
        let configured = installation.configured.clone();
        let path = tokio::task::spawn_blocking(move || discover(&configured)).await??;
        installation.executable = Some(path.clone());
        Ok(path)
    }
    async fn get(&self) -> Result<Arc<Client>> {
        let result = self.get_inner().await;
        if result.is_err() { self.installation.lock().await.executable = None; }
        result
    }
    async fn get_inner(&self) -> Result<Arc<Client>> {
        let mut slot = self.client.lock().await;
        if let Some(client) = slot.as_ref().filter(|c| !c.ended.is_cancelled()) { return Ok(client.clone()); }
        let executable = self.executable().await?;
        let mut cmd = if executable.extension().is_some_and(|v| v.to_string_lossy().eq_ignore_ascii_case("js")) {
            let mut cmd = Command::new(tokio::task::spawn_blocking(crate::discovery::node_executable).await??); cmd.arg(&executable); cmd
        } else { Command::new(&executable) };
        let tool_executable = executable.clone();
        let path = tokio::task::spawn_blocking(move || crate::discovery::command_path(&tool_executable)).await??;
        cmd.env("PATH", path);
        cmd.arg("app-server").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        #[cfg(windows)] cmd.creation_flags(0x08000000);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => { self.installation.lock().await.executable = None; return Err(error).context("无法启动 Codex，请检查可执行文件和本机登录配置"); }
        };
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("无法连接 Codex stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("无法连接 Codex stdout"))?;
        let (writer, writes) = mpsc::channel::<WriteJob>(128);
        let client = Arc::new(Client { writer,pending:StdMutex::new(HashMap::new()),approvals:StdMutex::new(HashMap::new()),active:StdMutex::new(HashMap::new()),unmaterialized:StdMutex::new(HashMap::new()),archived:StdMutex::new(HashSet::new()),resume_lock:Mutex::new(()),start_locks:StdMutex::new(HashMap::new()),ended:CancellationToken::new(),process_exited:CancellationToken::new() });
        // Initialization cancellation must terminate the process before it is published.
        let startup = client.ended.clone().drop_guard();
        let writer_stop = client.ended.clone();
        tokio::spawn(write_loop(stdin, writes, writer_stop));
        let reader_client = client.clone();
        let events = self.events.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let result: Result<()> = async {
                loop {
                    let mut line = String::new();
                    let size = tokio::select! {
                        _ = reader_client.ended.cancelled() => break,
                        result = reader.read_line(&mut line) => result?,
                    };
                    if size == 0 { break; }
                    ensure!(size <= crate::model::MAX_MESSAGE, "Codex 消息超过大小限制");
                    let Ok(mut msg) = serde_json::from_str::<Value>(&line) else { continue };
                    if msg.get("method").is_some() {
                        if let Some(rpc_id) = msg.get("id").cloned() {
                            let id = uuid::Uuid::new_v4().to_string();
                            msg["id"] = json!(id);
                            lock(&reader_client.approvals).insert(id, Approval { rpc_id, message:msg.clone() });
                        }
                        match msg["method"].as_str().unwrap_or_default() {
                            "turn/started" => {
                                if let (Some(thread), Some(turn)) = (msg["params"]["threadId"].as_str(), msg["params"]["turn"]["id"].as_str()) {
                                    lock(&reader_client.unmaterialized).remove(thread);
                                    lock(&reader_client.active).insert(thread.into(),turn.into());
                                }
                            }
                            "turn/completed" => { if let Some(thread) = msg["params"]["threadId"].as_str() { lock(&reader_client.active).remove(thread); } }
                            "thread/archived" => {
                                if let Some(thread) = msg["params"]["threadId"].as_str() {
                                    lock(&reader_client.archived).insert(thread.into());
                                    lock(&reader_client.unmaterialized).remove(thread);
                                    lock(&reader_client.active).remove(thread);
                                }
                            }
                            "thread/unarchived" => { if let Some(thread) = msg["params"]["threadId"].as_str() { lock(&reader_client.archived).remove(thread); } }
                            "thread/closed" => {
                                if let Some(thread) = msg["params"]["threadId"].as_str() {
                                    lock(&reader_client.unmaterialized).remove(thread);
                                    lock(&reader_client.active).remove(thread);
                                }
                            }
                            "serverRequest/resolved" => {
                                let rpc_id = &msg["params"]["requestId"];
                                let mut approvals = lock(&reader_client.approvals);
                                let resolved: Vec<_> = approvals.iter().filter(|(_,a)|a.rpc_id==*rpc_id).map(|(id,_)|id.clone()).collect();
                                for id in resolved {
                                    approvals.remove(&id);
                                    let _=events.send(json!({"method":"relay/approvalResolved","params":{"id":id}}));
                                }
                            }
                            _ => {}
                        }
                        let _ = events.send(msg);
                    } else if let Some(id) = msg["id"].as_str() {
                        if let Some(tx) = lock(&reader_client.pending).remove(id) {
                            let value = if let Some(error) = msg.get("error") {
                                let mut detail = error["message"].as_str().unwrap_or("Codex 请求失败").to_owned();
                                if let Some(code) = error.get("code") { detail.push_str(&format!("（错误码：{code}）")); }
                                if let Some(data) = error.get("data").filter(|data| !data.is_null()) { detail.push_str(&format!("；详情：{data}")); }
                                Err(detail)
                            } else { Ok(msg["result"].clone()) };
                            let _ = tx.send(value);
                        }
                    }
                }
                Ok(())
            }.await;
            reader_client.ended.cancel();
            for (_, tx) in lock(&reader_client.pending).drain() { let _ = tx.send(Err("Codex 进程连接已结束，提交结果可能未知，请重新读取会话".into())); }
            lock(&reader_client.approvals).clear();
            lock(&reader_client.active).clear();
            lock(&reader_client.unmaterialized).clear();
            lock(&reader_client.archived).clear();
            let _ = events.send(json!({"method":"relay/codexExited","params":{"reason":if result.is_ok() {"Codex 进程已退出"} else {"Codex 协议流异常，请检查版本兼容性"}}}));
        });
        let stop = client.ended.clone();
        let exited = client.process_exited.clone();
        tokio::spawn(async move {
            let _exited = exited.drop_guard();
            tokio::select! { _ = stop.cancelled() => { let _ = child.kill().await; }, _ = child.wait() => { stop.cancel(); } }
        });
        let initialized = client.request("initialize", json!({"clientInfo":{"name":"agent_relay","title":"Relay","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true,"requiredHumanApproval":true}})).await;
        if let Err(error) = initialized { client.ended.cancel(); bail!("Codex 协议初始化失败：{error}"); }
        client.write(json!({"method":"initialized","params":{}})).await?;
        *slot = Some(client.clone());
        startup.disarm();
        Ok(client)
    }
    pub async fn call(&self, method: &str, mut params: Value) -> Result<Value> {
        if method == "relay/environment" {
            if params["refresh"] == true { self.installation.lock().await.executable = None; }
            let path = self.executable().await;
            return match path {
                Ok(path) => {
                    let client = self.get().await?;
                    let account = client.request("account/read",json!({"refreshToken":false})).await?;
                    Ok(json!({"installed":true,"path":path.to_string_lossy(),"account":account}))
                }
                Err(error) => Ok(json!({"installed":false,"error":error.to_string()})),
            };
        }
        if method == "relay/prompts" {
            ensure!(params.as_object().is_some_and(|params| params.is_empty()), "自定义命令列表不接受额外参数");
            return tokio::task::spawn_blocking(crate::prompts::list).await?;
        }
        let client = self.get().await?;
        if method == "relay/projects" {
            ensure!(params.as_object().is_some_and(|params| params.is_empty()), "项目列表不接受额外参数");
            let desktop = tokio::task::spawn_blocking(crate::projects::read_desktop).await??;
            let mut cursor = Value::Null;
            let mut seen = HashSet::new();
            let mut projects = Vec::new();
            loop {
                let response = client.request("project/list", json!({"cursor":cursor,"limit":100,"sortKey":"position","sortDirection":"asc"})).await;
                let page = match response {
                    Ok(page) => page,
                    Err(error) => {
                        let detail = error.to_string();
                        if projects.is_empty() && (detail.contains("错误码：-32601") || detail.contains("unknown variant `project/list`") || detail.contains("Unknown method: project/list")) {
                            return desktop.catalog(None);
                        }
                        return Err(error).context("无法读取 Codex 项目列表");
                    }
                };
                let data = page["data"].as_array().ok_or_else(||anyhow!("Codex 返回了无效的项目列表"))?;
                projects.extend(data.iter().cloned());
                ensure!(projects.len() <= 4096, "Codex 项目数量超过读取限制");
                cursor = page["nextCursor"].clone();
                if cursor.is_null() { break; }
                let next = cursor.as_str().filter(|cursor| !cursor.is_empty()).ok_or_else(||anyhow!("Codex 项目分页标识无效"))?;
                ensure!(seen.insert(next.to_owned()), "Codex 项目分页未能继续");
            }
            return desktop.catalog(Some(projects));
        }
        if method == "relay/pending" { return Ok(json!({"requests":lock(&client.approvals).values().map(|a|a.message.clone()).collect::<Vec<_>>()})); }
        if method == "relay/approval" {
            let id = params["id"].as_str().ok_or_else(|| anyhow!("缺少审批标识"))?;
            let result = params.get("result").cloned().ok_or_else(|| anyhow!("缺少审批结果"))?;
            let request = lock(&client.approvals).get(id).map(|approval| approval.message.clone()).ok_or_else(||anyhow!("审批已处理或进程已重启，请刷新"))?;
            let result = crate::approvals::response(&request, result)?;
            let approval = lock(&client.approvals).remove(id).ok_or_else(||anyhow!("审批已由另一端处理"))?;
            if let Err(error) = client.write(json!({"id":approval.rpc_id.clone(),"result":result})).await {
                lock(&client.approvals).insert(id.into(),approval); return Err(error);
            }
            let _ = self.events.send(json!({"method":"relay/approvalResolved","params":{"id":id}}));
            return Ok(json!({}));
        }
        ensure!(matches!(method,"thread/list"|"thread/read"|"thread/start"|"thread/resume"|"thread/archive"|"thread/unarchive"|"thread/turns/list"|"thread/items/list"|"thread/compact/start"|"thread/fork"|"thread/name/set"|"thread/goal/get"|"thread/goal/set"|"thread/goal/clear"|"review/start"|"collaborationMode/list"|"mcpServerStatus/list"|"account/rateLimits/read"|"turn/start"|"turn/interrupt"|"model/list"|"account/read"|"fuzzyFileSearch"|"app/list"|"skills/list"), "不支持的 Codex 操作");
        ensure!(params.is_object(), "参数必须是对象");
        if matches!(method, "fuzzyFileSearch" | "app/list" | "skills/list") {
            let allowed: &[&str] = match method {
                "fuzzyFileSearch" => &["query", "roots", "cancellationToken"],
                "app/list" => &["cursor", "limit", "threadId", "forceRefetch"],
                _ => &["cwds", "forceReload"],
            };
            ensure!(params.as_object().unwrap().keys().all(|key| allowed.contains(&key.as_str())), "引用查询包含未开放的字段");
            if method == "fuzzyFileSearch" {
                let query = params["query"].as_str().ok_or_else(|| anyhow!("缺少文件查询文字"))?;
                ensure!(query.len() <= 2048, "文件查询文字过长");
                let roots = params["roots"].as_array().ok_or_else(|| anyhow!("缺少项目搜索目录"))?;
                ensure!(!roots.is_empty() && roots.len() <= 4, "项目搜索目录数量无效");
                for root in roots {
                    let path = root.as_str().ok_or_else(|| anyhow!("项目搜索目录无效"))?;
                    ensure!(Path::new(path).is_absolute() && Path::new(path).is_dir(), "执行电脑上的项目搜索目录无效");
                }
                if let Some(token) = params.get("cancellationToken").filter(|value| !value.is_null()) {
                    ensure!(token.as_str().is_some_and(|token| token.len() <= 200), "搜索取消标识无效");
                }
            } else if method == "skills/list" {
                if let Some(cwds) = params.get("cwds") {
                    let paths = cwds.as_array().ok_or_else(|| anyhow!("技能项目目录格式无效"))?;
                    ensure!(!paths.is_empty() && paths.len() <= 4, "技能项目目录数量无效");
                    for path in paths {
                        let path = path.as_str().ok_or_else(|| anyhow!("技能项目目录无效"))?;
                        ensure!(Path::new(path).is_absolute() && Path::new(path).is_dir(), "执行电脑上的技能项目目录无效");
                    }
                }
                if let Some(reload) = params.get("forceReload") { ensure!(reload.is_boolean(), "技能刷新参数无效"); }
            } else {
                if let Some(limit) = params.get("limit").filter(|value| !value.is_null()) {
                    ensure!(limit.as_u64().is_some_and(|limit| limit > 0 && limit <= 100), "应用列表分页数量无效");
                }
                if let Some(cursor) = params.get("cursor").filter(|value| !value.is_null()) {
                    ensure!(cursor.as_str().is_some_and(|cursor| cursor.len() <= 4096), "应用列表分页标识无效");
                }
                if let Some(thread) = params.get("threadId").filter(|value| !value.is_null()) {
                    ensure!(thread.as_str().is_some_and(|thread| !thread.is_empty() && thread.len() <= 200), "应用列表会话标识无效");
                }
                if let Some(refresh) = params.get("forceRefetch") { ensure!(refresh.is_boolean(), "应用列表刷新参数无效"); }
            }
        }
        if matches!(method,"thread/start"|"thread/resume") {
            if let Some(path) = params["cwd"].as_str() {
                ensure!(Path::new(path).is_absolute() && Path::new(path).is_dir(), "执行电脑上的项目目录无效");
            }
        }
        if method == "thread/start" {
            if let Some(project) = params.get("projectId") {
                ensure!(project.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 200), "Codex 项目标识无效");
            }
        }
        // No approval/sandbox/config overrides are accepted from a remote workbench.
        if matches!(method,"thread/start"|"thread/resume"|"turn/start") {
            let allowed: &[&str] = match method {
                "thread/start" => &["cwd","model","projectId"],
                "thread/resume" => &["threadId"],
                _ => &["threadId","input","model","effort","collaborationMode","serviceTier"],
            };
            ensure!(params.as_object().unwrap().keys().all(|k|allowed.contains(&k.as_str())), "请求包含未开放的权限或配置字段");
        }
        if method == "turn/start" {
            if let Some(mode) = params.get("collaborationMode") {
                ensure!(mode.as_object().is_some_and(|object| object.len() == 2 && object.contains_key("mode") && object.contains_key("settings")), "协作模式格式无效");
                ensure!(matches!(mode["mode"].as_str(), Some("default" | "plan")), "协作模式无效");
                let settings = mode["settings"].as_object().ok_or_else(||anyhow!("协作模式设置无效"))?;
                ensure!(settings.len() == 3 && settings.keys().all(|key| ["model","reasoning_effort","developer_instructions"].contains(&key.as_str())), "协作模式包含未开放的配置字段");
                ensure!(mode["settings"]["developer_instructions"].is_null(), "协作模式只能使用 Codex 内置指令");
                ensure!(mode["settings"]["model"].as_str().is_some_and(|model| !model.is_empty() && model.len() <= 200), "协作模式缺少模型");
                ensure!(mode["settings"]["reasoning_effort"].is_null() || matches!(mode["settings"]["reasoning_effort"].as_str(), Some("none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra")), "推理强度无效");
            }
            if let Some(tier) = params.get("serviceTier") {
                ensure!(tier.as_str().is_some_and(|tier| !tier.is_empty() && tier.len() <= 100), "服务档位无效");
            }
        }
        if matches!(method, "collaborationMode/list" | "account/rateLimits/read") {
            ensure!(params.as_object().unwrap().is_empty(), "查询包含未开放的字段");
        }
        if method == "mcpServerStatus/list" {
            ensure!(params.as_object().unwrap().keys().all(|key| ["cursor","limit","threadId"].contains(&key.as_str())), "MCP 查询包含未开放的字段");
            if let Some(limit) = params.get("limit") { ensure!(limit.as_u64().is_some_and(|limit| limit > 0 && limit <= 100), "MCP 分页数量无效"); }
            if let Some(cursor) = params.get("cursor").filter(|value| !value.is_null()) { ensure!(cursor.as_str().is_some_and(|cursor| cursor.len() <= 4096), "MCP 分页标识无效"); }
            if let Some(thread) = params.get("threadId") { ensure!(thread.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 200), "MCP 会话标识无效"); }
        }
        if matches!(method, "thread/compact/start" | "thread/fork" | "thread/name/set" | "review/start" | "thread/goal/get" | "thread/goal/set" | "thread/goal/clear") {
            let allowed: &[&str] = match method {
                "thread/name/set" => &["threadId","name"],
                "review/start" => &["threadId","target"],
                "thread/goal/set" => &["threadId","objective","status","tokenBudget"],
                _ => &["threadId"],
            };
            ensure!(params.as_object().unwrap().keys().all(|key| allowed.contains(&key.as_str())), "命令包含未开放的字段");
            let thread = params["threadId"].as_str().filter(|id| !id.is_empty() && id.len() <= 200).ok_or_else(||anyhow!("缺少或无效的会话标识"))?.to_owned();
            if method == "thread/name/set" {
                ensure!(params["name"].as_str().is_some_and(|name| !name.trim().is_empty() && name.len() <= 512), "会话名称无效或过长");
            }
            if method == "review/start" {
                let target = params["target"].as_object().ok_or_else(||anyhow!("审查目标无效"))?;
                let field = match params["target"]["type"].as_str() {
                    Some("uncommittedChanges") => None,
                    Some("baseBranch") => Some("branch"),
                    Some("commit") => Some("sha"),
                    Some("custom") => Some("instructions"),
                    _ => bail!("审查类型无效"),
                };
                ensure!(target.keys().all(|key| key == "type" || Some(key.as_str()) == field || (field == Some("sha") && key == "title")), "审查目标包含未开放的字段");
                if let Some(field) = field { ensure!(params["target"][field].as_str().is_some_and(|text| !text.trim().is_empty() && text.len() <= 16000), "请填写审查目标"); }
            }
            if method == "thread/goal/set" {
                if let Some(objective) = params.get("objective") { ensure!(objective.as_str().is_some_and(|text| !text.trim().is_empty() && text.len() <= 32000), "目标内容无效"); }
                if let Some(status) = params.get("status") { ensure!(matches!(status.as_str(), Some("active" | "paused")), "目标状态无效"); }
                if let Some(budget) = params.get("tokenBudget").filter(|value| !value.is_null()) { ensure!(budget.as_u64().is_some_and(|value| value > 0), "目标预算必须为正整数"); }
                params["origin"] = json!("user");
            }
            if method == "thread/goal/clear" { params["origin"] = json!("user"); }
            let start_lock = lock(&client.start_locks).entry(thread.clone()).or_insert_with(||Arc::new(Mutex::new(()))).clone();
            let _start_guard = start_lock.lock().await;
            ensure!(!lock(&client.archived).contains(&thread), "请先恢复已归档的会话");
            let starts_work = matches!(method, "thread/compact/start" | "review/start");
            let needs_idle = starts_work || method == "thread/fork";
            if needs_idle {
                ensure!(!lock(&client.active).contains_key(&thread), "请等待当前回合结束后执行此命令");
                ensure!(!lock(&client.approvals).values().any(|approval| approval.message["params"]["threadId"].as_str() == Some(thread.as_str())), "请先处理此会话的待办审批");
            }
            if matches!(method, "thread/compact/start" | "thread/fork") { ensure!(!lock(&client.unmaterialized).contains_key(&thread), "发送首条消息后才可执行此命令"); }
            if starts_work {
                client.resume(&thread).await?;
                let mut active = lock(&client.active);
                ensure!(!active.contains_key(&thread), "此会话已有回合正在运行");
                active.insert(thread.clone(), "relay:pending-command".into());
            }
            if method == "thread/fork" { params["excludeTurns"] = json!(true); params["deferGoalContinuation"] = json!(true); }
            let response = client.request(method, params).await;
            if starts_work {
                match &response {
                    Ok(value) => {
                        if let Some(turn) = value["turn"]["id"].as_str() {
                            lock(&client.unmaterialized).remove(&thread);
                            // A completed notification may precede the response.
                            if let Some(active) = lock(&client.active).get_mut(&thread) { if active.as_str() == "relay:pending-command" { *active = turn.into(); } }
                        }
                    }
                    Err(_) => { lock(&client.active).remove(&thread); }
                }
            }
            return response;
        }
        if matches!(method, "thread/archive" | "thread/unarchive") {
            ensure!(params.as_object().unwrap().keys().all(|key| key == "threadId"), "归档请求包含未开放的字段");
            let thread = params["threadId"].as_str().filter(|id| !id.is_empty() && id.len() <= 200).ok_or_else(||anyhow!("缺少或无效的会话标识"))?.to_owned();
            let start_lock = lock(&client.start_locks).entry(thread.clone()).or_insert_with(||Arc::new(Mutex::new(()))).clone();
            let _start_guard = start_lock.lock().await;
            if method == "thread/archive" {
                ensure!(!lock(&client.unmaterialized).contains_key(&thread), "发送首条消息后才可归档会话");
                ensure!(!lock(&client.active).contains_key(&thread), "请等待当前任务结束后再归档");
                ensure!(!lock(&client.approvals).values().any(|approval| approval.message["params"]["threadId"].as_str() == Some(thread.as_str())), "请先处理此会话的待办审批");
            }
            let result = client.request(method,params).await?;
            if method == "thread/archive" {
                lock(&client.archived).insert(thread.clone());
                lock(&client.unmaterialized).remove(&thread);
                lock(&client.active).remove(&thread);
            } else {
                lock(&client.archived).remove(&thread);
            }
            return Ok(result);
        }
        if method == "turn/start" {
            let thread = params["threadId"].as_str().ok_or_else(||anyhow!("缺少会话标识"))?.to_string();
            let start_lock=lock(&client.start_locks).entry(thread.clone()).or_insert_with(||Arc::new(Mutex::new(()))).clone();
            let _start_guard=start_lock.lock().await;
            ensure!(!lock(&client.active).contains_key(&thread), "此会话已有回合正在运行");
            client.resume(&thread).await?;
            {
                let mut active = lock(&client.active);
                ensure!(!active.contains_key(&thread), "此会话已有回合正在运行");
                active.insert(thread.clone(),String::new());
            }
            let response = client.request(method,params).await;
            match &response {
                Ok(value) => {
                    if let Some(turn) = value["turn"]["id"].as_str() {
                        lock(&client.unmaterialized).remove(&thread);
                        if let Some(active) = lock(&client.active).get_mut(&thread) { *active = turn.into(); }
                    }
                }
                Err(_) => { lock(&client.active).remove(&thread); }
            }
            return response;
        }
        if method == "thread/resume" {
            let thread = params["threadId"].as_str().ok_or_else(||anyhow!("缺少会话标识"))?;
            let start_lock = lock(&client.start_locks).entry(thread.into()).or_insert_with(||Arc::new(Mutex::new(()))).clone();
            let _start_guard = start_lock.lock().await;
            return client.resume(thread).await;
        }
        let mut result = client.request(method,params).await?;
        if method == "thread/start" {
            let thread = result["thread"]["id"].as_str().ok_or_else(||anyhow!("Codex 返回了无效的会话数据"))?.to_owned();
            // A new thread is already loaded, but has no persisted history until its first turn.
            result["relayHistoryPending"] = json!(true);
            ensure!(!client.ended.is_cancelled(), "Codex 进程已退出，新建会话尚未保存");
            lock(&client.unmaterialized).insert(thread,result.clone());
        }
        Ok(result)
    }
}
impl Client {
    async fn write(&self, value: Value) -> Result<()> {
        ensure!(!self.ended.is_cancelled(), "Codex 进程连接已结束");
        let mut data = serde_json::to_vec(&value)?; data.push(b'\n');
        let (done, result) = oneshot::channel();
        tokio::time::timeout(Duration::from_secs(15), self.writer.send(WriteJob { data, done })).await
            .context("Codex 写入队列等待超时")?.map_err(|_|anyhow!("Codex 写入通道已关闭"))?;
        result.await.map_err(|_|anyhow!("Codex 写入通道已关闭"))?.map_err(|error|anyhow!(error))
    }
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id.clone(),tx);
        let _pending = PendingRequest { pending: &self.pending, id: id.clone() };
        self.write(json!({"id":id,"method":method,"params":params})).await?;
        let result = tokio::time::timeout(Duration::from_secs(90),rx).await;
        match result {
            Ok(Ok(result)) => result.map_err(|e|anyhow!(e)),
            Ok(Err(_)) => bail!("Codex 连接已断开；请刷新会话确认提交结果"),
            Err(_) => bail!("Codex 请求超时；不会自动重发，请刷新会话确认提交结果"),
        }
    }
    async fn resume(&self, id: &str) -> Result<Value> {
        let _guard = self.resume_lock.lock().await;
        ensure!(!self.ended.is_cancelled(), "Codex 进程连接已结束");
        ensure!(!lock(&self.archived).contains(id), "此会话已归档，请先恢复会话");
        let pending = lock(&self.unmaterialized).get(id).cloned();
        if let Some(session) = pending { return Ok(session); }
        // Rejoin the thread to recover host permissions and subscriptions, without
        // hydrating its entire history before the bounded turns/list request.
        let result = self.request("thread/resume",json!({"threadId":id,"excludeTurns":true})).await.map_err(|error| anyhow!("无法接续此会话：{error:#}"))?;
        ensure!(!self.ended.is_cancelled(), "Codex 进程连接已结束");
        let mut active = lock(&self.active);
        if !active.get(id).is_some_and(|turn| turn.as_str() == "relay:pending-command") { active.remove(id); }
        if result["thread"]["status"]["type"]=="active" { active.insert(id.into(),String::new()); }
        if let Some(turns) = result["thread"]["turns"].as_array() {
            for turn in turns {
                if turn["status"] == "inProgress" {
                    if let Some(turn_id) = turn["id"].as_str() { active.insert(id.into(),turn_id.into()); }
                }
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    fn client(writer: mpsc::Sender<WriteJob>) -> Arc<Client> {
        Arc::new(Client {
            writer, pending: StdMutex::new(HashMap::new()), approvals: StdMutex::new(HashMap::new()),
            active: StdMutex::new(HashMap::new()), unmaterialized: StdMutex::new(HashMap::new()),
            archived: StdMutex::new(HashSet::new()), resume_lock: Mutex::new(()),
            start_locks: StdMutex::new(HashMap::new()), ended: CancellationToken::new(), process_exited: CancellationToken::new(),
        })
    }

    #[tokio::test]
    async fn cancelled_request_removes_pending_entry() {
        let (writer, mut writes) = mpsc::channel(4);
        let client = client(writer);
        let request_client = client.clone();
        let task = tokio::spawn(async move { request_client.request("thread/read", json!({})).await });
        let _job = writes.recv().await.unwrap();
        assert_eq!(lock(&client.pending).len(), 1);
        task.abort();
        let _ = task.await;
        assert!(lock(&client.pending).is_empty());
    }

    #[tokio::test]
    async fn cancelled_caller_does_not_truncate_a_started_json_line() {
        let (stdin, mut stdout) = tokio::io::duplex(16);
        let (writer, writes) = mpsc::channel(4);
        let stop = CancellationToken::new();
        let actor = tokio::spawn(write_loop(stdin, writes, stop));
        let first = serde_json::to_string(&json!({"text":"x".repeat(2048)})).unwrap() + "\n";
        let (done, result) = oneshot::channel();
        writer.send(WriteJob { data: first.as_bytes().to_vec(), done }).await.unwrap();
        let mut prefix = [0u8; 8];
        stdout.read_exact(&mut prefix).await.unwrap();
        drop(result);
        let (done, result) = oneshot::channel();
        writer.send(WriteJob { data: b"{\"next\":true}\n".to_vec(), done }).await.unwrap();
        drop(writer);
        let mut remainder = String::new();
        stdout.read_to_string(&mut remainder).await.unwrap();
        let full = String::from_utf8(prefix.to_vec()).unwrap() + &remainder;
        let lines: Vec<Value> = full.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["text"].as_str().unwrap().len(), 2048);
        assert_eq!(lines[1]["next"], true);
        assert!(result.await.unwrap().is_ok());
        actor.await.unwrap();
    }

    #[tokio::test]
    async fn write_failure_terminates_the_protocol_stream() {
        let (stdin, stdout) = tokio::io::duplex(16);
        drop(stdout);
        let (writer, writes) = mpsc::channel(1);
        let stop = CancellationToken::new();
        let actor = tokio::spawn(write_loop(stdin, writes, stop.clone()));
        let (done, result) = oneshot::channel();
        writer.send(WriteJob { data: b"{}\n".to_vec(), done }).await.unwrap();
        assert!(result.await.unwrap().is_err());
        actor.await.unwrap();
        assert!(stop.is_cancelled());
    }

    #[tokio::test]
    async fn invalid_configured_executable_is_reported_without_starting_a_process() {
        let codex = Codex::new("not-an-absolute-executable".into());
        let environment = codex.call("relay/environment", json!({})).await.unwrap();
        assert_eq!(environment["installed"], false);
        assert!(codex.client.lock().await.is_none());
        assert!(codex.installation.lock().await.executable.is_none());
    }

    #[tokio::test]
    async fn ended_writer_drops_queued_write_receipts() {
        let (stdin, _stdout) = tokio::io::duplex(16);
        let (writer, writes) = mpsc::channel(1);
        let stop = CancellationToken::new();
        stop.cancel();
        let (done, result) = oneshot::channel();
        writer.send(WriteJob { data: vec![0; 4096], done }).await.unwrap();
        tokio::spawn(write_loop(stdin, writes, stop)).await.unwrap();
        assert!(result.await.is_err());
    }
}

