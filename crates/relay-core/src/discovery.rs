//! Locate installed Codex entry points without launching processes or scanning whole drives.
use anyhow::{anyhow, ensure, Context, Result};
use serde::Serialize;
use std::{collections::HashSet, ffi::OsString, path::{Path, PathBuf}, time::SystemTime};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInstallation {
    pub path: PathBuf,
    pub source: String,
}

struct Candidate {
    path: PathBuf,
    source: &'static str,
}

pub fn discover(configured: &str) -> Result<PathBuf> {
    Ok(detect(configured)?.path)
}

pub fn detect(configured: &str) -> Result<CodexInstallation> {
    if !configured.trim().is_empty() {
        let path = PathBuf::from(configured.trim().trim_matches('"'));
        ensure!(path.is_absolute() && path.is_file(), "指定的 Codex 路径无效");
        if has_extension(&path, "cmd") || has_extension(&path, "bat") || has_extension(&path, "ps1") {
            let mut candidates = Vec::new();
            add_npm(&mut candidates, path.parent().unwrap_or(Path::new("")), "手动指定的 npm 安装");
            return select(candidates).ok_or_else(||anyhow!("此启动脚本旁未找到 Codex，请选择 codex.exe 或 codex.js"));
        }
        ensure!(has_extension(&path, "exe") || has_extension(&path, "js") || (!cfg!(windows) && path.extension().is_none()), "请选择 codex.exe、codex.js 或 Codex 启动脚本");
        return Ok(CodexInstallation { path, source: "手动指定".into() });
    }

    let mut candidates = Vec::new();
    for directory in search_paths() {
        add_bin(&mut candidates, &directory, "PATH");
        add_npm(&mut candidates, &directory, "npm / PATH");
    }

    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let openai = local.join("OpenAI/Codex");
        add_bin(&mut candidates, &openai.join("bin"), "Codex 本机安装");
        for version in recent_directories(&openai.join("bin"), None) {
            add_bin(&mut candidates, &version, "Codex 本机安装");
        }
        add_bin(&mut candidates, &openai.join("resources"), "Codex 桌面应用");
        add_bin(&mut candidates, &local.join("Programs/Codex/resources"), "Codex 桌面应用");
        add_bin(&mut candidates, &local.join("Microsoft/WinGet/Links"), "WinGet");
        add_npm(&mut candidates, &local.join("pnpm"), "pnpm");
        add_bin(&mut candidates, &local.join("pnpm/bin"), "pnpm");
    }
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        add_npm(&mut candidates, &appdata.join("npm"), "npm 全局安装");
    }
    for name in ["NVM_SYMLINK", "PNPM_HOME", "NPM_CONFIG_PREFIX", "npm_config_prefix"] {
        if let Some(root) = std::env::var_os(name).map(PathBuf::from) {
            add_bin(&mut candidates, &root, "Node.js 版本管理器");
            add_npm(&mut candidates, &root, "Node.js 版本管理器");
        }
    }
    if let Some(root) = std::env::var_os("NVM_HOME").map(PathBuf::from) {
        for version in recent_directories(&root, Some("v")) {
            add_npm(&mut candidates, &version, "nvm");
        }
    }
    if let Some(root) = std::env::var_os("VOLTA_HOME").map(PathBuf::from) {
        for version in recent_directories(&root.join("tools/image/packages/@openai/codex"), None) {
            add_npm(&mut candidates, &version, "Volta");
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(||std::env::var_os("HOME")).map(PathBuf::from) {
        for path in [".cargo/bin", ".local/bin", "scoop/shims", "scoop/apps/codex/current", "scoop/apps/codex/current/bin"] {
            add_bin(&mut candidates, &home.join(path), "用户安装");
        }
        for path in [".npm-global", ".local", ".volta/tools/image/packages/@openai/codex"] {
            add_npm(&mut candidates, &home.join(path), "npm 用户安装");
        }
        // Only the official extension's CLI entry point is used, never the editor executable.
        for editor in [".vscode", ".vscode-insiders", ".cursor", ".windsurf"] {
            for extension in recent_directories(&home.join(editor).join("extensions"), Some("openai.chatgpt-")) {
                let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
                    ("windows", "aarch64") => "windows-aarch64",
                    ("windows", _) => "windows-x86_64",
                    ("macos", "aarch64") => "macos-aarch64",
                    ("macos", _) => "macos-x86_64",
                    (_, "aarch64") => "linux-aarch64",
                    _ => "linux-x86_64",
                };
                add_bin(&mut candidates, &extension.join("bin").join(platform), "Codex 编辑器扩展");
            }
        }
    }
    select(candidates).ok_or_else(||anyhow!("未找到 Codex。请先安装 Codex，或选择 codex.exe、codex.js 及 npm 启动脚本"))
}

fn has_extension(path: &Path, expected: &str) -> bool {
    path.extension().is_some_and(|v|v.to_string_lossy().eq_ignore_ascii_case(expected))
}

fn add_bin(candidates: &mut Vec<Candidate>, directory: &Path, source: &'static str) {
    candidates.push(Candidate { path: directory.join(if cfg!(windows) {"codex.exe"} else {"codex"}), source });
}

fn add_npm(candidates: &mut Vec<Candidate>, prefix: &Path, source: &'static str) {
    for package in [prefix.join("node_modules/@openai/codex"), prefix.join("lib/node_modules/@openai/codex")] {
        // Prefer the real native binary, so a desktop-launched process need not find Node.js.
        let target = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "aarch64") => "aarch64-pc-windows-msvc",
            ("windows", _) => "x86_64-pc-windows-msvc",
            ("macos", "aarch64") => "aarch64-apple-darwin",
            ("macos", _) => "x86_64-apple-darwin",
            (_, "aarch64") => "aarch64-unknown-linux-musl",
            _ => "x86_64-unknown-linux-musl",
        };
        let binary = if cfg!(windows) {"codex.exe"} else {"codex"};
        candidates.push(Candidate { path:package.join("vendor").join(target).join("codex").join(binary), source });
        let suffix = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "aarch64") => "win32-arm64",
            ("windows", _) => "win32-x64",
            ("macos", "aarch64") => "darwin-arm64",
            ("macos", _) => "darwin-x64",
            (_, "aarch64") => "linux-arm64",
            _ => "linux-x64",
        };
        // Both hoisted npm optional packages and package-local optional packages.
        for scope in [package.parent().unwrap_or(&package).to_path_buf(), package.join("node_modules/@openai")] {
            candidates.push(Candidate { path:scope.join(format!("codex-{suffix}")).join("vendor").join(target).join("codex").join(binary), source });
        }
        candidates.push(Candidate { path:package.join("bin/codex.js"), source });
    }
}

fn select(candidates: Vec<Candidate>) -> Option<CodexInstallation> {
    let mut seen = HashSet::new();
    candidates.into_iter().filter(|candidate| {
        let key = candidate.path.to_string_lossy().into_owned();
        seen.insert(if cfg!(windows) { key.to_lowercase() } else { key })
    }).find(|candidate|candidate.path.is_absolute() && candidate.path.is_file())
      .map(|candidate|CodexInstallation {path:candidate.path,source:candidate.source.into()})
}

fn recent_directories(root: &Path, prefix: Option<&str>) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut entries: Vec<_> = entries.filter_map(|entry| {
        let entry = entry.ok()?;
        if !entry.file_type().ok()?.is_dir() { return None; }
        if prefix.is_some_and(|prefix|!entry.file_name().to_string_lossy().starts_with(prefix)) { return None; }
        let modified = entry.metadata().and_then(|m|m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        Some((entry.path(),modified))
    }).collect();
    entries.sort_by(|a,b|b.1.cmp(&a.1).then_with(||b.0.cmp(&a.0)));
    entries.into_iter().take(64).map(|(path,_)|path).collect()
}

/// Include persisted Windows PATH values: Explorer-launched apps can inherit a stale PATH.
pub fn search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(value) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&value)); }
    #[cfg(windows)]
    for (hive, key) in [
        (winreg::enums::HKEY_CURRENT_USER, "Environment"),
        (winreg::enums::HKEY_LOCAL_MACHINE, "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    ] {
        if let Ok(key) = winreg::RegKey::predef(hive).open_subkey(key) {
            if let Ok(value) = key.get_value::<String, _>("Path") {
                paths.extend(std::env::split_paths(&expand_environment(&value)));
            }
        }
    }
    paths
}

/// Preserve PATH precedence and append tools bundled with the selected Codex installation.
pub fn command_path(executable: &Path) -> Result<OsString> {
    let mut paths = search_paths();
    let rg = if cfg!(windows) { "rg.exe" } else { "rg" };
    if let Some(directory) = executable.parent() {
        let mut bundled = vec![directory.join("codex-path"), directory.to_path_buf()];
        // Native npm packages keep helper binaries next to the codex directory.
        if let Some(parent) = directory.parent() {
            if directory.file_name().is_some_and(|name| name == "codex") {
                bundled.push(parent.join("path"));
            }
        }
        paths.extend(bundled.into_iter().filter(|path| path.is_absolute() && path.join(rg).is_file()));
    }
    let mut seen = HashSet::new();
    paths.retain(|path| {
        let key = path.as_os_str().to_os_string();
        let key = if cfg!(windows) { OsString::from(key.to_string_lossy().to_lowercase()) } else { key };
        seen.insert(key)
    });
    std::env::join_paths(paths).context("无法为 Codex 配置命令搜索路径，请检查 PATH 中是否包含无效字符")
}

#[cfg(windows)]
fn expand_environment(value: &str) -> String {
    let mut result = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let tail = &rest[start + 1..];
        let Some(end) = tail.find('%') else { result.push_str(&rest[start..]); return result };
        let variable = &tail[..end];
        match std::env::var(variable) {
            Ok(value) => result.push_str(&value),
            Err(_) => { result.push('%'); result.push_str(variable); result.push('%'); }
        }
        rest = &tail[end + 1..];
    }
    result.push_str(rest);
    result
}

pub fn node_executable() -> Result<PathBuf> {
    let name = if cfg!(windows) {"node.exe"} else {"node"};
    search_paths().into_iter().map(|path|path.join(name)).find(|path|path.is_absolute() && path.is_file())
        .ok_or_else(||anyhow!("已找到 codex.js，但未找到 Node.js。请安装 Node.js，或手动选择原生 codex.exe"))
}
