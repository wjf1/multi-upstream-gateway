// =============================================================================
// T302：WorkBuddy 余额刷新与池状态持久化
// -----------------------------------------------------------------------------
// 覆盖 master-plan v1.2 T302 的三条 DoD：
//   [x] 积分按期刷新 —— `observe()` 由 provider 的 refreshPool（T303 探活 30s 一轮）
//       驱动，内存每次更新、**落盘按 5min 节流**；推进注入时钟后确实再次落盘。
//   [x] kill -9 后重启状态一致 —— 写盘走同目录临时文件 + rename（见 utils/state-store），
//       本文件用「新实例读同一文件」等价复现重启，断言余额与池状态逐字段一致。
//   [x] 损坏文件恢复测试 —— 垃圾内容 → `corrupted` + 告警且**不覆盖原文件** →
//       `refresh()` 从 sidecar 重建 → `state-rebuilt` 告警 + 文件可解析。
// 另覆盖：字段别名容忍 / Unix 秒归一 / 缺失即 undefined（未知≠0）/ 失败不清零账本 /
// 恢复告警 / 版本不认识按损坏处理。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WorkBuddyBalanceWatch,
  mapBalanceEntries,
  parseBalanceState,
  BALANCE_STATE_VERSION,
  DEFAULT_BALANCE_INTERVAL_MS,
  type BalanceAlert,
} from '../src/providers/workbuddy/balance-watch.js';
import { WorkBuddyProvider } from '../src/providers/workbuddy/provider.js';
import type { WorkBuddySidecar } from '../src/providers/workbuddy/sidecar.js';

const NOW = 1_800_000_000_000;

let dir = '';
let clock = NOW;
const now = () => clock;

/** 一份典型 `/status`：两个号，字段名故意混用驼峰/下划线以锁定别名容忍。 */
const STATUS = {
  total: 2,
  healthy: 1,
  accounts: [
    {
      uid: 'u1',
      nickname: '甲',
      credits: 42.5,
      credits_total: 100,
      creditsExpiring: 3,
      credits_earliest_expiry: Math.floor(NOW / 1000),
      credits_earliest_remaining: 3,
      cooling: true,
    },
    { id: 'u2', points: 7, paused: true },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeSidecar(): WorkBuddySidecar {
  return {
    baseUrl: 'http://127.0.0.1:8787',
    status: () => null,
    start: async () => undefined,
    stop: async () => undefined,
  } as unknown as WorkBuddySidecar;
}

function makeWatch(
  over: { fetchStatus?: () => Promise<Record<string, unknown> | null>; alerts?: BalanceAlert[] } = {},
): WorkBuddyBalanceWatch {
  const alerts = over.alerts ?? [];
  return new WorkBuddyBalanceWatch({
    filePath: path.join(dir, 'state.json'),
    now,
    onAlert: (a) => alerts.push(a),
    ...(over.fetchStatus ? { fetchStatus: over.fetchStatus } : {}),
  });
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ccproxy-t302-'));
  clock = NOW;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── 载入 / 基线 ──────────────────────────────────────────────────────────────

describe('T302 载入与基线', () => {
  it('首次运行（无文件）→ 空基线并落盘，镜像标记 degraded', async () => {
    const watch = makeWatch();
    const outcome = await watch.initialize();
    expect(outcome.status).toBe('missing');
    expect(readState()).toEqual({ version: BALANCE_STATE_VERSION, refreshedAt: 0, consecutiveFailures: 0, accounts: {} });
    const snap = watch.snapshot();
    expect(snap.accounts).toEqual([]);
    expect(snap.degraded).toBe(true);
    expect(snap.degradedReason).toMatch(/尚未完成首次刷新/);
    expect(snap.intervalMs).toBe(DEFAULT_BALANCE_INTERVAL_MS);
  });

  it('首次 observe 抽取余额与池状态并立即落盘（窗口从 0 起算，首次必写）', async () => {
    const watch = makeWatch();
    await watch.initialize();
    const res = await watch.observe(STATUS);

    expect(res).toMatchObject({ ok: true, persisted: true, accounts: 2, consecutiveFailures: 0 });
    const snap = watch.snapshot();
    expect(snap.degraded).toBe(false);
    expect(snap.persistedAt).toBe(NOW);

    const state = readState() as { refreshedAt: number; accounts: Record<string, Record<string, unknown>> };
    expect(state.refreshedAt).toBe(NOW);
    expect(state.accounts.u1).toMatchObject({
      uid: 'u1',
      nickname: '甲',
      credits: 42.5,
      creditsTotal: 100,
      creditsExpiring: 3,
      earliestExpiry: Math.floor(NOW / 1000) * 1000, // Unix 秒 → 毫秒
      earliestRemaining: 3,
      cooling: true,
      paused: false,
      disabled: false,
      sampledAt: NOW,
    });
    expect(state.accounts.u2).toMatchObject({ uid: 'u2', credits: 7, paused: true });
  });

  it('5min 节流：窗口内只更新内存不落盘，越过窗口后再次落盘（DoD 积分按期刷新）', async () => {
    const watch = makeWatch();
    await watch.initialize();
    await watch.observe(STATUS);

    // 同一窗口内（+30s，即探活下一轮）：余额已变但**不写盘**。
    clock = NOW + 30_000;
    const throttled = await watch.observe({ accounts: [{ uid: 'u1', credits: 40 }] });
    expect(throttled).toMatchObject({ ok: true, persisted: false });
    expect(watch.snapshot().accounts[0].credits).toBe(40);
    expect((readState() as { refreshedAt: number }).refreshedAt).toBe(NOW);

    // 越过 5min 窗口：落盘，且磁盘上是**这一轮**的最新值。
    clock = NOW + DEFAULT_BALANCE_INTERVAL_MS;
    const due = await watch.observe({ accounts: [{ uid: 'u1', credits: 38 }] });
    expect(due).toMatchObject({ ok: true, persisted: true });
    const state = readState() as { refreshedAt: number; accounts: Record<string, { credits: number }> };
    expect(state.refreshedAt).toBe(clock);
    expect(state.accounts.u1.credits).toBe(38);
  });

  it('kill -9 后重启状态一致：新实例读同一文件，余额与池状态逐字段相同（DoD）', async () => {
    const before = makeWatch();
    await before.initialize();
    await before.observe(STATUS);
    await before.drain();
    const first = before.snapshot();

    // 「重启」：不调用 destroy（模拟进程被 kill -9，落盘已由 rename 原子提交）。
    const after = makeWatch();
    const outcome = await after.initialize();
    expect(outcome.status).toBe('loaded');
    const second = after.snapshot();

    expect(second.accounts).toEqual(first.accounts);
    expect(second.persistedAt).toBe(first.persistedAt);
    expect(second.degraded).toBe(false);
    expect(second.consecutiveFailures).toBe(0);
  });
});

// ─── 损坏与重建（DoD 损坏文件恢复）─────────────────────────────────────────────

describe('T302 损坏恢复', () => {
  it('垃圾文件 → corrupted + 告警，且**不覆盖**原文件；refresh 从 sidecar 重建（DoD）', async () => {
    const file = path.join(dir, 'state.json');
    writeFileSync(file, 'NOT JSON {{{', 'utf8');
    const alerts: BalanceAlert[] = [];
    const watch = makeWatch({
      alerts,
      fetchStatus: async () => STATUS,
    });

    const outcome = await watch.initialize();
    expect(outcome.status).toBe('corrupted');
    expect(alerts.map((a) => a.kind)).toContain('state-corrupted');
    // 关键：损坏原文件必须原样保留（人工抢救的前提）。
    expect(readFileSync(file, 'utf8')).toBe('NOT JSON {{{');
    expect(watch.snapshot().degraded).toBe(true);
    expect(watch.snapshot().degradedReason).toMatch(/损坏待重建/);

    const rebuilt = await watch.refresh();
    expect(rebuilt).toMatchObject({ ok: true, persisted: true, accounts: 2 });
    expect(alerts.map((a) => a.kind)).toContain('state-rebuilt');
    const state = readState() as { refreshedAt: number; accounts: Record<string, { credits: number }> };
    expect(state.refreshedAt).toBe(NOW);
    expect(state.accounts.u1.credits).toBe(42.5);
    expect(watch.snapshot().degraded).toBe(false);
  });

  it('损坏但 sidecar 也不可用 → 保持降级且绝不写盘（不用空状态覆盖）', async () => {
    const file = path.join(dir, 'state.json');
    writeFileSync(file, '{"version":', 'utf8');
    const watch = makeWatch({ fetchStatus: async () => null });
    await watch.initialize();

    const res = await watch.refresh();
    expect(res).toMatchObject({ ok: false, persisted: false });
    expect(readFileSync(file, 'utf8')).toBe('{"version":');
    expect(watch.snapshot().degraded).toBe(true);
  });

  it('版本不认识 / accounts 非对象 → 按损坏处理（走重建而非误读）', async () => {
    const file = path.join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ version: 99, accounts: {} }), 'utf8');
    expect(parseBalanceState({ version: 99 }).ok).toBe(false);
    expect((await makeWatch().initialize()).status).toBe('corrupted');

    writeFileSync(file, JSON.stringify({ version: BALANCE_STATE_VERSION, accounts: [1, 2] }), 'utf8');
    expect((await makeWatch().initialize()).status).toBe('corrupted');
  });

  it('条目级损坏只丢弃该条目，整份文件仍可用', async () => {
    writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        version: BALANCE_STATE_VERSION,
        refreshedAt: 5,
        consecutiveFailures: 0,
        accounts: { good: { credits: 3, sampledAt: 5 }, bad: null, nope: 42, '': { credits: 1 } },
      }),
      'utf8',
    );
    const watch = makeWatch();
    expect((await watch.initialize()).status).toBe('loaded');
    expect(watch.snapshot().accounts.map((a) => a.uid)).toEqual(['good']);
  });
});

// ─── 失败与恢复 ───────────────────────────────────────────────────────────────

describe('T302 sidecar 不可用', () => {
  it('observe(null) 记失败 + 告警，**保留上次已知余额**（读不到 ≠ 清零）；恢复后告警一次', async () => {
    const alerts: BalanceAlert[] = [];
    const watch = makeWatch({ alerts });
    await watch.initialize();
    await watch.observe(STATUS);
    clock = NOW + DEFAULT_BALANCE_INTERVAL_MS;

    const failed = await watch.observe(null);
    expect(failed).toMatchObject({ ok: false, consecutiveFailures: 1 });
    expect(failed.reason).toMatch(/status unavailable/);
    expect(alerts.map((a) => a.kind)).toContain('refresh-failed');
    const degraded = watch.snapshot();
    expect(degraded.degraded).toBe(true);
    expect(degraded.degradedReason).toMatch(/连续不可用 1 次/);
    expect(degraded.accounts.map((a) => a.uid)).toEqual(['u1', 'u2']); // 账本未被清空
    expect((readState() as { consecutiveFailures: number }).consecutiveFailures).toBe(1);

    // 连续失败只在首次告警（避免每 5 分钟刷屏）。
    await watch.observe(null);
    expect(alerts.filter((a) => a.kind === 'refresh-failed')).toHaveLength(1);

    clock += DEFAULT_BALANCE_INTERVAL_MS;
    const ok = await watch.observe(STATUS);
    expect(ok.consecutiveFailures).toBe(0);
    expect(alerts.map((a) => a.kind)).toContain('refresh-recovered');
    expect(watch.snapshot().degraded).toBe(false);
  });

  it('refresh() 未注入 fetchStatus → 明确 skipped，不谎报成功', async () => {
    const watch = makeWatch();
    await watch.initialize();
    const res = await watch.refresh();
    expect(res).toMatchObject({ ok: false, skipped: true, reason: 'no fetchStatus provided' });
  });
});

// ─── 纯函数 ───────────────────────────────────────────────────────────────────

describe('T302 mapBalanceEntries', () => {
  it('字段别名容忍 + Unix 秒归一 + 缺失即 undefined（未知 ≠ 0）', () => {
    const entries = mapBalanceEntries(
      {
        accounts: [
          { uid: 'a', nickname: '甲', balance: 9, totalCredits: 20, earliest_remaining: 2, credits_expire_at: NOW },
          { id: 'b', credits_remaining: 1.5 },
          { uid: 'c' },
          { uid: '  ' },
          { nickname: '没有 uid' },
        ],
      },
      NOW,
    );
    expect(entries.map((e) => e.uid)).toEqual(['a', 'b', 'c']);
    expect(entries[0]).toMatchObject({
      credits: 9,
      creditsTotal: 20,
      earliestRemaining: 2,
      earliestExpiry: NOW,
      paused: false,
      disabled: false,
      cooling: false,
      sampledAt: NOW,
    });
    expect(entries[1].credits).toBe(1.5);
    expect(Object.keys(entries[2])).not.toContain('credits');
    expect(Object.keys(entries[2])).not.toContain('nickname');
  });

  it('非数组 accounts / 全空 uid → 安全返回空集', () => {
    expect(mapBalanceEntries({ accounts: 'nope' }, NOW)).toEqual([]);
    expect(mapBalanceEntries({}, NOW)).toEqual([]);
  });
});

// ─── provider 接线 ────────────────────────────────────────────────────────────

describe('T302 provider 接线', () => {
  it('refreshPool 顺带推进余额镜像（同一次 /status，零额外 IO），并按 5min 节流落盘', async () => {
    const provider = new WorkBuddyProvider({
      sidecar: fakeSidecar(),
      fetchFn: (async () => jsonResponse(STATUS)) as unknown as typeof fetch,
      env: {} as NodeJS.ProcessEnv,
      balanceWatch: makeWatch(),
    });
    await provider.initialize({ enabled: true, sidecar: { port: 8787 } });
    await provider.refreshPool();

    const snap = provider.balanceStatus();
    expect(snap.accounts.map((a) => a.uid)).toEqual(['u1', 'u2']);
    expect(snap.persistedAt).toBe(NOW);

    // 30s 后余额变了：内存跟随，磁盘不动（节流）。
    clock = NOW + 30_000;
    await provider.refreshPool();
    expect(provider.balanceStatus().accounts[0].credits).toBe(42.5);
    expect((readState() as { refreshedAt: number }).refreshedAt).toBe(NOW);

    // 越窗后落盘。
    clock = NOW + DEFAULT_BALANCE_INTERVAL_MS;
    await provider.refreshPool();
    expect((readState() as { refreshedAt: number }).refreshedAt).toBe(clock);
    await provider.destroy();
  });

  it('sidecar /status 不可用 → refreshPool 返回 null，镜像记失败但不清零', async () => {
    let healthy = true;
    const provider = new WorkBuddyProvider({
      sidecar: fakeSidecar(),
      fetchFn: (async () => (healthy ? jsonResponse(STATUS) : jsonResponse({}, 500))) as unknown as typeof fetch,
      env: {} as NodeJS.ProcessEnv,
      balanceWatch: makeWatch(),
    });
    await provider.initialize({ enabled: true, sidecar: { port: 8787 } });
    await provider.refreshPool();
    expect(provider.balanceStatus().accounts).toHaveLength(2);

    healthy = false;
    expect(await provider.refreshPool()).toBeNull();
    const snap = provider.balanceStatus();
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.accounts).toHaveLength(2);
    await provider.destroy();
  });

  it('未初始化/无 sidecar 时 balanceStatus 仍可读（返回空基线，不抛）', async () => {
    const provider = new WorkBuddyProvider({ env: {} as NodeJS.ProcessEnv, balanceWatch: makeWatch() });
    await provider.initialize({ enabled: true });
    const snap = provider.balanceStatus();
    expect(snap.accounts).toEqual([]);
    expect(snap.degraded).toBe(true);
    expect(snap.filePath).toContain('state.json');
    await provider.destroy();
  });
});
