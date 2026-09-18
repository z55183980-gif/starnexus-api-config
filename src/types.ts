// 与 Rust 侧结构保持一致

export type ConfigState = "missing" | "ok" | { broken: string };
export type SettingsState = "missing" | "ok" | { broken: string };

export type AuthState = "Missing" | "OfficialLogin" | "ApiKeyOnly" | "Unparsable";

export interface Profile {
  id: string;
  name: string;
  maskedKey: string;
  hasKey: boolean;
  codexModel: string;
  codexEffort: string;
  claudeModel: string;
}

export interface GatewayToken {
  id: number;
  name: string;
  usable: boolean;
  note: string;
  /** 已导入过就是本地那条的名字，界面据此显示「更新」而不是勾选 */
  linkedProfile: string | null;
}

export interface ImportResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  skipped: string[];
}

export interface SaveProfileRequest {
  id: string;
  name: string;
  apiKey: string;
  codexModel: string;
  codexEffort: string;
  claudeModel: string;
}

export interface CodexEnv {
  homeExists: boolean;
  home: string;
  configState: ConfigState;
  authState: AuthState;
  currentBaseUrl: string | null;
  currentModel: string | null;
  currentReasoningEffort: string | null;
  residue: string[];
  managedByUs: boolean;
  activeProfileId: string | null;
}

export interface ClaudeEnv {
  homeExists: boolean;
  home: string;
  settingsState: SettingsState;
  currentBaseUrl: string | null;
  currentModel: string | null;
  managedByUs: boolean;
  activeProfileId: string | null;
}

export interface Environment {
  codex: CodexEnv;
  claude: ClaudeEnv;
}

export interface RemoteConfig {
  base_url: string;
  wire_api: string;
  default_model: string;
  recommended_models: string[];
  claude_default_model: string;
  claude_recommended_models: string[];
  claude_opus_model: string;
  claude_sonnet_model: string;
  claude_haiku_model: string;
  min_client_version: string;
  notice: string;
  write_mode: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
  models: string[];
}

export interface BackupEntry {
  id: string;
  created_at: string;
  has_config: boolean;
  has_auth: boolean;
  has_claude: boolean;
}

export interface AppState {
  profiles: Profile[];
  ignoreProxy: boolean;
  cleanupResidue: boolean;
  lastConfiguredAt: string;
}

export interface ApplyRequest {
  profileId: string;
  baseUrl: string;
  wireApi: string;
  ignoreProxy: boolean;

  configureCodex: boolean;
  model: string;
  reasoningEffort: string;
  cleanupResidue: boolean;
  overwriteOfficialAuth: boolean;
  conservative: boolean;

  configureClaude: boolean;
  claudeModel: string;
  claudeOpusModel: string;
  claudeSonnetModel: string;
  claudeHaikuModel: string;
}

export interface ApplyResult {
  backupId: string;
  wroteCodexConfig: boolean;
  wroteCodexAuth: boolean;
  wroteClaudeSettings: boolean;
  paths: string[];
  warnings: string[];
}

export function isBroken(s: ConfigState | SettingsState): s is { broken: string } {
  return typeof s === "object" && s !== null && "broken" in s;
}
