// =============================================================================
// 上游 URL 安全校验（SSRF 加固）
// -----------------------------------------------------------------------------
// 自 config.ts 原样搬出（架构 Phase 1 拆分），公共行为零变化。
// 依赖方向：仅依赖 node 内置模块（net / dns），无项目内依赖，单向无环。
// COMMANDCODE_UPSTREAM_ALLOWED_HOSTS 环境变量的读取逻辑（hostInExtraAllowlist）
// 随函数一并搬至本文件。
//
// 所有服务端发起的上游请求（fetch / 用量统计 / 模型同步 / pricing 页）都必须
// 先经过 assertSafeUpstreamUrl 校验，防止：
//   - 注入非 http(s) 协议（file:、gopher: 等协议混淆）
//   - 在 URL 内嵌凭据（user:pass@host）
//   - 访问任意非授权主机（SSRF）
// 默认只允许 commandcode.ai 及其子域 + 回环地址；若用户配置了自建网关/镜像，
// 可通过环境变量 COMMANDCODE_UPSTREAM_ALLOWED_HOSTS 追加允许的 host（逗号分隔）。
//
// ── 4.22.4 移植说明（Phase D1）───────────────────────────────────────────────
// 本文件在 4.22.4 上是"上游 URL 安全校验（SSRF 加固）"的家（自 config.ts 拆出）。
// T105 的安全中间件链（请求 ID 传播 / modelAccess / 限流 / 请求完成日志）在参照树
// 里同名同址，故一并收在本文件：SSRF 函数保持原样，T105 链追加在文件末尾。二者
// 职责独立、互不引用。
// =============================================================================
import net from 'net';
import dns from 'dns';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, ProxyError } from './errors.js';
import { resolveRequestId } from './request-context.js';
import { sanitizeLog } from './sanitize.js';
import { logger } from './logger.js';
import { getDefaultRateLimiter, type RateLimiter, type RateLimitDecision } from './rate-limiter.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

function normalizeHost(hostname: string): string {
  // 去掉首尾空白、IPv6 方括号、前导/尾随点，统一小写。
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^\.+/, '').replace(/\.+$/, '');
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * 判断 host 是否是环回、私有或保留地址（IP 字面量）。这些内网/特殊地址默认一律
 * 拒绝，避免 SSRF 把请求导向本机、云元数据或内网；除非运维显式加入允许清单。
 * 非 IP 字面量（如域名）由 allowlist 判定，不在此处拦截。
 */
function isPrivateOrReserved(host: string): boolean {
  if (isLoopback(host)) return true;
  // IPv6：ULA fc00::/7、链路本地 fe80::/10 视为私有/保留
  if (host.includes(':')) {
    const h = host.toLowerCase();
    const fb = h.slice(0, 2);
    if (fb === 'fc' || fb === 'fd') return true;
    if (fb === 'fe') {
      const third = h.slice(2, 3);
      return third >= '8' && third <= 'b'; // fe80::/10 - febf::/10
    }
    return false;
  }
  // IPv4
  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 10) return true;                        // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true;                       // 127.0.0.0/8 回环
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试保留
    if (a === 0 || a >= 224) return true;             // 0.0.0.0/8、224/4(组播)、240/4(保留) 等
    return false;
  }
  return false;
}

function hostInExtraAllowlist(host: string): boolean {
  const extra = (process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS || '')
    .split(',')
    .map(s => normalizeHost(s))
    .filter(Boolean);
  return extra.some(e => host === e || host.endsWith('.' + e));
}

function isDefaultAllowedHost(host: string): boolean {
  // commandcode.ai 及其子域
  const sub = host.split('.').slice(-2).join('.');
  return host === 'commandcode.ai' || sub === 'commandcode.ai';
}

export function isAllowedUpstreamHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  // 环回/私有/保留地址默认拒绝，仅当运维显式加入允许清单时放行（自建网关/镜像/本地 mock）。
  if (isPrivateOrReserved(host)) return hostInExtraAllowlist(host);
  if (isDefaultAllowedHost(host)) return true;
  return hostInExtraAllowlist(host);
}

/**
 * 校验并返回一个可安全用于服务端 fetch 的 URL。
 * 不满足条件时抛错（fail-closed），调用方应据此拒绝请求而不是降级执行。
 * base 用于解析相对 URL（重定向 Location 场景）。
 */
export function assertSafeUpstreamUrl(rawUrl: string, base?: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(rawUrl), base);
  } catch (e: any) {
    throw new Error(`[NET] Invalid upstream URL: ${e?.message || 'parse error'}`, { cause: e });
  }
  if (url.username || url.password) {
    throw new Error('[NET] Upstream URL must not embed credentials');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`[NET] Upstream URL must be http(s), got '${url.protocol}'`);
  }
  const host = normalizeHost(url.hostname);
  if (!host) throw new Error('[NET] Upstream URL has no host');
  const loopback = isLoopback(host);
  const privateOrReserved = isPrivateOrReserved(host);
  const explicitlyAllowed = hostInExtraAllowlist(host);
  // 环回/私有/保留地址（含 localhost、127.x、10.x、169.254.x、192.168.x、172.16-31.x、
  // IPv6 ULA/链路本地）默认拒绝，除非运维显式加入允许清单。
  if (privateOrReserved && !explicitlyAllowed) {
    throw new Error(`[NET] Upstream host is private/loopback and not allowlisted: ${host}`);
  }
  // 非环回强制 https（避免降级到明文）；环回且显式放行时才允许 http（用于本地 mock/自建网关）。
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('[NET] Non-loopback upstream must use https (got http)');
  }
  if (!isAllowedUpstreamHost(host)) {
    throw new Error(`[NET] Upstream host is not allowed: ${host}`);
  }
  return url;
}

/**
 * 校验重定向目标（Wave 3 SSRF）：在 assertSafeUpstreamUrl 基线之上，强制拒绝
 * 私网/回环/保留地址（含 169.254.169.254 等云元数据）。重定向是唯一能绕过
 * "初始 URL 校验"的通道——即使主机被 COMMANDCODE_UPSTREAM_ALLOWED_HOSTS 显式
 * 放行，也不得作为重定向目标。本规则 fail-closed 且不提供任何开关。
 */
export function assertSafeUpstreamRedirectTarget(rawUrl: string, base?: string | URL): URL {
  const url = assertSafeUpstreamUrl(rawUrl, base);
  if (isPrivateOrReserved(normalizeHost(url.hostname))) {
    throw new Error(`[NET] Redirect target is private/loopback/reserved and can never be followed: ${url.hostname}`);
  }
  return url;
}

/**
 * Wave 3（DNS rebinding）：请求前解析上游域名并校验解析结果。assertSafeUpstreamUrl
 * 只能校验 URL 字面里的 host——攻击者控制的域名可以先解析到公网 IP 通过校验，实际
 * 请求时再解析到内网地址（DNS rebinding）。默认 on；DNS_REBINDING_GUARD=off 显式回退。
 * 跳过解析校验的三类 host（无 rebinding 可能或已显式信任）：
 *   - IP 字面量（安全性由 assertSafeUpstreamUrl + allowlist 决定）
 *   - localhost 等回环主机（恒解析为回环，是本地 mock / 自建网关的合法形态）
 *   - COMMANDCODE_UPSTREAM_ALLOWED_HOSTS 命中的主机（运维显式信任即显式放行）
 * 残余风险（已知且刻意接受）：lookup 与 fetch 真正建连之间存在 TOCTOU 窗口，彻底
 * 封闭需要固定解析结果建连（自定义 undici Agent），当前按"请求前校验"档位实现。
 */
export async function assertSafeUpstreamDns(rawUrl: string): Promise<void> {
  if ((process.env.DNS_REBINDING_GUARD || '').trim().toLowerCase() === 'off') return;
  const url = new URL(String(rawUrl));
  const host = normalizeHost(url.hostname);
  if (!host || net.isIP(host) || isLoopback(host) || hostInExtraAllowlist(host)) return;
  const addresses = await dns.promises.lookup(host, { all: true });
  const bad = addresses.find(a => isPrivateOrReserved(normalizeHost(a.address)));
  if (bad) {
    throw new Error(
      `Upstream host '${host}' resolves to private/reserved address ${bad.address} ` +
      `(DNS rebinding guard; set DNS_REBINDING_GUARD=off to skip)`,
    );
  }
}

// =============================================================================
// 以下为 T105 安全中间件链（执行依据 master-plan v1.2 §3.7-1/3/5）
// -----------------------------------------------------------------------------
// /v1/* 的纵深防御入口，在底座批次 B（ADMIN_API_TOKEN / Host 回环白名单 /
// OAuth state / CSP）之上补数据面三件：
//
//   onRequest   请求 ID —— resolveRequestId()（复用 request-context 的 header
//               提取机制）：客户端合法 x-request-id 透传复用，否则入口生成
//               crypto.randomUUID()；写响应头 X-Request-Id，供日志/用量记录/
//               审计全链路关联。
//
//   preHandler  ① modelAccess（§3.2）：blocklist 命中或 allowlist 非空未命中
//               → 403 MODEL_ACCESS_DENIED（OpenAI/Anthropic 信封均用
//               permission_error）；
//               ② 限流（§3.7-1）：全局桶（进程级保护）→ per-provider 桶
//               （各上游独立，互不误伤），超限 → 429 + Retry-After。
//
//   onResponse  请求完成日志（method/路径/状态/耗时/requestId，经 sanitizeLog）。
//
// per-provider 预判（T213 前的过渡实现）：路由核心 RequestRouter.route() 属
// T104 交付且尚未接入 /v1 路由（T213 统一 API 层接线），此处按
// `X-Upstream-Provider` header → 模型名前缀（codebuddy 等）→ 'default' 兜底
// **预判** provider 桶；T213 接线后换正式 decision.provider，本函数收敛为
// 单一事实来源。配置同理：限流/modelAccess 读 UnifiedConfig 的路径在 T213
// 收口，当前以 env 兜底（见 rate-limiter.ts / resolveModelAccessConfigFromEnv）。
//
// 4.22.4 适配差异（相对参照树）：
//   * estimateTokensForRateLimit 改为本地 CJK 感知实现（原参照树从
//     adapters/commandcode/upstream.ts import estimateTextTokens），避免
//     security-guard → adapters → safe-fetch → config → security-guard 的
//     循环导入。口径一致（CJK 逐字计 1，其余 4 字符 ≈ 1 token）。
//   * 4.22.4 已有**路由内**的 guardRateLimit/guardModelAccess（util/rate-limit.ts、
//     util/model-access.ts，env 名 RATE_LIMIT_RPM/TPM、MODEL_ALLOWLIST/BLOCKLIST），
//     与本链的 env 名（RATE_LIMIT_GLOBAL_*、MODEL_ACCESS_*）不重叠，可安全并存；
//     两套配置源的收口点记录在移植报告（T213 统一配置收口）。
// =============================================================================

/** 与 router.ts 的 UPSTREAM_PROVIDER_HEADER 同值（router 为 T104 交付禁改，此处自持常量）。 */
export const UPSTREAM_PROVIDER_HEADER = 'x-upstream-provider';

/** 模型名路由前缀 → provider（与 router.ts 的 PREFIX_TO_PROVIDER 同表）。 */
const PREFIX_TO_PROVIDER: Readonly<Record<string, string>> = {
  commandcode: 'commandcode',
  freebuff: 'freebuff',
  workbuddy: 'workbuddy',
  codebuddy: 'workbuddy',
};

const VALID_PROVIDERS = new Set(['commandcode', 'freebuff', 'workbuddy']);

// ─── modelAccess（§3.2）───────────────────────────────────────────────────────

export interface ModelAccessConfig {
  allowlist: string[];
  blocklist: string[];
}

/** env 兜底（T213 收口前通道）：MODEL_ACCESS_ALLOW / MODEL_ACCESS_BLOCK（逗号分隔）。 */
export function resolveModelAccessConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelAccessConfig {
  const csv = (v?: string) => (v || '').split(',').map(s => s.trim()).filter(Boolean);
  return { allowlist: csv(env.MODEL_ACCESS_ALLOW), blocklist: csv(env.MODEL_ACCESS_BLOCK) };
}

function patternMatches(model: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p.endsWith('*')) return model.toLowerCase().startsWith(p.slice(0, -1));
  return model.toLowerCase() === p;
}

/**
 * 模型访问判定：blocklist 命中即拒（显式 deny 优先）；allowlist 非空时未命中即拒；
 * 两表皆空 = 全放行（默认零破坏）。模式支持尾部 `*` 通配（`glm-5*`）。
 */
export function isModelAllowed(model: string, cfg: ModelAccessConfig): boolean {
  const m = String(model || '').trim();
  if (!m) return true; // 空模型名不在此判定（由路由/上游错误路径处理）
  if (cfg.blocklist.some(p => patternMatches(m, p))) return false;
  if (cfg.allowlist.length > 0 && !cfg.allowlist.some(p => patternMatches(m, p))) return false;
  return true;
}

// ─── per-provider 预判（T213 前过渡）─────────────────────────────────────────

type HeaderBag = Record<string, string | string[] | undefined>;

function getHeader(headers: HeaderBag, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== want) continue;
    const v = headers[key];
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === 'string' && first.trim()) return first.trim();
  }
  return undefined;
}

/**
 * 限流桶的 provider 预判：`X-Upstream-Provider` header 优先（归一化为小写短
 * 标识后作为桶 key —— 已知 provider 名归一到标准名（codebuddy → workbuddy），
 * 其余非空安全值原样作独立桶 key：per-provider 桶由配置驱动，未配置的 key
 * 天然不限流，且「某个上游被点名打满不会误伤其它上游」）；其次模型名前缀
 * （仅认已知 provider 前缀）；预判不到回退 'default' 桶（对应 T213 正式决策里
 * priority 兜底的目标 provider）。
 */
export function predictProviderForRateLimit(headers: HeaderBag, body?: { model?: string }): string {
  const headerRaw = getHeader(headers, UPSTREAM_PROVIDER_HEADER);
  if (headerRaw) {
    // 只保留小写字母数字与 _-，截断 32 位：桶 key 会进日志，不接受任意字节。
    const normalized = headerRaw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    if (normalized) return PREFIX_TO_PROVIDER[normalized] ?? normalized;
  }
  const model = String(body?.model || '').trim();
  const slash = model.indexOf('/');
  if (slash > 0) {
    const provider = PREFIX_TO_PROVIDER[model.slice(0, slash).toLowerCase()];
    if (provider && VALID_PROVIDERS.has(provider)) return provider;
  }
  return 'default';
}

// ─── 中间件链接线 ─────────────────────────────────────────────────────────────

export interface SecurityGuardsOptions {
  /** 注入限流器（默认：进程单例，env 兜底配置）。 */
  rateLimiter?: RateLimiter;
  /** 注入 modelAccess 配置；null 显式禁用（默认：env 兜底解析）。 */
  modelAccess?: ModelAccessConfig | null;
}

function isAnthropicPath(url: string): boolean {
  return url.startsWith('/v1/messages');
}

function sendRateLimited(
  reply: FastifyReply,
  url: string,
  scope: string,
  verdict: RateLimitDecision,
): FastifyReply {
  const seconds = Math.max(1, verdict.retryAfterSeconds);
  const err = new ProxyError(
    ErrorCode.RATE_LIMIT,
    `Rate limit exceeded (scope: ${scope}). Retry after ${seconds} seconds.`,
    { context: { scope, retryAfterSeconds: seconds } },
  );
  reply.header('Retry-After', String(seconds));
  return reply
    .status(429)
    .send(isAnthropicPath(url) ? err.anthropicPayload() : { error: err.openAIPayload() });
}

/**
 * 请求体大小的输入 token 估算（与 usage 缺失兜底同口径：4 字符 ≈ 1 token，
 * CJK 逐字计 1）。本地实现以避免 security-guard → adapters → config 循环导入。
 */
function estimateTokensForRateLimit(body: unknown): number {
  if (body === null || body === undefined) return 0;
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    return 0;
  }
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * 在 Fastify 实例上挂载安全中间件链。须在 verifyProxyAuth **之前**注册：
 * 请求 ID 的 onRequest 钩子要先于鉴权执行，被 401 拒绝的请求才能带上
 * X-Request-Id 响应头；鉴权拒绝会短路生命周期，preHandler（限流/模型访问）
 * 自然不消耗预算。
 */
export function registerSecurityGuards(fastify: FastifyInstance, opts: SecurityGuardsOptions = {}): void {
  // onRequest：请求 ID 生成与传播（所有路径生成，X-Request-Id 响应头全路径可用，
  // /api/* 的审计与管理面排障同样受益）。
  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = resolveRequestId(req.headers as HeaderBag);
    (req as unknown as Record<string, unknown>).requestId = requestId;
    reply.header('X-Request-Id', requestId);
  });

  // preHandler：body 已解析（模型名/token 预估可用），鉴权已通过（拒绝路径不至此）。
  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/v1/') || req.method === 'OPTIONS') return;

    const body = req.body as { model?: string } | undefined;
    const model = typeof body?.model === 'string' ? body.model.trim() : '';

    // ① modelAccess（T106 风险门之后的第二道内容面闸门）。opts.modelAccess 为
    // null = 显式禁用（跳过判定）；未提供 = env 兜底解析。
    const modelAccess = opts.modelAccess !== undefined ? opts.modelAccess : resolveModelAccessConfigFromEnv();
    if (modelAccess && model && !isModelAllowed(model, modelAccess)) {
      const err = new ProxyError(
        ErrorCode.MODEL_ACCESS_DENIED,
        `Model "${model}" is denied by the gateway model access policy.`,
        { context: { model } },
      );
      return reply
        .status(err.status)
        .send(isAnthropicPath(req.url) ? err.anthropicPayload() : { error: err.openAIPayload() });
    }

    // ② 限流：全局桶 → per-provider 桶（预判；互不误伤）。
    const limiter = opts.rateLimiter ?? getDefaultRateLimiter();
    const tokens = estimateTokensForRateLimit(body);
    const globalVerdict = limiter.checkGlobal(tokens);
    if (!globalVerdict.allowed) {
      return sendRateLimited(reply, req.url, 'global', globalVerdict);
    }
    const provider = predictProviderForRateLimit(req.headers as HeaderBag, body);
    const providerVerdict = limiter.checkProvider(provider, tokens);
    if (!providerVerdict.allowed) {
      return sendRateLimited(reply, req.url, `provider:${provider}`, providerVerdict);
    }
  });

  // onResponse：请求完成日志（全链路 requestId；消息经 sanitizeLog，杜绝凭据入日志）。
  fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/v1/')) return;
    const stored = (req as unknown as Record<string, unknown>).requestId;
    const requestId = typeof stored === 'string' && stored ? stored : resolveRequestId(req.headers as HeaderBag);
    const ms = Math.max(0, Math.round((reply.elapsedTime ?? 0) * 1000));
    logger.info(
      sanitizeLog(`[REQUEST] ${req.method} ${req.url.split('?')[0]} -> ${reply.statusCode} (${ms}ms) requestId=${requestId}`),
    );
  });
}
