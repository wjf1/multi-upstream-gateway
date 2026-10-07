// =============================================================================
// T204'/T205'：WorkBuddy 联邦透传 Provider（IProvider 契约 + sidecar 委托）
// -----------------------------------------------------------------------------
// 覆盖 DoD（3.11-2/3/4）：
//   [ ] chatCompletion 透传 /v1/chat/completions（流式 → 文本增量；非流 → 单块）
//   [ ] conversation_id 原样透传（T207' 网关侧唯一职责）；passthrough 模式跳过清洗层
//   [ ] listModels 读 sidecar /v1/models
//   [ ] 账号委托：listAccounts 读 /status；pause/resume/remove 打面板 API
//   [ ] addAccount 明确不支持（OAuth 设备授权属 T301）并给可执行提示
//   [ ] probe 走真实 /healthz；health() 汇总池快照
//   [ ] extractUsage：costUsd=null + native.points（§3.9 积分制口径）
// 手法：注入真实 WorkBuddySidecar（fake spawn）+ fake fetch —— 不触网、不落盘。
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WorkBuddyProvider } from '../src/providers/workbuddy/provider.js';
import { WorkBuddySidecar } from '../src/providers/workbuddy/sidecar.js';
import { ErrorCode, ProxyError } from '../src/utils/errors.js';
import type { OpenAIChatRequest } from '../src/types/index.js';

class FakeChild extends EventEmitter {
  pid = 4321;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

/** 可编排的 mock sidecar：按路径返回响应并记录调用。 */
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const calls: Call[] = [];
const BASE = 'http://127.0.0.1:8787';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let sidecarHealthy = true;
let chatMode: 'sse' | 'json' | 'http-error' = 'sse';

function makeFetch(): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    const call: Call = { method, url, headers: (init?.headers ?? {}) as Record<string, string> };
    if (init?.body) call.body = String(init.body);
    calls.push(call);

    if (url.endsWith('/healthz')) {
      if (!sidecarHealthy) return new Response('unhealthy', { status: 503 });
      return jsonResponse(200, { healthy: 1, total: 1, service: 'workbuddy2api' });
    }
    if (url.endsWith('/status')) {
      return jsonResponse(200, {
        total: 3,
        healthy: 2,
        cooling: 1,
        disabled: 1,
        accounts: [
          { uid: 'u-1', nickname: '一号', credits: 100 },
          { uid: 'u-2', nickname: '二号', paused: true },
          { uid: 'u-3', nickname: '三号', disabled: true, cooling: true },
        ],
      });
    }
    if (url.endsWith('/v1/models')) {
      return jsonResponse(200, {
        object: 'list',
        data: [
          { id: 'glm-5.2', object: 'model', created: 1, owned_by: 'workbuddy' },
          { id: 'claude-sonnet-5', object: 'model', created: 1, owned_by: 'workbuddy' },
        ],
      });
    }
    if (url.endsWith('/v1/chat/completions')) {
      if (chatMode === 'http-error') return jsonResponse(429, { error: { message: 'rate limited' } });
      if (chatMode === 'json') {
        return jsonResponse(200, {
          choices: [{ message: { content: '你好，世界' } }],
          usage: { prompt_tokens: 11, completion_tokens: 4 },
        });
      }
      const sse = [
        'data: {"choices":[{"delta":{"content":"你好"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"，世界"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"points":7}}',
        'data: [DONE]',
        '',
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

function makeProvider(env: Record<string, string> = {}, opts: { sidecar?: WorkBuddySidecar | null } = {}) {
  const sidecar =
    opts.sidecar === null
      ? null
      : opts.sidecar ??
        new WorkBuddySidecar({
          binPath: 'C:/fake/workbuddy2api.exe',
          port: 8787,
          attachProcessExitHook: false,
          spawnFn: (() => new FakeChild()) as unknown as typeof import('node:child_process').spawn,
          fetchFn: makeFetch(),
        });
  const provider = new WorkBuddyProvider({ sidecar: sidecar ?? undefined, fetchFn: makeFetch(), env });
  return { provider, sidecar };
}

function baseReq(extra: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: 'glm-5.2',
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

beforeEach(() => {
  calls.length = 0;
  sidecarHealthy = true;
  chatMode = 'sse';
});

describe('WorkBuddyProvider（联邦透传）', () => {
  it('命名空间与展示名', () => {
    const { provider } = makeProvider();
    expect(provider.name).toBe('workbuddy');
    expect(provider.displayName).toBe('WorkBuddy');
  });

  it('未配置 sidecar 二进制时初始化不阻断，但不可服务', async () => {
    const { provider } = makeProvider({}, { sidecar: null });
    await provider.initialize({ enabled: true });
    expect(provider.isEnabled()).toBe(true);
    await expect(collect(provider.chatCompletion(baseReq(), OPTS))).rejects.toMatchObject({
      code: ErrorCode.NO_PROVIDER_AVAILABLE,
    });
    expect((await provider.probe()).healthy).toBe(false);
  });

  it('sidecar 拉起失败不阻断初始化（尽力而为，健康面反映）', async () => {
    const broken = new WorkBuddySidecar({
      binPath: 'C:/fake/missing.exe',
      port: 8787,
      attachProcessExitHook: false,
      startTimeoutMs: 30,
      healthIntervalMs: 5,
      spawnFn: (() => new FakeChild()) as unknown as typeof import('node:child_process').spawn,
      fetchFn: (async () => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    });
    const { provider } = makeProvider({}, { sidecar: broken });
    await expect(provider.initialize({ enabled: true })).resolves.toBeUndefined();
    const pr = await provider.probe();
    expect(pr.healthy).toBe(false);
    expect(pr.detail).toBeTruthy();
  });

  it('chatCompletion 流式透传：SSE → 文本增量', async () => {
    const { provider } = makeProvider();
    await provider.initialize({ enabled: true, sidecar: { port: 8787 } });
    const chunks = await collect(provider.chatCompletion(baseReq(), OPTS));
    expect(chunks).toEqual(['你好', '，世界']);
    const call = calls.find((c) => c.url.endsWith('/v1/chat/completions'));
    expect(call).toBeTruthy();
  });

  it('conversation_id 原样透传（full 模式加 x-conversation-id；passthrough 不加）', async () => {
    const { provider: full } = makeProvider();
    await full.initialize({ enabled: true, rewriteMode: 'full' });
    await collect(full.chatCompletion(baseReq(), { ...OPTS, conversationId: 'conv-42' }));
    let call = calls.find((c) => c.url.endsWith('/v1/chat/completions'))!;
    expect(call.headers['x-conversation-id']).toBe('conv-42');

    calls.length = 0;
    const { provider: pass } = makeProvider();
    await pass.initialize({ enabled: true, rewriteMode: 'passthrough' });
    await collect(pass.chatCompletion(baseReq(), { ...OPTS, conversationId: 'conv-42' }));
    call = calls.find((c) => c.url.endsWith('/v1/chat/completions'))!;
    expect(call.headers['x-conversation-id']).toBeUndefined();
  });

  it('非流式：整段 JSON → 单块内容', async () => {
    chatMode = 'json';
    const { provider } = makeProvider();
    await provider.initialize({ enabled: true });
    const chunks = await collect(provider.chatCompletion(baseReq({ stream: false }), OPTS));
    expect(chunks).toEqual(['你好，世界']);
  });

  it('上游 429 → RATE_LIMIT（带上游原文）', async () => {
    chatMode = 'http-error';
    const { provider } = makeProvider();
    await provider.initialize({ enabled: true });
    await expect(collect(provider.chatCompletion(baseReq(), OPTS))).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMIT,
    });
  });

  it('listModels 读 sidecar 目录', async () => {
    const { provider } = makeProvider();
    await provider.initialize({ enabled: true });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(['glm-5.2', 'claude-sonnet-5']);
  });

  it('probe 真实往返并刷新池快照；health() 汇总口径', async () => {
    const { provider } = makeProvider();
    await provider.initialize({ enabled: true });
    const pr = await provider.probe();
    expect(pr.healthy).toBe(true);
    expect(typeof pr.latencyMs).toBe('number');

    const h = await provider.health();
    expect(h).toMatchObject({ healthy: true, total: 3, cooldownCount: 1 });
    expect(h.disabledCount).toBe(2); // disabled 1 + paused 1

    const list = provider.listAccounts();
    expect(list.map((a) => a.id)).toEqual(['u-1', 'u-2', 'u-3']);
    expect(list[0].apiKey).toBe('');
  });

  it('pause/resume/remove 委托 sidecar 面板 API', async () => {
    const { provider } = makeProvider();
    await provider.initialize({ enabled: true });
    provider.pauseAccount('u-1');
    provider.resumeAccount('u-1');
    provider.removeAccount('u-2');
    await new Promise((r) => setTimeout(r, 20));
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(posts).toContain(`${BASE}/panel/api/accounts/u-1/pause`);
    expect(posts).toContain(`${BASE}/panel/api/accounts/u-1/resume`);
    expect(posts).toContain(`${BASE}/panel/api/accounts/u-2/remove`);
  });

  it('addAccount 明确不支持并给可执行提示（OAuth 设备授权属 T301）', async () => {
    const { provider } = makeProvider();
    await provider.initialize({ enabled: true });
    await expect(provider.addAccount({})).rejects.toSatisfy((err: ProxyError) => {
      expect(err.code).toBe(ErrorCode.UNSUPPORTED_OPTION);
      expect(err.message).toContain('T301');
      return true;
    });
  });

  it('extractUsage：costUsd=null + native.points（积分制，§3.9）', () => {
    const { provider } = makeProvider();
    const snap = provider.extractUsage([
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 30 } } },
    ]);
    expect(snap).toMatchObject({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 30, costUsd: null });
    expect(snap.native?.points).toBeUndefined();

    const snap2 = provider.extractUsage([{ usage: { prompt_tokens: 1, completion_tokens: 1, points: 7 } }]);
    expect(snap2.costUsd).toBeNull();
    expect(snap2.native?.points).toBe(7);
  });

  it('sidecarStatus 暴露进程状态（面板上游卡片数据源）', async () => {
    const { provider, sidecar } = makeProvider();
    await provider.initialize({ enabled: true });
    const st = provider.sidecarStatus();
    expect(st).toBeTruthy();
    expect(st!.state).toBe('running');
    expect(st!.baseUrl).toBe(BASE);
    await sidecar.stop();
    expect(provider.sidecarStatus()!.state).toBe('stopped');
  });

  it('updateConfig 热重载 rewriteMode/enabled', async () => {
    const { provider } = makeProvider();
    await provider.initialize({ enabled: true, rewriteMode: 'full' });
    provider.updateConfig({ enabled: true, rewriteMode: 'passthrough' });
    expect(provider.isEnabled()).toBe(true);
    await collect(provider.chatCompletion(baseReq(), OPTS));
    const call = calls.find((c) => c.url.endsWith('/v1/chat/completions'))!;
    expect(call.headers['x-conversation-id']).toBeUndefined();
  });
});
