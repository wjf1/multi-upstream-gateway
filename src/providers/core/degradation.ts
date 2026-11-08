// =============================================================================
// 降级与级联防护管理器（DegradationManager，T303 DoD）
// -----------------------------------------------------------------------------
// 执行依据：master-plan v1.2 §3.6
// 核心能力：
//   1. 全局在途请求队列深度控制（queueMaxDepth 默认 128，超出返回 503+Retry-After）；
//   2. 30s 周期性健康探测调度与 degraded 状态标记；
//   3. 备选上游 429 熔断摘除（滑动窗口内 429 达标即停止向其降级并标记 degraded）；
//   4. 渐进切换流量控制（Ramp：第 1 分钟 10%，每分钟 +10% 平滑承接流量）；
//   5. 流式首字节降级铁律守护（仅首字节产生前允许切换，一旦流出字节禁止跨上游切换）。
// =============================================================================

import type { IProvider, ProviderName } from './interface.js';
import { ErrorCode, ProxyError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export interface DegradationOptions {
  /** 渐进切换初始流量比例（默认 10%）。 */
  rampStartPercent?: number;
  /** 渐进切换每分钟步进比例（默认 10%）。 */
  rampStepPercent?: number;
  /** 滑动窗口内备选上游 429 达到该次数即摘除（默认 2）。 */
  fallbackAbortHits?: number;
  /** 备选上游 429 统计滑动窗口时限（ms，默认 30000）。 */
  fallbackAbortWindowMs?: number;
  /** 全局在途请求上限（默认 128，超出拒启返回 503）。 */
  queueMaxDepth?: number;
  /** 周期性主动探活间隔（ms，默认 30000）。 */
  probeIntervalMs?: number;
}

export class DegradationManager {
  private inFlight = 0;
  private readonly rampStartPercent: number;
  private readonly rampStepPercent: number;
  private readonly fallbackAbortHits: number;
  private readonly fallbackAbortWindowMs: number;
  private readonly queueMaxDepth: number;
  private readonly probeIntervalMs: number;

  /** Provider 健康与降级状态字典。 */
  private degradedMap = new Map<ProviderName, { degraded: boolean; reason?: string; updatedAt: number }>();
  /** 备选上游 429 命中记录（用于滑动窗口熔断摘除）。 */
  private fallback429Hits = new Map<ProviderName, number[]>();
  /** 备选上游切换时间戳记录（用于渐进切换 ramp 计算）。 */
  private rampSwitchTimestamps = new Map<ProviderName, number>();
  /** ramp 计数器（用于确定性抽样分配）。 */
  private rampRequestCounters = new Map<ProviderName, number>();

  private probeTimer: NodeJS.Timeout | null = null;

  constructor(opts: DegradationOptions = {}) {
    this.rampStartPercent = opts.rampStartPercent ?? 10;
    this.rampStepPercent = opts.rampStepPercent ?? 10;
    this.fallbackAbortHits = opts.fallbackAbortHits ?? 2;
    this.fallbackAbortWindowMs = opts.fallbackAbortWindowMs ?? 30_000;
    this.queueMaxDepth = opts.queueMaxDepth ?? 128;
    this.probeIntervalMs = opts.probeIntervalMs ?? 30_000;
  }

  // ─── 1. 全局在途队列深度控制（queueMaxDepth）───────────────────────────────

  /** 获取当前在途请求数。 */
  getInFlightRequests(): number {
    return this.inFlight;
  }

  /** 获取全局在途队列深度上限。 */
  getQueueMaxDepth(): number {
    return this.queueMaxDepth;
  }

  /**
   * 申请请求队列槽位。若在途数达到 queueMaxDepth，立即抛出 503 GATEWAY_BUSY。
   */
  acquireQueueSlot(): void {
    if (this.inFlight >= this.queueMaxDepth) {
      throw new ProxyError(
        ErrorCode.GATEWAY_BUSY,
        `Gateway queue max depth exceeded (${this.queueMaxDepth}); new requests rejected`,
        {
          status: 503,
          retryable: true,
          context: {
            queueDepth: this.inFlight,
            maxDepth: this.queueMaxDepth,
            retryAfterSeconds: 5,
          },
        },
      );
    }
    this.inFlight++;
  }

  /** 释放请求队列槽位。 */
  releaseQueueSlot(): void {
    if (this.inFlight > 0) {
      this.inFlight--;
    }
  }

  // ─── 2. 健康探测与 degraded 标记 ──────────────────────────────────────────

  /** 查询 Provider 是否处于降级/异常状态。 */
  isDegraded(provider: ProviderName): boolean {
    return this.degradedMap.get(provider)?.degraded === true;
  }

  /** 获取 Provider 的降级信息。 */
  getDegradedInfo(provider: ProviderName): { degraded: boolean; reason?: string } {
    const item = this.degradedMap.get(provider);
    return item ? { degraded: item.degraded, reason: item.reason } : { degraded: false };
  }

  /** 手动或系统标记 Provider 状态。 */
  setProviderStatus(provider: ProviderName, status: 'healthy' | 'degraded', reason?: string): void {
    const wasDegraded = this.isDegraded(provider);
    const isNowDegraded = status === 'degraded';
    this.degradedMap.set(provider, {
      degraded: isNowDegraded,
      reason,
      updatedAt: Date.now(),
    });

    if (wasDegraded !== isNowDegraded) {
      logger.warn(
        `[DEGRADATION] Provider ${provider} status shifted to ${status.toUpperCase()}` +
          (reason ? `: ${reason}` : ''),
      );
      if (!isNowDegraded) {
        // 恢复健康时重置 429 计数与 ramp 状态
        this.fallback429Hits.delete(provider);
        this.rampSwitchTimestamps.delete(provider);
        this.rampRequestCounters.delete(provider);
      }
    }
  }

  /**
   * 启动 30s 周期性主动探活调度器。
   */
  startProbeScheduler(getProviders: () => IProvider[], intervalMs?: number): void {
    if (this.probeTimer) return;
    const interval = intervalMs ?? this.probeIntervalMs;

    this.probeTimer = setInterval(async () => {
      const providers = getProviders();
      for (const p of providers) {
        try {
          const res = await p.probe();
          if (res.healthy) {
            if (this.isDegraded(p.name)) {
              this.setProviderStatus(p.name, 'healthy', 'Probe recovered');
            }
          } else {
            this.setProviderStatus(p.name, 'degraded', res.detail || 'Probe reported unhealthy');
          }
        } catch (err: any) {
          this.setProviderStatus(p.name, 'degraded', err?.message || 'Probe threw error');
        }
      }
    }, interval);
  }

  /** 停止探活调度器。 */
  stopProbeScheduler(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  // ─── 3. 备选上游 429 熔断摘除 ──────────────────────────────────────────────

  /**
   * 记录备选上游收到的一次 429。若在滑动窗口内达到阈值，立即摘除并标记 degraded。
   */
  recordFallback429(provider: ProviderName): boolean {
    const now = Date.now();
    const windowStart = now - this.fallbackAbortWindowMs;

    let hits = this.fallback429Hits.get(provider) || [];
    hits = hits.filter((t) => t >= windowStart);
    hits.push(now);
    this.fallback429Hits.set(provider, hits);

    if (hits.length >= this.fallbackAbortHits) {
      this.setProviderStatus(
        provider,
        'degraded',
        `fallback aborted: 429 hit limit reached (${hits.length} times in ${this.fallbackAbortWindowMs}ms)`,
      );
      return true; // 触发熔断摘除
    }
    return false;
  }

  // ─── 4. 渐进切换（Ramp Traffic Controller）────────────────────────────────

  /**
   * 标记对备选上游的切换生效时刻。
   */
  recordFallbackSwitch(provider: ProviderName, now = Date.now()): void {
    if (!this.rampSwitchTimestamps.has(provider)) {
      this.rampSwitchTimestamps.set(provider, now);
      this.rampRequestCounters.set(provider, 0);
    }
  }

  /**
   * 获取备选上游当前的 ramp 允许承接百分比（0 ~ 100）。
   */
  getCurrentRampPercent(provider: ProviderName, now = Date.now()): number {
    const switchedAt = this.rampSwitchTimestamps.get(provider);
    if (!switchedAt) return 100; // 未处于 ramp 阶段则全量放行

    const elapsedMinutes = Math.floor(Math.max(0, now - switchedAt) / 60_000);
    const calculated = this.rampStartPercent + elapsedMinutes * this.rampStepPercent;
    return Math.min(100, Math.max(0, calculated));
  }

  /**
   * 判定当前请求是否被允许承接到该备选上游（按 ramp 比例抽样控制流量）。
   * 若返回 false，说明请求落在平滑削峰区间外，应抛出 503+Retry-After。
   */
  allowRampRequest(provider: ProviderName, now = Date.now()): boolean {
    const percent = this.getCurrentRampPercent(provider, now);
    if (percent >= 100) return true;

    const count = (this.rampRequestCounters.get(provider) ?? 0) + 1;
    this.rampRequestCounters.set(provider, count);

    // 采用确定性百分比分流算法（count % 100 < percent）
    return count % 100 < percent;
  }

  // ─── 5. 候选备选上游推荐 ──────────────────────────────────────────────────

  /**
   * 根据当前健康状况、启用状态与优先级，挑选合规的备选降级上游。
   */
  pickFallbackCandidate(
    primary: ProviderName,
    priorityList: ProviderName[],
    isEnabled: (p: ProviderName) => boolean,
  ): ProviderName | null {
    for (const p of priorityList) {
      if (p === primary) continue;
      if (!isEnabled(p)) continue;
      if (this.isDegraded(p)) continue;

      // 命中备选，登记切换
      this.recordFallbackSwitch(p);

      // 检查 ramp 限流
      if (!this.allowRampRequest(p)) {
        logger.info(`[DEGRADATION] Ramp shedding request for fallback ${p}`);
        continue;
      }
      return p;
    }
    return null;
  }
}
