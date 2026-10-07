// =============================================================================
// T213 阶段 1：/api/providers 管理面端点
// -----------------------------------------------------------------------------
// - GET  /api/providers                    —— 三源状态（含 sidecar 视图）
// - POST /api/providers/:name/enable       —— 总闸热生效
// - POST /api/providers/:name/disable
// - POST /api/providers/registry/refresh   —— 注册表刷新
// 未装配 runtime 时端点优雅降级（GET 返回空表，写端点 404），不 500。
// 写端点受管理面鉴权约束（非 GET /api/* 需 x-admin-token）—— 401 分支一并锁定。
// 手法：fastify.inject 端到端；runtime 用 stub 装饰；ADMIN_API_TOKEN 在动态
// import dashboard.ts 之前设置（admin-guard 是模块加载期常量）。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ProviderRuntime } from '../src/providers/runtime.js';

const ADMIN_TOKEN = 'test-admin-token-t213';

interface StubState {
  calls: string[];
  enabled: Record<string, boolean>;
  refreshed: number;
}

function makeStub(): { runtime: ProviderRuntime; state: StubState } {
  const state: StubState = { calls: [], enabled: { commandcode: true, freebuff: true, workbuddy: false }, refreshed: 0 };
  const runtime = {
    async status() {
      state.calls.push('status');
      return [
        { name: 'commandcode', displayName: 'CommandCode', enabled: state.enabled.commandcode, configured: true, initialized: true, health: { healthy: true, total: 1, cooldownCount: 0, disabledCount: 0 } },
        {
          name: 'workbuddy',
          displayName: 'WorkBuddy',
          enabled: state.enabled.workbuddy,
          configured: true,
          initialized: true,
          health: { healthy: false, total: 0, cooldownCount: 0, disabledCount: 0 },
          sidecar: { state: 'stopped', pid: null, restarts: 0, healthy: false, baseUrl: 'http://127.0.0.1:8787' },
        },
      ];
    },
    enable(name: string) {
      state.calls.push(`enable:${name}`);
      if (!(name in state.enabled)) return false;
      state.enabled[name] = true;
      return true;
    },
    disable(name: string) {
      state.calls.push(`disable:${name}`);
      if (!(name in state.enabled)) return false;
      state.enabled[name] = false;
      return true;
    },
    async refreshRegistry() {
      state.refreshed += 1;
    },
    namespacedModels() {
      return [{ id: 'freebuff/mock-model', object: 'model', created: 1, owned_by: 'Freebuff' }];
    },
  } as unknown as ProviderRuntime;
  return { runtime, state };
}

describe('/api/providers（T213 阶段 1）', () => {
  let app: FastifyInstance;
  let stub: StubState;

  beforeAll(async () => {
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    const { dashboardRoutes } = await import('../src/routes/dashboard.js');
    app = Fastify();
    const { runtime, state } = makeStub();
    stub = state;
    app.decorate('providerRuntime', runtime);
    await app.register(dashboardRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ADMIN_API_TOKEN;
  });

  it('GET /api/providers 返回三源状态（含 sidecar 视图）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runtime).toBe(true);
    expect(body.providers).toHaveLength(2);
    expect(body.providers[0]).toMatchObject({ name: 'commandcode', enabled: true, configured: true });
    expect(body.providers[1].sidecar).toMatchObject({ state: 'stopped', baseUrl: 'http://127.0.0.1:8787' });
  });

  it('POST enable/disable 需要 x-admin-token（缺失 401）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/providers/freebuff/disable' });
    expect(res.statusCode).toBe(401);
  });

  it('POST disable/enable 热生效（带 token）', async () => {
    const off = await app.inject({
      method: 'POST',
      url: '/api/providers/freebuff/disable',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ status: 'success', enabled: false });

    const on = await app.inject({
      method: 'POST',
      url: '/api/providers/freebuff/enable',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ status: 'success', enabled: true });
    expect(stub.calls).toContain('disable:freebuff');
    expect(stub.calls).toContain('enable:freebuff');
  });

  it('未知 provider 返回 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/nope/enable',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST registry/refresh 成功并回报名义模型数', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/registry/refresh',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'success', namespacedModels: 1 });
    expect(stub.refreshed).toBe(1);
  });

  it('未装配 runtime 时优雅降级（GET 空表 / 写端点 404）', async () => {
    const bare = Fastify();
    const { dashboardRoutes } = await import('../src/routes/dashboard.js');
    await bare.register(dashboardRoutes);
    await bare.ready();
    try {
      const get = await bare.inject({ method: 'GET', url: '/api/providers' });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ providers: [], runtime: false });

      const post = await bare.inject({
        method: 'POST',
        url: '/api/providers/freebuff/enable',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      expect(post.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
