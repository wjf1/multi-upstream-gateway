// =============================================================================
// 安全中间件链测试（T105 DoD：modelAccess / 请求 ID 传播 / 限流 429 / 日志脱敏验收）
// -----------------------------------------------------------------------------
// registerSecurityGuards 是 /v1/* 的纵深防御入口：
//   onRequest  —— 请求 ID 生成与传播（X-Request-Id 响应头）；
//   preHandler —— modelAccess allow/block（403 MODEL_ACCESS_DENIED）+ 全局与
//                 per-provider 限流（429 + Retry-After;T213 前按 header/前缀预判）;
//   onResponse —— 请求完成日志（带 requestId,经 sanitizeLog）。
// 验收用例复刻任务卡:带错误 Bearer 发起一次请求,断言日志捕获中无 `Bearer sk-`
// 与 20+ 位 key 片段。
// =============================================================================

import { describe, expect, it, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

import { logger } from '../src/utils/logger.js';
import { RateLimiter } from '../src/utils/rate-limiter.js';
import {
  isModelAllowed,
  predictProviderForRateLimit,
  registerSecurityGuards,
  resolveModelAccessConfigFromEnv,
  type ModelAccessConfig,
} from '../src/utils/security-guard.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

function buildApp(opts: Parameters<typeof registerSecurityGuards>[1] = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerSecurityGuards(app, opts);
  // mock 数据面路由：守卫逻辑在本测试里与真实上游解耦。
  app.post('/v1/chat/completions', async () => ({ ok: true }));
  app.post('/v1/messages', async () => ({ ok: true }));
  return app;
}

const post = (
  app: FastifyInstance,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) => app.inject({ method: 'POST', url, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });

// ─── modelAccess 纯函数 ───────────────────────────────────────────────────────

describe('isModelAllowed —— allow/block 判定', () => {
  const cfg: ModelAccessConfig = { allowlist: ['glm-5*', 'claude-*'], blocklist: ['bad-model', 'internal/*'] };

  it('blocklist 命中即拒绝（精确与通配）', () => {
    expect(isModelAllowed('bad-model', cfg)).toBe(false);
    expect(isModelAllowed('internal/secret-x', cfg)).toBe(false);
  });

  it('blocklist 优先于 allowlist', () => {
    expect(isModelAllowed('bad-model', { allowlist: ['bad-model'], blocklist: ['bad-model'] })).toBe(false);
  });

  it('allowlist 非空时未命中即拒绝,命中即放行', () => {
    expect(isModelAllowed('glm-5.3', cfg)).toBe(true);
    expect(isModelAllowed('claude-sonnet-4', cfg)).toBe(true);
    expect(isModelAllowed('gpt-9', cfg)).toBe(false);
  });

  it('allowlist 为空 = 不设白名单,仅受 blocklist 约束', () => {
    const only = { allowlist: [], blocklist: ['evil-model'] };
    expect(isModelAllowed('any-model', only)).toBe(true);
    expect(isModelAllowed('evil-model', only)).toBe(false);
  });

  it('两表皆空 = 全放行(默认零破坏)', () => {
    expect(isModelAllowed('anything', { allowlist: [], blocklist: [] })).toBe(true);
  });
});

describe('predictProviderForRateLimit —— T213 前的预判', () => {
  it('X-Upstream-Provider header 优先', () => {
    expect(
      predictProviderForRateLimit({ 'x-upstream-provider': 'workbuddy' }, { model: 'commandcode/m' }),
    ).toBe('workbuddy');
  });

  it('模型名前缀次之,codebuddy 归一为 workbuddy', () => {
    expect(predictProviderForRateLimit({}, { model: 'codebuddy/glm-5.2' })).toBe('workbuddy');
    expect(predictProviderForRateLimit({}, { model: 'freebuff/m1' })).toBe('freebuff');
  });

  it('预判不到回退 default 桶', () => {
    expect(predictProviderForRateLimit({}, { model: 'bare-model' })).toBe('default');
    expect(predictProviderForRateLimit({}, undefined)).toBe('default');
  });

  it('header 值经归一化（小写/去非法字符/截断）后作为独立桶 key', () => {
    expect(predictProviderForRateLimit({ 'x-upstream-provider': 'Alpha-1' }, {})).toBe('alpha-1');
    expect(predictProviderForRateLimit({ 'x-upstream-provider': 'hacker#' }, { model: 'freebuff/m' })).toBe('hacker');
    // 已知 provider 名仍归一到标准名
    expect(predictProviderForRateLimit({ 'x-upstream-provider': 'CodeBuddy' }, {})).toBe('workbuddy');
  });
});

describe('resolveModelAccessConfigFromEnv —— env 兜底', () => {
  it('逗号分隔解析,空白项忽略', () => {
    const cfg = resolveModelAccessConfigFromEnv({ MODEL_ACCESS_ALLOW: 'glm-5*, ', MODEL_ACCESS_BLOCK: 'bad' });
    expect(cfg.allowlist).toEqual(['glm-5*']);
    expect(cfg.blocklist).toEqual(['bad']);
  });

  it('未设置时空表（全放行）', () => {
    expect(resolveModelAccessConfigFromEnv({})).toEqual({ allowlist: [], blocklist: [] });
  });
});

// ─── 中间件链集成 ─────────────────────────────────────────────────────────────

describe('registerSecurityGuards 集成', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('请求 ID:未携带时生成 UUID 并回传 X-Request-Id 响应头', async () => {
    app = buildApp();
    const res = await post(app, '/v1/chat/completions', { model: 'm' });
    expect(res.statusCode).toBe(200);
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('请求 ID:合法 x-request-id 透传复用(跨网关链路关联)', async () => {
    app = buildApp();
    const client = `req-${randomUUID()}`;
    const res = await post(app, '/v1/chat/completions', { model: 'm' }, { 'x-request-id': client });
    expect(res.headers['x-request-id']).toBe(client);
  });

  it('请求 ID:非法 x-request-id(超长/控制字符)不透传,重新生成', async () => {
    app = buildApp();
    const res = await post(app, '/v1/chat/completions', { model: 'm' }, { 'x-request-id': 'bad id\nwith\tnewline!' });
    const id = String(res.headers['x-request-id']);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('modelAccess:blocklist 命中 → 403 MODEL_ACCESS_DENIED,OpenAI 信封 type=permission_error', async () => {
    app = buildApp({ modelAccess: { allowlist: [], blocklist: ['forbidden-model'] } });
    const res = await post(app, '/v1/chat/completions', { model: 'forbidden-model' });
    expect(res.statusCode).toBe(403);
    const payload = res.json();
    expect(payload.error.code).toBe('MODEL_ACCESS_DENIED');
    expect(payload.error.type).toBe('permission_error');
  });

  it('modelAccess:allowlist 非空且未命中 → 403;Anthropic 出口为 error.type=permission_error', async () => {
    app = buildApp({ modelAccess: { allowlist: ['glm-5*'], blocklist: [] } });
    const res = await post(app, '/v1/messages', { model: 'other-model' });
    expect(res.statusCode).toBe(403);
    const payload = res.json();
    expect(payload.type).toBe('error');
    expect(payload.error.type).toBe('permission_error');
    expect(payload.error.code).toBe('MODEL_ACCESS_DENIED');
  });

  it('modelAccess:allowlist 命中放行', async () => {
    app = buildApp({ modelAccess: { allowlist: ['glm-5*'], blocklist: [] } });
    const res = await post(app, '/v1/chat/completions', { model: 'glm-5.3' });
    expect(res.statusCode).toBe(200);
  });

  it('限流:全局桶超限 → 429 + Retry-After 头(1..60 整数)', async () => {
    app = buildApp({ rateLimiter: new RateLimiter({ global: { rpm: 2 } }) });
    expect((await post(app, '/v1/chat/completions', { model: 'm' })).statusCode).toBe(200);
    expect((await post(app, '/v1/chat/completions', { model: 'm' })).statusCode).toBe(200);
    const third = await post(app, '/v1/chat/completions', { model: 'm' });
    expect(third.statusCode).toBe(429);
    const retryAfter = parseInt(String(third.headers['retry-after']), 10);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(third.json().error.code).toBe('RATE_LIMIT');
  });

  it('限流:per-provider 桶独立 —— provider A 耗尽后 B 不受限(互不误伤)', async () => {
    app = buildApp({
      rateLimiter: new RateLimiter({ perProvider: { alpha: { rpm: 1 } } }),
    });
    const firstA = await post(app, '/v1/chat/completions', { model: 'm' }, { 'x-upstream-provider': 'alpha' });
    expect(firstA.statusCode).toBe(200);
    const secondA = await post(app, '/v1/chat/completions', { model: 'm' }, { 'x-upstream-provider': 'alpha' });
    expect(secondA.statusCode).toBe(429);
    expect(secondA.headers['retry-after']).toBeTruthy();
    // provider B 独立桶,不受 alpha 耗尽影响
    const firstB = await post(app, '/v1/chat/completions', { model: 'm' }, { 'x-upstream-provider': 'beta' });
    expect(firstB.statusCode).toBe(200);
  });

  it('限流:TPM 按 body 大小预扣,超限 429', async () => {
    app = buildApp({ rateLimiter: new RateLimiter({ global: { tpm: 50 } }) });
    const big = 'x'.repeat(400); // 4 字符 ≈ 1 token → 约 100 token,超 50
    const res = await post(app, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: big }] });
    expect(res.statusCode).toBe(429);
  });

  it('CORS 预检(OPTIONS)不参与限流与模型判定', async () => {
    app = buildApp({ rateLimiter: new RateLimiter({ global: { rpm: 1 } }), modelAccess: { allowlist: ['glm-5*'], blocklist: [] } });
    const pre = await app.inject({ method: 'OPTIONS', url: '/v1/chat/completions' });
    expect([200, 204, 404]).toContain(pre.statusCode); // 未注册 OPTIONS 路由 → 404,但绝不能是 429/403
  });
});

// ─── 验收:日志脱敏(带错误 Bearer 的一次请求)──────────────────────────────────

describe('验收 —— 带错误 Bearer 请求后日志无凭据', () => {
  it('日志捕获中不含 "Bearer sk-" 与 20+ 位 key 片段', async () => {
    process.env.PROXY_API_KEY = 'real-gateway-key-9876543210abcdef';
    const { verifyProxyAuth } = await import('../src/routes/chat.js');
    const app = Fastify({ logger: false });
    verifyProxyAuth(app);
    registerSecurityGuards(app);
    app.post('/v1/chat/completions', async () => ({ ok: true }));

    const leaked = 'sk-TEST0123456789abcdefghijklmn';
    logger.clearLogs();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${leaked}`,
          'x-api-key': 'sk-ABCDEF0123456789ABCDEF01',
        },
        body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.statusCode).toBe(401);

      const captured = logger.getLogs().map(l => l.message).join('\n');
      expect(captured).not.toMatch(/Bearer\s+sk/i);
      expect(captured).not.toContain(leaked);
      expect(captured).not.toContain('sk-ABCDEF0123456789ABCDEF01');
      expect(captured).not.toMatch(/Bearer\s+\S{20,}/);
      // 请求完成日志带 requestId(链路可追溯)
      expect(captured).toMatch(/requestId=[0-9a-f-]{36}/);
    } finally {
      delete process.env.PROXY_API_KEY;
      await app.close();
    }
  });
});
