// =============================================================================
// Freebuff Provider 内部共享类型（T201）
// -----------------------------------------------------------------------------
// 与 Go 原版 Quorinex/Freebuff2API@a1c1035 的数据结构一一对应：
//   - CachedSession      ← free_session.go:41 cachedSession
//   - FreeSessionResponse ← free_session.go:28 freeSessionResponse
//   - ManagedRun         ← run_manager.go:40 managedRun
//   - RunSnapshot        ← run_manager.go:68 runSnapshot
//   - TokenSnapshot      ← run_manager.go:54 tokenSnapshot
//   - WaitingRoomError   ← run_manager.go:76 waitingRoomError（Error() 见 free_session.go 等价物）
//
// 说明：Go 用 time.Time 表达时刻；TS 统一用 epoch 毫秒 number，0 表示 Go 的
// `time.Time{}` 零值（未知/无过期/无等待窗口）。
// =============================================================================

// ─── 会话（free_session.go）──────────────────────────────────────────────────

/** free_session.go:17 sessionStatus。 */
export type SessionStatus =
  | 'disabled'
  | 'none'
  | 'queued'
  | 'active'
  | 'ended'
  | 'superseded';

/** free_session.go:28 freeSessionResponse —— 上游 /api/v1/freebuff/session 应答。 */
export interface FreeSessionResponse {
  status: string;
  instanceId: string;
  position: number;
  queueDepth: number;
  queuedAt: string;
  expiresAt: string;
  remainingMs: number;
  estimatedWaitMs: number;
  gracePeriodRemainingMs: number;
  message: string;
}

/** free_session.go:41 cachedSession —— 池内缓存（epoch ms；0 = 零值）。 */
export interface CachedSession {
  status: SessionStatus;
  instanceId: string;
  /** 过期时刻（epoch ms；0 = 上游未给）。 */
  expiresAt: number;
  position: number;
  queueDepth: number;
  /** 下一次允许轮询的时刻（epoch ms；0 = 无等待窗口）。 */
  pollAt: number;
  /** 建议重试间隔（ms），由 queuedPollDelay 决定。 */
  retryAfterMs: number;
}

// ─── Run（run_manager.go）────────────────────────────────────────────────────

/** run_manager.go:40 managedRun —— 一个 agent 的当前 run + 在途计数。 */
export interface ManagedRun {
  id: string;
  agentId: string;
  /** 创建时刻（epoch ms）。 */
  startedAt: number;
  inflight: number;
  requestCount: number;
  /** FINISH 进行中标记（防止重复收敛，Go run_manager.go:391）。 */
  finishing: boolean;
}

/** run_manager.go:68 runSnapshot —— 面板/健康快照的单 run 视图。 */
export interface RunSnapshot {
  agentId: string;
  runId: string;
  startedAt: number;
  inflight: number;
  requestCount: number;
}

/** run_manager.go:54 tokenSnapshot —— 单 Token 池快照。 */
export interface TokenSnapshot {
  name: string;
  runs: RunSnapshot[];
  drainingRuns: number;
  sessionStatus?: SessionStatus;
  sessionInstanceId?: string;
  sessionExpiresAt?: number;
  sessionPosition?: number;
  sessionQueueDepth?: number;
  sessionPollAt?: number;
  cooldownUntil?: number;
  lastError?: string;
}

// ─── 等待室错误（run_manager.go:76 waitingRoomError）─────────────────────────

/**
 * 上游等待室排队信号。
 *
 * Go 用 `errors.As(err, &waitingRoomError)` 分支；TS 用 `instanceof` +
 * isWaitingRoomError() 守护（跨模块复制引用风险由单例类规避）。
 */
export class WaitingRoomError extends Error {
  constructor(
    public readonly token: string,
    public readonly position: number,
    public readonly queueDepth: number,
    public readonly retryAfterMs: number,
  ) {
    // 文案对齐 Go 的 (*waitingRoomError).Error()（free_session.go 同级）。
    let message = 'freebuff waiting room queued';
    if (token) message += ` for ${token}`;
    if (position > 0) {
      message += queueDepth >= position ? ` (position ${position}/${queueDepth})` : ` (position ${position})`;
    }
    if (retryAfterMs > 0) {
      const seconds = Math.max(1, Math.round(retryAfterMs / 1000));
      message += `, retry in about ${seconds}s`;
    }
    super(message);
    this.name = 'WaitingRoomError';
  }
}

export function isWaitingRoomError(err: unknown): err is WaitingRoomError {
  return err instanceof WaitingRoomError;
}

// ─── Freebuff 运行配置 ───────────────────────────────────────────────────────

/**
 * FreebuffConfig —— config.go:15 Config 的 TS 对应。
 *
 * 凭据纪律（§3.7-2）：tokens 只从环境变量 FREEBUFF_TOKENS（逗号/换行分隔）
 * 读取，config.json 不落明文。
 */
export interface FreebuffConfig {
  /** 上游基址（默认 https://www.codebuff.com，config.go:108）。 */
  apiBase: string;
  /** 远程模型注册表源（models.go:18 freeAgentsSourceURL）。 */
  modelRegistryUrl: string;
  /** 账号池 Token 列表（来自 FREEBUFF_TOKENS）。 */
  tokens: string[];
  /** Run 轮换周期（ms，默认 6h；config.go:109 ROTATION_INTERVAL）。 */
  rotationIntervalMs: number;
  /** 请求超时（ms，默认 15m；config.go:110 REQUEST_TIMEOUT）。 */
  requestTimeoutMs: number;
  /** User-Agent（config.go:186 generateUserAgent）。 */
  userAgent: string;
  /** Provider 总闸（unified config 的 enabled）。 */
  enabled: boolean;
}
