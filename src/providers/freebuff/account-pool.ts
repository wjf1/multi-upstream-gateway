// =============================================================================
// Freebuff 账号池 —— IAccountPool 契约实现（T203）
// -----------------------------------------------------------------------------
// 执行依据：master-plan v1.2 §3.4（预占租约；锁内 inFlight++、锁外发请求、
// 失败回滚）与 src/providers/core/interface.ts 的 IAccountPool<T>。
//
// 取舍（详见 T203 报告）：
//   - 内部仍以 T201 的 RunManager / TokenPool 为调度核心（Go run_manager.go
//     的 lease/inflight/draining 语义已在此落地），本类只做**契约适配**——
//     把 RunLease{pool,run} 包成 AccountLease<FreebuffAccount>，把
//     LeaseResult('success'|'error'|'ratelimit') 翻译为池的冷却/释放动作。
//     不另起一套调度器，避免与 T201 的双份状态漂移。
//   - 未引入 async-mutex：JS 单线程 + 临界区不含 await，等价 Go sync.Mutex
//     （T201 已在文件头论证），符合"不新增运行时依赖"。
//   - 模型→agent 的解析由外部注入（Registry 归 Provider 持有），池本身不感知
//     模型目录；无法解析时抛 MODEL_NOT_FOUND（与 provider.chatCompletion 同口径）。
// =============================================================================

import type {
  AccountLease,
  BaseAccount,
  IAccountPool,
  LeaseResult,
  PoolSnapshot,
  ProviderName,
  RoutingContext,
} from '../core/interface.js';
import { ErrorCode, ProxyError } from '../../utils/errors.js';
import { isWaitingRoomError } from './types.js';
import { RunManager, type RunLease } from './run-manager.js';

/** 账号在池中的最小公共面（IAccountPool 要求 BaseAccount）。 */
export interface FreebuffAccount extends BaseAccount {
  /** 展示名（含 Provider 前缀）。 */
  name: string;
}

/** 依次剥离 `freebuff/` 命名空间前缀后交给 agentResolver。 */
function candidateModels(model: string): string[] {
  const raw = String(model ?? '').trim();
  const out = [raw];
  const prefix = 'freebuff/';
  if (raw.toLowerCase().startsWith(prefix)) out.push(raw.slice(prefix.length));
  return out;
}

export class FreebuffAccountPool implements IAccountPool<FreebuffAccount> {
  /** leaseId → 内部 RunLease（releaseLease 归还用）。 */
  private readonly leases = new Map<string, RunLease>();
  private leaseSeq = 0;

  constructor(
    private readonly runs: RunManager,
    private readonly resolveAgentId: (model: string) => string | undefined,
    readonly name: ProviderName = 'freebuff',
  ) {}

  /** 选号并预占租约（T201 acquire 是唯一选号点，此处沿用其 Round-robin/selector）。 */
  async selectAccount(ctx: RoutingContext): Promise<AccountLease<FreebuffAccount>> {
    const agentId = candidateModels(ctx.model)
      .map((model) => this.resolveAgentId(model))
      .find((id): id is string => Boolean(id));
    if (!agentId) {
      throw new ProxyError(ErrorCode.MODEL_NOT_FOUND, `freebuff does not serve model "${ctx.model}"`, {
        context: { requestId: ctx.requestId, model: ctx.model },
      });
    }

    let lease: RunLease;
    try {
      lease = await this.runs.acquire(agentId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ProxyError(
        ErrorCode.UPSTREAM_ACCOUNT_UNAVAILABLE,
        `no healthy freebuff account available (${detail})`,
        {
          status: isWaitingRoomError(err) ? 503 : undefined,
          retryable: true,
          context: { requestId: ctx.requestId, agentId },
        },
      );
    }

    const leaseId = `${lease.pool.name}#${lease.run.id}#${(this.leaseSeq += 1)}`;
    this.leases.set(leaseId, lease);
    return {
      account: {
        id: lease.pool.name,
        label: `Freebuff ${lease.pool.name}`,
        name: `Freebuff ${lease.pool.name}`,
        enabled: lease.pool.enabled,
      },
      leaseId,
      acquiredAt: Date.now(),
    };
  }

  /** 归还租约：成功率清零失败计数；ratelimit 施加指数退避软冷却（§3.4）。 */
  releaseLease(lease: AccountLease<FreebuffAccount>, result: LeaseResult): void {
    const runLease = this.leases.get(lease.leaseId);
    if (!runLease) return;
    this.leases.delete(lease.leaseId);

    if (result === 'ratelimit') {
      runLease.pool.noteFailure('release lease reported rate limit');
    } else if (result === 'success') {
      runLease.pool.noteSuccess();
    }
    // error：仅释放，不冷却（具体分类由 Provider 决定冷却动作）。

    void this.runs.release(runLease).catch(() => {
      /* release 内部已记日志；租约归还失败不影响调用方 */
    });
  }

  /** 池状态快照（面板账号页数据源）。 */
  snapshot(): PoolSnapshot {
    const now = Date.now();
    const snaps = this.runs.snapshots();
    const accounts: PoolSnapshot['accounts'] = snaps.map((s) => {
      const pool = this.runs.getPool(s.name);
      return {
        id: s.name,
        label: `Freebuff ${s.name}`,
        state: pool ? pool.healthState(now) : 'HEALTHY',
        enabled: pool?.enabled ?? false,
      };
    });
    const cooldown = accounts.filter((a) => a.state === 'COOLING').length;
    const disabled = accounts.filter((a) => a.state === 'PAUSED').length;
    const inFlight = snaps.reduce((sum, s) => sum + s.runs.reduce((acc, r) => acc + r.inflight, 0), 0);
    return {
      total: accounts.length,
      healthy: accounts.filter((a) => a.state === 'HEALTHY').length,
      cooldown,
      disabled,
      inFlight,
      accounts,
    };
  }
}
