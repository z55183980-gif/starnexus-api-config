use crate::atomic::TwoFileTxn;
use crate::claude_config::{self, ClaudeSettings, SettingsState};
use crate::codex_auth::{self, AuthState};
use crate::codex_config::{self, AuthMode, ProviderConfig};
use crate::detect::{self, Environment};
use crate::error::{AppError, Result};
use crate::gateway::{self, SessionState};
use crate::{api, backup, paths, state};
use serde::{Deserialize, Serialize};
use std::fs;

pub const PROVIDER_ID: &str = "starnexus";
pub const DISPLAY_NAME: &str = "StarNexus";
const REMOTE_CONFIG_URL: &str = "https://api.dkby.com/api/dbkey/config";

#[tauri::command]
pub fn scan_environment(base_url: Option<String>) -> Result<Environment> {
    let openai_base = base_url.unwrap_or_else(|| api::builtin_defaults().base_url);
    let anthropic_base = claude_config::derive_anthropic_base_url(&openai_base);
    detect::scan(PROVIDER_ID, &anthropic_base)
}

#[tauri::command]
pub fn load_app_state() -> state::AppState {
    state::load()
}

/// 密钥列表。只返回元数据和掩码，完整密钥不出后端。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub name: String,
    pub masked_key: String,
    pub has_key: bool,
    pub codex_model: String,
    pub codex_effort: String,
    pub claude_model: String,
    pub gateway_token_id: Option<i64>,
}

#[tauri::command]
pub fn list_profiles() -> Vec<ProfileView> {
    state::load()
        .profiles
        .into_iter()
        .map(|p| {
            let key = state::load_profile_key(&p.id);
            ProfileView {
                masked_key: key.as_deref().map(state::mask).unwrap_or_default(),
                has_key: key.is_some(),
                id: p.id,
                name: p.name,
                codex_model: p.codex_model,
                codex_effort: p.codex_effort,
                claude_model: p.claude_model,
                gateway_token_id: p.gateway_token_id,
            }
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProfileRequest {
    /// 留空表示新建
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// 留空表示不改动已存的密钥
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub codex_model: String,
    #[serde(default)]
    pub codex_effort: String,
    #[serde(default)]
    pub claude_model: String,
}

#[tauri::command]
pub fn save_profile(req: SaveProfileRequest) -> Result<String> {
    let is_new = req.id.trim().is_empty();
    if is_new && req.api_key.trim().is_empty() {
        return Err(AppError::Other("请先填上 API Key".into()));
    }
    // 手动填了新 Key 就断开与网关令牌的关联 —— 它已经不是那把了
    let manual_key = !req.api_key.trim().is_empty();
    let keep_link = if manual_key {
        None
    } else {
        state::load()
            .profiles
            .iter()
            .find(|x| x.id == req.id)
            .and_then(|x| x.gateway_token_id)
    };

    let p = state::Profile {
        id: req.id,
        name: req.name,
        codex_model: req.codex_model,
        codex_effort: req.codex_effort,
        claude_model: req.claude_model,
        gateway_token_id: keep_link,
    };
    let key = if req.api_key.trim().is_empty() {
        None
    } else {
        Some(req.api_key.as_str())
    };
    Ok(state::upsert_profile(p, key)?.id)
}

#[tauri::command]
pub fn delete_profile(id: String) -> Result<()> {
    state::delete_profile(&id)
}

#[tauri::command]
pub async fn get_remote_config(ignore_proxy: bool) -> api::RemoteConfig {
    api::fetch_remote_config(REMOTE_CONFIG_URL, ignore_proxy).await
}

#[tauri::command]
pub async fn test_connection(
    base_url: String,
    api_key: String,
    ignore_proxy: bool,
) -> Result<api::TestResult> {
    api::list_models(&base_url, &api_key, ignore_proxy).await
}

// ——————————— 登录取 Key ———————————
//
// 登录态只活在内存里（见 gateway.rs 的说明），关掉窗口即失效。

/// 从带 /v1 的网关地址推出登录用的根地址
fn gateway_root(base_url: &str) -> String {
    let t = base_url.trim_end_matches('/');
    t.strip_suffix("/v1").unwrap_or(t).to_string()
}

#[tauri::command]
pub async fn gateway_login(
    sessions: tauri::State<'_, SessionState>,
    base_url: String,
    username: String,
    password: String,
    ignore_proxy: bool,
) -> Result<String> {
    let s = sessions.get_or_init(ignore_proxy)?;
    gateway::login(&s, &gateway_root(&base_url), &username, &password).await
}

#[tauri::command]
pub fn gateway_current_user(sessions: tauri::State<'_, SessionState>) -> Option<String> {
    sessions
        .get_or_init(false)
        .ok()
        .and_then(|s| s.current_user())
}

#[tauri::command]
pub fn gateway_logout(sessions: tauri::State<'_, SessionState>) {
    if let Ok(s) = sessions.get_or_init(false) {
        gateway::logout(&s);
    }
    sessions.reset();
}

/// 给界面看的一把 Key：在网关的信息 + 本地是否已经关联过
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenView {
    pub id: i64,
    pub name: String,
    pub usable: bool,
    pub note: String,
    /// 已经导入过就是本地那条的名字，界面据此显示「更新」而不是勾选
    pub linked_profile: Option<String>,
}

#[tauri::command]
pub async fn gateway_list_tokens(
    sessions: tauri::State<'_, SessionState>,
) -> Result<Vec<TokenView>> {
    let s = sessions.get_or_init(false)?;
    let list = gateway::list_tokens(&s).await?;
    Ok(list
        .into_iter()
        .map(|t| TokenView {
            linked_profile: state::find_by_token_id(t.id).map(|p| p.name),
            id: t.id,
            name: t.name,
            usable: t.usable,
            note: t.note,
        })
        .collect())
}

/// 取回某把 Key 的明文，直接存进指定的密钥库条目。
/// 明文只在后端停留，不返回给前端。
#[tauri::command]
pub async fn gateway_adopt_token(
    sessions: tauri::State<'_, SessionState>,
    profile_id: String,
    token_id: i64,
) -> Result<String> {
    let s = sessions.get_or_init(false)?;
    let key = gateway::fetch_key(&s, token_id).await?;
    if profile_id.trim().is_empty() {
        return Err(AppError::Other("请先选择要存到哪一条".into()));
    }
    state::save_profile_key(&profile_id, &key);
    if let Some(mut p) = state::load().profiles.into_iter().find(|p| p.id == profile_id) {
        p.gateway_token_id = Some(token_id);
        let _ = state::upsert_profile(p, None);
    }
    Ok(state::mask(&key))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub created: Vec<String>,
    /// 已关联过，值换成了最新的
    pub updated: Vec<String>,
    /// 已关联且密钥没变，什么都没做
    pub unchanged: Vec<String>,
    pub skipped: Vec<String>,
}

/// 一次登录批量导入多把 Key：每把存成一条，名字沿用 Key 的名字。
/// 明文只在后端停留，直接进系统密钥库。
#[tauri::command]
pub async fn gateway_import_tokens(
    sessions: tauri::State<'_, SessionState>,
    token_ids: Vec<i64>,
) -> Result<ImportResult> {
    if token_ids.is_empty() {
        return Err(AppError::Other("请先勾选要导入的 Key".into()));
    }
    let s = sessions.get_or_init(false)?;
    let all = gateway::list_tokens(&s).await?;

    let mut out = ImportResult {
        created: Vec::new(),
        updated: Vec::new(),
        unchanged: Vec::new(),
        skipped: Vec::new(),
    };

    for id in token_ids {
        let Some(t) = all.iter().find(|t| t.id == id) else {
            continue;
        };
        let key = match gateway::fetch_key(&s, id).await {
            Ok(k) => k,
            Err(_) => {
                out.skipped.push(t.name.clone());
                continue;
            }
        };

        // 这把 Key 之前导过：就地换成最新的值，不重复新建。
        // 服务端重置 Key 后，用户点一次「更新」就恢复可用。
        if let Some(mut existing) = state::find_by_token_id(id) {
            let unchanged = state::load_profile_key(&existing.id).as_deref() == Some(key.as_str());
            existing.gateway_token_id = Some(id);
            match state::upsert_profile(existing.clone(), Some(&key)) {
                Ok(_) => {
                    if unchanged {
                        out.unchanged.push(existing.name);
                    } else {
                        out.updated.push(existing.name);
                    }
                }
                Err(_) => out.skipped.push(t.name.clone()),
            }
            continue;
        }

        let st = state::load();
        // 名字撞了就在后面加个序号，别让用户看到两个同名条目
        let mut name = t.name.clone();
        let mut n = 2;
        while st.profiles.iter().any(|p| p.name == name) {
            name = format!("{} {}", t.name, n);
            n += 1;
        }

        let profile = state::Profile {
            id: String::new(),
            name: name.clone(),
            codex_model: String::new(),
            codex_effort: String::new(),
            claude_model: String::new(),
            gateway_token_id: Some(id),
        };
        match state::upsert_profile(profile, Some(&key)) {
            Ok(_) => out.created.push(name),
            Err(_) => out.skipped.push(t.name.clone()),
        }
    }

    Ok(out)
}

/// 用某把已保存的 Key 去查可用模型。
/// 密钥从系统密钥库取，不经过前端 —— 用户不用为了刷新列表再粘一遍 Key。
#[tauri::command]
pub async fn test_profile_connection(
    profile_id: String,
    base_url: String,
    ignore_proxy: bool,
) -> Result<api::TestResult> {
    let key = state::load_profile_key(&profile_id)
        .ok_or_else(|| AppError::Other("这一条还没填 API Key".into()))?;
    api::list_models(&base_url, &key, ignore_proxy).await
}

#[tauri::command]
pub fn list_backups() -> Result<Vec<backup::BackupEntry>> {
    backup::list()
}

#[tauri::command]
pub fn restore_backup(id: String) -> Result<()> {
    backup::restore(&id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    /// 要启用哪一把
    pub profile_id: String,
    /// 带 /v1 的网关地址，Codex 用。Claude Code 的地址由它推导。
    pub base_url: String,
    pub wire_api: String,
    pub ignore_proxy: bool,

    // —— Codex ——
    pub configure_codex: bool,
    pub model: String,
    pub reasoning_effort: String,
    pub cleanup_residue: bool,
    /// 用户明确勾选了「同时写入 auth.json（会覆盖官方登录）」
    pub overwrite_official_auth: bool,
    /// 保守模式：不写 experimental_bearer_token，退回老版本能认的写法
    pub conservative: bool,

    // —— Claude Code ——
    pub configure_claude: bool,
    pub claude_model: String,
    pub claude_opus_model: String,
    pub claude_sonnet_model: String,
    pub claude_haiku_model: String,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub backup_id: String,
    pub wrote_codex_config: bool,
    pub wrote_codex_auth: bool,
    pub wrote_claude_settings: bool,
    pub paths: Vec<String>,
    pub warnings: Vec<String>,
}

/// 一键配置。整个工具的主流程。
///
/// Codex 和 Claude Code 在同一个事务里写 —— 任何一个失败就全部还原，
/// 不留"一半配好一半没配"的中间态。
#[tauri::command]
pub fn apply_config(req: ApplyRequest) -> Result<ApplyResult> {
    let mut out = ApplyResult::default();

    let api_key = state::load_profile_key(&req.profile_id)
        .ok_or_else(|| AppError::Other("这一条还没填 API Key".into()))?;
    if !req.configure_codex && !req.configure_claude {
        return Err(AppError::Other("请先选择要配置哪个工具".into()));
    }

    let openai_base = req.base_url.trim_end_matches('/').to_string();
    let anthropic_base = claude_config::derive_anthropic_base_url(&openai_base);

    // ——— 先把所有校验做完，再动任何一个文件 ———

    let codex_cfg_path = paths::config_path()?;
    let codex_auth_path = paths::auth_path()?;
    let claude_path = paths::claude_settings_path()?;

    let existing_codex = if req.configure_codex {
        let t = fs::read_to_string(&codex_cfg_path).unwrap_or_default();
        // 硬规则：解析不了就绝不写入。宁可让用户手动修，也不能覆盖他的东西。
        if !t.trim().is_empty() {
            if let Err(e) = codex_config::parse(&t) {
                return Err(AppError::TomlParse(format!(
                    "{}。你的原文件没有被改动，可以自己修好它，或者用「备份原文件，重新生成」",
                    e
                )));
            }
        }
        Some(t)
    } else {
        None
    };

    let existing_claude = if req.configure_claude {
        let t = fs::read_to_string(&claude_path).ok();
        if let SettingsState::Broken(e) = claude_config::inspect(t.as_deref()) {
            return Err(AppError::JsonParse(format!(
                "Claude Code 的配置文件有格式问题：{}。你的原文件没有被改动，请先修好它",
                e
            )));
        }
        Some(t)
    } else {
        None
    };

    // 目录不存在就建，但要告诉用户
    if req.configure_codex {
        let home = paths::codex_home()?;
        if !home.is_dir() {
            fs::create_dir_all(&home).map_err(|e| {
                AppError::CodexHomeMissing(format!("{}（创建失败：{}）", home.display(), e))
            })?;
            out.warnings
                .push(format!("没找到 Codex 的设置文件夹，已经帮你建好：{}", home.display()));
        }
    }
    if req.configure_claude {
        let home = paths::claude_home()?;
        if !home.is_dir() {
            fs::create_dir_all(&home).map_err(|e| {
                AppError::Other(format!("创建 {} 失败：{}", home.display(), e))
            })?;
            out.warnings
                .push(format!("没找到 Claude Code 的设置文件夹，已经帮你建好：{}", home.display()));
        }
    }

    // ——— 校验都过了，先备份再动手 ———
    out.backup_id = backup::create()?;
    let mut txn = TwoFileTxn::new();

    // ——— Codex ———
    if let Some(existing) = existing_codex {
        let auth_text = fs::read_to_string(&codex_auth_path).ok();
        let auth_state = codex_auth::inspect(auth_text.as_deref());

        // 默认用手动配置多年通行的写法（内置 openai + auth.json），实测可用。
        // 只有在必须保住官方 ChatGPT 登录、或 auth.json 坏了动不得时，
        // 才改走自定义 provider 段把密钥放配置里。
        let keep_official =
            auth_state == AuthState::OfficialLogin && !req.overwrite_official_auth;
        let auth_mode = if keep_official || auth_state == AuthState::Unparsable {
            AuthMode::BearerToken
        } else {
            AuthMode::OpenAiBuiltin
        };

        let provider = ProviderConfig {
            provider_id: PROVIDER_ID.into(),
            display_name: DISPLAY_NAME.into(),
            base_url: openai_base.clone(),
            wire_api: req.wire_api.clone(),
            model: req.model.clone(),
            reasoning_effort: req.reasoning_effort.clone(),
            api_key: api_key.clone(),
            auth_mode,
        };

        let new_cfg = codex_config::apply(&existing, &provider, req.cleanup_residue)?;
        txn.write(&codex_cfg_path, &new_cfg)?;
        out.wrote_codex_config = true;
        out.paths.push(codex_cfg_path.to_string_lossy().to_string());

        match auth_state {
            AuthState::OfficialLogin if keep_official => {
                out.warnings
                    .push("已经帮你保住了 ChatGPT 官方登录，以后随时能切回去".into());
            }
            AuthState::OfficialLogin => {
                out.warnings
                    .push("按你的选择，已经退出了 ChatGPT 官方登录".into());
            }
            AuthState::Unparsable => {
                out.warnings
                    .push("登录信息文件有格式问题，没有改动它，密钥已改放在配置文件里".into());
            }
            _ => {}
        }

        if auth_mode == AuthMode::OpenAiBuiltin {
            let merged = codex_auth::merge_api_key(auth_text.as_deref(), &api_key)?;
            txn.write(&codex_auth_path, &merged)?;
            out.wrote_codex_auth = true;
            out.paths
                .push(codex_auth_path.to_string_lossy().to_string());
        }
    }

    // ——— Claude Code ———
    if let Some(existing) = existing_claude {
        let settings = ClaudeSettings {
            base_url: anthropic_base.clone(),
            auth_token: api_key.clone(),
            model: req.claude_model.clone(),
            opus_model: req.claude_opus_model.clone(),
            sonnet_model: req.claude_sonnet_model.clone(),
            haiku_model: req.claude_haiku_model.clone(),
        };
        let merged = claude_config::merge(existing.as_deref(), &settings)?;
        txn.write(&claude_path, &merged)?;
        out.wrote_claude_settings = true;
        out.paths.push(claude_path.to_string_lossy().to_string());
    }

    txn.commit();

    // 模型偏好跟着密钥走，全局只记这几项
    let mut st = state::load();
    st.ignore_proxy = req.ignore_proxy;
    st.cleanup_residue = req.cleanup_residue;
    st.last_configured_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    if let Some(prof) = st.profiles.iter_mut().find(|x| x.id == req.profile_id) {
        if req.configure_codex {
            prof.codex_model = req.model.clone();
            prof.codex_effort = req.reasoning_effort.clone();
        }
        if req.configure_claude {
            prof.claude_model = req.claude_model.clone();
        }
    }
    let _ = state::save(&st);

    Ok(out)
}

/// 把两个工具都切回官方，并清掉我们写进去的密钥
#[tauri::command]
pub fn revert_to_official(codex: bool, claude: bool) -> Result<String> {
    let backup_id = backup::create()?;
    let mut txn = TwoFileTxn::new();

    if codex {
        let cfg_path = paths::config_path()?;
        if let Ok(existing) = fs::read_to_string(&cfg_path) {
            codex_config::parse(&existing)?;
            let new_cfg = codex_config::revert_to_official(&existing, PROVIDER_ID)?;
            txn.write(&cfg_path, &new_cfg)?;

            // 只有在没有官方登录的情况下才动 auth.json
            let auth_path = paths::auth_path()?;
            let auth_text = fs::read_to_string(&auth_path).ok();
            if codex_auth::inspect(auth_text.as_deref()) == AuthState::ApiKeyOnly {
                if let Some(stripped) = codex_auth::strip_api_key(auth_text.as_deref())? {
                    txn.write(&auth_path, &stripped)?;
                }
            }
        }
    }

    if claude {
        let claude_path = paths::claude_settings_path()?;
        let text = fs::read_to_string(&claude_path).ok();
        if let SettingsState::Ok = claude_config::inspect(text.as_deref()) {
            if let Some(reverted) = claude_config::revert(text.as_deref())? {
                txn.write(&claude_path, &reverted)?;
            }
        }
    }

    txn.commit();
    Ok(backup_id)
}

/// config.toml 坏到没法解析时的最后出路：备份后重建一份最小可用配置
#[tauri::command]
pub fn rebuild_minimal_config(req: ApplyRequest) -> Result<ApplyResult> {
    let api_key = state::load_profile_key(&req.profile_id)
        .ok_or_else(|| AppError::Other("这一条还没填 API Key".into()))?;

    let mut out = ApplyResult {
        backup_id: backup::create()?,
        warnings: vec!["已经重新生成了一份干净的配置，原文件在备份里".into()],
        ..Default::default()
    };

    let cfg_path = paths::config_path()?;
    let provider = ProviderConfig {
        provider_id: PROVIDER_ID.into(),
        display_name: DISPLAY_NAME.into(),
        base_url: req.base_url.trim_end_matches('/').to_string(),
        wire_api: req.wire_api,
        model: req.model,
        reasoning_effort: req.reasoning_effort,
        api_key: api_key.clone(),
        auth_mode: AuthMode::OpenAiBuiltin,
    };

    // 从空文档重建，原文件已经在备份里
    let new_cfg = codex_config::apply("", &provider, false)?;

    let mut txn = TwoFileTxn::new();
    txn.write(&cfg_path, &new_cfg)?;
    out.wrote_codex_config = true;
    out.paths.push(cfg_path.to_string_lossy().to_string());

    let auth_path = paths::auth_path()?;
    let auth_text = fs::read_to_string(&auth_path).ok();
    if codex_auth::inspect(auth_text.as_deref()) != AuthState::OfficialLogin {
        let merged = codex_auth::merge_api_key(auth_text.as_deref(), &api_key)?;
        txn.write(&auth_path, &merged)?;
        out.wrote_codex_auth = true;
        out.paths.push(auth_path.to_string_lossy().to_string());
    }
    txn.commit();
    Ok(out)
}
