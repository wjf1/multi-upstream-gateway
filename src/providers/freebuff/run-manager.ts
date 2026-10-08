// =============================================================================
// Freebuff Run 生命周期与账号池（T201）
// -----------------------------------------------------------------------------
// 对应 Go 原版 Quorinex/Freebuff2API@a1c1035 run_manager.go：
//   - run_manager.go:14-22   RunManager（cfg / pools / next / stopCh / wg）
//   - run_manager.go:24-38   tokenPool（runs / draining / session / lastError / cooldownUntil）
//   - run_manager.go:40-74   managedRun / runLease / tokenSnapshot / runSnapshot
//   - run_manager.go:105-124 NewRunManager（按 AuthTokens 建池，命名 token-N）
//   - run_manager.go:126-153 Start（后台 prewarm + 每分钟 maintain）
//   - run_manager.go:155-171 prewarm（ensureSession + 每个 agent rotateAgent）
//   - run_manager.go:173-181 Close（停 ticker + 每池 shutdown）
//   - run_manager.go:183-217 Acquire（Round-robin 起点 + 逐池尝试 + 等待室择优）
//   - run_manager.go:219-246 Release / Invalidate / Cooldown / Snapshots
//   - run_manager.go:248-278 (*tokenPool).acquire（冷却判定 + 轮换 + inflight/requestCount++）
//   - run_manager.go:280-307 maintain（会话保活 + 过期 run 轮换 + draining 收敛）
//   - run_manager.go:309-333 shutdown（FINISH 全部 run + endSession）
//   - run_manager.go:335-373 rotateAgent（START 新 run；旧 run 入 draining 并异步收敛）
//   - run_manager.go:375-426 release / finishIfReady
//   - run_manager.go:428-459 invalidate / markCooldown
//   - run_manager.go:461-489 snapshot
//
// T201 范围：多 Token 的最简形态 —— Round-robin 选池 + 失败冷却跳过。
// 完整账号池语义（配额感知调度、账号健康分级、持久化）属 T203；本文件的
// RunManager 已把「选号」集中在 Acquire，并在下方标出 T203 扩展点。
//
// 并发模型：JS 单线程 + 临界区内无 await ⇒ 等价 Go 的 sync.Mutex 临界区
// （无 async-mutex 依赖）；Go 的 WaitGroup/goroutine 用 Promise + setInterval 表达。
// =============================================================================

import { logger } from '../../utils/logger.js';
import type { FreebuffConfig, ManagedRun, RunSnapshot, TokenSnapshot } from './types.js';
import { WaitingRoomError } from './types.js';
import { SOFT_COOL_BASE_MS, softCooldownMs } from './errors.js';
import {
  endSession,
  ensureSession,
  type SessionHost,
} from './free-session.js';
import type { UpstreamClient } from './upstream.js';

/** run_manager.go:49 runLease。 */
export interface RunLease {
  pool: TokenPool;
  run: ManagedRun;
}

/** run_manager.go:24 tokenPool（含 T203 需要的 enabled 开关）。 */
export class TokenPool implements SessionHost {
  runs = new Map<string, ManagedRun>();
  draining: ManagedRun[] = [];
  session: SessionHost['session'] = null;
  sessionRefresh: Promise<void> | null = null;
  lastError = '';
  cooldownUntil = 0;
  /** 手动暂停开关（IProvider.pauseAccount）。暂停的池不参与选号。 */
  enabled = true;
  /** 连续失败计数（T203 §3.4 软冷却指数退避的输入）。 */
  consecutiveFailures = 0;
  /** 已成功 FINISH 的 run id：保证 created == finished（防 shutdown 与
   *  异步 finishIfReady 竞争导致重复 FINISH）。 */
  private readonly finishedRunIds = new Set<string>();

  constructor(
    readonly name: string,
    readonly token: string,
    readonly cfg: FreebuffConfig,
    readonly client: UpstreamClient,
  ) {}

  // ─── run_manager.go:248 acquire ────────────────────────────────────────────

  /** 冷却 + 轮换 + 预占 inflight；失败抛错（RunManager 据此尝试下一个池）。 */
  async acquire(agentId: string): Promise<RunLease> {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      throw new Error(`token cooling down until ${new Date(this.cooldownUntil).toISOString()}`);
    }
    const current = this.runs.get(agentId);
    const needsRotate = !current || now - current.startedAt >= this.cfg.rotationIntervalMs;
    if (needsRotate) {
      await this.rotateAgent(agentId);
    }

    await ensureSession(this);

    const run = this.runs.get(agentId);
    if (!run) throw new Error('run missing after rotation');
    run.inflight += 1;
    run.requestCount += 1;
    return { pool: this, run };
  }

  // ─── run_manager.go:280 maintain ───────────────────────────────────────────

  /** 周期保活：会话刷新 + 过期 run 轮换 + draining 收敛。 */
  async maintain(): Promise<void> {
    try {
      await ensureSession(this);
    } catch (err) {
      logger.warn(`${this.name}: refresh free session failed: ${messageOf(err)}`);
    }

    const now = Date.now();
    const toRotate: string[] = [];
    for (const [agentId, run] of this.runs) {
      if (now - run.startedAt >= this.cfg.rotationIntervalMs) toRotate.push(agentId);
    }
    const draining = [...this.draining];

    for (const agentId of toRotate) {
      try {
        await this.rotateAgent(agentId);
      } catch (err) {
        logger.warn(`${this.name}: rotate agent ${agentId} failed: ${messageOf(err)}`);
      }
    }
    for (const run of draining) {
      try {
        await this.finishIfReady(run);
      } catch (err) {
        logger.warn(`${this.name}: finish draining run ${run.id} failed: ${messageOf(err)}`);
      }
    }
  }

  // ─── run_manager.go:309 shutdown ───────────────────────────────────────────

  /** 关闭：FINISH 全部在册 run（current + draining），再结束上游会话。 */
  async shutdown(): Promise<void> {
    const allRuns = [...this.runs.values(), ...this.draining];
    this.runs = new Map();
    this.draining = [];

    const errors: string[] = [];
    for (const run of allRuns) {
      try {
        await this.finishRunOnce(run);
      } catch (err) {
        errors.push(messageOf(err));
      }
    }
    try {
      await endSession(this);
    } catch (err) {
      errors.push(messageOf(err));
    }
    if (errors.length > 0) {
      logger.warn(`${this.name}: shutdown reported errors: ${errors.join('; ')}`);
    }
  }

  // ─── run_manager.go:335 rotateAgent ────────────────────────────────────────

  /** START 一个新 run；旧 run 移入 draining 并异步收敛（finishIfReady）。 */
  async rotateAgent(agentId: string): Promise<void> {
    if (Date.now() < this.cooldownUntil) {
      throw new Error(`token cooling down until ${new Date(this.cooldownUntil).toISOString()}`);
    }

    let runId: string;
    try {
      runId = await this.client.startRun(this.token, agentId);
    } catch (err) {
      this.lastError = messageOf(err);
      throw err;
    }

    const oldRun = this.runs.get(agentId);
    this.runs.set(agentId, {
      id: runId,
      agentId,
      startedAt: Date.now(),
      inflight: 0,
      requestCount: 0,
      finishing: false,
    });
    this.lastError = '';
    if (oldRun) this.draining.push(oldRun);

    if (oldRun) {
      void this.finishIfReady(oldRun).catch((err) => {
        logger.warn(
          `${this.name}: finish rotated run ${oldRun.id} (agent ${oldRun.agentId}) failed: ${messageOf(err)}`,
        );
      });
    }
  }

  // ─── run_manager.go:375 release ────────────────────────────────────────────

  async release(run: ManagedRun | null | undefined): Promise<void> {
    if (!run) return;
    if (run.inflight > 0) run.inflight -= 1;
    try {
      await this.finishIfReady(run);
    } catch (err) {
      logger.warn(`${this.name}: finish released run ${run.id} failed: ${messageOf(err)}`);
    }
  }

  // ─── run_manager.go:391 finishIfReady ──────────────────────────────────────

  /**
   * 收敛一个 run：仅当它已不是当前 run、inflight 归零且未在收敛中时真正 FINISH。
   * 失败时复位 finishing 并记录 lastError（可被下次 maintain/ release 重试）。
   */
  async finishIfReady(run: ManagedRun | null | undefined): Promise<void> {
    if (!run || run.inflight > 0 || run.finishing) return;
    if (this.runs.get(run.agentId) === run) return; // 仍是当前 run

    run.finishing = true;
    try {
      await this.finishRunOnce(run);
    } catch (err) {
      run.finishing = false;
      this.lastError = messageOf(err);
      throw err;
    }
    this.draining = this.draining.filter((r) => r !== run);
  }

  /**
   * 幂等 FINISH：同一 run id 只发一次（shutdown 与异步 finishIfReady 竞争时的
   * 去重，保证 created == finished 不变式不被破坏）。
   */
  private async finishRunOnce(run: ManagedRun): Promise<void> {
    if (this.finishedRunIds.has(run.id)) return;
    await this.client.finishRun(this.token, run.id, run.requestCount);
    this.finishedRunIds.add(run.id);
  }

  // ─── run_manager.go:428 invalidate ─────────────────────────────────────────

  /**
   * 上游明确报告 run 失效（runid not found / not running）时摘除该 run。
   *
   * 与 Go 一致：**不发 FINISH**（run_manager.go:428-447）——此时上游已无对应
   * run，FINISH 必然失败；这是「created == finished」不变式的唯一有意例外，
   * 仅在上游主动失效路径触发（报告已登记）。
   */
  invalidate(run: ManagedRun | null | undefined, reason: string): void {
    if (!run) return;
    if (this.runs.get(run.agentId) === run) this.runs.delete(run.agentId);
    this.draining = this.draining.filter((r) => r !== run);
    if (reason) this.lastError = reason;
  }

  // ─── run_manager.go:449 markCooldown ───────────────────────────────────────

  markCooldown(durationMs: number, reason: string): void {
    if (durationMs <= 0) return;
    this.cooldownUntil = Date.now() + durationMs;
    if (reason) this.lastError = reason;
  }

  // ─── T203：连续失败 → 指数退避软冷却（§3.4 SOFT_COOL）──────────────────────

  /**
   * 记录一次失败并按 §3.4 施加指数退避软冷却（1→2→4→8→…→max 30min）。
   * 返回本次施加的冷却毫秒数（0 表示未冷却）。
   */
  noteFailure(reason: string, baseMs = SOFT_COOL_BASE_MS): number {
    this.consecutiveFailures += 1;
    const durationMs = softCooldownMs(this.consecutiveFailures, baseMs);
    this.cooldownUntil = Date.now() + durationMs;
    if (reason) this.lastError = reason;
    return durationMs;
  }

  /** 记录一次成功：清零连续失败计数（冷却仍按既有到期时间自然收敛）。 */
  noteSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** T203：账号级健康分级（面板/快照口径）。 */
  healthState(nowMs = Date.now()): 'PAUSED' | 'COOLING' | 'HEALTHY' {
    if (!this.enabled) return 'PAUSED';
    if (nowMs < this.cooldownUntil) return 'COOLING';
    return 'HEALTHY';
  }

  // ─── run_manager.go:461 snapshot ───────────────────────────────────────────

  snapshot(): TokenSnapshot {
    const snapshot: TokenSnapshot = {
      name: this.name,
      runs: [],
      drainingRuns: this.draining.length,
      cooldownUntil: this.cooldownUntil || undefined,
      lastError: this.lastError || undefined,
    };
    if (this.session) {
      snapshot.sessionStatus = this.session.status;
      snapshot.sessionInstanceId = this.session.instanceId || undefined;
      snapshot.sessionExpiresAt = this.session.expiresAt || undefined;
      snapshot.sessionPosition = this.session.position || undefined;
      snapshot.sessionQueueDepth = this.session.queueDepth || undefined;
      snapshot.sessionPollAt = this.session.pollAt || undefined;
    }
    for (const [agentId, run] of this.runs) {
      const runSnapshot: RunSnapshot = {
        agentId,
        runId: run.id,
        startedAt: run.startedAt,
        inflight: run.inflight,
        requestCount: run.requestCount,
      };
      snapshot.runs.push(runSnapshot);
    }
    return snapshot;
  }

  /** T203 扩展点：账号级健康度（当前只区分 cooling / paused / healthy）。 */
  isCoolingDown(nowMs = Date.now()): boolean {
    return nowMs < this.cooldownUntil;
  }
}

/** run_manager.go:14 RunManager。 */
export class RunManager {
  private readonly pools: TokenPool[];
  /** run_manager.go:18 next（Round-robin 起点游标）。 */
  private next = 0;
  private healthyTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /**
   * T203 选号策略注入点：返回本次尝试的**起点池下标**（后续仍按顺序环形遍历，
   * 保证"起点优先 + 失败顺延"）。返回非法值时回退 Round-robin 游标。
   * 不注入即默认 Round-robin（与 T201 行为字节一致）。
   */
  selector: PoolSelector | null = null;

  constructor(
    private readonly cfg: FreebuffConfig,
    private readonly client: UpstreamClient,
  ) {
    this.pools = cfg.tokens.map(
      (token, index) => new TokenPool(`token-${index + 1}`, token, cfg, client),
    );
  }

  /** 只读视图（T203 选号/账号池实现读取；外部不得改写数组结构）。 */
  poolsView(): readonly TokenPool[] {
    return this.pools;
  }

  // ─── run_manager.go:126 Start ──────────────────────────────────────────────

  /**
   * 后台预热 + 每分钟 maintain（Go run_manager.go:126）。
   * prewarm 刻意不阻塞：请求先到就懒建 run（acquire 兜底）。
   */
  start(agentIds: string[]): void {
    void this.prewarm(agentIds).catch((err) => {
      logger.warn(`freebuff prewarm failed: ${messageOf(err)}`);
    });
    this.healthyTimer = setInterval(() => {
      for (const pool of this.pools) {
        void pool.maintain().catch((err) => {
          logger.warn(`${pool.name}: maintenance failed: ${messageOf(err)}`);
        });
      }
    }, 60_000);
    this.healthyTimer.unref?.();
  }

  // ─── run_manager.go:155 prewarm ────────────────────────────────────────────

  /** 预热：每个池建好会话，并为每个 agent 预建 run（首个请求不等待建 Run）。 */
  async prewarm(agentIds: string[]): Promise<void> {
    for (const pool of this.pools) {
      if (this.closed) return; // destroy/close 后停止后续预热，避免悬挂请求
      try {
        await ensureSession(pool);
      } catch (err) {
        logger.warn(`${pool.name}: free session prewarm failed: ${messageOf(err)}`);
      }
      for (const agentId of agentIds) {
        if (this.closed) return;
        try {
          await pool.rotateAgent(agentId);
          logger.info(`${pool.name}: prewarmed ${agentId}`);
        } catch (err) {
          logger.warn(`${pool.name}: prewarm ${agentId} failed: ${messageOf(err)}`);
        }
      }
    }
  }

  // ─── run_manager.go:173 Close ──────────────────────────────────────────────

  async close(): Promise<void> {
    this.closed = true;
    if (this.healthyTimer) clearInterval(this.healthyTimer);
    this.healthyTimer = null;
    for (const pool of this.pools) {
      try {
        await pool.shutdown();
      } catch (err) {
        logger.warn(`${pool.name}: shutdown failed: ${messageOf(err)}`);
      }
    }
  }

  // ─── run_manager.go:183 Acquire ────────────────────────────────────────────

  /**
   * Round-robin 选池并预占租约。
   * 全部失败时：若每池都是等待室排队，返回「位置最优」的那个 WaitingRoomError；
   * 否则抛聚合错误。
   *
   * T203 扩展点：把 startIndex 的选择替换为配额感知调度器（保留本方法签名，
   * 注入 `selector?: (pools) => number` 即可，不影响调用方）。
   *
   * `preferredAccountId` 承接路由层的 `X-Upstream-Account`（ChatOptions.preferredAccountId）：
   * 指定账号只影响**起点**，仍走下方的既有兜底链——指定的池不可用时换下一个池，
   * 指定一个不存在的账号不会让请求直接失败。
   */
  async acquire(agentId: string, preferredAccountId?: string): Promise<RunLease> {
    if (this.pools.length === 0) {
      throw new Error('no auth tokens configured');
    }
    if (this.closed) {
      throw new Error('run manager is closed');
    }

    const startIndex = this.selectStartIndex(agentId, preferredAccountId);
    const errors: string[] = [];
    const waiting: WaitingRoomError[] = [];

    for (let offset = 0; offset < this.pools.length; offset++) {
      const pool = this.pools[(startIndex + offset) % this.pools.length];
      if (!pool.enabled) {
        errors.push(`${pool.name}: token paused`);
        continue;
      }
      try {
        return await pool.acquire(agentId);
      } catch (err) {
        if (err instanceof WaitingRoomError) waiting.push(err);
        errors.push(`${pool.name}: ${messageOf(err)}`);
      }
    }

    if (waiting.length === this.pools.length && waiting.length > 0) {
      let best = waiting[0];
      for (const candidate of waiting.slice(1)) {
        if (candidate.position > 0 && (best.position <= 0 || candidate.position < best.position)) {
          best = candidate;
        }
      }
      throw best;
    }

    throw new Error(`unable to acquire run from any token (${errors.join('; ')})`);
  }

  /**
   * 选号起点，优先级：指定账号 → 注入 selector → Round-robin 游标。
   *
   * 指定账号（X-Upstream-Account）命中且参与调度时直接用；未命中或已暂停时**告警并回退**——
   * 强制失败会把一个「想让请求走某个账号」的意图升级成一次请求失败，而回退至少保住可用性。
   * 回退原因必须留日志，否则「指定了却没生效」在排障时无迹可寻（与端口漂移同类的坑）。
   */
  private selectStartIndex(agentId: string, preferredAccountId?: string): number {
    if (preferredAccountId) {
      const index = this.pools.findIndex((pool) => pool.name === preferredAccountId);
      if (index < 0) {
        logger.warn(
          `freebuff preferred account "${preferredAccountId}" not found, falling back to round-robin`,
        );
      } else if (!this.pools[index].enabled) {
        logger.warn(
          `freebuff preferred account "${preferredAccountId}" is paused, falling back to round-robin`,
        );
      } else {
        return index;
      }
    }
    if (this.selector) {
      try {
        const index = this.selector(this.pools, agentId);
        if (Number.isInteger(index) && index >= 0 && index < this.pools.length) return index;
      } catch (err) {
        logger.warn(`freebuff pool selector failed, falling back to round-robin: ${messageOf(err)}`);
      }
    }
    return this.next++ % this.pools.length;
  }

  // ─── run_manager.go:219-246 Release / Invalidate / Cooldown / Snapshots ─────

  async release(lease: RunLease | null | undefined): Promise<void> {
    if (!lease?.pool || !lease.run) return;
    await lease.pool.release(lease.run);
  }

  invalidate(lease: RunLease | null | undefined, reason: string): void {
    if (!lease?.pool || !lease.run) return;
    lease.pool.invalidate(lease.run, reason);
  }

  cooldown(lease: RunLease | null | undefined, durationMs: number, reason: string): void {
    if (!lease?.pool) return;
    lease.pool.markCooldown(durationMs, reason);
  }

  snapshots(): TokenSnapshot[] {
    return this.pools.map((pool) => pool.snapshot());
  }

  // ─── T203 扩展点：动态账号（addAccount / removeAccount / pause / resume）────

  get poolCount(): number {
    return this.pools.length;
  }

  poolNames(): string[] {
    return this.pools.map((p) => p.name);
  }

  getPool(name: string): TokenPool | undefined {
    return this.pools.find((p) => p.name === name);
  }

  /** 动态新增账号（内存态；持久化凭据属 T203）。名称重复时抛错。 */
  addPool(token: string): TokenPool {
    const trimmed = String(token ?? '').trim();
    if (!trimmed) throw new Error('token is required');
    if (this.pools.some((p) => p.token === trimmed)) {
      throw new Error('token already registered');
    }
    let index = this.pools.length + 1;
    while (this.pools.some((p) => p.name === `token-${index}`)) index += 1;
    const pool = new TokenPool(`token-${index}`, trimmed, this.cfg, this.client);
    this.pools.push(pool);
    return pool;
  }

  /** 动态移除账号（幂等）。 */
  removePool(name: string): boolean {
    const index = this.pools.findIndex((p) => p.name === name);
    if (index < 0) return false;
    this.pools.splice(index, 1);
    return true;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * T203 选号策略签名：给定池列表与目标 agent，返回尝试起点下标。
 * 默认 Round-robin；配额感知/加权调度可在 T213 或后续任务注入。
 */
export type PoolSelector = (pools: readonly TokenPool[], agentId: string) => number;
