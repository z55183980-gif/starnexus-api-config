use crate::claude_config::{self, SettingsState};
use crate::codex_auth::{self, AuthState};
use crate::codex_config;
use crate::error::Result;
use crate::paths;
use serde::Serialize;
use std::fs;

/// config.toml 的健康状况。
/// 解析不了的时候绝不能写入 —— 宁可让用户手动修，也不能覆盖掉他的东西。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigState {
    Missing,
    Ok,
    /// 存在但 TOML 语法有误，附带错误信息
    Broken(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexEnv {
    /// Codex 目录是否存在
    pub home_exists: bool,
    pub home: String,
    pub config_state: ConfigState,
    pub auth_state: AuthState,
    /// 当前 config.toml 指向的 base_url
    pub current_base_url: Option<String>,
    pub current_model: Option<String>,
    /// 用户可能手改过推理强度，界面要回填而不是用默认值盖掉
    pub current_reasoning_effort: Option<String>,
    /// 旧脚本留下的内伤清单
    pub residue: Vec<String>,
    /// 是否已经由本工具配置过
    pub managed_by_us: bool,
    /// 当前生效的是哪一把（能和已保存的某把 Key 对上时才有值）
    pub active_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeEnv {
    pub home_exists: bool,
    pub home: String,
    pub settings_state: SettingsState,
    pub current_base_url: Option<String>,
    pub current_model: Option<String>,
    pub managed_by_us: bool,
    pub active_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub codex: CodexEnv,
    pub claude: ClaudeEnv,
}

pub fn scan(provider_id: &str, anthropic_base_url: &str) -> Result<Environment> {
    Ok(Environment {
        codex: scan_codex(provider_id)?,
        claude: scan_claude(anthropic_base_url)?,
    })
}

fn scan_codex(provider_id: &str) -> Result<CodexEnv> {
    let home = paths::codex_home()?;
    let home_exists = home.is_dir();

    let cfg_text = fs::read_to_string(paths::config_path()?).ok();

    let config_state = match &cfg_text {
        None => ConfigState::Missing,
        Some(t) => match codex_config::parse(t) {
            Ok(_) => ConfigState::Ok,
            Err(e) => ConfigState::Broken(e.to_string()),
        },
    };

    let auth_text = fs::read_to_string(paths::auth_path()?).ok();
    let auth_state = codex_auth::inspect(auth_text.as_deref());

    let (current_base_url, current_model, current_reasoning_effort, residue) = match &cfg_text {
        Some(t) if matches!(config_state, ConfigState::Ok) => (
            codex_config::current_pointing(t),
            codex_config::current_model(t),
            codex_config::current_reasoning_effort(t),
            codex_config::detect_residue(t),
        ),
        _ => (None, None, None, Vec::new()),
    };

    // 密钥可能在 auth.json，也可能在 provider 段里
    let live_key = codex_auth::current_api_key(auth_text.as_deref()).or_else(|| {
        cfg_text
            .as_deref()
            .and_then(|t| codex_config::current_bearer_token(t, provider_id))
    });
    let active_profile_id = crate::state::match_profile(live_key.as_deref());
    // "是不是我们配的"就看配置里那把密钥能不能对上已保存的某一把。
    // 早先是看有没有 [model_providers.starnexus] 段，但默认写法已经不写那个段了，
    // 那个判据会让程序认不出自己刚写的配置。
    let managed_by_us = active_profile_id.is_some();

    Ok(CodexEnv {
        home_exists,
        home: home.to_string_lossy().to_string(),
        config_state,
        auth_state,
        current_base_url,
        current_model,
        current_reasoning_effort,
        residue,
        managed_by_us,
        active_profile_id,
    })
}

fn scan_claude(anthropic_base_url: &str) -> Result<ClaudeEnv> {
    let home = paths::claude_home()?;
    let home_exists = home.is_dir();

    let text = fs::read_to_string(paths::claude_settings_path()?).ok();
    let settings_state = claude_config::inspect(text.as_deref());

    let (current_base_url, current_model) = match (&text, &settings_state) {
        (Some(t), SettingsState::Ok) => (
            claude_config::current_base_url(t),
            claude_config::current_model(t),
        ),
        _ => (None, None),
    };

    let active_profile_id = crate::state::match_profile(
        text.as_deref()
            .and_then(claude_config::current_auth_token)
            .as_deref(),
    );
    let managed_by_us = active_profile_id.is_some()
        && current_base_url
            .as_deref()
            .map(|u| u.trim_end_matches('/') == anthropic_base_url.trim_end_matches('/'))
            .unwrap_or(false);

    Ok(ClaudeEnv {
        home_exists,
        home: home.to_string_lossy().to_string(),
        settings_state,
        current_base_url,
        current_model,
        managed_by_us,
        active_profile_id,
    })
}
