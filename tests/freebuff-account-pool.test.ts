// =============================================================================
// T203：Freebuff 账号池 —— 错误分类/冷却/凭据持久化（单元层）
// -----------------------------------------------------------------------------
// 覆盖：
//   1) classifyFreebuffError 三类错误判定与冷却策略（server.go:387/722/337）；
//   2) TokenPool 连续失败指数退避（§3.4 SOFT_COOL 1→2→4→…→max 30min）；
//   3) RunManager 选号策略注入点（selector）；
//   4) FreebuffAccountStore：加密落库（明文不可见）+ 共库不误删他方账号；
//   5) FreebuffAccountPool：IAccountPool 契约（selectAccount/releaseLease/snapshot）。
//
// 隔离纪律：CREDENTIAL_* / 日志路径等模块加载期常量必须在动态 import 之前设好，
// 指向临时目录，绝不触碰仓库根的真实 config.json/.env/credentials.enc。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let stateDir = '';
let credPath = '';

beforeAll(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-freebuff-t203a-'));
  credPath = path.join(stateDir, 'credentials.enc');
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  // 模块加载期常量隔离（虽 credential-store 在调用期求值，仍按纪律提前设置）。
  process.env.CREDENTIAL_STORE_PATH = credPath;
  process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
});

afterAll(() => {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
});

// ─── 错误分类 ────────────────────────────────────────────────────────────────

describe('classifyFreebuffError（server.go:387/722/337 三类判定）', () => {
  it('session invalid：5 个会话失效码 → refresh_session 且同请求内可重试、不冷却', async () => {
    const { classifyFreebuffError } = await import('../src/providers/freebuff/errors.js');
    for (const code of [
      'freebuff_update_required',
      'waiting_room_required',
      'waiting_room_queued',
      'session_superseded',
      'session_expired',
    ]) {
      const c = classifyFreebuffError(400, JSON.stringify({ error: code }));
      expect(c.kind, code).toBe('session_invalid');
      expect(c.action).toBe('refresh_session');
      expect(c.retryable).toBe(true);
      expect(c.cooldownMs).toBe(0);
    }
  });

  it('run invalid：400 + runid not found/running → rotate_run', async () => {
    const { classifyFreebuffError } = await import('../src/providers/freebuff/errors.js');
    expect(classifyFreebuffError(400, JSON.stringify({ error: 'runid not found' })).action).toBe('rotate_run');
    expect(
      classifyFreebuffError(400, JSON.stringify({ error: 'RunId not running anymore' })).kind,
    ).toBe('run_invalid');
    // 其它 400 不误判为 run invalid。
    expect(classifyFreebuffError(400, JSON.stringify({ error: 'bad payload' })).kind).toBe('upstream_error');
  });

  it('auth rejected：401/403 → cooldown_auth(30min) 且不可重试', async () => {
    const { classifyFreebuffError, AUTH_REJECT_COOLDOWN_MS } = await import(
      '../src/providers/freebuff/errors.js'
    );
    for (const status of [401, 403]) {
      const c = classifyFreebuffError(status, '');
      expect(c.kind).toBe('auth_rejected');
      expect(c.action).toBe('cooldown_auth');
      expect(c.retryable).toBe(false);
      expect(c.cooldownMs).toBe(AUTH_REJECT_COOLDOWN_MS);
    }
    expect(AUTH_REJECT_COOLDOWN_MS).toBe(30 * 60 * 1000);
  });

  it('限流/服务端错误 → cooldown_soft（冷却时长由指数退避决定）', async () => {
    const { classifyFreebuffError } = await import('../src/providers/freebuff/errors.js');
    expect(classifyFreebuffError(429, '').action).toBe('cooldown_soft');
    expect(classifyFreebuffError(402, '').kind).toBe('rate_limited');
    expect(classifyFreebuffError(503, '').kind).toBe('server_error');
    expect(classifyFreebuffError(503, '').retryable).toBe(true);
  });

  it('指数退避：1→2→4→8 分钟，封顶 30 分钟', async () => {
    const { softCooldownMs, SOFT_COOL_MAX_MS } = await import('../src/providers/freebuff/errors.js');
    expect(softCooldownMs(1)).toBe(60_000);
    expect(softCooldownMs(2)).toBe(120_000);
    expect(softCooldownMs(3)).toBe(240_000);
    expect(softCooldownMs(4)).toBe(480_000);
    expect(softCooldownMs(50)).toBe(SOFT_COOL_MAX_MS);
    expect(SOFT_COOL_MAX_MS).toBe(30 * 60 * 1000);
  });

  it('findHttpStatus：穿透 wrapper Error 的 cause 链取出 401', async () => {
    const { findHttpStatus } = await import('../src/providers/freebuff/errors.js');
    const inner = Object.assign(new Error('free session request failed with status 401: nope'), {
      status: 401,
    });
    const wrapped = new Error('start free session: ...', { cause: inner });
    expect(findHttpStatus(wrapped)).toBe(401);
    const messageOnly = new Error('free session request failed with status 403');
    expect(findHttpStatus(messageOnly)).toBe(403);
  });
});

// ─── TokenPool 冷却 ──────────────────────────────────────────────────────────

const CFG = {
  apiBase: 'http://127.0.0.1:1',
  modelRegistryUrl: 'http://127.0.0.1:1/free-agents.ts',
  tokens: ['t1', 't2'] as string[],
  rotationIntervalMs: 6 * 60 * 60 * 1000,
  requestTimeoutMs: 5_000,
  userAgent: 'test',
  enabled: true,
};

/** 最小可用 UpstreamClient 替身：会话 disabled、startRun 立即返回。 */
function fakeClient() {
  let runSeq = 0;
  return {
    startRun: async () => `run-${++runSeq}`,
    finishRun: async () => undefined,
    endSession: async () => undefined,
    createOrRefreshSession: async () => ({
      status: 'disabled',
      instanceId: '',
      position: 0,
      queueDepth: 0,
      queuedAt: '',
      expiresAt: '',
      remainingMs: 0,
      estimatedWaitMs: 0,
      gracePeriodRemainingMs: 0,
      message: '',
    }),
    getSession: async () => {
      throw new Error('unused');
    },
  } as unknown as import('../src/providers/freebuff/upstream.js').UpstreamClient;
}

describe('TokenPool 冷却与健康分级', () => {
  it('noteFailure 指数退避、noteSuccess 清零、healthState 分级', async () => {
    const { TokenPool } = await import('../src/providers/freebuff/run-manager.js');
    const pool = new TokenPool('token-1', 't1', CFG, fakeClient());

    expect(pool.healthState()).toBe('HEALTHY');
    expect(pool.noteFailure('boom')).toBe(60_000);
    expect(pool.healthState()).toBe('COOLING');
    expect(pool.consecutiveFailures).toBe(1);

    // 手动清掉冷却后再次失败 → 翻倍。
    pool.cooldownUntil = 0;
    expect(pool.noteFailure('boom')).toBe(120_000);
    pool.cooldownUntil = 0;
    expect(pool.noteFailure('boom')).toBe(240_000);

    pool.noteSuccess();
    expect(pool.consecutiveFailures).toBe(0);
    expect(pool.isCoolingDown()).toBe(true); // 冷却按既有到期时间自然收敛

    pool.cooldownUntil = 0;
    pool.enabled = false;
    expect(pool.healthState()).toBe('PAUSED');
  });
});

// ─── RunManager 选号注入点 ───────────────────────────────────────────────────

describe('RunManager 选号策略注入（T203 扩展点）', () => {
  it('selector 返回的起点池优先被选中；异常时回退 Round-robin', async () => {
    const { RunManager } = await import('../src/providers/freebuff/run-manager.js');
    const runs = new RunManager(CFG, fakeClient());

    // 注入：永远从下标 1（token-2）开始。
    runs.selector = (pools) => pools.length - 1;
    const lease = await runs.acquire('agent-x');
    expect(lease.pool.name).toBe('token-2');
    await runs.release(lease);

    // 非法返回 → 回退 Round-robin（游标仍从 0 开始）。
    runs.selector = () => 99;
    const lease2 = await runs.acquire('agent-x');
    expect(lease2.pool.name).toBe('token-1');
    await runs.release(lease2);

    // 抛异常 → 回退，不向上冒泡。
    runs.selector = () => {
      throw new Error('selector boom');
    };
    const lease3 = await runs.acquire('agent-x');
    expect(['token-1', 'token-2']).toContain(lease3.pool.name);
    await runs.release(lease3);

    await runs.close();
  });

  it('poolsView 暴露只读池列表', async () => {
    const { RunManager } = await import('../src/providers/freebuff/run-manager.js');
    const runs = new RunManager(CFG, fakeClient());
    expect(runs.poolsView().map((p) => p.name)).toEqual(['token-1', 'token-2']);
    await runs.close();
  });
});

// ─── 凭据持久化（T103 加密库）────────────────────────────────────────────────

describe('FreebuffAccountStore：加密落库与共库安全', () => {
  it('upsert 落进 AES-256-GCM 库，明文不可见；重新加载可读回', async () => {
    const { CredentialStore } = await import('../src/utils/credential-store.js');
    const { FreebuffAccountStore } = await import('../src/providers/freebuff/account-store.js');

    const filePath = path.join(stateDir, 'store-basic.enc');
    const store = new FreebuffAccountStore(
      new CredentialStore({ backend: 'file', filePath }),
    );
    const secret = 'freebuff-super-secret-token-ABC123';
    const count = store.upsert({
      id: 'token-1',
      provider: 'freebuff',
      apiKey: secret,
      name: 'Freebuff token-1',
      addedAt: '2026-10-07T00:00:00.000Z',
    });
    expect(count).toBe(1);

    // ① 磁盘上只有密文：原文 token 绝不出现在文件里。
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('freebuff-super-secret');
    expect(JSON.parse(raw).alg).toBe('aes-256-gcm');

    // ② 用同一路径新建实例重新加载（模拟重启读回）。
    const reloaded = new FreebuffAccountStore(
      new CredentialStore({ backend: 'file', filePath }),
    );
    expect(reloaded.tokens()).toEqual([secret]);
    expect(reloaded.load()[0].id).toBe('token-1');
  });

  it('共库安全：upsert/remove 不覆盖、不误删其它 Provider 的账号', async () => {
    const { CredentialStore } = await import('../src/utils/credential-store.js');
    const { FreebuffAccountStore } = await import('../src/providers/freebuff/account-store.js');

    const filePath = path.join(stateDir, 'store-foreign.enc');
    const backend = new CredentialStore({ backend: 'file', filePath });
    // 预置一个 commandcode 账号。
    backend.save([{ id: 'cc-1', apiKey: 'cc-secret-key', name: 'CommandCode' }]);

    const store = new FreebuffAccountStore(backend);
    store.upsert({
      id: 'token-1',
      provider: 'freebuff',
      apiKey: 'fb-1',
      name: 'Freebuff token-1',
      addedAt: '2026-10-07T00:00:00.000Z',
    });
    store.remove('token-1');

    const remaining = backend.load();
    expect(remaining.map((r) => r.id)).toEqual(['cc-1']);
    expect(store.tokens()).toEqual([]);
  });

  it('tokens() 跨重复 API key 去重', async () => {
    const { CredentialStore } = await import('../src/utils/credential-store.js');
    const { FreebuffAccountStore } = await import('../src/providers/freebuff/account-store.js');
    const store = new FreebuffAccountStore(
      new CredentialStore({ backend: 'memory', initialMemory: [] }),
    );
    const fileLike = new FreebuffAccountStore(new CredentialStore({ backend: 'file', filePath: path.join(stateDir, 'dup.enc') }));
    fileLike.upsert({ id: 'token-1', provider: 'freebuff', apiKey: 'same', name: 'a', addedAt: 'x' });
    fileLike.upsert({ id: 'token-2', provider: 'freebuff', apiKey: 'same', name: 'b', addedAt: 'x' });
    expect(fileLike.tokens()).toEqual(['same']);
    expect(store.load()).toEqual([]);
  });
});

// ─── IAccountPool 契约 ───────────────────────────────────────────────────────

describe('FreebuffAccountPool（IAccountPool 契约实现）', () => {
  it('selectAccount/releaseLease/snapshot：预占租约 + 限流软冷却', async () => {
    const { RunManager } = await import('../src/providers/freebuff/run-manager.js');
    const { FreebuffAccountPool } = await import('../src/providers/freebuff/account-pool.js');
    const runs = new RunManager(CFG, fakeClient());
    const pool = new FreebuffAccountPool(runs, (model) => (model === 'mock-model' ? 'agent-1' : undefined));

    // 未解析到模型 → MODEL_NOT_FOUND。
    await expect(
      pool.selectAccount({ model: 'nope', requestId: 'r1' }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });

    // freebuff/ 前缀可剥。
    const lease = await pool.selectAccount({ model: 'freebuff/mock-model', requestId: 'r2' });
    expect(lease.account.id).toBe('token-1');
    expect(lease.leaseId).toContain('token-1#run-');

    let snap = pool.snapshot();
    expect(snap.total).toBe(2);
    expect(snap.inFlight).toBe(1);
    expect(snap.accounts.map((a) => a.state)).toEqual(['HEALTHY', 'HEALTHY']);

    // ratelimit 归还 → 该池进入软冷却，快照反映 COOLING。
    pool.releaseLease(lease, 'ratelimit');
    snap = pool.snapshot();
    expect(snap.accounts.find((a) => a.id === 'token-1')?.state).toBe('COOLING');
    expect(snap.cooldown).toBe(1);

    // 重复归还同一租约：幂等，不重复计数。
    pool.releaseLease(lease, 'ratelimit');
    expect(pool.snapshot().inFlight).toBe(0);

    await runs.close();
  });
});
