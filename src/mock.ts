// 开发期界面预览用的假数据。
// 只在 vite dev 且 URL 带 ?mock=<场景> 时生效，生产构建里这段代码会被摇掉。
//
//   http://localhost:1420/?mock=configured   已配置
//   http://localhost:1420/?mock=fresh        全新未配置
//   http://localhost:1420/?mock=legacy       旧脚本残留 + 官方登录
//   http://localhost:1420/?mock=broken       配置文件损坏
//   http://localhost:1420/?mock=nocodex      没装 Codex

import type {
  AppState,
  ApplyRequest,
  ApplyResult,
  BackupEntry,
  Environment,
  GatewayToken,
  Profile,
  RemoteConfig,
  TestResult,
} from "./types";

export type Scenario = "configured" | "fresh" | "legacy" | "broken" | "nocodex";

export function activeScenario(): Scenario | null {
  if (!import.meta.env.DEV) return null;
  const m = new URLSearchParams(location.search).get("mock");
  return m ? (m as Scenario) : null;
}

const HOME_CODEX = "C:\\Users\\PC\\.codex";
const HOME_CLAUDE = "C:\\Users\\PC\\.claude";

export function mockRemote(): RemoteConfig {
  return {
    base_url: "https://api.dkby.com/v1",
    wire_api: "responses",
    default_model: "gpt-5.6-sol",
    recommended_models: [],
    claude_default_model: "claude-opus-4-8",
    claude_recommended_models: [],
    claude_opus_model: "claude-opus-4-8",
    claude_sonnet_model: "claude-sonnet-4-6",
    claude_haiku_model: "claude-haiku-4-5-20251001",
    min_client_version: "",
    notice: "",
    write_mode: "provider_table",
  };
}

export function mockProfiles(s: Scenario): Profile[] {
  if (s === "fresh") return [];
  const base = [
    { id: "p1", name: "主号", maskedKey: "sk-••••••••a1b2", hasKey: true,
      codexModel: "gpt-5.3-codex", codexEffort: "medium", claudeModel: "claude-opus-4-8", gatewayTokenId: 1 },
    { id: "p2", name: "测试号", maskedKey: "sk-••••••••c3d4", hasKey: true,
      codexModel: "gpt-5-codex-mini", codexEffort: "low", claudeModel: "claude-haiku-4-5-20251001", gatewayTokenId: null },
  ];
  return base;
}

export function mockState(): AppState {
  return {
    profiles: [],
    ignoreProxy: false,
    cleanupResidue: true,
    lastConfiguredAt: "",
  };
}

export function mockBackups(s: Scenario): BackupEntry[] {
  if (s === "fresh" || s === "nocodex") return [];
  return [
    { id: "20260918-181530", created_at: "2026-09-18 18:15:30", has_config: true, has_auth: true, has_claude: true },
    { id: "20260918-174402", created_at: "2026-09-18 17:44:02", has_config: true, has_auth: true, has_claude: false },
  ];
}

export function mockEnv(s: Scenario): Environment {
  const claudeConfigured = {
    homeExists: true,
    home: HOME_CLAUDE,
    settingsState: "ok" as const,
    currentBaseUrl: "https://api.dkby.com",
    currentModel: "claude-opus-4-8",
    managedByUs: true,
    activeProfileId: "p1",
  };
  const claudeFresh = {
    homeExists: true,
    home: HOME_CLAUDE,
    settingsState: "ok" as const,
    currentBaseUrl: null,
    currentModel: null,
    managedByUs: false,
    activeProfileId: null,
  };

  switch (s) {
    case "configured":
      return {
        codex: {
          homeExists: true,
          home: HOME_CODEX,
          configState: "ok",
          authState: "ApiKeyOnly",
          currentBaseUrl: "https://api.dkby.com/v1",
          currentModel: "gpt-5.3-codex",
          currentReasoningEffort: "medium",
          residue: [],
          managedByUs: true,
          activeProfileId: "p1",
        },
        claude: claudeConfigured,
      };

    case "fresh":
      return {
        codex: {
          homeExists: true,
          home: HOME_CODEX,
          configState: "missing",
          authState: "Missing",
          currentBaseUrl: null,
          currentModel: null,
          currentReasoningEffort: null,
          residue: [],
          managedByUs: false,
          activeProfileId: null,
        },
        claude: claudeFresh,
      };

    case "legacy":
      return {
        codex: {
          homeExists: true,
          home: HOME_CODEX,
          configState: "ok",
          authState: "OfficialLogin",
          currentBaseUrl: "https://api.dkby.com/v1",
          currentModel: "gpt-5.6-sol",
          currentReasoningEffort: "high",
          residue: ["14 行多余的空行", "2 行末尾有多余空格", "早期版本留下的设置"],
          managedByUs: false,
          activeProfileId: null,
        },
        claude: claudeFresh,
      };

    case "broken":
      return {
        codex: {
          homeExists: true,
          home: HOME_CODEX,
          configState: { broken: "TOML parse error at line 42, column 8\n  |\n42 | model = \"unclosed\n  |         ^\ninvalid basic string" },
          authState: "ApiKeyOnly",
          currentBaseUrl: null,
          currentModel: null,
          currentReasoningEffort: null,
          residue: [],
          managedByUs: false,
          activeProfileId: null,
        },
        claude: {
          ...claudeFresh,
          settingsState: { broken: "expected `,` or `}` at line 6 column 3" },
        },
      };

    case "nocodex":
      return {
        codex: {
          homeExists: false,
          home: HOME_CODEX,
          configState: "missing",
          authState: "Missing",
          currentBaseUrl: null,
          currentModel: null,
          currentReasoningEffort: null,
          residue: [],
          managedByUs: false,
          activeProfileId: null,
        },
        claude: { ...claudeFresh, homeExists: false },
      };
  }
}

export function mockTokens(): GatewayToken[] {
  return [
    { id: 1, name: "默认令牌", usable: true, note: "", linkedProfile: "主号" },
    { id: 2, name: "Codex 专用", usable: true, note: "", linkedProfile: null },
    { id: 3, name: "新令牌", usable: true, note: "", linkedProfile: null },
    { id: 4, name: "旧的测试令牌", usable: false, note: "已停用", linkedProfile: null },
  ];
}

export function mockTest(): TestResult {
  // 网关 /v1/models 返回的是这个 Key 能用的全部模型，跨厂商混在一起
  const models = [
    "gpt-6-astra", "gpt-5.6-sol", "gpt-5.3-codex", "gpt-5.1-codex-max", "gpt-5",
    "claude-opus-4-8", "claude-opus-4-8-thinking", "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "gemini-2.5-pro", "deepseek-v3", "qwen3-max", "glm-4.6",
  ];
  return { ok: true, message: `连上了，可以用 ${models.length} 个模型`, models };
}

export function mockApply(req: ApplyRequest): ApplyResult {
  return {
    backupId: "20260918-183012",
    wroteCodexConfig: req.configureCodex,
    wroteCodexAuth: req.configureCodex,
    wroteClaudeSettings: req.configureClaude,
    paths: [
      ...(req.configureCodex
        ? [`${HOME_CODEX}\\config.toml`, `${HOME_CODEX}\\auth.json`]
        : []),
      ...(req.configureClaude ? [`${HOME_CLAUDE}\\settings.json`] : []),
    ],
    warnings: ["检测到官方 ChatGPT 登录，已为你保留（密钥写在 config.toml 的 provider 段里）"],
  };
}
