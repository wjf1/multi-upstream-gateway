// =============================================================================
// 模型访问控制（默认关闭 —— MODEL_ALLOWLIST / MODEL_BLOCKLIST 均未设置时全放行）
// -----------------------------------------------------------------------------
// - MODEL_ALLOWLIST / MODEL_BLOCKLIST：逗号分隔的精确模型 id，大小写不敏感、
//   容忍名单项两侧空格。env 在调用时读取，改了即生效。
// - allowlist 优先：设置了 MODEL_ALLOWLIST 则不在名单内的模型一律拒绝（即使
//   blocklist 未设）；未设 allowlist 时才查 MODEL_BLOCKLIST。
// - 空模型名：设了 allowlist 即拒（不在名单内）；仅 blocklist 时放行。
// - 错误码决策：复用 errors.ts 既有 MODEL_NOT_IN_PLAN（403 / permission_error，
//   现有体系里最贴近"该模型不可用"的码）。不追加 MODEL_BLOCKED —— errors.ts 的
//   STATUS/OPENAI_TYPE/ANTHROPIC_TYPE/HINTS 映射是封闭的 Record<ErrorCodeName, ...>，
//   外部新增码拿不到正确的 status 与 error.type（信封会缺字段），自建 payload
//   又会复制错误信封逻辑，故复用并在 message 里写明 allowlist/blocklist 原因。
// =============================================================================
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ErrorCode, ProxyError } from './errors.js';
import { auditReject } from './audit-log.js';
import { getUnifiedConfigStore } from './config-store-runtime.js';
import { logger } from './logger.js';

function parseList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 尾部通配匹配（判定路径合一后的统一语义）：`glm-5*` 前缀命中 `glm-5.3`；
 * 不含 `*` 为精确匹配；大小写不敏感、容忍模式两侧空格。
 */
export function patternMatches(model: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p.endsWith('*')) return model.toLowerCase().startsWith(p.slice(0, -1));
  return model.toLowerCase() === p;
}

/** 访问判定：allowlist 优先，其次 blocklist；均未设置全放行。大小写不敏感。 */
/**
 * 配置源（判定路径合一，方案 2 落地）：config.json 的 `modelAccess` 分片（经
 * UnifiedConfigStore，热重载）为**唯一配置源**；为空/未装配时按序回退 env——
 * 先 `MODEL_ALLOWLIST` / `MODEL_BLOCKLIST`（路由守卫通道），再弃用的
 * `MODEL_ACCESS_ALLOW` / `MODEL_ACCESS_BLOCK`（旧全局守卫通道，首次命中时打
 * 一次弃用告警，计划下一个大版本移除）。三个通道的匹配语义统一为「精确 +
 * 尾部通配」（`glm-5*`），见 patternMatches。
 */
let warnedLegacyModelAccessEnv = false;

function effectiveLists(): { allow: string[]; block: string[] } {
  const store = getUnifiedConfigStore();
  if (store) {
    try {
      const ma = store.get().modelAccess;
      if (ma && (ma.allowlist.length > 0 || ma.blocklist.length > 0)) {
        const lower = (arr: string[]) => arr.map(s => s.trim().toLowerCase()).filter(Boolean);
        return { allow: lower(ma.allowlist), block: lower(ma.blocklist) };
      }
    } catch { /* store 未加载：回退 env */ }
  }
  if (process.env.MODEL_ALLOWLIST || process.env.MODEL_BLOCKLIST) {
    return { allow: parseList('MODEL_ALLOWLIST'), block: parseList('MODEL_BLOCKLIST') };
  }
  if (process.env.MODEL_ACCESS_ALLOW || process.env.MODEL_ACCESS_BLOCK) {
    if (!warnedLegacyModelAccessEnv) {
      warnedLegacyModelAccessEnv = true;
      logger.warn(
        '[modelAccess] MODEL_ACCESS_ALLOW / MODEL_ACCESS_BLOCK 已弃用：请改用 config.json 的 modelAccess 分片（或 MODEL_ALLOWLIST / MODEL_BLOCKLIST）；该兼容通道计划在下一个大版本移除。',
      );
    }
    return { allow: parseList('MODEL_ACCESS_ALLOW'), block: parseList('MODEL_ACCESS_BLOCK') };
  }
  return { allow: [], block: [] };
}

export function checkModelAccess(model: string): { allowed: boolean; reason?: string } {
  const { allow, block } = effectiveLists();
  if (allow.length === 0 && block.length === 0) return { allowed: true };
  const m = String(model ?? '').trim();
  if (allow.length > 0) {
    if (m && allow.some((p) => patternMatches(m, p))) return { allowed: true };
    return { allowed: false, reason: `not in MODEL_ALLOWLIST (${allow.join(', ')})` };
  }
  if (block.some((p) => patternMatches(m, p))) {
    return { allowed: false, reason: `blocked by MODEL_BLOCKLIST (${block.join(', ')})` };
  }
  return { allowed: true };
}

/**
 * 路由早期守卫（鉴权之后、转发上游之前）：按请求体的 model 字段做访问控制，
 * 被拒时直接响应（403，按出口形态选 OpenAI / Anthropic 信封，并落审计行）。
 * 返回 true 表示已拒绝并写完响应，handler 应立即 return。
 */
export function guardModelAccess(req: FastifyRequest, reply: FastifyReply): boolean {
  const model = String((req.body as any)?.model ?? '').trim();
  const verdict = checkModelAccess(model);
  if (verdict.allowed) return false;
  auditReject(req, 'MODEL_FORBIDDEN', model || null);
  const err = new ProxyError(
    ErrorCode.MODEL_NOT_IN_PLAN,
    `Model "${model}" is rejected by the gateway access policy: ${verdict.reason}. Adjust MODEL_ALLOWLIST / MODEL_BLOCKLIST to change it.`,
  );
  if (req.url.startsWith('/v1/messages')) reply.status(err.status).send(err.anthropicPayload());
  else reply.status(err.status).send({ error: err.openAIPayload() });
  return true;
}
