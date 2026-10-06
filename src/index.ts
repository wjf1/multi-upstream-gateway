// =============================================================================
// CommandCode Proxy v4 —— 服务入口（bootstrap）
// -----------------------------------------------------------------------------
// 启动流程：
//   1. 注册全局未捕获异常/拒绝处理器（记录日志，不让进程崩溃）
//   2. 加载配置（config.json / 环境变量）
//   3. 注册管理员仪表盘、OpenAI、Anthropic、models 四条路由
//   4. 可选地挂载 PROXY_API_KEY 共享密钥鉴权钩子
//   5. 后台拉取模型目录（尽力而为，不阻塞启动）
//   6. 若配置为 auto-quota 轮换模式，启动 30 分钟一次的额度轮换调度器
//   7. 监听端口；默认自动打开浏览器显示仪表盘
// =============================================================================
import Fastify from 'fastify';
import crypto from 'node:crypto';
import { loadConfig, openBrowser, checkAndRotateAccountsOnQuota, getActiveApiKey, resolveBodyLimit, enrichDefaultAccountName, fetchWindowLimits } from './utils/config.js';
import { fetchUpstreamModels } from './utils/models.js';
import { logger } from './utils/logger.js';
import { PROXY_VERSION } from './utils/version.js';
import { chatRoutes, verifyProxyAuth } from './routes/chat.js';
import { ADMIN_TOKEN, isInsecureBind } from './utils/admin-guard.js';
import { messagesRoutes } from './routes/messages.js';
import { modelsRoutes } from './routes/models.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { registerPromptRoutes } from './routes/prompts.js';
import { registerSecurityGuards } from './utils/security-guard.js';
import { registerRiskGate, isRiskDisclaimerAccepted } from './utils/risk-gate.js';
import { stripDangerousNodeDebug } from './utils/sanitize.js';
import { assertCredentialsEncryptedOrThrow, migratePlaintextCredentialsIfNeeded } from './utils/credential-store.js';
import { recordQuotaSample, getQuotaProjection } from './utils/quota-tracker.js';
import { flushPendingWrites } from './utils/usage-store.js';
import { scheduleUpdateChecks } from './utils/update-check.js';
import { notify, ensureAumidRegistered, isGlobalToastEnabled } from './utils/notifier.js';
import { startHealthChecks } from './utils/health-check.js';
import { startWebhookAlerts } from './utils/webhook-alerts.js';
import { initOutboundProxy } from './utils/proxy-agent.js';

// 未捕获异常/拒绝：单次只记日志（代理要尽量活着）。
// 但短时间连续出现说明进程已进入不可信状态（可能挂着僵死的上游连接、
// 内部状态被写坏）——达到阈值即主动退出，交给服务管理器/看门狗重启。
const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_THRESHOLD = 3;
let crashTimes: number[] = [];

function noteUncaught(kind: string, detail: string): void {
  const now = Date.now();
  crashTimes = crashTimes.filter(t => now - t < CRASH_WINDOW_MS);
  crashTimes.push(now);
  logger.error(`[CRITICAL] Uncaught ${kind}: ${detail}`);
  if (crashTimes.length >= CRASH_THRESHOLD) {
    logger.error(`[CRITICAL] ${CRASH_THRESHOLD} uncaught ${kind} within 5 minutes; exiting for supervisor restart.`);
    exitForCrashBudget(kind);
  }
}

process.on('uncaughtException', err => {
  noteUncaught('Exception', err.message);
});

process.on('unhandledRejection', (reason: any) => {
  noteUncaught('Rejection', reason?.message || String(reason));
});

const config = loadConfig();
await initOutboundProxy(config);

// T105（§3.7-5）：启动时剥离 NODE_DEBUG 中的 undici/http/http2 项。这些项会让
// Node 原生客户端把完整请求头（含 Authorization）打到 stderr —— 绕过全部日志
// 脱敏（sanitizeLog 只覆盖本代理的日志通道），必须在最前面掐断。
{
  const stripped = stripDangerousNodeDebug(process.env);
  if (stripped.changed) {
    logger.warn(
      `[SECURITY] NODE_DEBUG 已剥离危险调试项：${stripped.removed.join(', ')} —— ` +
      'undici/http 的原生调试输出会打印完整请求头（含 Authorization），日志脱敏覆盖不到该通路。',
    );
  }
}

// T103（master-plan v1.2 §3.7-2）：凭据加密-at-rest 启动钩子。
// 1) 校验：存在凭据（明文 V1 / auths/*.json / 已有加密库）而
//    CREDENTIAL_ENCRYPTION_KEY 未设置或非法 → 拒绝启动并给出生成密钥指引；
// 2) 首次带密钥启动：把明文凭据加密落盘（credentials.enc）、摘除 .env 明文行、
//    旧明文 auths/*.json 改名 *.plain.bak 并告警提示删除。
try {
  assertCredentialsEncryptedOrThrow();
  migratePlaintextCredentialsIfNeeded();
} catch (err: any) {
  logger.error(`${err?.message || err}`);
  process.exit(1);
}

const fastify = Fastify({
  // T105（§3.7-5）：Fastify 内建 pino 日志启用在 warn 级（不产生逐请求噪音，仅
  // 框架级错误可见），并对凭据类请求头做 redact —— 兜底覆盖 pino 序列化路径。
  // 项目自身的日志控制台（utils/logger.ts）与此通道并行，互不影响。
  logger: {
    level: 'warn',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["proxy-authorization"]',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers["x-admin-token"]',
      ],
      censor: '[REDACTED]',
    },
  },
  // T105：Fastify 内部 req.id 也用 UUID，与安全链生成的 X-Request-Id 同构。
  genReqId: () => crypto.randomUUID(),
  trustProxy: true,
  // 视觉/多图请求的 base64 负载可能超过 Fastify 默认 1MB，触发 413
  // (FST_ERR_CTP_BODY_TOO_LARGE)。默认 64MB，可用环境变量 MAX_BODY_MB 调整。
  bodyLimit: resolveBodyLimit(),
});

const QUOTA_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 每 30 分钟检查一次额度
/** 额度采样周期：官方 used 的时间差分决定燃烧速率，太疏会漏掉短时高峰。 */
const QUOTA_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 采样官方窗口用量并推进燃烧速率预测。只拉 credits 一个端点，开销最低。
 * 采样允许失败（网络抖动跳过本次即可，预测基于历史窗口）。
 */
async function sampleQuotaWindow(): Promise<void> {
  const apiKey = getActiveApiKey();
  if (!apiKey) return;
  try {
    const wl = await fetchWindowLimits(apiKey, config.ccApiBase, config.ccVersion);
    const fh = wl?.fiveHour;
    if (fh && Number.isFinite(fh.used) && Number.isFinite(fh.cap)) {
      recordQuotaSample(fh.used, fh.cap, typeof fh.resetAt === 'number' ? fh.resetAt : null);
      const p = getQuotaProjection();
      // 只在"会撞限"这个可行动结论上提醒，且由 notifier 去重限频。
      if (p.willHitCapBeforeReset === true && p.minutesToCap !== null) {
        notify(
          'quota-window-cap',
          'CommandCode 额度将耗尽',
          `按当前速率约 ${p.minutesToCap} 分钟后用完 5 小时窗口（剩余 $${(p.remainingUsd ?? 0).toFixed(2)}），早于重置时间`,
          'critical'
        );
      }
    }
  } catch (err: any) {
    logger.warn(`[QUOTA-SAMPLE] ${err?.message || err}`);
  }
}

// 优雅退出：SIGINT/SIGTERM 时先冲刷挂起的用量写入（内存写队列）再关闭，
// 避免 Ctrl+C 丢掉最后一两条会话记录。二次信号直接强制退出。
let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[SERVER] ${signal} received; flushing pending usage writes and closing...`);
  try {
    await flushPendingWrites();
  } catch { /* 尽力而为 */ }
  try {
    await fastify.close();
  } catch { /* 尽力而为 */ }
  process.exit(exitCode);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

/**
 * 崩溃预算用尽时的退出：走与 SIGINT 同一条收尾路径，否则排队的用量记录会随进程
 * 一起丢掉（这是丢数据，不是丢日志）。冲刷本身可能挂在死掉的上游连接上，所以
 * 另挂一个不 unref 的 2s 兜底计时器，到点无条件退出交给服务管理器重启。
 */
function exitForCrashBudget(kind: string): void {
  void shutdown(`uncaught-${kind}`, 1);
  setTimeout(() => process.exit(1), 2000);
}

const start = async () => {
  try {
    // T105 安全中间件链（请求 ID 传播 / modelAccess / 限流 / 请求日志）。
    // 必须先于 verifyProxyAuth 注册：请求 ID 的 onRequest 钩子要先执行，
    // 被 401 拒绝的请求才能带上 X-Request-Id 响应头。
    registerSecurityGuards(fastify);

    // 可选的共享密钥鉴权（PROXY_API_KEY 环境变量），作用于 /v1/*。
    verifyProxyAuth(fastify);

    // T106（§3.7-7）：合规风险告知门，作用于 /v1/*。
    // 必须排在 verifyProxyAuth 之后：鉴权先答"你是谁"（401），风险门再答
    // "你确认过风险了吗"（403）。顺序反了会看到 403 而非 401，把鉴权失败
    // 伪装成合规拦截。未确认时（默认）所有 /v1 请求 403。
    registerRiskGate(fastify);

    await fastify.register(dashboardRoutes);
    await fastify.register(chatRoutes);
    await fastify.register(messagesRoutes);
    await fastify.register(modelsRoutes);
    // Prompt 版本管理（默认关闭）：PROMPT_VERSIONS=on 时 plugin 内部才会注册路由。
    await fastify.register(registerPromptRoutes);

    fastify.get('/health', async () => {
      return { status: 'ok', version: PROXY_VERSION, time: new Date().toISOString() };
    });

    logger.info('[BOOT] Initializing CommandCode Proxy v4...');

    const activeApiKey = getActiveApiKey();
    if (activeApiKey) {
      fetchUpstreamModels(activeApiKey, config.ccVersion).catch(err => {
        logger.warn(`[BOOT] Model fetch background warning: ${err.message}`);
      });
      // 后台补全兜底账号的真实用户名（whoami），不阻塞启动；失败静默。
      enrichDefaultAccountName().catch(err => {
        logger.warn(`[BOOT] Account name enrichment warning: ${err?.message || err}`);
      });
    }

    // v3 bug 修复：auto-quota 轮换此前是死代码 —— 现在真正被调度执行。
    //
    // 但装配条件必须放在 tick 里、且用**新鲜**配置判定。此前是启动时一次性
    // `if (config.rotationMode === 'auto-quota' && config.accounts.length > 1) setInterval(...)`，
    // 而 config 是启动期快照：用户在仪表盘把模式切成 auto-quota 或加上第二个账号后，
    // 设置已持久化、UI 显示"已开启"，调度器却永远不会启动，直到下次重启 ——
    // 正是"看起来在工作、实际没工作"的那一类。
    setInterval(() => {
      const live = loadConfig();
      if (live.rotationMode !== 'auto-quota' || live.accounts.length <= 1) return;
      checkAndRotateAccountsOnQuota().catch(err => {
        logger.warn(`[AUTO-QUOTA] Scheduled check failed: ${err.message}`);
      });
    }, QUOTA_CHECK_INTERVAL_MS);
    logger.info('[AUTO-QUOTA] Rotation scheduler armed (every 30m, gated per tick).');

    // 燃烧速率采样：立即采一次拿到基线，之后定时差分。同理不按启动时是否有 Key
    // 来决定装配 —— sampleQuotaWindow 无 Key 时自己就会返回，中途加账号无需重启。
    sampleQuotaWindow().catch(() => {});
    setInterval(() => {
      sampleQuotaWindow().catch(err => logger.warn(`[QUOTA-SAMPLE] ${err?.message || err}`));
    }, QUOTA_SAMPLE_INTERVAL_MS);
    logger.info('[QUOTA-SAMPLE] Window usage sampler active (every 5m).');

    // 通道健康检查 + Webhook 告警（均为纯旁路，不影响任何请求路径）。
    // 健康检查默认 5 分钟一次仅告警；WEBHOOK_URL 未设置时 webhook 完全不启动。
    const healthTimer = startHealthChecks();
    if (healthTimer) logger.info('[HEALTH] Channel health probe armed.');
    const webhookTimer = startWebhookAlerts();
    if (webhookTimer) logger.info('[WEBHOOK] Alert scheduler armed.');

    // 预注册通知 AUMID：让第一条 toast 就能以 "CommandCode Proxy" 名义显示，
    // 而不是回退到 PowerShell。幂等，且失败只影响显示名，不阻断启动。
    if (process.platform === 'win32') {
      setImmediate(() => {
        try {
          ensureAumidRegistered();
          // 系统通知总开关若被关闭，toast 会被静默拒绝 —— 启动时就讲清楚。
          if (!isGlobalToastEnabled()) {
            logger.warn(
              '[NOTIFY] 系统通知总开关已关闭，桌面通知将不会显示。' +
              '修复路径：Windows 设置 → 系统 → 通知，打开总开关。'
            );
          }
        } catch { /* 非关键路径 */ }
      });
    }

    // B3：非回环绑定却没有数据面密钥，等于把整台网关交给局域网 —— 任何人都能增删
    // 账号、改配置、清空用量历史。此前只打一行警告然后照常启动；现在拒绝启动，
    // 除非显式 ALLOW_INSECURE_BIND=1（LAN 自托管是合法场景，但必须是主动选择）。
    if (
      isInsecureBind({
        host: config.host,
        hasProxyKey: !!process.env.PROXY_API_KEY?.trim(),
        allowInsecure: process.env.ALLOW_INSECURE_BIND === '1',
      })
    ) {
      const reason =
        `[STARTUP] 拒绝启动：绑定到非回环地址 ${config.host} 却未设置 PROXY_API_KEY。` +
        '这样局域网内任何主机都能调用 API 并完整操作管理面（增删账号、改配置、清空历史）。' +
        '三选一：把 HOST 改回 127.0.0.1；设置 PROXY_API_KEY；' +
        '确实要开放则设 ALLOW_INSECURE_BIND=1（同时建议给管理面固定 ADMIN_API_TOKEN）。';
      logger.error(reason);
      console.error(reason);
      process.exit(1);
    }

    await fastify.listen({ port: config.port, host: config.host });

    const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    const dashboardUrl = `http://${displayHost}:${config.port}/`;

    console.log('\n=============================================================');
    console.log('  ⚡ CommandCode Proxy v4 is ACTIVE');
    console.log(`  🏷️  Version:                 ${PROXY_VERSION}`);
    console.log(`  🌐 Controller GUI:          ${dashboardUrl}`);
    console.log(`  🤖 OpenAI Chat Completions: ${dashboardUrl}v1/chat/completions`);
    console.log(`  💬 Anthropic Messages:      ${dashboardUrl}v1/messages`);
    console.log(`  🔒 Bound to:                ${config.host}${process.env.PROXY_API_KEY ? ' (API auth ON)' : ''}`);
    // 管理面写操作凭据。控制台输出它是有意的：本机脚本需要一个稳定途径拿到 token，
    // 而能读到这份日志的账号本来就能读到 config.json 里的明文上游密钥。
    console.log(`  🔑 Admin token:             ${ADMIN_TOKEN}（管理面写操作凭据；重启换代，可用 ADMIN_API_TOKEN 固定）`);
    // T106：未确认风险告知时 /v1 一律 403。启动时就讲清楚，不要等到用户
    // 拿着 403 回来问"为什么突然不能用了"。
    if (!isRiskDisclaimerAccepted()) {
      console.log('  ⚠️  Risk disclaimer:        NOT ACCEPTED —— /v1/* 请求将返回 403');
      console.log('                              打开面板确认风险告知，或设 ACCEPTED_RISK_DISCLAIMER=1');
    }
    console.log('=============================================================\n');

    logger.info(`[SERVER] CommandCode Proxy v4 running on ${dashboardUrl}`);
    scheduleUpdateChecks();

    if (process.env.NODE_ENV !== 'test' && !process.env.NO_OPEN_BROWSER) {
      openBrowser(dashboardUrl);
    }
  } catch (err: any) {
    logger.error(`[SERVER] Error starting server: ${err.message}`);
    console.error(`\n[SERVER] Startup error: ${err.message}`);
    process.exit(1);
  }
};

start();
