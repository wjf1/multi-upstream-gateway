// =============================================================================
// WorkBuddy OAuth 授权编排 + 令牌健康看护（T301）
// -----------------------------------------------------------------------------
// 联邦裁决（G0-T2 / §3.11-2）下，WorkBuddy 的**凭据持久化与选号**由 Go sidecar
// 承接；网关侧不持有、不落盘任何 access token / refresh token。本模块补齐的是
// sidecar 本身**没有**的两件事（Go 源码实测：无重试退避、无「待刷新」标记、
// 预刷窗口硬编码 10 分钟且未接入配置）：
//
//   1. `WorkBuddyOAuthClient` —— 面板内「添加账号」的授权编排：向 sidecar 原生
//      面板 API 发起授权（`POST /panel/api/login/start` 拿 authUrl + state），
//      再轮询 `GET /panel/api/login/poll?state=` 直到用户浏览器完成授权。这是
//      Go `internal/panel/login.go` 的既有两段式流程（state + authUrl + 轮询），
//      不是 RFC 8628 设备流（无 device_code / user_code / slow_down 语义）。
//      **本客户端永不接触 token**：poll 只取 uid / nickname / realm，上游返回的
//      accessToken / refreshToken 一律丢弃（凭据留在 sidecar 的加密 auths/ 内）。
//
//   2. `WorkBuddyTokenWatch` —— 令牌到期看护：按 sidecar `/status` 暴露的每号
//      `expiresAt` 计算「距过期 ≤ 1h」（T301 DoD 的 1 小时预刷窗口），到点触发
//      刷新；刷新失败按 **3 次指数退避重试**（1s → 2s → 4s），全部失败后将该号
//      标记为 **「待刷新」**（进入面板与 `/api/upstreams/workbuddy/tokens` 可见的
//      pendingRefresh 态，**非静默失效**）并向 Webhook 发一条告警。
//
// 端口/端点全部经依赖注入（fetch / sleep / now / triggerRefresh / notify），
// 测试不需要真的拉起 sidecar，也不需要真实时钟。
// =============================================================================
import { logger } from '../../utils/logger.js';

// ─── 授权编排（面板内添加账号）────────────────────────────────────────────────

/** sidecar 原生面板的授权端点（核自 workbuddy2api-panel/internal/panel/panel.go:157-159）。 */
export const WB_LOGIN_START_PATH = '/panel/api/login/start';
export const WB_LOGIN_POLL_PATH = '/panel/api/login/poll';

export type WorkBuddyRealm = 'cn' | 'global';

export interface LoginStartResult {
  /** 用户在浏览器打开的授权 URL（sidecar 签发）。 */
  url: string;
  /** 授权会话句柄，用于轮询。 */
  state: string;
  realm: WorkBuddyRealm;
}

export interface LoginPollResult {
  done: boolean;
  /** 未完成时的提示（如 "waiting for login"）。 */
  message?: string;
  uid?: string;
  nickname?: string;
  realm?: string;
  credits?: number;
}

/** 轮询超时（授权 URL 有效期由 sidecar 定为 15 分钟，网关侧留出同等窗口）。 */
export class WorkBuddyLoginTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`workbuddy login was not completed within ${timeoutMs}ms`);
    this.name = 'WorkBuddyLoginTimeoutError';
  }
}

export interface WorkBuddyOAuthClientDeps {
  /** sidecar base URL（如 `http://127.0.0.1:8787`）。 */
  baseUrl: string;
  /** sidecar Bearer 密钥（空 = 回环无鉴权部署）。 */
  apiKey?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 单次面板请求超时（默认 8s）。 */
  requestTimeoutMs?: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * sidecar 原生面板授权 API 的薄客户端。
 *
 * 契约边界：**只读账号身份，不读凭据**。上游 / poll 响应里的 `accessToken` /
 * `refreshToken` / `expiresIn` 一律不透出（返回值里根本没有这些字段），
 * 从类型层面杜绝 OAuth token 进入网关进程。
 */
export class WorkBuddyOAuthClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestTimeoutMs: number;

  constructor(deps: WorkBuddyOAuthClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, '');
    this.apiKey = deps.apiKey ?? '';
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 8_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /** 发起授权：拿 authUrl + state（面板展示 URL，用户浏览器完成）。 */
  async startLogin(realm: WorkBuddyRealm = 'cn'): Promise<LoginStartResult> {
    const res = await this.fetchFn(`${this.baseUrl}${WB_LOGIN_START_PATH}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ realm }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`workbuddy login/start failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const url = typeof body.url === 'string' ? body.url : '';
    const state = typeof body.state === 'string' ? body.state : '';
    if (!url || !state) {
      throw new Error('workbuddy login/start returned no auth url/state');
    }
    return { url, state, realm: body.realm === 'global' ? 'global' : realm };
  }

  /** 轮询一次授权结果（凭据字段被有意丢弃）。 */
  async pollLogin(state: string): Promise<LoginPollResult> {
    const res = await this.fetchFn(
      `${this.baseUrl}${WB_LOGIN_POLL_PATH}?state=${encodeURIComponent(state)}`,
      { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(this.requestTimeoutMs) },
    );
    if (res.status === 404) {
      throw new Error('workbuddy login state is unknown or expired; please restart the login flow');
    }
    if (!res.ok) {
      throw new Error(`workbuddy login/poll failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (body.done !== true) {
      return { done: false, message: typeof body.message === 'string' ? body.message : 'waiting for login' };
    }
    // 刻意只取身份字段：accessToken / refreshToken 永不进入网关进程。
    return {
      done: true,
      ...(typeof body.uid === 'string' ? { uid: body.uid } : {}),
      ...(typeof body.nickname === 'string' ? { nickname: body.nickname } : {}),
      ...(typeof body.realm === 'string' ? { realm: body.realm } : {}),
      ...(typeof body.credits === 'number' ? { credits: body.credits } : {}),
    };
  }

  /**
   * 轮询直到授权完成或超时（面板「添加账号」按钮的驱动循环）。
   * 默认 3s 间隔 / 15 分钟上限（与 sidecar 的 loginTTL 对齐）。
   */
  async waitForLogin(
    state: string,
    opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<LoginPollResult> {
    const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    const intervalMs = opts.intervalMs ?? 3_000;
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (opts.signal?.aborted) throw new WorkBuddyLoginTimeoutError(timeoutMs);
      const result = await this.pollLogin(state);
      if (result.done) return result;
      if (this.now() >= deadline) throw new WorkBuddyLoginTimeoutError(timeoutMs);
      await this.sleep(intervalMs);
    }
  }
}

// ─── 令牌健康看护（预刷窗口 / 指数退避 / 待刷新态 / 告警）─────────────────────

/** T301 DoD：过期前 1 小时自动预刷。 */
export const DEFAULT_PRE_REFRESH_WINDOW_MS = 3_600_000;
/** T301 DoD：刷新失败 3 次指数退避重试（1s → 2s → 4s）。 */
export const DEFAULT_REFRESH_MAX_RETRIES = 3;
export const DEFAULT_REFRESH_BASE_BACKOFF_MS = 1_000;

/** 「待刷新」标记的稳定代号（面板与告警共用）。 */
export const PENDING_REFRESH_CODE = 'PENDING_REFRESH';

export interface TokenWatchAccount {
  id: string;
  /** 绝对到期时刻（Unix 毫秒）；缺失时该号不参与预刷判定。 */
  expiresAt?: number;
}

export interface TokenWatchEntry {
  id: string;
  expiresAt?: number;
  /** 该号是否处于「待刷新」（连续刷新失败，需人工重新授权）。 */
  pendingRefresh: boolean;
  /** 最近一次刷新失败原因。 */
  lastError?: string;
  /** 最近一次刷新尝试次数（含首次）。 */
  attempts: number;
}

export interface RefreshOutcome {
  id: string;
  ok: boolean;
  attempts: number;
  error?: string;
  pendingRefresh: boolean;
}

export interface WorkBuddyTokenWatchDeps {
  /** 触发一次上游侧刷新（网关注入：打 sidecar 面板 API）。抛错 = 本次尝试失败。 */
  triggerRefresh: (uid: string) => Promise<void>;
  /** 告警出口（缺省用 webhook-alerts 的 notifyWebhook；注入便于测试断言）。 */
  notify?: (event: string, payload: Record<string, unknown>) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  preRefreshWindowMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
}

/**
 * 令牌到期看护。
 *
 * 生命周期：
 *   `sync(accounts)`（每次池快照刷新）→ `due()`（距过期 ≤ 1h 且未处于待刷新）
 *   → `refresh(uid)`（3 次指数退避）→ 成功清除待刷新 / 失败标记待刷新 + 告警。
 *
 * 刻意与 sidecar 的既有行为互补而非重复：sidecar 每请求前按 10 分钟窗口懒刷新、
 * 每日 22:00 无条件 keepalive；本看护把窗口前移到 **1 小时**，并在**连续失败**时
 * 把「静默失效」变成**显式的待刷新态 + 告警**（这是 Go 侧缺的那一环）。
 */
export class WorkBuddyTokenWatch {
  private readonly triggerRefresh: (uid: string) => Promise<void>;
  private readonly notify: (event: string, payload: Record<string, unknown>) => Promise<boolean>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly preRefreshWindowMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  private entries = new Map<string, TokenWatchEntry>();
  /** 已就「进入待刷新」告警过的 uid，避免每 tick 重复轰炸。 */
  private alerted = new Set<string>();

  constructor(deps: WorkBuddyTokenWatchDeps) {
    this.triggerRefresh = deps.triggerRefresh;
    this.notify = deps.notify ?? (async () => false);
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.preRefreshWindowMs = deps.preRefreshWindowMs ?? DEFAULT_PRE_REFRESH_WINDOW_MS;
    this.maxRetries = deps.maxRetries ?? DEFAULT_REFRESH_MAX_RETRIES;
    this.baseBackoffMs = deps.baseBackoffMs ?? DEFAULT_REFRESH_BASE_BACKOFF_MS;
  }

  /** 用最新池快照对齐账号集合（保留已存在的待刷新标记）。 */
  sync(accounts: TokenWatchAccount[]): void {
    const seen = new Set<string>();
    for (const a of accounts) {
      const id = String(a.id ?? '').trim();
      if (!id) continue;
      seen.add(id);
      const prev = this.entries.get(id);
      this.entries.set(id, {
        id,
        ...(typeof a.expiresAt === 'number' && Number.isFinite(a.expiresAt) ? { expiresAt: a.expiresAt } : {}),
        pendingRefresh: prev?.pendingRefresh ?? false,
        ...(prev?.lastError ? { lastError: prev.lastError } : {}),
        attempts: prev?.attempts ?? 0,
      });
    }
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) {
        this.entries.delete(id);
        this.alerted.delete(id);
      }
    }
  }

  /** 是否进入预刷窗口（`expiresAt` 缺失时恒 false：未知不等于"要过期"）。 */
  needsRefresh(expiresAt: number | undefined, now = this.now()): boolean {
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
    return expiresAt - now <= this.preRefreshWindowMs;
  }

  /** 当前应触发预刷的账号（进入窗口且未处于待刷新）。 */
  due(now = this.now()): TokenWatchEntry[] {
    return [...this.entries.values()].filter((e) => !e.pendingRefresh && this.needsRefresh(e.expiresAt, now));
  }

  /** 「待刷新」账号集合（面板徽章与 /api 出口）。 */
  pendingRefreshIds(): string[] {
    return [...this.entries.values()].filter((e) => e.pendingRefresh).map((e) => e.id);
  }

  snapshot(): TokenWatchEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  /** 预刷窗口（毫秒）；面板与 `/api` 出口展示用，避免调用方硬编码常量。 */
  get windowMs(): number {
    return this.preRefreshWindowMs;
  }

  /** 失败重试上限（首次之外的重试次数）。 */
  get retryLimit(): number {
    return this.maxRetries;
  }

  /**
   * 刷新单个账号：首次 + 最多 `maxRetries` 次重试，间隔 `baseBackoffMs * 2^n`
   * （默认 1s / 2s / 4s）。全部失败 → 标记「待刷新」并告警一次。
   */
  async refresh(uid: string): Promise<RefreshOutcome> {
    const entry = this.entries.get(uid);
    const attemptsAllowed = this.maxRetries + 1;
    let attempts = 0;
    let lastError: string | undefined;

    for (let i = 0; i < attemptsAllowed; i += 1) {
      attempts += 1;
      try {
        await this.triggerRefresh(uid);
        if (entry) {
          entry.pendingRefresh = false;
          entry.attempts = attempts;
          delete entry.lastError;
          // 到期时刻未知（sidecar 会在成功后回写），保守置为窗口外以避免同 tick 反复触发。
          entry.expiresAt = this.now() + this.preRefreshWindowMs * 2;
        }
        this.alerted.delete(uid);
        logger.info(`[PVD:workbuddy] token refresh ok for ${uid} (attempts=${attempts})`);
        return { id: uid, ok: true, attempts, pendingRefresh: false };
      } catch (err) {
        lastError = messageOf(err);
        logger.warn(`[PVD:workbuddy] token refresh attempt ${attempts} failed for ${uid}: ${lastError}`);
        if (i < attemptsAllowed - 1) {
          await this.sleep(this.baseBackoffMs * 2 ** i);
        }
      }
    }

    if (entry) {
      entry.pendingRefresh = true;
      entry.attempts = attempts;
      entry.lastError = lastError;
    }
    await this.alertPending(uid, attempts, lastError);
    return { id: uid, ok: false, attempts, error: lastError, pendingRefresh: true };
  }

  /** 一轮看护：对所有 due 账号触发预刷。返回本轮结果（供测试与日志）。 */
  async runTick(now = this.now()): Promise<RefreshOutcome[]> {
    const due = this.due(now);
    const out: RefreshOutcome[] = [];
    for (const entry of due) {
      out.push(await this.refresh(entry.id));
    }
    return out;
  }

  /** 「待刷新」告警（Webhook + 面板态）；每个 uid 的每次进入只发一次。 */
  private async alertPending(uid: string, attempts: number, error?: string): Promise<void> {
    if (this.alerted.has(uid)) return;
    this.alerted.add(uid);
    logger.error(
      `[PVD:workbuddy] account ${uid} marked ${PENDING_REFRESH_CODE} after ${attempts} refresh attempts: ${error ?? 'unknown error'}`,
    );
    try {
      await this.notify('workbuddy-token-refresh-failed', {
        uid,
        attempts,
        error: error ?? 'unknown error',
        status: PENDING_REFRESH_CODE,
        summary: `WorkBuddy 账号 ${uid} 刷新 ${attempts} 次仍失败，已标记「待刷新」，请重新授权`,
      });
    } catch (err) {
      // 旁路通知失败绝不外泄（与本卡之外的 webhook 告警同约束）。
      logger.warn(`[PVD:workbuddy] pending-refresh alert failed: ${messageOf(err)}`);
    }
  }
}

// ─── 纯函数 ───────────────────────────────────────────────────────────────────

/**
 * 从 sidecar `/status` 的账号条目解析绝对到期时刻（毫秒）。
 *
 * 容忍 sidecar 演进与三种常见口径：
 *   - `expiresAt` / `tokenExpiresAt` / `expires_at`：绝对值；< 1e12 视为 Unix 秒；
 *   - `expiresIn` / `expires_in`：相对秒数（以 `now` 起算）。
 * 全部缺失或非法 → `undefined`（该号不参与预刷判定，未知不等于"已过期"）。
 */
export function parseTokenExpiry(account: Record<string, unknown>, now: number = Date.now()): number | undefined {
  const abs = account.expiresAt ?? account.tokenExpiresAt ?? account.expires_at;
  if (typeof abs === 'number' && Number.isFinite(abs) && abs > 0) {
    return abs < 1e12 ? Math.round(abs * 1000) : abs;
  }
  if (typeof abs === 'string' && abs.trim() !== '') {
    const n = Number(abs);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : n;
  }
  const rel = account.expiresIn ?? account.expires_in;
  if (typeof rel === 'number' && Number.isFinite(rel) && rel > 0) {
    return now + Math.round(rel * 1000);
  }
  return undefined;
}
