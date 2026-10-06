// =============================================================================
// 限流器（T105，执行依据 master-plan v1.2 §3.2 / §3.7-1）
// -----------------------------------------------------------------------------
// 全局桶 + per-provider 桶，RPM（请求数）/ TPM（token 量）滑动窗。超限决策由
// 调用方（security-guard.ts）映射为 429 + Retry-After；per-provider 桶相互独立
// —— 某个上游被打满不会误伤其它上游的流量。
//
// TPM 记账口径：请求**之前**只能按请求体大小估算输入侧 token（4 字符 ≈ 1 token，
// 与 usage 缺失时的成本估算同口径），输出侧记账属 T213 用量统计接线。预扣只影响
// TPM 判定的保守性，不影响 RPM。
//
// 配置来源（§3.2 config.rateLimit）：UnifiedConfig 已有 schema，但当前启动路径
// 仍走底座 loadConfig()（旧扁平视图）。在 T213 统一 API 层接线前，本模块以
// 环境变量兜底（RATE_LIMIT_GLOBAL_RPM/TPM、RATE_LIMIT_PROVIDER_<NAME>_RPM/TPM），
// 未设置 = 不限流（默认零破坏）。**T213 收口**：改由 UnifiedConfigStore.get()
// .rateLimit 经 reconfigureRateLimiter() 注入，删除 env 兜底通道。
// =============================================================================

/** 单桶限额（§3.2 RateBucket：rpm/tpm 均可选，至少一个生效才限流）。 */
export interface RateLimitBucketConfig {
  rpm?: number;
  tpm?: number;
}

/** per-provider 配置项：具体限额或 'inherit'（沿用全局值，独立计数；§3.2 P2-6）。 */
export type RateLimitScopeConfig = RateLimitBucketConfig | 'inherit';

export interface RateLimitConfig {
  global?: RateLimitBucketConfig;
  perProvider?: Record<string, RateLimitScopeConfig>;
}

/** 滑动窗宽度（§3.2 RPM/TPM 语义：每分钟）。 */
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimitDecision {
  allowed: boolean;
  /** 不允许时建议的 Retry-After 秒数（取窗口内最旧事件到期时刻，向上取整，1..60）。 */
  retryAfterSeconds: number;
}

function hasLimit(cfg: RateLimitBucketConfig | undefined): boolean {
  return !!cfg && (cfg.rpm !== undefined || cfg.tpm !== undefined);
}

/**
 * 单桶滑动窗：RPM 按事件时间戳计数，TPM 按 {时间, token} 记账。判定即预扣：
 * 允许则把本次请求/token 写入窗口，拒绝则不写（不会因为被拒的请求占用配额）。
 */
export class SlidingWindowRateLimiter {
  private hits: number[] = [];
  private tokenEvents: Array<{ t: number; n: number }> = [];

  constructor(
    private readonly cfg: RateLimitBucketConfig,
    private readonly windowMs: number = RATE_LIMIT_WINDOW_MS,
  ) {}

  tryAcquire(tokens = 0, now = Date.now()): RateLimitDecision {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && this.hits[0] <= cutoff) this.hits.shift();
    while (this.tokenEvents.length > 0 && this.tokenEvents[0].t <= cutoff) this.tokenEvents.shift();

    let allowed = true;
    let oldestAt = now;
    if (this.cfg.rpm !== undefined && this.hits.length + 1 > this.cfg.rpm) {
      allowed = false;
      oldestAt = Math.min(oldestAt, this.hits[0] ?? now);
    }
    if (
      allowed &&
      this.cfg.tpm !== undefined &&
      this.tokenEvents.reduce((acc, e) => acc + e.n, 0) + Math.max(0, tokens) > this.cfg.tpm
    ) {
      allowed = false;
      oldestAt = Math.min(oldestAt, this.tokenEvents[0]?.t ?? now);
    }

    if (!allowed) {
      return { allowed: false, retryAfterSeconds: clampRetry(oldestAt + this.windowMs - now) };
    }
    this.hits.push(now);
    if (tokens > 0) this.tokenEvents.push({ t: now, n: tokens });
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

function clampRetry(msRemaining: number): number {
  return Math.min(60, Math.max(1, Math.ceil(msRemaining / 1000)));
}

/**
 * 双层限流器：checkGlobal（/v1/* 入口）与 checkProvider（路由决策后 / 预判后）。
 * 桶惰性创建；'inherit' 用全局限额但独立计数；未配置的 provider 不限流。
 */
export class RateLimiter {
  private readonly globalLimiter: SlidingWindowRateLimiter | null;
  private readonly providerLimiters = new Map<string, SlidingWindowRateLimiter>();

  constructor(private readonly cfg: RateLimitConfig = {}) {
    this.globalLimiter = hasLimit(cfg.global) ? new SlidingWindowRateLimiter(cfg.global!) : null;
  }

  get config(): RateLimitConfig {
    return this.cfg;
  }

  /** 全局桶判定（进程级保护；所有 /v1 请求共享）。 */
  checkGlobal(tokens = 0, now = Date.now()): RateLimitDecision {
    if (!this.globalLimiter) return { allowed: true, retryAfterSeconds: 0 };
    return this.globalLimiter.tryAcquire(tokens, now);
  }

  /** per-provider 桶判定。桶相互独立 —— 上游 A 被打满不影响 B。 */
  checkProvider(name: string, tokens = 0, now = Date.now()): RateLimitDecision {
    const raw = this.cfg.perProvider?.[name];
    const effective: RateLimitBucketConfig = raw === 'inherit' ? (this.cfg.global ?? {}) : (raw ?? {});
    if (!hasLimit(effective)) return { allowed: true, retryAfterSeconds: 0 };
    let limiter = this.providerLimiters.get(name);
    if (!limiter) {
      limiter = new SlidingWindowRateLimiter(effective);
      this.providerLimiters.set(name, limiter);
    }
    return limiter.tryAcquire(tokens, now);
  }

  /** 清空全部桶（测试与配置热更新场景）。 */
  reset(): void {
    this.providerLimiters.clear();
  }
}

function positiveInt(raw: string | undefined): number | undefined {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * env 兜底配置（T213 收口前的通道）：RATE_LIMIT_GLOBAL_RPM/TPM 与
 * RATE_LIMIT_PROVIDER_<NAME>_RPM/TPM（NAME 为 provider 名的大写形式）。
 * 非法值（非正整数）静默忽略。
 */
export function resolveRateLimitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Required<RateLimitConfig> {
  const global: RateLimitBucketConfig = {};
  const rpm = positiveInt(env.RATE_LIMIT_GLOBAL_RPM);
  if (rpm !== undefined) global.rpm = rpm;
  const tpm = positiveInt(env.RATE_LIMIT_GLOBAL_TPM);
  if (tpm !== undefined) global.tpm = tpm;

  const perProvider: Record<string, RateLimitBucketConfig> = {};
  for (const [key, value] of Object.entries(env)) {
    const m = /^RATE_LIMIT_PROVIDER_([A-Z0-9]+)_(RPM|TPM)$/.exec(key);
    if (!m || value === undefined) continue;
    const n = positiveInt(value);
    if (n === undefined) continue;
    const name = m[1].toLowerCase();
    const dim = m[2].toLowerCase() as 'rpm' | 'tpm';
    perProvider[name] = { ...perProvider[name], [dim]: n };
  }
  return { global, perProvider };
}

// ─── 默认实例（进程单例；T213 经 reconfigureRateLimiter 注入 UnifiedConfig）──

let currentLimiter = new RateLimiter(resolveRateLimitConfigFromEnv());

/** 当前生效的限流器（security-guard 消费；测试可经 reconfigure 替换）。 */
export function getDefaultRateLimiter(): RateLimiter {
  return currentLimiter;
}

/** 替换限流配置与桶（T213：UnifiedConfig 的 rateLimit 热重载后调用）。 */
export function reconfigureRateLimiter(cfg: RateLimitConfig): void {
  currentLimiter = new RateLimiter(cfg);
}
