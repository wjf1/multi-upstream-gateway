// =============================================================================
// Provider 运行时 —— 三源接线阶段 1（T213）
// -----------------------------------------------------------------------------
// 把 T101~T104 的契约（IProvider/registry/router）与三个 Provider 外壳装配成
// 一个运行时单例，挂到 Fastify 实例上，并提供管理面数据源（/api/providers）。
//
// 本阶段（阶段 1）刻意**不接 /v1 数据面**：chat/messages 路由仍走 CommandCode
// 既有通路（零回归）；本运行时交付的是注册表/路由器实例、三源健康与启停、
// /v1/models 的命名空间聚合。数据面切换（chatCompletion 经 router 分发）是
// T213 阶段 2，独立提交、独立验证。
//
// 按需初始化（启动零变化）：只有「有配置」的 Provider 才执行 initialize——
//   - commandcode：总是初始化（纯内存，无 IO）；
//   - freebuff：存在 `providers.freebuff` 分片或 FREEBUFF_TOKENS 环境变量；
//   - workbuddy：存在 `providers.workbuddy` 分片或 WORKBUDDY_* 环境变量。
// 未配置的 Provider 保持未初始化（chat 会得到 NO_PROVIDER_AVAILABLE），
// 不会在启动时拉起 sidecar / 发起模型注册表网络请求 —— 缺省部署的启动路径
// 与 T213 之前逐字节一致。
//
// /v1/models 命名空间聚合的门控：仅聚合「分片存在且 enabled !== false 且
// isEnabled()」的 Provider —— 存量 config.json 只有 providers.commandcode，
// 行为与 T213 之前一致；用户显式加 Freebuff/WorkBuddy 分片即视为接入意图。
// =============================================================================

import type { FastifyInstance } from 'fastify';
import type { IProvider, OpenAIModel, ProviderHealth, ProviderName } from './core/interface.js';
import { ProviderRegistry } from './core/registry.js';
import { RequestRouter } from './core/router.js';
import { CommandCodeProvider } from './commandcode/provider.js';
import { FreebuffProvider } from './freebuff/provider.js';
import { WorkBuddyProvider, WORKBUDDY_SIDECAR_BIN_ENV, WORKBUDDY_SIDECAR_KEY_ENV, WORKBUDDY_SIDECAR_PORT_ENV } from './workbuddy/provider.js';
import { readRawConfigFile } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const ALL_PROVIDERS: readonly ProviderName[] = ['commandcode', 'freebuff', 'workbuddy'];
const DEFAULT_PRIORITY: readonly ProviderName[] = ALL_PROVIDERS;

declare module 'fastify' {
  interface FastifyInstance {
    /** T213 阶段 1：三源 Provider 运行时（index.ts 装配；未装配时为 undefined）。 */
    providerRuntime?: ProviderRuntime;
  }
}

/** 从 Fastify 实例安全取运行时（未装配返回 undefined；路由/面板共用入口）。 */
export function getProviderRuntime(app: FastifyInstance): ProviderRuntime | undefined {
  return app.providerRuntime;
}

/** sidecar 进程状态的最小形状（duck-type，避免 runtime 依赖具体 Provider 类）。 */
interface SidecarView {
  state: string;
  pid: number | null;
  restarts: number;
  healthy: boolean;
  lastError?: string;
  baseUrl: string;
}

export interface ProviderStatusView {
  name: ProviderName;
  displayName: string;
  enabled: boolean;
  /** 是否具备配置（分片或环境变量）；false = 尚未 initialize。 */
  configured: boolean;
  initialized: boolean;
  health: ProviderHealth | null;
  /** WorkBuddy 联邦 sidecar 进程状态（§3.11-4 面板上游卡片数据源）。 */
  sidecar?: SidecarView;
  /** 初始化失败原因（尽力而为，不阻断启动）。 */
  initError?: string;
}

export interface ProviderRuntimeDeps {
  env?: NodeJS.ProcessEnv;
  /**
   * 配置分片加载（默认 `readRawConfigFile().providers`）。
   * 返回的键是 provider 名，值是原始分片对象（可能缺项）。
   */
  loadShards?: () => Record<string, unknown>;
  /** 测试注入：完全接管 Provider 实例的构建。 */
  buildProviders?: (shards: Record<string, unknown>, env: NodeJS.ProcessEnv) => Map<ProviderName, IProvider>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ProviderRuntime {
  readonly registry = new ProviderRegistry();
  readonly router: RequestRouter;

  private readonly env: NodeJS.ProcessEnv;
  private readonly loadShards: () => Record<string, unknown>;
  private readonly buildProvidersFn?: ProviderRuntimeDeps['buildProviders'];

  private providers = new Map<ProviderName, IProvider>();
  private shards: Record<string, unknown> = {};
  private initializedSet = new Set<ProviderName>();
  private initErrors = new Map<ProviderName, string>();
  /** 各 Provider 最近一次 listModels 的元数据缓存（/v1/models 聚合用，避免热路径打 sidecar）。 */
  private modelCache = new Map<ProviderName, OpenAIModel[]>();
  private upstreamPriority: ProviderName[] = [...DEFAULT_PRIORITY];

  constructor(deps: ProviderRuntimeDeps = {}) {
    this.env = deps.env ?? process.env;
    this.loadShards = deps.loadShards ?? (() => readRawConfigFile().providers as Record<string, unknown> ?? {});
    this.buildProvidersFn = deps.buildProviders;
    this.router = new RequestRouter({
      upstreamPriority: this.upstreamPriority,
      isProviderEnabled: (name) => this.providers.get(name)?.isEnabled() ?? false,
      registry: this.registry,
    });
  }

  // ─── 生命周期 ───────────────────────────────────────────────────────────────

  /**
   * 读分片 → 构建并初始化各 Provider（按需、尽力而为）→ 刷新注册表。
   * 单个 Provider 初始化失败不阻断其余（记入 initErrors，/api/providers 可见）。
   */
  async initialize(): Promise<void> {
    this.shards = this.loadShards() ?? {};
    const routing = (this.shards.routing ?? {}) as Record<string, unknown>;
    if (Array.isArray(routing.upstreamPriority)) {
      const valid = routing.upstreamPriority.filter(
        (n): n is ProviderName => (ALL_PROVIDERS as readonly string[]).includes(String(n)),
      );
      // 就地替换：router 持有同一数组引用，重赋值会让路由器读到旧序（T213 阶段 2 修）。
      if (valid.length > 0) this.upstreamPriority.splice(0, this.upstreamPriority.length, ...valid);
    }
    // routing.defaultProvider：priority 兜底序的第一位（§3.3 步骤 6）。
    if (typeof routing.defaultProvider === 'string' && (ALL_PROVIDERS as readonly string[]).includes(routing.defaultProvider)) {
      const first = routing.defaultProvider as ProviderName;
      this.upstreamPriority.splice(0, this.upstreamPriority.length, first, ...this.upstreamPriority.filter((n) => n !== first));
    }

    if (this.buildProvidersFn) {
      this.providers = this.buildProvidersFn(this.shards, this.env);
    } else {
      this.providers = this.defaultBuild();
    }

    for (const name of ALL_PROVIDERS) {
      const provider = this.providers.get(name);
      if (!provider) continue;
      if (!this.isConfigured(name)) continue;
      try {
        await provider.initialize(this.shards[name]);
        this.initializedSet.add(name);
      } catch (err) {
        // 尽力而为：一个上游缺席不拖垮网关三源启动；健康面/面板会反映。
        this.initErrors.set(name, messageOf(err));
        logger.warn(`[PVD:runtime] ${name} initialize failed: ${messageOf(err)}`);
      }
    }
    await this.refreshRegistry();
  }

  async destroy(): Promise<void> {
    for (const provider of this.providers.values()) {
      try {
        await provider.destroy();
      } catch (err) {
        logger.warn(`[PVD:runtime] destroy error: ${messageOf(err)}`);
      }
    }
    this.initializedSet.clear();
  }

  // ─── 查询 / 总闸 ────────────────────────────────────────────────────────────

  get(name: ProviderName): IProvider | undefined {
    return this.providers.get(name);
  }

  names(): ProviderName[] {
    return ALL_PROVIDERS.filter((n) => this.providers.has(n));
  }

  isConfigured(name: ProviderName): boolean {
    if (name === 'commandcode') return true;
    if (name === 'freebuff') {
      return !!this.shards[name] || !!this.env.FREEBUFF_TOKENS;
    }
    return (
      !!this.shards[name] ||
      !!this.env[WORKBUDDY_SIDECAR_BIN_ENV] ||
      !!this.env[WORKBUDDY_SIDECAR_PORT_ENV] ||
      !!this.env[WORKBUDDY_SIDECAR_KEY_ENV]
    );
  }

  isEnabled(name: ProviderName): boolean {
    return this.providers.get(name)?.isEnabled() ?? false;
  }

  /** 面板总闸（热生效，仅运行期；持久化随 T213 阶段 2 的统一配置源落地）。 */
  enable(name: ProviderName): boolean {
    const p = this.providers.get(name);
    if (!p) return false;
    p.enable();
    return true;
  }

  disable(name: ProviderName): boolean {
    const p = this.providers.get(name);
    if (!p) return false;
    p.disable();
    return true;
  }

  /** 当前兜底序的第一位（= 面板「默认上游」）。 */
  get defaultProvider(): ProviderName {
    return this.upstreamPriority[0];
  }

  /**
   * 面板手动切换默认上游（T213 DoD：2s 内对新请求生效——本方法即时生效，
   * router 共享同一数组引用）。持久化由调用方经 saveConfigFile 落 `routing`。
   */
  setDefaultProvider(name: ProviderName): boolean {
    if (!(ALL_PROVIDERS as readonly string[]).includes(name)) return false;
    this.upstreamPriority.splice(0, this.upstreamPriority.length, name, ...this.upstreamPriority.filter((n) => n !== name));
    return true;
  }

  // ─── 目录 / 状态 ────────────────────────────────────────────────────────────

  /**
   * 刷新统一模型注册表与元数据缓存。
   * CommandCode 的目录**不入注册表**：它是兜底上游，裸名经 priority 兜底同样落到它，
   * 入表只会放大歧义面（其目录随套餐变化大，缓存失真风险高）——这是本阶段的
   * 刻意决策，阶段 2 若接 routing.upstreamPriority 热配置再复评。
   */
  async refreshRegistry(): Promise<void> {
    for (const name of ALL_PROVIDERS) {
      const provider = this.providers.get(name);
      if (!provider || !this.initializedSet.has(name) || !provider.isEnabled()) continue;
      if (name === 'commandcode') continue;
      try {
        const models = await provider.listModels();
        this.registry.setProviderModels(name, models);
        this.modelCache.set(name, models);
      } catch (err) {
        logger.warn(`[PVD:runtime] ${name} listModels failed: ${messageOf(err)}`);
      }
    }
  }

  /**
   * `/v1/models` 的命名空间聚合条目（`freebuff/<id>` / `workbuddy/<id>`）。
   * 只含：已初始化 + isEnabled + 分片存在且 enabled !== false 的 Provider。
   * 读的是 refreshRegistry 的缓存——本端点是客户端连接时的热路径，不打 sidecar。
   */
  namespacedModels(): OpenAIModel[] {
    const out: OpenAIModel[] = [];
    for (const name of ALL_PROVIDERS) {
      if (name === 'commandcode') continue;
      const provider = this.providers.get(name);
      if (!provider || !this.initializedSet.has(name) || !provider.isEnabled()) continue;
      const shard = this.shards[name] as Record<string, unknown> | undefined;
      if (!shard || shard.enabled === false) continue;
      for (const model of this.modelCache.get(name) ?? []) {
        out.push({ ...model, id: `${name}/${model.id}` });
      }
    }
    return out;
  }

  /** 管理面状态视图（/api/providers 数据源；health 全部读缓存/本地，不做网络 IO）。 */
  async status(): Promise<ProviderStatusView[]> {
    const out: ProviderStatusView[] = [];
    for (const name of this.names()) {
      const provider = this.providers.get(name)!;
      let health: ProviderHealth;
      try {
        health = await provider.health();
      } catch {
        health = { healthy: false, total: 0, cooldownCount: 0, disabledCount: 0 };
      }
      const view: ProviderStatusView = {
        name,
        displayName: provider.displayName,
        enabled: provider.isEnabled(),
        configured: this.isConfigured(name),
        initialized: this.initializedSet.has(name),
        health,
      };
      const sidecar = (provider as { sidecarStatus?: () => SidecarView | null }).sidecarStatus?.();
      if (sidecar) view.sidecar = sidecar;
      const initError = this.initErrors.get(name);
      if (initError) view.initError = initError;
      out.push(view);
    }
    return out;
  }

  // ─── 内部 ───────────────────────────────────────────────────────────────────

  private defaultBuild(): Map<ProviderName, IProvider> {
    const map = new Map<ProviderName, IProvider>();
    map.set('commandcode', new CommandCodeProvider());
    map.set('freebuff', new FreebuffProvider());
    map.set('workbuddy', new WorkBuddyProvider({ env: this.env }));
    return map;
  }
}
