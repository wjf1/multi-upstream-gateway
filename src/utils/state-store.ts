// =============================================================================
// 本地状态持久化（T302，master-plan v1.2 §3.4 / §3.2 storage.statePath）
// -----------------------------------------------------------------------------
// 网关需要一份「重启后仍在」的本地状态（当前是 WorkBuddy 池快照与积分账本；
// T401 的 lastRunAt 也会挂到同一文件）。本模块把三件容易写错的事收敛到一处：
//
//   1. **临界区**：`AsyncMutex` 只保护**内存状态**的读改写，**锁内禁止 IO**
//      （§3.4）；落盘一律在临界区之外串行排队。
//   2. **跨进程文件锁**：`withFileLock` 以 `open(path, 'wx')` 抢占 `<file>.lock`，
//      带 PID 与过期接管（等价 proper-lockfile 的最小实现，避免为此引入依赖）。
//   3. **原子替换**：写同目录唯一临时文件 → fsync → `rename`。任何时刻
//      state.json 要么是旧内容要么是新内容，不存在半截文件（kill -9 友好的前提）。
//
// 损坏判定（JSON 解析失败或 schema 校验失败）**不由本模块自行修复**：它只如实
// 返回 `corrupted` 结论与原因，由调用方决定用哪个数据源重建并告警（T302 的
// DoD「损坏文件恢复测试」）。
// =============================================================================
import fsp from 'fs/promises';
import path from 'path';
import { getProjectRootDir } from './paths.js';
import { logger } from './logger.js';

/** state.json 路径覆盖（测试与多实例隔离用；优先级高于 config）。 */
export const STATE_PATH_ENV = 'COMMANDCODE_STATE_PATH';

/** 默认相对路径，与 `StorageConfigSchema.statePath` 的默认值保持一致。 */
export const DEFAULT_STATE_RELATIVE_PATH = path.join('data', 'state.json');

// ─── 临界区 ────────────────────────────────────────────────────────────────────

/**
 * 最小互斥量：`runExclusive` 内的任务严格串行，前一个 settle 后才放行下一个。
 * 语义与 `async-mutex` 的 `Mutex.runExclusive` 一致——引入依赖只为这点代码不值当。
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();
  private active = 0;

  get locked(): boolean {
    return this.active > 0;
  }

  runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.active += 1;
      try {
        return await fn();
      } finally {
        this.active -= 1;
      }
    };
    const next = this.tail.then(run, run);
    // 队列本身不能因某次任务失败而断链；失败由调用方从返回值感知。
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

// ─── 跨进程文件锁 ──────────────────────────────────────────────────────────────

export interface FileLockOptions {
  /** 锁文件超过该年龄即视为持有者已死，可被接管。默认 10s。 */
  staleMs?: number;
  /** 抢占总超时。默认 5s。 */
  timeoutMs?: number;
  /** 重试间隔。默认 25ms。 */
  retryMs?: number;
  now?: () => number;
}

export class StateLockTimeoutError extends Error {
  constructor(readonly lockPath: string, readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for state lock ${lockPath}`);
    this.name = 'StateLockTimeoutError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 独占执行 `fn`（先抢 `<target>.lock`，结束释放）。
 *
 * 抢占方式：`open(lockPath, 'wx')` 是原子的「不存在才创建」，因此同一时刻只有
 * 一个进程能拿到锁。持锁者进程被 kill -9 时锁文件会残留——由 `staleMs` 接管兜底。
 */
export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const retryMs = opts.retryMs ?? 25;
  const now = opts.now ?? Date.now;
  const lockPath = `${target}.lock`;
  const deadline = now() + timeoutMs;

  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() }), 'utf8');
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // 持有者可能已经被 kill -9：超过 staleMs 的锁按「已死」处理，删掉重抢。
      let mtimeMs: number;
      try {
        mtimeMs = (await fsp.stat(lockPath)).mtimeMs;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') continue; // 刚被释放
        throw statErr;
      }
      if (now() - mtimeMs > staleMs) {
        logger.warn(`[STATE] taking over stale lock ${lockPath}`);
        await fsp.rm(lockPath, { force: true });
        continue;
      }
      if (now() >= deadline) throw new StateLockTimeoutError(lockPath, timeoutMs);
      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    await fsp.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

// ─── 原子 JSON 状态文件 ────────────────────────────────────────────────────────

export type LoadOutcome<T> =
  | { status: 'loaded'; state: T }
  | { status: 'missing' }
  | { status: 'corrupted'; reason: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface JsonStateStoreOptions<T> {
  filePath: string;
  /** schema 校验（zod safeParse 的适配层由调用方提供，本模块不绑 schema 库）。 */
  parse: (raw: unknown) => ParseResult<T>;
  initial: () => T;
  lock?: FileLockOptions;
}

/**
 * 单写者、原子落盘的 JSON 状态文件。
 *
 * 写路径分为两段：内存变更在 `AsyncMutex` 临界区内完成，落盘在临界区外排队
 * （`flush()`），且每次落盘取的是**排队轮到自己时的最新状态**——后发的变更不会
 * 被先发的写入覆盖。
 */
export class JsonStateStore<T> {
  private state: T;
  private loaded = false;
  private lastOutcome: LoadOutcome<T> | null = null;
  private readonly mutex = new AsyncMutex();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: JsonStateStoreOptions<T>) {
    this.state = opts.initial();
  }

  get filePath(): string {
    return this.opts.filePath;
  }

  /** 最近一次 `initialize()` 的结论（`corrupted` 时调用方据此决定重建与告警）。 */
  get outcome(): LoadOutcome<T> | null {
    return this.lastOutcome;
  }

  /** 读盘（不做任何修复）。纯 IO，必须在临界区之外调用。 */
  async read(): Promise<LoadOutcome<T>> {
    let text: string;
    try {
      text = await fsp.readFile(this.opts.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      return { status: 'corrupted', reason: `invalid JSON: ${(err as Error).message}` };
    }
    const parsed = this.opts.parse(raw);
    // 用 `in` 而非 `!parsed.ok` 收窄：`tsconfig.test.json` 关闭了 strict，布尔字面量会被
    // 加宽成 `boolean`，判别式收窄在测试工程里失效（src 工程则正常）。
    if ('error' in parsed) return { status: 'corrupted', reason: parsed.error };
    return { status: 'loaded', state: parsed.value };
  }

  /**
   * 载入状态。文件缺失时落到 `initial()` 并立即落盘（首次运行建基线）；
   * 文件损坏时**保持内存为 `initial()` 且不写盘**——等调用方 `recover()` 用
   * 真实数据源重建，避免用空状态覆盖掉尚可抢救的原文件。
   */
  async initialize(): Promise<LoadOutcome<T>> {
    const outcome = await this.read();
    this.lastOutcome = outcome;
    if (outcome.status === 'loaded') {
      this.state = outcome.state;
      this.loaded = true;
      return outcome;
    }
    this.state = this.opts.initial();
    this.loaded = true;
    if (outcome.status === 'missing') await this.flush();
    return outcome;
  }

  getState(): T {
    return this.state;
  }

  /** 临界区内变更 → 临界区外落盘。返回落盘后的状态引用。 */
  async mutate(fn: (current: T) => T): Promise<T> {
    await this.mutex.runExclusive(() => {
      this.state = fn(this.state);
    });
    await this.flush();
    return this.state;
  }

  /** 用重建结果替换内存状态并落盘（损坏恢复出口）。 */
  async recover(next: T): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.state = next;
    });
    await this.flush();
  }

  /** 落盘（原子替换）。并发调用按调用顺序串行，各自写入轮到自己时的最新状态。 */
  flush(): Promise<void> {
    const run = async (): Promise<void> => {
      await this.writeAtomic(this.state);
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 等待所有排队中的落盘完成（destroy/退出前调用）。 */
  async drain(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }

  private async writeAtomic(state: T): Promise<void> {
    const body = `${JSON.stringify(state, null, 2)}\n`;
    const dir = path.dirname(this.opts.filePath);
    await fsp.mkdir(dir, { recursive: true });
    // 临时文件必须与目标同目录：跨设备 rename 不是原子替换。
    const tmp = `${this.opts.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const handle = await fsp.open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await withFileLock(this.opts.filePath, async () => {
        await fsp.rename(tmp, this.opts.filePath);
      }, this.opts.lock);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}

// ─── 路径解析 ─────────────────────────────────────────────────────────────────

/**
 * state.json 落点：`COMMANDCODE_STATE_PATH` > `storage.statePath`（unified config）
 * > `data/state.json`（相对项目根）。
 */
export async function resolveConfiguredStatePath(explicit?: string): Promise<string> {
  const fromEnv = process.env[STATE_PATH_ENV]?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (explicit && explicit.trim()) return path.resolve(explicit);
  const configured = await readStorageStatePath();
  return path.resolve(getProjectRootDir(), configured ?? DEFAULT_STATE_RELATIVE_PATH);
}

/** 读 `storage.statePath`；config store 未启动（测试/单测）时返回 undefined，不抛。 */
async function readStorageStatePath(): Promise<string | undefined> {
  try {
    const { getUnifiedConfigStore } = await import('./config-store-runtime.js');
    const store = getUnifiedConfigStore();
    const value = store?.get()?.storage?.statePath;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}
