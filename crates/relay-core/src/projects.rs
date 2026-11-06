//! Read Codex desktop project metadata without modifying its configuration or database.
use anyhow::{anyhow, ensure, Context, Result};
use serde_json::{json, Map, Value};
use std::{collections::HashMap, io::Read, path::PathBuf};

pub struct DesktopProjects {
    home: PathBuf,
    state: Value,
}

fn path_key(path: &str) -> String {
    let path = path.replace('\\', "/").trim_end_matches('/').to_owned();
    if cfg!(windows) { path.to_lowercase() } else { path }
}

fn host_state<'a>(state: &'a Value, host: &str, key: &str) -> Option<&'a Value> {
    state[key].as_object()?.iter().find(|(key, _)| path_key(key) == path_key(host)).map(|(_, value)| value)
}

pub fn read_desktop() -> Result<DesktopProjects> {
    let home = crate::discovery::codex_home()?;
    let path = home.join(".codex-global-state.json");
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(DesktopProjects { home, state: Value::Null }),
        Err(error) => return Err(error).context("无法读取 Codex 桌面项目元数据"),
    };
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes).context("无法读取 Codex 桌面项目元数据")?;
    ensure!(bytes.len() <= 16 * 1024 * 1024, "Codex 桌面项目元数据超过大小限制");
    let state: Value = serde_json::from_slice(&bytes).context("Codex 桌面项目元数据格式无效，请稍后刷新")?;
    ensure!(state.is_object(), "Codex 桌面项目元数据格式无效");
    Ok(DesktopProjects { home, state })
}

impl DesktopProjects {
    pub fn catalog(self, native: Option<Vec<Value>>) -> Result<Value> {
        let state = self.state;
        let legacy = state["local-projects"].as_object();
        let supported = native.is_some();
        ensure!(supported || legacy.is_some(), "此版本 Codex 未提供项目列表，且未找到桌面项目数据；请升级 Codex 后刷新");
        let host_key = format!("local:{}", self.home.to_string_lossy());
        let migration = host_state(&state, &host_key, "app-server-projects-migration-by-host");
        let native_ids = host_state(&state, &host_key, "app-server-project-id-by-legacy-project-id-by-host").and_then(Value::as_object);
        let legacy_assignments = legacy.is_some() && (!supported || migration.and_then(|value| value["threadAssignmentsMigrated"].as_bool()) != Some(true));
        let mut data = Vec::new();
        if let Some(projects) = native {
            for project in projects {
                let id = project["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| anyhow!("Codex 返回了无效的项目标识"))?;
                let name = project["name"].as_str().ok_or_else(|| anyhow!("Codex 返回了无效的项目名称"))?;
                let roots = project["roots"].as_array().ok_or_else(|| anyhow!("Codex 返回了无效的项目目录"))?;
                let roots: Vec<&str> = roots.iter().map(|root| root["path"].as_str().ok_or_else(|| anyhow!("Codex 返回了无效的项目路径"))).collect::<Result<_>>()?;
                data.push(json!({"id":id,"name":name,"rootPaths":roots,"native":true}));
            }
        } else if let Some(projects) = legacy {
            let order = state["project-order"].as_array();
            let mut projects: Vec<_> = projects.iter().collect();
            projects.sort_by(|(left, _), (right, _)| {
                let position = |id: &str| order.and_then(|order| order.iter().position(|value| value.as_str() == Some(id))).unwrap_or(usize::MAX);
                position(left).cmp(&position(right)).then_with(||left.cmp(right))
            });
            for (id, project) in projects {
                let name = project["name"].as_str().ok_or_else(|| anyhow!("Codex 桌面项目名称格式无效"))?;
                let roots = project["rootPaths"].as_array().ok_or_else(|| anyhow!("Codex 桌面项目目录格式无效"))?;
                ensure!(roots.iter().all(Value::is_string), "Codex 桌面项目路径格式无效");
                data.push(json!({"id":id,"name":name,"rootPaths":roots,"native":false}));
            }
        }
        let mut aliases = HashMap::<String, String>::new();
        for project in &data {
            let id = project["id"].as_str().unwrap();
            aliases.insert(id.into(), id.into());
        }
        if let Some(projects) = legacy {
            for (legacy_id, project) in projects {
                let mapped = native_ids.and_then(|ids| ids.get(legacy_id)).and_then(Value::as_str);
                if let Some(id) = mapped.filter(|id| aliases.contains_key(*id)) {
                    aliases.insert(legacy_id.clone(), id.into());
                    continue;
                }
                // Old desktop releases may not have recorded the migration ID map.
                let roots: Vec<_> = project["rootPaths"].as_array().into_iter().flatten().filter_map(Value::as_str).map(path_key).collect();
                if roots.is_empty() { continue; }
                let matches: Vec<_> = data.iter().filter(|candidate| {
                    let candidate: Vec<_> = candidate["rootPaths"].as_array().unwrap().iter().filter_map(Value::as_str).map(path_key).collect();
                    candidate.len() == roots.len() && roots.iter().all(|root| candidate.contains(root))
                }).collect();
                if matches.len() == 1 {
                    aliases.insert(legacy_id.clone(), matches[0]["id"].as_str().unwrap().into());
                }
            }
        }
        let mut assignments = Map::new();
        if legacy_assignments {
            if let Some(values) = state["thread-project-assignments"].as_object() {
                for (thread, assignment) in values {
                    if assignment["projectKind"] != "local" { continue; }
                    if let Some(project) = assignment["projectId"].as_str() {
                        assignments.insert(thread.clone(), aliases.get(project).map(|id|json!(id)).unwrap_or(Value::Null));
                    }
                }
            }
            if let Some(values) = state["projectless-thread-ids"].as_array() {
                for thread in values.iter().filter_map(Value::as_str) { assignments.insert(thread.into(), Value::Null); }
            }
        }
        let hints: Map<String, Value> = if legacy_assignments {
            state["thread-workspace-root-hints"].as_object().into_iter().flatten()
                .filter(|(_, value)| value.is_string()).map(|(key, value)| (key.clone(), value.clone())).collect()
        } else { Map::new() };
        // Only project fields cross the Relay connection, never the full desktop state.
        Ok(json!({"data":data,"assignments":assignments,"workspaceRootHints":hints,"legacyAssignments":legacy_assignments,"nativeProjects":supported}))
    }
}
