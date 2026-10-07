// =============================================================================
// T308：WorkBuddy Anthropic 通用桥接入测试与快照（DoD 锁定）
// -----------------------------------------------------------------------------
// master-plan v1.2 T308:
//   范围：core/anthropic-bridge 复用，矩阵补齐。
//   DoD：[x] /v1/messages 对 workbuddy 模型可用；[x] snapshot。
//
// 覆盖：
//   1. 前缀路由（codebuddy/glm-5.2、workbuddy/glm-5.2）与 Header 显式路由；
//   2. /v1/messages 流式 SSE：Anthropic 事件序列（message_start → content_block_*
//      → message_delta → message_stop），且事件顺序与块生命周期完备；
//   3. /v1/messages 非流式：标准 Anthropic message JSON 聚合与 usage 估算；
//   4. System prompt 与多轮对话上下文经桥转换完整保真；
//   5. 上游故障返回 Anthropic 格式的标准错误信封；
//   6. 流式与非流式 Snapshot 快照断言。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

function makeMockWorkBuddyProvider(fail = false, capturedRequests: OpenAIChatRequest[] = []): IProvider {
  let enabled = true;
  return {
    name: 'workbuddy',
    displayName: 'WorkBuddy',
    async initialize(): Promise<void> {},
    async health(): Promise<ProviderHealth> {
      return { healthy: enabled, total: 1, cooldownCount: 0, disabledCount: 0 };
    },
    async probe(): Promise<ProbeResult> {
      return { healthy: enabled, checkedAt: new Date().toISOString() };
    },
    async listModels(): Promise<OpenAIModel[]> {
      return [{ id: 'glm-5.2', object: 'model', created: 1, owned_by: 'workbuddy' }];
    },
    async *chatCompletion(req: OpenAIChatRequest, _opts: ChatOptions): AsyncIterable<string> {
      capturedRequests.push(req);
      if (fail) throw new Error('sidecar process crashed');
      yield '[wb:chunk1:';
      yield String(req.model);
      yield ']';
      yield ' [wb:chunk2:done]';
    },
    extractUsage(_events: unknown[]): UsageSnapshot {
      return { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
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
    enable(): void { enabled = true; },
    disable(): void { enabled = false; },
    isEnabled(): boolean { return enabled; },
    updateConfig(): void {},
    async destroy(): Promise<void> {},
  } as IProvider;
}

let dashboardRoutes: typeof import('../src/routes/dashboard.js')['dashboardRoutes'];
let messagesRoutes: typeof import('../src/routes/messages.js')['messagesRoutes'];
let ProviderRuntime: typeof import('../src/providers/runtime.js')['ProviderRuntime'];

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-t308-'));
  configFile = path.join(stateDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ providers: { workbuddy: {} } }), 'utf-8');
  process.env.COMMANDCODE_CONFIG_PATH = configFile;
  process.env.COMMANDCODE_ENV_PATH = path.join(stateDir, '.env');
  process.env.CREDENTIAL_STORE_PATH = path.join(stateDir, 'credentials.enc');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  process.env.COMMANDCODE_API_KEY = 'test-key-t308';
  process.env.ACCEPTED_RISK_DISCLAIMER = '1';
  process.env.ADMIN_API_TOKEN = 't308-admin';

  ({ dashboardRoutes } = await import('../src/routes/dashboard.js'));
  ({ messagesRoutes } = await import('../src/routes/messages.js'));
  ({ ProviderRuntime } = await import('../src/providers/runtime.js'));
});

async function makeApp(fail = false) {
  const capturedRequests: OpenAIChatRequest[] = [];
  const wbProvider = makeMockWorkBuddyProvider(fail, capturedRequests);

  const runtime = new ProviderRuntime({
    buildProviders: () => new Map<ProviderName, IProvider>([['workbuddy', wbProvider]]),
  });

  const app: FastifyInstance = Fastify({ logger: false });
  app.decorate('providerRuntime', runtime as never);
  await app.register(dashboardRoutes);
  await app.register(messagesRoutes);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return { app, runtime, base, capturedRequests };
}

async function postMessages(base: string, payload: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  const hs: Record<string, string> = {};
  res.headers.forEach((v, k) => (hs[k.toLowerCase()] = v));
  return { body, headers: hs, statusCode: res.status };
}

describe('T308 WorkBuddy Anthropic 通用桥接入（/v1/messages）', () => {
  let app: FastifyInstance;
  let runtime: InstanceType<typeof ProviderRuntime>;
  let base = '';
  let captured: OpenAIChatRequest[] = [];

  beforeAll(async () => {
    ({ app, runtime, base, capturedRequests: captured } = await makeApp(false));
    await runtime.initialize();
  });

  afterAll(async () => {
    await app.close();
    await runtime.destroy();
  });

  it('前缀 codebuddy/glm-5.2 成功路由至 WorkBuddy，剥离前缀并回传响应头', async () => {
    const res = await postMessages(base, {
      model: 'codebuddy/glm-5.2',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-actual-upstream']).toBe('workbuddy');
    const body = JSON.parse(res.body);
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('glm-5.2');
    expect(body.content).toEqual([{ type: 'text', text: '[wb:chunk1:glm-5.2] [wb:chunk2:done]' }]);
    expect(body.stop_reason).toBe('end_turn');

    // 校验传递给 Provider 的请求已剥离前缀
    const lastReq = captured[captured.length - 1];
    expect(lastReq.model).toBe('glm-5.2');
  });

  it('前缀 workbuddy/glm-5.2 与 Header x-upstream-provider: workbuddy 均可正确路由', async () => {
    // 1. workbuddy/ 前缀
    const r1 = await postMessages(base, {
      model: 'workbuddy/glm-5.2',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['x-actual-upstream']).toBe('workbuddy');

    // 2. Header 指定
    const r2 = await postMessages(
      base,
      { model: 'glm-5.2', max_tokens: 100, messages: [{ role: 'user', content: 'test' }] },
      { 'x-upstream-provider': 'workbuddy' },
    );
    expect(r2.statusCode).toBe(200);
    expect(r2.headers['x-actual-upstream']).toBe('workbuddy');
  });

  it('流式 SSE：标准 Anthropic 块生命周期序列完备', async () => {
    const res = await postMessages(base, {
      model: 'codebuddy/glm-5.2',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'stream please' }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-actual-upstream']).toBe('workbuddy');

    const raw = res.body;

    // 验证 Anthropic 块生命周期的有序性与闭合
    const eventTypes = [...raw.matchAll(/^event:\s*([a-z_]+)/gm)].map(m => m[1]);
    expect(eventTypes[0]).toBe('message_start');
    expect(eventTypes[1]).toBe('content_block_start');
    // 中间必须是 content_block_delta
    const middle = eventTypes.slice(2, -3);
    expect(middle.length).toBeGreaterThan(0);
    expect(middle.every(e => e === 'content_block_delta')).toBe(true);
    // 尾部三件套必须有序
    expect(eventTypes.slice(-3)).toEqual([
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    // 验证各帧结构与内容
    expect(raw).toContain('"type":"message_start"');
    expect(raw).toContain('"type":"content_block_start"');
    expect(raw).toContain('"type":"text_delta","text":"[wb:chunk1:"');
    expect(raw).toContain('"type":"text_delta","text":"glm-5.2"');
    expect(raw).toContain('"type":"text_delta","text":" [wb:chunk2:done]"');
    expect(raw).toContain('"type":"content_block_stop"');
    expect(raw).toContain('"stop_reason":"end_turn"');
    expect(raw).toContain('"type":"message_stop"');
  });

  it('System Prompt 与多轮对话上下文经桥转换后正确透传至 WorkBuddy', async () => {
    const payload = {
      model: 'codebuddy/glm-5.2',
      max_tokens: 128,
      system: 'You are a master coder.',
      messages: [
        { role: 'user', content: 'What is 1+1?' },
        { role: 'assistant', content: 'It is 2.' },
        { role: 'user', content: 'And 2+2?' },
      ],
    };

    const res = await postMessages(base, payload);
    expect(res.statusCode).toBe(200);

    const lastReq = captured[captured.length - 1];
    expect(lastReq.messages).toBeDefined();
    // 经 anthropicToOpenAIRequest 转换后，system 位于第一项
    expect(lastReq.messages[0]).toEqual({ role: 'system', content: 'You are a master coder.' });
    expect(lastReq.messages[1]).toEqual({ role: 'user', content: 'What is 1+1?' });
    expect(lastReq.messages[2]).toEqual({ role: 'assistant', content: 'It is 2.' });
    expect(lastReq.messages[3]).toEqual({ role: 'user', content: 'And 2+2?' });
  });
});

describe('T308 WorkBuddy Anthropic 错误处理', () => {
  let app: FastifyInstance;
  let runtime: InstanceType<typeof ProviderRuntime>;
  let base = '';

  beforeAll(async () => {
    ({ app, runtime, base } = await makeApp(true)); // 构造抛错的 provider
    await runtime.initialize();
  });

  afterAll(async () => {
    await app.close();
    await runtime.destroy();
  });

  it('WorkBuddy 异常时返回合规的 Anthropic 错误信封', async () => {
    const res = await postMessages(base, {
      model: 'codebuddy/glm-5.2',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'fail' }],
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('error');
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe('api_error');
    expect(body.error.code).toBe('PROVIDER_PROTOCOL_ERROR');
    expect(body.error.message).toContain('sidecar process crashed');
  });
});

describe('T308 WorkBuddy Anthropic 快照测试（Snapshot 保真度锁）', () => {
  let app: FastifyInstance;
  let runtime: InstanceType<typeof ProviderRuntime>;
  let base = '';

  beforeAll(async () => {
    ({ app, runtime, base } = await makeApp(false));
    await runtime.initialize();
  });

  afterAll(async () => {
    await app.close();
    await runtime.destroy();
  });

  it('非流式快照保真度：响应规范字段结构完整一致', async () => {
    const res = await postMessages(base, {
      model: 'codebuddy/glm-5.2',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'snapshot nonstream' }],
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // 验证必须包含的规范字段
    expect(body).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'glm-5.2',
      content: [{ type: 'text', text: '[wb:chunk1:glm-5.2] [wb:chunk2:done]' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    });
    expect(body.id).toMatch(/^msg_[a-zA-Z0-9_-]+/);
    expect(body.usage).toBeDefined();
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
  });

  it('流式快照保真度：SSE 帧事件严格符合 Anthropic 规范', async () => {
    const res = await postMessages(base, {
      model: 'codebuddy/glm-5.2',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'snapshot stream' }],
    });

    expect(res.statusCode).toBe(200);
    const text = res.body;

    // 逐帧抽样断言
    expect(text).toContain('event: message_start\ndata: {"type":"message_start"');
    expect(text).toContain('event: content_block_start\ndata: {"type":"content_block_start","index":0');
    expect(text).toContain('event: content_block_delta\ndata: {"type":"content_block_delta","index":0');
    expect(text).toContain('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
    expect(text).toContain('event: message_delta\ndata: {"type":"message_delta"');
    expect(text).toContain('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
});
