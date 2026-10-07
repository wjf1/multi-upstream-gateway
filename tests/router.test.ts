// =============================================================================
// T104 请求路由层核心 —— 六步决策 + 命名空间规则（执行依据：master-plan v1.2 §3.3）
// -----------------------------------------------------------------------------
// 覆盖：
//   - 六步决策按序短路：header > extra_body > 前缀 > 注册表 > 粘性 > priority；
//   - 前缀剥离正确性（含 codebuddy/ → workbuddy 别名，剥后模型名返回调用方）；
//   - 非法 header 值 → 400；裸名歧义 → MODEL_AMBIGUOUS(400)；全落空 →
//     NO_PROVIDER_AVAILABLE(503) + Retry-After 建议值；
//   - upstreamPriority 跳过 disabled；stickyResolver 注入语义；
//   - ProviderRegistry 命名空间列表与 resolve。
// 本套件只测核心决策（纯函数语义，无 HTTP 接线）；X-Actual-Upstream /
// X-Request-Id 响应头属 HTTP 层（T213 接线），不在此测。
// =============================================================================

import { describe, expect, it } from 'vitest';

import { ErrorCode, ProxyError, type ErrorCodeName } from '../src/utils/errors.js';
import type { ProviderName } from '../src/providers/core/interface.js';
import { ProviderRegistry } from '../src/providers/core/registry.js';
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  RequestRouter,
  type RouterDeps,
  type RoutingInput,
} from '../src/providers/core/router.js';

const ALL_PROVIDERS: ProviderName[] = ['commandcode', 'freebuff', 'workbuddy'];

/** 构造被测路由器：默认全 provider enabled、空注册表。 */
function makeRouter(
  overrides: Partial<RouterDeps> = {},
  registry: ProviderRegistry = new ProviderRegistry(),
): RequestRouter {
  return new RequestRouter({
    upstreamPriority: overrides.upstreamPriority ?? [...ALL_PROVIDERS],
    isProviderEnabled: overrides.isProviderEnabled ?? (() => true),
    registry: overrides.registry ?? registry,
    stickyResolver: overrides.stickyResolver,
  });
}

function input(partial: Partial<RoutingInput>): RoutingInput {
  return {
    headers: {},
    requestId: 'req-test-1',
    ...partial,
  };
}

function route(partial: Partial<RoutingInput>, overrides: Partial<RouterDeps> = {}) {
  return makeRouter(overrides).route(input(partial));
}

/** 统一捕获 ProxyError，断言错误码后返回（缩小后续断言的联合类型）。 */
function expectProxyError(fn: () => unknown, code: ErrorCodeName): ProxyError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProxyError);
    const proxyErr = err as ProxyError;
    expect(proxyErr.code, `期望 ${code}，实际 ${proxyErr.code}`).toBe(code);
    return proxyErr;
  }
  throw new Error(`期望抛出 ${code}，但调用成功返回`);
}

// ─── 步骤 1：X-Upstream-Provider Header 显式指定 ─────────────────────────────

describe('步骤1：X-Upstream-Provider Header 显式指定', () => {
  it('header 值生效，via=header，模型名原样透传', () => {
    const d = route({
      headers: { 'X-Upstream-Provider': 'freebuff' },
      body: { model: 'glm-5.2' },
    });
    expect(d.provider).toBe('freebuff');
    expect(d.via).toBe('header');
    expect(d.model).toBe('glm-5.2');
  });

  it('header 名大小写不敏感，值做 trim + lowercase 归一', () => {
    const d = route({
      headers: { 'x-upstream-provider': '  WorkBuddy  ' },
      body: { model: 'glm-5.2' },
    });
    expect(d.provider).toBe('workbuddy');
    expect(d.via).toBe('header');
  });

  it('非法 header 值 → 400（UNSUPPORTED_OPTION），消息列出全部合法值', () => {
    const err = expectProxyError(
      () => route({ headers: { 'X-Upstream-Provider': 'gemini' }, body: { model: 'x' } }),
      ErrorCode.UNSUPPORTED_OPTION,
    );
    expect(err.status).toBe(400);
    for (const p of ALL_PROVIDERS) expect(err.message).toContain(p);
  });

  it('header 同时覆盖 extra_body 与模型前缀（优先级 header 最高）', () => {
    const d = route({
      headers: { 'X-Upstream-Provider': 'commandcode' },
      body: { model: 'workbuddy/glm-5.2', extra_body: { upstream_provider: 'freebuff' } },
    });
    expect(d.provider).toBe('commandcode');
    expect(d.via).toBe('header');
    expect(d.model).toBe('glm-5.2'); // 已知前缀仍被剥除，避免脏名传给上游
  });

  it('header 点名 disabled 的 provider → NO_PROVIDER_AVAILABLE，不静默回退', () => {
    const err = expectProxyError(
      () =>
        route(
          { headers: { 'X-Upstream-Provider': 'freebuff' }, body: { model: 'm' } },
          { isProviderEnabled: (n) => n !== 'freebuff' },
        ),
      ErrorCode.NO_PROVIDER_AVAILABLE,
    );
    expect(err.status).toBe(503);
    expect(err.message).toContain('freebuff');
  });
});

// ─── 步骤 2：extra_body.upstream_provider ────────────────────────────────────

describe('步骤2：extra_body.upstream_provider', () => {
  it('extra_body 指定生效，via=extra_body', () => {
    const d = route({
      body: { model: 'glm-5.2', extra_body: { upstream_provider: 'workbuddy' } },
    });
    expect(d.provider).toBe('workbuddy');
    expect(d.via).toBe('extra_body');
    expect(d.model).toBe('glm-5.2');
  });

  it('extra_body 非法值 → 400（UNSUPPORTED_OPTION）', () => {
    const err = expectProxyError(
      () =>
        route({ body: { model: 'x', extra_body: { upstream_provider: 'nope' } } }),
      ErrorCode.UNSUPPORTED_OPTION,
    );
    expect(err.status).toBe(400);
  });

  it('extra_body 覆盖模型前缀（优先级 extra_body > prefix）', () => {
    const d = route({
      body: { model: 'workbuddy/glm-5.2', extra_body: { upstream_provider: 'freebuff' } },
    });
    expect(d.provider).toBe('freebuff');
    expect(d.via).toBe('extra_body');
    expect(d.model).toBe('glm-5.2');
  });
});

// ─── 步骤 3：模型名前缀 ──────────────────────────────────────────────────────

describe('步骤3：模型名前缀路由与剥离', () => {
  it('codebuddy/ 别名前缀 → 剥除并路由 workbuddy，剥后模型名返回调用方', () => {
    const d = route({ body: { model: 'codebuddy/glm-5.2' } });
    expect(d.provider).toBe('workbuddy');
    expect(d.model).toBe('glm-5.2');
    expect(d.via).toBe('prefix');
  });

  it('provider 名自身作前缀（workbuddy/）同样剥除，多段模型名保留后续部分', () => {
    const d = route({ body: { model: 'workbuddy/deepseek/v3' } });
    expect(d.provider).toBe('workbuddy');
    expect(d.model).toBe('deepseek/v3');
    expect(d.via).toBe('prefix');
  });

  it('未知前缀不按路由前缀处理：模型名原样落入 priority 兜底', () => {
    const d = route({ body: { model: 'openai/gpt-4o' } });
    expect(d.provider).toBe('commandcode'); // 默认优先级第一个 enabled
    expect(d.model).toBe('openai/gpt-4o');
    expect(d.via).toBe('priority');
  });
});

// ─── 步骤 4：统一模型注册表隐式映射 ─────────────────────────────────────────

describe('步骤4：模型注册表隐式映射', () => {
  it('裸名唯一命中 → 路由到该 provider，via=registry', () => {
    const registry = new ProviderRegistry();
    registry.setProviderModels('commandcode', [{ id: 'glm-5.2' }]);
    const d = route({ body: { model: 'glm-5.2' } }, { registry });
    expect(d.provider).toBe('commandcode');
    expect(d.via).toBe('registry');
    expect(d.model).toBe('glm-5.2');
  });

  it('裸名命中多个 provider → MODEL_AMBIGUOUS(400)，提示带前缀重试', () => {
    const registry = new ProviderRegistry();
    registry.setProviderModels('commandcode', [{ id: 'glm-5.2' }]);
    registry.setProviderModels('workbuddy', [{ id: 'glm-5.2' }]);
    const err = expectProxyError(
      () => route({ body: { model: 'glm-5.2' } }, { registry }),
      ErrorCode.MODEL_AMBIGUOUS,
    );
    expect(err.status).toBe(400);
    // 消息必须给出可用命名空间形式，供调用方直接改请求
    expect(err.message).toContain('commandcode/glm-5.2');
    expect(err.message).toContain('workbuddy/glm-5.2');
  });

  it('裸名注册表未命中 → 落到 priority 兜底，模型名原样', () => {
    const registry = new ProviderRegistry();
    registry.setProviderModels('freebuff', [{ id: 'glm-5.2' }]);
    const d = route({ body: { model: 'unknown-model' } }, { registry });
    expect(d.provider).toBe('commandcode');
    expect(d.via).toBe('priority');
    expect(d.model).toBe('unknown-model');
  });
});

// ─── 步骤 5：会话粘性（本阶段仅注入点，联邦路线下 WorkBuddy 粘性由 sidecar 承接）──

describe('步骤5：会话粘性注入点', () => {
  it('stickyResolver 命中 → via=sticky 且 stickyHit=true', () => {
    const d = route(
      { body: { model: 'glm-5.2' }, conversationId: 'conv-1' },
      { stickyResolver: (cid) => (cid === 'conv-1' ? 'workbuddy' : undefined) },
    );
    expect(d.provider).toBe('workbuddy');
    expect(d.via).toBe('sticky');
    expect(d.stickyHit).toBe(true);
  });

  it('未注入 stickyResolver（默认 undefined）时粘性不启用，落 priority', () => {
    const d = route({ body: { model: 'glm-5.2' }, conversationId: 'conv-1' });
    expect(d.via).toBe('priority');
    expect(d.stickyHit).toBeUndefined();
  });

  it('resolver 返回 undefined → 视为未命中，落到 priority', () => {
    const d = route(
      { body: { model: 'glm-5.2' }, conversationId: 'conv-1' },
      { stickyResolver: () => undefined },
    );
    expect(d.via).toBe('priority');
  });

  it('请求无 conversationId 时即便注入 resolver 也不触发粘性', () => {
    const d = route(
      { body: { model: 'glm-5.2' } },
      { stickyResolver: () => 'workbuddy' },
    );
    expect(d.via).toBe('priority');
  });

  it('sticky 命中 disabled 的 provider → 视为落空继续 priority（粘性是提示非强制）', () => {
    const d = route(
      { body: { model: 'glm-5.2' }, conversationId: 'conv-1' },
      {
        stickyResolver: () => 'workbuddy',
        isProviderEnabled: (n) => n !== 'workbuddy',
      },
    );
    expect(d.via).toBe('priority');
    expect(d.provider).toBe('commandcode');
  });
});

// ─── 步骤 6：upstreamPriority 兜底 ───────────────────────────────────────────

describe('步骤6：upstreamPriority 兜底', () => {
  it('取优先级列表中第一个 enabled 的 provider，via=priority', () => {
    const d = route({ body: { model: 'glm-5.2' } }, {
      upstreamPriority: ['freebuff', 'workbuddy'],
    });
    expect(d.provider).toBe('freebuff');
    expect(d.via).toBe('priority');
  });

  it('跳过 disabled 的 provider，取下一个 enabled', () => {
    const d = route({ body: { model: 'glm-5.2' } }, {
      upstreamPriority: ['commandcode', 'workbuddy'],
      isProviderEnabled: (n) => n !== 'commandcode',
    });
    expect(d.provider).toBe('workbuddy');
    expect(d.via).toBe('priority');
  });

  it('全部 provider disabled → NO_PROVIDER_AVAILABLE(503)，消息含 Retry-After 建议值', () => {
    const err = expectProxyError(
      () => route({ body: { model: 'glm-5.2' } }, { isProviderEnabled: () => false }),
      ErrorCode.NO_PROVIDER_AVAILABLE,
    );
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/Retry-After/i);
    expect(err.message).toContain(String(DEFAULT_RETRY_AFTER_SECONDS));
    expect(err.context.retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);
  });

  it('upstreamPriority 为空列表 → 同样 NO_PROVIDER_AVAILABLE(503)', () => {
    const err = expectProxyError(
      () => route({ body: { model: 'glm-5.2' } }, { upstreamPriority: [] }),
      ErrorCode.NO_PROVIDER_AVAILABLE,
    );
    expect(err.status).toBe(503);
    expect(err.context.retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);
  });
});

// ─── 决策结果形状 ─────────────────────────────────────────────────────────────

describe('RouteDecision 形状', () => {
  it('requestId 原样透传（HTTP 层 T213 据此设 X-Request-Id 响应头）', () => {
    const d = route({ body: { model: 'glm-5.2' }, requestId: 'req-abc-123' });
    expect(d.requestId).toBe('req-abc-123');
  });

  it('成功决策不含 retryAfterSeconds（该值仅在 NO_PROVIDER_AVAILABLE 错误路径由 error.context 携带）', () => {
    const d = route({ body: { model: 'glm-5.2' } });
    expect(d.retryAfterSeconds).toBeUndefined();
    expect(d.stickyHit).toBeUndefined();
  });
});

// ─── 命名空间规则（§3.3 v1.1）：ProviderRegistry ─────────────────────────────

describe('ProviderRegistry：命名空间列表与 resolve', () => {
  it('listNamespaced 为模型 ID 加 provider/ 前缀并按固定 provider 序合并', () => {
    const registry = new ProviderRegistry();
    registry.setProviderModels('workbuddy', [{ id: 'glm-5.2' }]);
    registry.setProviderModels('commandcode', [{ id: 'gpt-4o' }]);
    expect(registry.listNamespaced()).toEqual(['commandcode/gpt-4o', 'workbuddy/glm-5.2']);
  });

  it('resolve 返回命中的 provider 数组：唯一命中长度 1', () => {
    const registry = new ProviderRegistry();
    registry.setProviderModels('freebuff', [{ id: 'glm-5.2' }]);
    expect(registry.resolve('glm-5.2')).toEqual(['freebuff']);
  });

  it('resolve 跨 provider 同名 → 返回全部命中（顺序为 ProviderName 固定序）', () => {
    const registry = new ProviderRegistry();
    registry.setProviderModels('workbuddy', [{ id: 'glm-5.2' }]);
    registry.setProviderModels('commandcode', [{ id: 'glm-5.2' }]);
    expect(registry.resolve('glm-5.2')).toEqual(['commandcode', 'workbuddy']);
  });

  it('resolve 未命中 → 空数组', () => {
    const registry = new ProviderRegistry();
    registry.setProviderModels('freebuff', [{ id: 'glm-5.2' }]);
    expect(registry.resolve('other')).toEqual([]);
  });

  it('setProviderModels 重复设置同一 provider 覆盖旧列表', () => {
    const registry = new ProviderRegistry();
    registry.setProviderModels('commandcode', [{ id: 'old-a' }, { id: 'old-b' }]);
    registry.setProviderModels('commandcode', [{ id: 'new-a' }]);
    expect(registry.listNamespaced()).toEqual(['commandcode/new-a']);
  });

  it('同一 provider 内重复模型 ID 去重；空注册表 listNamespaced 为空', () => {
    const registry = new ProviderRegistry();
    expect(registry.listNamespaced()).toEqual([]);
    registry.setProviderModels('workbuddy', [{ id: 'glm-5.2' }, { id: 'glm-5.2' }]);
    expect(registry.listNamespaced()).toEqual(['workbuddy/glm-5.2']);
  });
});
