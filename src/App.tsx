import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "./api";
import { isBroken } from "./types";
import type {
  ApplyResult,
  BackupEntry,
  Environment,
  GatewayToken,
  Profile,
  RemoteConfig,
} from "./types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ClaudeIcon, CodexIcon } from "./BrandIcons";
import { LoginPanel } from "./LoginPanel";
import { ModelPicker } from "./ModelPicker";
import logoUrl from "./assets/logo.png";
import "./App.css";

// value 是 Codex 认的英文值，label 是给用户看的。
// 源码里还有 none/max/ultra/persistent，但 none 会被网关过滤掉，
// 其余未进官方文档、上游未必支持，不放出来免得用户选了报错。
const EFFORTS: { value: string; label: string }[] = [
  { value: "minimal", label: "最低 — 最快最省" },
  { value: "low", label: "较低" },
  { value: "medium", label: "中等 — 推荐" },
  { value: "high", label: "较高" },
  { value: "xhigh", label: "最高 — 部分模型支持" },
];

type AppId = "codex" | "claude";
type Busy = null | "scan" | "fetch" | "apply" | "restore" | "revert" | "save";

const SITE_URL = "https://dkby.com/";

/** 用系统浏览器打开官网；开发预览时没有 Tauri，回落到 window.open */
async function openSite() {
  try {
    await openUrl(SITE_URL);
  } catch {
    window.open(SITE_URL, "_blank", "noopener,noreferrer");
  }
}

const APP_META: Record<
  AppId,
  { name: string; file: string; officialDesc: string; Icon: typeof CodexIcon }
> = {
  codex: {
    name: "Codex",
    file: "~/.codex/config.toml",
    officialDesc: "用 OpenAI 官方服务，走你自己的 ChatGPT 账号",
    Icon: CodexIcon,
  },
  claude: {
    name: "Claude Code",
    file: "~/.claude/settings.json",
    officialDesc: "用 Anthropic 官方服务，走你自己的账号",
    Icon: ClaudeIcon,
  },
};

/** 正在编辑的密钥表单 */
type Draft = {
  id: string;
  name: string;
  /** 用户新输入的 Key。留空 = 沿用已保存的那把 */
  apiKey: string;
  /** 这把密钥此前是否已存过值，决定提示怎么说 */
  hasKey: boolean;
  /** 已存那把的掩码，直接摆进输入框当占位，让用户一眼看见 */
  maskedKey: string;
  codexModel: string;
  codexEffort: string;
  claudeModel: string;
};

/** 和 Rust 侧一致：取最小的未占用编号，而不是「个数+1」 */
function nextDefaultName(profiles: Profile[]): string {
  for (let n = 1; ; n++) {
    const candidate = `密钥 ${n}`;
    if (!profiles.some((p) => p.name === candidate)) return candidate;
  }
}

const emptyDraft = (): Draft => ({
  id: "",
  name: "",
  apiKey: "",
  hasKey: false,
  maskedKey: "",
  codexModel: "",
  codexEffort: "medium",
  claudeModel: "",
});

export default function App() {
  const [tab, setTab] = useState<AppId>("codex");

  const [env, setEnv] = useState<Environment | null>(null);
  const [remote, setRemote] = useState<RemoteConfig | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);

  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [claudeModels, setClaudeModels] = useState<string[]>([]);
  const [fromUpstream, setFromUpstream] = useState(false);

  const [aliasOpus, setAliasOpus] = useState("");
  const [aliasSonnet, setAliasSonnet] = useState("");
  const [aliasHaiku, setAliasHaiku] = useState("");

  const [cleanup, setCleanup] = useState(true);
  const [overwriteAuth, setOverwriteAuth] = useState(false);
  const [ignoreProxy, setIgnoreProxy] = useState(false);
  const [conservative, setConservative] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  /** 有值就是在编辑（id 为空表示新建） */
  const [draft, setDraft] = useState<Draft | null>(null);

  // 登录态提升到这里：登录一次，整个窗口周期内都能用 ——
  // 批量导入、之后再换 Key，都不必重新登录。
  const [loggedAs, setLoggedAs] = useState<string | null>(null);
  const [tokens, setTokens] = useState<GatewayToken[] | null>(null);
  const [showLogin, setShowLogin] = useState(false);

  const [busy, setBusy] = useState<Busy>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);

  const codexBroken =
    env && isBroken(env.codex.configState) ? env.codex.configState.broken : null;
  const claudeBroken =
    env && isBroken(env.claude.settingsState) ? env.claude.settingsState.broken : null;
  const broken = tab === "codex" ? codexBroken : claudeBroken;
  const active = env ? (tab === "codex" ? env.codex : env.claude) : null;
  const activeId = active?.activeProfileId ?? null;

  /** 真正在用官方：既不是我们配的，也没指向任何第三方地址 */
  const onOfficial = !!active && !broken && !active.managedByUs && !active.currentBaseUrl;

  const reload = useCallback(async (url?: string) => {
    try {
      const [e, ps, bs] = await Promise.all([
        api.scanEnvironment(url),
        api.listProfiles().catch(() => [] as Profile[]),
        api.listBackups().catch(() => [] as BackupEntry[]),
      ]);
      setEnv(e);
      setProfiles(ps);
      setBackups(bs);
      setScanError(null);
    } catch (e) {
      setScanError(String(e));
    }
  }, []);

  useEffect(() => {
    (async () => {
      const st = await api.loadAppState().catch(() => null);
      if (st) {
        setIgnoreProxy(st.ignoreProxy);
        setCleanup(st.cleanupResidue ?? true);
      }

      const rc = await api.getRemoteConfig(st?.ignoreProxy ?? false);
      setRemote(rc);
      setBaseUrl(rc.base_url);
      setAliasOpus(rc.claude_opus_model);
      setAliasSonnet(rc.claude_sonnet_model);
      setAliasHaiku(rc.claude_haiku_model);

      await reload(rc.base_url);
    })();
  }, [reload]);

  // 弹窗按 Esc 关掉，符合用户对弹窗的预期
  useEffect(() => {
    if (!showAdvanced) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowAdvanced(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showAdvanced]);

  // 已启用的那把密钥在哪个标签，就默认停在哪个标签
  useEffect(() => {
    if (env && !env.codex.activeProfileId && env.claude.activeProfileId) setTab("claude");
  }, [env]);

  const modelOf = (p: Profile) =>
    tab === "codex" ? p.codexModel || remote?.default_model : p.claudeModel || remote?.claude_default_model;

  // —————— 密钥编辑 ——————

  const startEdit = (p?: Profile) => {
    setToast(null);
    setDraft(
      p
        ? {
            id: p.id,
            name: p.name,
            apiKey: "",
            hasKey: p.hasKey,
            maskedKey: p.maskedKey,
            codexModel: p.codexModel || remote?.default_model || "",
            codexEffort: p.codexEffort || "medium",
            claudeModel: p.claudeModel || remote?.claude_default_model || "",
          }
        : {
            ...emptyDraft(),
            name: nextDefaultName(profiles),
            codexModel: remote?.default_model || "",
            claudeModel: remote?.claude_default_model || "",
          },
    );
  };

  const doLogout = async () => {
    await api.gatewayLogout().catch(() => {});
    setLoggedAs(null);
    setTokens(null);
  };

  const saveDraft = async (thenEnable: boolean) => {
    if (!draft) return;
    if (!draft.hasKey && !draft.apiKey.trim()) {
      return setToast({ kind: "err", text: "请先填上 API Key" });
    }
    setBusy("save");
    try {
      const id = await api.saveProfile({
        id: draft.id,
        name: draft.name.trim(),
        apiKey: draft.apiKey.trim(),
        codexModel: draft.codexModel.trim(),
        codexEffort: draft.codexEffort,
        claudeModel: draft.claudeModel.trim(),
      });
      setProfiles(await api.listProfiles().catch(() => profiles));
      setDraft(null);
      if (thenEnable) await enable(id, draft);
      else setToast({ kind: "ok", text: "已保存" });
    } catch (e) {
      setToast({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  /**
   * 删除一把密钥。二次确认走界面内的两步按钮，不用 window.confirm ——
   * Tauri 的 WebView 里原生对话框被禁用，confirm 会直接返回 false，
   * 导致删除静默失效。
   */
  const removeProfile = async (p: Profile) => {
    try {
      await api.deleteProfile(p.id);
      setDraft(null);
      await reload(baseUrl);
      setToast({ kind: "ok", text: `已删除「${p.name}」` });
    } catch (e) {
      setToast({ kind: "err", text: String(e) });
    }
  };

  // —————— 启用 ——————

  const enable = async (profileId: string, d?: Draft, rebuild = false) => {
    const p = profiles.find((x) => x.id === profileId);
    setBusy("apply");
    setToast(null);
    setResult(null);
    try {
      const r = await (rebuild ? api.rebuildMinimalConfig : api.applyConfig)({
        profileId,
        baseUrl: baseUrl || remote?.base_url || "",
        wireApi: remote?.wire_api || "responses",
        ignoreProxy,
        configureCodex: tab === "codex",
        model: d?.codexModel || p?.codexModel || remote?.default_model || "",
        reasoningEffort: d?.codexEffort || p?.codexEffort || "medium",
        cleanupResidue: cleanup,
        overwriteOfficialAuth: overwriteAuth,
        conservative,
        configureClaude: tab === "claude",
        claudeModel: d?.claudeModel || p?.claudeModel || remote?.claude_default_model || "",
        claudeOpusModel: aliasOpus,
        claudeSonnetModel: aliasSonnet,
        claudeHaikuModel: aliasHaiku,
      });
      setResult(r);
      setToast({
        kind: "ok",
        text: `${APP_META[tab].name} 配置好了，重新打开它就能用`,
      });
      await reload(baseUrl);
    } catch (e) {
      setToast({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const enableOfficial = async () => {
    setBusy("revert");
    setToast(null);
    setResult(null);
    try {
      await api.revertToOfficial(tab === "codex", tab === "claude");
      setToast({ kind: "ok", text: `${APP_META[tab].name} 已经换回官方` });
      await reload(baseUrl);
    } catch (e) {
      setToast({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const restore = async (id: string) => {
    setBusy("restore");
    try {
      await api.restoreBackup(id);
      setToast({ kind: "ok", text: `已还原到 ${id} 那一次的配置` });
      await reload(baseUrl);
    } catch (e) {
      setToast({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  /** 拉模型列表。优先用刚输入的 Key，没输就用这条已存的那把 */
  const fetchModels = async () => {
    const typed = draft?.apiKey.trim();
    const savedId = draft?.id && draft.hasKey ? draft.id : null;
    if (!typed && !savedId) {
      return setToast({
        kind: "err",
        text: "先填上 API Key 才能查你能用哪些模型",
      });
    }
    setBusy("fetch");
    try {
      const r = typed
        ? await api.testConnection(baseUrl, typed, ignoreProxy)
        : await api.testProfileConnection(savedId!, baseUrl, ignoreProxy);
      setToast({ kind: r.ok ? "ok" : "err", text: r.message });
      if (r.ok && r.models.length) {
        setFromUpstream(true);
        // 不做任何筛选，上游给什么就列什么 —— 用户比我们更清楚自己要用哪个
        setModels(r.models);
        setClaudeModels(r.models);
      }
    } catch (e) {
      setToast({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const hint = useMemo(() => {
    if (!env) return "检测中…";
    if (broken) return "配置文件打不开";
    if (!active?.homeExists) return `没找到 ${APP_META[tab].name}，仍可先配置好`;
    return null;
  }, [env, broken, active, tab]);

  return (
    <div className="app">
      <header className="hd">
        <img className="logo" src={logoUrl} alt="" aria-hidden="true" />
        <h1>星域互联 API</h1>
        <button className="site" onClick={openSite} title="打开官网">
          dkby.com
        </button>
        <button
          className={`icon-btn push-right ${showAdvanced ? "on" : ""}`}
          onClick={() => setShowAdvanced((v) => !v)}
          title={showAdvanced ? "收起高级选项" : "高级选项"}
          aria-label="高级选项"
        >
          {/* Feather/Lucide 的 settings 齿轮，最通用的设置图标 */}
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </header>

      <nav className="tabs" role="tablist">
        {(Object.keys(APP_META) as AppId[]).map((id) => {
          const e = env ? (id === "codex" ? env.codex : env.claude) : null;
          const Icon = APP_META[id].Icon;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`tab ${tab === id ? "on" : ""}`}
              onClick={() => {
                setTab(id);
                setDraft(null);
              }}
            >
              <Icon className={`brand brand-${id}`} />
              {APP_META[id].name}
              {e?.activeProfileId && <span className="dot" title="已启用" />}
            </button>
          );
        })}
      </nav>

      {scanError && <div className="toast err">读取本机设置时出错：{scanError}</div>}
      {remote?.notice && <div className="notice">{remote.notice}</div>}
      {hint && !broken && <div className="hint">{hint}</div>}

      {broken && (
        <div className="panel danger">
          <strong>配置文件打不开</strong>
          <pre className="mono">{broken}</pre>
          {tab === "codex" ? (
            <>
              <p>
                文件内容有格式问题，为了不弄坏它，已经停下没有写入。你可以自己修好它，也可以让我
                重新生成一份干净的 —— 原文件会先完整备份。
              </p>
              <button
                className="danger"
                onClick={() => activeId && enable(activeId, undefined, true)}
                disabled={busy !== null || profiles.length === 0}
              >
                备份原文件，重新生成
              </button>
            </>
          ) : (
            <p>文件内容有格式问题，为了不弄坏它，已经停下没有写入。请先修好这个文件。</p>
          )}
        </div>
      )}

      {/* 官方 */}
      <article className={`card ${onOfficial ? "on" : ""}`}>
        <div className="card-hd">
          <span className={`radio ${onOfficial ? "on" : ""}`} />
          <span className="avatar">
            {(() => {
              const Icon = APP_META[tab].Icon;
              return <Icon className={`brand brand-${tab}`} />;
            })()}
          </span>
          <div className="card-title">
            <strong>官方</strong>
            <span className="card-sub">{APP_META[tab].officialDesc}</span>
          </div>
          {onOfficial ? (
            <span className="badge">当前</span>
          ) : (
            <button className="ghost sm" onClick={enableOfficial} disabled={busy !== null || !env}>
              {busy === "revert" ? "切换中…" : "换回官方"}
            </button>
          )}
        </div>
      </article>

      {/* 密钥列表 */}
      {profiles.map((p) => {
        const on = activeId === p.id;
        const editing = draft?.id === p.id;
        return (
          <article key={p.id} className={`card ${on ? "on" : ""}`}>
            <div className="card-hd">
              <span className={`radio ${on ? "on" : ""}`} />
              <span className="avatar">
                <img src={logoUrl} alt="" />
              </span>
              <div className="card-title">
                <strong>{p.name}</strong>
                <span className="card-sub mono">
                  {p.maskedKey || "还没填 API Key"}
                  {modelOf(p) ? ` · ${modelOf(p)}` : ""}
                </span>
              </div>
              {!editing && (
                <button className="ghost sm" onClick={() => startEdit(p)} disabled={busy !== null}>
                  编辑
                </button>
              )}
              {on ? (
                <span className="badge ok">已启用</span>
              ) : (
                <button
                  className="primary sm"
                  onClick={() => enable(p.id)}
                  disabled={busy !== null || !env || !!broken || !p.hasKey}
                >
                  {busy === "apply" ? "配置中…" : "启用"}
                </button>
              )}
            </div>

            {editing && draft && (
              <Editor
                draft={draft}
                setDraft={setDraft}
                tab={tab}
                models={models}
                claudeModels={claudeModels}
                fromUpstream={fromUpstream}
                busy={busy}
                onFetch={fetchModels}
                onCancel={() => setDraft(null)}
                onSave={saveDraft}
                onDelete={() => removeProfile(p)}
                env={env}
                overwriteAuth={overwriteAuth}
                setOverwriteAuth={setOverwriteAuth}
                cleanup={cleanup}
                setCleanup={setCleanup}
              />
            )}
          </article>
        );
      })}

      {/* 新建 */}
      {draft && !draft.id && (
        <article className="card on">
          <div className="card-hd">
            <span className="radio" />
            <span className="avatar">
              <img src={logoUrl} alt="" />
            </span>
            <div className="card-title">
              <strong>新密钥</strong>
              <span className="card-sub">填好 API Key 就能用</span>
            </div>
          </div>
          <Editor
            draft={draft}
            setDraft={setDraft}
            tab={tab}
            models={models}
            claudeModels={claudeModels}
            fromUpstream={fromUpstream}
            busy={busy}
            onFetch={fetchModels}
            onCancel={() => setDraft(null)}
            onSave={saveDraft}
            env={env}
            overwriteAuth={overwriteAuth}
            setOverwriteAuth={setOverwriteAuth}
            cleanup={cleanup}
            setCleanup={setCleanup}
          />
        </article>
      )}

      {showLogin && (
        <LoginPanel
          loggedAs={loggedAs}
          tokens={tokens}
          baseUrl={baseUrl}
          ignoreProxy={ignoreProxy}
          busy={busy !== null}
          onLoggedIn={(u, list) => {
            setLoggedAs(u);
            setTokens(list);
          }}
          onLogout={doLogout}
          onImported={async (created, updated, unchanged, skipped) => {
            setProfiles(await api.listProfiles().catch(() => profiles));
            const parts: string[] = [];
            if (created.length) parts.push(`新增 ${created.length} 个密钥`);
            if (updated.length) parts.push(`更新 ${updated.length} 个`);
            if (unchanged.length) parts.push(`${unchanged.length} 个没有变化`);
            if (skipped.length) parts.push(`${skipped.length} 个取不到，跳过`);
            setToast({ kind: "ok", text: parts.join("，") || "没有可导入的" });
            setShowLogin(false);
          }}
          onError={(m) => setToast({ kind: "err", text: m })}
          onClose={() => setShowLogin(false)}
        />
      )}

      {!draft && !showLogin && profiles.length === 0 && (
        // 一把密钥都没有：这是用户唯一该做的事，给它主按钮的分量，
        // 别让它输给上面那张不需要操作的「官方」卡。
        <div className="empty">
          <div className="empty-title">先添加一把密钥</div>
          <div className="empty-sub">
            配好之后，Codex 和 Claude Code 就走星域互联，不用再手改配置文件。
          </div>
          <div className="row">
            <button
              className="primary"
              onClick={() => setShowLogin(true)}
              disabled={busy !== null}
            >
              登录导入{loggedAs ? `（已登录 ${loggedAs}）` : ""}
            </button>
            <button className="ghost" onClick={() => startEdit()} disabled={busy !== null}>
              手动填 Key
            </button>
          </div>
        </div>
      )}

      {!draft && !showLogin && profiles.length > 0 && (
        // 已经有密钥了：「添加」留在列表末尾，样式和文案跟空态那对按钮一致 ——
        // 同一件事在两个地方长得一样，用户不用重新认一遍。
        <div className="add-row row">
          <button
            className="primary"
            onClick={() => setShowLogin(true)}
            disabled={busy !== null}
          >
            登录导入{loggedAs ? `（已登录 ${loggedAs}）` : ""}
          </button>
          <button className="ghost" onClick={() => startEdit()} disabled={busy !== null}>
            手动填 Key
          </button>
        </div>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}

      {result && (
        <div className="panel ok">
          <strong>配置好了</strong>
          <ul>
            {result.paths.map((p) => (
              <li key={p} className="mono">
                {p}
              </li>
            ))}
          </ul>
          <div className="row logged">
            <span className="dim">改动前已备份（{result.backupId}）</span>
            <button
              className="ghost sm"
              onClick={() => restore(result.backupId)}
              disabled={busy !== null}
              title="把刚才的改动撤销掉"
            >
              撤销这次改动
            </button>
          </div>
          {result.warnings.map((w, i) => (
            <div key={i} className="warn-line">
              {w}
            </div>
          ))}
        </div>
      )}

      {showAdvanced && (
        <div
          className="overlay"
          onMouseDown={(e) => {
            // 只有点在遮罩本身才关，点内容不关
            if (e.target === e.currentTarget) setShowAdvanced(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label="高级选项">
            <div className="modal-hd">
              <strong>高级选项</strong>
              <button className="ghost sm" onClick={() => setShowAdvanced(false)}>
                关闭
              </button>
            </div>
            <div className="modal-body">
          <div className="field">
            <label>
              服务地址
              <span className="dim"> · 一般不用改</span>
            </label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
          </div>
          <div className="field">
            <label>
              Claude Code 里 haiku / sonnet / opus 分别用哪个模型
              <span className="dim"> · 影响后台杂事和快捷切换，留空就不设置</span>
            </label>
            <input value={aliasHaiku} onChange={(e) => setAliasHaiku(e.target.value)} placeholder="haiku" spellCheck={false} />
            <input value={aliasSonnet} onChange={(e) => setAliasSonnet(e.target.value)} placeholder="sonnet" spellCheck={false} />
            <input value={aliasOpus} onChange={(e) => setAliasOpus(e.target.value)} placeholder="opus" spellCheck={false} />
          </div>
          <label className="check">
            <input type="checkbox" checked={ignoreProxy} onChange={(e) => setIgnoreProxy(e.target.checked)} />
            <span>
              不走系统代理
              <span className="dim"> · 连不上、一直转圈时勾这个</span>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={conservative} onChange={(e) => setConservative(e.target.checked)} />
            <span>
              Codex 兼容旧版本
              <span className="dim"> · 配好后 Codex 还提示没登录时勾这个</span>
            </span>
          </label>

          {backups.length > 0 && (
            <div className="backups">
              <label>备份记录 · 出问题时可以退回</label>
              {backups.map((b) => (
                <div key={b.id} className="backup-row">
                  <span className="mono dim">{b.created_at}</span>
                  <button className="ghost sm" onClick={() => restore(b.id)} disabled={busy !== null}>
                    还原
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ——————————————————————————————————————————————

function Editor(props: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  tab: AppId;
  models: string[];
  claudeModels: string[];
  fromUpstream: boolean;
  busy: Busy;
  onFetch: () => void;
  onCancel: () => void;
  onSave: (thenEnable: boolean) => void;
  onDelete?: () => void;
  env: Environment | null;
  overwriteAuth: boolean;
  setOverwriteAuth: (v: boolean) => void;
  cleanup: boolean;
  setCleanup: (v: boolean) => void;
}) {
  const {
    draft: d,
    setDraft,
    tab,
    models,
    claudeModels,
    fromUpstream,
    busy,
    onFetch,
    onCancel,
    onSave,
    onDelete,
    env,
    overwriteAuth,
    setOverwriteAuth,
    cleanup,
    setCleanup,
  } = props;

  const list = tab === "codex" ? models : claudeModels;
  const [showKey, setShowKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 用户是不是正在输入一把新的 Key */
  const typing = d.apiKey.length > 0;

  return (
    <div className="card-body">
      <div className="grid2">
        <div className="field">
          <label>
            名称
            <span className="dim"> · 只是给你自己看的</span>
          </label>
          <input
            value={d.name}
            onChange={(e) => setDraft({ ...d, name: e.target.value })}
            placeholder="例如：主号 / 测试号"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label>
            {confirmDelete && onDelete ? (
              <span className="warn-text">保存的 API Key 会一并清掉</span>
            ) : (
              <>&nbsp;</>
            )}
          </label>
          {onDelete &&
            (confirmDelete ? (
              <div className="row">
                <button
                  className="danger"
                  onClick={() => {
                    setConfirmDelete(false);
                    onDelete();
                  }}
                  disabled={busy !== null}
                >
                  确认删除
                </button>
                <button
                  className="ghost"
                  onClick={() => setConfirmDelete(false)}
                  disabled={busy !== null}
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                className="ghost danger-text"
                onClick={() => setConfirmDelete(true)}
                disabled={busy !== null}
              >
                删除这把密钥
              </button>
            ))}
        </div>
      </div>

      <div className="field">
        <label>
          API Key
          {d.hasKey && !typing ? (
            <span className="ok-text"> · 已保存，不用再填</span>
          ) : typing ? (
            <span className="dim"> · 保存后会替换掉原来那把</span>
          ) : (
            <span className="warn-text"> · 还没填</span>
          )}
        </label>
        <div className="row">
          <input
            type={showKey || (d.hasKey && !typing) ? "text" : "password"}
            value={typing ? d.apiKey : d.hasKey ? d.maskedKey : d.apiKey}
            onChange={(e) => setDraft({ ...d, apiKey: e.target.value })}
            onFocus={() => {
              if (d.hasKey && !typing) setDraft({ ...d, apiKey: "" });
            }}
            placeholder={d.hasKey ? "" : "粘贴你的 API Key，或用下方的登录导入"}
            spellCheck={false}
            autoComplete="off"
            className={d.hasKey && !typing ? "mono placeholderish" : undefined}
          />
          {typing && (
            <button className="ghost" onClick={() => setShowKey(!showKey)}>
              {showKey ? "隐藏" : "显示"}
            </button>
          )}
          {d.hasKey && typing && (
            <button
              className="ghost"
              onClick={() => setDraft({ ...d, apiKey: "" })}
              title="放弃修改，继续用原来那把"
            >
              撤销
            </button>
          )}
        </div>
      </div>

      {tab === "codex" ? (
        <div className="grid2">
          <div className="field">
            <label>
              模型
              {fromUpstream ? (
                <span className="dim"> · {models.length} 个可选，点右侧箭头看全部</span>
              ) : (
                <span className="dim"> · 可直接填，或点「获取」列出你能用的</span>
              )}
            </label>
            <div className="row">
              <ModelPicker
                value={d.codexModel}
                onChange={(v) => setDraft({ ...d, codexModel: v })}
                options={list}
                placeholder="填写模型名"
                disabled={busy !== null}
              />
              <button className="ghost" onClick={onFetch} disabled={busy !== null}>
                {busy === "fetch" ? "…" : "获取"}
              </button>
            </div>
          </div>
          <div className="field">
            <label>思考深度</label>
            <select
              value={d.codexEffort}
              onChange={(e) => setDraft({ ...d, codexEffort: e.target.value })}
            >
              {EFFORTS.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <div className="field">
          <label>
            模型
            {fromUpstream ? (
              <span className="dim"> · {claudeModels.length} 个可选，点右侧箭头看全部</span>
            ) : (
              <span className="dim"> · 可直接填，或点「获取」列出你能用的</span>
            )}
          </label>
          <div className="row">
            <ModelPicker
              value={d.claudeModel}
              onChange={(v) => setDraft({ ...d, claudeModel: v })}
              options={list}
              placeholder="填写模型名"
              disabled={busy !== null}
            />
            <button className="ghost" onClick={onFetch} disabled={busy !== null}>
              {busy === "fetch" ? "…" : "获取"}
            </button>
          </div>
        </div>
      )}

      {tab === "codex" && env?.codex.authState === "OfficialLogin" && (
        <div className="panel info">
          <strong>你已经登录了 ChatGPT 官方账号</strong>
          <p>默认会帮你保住这个登录，以后随时能切回去用官方。</p>
          <label className="check">
            <input
              type="checkbox"
              checked={overwriteAuth}
              onChange={(e) => setOverwriteAuth(e.target.checked)}
            />
            <span>
              不用保留
              <span className="dim"> · 勾了会退出官方登录</span>
            </span>
          </label>
        </div>
      )}

      {tab === "codex" && !!env?.codex.residue.length && (
        <label className="check">
          <input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} />
          <span>
            顺手整理一下配置文件
            <span className="dim"> · {env.codex.residue.join("、")}</span>
          </span>
        </label>
      )}

      <div className="row end">
        <button className="ghost" onClick={onCancel} disabled={busy !== null}>
          取消
        </button>
        <button className="ghost" onClick={() => onSave(false)} disabled={busy !== null}>
          {busy === "save" ? "保存中…" : "只保存"}
        </button>
        <button className="primary" onClick={() => onSave(true)} disabled={busy !== null}>
          {busy === "apply" ? "配置中…" : "保存并启用"}
        </button>
      </div>
    </div>
  );
}
