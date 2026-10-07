// =============================================================================
// P0-PORT-D2：CommandCode Provider 薄适配层（IProvider 契约）
// -----------------------------------------------------------------------------
// 覆盖 D2 交付：
//   [ ] `providers/commandcode/provider.ts` 实现 IProvider（18 成员全集）
//   [ ] 不搬家：薄包装既有 CommandCodeAdapter + sendToCC + config/用量/模型层
//   [ ] chatCompletion 产出文本增量（text-delta），error 事件转 ProxyError
//   [ ] extractUsage 复用 accumulateUsage（含权威 costUsd / cache 明细口径）
//   [ ] 账号面脱敏（只露尾 4 位）；启停总闸 + 热重载
// 手法：全部外部依赖经 CommandCodeProviderDeps 注入 —— 测试不触网、不读写真实
// config.json / .env（这些路径是模块加载期常量，测试无法覆盖）。
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { AccountInfo, ModelItem, OpenAIChatRequest } from '../src/types/index.js';
import { CommandCodeProvider, type CommandCodeProviderDeps } from '../src/providers/commandcode/provider.js';
import { ErrorCode, ProxyError } from '../src/utils/errors.js';

const ACCOUNTS: AccountInfo[] = [
  { id: 'acc_1', name: '主账号', apiKey: 'sk-live-abcdef123456', addedAt: '2026-10-01T00:00:00.000Z' },
  { id: 'acc_2', name: '备用', apiKey: 'sk-back-9876543210', addedAt: '2026-10-02T00:00:00.000Z' },
];

const MODELS: ModelItem[] = [
  { id: 'glm-4.7', object: 'model', created: 1, owned_by: 'CommandCode' },
  { id: 'claude-sonnet-5', object: 'model', created: 1, owned_by: 'CommandCode' },
];

/** 把 SSE 行数组包成上游 Readable。 */
function sseStream(lines: string[]): Readable {
  return Readable.from(lines.map((l) => `${l}\n`));
}

function makeProvider(overrides: Partial<CommandCodeProviderDeps> = {}) {
  const sent: Array<{ body: unknown; opts: Record<string, unknown> }> = [];
  const deps: CommandCodeProviderDeps = {
    gatewayConfig: () => ({
      ccApiBase: 'https://cc.example.test',
      ccVersion: '1.0.0',
      accounts: ACCOUNTS,
      activeAccountId: 'acc_1',
      rotationMode: 'manual',
    }),
    activeApiKey: () => ACCOUNTS[0].apiKey,
    models: () => MODELS,
    send: async (body, opts) => {
      sent.push({ body, opts: opts as unknown as Record<string, unknown> });
      return sseStream([
        'data: {"type":"start"}',
        'data: {"type":"text-delta","text":"Hello"}',
        'data: {"type":"text-delta","data":{"text":" world"}}',
        'data: {"type":"finish","totalUsage":{"inputTokens":10,"outputTokens":5,"inputTokenDetails":{"cacheReadTokens":2}}}',
        'data: [DONE]',
      ]);
    },
    probeUpstream: async () => ({ org: { id: 'org_1' } }),
    loginAccount: async (apiKey, name) => ({ id: 'acc_new', name: name ?? 'new', apiKey, addedAt: 'now' }),
    logoutAccount: () => true,
    ...overrides,
  };
  const provider = new CommandCodeProvider(deps);
  return { provider, sent };
}

function baseReq(extra: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: 'glm-4.7',
    messages: [{ role: 'user', content: 'hi' } as never],
    stream: true,
    ...extra,
  };
}

const OPTS = { requestId: 'req-1' };

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe('CommandCodeProvider 契约（D2 薄适配层）', () => {
  let provider: CommandCodeProvider;
  beforeEach(async () => {
    ({ provider } = makeProvider());
    await provider.initialize({ enabled: true, rotationMode: 'manual' });
  });

  it('暴露稳定的命名空间与展示名', () => {
    expect(provider.name).toBe('commandcode');
    expect(provider.displayName).toBe('CommandCode');
  });

  it('initialize 后默认启用；disable/enable 驱动总闸', () => {
    expect(provider.isEnabled()).toBe(true);
    provider.disable();
    expect(provider.isEnabled()).toBe(false);
    provider.enable();
    expect(provider.isEnabled()).toBe(true);
  });

  it('未初始化或已禁用时 chatCompletion 抛 NO_PROVIDER_AVAILABLE', async () => {
    const { provider: fresh } = makeProvider();
    await expect(collect(fresh.chatCompletion(baseReq(), OPTS))).rejects.toMatchObject({
      code: ErrorCode.NO_PROVIDER_AVAILABLE,
    });

    provider.disable();
    await expect(collect(provider.chatCompletion(baseReq(), OPTS))).rejects.toMatchObject({
      code: ErrorCode.NO_PROVIDER_AVAILABLE,
    });
  });

  it('缺少 model 时抛 MODEL_NOT_FOUND', async () => {
    await expect(collect(provider.chatCompletion(baseReq({ model: '' }), OPTS))).rejects.toMatchObject({
      code: ErrorCode.MODEL_NOT_FOUND,
    });
  });

  it('chatCompletion 只产出文本增量（忽略 start / finish / [DONE]）', async () => {
    const chunks = await collect(provider.chatCompletion(baseReq(), OPTS));
    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('把 requestId / abortSignal 透传给上游 send', async () => {
    const { provider: p, sent } = makeProvider();
    await p.initialize({ enabled: true });
    const ac = new AbortController();
    await collect(p.chatCompletion(baseReq(), { requestId: 'req-42', abortSignal: ac.signal }));
    expect(sent).toHaveLength(1);
    expect(sent[0].opts.abortSignal).toBe(ac.signal);
    expect(sent[0].opts.apiKey).toBe(ACCOUNTS[0].apiKey);
  });

  it('上游以 error 事件告知失败时抛 ProxyError（不再静默 yield）', async () => {
    const { provider: p } = makeProvider({
      send: async () =>
        sseStream([
          'data: {"type":"start"}',
          'data: {"type":"text-delta","text":"partial"}',
          'data: {"type":"error","error":{"message":"model is not available"}}',
        ]),
    });
    await p.initialize({ enabled: true });
    await expect(collect(p.chatCompletion(baseReq(), OPTS))).rejects.toBeInstanceOf(ProxyError);
  });

  it('无可用凭据时抛 MISSING_CREDENTIAL 而不是把空 key 发给上游', async () => {
    const { provider: p, sent } = makeProvider({ activeApiKey: () => '' });
    await p.initialize({ enabled: true });
    await expect(collect(p.chatCompletion(baseReq(), OPTS))).rejects.toMatchObject({
      code: ErrorCode.MISSING_CREDENTIAL,
    });
    expect(sent).toHaveLength(0);
  });

  it('listModels 直接复用注册表缓存（ModelItem → OpenAIModel）', async () => {
    await expect(provider.listModels()).resolves.toEqual(MODELS);
  });

  it('listAccounts 脱敏凭据（只露尾 4 位，不落全量 key）', () => {
    const list = provider.listAccounts();
    expect(list).toHaveLength(2);
    expect(list[0].apiKey).toBe('****3456');
    expect(list[0].apiKey).not.toContain('sk-live');
    expect(list[1].apiKey).toBe('****3210');
  });

  it('extractUsage 复用 accumulateUsage：token 口径 + 权威 costUsd', () => {
    const snap = provider.extractUsage([
      { type: 'finish', totalUsage: { inputTokens: 100, outputTokens: 40, inputTokenDetails: { cacheReadTokens: 30 } } },
      { type: 'provider-metadata', providerMetadata: { gateway: { cost: '0.00123' } } },
    ]);
    expect(snap.inputTokens).toBe(100);
    expect(snap.outputTokens).toBe(40);
    expect(snap.cacheReadTokens).toBe(30);
    expect(snap.costUsd).toBeCloseTo(0.00123, 6);
  });

  it('extractUsage：无权威计费时 costUsd 为 null（≠ 0，§3.9 不参与聚合语义）', () => {
    const snap = provider.extractUsage([
      { type: 'finish', totalUsage: { inputTokens: 7, outputTokens: 3 } },
    ]);
    expect(snap.costUsd).toBeNull();
    expect(snap.cacheWriteTokens).toBe(0);
  });

  it('health 反映账号数与本地暂停；probe 走真实注入的往返', async () => {
    const h = await provider.health();
    expect(h).toMatchObject({ healthy: true, total: 2, disabledCount: 0 });

    provider.pauseAccount('acc_2');
    const h2 = await provider.health();
    expect(h2.disabledCount).toBe(1);
    expect(h2.healthy).toBe(true);

    const pr = await provider.probe();
    expect(pr.healthy).toBe(true);
    expect(typeof pr.latencyMs).toBe('number');
    expect(pr.checkedAt).toMatch(/^\d{4}-/);
  });

  it('probe 在上游拒绝时返回不健康（禁止恒真）', async () => {
    const { provider: p } = makeProvider({ probeUpstream: async () => null });
    await p.initialize({ enabled: true });
    const pr = await p.probe();
    expect(pr.healthy).toBe(false);
    expect(pr.detail).toBeTruthy();
  });

  it('probe 无凭据时不发请求', async () => {
    let called = 0;
    const { provider: p } = makeProvider({
      activeApiKey: () => '',
      probeUpstream: async () => {
        called += 1;
        return {};
      },
    });
    await p.initialize({ enabled: true });
    const pr = await p.probe();
    expect(pr.healthy).toBe(false);
    expect(called).toBe(0);
  });

  it('addAccount 委托管理员登录；removeAccount 委托登出（幂等）', async () => {
    let loggedOut = '';
    const { provider: p } = makeProvider({
      logoutAccount: (id) => {
        loggedOut = id;
        return true;
      },
    });
    await p.initialize({ enabled: true });
    await expect(p.addAccount({ apiKey: 'sk-new', name: '新号' })).resolves.toMatchObject({ id: 'acc_new' });
    p.removeAccount('acc_2');
    expect(loggedOut).toBe('acc_2');
    expect(() => p.removeAccount('acc_missing')).not.toThrow();
  });

  it('addAccount 缺凭据时抛 MISSING_CREDENTIAL', async () => {
    await expect(provider.addAccount({})).rejects.toMatchObject({ code: ErrorCode.MISSING_CREDENTIAL });
  });

  it('updateConfig 热重载 enabled/rotationMode，但不接受凭据字段', async () => {
    provider.updateConfig({ enabled: false, rotationMode: 'auto-quota' });
    expect(provider.isEnabled()).toBe(false);
    provider.updateConfig({ enabled: true });
    expect(provider.isEnabled()).toBe(true);
  });

  it('destroy 后视为未初始化（chatCompletion 抛 NO_PROVIDER_AVAILABLE）', async () => {
    await provider.destroy();
    await expect(collect(provider.chatCompletion(baseReq(), OPTS))).rejects.toMatchObject({
      code: ErrorCode.NO_PROVIDER_AVAILABLE,
    });
  });
});
