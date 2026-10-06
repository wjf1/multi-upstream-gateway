// =============================================================================
// Freebuff Provider 配置解析（T201）
// -----------------------------------------------------------------------------
// 对应 Go 原版 Quorinex/Freebuff2API@a1c1035：
//   - config.go:60-85   loadConfig 的最终 Config（含 normalizeUpstreamBaseURL）
//   - config.go:87-103  normalizeUpstreamBaseURL（codebuff.com → www.codebuff.com）
//   - config.go:144-174 splitList / compactStrings / dedupeStrings
//   - config.go:185-203 generateUserAgent / generateClientSessionId
//
// 与底座 commandcode 的差异（刻意的）：
//   - 本模块的配置解析**不做模块加载期求值**（commandcode 的 CONFIG_FILE_PATH
//     在 import 时固化，导致测试必须先设 env 再动态 import）。Freebuff 的
//     initialize(config) 每次从传入的 config 分片 + 当前 process.env 求值，
//     因此可静态 import、可反复 initialize，测试与热重载都更稳。
//   - Token 只从 FREEBUFF_TOKENS 读取；config.json 分片仅承载非凭据字段
//     （§3.7-2；FreebuffConfigSchema 的 superRefine 会拒绝 token 形状的键）。
// =============================================================================

import { logger } from '../../utils/logger.js';
import type { FreebuffConfig } from './types.js';

/** models.go:18 freeAgentsSourceURL —— 远程 agent→model 目录源。 */
export const FREE_AGENTS_SOURCE_URL =
  'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/free-agents.ts';

/** config.go:108 UpstreamBaseURL 默认值。 */
export const DEFAULT_FREEBUFF_API_BASE = 'https://www.codebuff.com';

/** config.go:109 ROTATION_INTERVAL 默认 6h。 */
export const DEFAULT_FREEBUFF_ROTATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** config.go:110 REQUEST_TIMEOUT 默认 15m。 */
export const DEFAULT_FREEBUFF_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/** config.go:186 generateUserAgent —— 与官方 ai-sdk openai-compatible 客户端同 UA。 */
export const FREEBUFF_USER_AGENT = 'ai-sdk/openai-compatible/1.0.25/codebuff';

/** Token 环境变量名（逗号 / 换行分隔）。 */
export const FREEBUFF_TOKENS_ENV = 'FREEBUFF_TOKENS';

/** 追加 SSRF 白名单所用的环境变量（与 config.ts hostInExtraAllowlist 同源）。 */
export const UPSTREAM_ALLOWED_HOSTS_ENV = 'COMMANDCODE_UPSTREAM_ALLOWED_HOSTS';

// ─── 列表解析（config.go:144-174）────────────────────────────────────────────

/** config.go:144 splitList —— 按 , \n \r 切分并去空白项。 */
export function splitList(value: string): string[] {
  return String(value ?? '')
    .split(/[,\n\r]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** config.go:163 dedupeStrings —— 保序去重。 */
export function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 读取 FREEBUFF_TOKENS（逗号/换行分隔，保序去重）。空值返回 []。 */
export function loadFreebuffTokens(env: NodeJS.ProcessEnv = process.env): string[] {
  return dedupeStrings(splitList(env[FREEBUFF_TOKENS_ENV] ?? ''));
}

// ─── 基址归一化（config.go:87-103）───────────────────────────────────────────

/** config.go:87 normalizeUpstreamBaseURL —— 去尾斜杠；codebuff.com → www.codebuff.com。 */
export function normalizeUpstreamBaseUrl(raw: string): string {
  let trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() === 'codebuff.com') parsed.hostname = 'www.codebuff.com';
    trimmed = parsed.toString().replace(/\/+$/, '');
  } catch {
    // 保留原值（与 Go url.Parse 失败时的行为一致：返回原始字符串）。
  }
  return trimmed;
}

// ─── 配置合成 ────────────────────────────────────────────────────────────────

function readPositiveInt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

function readNonEmptyString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 把 unified config 的 freebuff 分片 + 环境变量合成运行配置。
 *
 * 分片字段（FreebuffConfigSchema）：enabled / apiBase / modelRegistryUrl /
 * rotationIntervalMs / requestTimeoutMs / userAgent。
 * Token 永远取自 FREEBUFF_TOKENS —— 分片里即便出现也不会被采纳。
 */
export function resolveFreebuffConfig(
  shard: unknown,
  env: NodeJS.ProcessEnv = process.env,
): FreebuffConfig {
  const source: Record<string, unknown> =
    shard && typeof shard === 'object' && !Array.isArray(shard)
      ? (shard as Record<string, unknown>)
      : {};

  const apiBase = normalizeUpstreamBaseUrl(readNonEmptyString(source, 'apiBase') ?? DEFAULT_FREEBUFF_API_BASE);

  return {
    apiBase: apiBase || DEFAULT_FREEBUFF_API_BASE,
    modelRegistryUrl: readNonEmptyString(source, 'modelRegistryUrl') ?? FREE_AGENTS_SOURCE_URL,
    tokens: loadFreebuffTokens(env),
    rotationIntervalMs:
      readPositiveInt(source, 'rotationIntervalMs') ?? DEFAULT_FREEBUFF_ROTATION_INTERVAL_MS,
    requestTimeoutMs:
      readPositiveInt(source, 'requestTimeoutMs') ?? DEFAULT_FREEBUFF_REQUEST_TIMEOUT_MS,
    userAgent: readNonEmptyString(source, 'userAgent') ?? FREEBUFF_USER_AGENT,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
  };
}

// ─── SSRF 白名单自注册 ───────────────────────────────────────────────────────

/**
 * 把本 Provider 的上游 host 追加进 COMMANDCODE_UPSTREAM_ALLOWED_HOSTS。
 *
 * 背景：底座 safe-fetch.ts 是 fail-closed 的 SSRF 守卫，默认只放行
 * commandcode.ai；所有出站请求（含 Freebuff 的 apiBase 与模型注册表）都必须
 * 过 assertSafeUpstreamUrl。T201 不改底座默认策略（config.ts 未列入本卡范围），
 * 改由 Provider 在 initialize 时把自己的 host 声明进白名单——与运维手工
 * 配置同一入口，语义等价、行为可审计。
 *
 * 建议 T213/T305 收敛：在统一配置层集中登记各 Provider 声明的上游 host。
 *
 * @returns 本次实际新增的 host（已存在的不会重复写入）。
 */
export function registerUpstreamHosts(
  urls: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const existing = new Set(splitList(env[UPSTREAM_ALLOWED_HOSTS_ENV] ?? '').map((h) => h.toLowerCase()));
  const added: string[] = [];
  for (const raw of urls) {
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
      continue;
    }
    if (!host || existing.has(host)) continue;
    existing.add(host);
    added.push(host);
  }
  if (added.length > 0) {
    env[UPSTREAM_ALLOWED_HOSTS_ENV] = Array.from(existing).join(',');
    logger.info(`[PVD:freebuff] registered upstream host(s) into SSRF allowlist: ${added.join(', ')}`);
  }
  return added;
}

// ─── 客户端会话 ID（config.go:189-203）───────────────────────────────────────

/** config.go:189 generateClientSessionId —— Math.random().toString(36).slice(2,15) 同构。 */
export function generateClientSessionId(): string {
  return Math.random().toString(36).substring(2, 15);
}
