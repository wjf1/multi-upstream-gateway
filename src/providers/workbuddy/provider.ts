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
// 边界：`addAccount` 需要 OAuth 设备授权（sidecar 原生面板流程，属 T301），本卡
// 明确不支持并抛出可执行提示；`rewriteMode` 总开关保留，仅控制透传前的清洗层
// （'full' 追加会话头与模型名规范化；'passthrough' 原样透传，用于故障一键回退）。
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

  private readonly deps: WorkBuddyProviderDeps;
  private readonly fetchFn: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: WorkBuddyProviderDeps = {}) {
    this.deps = deps;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.env = deps.env ?? process.env;
    this.sidecar = deps.sidecar ?? null;
  }

  // ─── 生命周期 ───────────────────────────────────────────────────────────────

  async initialize(config: unknown): Promise<void> {
    const cfg = resolveWorkBuddyConfig(config, this.env);
    this.cfg = cfg;
    this.enabled = cfg.enabled;
    this.initialized = true;

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
    if (!status) return null;
    this.pool = mapPoolSnapshot(status);
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
export function mapPoolSnapshot(status: Record<string, unknown>): PoolSnapshot {
  const rawAccounts = Array.isArray(status.accounts) ? (status.accounts as Array<Record<string, unknown>>) : [];
  const accounts = rawAccounts
    .map((a) => {
      const uid = String(a.uid ?? a.id ?? '').trim();
      if (!uid) return null;
      return {
        id: uid,
        label: typeof a.nickname === 'string' && a.nickname ? a.nickname : uid,
        paused: a.paused === true,
        disabled: a.disabled === true,
        cooling: a.cooling === true,
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
