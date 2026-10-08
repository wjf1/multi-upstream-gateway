// =============================================================================
// WorkBuddy Provider —— 联邦透传薄壳（T204'/T205'，联邦路线 3.11-2/3）
// -----------------------------------------------------------------------------
// 联邦裁决（G0-T2）下，WorkBuddy 的选号骨架、四维冷却/熔断状态机、payload 改写
// 管线由 Go sidecar 内置承接；本 Provider **不做任何选号与改写**，只做：
//   - `chatCompletion`：向 `{baseUrl}/v1/chat/completions` 透传（流式直接 yield
//     文本增量），保证 `conversation_id` 原样透传（T207' 的网关侧唯一职责）；
//   - `listModels`：读 sidecar `/v1/models` 映射（命名空间前缀由路由层加）；
//   - 账号管理**委托**：`listAccounts` 读 `/status`，`pause/resume/remove` 打
//     sidecar 面板 API（`/panel/api/accounts/{uid}/{pause|resume|remove}`，T205'）；
//   - `probe`：真实 `GET /healthz` 往返（禁止恒真，T303 依赖）。
//
// T301：账号授权编排与令牌看护由 `./oauth.ts` 承接——`loginStart`/`loginPoll` 驱动
// sidecar 原生面板的两段式授权（面板内「添加账号」），`WorkBuddyTokenWatch` 按
// sidecar `/status` 的 `expiresAt` 做 1 小时预刷 + 3 次指数退避 + 「待刷新」态 + 告警。
// 网关侧**永不持有 OAuth token**（凭据落在 sidecar 的加密 auths/ 内）。
//
// 边界：`addAccount`（程序化直接写入凭据）仍不支持并抛出可执行提示——联邦下凭据
// 由 sidecar 独占，网关只提供授权编排入口；`rewriteMode` 总开关保留，仅控制透传前
// 的清洗层（'full' 追加会话头与模型名规范化；'passthrough' 原样透传，一键回退）。
//
// sidecar 端点为 Go 源码实测口径：GET /healthz（无鉴权）、GET /status、GET /v1/models、
// POST /v1/chat/completions、POST /panel/api/accounts/{uid}/{pause|resume|remove}（均 Bearer）。
// =============================================================================
import type { AccountInfo, ModelItem, OpenAIChatRequest } from '../../types/index.js';
import type {
  ChatOptions,
  IProvider,
  OpenAIModel,
  ProbeResult,
  ProviderHealth,
  ProviderName,
  UsageSnapshot,
} from '../core/interface.js';
import { logger } from '../../utils/logger.js';
import { ErrorCode, ProxyError, codeForStatus, toProxyError } from '../../utils/errors.js';
import {
  WorkBuddySidecar,
  type SidecarStatus,
  type WorkBuddySidecarOptions,
} from './sidecar.js';
import {
  WorkBuddyOAuthClient,
  WorkBuddyTokenWatch,
  parseTokenExpiry,
  type LoginPollResult,
  type LoginStartResult,
  type RefreshOutcome,
  type TokenWatchEntry,
  type WorkBuddyRealm,
} from './oauth.js';
import { notifyWebhook } from '../../utils/webhook-alerts.js';
import {
  WorkBuddyBalanceWatch,
  type BalanceSnapshot,
} from './balance-watch.js';

const PROVIDER_NAME: ProviderName = 'workbuddy';
const DEFAULT_SIDECAR_PORT = 8787;
const ERROR_TEXT_LIMIT = 600;

/** 环境变量名（凭据与二进制路径都不落 config.json，§3.7-2）。 */
export const WORKBUDDY_SIDECAR_BIN_ENV = 'WORKBUDDY_SIDECAR_BIN';
export const WORKBUDDY_SIDECAR_PORT_ENV = 'WORKBUDDY_SIDECAR_PORT';
export const WORKBUDDY_SIDECAR_KEY_ENV = 'WORKBUDDY_SIDECAR_KEY';
export const WORKBUDDY_AUTH_DIR_ENV = 'WORKBUDDY_AUTH_DIR';

export interface WorkBuddyConfig {
  enabled: boolean;
  authDir?: string;
  rewriteMode: 'full' | 'passthrough';
  pointsPerUsdRate: number | null;
  sidecar: { binPath?: string; port: number };
  /** sidecar Bearer 密钥（空 = sidecar 不鉴权，回环部署默认）。 */
  apiKey: string;
}

/** sidecar `/status` 的池快照（只留住我们消费的字段）。 */
interface PoolSnapshot {
  total: number;
  healthy: number;
  cooling: number;
  disabled: number;
  accounts: Array<{
    id: string;
    label?: string;
    paused: boolean;
    disabled: boolean;
    cooling: boolean;
    /** T301：绝对到期时刻（Unix 毫秒），用于 1 小时预刷窗口判定。 */
    expiresAt?: number;
  }>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, limit = ERROR_TEXT_LIMIT): string {
  const t = text.trim();
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

function resolveWorkBuddyConfig(raw: unknown, env: NodeJS.ProcessEnv): WorkBuddyConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const sidecar = (o.sidecar ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

  const binPath =
    (typeof sidecar.binPath === 'string' && sidecar.binPath.trim() !== '' ? sidecar.binPath.trim() : undefined) ??
    (env[WORKBUDDY_SIDECAR_BIN_ENV]?.trim() || undefined);
  const portFromEnv = Number.parseInt(env[WORKBUDDY_SIDECAR_PORT_ENV] ?? '', 10);
  const port =
    num(sidecar.port) ??
    (Number.isFinite(portFromEnv) && portFromEnv > 0 ? portFromEnv : DEFAULT_SIDECAR_PORT);

  return {
    enabled: o.enabled !== false,
    authDir:
      (typeof o.authDir === 'string' && o.authDir.trim() !== '' ? o.authDir.trim() : undefined) ??
      (env[WORKBUDDY_AUTH_DIR_ENV]?.trim() || undefined),
    rewriteMode: o.rewriteMode === 'passthrough' ? 'passthrough' : 'full',
    pointsPerUsdRate: typeof o.pointsPerUsdRate === 'number' ? o.pointsPerUsdRate : null,
    sidecar: { binPath, port },
    apiKey: env[WORKBUDDY_SIDECAR_KEY_ENV] ?? '',
  };
}

export interface WorkBuddyProviderDeps {
  /** 注入 sidecar 管理器（测试）；缺省时按配置分片构造。 */
  sidecar?: WorkBuddySidecar;
  createSidecar?: (opts: WorkBuddySidecarOptions) => WorkBuddySidecar;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** T301：注入令牌看护（测试可控制时钟/退避/告警出口）。 */
  tokenWatch?: WorkBuddyTokenWatch;
  /** T301：注入授权客户端（测试可完全离线）。 */
  oauthClient?: WorkBuddyOAuthClient;
  /** T302：注入余额镜像（测试可注入临时 state.json 路径与假时钟）。 */
  balanceWatch?: WorkBuddyBalanceWatch;
}

/**
 * WorkBuddy 联邦透传 Provider。
 *
 * `initialize` 会尽力拉起 sidecar；**拉起失败不阻断 Provider 初始化**（记录告警，
 * health()/probe() 反映不健康），以免一个 sidecar 缺失拖垮整个网关三源启动。
 */
export class WorkBuddyProvider implements IProvider {
  readonly name: ProviderName = PROVIDER_NAME;
  readonly displayName = 'WorkBuddy';

  private enabled = true;
  private initialized = false;
  private cfg: WorkBuddyConfig | null = null;
  private sidecar: WorkBuddySidecar | null;
  private pool: PoolSnapshot | null = null;
  private oauth: WorkBuddyOAuthClient | null;
  private tokenWatch: WorkBuddyTokenWatch | null;
  private balanceWatch: WorkBuddyBalanceWatch | null;

  private readonly deps: WorkBuddyProviderDeps;
  private readonly fetchFn: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: WorkBuddyProviderDeps = {}) {
    this.deps = deps;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.env = deps.env ?? process.env;
    this.sidecar = deps.sidecar ?? null;
    this.oauth = deps.oauthClient ?? null;
    this.tokenWatch = deps.tokenWatch ?? null;
    this.balanceWatch = deps.balanceWatch ?? null;
  }

  // ─── 生命周期 ───────────────────────────────────────────────────────────────

  async initialize(config: unknown): Promise<void> {
    const cfg = resolveWorkBuddyConfig(config, this.env);
    this.cfg = cfg;
    this.enabled = cfg.enabled;
    this.initialized = true;

    // T302：载入本地余额/池状态镜像。**先于 sidecar 分支**——即便没配 sidecar 二进制，
    // 也应有基线落盘与损坏告警（状态文件属于网关自身，不依赖 sidecar 是否起得来）。
    // 失败不阻断启动：镜像降级，sidecar 与探活面照常工作。
    try {
      await this.balanceWatcher().initialize();
    } catch (err) {
      logger.warn(`[PVD:workbuddy] balance state init failed: ${messageOf(err)}`);
    }

    if (!this.sidecar) {
      if (!cfg.sidecar.binPath) {
        logger.warn(
          `[PVD:workbuddy] no sidecar binary configured (set providers.workbuddy.sidecar.binPath ` +
            `or ${WORKBUDDY_SIDECAR_BIN_ENV}); provider is initialized but cannot serve requests yet`,
        );
        return;
      }
      const opts: WorkBuddySidecarOptions = {
        binPath: cfg.sidecar.binPath,
        port: cfg.sidecar.port,
        args: this.buildSidecarArgs(cfg),
      };
      this.sidecar = this.deps.createSidecar ? this.deps.createSidecar(opts) : new WorkBuddySidecar(opts);
    }

    try {
      await this.sidecar.start();
    } catch (err) {
      // 尽力而为：不阻断启动；健康面会反映不健康（§3.11 面板可见）。
      logger.warn(`[PVD:workbuddy] sidecar start failed: ${messageOf(err)}`);
    }
  }

  async destroy(): Promise<void> {
    this.enabled = false;
    this.initialized = false;
    this.pool = null;
    // T302：把排队中的落盘等完再停 sidecar——否则最后一次余额写入可能被进程退出截断。
    try {
      await this.balanceWatch?.drain();
    } catch (err) {
      logger.warn(`[PVD:workbuddy] balance state drain failed: ${messageOf(err)}`);
    }
    if (this.sidecar) {
      await this.sidecar.stop();
    }
  }

  // ─── 健康 / 探活 ────────────────────────────────────────────────────────────

  async health(): Promise<ProviderHealth> {
    const status = this.sidecar?.status();
    const pool = this.pool;
    const total = pool?.total ?? 0;
    const disabledCount = (pool?.disabled ?? 0) + (pool?.accounts.filter((a) => a.paused).length ?? 0);
    const cooldownCount = pool?.cooling ?? 0;
    const healthyBackend = !!status && status.healthy && this.enabled && (pool?.healthy ?? total) > 0;
    return {
      healthy: healthyBackend,
      total,
      cooldownCount,
      disabledCount,
    };
  }

  /**
   * 真实探活：`GET /healthz` 一次往返（恒无鉴权，200=可服务 / 503=池不可服务）。
   * 同时刷新池快照（`GET /status`）供 health()/面板读取。
   */
  async probe(): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    if (!this.enabled) return { healthy: false, detail: 'provider disabled', checkedAt };
    if (!this.sidecar) {
      return { healthy: false, detail: 'workbuddy sidecar is not configured', checkedAt };
    }
    const started = Date.now();
    const healthy = await this.sidecar.health();
    const latencyMs = Date.now() - started;
    if (!healthy) {
      const st = this.sidecar.status();
      return { healthy: false, latencyMs, detail: st.lastError ?? `sidecar ${st.state}`, checkedAt };
    }
    await this.refreshPool();
    // T301：探活（30s 调度）顺带推进一轮令牌预刷看护——进窗口的号在此被刷新，
    // 连续失败则转「待刷新」+ 告警。失败绝不影响探活结论（旁路安全）。
    try {
      await this.tokenWatcher().runTick();
    } catch (err) {
      logger.warn(`[PVD:workbuddy] token watch tick failed: ${messageOf(err)}`);
    }
    return { healthy: true, latencyMs, checkedAt };
  }

  // ─── 目录 ──────────────────────────────────────────────────────────────────

  async listModels(): Promise<OpenAIModel[]> {
    const models = await this.getJson<{ data?: unknown }>('/v1/models');
    const data = Array.isArray(models?.data) ? (models!.data as Array<Record<string, unknown>>) : [];
    return data
      .map((m) => m as unknown as ModelItem)
      .filter((m) => typeof m?.id === 'string' && m.id.length > 0);
  }

  // ─── 对话补全（透传 → 文本增量）─────────────────────────────────────────────

  async *chatCompletion(req: OpenAIChatRequest, opts: ChatOptions): AsyncIterable<string> {
    this.assertEnabled();
    const cfg = this.cfg!;
    const model = String(req?.model ?? '').trim();
    if (!model) {
      throw new ProxyError(ErrorCode.MODEL_NOT_FOUND, 'model is required', {
        context: { requestId: opts.requestId },
      });
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    // T207'：网关侧唯一职责是保证会话 ID 原样透传（粘性由 sidecar 内部承接）。
    // 'passthrough' 模式下连这个清洗层也跳过（故障一键回退）。
    if (cfg.rewriteMode === 'full' && opts.conversationId) {
      headers['x-conversation-id'] = opts.conversationId;
    }

    let res: Response;
    try {
      res = await this.fetchFn(`${this.sidecar!.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: opts.abortSignal,
      });
    } catch (err) {
      throw toProxyError(err, ErrorCode.NETWORK_ERROR);
    }

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new ProxyError(codeForStatus(res.status), truncate(text) || `workbuddy sidecar returned HTTP ${res.status}`, {
        status: res.status,
        context: { requestId: opts.requestId, model },
      });
    }

    if (req?.stream === true) {
      if (!res.body) return;
      yield* this.streamText(res.body, opts.abortSignal);
      return;
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProxyError(
        ErrorCode.PROVIDER_PROTOCOL_ERROR,
        `workbuddy sidecar returned a non-JSON body: ${truncate(text)}`,
      );
    }
    const content = (parsed as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.length > 0) yield content;
  }

  private async *streamText(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        if (signal?.aborted) return;
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          const piece = parseDelta(line);
          if (piece === null) continue;
          if (piece === '__ERROR__') {
            throw new ProxyError(ErrorCode.PROVIDER_PROTOCOL_ERROR, 'workbuddy sidecar stream reported an error event');
          }
          if (piece) yield piece;
        }
      }
    } catch (err) {
      if (err instanceof ProxyError) throw err;
      if (signal?.aborted) return;
      throw toProxyError(err, ErrorCode.PROVIDER_PROTOCOL_ERROR);
    } finally {
      reader.releaseLock?.();
    }
  }

  // ─── 用量 ──────────────────────────────────────────────────────────────────

  /**
   * 用量口径（§3.9）：WorkBuddy 是**积分制**，网关不做美元折算 → `costUsd` 恒
   * **null**（不参与美元聚合）；原生量放 `native.points`。token 取自透传体的
   * OpenAI usage（sidecar 原样透出）。
   */
  extractUsage(events: unknown[]): UsageSnapshot {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let points: number | undefined;

    for (const raw of events) {
      const usage = findUsage(raw);
      if (!usage) continue;
      const prompt = numberOr(usage.prompt_tokens);
      const completion = numberOr(usage.completion_tokens);
      if (prompt !== undefined) inputTokens = prompt;
      if (completion !== undefined) outputTokens = completion;
      const details = usage.prompt_tokens_details;
      if (details && typeof details === 'object') {
        const cached = numberOr((details as Record<string, unknown>).cached_tokens);
        if (cached !== undefined) cacheReadTokens = cached;
      }
      const p = numberOr(usage.points) ?? numberOr((usage as Record<string, unknown>).credits);
      if (p !== undefined) points = p;
    }

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      costUsd: null,
      ...(points !== undefined ? { native: { points } } : {}),
    };
  }

  // ─── 账号（委托 sidecar 面板 API，T205'）────────────────────────────────────

  /** 账号列表：读最近一次 `/status` 池快照（不做凭据透出）。 */
  listAccounts(): AccountInfo[] {
    return (this.pool?.accounts ?? []).map((a) => ({
      id: a.id,
      name: a.label ?? a.id,
      // sidecar 的账号凭据（OAuth token）永不出 sidecar：本层不持有、不透出。
      apiKey: '',
      addedAt: '',
    }));
  }

  /** 刷新池快照（面板与 health() 的数据源）。 */
  async refreshPool(): Promise<PoolSnapshot | null> {
    const status = await this.getJson<Record<string, unknown>>('/status');
    if (!status) {
      // T302：sidecar 读不到时也告诉余额镜像一声——它会记一次失败并保留上次已知余额
      // （绝不能把「读不到」写成「余额清零」）。
      await this.balanceWatcher().observe(null);
      return null;
    }
    this.pool = mapPoolSnapshot(status);
    // T301：把最新账号集合（含 expiresAt）对齐到令牌看护；账号消失时其待刷新标记
    // 一并清除（sync 保留既有 pendingRefresh/lastError/attempts）。
    this.tokenWatcher().sync(
      this.pool.accounts.map((a) => ({ id: a.id, ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}) })),
    );
    // T302：复用**同一次** `/status` 响应推进余额镜像（零额外 IO）；落盘按 5min 节流。
    await this.balanceWatcher().observe(status);
    return this.pool;
  }

  /** sidecar 账号由 OAuth 设备授权流程创建（原生面板 / T301）；本卡不支持程序化新增。 */
  async addAccount(_credentials: unknown): Promise<AccountInfo> {
    throw new ProxyError(
      ErrorCode.UNSUPPORTED_OPTION,
      'workbuddy accounts are managed by the sidecar: use its native panel OAuth device login ' +
        `(${this.sidecar?.baseUrl ?? 'sidecar'}/panel/), or wait for T301 (device authorization)`,
    );
  }

  removeAccount(id: string): void {
    this.fireAndForget(`/panel/api/accounts/${encodeURIComponent(id)}/remove`, 'remove', id);
  }

  pauseAccount(id: string): void {
    this.fireAndForget(`/panel/api/accounts/${encodeURIComponent(id)}/pause`, 'pause', id);
  }

  resumeAccount(id: string): void {
    this.fireAndForget(`/panel/api/accounts/${encodeURIComponent(id)}/resume`, 'resume', id);
  }

  // ─── T301：授权编排（面板内添加账号）────────────────────────────────────────

  /**
   * 发起授权：返回 `{ url, state }`，面板把 url 交给用户，然后轮询 `loginPoll`。
   * 凭据全程留在 sidecar（本方法返回值里没有任何 token 字段）。
   */
  async loginStart(realm: WorkBuddyRealm = 'cn'): Promise<LoginStartResult> {
    return this.oauthClient().startLogin(realm);
  }

  /** 轮询一次授权状态（`done=false` 表示用户尚未在浏览器完成授权）。 */
  async loginPoll(state: string): Promise<LoginPollResult> {
    return this.oauthClient().pollLogin(state);
  }

  // ─── T301：令牌看护（1h 预刷 / 3 次指数退避 / 待刷新态 / 告警）──────────────

  /** 令牌看护状态（面板徽章与 `GET /api/upstreams/workbuddy/tokens` 数据源）。 */
  tokenWatchStatus(): { preRefreshWindowMs: number; maxRetries: number; accounts: TokenWatchEntry[]; pendingRefresh: string[] } {
    const watch = this.tokenWatcher();
    return {
      preRefreshWindowMs: watch.windowMs,
      maxRetries: watch.retryLimit,
      accounts: watch.snapshot(),
      pendingRefresh: watch.pendingRefreshIds(),
    };
  }

  /** 主动跑一轮预刷看护（T303 的 30s 探活调度经 `probe()` 间接触发）。 */
  async runTokenWatchTick(): Promise<RefreshOutcome[]> {
    return this.tokenWatcher().runTick();
  }

  // ─── T302：余额镜像与池状态持久化 ───────────────────────────────────────────

  /** 余额/池状态镜像的只读视图（`GET /api/upstreams/workbuddy/balance` 数据源）。 */
  balanceStatus(): BalanceSnapshot {
    return this.balanceWatcher().snapshot();
  }

  /** 主动刷新一次余额（不等 5min 窗口）；也用于损坏后从 sidecar 重建。 */
  refreshBalance(): Promise<{ ok: boolean; persisted: boolean; accounts: number; refreshedAt: number }> {
    return this.balanceWatcher()
      .refresh({ force: true })
      .then((r) => ({ ok: r.ok, persisted: r.persisted, accounts: r.accounts, refreshedAt: r.refreshedAt }));
  }

  /** 懒构造余额镜像：只拉 `/status`（sidecar 才是刷新执行者，网关不碰上游凭据）。 */
  private balanceWatcher(): WorkBuddyBalanceWatch {
    if (!this.balanceWatch) {
      this.balanceWatch = new WorkBuddyBalanceWatch({
        fetchStatus: () => this.getJson<Record<string, unknown>>('/status'),
        onAlert: (alert) => notifyWebhook('workbuddy.balance', {
          kind: alert.kind,
          message: alert.message,
          at: alert.at,
          ...(alert.detail ?? {}),
        }),
      });
    }
    return this.balanceWatch;
  }

  /** 懒构造：sidecar baseUrl/密钥在 initialize 后才确定。 */
  private oauthClient(): WorkBuddyOAuthClient {    if (!this.oauth) {
      if (!this.sidecar) {
        throw new ProxyError(ErrorCode.NO_PROVIDER_AVAILABLE, 'WorkBuddy sidecar is not available');
      }
      this.oauth = new WorkBuddyOAuthClient({
        baseUrl: this.sidecar.baseUrl,
        apiKey: this.cfg?.apiKey ?? '',
        fetchFn: this.fetchFn,
      });
    }
    return this.oauth;
  }

  /** 懒构造令牌看护：刷新出口 = sidecar 面板的「复活」路由（联邦下刷新由 sidecar 执行）。 */
  private tokenWatcher(): WorkBuddyTokenWatch {
    if (!this.tokenWatch) {
      this.tokenWatch = new WorkBuddyTokenWatch({
        triggerRefresh: (uid) => this.refreshAccountViaSidecar(uid),
        notify: (event, payload) => notifyWebhook(event, payload),
      });
    }
    return this.tokenWatch;
  }

  /** 触发 sidecar 刷新单号（失败抛错，由看护层做退避重试与待刷新标记）。 */
  private async refreshAccountViaSidecar(uid: string): Promise<void> {
    if (!this.sidecar) throw new Error('workbuddy sidecar is not available');
    const headers: Record<string, string> = {};
    if (this.cfg?.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const res = await this.fetchFn(
      `${this.sidecar.baseUrl}/panel/api/accounts/${encodeURIComponent(uid)}/revive`,
      { method: 'POST', headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      throw new Error(`sidecar revive ${uid} -> HTTP ${res.status}`);
    }
  }

  // ─── 总闸 / 配置 ────────────────────────────────────────────────────────────

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 热重载：只应用非凭据增量；sidecar 二进制/端口变更需重新 initialize。 */
  updateConfig(config: unknown): void {
    const next = resolveWorkBuddyConfig(config, this.env);
    this.cfg = next;
    this.enabled = next.enabled;
  }

  /** sidecar 进程状态（面板上游卡片的直读数据源，§3.11-4）。 */
  sidecarStatus(): SidecarStatus | null {
    return this.sidecar?.status() ?? null;
  }

  // ─── 内部工具 ──────────────────────────────────────────────────────────────

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ProxyError(ErrorCode.NO_PROVIDER_AVAILABLE, 'WorkBuddy provider is disabled');
    }
    if (!this.initialized || !this.sidecar) {
      throw new ProxyError(ErrorCode.NO_PROVIDER_AVAILABLE, 'WorkBuddy sidecar is not available');
    }
  }

  private buildSidecarArgs(cfg: WorkBuddyConfig): string[] {
    const args = [`--listen`, `127.0.0.1:${cfg.sidecar.port}`];
    if (cfg.authDir) args.push('--auth-dir', cfg.authDir);
    if (cfg.apiKey) args.push('--api-key', cfg.apiKey);
    return args;
  }

  private async getJson<T>(path: string): Promise<T | null> {
    if (!this.sidecar) return null;
    const headers: Record<string, string> = {};
    if (this.cfg?.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    try {
      const res = await this.fetchFn(`${this.sidecar.baseUrl}${path}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch (err) {
      logger.warn(`[PVD:workbuddy] GET ${path} failed: ${messageOf(err)}`);
      return null;
    }
  }

  /** 面板写操作是 void 契约：异步执行，失败只记日志（面板会以快照回读校验）。 */
  private fireAndForget(path: string, action: string, id: string): void {
    if (!this.sidecar) return;
    const headers: Record<string, string> = {};
    if (this.cfg?.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    void this.fetchFn(`${this.sidecar.baseUrl}${path}`, { method: 'POST', headers })
      .then((res) => {
        if (!res.ok) logger.warn(`[PVD:workbuddy] ${action} ${id} -> HTTP ${res.status}`);
      })
      .catch((err) => logger.warn(`[PVD:workbuddy] ${action} ${id} failed: ${messageOf(err)}`));
  }
}

// ─── 纯函数（导出以便单测）────────────────────────────────────────────────────

/** 把 sidecar `/status` 响应映射为池快照（缺失字段按 0 处理，容忍 sidecar 演进）。 */
export function mapPoolSnapshot(status: Record<string, unknown>, now: number = Date.now()): PoolSnapshot {
  const rawAccounts = Array.isArray(status.accounts) ? (status.accounts as Array<Record<string, unknown>>) : [];
  const accounts = rawAccounts
    .map((a) => {
      const uid = String(a.uid ?? a.id ?? '').trim();
      if (!uid) return null;
      const expiresAt = parseTokenExpiry(a, now);
      return {
        id: uid,
        label: typeof a.nickname === 'string' && a.nickname ? a.nickname : uid,
        paused: a.paused === true,
        disabled: a.disabled === true,
        cooling: a.cooling === true,
        // T301：只有 sidecar 明确给出到期信息时才填；缺失即 undefined（未知≠已过期）。
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  const int = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    total: int(status.total, accounts.length),
    healthy: int(status.healthy, accounts.filter((a) => !a.disabled && !a.paused && !a.cooling).length),
    cooling: int(status.cooling, accounts.filter((a) => a.cooling).length),
    disabled: int(status.disabled, accounts.filter((a) => a.disabled).length),
    accounts,
  };
}

function findUsage(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.usage && typeof obj.usage === 'object') return obj.usage as Record<string, unknown>;
  const data = obj.data;
  if (data && typeof data === 'object') {
    const nested = (data as Record<string, unknown>).usage;
    if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  }
  return undefined;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const ERROR_MARKER = '__ERROR__';

/**
 * 解析一行 SSE：返回文本增量、空串（无内容）、`null`（忽略的心跳/非数据帧）或
 * `ERROR_MARKER`（上游 error 事件）。与 freebuff 的 `pickDeltaContents` 同构。
 */
export function parseDelta(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!jsonStr || jsonStr === '[DONE]') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  const err = (parsed as { error?: unknown })?.error;
  if (typeof err === 'string' && err.trim() !== '') return ERROR_MARKER;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') return ERROR_MARKER;
  const choices = (parsed as { choices?: unknown })?.choices;
  if (!Array.isArray(choices)) return null;
  let out = '';
  for (const choice of choices) {
    const content = (choice as { delta?: { content?: unknown } })?.delta?.content;
    if (typeof content === 'string') out += content;
  }
  return out;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
