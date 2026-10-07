// =============================================================================
// FreebuffProvider 测试（T201 DoD）
// -----------------------------------------------------------------------------
// 覆盖 DoD：
//   1. 流 / 非流响应正确（mock 上游 → 文本增量口径）；
//   2. 多 Token 轮询（连续请求命中不同 Token；401 后该 Token 被冷却跳过）；
//   3. Run 预热（prewarm 后首个请求不等待建 Run，mock 计时断言）；
//   4. 所有创建的 Run 有对应 FINISH（created == finished，不泄漏）；
//   5. 远程模型注册表 + 网络失败硬编码兜底。
//
// mock 上游按 Codebuff wire（/api/v1/agent-runs、/api/v1/freebuff/session、
// /api/v1/chat/completions、free-agents.ts）应答，全部经 127.0.0.1 回环
// （safe-fetch 的 SSRF 白名单需显式放行，与 tests/snapshot 同法）。
// =============================================================================

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenAIChatRequest } from '../src/types/index.js';
import { FreebuffProvider } from '../src/providers/freebuff/provider.js';
import { RunManager } from '../src/providers/freebuff/run-manager.js';
import { UpstreamClient } from '../src/providers/freebuff/upstream.js';
import { resolveFreebuffConfig } from '../src/providers/freebuff/config.js';
import {
  buildModelMapping,
  HARDCODED_FALLBACK,
  parseAllFreeModels,
} from '../src/providers/freebuff/models.js';
import { ensureSession } from '../src/providers/freebuff/free-session.js';
import { ErrorCode } from '../src/utils/errors.js';

const MODEL = 'z-ai/glm-5.1';
const AGENT = 'test-agent';

/** 单 agent / 单模型的远程注册表源（与 models.go 的 free-agents.ts 同形）。 */
const REGISTRY_SOURCE = `export const freeAgents = {
  '${AGENT}': new Set(['${MODEL}']),
};\n`;

// ─── mock 上游 ───────────────────────────────────────────────────────────────

interface MockState {
  startCount: number;
  finishCount: number;
  startedRunIds: string[];
  finishedRunIds: string[];
  /** 依次记录 chat 请求命中的 token（= 多 Token 轮询断言依据）。 */
  chatTokens: string[];
  sessionTokens: string[];
  startDelayMs: number;
  /** 命中该集合的 token 在 chat 时返回 401（模拟失效凭据）。 */
  rejectTokens: Set<string>;
  /** null → 注册表 404（触发 fallback）。 */
  registryBody: string | null;
  /** true → chat 流式返回一个 error 事件帧。 */
  chatErrorFrame: boolean;
}

interface MockUpstream {
  base: string;
  state: MockState;
  close(): Promise<void>;
}

function tokenOf(req: http.IncomingMessage): string {
  const auth = String(req.headers['authorization'] ?? '');
  return auth.replace(/^Bearer\s+/i, '').trim();
}

async function createMock(overrides: Partial<MockState> = {}): Promise<MockUpstream> {
  const state: MockState = {
    startCount: 0,
    finishCount: 0,
    startedRunIds: [],
    finishedRunIds: [],
    chatTokens: [],
    sessionTokens: [],
    startDelayMs: 0,
    rejectTokens: new Set(),
    registryBody: REGISTRY_SOURCE,
    chatErrorFrame: false,
    ...overrides,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf-8')));
    req.on('end', async () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const p = url.pathname;
      const token = tokenOf(req);
      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (p === '/free-agents.ts') {
        if (!state.registryBody) return sendJson(404, { message: 'not found' });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(state.registryBody);
        return;
      }

      if (p === '/api/v1/freebuff/session') {
        state.sessionTokens.push(token);
        if (req.method === 'DELETE') return sendJson(200, { ok: true });
        return sendJson(200, {
          status: 'active',
          instanceId: 'inst-1',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      }

      if (p === '/api/v1/agent-runs') {
        const body = JSON.parse(raw || '{}');
        if (body.action === 'START') {
          if (state.startDelayMs > 0) await new Promise((r) => setTimeout(r, state.startDelayMs));
          state.startCount += 1;
          const runId = `run-${state.startCount}`;
          state.startedRunIds.push(runId);
          return sendJson(200, { runId });
        }
        if (body.action === 'FINISH') {
          state.finishCount += 1;
          state.finishedRunIds.push(String(body.runId));
          return sendJson(200, { ok: true });
        }
        return sendJson(400, { message: 'unknown action' });
      }

      if (p === '/api/v1/chat/completions') {
        state.chatTokens.push(token);
        if (state.rejectTokens.has(token)) {
          return sendJson(401, { error: 'invalid token' });
        }
        const body = JSON.parse(raw || '{}');
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          if (state.chatErrorFrame) {
            res.write(`data: ${JSON.stringify({ error: { message: 'mock upstream exploded' } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          const frames = [
            { id: 'cc-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
            { id: 'cc-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'Hello, ' } }] },
            { id: 'cc-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'freebuff!' } }] },
            { id: 'cc-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ];
          for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        return sendJson(200, {
          id: 'cc-1',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello, freebuff!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        });
      }

      return sendJson(404, { message: `mock upstream: unhandled ${p}` });
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ─── 环境隔离 ────────────────────────────────────────────────────────────────

const ORIGINAL_ALLOWED = process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS;
const ORIGINAL_TOKENS = process.env.FREEBUFF_TOKENS;

beforeEach(() => {
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
});
afterEach(() => {
  if (ORIGINAL_ALLOWED === undefined) delete process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS;
  else process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = ORIGINAL_ALLOWED;
  if (ORIGINAL_TOKENS === undefined) delete process.env.FREEBUFF_TOKENS;
  else process.env.FREEBUFF_TOKENS = ORIGINAL_TOKENS;
});

async function makeProvider(
  mock: MockUpstream,
  opts: { tokens?: string[]; registry?: 'remote' | 'missing'; rotationIntervalMs?: number } = {},
): Promise<FreebuffProvider> {
  process.env.FREEBUFF_TOKENS = (opts.tokens ?? ['t1']).join(',');
  const provider = new FreebuffProvider();
  await provider.initialize({
    apiBase: mock.base,
    modelRegistryUrl: opts.registry === 'missing' ? `${mock.base}/missing.ts` : `${mock.base}/free-agents.ts`,
    ...(opts.rotationIntervalMs ? { rotationIntervalMs: opts.rotationIntervalMs } : {}),
  });
  return provider;
}

function chatReq(overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    ...overrides,
  };
}

async function collect(gen: AsyncIterable<string>): Promise<{ items: string[]; error?: Error }> {
  const items: string[] = [];
  try {
    for await (const item of gen) items.push(item);
    return { items };
  } catch (err) {
    return { items, error: err as Error };
  }
}

// ─── 用例 ────────────────────────────────────────────────────────────────────

describe('FreebuffProvider 标识与生命周期', () => {
  it('name/displayName 与总闸：disable 后 chatCompletion 短路 NO_PROVIDER_AVAILABLE', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      expect(provider.name).toBe('freebuff');
      expect(provider.displayName).toBe('Freebuff');
      expect(provider.isEnabled()).toBe(true);

      provider.disable();
      const { error } = await collect(provider.chatCompletion(chatReq(), { requestId: 'r1' }));
      expect(error).toMatchObject({ code: ErrorCode.NO_PROVIDER_AVAILABLE, status: 503 });

      provider.enable();
      expect(provider.isEnabled()).toBe(true);
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });

  it('listAccounts 脱敏：token 只露尾 4 位', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock, { tokens: ['secret-token-aaaa', 'secret-token-bbbb'] });
      const accounts = provider.listAccounts();
      expect(accounts).toHaveLength(2);
      for (const a of accounts) {
        expect(a.apiKey.startsWith('****')).toBe(true);
        expect(a.apiKey).not.toContain('secret-token');
      }
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });

  it('无 Token 时 initialize 不抛（可启动），chat 报 UPSTREAM_ACCOUNT_UNAVAILABLE', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock, { tokens: [] });
      const health = await provider.health();
      expect(health.healthy).toBe(false);
      expect(health.total).toBe(0);
      const { error } = await collect(provider.chatCompletion(chatReq(), { requestId: 'r1' }));
      expect(error).toMatchObject({ code: ErrorCode.UPSTREAM_ACCOUNT_UNAVAILABLE });
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });

  it('extractUsage：freebuff 免费口径 costUsd = 0（确定免费，≠ null）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      const usage = provider.extractUsage([
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } } },
      ]);
      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);
      expect(usage.cacheReadTokens).toBe(20);
      expect(usage.costUsd).toBe(0);
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });

  it('probe：真实往返（active 会话）→ healthy 且带 latencyMs', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      const result = await provider.probe();
      expect(result.healthy).toBe(true);
      expect(typeof result.latencyMs).toBe('number');
      expect(mock.state.sessionTokens.length).toBeGreaterThan(0);
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });
});

describe('DoD 1：流 / 非流响应正确', () => {
  it('流式：SSE chunk → 文本增量序列', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      const { items, error } = await collect(
        provider.chatCompletion(chatReq({ stream: true }), { requestId: 'r1' }),
      );
      expect(error).toBeUndefined();
      expect(items).toEqual(['Hello, ', 'freebuff!']);
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });

  it('非流式：JSON 响应 → 单块文本', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      const { items, error } = await collect(
        provider.chatCompletion(chatReq({ stream: false }), { requestId: 'r1' }),
      );
      expect(error).toBeUndefined();
      expect(items).toEqual(['Hello, freebuff!']);
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });

  it('上游 error 事件 → PROVIDER_PROTOCOL_ERROR', async () => {
    const mock = await createMock({ chatErrorFrame: true });
    try {
      const provider = await makeProvider(mock);
      const { items, error } = await collect(
        provider.chatCompletion(chatReq({ stream: true }), { requestId: 'r1' }),
      );
      expect(items).toEqual([]);
      expect(error).toMatchObject({ code: ErrorCode.PROVIDER_PROTOCOL_ERROR });
      expect(error?.message).toContain('mock upstream exploded');
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });
});

describe('DoD 2：多 Token 轮询', () => {
  it('连续请求命中不同 Token（Round-robin）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock, { tokens: ['t1', 't2', 't3'] });
      for (let i = 0; i < 3; i++) {
        const { error } = await collect(
          provider.chatCompletion(chatReq({ stream: false }), { requestId: `r${i}` }),
        );
        expect(error).toBeUndefined();
      }
      expect(mock.state.chatTokens).toEqual(['t1', 't2', 't3']);
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });

  it('单个 Token 401 后被冷却跳过，不再被选中', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock, { tokens: ['t1', 't2', 't3'] });

      // 让 t2 失效；循环请求直到 t2 被选中并触发 401。
      mock.state.rejectTokens.add('t2');
      let sawRejection = false;
      for (let i = 0; i < 6 && !sawRejection; i++) {
        const { error } = await collect(
          provider.chatCompletion(chatReq({ stream: false }), { requestId: `warm-${i}` }),
        );
        if (error) {
          expect((error as { code?: string }).code).toBe(ErrorCode.INVALID_CREDENTIAL);
          sawRejection = true;
        }
      }
      expect(sawRejection).toBe(true);

      // 冷却期内继续请求：t2 不应再被选中。
      const before = mock.state.chatTokens.length;
      for (let i = 0; i < 6; i++) {
        const { error } = await collect(
          provider.chatCompletion(chatReq({ stream: false }), { requestId: `after-${i}` }),
        );
        expect(error).toBeUndefined();
      }
      const afterwards = mock.state.chatTokens.slice(before);
      expect(afterwards.length).toBe(6);
      expect(afterwards.every((t) => t !== 't2')).toBe(true);

      await provider.destroy();
    } finally {
      await mock.close();
    }
  });
});

describe('DoD 3：Run 预热（首个请求不等待建 Run）', () => {
  it('prewarm 后首个请求不触发 START，冷启动则需等待', async () => {
    const mock = await createMock({ startDelayMs: 400 });
    try {
      process.env.FREEBUFF_TOKENS = 't1';
      const cfg = resolveFreebuffConfig({ apiBase: mock.base, modelRegistryUrl: `${mock.base}/free-agents.ts` });
      const client = new UpstreamClient(cfg);

      // 冷启动：无 prewarm，acquire 必须同步建 Run（START 400ms）。
      const cold = new RunManager(cfg, client);
      const coldStart = Date.now();
      const coldLease = await cold.acquire(AGENT);
      const coldLatency = Date.now() - coldStart;
      await ensureSession(coldLease.pool);
      await cold.release(coldLease);
      await cold.close();

      // 预热：prewarm 建好 Run，随后 acquire 不应再发 START。
      const warm = new RunManager(cfg, client);
      await warm.prewarm([AGENT]);
      const startsAfterPrewarm = mock.state.startCount;
      const warmStart = Date.now();
      const warmLease = await warm.acquire(AGENT);
      const warmLatency = Date.now() - warmStart;
      await ensureSession(warmLease.pool);
      await warm.release(warmLease);
      const startsDuringWarmAcquire = mock.state.startCount - startsAfterPrewarm;
      await warm.close();

      // 阈值依据：mock START 延时 400ms。冷启动必然 ≥400ms；预热后 acquire
      // 只做会话缓存命中与 inflight 自增（无网络），应 <200ms（留 200ms 余量）。
      console.log(
        `[DoD3] cold first-acquire=${coldLatency}ms, prewarmed first-acquire=${warmLatency}ms, ` +
          `STARTs during prewarmed acquire=${startsDuringWarmAcquire} (mock START delay=400ms)`,
      );
      expect(coldLatency).toBeGreaterThan(300);
      expect(warmLatency).toBeLessThan(200);
      expect(startsDuringWarmAcquire).toBe(0);
    } finally {
      await mock.close();
    }
  }, 20000);
});

describe('DoD 4：Run created == finished（不泄漏）', () => {
  it('预建 + 多次请求 + destroy 后，START 与 FINISH 一一对应', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock, { tokens: ['t1', 't2'] });
      // 等待 prewarm（每池每 agent 各建一个 run）完成：mock 会记录 2 次 START。
      const deadline = Date.now() + 5000;
      while (mock.state.startCount < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }

      for (let i = 0; i < 4; i++) {
        const { error } = await collect(
          provider.chatCompletion(chatReq({ stream: false }), { requestId: `r${i}` }),
        );
        expect(error).toBeUndefined();
      }

      await provider.destroy();

      console.log(
        `[DoD4] STARTs=${mock.state.startCount}, FINISHes=${mock.state.finishCount}, ` +
          `startedRuns=[${mock.state.startedRunIds.join(',')}], finishedRuns=[${mock.state.finishedRunIds.join(',')}]`,
      );
      expect(mock.state.startCount).toBe(2);
      expect(mock.state.finishCount).toBe(2);
      expect([...mock.state.finishedRunIds].sort()).toEqual([...mock.state.startedRunIds].sort());
    } finally {
      await mock.close();
    }
  });
});

describe('DoD 5：远程模型注册表与兜底', () => {
  it('parseAllFreeModels + buildModelMapping（去重、排序、agent 反查）', () => {
    const parsed = parseAllFreeModels(REGISTRY_SOURCE);
    expect(parsed).toEqual({ [AGENT]: [MODEL] });

    const { modelToAgent, allModels } = buildModelMapping({
      b: ['m1', 'm2'],
      a: ['m2'],
    });
    expect(allModels).toEqual(['m1', 'm2']);
    // 同一 model 被多 agent 声明时取排序后第一个（确定性，见 models.ts 偏差说明）。
    expect(modelToAgent.m2).toBe('a');
  });

  it('网络失败 → 硬编码 fallback（Provider 仍可启动并列出模型）', async () => {
    const mock = await createMock({ registryBody: null });
    try {
      const provider = await makeProvider(mock, { registry: 'missing' });
      const models = (await provider.listModels()).map((m) => m.id);
      const expected = [...new Set(Object.values(HARDCODED_FALLBACK).flat())].sort();
      expect(models).toEqual(expected);
      expect(models).toContain('z-ai/glm-5.1');
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });

  it('远端可用时以远端目录为准（listModels 与注册表一致）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      const models = (await provider.listModels()).map((m) => m.id);
      expect(models).toEqual([MODEL]);
      await provider.destroy();
    } finally {
      await mock.close();
    }
  });
});
