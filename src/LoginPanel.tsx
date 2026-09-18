import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "./api";
import type { GatewayToken } from "./types";

/** 官网对应页面；开发预览没有 Tauri，回落到 window.open */
async function openWeb(path: string) {
  const url = `https://dkby.com${path}`;
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * 登录导入：登录一次，勾选多把 Key，一次全导进来。
 *
 * 会话由 App 统一持有并保持到关窗口，所以导完不登出 ——
 * 用户想再导、或给某把密钥换值，都不用重新登录。
 * 密码只用来换会话，登录成功立刻从内存清掉，不落盘。
 */
export function LoginPanel(props: {
  loggedAs: string | null;
  tokens: GatewayToken[] | null;
  baseUrl: string;
  ignoreProxy: boolean;
  busy: boolean;
  onLoggedIn: (user: string, tokens: GatewayToken[]) => void;
  onLogout: () => void;
  onImported: (created: string[], updated: string[], unchanged: string[], skipped: string[]) => void;
  onError: (msg: string) => void;
  onClose: () => void;
}) {
  const {
    loggedAs,
    tokens,
    baseUrl,
    ignoreProxy,
    busy,
    onLoggedIn,
    onLogout,
    onImported,
    onError,
    onClose,
  } = props;

  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [working, setWorking] = useState<null | "login" | "import">(null);

  const doLogin = async () => {
    setWorking("login");
    try {
      const name = await api.gatewayLogin(baseUrl, user.trim(), pass, ignoreProxy);
      setPass(""); // 密码用完即丢
      const list = await api.gatewayListTokens();
      // 默认只勾还没导过的 —— 已关联的交给用户自己决定要不要更新
      setPicked(new Set(list.filter((t) => t.usable && !t.linkedProfile).map((t) => t.id)));
      onLoggedIn(name, list);
    } catch (e) {
      onError(String(e));
    } finally {
      setWorking(null);
    }
  };

  const toggle = (id: number) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  /** 单独更新某把已关联的 Key */
  const updateOne = async (id: number) => {
    setWorking("import");
    try {
      const r = await api.gatewayImportTokens([id]);
      onImported(r.created, r.updated, r.unchanged, r.skipped);
    } catch (e) {
      onError(String(e));
    } finally {
      setWorking(null);
    }
  };

  const doImport = async () => {
    setWorking("import");
    try {
      const r = await api.gatewayImportTokens([...picked]);
      onImported(r.created, r.updated, r.unchanged, r.skipped);
    } catch (e) {
      onError(String(e));
    } finally {
      setWorking(null);
    }
  };

  const fresh = tokens?.filter((t) => t.usable && !t.linkedProfile) ?? [];

  return (
    <article className="card on">
      <div className="card-hd">
        <span className="radio on" />
        <div className="card-title">
          <strong>登录导入</strong>
          <span className="card-sub">
            {loggedAs ? `已登录 ${loggedAs}` : "用星域互联的账号登录，把 Key 直接取过来"}
          </span>
        </div>
        {loggedAs && (
          <button className="ghost sm" onClick={onLogout} disabled={busy || working !== null}>
            退出登录
          </button>
        )}
        <button className="ghost sm" onClick={onClose} disabled={working !== null}>
          关闭
        </button>
      </div>

      <div className="card-body">
        {!loggedAs ? (
          // 表单结构和文案对齐 dkby.com 的登录页 —— 用户注册时见过同一套，
          // 样式一致能降低"这程序是不是假的"的疑虑
          <div className="login-form">
            <div className="login-title">用户登录</div>
            <div className="login-sub">
              没有账号？{" "}
              <button className="linkish" onClick={() => void openWeb("/sign-up")}>
                注册
              </button>
              .
            </div>

            <div className="field">
              <label>用户名或电子邮件</label>
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="输入您的用户名或电子邮件"
                spellCheck={false}
                autoComplete="off"
                disabled={working !== null}
              />
            </div>

            <div className="field">
              <label className="label-row">
                <span>密码</span>
                <button className="linkish" onClick={() => void openWeb("/forgot-password")}>
                  忘记密码？
                </button>
              </label>
              <div className="pw">
                <input
                  type={showPass ? "text" : "password"}
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doLogin()}
                  placeholder="输入密码"
                  autoComplete="off"
                  disabled={working !== null}
                />
                <button
                  className="pw-eye"
                  onClick={() => setShowPass((v) => !v)}
                  title={showPass ? "隐藏密码" : "显示密码"}
                  aria-label={showPass ? "隐藏密码" : "显示密码"}
                  disabled={working !== null}
                >
                  {showPass ? (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <button className="login-submit" onClick={doLogin} disabled={working !== null}>
              {/* 官网用的是 Lucide 的 LogIn 图标 */}
              <svg
                viewBox="0 0 24 24"
                width="17"
                height="17"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" x2="3" y1="12" y2="12" />
              </svg>
              {working === "login" ? "登录中…" : "登录"}
            </button>

            <div className="dim login-note">密码只用来登录一次，不会保存</div>
          </div>
        ) : (
          <>
            {tokens && tokens.length === 0 ? (
              <div className="hint">这个账号下还没有 Key，先去官网建一个。</div>
            ) : (
              <>
                <div className="row logged">
                  <span className="dim">勾选要导入的 Key</span>
                  <button
                    className="ghost sm"
                    onClick={() =>
                      setPicked(
                        picked.size === fresh.length
                          ? new Set()
                          : new Set(fresh.map((t) => t.id)),
                      )
                    }
                    disabled={working !== null}
                  >
                    {picked.size === fresh.length && fresh.length > 0 ? "全不选" : "全选未导入的"}
                  </button>
                </div>

                {tokens?.map((t) =>
                  t.linkedProfile ? (
                    // 已经导过：不给勾选框，只给「更新」—— 把密钥换成最新值，不重复新建
                    <div key={t.id} className="token">
                      <span className="linked-dot" />
                      <div className="token-main">
                        <strong>{t.name}</strong>
                        <span className="dim">已关联「{t.linkedProfile}」</span>
                      </div>
                      <button
                        className="ghost sm"
                        onClick={() => void updateOne(t.id)}
                        disabled={!t.usable || working !== null}
                      >
                        {working === "import" ? "处理中…" : "更新"}
                      </button>
                    </div>
                  ) : (
                    <label key={t.id} className={`token ${t.usable ? "" : "off"}`}>
                      <input
                        type="checkbox"
                        checked={picked.has(t.id)}
                        onChange={() => toggle(t.id)}
                        disabled={!t.usable || working !== null}
                      />
                      <div className="token-main">
                        <strong>{t.name}</strong>
                        {t.note && <span className="dim">{t.note}</span>}
                      </div>
                    </label>
                  ),
                )}

                <div className="row end">
                  <button
                    className="primary"
                    onClick={doImport}
                    disabled={picked.size === 0 || working !== null}
                  >
                    {working === "import" ? "导入中…" : `导入选中的 ${picked.size} 个`}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </article>
  );
}
