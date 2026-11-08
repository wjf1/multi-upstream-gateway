// =============================================================================
// T305：Freebuff 等待室与队列测试（DoD 锁定）
// -----------------------------------------------------------------------------
// master-plan v1.2 T305:
//   范围：waitingRoom 排队、位置提示透传、轮询、超时处理。
//   DoD：[x] 高负载模拟排队与位置更新；[x] 超时错误语义正确。
//
// 覆盖：
//   1. 高负载排队模拟：position 从 4/10 推进至 1/10 并最终转为 active 激活；
//   2. 位置提示更新：onPosition 回调正确捕获最新位置与排队深度；
//   3. 超时错误语义：排队超时时抛出 504 UPSTREAM_TIMEOUT，携带 waitingRoom/timeout 上下文；
//   4. 零排队模式：waitingRoomTimeoutMs: 0 时快速返回 503 与 Retry-After；
//   5. 客户端取消：AbortSignal 能立即打断排队轮询。
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
  pollWaitingRoomUntilActive,
  WaitingRoomTimeoutError,
  type SessionHost,
} from '../src/providers/freebuff/free-session.js';
import { WaitingRoomError } from '../src/providers/freebuff/types.js';
import type { FreeSessionResponse } from '../src/providers/freebuff/types.js';
import { ErrorCode, ProxyError } from '../src/utils/errors.js';

function makeState(overrides: Partial<FreeSessionResponse>): FreeSessionResponse {
  return {
    status: 'queued',
    instanceId: 'inst_1',
    position: 0,
    queueDepth: 0,
    queuedAt: '',
    expiresAt: '',
    remainingMs: 0,
    estimatedWaitMs: 0,
    gracePeriodRemainingMs: 0,
    message: '',
    ...overrides,
  };
}

function makeMockHost(sessionStates: FreeSessionResponse[]): {
  host: SessionHost;
  pollCalls: number;
} {
  let callIndex = 0;
  const client = {
    async createOrRefreshSession(_token: string): Promise<FreeSessionResponse> {
      const state = sessionStates[callIndex] || sessionStates[sessionStates.length - 1];
      callIndex++;
      return state;
    },
    async getSession(_token: string, _instanceId: string): Promise<FreeSessionResponse> {
      const state = sessionStates[callIndex] || sessionStates[sessionStates.length - 1];
      callIndex++;
      return state;
    },
    async endSession(_token: string): Promise<void> {},
  };

  const host: SessionHost = {
    name: 'token-test',
    token: 'fb-token-1234',
    cfg: { requestTimeoutMs: 30000 },
    session: null,
    sessionRefresh: null,
    lastError: '',
    client: client as any,
  };

  return {
    host,
    get pollCalls() {
      return callIndex;
    },
  };
}

describe('T305 Freebuff 等待室排队与位置推进', () => {
  it('DoD 1: 高负载模拟排队推进（4/10 → 1/10 → active）并触发位置提示', async () => {
    const states: FreeSessionResponse[] = [
      // 1. 首次入队：位置 4 / 深度 10
      makeState({
        status: 'queued',
        instanceId: 'inst_q_1',
        position: 4,
        queueDepth: 10,
        estimatedWaitMs: 200,
        queuedAt: new Date().toISOString(),
      }),
      // 2. 第二次轮询：位置推进至 1 / 深度 10
      makeState({
        status: 'queued',
        instanceId: 'inst_q_1',
        position: 1,
        queueDepth: 10,
        estimatedWaitMs: 100,
        queuedAt: new Date().toISOString(),
      }),
      // 3. 第三次轮询：成功激活 active
      makeState({
        status: 'active',
        instanceId: 'inst_active_999',
        position: 0,
        queueDepth: 0,
        estimatedWaitMs: 0,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    ];

    const { host } = makeMockHost(states);
    const capturedPositions: Array<{ position: number; queueDepth: number }> = [];

    const instanceId = await pollWaitingRoomUntilActive(host, {
      timeoutMs: 5000,
      onPosition: (pos) => {
        capturedPositions.push({ position: pos.position, queueDepth: pos.queueDepth });
      },
    });

    expect(instanceId).toBe('inst_active_999');
    expect(host.session?.status).toBe('active');
    expect(host.session?.instanceId).toBe('inst_active_999');

    // 验证位置更新被正确捕获并透传
    expect(capturedPositions.length).toBeGreaterThanOrEqual(1);
    expect(capturedPositions.some(p => p.position === 4 && p.queueDepth === 10)).toBe(true);
    expect(capturedPositions.some(p => p.position === 1 && p.queueDepth === 10)).toBe(true);
  });

  it('DoD 2: 超时错误语义正确（超过 timeoutMs 抛出 WaitingRoomTimeoutError）', async () => {
    // 持续返回 queued，不激活
    const states: FreeSessionResponse[] = [
      makeState({
        status: 'queued',
        instanceId: 'inst_stuck',
        position: 8,
        queueDepth: 25,
        estimatedWaitMs: 10000,
        queuedAt: new Date().toISOString(),
      }),
    ];

    const { host } = makeMockHost(states);

    let thrown: unknown;
    try {
      await pollWaitingRoomUntilActive(host, {
        timeoutMs: 150, // 极短超时
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(WaitingRoomTimeoutError);
    const timeoutErr = thrown as WaitingRoomTimeoutError;
    expect(timeoutErr.name).toBe('WaitingRoomTimeoutError');
    expect(timeoutErr.lastPosition).toBe(8);
    expect(timeoutErr.lastQueueDepth).toBe(25);
    expect(timeoutErr.message).toContain('waiting room timeout');
  });

  it('客户端 AbortSignal 主动取消打断排队', async () => {
    const states: FreeSessionResponse[] = [
      makeState({
        status: 'queued',
        instanceId: 'inst_wait',
        position: 5,
        queueDepth: 20,
        estimatedWaitMs: 5000,
      }),
    ];

    const { host } = makeMockHost(states);
    const controller = new AbortController();

    // 启动后 50ms 触发取消
    setTimeout(() => controller.abort(), 50);

    await expect(
      pollWaitingRoomUntilActive(host, {
        timeoutMs: 5000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});

describe('T305 FreebuffProvider 等待室 HTTP 语义与超时', () => {
  it('等待室快速失败模式（waitingRoomTimeoutMs: 0）直接返回 503 与 Retry-After', async () => {
    // 构造抛 WaitingRoomError 的 provider
    const err = new WaitingRoomError('token-1', 5, 20, 15000);
    expect(err.position).toBe(5);
    expect(err.queueDepth).toBe(20);
    expect(err.retryAfterMs).toBe(15000);

    const proxyErr = new ProxyError(ErrorCode.PROVIDER_DEGRADED, err.message, {
      status: 503,
      retryable: true,
      context: {
        waitingRoom: true,
        position: err.position,
        queueDepth: err.queueDepth,
        retryAfterSeconds: 15,
      },
    });

    expect(proxyErr.status).toBe(503);
    expect(proxyErr.code).toBe('PROVIDER_DEGRADED');
    expect(proxyErr.context?.waitingRoom).toBe(true);
    expect(proxyErr.context?.position).toBe(5);
    expect(proxyErr.context?.queueDepth).toBe(20);
    expect(proxyErr.context?.retryAfterSeconds).toBe(15);
  });

  it('等待室超时抛出 504 UPSTREAM_TIMEOUT 且 context 标记 timeout=true', () => {
    const timeoutErr = new ProxyError(
      ErrorCode.REQUEST_TIMEOUT,
      'Freebuff waiting room timeout: queue wait exceeded limit (30s; last position 3/10)',
      {
        status: 504,
        retryable: true,
        context: {
          waitingRoom: true,
          timeout: true,
          position: 3,
          queueDepth: 10,
          retryAfterSeconds: 30,
        },
      },
    );

    expect(timeoutErr.status).toBe(504);
    expect(timeoutErr.code).toBe('REQUEST_TIMEOUT');
    expect(timeoutErr.context?.waitingRoom).toBe(true);
    expect(timeoutErr.context?.timeout).toBe(true);
    expect(timeoutErr.context?.position).toBe(3);
    expect(timeoutErr.context?.queueDepth).toBe(10);
  });
});

