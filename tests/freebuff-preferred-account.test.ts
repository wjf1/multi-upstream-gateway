// =============================================================================
// Freebuff 指定账号（X-Upstream-Account）端到端接线
// -----------------------------------------------------------------------------
// 收口 T203 登记的遗留：「preferredAccountId / onRetry 未透传到选号」。
// 覆盖四条链路：
//   1. 路由头 → ChatOptions.preferredAccountId 的解析（重复头取首值、空白视为缺失）；
//   2. 指定账号命中时，上游请求真的走该 Token（而不是只把字段收下不用）；
//   3. 指定账号不存在 / 已暂停时**回退**到普通选号，而不是把请求打挂
//      —— 指定一个坏账号不该升级成一次请求失败；
//   4. onRetry 契约对齐 commandcode 适配器：换号重试前回调，返回值决定下一轮账号。
//
// mock 上游按 Codebuff wire 应答，全部经 127.0.0.1 回环（safe-fetch 的 SSRF
// 白名单需显式放行，与 tests/freebuff-provider.test.ts 同法）。
// =============================================================================

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenAIChatRequest } from '../src/types/index.js';
import { FreebuffProvider } from '../src/providers/freebuff/provider.js';
import { resolvePreferredAccount } from '../src/routes/provider-dispatch.js';

const MODEL = 'z-ai/glm-5.1';
const AGENT = 'test-agent';

/** 单 agent / 单模型的注册表源（与 models.go 的 free-agents.ts 同形）。 */
const REGISTRY_SOURCE = `export const freeAgents = {
  '${AGENT}': new Set(['${MODEL}']),
};\n`;

interface MockState {
  /** 依次记录 chat 请求命中的 token —— 选号断言的唯一依据。 */
  chatTokens: string[];
  /** 命中该集合的 token 在 chat 时返回 500（→ cooldown_soft → 换号重试）。 */
  failTokens: Set<string>;
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

/** 起一个 Codebuff wire 的 mock 上游（只实现本用例用到的四个端点）。 */
async function createMock(): Promise<MockUpstream> {
  const state: MockState = { chatTokens: [], failTokens: new Set() };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf-8')));
    req.on('end', () => {
      const p = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      const token = tokenOf(req);
      const sendJson = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (p === '/free-agents.ts') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(REGISTRY_SOURCE);
        return;
      }
      if (p === '/api/v1/freebuff/session') {
        if (req.method === 'DELETE') return sendJson(200, { ok: true });
        return sendJson(200, {
          status: 'active',
          instanceId: 'inst-1',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (p === '/api/v1/agent-runs') {
        const body = JSON.parse(raw || '{}');
        if (body.action === 'START') return sendJson(200, { runId: 'run-1' });
        return sendJson(200, { ok: true });
      }
      if (p === '/api/v1/chat/completions') {
        state.chatTokens.push(token);
        if (state.failTokens.has(token)) return sendJson(500, { error: 'mock upstream exploded' });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ id: 'cc-1', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
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

/** 两 Token 实例：t1 → token-1，t2 → token-2（命名规则见 RunManager 建池处）。 */
async function makeProvider(mock: MockUpstream): Promise<FreebuffProvider> {
  process.env.FREEBUFF_TOKENS = 't1,t2';
  const provider = new FreebuffProvider();
  await provider.initialize({
    apiBase: mock.base,
    modelRegistryUrl: `${mock.base}/free-agents.ts`,
  });
  return provider;
}

function chatReq(): OpenAIChatRequest {
  return { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true };
}

async function collect(gen: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const delta of gen) text += delta;
  return text;
}

// ─── 1. 路由头解析 ───────────────────────────────────────────────────────────

describe('resolvePreferredAccount（X-Upstream-Account）', () => {
  it('取头值并去除首尾空白', () => {
    expect(resolvePreferredAccount({ 'x-upstream-account': ' token-2 ' })).toBe('token-2');
  });

  it('重复头（数组）取首值', () => {
    expect(resolvePreferredAccount({ 'x-upstream-account': ['token-1', 'token-2'] })).toBe('token-1');
  });

  it('缺失 / 空白 / 非字符串一律视为未指定', () => {
    expect(resolvePreferredAccount({})).toBeUndefined();
    expect(resolvePreferredAccount(undefined)).toBeUndefined();
    expect(resolvePreferredAccount({ 'x-upstream-account': '   ' })).toBeUndefined();
    expect(resolvePreferredAccount({ 'x-upstream-account': null })).toBeUndefined();
  });
});

// ─── 2~4. 选号与重试 ─────────────────────────────────────────────────────────

describe('Freebuff 指定账号选号', () => {
  it('指定 token-2 时，上游请求走 t2（而不是仍按 round-robin 从 t1 开始）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      const text = await collect(
        provider.chatCompletion(chatReq(), { requestId: 'r-hit', preferredAccountId: 'token-2' }),
      );
      expect(text).toContain('ok');
      expect(mock.state.chatTokens).toEqual(['t2']);
    } finally {
      await mock.close();
    }
  });

  it('指定不存在的账号时回退到普通选号并正常完成请求', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      const text = await collect(
        provider.chatCompletion(chatReq(), { requestId: 'r-miss', preferredAccountId: 'token-99' }),
      );
      expect(text).toContain('ok');
      // 回退而非失败：仍然只发一次请求，且落在真实存在的池上。
      expect(mock.state.chatTokens).toHaveLength(1);
      expect(['t1', 't2']).toContain(mock.state.chatTokens[0]);
    } finally {
      await mock.close();
    }
  });

  it('指定已暂停的账号时同样回退（暂停 ≠ 让请求失败）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      provider.pauseAccount('token-1');
      const text = await collect(
        provider.chatCompletion(chatReq(), { requestId: 'r-paused', preferredAccountId: 'token-1' }),
      );
      expect(text).toContain('ok');
      expect(mock.state.chatTokens).toEqual(['t2']);
    } finally {
      await mock.close();
    }
  });

  it('onRetry 在换号重试前被调用，其返回值决定下一轮账号', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      // t1 首轮 500 → cooldown_soft → 触发 onRetry → 指定下一轮用 token-2。
      mock.state.failTokens.add('t1');
      const attempts: number[] = [];
      const text = await collect(
        provider.chatCompletion(chatReq(), {
          requestId: 'r-retry',
          onRetry: async (attempt) => {
            attempts.push(attempt);
            return 'token-2';
          },
        }),
      );
      expect(text).toContain('ok');
      expect(attempts).toEqual([0]);
      expect(mock.state.chatTokens).toEqual(['t1', 't2']);
    } finally {
      await mock.close();
    }
  });

  it('onRetry 返回 undefined 时沿用普通选号（不因回调而卡死在坏账号上）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      mock.state.failTokens.add('t1');
      const attempts: number[] = [];
      const text = await collect(
        provider.chatCompletion(chatReq(), {
          requestId: 'r-retry-undefined',
          onRetry: async (attempt) => {
            attempts.push(attempt);
            return undefined;
          },
        }),
      );
      expect(text).toContain('ok');
      expect(attempts).toEqual([0]);
      // t1 已进软冷却 → 第二轮换到 t2。
      expect(mock.state.chatTokens).toEqual(['t1', 't2']);
    } finally {
      await mock.close();
    }
  });

  it('onRetry 自身抛错时不影响本轮重试（回调是调用方代码）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock);
      mock.state.failTokens.add('t1');
      const text = await collect(
        provider.chatCompletion(chatReq(), {
          requestId: 'r-retry-throw',
          onRetry: async () => {
            throw new Error('callback exploded');
          },
        }),
      );
      expect(text).toContain('ok');
      expect(mock.state.chatTokens).toEqual(['t1', 't2']);
    } finally {
      await mock.close();
    }
  });
});
