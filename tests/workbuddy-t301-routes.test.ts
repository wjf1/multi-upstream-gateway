// =============================================================================
// T301：WorkBuddy 面板内授权 + 令牌看护的管理面端点
// -----------------------------------------------------------------------------
// POST /api/upstreams/workbuddy/login/start        —— 发起授权（realm 校验）
// GET  /api/upstreams/workbuddy/login/poll?state=  —— 轮询（404 区分「会话过期」）
// GET  /api/upstreams/workbuddy/tokens             —— 看护状态（pendingRefresh 徽章）
// 另断言：未装配 runtime → 404 优雅降级；响应体永不含 token 字段。
// 前端接线取证：public/js/accounts.js 必须出现端点与授权入口。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderRuntime } from '../src/providers/runtime.js';

const root = path.resolve(__dirname, '..');
const accountsJs = readFileSync(path.join(root, 'public', 'js', 'accounts.js'), 'utf-8');

let stateDir = '';
let dashboardRoutes: typeof import('../src/routes/dashboard.js')['dashboardRoutes'];
let ADMIN_TOKEN: string;

/** 空转 workbuddy provider：只暴露 T301 的三个方法。 */
function wbStub(over: Partial<Record<'loginStart' | 'loginPoll' | 'tokenWatchStatus', unknown>> = {}) {
  return {
    loginStart: async (realm: string) => ({ url: 'https://www.codebuddy.cn/auth?x=1', state: 'st-1', realm }),
    loginPoll: async (_state: string) => ({ done: true, uid: 'u-1', nickname: '甲' }),
    tokenWatchStatus: () => ({
      preRefreshWindowMs: 3_600_000,
      maxRetries: 3,
      accounts: [{ id: 'u-1', pendingRefresh: true, attempts: 4, lastError: 'HTTP 500' }],
      pendingRefresh: ['u-1'],
    }),
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
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-t301-routes-'));
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_ENV_PATH = path.join(stateDir, '.env');
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  ({ dashboardRoutes } = await import('../src/routes/dashboard.js'));
  ({ ADMIN_TOKEN } = await import('../src/utils/admin-guard.js'));
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('T301 授权端点', () => {
  it('login/start 透传 realm 并返回 url/state（无 token 字段）', async () => {
    const app = appWith(stubRuntime(wbStub()));
    const res = await app.inject({
      method: 'POST',
      url: '/api/upstreams/workbuddy/login/start',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: { realm: 'global' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, state: 'st-1', realm: 'global' });
    expect(res.body).not.toMatch(/accessToken|refreshToken/i);
    await app.close();
  });

  it('login/start 拒绝非法 realm（400）', async () => {
    const app = appWith(stubRuntime(wbStub()));
    const res = await app.inject({
      method: 'POST',
      url: '/api/upstreams/workbuddy/login/start',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: { realm: 'us' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('login/start 无管理令牌 → 401', async () => {
    const app = appWith(stubRuntime(wbStub()));
    const res = await app.inject({ method: 'POST', url: '/api/upstreams/workbuddy/login/start', payload: {} });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('login/start sidecar 不可用 → 503（明确报错，不静默）', async () => {
    const app = appWith(
      stubRuntime(
        wbStub({
          loginStart: async () => {
            throw new Error('WorkBuddy sidecar is not available');
          },
        }),
      ),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/upstreams/workbuddy/login/start',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/sidecar is not available/);
    await app.close();
  });

  it('login/poll 缺 state → 400；会话过期 → 404；完成 → done=true', async () => {
    const app = appWith(stubRuntime(wbStub()));
    const missing = await app.inject({ method: 'GET', url: '/api/upstreams/workbuddy/login/poll' });
    expect(missing.statusCode).toBe(400);

    const done = await app.inject({ method: 'GET', url: '/api/upstreams/workbuddy/login/poll?state=st-1' });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ ok: true, done: true, uid: 'u-1', nickname: '甲' });
    await app.close();

    const expired = appWith(
      stubRuntime(
        wbStub({
          loginPoll: async () => {
            throw new Error('workbuddy login state is unknown or expired; please restart the login flow');
          },
        }),
      ),
    );
    const res = await expired.inject({ method: 'GET', url: '/api/upstreams/workbuddy/login/poll?state=gone' });
    expect(res.statusCode).toBe(404);
    await expired.close();
  });
});

describe('T301 令牌看护端点', () => {
  it('GET tokens 返回预刷窗口/重试上限/待刷新集合', async () => {
    const app = appWith(stubRuntime(wbStub()));
    const res = await app.inject({ method: 'GET', url: '/api/upstreams/workbuddy/tokens' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      preRefreshWindowMs: 3_600_000,
      maxRetries: 3,
      pendingRefresh: ['u-1'],
    });
    await app.close();
  });

  it('未装配 runtime / workbuddy 未接线 → 404 优雅降级', async () => {
    const bare = appWith();
    expect((await bare.inject({ method: 'GET', url: '/api/upstreams/workbuddy/tokens' })).statusCode).toBe(404);
    await bare.close();

    const other = appWith(stubRuntime({ listAccounts: () => [] }));
    expect((await other.inject({ method: 'GET', url: '/api/upstreams/workbuddy/tokens' })).statusCode).toBe(404);
    await other.close();
  });
});

describe('T301 面板接线（accounts.js）', () => {
  it('存在授权入口、轮询与待刷新徽章', () => {
    expect(accountsJs).toContain('/api/upstreams/workbuddy/login/start');
    expect(accountsJs).toContain('/api/upstreams/workbuddy/login/poll');
    expect(accountsJs).toContain('/api/upstreams/workbuddy/tokens');
    expect(accountsJs).toContain('添加账号（授权）');
    expect(accountsJs).toContain('待刷新');
    expect(accountsJs).toContain('wbLoginRealm');
    // 旧文案（让用户去 sidecar 原生面板）已被面板内入口取代
    expect(accountsJs).not.toContain('经 sidecar 原生面板 OAuth 登录');
  });
});
