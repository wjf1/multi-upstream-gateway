// =============================================================================
// WorkBuddy Sidecar 进程管理（T204'，联邦路线 3.11-1）
// -----------------------------------------------------------------------------
// 联邦裁决（G0-T2，见 docs/wb-source-diff-report.md §7）下，WorkBuddy 的选号骨架、
// 四维冷却/熔断状态机、payload 改写管线全部由 Go sidecar 内置承接；网关侧只负责
// **把二进制拉起来、看住它、探活、崩溃自动重启**。
//
// 契约（§3.11-1）：以子进程拉起 Go 二进制（路径/端口可配），健康检查 + 崩溃自动
// 重启（5min 内 3 次），随主进程退出。
//
// sidecar 真实端点（核自 workbuddy2api-panel/internal/server/handler.go）：
//   GET /healthz        —— 恒无鉴权，200=可服务 / 503=池不可服务
//   GET /status         —— Bearer 鉴权，池与管理汇总
//   GET /v1/models      —— Bearer 鉴权
//   POST /v1/chat/completions —— Bearer 鉴权
//
// 全部外部副作用（spawn / fetch / 时钟 / 睡眠）均可注入，测试无需真的拉起进程。
// =============================================================================
import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../../utils/logger.js';

export type SidecarState = 'stopped' | 'starting' | 'running' | 'crashed';

/** 崩溃重启策略（§3.11-1：5min 内 3 次）。 */
export interface SidecarRestartPolicy {
  maxRestarts: number;
  windowMs: number;
}

export const DEFAULT_SIDECAR_RESTART_POLICY: SidecarRestartPolicy = {
  maxRestarts: 3,
  windowMs: 5 * 60_000,
};

export interface SidecarStatus {
  state: SidecarState;
  pid: number | null;
  /** 累计重启次数（不含首次启动）。 */
  restarts: number;
  /** 最近一次探活结果（不做额外 IO，读缓存）。 */
  healthy: boolean;
  lastError?: string;
  baseUrl: string;
}

export interface WorkBuddySidecarOptions {
  /** sidecar 二进制绝对路径（配置分片 `sidecar.binPath` 或环境变量）。 */
  binPath: string;
  /** 传给二进制的附加参数（如 `--listen` / `--api-key`）。 */
  args?: string[];
  /** sidecar 监听端口（回环）。 */
  port: number;
  host?: string;
  /** 探活路径（默认 `/healthz`）。 */
  healthPath?: string;
  /** 启动后等待首个健康响应的上限（默认 15s）。 */
  startTimeoutMs?: number;
  /** 健康轮询间隔（默认 250ms）。 */
  healthIntervalMs?: number;
  /** 单次探活请求超时（默认 3s）。 */
  probeTimeoutMs?: number;
  restartPolicy?: SidecarRestartPolicy;
  /** 是否安装「主进程退出即杀掉 sidecar」钩子（默认 true；测试可关）。 */
  attachProcessExitHook?: boolean;
  // ── 依赖注入（测试用） ──
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Go sidecar 生命周期管理器。
 *
 * 状态机：`stopped → starting → running`；进程意外退出时若在重启策略内则回到
 * `starting` 并 +1 重启计数，否则进入 `crashed`（此时 health() 恒 false，面板可见）。
 * `stop()` 是**有意停止**，不再触发重启。
 */
export class WorkBuddySidecar {
  private readonly opts: Required<Pick<WorkBuddySidecarOptions, 'binPath' | 'port' | 'host' | 'healthPath' | 'startTimeoutMs' | 'healthIntervalMs' | 'probeTimeoutMs' | 'restartPolicy'>>;
  private readonly args: string[];
  private readonly spawnFn: typeof spawn;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private child: ChildProcess | null = null;
  private state: SidecarState = 'stopped';
  private healthy = false;
  private restarts = 0;
  private lastError: string | undefined;
  private restartStamps: number[] = [];
  private intentionalStop = false;
  private startPromise: Promise<void> | null = null;

  constructor(options: WorkBuddySidecarOptions) {
    this.opts = {
      binPath: options.binPath,
      port: options.port,
      host: options.host ?? '127.0.0.1',
      healthPath: options.healthPath ?? '/healthz',
      startTimeoutMs: options.startTimeoutMs ?? 15_000,
      healthIntervalMs: options.healthIntervalMs ?? 250,
      probeTimeoutMs: options.probeTimeoutMs ?? 3_000,
      restartPolicy: options.restartPolicy ?? DEFAULT_SIDECAR_RESTART_POLICY,
    };
    this.args = options.args ?? [];
    this.spawnFn = options.spawnFn ?? spawn;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

    if (options.attachProcessExitHook !== false) {
      // 随主进程退出：进程被杀时不保证触发，但正常退出与 SIGINT 能覆盖。
      process.once('exit', () => {
        try {
          this.child?.kill('SIGKILL');
        } catch {
          /* 退出路径不抛 */
        }
      });
    }
  }

  get baseUrl(): string {
    return `http://${this.opts.host}:${this.opts.port}`;
  }

  /** 健康状况（缓存，不做网络 IO；探活请用 `health()`）。 */
  get stateName(): SidecarState {
    return this.state;
  }

  status(): SidecarStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      healthy: this.healthy,
      lastError: this.lastError,
      baseUrl: this.baseUrl,
    };
  }

  /**
   * 启动 sidecar 并等待首个健康响应。
   * 已在运行/启动中则幂等返回。启动超时或进程早退会抛错，并留下 `lastError`。
   */
  async start(): Promise<void> {
    if (this.state === 'running') return;
    if (this.startPromise) return this.startPromise;
    this.intentionalStop = false;
    this.startPromise = this.launchAndWait().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  /** 有意停止：不再触发自动重启。 */
  async stop(): Promise<void> {
    this.intentionalStop = true;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch (err) {
        logger.warn(`[PVD:workbuddy] sidecar kill failed: ${messageOf(err)}`);
      }
    }
    this.state = 'stopped';
    this.healthy = false;
  }

  /** 真实探活：一次 `GET {healthPath}` 往返（T303 依赖其真实性）。 */
  async health(): Promise<boolean> {
    if (this.state !== 'running' && this.state !== 'starting') {
      this.healthy = false;
      return false;
    }
    this.healthy = await this.ping();
    return this.healthy;
  }

  // ─── 内部实现 ──────────────────────────────────────────────────────────────

  private async ping(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}${this.opts.healthPath}`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.opts.probeTimeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private launchAndWait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) {
          this.lastError = err.message;
          reject(err);
        } else {
          resolve();
        }
      };

      let child: ChildProcess;
      this.state = 'starting';
      this.healthy = false;
      try {
        child = this.spawnFn(this.opts.binPath, this.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        this.state = 'crashed';
        finish(new Error(`failed to spawn workbuddy sidecar: ${messageOf(err)}`));
        return;
      }

      this.child = child;
      child.on('exit', (code, signal) => {
        this.onChildExit(code, signal);
      });
      child.on('error', (err) => {
        this.lastError = messageOf(err);
        logger.warn(`[PVD:workbuddy] sidecar process error: ${this.lastError}`);
      });
      // 子进程输出转日志（便于排查；sidecar 正常日志也在此）。
      child.stdout?.on('data', (b: Buffer) => logger.info(`[workbuddy] ${String(b).trimEnd()}`));
      child.stderr?.on('data', (b: Buffer) => logger.warn(`[workbuddy] ${String(b).trimEnd()}`));

      // 轮询健康直至就绪或超时。
      const deadline = this.now() + this.opts.startTimeoutMs;
      const poll = async (): Promise<void> => {
        // 早退（进程已退出且未 running）直接失败，不空等到超时。
        if (this.child !== child && !this.intentionalStop) {
          finish(new Error(this.lastError ?? 'workbuddy sidecar exited during startup'));
          return;
        }
        if (await this.ping()) {
          this.state = 'running';
          this.healthy = true;
          logger.info(`[PVD:workbuddy] sidecar healthy at ${this.baseUrl} (pid ${child.pid ?? '?'})`);
          finish();
          return;
        }
        if (this.now() >= deadline) {
          this.state = 'crashed';
          finish(new Error(`workbuddy sidecar did not become healthy within ${this.opts.startTimeoutMs}ms`));
          return;
        }
        await this.sleep(this.opts.healthIntervalMs);
        if (!settled) void poll();
      };
      void poll();
    });
  }

  /** 子进程退出：有意停止 → stopped；否则按策略重启或置 crashed。 */
  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.intentionalStop) {
      this.state = 'stopped';
      this.healthy = false;
      this.child = null;
      return;
    }
    this.child = null;
    this.healthy = false;
    const cause = `sidecar exited (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`;
    this.lastError = cause;
    logger.warn(`[PVD:workbuddy] ${cause}`);

    const now = this.now();
    this.restartStamps = this.restartStamps.filter((t) => now - t < this.opts.restartPolicy.windowMs);
    if (this.restartStamps.length >= this.opts.restartPolicy.maxRestarts) {
      this.state = 'crashed';
      logger.error(
        `[PVD:workbuddy] sidecar crashed ${this.restartStamps.length} times within ` +
          `${Math.round(this.opts.restartPolicy.windowMs / 1000)}s; giving up (manual restart required)`,
      );
      return;
    }
    this.restartStamps.push(now);
    this.restarts += 1;
    logger.info(`[PVD:workbuddy] restarting sidecar (attempt ${this.restarts})`);
    this.launchAndWait().catch((err) => {
      logger.error(`[PVD:workbuddy] sidecar restart failed: ${messageOf(err)}`);
      // 重启失败也走一次退避判定：失败的自重启同样是"退出"，交给 onChildExit 语义。
      this.onChildExit(null, null);
    });
  }
}
