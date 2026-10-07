// =============================================================================
// Freebuff 上游错误分类与冷却策略（T203）
// -----------------------------------------------------------------------------
// 对应 Go 原版 Quorinex/Freebuff2API@a1c1035：
//   - server.go:387-403  isSessionInvalid（error ∈ 5 个会话失效码）
//   - server.go:722-728  isRunInvalid（400 + runid not found/running）
//   - server.go:337-340  401 → Cooldown(30m) + invalidateSession
//   - server.go:323-335  会话失效/run 失效 → continue（同请求内重试）
//   - run_manager.go:449-459 markCooldown
//   - 3.4 熔断状态机：SOFT_COOL 429/5xx 指数退避 1→2→4→8→max 30min
//
// 本模块把 T201 散落在 provider.ts 的两段判定收敛为**单一分类入口** classify(),
// 每类错误显式给出「恢复动作 + 同请求内是否重试 + 冷却时长」，供 provider
// 的执行循环与 probe() 共用，避免两处判定漂移。
// =============================================================================

/** 上游错误的四类恢复语义（对应 §3.4 的冷却/重试动作）。 */
export type FreebuffErrorKind =
  | 'session_invalid' // 免费会话失效/被顶替/等待室要求：刷新会话后重试
  | 'run_invalid' // 上游已无对应 run：摘除并轮换后重试
  | 'auth_rejected' // 401/403：Token 被拒，冷却该账号
  | 'rate_limited' // 402/429：限流/额度，软冷却（指数退避）
  | 'server_error' // 5xx：上游故障，软冷却（指数退避）
  | 'upstream_error'; // 其余 4xx/未分类

/** 分类结果：驱动 provider 执行循环的状态迁移。 */
export interface ClassifiedFreebuffError {
  kind: FreebuffErrorKind;
  /** 是否允许在**同一请求内**换 run/换会话后重试（首字节之前）。 */
  retryable: boolean;
  /** 恢复动作。 */
  action: 'refresh_session' | 'rotate_run' | 'cooldown_auth' | 'cooldown_soft' | 'none';
  /** 固定冷却时长（ms）；0 表示由调用方决定（软冷却走指数退避）。 */
  cooldownMs: number;
  /** 分类理由（已脱敏，可入日志）。 */
  reason: string;
}

/** server.go:338 —— 401 后固定冷却 30 分钟。 */
export const AUTH_REJECT_COOLDOWN_MS = 30 * 60 * 1000;

/** §3.4 SOFT_COOL 指数退避基数（1→2→4→8→…）与上限 30min。 */
export const SOFT_COOL_BASE_MS = 60 * 1000;
export const SOFT_COOL_MAX_MS = 30 * 60 * 1000;

/** server.go:387 isSessionInvalid。 */
export function isSessionInvalid(status: number, errorBody: string): boolean {
  if (status < 400) return false;
  const code = extractErrorCode(errorBody);
  return (
    code === 'freebuff_update_required' ||
    code === 'waiting_room_required' ||
    code === 'waiting_room_queued' ||
    code === 'session_superseded' ||
    code === 'session_expired'
  );
}

/** server.go:722 isRunInvalid（400 + runid not found/running）。 */
export function isRunInvalid(status: number, errorBody: string): boolean {
  if (status !== 400) return false;
  const message = String(errorBody ?? '').toLowerCase();
  return message.includes('runid not found') || message.includes('runid not running');
}

/** 从错误体里取字符串型 error 字段（server.go:391 的 `struct{ Error string }`）。 */
export function extractErrorCode(errorBody: string): string {
  try {
    const parsed = JSON.parse(errorBody) as { error?: unknown };
    return typeof parsed?.error === 'string' ? parsed.error.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 上游错误分类（唯一入口）。
 *
 * 判定顺序与 Go 的 server.go:323-340 完全一致：会话失效 → run 失效 →
 * 401/403（Go 只冷却 401；本实现把 403 一并归入 auth_rejected，因为两者
 * codeForStatus 都映射 INVALID_CREDENTIAL，且 403 同样是"这个 Token 不被接受"）。
 */
export function classifyFreebuffError(status: number, errorBody: string): ClassifiedFreebuffError {
  if (isSessionInvalid(status, errorBody)) {
    return {
      kind: 'session_invalid',
      retryable: true,
      action: 'refresh_session',
      cooldownMs: 0,
      reason: `session invalid (${extractErrorCode(errorBody) || `HTTP ${status}`})`,
    };
  }
  if (isRunInvalid(status, errorBody)) {
    return {
      kind: 'run_invalid',
      retryable: true,
      action: 'rotate_run',
      cooldownMs: 0,
      reason: 'run invalid (runid not found/running)',
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'auth_rejected',
      retryable: false,
      action: 'cooldown_auth',
      cooldownMs: AUTH_REJECT_COOLDOWN_MS,
      reason: `upstream rejected token (HTTP ${status})`,
    };
  }
  if (status === 402 || status === 429) {
    return {
      kind: 'rate_limited',
      retryable: true,
      action: 'cooldown_soft',
      cooldownMs: 0,
      reason: `rate limited / quota (HTTP ${status})`,
    };
  }
  if (status >= 500) {
    return {
      kind: 'server_error',
      retryable: true,
      action: 'cooldown_soft',
      cooldownMs: 0,
      reason: `upstream server error (HTTP ${status})`,
    };
  }
  return {
    kind: 'upstream_error',
    retryable: false,
    action: 'none',
    cooldownMs: 0,
    reason: `unclassified upstream error (HTTP ${status})`,
  };
}

/**
 * §3.4 SOFT_COOL 指数退避：base * 2^(failures-1)，封顶 SOFT_COOL_MAX_MS。
 * failures 为本次失败前的**连续失败计数**（1 表示首次失败 → base）。
 */
export function softCooldownMs(failures: number, base = SOFT_COOL_BASE_MS): number {
  const n = Math.max(1, Math.floor(failures));
  // 先封顶指数避免 2^n 溢出（n 很大时）——超出上限即返回上限。
  const exponent = Math.min(n - 1, 30);
  return Math.min(base * Math.pow(2, exponent), SOFT_COOL_MAX_MS);
}

/** 取错误链上最近一个 HTTP 状态码（wrapper Error 的 cause 里可能藏着 ProxyError）。 */
export function findHttpStatus(err: unknown): number | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const status = (current as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) return status;
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') {
      const match = /\bstatus\s+(\d{3})\b/.exec(message);
      if (match) return Number(match[1]);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
