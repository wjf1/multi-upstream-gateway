// =============================================================================
// T302：WorkBuddy 余额镜像的管理面端点
// -----------------------------------------------------------------------------
// GET  /api/upstreams/workbuddy/balance          —— 只读镜像（含 degraded/persistedAt）
// POST /api/upstreams/workbuddy/balance/refresh  —— 手动强制刷新（sidecar 不可用 → 503）
// 另断言：未装配 runtime / workbuddy 未接线 → 404 优雅降级。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderRuntime } from '../src/providers/runtime.js';

let stateDir = '';
let dashboardRoutes: typeof import('../src/routes/dashboard.js')['dashboardRoutes'];
let ADMIN_TOKEN: string;

/** 空转 workbuddy provider：只暴露 T302 的两个方法。 */
function wbStub(over: Partial<Record<'balanceStatus' | 'refreshBalance', unknown>> = {}) {
  return {
    balanceStatus: () => ({
      filePath: 'C:/tmp/state.json',
      refreshedAt: 1_800_000_000_000,
      persistedAt: 1_800_000_000_000,
      intervalMs: 300_000,
      nextRefreshAt: 1_800_000_300_000,
      consecutiveFailures: 0,
      degraded: false,
      accounts: [{ uid: 'u1', nickname: '甲', credits: 42.5, paused: false, disabled: false, cooling: false, sampledAt: 1_800_000_000_000 }],
    }),
    refreshBalance: async () => ({ ok: true, persisted: true, accounts: 1, refreshedAt: 1_800_000_000_000 }),
    ...over,
  };
}

function appWith(runtime?: ProviderRuntime): FastifyInstance {
  const app = Fastify();
  if (runtime) app.decorate('providerRuntime', runtime);
  void app.register(dashboardRoutes);
  return app;
}

function stubRuntime(provider: unknown): ProviderRuntime {
  return { get: (name: string) => (name === 'workbuddy' ? provider : undefined) } as unknown as ProviderRuntime;
}

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-t302-routes-'));
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_ENV_PATH = path.join(stateDir, '.env');
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  process.env.COMMANDCODE_STATE_PATH = path.join(stateDir, 'state.json');
  ({ dashboardRoutes } = await import('../src/routes/dashboard.js'));
  ({ ADMIN_TOKEN } = await import('../src/utils/admin-guard.js'));
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('T302 余额端点', () => {
  it('GET balance 返回只读镜像（含 degraded / persistedAt / 积分）', async () => {
    const app = appWith(stubRuntime(wbStub()));
    const res = await app.inject({ method: 'GET', url: '/api/upstreams/workbuddy/balance' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, intervalMs: 300_000, degraded: false, persistedAt: 1_800_000_000_000 });
    expect(body.accounts[0]).toMatchObject({ uid: 'u1', credits: 42.5 });
    await app.close();
  });

  it('POST balance/refresh 成功 → ok + 回读快照', async () => {
    const app = appWith(stubRuntime(wbStub()));
    const res = await app.inject({
      method: 'POST',
      url: '/api/upstreams/workbuddy/balance/refresh',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, persisted: true, accounts: 1 });
    await app.close();
  });

  it('POST balance/refresh sidecar 不可用 → 503 且不谎报成功', async () => {
    const app = appWith(
      stubRuntime(
        wbStub({
          refreshBalance: async () => ({ ok: false, persisted: false, accounts: 0, refreshedAt: 0 }),
        }),
      ),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/upstreams/workbuddy/balance/refresh',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false });
    await app.close();
  });

  it('未装配 runtime / workbuddy 未接线 → 404 优雅降级', async () => {
    const bare = appWith();
    expect((await bare.inject({ method: 'GET', url: '/api/upstreams/workbuddy/balance' })).statusCode).toBe(404);
    await bare.close();

    const other = appWith(stubRuntime({ listAccounts: () => [] }));
    expect((await other.inject({ method: 'GET', url: '/api/upstreams/workbuddy/balance' })).statusCode).toBe(404);
    await other.close();
  });
});
