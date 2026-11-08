// =============================================================================
// 请求路由层核心 —— 六步决策（执行依据：master-plan v1.2 §3.3，T104）
// -----------------------------------------------------------------------------
// 只做「选哪个 provider + 模型名规范化」的决策逻辑，纯函数语义、零 IO、零 HTTP：
// Fastify 路由的接线（调用本模块、把 decision 映射为 X-Actual-Upstream /
// X-Request-Id 响应头、把 ProxyError 映射为 OpenAI/Anthropic 错误信封）属
// T213 统一 API 层，本文件不感知 HTTP 概念。
//
// 六步决策（按序短路，先命中先用）：
//   1. `X-Upstream-Provider` Header 显式指定；
//   2. `extra_body.upstream_provider`（请求体扩展）；
//   3. 模型名前缀（`codebuddy/glm-5.2` → 剥前缀路由 workbuddy）；
//   4. 统一模型注册表隐式映射（裸名唯一命中才放行，歧义抛 MODEL_AMBIGUOUS）；
//   5. 会话粘性（本阶段只留注入点）；
//   6. upstreamPriority 取第一个 enabled 的 provider（兜底）。
// 全部落空 → 抛 NO_PROVIDER_AVAILABLE(503)，error.context 携带 retryAfterSeconds
// 建议值，message 含 Retry-After 字样（T213 据此设置 Retry-After 响应头）。
//
// 会话粘性说明（G0-T2 裁决）：联邦路线下 WorkBuddy 的粘性由 sidecar 承接，
// 本阶段只留注入点——RoutingInput.conversationId 可选，RouterDeps.stickyResolver
// 默认 undefined 不启用；决策结果以 stickyHit 标记粘性命中。粘性命中是提示性
// 的：resolver 返回的 provider 若已被禁用，视为落空继续 priority 兜底。
// =============================================================================

import type { ProviderName } from './interface.js';
import { ErrorCode, ProxyError } from '../../utils/errors.js';
import type { ProviderRegistry } from './registry.js';

// ─── 输入 / 输出契约 ─────────────────────────────────────────────────────────

/** 路由决策的来源（对应 §3.3 六步）。 */
export type RouteVia = 'header' | 'extra_body' | 'prefix' | 'registry' | 'sticky' | 'priority';

/** 路由决策结果（T213 接线时映射为响应头：provider → X-Actual-Upstream，requestId → X-Request-Id）。 */
export interface RouteDecision {
  /** 选中的上游 provider（命名空间标识）。 */
  provider: ProviderName;
  /** 规范化后的模型名（带命名空间前缀的已剥除，直接交给 provider 适配器）。 */
  model: string;
  /** 全链路请求 ID（入口 T105 生成，此处原样透传）。 */
  requestId: string;
  /** 决策来源步骤。 */
  via: RouteVia;
  /** 仅 via='sticky' 时为 true（§3.5 会话粘性命中）。 */
  stickyHit?: boolean;
  /** T304：强制指定的上游账号 ID（来自 X-Upstream-Account）。 */
  preferredAccountId?: string;
  /**
   * 重试建议秒数。成功决策恒缺省；NO_PROVIDER_AVAILABLE 走错误路径（抛
   * ProxyError），建议值由 error.context.retryAfterSeconds 承载——本字段为
   * T213/后续任务预留（如未来 sidecar 在决策期返回冷却窗口）。
   */
  retryAfterSeconds?: number;
}

/** 路由输入（HTTP 无关：headers/body 由 T213 从 Fastify request 提取后传入）。 */
export interface RoutingInput {
  /** 请求头（值可为 undefined；header 名大小写不敏感）。 */
  headers: Record<string, string | undefined>;
  /** OpenAI 侧请求体（仅取路由相关字段）。 */
  body?: {
    model?: string;
    extra_body?: { upstream_provider?: string };
  };
  /** 会话标识（§3.5 粘性键；客户端提供或 HTTP 层派生）。 */
  conversationId?: string;
  /** 全链路请求 ID（必传，原样进 decision）。 */
  requestId: string;
}

/** 路由器依赖（全部注入，保持可测）。 */
export interface RouterDeps {
  /**
   * 上游优先级序（步骤 6 兜底按序取第一个 enabled 的 provider）。
   * 同时是「enabled 状态」的裁决来源之外的全部路由知识——本模块不直接
   * 依赖 IProvider 实例，enabled 与否经 isProviderEnabled 回调注入。
   */
  upstreamPriority: ProviderName[];
  /** provider 总闸查询（T213 用 IProvider.isEnabled() 实现）。 */
  isProviderEnabled: (name: ProviderName) => boolean;
  /** 统一模型注册表（步骤 4 隐式映射）。 */
  registry: ProviderRegistry;
  /**
   * 会话粘性解析器（默认 undefined 不启用）。联邦路线下 WorkBuddy 粘性由
   * sidecar 承接（G0-T2 裁决）；后续任务如需网关侧粘性（如 T213 派生
   * conversationId 后查映射表），注入本回调即可，路由决策本体无需改动。
   */
  stickyResolver?: (conversationId: string) => ProviderName | undefined;
  /** T304：会话粘性是否启用（默认 true）。设为 false 则跳过粘性决策。 */
  sessionStickyEnabled?: boolean;
  /** T304：模型名前缀路由是否启用（默认 true）。设为 false 则跳过前缀剥离。 */
  modelPrefixRouting?: boolean;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 步骤 1 的显式指定 header（比对时大小写不敏感）。 */
export const UPSTREAM_PROVIDER_HEADER = 'x-upstream-provider';

/** T304：强制指定账号 header（比对时大小写不敏感）。 */
export const UPSTREAM_ACCOUNT_HEADER = 'x-upstream-account';

/** NO_PROVIDER_AVAILABLE 的 Retry-After 建议值（秒）。 */
export const DEFAULT_RETRY_AFTER_SECONDS = 30;

/**
 * 模型名前缀 → provider 映射。
 * `codebuddy` 是 WorkBuddy 的对外命名空间别名（§3.3 示例 `codebuddy/glm-5.2`；
 * interface.ts 命名空间注释与 errors.ts 的 MODEL_AMBIGUOUS 提示同口径）。
 */
const PREFIX_TO_PROVIDER: Readonly<Record<string, ProviderName>> = {
  commandcode: 'commandcode',
  freebuff: 'freebuff',
  workbuddy: 'workbuddy',
  codebuddy: 'workbuddy',
};

const VALID_PROVIDERS: readonly ProviderName[] = ['commandcode', 'freebuff', 'workbuddy'];

// ─── 内部工具 ────────────────────────────────────────────────────────────────

/** 大小写不敏感地取 header 值（返回原始值，调用方自行归一化）。 */
function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name && headers[key] !== undefined) return headers[key];
  }
  return undefined;
}

/** 把显式指定值归一化为 ProviderName；非法返回 undefined。 */
function normalizeProvider(raw: string): ProviderName | undefined {
  const v = raw.trim().toLowerCase();
  return (VALID_PROVIDERS as readonly string[]).includes(v) ? (v as ProviderName) : undefined;
}

/**
 * 剥模型名的路由前缀：`codebuddy/glm-5.2` → { provider: 'workbuddy', bare: 'glm-5.2' }。
 * 仅识别 PREFIX_TO_PROVIDER 中的前缀；未知前缀（如 `openai/gpt-4o`）、
 * 空段（`/m`、`p/`）不算路由前缀，模型名原样返回 undefined。
 */
function splitRoutingPrefix(model: string): { provider: ProviderName; bare: string } | undefined {
  const idx = model.indexOf('/');
  if (idx <= 0 || idx === model.length - 1) return undefined;
  const provider = PREFIX_TO_PROVIDER[model.slice(0, idx).toLowerCase()];
  if (!provider) return undefined;
  return { provider, bare: model.slice(idx + 1) };
}

// ─── 路由器 ──────────────────────────────────────────────────────────────────

export class RequestRouter {
  constructor(private readonly deps: RouterDeps) {}

  /**
   * 六步决策主入口。可失败：抛 ProxyError（非法显式值 → UNSUPPORTED_OPTION(400)；
   * 显式点名 disabled provider 或全落空 → NO_PROVIDER_AVAILABLE(503)；
   * 裸名歧义 → MODEL_AMBIGUOUS(400)）。
   */
  route(input: RoutingInput): RouteDecision {
    const { requestId } = input;
    const preferredAccountId = getHeader(input.headers, UPSTREAM_ACCOUNT_HEADER);

    // 步骤 1：X-Upstream-Provider 显式指定（优先级最高）。
    const headerRaw = getHeader(input.headers, UPSTREAM_PROVIDER_HEADER);
    if (headerRaw !== undefined && headerRaw.trim() !== '') {
      return this.decideExplicit(input, headerRaw, 'header', preferredAccountId);
    }

    // 步骤 2：extra_body.upstream_provider。
    const bodyRaw = input.body?.extra_body?.upstream_provider;
    if (typeof bodyRaw === 'string' && bodyRaw.trim() !== '') {
      return this.decideExplicit(input, bodyRaw, 'extra_body', preferredAccountId);
    }

    // 步骤 3：模型名前缀（前缀 = provider name 或其对外别名）。
    const model = input.body?.model ?? '';
    if (this.deps.modelPrefixRouting !== false) {
      const prefixed = splitRoutingPrefix(model);
      if (prefixed) {
        return {
          provider: prefixed.provider,
          model: prefixed.bare,
          requestId,
          via: 'prefix',
          ...(preferredAccountId ? { preferredAccountId } : {}),
        };
      }
    }

    // 步骤 4：统一模型注册表隐式映射（裸名仅在唯一命中时放行）。
    if (model !== '') {
      const hits = this.deps.registry.resolve(model);
      if (hits.length > 1) {
        throw new ProxyError(
          ErrorCode.MODEL_AMBIGUOUS,
          `Bare model "${model}" matches multiple providers (${hits.join(', ')}). ` +
            `Retry with a namespaced model id, e.g. ${hits.map((p) => `${p}/${model}`).join(' or ')}.`,
          { context: { requestId, bareModel: model, candidates: hits } },
        );
      }
      if (hits.length === 1) {
        return {
          provider: hits[0],
          model,
          requestId,
          via: 'registry',
          ...(preferredAccountId ? { preferredAccountId } : {}),
        };
      }
    }

    // 步骤 5：会话粘性（默认启用；命中仅作提示，provider disabled 则视为落空）。
    if (this.deps.sessionStickyEnabled !== false && input.conversationId !== undefined && this.deps.stickyResolver) {
      const sticky = this.deps.stickyResolver(input.conversationId);
      if (sticky && this.deps.isProviderEnabled(sticky)) {
        return {
          provider: sticky,
          model,
          requestId,
          via: 'sticky',
          stickyHit: true,
          ...(preferredAccountId ? { preferredAccountId } : {}),
        };
      }
    }

    // 步骤 6：upstreamPriority 兜底——取第一个 enabled 的 provider。
    for (const name of this.deps.upstreamPriority) {
      if (this.deps.isProviderEnabled(name)) {
        return {
          provider: name,
          model,
          requestId,
          via: 'priority',
          ...(preferredAccountId ? { preferredAccountId } : {}),
        };
      }
    }

    // 全部落空：无任何 enabled provider 可承接。
    throw new ProxyError(
      ErrorCode.NO_PROVIDER_AVAILABLE,
      `No enabled provider can serve this request (priority: ` +
        `${this.deps.upstreamPriority.join(', ') || '(empty)'}, all disabled). ` +
        `Enable a provider in the dashboard and retry. ` +
        `Suggested Retry-After: ${DEFAULT_RETRY_AFTER_SECONDS} seconds.`,
      {
        context: {
          requestId,
          retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        },
      },
    );
  }

  /**
   * 步骤 1/2 共用：显式指定路由。显式点名被禁用的 provider 直接抛
   * NO_PROVIDER_AVAILABLE（总闸关闭即「新请求不再进入」，不静默回退——回退会让
   * 计费/额度归属偏离调用方预期）；body.model 若带已知命名空间前缀则剥除
   * （前缀只是路由提示，被更高优先级覆盖后不把脏名传给上游）。
   */
  private decideExplicit(
    input: RoutingInput,
    raw: string,
    via: 'header' | 'extra_body',
    preferredAccountId?: string,
  ): RouteDecision {
    const provider = normalizeProvider(raw);
    if (!provider) {
      const field = via === 'header' ? `${UPSTREAM_PROVIDER_HEADER} header` : 'extra_body.upstream_provider';
      throw new ProxyError(
        ErrorCode.UNSUPPORTED_OPTION,
        `Invalid ${field} value "${raw.trim()}". Valid providers: ${VALID_PROVIDERS.join(', ')}.`,
        { context: { requestId: input.requestId, rawValue: raw, via } },
      );
    }
    if (!this.deps.isProviderEnabled(provider)) {
      throw new ProxyError(
        ErrorCode.NO_PROVIDER_AVAILABLE,
        `Provider "${provider}" was explicitly requested (via ${via}) but is currently disabled. ` +
          `Enable it in the dashboard or drop the explicit selection to use priority fallback. ` +
          `Suggested Retry-After: ${DEFAULT_RETRY_AFTER_SECONDS} seconds.`,
        { context: { requestId: input.requestId, requestedProvider: provider, via, retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS } },
      );
    }
    const model = input.body?.model ?? '';
    const prefixed = splitRoutingPrefix(model);
    return {
      provider,
      model: prefixed ? prefixed.bare : model,
      requestId: input.requestId,
      via,
      ...(preferredAccountId ? { preferredAccountId } : {}),
    };
  }
}
