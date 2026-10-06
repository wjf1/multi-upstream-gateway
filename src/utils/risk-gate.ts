// =============================================================================
// 合规风险告知门（T106，master-plan v1.2 §3.7-7）
// -----------------------------------------------------------------------------
// 背景：本网关聚合的三个上游（CommandCode / Freebuff / 腾讯 CodeBuddy）都**不是**
// 公开稳定的官方 API —— 它们是逆向或非公开接口，使用它们存在账号封禁、额度清零
// 乃至法律层面的风险。这类工具不该"装完就能用"：用户必须明确知道自己承担什么。
//
// 因此默认 `acceptedRiskDisclaimer = false`，此时**所有 `/v1/*` 请求返回 403**
// （错误码 RISK_DISCLAIMER_NOT_ACCEPTED），面板首屏强制弹风险告知；用户确认后
// 写回 config.json 并热生效（无需重启）。
//
// 判定优先级（与配置体系 §3.2 一致）：
//   ACCEPTED_RISK_DISCLAIMER 环境变量（'1'/'true'）> 进程内热生效覆盖 > config.json
//   > 默认 false。环境变量优先是为了让 CI / 一次性脚本能显式跳过风险门。
//
// 注意这是**破坏性升级**：存量用户升级后若未确认，/v1 会立即 403。这是刻意的
// 取舍（T503 迁移指南会显著标注），面板弹窗负责把"为什么突然不能用了"讲清楚。
// =============================================================================

import fs from 'fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CONFIG_FILE_PATH } from './config.js';
import { ErrorCode, ProxyError } from './errors.js';
import { logger } from './logger.js';

/**
 * 进程内覆盖：用户在本进程内确认后立即生效，不必等下一次读盘。
 * null = 未在本次运行中确认过，回落到读文件判定。
 */
let inMemoryAccepted: boolean | null = null;

/** 读 config.json 顶层的 acceptedRiskDisclaimer（unified 与旧扁平形态同位置）。 */
function readFileFlag(): boolean {
  try {
    if (!fs.existsSync(CONFIG_FILE_PATH)) return false;
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
    return raw?.acceptedRiskDisclaimer === true;
  } catch (err: any) {
    // 配置读不出来不等于"已确认"——fail-closed，风险门上保持关闭。
    logger.warn(`[RISK] Could not read risk disclaimer state: ${err?.message || err}`);
    return false;
  }
}

/** 风险告知是否已被接受（ACCEPTED_RISK_DISCLAIMER 环境变量 > 内存 > 文件 > false）。 */
export function isRiskDisclaimerAccepted(): boolean {
  const env = (process.env.ACCEPTED_RISK_DISCLAIMER || '').trim().toLowerCase();
  if (env === '1' || env === 'true') return true;
  if (inMemoryAccepted !== null) return inMemoryAccepted;
  return readFileFlag();
}

/**
 * 接受风险告知：原子写回 config.json（保留其余全部字段与未知键）并热生效。
 * 失败时抛错而不是静默成功——用户按了确认却发现还是 403，比直接报错更难排查。
 */
export function acceptRiskDisclaimer(): void {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_FILE_PATH)) {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  }
  raw.acceptedRiskDisclaimer = true;
  const tmp = `${CONFIG_FILE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf-8');
  fs.renameSync(tmp, CONFIG_FILE_PATH);
  inMemoryAccepted = true;
  logger.info('[RISK] Risk disclaimer accepted; /v1 requests are now served.');
}

/** 测试用：清空进程内覆盖（回落到读文件/环境变量判定）。 */
export function resetRiskDisclaimerCacheForTest(): void {
  inMemoryAccepted = null;
}

/**
 * 注册 `/v1/*` 的风险门（T106）。
 *
 * 挂载顺序：必须在 verifyProxyAuth **之后**注册 —— 鉴权先答"你是谁"（401），
 * 风险门再答"你确认过风险了吗"（403）；顺序反了会让未鉴权的探测请求看到
 * 403 而不是 401，把鉴权失败伪装成合规拦截，排查方向整个带偏。
 */
export function registerRiskGate(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/v1/')) return;
    // CORS 预检不携带自定义头，也不产生实际调用，放行。
    if (req.method === 'OPTIONS') return;
    if (isRiskDisclaimerAccepted()) return;
    const err = new ProxyError(
      ErrorCode.RISK_DISCLAIMER_NOT_ACCEPTED,
      'Risk disclaimer has not been accepted yet. Open the dashboard and confirm it, '
        + 'or set ACCEPTED_RISK_DISCLAIMER=1.',
    );
    return req.url.startsWith('/v1/messages')
      ? reply.status(err.status).send(err.anthropicPayload())
      : reply.status(err.status).send({ error: err.openAIPayload() });
  });
}
