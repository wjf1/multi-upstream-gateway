// =============================================================================
// Freebuff Provider —— IProvider 外壳（T201，master-plan v1.2 §5 T201）
// -----------------------------------------------------------------------------
// 职责：把「Run 生命周期 + free session + 远程目录 + 多 Token 池」四个内部模块
// 装配成契约要求的 IProvider（src/providers/core/interface.ts），并把上游
// OpenAI 兼容响应降为**文本增量**（AsyncIterable<string>，与 commandcode
// 外壳同口径）。
//
// 内部模块与 Go 原版（Quorinex/Freebuff2API@a1c1035）的对应：
//   - run-manager.ts  ← run_manager.go（Acquire/Release/rotate/draining/prewarm）
//   - free-session.ts ← free_session.go（会话缓存与刷新/等待室）
//   - models.ts       ← models.go（free-agents.ts 注册表 + 6h 刷新 + fallback）
//   - upstream.ts     ← upstream.go（safe-fetch 出站：agent-runs / chat / session）
//   - config.ts       ← config.go（apiBase 归一化 / UA / client session id）
//
// 明确定界：
//   - tools schema 规范化（Go server.go:408 normalizeToolSchemas）→ **T202a 已落地**
//     （tool-schema.ts，由本文件 buildUpstreamBody 接入）；
//   - Anthropic /v1/messages 桥 → T202b；
//   - 配额感知调度、账号健康分级、凭据持久化 → T203；
//   - 等待室 HTTP 语义（Retry-After / waiting_room_queued 映射）→ T305
//     （本卡已把 position/queueDepth/retryAfterSeconds 放进 ProxyError.context）。
// =============================================================================

import type { AccountInfo, OpenAIChatRequest } from '../../types/index.js';
import type {
  ChatOptions,
  IProvider,
  OpenAIModel,
  ProviderHealth,
  ProviderName,
  ProbeResult,
  UsageSnapshot,
} from '../core/interface.js';
import { logger } from '../../utils/logger.js';
import { ErrorCode, ProxyError, codeForStatus, terminalCodeFor, toProxyError } from '../../utils/errors.js';
import {
  dedupeStrings,
  generateClientSessionId,
  registerUpstreamHosts,
  resolveFreebuffConfig,
} from './config.js';
import { ModelRegistry } from './models.js';
import { ensureSession, invalidateSession } from './free-session.js';
import { RunManager, TokenPool, type RunLease } from './run-manager.js';
import { iterateSsePayloads, UpstreamClient, type ChatCompletionsResult } from './upstream.js';
import { isWaitingRoomError, WaitingRoomError, type FreebuffConfig } from './types.js';
import { normalizeToolSchemas } from './tool-schema.js';
import { classifyFreebuffError, findHttpStatus } from './errors.js';
import {
  FreebuffAccountStore,
  FREEBUFF_PROVIDER_ID,
  type FreebuffStoredAccount,
} from './account-store.js';
import { getDefaultCredentialStore } from '../../utils/credential-store.js';

const PROVIDER_NAME: ProviderName = 'freebuff';

// server.go:338 的 30 分钟 401 冷却由 errors.ts 的 classify() 统一给出；
// 此处保留常量导出以兼容 T201 调用方（值同源）。
export { AUTH_REJECT_COOLDOWN_MS } from './errors.js';
export { isSessionInvalid, isRunInvalid } from './errors.js';

/** 单请求最大「上游错误重试」次数（server.go:267 `attempt < 2`）。 */
const MAX_RUN_ATTEMPTS = 2;

/** 错误体入 message 的长度上限（防止把整页 HTML 塞进错误信封）。 */
const ERROR_TEXT_LIMIT = 600;

/** 凭据脱敏：只露尾 4 位（§3.1，与 commandcode 外壳同口径）。 */
function maskToken(token: string): string {
  if (!token) return '';
  return `****${token.slice(-4)}`;
}

/** FreebuffProvider 可选依赖注入（T203：账号持久化后端；测试可注入 memory 后端）。 */
export interface FreebuffProviderDeps {
  accountStore?: FreebuffAccountStore;
}

export class FreebuffProvider implements IProvider {
  readonly name: ProviderName = PROVIDER_NAME;
  readonly displayName = 'Freebuff';

  private enabled = true;
  private initialized = false;
  private cfg: FreebuffConfig | null = null;
  private client: UpstreamClient | null = null;
  private registry: ModelRegistry | null = null;
  private runs: RunManager | null = null;
  private accountAddedAt = new Date().toISOString();
  private accountStore: FreebuffAccountStore | null;

  constructor(deps: FreebuffProviderDeps = {}) {
    this.accountStore = deps.accountStore ?? null;
  }

  // ─── 生命周期 ───────────────────────────────────────────────────────────────

  async initialize(config: unknown): Promise<void> {
    const cfg = resolveFreebuffConfig(config);
    this.cfg = cfg;
    this.enabled = cfg.enabled;
    this.initialized = true;

    // T203：启动时从 T103 加密库读回 Freebuff 账号；FREEBUFF_TOKENS 作为引导
    // 通道保留（两者合并去重，加密库条目在前）。
    this.accountStore ??= new FreebuffAccountStore(getDefaultCredentialStore());
    const persisted = this.accountStore.tokens();
    if (persisted.length > 0) {
      cfg.tokens = dedupeStrings([...persisted, ...cfg.tokens]);
    }

    // SSRF 白名单自注册必须在任何出站请求之前（safe-fetch 是 fail-closed）。
    registerUpstreamHosts([cfg.apiBase, cfg.modelRegistryUrl]);

    this.client = new UpstreamClient(cfg);

    // 注册表：首刷失败自动回落内置目录，永不阻断 Provider 启动（DoD）。
    this.registry = new ModelRegistry(cfg);
    await this.registry.start();

    this.runs = new RunManager(cfg, this.client);
    this.runs.start(this.registry.agentIds());

    if (cfg.tokens.length === 0) {
      logger.warn(
        '[PVD:freebuff] no tokens configured (set FREEBUFF_TOKENS, comma-separated); ' +
          'provider is initialized but cannot serve requests yet',
      );
    } else {
      logger.info(
        `[PVD:freebuff] initialized (${cfg.tokens.length} token(s), ` +
          `${this.registry.agentIds().length} agents, registry=${this.registry.source})`,
      );
    }
  }

  async destroy(): Promise<void> {
    this.enabled = false;
    this.initialized = false;
    if (this.runs) await this.runs.close();
    this.registry?.stop();
    this.client = null;
    this.registry = null;
    this.runs = null;
  }

  // ─── 健康 / 探活 ────────────────────────────────────────────────────────────

  async health(): Promise<ProviderHealth> {
    if (!this.runs) {
      return { healthy: false, total: 0, cooldownCount: 0, disabledCount: 0, queueDepth: 0 };
    }
    const now = Date.now();
    const snapshots = this.runs.snapshots();
    const total = snapshots.length;
    const cooldownCount = snapshots.filter(
      (s) => (s.cooldownUntil ?? 0) > now,
    ).length;
    const disabledCount = snapshots.filter((s) => !this.runs?.getPool(s.name)?.enabled).length;
    const queueDepth = snapshots.reduce(
      (sum, s) => sum + s.runs.reduce((acc, r) => acc + r.inflight, 0),
      0,
    );
    return {
      healthy: this.enabled && total > 0 && total - cooldownCount - disabledCount > 0,
      total,
      cooldownCount,
      disabledCount,
      queueDepth,
    };
  }

  /**
   * 真实探活：依次对「未暂停且未冷却」的 Token 发起一次 free session 往返
   * （与 prewarm 同一最小路径，不建 Run、不发对话请求）。
   *
   * T203 强化：
   *   - 逐个 Token 尝试，前一个失效（401/403/429/5xx）即冷却并继续下一个，
   *     全部失败才判不健康——避免"首个 Token 失效就整体不健康"的误判，
   *     也避免"首个 Token 有效就整体健康"的漏判；
   *   - 401/403 明确**不返回健康**（DoD：Token 失效时 probe 返回不健康）；
   *   - 等待室排队说明上游可达 → healthy（T201 语义保留）。
   */
  async probe(): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    if (!this.enabled) return { healthy: false, detail: 'provider disabled', checkedAt };
    const runs = this.runs;
    if (!runs) return { healthy: false, detail: 'freebuff provider is not initialized', checkedAt };

    const now = Date.now();
    const candidates = runs
      .poolNames()
      .map((name) => runs.getPool(name))
      .filter((pool): pool is TokenPool => !!pool && pool.enabled && !pool.isCoolingDown(now));
    if (candidates.length === 0) {
      return { healthy: false, detail: 'no usable freebuff token (all paused or cooling down)', checkedAt };
    }

    const started = Date.now();
    const failures: string[] = [];
    for (const pool of candidates) {
      try {
        await ensureSession(pool);
        pool.noteSuccess();
        return { healthy: true, latencyMs: Date.now() - started, checkedAt };
      } catch (err) {
        if (isWaitingRoomError(err)) {
          return {
            healthy: true,
            latencyMs: Date.now() - started,
            detail: `waiting room queued: ${err.message}`,
            checkedAt,
          };
        }
        const status = findHttpStatus(err);
        const classified = status !== undefined ? classifyFreebuffError(status, messageOf(err)) : null;
        if (classified && classified.action === 'cooldown_auth') {
          pool.markCooldown(classified.cooldownMs, classified.reason);
          failures.push(`${pool.name}: ${classified.reason}`);
        } else if (classified && classified.action === 'cooldown_soft') {
          const ms = pool.noteFailure(classified.reason);
          failures.push(`${pool.name}: ${classified.reason} (cooldown ${Math.round(ms / 1000)}s)`);
        } else {
          pool.lastError = messageOf(err);
          failures.push(`${pool.name}: ${messageOf(err)}`);
        }
      }
    }
    return {
      healthy: false,
      latencyMs: Date.now() - started,
      detail: `all freebuff tokens unhealthy (${failures.join('; ')})`,
      checkedAt,
    };
  }

  // ─── 目录 ──────────────────────────────────────────────────────────────────

  async listModels(): Promise<OpenAIModel[]> {
    if (!this.registry) return [];
    const created = this.registry.createdAtSec;
    return this.registry.models().map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: 'Freebuff',
      name: id,
    }));
  }

  // ─── 对话补全（流/非流 → 文本增量）──────────────────────────────────────────

  async *chatCompletion(req: OpenAIChatRequest, opts: ChatOptions): AsyncIterable<string> {
    this.assertEnabled();
    const runs = this.runs;
    const client = this.client;
    const registry = this.registry;
    if (!runs || !client || !registry) {
      throw new ProxyError(ErrorCode.NO_PROVIDER_AVAILABLE, 'Freebuff provider is not initialized');
    }

    const model = String(req?.model ?? '').trim();
    if (!model) {
      throw new ProxyError(ErrorCode.MODEL_NOT_FOUND, 'model is required', {
        context: { requestId: opts.requestId },
      });
    }
    const agentId = registry.agentForModel(model);
    if (!agentId) {
      throw new ProxyError(ErrorCode.MODEL_NOT_FOUND, `freebuff does not serve model "${model}"`, {
        context: { requestId: opts.requestId, model },
      });
    }

    for (let attempt = 0; attempt < MAX_RUN_ATTEMPTS; attempt++) {
      // 选号 + 预占租约（Round-robin + 冷却跳过；等待室信号透传为 503）。
      let lease: RunLease;
      try {
        lease = await runs.acquire(agentId);
      } catch (err) {
        if (isWaitingRoomError(err)) {
          throw this.waitingRoomProxyError(err, opts.requestId);
        }
        throw new ProxyError(
          ErrorCode.UPSTREAM_ACCOUNT_UNAVAILABLE,
          `no healthy freebuff token available (${messageOf(err)})`,
          { retryable: true, context: { requestId: opts.requestId, agentId } },
        );
      }

      try {
        const instanceId = await this.ensureLeaseSession(lease, opts.requestId);
        const body = buildUpstreamBody(req, model, lease.run.id, instanceId);

        let result: ChatCompletionsResult;
        try {
          result = await client.chatCompletions(lease.pool.token, body, opts.abortSignal);
        } catch (err) {
          throw toProxyError(err, ErrorCode.NETWORK_ERROR);
        }

        if (result.ok && result.response) {
          lease.pool.noteSuccess();
          // 首字节之后不再重试：streamUpstreamText 一旦 yield 即不可回退。
          yield* streamUpstreamText(result, req?.stream === true, opts.abortSignal);
          return;
        }

        const errorText = result.errorText ?? '';
        const classified = classifyFreebuffError(result.status, errorText);

        // server.go:323 —— free session 失效：刷新会话后重试。
        if (classified.action === 'refresh_session') {
          logger.warn(`${lease.pool.name}: ${classified.reason}, refreshing and retrying`);
          invalidateSession(lease.pool, classified.reason);
          continue;
        }
        // server.go:330 —— run 失效：摘除 run 后重试（下一轮 rotate）。
        if (classified.action === 'rotate_run') {
          logger.warn(`${lease.pool.name}: ${classified.reason} (run ${lease.run.id}), rotating and retrying`);
          runs.invalidate(lease, classified.reason);
          continue;
        }
        // server.go:337 —— token 被上游拒绝：固定冷却并让调用方换号/报错。
        if (classified.action === 'cooldown_auth') {
          runs.cooldown(lease, classified.cooldownMs, classified.reason);
          invalidateSession(lease.pool, classified.reason);
          throw new ProxyError(
            ErrorCode.INVALID_CREDENTIAL,
            `freebuff upstream rejected token (HTTP ${result.status})`,
            { status: result.status, context: { requestId: opts.requestId, token: lease.pool.name } },
          );
        }
        // §3.4 软冷却：429/402/5xx 施加指数退避并换号重试。
        if (classified.action === 'cooldown_soft') {
          const cooldownMs = lease.pool.noteFailure(classified.reason);
          logger.warn(
            `${lease.pool.name}: ${classified.reason}; cooling down ${Math.round(cooldownMs / 1000)}s and retrying`,
          );
          continue;
        }

        throw new ProxyError(
          codeForStatus(result.status),
          truncate(errorText.trim()) || `freebuff upstream returned HTTP ${result.status}`,
          { status: result.status, context: { requestId: opts.requestId, model } },
        );
      } finally {
        await runs.release(lease);
      }
    }

    throw new ProxyError(ErrorCode.PROVIDER_DEGRADED, 'freebuff run expired twice in a row', {
      retryable: true,
      context: { requestId: opts.requestId, model },
    });
  }

  // ─── 用量 ──────────────────────────────────────────────────────────────────

  /**
   * 从上游事件序列提取用量。
   * freebuff 走免费 session：costUsd 恒为 **0**（§3.9：0 = 确定免费，≠ null
   * 的「不参与聚合」），无权威美元计费。
   */
  extractUsage(events: unknown[]): UsageSnapshot {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

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
    }

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
  }

  // ─── 账号 ──────────────────────────────────────────────────────────────────

  /** 账号列表（凭据脱敏：只露 token 尾 4 位）。 */
  listAccounts(): AccountInfo[] {
    if (!this.runs) return [];
    return this.runs.snapshots().map((s) => {
      const pool = this.runs?.getPool(s.name);
      return {
        id: s.name,
        name: `Freebuff ${s.name}`,
        apiKey: maskToken(pool?.token ?? ''),
        addedAt: this.accountAddedAt,
      };
    });
  }

  /**
   * 添加账号：内存态立即参与轮询，**并写入 T103 加密库**（T203 DoD：
   * 面板/API 新增的账号必须进加密库，不能只留在内存/环境变量）。
   *
   * 落库失败（无 CREDENTIAL_ENCRYPTION_KEY / 库不可写）只告警不抛——
   * 运行期可用性优先；由 T213 面板据 accountStore.canPersist() 提示用户。
   */
  async addAccount(credentials: unknown): Promise<AccountInfo> {
    if (!this.runs) {
      throw new ProxyError(ErrorCode.NO_PROVIDER_AVAILABLE, 'Freebuff provider is not initialized');
    }
    const c = (credentials ?? {}) as { token?: string; apiKey?: string; name?: string };
    const token = String(c.token ?? c.apiKey ?? '').trim();
    if (!token) {
      throw new ProxyError(ErrorCode.INVALID_CREDENTIAL, 'credentials.token is required');
    }
    let pool: TokenPool;
    try {
      pool = this.runs.addPool(token);
    } catch (err) {
      throw new ProxyError(ErrorCode.INVALID_CREDENTIAL, messageOf(err));
    }

    const addedAt = new Date().toISOString();
    const record: FreebuffStoredAccount = {
      id: pool.name,
      provider: FREEBUFF_PROVIDER_ID,
      apiKey: token,
      name: String(c.name ?? `Freebuff ${pool.name}`),
      addedAt,
    };
    try {
      if (!this.accountStore) {
        this.accountStore = new FreebuffAccountStore(getDefaultCredentialStore());
      }
      this.accountStore.upsert(record);
    } catch (err) {
      logger.warn(
        `[PVD:freebuff] added ${pool.name} in-memory but could NOT persist to encrypted store: ${messageOf(err)}`,
      );
    }

    return {
      id: pool.name,
      name: record.name,
      apiKey: maskToken(token),
      addedAt,
    };
  }

  /** 移除账号：内存池 + 加密库同步删除（幂等）。 */
  removeAccount(id: string): void {
    this.runs?.removePool(id);
    if (this.accountStore) {
      try {
        this.accountStore.remove(id);
      } catch (err) {
        logger.warn(`[PVD:freebuff] could not remove ${id} from encrypted store: ${messageOf(err)}`);
      }
    }
  }

  pauseAccount(id: string): void {
    const pool = this.runs?.getPool(id);
    if (pool) pool.enabled = false;
  }

  resumeAccount(id: string): void {
    const pool = this.runs?.getPool(id);
    if (pool) pool.enabled = true;
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

  /**
   * 热重载：只应用非凭据增量（apiBase / 超时 / UA / rotation）。
   * Token 变更需重新 initialize（凭据从环境变量读取，热重载不触碰）。
   */
  updateConfig(config: unknown): void {
    const next = resolveFreebuffConfig(config);
    if (!this.cfg) {
      this.cfg = next;
      this.enabled = next.enabled;
      return;
    }
    // 就地更新共享引用：RunManager/TokenPool 持有的是同一 cfg 对象。
    this.cfg.apiBase = next.apiBase;
    this.cfg.modelRegistryUrl = next.modelRegistryUrl;
    this.cfg.rotationIntervalMs = next.rotationIntervalMs;
    this.cfg.requestTimeoutMs = next.requestTimeoutMs;
    this.cfg.userAgent = next.userAgent;
    this.cfg.enabled = next.enabled;
    this.enabled = next.enabled;
  }

  // ─── 内部工具 ──────────────────────────────────────────────────────────────

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ProxyError(ErrorCode.NO_PROVIDER_AVAILABLE, 'Freebuff provider is disabled');
    }
    if (!this.initialized) {
      throw new ProxyError(ErrorCode.NO_PROVIDER_AVAILABLE, 'Freebuff provider is not initialized');
    }
  }

  private async ensureLeaseSession(lease: RunLease, requestId: string): Promise<string> {
    try {
      return await ensureSession(lease.pool);
    } catch (err) {
      if (isWaitingRoomError(err)) throw this.waitingRoomProxyError(err, requestId);
      throw new ProxyError(
        ErrorCode.PROVIDER_DEGRADED,
        `failed to acquire freebuff free session: ${messageOf(err)}`,
        { retryable: true, context: { requestId, token: lease.pool.name } },
      );
    }
  }

  private waitingRoomProxyError(err: WaitingRoomError, requestId: string): ProxyError {
    return new ProxyError(ErrorCode.PROVIDER_DEGRADED, err.message, {
      status: 503,
      retryable: true,
      context: {
        requestId,
        waitingRoom: true,
        position: err.position,
        queueDepth: err.queueDepth,
        retryAfterSeconds: Math.max(1, Math.ceil(err.retryAfterMs / 1000)),
      },
    });
  }
}

// ─── 上游请求体（server.go:357 injectUpstreamMetadata）───────────────────────

/** server.go:357 injectUpstreamMetadata —— 注入 run_id / cost_mode / client_id / instance_id。 */
export function buildUpstreamBody(
  req: OpenAIChatRequest,
  model: string,
  runId: string,
  sessionInstanceId: string,
): string {
  const source = { ...(req as unknown as Record<string, unknown>) };
  source.model = model;

  // server.go:364-366 —— tools schema 规范化（$ref 解析 + nullable 简化）。
  // 规范化返回深拷贝，避免就地改写调用方传入的 req.tools。
  if (Array.isArray(source.tools)) {
    source.tools = normalizeToolSchemas(source.tools);
  }

  const existing = source.codebuff_metadata;
  const metadata: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  metadata.run_id = runId;
  metadata.cost_mode = 'free';
  metadata.client_id = generateClientSessionId();
  if (sessionInstanceId.trim() !== '') {
    metadata.freebuff_instance_id = sessionInstanceId;
  }
  source.codebuff_metadata = metadata;

  return JSON.stringify(source);
}

// ─── 上游错误分类（已收敛至 errors.ts，见文件头说明）─────────────────────────
// isSessionInvalid / isRunInvalid / classifyFreebuffError 由 ./errors.ts 提供，
// 本文件仅 re-export 以兼容 T201 调用方。

// ─── 文本增量（IProvider 契约口径）───────────────────────────────────────────

/**
 * 把上游响应降为文本增量。
 * - stream=true：逐帧解析 SSE，取 `choices[].delta.content`；`data: [DONE]` 结束；
 * - stream=false：读整段 JSON，取 `choices[0].message.content`（单块产出）；
 * - 上游 `error` 事件 → ProxyError（命中终止性标记时用其错误码）。
 */
async function* streamUpstreamText(
  result: ChatCompletionsResult,
  stream: boolean,
  signal: AbortSignal | undefined,
): AsyncGenerator<string> {
  const response = result.response;
  if (!response) return;

  if (!stream) {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProxyError(
        ErrorCode.PROVIDER_PROTOCOL_ERROR,
        `freebuff upstream returned a non-JSON body: ${truncate(text.trim())}`,
      );
    }
    const errorMessage = extractErrorMessage(parsed);
    if (errorMessage) throw protocolError(errorMessage);
    const content = pickContent(parsed);
    if (content) yield content;
    return;
  }

  try {
    for await (const payload of iterateSsePayloads(response.body, signal)) {
      if (signal?.aborted) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // 非 JSON 帧（心跳等）跳过
      }
      const errorMessage = extractErrorMessage(parsed);
      if (errorMessage) throw protocolError(errorMessage);
      for (const piece of pickDeltaContents(parsed)) {
        yield piece;
      }
    }
  } catch (err) {
    if (err instanceof ProxyError) throw err;
    if (signal?.aborted) return;
    throw toProxyError(err, ErrorCode.PROVIDER_PROTOCOL_ERROR);
  }
}

/** 取非流式响应的文本内容（choices[0].message.content）。 */
function pickContent(parsed: unknown): string {
  const choices = (parsed as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = (choices[0] as { message?: { content?: unknown } })?.message;
  const content = message?.content;
  return typeof content === 'string' ? content : '';
}

/** 取流式 chunk 的文本增量（choices[].delta.content，可能多 choice）。 */
function pickDeltaContents(parsed: unknown): string[] {
  const choices = (parsed as { choices?: unknown })?.choices;
  if (!Array.isArray(choices)) return [];
  const out: string[] = [];
  for (const choice of choices) {
    const content = (choice as { delta?: { content?: unknown } })?.delta?.content;
    if (typeof content === 'string' && content.length > 0) out.push(content);
  }
  return out;
}

/** 提取上游 error 事件文案（string 或 {message} 两种形态）。 */
function extractErrorMessage(parsed: unknown): string | undefined {
  const error = (parsed as { error?: unknown })?.error;
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message.trim();
  }
  return undefined;
}

function protocolError(message: string): ProxyError {
  return new ProxyError(terminalCodeFor(message) ?? ErrorCode.PROVIDER_PROTOCOL_ERROR, message);
}

/** 从任意事件对象里找 usage 字段（顶层或 data.usage）。 */
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

function truncate(text: string, limit = ERROR_TEXT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
