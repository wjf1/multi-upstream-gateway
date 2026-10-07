// =============================================================================
// T213 阶段 1：ProviderRuntime（三源运行时装配）
// -----------------------------------------------------------------------------
// 覆盖：
//   [ ] 按需初始化 —— 无分片/环境变量的 Provider 不执行 initialize（启动零变化）
//   [ ] 注册表只收 freebuff/workbuddy；CommandCode 走 priority 兜底（刻意不入表）
//   [ ] /v1/models 命名空间聚合门控：分片存在 + enabled !== false + isEnabled
//   [ ] 面板总闸 enable/disable 热生效并联动聚合
//   [ ] router 六步决策经 runtime 可用（prefix / registry / priority）
//   [ ] status() 暴露 sidecar 进程视图（WorkBuddy，§3.11-4）
// Provider 实例全部经 buildProviders 注入假实现 —— 不触网、不读写真实配置。
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  ChatOptions,
  IProvider,
  OpenAIModel,
  ProbeResult,
  ProviderHealth,
  ProviderName,
  UsageSnapshot,
} from '../src/providers/core/interface.js';
import type { AccountInfo } from '../src/types/index.js';
import { ProviderRuntime } from '../src/providers/runtime.js';
import type { OpenAIChatRequest } from '../src/types/index.js';

function fakeProvider(
  name: ProviderName,
  opts: {
    models?: OpenAIModel[];
    enabled?: boolean;
    sidecar?: Record<string, unknown>;
    onInitialize?: () => void;
  } = {},
): IProvider {
  let enabled = opts.enabled ?? true;
  let initialized = false;
  const instance: IProvider = {
    name,
    displayName: name.toUpperCase(),
    async initialize() {
      initialized = true;
      opts.onInitialize?.();
    },
    async health(): Promise<ProviderHealth> {
      return { healthy: initialized && enabled, total: opts.models?.length ?? 0, cooldownCount: 0, disabledCount: 0 };
    },
    async probe(): Promise<ProbeResult> {
      return { healthy: initialized && enabled, checkedAt: new Date().toISOString() };
    },
    async listModels() {
      return opts.models ?? [];
    },
    // eslint-disable-next-line require-yield
    async *chatCompletion(_req: OpenAIChatRequest, _opts: ChatOptions): AsyncIterable<string> {
      throw new Error('not wired (T213 phase 2)');
    },
    extractUsage(_events: unknown[]): UsageSnapshot {
      return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
    },
    listAccounts(): AccountInfo[] {
      return [];
    },
    async addAccount() {
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
    async destroy(): Promise<void> {
      initialized = false;
    },
    // sidecar 视图（duck-type：runtime 不做 instanceof）
    ...(opts.sidecar ? { sidecarStatus: () => opts.sidecar } : {}),
  } as IProvider & { sidecarStatus?: () => unknown };
  return instance;
}

function makeRuntime(
  shards: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
  overrides: Partial<Record<ProviderName, { models?: OpenAIModel[]; sidecar?: Record<string, unknown> }>> = {},
) {
  const initCalls: ProviderName[] = [];
  const runtime = new ProviderRuntime({
    env,
    loadShards: () => shards,
    buildProviders: (s) => {
      const map = new Map<ProviderName, IProvider>();
      for (const name of ['commandcode', 'freebuff', 'workbuddy'] as const) {
        const shard = s[name] as Record<string, unknown> | undefined;
        const enabled = shard ? shard.enabled !== false : true;
        map.set(
          name,
          fakeProvider(name, {
            models: overrides[name]?.models,
            enabled,
            sidecar: overrides[name]?.sidecar,
            onInitialize: () => initCalls.push(name),
          }),
        );
      }
      return map;
    },
  });
  return { runtime, initCalls };
}

const FB_MODELS: OpenAIModel[] = [
  { id: 'mock-model', object: 'model', created: 1, owned_by: 'Freebuff', name: 'mock-model' },
];
const WB_MODELS: OpenAIModel[] = [{ id: 'glm-5.2', object: 'model', created: 1, owned_by: 'workbuddy' }];

beforeEach(() => {
  delete process.env.FREEBUFF_TOKENS;
  delete process.env.WORKBUDDY_SIDECAR_BIN;
});

describe('ProviderRuntime（T213 阶段 1）', () => {
  it('按需初始化：无分片/环境变量时不执行 initialize（启动零变化）', async () => {
    const { runtime, initCalls } = makeRuntime({});
    await runtime.initialize();
    expect(initCalls).toEqual(['commandcode']);
    const st = await runtime.status();
    const fb = st.find((s) => s.name === 'freebuff')!;
    expect(fb.configured).toBe(false);
    expect(fb.initialized).toBe(false);
    expect(fb.health?.healthy).toBe(false);
    await runtime.destroy();
  });

  it('存在分片或环境变量即视为已配置并初始化', async () => {
    const { runtime, initCalls } = makeRuntime(
      { freebuff: { enabled: true } },
      { WORKBUDDY_SIDECAR_BIN: 'C:/sidecar.exe' },
    );
    await runtime.initialize();
    expect(initCalls).toEqual(['commandcode', 'freebuff', 'workbuddy']);
    await runtime.destroy();
  });

  it('注册表只收 freebuff/workbuddy；命名空间聚合带前缀', async () => {
    const { runtime } = makeRuntime(
      { freebuff: {}, workbuddy: {} },
      {},
      { freebuff: { models: FB_MODELS }, workbuddy: { models: WB_MODELS } },
    );
    await runtime.initialize();
    expect(runtime.registry.resolve('mock-model')).toEqual(['freebuff']);
    expect(runtime.registry.resolve('glm-5.2')).toEqual(['workbuddy']);
    const ns = runtime.namespacedModels().map((m) => m.id);
    expect(ns).toEqual(['freebuff/mock-model', 'workbuddy/glm-5.2']);
    await runtime.destroy();
  });

  it('聚合门控：分片缺失 / enabled:false / 总闸关闭都不出现在 /v1/models', async () => {
    const { runtime } = makeRuntime(
      { freebuff: { enabled: true }, workbuddy: { enabled: false } },
      {},
      { freebuff: { models: FB_MODELS }, workbuddy: { models: WB_MODELS } },
    );
    await runtime.initialize();
    expect(runtime.namespacedModels().map((m) => m.id)).toEqual(['freebuff/mock-model']);

    runtime.disable('freebuff');
    expect(runtime.namespacedModels()).toEqual([]);

    runtime.enable('freebuff');
    expect(runtime.namespacedModels().map((m) => m.id)).toEqual(['freebuff/mock-model']);
    await runtime.destroy();
  });

  it('router 经 runtime 可用：prefix > registry > priority', async () => {
    const { runtime } = makeRuntime(
      { freebuff: {}, workbuddy: {} },
      {},
      { freebuff: { models: FB_MODELS }, workbuddy: { models: WB_MODELS } },
    );
    await runtime.initialize();

    const viaPrefix = runtime.router.route({
      headers: {},
      body: { model: 'codebuddy/glm-5.2' },
      requestId: 'r1',
    });
    expect(viaPrefix).toMatchObject({ provider: 'workbuddy', model: 'glm-5.2', via: 'prefix' });

    const viaRegistry = runtime.router.route({ headers: {}, body: { model: 'mock-model' }, requestId: 'r2' });
    expect(viaRegistry).toMatchObject({ provider: 'freebuff', via: 'registry' });

    const viaPriority = runtime.router.route({ headers: {}, body: { model: 'glm-4.7' }, requestId: 'r3' });
    expect(viaPriority).toMatchObject({ provider: 'commandcode', via: 'priority' });

    const viaHeader = runtime.router.route({
      headers: { 'x-upstream-provider': 'workbuddy' },
      body: { model: 'glm-5.2' },
      requestId: 'r4',
    });
    expect(viaHeader).toMatchObject({ provider: 'workbuddy', via: 'header' });
    await runtime.destroy();
  });

  it('status() 暴露 WorkBuddy sidecar 进程视图（面板上游卡片数据源）', async () => {
    const { runtime } = makeRuntime(
      { workbuddy: {} },
      {},
      { workbuddy: { models: WB_MODELS, sidecar: { state: 'running', pid: 99, restarts: 0, healthy: true, baseUrl: 'http://127.0.0.1:8787' } } },
    );
    await runtime.initialize();
    const st = await runtime.status();
    const wb = st.find((s) => s.name === 'workbuddy')!;
    expect(wb.sidecar).toMatchObject({ state: 'running', pid: 99 });
    await runtime.destroy();
  });

  it('单 Provider 初始化失败不阻断其余（initErrors 可见）', async () => {
    const shards: Record<string, unknown> = { freebuff: {}, workbuddy: {} };
    const runtime = new ProviderRuntime({
      env: {},
      loadShards: () => shards,
      buildProviders: (s) => {
        const map = new Map<ProviderName, IProvider>();
        map.set('commandcode', fakeProvider('commandcode'));
        const fb = fakeProvider('freebuff', {
          onInitialize: () => {
            throw new Error('boom');
          },
        });
        map.set('freebuff', fb);
        map.set('workbuddy', fakeProvider('workbuddy', { models: WB_MODELS }));
        void s;
        return map;
      },
    });
    await runtime.initialize();
    const st = await runtime.status();
    const fb = st.find((s) => s.name === 'freebuff')!;
    expect(fb.initialized).toBe(false);
    expect(fb.initError).toContain('boom');
    expect(runtime.namespacedModels().map((m) => m.id)).toEqual(['workbuddy/glm-5.2']);
    await runtime.destroy();
  });
});

// 供端点测试复用的假 runtime 装饰（Fastify 类型经 runtime.ts 的模块增强）。
export function decorateRuntime(app: FastifyInstance, runtime: unknown): void {
  app.decorate('providerRuntime', runtime as ProviderRuntime);
}
