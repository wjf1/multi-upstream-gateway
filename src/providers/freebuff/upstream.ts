// =============================================================================
// Freebuff 上游 HTTP 客户端（T201）
// -----------------------------------------------------------------------------
// 对应 Go 原版 Quorinex/Freebuff2API@a1c1035 upstream.go：
//   - upstream.go:35-53   NewUpstreamClient（baseURL / timeout / userAgent）
//   - upstream.go:55-107  StartRun（POST /api/v1/agent-runs, action=START）
//   - upstream.go:109-137 FinishRun（action=FINISH, status=completed, totalSteps）
//   - upstream.go:139-155 ChatCompletions（POST /api/v1/chat/completions）
//   - upstream.go:157-177 doJSON（Bearer + Accept: application/json, text/event-stream）
//   - free_session.go:289-378 CreateOrRefreshSession / GetSession / EndSession / doSessionRequest
//
// 底座纪律（T105 §3.7-6）：所有出站请求一律走 safe-fetch.ts 的 safeFetch
// （undici redirect:'manual' + 逐跳 assertSafeUpstreamUrl），不得直接用全局 fetch。
// =============================================================================

import type { Response as UndiciResponse, RequestInit as UndiciRequestInit } from 'undici';
import { safeFetch, SafeFetchError } from '../../utils/safe-fetch.js';
import { ErrorCode, ProxyError, codeForStatus, terminalCodeFor } from '../../utils/errors.js';
import type { FreeSessionResponse } from './types.js';

const AGENT_RUNS_PATH = '/api/v1/agent-runs';
const CHAT_COMPLETIONS_PATH = '/api/v1/chat/completions';
const FREE_SESSION_PATH = '/api/v1/freebuff/session';

export interface FreebuffUpstreamConfig {
  apiBase: string;
  userAgent: string;
  requestTimeoutMs: number;
}

/** chatCompletions 的结果：2xx 时给出可继续读取的流式响应，否则给出错误体。 */
export interface ChatCompletionsResult {
  ok: boolean;
  status: number;
  /** ok=true 时存在（响应体尚未被消费，供流式/非流式读取）。 */
  response?: UndiciResponse;
  /** ok=false 时存在（上游错误体原文）。 */
  errorText?: string;
}

export class FreebuffUpstreamError extends ProxyError {
  constructor(message: string, status?: number, retryable = false) {
    super(terminalCodeFor(message) ?? codeForStatus(status), message, { status, retryable });
    this.name = 'FreebuffUpstreamError';
  }
}

export class UpstreamClient {
  constructor(private readonly cfg: FreebuffUpstreamConfig) {}

  // ─── Run 生命周期（upstream.go:55-137）─────────────────────────────────────

  /** upstream.go:55 StartRun —— 返回 runId。 */
  async startRun(authToken: string, agentId: string, signal?: AbortSignal): Promise<string> {
    const body = JSON.stringify({ action: 'START', agentId });
    const res = await this.doJson(authToken, AGENT_RUNS_PATH, body, signal, 'start run');
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new FreebuffUpstreamError(
        `start run failed with status ${res.status}: ${text.trim()}`,
        res.status,
        res.status >= 500,
      );
    }
    let parsed: { runId?: unknown };
    try {
      parsed = JSON.parse(text) as { runId?: unknown };
    } catch (err) {
      throw new FreebuffUpstreamError(`decode start run response: ${messageOf(err)}`, res.status);
    }
    const runId = typeof parsed.runId === 'string' ? parsed.runId.trim() : '';
    if (!runId) {
      throw new FreebuffUpstreamError(`start run response missing runId: ${text.trim()}`, res.status);
    }
    return runId;
  }

  /** upstream.go:109 FinishRun。 */
  async finishRun(
    authToken: string,
    runId: string,
    totalSteps: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = JSON.stringify({
      action: 'FINISH',
      runId,
      status: 'completed',
      totalSteps,
      directCredits: 0,
      totalCredits: 0,
    });
    const res = await this.doJson(authToken, AGENT_RUNS_PATH, body, signal, 'finish run');
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new FreebuffUpstreamError(
        `finish run failed with status ${res.status}: ${text.trim()}`,
        res.status,
        res.status >= 500,
      );
    }
  }

  // ─── 对话补全（upstream.go:139-155）─────────────────────────────────────────

  /**
   * upstream.go:139 ChatCompletions。
   * 2xx 返回未消费的响应（供 Provider 流式/非流式读取）；非 2xx 读出错误体原文。
   */
  async chatCompletions(
    authToken: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<ChatCompletionsResult> {
    const res = await this.doJson(authToken, CHAT_COMPLETIONS_PATH, body, signal, 'chat completions');
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, response: res };
    }
    const errorText = await res.text().catch(() => '');
    return { ok: false, status: res.status, errorText };
  }

  // ─── free session（free_session.go:289-378）────────────────────────────────

  /** free_session.go:289 CreateOrRefreshSession（POST，body "{}"）。 */
  async createOrRefreshSession(
    authToken: string,
    signal?: AbortSignal,
  ): Promise<FreeSessionResponse> {
    return this.doSessionRequest('POST', authToken, '', signal);
  }

  /** free_session.go:293 GetSession（GET + x-freebuff-instance-id）。 */
  async getSession(
    authToken: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<FreeSessionResponse> {
    return this.doSessionRequest('GET', authToken, instanceId, signal);
  }

  /** free_session.go:297 EndSession（DELETE；404 视为成功）。 */
  async endSession(authToken: string, signal?: AbortSignal): Promise<void> {
    const res = await this.request(authToken, FREE_SESSION_PATH, {
      method: 'DELETE',
      signal,
    }, 'free session delete');
    if (res.status === 404) return;
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => '');
      throw new FreebuffUpstreamError(
        `free session delete failed with status ${res.status}: ${text.trim()}`,
        res.status,
      );
    }
    // 释放 2xx 响应体。
    await res.text().catch(() => '');
  }

  /** free_session.go:327 doSessionRequest。 */
  private async doSessionRequest(
    method: 'POST' | 'GET',
    authToken: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<FreeSessionResponse> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (method === 'POST') {
      body = '{}';
      headers['content-type'] = 'application/json';
    } else if (instanceId) {
      headers['x-freebuff-instance-id'] = instanceId;
    }

    const res = await this.request(
      authToken,
      FREE_SESSION_PATH,
      { method, headers, body, signal },
      'free session',
    );

    // free_session.go:358 —— 404 视为 disabled。
    if (res.status === 404) {
      return emptySessionResponse('disabled');
    }

    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new FreebuffUpstreamError(
        `free session request failed with status ${res.status}: ${text.trim()}`,
        res.status,
        res.status >= 500,
      );
    }

    let parsed: FreeSessionResponse;
    try {
      parsed = JSON.parse(text) as FreeSessionResponse;
    } catch (err) {
      throw new FreebuffUpstreamError(`decode free session response: ${messageOf(err)}`, res.status);
    }
    if (typeof parsed?.status !== 'string' || parsed.status.trim() === '') {
      throw new FreebuffUpstreamError('free session response missing status', res.status);
    }
    return parsed;
  }

  // ─── 低层（upstream.go:157-177 doJSON）─────────────────────────────────────

  /** upstream.go:157 doJSON —— Bearer + JSON 头；返回原始响应（错误码由调用方处理）。 */
  private async doJson(
    authToken: string,
    path: string,
    body: string,
    signal: AbortSignal | undefined,
    what: string,
  ): Promise<UndiciResponse> {
    return this.request(
      authToken,
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
        signal,
      },
      what,
    );
  }

  /**
   * 统一出站入口：拼 URL → safeFetch（逐跳 SSRF 校验）→ 超时/中止合并。
   * 传输层失败（含被 SSRF 守卫拦下）映射为 ProxyError。
   */
  private async request(
    authToken: string,
    path: string,
    init: UndiciRequestInit,
    what: string,
  ): Promise<UndiciResponse> {
    const url = joinUrl(this.cfg.apiBase, path);
    const { signal, dispose } = combineSignals(init.signal, this.cfg.requestTimeoutMs);
    try {
      return await safeFetch(url, {
        ...init,
        signal,
        headers: {
          authorization: `Bearer ${authToken}`,
          'user-agent': this.cfg.userAgent,
          accept: 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      if (err instanceof SafeFetchError) {
        const code = err.reason === 'REDIRECT_BLOCKED' || err.reason === 'INVALID_LOCATION'
          ? ErrorCode.BLOCKED_HOST
          : ErrorCode.NETWORK_ERROR;
        throw new ProxyError(code, `${what}: ${err.message}`, { cause: err });
      }
      if (isAbortError(err)) throw err;
      throw new ProxyError(ErrorCode.NETWORK_ERROR, `${what}: ${messageOf(err)}`, {
        cause: err,
        retryable: true,
      });
    } finally {
      dispose();
    }
  }
}

// ─── SSE 文本增量读取（Provider 契约口径）────────────────────────────────────

/**
 * 把 SSE 响应体逐帧解析为 `data:` 负载字符串（不含 `data:` 前缀）。
 *
 * - 跳过空行与 `:` 开头的心跳注释；
 * - 收到 `[DONE]` 结束；
 * - 跨 chunk 的分帧用文本缓冲拼接（SSE 帧可被 TCP 任意切分）。
 *
 * 与 commandcode 外壳一致：Provider 只负责产出可用的负载，不做协议翻译。
 */
export async function* iterateSsePayloads(
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  // undici Response.body 的静态类型与 @types/node 的 Web ReadableStream 不同源，
  // 这里经 unknown 收窄为最小可用形态（只用到 getReader()）。
  const stream = body as ReadableStream<Uint8Array> | null | undefined;
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          if (payload === '[DONE]') return;
          continue;
        }
        yield payload;
      }
    }
    // 收尾：无换行结尾的最后一帧。
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') yield payload;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 尽力而为 */
    }
  }
}

// ─── 工具 ────────────────────────────────────────────────────────────────────

/** upstream.go doJSON 的 url.JoinPath 等价物（path 以 / 开头）。 */
export function joinUrl(base: string, path: string): string {
  const trimmedBase = String(base ?? '').replace(/\/+$/, '');
  return `${trimmedBase}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * 合并「调用方 AbortSignal」与「上游超时」：任一触发即中止，并确保定时器清理。
 * 等价 Go upstream.go:252 的 http.Client{Timeout} + ctx 取消双保险。
 */
export function combineSignals(
  external: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  timer?.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

/** 判断是否为中止类错误（客户端断开 / 超时）。 */
export function isAbortError(err: any): boolean {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 20) return true;
  const message = String(err?.message ?? '').toLowerCase();
  if (message.includes('abort')) return true;
  const cause = err?.cause;
  if (cause && (cause.name === 'AbortError' || String(cause?.message ?? '').toLowerCase().includes('abort'))) {
    return true;
  }
  return false;
}

function emptySessionResponse(status: string): FreeSessionResponse {
  return {
    status,
    instanceId: '',
    position: 0,
    queueDepth: 0,
    queuedAt: '',
    expiresAt: '',
    remainingMs: 0,
    estimatedWaitMs: 0,
    gracePeriodRemainingMs: 0,
    message: '',
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
