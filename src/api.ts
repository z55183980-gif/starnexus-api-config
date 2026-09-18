import { invoke } from "@tauri-apps/api/core";
import * as mock from "./mock";
import type {
  AppState,
  ApplyRequest,
  ApplyResult,
  BackupEntry,
  Environment,
  GatewayToken,
  ImportResult,
  Profile,
  SaveProfileRequest,
  RemoteConfig,
  TestResult,
} from "./types";

// 每个分支都由 import.meta.env.DEV 直接守卫。
// 生产构建里它会被替换成字面量 false，整段模拟代码连同 ./mock 一起被摇掉。
const DEV = import.meta.env.DEV;
const S = DEV ? mock.activeScenario() : null;

export const scanEnvironment = (baseUrl?: string): Promise<Environment> =>
  DEV && S
    ? Promise.resolve(mock.mockEnv(S))
    : invoke<Environment>("scan_environment", { baseUrl: baseUrl ?? null });

export const loadAppState = (): Promise<AppState> =>
  DEV && S ? Promise.resolve(mock.mockState()) : invoke<AppState>("load_app_state");

export const listProfiles = (): Promise<Profile[]> =>
  DEV && S ? Promise.resolve(mock.mockProfiles(S)) : invoke<Profile[]>("list_profiles");

export const saveProfile = (req: SaveProfileRequest): Promise<string> =>
  DEV && S ? Promise.resolve(req.id || "p-new") : invoke<string>("save_profile", { req });

export const deleteProfile = (id: string): Promise<void> =>
  DEV && S ? Promise.resolve() : invoke<void>("delete_profile", { id });

export const getRemoteConfig = (ignoreProxy: boolean): Promise<RemoteConfig> =>
  DEV && S
    ? Promise.resolve(mock.mockRemote())
    : invoke<RemoteConfig>("get_remote_config", { ignoreProxy });

export const testConnection = (
  baseUrl: string,
  apiKey: string,
  ignoreProxy: boolean,
): Promise<TestResult> =>
  DEV && S
    ? Promise.resolve(mock.mockTest())
    : invoke<TestResult>("test_connection", { baseUrl, apiKey, ignoreProxy });

/** 用已保存的 Key 测试，密钥不经过前端 */
export const testProfileConnection = (
  profileId: string,
  baseUrl: string,
  ignoreProxy: boolean,
): Promise<TestResult> =>
  DEV && S
    ? Promise.resolve(mock.mockTest())
    : invoke<TestResult>("test_profile_connection", { profileId, baseUrl, ignoreProxy });

// ——— 登录取 Key。登录态只在后端内存里，前端只拿得到用户名和掩码 ———

export const gatewayLogin = (
  baseUrl: string,
  username: string,
  password: string,
  ignoreProxy: boolean,
): Promise<string> =>
  DEV && S
    ? Promise.resolve(username || "demo")
    : invoke<string>("gateway_login", { baseUrl, username, password, ignoreProxy });

export const gatewayLogout = (): Promise<void> =>
  DEV && S ? Promise.resolve() : invoke<void>("gateway_logout");

export const gatewayCurrentUser = (): Promise<string | null> =>
  DEV && S ? Promise.resolve(null) : invoke<string | null>("gateway_current_user");

export const gatewayListTokens = (): Promise<GatewayToken[]> =>
  DEV && S ? Promise.resolve(mock.mockTokens()) : invoke<GatewayToken[]>("gateway_list_tokens");

/** 取回明文并直接存进密钥库，返回掩码 */
export const gatewayAdoptToken = (profileId: string, tokenId: number): Promise<string> =>
  DEV && S
    ? Promise.resolve("sk-••••••••ab12")
    : invoke<string>("gateway_adopt_token", { profileId, tokenId });

/** 一次登录批量导入多把 Key，每把存成一条 */
export const gatewayImportTokens = (tokenIds: number[]): Promise<ImportResult> =>
  DEV && S
    ? Promise.resolve({ created: ["Codex 专用"], updated: ["主号"], unchanged: [], skipped: [] })
    : invoke<ImportResult>("gateway_import_tokens", { tokenIds });

export const listBackups = (): Promise<BackupEntry[]> =>
  DEV && S ? Promise.resolve(mock.mockBackups(S)) : invoke<BackupEntry[]>("list_backups");

export const restoreBackup = (id: string): Promise<void> =>
  DEV && S ? Promise.resolve() : invoke<void>("restore_backup", { id });

export const applyConfig = (req: ApplyRequest): Promise<ApplyResult> =>
  DEV && S ? Promise.resolve(mock.mockApply(req)) : invoke<ApplyResult>("apply_config", { req });

export const rebuildMinimalConfig = (req: ApplyRequest): Promise<ApplyResult> =>
  DEV && S
    ? Promise.resolve(mock.mockApply(req))
    : invoke<ApplyResult>("rebuild_minimal_config", { req });

export const revertToOfficial = (codex: boolean, claude: boolean): Promise<string> =>
  DEV && S
    ? Promise.resolve("20260918-183012")
    : invoke<string>("revert_to_official", { codex, claude });
