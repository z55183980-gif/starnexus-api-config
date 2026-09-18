use crate::error::{AppError, Result};
use crate::paths;
use serde::{Deserialize, Serialize};
use std::fs;

const KEYRING_SERVICE: &str = "com.starnexus.dbkey";
/// 旧版只存一把 key 时用的条目名，用于一次性迁移
const LEGACY_KEYRING_USER: &str = "api_key";

/// 一把密钥的配置。用户可能有多把 Key（主号/测试号、不同套餐），
/// 每把各自记住自己的模型偏好 —— 因为不同套餐能用的模型本来就不一样。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub codex_model: String,
    #[serde(default)]
    pub codex_effort: String,
    #[serde(default)]
    pub claude_model: String,
    /// 这把 Key 来自网关的哪个令牌。
    /// 有了它，登录导入时才能认出"这把已经导过"，从而变成更新而不是重复新建。
    #[serde(default)]
    pub gateway_token_id: Option<i64>,
}

/// 本工具自己的状态。注意：API Key 不在这里 —— 每把 key 各自进系统密钥库。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub ignore_proxy: bool,
    #[serde(default)]
    pub cleanup_residue: bool,
    #[serde(default)]
    pub last_configured_at: String,
}

pub fn load() -> AppState {
    let Ok(p) = paths::state_path() else {
        return AppState::default();
    };
    let mut st: AppState = fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // 从旧版本升上来：把那唯一一把 key 变成第一条，用户无感
    if st.profiles.is_empty() {
        if let Some(legacy) = load_legacy_key() {
            let p = Profile {
                id: new_id(),
                name: "我的密钥".into(),
                codex_model: String::new(),
                codex_effort: String::new(),
                claude_model: String::new(),
                gateway_token_id: None,
            };
            save_profile_key(&p.id, &legacy);
            clear_legacy_key();
            st.profiles.push(p);
            let _ = save(&st);
        }
    }
    st
}

pub fn save(s: &AppState) -> Result<()> {
    let dir = paths::app_dir()?;
    fs::create_dir_all(&dir)?;
    let text = serde_json::to_string_pretty(s)?;
    crate::atomic::write_atomic(&paths::state_path()?, &text)
}

/// 条目 id。用时间戳加进程号，够用且不引入额外依赖。
pub fn new_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("p{:x}{:x}", ms, std::process::id())
}

fn keyring_user(profile_id: &str) -> String {
    format!("profile-{}", profile_id)
}

/// 每把 Key 各存一条系统密钥库记录（Windows DPAPI / macOS Keychain），
/// 绝不明文落盘。密钥库不可用时静默跳过 —— 记不住只是不方便，不该让工具用不了。
pub fn save_profile_key(profile_id: &str, key: &str) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, &keyring_user(profile_id)) {
        let _ = e.set_password(key);
    }
}

pub fn load_profile_key(profile_id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, &keyring_user(profile_id))
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|k| !k.trim().is_empty())
}

pub fn delete_profile_key(profile_id: &str) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, &keyring_user(profile_id)) {
        let _ = e.delete_credential();
    }
}

fn load_legacy_key() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, LEGACY_KEYRING_USER)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|k| !k.trim().is_empty())
}

fn clear_legacy_key() {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, LEGACY_KEYRING_USER) {
        let _ = e.delete_credential();
    }
}

/// 取一个没被占用的默认名。
/// 不能用「个数+1」：删掉中间某个后再新建会和现存的重名。
pub fn next_default_name(profiles: &[Profile]) -> String {
    for n in 1.. {
        let candidate = format!("密钥 {}", n);
        if !profiles.iter().any(|p| p.name == candidate) {
            return candidate;
        }
    }
    unreachable!()
}

/// 新增或更新一条。key 传 None 表示不改动已存的 key。
pub fn upsert_profile(mut p: Profile, key: Option<&str>) -> Result<Profile> {
    let mut st = load();

    let is_new = p.id.trim().is_empty();
    if is_new {
        p.id = new_id();
    }

    if p.name.trim().is_empty() {
        p.name = if is_new {
            next_default_name(&st.profiles)
        } else {
            // 改已有条目时把名字清空了，多半不是想改名 —— 保留原来的
            st.profiles
                .iter()
                .find(|x| x.id == p.id)
                .map(|x| x.name.clone())
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| next_default_name(&st.profiles))
        };
    }

    if let Some(k) = key {
        let k = k.trim();
        if !k.is_empty() {
            save_profile_key(&p.id, k);
        }
    }

    // 手动改过 Key 就不再算作来自某个网关令牌，避免之后误判成"已关联"
    if p.gateway_token_id.is_none() {
        if let Some(old) = st.profiles.iter().find(|x| x.id == p.id) {
            if key.is_none() {
                p.gateway_token_id = old.gateway_token_id;
            }
        }
    }

    match st.profiles.iter_mut().find(|x| x.id == p.id) {
        Some(existing) => *existing = p.clone(),
        None => st.profiles.push(p.clone()),
    }
    save(&st)?;
    Ok(p)
}

pub fn delete_profile(id: &str) -> Result<()> {
    let mut st = load();
    let before = st.profiles.len();
    st.profiles.retain(|x| x.id != id);
    if st.profiles.len() == before {
        return Err(AppError::Other("找不到这把密钥".into()));
    }
    delete_profile_key(id);
    save(&st)
}

/// 按网关令牌 id 查找，用于判断某把 Key 是否已经导入过
pub fn find_by_token_id(token_id: i64) -> Option<Profile> {
    load()
        .profiles
        .into_iter()
        .find(|p| p.gateway_token_id == Some(token_id))
}

/// 找出当前生效的是哪一把 —— 拿实际配置里的 key 和各条的 key 逐一比对。
/// 比对在 Rust 侧做，密钥不出后端。
pub fn match_profile(live_key: Option<&str>) -> Option<String> {
    let live = live_key?.trim();
    if live.is_empty() {
        return None;
    }
    load()
        .profiles
        .iter()
        .find(|p| load_profile_key(&p.id).as_deref() == Some(live))
        .map(|p| p.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str) -> Profile {
        Profile {
            id: name.into(),
            name: name.into(),
            codex_model: String::new(),
            codex_effort: String::new(),
            claude_model: String::new(),
            gateway_token_id: None,
        }
    }

    #[test]
    fn default_name_skips_taken_numbers() {
        let list = vec![p("密钥 1"), p("密钥 3")];
        assert_eq!(next_default_name(&list), "密钥 2");
    }

    /// 回归：曾经用「个数+1」取名，删掉中间一个后新建会重名
    #[test]
    fn default_name_avoids_collision_after_delete() {
        // 原本有 密钥 1 / 密钥 2，删掉 密钥 1 后只剩一个
        let list = vec![p("密钥 2")];
        assert_eq!(next_default_name(&list), "密钥 1");
    }

    #[test]
    fn default_name_on_empty_list() {
        assert_eq!(next_default_name(&[]), "密钥 1");
    }

    #[test]
    fn custom_names_do_not_block_numbering() {
        let list = vec![p("主号"), p("测试号")];
        assert_eq!(next_default_name(&list), "密钥 1");
    }
}

/// 界面上只显示掩码，永远不回显完整 key
pub fn mask(key: &str) -> String {
    let n = key.chars().count();
    if n <= 8 {
        return "•".repeat(n.max(4));
    }
    let head: String = key.chars().take(3).collect();
    let tail: String = key.chars().skip(n - 4).collect();
    format!("{}{}{}", head, "•".repeat(8), tail)
}
