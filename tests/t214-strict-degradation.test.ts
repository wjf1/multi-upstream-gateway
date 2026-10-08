// =============================================================================
// T214 阶段门 —— 错误注入与降级语义（strict）
// -----------------------------------------------------------------------------
// 验收依据：master-plan §3.6「降级与级联防护」
//   - **默认策略 strict**：上游不可用直接返回错误，`auto` 必须用户显式开启（属 P2/T303）。
//   - **流式降级语义**：仅首字节之前允许重试/切换；一旦响应流已开始，**禁止跨 Provider 切换**，
//     只能中断并返回错误。
//
// 因此 P1 这一阶段要锁定的不是"能降级"，而是**没有偷偷降级**：
//   1. 选定上游失败 → 稳定错误码，且**其它 Provider 一次都没被调用**（无跨上游兜底）；
//   2. 流式首字节之后失败 → 只能中断（错误并入内容流），已产出的内容不撤回、也不换上游；
//   3. 未注册 / 未启用的上游 → 明确错误码或按既定路由语义回退，**不静默 500、不挂起**；
//   4. 路由层的 priority 回退（显式选择落空 → 兜底上游）是**决策期**语义，与"失败后降级"是两件事，
//      本文件用独立用例把两者分开锁定，避免后来者把决策回退误当降级实现。
//
// 手法：真实 ProviderRuntime + 注入"会记录调用"的假 Provider（可注入两类故障），真实监听端口
// （fastify.inject 的 mock res 没有 setTimeout/socket，hardenConnection 会炸）。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AccountInfo, OpenAIChatRequest } from '../src/types/index.js';
import { ErrorCode, ProxyError } from '../src/utils/errors.js';
import type {
  ChatOptions,
  IProvider,
  OpenAIModel,
  ProbeResult,
  ProviderHealth,
  ProviderName,
  UsageSnapshot,
} from '../src/providers/core/interface.js';

let stateDir = '';
let mockUpstream: import('node:http').Server | null = null;
let mockUpstreamBase = '';
/** commandcode 通路（既有适配器）打到 mock 上游的次数 —— 用于断言"没被牵连调用"。 */
let mockUpstreamHits = 0;

type FailMode = 'none' | 'before-output' | 'after-first-chunk';

/** 记录调用次数的假 Provider；`fail` 控制注入点。 */
interface Recording extends IProvider {
  calls: string[];
}

function recordingProvider(name: ProviderName, fail: FailMode = 'none', assertEnabled = false): Recording {
  const calls: string[] = [];
  let enabled = true;
  return {
    calls,
    name,
    displayName: name.toUpperCase(),
    async initialize(): Promise<void> {},
    async health(): Promise<ProviderHealth> {
      return { healthy: enabled && fail === 'none', total: 1, cooldownCount: 0, disabledCount: 0 };
    },
    async probe(): Promise<ProbeResult> {
      return { healthy: enabled && fail === 'none', checkedAt: new Date().toISOString() };
    },
    async listModels(): Promise<OpenAIModel[]> {
      return [{ id: 'mock-model', object: 'model', created: 1, owned_by: name }];
    },
    async *chatCompletion(req: OpenAIChatRequest, _opts: ChatOptions): AsyncIterable<string> {
      calls.push(String(req.model));
      // 真实 Provider（如 FreebuffProvider.assertEnabled）会自查总闸；用于锁定
      // 「前缀路径下由谁拒绝停用上游」这一契约（见文件末尾用例）。
      if (assertEnabled && !enabled) {
        throw new ProxyError(ErrorCode.NO_PROVIDER_AVAILABLE, `${name} provider is disabled`);
      }
      if (fail === 'before-output') {
        throw new Error(`${name} upstream unavailable (injected)`);
      }
      yield `[${name}:first]`;
      if (fail === 'after-first-chunk') {
        throw new Error(`${name} stream broke after first chunk (injected)`);
      }
      yield `[${name}:tail]`;
    },
    extractUsage(): UsageSnapshot {
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
  } as Recording;
}

let chatRoutes: typeof import('../src/routes/chat.js')['chatRoutes'];
let messagesRoutes: typeof import('../src/routes/messages.js')['messagesRoutes'];
let dashboardRoutes: typeof import('../src/routes/dashboard.js')['dashboardRoutes'];
let ProviderRuntime: typeof import('../src/providers/runtime.js')['ProviderRuntime'];

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-t214-strict-'));
  writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ providers: { commandcode: {} } }),
    'utf-8',
  );
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_ENV_PATH = path.join(stateDir, '.env');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  process.env.COMMANDCODE_API_KEY = 'test-key-t214';
  process.env.ACCEPTED_RISK_DISCLAIMER = '1';
  process.env.ADMIN_API_TOKEN = 't214-admin';
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';

  const http = await import('node:http');
  mockUpstream = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      mockUpstreamHits += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"type":"start"}\n\ndata: {"type":"text-delta","text":"cc-ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((r) => mockUpstream!.listen(0, '127.0.0.1', () => r()));
  const addr = mockUpstream.address();
  mockUpstreamBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  ({ chatRoutes } = await import('../src/routes/chat.js'));
  ({ messagesRoutes } = await import('../src/routes/messages.js'));
  ({ dashboardRoutes } = await import('../src/routes/dashboard.js'));
  ({ ProviderRuntime } = await import('../src/providers/runtime.js'));
});

afterAll(async () => {
  if (mockUpstream) await new Promise<void>((r) => mockUpstream!.close(() => r()));
  rmSync(stateDir, { recursive: true, force: true });
});

interface Harness {
  base: string;
  providers: Record<string, Recording>;
  runtime: InstanceType<typeof ProviderRuntime>;
  close(): Promise<void>;
}

/**
 * 起一个真实监听的网关。
 * `omit` 用于模拟"某上游根本没装配"（runtime.get 返回 undefined）。
 */
async function makeHarness(
  fail: Partial<Record<ProviderName, FailMode>> = {},
  omit: ProviderName[] = [],
  assertEnabled: ProviderName[] = [],
): Promise<Harness> {
  const providers: Record<string, Recording> = {};
  const runtime = new ProviderRuntime({
    env: process.env,
    loadShards: () => ({ freebuff: {}, workbuddy: {} }),
    buildProviders: () => {
      const map = new Map<ProviderName, IProvider>();
      for (const name of ['commandcode', 'freebuff', 'workbuddy'] as ProviderName[]) {
        if (omit.includes(name)) continue;
        const p = recordingProvider(name, fail[name] ?? 'none', assertEnabled.includes(name));
        providers[name] = p;
        map.set(name, p);
      }
      return map;
    },
  });
  process.env.COMMANDCODE_API_BASE = mockUpstreamBase;
  // initialize() 才会执行 buildProviders 把 Provider 装配进 runtime；漏掉它时所有请求都会落到
  // 「运行时里没有该 Provider」分支（503 NO_PROVIDER_AVAILABLE），测出来的就不是降级语义了。
  await runtime.initialize();
  const app = Fastify();
  app.decorate('providerRuntime', runtime as never);
  await app.register(dashboardRoutes);
  await app.register(chatRoutes);
  await app.register(messagesRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const a = app.server.address();
  const base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  return { base, providers, runtime, close: () => app.close() };
}

async function post(
  base: string,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ body: string; statusCode: number; headers: Record<string, string> }> {
  const res = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  const hs: Record<string, string> = {};
  res.headers.forEach((v, k) => (hs[k.toLowerCase()] = v));
  return { body, statusCode: res.status, headers: hs };
}

const chatBody = (model: string, stream = true): unknown => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  stream,
});

// ─── 1. 选定上游失败：稳定错误码 + 其它上游零调用 ─────────────────────────────

describe('T214 strict：上游失败不跨 Provider 降级', () => {
  it('chat 非流式：目标上游产出前失败 → 稳定错误码，其它上游一次都没被调用', async () => {
    const h = await makeHarness({ freebuff: 'before-output' });
    try {
      const before = mockUpstreamHits;
      const r = await post(h.base, '/v1/chat/completions', chatBody('freebuff/mock-model', false));
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.body).toContain('PROVIDER_PROTOCOL_ERROR');
      expect(h.providers.freebuff.calls).toHaveLength(1);
      // 关键：没有落到 workbuddy/commandcode —— strict 不静默换上游。
      expect(h.providers.workbuddy.calls).toHaveLength(0);
      expect(mockUpstreamHits - before).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('chat 流式：产出前失败 → HTTP 错误码信封（未写头，可回真实状态码）', async () => {
    const h = await makeHarness({ freebuff: 'before-output' });
    try {
      const before = mockUpstreamHits;
      const r = await post(h.base, '/v1/chat/completions', chatBody('freebuff/mock-model'));
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.body).toContain('PROVIDER_PROTOCOL_ERROR');
      expect(h.providers.workbuddy.calls).toHaveLength(0);
      expect(mockUpstreamHits - before).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('messages 出口同样不降级：失败即错误信封，Anthropic 形态', async () => {
    const h = await makeHarness({ workbuddy: 'before-output' });
    try {
      const r = await post(h.base, '/v1/messages', {
        model: 'workbuddy/glm-5.2',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.body).toContain('PROVIDER_PROTOCOL_ERROR');
      expect(h.providers.freebuff.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('全部上游注入故障：仍是稳定错误码，不是 500 内部错误、不挂起', async () => {
    const h = await makeHarness({
      commandcode: 'before-output',
      freebuff: 'before-output',
      workbuddy: 'before-output',
    });
    try {
      const r = await post(h.base, '/v1/chat/completions', chatBody('freebuff/mock-model'));
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).not.toBe(500); // 500 = INTERNAL_ERROR（未预期的内部异常）；502 才对
      expect(r.body).toContain('PROVIDER_PROTOCOL_ERROR');
    } finally {
      await h.close();
    }
  });
});

// ─── 2. 首字节之后失败：只能中断，禁止跨 Provider 切换 ───────────────────────

describe('T214 strict：流已开始后失败不切换上游', () => {
  it('chat 流式：首块之后失败 → 已产出内容保留 + 错误码并入流，其它上游零调用', async () => {
    const h = await makeHarness({ freebuff: 'after-first-chunk' });
    try {
      const before = mockUpstreamHits;
      const r = await post(h.base, '/v1/chat/completions', chatBody('freebuff/mock-model'));
      // 流已开始，HTTP 状态不可再改 —— 与既有语义一致（200 + 流内错误）。
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/event-stream');
      expect(r.body).toContain('[freebuff:first]'); // 已产出的内容不撤回
      expect(r.body).toContain('PROVIDER_PROTOCOL_ERROR'); // 中断原因并入流
      expect(r.body).not.toContain('[freebuff:tail]'); // 后半段确实没发生
      expect(h.providers.workbuddy.calls).toHaveLength(0); // 没有偷偷换上游
      expect(mockUpstreamHits - before).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('messages 流式：首块之后失败 → Anthropic error 帧并入流，不切换上游', async () => {
    const h = await makeHarness({ workbuddy: 'after-first-chunk' });
    try {
      const r = await post(h.base, '/v1/messages', {
        model: 'workbuddy/glm-5.2',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('event: error');
      expect(r.body).toContain('PROVIDER_PROTOCOL_ERROR');
      expect(h.providers.freebuff.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});

// ─── 3. 未装配 / 未启用：明确错误或按既定路由语义回退 ────────────────────────

describe('T214 strict：缺失与禁用上游的边界语义', () => {
  it('上游根本没装配 → NO_PROVIDER_AVAILABLE（不是 500，也不是挂起）', async () => {
    const h = await makeHarness({}, ['workbuddy']);
    try {
      const r = await post(h.base, '/v1/chat/completions', chatBody('workbuddy/glm-5.2'));
      expect(r.statusCode).toBe(503); // 明确的服务端不可用，不是 500 内部错误、也不是挂起
      expect(r.body).toContain('NO_PROVIDER_AVAILABLE');
    } finally {
      await h.close();
    }
  });

  it('header 显式点名已停用上游 → router 直接拒绝（503，带 explicitly requested 文案）', async () => {
    const h = await makeHarness();
    try {
      expect(h.runtime.disable('freebuff')).toBe(true);
      const r = await post(h.base, '/v1/chat/completions', chatBody('mock-model'), {
        'x-upstream-provider': 'freebuff',
      });
      expect(r.statusCode).toBe(503);
      expect(r.body).toContain('explicitly requested');
      // 决策期就拦下了：请求根本没走到 Provider。
      expect(h.providers.freebuff.calls).toHaveLength(0);
      expect(h.providers.workbuddy.calls).toHaveLength(0);
      expect(h.providers.commandcode.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('前缀点名已停用上游 → 决策层不拦截（请求仍到该 Provider），由 Provider 自检拒绝', async () => {
    // 已登记的契约缺口：router 的六步里，步骤 3（模型名前缀）不查 enabled ——
    // 文件头注释只承诺"粘性步骤落空"，显式 header/extra_body（步骤 1/2）另有 503 分支。
    // 因此前缀路径的停用拦截**依赖各 Provider 自查总闸**（FreebuffProvider.assertEnabled）。
    // 本用例锁定现状：决策层照常放行 → Provider 抛 503。若今后把 enabled 检查提到步骤 3，
    // 本用例的 calls 断言会变红，届时同步更新契约说明。
    const h = await makeHarness({}, [], ['freebuff']);
    try {
      expect(h.runtime.disable('freebuff')).toBe(true);
      const r = await post(h.base, '/v1/chat/completions', chatBody('freebuff/mock-model'));
      expect(h.providers.freebuff.calls).toHaveLength(1); // 决策层没拦，请求确实进了上游门
      expect(r.statusCode).toBe(503); // 由 Provider 自身拒绝
      expect(r.body).toContain('NO_PROVIDER_AVAILABLE');
      expect(h.providers.workbuddy.calls).toHaveLength(0); // 也没有偷偷换上游
    } finally {
      await h.close();
    }
  });
});
