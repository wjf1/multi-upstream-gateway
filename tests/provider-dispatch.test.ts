// =============================================================================
// T213 阶段 2：数据面分发（chat / messages 经 router 到三 Provider）
// -----------------------------------------------------------------------------
// 覆盖 DoD 的可自动化面：
//   [ ] 前缀模型 → 对应 Provider，响应带 x-actual-upstream（来源正确）
//   [ ] 裸名注册表唯一命中 → 对应 Provider
//   [ ] commandcode 决策走既有通路（零回归：请求仍打 mock 上游）
//   [ ] chat 流式/非流式与 messages 流式/非流式的出口协议正确
//   [ ] 上游错误 → 稳定错误码信封（HTTP 状态，未产出字节时）
//   [ ] 混合并发无跨 Provider 污染（并发 30）
//   [ ] 面板切换默认上游：热生效（priority 决策立即变）+ 持久化 routing 分片
// 手法：真实 ProviderRuntime + 注入假 Provider（文本 marker）；**真实监听端口**
// （fastify.inject 的 mock res 没有 setTimeout/socket，hardenConnection 会炸）；
// COMMANDCODE_* 路径在动态 import 之前指向临时目录（隔离纪律同既有测试）。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AccountInfo } from '../src/types/index.js';
import type {
  ChatOptions,
  IProvider,
  OpenAIModel,
  ProbeResult,
  ProviderHealth,
  ProviderName,
  UsageSnapshot,
} from '../src/providers/core/interface.js';
import type { OpenAIChatRequest } from '../src/types/index.js';

let stateDir = '';
let configFile = '';

function markerProvider(name: ProviderName, fail = false): IProvider {
  let enabled = true;
  return {
    name,
    displayName: name.toUpperCase(),
    async initialize(): Promise<void> {},
    async health(): Promise<ProviderHealth> {
      return { healthy: enabled, total: 1, cooldownCount: 0, disabledCount: 0 };
    },
    async probe(): Promise<ProbeResult> {
      return { healthy: enabled, checkedAt: new Date().toISOString() };
    },
    async listModels(): Promise<OpenAIModel[]> {
      return name === 'freebuff'
        ? [{ id: 'mock-model', object: 'model', created: 1, owned_by: 'Freebuff' }]
        : [{ id: 'glm-5.2', object: 'model', created: 1, owned_by: 'workbuddy' }];
    },
    async *chatCompletion(req: OpenAIChatRequest, _opts: ChatOptions): AsyncIterable<string> {
      if (fail) throw new Error(name === 'freebuff' ? 'quota exhausted' : 'sidecar exploded');
      yield `[${name}:${String(req.model)}]`;
      yield '[tail]';
    },
    extractUsage(_events: unknown[]): UsageSnapshot {
      return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
    },
    listAccounts(): AccountInfo[] {
      return [];
    },
    async addAccount(): Promise<AccountInfo> {
      throw new Error('unsupported');
    },
    removeAccount(): void {},
    pauseAccount(): void {},
    resumeAccount(): void {},
    enable(): void {
      enabled = true;
    },
    disable(): void {
      enabled = false;
    },
    isEnabled(): boolean {
      return enabled;
    },
    updateConfig(): void {},
    async destroy(): Promise<void> {},
  } as IProvider;
}

let dashboardRoutes: typeof import('../src/routes/dashboard.js')['dashboardRoutes'];
let chatRoutes: typeof import('../src/routes/chat.js')['chatRoutes'];
let messagesRoutes: typeof import('../src/routes/messages.js')['messagesRoutes'];
let ProviderRuntime: typeof import('../src/providers/runtime.js')['ProviderRuntime'];

// chat.ts 的 commandcode 通路会真打上游：本地 mock 收口。
let mockUpstream: import('node:http').Server | null = null;
let mockUpstreamBase = '';

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-t213p2-'));
  configFile = path.join(stateDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ providers: { commandcode: {} } }), 'utf-8');
  process.env.COMMANDCODE_CONFIG_PATH = configFile;
  process.env.COMMANDCODE_ENV_PATH = path.join(stateDir, '.env');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  process.env.COMMANDCODE_API_KEY = 'test-key-t213';
  process.env.ACCEPTED_RISK_DISCLAIMER = '1';

  const http = await import('node:http');
  mockUpstream = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"start"}\n\ndata: {"type":"text-delta","text":"cc-ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => mockUpstream!.listen(0, '127.0.0.1', () => r()));
  const addr = mockUpstream.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  mockUpstreamBase = `http://127.0.0.1:${port}`;
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  // admin-guard 是模块加载期常量：必须在动态 import dashboard.js 之前设好。
  process.env.ADMIN_API_TOKEN = 't213-admin';

  ({ dashboardRoutes } = await import('../src/routes/dashboard.js'));
  ({ chatRoutes } = await import('../src/routes/chat.js'));
  ({ messagesRoutes } = await import('../src/routes/messages.js'));
  ({ ProviderRuntime } = await import('../src/providers/runtime.js'));
});

afterAll(async () => {
  if (mockUpstream) await new Promise<void>((r) => mockUpstream!.close(() => r()));
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.COMMANDCODE_API_KEY;
  delete process.env.ACCEPTED_RISK_DISCLAIMER;
});

/** 起真实监听（hardenConnectionForLongStream 需要真实 socket）。 */
async function makeApp(shards: Record<string, unknown> = { freebuff: {}, workbuddy: {} }, fail: Partial<Record<ProviderName, boolean>> = {}) {
  const runtime = new ProviderRuntime({
    env: process.env,
    loadShards: () => shards,
    buildProviders: (s) => {
      const map = new Map<ProviderName, IProvider>();
      map.set('commandcode', markerProvider('commandcode', fail.commandcode));
      map.set('freebuff', markerProvider('freebuff', fail.freebuff));
      map.set('workbuddy', markerProvider('workbuddy', fail.workbuddy));
      void s;
      return map;
    },
  });
  process.env.COMMANDCODE_API_BASE = mockUpstreamBase;
  const app = Fastify();
  app.decorate('providerRuntime', runtime as never);
  await app.register(dashboardRoutes);
  await app.register(chatRoutes);
  await app.register(messagesRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const a = app.server.address();
  const base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  return { app, runtime, base };
}

const CHAT_BODY = { model: 'freebuff/mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true };

async function post(base: string, url: string, payload: unknown, headers: Record<string, string> = {}): Promise<{ body: string; headers: Record<string, string>; statusCode: number }> {
  const res = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  const hs: Record<string, string> = {};
  res.headers.forEach((v, k) => (hs[k.toLowerCase()] = v));
  if (res.status >= 500) console.error(`[DBG] ${url} -> ${res.status}: ${body.slice(0, 500)}`);
  return { body, headers: hs, statusCode: res.status };
}

describe('T213 阶段 2：数据面分发', () => {
  let app: FastifyInstance;
  let runtime: InstanceType<typeof ProviderRuntime>;
  let base = '';

  beforeAll(async () => {
    ({ app, runtime, base } = await makeApp());
    await runtime.initialize();
  });

  afterAll(async () => {
    await app.close();
    await runtime.destroy();
  });

  it('chat 非流式：前缀模型路由到 freebuff，响应体与 x-actual-upstream 正确', async () => {
    const r = await post(base, '/v1/chat/completions', { ...CHAT_BODY, stream: false });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-actual-upstream']).toBe('freebuff');
    const body = JSON.parse(r.body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('[freebuff:mock-model][tail]');
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('chat 流式：OpenAI chunk 序列（role 起始 → 内容增量 → finish）', async () => {
    const r = await post(base, '/v1/chat/completions', CHAT_BODY);
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-actual-upstream']).toBe('freebuff');
    expect(r.body).toContain('"delta":{"role":"assistant"');
    expect(r.body).toContain('"delta":{"content":"[freebuff:mock-model]"}');
    expect(r.body).toContain('"finish_reason":"stop"');
    expect(r.body).not.toContain('[workbuddy');
  });

  it('messages 流式：Anthropic 事件序列完整且 message_start 唯一', async () => {
    const r = await post(base, '/v1/messages', { model: 'freebuff/mock-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-actual-upstream']).toBe('freebuff');
    expect(r.body).toContain('event: message_start');
    expect(r.body).toContain('"type":"text_delta","text":"[freebuff:mock-model]"');
    expect(r.body).toContain('event: message_delta');
    expect(r.body).toContain('event: message_stop');
    expect(r.body.split('event: message_start').length - 1).toBe(1);
  });

  it('messages 非流式：Anthropic message 响应', async () => {
    const r = await post(base, '/v1/messages', { model: 'freebuff/mock-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content).toEqual([{ type: 'text', text: '[freebuff:mock-model][tail]' }]);
    expect(body.usage.input_tokens).toBeGreaterThan(0);
  });

  it('裸名注册表唯一命中 → freebuff；commandcode 裸名走既有通路', async () => {
    const viaRegistry = await post(base, '/v1/chat/completions', { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: false });
    expect(viaRegistry.headers['x-actual-upstream']).toBe('freebuff');

    const viaPriority = await post(base, '/v1/chat/completions', { model: 'glm-4.7', messages: [{ role: 'user', content: 'hi' }], stream: false });
    expect(viaPriority.headers['x-actual-upstream']).toBe('commandcode');
    expect(viaPriority.body).toContain('cc-ok');
  });

  it('X-Upstream-Provider 显式指定优先于前缀（且剥前缀）', async () => {
    const explicit = await post(base, '/v1/chat/completions', { ...CHAT_BODY, stream: false }, { 'x-upstream-provider': 'workbuddy' });
    expect(explicit.headers['x-actual-upstream']).toBe('workbuddy');
    expect(JSON.parse(explicit.body).choices[0].message.content).toBe('[workbuddy:mock-model][tail]');
  });

  it('上游失败（未产出字节）→ 稳定错误码 HTTP 信封，不 500', async () => {
    const { app: failing, runtime: failingRuntime, base: failingBase } = await makeApp(undefined, { freebuff: true });
    await failingRuntime.initialize();
    try {
      const r = await post(failingBase, '/v1/chat/completions', { ...CHAT_BODY, stream: false });
      expect(r.statusCode).toBe(502);
      expect(JSON.parse(r.body).error.code).toBe('PROVIDER_PROTOCOL_ERROR');

      const rMsg = await post(failingBase, '/v1/messages', { model: 'freebuff/mock-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
      expect(rMsg.statusCode).toBe(502);
      expect(JSON.parse(rMsg.body).error.type).toBe('api_error');
    } finally {
      await failing.close();
      await failingRuntime.destroy();
    }
  });

  it('混合并发 50：各自 marker 只出现在自己的响应（无跨 Provider 污染，DoD 口径）', async () => {
    const picks: ProviderName[] = ['freebuff', 'workbuddy', 'commandcode'];
    const jobs = Array.from({ length: 50 }, (_, i) => {
      const pick = picks[i % picks.length];
      const model = pick === 'commandcode' ? 'glm-4.7' : `${pick}/${pick === 'freebuff' ? 'mock-model' : 'glm-5.2'}`;
      return post(base, '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], stream: false }).then((res) => ({ pick, res }));
    });
    const results = await Promise.all(jobs);
    for (const { pick, res } of results) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-actual-upstream']).toBe(pick);
      const content = JSON.parse(res.body).choices[0].message.content as string;
      // commandcode 走既有通路（mock 上游文本 cc-ok），freebuff/workbuddy 走 marker。
      if (pick === 'commandcode') {
        expect(content).toBe('cc-ok');
      } else {
        expect(content).toContain(`[${pick}:`);
      }
      for (const other of picks.filter((p) => p !== pick)) {
        if (other === 'commandcode') {
          expect(content).not.toBe('cc-ok');
        } else {
          expect(content).not.toContain(`[${other}:`);
        }
      }
    }
  });
});

describe('T213 阶段 2：默认上游切换（热生效 + 持久化）', () => {
  it('POST /api/providers/default 立即改变 priority 决策并写回 routing 分片', async () => {
    const { app, runtime, base } = await makeApp();
    await runtime.initialize();
    try {
      const before = await post(base, '/v1/chat/completions', { model: 'glm-4.7', messages: [{ role: 'user', content: 'hi' }], stream: false });
      expect(before.headers['x-actual-upstream']).toBe('commandcode');

      const sw = await fetch(`${base}/api/providers/default`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': 't213-admin', origin: base },
        body: JSON.stringify({ name: 'freebuff' }),
      });
      expect(sw.status).toBe(200);
      expect(await sw.json()).toMatchObject({ defaultProvider: 'freebuff', persisted: true });

      // 热生效：切换后 priority 兜底立即落到 freebuff（无注册表命中的裸名）。
      const after = await post(base, '/v1/chat/completions', { model: 'glm-4.7', messages: [{ role: 'user', content: 'hi' }], stream: false });
      expect(after.headers['x-actual-upstream']).toBe('freebuff');

      // 持久化：config.json 出现 routing.defaultProvider（deepMergeKeepUnknown 保住其余键）。
      const raw = JSON.parse(readFileSync(configFile, 'utf-8'));
      expect(raw.routing.defaultProvider).toBe('freebuff');
      expect(raw.providers.commandcode).toBeTruthy();

      const status = await fetch(`${base}/api/providers`);
      expect((await status.json()).defaultProvider).toBe('freebuff');

      const bad = await fetch(`${base}/api/providers/default`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': 't213-admin', origin: base },
        body: JSON.stringify({ name: 'nope' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await app.close();
      await runtime.destroy();
      delete process.env.ADMIN_API_TOKEN;
    }
  });

  it('重启等价：routing.defaultProvider 在 initialize 时被读回 priority 首位', async () => {
    writeFileSync(configFile, JSON.stringify({ providers: { commandcode: {} }, routing: { defaultProvider: 'workbuddy' } }), 'utf-8');
    const { app, runtime, base } = await makeApp({ freebuff: {}, workbuddy: {}, routing: { defaultProvider: 'workbuddy' } });
    await runtime.initialize();
    try {
      const r = await post(base, '/v1/chat/completions', { model: 'glm-4.7', messages: [{ role: 'user', content: 'hi' }], stream: false });
      expect(r.headers['x-actual-upstream']).toBe('workbuddy');
    } finally {
      await app.close();
      await runtime.destroy();
      if (existsSync(configFile)) rmSync(configFile, { force: true });
    }
  });
});
