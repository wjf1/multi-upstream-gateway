// =============================================================================
// Freebuff 账号凭据持久化（T203）
// -----------------------------------------------------------------------------
// 执行依据：master-plan v1.2 §3.7-2（凭据加密-at-rest）与 T203 卡
//   「把 Freebuff 的多 Token 接入 T103 的加密存储（addAccount 写入加密库、
//     启动时读回），而不是只留在内存/环境变量。环境变量 FREEBUFF_TOKENS 作为
//     引导通道保留，但面板/API 新增的账号必须进加密库。」
//
// 设计要点：
//   - 复用 T103 的 CredentialStore（AES-256-GCM），不新增依赖、不新造加密；
//   - Freebuff 账号以 `{ id, provider:'freebuff', apiKey:<token>, name, addedAt }`
//     形态存于同一个加密库（与 commandcode 账号共库，按 provider 字段区分）；
//   - **合并写**：upsert/remove 都先 load 全量、只改 freebuff 条目、再整体 save，
//     绝不覆盖其它 Provider 的账号（多 Provider 共库的关键纪律）；
//   - 无密钥/无库时 load 返回 []（引导通道 FREEBUFF_TOKENS 仍可用）；
//     addAccount 落库失败只告警不抛（运行期可用性优先），由 T213 面板提示。
// =============================================================================

import { logger } from '../../utils/logger.js';
import { CredentialStore } from '../../utils/credential-store.js';

/** 账号记录里的 provider 标识（与 ProviderName 对齐）。 */
export const FREEBUFF_PROVIDER_ID = 'freebuff';

/** 加密库中的 Freebuff 账号记录（apiKey 即上游 Bearer Token）。 */
export interface FreebuffStoredAccount {
  /** 池内唯一 ID（= TokenPool.name，如 token-1）。 */
  id: string;
  provider: typeof FREEBUFF_PROVIDER_ID;
  /** 凭据本体（上游 Bearer Token）；at-rest 由 CredentialStore 加密。 */
  apiKey: string;
  name: string;
  addedAt: string;
}

/** 判定一条库内记录是否为 Freebuff 账号。 */
export function isFreebuffAccount(record: Record<string, unknown>): boolean {
  if (!record || typeof record !== 'object') return false;
  if (record.provider === FREEBUFF_PROVIDER_ID) return true;
  // 兼容：未标 provider 但带 freebuff 前缀 id / 名字的记录视为 freebuff。
  const id = String(record.id ?? '');
  return typeof record.apiKey === 'string' && Boolean(record.apiKey.trim()) && id.startsWith('freebuff');
}

function toStoredAccount(record: Record<string, unknown>): FreebuffStoredAccount | null {
  const id = String(record.id ?? '').trim();
  const apiKey = String(record.apiKey ?? '').trim();
  if (!id || !apiKey) return null;
  return {
    id,
    provider: FREEBUFF_PROVIDER_ID,
    apiKey,
    name: String(record.name ?? `Freebuff ${id}`),
    addedAt: String(record.addedAt ?? new Date().toISOString()),
  };
}

/**
 * Freebuff 账号存储：CredentialStore 的 Freebuff 视图。
 *
 * 所有写操作走「load 全量 → 改 freebuff 子集 → save 全量」，保证与
 * commandcode 账号共库时不互相踩踏。
 */
export class FreebuffAccountStore {
  constructor(private readonly store: CredentialStore) {}

  /** 库中全部 Freebuff 账号（无密钥/无库 → []）。 */
  load(): FreebuffStoredAccount[] {
    let records: Array<Record<string, unknown>>;
    try {
      records = this.store.load();
    } catch (err) {
      logger.warn(`[PVD:freebuff] credential store unreadable for freebuff accounts: ${messageOf(err)}`);
      return [];
    }
    const out: FreebuffStoredAccount[] = [];
    for (const record of records) {
      if (!isFreebuffAccount(record)) continue;
      const account = toStoredAccount(record);
      if (account) out.push(account);
    }
    return out;
  }

  /** 库中全部 Freebuff Token（保序去重）。 */
  tokens(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const account of this.load()) {
      if (seen.has(account.apiKey)) continue;
      seen.add(account.apiKey);
      out.push(account.apiKey);
    }
    return out;
  }

  /**
   * 新增/覆盖一个 Freebuff 账号（同 id 覆盖），返回落库后的 Freebuff 账号数。
   * 失败抛出（调用方决定是否降级为仅内存）。
   */
  upsert(account: FreebuffStoredAccount): number {
    return this.upsertMany([account]);
  }

  /** 批量新增/覆盖。 */
  upsertMany(accounts: FreebuffStoredAccount[]): number {
    const incoming = accounts.filter((a) => a.id && a.apiKey);
    if (incoming.length === 0) return this.load().length;
    const all = this.store.load();
    const byId = new Map<string, Record<string, unknown>>();
    for (const record of all) {
      byId.set(String(record.id ?? `__noid_${byId.size}`), record);
    }
    for (const account of incoming) {
      byId.set(account.id, { ...account });
    }
    this.store.save(Array.from(byId.values()));
    return this.load().length;
  }

  /** 按 id 移除（幂等）；返回是否命中。 */
  remove(id: string): boolean {
    const all = this.store.load();
    const kept = all.filter((record) => String(record.id ?? '') !== id);
    if (kept.length === all.length) return false;
    this.store.save(kept);
    return true;
  }

  /** 当前是否具备可用的加密后端（有密钥）。 */
  canPersist(): boolean {
    return this.store.hasKey();
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
