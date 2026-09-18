# 星域互联 API 配置器

给星域互联网关用户的一键配置工具，同时支持 **Codex** 和 **Claude Code CLI**。单供应商、一屏搞定。

写入内核参照 [cc-switch](https://github.com/farion1231/cc-switch)（MIT）的做法，但砍掉了多供应商管理层 —— 我们只服务一个网关。

## 技术栈

- Tauri 2 + React 18 + TypeScript + Vite
- `toml_edit` 结构化改写 config.toml（保留注释与格式）
- `serde_json` + `preserve_order` 合并式改写 auth.json
- `reqwest` + rustls（不依赖系统 OpenSSL）
- 密钥存系统密钥库（Windows DPAPI / macOS Keychain），每把各存一条

## 它写入什么

### Codex

默认走 **内置 openai provider** 这条路，也就是多年来手动配置通行的写法：

`~/.codex/config.toml`

```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "medium"
openai_base_url = "https://api.dkby.com/v1"
```

`~/.codex/auth.json`

```json
{ "OPENAI_API_KEY": "sk-..." }
```

`model_provider` 的默认值就是 `"openai"`，所以不写；只有当它被改成别的值时才纠正回来。改动越少越不容易出事。

> **为什么不用自定义 provider 段**
>
> 只有内置的 `openai` provider 会去读 `auth.json`。一旦把 `model_provider` 换成自定义段名，取密钥这条链就断了，请求会被判成 `401 Invalid token`。
>
> 另外 Codex 的几种认证方式是**互斥**的：`env_key`、`experimental_bearer_token`、`requires_openai_auth` 不能同时出现，否则报 `Missing environment variable: OPENAI_API_KEY`。代码里有专门的测试 `never_writes_env_key` 锁着这条。

想保住官方 ChatGPT 登录的用户可以切到 **Bearer Token 模式**：写一个自定义 provider 段、密钥放段内，完全不碰 `auth.json`。

### Claude Code — `~/.claude/settings.json`

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.dkby.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "...",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "...",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "...",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "..."
  }
}
```

三个 `DEFAULT_*_MODEL` 别名必须写齐，否则用户执行 `/model opus` 时会解析到 Anthropic 官方的模型 ID，在网关上 404。

写入时还会清掉两个东西：

- `ANTHROPIC_SMALL_FAST_MODEL` —— 官方已标记废弃，由 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 取代
- `ANTHROPIC_API_KEY` —— 它走 `x-api-key` 头，和 `ANTHROPIC_AUTH_TOKEN` 的 Bearer 冲突，只能留一个

### 两个工具的 base_url 不一样

同一个网关，地址却不同 —— 这是最容易踩的坑，所以由代码推导，不让用户手填：

| 工具 | base_url | 原因 |
|---|---|---|
| Codex | `https://api.dkby.com/v1` | 它自己拼 `/responses` |
| Claude Code | `https://api.dkby.com` | 它自己拼 `/v1/messages` |

## 多把密钥

用户常有多把 Key（主号 / 测试号 / 不同套餐），工具里各存一条，随时切换。可以手动粘贴，也可以用星域互联的账号登录后批量导入 —— **登录态只在内存里，不落盘**，密码用完即丢。

## 三条不可违背的规则

**1. 解析不了就绝不写入。**
`config.toml` TOML 语法有误时停止写入，让用户手动修，或走「备份并重建最小配置」。绝不静默覆盖。

**2. 只合并，绝不覆盖。**
Codex 的 `auth.json` 只改 `OPENAI_API_KEY`，`auth_mode`、`tokens`、`last_refresh` 一律保留。
Claude Code 的 `settings.json` 只动 `env` 里我们管的那几个键，`permissions`、`hooks`、`statusLine`、`theme`、顶层 `model` 一律保留。

**3. 只动自己的地盘。**
`[marketplaces.*]`、`[plugins.*]`、`notify`、用户注释 —— 一个字不动。

## 容错

- **原子写**：临时文件 → fsync → rename
- **多文件事务**：Codex 和 Claude Code 在同一个事务里写，任何一步失败全部还原，不留半残态
- **自动备份**：写入前备份到 `~/.codex/.dbkey-backups/<时间戳>/`，保留最近 10 份
- **一键回滚**：界面常驻「恢复上一次配置」
- **权限收紧**：Windows `icacls` 去继承，macOS `chmod 600`

## 兼容性处理

| 场景 | 处理 |
|---|---|
| `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 被改过 | 优先读环境变量，不硬编码 `~/.codex` 和 `~/.claude` |
| `~/.codex` 不存在 | 自动创建并提示 |
| `config.toml` 语法错误 | 停止写入，提供重建选项 |
| `settings.json` 语法错误 | 停止写入，要求用户先修 JSON |
| 两个工具 base_url 不同 | 代码自动推导，用户只填一次 |
| 中文用户名 / 路径 | 全程 `PathBuf`，不拼字符串 |
| 多行字符串 | 检测到 `"""` / `'''` 时跳过空行清理，绝不改坏用户的值 |
| 官方 ChatGPT 登录 | 默认保留，需用户显式切到 Bearer Token 模式 |
| Win10 无 WebView2 | 打包时 `embedBootstrapper` 自动安装 |

## 开发

Windows 需要 Rust + MSVC 生成工具 + Windows SDK；macOS 需要 Xcode Command Line Tools。

```bash
npm install
npm run tauri dev
```

跑测试：

```bash
cd src-tauri && cargo test
```

测试样本取自真实用户的 `config.toml`（含 `[plugins.*]`、`[marketplaces.*]`、手改的 model、旧脚本累积的空行），锁住「不破坏用户配置」这条底线。其中几条是事故回归测试，专门盯着上面说的那几个认证坑。

对着**本机真实配置**做一次干跑（只在内存里算，不落盘）：

```bash
cd src-tauri && cargo run --example dryrun
```

它会报告段落/键的增减、注释是否保留、是否幂等 —— 改动写入逻辑后应该先跑它。

## 出包

Windows 包可以本地打：

```bash
npm run tauri build
```

macOS 包**只能由 macOS 出**（编译要 Apple SDK，打 DMG 要 `hdiutil`，签名要 `codesign`），所以走 GitHub Actions。推一个 `v*` tag 触发，或在 Actions 页面手动运行：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

流水线定义在 [.github/workflows/release.yml](.github/workflows/release.yml)，macOS 出通用包（Intel + Apple Silicon），Windows 出 NSIS / MSI / 免安装三种。

签名是可选的：配了 `APPLE_CERTIFICATE` 等 secret 就签名并公证，没配就产出未签名包。**未签名的 Mac 包只够自己测** —— 用户下载后会被 Gatekeeper 判为「已损坏」，macOS 15 之后连右键绕过都不行了。

## 尚未完成

- 代码签名与 macOS 公证（需要 Apple Developer Program）
- `tauri-plugin-updater` 自动更新
- 真实环境验证：登录导入、Claude Code 写入链路
