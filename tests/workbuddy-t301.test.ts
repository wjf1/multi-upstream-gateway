// =============================================================================
// T301：WorkBuddy OAuth 授权编排 + 令牌看护
// -----------------------------------------------------------------------------
// 覆盖 master-plan v1.2 T301 的四条 DoD：
//   [x] 面板完成授权加账号 —— loginStart 拿 url/state → pollLogin 轮询 →
//       完成后**只回身份字段**（uid/nickname/credits），响应含 accessToken /
//       refreshToken 也必须被丢弃（类型层面就不存在这些出口）。
//   [x] 模拟 refresh 500：重试 → 告警 → 状态「待刷新」——首次 + 3 次重试
//       （1s/2s/4s 指数退避），pendingRefresh=true，webhook 告警恰好一次。
//   [x] 过期前 1h 自动预刷 —— due() 在「距过期 ≤ 1h」命中、2h 不命中。
//   [x] 文件无明文 token —— 网关侧根本不存在 token 字段（本文件以断言兜住）。
// 另覆盖 parseTokenExpiry 的各口径与 sync 的标记保留语义。
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
  WorkBuddyOAuthClient,
  WorkBuddyTokenWatch,
  WorkBuddyLoginTimeoutError,
  parseTokenExpiry,
  PENDING_REFRESH_CODE,
  WB_LOGIN_START_PATH,
  WB_LOGIN_POLL_PATH,
  DEFAULT_PRE_REFRESH_WINDOW_MS,
} from '../src/providers/workbuddy/oauth.js';
import { WorkBuddyProvider, mapPoolSnapshot } from '../src/providers/workbuddy/provider.js';
import type { WorkBuddySidecar } from '../src/providers/workbuddy/sidecar.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── 1. 授权编排 ─────────────────────────────────────────────────────────────

describe('T301 WorkBuddyOAuthClient（面板内授权加账号）', () => {
  it('startLogin 返回 authUrl + state，并带上 realm', async () => {
    const seen: Array<{ url: string; method?: string; body?: string; auth?: string }> = [];
    const client = new WorkBuddyOAuthClient({
      baseUrl: 'http://127.0.0.1:8787/',
      apiKey: 'kp',
      fetchFn: (async (url: string, init: RequestInit) => {
        seen.push({
          url: String(url),
          method: init.method,
          body: String(init.body),
          auth: (init.headers as Record<string, string>).authorization,
        });
        return jsonResponse({ url: 'https://www.codebuddy.cn/auth?x=1', state: 'st-abc', realm: 'cn' });
      }) as unknown as typeof fetch,
    });

    const out = await client.startLogin('cn');
    expect(out).toEqual({ url: 'https://www.codebuddy.cn/auth?x=1', state: 'st-abc', realm: 'cn' });
    expect(seen[0].url).toBe('http://127.0.0.1:8787' + WB_LOGIN_START_PATH);
    expect(seen[0].method).toBe('POST');
    expect(JSON.parse(seen[0].body!)).toEqual({ realm: 'cn' });
    expect(seen[0].auth).toBe('Bearer kp');
  });

  it('startLogin 响应缺 url/state 时明确报错（不返回半成品）', async () => {
    const client = new WorkBuddyOAuthClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchFn: (async () => jsonResponse({ realm: 'cn' })) as unknown as typeof fetch,
    });
    await expect(client.startLogin()).rejects.toThrow(/no auth url\/state/);
  });

  it('pollLogin 未完成 → done=false；完成后只回身份字段，token 字段被丢弃', async () => {
    let phase = 0;
    const client = new WorkBuddyOAuthClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchFn: (async (url: string) => {
        expect(String(url)).toContain(WB_LOGIN_POLL_PATH + '?state=st-abc');
        if (phase++ === 0) return jsonResponse({ done: false, message: 'waiting for login' });
        // 上游即使回传凭据，也不得透出（DoD：文件无明文 token）。
        return jsonResponse({
          done: true,
          uid: 'u-1',
          nickname: '阿蒙',
          realm: 'cn',
          credits: 120,
          accessToken: 'AT-SECRET',
          refreshToken: 'RT-SECRET',
          expiresIn: 5184000,
        });
      }) as unknown as typeof fetch,
    });

    const pending = await client.pollLogin('st-abc');
    expect(pending.done).toBe(false);
    expect(pending.message).toBe('waiting for login');
    expect(pending.uid).toBeUndefined();

    const done = await client.pollLogin('st-abc');
    expect(done.done).toBe(true);
    expect(done.uid).toBe('u-1');
    expect(done.nickname).toBe('阿蒙');
    expect(done.credits).toBe(120);
    // 无任何 token 字段进入网关进程/落盘路径。
    const flat = JSON.stringify(done);
    expect(flat).not.toContain('SECRET');
    expect(Object.keys(done).sort()).toEqual(['credits', 'done', 'nickname', 'realm', 'uid']);
  });

  it('pollLogin 404（state 未知/过期）与其它 HTTP 错误分别报错', async () => {
    const notFound = new WorkBuddyOAuthClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchFn: (async () => jsonResponse({}, 404)) as unknown as typeof fetch,
    });
    await expect(notFound.pollLogin('gone')).rejects.toThrow(/unknown or expired/);

    const boom = new WorkBuddyOAuthClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchFn: (async () => jsonResponse({}, 500)) as unknown as typeof fetch,
    });
    await expect(boom.pollLogin('st')).rejects.toThrow(/HTTP 500/);
  });

  it('waitForLogin 轮询至完成；超时抛 WorkBuddyLoginTimeoutError', async () => {
    let clock = 0;
    const client = new WorkBuddyOAuthClient({
      baseUrl: 'http://127.0.0.1:8787',
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      fetchFn: (async () => jsonResponse(clock >= 6000 ? { done: true, uid: 'u-2' } : { done: false })) as unknown as typeof fetch,
    });
    const ok = await client.waitForLogin('st', { timeoutMs: 60_000, intervalMs: 3_000 });
    expect(ok).toEqual({ done: true, uid: 'u-2' });

    const stalled = new WorkBuddyOAuthClient({
      baseUrl: 'http://127.0.0.1:8787',
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      fetchFn: (async () => jsonResponse({ done: false })) as unknown as typeof fetch,
    });
    await expect(stalled.waitForLogin('st', { timeoutMs: 5_000, intervalMs: 3_000 })).rejects.toBeInstanceOf(
      WorkBuddyLoginTimeoutError,
    );
  });
});

// ─── 2. 令牌看护：重试 / 退避 / 待刷新 / 告警 ────────────────────────────────

describe('T301 WorkBuddyTokenWatch（预刷 / 重试 / 待刷新 / 告警）', () => {
  const NOW = 1_700_000_000_000;

  function makeWatch(opts: {
    // failCount 未指定 = 一直失败；0 = 从不失败；n = 前 n 次失败后成功。
    failCount?: number;
    now?: () => number;
  } = {}) {
    const sleepCalls: number[] = [];
    const alerts: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let calls = 0;
    let clock = NOW;
    const watch = new WorkBuddyTokenWatch({
      triggerRefresh: async () => {
        calls += 1;
        if (opts.failCount === undefined || calls <= opts.failCount) {
          throw new Error('sidecar revive -> HTTP 500');
        }
      },
      notify: async (event, payload) => {
        alerts.push({ event, payload });
        return true;
      },
      now: opts.now ?? (() => clock),
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        clock += ms;
      },
      baseBackoffMs: 1_000,
    });
    return { watch, sleepCalls, alerts, callsFn: () => calls };
  }

  it('刷新 500：首次 + 3 次重试（1s/2s/4s）→ 待刷新 → 告警一次', async () => {
    const { watch, sleepCalls, alerts, callsFn } = makeWatch({});
    watch.sync([{ id: 'acc-1', expiresAt: NOW + 30 * 60_000 }]);

    const out = await watch.refresh('acc-1');
    expect(callsFn()).toBe(4); // 首次 + 3 次重试
    expect(sleepCalls).toEqual([1_000, 2_000, 4_000]); // 指数退避
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(4);
    expect(out.pendingRefresh).toBe(true);
    expect(out.error).toMatch(/HTTP 500/);

    const entry = watch.snapshot().find((e) => e.id === 'acc-1')!;
    expect(entry.pendingRefresh).toBe(true);
    expect(entry.attempts).toBe(4);
    expect(entry.lastError).toMatch(/HTTP 500/);
    expect(watch.pendingRefreshIds()).toEqual(['acc-1']);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].event).toBe('workbuddy-token-refresh-failed');
    expect(alerts[0].payload).toMatchObject({ uid: 'acc-1', attempts: 4, status: PENDING_REFRESH_CODE });
  });

  it('待刷新账号不再被 due() 选中，重复 refresh 也不重复告警', async () => {
    const { watch, alerts } = makeWatch({});
    watch.sync([{ id: 'acc-1', expiresAt: NOW + 60_000 }]);
    expect(watch.due().map((e) => e.id)).toEqual(['acc-1']);

    await watch.refresh('acc-1');
    expect(watch.due()).toEqual([]); // 已待刷新：静默重试停止
    await watch.refresh('acc-1');
    expect(alerts).toHaveLength(1); // 每个 uid 每次进入只告警一次
    // runTick 也不应再打它
    expect(await watch.runTick()).toEqual([]);
  });

  it('中途成功：清 pendingRefresh 并重置告警标记', async () => {
    const { watch, alerts } = makeWatch({ failCount: 2 });
    watch.sync([{ id: 'acc-2', expiresAt: NOW + 60_000 }]);

    const out = await watch.refresh('acc-2');
    expect(out).toMatchObject({ ok: true, attempts: 3, pendingRefresh: false });
    expect(watch.pendingRefreshIds()).toEqual([]);
    expect(alerts).toHaveLength(0);
    const entry = watch.snapshot().find((e) => e.id === 'acc-2')!;
    expect(entry.pendingRefresh).toBe(false);
    expect(entry.lastError).toBeUndefined();
    // 成功后保守推迟到期时刻，避免同 tick 反复触发
    expect(entry.expiresAt).toBeGreaterThan(NOW + DEFAULT_PRE_REFRESH_WINDOW_MS);
  });

  it('runTick 按到期时刻分发：只有进入 1h 窗口的账号被预刷', async () => {
    const { watch } = makeWatch({ failCount: 0 });
    watch.sync([
      { id: 'soon', expiresAt: NOW + 30 * 60_000 }, // 30 分钟后过期 → 命中
      { id: 'later', expiresAt: NOW + 2 * 60 * 60_000 }, // 2 小时后 → 不命中
      { id: 'unknown' }, // 无到期信息 → 不参与
    ]);
    const out = await watch.runTick();
    expect(out.map((o) => o.id)).toEqual(['soon']);
  });

  it('sync 保留既有待刷新/失败信息，账号消失时清除其标记', async () => {
    const { watch, alerts } = makeWatch({});
    watch.sync([{ id: 'acc-9', expiresAt: NOW + 1_000 }]);
    await watch.refresh('acc-9');
    expect(watch.pendingRefreshIds()).toEqual(['acc-9']);

    watch.sync([{ id: 'acc-9', expiresAt: NOW + 1_000 }, { id: 'acc-10' }]);
    const kept = watch.snapshot().find((e) => e.id === 'acc-9')!;
    expect(kept.pendingRefresh).toBe(true);
    expect(kept.attempts).toBe(4);
    expect(kept.lastError).toMatch(/HTTP 500/);

    watch.sync([{ id: 'acc-10' }]);
    expect(watch.snapshot().map((e) => e.id)).toEqual(['acc-10']);
    // 账号消失后其告警标记一并清除：再次出现可重新告警。
    watch.sync([{ id: 'acc-9', expiresAt: NOW + 1_000 }]);
    await watch.refresh('acc-9');
    expect(alerts).toHaveLength(2);
  });

  it('告警出口抛错不外泄（旁路通知安全）', async () => {
    const watch = new WorkBuddyTokenWatch({
      triggerRefresh: async () => {
        throw new Error('boom');
      },
      notify: async () => {
        throw new Error('webhook down');
      },
      now: () => NOW,
      sleep: async () => {},
    });
    watch.sync([{ id: 'acc-1', expiresAt: NOW + 1 }]);
    const out = await watch.refresh('acc-1');
    expect(out.pendingRefresh).toBe(true); // 刷新失败语义不受告警故障影响
  });
});

// ─── 3. parseTokenExpiry 各口径 ──────────────────────────────────────────────

describe('T301 parseTokenExpiry（到期时刻解析）', () => {
  const NOW = 1_700_000_000_000;

  it('Unix 秒 → 毫秒；已是毫秒的原样返回', () => {
    expect(parseTokenExpiry({ expiresAt: 1_700_000_000 }, NOW)).toBe(1_700_000_000_000);
    expect(parseTokenExpiry({ expiresAt: NOW + 5_000 }, NOW)).toBe(NOW + 5_000);
  });

  it('字符串数字与别名键（tokenExpiresAt / expires_at）均可解析', () => {
    expect(parseTokenExpiry({ tokenExpiresAt: '1700000000' }, NOW)).toBe(1_700_000_000_000);
    expect(parseTokenExpiry({ expires_at: 1_700_000_000 }, NOW)).toBe(1_700_000_000_000);
    expect(parseTokenExpiry({ expiresAt: String(NOW + 1_000) }, NOW)).toBe(NOW + 1_000);
  });

  it('相对秒（expiresIn / expires_in）以 now 起算', () => {
    expect(parseTokenExpiry({ expiresIn: 3_600 }, NOW)).toBe(NOW + 3_600_000);
    expect(parseTokenExpiry({ expires_in: 60 }, NOW)).toBe(NOW + 60_000);
  });

  it('缺失或非法 → undefined（未知不等于已过期）', () => {
    expect(parseTokenExpiry({}, NOW)).toBeUndefined();
    expect(parseTokenExpiry({ expiresAt: 0 }, NOW)).toBeUndefined();
    expect(parseTokenExpiry({ expiresAt: 'soon' }, NOW)).toBeUndefined();
    expect(parseTokenExpiry({ expiresAt: Number.NaN }, NOW)).toBeUndefined();
  });
});

// ─── 4. Provider 接线（快照 → 看护 → 面板状态）────────────────────────────────

describe('T301 WorkBuddyProvider 接线', () => {
  const NOW = 1_700_000_000_000;

  function fakeSidecar(): WorkBuddySidecar {
    return { baseUrl: 'http://127.0.0.1:8787', status: () => null } as unknown as WorkBuddySidecar;
  }

  it('mapPoolSnapshot 从 /status 填入 expiresAt（缺失不填）', () => {
    const snap = mapPoolSnapshot(
      {
        accounts: [
          { uid: 'a1', nickname: '甲', expiresAt: 1_700_000_000 },
          { uid: 'a2', nickname: '乙' },
        ],
      },
      NOW,
    );
    expect(snap.accounts[0].expiresAt).toBe(1_700_000_000_000);
    expect(snap.accounts[1].expiresAt).toBeUndefined();
    expect(Object.keys(snap.accounts[1])).not.toContain('expiresAt');
  });

  it('refreshPool 把账号（含到期时刻）同步进看护，tokenWatchStatus 可读', async () => {
    const provider = new WorkBuddyProvider({
      sidecar: fakeSidecar(),
      fetchFn: (async () =>
        jsonResponse({
          total: 2,
          healthy: 2,
          accounts: [
            { uid: 'soon', nickname: '快到期的', expiresAt: Math.floor((NOW + 30 * 60_000) / 1000) },
            { uid: 'later', nickname: '还早', expiresAt: Math.floor((NOW + 5 * 60 * 60_000) / 1000) },
          ],
        })) as unknown as typeof fetch,
      env: { WORKBUDDY_SIDECAR_KEY: 'k' } as NodeJS.ProcessEnv,
    });
    await provider.initialize({ enabled: true, sidecar: { port: 8787 } });

    await provider.refreshPool();
    const view = provider.tokenWatchStatus();
    expect(view.preRefreshWindowMs).toBe(DEFAULT_PRE_REFRESH_WINDOW_MS);
    expect(view.maxRetries).toBe(3);
    expect(view.accounts.map((a) => a.id).sort()).toEqual(['later', 'soon']);
    expect(view.pendingRefresh).toEqual([]);
    // 只有 30 分钟到期的那个进入预刷窗口
    const soon = view.accounts.find((a) => a.id === 'soon')!;
    expect(soon.expiresAt).toBeGreaterThan(NOW);
    expect(soon.pendingRefresh).toBe(false);
  });

  it('未接 sidecar 时 loginStart 明确报错（不静默）', async () => {
    const provider = new WorkBuddyProvider({ env: {} as NodeJS.ProcessEnv });
    await provider.initialize({ enabled: true });
    await expect(provider.loginStart('cn')).rejects.toThrow(/sidecar is not available/);
  });

  it('loginStart / loginPoll 委托注入的授权客户端（凭据不出上游）', async () => {
    const provider = new WorkBuddyProvider({
      env: {} as NodeJS.ProcessEnv,
      oauthClient: new WorkBuddyOAuthClient({
        baseUrl: 'http://127.0.0.1:8787',
        fetchFn: (async (url: string) => {
          if (String(url).includes('/login/start')) return jsonResponse({ url: 'https://u', state: 's1', realm: 'global' });
          return jsonResponse({ done: true, uid: 'u', nickname: 'n', accessToken: 'LEAK' });
        }) as unknown as typeof fetch,
      }),
    });
    await provider.initialize({ enabled: true });

    const started = await provider.loginStart('global');
    expect(started).toEqual({ url: 'https://u', state: 's1', realm: 'global' });
    const polled = await provider.loginPoll('s1');
    expect(polled).toEqual({ done: true, uid: 'u', nickname: 'n' });
  });
});
