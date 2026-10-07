// =============================================================================
// 管理仪表盘（/api/* 后端接口；SPA 本体在 public/index.html）
// -----------------------------------------------------------------------------
// - 提供中文管理界面：概览、账号与鉴权、用量与额度、模型、实时日志五个标签页
// - /api/* 为管理员接口：状态、网关开关、日志、账号增删改、OAuth/手动登录、
//   用量聚合等
// - 安全要点：
//   * CORS 只对公共 API 表面（/v1/*、/health）开放；/api/* 不发 CORS 头，
//     防止浏览器里的随机网页驱动管理操作
//   * esc() 对所有动态渲染进 SPA 的 HTML 做转义，防止 XSS
// =============================================================================
import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { logger, LOG_FILE_PATH } from '../utils/logger.js';
import { getUpdateState } from '../utils/update-check.js';
import { getProjectRootDir, readRawConfigFile, saveConfigFile } from '../utils/config.js';
import { isSameOriginIfPresent } from './sse-common.js';
import { ADMIN_CSP, adminTokenOk, injectAdminTokenMeta, isLoopbackHostHeader } from '../utils/admin-guard.js';
import { registerAuditLog } from '../utils/audit-log.js';
import { acceptRiskDisclaimer, isRiskDisclaimerAccepted } from '../utils/risk-gate.js';
import {
  loadConfig,
  resolveBodyLimit,
  CONFIG_FILE_PATH,
  getGatewayRunning,
  setGatewayRunning,
  loginNewAccount,
  startBrowserLoginFlow,
  logoutAccount,
  setActiveAccount,
  setRotationMode,
  fetchLiveUsageStatsCached,
  getActiveApiKey,
  defaultAccountName,
} from '../utils/config.js';
import { getCachedModels, MODELS_FILE_PATH } from '../utils/models.js';
import { planName, planTier } from '../utils/plans.js';
import { PROXY_VERSION } from '../utils/version.js';
import { getUsageHistory, getUsageStats, clearUsageHistory, describeBillingWindow, getTimeOfDayModels, USAGE_FILE_PATH, getTodaySpendUsd, summarizeByProvider } from '../utils/usage-store.js';
import { getQuotaProjection } from '../utils/quota-tracker.js';
import { notify } from '../utils/notifier.js';
import { getChannelHealth } from '../utils/health-check.js';
import { webhookEnabled } from '../utils/webhook-alerts.js';
import { resolvePromptsDir } from '../utils/prompt-versions.js';
import type { AccountInfo } from '../types/index.js';
import type { ProviderName } from '../providers/core/interface.js';

const startTimestamp = Date.now();

/** ?limit= 的封顶值：足够取回轮转窗口内的全部记录，又不至于让单次响应无界。 */
const HISTORY_EXPORT_MAX = 50000;

/**
 * apiKey → 展示用掩码。四处出接口（accounts 列表、manual-login、browser-login、
 * aggregate）此前各自复制同一表达式；漏掉一处就等于把明文 bearer token 发进 HTTP
 * 响应体（browser-login 正是这么漏的），所以收口成单点。
 */
export function maskApiKey(apiKey?: string | null): string {
  return apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : 'None';
}

/**
 * AccountInfo → 可安全出接口的形状。凭据是在这里被结构性摘掉的，而不是靠每个
 * 端点自己记得解构 —— 新增端点不会再复现 browser-login 那类漏口。
 */
function toSafeAccount(acc: AccountInfo) {
  const { apiKey, ...rest } = acc;
  return { ...rest, apiKeyMasked: maskApiKey(apiKey) };
}

// ─── 运行能力开关只读视图（/api/features）────────────────────────────────────
// 4.21.0 引入的一批默认关闭/旁路运行能力（健康检查、webhook 告警、prompt 版本、
// 限流、模型访问控制、审计日志）此前只在日志里可见；本端点把它们的当前判定集中
// 成一个只读快照供概览页展示。判定逻辑与各能力模块"调用时读 env"的写法逐条对齐
// （各辅助函数注明来源模块），同样不做缓存 —— env 改了即生效。
//
// 安全边界：绝不返回 WEBHOOK_URL 本身（内含内网地址与 token 参数），只回 enabled；
// API key、账号凭据等敏感值本端点不触碰。模型名单（allowlist/blocklist）非敏感，
// 原样回显生效名单。

/** 读取非负整数 env；未设置/非法回退默认值（与 utils/health-check.ts 的 readEnvInt 保持一致）。 */
function readEnvIntDefault(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 读取正整数 env；未设置/非法返回 undefined（与 utils/rate-limit.ts 的 intEnv 保持一致）。 */
function readEnvIntStrict(name: string): number | undefined {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 读取浮点 env；未设置/非法返回 NaN（与 utils/webhook-alerts.ts 的 readEnvFloat 保持一致）。 */
function readEnvFloatLike(name: string): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** 逗号分隔名单：trim + 小写化 + 去空项（与 utils/model-access.ts 的 parseList 保持一致）。 */
function parseEnvList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export async function dashboardRoutes(fastify: FastifyInstance) {
  // T105：/api/* 全部写操作落审计日志（audit-log.jsonl：时间/类别/目标/来源 IP/
  // requestId/结果，不落正文与凭据；被 token 校验拒绝的写操作同样留痕）。
  registerAuditLog(fastify);

  // 仅对公共 API 表面（/v1/*）开放 CORS。管理 /api/* 路由不发 CORS 头，
  // 这样浏览器里的随机网页就无法驱动它们。
  fastify.addHook('onRequest', async (req, reply) => {
    const routePath = req.url.split('?')[0];
    const isAdminApi = routePath.startsWith('/api/');
    const isDashboardPage = routePath === '/';

    if (req.url.startsWith('/v1/') || req.url === '/health') {
      reply.header('Access-Control-Allow-Origin', '*');
    }

    // B2：页面与 /api/* 只认回环 Host（或 ADMIN_ALLOWED_HOSTS 显式放行的名字）。
    // 这是旧防线缺的那一环：isSameOriginIfPresent 比的 host 来自请求头本身，
    // DNS rebinding 下 Origin 与 Host 天然自洽，检查形同不存在。
    if ((isAdminApi || isDashboardPage) && !isLoopbackHostHeader(req.headers.host as string | undefined)) {
      return reply.status(403).send({ error: 'Host not allowed for admin surface' });
    }

    // 防跨站驱动管理操作：CORS 只能阻止"读响应"，阻止不了"发请求"。
    // 校验逻辑见 isSameOriginIfPresent（纯函数，tests/guard.test.ts 锁定）。
    if (isAdminApi && !['GET', 'OPTIONS', 'HEAD'].includes(req.method)) {
      if (!isSameOriginIfPresent(req.headers.origin as string | undefined, req.headers.host as string | undefined, req.protocol)) {
        return reply.status(403).send({ error: 'Cross-origin admin request rejected' });
      }
      // B1：管理面写操作要一次性 token。PROXY_API_KEY 从此只管 /v1/*——两把凭据
      // 混用意味着数据面密钥泄露即可改配置、删账号（审查 P0-2 的权限未分离）。
      // 只卡写不卡读：/api/* 的读端点保持可被本机脚本直接访问。
      if (!adminTokenOk(req.headers['x-admin-token'] as string | undefined)) {
        return reply.status(401).send({
          error: 'Missing or invalid x-admin-token. It is served in the dashboard page '
            + '(<meta name="ccproxy-admin-token">) and printed at startup; pin it with ADMIN_API_TOKEN.',
        });
      }
    }

    // B5：只上零风险项，刻意不含 script-src（SPA 还有一整块内联脚本 + 大量内联事件）。
    if (isDashboardPage) {
      reply.header('Content-Security-Policy', ADMIN_CSP);
    }

    // 仪表盘 HTML 与管理 API 禁用缓存：升级后浏览器不会再用旧页面调新接口。
    if (isDashboardPage || isAdminApi || req.url.startsWith('/?')) {
      reply.header('Cache-Control', 'no-cache');
    }
  });
  fastify.options('/v1/*', async (_req, reply) => {
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version')
      .status(204)
      .send();
  });

  // ── 本地化静态资源（原 CDN：tailwind / font-awesome / chart.js）────────────
  // 离线或 CDN 被墙时仪表盘不再掉样式、丢图表。文件随仓库 public/vendor/ 分发，
  // pkg 打包时列入 assets。
  const PUBLIC_DIR = path.join(getProjectRootDir(), 'public');
  const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');
  // 面板自身脚本（T110：从 index.html 外置到 public/js/）。与 vendor 分开是因为二者
  // 语义不同：vendor 是第三方库（长期缓存，升级才变），js 是本项目代码（随版本走）。
  const PANEL_JS_DIR = path.join(PUBLIC_DIR, 'js');
  const DASHBOARD_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');
  const VENDOR_TYPES: Record<string, string> = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };

  /**
   * 从 baseDir 下安全地读取相对路径 rel。
   * 拒绝空串 / `..` / 反斜杠 / 绝对路径（路径穿越）；vendor 与面板 js 两个静态
   * 路由共用这一套拒绝逻辑，避免各写一份时漏掉其中一处。
   */
  async function serveStatic(baseDir: string, rel: string, reply: any, cacheControl: string): Promise<unknown> {
    if (!rel || rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) {
      return reply.status(404).send();
    }
    const file = path.join(baseDir, ...rel.split('/'));
    try {
      const data = await fs.promises.readFile(file);
      const ext = path.extname(file).toLowerCase();
      return reply
        .header('Content-Type', VENDOR_TYPES[ext] || 'application/octet-stream')
        .header('Cache-Control', cacheControl)
        .send(data);
    } catch {
      return reply.status(404).send();
    }
  }

  fastify.get('/assets/vendor/*', async (req, reply) => {
    const rel = decodeURIComponent(String((req.params as any)['*'] || ''));
    return serveStatic(VENDOR_DIR, rel, reply, 'public, max-age=86400');
  });

  // 面板页面脚本通路：/js/core.js → public/js/core.js。禁缓存：与 GET / 的策略一致，
  // 升级后浏览器不会再用旧脚本调新接口。
  fastify.get('/js/*', async (req, reply) => {
    const rel = decodeURIComponent(String((req.params as any)['*'] || ''));
    return serveStatic(PANEL_JS_DIR, rel, reply, 'no-cache');
  });

  fastify.get('/api/status', async () => {
    const config = loadConfig();
    const uptimeSec = Math.floor((Date.now() - startTimestamp) / 1000);
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;
    const activeAcc = config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];

    return {
      status: 'active',
      version: PROXY_VERSION,
      running: getGatewayRunning(),
      uptime: `${hrs}h ${mins}m ${secs}s`,
      port: config.port,
      host: config.host,
      apiBase: config.ccApiBase,
      cliVersion: config.ccVersion,
      rotationMode: config.rotationMode,
      activeAccountId: config.activeAccountId || activeAcc?.id || '',
      activeAccountName: activeAcc?.name || 'None',
      accountsCount: config.accounts.length,
      hasApiKey: !!getActiveApiKey(),
      modelsCount: getCachedModels().length,
      authRequired: !!process.env.PROXY_API_KEY,
      // T106（§3.7-7）：风险告知确认状态。false 时 /v1 一律 403，面板据此弹窗。
      acceptedRiskDisclaimer: isRiskDisclaimerAccepted(),
      // 绑定非回环地址 = API 与管理面对局域网可见；未设 PROXY_API_KEY 时前端要醒目警示
      boundNonLoopback: !['127.0.0.1', 'localhost', '::1'].includes(config.host),
      // 版本更新检查（尽力而为，离线时 latest 为 null）
      update: getUpdateState(),
    };
  });

  // 只读运行配置视图：一眼可查部署参数（不含任何密钥）。
  fastify.get('/api/config', async () => {
    const config = loadConfig();
    return {
      version: PROXY_VERSION,
      port: config.port,
      host: config.host,
      apiBase: config.ccApiBase,
      cliVersion: config.ccVersion,
      rotationMode: config.rotationMode,
      accountsCount: config.accounts.length,
      upstream: {
        timeoutMs: config.upstreamTimeoutMs,
        idleTimeoutMs: config.idleTimeoutMs,
        maxRetries: config.maxRetries,
      },
      limits: {
        maxBodyMb: Math.round(resolveBodyLimit() / 1048576),
        todaySpendUsd: Math.round(getTodaySpendUsd() * 100) / 100,
        maxUpstreamConcurrency: process.env.MAX_UPSTREAM_CONCURRENCY || 'unlimited',
        dailyBudgetUsd: process.env.DAILY_BUDGET_USD || 'off',
      },
      paths: {
        config: CONFIG_FILE_PATH,
        log: LOG_FILE_PATH,
        usageHistory: USAGE_FILE_PATH,
        modelsCache: MODELS_FILE_PATH,
      },
      update: getUpdateState(),
    };
  });

  // 运行能力开关快照（只读）：概览页"通道健康 / 运行开关"两张卡片的数据源。
  fastify.get('/api/features', async () => {
    // 健康检查：默认 300000ms，设 0 整体关闭（与 health-check.ts 的 startHealthChecks 一致）。
    const healthIntervalMs = readEnvIntDefault('HEALTH_CHECK_INTERVAL_MS', 300_000);
    // Webhook：配置了 WEBHOOK_URL 才启用（webhookEnabled 原样复用）；阈值
    // Number.isFinite 才算配置（与 webhook-alerts.ts 的 checkThresholds 一致）。
    const costThreshold = readEnvFloatLike('WEBHOOK_COST_USD');
    const errorRateThreshold = readEnvFloatLike('WEBHOOK_ERROR_RATE');
    // 模型访问：allowlist 优先于 blocklist（与 model-access.ts 的 checkModelAccess 一致）。
    const allow = parseEnvList('MODEL_ALLOWLIST');
    const block = parseEnvList('MODEL_BLOCKLIST');
    const accessMode = allow.length > 0 ? 'allowlist' : block.length > 0 ? 'blocklist' : 'off';
    // 审计日志：AUDIT_LOG 默认 on，'off' 关闭；路径惰性求值（与 audit-log.ts 的
    // auditEnabled/auditFilePath 保持一致，那两个函数未导出，这里照抄判定）。
    const auditOn = (process.env.AUDIT_LOG ?? 'on').trim().toLowerCase() !== 'off';
    const auditPath = process.env.AUDIT_LOG_PATH
      ? path.resolve(process.env.AUDIT_LOG_PATH)
      : path.join(getProjectRootDir(), 'logs', 'audit.log');
    // Prompt 版本：PROMPT_VERSIONS === 'on' 才装配路由（与 routes/prompts.ts 一致）；
    // 目录解析直接复用导出的 resolvePromptsDir。
    const promptFlag = String(process.env.PROMPT_VERSIONS ?? '').trim().toLowerCase();
    const rpm = readEnvIntStrict('RATE_LIMIT_RPM');
    const tpm = readEnvIntStrict('RATE_LIMIT_TPM');

    return {
      healthCheck: {
        enabled: healthIntervalMs > 0,
        intervalMs: healthIntervalMs,
        // 从未探活（启动 <1 周期）时 lastResult 为 null，前端显示"等待首次探活"。
        channel: getChannelHealth(),
      },
      webhook: {
        enabled: webhookEnabled(),
        costThreshold: Number.isFinite(costThreshold) ? costThreshold : null,
        errorRateThreshold: Number.isFinite(errorRateThreshold) ? errorRateThreshold : null,
      },
      promptVersions: {
        enabled: promptFlag === 'on',
        dir: resolvePromptsDir(),
      },
      rateLimit: {
        rpm: rpm ?? null,
        tpm: tpm ?? null,
      },
      modelAccess: {
        mode: accessMode,
        // 回显生效名单：allowlist 模式返回 allowlist，否则返回 blocklist（off 时为空）。
        list: accessMode === 'allowlist' ? allow : block,
      },
      auditLog: {
        enabled: auditOn,
        path: auditPath,
      },
    };
  });

  fastify.post('/api/gateway/toggle', async (req: any) => {
    const body = req.body || {};
    if (body.running !== undefined) {
      // 只认严格布尔。此前把请求体原样交给 setter，而 getGatewayRunning() 的判据是
      // `!== false`，于是 {"running":"false"} / 0 这类真值会被当成"继续运行"：
      // 用户点了暂停但引擎没停，暂停通知也永远不发。SPA 侧发的本就是布尔。
      const wanted = body.running === true;
      setGatewayRunning(wanted);
      logger.info(`[DASHBOARD] Gateway engine toggled: ${wanted ? 'STARTED' : 'STOPPED'}`);
      // 引擎暂停意味着所有经过代理的请求都会被拒，用户多半不在面板前。
      if (!wanted) {
        notify('engine-paused', 'CommandCode 引擎已暂停', '代理将拒绝新的 /v1/* 请求，直到在面板恢复', 'warn');
      }
    }
    return { status: 'success', running: getGatewayRunning() };
  });

  fastify.get('/api/logs', async () => ({ logs: logger.getLogs() }));

  /**
   * T106（§3.7-7）：确认合规风险告知。
   *
   * 写操作 —— 自动受管理面鉴权约束（非 GET 的 /api/* 需 x-admin-token，
   * 且由 T105 的审计链记录）。成功后写回 config.json 并**热生效**（无需重启）：
   * 下一个 /v1 请求即放行。
   */
  fastify.post('/api/risk/accept', async (_req, reply) => {
    try {
      acceptRiskDisclaimer();
      return { status: 'success', acceptedRiskDisclaimer: true };
    } catch (err: any) {
      logger.error(`[RISK] Failed to persist risk disclaimer acceptance: ${err?.message || err}`);
      return reply.status(500).send({ error: `Could not persist acceptance: ${err?.message || err}` });
    }
  });

  fastify.post('/api/logs/clear', async () => {
    logger.clearLogs();
    logger.info('[DASHBOARD] Log console cleared.');
    return { status: 'success' };
  });

  // ── 多上游 Provider（T213 阶段 1）──────────────────────────────────────────
  // 未装配运行时（如部分测试只挂 dashboardRoutes）时端点优雅降级，而不是 500。

  fastify.get('/api/providers', async () => {
    const runtime = fastify.providerRuntime;
    if (!runtime) return { providers: [], runtime: false, defaultProvider: undefined };
    return { runtime: true, defaultProvider: runtime.defaultProvider, providers: await runtime.status() };
  });

  const PROVIDER_NAMES: readonly string[] = ['commandcode', 'freebuff', 'workbuddy'];

  fastify.post('/api/providers/:name/enable', async (req: any, reply) => {
    const runtime = fastify.providerRuntime;
    if (!runtime) return reply.status(404).send({ error: 'Provider runtime is not wired in this build' });
    const name = String(req.params?.name ?? '');
    if (!PROVIDER_NAMES.includes(name)) {
      return reply.status(404).send({ error: `Unknown provider "${name}"` });
    }
    runtime.enable(name as ProviderName);
    logger.info(`[DASHBOARD] Provider ${name} enabled (hot)`);
    return { status: 'success', name, enabled: true };
  });

  fastify.post('/api/providers/:name/disable', async (req: any, reply) => {
    const runtime = fastify.providerRuntime;
    if (!runtime) return reply.status(404).send({ error: 'Provider runtime is not wired in this build' });
    const name = String(req.params?.name ?? '');
    if (!PROVIDER_NAMES.includes(name)) {
      return reply.status(404).send({ error: `Unknown provider "${name}"` });
    }
    runtime.disable(name as ProviderName);
    logger.info(`[DASHBOARD] Provider ${name} disabled (hot)`);
    return { status: 'success', name, enabled: false };
  });

  fastify.get('/api/providers/:name/accounts', async (req: any, reply) => {
    const runtime = fastify.providerRuntime;
    if (!runtime) return reply.status(404).send({ error: 'Provider runtime is not wired in this build' });
    const name = String(req.params?.name ?? '');
    if (!PROVIDER_NAMES.includes(name)) {
      return reply.status(404).send({ error: `Unknown provider "${name}"` });
    }
    const provider = runtime.get(name as ProviderName);
    // listAccounts 契约：凭据字段必须脱敏（免费/联邦侧本就不持有明文）。
    return { provider: name, accounts: provider ? provider.listAccounts() : [] };
  });

  // T212：用量按上游分口径聚合（§3.9）——commandcode 记美元、freebuff 记免费、
  // workbuddy 记积分，禁止跨上游混加。数据源是本地用量历史的内存读（廉价）。
  fastify.get('/api/usage/by-provider', async () => {
    return { summary: summarizeByProvider(getUsageHistory()) };
  });

  fastify.post('/api/providers/default', async (req: any, reply) => {
    const runtime = fastify.providerRuntime;
    if (!runtime) return reply.status(404).send({ error: 'Provider runtime is not wired in this build' });
    const name = String(req.body?.name ?? '').trim();
    if (!runtime.setDefaultProvider(name as never)) {
      return reply.status(400).send({ error: `Unknown provider "${name}"` });
    }
    // 持久化到 config.json 的 routing 分片（deepMergeKeepUnknown 保留其余键），
    // 重启后由 ProviderRuntime.initialize 读回；当前进程即时热生效。
    const currentRouting = (readRawConfigFile().routing ?? {}) as Record<string, unknown>;
    const persisted = saveConfigFile({
      routing: { ...currentRouting, defaultProvider: name },
    } as never);
    logger.info(`[DASHBOARD] Default provider switched to ${name} (hot; persisted=${persisted})`);
    return { status: 'success', defaultProvider: name, persisted };
  });

  fastify.post('/api/providers/registry/refresh', async (_req, reply) => {
    const runtime = fastify.providerRuntime;
    if (!runtime) return reply.status(404).send({ error: 'Provider runtime is not wired in this build' });
    await runtime.refreshRegistry();
    const count = runtime.namespacedModels().length;
    logger.info(`[DASHBOARD] Provider model registry refreshed (${count} namespaced models)`);
    return { status: 'success', namespacedModels: count };
  });

  fastify.get('/api/accounts', async () => {
    const config = loadConfig();
    const safeAccounts = config.accounts.map(a => ({
      id: a.id,
      name: a.name,
      userName: a.userName,
      email: a.email,
      addedAt: a.addedAt,
      apiKeyMasked: maskApiKey(a.apiKey),
      isActive: a.id === config.activeAccountId,
    }));
    return {
      activeAccountId: config.activeAccountId,
      rotationMode: config.rotationMode,
      accounts: safeAccounts,
    };
  });

  fastify.post('/api/accounts/active', async (req: any, reply) => {
    const { accountId } = req.body || {};
    if (!accountId) return reply.status(400).send({ error: 'accountId required' });
    if (!setActiveAccount(accountId)) {
      return reply.status(500).send({ error: '切换失败：账号不存在或 config.json 写入未成功' });
    }
    return { status: 'success', activeAccountId: accountId };
  });

  fastify.post('/api/accounts/delete', async (req: any, reply) => {
    const { accountId } = req.body || {};
    if (!accountId) return reply.status(400).send({ error: 'accountId required' });
    if (!logoutAccount(accountId)) {
      return reply.status(500).send({ error: '删除失败：config.json 写入未成功' });
    }
    return { status: 'success' };
  });

  fastify.post('/api/accounts/rotation', async (req: any, reply) => {
    const { rotationMode } = req.body || {};
    if (rotationMode !== 'manual' && rotationMode !== 'auto-quota') {
      return reply.status(400).send({ error: 'rotationMode must be manual|auto-quota' });
    }
    if (!setRotationMode(rotationMode)) {
      return reply.status(500).send({ error: '保存失败：config.json 写入未成功' });
    }
    return { status: 'success', rotationMode };
  });

  fastify.post('/api/auth/manual-login', async (req: any, reply) => {
    const { apiKey, name } = req.body || {};
    if (!apiKey) return reply.status(400).send({ error: 'API key is required' });
    try {
      const acc = await loginNewAccount(String(apiKey), name ? String(name).slice(0, 60) : undefined);
      // 明文 apiKey 绝不出接口：loginNewAccount 的返回类型带完整凭据（内部调用方需要），
      // 收口在 toSafeAccount —— 摘除动作发生在辅助函数里，新增端点不会再漏。
      return { status: 'success', account: toSafeAccount(acc) };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.post('/api/auth/browser-login', async (_req, reply) => {
    try {
      logger.info('[DASHBOARD] Triggering CLI Browser OAuth Login flow...');
      const newAcc = await startBrowserLoginFlow(5959);
      // OAuth 流程同样透传完整 AccountInfo —— 与 manual-login 共用一个收口。
      return { status: 'success', account: toSafeAccount(newAcc) };
    } catch (err: any) {
      logger.error(`[DASHBOARD] Browser Login flow error: ${err.message}`);
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.get('/api/usage/aggregate', async () => {
    const config = loadConfig();
    const targetAccounts =
      config.accounts.length > 0
        ? config.accounts
        : [{ id: 'acc_default', name: defaultAccountName(getActiveApiKey(), ''), apiKey: getActiveApiKey() }];

    const results = await Promise.all(
      targetAccounts.map(async (acc: any) => {
        const stats = await fetchLiveUsageStatsCached(acc.apiKey, config.ccApiBase, config.ccVersion);
        const who = stats.whoami?.user;
        return {
          account: {
            id: acc.id,
            name: acc.name || (who ? who.name || who.userName : defaultAccountName(acc.apiKey, '')),
            userName: acc.userName || who?.userName || 'system_user',
            email: acc.email || who?.email || 'System Auth Key',
            isActive: acc.id === config.activeAccountId || targetAccounts.length === 1,
            apiKeyMasked: maskApiKey(acc.apiKey),
          },
          ...stats,
        };
      })
    );
    return { accountsUsage: results };
  });

  // ─── 官方用量总览（对齐 commandcode.ai usage 页数据源）────────────────────────
  //
  // 页面的 Total Tokens / Total Runs / Usage Limits 分别来自
  // /internal/usage/summary 与 /internal/billing/credits（仅认 Web Cookie），
  // 这里改走字段一致的 CLI 通道 /alpha/usage/summary 与 /alpha/billing/credits。
  fastify.get('/api/usage/overview', async () => {
    const config = loadConfig();
    const acc = config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];
    if (!acc || !acc.apiKey) {
      return { error: 'No active Command Code account' };
    }
    const stats = await fetchLiveUsageStatsCached(acc.apiKey, config.ccApiBase, config.ccVersion);
    const s = stats.summary || {};
    const credits = stats.credits?.credits || {};
    const wl = stats.credits?.windowLimits || {};
    const monthlyUsed = Number(s.totalMonthlyCredits) || 0;
    const monthlyRemaining = Number(credits.monthlyCredits) || 0;
    const pct = (used: unknown, cap: unknown) => {
      const u = Number(used) || 0;
      const c = Number(cap) || 0;
      return c > 0 ? Math.min(100, Math.round((u / c) * 1000) / 10) : 0;
    };

    // ── 套餐与计费周期（/alpha/billing/subscriptions）──────────────────────────
    // 订阅额度在续费时刷新，未用完的部分不会结转，因此周期信息对"要不要升档"
    // 的判断很关键；之前这里只取了 credits/summary，完全没读订阅周期。
    const sub: any = stats.subscription?.data ?? stats.subscription ?? {};
    const planId = typeof sub.planId === 'string' ? sub.planId : '';
    const tier = planTier(planId);
    const toMs = (v: unknown): number => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const t = Date.parse(v);
        if (Number.isFinite(t)) return t;
      }
      return 0;
    };
    const periodStart = toMs(sub.currentPeriodStart);
    const periodEnd = toMs(sub.currentPeriodEnd);
    const cycle = (() => {
      if (!periodStart || !periodEnd || periodEnd <= periodStart) return null;
      const totalDays = (periodEnd - periodStart) / 86_400_000;
      const elapsedDays = Math.min(Math.max((Date.now() - periodStart) / 86_400_000, 0), totalDays);
      return {
        totalDays: Math.round(totalDays * 100) / 100,
        daysElapsed: Math.round(elapsedDays * 100) / 100,
        daysLeft: Math.max(0, Math.ceil((periodEnd - Date.now()) / 86_400_000)),
        cyclePct: Math.round((elapsedDays / totalDays) * 1000) / 10,
      };
    })();

    return {
      account: {
        id: acc.id,
        name: acc.name || stats.whoami?.user?.name || defaultAccountName(acc.apiKey, ''),
        userName: acc.userName || stats.whoami?.user?.userName || '',
      },
      plan: planId
        ? {
            planId,
            name: planName(planId),
            status: sub.status || '',
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
            monthlyCredits: tier?.monthlyCredits,
            fiveHourCap: tier?.fiveHourCap,
            weeklyCap: tier?.weeklyCap,
            currentPeriodStart: periodStart || null,
            currentPeriodEnd: periodEnd || null,
            ...(cycle ?? {}),
          }
        : null,
      summary: {
        totalTokens: Number(s.totalTokens) || 0,
        totalTokensIn: Number(s.totalTokensIn) || 0,
        totalTokensOut: Number(s.totalTokensOut) || 0,
        totalRuns: Number(s.totalCount) || 0,
        completedCount: Number(s.completedCount) || 0,
        failedCount: Number(s.failedCount) || 0,
        successRate: Number(s.successRate) || 0,
        totalCost: Number(s.totalCost) || 0,
        periodBasis: s.periodBasis || 'billing-period',
      },
      limits: {
        fiveHour: wl.fiveHour
          ? { used: wl.fiveHour.used, cap: wl.fiveHour.cap, pct: pct(wl.fiveHour.used, wl.fiveHour.cap), exceeded: !!wl.fiveHour.exceeded, resetAt: wl.fiveHour.resetAt || 0 }
          : null,
        weekly: wl.weekly
          ? { used: wl.weekly.used, cap: wl.weekly.cap, pct: pct(wl.weekly.used, wl.weekly.cap), exceeded: !!wl.weekly.exceeded, resetAt: wl.weekly.resetAt || 0 }
          : null,
        monthly: {
          used: monthlyUsed,
          remaining: monthlyRemaining,
          cap: Math.round((monthlyUsed + monthlyRemaining) * 100) / 100,
          pct: pct(monthlyUsed, monthlyUsed + monthlyRemaining),
        },
      },
      sources: {
        tokensAndRuns: '/alpha/usage/summary',
        limits: '/alpha/billing/credits',
      },
    };
  });

  // ─── 会话明细历史 ────────────────────────────────────────────────────────────

  fastify.get('/api/usage/history', async (req: any) => {
    const records = getUsageHistory();
    const stats = getUsageStats();
    // 表格展示默认 200 条；导出走 ?limit= 取全量。此前无论调用方要多少都只有 200 条，
    // 而"导出 CSV"照此拼文件并提示"已导出 N 条"，拿去对账的人拿到的是残缺数据。
    const requested = Number(req?.query?.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), HISTORY_EXPORT_MAX)
      : 200;
    return {
      total: stats.total,
      today: stats.today,
      week: stats.week,
      month: stats.month,
      byDay: stats.byDay,
      byModel: stats.byModel,
      byModelPerf: stats.byModelPerf,
      byProject: stats.byProject,
      bySession: stats.bySession,
      attribution: stats.attribution,
      recent: records.slice(-limit).reverse(),
      storedRecords: records.length,
      quotaProjection: getQuotaProjection(),
      // 峰谷计费状态：受分时价影响的模型此刻按哪档计费、何时切换。
      billing: {
        window: describeBillingWindow(),
        models: getTimeOfDayModels(),
      },
    };
  });

  fastify.post('/api/usage/clear', async () => {
    clearUsageHistory();
    return { status: 'success' };
  });

  // ─── 仪表盘 SPA ────────────────────────────────────────────────────────────

  // ── 仪表盘 SPA ────────────────────────────────────────────────────────────
  // 页面本体是静态文件 public/index.html（v4.9.3 起从模板字符串迁出，可独立
  // 编辑与测试）；pkg 打包时列入 assets。禁用缓存：升级后浏览器不会再用旧
  // 页面调新接口。
  fastify.get('/', async (_req, reply) => {
    try {
      const html = await fs.promises.readFile(DASHBOARD_HTML_PATH, 'utf-8');
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-cache')
        .send(injectAdminTokenMeta(html));
    } catch (err: any) {
      logger.error(`[DASHBOARD] Failed to load public/index.html: ${err.message}`);
      return reply.status(500).send('Dashboard assets missing: public/index.html not found.');
    }
  });
}
