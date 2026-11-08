// =============================================================================
// T304：路由策略高级配置测试（DoD 全项锁定）
// -----------------------------------------------------------------------------
// master-plan v1.2 T304:
//   范围：strict/auto/same-model、X-Upstream-Account（写审计）、粘性开关、路由规则配置页。
//   DoD：
//     [x] 1. 三模式行为断言（strict / auto / same-model）；
//     [x] 2. 强制账号指定生效且留痕（X-Upstream-Account 写入审计日志）；
//     [x] 3. 规则页配置热生效（GET/POST /api/routing/rules）。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AccountInfo, OpenAIChatRequest } from '../src/types/index.js';
import type {
  ChatOptions,
  IProvider,
  OpenAIModel,
  ProbeResult,
  ProviderHealth,
  ProviderName,
  UsageSnapshot,
} from '../src/providers/core/interface.js';
import { readAuditEntries } from '../src/utils/audit-log.js';
import { ADMIN_TOKEN } from '../src/utils/admin-guard.js';

let stateDir = '';
let configFile = '';
let auditLogFile = '';

function makeMockProvider(
  name: ProviderName,
  opts: { fail?: boolean; supportedModels?: string[]; onChat?: (req: OpenAIChatRequest, opts: ChatOptions) => void } = {},
): IProvider {
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
      const models = opts.supportedModels ?? ['glm-5.2', 'common-model'];
      return models.map(id => ({ id, object: 'model', created: 1, owned_by: name }));
    },
    async *chatCompletion(req: OpenAIChatRequest, chatOpts: ChatOptions): AsyncIterable<string> {
      if (opts.onChat) opts.onChat(req, chatOpts);
      if (opts.fail) throw new Error(`${name} failed`);
      yield `[${name}:ok]`;
    },
    extractUsage(): UsageSnapshot {
      return { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
    },
    listAccounts(): AccountInfo[] { return []; },
    async addAccount(): Promise<AccountInfo> { throw new Error('unsupported'); },
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
let chatRoutes: typeof import('../src/routes/chat.js')['chatRoutes'];
let ProviderRuntime: typeof import('../src/providers/runtime.js')['ProviderRuntime'];

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-t304-'));
  configFile = path.join(stateDir, 'config.json');
  auditLogFile = path.join(stateDir, 'audit-log.jsonl');

  writeFileSync(
    configFile,
    JSON.stringify({
      routing: {
        defaultProvider: 'freebuff',
        fallbackStrategy: 'strict',
        upstreamPriority: ['freebuff', 'workbuddy', 'commandcode'],
      },
    }),
    'utf-8',
  );

  process.env.COMMANDCODE_CONFIG_PATH = configFile;
  process.env.COMMANDCODE_ENV_PATH = path.join(stateDir, '.env');
  process.env.CREDENTIAL_STORE_PATH = path.join(stateDir, 'credentials.enc');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  process.env.AUDIT_LOG_PATH = auditLogFile;
  process.env.COMMANDCODE_API_KEY = 'test-key-t304';
  process.env.ACCEPTED_RISK_DISCLAIMER = '1';

  ({ dashboardRoutes } = await import('../src/routes/dashboard.js'));
  ({ chatRoutes } = await import('../src/routes/chat.js'));
  ({ ProviderRuntime } = await import('../src/providers/runtime.js'));
});

async function makeApp(providers: Map<ProviderName, IProvider>) {
  const runtime = new ProviderRuntime({
    buildProviders: () => providers,
  });

  const app: FastifyInstance = Fastify({ logger: false });
  app.decorate('providerRuntime', runtime as never);
  await app.register(dashboardRoutes);
  await app.register(chatRoutes);

  for (const [name, p] of providers) {
    runtime.registry.setProviderModels(name, await p.listModels());
  }

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return { app, runtime, base };
}

async function postChat(base: string, payload: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  const hs: Record<string, string> = {};
  res.headers.forEach((v, k) => (hs[k.toLowerCase()] = v));
  return { body, headers: hs, statusCode: res.status };
}

describe('T304 DoD 1: 三模式降级行为（strict / auto / same-model）', () => {
  it('strict 模式：首选 Provider 失败时不降级，直接返回 502/503 错误', async () => {
    // freebuff 失败，workbuddy 成功
    const providers = new Map<ProviderName, IProvider>([
      ['freebuff', makeMockProvider('freebuff', { fail: true })],
      ['workbuddy', makeMockProvider('workbuddy', { fail: false })],
    ]);

    const { app, runtime, base } = await makeApp(providers);
    await runtime.initialize();
    runtime.setRoutingRules({ fallbackStrategy: 'strict', defaultProvider: 'freebuff' });

    try {
      const res = await postChat(base, {
        model: 'freebuff/glm-5.2',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(res.statusCode).toBe(502);
      expect(res.body).toContain('freebuff failed');
    } finally {
      await app.close();
      await runtime.destroy();
    }
  });

  it('auto 模式：首选 Provider 首字节前失败自动降级到备选 Provider', async () => {
    const providers = new Map<ProviderName, IProvider>([
      ['freebuff', makeMockProvider('freebuff', { fail: true })],
      ['workbuddy', makeMockProvider('workbuddy', { fail: false })],
    ]);

    const { app, runtime, base } = await makeApp(providers);
    await runtime.initialize();
    // 设置 auto 降级策略
    runtime.setRoutingRules({ fallbackStrategy: 'auto', defaultProvider: 'freebuff' });

    try {
      const res = await postChat(base, {
        model: 'freebuff/glm-5.2',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-actual-upstream']).toBe('workbuddy');
      const data = JSON.parse(res.body);
      expect(data.choices[0].message.content).toBe('[workbuddy:ok]');
    } finally {
      await app.close();
      await runtime.destroy();
    }
  });

  it('same-model 模式：仅当备选 Provider 明确支持同名模型时才允许降级', async () => {
    // freebuff 失败；workbuddy 支持 glm-5.2，不支持 special-only-model
    const providers = new Map<ProviderName, IProvider>([
      ['freebuff', makeMockProvider('freebuff', { fail: true, supportedModels: ['glm-5.2', 'special-only-model'] })],
      ['workbuddy', makeMockProvider('workbuddy', { fail: false, supportedModels: ['glm-5.2'] })],
    ]);

    const { app, runtime, base } = await makeApp(providers);
    await runtime.initialize();
    runtime.setRoutingRules({ fallbackStrategy: 'same-model', defaultProvider: 'freebuff' });

    try {
      // 1. 同名模型 glm-5.2：workbuddy 支持 → 降级成功
      const resSame = await postChat(base, {
        model: 'freebuff/glm-5.2',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect(resSame.statusCode).toBe(200);
      expect(resSame.headers['x-actual-upstream']).toBe('workbuddy');

      // 2. 独占模型 special-only-model：workbuddy 不支持 → 拒绝降级，报错
      const resDiff = await postChat(base, {
        model: 'freebuff/special-only-model',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect(resDiff.statusCode).toBe(502);
      expect(resDiff.body).toContain('freebuff failed');
    } finally {
      await app.close();
      await runtime.destroy();
    }
  });
});

describe('T304 DoD 2: X-Upstream-Account 强制指定生效且写审计留痕', () => {
  it('请求头带 X-Upstream-Account 时生效传递并记入审计日志', async () => {
    let capturedPreferredAccount: string | undefined;

    const providers = new Map<ProviderName, IProvider>([
      [
        'workbuddy',
        makeMockProvider('workbuddy', {
          fail: false,
          onChat: (_req, opts) => {
            capturedPreferredAccount = opts.preferredAccountId;
          },
        }),
      ],
    ]);

    const { app, runtime, base } = await makeApp(providers);
    await runtime.initialize();

    const targetAccount = 'acc_forced_wb_888';

    try {
      const res = await postChat(
        base,
        { model: 'workbuddy/glm-5.2', messages: [{ role: 'user', content: 'test' }] },
        { 'x-upstream-account': targetAccount },
      );

      expect(res.statusCode).toBe(200);
      // 1. 验证 Provider 层面接收到 preferredAccountId
      expect(capturedPreferredAccount).toBe(targetAccount);

      // 2. 验证审计日志中留痕
      const entries = readAuditEntries(auditLogFile);
      const matched = entries.find((e) => (e as any).accountId === targetAccount);
      expect(matched).toBeDefined();
      expect((matched as any).accountId).toBe(targetAccount);
    } finally {
      await app.close();
      await runtime.destroy();
    }
  });
});

describe('T304 DoD 3: 路由规则管理与热生效 API（GET / POST /api/routing/rules）', () => {
  let app: FastifyInstance;
  let runtime: InstanceType<typeof ProviderRuntime>;

  beforeAll(async () => {
    const providers = new Map<ProviderName, IProvider>([
      ['commandcode', makeMockProvider('commandcode')],
      ['freebuff', makeMockProvider('freebuff')],
      ['workbuddy', makeMockProvider('workbuddy')],
    ]);

    runtime = new ProviderRuntime({
      buildProviders: () => providers,
    });

    app = Fastify({ logger: false });
    app.decorate('providerRuntime', runtime as never);
    await app.register(dashboardRoutes);
    await app.register(chatRoutes);
    await runtime.initialize();
  });

  afterAll(async () => {
    await app.close();
    await runtime.destroy();
  });

  it('GET /api/routing/rules 返回当前规则', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/routing/rules' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.rules).toBeDefined();
    expect(body.rules.fallbackStrategy).toBeDefined();
    expect(body.rules.defaultProvider).toBeDefined();
    expect(body.rules.upstreamPriority).toBeDefined();
  });

  it('POST /api/routing/rules 非法参数返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/routing/rules',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: {
        fallbackStrategy: 'invalid-strategy-xyz',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.errors.fallbackStrategy).toContain('无效的降级策略');
  });

  it('POST /api/routing/rules 合法修改即时热生效（无需重启）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/routing/rules',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: {
        fallbackStrategy: 'auto',
        defaultProvider: 'workbuddy',
        sessionStickyEnabled: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);

    // 验证运行时内存即时热生效
    expect(runtime.fallbackStrategyMode).toBe('auto');
    expect(runtime.defaultProvider).toBe('workbuddy');
    expect(runtime.getRoutingRules().sessionStickyEnabled).toBe(false);
  });
});
