//! Read custom slash prompts from the execution host's Codex home.
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::io::Read;

pub fn list() -> Result<Value> {
    let home = crate::discovery::codex_home()?;
    let entries = match std::fs::read_dir(home.join("prompts")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"data":[],"errors":[]})),
        Err(error) => return Err(error).context("无法读取自定义命令目录"),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("md")) && path.is_file() {
            ensure!(paths.len() < 256, "自定义命令超过 256 个，请减少后重试");
            paths.push(path);
        }
    }
    paths.sort();
    let mut data = Vec::new();
    let mut errors = Vec::new();
    let mut total = 0;
    for path in paths {
        let name = path.file_stem().and_then(|name| name.to_str()).unwrap_or_default();
        if name.is_empty() || name.contains(char::is_whitespace) || name.contains('/') || name.contains('\\') { continue; }
        let result: Result<Value> = (|| {
            let mut bytes = Vec::new();
            std::fs::File::open(&path)?.take(128 * 1024 + 1).read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 128 * 1024, "命令内容超过 128 KiB");
            total += bytes.len();
            ensure!(total <= 2 * 1024 * 1024, "自定义命令总大小超过 2 MiB");
            let text = String::from_utf8(bytes).context("命令必须采用 UTF-8 编码")?;
            let normalized = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
            let mut content = normalized.as_str();
            let mut description = String::new();
            let mut argument_hint = String::new();
            if let Some(frontmatter) = content.strip_prefix("---\n") {
                if let Some(end) = frontmatter.find("\n---\n") {
                    for line in frontmatter[..end].lines() {
                        if let Some((key, value)) = line.split_once(':') {
                            let value = value.trim().trim_matches(|character| character == '"' || character == '\'');
                            match key.trim() {
                                "description" => description = value.into(),
                                "argument-hint" => argument_hint = value.into(),
                                _ => {}
                            }
                        }
                    }
                    content = &frontmatter[end + 5..];
                }
            }
            Ok(json!({"name":name,"description":description,"argumentHint":argument_hint,"content":content}))
        })();
        match result { Ok(prompt) => data.push(prompt), Err(error) => errors.push(format!("{name}：{error:#}")) }
        if total > 2 * 1024 * 1024 { break; }
    }
    Ok(json!({"data":data,"errors":errors}))
}
