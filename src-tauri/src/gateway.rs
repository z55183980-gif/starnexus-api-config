//! 登录网关取 API Key，省掉用户去官网复制粘贴。
//!
//! 登录态**只活在内存里，绝不落盘**：
//!   - 它的权限远大于本工具所需（能建/删 token、看账单），不该在磁盘上留一份
//!   - 服务端 session 本来就会过期，持久化只会让用户下次看到"已登录"却一点就报错
//!   - key 一旦取到就已经进了系统密钥库，登录态的使命就结束了
//! 关掉窗口即失效，符合"装完即弃"的定位。

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

/// 带 cookie 的会话。整个应用共用一个，存在 Tauri 的托管状态里。
pub struct Session {
    client: reqwest::Client,
    /// 网关根地址，如 https://api.dkby.com
    base: std::sync::Mutex<String>,
    /// 当前登录的用户名，仅用于界面显示
    user: std::sync::Mutex<Option<String>>,
    /// 用户数字 id。网关除了 session 还要求每个请求带 New-Api-User 头，
    /// 值必须等于 session 里的 id，否则一律 401。
    user_id: std::sync::Mutex<Option<i64>>,
}

impl Session {
    pub fn new(ignore_proxy: bool) -> Result<Self> {
        let mut b = reqwest::Client::builder()
            .cookie_store(true)
            .timeout(Duration::from_secs(25))
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("DBkey/", env!("CARGO_PKG_VERSION")));
        if ignore_proxy {
            b = b.no_proxy();
        }
        Ok(Self {
            client: b.build().map_err(|e| AppError::Network(e.to_string()))?,
            base: std::sync::Mutex::new(String::new()),
            user: std::sync::Mutex::new(None),
            user_id: std::sync::Mutex::new(None),
        })
    }

    pub fn current_user(&self) -> Option<String> {
        self.user.lock().ok().and_then(|u| u.clone())
    }

    fn user_id(&self) -> Option<i64> {
        self.user_id.lock().ok().and_then(|u| *u)
    }

    fn url(&self, path: &str) -> String {
        let base = self.base.lock().map(|b| b.clone()).unwrap_or_default();
        format!("{}{}", base.trim_end_matches('/'), path)
    }
}

/// 网关统一的响应包装
#[derive(Debug, Deserialize)]
// 不加这条的话 serde 会给 T 推断出 Default 约束，而我们的响应类型没必要实现它
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct ApiEnvelope<T> {
    success: bool,
    #[serde(default)]
    message: String,
    #[serde(default)]
    data: Option<T>,
}

fn unwrap_envelope<T>(env: ApiEnvelope<T>, fallback: &str) -> Result<T> {
    if !env.success {
        let msg = if env.message.trim().is_empty() {
            fallback.to_string()
        } else {
            env.message
        };
        return Err(AppError::Other(msg));
    }
    env.data
        .ok_or_else(|| AppError::Other("服务器返回的内容不完整".into()))
}

#[derive(Debug, Deserialize)]
struct LoginUser {
    id: i64,
    username: String,
}

/// 界面上展示的一把 Key。注意这里**不含明文**，要用时再单取。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayToken {
    pub id: i64,
    pub name: String,
    /// 是否可用（被禁用或过期的不让选）
    pub usable: bool,
    /// 不可用的原因，可用时为空
    pub note: String,
}

#[derive(Debug, Deserialize)]
struct RawToken {
    id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: i64,
    #[serde(default)]
    expired_time: i64,
}

impl RawToken {
    fn into_view(self) -> GatewayToken {
        // status: 1 启用；其余都是禁用/耗尽
        let enabled = self.status == 1;
        // expired_time: -1 永不过期
        let expired = self.expired_time > 0
            && self.expired_time
                < std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

        // 不显示额度：它的单位取决于服务端的显示设置（美元/人民币/token），
        // 客户端拿不到那个设置，换算出来的数字会误导用户。
        let note = if !enabled {
            "已停用".into()
        } else if expired {
            "已过期".into()
        } else {
            String::new()
        };

        GatewayToken {
            name: if self.name.trim().is_empty() {
                format!("令牌 {}", self.id)
            } else {
                self.name
            },
            id: self.id,
            usable: enabled && !expired,
            note,
        }
    }
}

/// 账号密码登录。base 传网关根地址（不带 /v1）。
pub async fn login(
    s: &Session,
    base: &str,
    username: &str,
    password: &str,
) -> Result<String> {
    if username.trim().is_empty() || password.is_empty() {
        return Err(AppError::Other("请填写账号和密码".into()));
    }
    {
        let mut b = s.base.lock().map_err(|_| AppError::Other("内部状态异常".into()))?;
        *b = base.trim_end_matches('/').to_string();
    }

    let resp = s
        .client
        .post(s.url("/api/user/login"))
        .json(&serde_json::json!({ "username": username.trim(), "password": password }))
        .send()
        .await
        .map_err(|e| AppError::Network(explain(&e)))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(AppError::Other("登录太频繁了，等一会儿再试".into()));
    }

    let env: ApiEnvelope<LoginUser> = serde_json::from_str(&text).map_err(|_| {
        AppError::Other(if status.is_success() {
            "服务器返回的内容看不懂，可能不是星域互联的地址".into()
        } else {
            format!("登录失败（{}）", status.as_u16())
        })
    })?;

    let u = unwrap_envelope(env, "账号或密码不对")?;
    if let Ok(mut cur) = s.user.lock() {
        *cur = Some(u.username.clone());
    }
    if let Ok(mut id) = s.user_id.lock() {
        *id = Some(u.id);
    }
    Ok(u.username)
}

pub fn logout(s: &Session) {
    if let Ok(mut u) = s.user.lock() {
        *u = None;
    }
    if let Ok(mut id) = s.user_id.lock() {
        *id = None;
    }
    // cookie 留在内存里的 client 上，下次登录会被新的覆盖；
    // 进程退出即全部消失，不做额外清理。
}

/// 列出当前账号下的所有 Key（不含明文）
pub async fn list_tokens(s: &Session) -> Result<Vec<GatewayToken>> {
    if s.current_user().is_none() {
        return Err(AppError::Other("还没登录".into()));
    }
    let uid = s
        .user_id()
        .ok_or_else(|| AppError::Other("登录状态异常，请重新登录".into()))?;
    let resp = s
        .client
        .get(s.url("/api/token/"))
        .header("New-Api-User", uid.to_string())
        .query(&[("p", "0"), ("size", "100")])
        .send()
        .await
        .map_err(|e| AppError::Network(explain(&e)))?;

    let text = resp.text().await.unwrap_or_default();

    // 分页接口可能直接给数组，也可能包一层 {items: []}
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Listing {
        Paged { items: Vec<RawToken> },
        Plain(Vec<RawToken>),
    }

    let env: ApiEnvelope<Listing> = serde_json::from_str(&text)
        .map_err(|_| AppError::Other("读取 Key 列表失败，登录可能已过期".into()))?;

    let list = match unwrap_envelope(env, "读取 Key 列表失败")? {
        Listing::Paged { items } => items,
        Listing::Plain(v) => v,
    };
    Ok(list.into_iter().map(RawToken::into_view).collect())
}

#[derive(Debug, Deserialize)]
struct KeyOnly {
    key: String,
}

/// 取某把 Key 的明文。这是唯一会拿到密钥的地方，取完直接进系统密钥库。
pub async fn fetch_key(s: &Session, token_id: i64) -> Result<String> {
    if s.current_user().is_none() {
        return Err(AppError::Other("还没登录".into()));
    }
    let uid = s
        .user_id()
        .ok_or_else(|| AppError::Other("登录状态异常，请重新登录".into()))?;
    let resp = s
        .client
        .post(s.url(&format!("/api/token/{}/key", token_id)))
        .header("New-Api-User", uid.to_string())
        .send()
        .await
        .map_err(|e| AppError::Network(explain(&e)))?;

    let text = resp.text().await.unwrap_or_default();
    let env: ApiEnvelope<KeyOnly> = serde_json::from_str(&text)
        .map_err(|_| AppError::Other("取 Key 失败，登录可能已过期".into()))?;
    let k = unwrap_envelope(env, "取 Key 失败")?.key;

    // 网关存的是不带前缀的裸串，补成 Codex / Claude Code 认的形式
    Ok(if k.starts_with("sk-") {
        k
    } else {
        format!("sk-{}", k)
    })
}

fn explain(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "连了半天没反应。如果你开了加速器或代理，去高级选项里勾上「不走系统代理」试试".into()
    } else if e.is_connect() {
        "连不上服务器，先看看网络通不通".into()
    } else {
        format!("网络出了点问题：{}", e)
    }
}

/// Tauri 托管状态：整个应用共用一个会话
pub struct SessionState(pub Arc<std::sync::Mutex<Option<Arc<Session>>>>);

impl SessionState {
    pub fn new() -> Self {
        Self(Arc::new(std::sync::Mutex::new(None)))
    }

    /// 取当前会话；没有就按当前代理设置新建一个
    pub fn get_or_init(&self, ignore_proxy: bool) -> Result<Arc<Session>> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| AppError::Other("内部状态异常".into()))?;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let s = Arc::new(Session::new(ignore_proxy)?);
        *guard = Some(s.clone());
        Ok(s)
    }

    /// 代理设置变了要重建 client，顺带丢掉旧 cookie
    pub fn reset(&self) {
        if let Ok(mut g) = self.0.lock() {
            *g = None;
        }
    }
}
