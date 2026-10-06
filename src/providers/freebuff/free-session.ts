// =============================================================================
// Freebuff free session 缓存与刷新（T201）
// -----------------------------------------------------------------------------
// 对应 Go 原版 Quorinex/Freebuff2API@a1c1035 free_session.go：
//   - free_session.go:15    freeSessionPollInterval = 5s
//   - free_session.go:51    (*tokenPool).ensureSession（合并并发刷新的循环）
//   - free_session.go:102   readySessionLocked（disabled / active 新鲜度判定）
//   - free_session.go:120   refreshSession（queued → GET poll；none/ended/superseded → 重开）
//   - free_session.go:185   invalidateSession
//   - free_session.go:194   currentSessionInstanceID
//   - free_session.go:203   waitingRoomErrorFromSession
//   - free_session.go:225   logQueuePosition
//   - free_session.go:251   formatWaitDuration / formatElapsedDuration
//   - free_session.go:274   endSession
//   - free_session.go:380   queuedPollDelay
//   - free_session.go:394   parseOptionalTime
//
// 并发模型说明（Go sync.Mutex → TS）：
//   JS 单线程，且本文件所有临界区**不含 await**，因此同步读改天然原子，
//   与 Go 的 mu.Lock/Unlock 等价，无需引入 async-mutex（也符合"不新增依赖"）。
//   Go 的 sessionRefreshCh（合并并发刷新）在此用共享 Promise 表示：
//   已有刷新在途时，后来者 await 同一 Promise 并重新判定（等价 `<-ch; continue`）。
// =============================================================================

import { logger } from '../../utils/logger.js';
import type { CachedSession, FreeSessionResponse, SessionStatus } from './types.js';
import { WaitingRoomError } from './types.js';
import type { UpstreamClient } from './upstream.js';

/** free_session.go:15 freeSessionPollInterval。 */
export const FREE_SESSION_POLL_INTERVAL_MS = 5_000;

/** active 会话在过期前 5s 即视为需要刷新（free_session.go:113）。 */
const SESSION_EXPIRY_SKEW_MS = 5_000;

/**
 * 会话宿主：tokenPool 中与会话相关的可变字段（run_manager.go:24 tokenPool 的子集）。
 * TokenPool 结构化满足本接口；free-session 只依赖这些字段，保持单向依赖。
 */
export interface SessionHost {
  readonly name: string;
  readonly token: string;
  readonly client: UpstreamClient;
  readonly cfg: { requestTimeoutMs: number };
  session: CachedSession | null;
  /** 在途刷新句柄（合并并发，见文件头）。 */
  sessionRefresh: Promise<void> | null;
  lastError: string;
}

// ─── 判定（free_session.go:102 / 203）──────────────────────────────────────

/** free_session.go:102 readySessionLocked。 */
export function readySessionLocked(host: SessionHost, nowMs = Date.now()): { ready: boolean; instanceId: string } {
  const session = host.session;
  if (!session) return { ready: false, instanceId: '' };
  if (session.status === 'disabled') return { ready: true, instanceId: '' };
  if (session.status === 'active') {
    if (!session.instanceId) return { ready: false, instanceId: '' };
    if (session.expiresAt === 0 || nowMs < session.expiresAt - SESSION_EXPIRY_SKEW_MS) {
      return { ready: true, instanceId: session.instanceId };
    }
  }
  return { ready: false, instanceId: '' };
}

/** free_session.go:203 waitingRoomErrorFromSession。 */
export function waitingRoomErrorFromSession(
  token: string,
  session: CachedSession | null,
  nowMs = Date.now(),
): WaitingRoomError | null {
  if (!session || session.status !== 'queued') return null;
  if (session.pollAt !== 0 && nowMs < session.pollAt) {
    return new WaitingRoomError(token, session.position, session.queueDepth, session.pollAt - nowMs);
  }
  return null;
}

/** free_session.go:380 queuedPollDelay。 */
export function queuedPollDelay(state: FreeSessionResponse): number {
  if (!(state.estimatedWaitMs > 0)) return FREE_SESSION_POLL_INTERVAL_MS;
  const delay = state.estimatedWaitMs;
  if (delay < 1_000) return 1_000;
  if (delay > FREE_SESSION_POLL_INTERVAL_MS) return FREE_SESSION_POLL_INTERVAL_MS;
  return delay;
}

// ─── 刷新（free_session.go:51 / 120）───────────────────────────────────────

/**
 * free_session.go:51 ensureSession —— 返回可用 instanceId（disabled 时为 ''）。
 * 可失败：等待室排队抛 WaitingRoomError；刷新失败抛 Error（lastError 同步更新）。
 */
export async function ensureSession(host: SessionHost, nowMs = Date.now()): Promise<string> {
  for (;;) {
    const ready = readySessionLocked(host, nowMs);
    if (ready.ready) return ready.instanceId;

    const waiting = waitingRoomErrorFromSession(host.name, host.session, nowMs);
    if (waiting) throw waiting;

    if (host.sessionRefresh) {
      // 等价 Go：`case <-ch: continue`（复用他人刷新结果后重新判定）。
      await host.sessionRefresh;
      nowMs = Date.now();
      continue;
    }

    // 独占刷新：先登记 in-flight 句柄，再执行（后来者 await 它）。
    const refresh = refreshAndApply(host);
    host.sessionRefresh = refresh;
    try {
      await refresh;
    } finally {
      host.sessionRefresh = null;
    }

    // refresh 完成后按 Go 的返回语义收束（不再无条件循环）。
    const postWaiting = waitingRoomErrorFromSession(host.name, host.session, Date.now());
    if (postWaiting) throw postWaiting;
    if (host.session === null) {
      throw new Error(host.lastError || 'free session unavailable');
    }
    return readySessionLocked(host, Date.now()).instanceId;
  }
}

/** 执行一次 refreshSession 并把结果（会话/错误）落进宿主状态。 */
async function refreshAndApply(host: SessionHost): Promise<void> {
  let result: { session: CachedSession; instanceId: string };
  try {
    result = await refreshSession(host);
  } catch (err) {
    host.session = null;
    host.lastError = messageOf(err);
    throw err;
  }
  host.session = result.session;
  const waiting = waitingRoomErrorFromSession(host.name, result.session, Date.now());
  host.lastError = waiting ? waiting.message : '';
  return;
}

/**
 * free_session.go:120 refreshSession。
 * 当前会话处于 queued 且已有 instanceId → GET 轮询；否则 POST 新建/刷新。
 */
export async function refreshSession(
  host: SessionHost,
): Promise<{ session: CachedSession; instanceId: string }> {
  const current = host.session;
  let state: FreeSessionResponse;
  if (current && current.status === 'queued' && current.instanceId.trim() !== '') {
    try {
      state = await host.client.getSession(host.token, current.instanceId);
    } catch (err) {
      throw new Error(`poll free session: ${messageOf(err)}`, { cause: err });
    }
  } else {
    try {
      state = await host.client.createOrRefreshSession(host.token);
    } catch (err) {
      throw new Error(`start free session: ${messageOf(err)}`, { cause: err });
    }
  }

  for (;;) {
    const status = String(state.status ?? '').trim() as SessionStatus;
    switch (status) {
      case 'disabled':
        return { session: emptySession('disabled'), instanceId: '' };

      case 'active': {
        const instanceId = String(state.instanceId ?? '').trim();
        if (!instanceId) throw new Error('free session active response missing instanceId');
        const expiresAt = parseOptionalTime(state.expiresAt);
        return {
          session: {
            status: 'active',
            instanceId,
            expiresAt,
            position: 0,
            queueDepth: 0,
            pollAt: 0,
            retryAfterMs: 0,
          },
          instanceId,
        };
      }

      case 'queued': {
        const instanceId = String(state.instanceId ?? '').trim();
        if (!instanceId) throw new Error('free session queued response missing instanceId');
        logQueuePosition(host, state);
        const delay = queuedPollDelay(state);
        const position = Math.max(state.position, 1);
        return {
          session: {
            status: 'queued',
            instanceId,
            expiresAt: 0,
            position,
            queueDepth: Math.max(state.queueDepth, position),
            pollAt: Date.now() + delay,
            retryAfterMs: delay,
          },
          instanceId: '',
        };
      }

      case 'none':
      case 'ended':
      case 'superseded':
        try {
          state = await host.client.createOrRefreshSession(host.token);
        } catch (err) {
          throw new Error(`refresh free session: ${messageOf(err)}`, { cause: err });
        }
        continue;

      default:
        throw new Error(`unexpected free session status ${JSON.stringify(state.status)}`);
    }
  }
}

/** free_session.go:185 invalidateSession。 */
export function invalidateSession(host: SessionHost, reason: string): void {
  host.session = null;
  if (reason) host.lastError = reason;
}

/** free_session.go:194 currentSessionInstanceID。 */
export function currentSessionInstanceId(host: SessionHost): string {
  return host.session?.instanceId ?? '';
}

/** free_session.go:274 endSession —— 尽力关闭上游会话（无会话/disabled 时 no-op）。 */
export async function endSession(host: SessionHost): Promise<void> {
  const session = host.session;
  host.session = null;
  if (!session || session.status === 'disabled' || !session.instanceId) return;
  try {
    await host.client.endSession(host.token);
  } catch (err) {
    throw new Error(`end free session: ${messageOf(err)}`, { cause: err });
  }
}

// ─── 日志与格式化（free_session.go:225-272）────────────────────────────────

/** free_session.go:225 logQueuePosition。 */
export function logQueuePosition(host: SessionHost, state: FreeSessionResponse): void {
  const parts: string[] = [];
  if (state.queueDepth > 0) parts.push(`position ${state.position}/${state.queueDepth}`);
  else if (state.position > 0) parts.push(`position ${state.position}`);

  if (state.estimatedWaitMs > 0) {
    parts.push(`~${formatWaitDuration(state.estimatedWaitMs)} remaining`);
  }
  if (state.queuedAt) {
    const queuedAt = Date.parse(state.queuedAt);
    if (!Number.isNaN(queuedAt)) parts.push(`elapsed ${formatElapsedDuration(Date.now() - queuedAt)}`);
  }
  logger.info(`${host.name}: waiting room: ${parts.length > 0 ? parts.join(', ') : 'queued'}`);
}

/** free_session.go:251 formatWaitDuration（分钟粒度，与 Go Round(time.Minute) 对齐）。 */
export function formatWaitDuration(ms: number): string {
  const roundedMin = Math.round(ms / 60_000);
  if (roundedMin < 1) return '< 1 min';
  if (roundedMin >= 60) return `${Math.floor(roundedMin / 60)}h ${roundedMin % 60}m`;
  return `${roundedMin} min`;
}

/** free_session.go:264 formatElapsedDuration（秒粒度）。 */
export function formatElapsedDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

// ─── 工具 ────────────────────────────────────────────────────────────────────

/** free_session.go:394 parseOptionalTime —— RFC3339 → epoch ms（空串 → 0）。 */
export function parseOptionalTime(value: string): number {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return 0;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function emptySession(status: SessionStatus): CachedSession {
  return {
    status,
    instanceId: '',
    expiresAt: 0,
    position: 0,
    queueDepth: 0,
    pollAt: 0,
    retryAfterMs: 0,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
