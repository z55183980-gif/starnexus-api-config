use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteConfig {
    pub base_url: String,
    pub wire_api: String,
    pub default_model: String,
    pub recommended_models: Vec<String>,
    #[serde(default)]
    pub claude_default_model: String,
    #[serde(default)]
    pub claude_recommended_models: Vec<String>,
    /// opus / sonnet / haiku 三个别名各自解析到的网关模型
    #[serde(default)]
    pub claude_opus_model: String,
    #[serde(default)]
    pub claude_sonnet_model: String,
    #[serde(default)]
    pub claude_haiku_model: String,
    #[serde(default)]
    pub min_client_version: String,
    #[serde(default)]
    pub notice: String,
    #[serde(default)]
    pub write_mode: String,
}

/// 拉不到远程配置时的兜底 —— 绝不能因为拉不到就罢工
pub fn builtin_defaults() -> RemoteConfig {
    RemoteConfig {
        base_url: "https://api.dkby.com/v1".into(),
        wire_api: "responses".into(),
        default_model: "gpt-5.6-sol".into(),
        // 不内置模型列表：点「获取」从 /v1/models 拿这个 Key 真正能用的，
        // 其余时候允许用户直接手填。避免预设过期或含用不了的模型。
        recommended_models: Vec::new(),
        claude_default_model: "claude-opus-4-8".into(),
        claude_recommended_models: Vec::new(),
        claude_opus_model: "claude-opus-4-8".into(),
        claude_sonnet_model: "claude-sonnet-4-6".into(),
        claude_haiku_model: "claude-haiku-4-5-20251001".into(),
        min_client_version: String::new(),
        notice: String::new(),
        write_mode: "provider_table".into(),
    }
}

fn client(ignore_proxy: bool) -> Result<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("DBkey/", env!("CARGO_PKG_VERSION")));

    // 国内用户挂代理的比例很高，给一条绕过的路
    if ignore_proxy {
        b = b.no_proxy();
    }
    b.build().map_err(|e| AppError::Network(e.to_string()))
}

/// 把 HTTP 状态码翻成用户看得懂的话。
/// 这是客服成本的大头 —— 用户看到"401"只会来问，看到下面这些话就能自己解决。
fn explain(status: u16, body: &str) -> String {
    let detail = body.chars().take(200).collect::<String>();
    match status {
        401 => "API Key 不对或者已经过期了，去官网重新复制一次".into(),
        403 => "你的套餐用不了这个模型，换一个试试".into(),
        404 => "服务地址不对，请把本工具更新到最新版".into(),
        429 => "额度用完了，或者用得太频繁，过一会儿再试".into(),
        500..=599 => format!("服务暂时用不了（{}），过一会儿再试", status),
        _ => format!("没请求成功（{}）：{}", status, detail),
    }
}

fn explain_network(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "连了半天没反应。如果你开了加速器或代理，去高级选项里勾上「不走系统代理」试试".into()
    } else if e.is_connect() {
        "连不上服务器。先看看网络通不通；如果开了加速器或代理，去高级选项里勾上「不走系统代理」".into()
    } else {
        let s = e.to_string();
        if s.contains("certificate") || s.contains("tls") || s.contains("TLS") {
            "安全连接没建立起来。先看看电脑的日期时间对不对，再看看有没有杀毒或上网软件在拦".into()
        } else {
            format!("网络出了点问题：{}", s)
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub models: Vec<String>,
}

/// 用用户的 key 拉模型列表：既验证了 key 有效，又拿到了真实可用的模型。
/// 不计费，适合当"测试连通性"按钮。
pub async fn list_models(base_url: &str, api_key: &str, ignore_proxy: bool) -> Result<TestResult> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));

    let resp = client(ignore_proxy)?
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| AppError::Network(explain_network(&e)))?;

    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();

    if !(200..300).contains(&status) {
        return Ok(TestResult {
            ok: false,
            message: explain(status, &text),
            models: Vec::new(),
        });
    }

    let mut models: Vec<String> = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("data").cloned())
        .and_then(|d| d.as_array().cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    models.sort();

    Ok(TestResult {
        ok: true,
        message: format!("连上了，可以用 {} 个模型", models.len()),
        models,
    })
}

/// 拉远程配置。失败静默回落到内置默认值，绝不阻断用户。
pub async fn fetch_remote_config(endpoint: &str, ignore_proxy: bool) -> RemoteConfig {
    let fallback = builtin_defaults();

    let Ok(c) = client(ignore_proxy) else {
        return fallback;
    };
    let Ok(resp) = c.get(endpoint).send().await else {
        return fallback;
    };
    if !resp.status().is_success() {
        return fallback;
    }
    match resp.json::<RemoteConfig>().await {
        Ok(mut cfg) if !cfg.base_url.is_empty() => {
            // 远端没给 Claude 相关字段时补内置值，别让下拉框空着
            if cfg.claude_default_model.is_empty() {
                cfg.claude_default_model = fallback.claude_default_model.clone();
            }
            if cfg.claude_recommended_models.is_empty() {
                cfg.claude_recommended_models = fallback.claude_recommended_models.clone();
            }
            if cfg.claude_opus_model.is_empty() {
                cfg.claude_opus_model = fallback.claude_opus_model.clone();
            }
            if cfg.claude_sonnet_model.is_empty() {
                cfg.claude_sonnet_model = fallback.claude_sonnet_model.clone();
            }
            if cfg.claude_haiku_model.is_empty() {
                cfg.claude_haiku_model = fallback.claude_haiku_model.clone();
            }
            cfg
        }
        _ => fallback,
    }
}
