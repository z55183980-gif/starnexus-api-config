use crate::error::{AppError, Result};
use crate::paths;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

const KEEP: usize = 10;

#[derive(Debug, Clone, Serialize)]
pub struct BackupEntry {
    pub id: String,
    pub created_at: String,
    pub has_config: bool,
    pub has_auth: bool,
    pub has_claude: bool,
}

/// 写入前先备份。这是数千用户场景下最重要的自救出口 ——
/// 出任何问题，用户点一下"恢复上一次配置"就能回去。
pub fn create() -> Result<String> {
    let root = paths::backup_root()?;
    let id = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let dir = root.join(&id);
    fs::create_dir_all(&dir)?;

    let cfg = paths::config_path()?;
    if cfg.exists() {
        fs::copy(&cfg, dir.join("config.toml"))?;
    }
    let auth = paths::auth_path()?;
    if auth.exists() {
        fs::copy(&auth, dir.join("auth.json"))?;
    }
    let claude = paths::claude_settings_path()?;
    if claude.exists() {
        fs::copy(&claude, dir.join("claude-settings.json"))?;
    }

    prune()?;
    Ok(id)
}

pub fn list() -> Result<Vec<BackupEntry>> {
    let root = paths::backup_root()?;
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut out: Vec<BackupEntry> = fs::read_dir(&root)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| {
            let p = e.path();
            let id = e.file_name().to_string_lossy().to_string();
            BackupEntry {
                created_at: format_id(&id),
                has_config: p.join("config.toml").exists(),
                has_auth: p.join("auth.json").exists(),
                has_claude: p.join("claude-settings.json").exists(),
                id,
            }
        })
        .collect();

    // 目录名是时间戳，字典序倒排就是时间倒序
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

/// 恢复某一份备份。恢复本身也走原子写，并且恢复前再备份一次当前状态 ——
/// 免得用户点错了想退回来却退不回去。
pub fn restore(id: &str) -> Result<()> {
    // 防目录穿越：id 必须是我们自己生成的时间戳格式
    if !id.chars().all(|c| c.is_ascii_digit() || c == '-') || id.is_empty() {
        return Err(AppError::Other("备份编号不合法".into()));
    }

    let dir = paths::backup_root()?.join(id);
    if !dir.is_dir() {
        return Err(AppError::Other(format!("找不到备份 {}", id)));
    }

    // 恢复前先把当前状态存一份
    let _ = create();

    let mut txn = crate::atomic::TwoFileTxn::new();

    let src_cfg = dir.join("config.toml");
    if src_cfg.exists() {
        let content = fs::read_to_string(&src_cfg)?;
        txn.write(&paths::config_path()?, &content)?;
    }

    let src_auth = dir.join("auth.json");
    if src_auth.exists() {
        let content = fs::read_to_string(&src_auth)?;
        txn.write(&paths::auth_path()?, &content)?;
    }

    let src_claude = dir.join("claude-settings.json");
    if src_claude.exists() {
        let content = fs::read_to_string(&src_claude)?;
        txn.write(&paths::claude_settings_path()?, &content)?;
    }

    txn.commit();
    Ok(())
}

fn prune() -> Result<()> {
    let mut all: Vec<PathBuf> = fs::read_dir(paths::backup_root()?)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();

    all.sort();
    if all.len() > KEEP {
        for old in &all[..all.len() - KEEP] {
            let _ = fs::remove_dir_all(old);
        }
    }
    Ok(())
}

fn format_id(id: &str) -> String {
    // 20260918-173045 -> 2026-09-18 17:30:45
    if id.len() == 15 && id.as_bytes().get(8) == Some(&b'-') {
        format!(
            "{}-{}-{} {}:{}:{}",
            &id[0..4],
            &id[4..6],
            &id[6..8],
            &id[9..11],
            &id[11..13],
            &id[13..15]
        )
    } else {
        id.to_string()
    }
}
