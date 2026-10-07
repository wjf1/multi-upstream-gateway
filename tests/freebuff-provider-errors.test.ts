// =============================================================================
// T203：Freebuff Provider 错误分类冷却 / probe / 凭据落库（端到端层）
// -----------------------------------------------------------------------------
// 覆盖 T203 DoD：
//   [ ] 三类错误注入行为符合（session invalid / run invalid / auth rejected）
//   [ ] Token 失效时 probe 返回不健康
//   [ ] 面板/API 新增账号确实落进加密库（磁盘无明文 + 重启读回）
//
// 手法：本地 mock 上游 HTTP 服务，逐请求编排响应；provider 走真实
// chatCompletion / probe / addAccount 路径。隔离纪律同 T202a 测试：
// CREDENTIAL_*/LOG 路径等加载期常量在动态 import 之前指向临时目录。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

let stateDir = '';
let server: http.Server;
let base = '';

// ── 可编排的 mock 上游行为 ──────────────────────────────────────────────────
/** 会话端点是否返回 401（Token 失效模拟）。 */
let sessionAuthReject = false;
/** chat/completions 的响应队列（先进先出；耗尽后默认成功）。 */
let chatQueue: Array<{ status: number; error?: string }> = [];
let sessionPosts = 0;
let runStarts = 0;
let chatCalls = 0;
let runSeq = 0;

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-freebuff-t203b-'));
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  process.env.CREDENTIAL_STORE_PATH = path.join(stateDir, 'default-credentials.enc');
  process.env.CREDENTIAL_ENCRYPTION_KEY = 'b'.repeat(64);
  delete process.env.FREEBUFF_TOKENS;

  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (url.startsWith('/free-agents.ts')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end("export const freeAgents = {\n  'base2-free': new Set(['mock-model']),\n};\n");
        return;
      }

      if (url.startsWith('/api/v1/freebuff/session')) {
        if (req.method === 'DELETE') return json(200, {});
        sessionPosts += 1;
        if (sessionAuthReject) return json(401, { error: 'invalid token' });
        return json(200, {
          status: 'active',
          instanceId: `inst-${sessionPosts}`,
          expiresAt: '',
          position: 0,
          queueDepth: 0,
          queuedAt: '',
          remainingMs: 0,
          estimatedWaitMs: 0,
          gracePeriodRemainingMs: 0,
          message: '',
        });
      }

      if (url.startsWith('/api/v1/agent-runs')) {
        runStarts += 1;
        return json(200, { runId: `run-${++runSeq}` });
      }

      if (url.startsWith('/api/v1/chat/completions')) {
        chatCalls += 1;
        const next = chatQueue.shift();
        if (next && next.status >= 400) return json(next.status, { error: next.error ?? 'upstream error' });
        return json(200, { choices: [{ message: { content: 'ok' } }] });
      }

      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
});

beforeEach(() => {
  sessionAuthReject = false;
  chatQueue = [];
  sessionPosts = 0;
  runStarts = 0;
  chatCalls = 0;
});

/** 建一个 provider（可注入账号存储），完成 initialize 并等预热请求落地。 */
async function makeProvider(tokens?: string) {
  const { FreebuffProvider } = await import('../src/providers/freebuff/provider.js');
  if (tokens === undefined) delete process.env.FREEBUFF_TOKENS;
  else process.env.FREEBUFF_TOKENS = tokens;
  const provider = new FreebuffProvider();
  await provider.initialize({
    apiBase: base,
    modelRegistryUrl: `${base}/free-agents.ts`,
    requestTimeoutMs: 5_000,
    rotationIntervalMs: 60_000,
  });
  // 预热（prewarm）不阻塞 initialize；等它把会话/run 建好再计数。
  await new Promise((r) => setTimeout(r, 80));
  return provider;
}

async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const piece of iter) out += piece;
  return out;
}

// ─── 三类错误注入 ────────────────────────────────────────────────────────────

describe('T203 三类上游错误注入', () => {
  it('session invalid（session_expired）→ 刷新会话后重试，最终成功', async () => {
    const provider = await makeProvider('fb-token-1');
    try {
      chatQueue = [{ status: 400, error: 'session_expired' }];
      const sessionsBefore = sessionPosts;

      const text = await collect(
        provider.chatCompletion(
          { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: false } as never,
          { requestId: 't-session' },
        ),
      );

      expect(text).toBe('ok');
      expect(chatCalls).toBe(2); // 失效一次 + 成功一次
      expect(sessionPosts).toBeGreaterThan(sessionsBefore); // 会话被 invalidate 后重建
    } finally {
      await provider.destroy();
    }
  });

  it('run invalid（runid not found）→ 摘除并轮换 run 后重试，最终成功', async () => {
    const provider = await makeProvider('fb-token-1');
    try {
      chatQueue = [{ status: 400, error: 'runid not found' }];
      const runsBefore = runStarts;

      const text = await collect(
        provider.chatCompletion(
          { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: false } as never,
          { requestId: 't-run' },
        ),
      );

      expect(text).toBe('ok');
      expect(chatCalls).toBe(2);
      expect(runStarts).toBeGreaterThan(runsBefore); // 触发了新的 START
    } finally {
      await provider.destroy();
    }
  });

  it('auth rejected（401）→ INVALID_CREDENTIAL + 账号冷却 30 分钟', async () => {
    const provider = await makeProvider('fb-token-1');
    try {
      chatQueue = [{ status: 401, error: 'rejected' }];

      await expect(
        collect(
          provider.chatCompletion(
            { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: false } as never,
            { requestId: 't-auth' },
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });

      // 冷却生效：health 计入 cooldownCount，pool 快照 cooldownUntil 在未来。
      const health = await provider.health();
      expect(health.cooldownCount).toBe(1);

      // 冷却中的账号对 probe 不可用 → 不健康。
      const probe = await provider.probe();
      expect(probe.healthy).toBe(false);
    } finally {
      await provider.destroy();
    }
  });

  it('429 限流 → 软冷却（指数退避）+ 换号重试，两次失败后 PROVIDER_DEGRADED', async () => {
    const provider = await makeProvider('fb-token-1');
    try {
      chatQueue = [{ status: 429, error: 'rate limited' }, { status: 429, error: 'rate limited' }];
      await expect(
        collect(
          provider.chatCompletion(
            { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: false } as never,
            { requestId: 't-429' },
          ),
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/PROVIDER_DEGRADED|UPSTREAM_ACCOUNT_UNAVAILABLE/) });
      expect((await provider.health()).cooldownCount).toBe(1);
    } finally {
      await provider.destroy();
    }
  });
});

// ─── probe ───────────────────────────────────────────────────────────────────

describe('T203 probe（真实探活）', () => {
  it('Token 有效 → healthy true', async () => {
    const provider = await makeProvider('fb-token-ok');
    try {
      const probe = await provider.probe();
      expect(probe.healthy).toBe(true);
    } finally {
      await provider.destroy();
    }
  });

  it('Token 失效（会话端点 401）→ probe 返回不健康并冷却该账号', async () => {
    const provider = await makeProvider('fb-token-dead');
    try {
      sessionAuthReject = true;
      const probe = await provider.probe();
      expect(probe.healthy).toBe(false);
      expect(probe.detail ?? '').toContain('unhealthy');
      expect((await provider.health()).cooldownCount).toBe(1);
    } finally {
      await provider.destroy();
    }
  });
});

// ─── 凭据落库（加密库持久化 + 启动读回）─────────────────────────────────────

describe('T203 凭据持久化（面板新增账号进加密库）', () => {
  it('addAccount 落加密库（磁盘无明文），新实例 initialize 读回', async () => {
    const { CredentialStore } = await import('../src/utils/credential-store.js');
    const { FreebuffAccountStore } = await import('../src/providers/freebuff/account-store.js');
    const { FreebuffProvider } = await import('../src/providers/freebuff/provider.js');

    const credPath = path.join(stateDir, 'freebuff-accounts.enc');
    expect(existsSync(credPath)).toBe(false);
    const secret = 'panel-added-token-xyz987';

    // 第一次启动：无环境变量 Token，面板新增。
    delete process.env.FREEBUFF_TOKENS;
    const store1 = new FreebuffAccountStore(new CredentialStore({ backend: 'file', filePath: credPath }));
    const p1 = new FreebuffProvider({ accountStore: store1 });
    await p1.initialize({ apiBase: base, modelRegistryUrl: `${base}/free-agents.ts`, requestTimeoutMs: 5_000 });
    const info = await p1.addAccount({ token: secret });
    await p1.destroy();

    // ① 加密库里能读到；磁盘文件不含明文。
    expect(existsSync(credPath)).toBe(true);
    const raw = readFileSync(credPath, 'utf-8');
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw).alg).toBe('aes-256-gcm');
    expect(store1.tokens()).toEqual([secret]);

    // ② 新实例启动时读回（无 FREEBUFF_TOKENS 仍可用）。
    const store2 = new FreebuffAccountStore(new CredentialStore({ backend: 'file', filePath: credPath }));
    const p2 = new FreebuffProvider({ accountStore: store2 });
    await p2.initialize({ apiBase: base, modelRegistryUrl: `${base}/free-agents.ts`, requestTimeoutMs: 5_000 });
    const accounts = p2.listAccounts();
    expect(accounts.map((a) => a.id)).toEqual([info.id]);
    // 列表脱敏：只露尾 4 位，绝不含完整 token。
    expect(accounts[0].apiKey).not.toContain(secret);
    expect(accounts[0].apiKey.endsWith(secret.slice(-4))).toBe(true);

    // ③ removeAccount 同步删除加密库条目。
    p2.removeAccount(info.id);
    expect(store2.tokens()).toEqual([]);
    await p2.destroy();
  });
});
