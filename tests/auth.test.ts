import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { verifyProxyAuth } from '../src/routes/chat.js';

const KEY = 'test-admin-key-123';

/**
 * 用 fastify.inject 构建不监听端口的鉴权契约测试。
 * 这里的 /api/status 是**桩路由**：批次 B 之后 PROXY_API_KEY 只管 /v1/*，管理面自己的
 * token 门在 dashboard 钩子里，由 tests/admin-boundary.test.ts 端到端锁定。
 */
async function buildApp() {
  const app = Fastify();
  verifyProxyAuth(app);
  app.get('/v1/ping', async () => ({ ok: true }));
  app.post('/v1/messages', async () => ({ ok: true }));
  app.options('/v1/chat/completions', async () => ({ ok: true }));
  app.get('/api/status', async () => ({ ok: true }));
  app.get('/health', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('verifyProxyAuth — PROXY_API_KEY set', () => {
  it('rejects /v1/* without a key', async () => {
    process.env.PROXY_API_KEY = KEY;
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/v1/ping' })).statusCode).toBe(401);
    await app.close();
    delete process.env.PROXY_API_KEY;
  });

  it('does not gate /api/* — 权限分离（P0-2）：数据面密钥不再等于管理面凭据', async () => {
    process.env.PROXY_API_KEY = KEY;
    const app = await buildApp();
    // 不带任何凭据也能读到这个桩管理端点：PROXY_API_KEY 已经不管 /api 了。
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(200);
    // 带对的密钥也不意味着什么 —— 管理面写操作的凭据是 x-admin-token，见 admin-boundary。
    expect(
      (await app.inject({ method: 'GET', url: '/api/status', headers: { 'x-api-key': KEY } })).statusCode
    ).toBe(200);
    await app.close();
    delete process.env.PROXY_API_KEY;
  });

  it('accepts Bearer and x-api-key on the data surface', async () => {
    process.env.PROXY_API_KEY = KEY;
    const app = await buildApp();
    expect(
      (await app.inject({ method: 'GET', url: '/v1/ping', headers: { authorization: `Bearer ${KEY}` } })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/ping', headers: { 'x-api-key': KEY } })).statusCode
    ).toBe(200);
    await app.close();
    delete process.env.PROXY_API_KEY;
  });

  it('rejects a wrong key', async () => {
    process.env.PROXY_API_KEY = KEY;
    const app = await buildApp();
    expect(
      (await app.inject({ method: 'GET', url: '/v1/ping', headers: { 'x-api-key': 'wrong' } })).statusCode
    ).toBe(401);
    await app.close();
    delete process.env.PROXY_API_KEY;
  });

  it('returns the Anthropic error envelope for /v1/messages, OpenAI shape elsewhere', async () => {
    process.env.PROXY_API_KEY = KEY;
    const app = await buildApp();
    const messages = JSON.parse((await app.inject({ method: 'POST', url: '/v1/messages' })).body);
    expect(messages.type).toBe('error');
    expect(messages.error.type).toBe('authentication_error');

    const openai = JSON.parse((await app.inject({ method: 'GET', url: '/v1/ping' })).body);
    expect(openai.error.type).toBe('authentication_error');
    expect(openai.error.code).toBe('PROXY_AUTH_REQUIRED');
    await app.close();
    delete process.env.PROXY_API_KEY;
  });

  it('leaves non-protected paths (e.g. /health, dashboard /) open', async () => {
    process.env.PROXY_API_KEY = KEY;
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await app.close();
    delete process.env.PROXY_API_KEY;
  });

  it('exempts CORS preflight (OPTIONS) from auth — browsers send no auth headers on preflight', async () => {
    process.env.PROXY_API_KEY = KEY;
    const app = await buildApp();
    expect(
      (await app.inject({ method: 'OPTIONS', url: '/v1/chat/completions', headers: { origin: 'https://web.example' } })).statusCode
    ).toBe(200);
    await app.close();
    delete process.env.PROXY_API_KEY;
  });
});

describe('verifyProxyAuth — no key configured', () => {
  it('registers no hook: everything passes', async () => {
    delete process.env.PROXY_API_KEY;
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/v1/ping' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(200);
    await app.close();
  });
});
