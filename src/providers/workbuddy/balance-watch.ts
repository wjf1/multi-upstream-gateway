// =============================================================================
// WorkBuddy 余额镜像与池状态持久化（T302，master-plan v1.2 §3.4）
// -----------------------------------------------------------------------------
// 职责边界（联邦裁决 G0-T2）：**sidecar 自己才是刷新的执行者**，网关侧不主动登录
// 上游、不持凭据，只做两件事：
//   1. **只读镜像**：把 `/status` 里的积分快照收敛成本地账本；
//   2. **原子持久化**：经 `JsonStateStore`（临时文件 + rename，见 utils/state-store.ts）
//      落盘 —— 任何时刻磁盘上要么是旧内容要么是新内容，不存在半截文件，这是
//      DoD「kill -9 后重启状态一致」成立的前提。
//
// 5 分钟节流：`observe()` 由 provider 的 `refreshPool()` 驱动（T303 探活每 30s 一轮），
// 内存每次都更新，**落盘按 `intervalMs`（默认 5min）节流** —— 不新增常驻定时器
// （Bash 硬约束：不为后台轮询加进程）。
//
// 损坏重建（DoD「损坏文件恢复测试」）：state.json 不可解析时 `JsonStateStore` 只如实
// 返回 `corrupted` 且**不写盘**（避免用空状态覆盖尚可抢救的原文件）。本模块拿到该结论后
// 告警 + `refresh({ force: true })` 从 sidecar 强制重建——**权威源是 sidecar**。
// 与 §3.4 字面写法（「从 usage 记录重建」）的偏差在此登记：usage 记录里 WorkBuddy 只有
// 消费侧的原生量（`native.points`，见 provider.extractUsage），反推不出剩余余额，
// 拿它当重建源会写出**看似成功实则错误**的账本；sidecar 才是余额的真正持有者。
// sidecar 也不可用时：保持空基线 + 标记 `degraded`，并保证损坏文件不落新盘。
// =============================================================================
import { logger } from '../../utils/logger.js';
import {
  AsyncMutex,
  JsonStateStore,
  resolveConfiguredStatePath,
  type LoadOutcome,
  type ParseResult,
} from '../../utils/state-store.js';

/** 当前 state.json 的 schema 版本；不认识版本一律按损坏处理（走重建）。 */
export const BALANCE_STATE_VERSION = 1;

/** 默认刷新间隔：5 分钟（§3.4）。 */
export const DEFAULT_BALANCE_INTERVAL_MS = 5 * 60 * 1000;

/** 单个账号的积分镜像条目。字段缺失一律为 `undefined`（未知 ≠ 0）。 */
export interface BalanceEntry {
  uid: string;
  nickname?: string;
  /** 剩余可用积分。 */
  credits?: number;
  /** 本周期总额度（用于「已用 x / 共 y」展示）。 */
  creditsTotal?: number;
  /** 即将过期/本周期内将失效的积分。 */
  creditsExpiring?: number;
  /** 最早一批积分的过期时刻（Unix 毫秒）。 */
  earliestExpiry?: number;
  /** 最早过期那批积分的剩余可用量。 */
  earliestRemaining?: number;
  /** 池状态（「池状态持久化」的落点）：暂停 / 停用 / 冷却中。 */
  paused: boolean;
  disabled: boolean;
  cooling: boolean;
  /** 本条目采样时刻（Unix 毫秒）。 */
  sampledAt: number;
}

/** 落盘的状态文件结构。 */
export interface BalanceState {
  version: number;
  /** 最近一次**成功落盘**的采样时刻（Unix 毫秒）；0 = 从未成功。 */
  refreshedAt: number;
  /** sidecar 连续不可用次数，成功一次即清零。 */
  consecutiveFailures: number;
  accounts: Record<string, BalanceEntry>;
}

export type BalanceAlertKind = 'state-corrupted' | 'state-rebuilt' | 'refresh-failed' | 'refresh-recovered';

export interface BalanceAlert {
  kind: BalanceAlertKind;
  message: string;
  at: number;
  detail?: Record<string, unknown>;
}

/** 只读视图（面板 / `GET /api/upstreams/workbuddy/balance` 的数据源）。 */
export interface BalanceSnapshot {
  filePath: string;
  /** 最近一次成功采样（内存侧，Unix 毫秒）。 */
  refreshedAt: number;
  /** 最近一次成功落盘（磁盘侧，Unix 毫秒）。 */
  persistedAt: number;
  intervalMs: number;
  /** 下次允许落盘的时刻（Unix 毫秒）。 */
  nextRefreshAt: number;
  consecutiveFailures: number;
  /** true = 镜像不可信（从未刷新成功 / 连续失败 / 损坏未重建）。 */
  degraded: boolean;
  degradedReason?: string;
  accounts: BalanceEntry[];
}

export interface BalanceTickResult {
  /** 本次是否取得了可信快照。 */
  ok: boolean;
  /** 本次是否发生落盘。 */
  persisted: boolean;
  /** true = 未到刷新窗口且非 force，什么都没做。 */
  skipped: boolean;
  reason?: string;
  accounts: number;
  refreshedAt: number;
  consecutiveFailures: number;
}

export interface WorkBuddyBalanceWatchOptions {
  /** 默认落点：`resolveConfiguredStatePath()`（`COMMANDCODE_STATE_PATH` > config > data/state.json）。 */
  store?: JsonStateStore<BalanceState>;
  /** 注入临时路径（测试）；等价于 store 的 filePath。 */
  filePath?: string;
  intervalMs?: number;
  now?: () => number;
  /** 告警出口（损坏 / 重建 / 失败 / 恢复）；provider 侧接 Webhook。 */
  onAlert?: (alert: BalanceAlert) => void;
  /** 主动拉取 `/status`（仅损坏重建与手动刷新用到；主路径由 `observe` 喂快照）。 */
  fetchStatus?: () => Promise<Record<string, unknown> | null>;
}

export function emptyBalanceState(): BalanceState {
  return { version: BALANCE_STATE_VERSION, refreshedAt: 0, consecutiveFailures: 0, accounts: {} };
}

/**
 * state.json schema 校验。
 *
 * 条目级损坏**只丢弃该条目**并计数，不让整份文件作废——部分可抢救时优先抢救；
 * 结构性损坏（不是对象 / 版本不认识 / `accounts` 不是对象）才判 corrupted 走重建。
 */
export function parseBalanceState(raw: unknown): ParseResult<BalanceState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'state must be a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== BALANCE_STATE_VERSION) {
    return { ok: false, error: `unsupported state version: ${String(o.version)}` };
  }
  const rawAccounts = o.accounts;
  if (rawAccounts !== undefined && (typeof rawAccounts !== 'object' || rawAccounts === null || Array.isArray(rawAccounts))) {
    return { ok: false, error: 'accounts must be an object map' };
  }

  const accounts: Record<string, BalanceEntry> = {};
  for (const [uid, value] of Object.entries((rawAccounts ?? {}) as Record<string, unknown>)) {
    const entry = parseBalanceEntry(uid, value);
    if (entry) accounts[uid] = entry;
  }

  return {
    ok: true,
    value: {
      version: BALANCE_STATE_VERSION,
      refreshedAt: num(o.refreshedAt) ?? 0,
      consecutiveFailures: num(o.consecutiveFailures) ?? 0,
      accounts,
    },
  };
}

/** 单条目校验：uid 必须非空且各数值字段要么缺失要么是有限数。 */
function parseBalanceEntry(uid: string, value: unknown): BalanceEntry | null {
  if (!uid.trim() || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const entry: BalanceEntry = {
    uid,
    paused: v.paused === true,
    disabled: v.disabled === true,
    cooling: v.cooling === true,
    sampledAt: num(v.sampledAt) ?? 0,
  };
  const nickname = str(v.nickname);
  if (nickname !== undefined) entry.nickname = nickname;
  for (const key of ['credits', 'creditsTotal', 'creditsExpiring', 'earliestExpiry', 'earliestRemaining'] as const) {
    const n = num(v[key]);
    if (n !== undefined) entry[key] = n;
  }
  return entry;
}

/**
 * 从一次 `/status` 响应抽取余额镜像。
 *
 * 字段名容忍多种别名（与 `parseTokenExpiry` 同风格）——sidecar 是 Go 侧独立演进
 * 的产物，字段更名不应让我们把「有余额」读成「没有余额」。**全部缺失即 `undefined`**
 * （未知 ≠ 0，避免面板把「读不到」显示成「已用尽」）。
 */
export function mapBalanceEntries(status: Record<string, unknown>, sampledAt: number = Date.now()): BalanceEntry[] {
  const rawAccounts = Array.isArray(status.accounts) ? (status.accounts as Array<Record<string, unknown>>) : [];
  const out: BalanceEntry[] = [];
  for (const a of rawAccounts) {
    const uid = String(a.uid ?? a.id ?? '').trim();
    if (!uid) continue;
    const entry: BalanceEntry = {
      uid,
      paused: a.paused === true,
      disabled: a.disabled === true,
      cooling: a.cooling === true,
      sampledAt,
    };
    const nickname = str(a.nickname) ?? str(a.label);
    if (nickname !== undefined) entry.nickname = nickname;

    const credits = firstNumber(a, ['credits', 'points', 'balance', 'creditsRemaining', 'credits_remaining', 'remaining']);
    if (credits !== undefined) entry.credits = credits;
    const creditsTotal = firstNumber(a, ['creditsTotal', 'credits_total', 'totalCredits', 'total_credits']);
    if (creditsTotal !== undefined) entry.creditsTotal = creditsTotal;
    const creditsExpiring = firstNumber(a, ['creditsExpiring', 'credits_expiring', 'expiringCredits', 'expiring_credits']);
    if (creditsExpiring !== undefined) entry.creditsExpiring = creditsExpiring;

    // 到期时刻复用 token 到期的同一套识别（Unix 秒 <1e12 视为秒 → ×1000）。
    const earliestExpiry = firstNumber(a, [
      'creditsEarliestExpiry',
      'credits_earliest_expiry',
      'earliestExpiry',
      'earliest_expiry',
      'creditsExpireAt',
      'credits_expire_at',
      'credits_expires_at',
    ]);
    if (earliestExpiry !== undefined) entry.earliestExpiry = normalizeEpoch(earliestExpiry);
    const earliestRemaining = firstNumber(a, [
      'creditsEarliestRemaining',
      'credits_earliest_remaining',
      'earliestRemaining',
      'earliest_remaining',
    ]);
    if (earliestRemaining !== undefined) entry.earliestRemaining = earliestRemaining;

    out.push(entry);
  }
  return out;
}

/**
 * 余额镜像与池状态持久化（T302）。
 *
 * 并发模型：`observe`/`refresh` 共用一个 `AsyncMutex`，落在临界区内的只有**纯内存
 * 状态计算**；fetch 与落盘全部在锁外（§3.4「锁内禁止 IO」）。
 */
export class WorkBuddyBalanceWatch {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onAlert: (alert: BalanceAlert) => void;
  private readonly fetchStatus: (() => Promise<Record<string, unknown> | null>) | null;
  private readonly injectedStore: JsonStateStore<BalanceState> | null;
  private readonly explicitFilePath: string | undefined;
  private readonly mutex = new AsyncMutex();

  private store: JsonStateStore<BalanceState> | null = null;
  private loadOutcome: LoadOutcome<BalanceState> | null = null;
  /** 损坏未重建：镜像不可信，且禁止用空状态覆盖原文件。 */
  private pendingRebuild = false;
  private lastSampleAt = 0;
  private lastPersistAt = 0;
  private failures = 0;
  private accounts: BalanceEntry[] = [];

  constructor(opts: WorkBuddyBalanceWatchOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_BALANCE_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.onAlert = opts.onAlert ?? (() => undefined);
    this.fetchStatus = opts.fetchStatus ?? null;
    this.injectedStore = opts.store ?? null;
    this.explicitFilePath = opts.filePath;
  }

  /**
   * 载入持久化状态。首次运行（文件缺失）建空基线并落盘；文件损坏时**不写盘**，
   * 只告警并把镜像标记为 degraded，等调用方 `refresh({ force: true })` 重建。
   */
  async initialize(): Promise<LoadOutcome<BalanceState>> {
    const store = await this.ensureStore();
    const outcome = await store.initialize();
    this.loadOutcome = outcome;

    if (outcome.status === 'loaded') {
      const state = store.getState();
      this.accounts = Object.values(state.accounts);
      this.failures = state.consecutiveFailures;
      this.lastPersistAt = state.refreshedAt;
      this.lastSampleAt = state.refreshedAt;
      this.pendingRebuild = false;
      return outcome;
    }

    if (outcome.status === 'corrupted') {
      // 关键：这里**不落盘**（store.initialize 已保证），保留原文件供人工抢救。
      this.pendingRebuild = true;
      this.emit('state-corrupted', `余额状态文件损坏，等待从 sidecar 重建：${outcome.reason}`, {
        filePath: store.filePath,
        reason: outcome.reason,
      });
      return outcome;
    }

    // missing：首次运行，落空基线（store.initialize 已写盘）。
    this.lastPersistAt = store.getState().refreshedAt;
    return outcome;
  }

  /**
   * 用一次已取得的 `/status` 快照推进镜像。**主路径**（`refreshPool()` 调它，零额外 IO）。
   *
   * `status === null`（sidecar 不可用）按失败处理：计数 + 首次失败告警；**不动账本**，
   * 避免把「读不到」写成「余额清零」。
   */
  async observe(status: Record<string, unknown> | null, opts: { force?: boolean } = {}): Promise<BalanceTickResult> {
    const store = await this.ensureStore();
    const now = this.now();

    if (status === null) {
      const failures = await this.mutex.runExclusive(() => {
        this.failures += 1;
        return this.failures;
      });
      if (failures === 1) {
        this.emit('refresh-failed', 'WorkBuddy 余额刷新失败：sidecar /status 不可用（镜像转为降级，保留上次已知余额）', {
          consecutiveFailures: failures,
        });
      }
      // 失败次数只在真正落盘时随状态一起持久化——窗口内失败不写盘，减少无谓 IO。
      const persisted = await this.persistIfDue(store, opts.force === true);
      return {
        ok: false,
        persisted,
        skipped: false,
        reason: 'sidecar status unavailable',
        accounts: this.accounts.length,
        refreshedAt: this.lastSampleAt,
        consecutiveFailures: this.failures,
      };
    }

    const entries = mapBalanceEntries(status, now);
    let recovered = 0;
    await this.mutex.runExclusive(() => {
      this.accounts = entries;
      this.lastSampleAt = now;
      recovered = this.failures;
      this.failures = 0;
      this.pendingRebuild = false;
    });
    if (recovered > 0) {
      this.emit('refresh-recovered', `WorkBuddy 余额镜像恢复（此前连续失败 ${recovered} 次）`, {
        consecutiveFailures: recovered,
        accounts: entries.length,
      });
    }

    const persisted = await this.persistIfDue(store, opts.force === true);
    return {
      ok: true,
      persisted,
      skipped: false,
      accounts: entries.length,
      refreshedAt: this.lastSampleAt,
      consecutiveFailures: 0,
    };
  }

  /**
   * 主动拉一次 `/status` 再 `observe`（损坏重建与手动刷新用）。
   * `force` 默认 true —— 本方法的语义就是「现在就刷，不等窗口」。
   */
  async refresh(opts: { force?: boolean } = {}): Promise<BalanceTickResult> {
    const force = opts.force !== false;
    if (!this.fetchStatus) {
      return {
        ok: false,
        persisted: false,
        skipped: true,
        reason: 'no fetchStatus provided',
        accounts: this.accounts.length,
        refreshedAt: this.lastSampleAt,
        consecutiveFailures: this.failures,
      };
    }
    const status = await this.fetchStatus();
    const rebuilt = this.pendingRebuild && status !== null;
    const result = await this.observe(status, { force });
    if (rebuilt) {
      this.emit('state-rebuilt', 'WorkBuddy 余额状态已从 sidecar 重建', {
        filePath: this.store?.filePath,
        accounts: result.accounts,
      });
    }
    return result;
  }

  /** 只读视图。 */
  snapshot(): BalanceSnapshot {
    const state = this.store?.getState();
    const persistedAt = state?.refreshedAt ?? 0;
    const degradedReason = this.pendingRebuild
      ? this.loadOutcome?.status === 'corrupted'
        ? `state.json 损坏待重建：${this.loadOutcome.reason}`
        : 'state.json 损坏待重建'
      : this.failures > 0
        ? `sidecar /status 连续不可用 ${this.failures} 次`
        : this.lastSampleAt === 0
          ? '尚未完成首次刷新'
          : undefined;
    return {
      filePath: this.store?.filePath ?? '',
      refreshedAt: this.lastSampleAt,
      persistedAt,
      intervalMs: this.intervalMs,
      nextRefreshAt: this.nextPersistDueAt(),
      consecutiveFailures: this.failures,
      degraded: degradedReason !== undefined,
      ...(degradedReason !== undefined ? { degradedReason } : {}),
      accounts: this.accounts.map((a) => ({ ...a })),
    };
  }

  /** 等待排队中的落盘结束（destroy 前调用）。 */
  async drain(): Promise<void> {
    if (this.store) await this.store.drain();
  }

  // ─── 内部 ──────────────────────────────────────────────────────────────────

  private async ensureStore(): Promise<JsonStateStore<BalanceState>> {
    if (this.store) return this.store;
    if (this.injectedStore) {
      this.store = this.injectedStore;
      return this.store;
    }
    const filePath = await resolveConfiguredStatePath(this.explicitFilePath);
    this.store = new JsonStateStore<BalanceState>({
      filePath,
      initial: emptyBalanceState,
      parse: parseBalanceState,
    });
    return this.store;
  }

  private nextPersistDueAt(): number {
    return this.lastPersistAt === 0 ? 0 : this.lastPersistAt + this.intervalMs;
  }

  /** 落盘窗口判定：`force` 或距上次落盘已满 `intervalMs`。 */
  private async persistIfDue(store: JsonStateStore<BalanceState>, force: boolean): Promise<boolean> {
    const now = this.now();
    if (!force && this.lastPersistAt !== 0 && now - this.lastPersistAt < this.intervalMs) return false;

    // 损坏未重建时禁止落盘：写入会覆盖掉尚可抢救的原文件（DoD「损坏恢复」的反面）。
    if (this.pendingRebuild) return false;

    const accounts = this.accounts;
    const sampleAt = this.lastSampleAt;
    const failures = this.failures;
    // 临界区只做内存替换，落盘由 store 在锁外串行排队（§3.4）。
    await store.mutate(() => ({
      version: BALANCE_STATE_VERSION,
      refreshedAt: sampleAt,
      consecutiveFailures: failures,
      accounts: Object.fromEntries(accounts.map((a) => [a.uid, a] satisfies [string, BalanceEntry])),
    }));
    // 落盘后才推进窗口（落盘失败时异常上抛，窗口不推进 → 下一轮重试）。
    this.lastPersistAt = sampleAt;
    return true;
  }

  private emit(kind: BalanceAlertKind, message: string, detail?: Record<string, unknown>): void {
    logger.warn(`[BALANCE] ${kind}: ${message}`);
    try {
      this.onAlert({ kind, message, at: this.now(), ...(detail !== undefined ? { detail } : {}) });
    } catch (err) {
      logger.warn(`[BALANCE] alert sink failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── 纯函数工具 ───────────────────────────────────────────────────────────────

/** 按别名顺序取第一个有限数；全缺失返回 undefined。 */
function firstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const n = num(obj[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Unix 秒（<1e12）→ 毫秒；已是毫秒则原样返回。 */
function normalizeEpoch(value: number): number {
  return value > 0 && value < 1e12 ? value * 1000 : value;
}
