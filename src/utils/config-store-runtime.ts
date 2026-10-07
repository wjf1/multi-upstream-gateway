// =============================================================================
// UnifiedConfigStore 运行时装配（T213b 配置源收口）
// -----------------------------------------------------------------------------
// T105 移植的 UnifiedConfigStore 此前只有类定义、无运行时消费者 —— 限流
// （rate-limiter.ts）与 modelAccess（model-access.ts）直读 env，形成
// 「schema 已定义但无人喂值」的双轨。本模块把它装配成进程单例：
//   - start()：加载 config.json（unified 形态）+ chokidar 热重载（防抖 200ms）；
//   - 把非空的 `rateLimit` 分片注入 security-guard 的滑动窗限流器
//     （reconfigureRateLimiter）；分片为空时**回退 env 兜底**（双向确定性，
//     缺省部署零破坏 —— config.json 没有 rateLimit 分片时行为与收口前一致）；
//   - modelAccess 的消费在 model-access.ts（store 优先、env 回退，同口径）。
//
// 失败语义：bootstrap 失败（文件缺失/Zod 校验不过）只告警并维持 env 兜底，
// **不阻断启动** —— 配置源升级不得让网关起不来。
// =============================================================================
import { CONFIG_FILE_PATH, ENV_FILE_PATH, resolveBodyLimit } from './config.js';
import { UnifiedConfigStore, type UnifiedConfig } from './unified-config.js';
import { reconfigureRateLimiter, resolveRateLimitConfigFromEnv } from './rate-limiter.js';
import { logger } from './logger.js';

let store: UnifiedConfigStore | null = null;

/** 当前运行时 store（未装配返回 null；消费方据此回退 env）。 */
export function getUnifiedConfigStore(): UnifiedConfigStore | null {
  return store;
}

function hasRateLimitSection(cfg: UnifiedConfig): boolean {
  const rl = cfg.rateLimit;
  if (!rl) return false;
  const g = rl.global ?? {};
  if (g.rpm !== undefined || g.tpm !== undefined) return true;
  return Object.keys(rl.perProvider ?? {}).length > 0;
}

/**
 * 运行期旋钮应用（启动 + 每次热重载）：store 的 rateLimit 分片非空 → 注入
 * 限流器；为空 → 回到 env 兜底配置。**双向都确定性**——删掉分片即回到 env 语义。
 */
function applyRuntimeKnobs(cfg: UnifiedConfig): void {
  if (hasRateLimitSection(cfg)) {
    reconfigureRateLimiter({ global: cfg.rateLimit.global, perProvider: cfg.rateLimit.perProvider });
    logger.info('[CONFIG-STORE] rateLimit 分片已注入限流器（store 优先）。');
  } else {
    reconfigureRateLimiter(resolveRateLimitConfigFromEnv());
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 进程单例装配（幂等）。失败不抛 —— 维持 env 兜底。 */
export async function bootstrapConfigStore(): Promise<UnifiedConfigStore | null> {
  if (store) return store;
  try {
    const s = new UnifiedConfigStore({
      configFilePath: CONFIG_FILE_PATH,
      envFilePath: ENV_FILE_PATH,
      maxBodySizeFallbackBytes: resolveBodyLimit(),
    });
    await s.start();
    store = s;
    applyRuntimeKnobs(s.get());
    s.onChange(applyRuntimeKnobs);
    s.onLoadError((msg) => logger.warn(`[CONFIG-STORE] 热重载失败（保留旧配置）：${msg}`));
    logger.info('[CONFIG-STORE] UnifiedConfigStore 已装配（热重载开启；rateLimit/modelAccess 可由 config.json 驱动）。');
    return s;
  } catch (err) {
    logger.warn(`[CONFIG-STORE] bootstrap 失败（运行期旋钮维持 env 兜底）：${messageOf(err)}`);
    store = null;
    return null;
  }
}

/** 优雅停止（进程退出路径调用；释放 chokidar watcher）。 */
export async function shutdownConfigStore(): Promise<void> {
  if (!store) return;
  const s = store;
  store = null;
  try {
    await s.stop();
  } catch (err) {
    logger.warn(`[CONFIG-STORE] stop 失败：${messageOf(err)}`);
  }
}

/** 测试钩子：丢弃单例（不 stop watcher —— 测试自管生命周期）。 */
export function __resetConfigStoreForTest(): void {
  store = null;
}
