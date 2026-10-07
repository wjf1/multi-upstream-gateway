// =============================================================================
// CommandCode Provider —— IProvider 薄适配层（P0-PORT-D2）
// -----------------------------------------------------------------------------
// 定位（D1 报告结论）：**不搬家、只做薄包装**。
//
// 4.22.4 起 `src/adapters/commandcode/` 已模块化（adapter / pipeline / 各类
// request·stream·usage 子模块），把整目录 `git mv` 到 `providers/commandcode/`
// 收益低、回归风险高（要动全部 import 与快照）。因此本文件只做一层**契约适配**：
// 把既有的翻译引擎（CommandCodeAdapter + sendToCC）、配置/账号层（utils/config）、
// 模型注册表（utils/models）与用量采集（adapters/commandcode/usage）暴露成
// `IProvider` 契约，供 T213 统一 API 层接线使用。
//
// 边界（刻意不在此实现，属 T213 的路由职责）：
//   - 审计留痕（auditRequestStart/End）、用量落库（persistCompletion）、
//     限流与 modelAccess 守卫、风险门顺序 —— 都留在 `routes/chat.ts`，由 T213
//     在接线时统一编排，避免同一份副作用在 Provider 与路由各写一次；
//   - 因此 `chatCompletion` 只产出**文本增量**，不写任何持久化状态。
//
// 外部依赖一律经 CommandCodeProviderDeps 注入：既便于测试（不触网、不读写真实
// config.json / .env），也让 T213 在接线时按需替换（如统一配置源）。
// =============================================================================
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type {
  AccountInfo,
  CCEvent,
  CCRequestBody,
  ModelItem,
  OpenAIChatRequest,
} from '../../types/index.js';
import type {
  ChatOptions,
  IProvider,
  OpenAIModel,
  ProbeResult,
  ProviderHealth,
  ProviderName,
  UsageSnapshot,
} from '../core/interface.js';
import { CommandCodeAdapter } from '../../adapters/commandcode/adapter.js';
import { sendToCC, isAbortError, type SendOptions } from '../../adapters/commandcode/upstream.js';
import { accumulateUsage, createUsageAccumulator } from '../../adapters/commandcode/usage.js';
import { openAIUpstreamErrorText } from '../../adapters/commandcode/usage-extract.js';
import { getCachedModels } from '../../utils/models.js';
import { parseEventLine } from '../../routes/sse-common.js';
import {
  loadConfig,
  getActiveApiKey,
  loginNewAccount,
  logoutAccount,
  fetchLiveUsageStats,
  checkAndRotateAccountsOnQuota,
} from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { ErrorCode, ProxyError, terminalCodeFor, toProxyError } from '../../utils/errors.js';

const PROVIDER_NAME: ProviderName = 'commandcode';

/** 凭据脱敏口径：只露尾 4 位（与 §3.1 / freebuff 外壳一致）。 */
function maskKey(key: string): string {
  return key ? `****${key.slice(-4)}` : '';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * commandcode 分片（`providers.commandcode`，§3.2 CommandCodeConfigSchema）的
 * 运行时视图。**只含非凭据字段** —— 账号凭据始终从 `.env` / 加密库经
 * `loadConfig()` 读取，本层不接收、不落盘任何明文凭据。
 */
export interface CommandCodeProviderConfig {
  enabled: boolean;
  rotationMode: 'manual' | 'auto-quota';
  activeAccountId: string;
  upstream: {
    apiBase?: string;
    ccVersion?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    maxRetries?: number;
  };
}

function resolveCommandCodeConfig(raw: unknown): CommandCodeProviderConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const upstream = (o.upstream ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    enabled: o.enabled !== false,
    rotationMode: o.rotationMode === 'auto-quota' ? 'auto-quota' : 'manual',
    activeAccountId: typeof o.activeAccountId === 'string' ? o.activeAccountId : '',
    upstream: {
      apiBase: typeof upstream.apiBase === 'string' ? upstream.apiBase : undefined,
      ccVersion: typeof upstream.ccVersion === 'string' ? upstream.ccVersion : undefined,
      timeoutMs: num(upstream.timeoutMs),
      idleTimeoutMs: num(upstream.idleTimeoutMs),
      maxRetries: num(upstream.maxRetries),
    },
  };
}

/** 默认探活：`/alpha/whoami` 一次真实往返（需有效凭据；401/网络失败 → null）。 */
async function defaultProbeUpstream(apiKey: string, apiBase: string, ccVersion: string): Promise<unknown> {
  const stats = await fetchLiveUsageStats(apiKey, apiBase, ccVersion);
  return stats?.whoami ?? null;
}

/**
 * 配置/账号视图的最小面（`GatewayConfig` 的结构子集）。
 * 只声明本层真正消费的字段：更窄的依赖面便于测试注入，也避免把端口/主机等
 * 网关级配置拖进 Provider 契约。
 */
export interface CommandCodeGatewayView {
  ccApiBase: string;
  ccVersion: string;
  accounts: AccountInfo[];
  activeAccountId: string;
  rotationMode: 'manual' | 'auto-quota';
}

export interface CommandCodeProviderDeps {
  adapter?: CommandCodeAdapter;
  send?: (body: CCRequestBody, opts: SendOptions) => Promise<Readable>;
  /** 配置/账号视图（默认 `loadConfig()`）。 */
  gatewayConfig?: () => CommandCodeGatewayView;
  activeApiKey?: () => string;
  models?: () => ModelItem[];
  probeUpstream?: (apiKey: string, apiBase: string, ccVersion: string) => Promise<unknown>;
  loginAccount?: (apiKey: string, name?: string) => Promise<AccountInfo>;
  logoutAccount?: (id: string) => boolean;
  /** 额度轮换回调（auto-quota 模式下 sendToCC 重试时换号）。 */
  rotateOnQuota?: () => Promise<boolean>;
}

/**
 * CommandCode（上游 CC wire）Provider 外壳。
 *
 * 生命周期：构造（不 IO）→ initialize(config) → 服务请求 → destroy()。
 */
export class CommandCodeProvider implements IProvider {
  readonly name: ProviderName = PROVIDER_NAME;
  readonly displayName = 'CommandCode';

  private enabled = true;
  private initialized = false;
  private cfg: CommandCodeProviderConfig | null = null;
  /** 本地暂停集合：CC 上游没有「单账号暂停」的协议语义，暂停仅影响本网关选号/探活。 */
  private paused = new Set<string>();

  private readonly adapter: CommandCodeAdapter;
  private readonly send: (body: CCRequestBody, opts: SendOptions) => Promise<Readable>;
  private readonly gatewayConfig: () => CommandCodeGatewayView;
  private readonly activeApiKey: () => string;
  private readonly models: () => ModelItem[];
  private readonly probeUpstream: (apiKey: string, apiBase: string, ccVersion: string) => Promise<unknown>;
  private readonly loginAccount: (apiKey: string, name?: string) => Promise<AccountInfo>;
  private readonly logoutAccount: (id: string) => boolean;
  private readonly rotateOnQuota: (() => Promise<boolean>) | null;

  constructor(deps: CommandCodeProviderDeps = {}) {
    this.adapter = deps.adapter ?? new CommandCodeAdapter();
    this.send = deps.send ?? sendToCC;
    this.gatewayConfig = deps.gatewayConfig ?? loadConfig;
    this.activeApiKey = deps.activeApiKey ?? getActiveApiKey;
    this.models = deps.models ?? getCachedModels;
    this.probeUpstream = deps.probeUpstream ?? defaultProbeUpstream;
    this.loginAccount = deps.loginAccount ?? loginNewAccount;
    this.logoutAccount = deps.logoutAccount ?? logoutAccount;
    this.rotateOnQuota = deps.rotateOnQuota ?? checkAndRotateAccountsOnQuota;
  }

  // ─── 生命周期 ───────────────────────────────────────────────────────────────

  async initialize(config: unknown): Promise<void> {
    this.cfg = resolveCommandCodeConfig(config);
    this.enabled = this.cfg.enabled;
    this.initialized = true;
    logger.info(`[PVD:commandcode] initialized (enabled=${this.enabled}, rotation=${this.cfg.rotationMode})`);
  }

  async destroy(): Promise<void> {
    this.enabled = false;
    this.initialized = false;
    this.paused.clear();
    logger.info('[PVD:commandcode] destroyed');
  }

  // ─── 健康 / 探活 ────────────────────────────────────────────────────────────

  async health(): Promise<ProviderHealth> {
    const accounts = this.gatewayConfig().accounts;
    const total = accounts.length;
    const disabledCount = accounts.filter((a) => this.paused.has(a.id)).length;
    return {
      healthy: this.enabled && total - disabledCount > 0,
      total,
      cooldownCount: 0,
      disabledCount,
    };
  }

  /**
   * 真实探活：一次最小开销的上游往返（`/alpha/whoami`，T303 依赖其真实性，
   * 禁止恒真）。无凭据时不发请求，直接判不健康。
   */
  async probe(): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    if (!this.enabled) return { healthy: false, detail: 'provider disabled', checkedAt };

    const apiKey = this.activeApiKey();
    if (!apiKey) {
      return { healthy: false, detail: 'no active commandcode credential', checkedAt };
    }

    const cfg = this.gatewayConfig();
    const started = Date.now();
    try {
      const result = await this.probeUpstream(apiKey, cfg.ccApiBase, cfg.ccVersion);
      const latencyMs = Date.now() - started;
      if (result === null || result === undefined) {
        return { healthy: false, latencyMs, detail: 'upstream rejected the probe (invalid credential or unreachable)', checkedAt };
      }
      return { healthy: true, latencyMs, checkedAt };
    } catch (err) {
      return { healthy: false, latencyMs: Date.now() - started, detail: messageOf(err), checkedAt };
    }
  }

  // ─── 目录 ──────────────────────────────────────────────────────────────────

  async listModels(): Promise<OpenAIModel[]> {
    return this.models();
  }

  // ─── 对话补全（文本增量）────────────────────────────────────────────────────

  async *chatCompletion(req: OpenAIChatRequest, opts: ChatOptions): AsyncIterable<string> {
    this.assertEnabled();

    const model = String(req?.model ?? '').trim();
    if (!model) {
      throw new ProxyError(ErrorCode.MODEL_NOT_FOUND, 'model is required', {
        context: { requestId: opts.requestId },
      });
    }

    const apiKey = this.activeApiKey();
    if (!apiKey) {
      throw new ProxyError(ErrorCode.MISSING_CREDENTIAL, 'no active commandcode credential', {
        context: { requestId: opts.requestId },
      });
    }

    let body: CCRequestBody;
    try {
      body = this.adapter.translateOpenAIRequest(req) as CCRequestBody;
    } catch (err) {
      throw toProxyError(err, ErrorCode.UNSUPPORTED_OPTION);
    }

    let upstream: Readable;
    try {
      upstream = await this.send(body, {
        apiKey,
        abortSignal: opts.abortSignal,
        onRetry: async () => {
          if (!this.rotateOnQuota) return undefined;
          const rotated = await this.rotateOnQuota();
          return rotated ? this.activeApiKey() : undefined;
        },
      });
    } catch (err) {
      if (isAbortError(err)) return;
      throw toProxyError(err, ErrorCode.NETWORK_ERROR);
    }

    yield* this.streamText(upstream, opts.abortSignal, opts.requestId, model);
  }

  /** 上游 SSE → 文本增量；`error` 事件转 ProxyError（不再静默当成内容）。 */
  private async *streamText(
    upstream: Readable,
    signal: AbortSignal | undefined,
    requestId: string,
    model: string,
  ): AsyncGenerator<string> {
    const rl = createInterface({ input: upstream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (signal?.aborted) return;
        const event = parseEventLine(line) as CCEvent | null;
        if (!event) continue;

        if (event.type === 'error') {
          const msg = openAIUpstreamErrorText(event);
          if (msg) {
            throw new ProxyError(terminalCodeFor(msg) ?? ErrorCode.PROVIDER_PROTOCOL_ERROR, msg, {
              context: { requestId, model },
            });
          }
          continue;
        }

        if (event.type === 'text-delta') {
          const text = (event as { text?: unknown }).text ?? (event as { data?: { text?: unknown } }).data?.text;
          if (typeof text === 'string' && text.length > 0) yield text;
        }
      }
    } catch (err) {
      if (err instanceof ProxyError) throw err;
      if (signal?.aborted) return;
      throw toProxyError(err, ErrorCode.PROVIDER_PROTOCOL_ERROR);
    } finally {
      rl.close();
    }
  }

  // ─── 用量 ──────────────────────────────────────────────────────────────────

  /**
   * 复用 CC 事件采集器（含缓存明细拆分与 provider-metadata 权威账单）。
   * `costUsd`：有上游权威金额用权威值，否则 **null**（§3.9：null = 不参与美元
   * 聚合，由用量层本地估算兜底；≠ 0 的「确定免费」语义）。
   */
  extractUsage(events: unknown[]): UsageSnapshot {
    const acc = createUsageAccumulator();
    for (const event of events) {
      if (event && typeof event === 'object') accumulateUsage(acc, event as CCEvent);
    }
    return {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens,
      costUsd: acc.upstreamCostUsd ?? null,
    };
  }

  // ─── 账号 ──────────────────────────────────────────────────────────────────

  /** 账号列表（凭据脱敏：只露尾 4 位）。 */
  listAccounts(): AccountInfo[] {
    return this.gatewayConfig().accounts.map((a) => ({ ...a, apiKey: maskKey(a.apiKey) }));
  }

  /** 添加账号：走既有 loginNewAccount（校验上游 + 落加密库 / .env 通道）。 */
  async addAccount(credentials: unknown): Promise<AccountInfo> {
    const c = (credentials ?? {}) as { apiKey?: string; token?: string; name?: string };
    const key = String(c.apiKey ?? c.token ?? '').trim();
    if (!key) {
      throw new ProxyError(ErrorCode.MISSING_CREDENTIAL, 'apiKey is required to add a commandcode account');
    }
    return this.loginAccount(key, c.name);
  }

  /** 移除账号（幂等）。 */
  removeAccount(id: string): void {
    this.paused.delete(id);
    try {
      this.logoutAccount(id);
    } catch (err) {
      logger.warn(`[PVD:commandcode] logoutAccount(${id}) failed: ${messageOf(err)}`);
    }
  }

  pauseAccount(id: string): void {
    this.paused.add(id);
  }

  resumeAccount(id: string): void {
    this.paused.delete(id);
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

  /** 热重载：只应用非凭据增量（enabled / rotationMode / upstream）。 */
  updateConfig(config: unknown): void {
    const next = resolveCommandCodeConfig(config);
    this.cfg = next;
    this.enabled = next.enabled;
  }

  // ─── 内部工具 ──────────────────────────────────────────────────────────────

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ProxyError(ErrorCode.NO_PROVIDER_AVAILABLE, 'CommandCode provider is disabled');
    }
    if (!this.initialized) {
      throw new ProxyError(ErrorCode.NO_PROVIDER_AVAILABLE, 'CommandCode provider is not initialized');
    }
  }
}
