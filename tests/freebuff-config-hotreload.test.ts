// =============================================================================
// Freebuff 配置热重载：Token 增量参保
// -----------------------------------------------------------------------------
// 收口 T203 遗留「updateConfig 不热改 Token」。
//
// 语义（有意的取舍，见 provider.updateConfig 的注释）：
//   1. **增**：热重载会按当前 `FREEBUFF_TOKENS` 把新 Token 补进池 —— 运维改完环境变量
//      触发热重载即可参保，不必重启进程；
//   2. **不删**：池有两个来源（环境变量 + 面板 addAccount 落加密库），按 env 校准会把面板
//      加的账号一起摘掉，属"改配置丢账号"的事故级副作用。移除账号只经面板 removeAccount。
//   3. 非凭据字段（enabled 等）的热更新通道不受影响；重复热重载幂等。
// =============================================================================

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FreebuffProvider } from '../src/providers/freebuff/provider.js';
import type { OpenAIChatRequest } from '../src/types/index.js';

const MODEL = 'z-ai/glm-5.1';
const AGENT = 'test-agent';
const REGISTRY_SOURCE = `export const freeAgents = {
  '${AGENT}': new Set(['${MODEL}']),
};\n`;

interface MockUpstream {
  base: string;
  chatTokens: string[];
  close(): Promise<void>;
}

function tokenOf(req: http.IncomingMessage): string {
  return String(req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '').trim();
}

async function createMock(): Promise<MockUpstream> {
  const state = { chatTokens: [] as string[] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf-8')));
    req.on('end', () => {
      const p = new URL(req.url || '/', 'http://127.0.0.1').pathname;
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
        state.chatTokens.push(tokenOf(req));
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
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    chatTokens: state.chatTokens,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

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

async function makeProvider(mock: MockUpstream, tokens: string): Promise<FreebuffProvider> {
  process.env.FREEBUFF_TOKENS = tokens;
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

/** 热重载的入参：与 initialize 传同一个分片（分片缺字段会回落到默认值，
 *  传空对象会把 apiBase 重置成官方默认的 www.codebuff.com）。 */
function shardOf(mock: MockUpstream): { apiBase: string; modelRegistryUrl: string } {
  return { apiBase: mock.base, modelRegistryUrl: `${mock.base}/free-agents.ts` };
}

async function collect(gen: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const delta of gen) text += delta;
  return text;
}

describe('Freebuff 配置热重载：Token 增量', () => {
  it('环境变量新增 Token 后热重载即可参保（不必重新 initialize）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock, 't1');
      expect(provider.listAccounts()).toHaveLength(1);

      process.env.FREEBUFF_TOKENS = 't1,t2';
      provider.updateConfig(shardOf(mock)); // 配置热重载入口（分片为空，Token 取自 env）

      const accounts = provider.listAccounts();
      expect(accounts).toHaveLength(2);
      expect(accounts.map((a) => a.id)).toContain('token-2');
    } finally {
      await mock.close();
    }
  });

  it('新参保的 Token 真的参与调度（请求能打到它）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock, 't1');
      process.env.FREEBUFF_TOKENS = 't1,t2';
      provider.updateConfig(shardOf(mock));

      // 指定新池：验证它不只是列表里多了一条，而是能真的承接请求。
      await collect(
        provider.chatCompletion(chatReq(), { requestId: 'r-hot', preferredAccountId: 'token-2' }),
      );
      expect(mock.chatTokens).toEqual(['t2']);
    } finally {
      await mock.close();
    }
  });

  it('热重载不会摘掉面板添加的账号（只增不删）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock, 't1');
      await provider.addAccount({ token: 'panel-token' }); // 面板路径：内存态 + 落加密库
      expect(provider.listAccounts()).toHaveLength(2);

      // 环境变量里从来没有 panel-token；若按 env 校准，这里会把它摘掉。
      provider.updateConfig(shardOf(mock));
      provider.updateConfig(shardOf(mock));

      expect(provider.listAccounts()).toHaveLength(2);
      expect(provider.listAccounts().map((a) => a.id)).toContain('token-2');
      // 面板账号不只是"还在列表里"，它仍然用自己的 Token 承接请求。
      await collect(
        provider.chatCompletion(chatReq(), { requestId: 'r-panel', preferredAccountId: 'token-2' }),
      );
      expect(mock.chatTokens).toEqual(['panel-token']);
    } finally {
      await mock.close();
    }
  });

  it('重复热重载幂等（Token 不重复入池）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock, 't1');
      process.env.FREEBUFF_TOKENS = 't1,t2';
      provider.updateConfig(shardOf(mock));
      provider.updateConfig(shardOf(mock));
      provider.updateConfig(shardOf(mock));
      expect(provider.listAccounts()).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });

  it('非凭据字段的热更新通道不受影响（enabled 仍即时生效）', async () => {
    const mock = await createMock();
    try {
      const provider = await makeProvider(mock, 't1');
      expect(provider.isEnabled()).toBe(true);
      provider.updateConfig({ ...shardOf(mock), enabled: false });
      expect(provider.isEnabled()).toBe(false);
      provider.updateConfig({ ...shardOf(mock), enabled: true });
      expect(provider.isEnabled()).toBe(true);
    } finally {
      await mock.close();
    }
  });
});
