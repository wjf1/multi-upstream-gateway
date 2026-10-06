// =============================================================================
// Freebuff 远程模型注册表（T201）
// -----------------------------------------------------------------------------
// 对应 Go 原版 Quorinex/Freebuff2API@a1c1035 models.go：
//   - models.go:17-20   常量 freeAgentsSourceURL / modelRefreshInterval(6h)
//   - models.go:22-33   hardcodedFallback（网络失败时的兜底目录）
//   - models.go:51-59   NewModelRegistry
//   - models.go:61-85   Start（首刷失败 → fallback；6h 定时刷新）
//   - models.go:92-126  Models / HasModel / AgentForModel / AgentIDs
//   - models.go:128-166 refresh（safeFetch 拉取 free-agents.ts 源码）
//   - models.go:168-178 loadFallback
//   - models.go:180-202 parseAllFreeModels（正则块解析）
//   - models.go:204-222 buildModelMapping（model → agent 反查 + 排序去重）
//
// 契约要点（T201 DoD）：远程失败必须能兜底，**不得让 Provider 起不来** ——
// 首刷异常只落 fallback 并告警，start() 永不抛。
//
// 与 Go 的刻意偏差（已在报告登记）：
//   - Go buildModelMapping 对「一个 model 被多个 agent 声明」用 rand.Intn 随机
//     选 agent；TS 改为取排序后的第一个 agent，保证路由可复现、快照稳定。
//     功能等价（这些 agent 都声明支持该 model），T203 若要负载分散再改回。
// =============================================================================

import { logger } from '../../utils/logger.js';
import { safeFetch } from '../../utils/safe-fetch.js';
import type { FreebuffConfig } from './types.js';

/** models.go:19 modelRefreshInterval = 6h。 */
export const MODEL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 注册表单次刷新的网络等待上限（Go main.go:241 http.Client Timeout=15s）。 */
const REGISTRY_FETCH_TIMEOUT_MS = 15_000;

/** models.go:23-33 hardcodedFallback（逐字对应，顺序保持）。 */
export const HARDCODED_FALLBACK: Record<string, string[]> = {
  'base2-free': ['minimax/minimax-m2.7', 'z-ai/glm-5.1'],
  'file-picker': ['google/gemini-2.5-flash-lite'],
  'file-picker-max': ['google/gemini-3.1-flash-lite-preview'],
  'file-lister': ['google/gemini-3.1-flash-lite-preview'],
  'researcher-web': ['google/gemini-3.1-flash-lite-preview'],
  'researcher-docs': ['google/gemini-3.1-flash-lite-preview'],
  basher: ['google/gemini-3.1-flash-lite-preview'],
  'editor-lite': ['minimax/minimax-m2.7', 'z-ai/glm-5.1'],
  'code-reviewer-lite': ['minimax/minimax-m2.7', 'z-ai/glm-5.1'],
};

// ─── 解析（models.go:180-222）────────────────────────────────────────────────

/** models.go:182 块正则：'<agentId>': new Set([ ... ]) */
const BLOCK_PATTERN = /'([^']+)':\s*new\s+Set\(\[([^\]]*)\]\)/g;
/** models.go:183 模型名正则：'<model>' */
const MODEL_PATTERN = /'([^']+)'/g;

/**
 * models.go:181 parseAllFreeModels —— 从 free-agents.ts 源码抽出全部
 * agent → models 映射。空字符串模型名被丢弃；无模型的 agent 不入表。
 */
export function parseAllFreeModels(source: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const block of String(source ?? '').matchAll(BLOCK_PATTERN)) {
    const agentId = block[1];
    const models: string[] = [];
    for (const m of block[2].matchAll(MODEL_PATTERN)) {
      const model = m[1].trim();
      if (model) models.push(model);
    }
    if (models.length > 0) result[agentId] = models;
  }
  return result;
}

/**
 * models.go:206 buildModelMapping —— 生成 model→agent 反查与去重排序后的模型表。
 * TS 侧对同名多 agent 取排序后第一个（见文件头偏差说明）。
 */
export function buildModelMapping(agentModels: Record<string, string[]>): {
  modelToAgent: Record<string, string>;
  allModels: string[];
} {
  const modelAgents = new Map<string, string[]>();
  for (const [agentId, models] of Object.entries(agentModels)) {
    for (const model of models) {
      const list = modelAgents.get(model);
      if (list) list.push(agentId);
      else modelAgents.set(model, [agentId]);
    }
  }

  const modelToAgent: Record<string, string> = {};
  for (const [model, agents] of modelAgents) {
    modelToAgent[model] = [...agents].sort()[0];
  }
  const allModels = [...modelAgents.keys()].sort();
  return { modelToAgent, allModels };
}

// ─── 注册表 ──────────────────────────────────────────────────────────────────

export interface ModelRegistryDeps {
  /** 注入式取源：默认走 safeFetch（tests 可注入本地 mock）。 */
  fetchSource?: (url: string, signal: AbortSignal) => Promise<string>;
}

export class ModelRegistry {
  private agentModels: Record<string, string[]> = {};
  private modelToAgent: Record<string, string> = {};
  private allModels: string[] = [];
  private lastOk = 0;
  /** 目录来源：'remote' | 'fallback' | 'empty'（诊断用）。 */
  private sourceKind: 'remote' | 'fallback' | 'empty' = 'empty';
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 列表输出里的 created 时间戳（epoch 秒，构造时固化，保证可复现）。 */
  readonly createdAtSec = Math.floor(Date.now() / 1000);

  constructor(
    private readonly cfg: FreebuffConfig,
    private readonly deps: ModelRegistryDeps = {},
  ) {}

  /**
   * models.go:61 Start —— 首刷（失败落 fallback），随后按 6h 定时刷新。
   * 永不抛：注册表不可用不能拖垮 Provider 启动。
   */
  async start(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      logger.warn(
        `[PVD:freebuff] model registry initial fetch failed, loading hardcoded fallback: ${messageOf(err)}`,
      );
      this.loadFallback();
    }
    this.timer = setInterval(() => {
      void this.refresh().catch((err) => {
        logger.warn(`[PVD:freebuff] model registry refresh failed: ${messageOf(err)}`);
      });
    }, MODEL_REFRESH_INTERVAL_MS);
    // 不因定时器持有事件循环（等价 Go 的 goroutine + stopCh，但无需显式 stop）。
    this.timer.unref?.();
  }

  /** models.go:87 Stop。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** models.go:93 Models（去重排序副本）。 */
  models(): string[] {
    return [...this.allModels];
  }

  /** models.go:117 AgentIDs（保持解析/回退插入序）。 */
  agentIds(): string[] {
    return Object.keys(this.agentModels);
  }

  /** models.go:102 HasModel。 */
  hasModel(model: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.modelToAgent, model);
  }

  /** models.go:110 AgentForModel。 */
  agentForModel(model: string): string | undefined {
    return this.modelToAgent[model];
  }

  /** 诊断：最近一次成功刷新的时刻（epoch ms；0 = 从未成功）。 */
  get lastOkAt(): number {
    return this.lastOk;
  }

  /** 诊断：当前目录来源。 */
  get source(): 'remote' | 'fallback' | 'empty' {
    return this.sourceKind;
  }

  /** models.go:128 refresh —— 拉取 free-agents.ts 并重建映射；失败抛错。 */
  async refresh(): Promise<void> {
    const text = await this.fetchSource(this.cfg.modelRegistryUrl);
    const all = parseAllFreeModels(text);
    if (Object.keys(all).length === 0) {
      throw new Error('no free agents found in source');
    }
    const { modelToAgent, allModels } = buildModelMapping(all);
    this.agentModels = all;
    this.modelToAgent = modelToAgent;
    this.allModels = allModels;
    this.lastOk = Date.now();
    this.sourceKind = 'remote';
    logger.info(
      `[PVD:freebuff] model registry: updated ${Object.keys(all).length} agents, ${allModels.length} models`,
    );
  }

  /** models.go:168 loadFallback。 */
  loadFallback(): void {
    const { modelToAgent, allModels } = buildModelMapping(HARDCODED_FALLBACK);
    this.agentModels = HARDCODED_FALLBACK;
    this.modelToAgent = modelToAgent;
    this.allModels = allModels;
    this.sourceKind = 'fallback';
    logger.info(`[PVD:freebuff] model registry: loaded fallback models: ${allModels.join(', ')}`);
  }

  /** 单次取源：默认 safeFetch（含逐跳 SSRF 校验），失败抛错。 */
  private async fetchSource(url: string): Promise<string> {
    if (this.deps.fetchSource) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REGISTRY_FETCH_TIMEOUT_MS);
      try {
        return await this.deps.fetchSource(url, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REGISTRY_FETCH_TIMEOUT_MS);
    try {
      const res = await safeFetch(url, {
        method: 'GET',
        headers: { accept: 'text/plain' },
        signal: controller.signal,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`unexpected status ${res.status}`);
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
