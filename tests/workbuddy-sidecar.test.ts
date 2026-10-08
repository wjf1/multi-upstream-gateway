// =============================================================================
// T204'：WorkBuddy Sidecar 进程管理（联邦路线 3.11-1）
// -----------------------------------------------------------------------------
// 覆盖 DoD：
//   [ ] 拉起子进程 + 等待首个健康响应（就绪 → running）
//   [ ] 启动超时（一直连不上）→ 抛错并置 crashed
//   [ ] HTTP 可达但 /healthz 503（真实二进制空池语义）→ 算起来了：running + healthy=false
//   [ ] 空池冷启后补号：health() 由 503 自然转 200，不被锁定在 false
//   [ ] 崩溃自动重启（5min 内 3 次策略）
//   [ ] 超过策略 → crashed，不再重启
//   [ ] stop() 为有意停止，不触发重启
//   [ ] health() 走真实往返（禁止恒真）
// 手法：注入 fake spawn（EventEmitter 假子进程）+ fake fetch，不真的拉起 Go 二进制。
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WorkBuddySidecar } from '../src/providers/workbuddy/sidecar.js';

class FakeChild extends EventEmitter {
  pid = 4321;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

let spawned: FakeChild[] = [];
let healthy = true;
let clock = 0;

function fakeSpawn(): FakeChild {
  const c = new FakeChild();
  c.pid = 4321 + spawned.length;
  spawned.push(c);
  return c;
}

function okResponse(): Response {
  return new Response(JSON.stringify({ healthy: true, service: 'workbuddy2api' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeSidecar(over: Partial<ConstructorParameters<typeof WorkBuddySidecar>[0]> = {}) {
  return new WorkBuddySidecar({
    binPath: 'C:/fake/workbuddy2api.exe',
    port: 8787,
    attachProcessExitHook: false,
    startTimeoutMs: 500,
    healthIntervalMs: 5,
    spawnFn: (() => fakeSpawn()) as unknown as typeof import('node:child_process').spawn,
    fetchFn: (async () => (healthy ? okResponse() : Promise.reject(new Error('ECONNREFUSED')))) as unknown as typeof fetch,
    // 时钟注入：now 只读、sleep 推进 —— 否则恒定时钟会让启动超时永不触发。
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    ...over,
  });
}

beforeEach(() => {
  spawned = [];
  healthy = true;
  clock = 0;
});

describe('WorkBuddySidecar', () => {
  it('拉起子进程并等到健康响应 → running', async () => {
    const s = makeSidecar();
    await s.start();
    const st = s.status();
    expect(spawned).toHaveLength(1);
    expect(st.state).toBe('running');
    expect(st.healthy).toBe(true);
    expect(st.pid).toBe(4321);
    expect(st.baseUrl).toBe('http://127.0.0.1:8787');
    await s.stop();
  });

  it('一直连不上（ECONNREFUSED）→ 启动超时报错并置 crashed', async () => {
    healthy = false;
    const s = makeSidecar({ startTimeoutMs: 30 });
    await expect(s.start()).rejects.toThrow(/did not become healthy/);
    expect(s.status().state).toBe('crashed');
    expect(s.status().lastError).toBeTruthy();
  });

  // 真实二进制（workbuddy2api-panel）的 /healthz 契约是「200=可服务 / 503=池不可服务」：
  // 冷启动没有任何账号时**恒返 503**，而 503 恰恰是授权流程开始前的正常稳态。旧语义把
  // 「15s 内没拿到 200」一律判 crashed，且 health() 对非 running 状态直接返回 false，导致
  // 空池冷启的 provider 被永久判死——用户完成 OAuth 补进账号后也不会恢复。故选号池
  // 不可服务 ≠ 进程没起来：HTTP 有响应即视为 running，healthy 交给后续探活如实反映。
  it('HTTP 可达但 /healthz 503（空池）→ running + healthy=false，不判 crashed', async () => {
    const s = makeSidecar({
      fetchFn: (async () =>
        new Response('{"healthy":0,"realm_servable":{"cn":false,"global":false}}', {
          status: 503,
        })) as unknown as typeof fetch,
    });
    await s.start();
    expect(spawned).toHaveLength(1);
    expect(s.status().state).toBe('running');
    expect(s.status().healthy).toBe(false);
    await s.stop();
  });

  it('空池冷启后补号：health() 由 503 转 true，不被锁死', async () => {
    let servable = false;
    const s = makeSidecar({
      fetchFn: (async () =>
        servable
          ? okResponse()
          : new Response('{"healthy":0,"total":0}', { status: 503 })) as unknown as typeof fetch,
    });
    await s.start();
    expect(s.status().healthy).toBe(false);

    servable = true; // 用户完成 OAuth，池里有号了
    await expect(s.health()).resolves.toBe(true);
    expect(s.status().healthy).toBe(true);
    await s.stop();
  });

  it('start() 幂等（running 时重复调用不再 spawn）', async () => {
    const s = makeSidecar();
    await s.start();
    await s.start();
    expect(spawned).toHaveLength(1);
    await s.stop();
  });

  it('崩溃后在策略内自动重启（5min 3 次）', async () => {
    const s = makeSidecar();
    await s.start();
    expect(s.status().restarts).toBe(0);

    spawned[0].emit('exit', 1, null); // 模拟崩溃
    await new Promise((r) => setTimeout(r, 60));

    expect(spawned).toHaveLength(2);
    const st = s.status();
    expect(st.restarts).toBe(1);
    expect(st.state).toBe('running');
    await s.stop();
  });

  it('超过重启策略（3 次）后置 crashed，不再拉起', async () => {
    const s = makeSidecar();
    await s.start();

    for (let i = 0; i < 4; i++) {
      const child = spawned[spawned.length - 1];
      child.emit('exit', 1, null);
      await new Promise((r) => setTimeout(r, 60));
    }

    expect(s.status().restarts).toBe(3);
    expect(s.status().state).toBe('crashed');
    // 首次 + 3 次重启 = 4 个进程；第 4 次退出不再触发新 spawn。
    expect(spawned).toHaveLength(4);
  });

  it('stop() 为有意停止：杀进程且不重启', async () => {
    const s = makeSidecar();
    await s.start();
    const child = spawned[0];
    await s.stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(child.killed).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(s.status().state).toBe('stopped');
    expect(s.status().healthy).toBe(false);
  });

  it('health() 走真实往返：上游拒绝即不健康（禁止恒真）', async () => {
    const s = makeSidecar();
    await s.start();
    expect(await s.health()).toBe(true);

    healthy = false;
    expect(await s.health()).toBe(false);
    await s.stop();
  });

  it('未启动时 health() 恒 false（不空发请求）', async () => {
    let calls = 0;
    const s = makeSidecar({
      fetchFn: (async () => {
        calls += 1;
        return okResponse();
      }) as unknown as typeof fetch,
    });
    expect(await s.health()).toBe(false);
    expect(calls).toBe(0);
  });
});
