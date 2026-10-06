// =============================================================================
// Provider 核心契约（执行依据：master-plan v1.2 §3.1）
// -----------------------------------------------------------------------------
// 多上游网关的单一事实接口：CommandCode / Freebuff / WorkBuddy 三个 Provider
// 适配器都实现 IProvider；各上游的账号池实现 IAccountPool。路由层（T104）与
// 统一 API 层（T213）只面向本文件，不感知任何 Provider 的内部协议。
//
// 约定：
//   - 复用 src/types/index.ts 的 OpenAI 侧类型（OpenAIChatRequest / ModelItem /
//     AccountInfo），禁止在本层重复定义协议结构；
//   - 所有可失败的方法抛 src/utils/errors.ts 的 ProxyError（稳定错误码 +
//     可执行提示），不得返回裸字符串错误；
//   - 流式输出统一为 AsyncIterable<string>（文本增量语义，与底座 chat 路由
//     的 SSE 编码管线对齐）；tool-call 等结构化增量由 Provider 内部聚合后
//     以文本（或路由层的约定事件）表达，跨 Provider 保持一致；
//   - 本层禁止 IO 之外的全局副作用：Provider 生命周期由 initialize/destroy
//     界定，运行期可变状态只允许通过 updateConfig 与启停方法变更。
// =============================================================================

import type { AccountInfo, ModelItem, OpenAIChatRequest } from '../../types/index.js';

// ─── 基础标识 ────────────────────────────────────────────────────────────────

/**
 * Provider 命名空间标识。
 *
 * 同时是 `GET /v1/models` 返回模型 ID 的命名空间前缀（§3.3 命名空间规则：
 * `codebuddy/glm-5.2` → 剥前缀路由 workbuddy）；裸模型名仅在注册表内唯一时
 * 允许使用，重名时路由层返回 `MODEL_AMBIGUOUS`（400）。
 */
export type ProviderName = 'commandcode' | 'freebuff' | 'workbuddy';

/** /v1/models 条目。复用底座 ModelItem（含定价/能力元数据），不另造结构。 */
export type OpenAIModel = ModelItem;

// ─── 健康与探活 ──────────────────────────────────────────────────────────────

/** health() 的聚合快照：面板上游状态卡与总览页的数据源（§3.1）。 */
export interface ProviderHealth {
  /** 池内是否存在至少一个可用账号（探活语义以 probe() 为准）。 */
  healthy: boolean;
  total: number;
  /** 处于冷却（SOFT_COOL/HARD_COOL 等价状态）中的账号数。 */
  cooldownCount: number;
  /** 被手动禁用/暂停的账号数。 */
  disabledCount: number;
  /** 当前在途请求数（有队列/并发统计的 Provider 提供）。 */
  queueDepth?: number;
}

/**
 * probe() 的结果：轻量**真实**探活（一次最小开销的上游往返），
 * 禁止恒真实现——T303 的自动降级与健康探测依赖它的真实性。
 */
export interface ProbeResult {
  healthy: boolean;
  /** 本次探活往返耗时（毫秒）；未发出请求即失败时可缺省。 */
  latencyMs?: number;
  /** 失败原因或降级详情（已脱敏，可直接入日志）。 */
  detail?: string;
  /** ISO 8601 时间戳。 */
  checkedAt: string;
}

// ─── 用量 ────────────────────────────────────────────────────────────────────

/**
 * 单次请求的用量快照（extractUsage 的返回值）。
 *
 * 成本口径遵循 §3.9：`costUsd` 为 null 表示该 Provider 不参与美元聚合
 * （workbuddy 积分、freebuff 免费额度），原生量放 `native`，面板禁止混加。
 */
export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  /** 输入中命中缓存的 token 数（计费按缓存读单价）。 */
  cacheReadTokens: number;
  /** 写入缓存的输入 token 数（多数上游为 0）。 */
  cacheWriteTokens: number;
  /**
   * 权威账单金额（USD）。有上游权威计费（如 commandcode provider-metadata）
   * 时用权威值；无权威计价填 null（≠ 0！0 表示确定免费，null 表示不参与聚合）。
   */
  costUsd: number | null;
  /** 原生计量单位。 */
  native?: { points?: number; freeSessionSec?: number };
}

// ─── 请求上下文 ──────────────────────────────────────────────────────────────

/**
 * 传给 chatCompletion 的调用选项。
 */
export interface ChatOptions {
  /** 客户端断开/超时信号；Provider 必须响应并中止上游请求。 */
  abortSignal?: AbortSignal;
  /**
   * 全链路请求 ID（必传）：入口生成（T105），Provider 需把它写入上游可关联
   * 的日志/用量记录，并保留在错误 context 中。
   */
  requestId: string;
  /** 会话标识（客户端提供或路由层派生，§3.5 会话粘性的键）。 */
  conversationId?: string;
  /** 强制指定账号（X-Upstream-Account 数据面能力，路由层负责审计留痕）。 */
  preferredAccountId?: string;
  /**
   * 重试回调：撞额度/瞬时错误时由 Provider 调用，返回下一次要用的账号 ID；
   * 返回 undefined 表示沿用当前账号。契约与底座 commandcode 适配器的
   * onRetry 对齐（批次 A 语义：返回值而非出参）。
   */
  onRetry?: (attempt: number, err: Error) => string | undefined | Promise<string | undefined>;
}

// ─── 账号池抽象 ──────────────────────────────────────────────────────────────

/** 账号池元素的最小公共面。各 Provider 用自己的富账号结构扩展它。 */
export interface BaseAccount {
  /** 池内唯一 ID。 */
  id: string;
  /** 人类可读标签（面板展示用，已脱敏）。 */
  label?: string;
  /** 是否参与调度（手动禁用开关）。 */
  enabled: boolean;
}

/** 路由层交给池的选号上下文。 */
export interface RoutingContext {
  /** 本次请求的目标模型（可能带命名空间前缀，池实现按需处理）。 */
  model: string;
  requestId: string;
  conversationId?: string;
  preferredAccountId?: string;
}

/** 一次预占租约：selectAccount 成功后持有，releaseLease 时归还。 */
export interface AccountLease<T extends BaseAccount> {
  account: T;
  /** 租约标识（预占/回滚与审计用）。 */
  leaseId: string;
  /** 获取时刻（epoch 毫秒）。 */
  acquiredAt: number;
}

/** 租约归还时的结果分类，驱动池的冷却/统计。 */
export type LeaseResult = 'success' | 'error' | 'ratelimit';

/** 池状态快照：面板账号页与 /api 的数据源。 */
export interface PoolSnapshot {
  total: number;
  healthy: number;
  cooldown: number;
  disabled: number;
  inFlight: number;
  accounts: Array<{
    id: string;
    label?: string;
    /** 池实现的状态枚举字符串（HEALTHY/SOFT_COOL/…，面板只展示不解释）。 */
    state: string;
    enabled: boolean;
  }>;
}

/**
 * 账号池契约。
 *
 * 实现约束（§3.4）：所有状态变更必须在 `async-mutex` 临界区内完成且锁内
 * 禁止 IO；selectAccount 采用"预占租约"——锁内 inFlight++，锁外发请求，
 * 失败经 releaseLease 回滚。
 */
export interface IAccountPool<T extends BaseAccount> {
  /** 选号并预占租约；无可用账号时抛 `UPSTREAM_ACCOUNT_UNAVAILABLE`。 */
  selectAccount(ctx: RoutingContext): Promise<AccountLease<T>>;
  /** 归还租约并按结果驱动冷却/统计状态迁移。 */
  releaseLease(lease: AccountLease<T>, result: LeaseResult): void;
  /** 池状态快照（含每账号状态，供面板与 /api）。 */
  snapshot(): PoolSnapshot;
}

// ─── Provider 主接口 ─────────────────────────────────────────────────────────

/**
 * 上游 Provider 适配器契约。
 *
 * 生命周期：构造（不 IO）→ initialize(config) → 服务请求 → destroy()。
 * `enable/disable` 是运行期总闸（T213 面板启停，2s 内对新请求生效）；
 * `updateConfig` 承接配置热重载（T102）的增量应用。
 */
export interface IProvider {
  /** 命名空间标识（ProviderName，作模型 ID 前缀与路由键）。 */
  readonly name: ProviderName;
  /** 面板展示名。 */
  readonly displayName: string;

  /**
   * 加载 Provider 配置并初始化资源（连接、缓存、后台任务）。
   * config 为该 Provider 的配置分片（Zod 校验后的输出，§3.2）；
   * 校验失败或致命初始化错误直接抛出（启动失败）。
   */
  initialize(config: unknown): Promise<void>;

  /** 聚合健康快照（账号池维度，不做网络 IO 或仅读缓存）。 */
  health(): Promise<ProviderHealth>;

  /** 轻量真实探活；禁止恒真实现（T303 依赖其真实性）。 */
  probe(): Promise<ProbeResult>;

  /** 该 Provider 当前可服务的模型列表（ID 将被路由层加命名空间前缀）。 */
  listModels(): Promise<OpenAIModel[]>;

  /**
   * 对话补全（流式统一为文本增量的 AsyncIterable）。
   * 可失败：抛 ProxyError（NO_PROVIDER_AVAILABLE / UPSTREAM_ACCOUNT_UNAVAILABLE /
   * PROVIDER_DEGRADED 等）。首字节之后不得再跨账号/上游重试（§3.6 流式降级语义）。
   */
  chatCompletion(req: OpenAIChatRequest, opts: ChatOptions): AsyncIterable<string>;

  /** 从上游原始事件序列提取用量（不落库，落库由用量层 T109 负责）。 */
  extractUsage(events: unknown[]): UsageSnapshot;

  /** 账号列表（面板展示口径，凭据字段须脱敏——批次 A `/api/auth/manual-login` 教训）。 */
  listAccounts(): AccountInfo[];

  /** 添加账号（凭据形态由各 Provider 定义；at-rest 落 T103 的加密存储）。 */
  addAccount(credentials: unknown): Promise<AccountInfo>;

  /** 移除账号（连同其状态与凭据；幂等）。 */
  removeAccount(id: string): void;

  /** 暂停单账号（退出调度，不删凭据）。 */
  pauseAccount(id: string): void;

  /** 恢复单账号。 */
  resumeAccount(id: string): void;

  /** Provider 总闸：开启。 */
  enable(): void;
  /** Provider 总闸：关闭（路由层把它视为不可选，新请求不再进入）。 */
  disable(): void;
  isEnabled(): boolean;

  /** 配置热重载的增量应用（仅应用本 Provider 分片的合法字段）。 */
  updateConfig(config: unknown): void;

  /** 释放全部资源（后台任务、连接、文件句柄）；进程退出与 Provider 移除时调用。 */
  destroy(): Promise<void>;
}
