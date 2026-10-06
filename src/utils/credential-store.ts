// =============================================================================
// 凭据加密存储（执行依据：master-plan v1.2 §3.7-2 / 任务卡 T103）
// -----------------------------------------------------------------------------
// 目标：账号凭据（apiKey 等）在磁盘上只以 AES-256-GCM 密文存在，杜绝 at-rest
// 明文。三部分能力：
//   1. encrypt/decrypt —— AES-256-GCM，随机 IV，authTag 完整性校验（篡改必败）；
//      密钥来自环境变量 CREDENTIAL_ENCRYPTION_KEY（64 位 hex = 32 字节）；
//   2. CredentialStore —— file（加密文件，默认源）/ memory（进程内，测试/临时）
//      / env（COMMANDCODE_ACCOUNTS_V1，T102 兼容回退）三后端的 load/save，
//      以及 migratePlaintext（明文 → 加密文件的一次性迁移）；
//   3. assertCredentialsEncryptedOrThrow —— 启动校验：存在凭据而密钥未设置 →
//      抛出带生成密钥指引的错误（拒绝启动，fail-closed）。
//
// 迁移语义（首次带密钥启动）：
//   - .env 的 COMMANDCODE_ACCOUNTS_V1（base64 JSON 明文，T102 迁入）与
//     auths/*.json（若存在、含 apiKey 字段）全部吸收进加密文件；
//   - .env 中该行被原子摘除（其余行保留），process.env 同步清理；
//   - 旧明文 auths/*.json 改名 *.plain.bak 并日志告警提示确认后删除；
//   - 幂等：之后面板保存若再次把明文写回 .env，下次带密钥启动会增量吸收。
//
// Windows 说明：POSIX 下加密文件 chmod 0600；Windows（NTFS）没有 POSIX 权限
// 位，机密性依赖文件所在目录的 ACL——默认路径在用户主目录（%USERPROFILE%\.commandcode）
// 下，其默认 ACL 仅本人与 SYSTEM/Administrators 可访问；若通过
// CREDENTIAL_STORE_PATH 把加密文件放到共享目录，请自行收紧该目录 ACL。
//
// 依赖边界：本文件不得 import config.ts（config.ts 反向依赖本文件，避免循环）；
// .env 路径解析与 config.ts 保持同一逻辑（COMMANDCODE_ENV_PATH > 项目根/.env）。
// =============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';
import { getProjectRootDir } from './paths.js';
import { findEnvAccountsLine, parseEnvAccountsV1, writeEnvAccountsV1 } from './unified-config.js';

/** 加密密钥的环境变量名（64 位 hex，32 字节）。 */
export const ENCRYPTION_KEY_ENV = 'CREDENTIAL_ENCRYPTION_KEY';
/** T102 兼容回退：.env 中明文账号（base64 JSON）的变量名。 */
export const DEFAULT_ENV_VAR = 'COMMANDCODE_ACCOUNTS_V1';

/** 加密文件的磁盘格式（单行 JSON，文件名建议 credentials.enc）。 */
export interface EncryptedPayload {
  /** 格式版本（演进预留）。 */
  v: 1;
  alg: 'aes-256-gcm';
  /** 随机 IV（base64，每次加密新生成）。 */
  iv: string;
  /** GCM authTag（base64，16 字节）。 */
  tag: string;
  /** 密文（base64）。 */
  data: string;
}

// ─── 密钥解析 ────────────────────────────────────────────────────────────────

/** 生成密钥的指引文本（DoD：错误消息必须告知生成方法）。 */
function keyHint(): string {
  return `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" ` +
    `and set it as the ${ENCRYPTION_KEY_ENV} environment variable (e.g. add '${ENCRYPTION_KEY_ENV}=<64-hex>' to .env), then restart.`;
}

/**
 * 解析加密密钥：未设置/空 → null；设置了但非法（非 64 位 hex）→ 抛出带指引的
 * 错误（fail-closed：半配置状态不允许静默降级）。
 */
export function resolveEncryptionKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[ENCRYPTION_KEY_ENV] || '').trim();
  if (!raw) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      `[CREDENTIAL] ${ENCRYPTION_KEY_ENV} is set but invalid: expected exactly 64 hex characters (32 bytes), got ${raw.length} chars. ` +
        keyHint(),
    );
  }
  return raw.toLowerCase();
}

// ─── 加解密（AES-256-GCM）────────────────────────────────────────────────────

/** AES-256-GCM 加密：随机 12 字节 IV，输出 {v,alg,iv,tag,data}。 */
export function encrypt(plaintext: string, keyHex: string): EncryptedPayload {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** AES-256-GCM 解密：authTag 校验失败（篡改/错钥）→ 抛出。 */
export function decrypt(payload: EncryptedPayload, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf-8');
}

// ─── 明文凭据检测（供启动校验）───────────────────────────────────────────────

/** .env 路径解析：与 config.ts 同一逻辑（此处不得 import config.ts，避免循环）。
 *  4.22.4 的 config.ts 用 COMMANDCODE_ENV_FILE_PATH；保留 COMMANDCODE_ENV_PATH
 *  作为兼容别名（移植自 4.17.0 的调用方/测试仍可用旧名）。 */
export function resolveEnvFilePath(): string {
  const override = process.env.COMMANDCODE_ENV_FILE_PATH || process.env.COMMANDCODE_ENV_PATH;
  return override ? path.resolve(override) : path.join(getProjectRootDir(), '.env');
}

/** auths 明文凭据目录（旧版/手工放置的 *.json，任务卡"若存在"场景）。 */
export function resolveAuthDir(): string {
  return path.join(getProjectRootDir(), 'auths');
}

/** 默认加密库路径：用户主目录（Windows 下依赖该目录 ACL，见文件头说明），
 *  可用 CREDENTIAL_STORE_PATH 覆盖。 */
export function resolveDefaultStoreFilePath(): string {
  return process.env.CREDENTIAL_STORE_PATH
    ? path.resolve(process.env.CREDENTIAL_STORE_PATH)
    : path.join(os.homedir(), '.commandcode', 'credentials.enc');
}

export interface PlaintextDetectionOptions {
  envFilePath?: string;
  authDir?: string;
  storeFilePath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PlaintextDetection {
  /** 明文来源描述（env 变量名 / auths 下的文件路径）。 */
  sources: string[];
  /** 加密库文件是否已存在（有库无钥也是"凭据存在而密钥未设置"）。 */
  hasEncryptedStore: boolean;
}

/** 判断 json 内容是否携带凭据（对象含 apiKey，或数组中存在含 apiKey 的元素）。 */
function jsonCarriesCredentials(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const hasKey = (o: unknown): boolean =>
      o !== null && typeof o === 'object' && typeof (o as Record<string, unknown>).apiKey === 'string' &&
      Boolean(String((o as Record<string, unknown>).apiKey).trim());
    if (Array.isArray(parsed)) return parsed.some(hasKey);
    return hasKey(parsed);
  } catch {
    return false;
  }
}

/** 扫描明文凭据来源（.env 的 V1 行 + auths/*.json）与加密库存在性。 */
export function detectPlaintextCredentials(opts: PlaintextDetectionOptions = {}): PlaintextDetection {
  const env = opts.env ?? process.env;
  const envFilePath = opts.envFilePath ?? resolveEnvFilePath();
  const authDir = opts.authDir ?? resolveAuthDir();
  const storeFilePath = opts.storeFilePath ?? resolveDefaultStoreFilePath();
  const sources: string[] = [];

  // 来源 1：T102 迁入的 COMMANDCODE_ACCOUNTS_V1（process.env 优先，.env 文件兜底）
  const envVarValue = env[DEFAULT_ENV_VAR];
  if (envVarValue && parseEnvAccountsV1(envVarValue).length > 0) {
    sources.push(`env:${DEFAULT_ENV_VAR}`);
  } else if (fs.existsSync(envFilePath)) {
    try {
      const { value } = findEnvAccountsLine(fs.readFileSync(envFilePath, 'utf-8'));
      if (value && parseEnvAccountsV1(value).length > 0) sources.push(`env:${DEFAULT_ENV_VAR} (${envFilePath})`);
    } catch { /* 读不了当作没有 */ }
  }

  // 来源 2：auths/*.json 中携带 apiKey 的文件
  try {
    if (fs.existsSync(authDir)) {
      for (const name of fs.readdirSync(authDir)) {
        if (!name.endsWith('.json')) continue;
        const full = path.join(authDir, name);
        try {
          if (jsonCarriesCredentials(fs.readFileSync(full, 'utf-8'))) sources.push(full);
        } catch { /* 单文件失败不阻塞扫描 */ }
      }
    }
  } catch { /* 目录不可读当作没有 */ }

  return { sources, hasEncryptedStore: fs.existsSync(storeFilePath) };
}

// ─── 启动校验 ────────────────────────────────────────────────────────────────

export type StartupCheckOptions = PlaintextDetectionOptions;

/**
 * 启动校验（DoD：存在凭据而密钥未设置 → 抛出带迁移指引的错误，拒绝启动）：
 *   - 密钥有效 → 放行（后续迁移由 migratePlaintext 负责）；
 *   - 密钥非法 → resolveEncryptionKey 抛出（含生成密钥指引）；
 *   - 密钥未设置：已有加密库（凭据在但不可读）或存在明文来源 → 抛出；
 *     两者皆无 → 放行（全新部署，无凭据可保护）。
 */
export function assertCredentialsEncryptedOrThrow(opts: StartupCheckOptions = {}): void {
  const key = resolveEncryptionKey(opts.env ?? process.env);
  if (key) return;
  const detection = detectPlaintextCredentials(opts);
  if (detection.hasEncryptedStore) {
    throw new Error(
      `[CREDENTIAL] Refusing to start: encrypted credential store exists ` +
        `(${opts.storeFilePath ?? resolveDefaultStoreFilePath()}) but ${ENCRYPTION_KEY_ENV} is not set — ` +
        `accounts cannot be decrypted. ` + keyHint(),
    );
  }
  if (detection.sources.length > 0) {
    throw new Error(
      `[CREDENTIAL] Refusing to start: plaintext credentials detected (${detection.sources.join(', ')}) ` +
        `but ${ENCRYPTION_KEY_ENV} is not set. ` + keyHint() +
        ` On the next key-enabled start the plaintext credentials are encrypted automatically ` +
        `(old plaintext files are renamed *.plain.bak).`,
    );
  }
}

// ─── CredentialStore（file / memory / env 三后端）────────────────────────────

export type CredentialBackend = 'file' | 'memory' | 'env';

export interface CredentialStoreOptions {
  backend: CredentialBackend;
  /** file 后端：加密文件路径（默认 resolveDefaultStoreFilePath()）。 */
  filePath?: string;
  /** env 后端：环境变量名（默认 COMMANDCODE_ACCOUNTS_V1）。 */
  envVar?: string;
  /** env 后端：持久化 .env 路径（save 时写盘；load 只读 process.env）。 */
  envFilePath?: string;
  /** 密钥解析器（默认读 process.env，可注入用于测试/自定义来源）。 */
  keyResolver?: () => string | null;
  /** memory 后端：预置账号。 */
  initialMemory?: Array<Record<string, unknown>>;
}

/** 账号合并：同 id 以 patch 侧为准（新明文覆盖旧），无 id 条目原样保留。 */
function mergeAccountsById(
  base: Array<Record<string, unknown>>,
  patch: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const noId: Array<Record<string, unknown>> = [];
  for (const acc of [...base, ...patch]) {
    const id = typeof acc.id === 'string' && acc.id ? acc.id : '';
    if (id) byId.set(id, acc);
    else noId.push(acc);
  }
  return [...byId.values(), ...noId];
}

export interface MigratePlaintextOptions {
  envFilePath?: string;
  authDir?: string;
}

export interface MigrationResult {
  migrated: boolean;
  /** 迁移后加密库中的账号总数。 */
  encryptedCount: number;
  /** 是否摘除了 .env 的 COMMANDCODE_ACCOUNTS_V1 行。 */
  removedEnvLine: boolean;
  /** 被改名 *.plain.bak 的明文文件。 */
  backedUpFiles: string[];
}

/**
 * 三后端凭据存储：
 *   - file：加密文件（AES-256-GCM），POSIX chmod 0600；Windows 依赖用户目录
 *     ACL（见文件头说明）；
 *   - memory：进程内存（重启即失，测试/无盘场景）；
 *   - env：COMMANDCODE_ACCOUNTS_V1（T102 形态，明文 base64 JSON，仅作兼容回退）。
 */
export class CredentialStore {
  private readonly opts: Required<Pick<CredentialStoreOptions, 'backend'>> & CredentialStoreOptions;
  /** file 后端的解密缓存（mtime+size 变化才重读重解，loadConfig 每请求都来）。 */
  private fileCache: { mtimeMs: number; size: number; accounts: Array<Record<string, unknown>> } | null = null;
  private memory: Array<Record<string, unknown>>;

  constructor(opts: CredentialStoreOptions) {
    this.opts = { ...opts };
    this.memory = opts.initialMemory ? [...opts.initialMemory] : [];
  }

  get backend(): CredentialBackend {
    return this.opts.backend;
  }

  /** 当前进程是否具备可用加密密钥。 */
  hasKey(): boolean {
    try {
      return this.key() !== null;
    } catch {
      return false; // 密钥设置了但格式非法：按"无可用密钥"处理（启动校验会拒绝）
    }
  }

  private key(): string | null {
    const resolver = this.opts.keyResolver ?? (() => resolveEncryptionKey());
    return resolver();
  }

  private requireKey(): string {
    const key = this.key();
    if (!key) {
      throw new Error(`[CREDENTIAL] ${ENCRYPTION_KEY_ENV} is not set or invalid. ` + keyHint());
    }
    return key;
  }

  private storeFilePath(): string {
    return this.opts.filePath ?? resolveDefaultStoreFilePath();
  }

  /**
   * 读取账号（解密后）。返回空数组的情形：无数据 / 无密钥 / 文件不存在；
   * 密钥不匹配或文件损坏 → 抛出（fail-closed，由调用方决定回退策略）。
   */
  load(): Array<Record<string, unknown>> {
    switch (this.opts.backend) {
      case 'memory':
        return [...this.memory];
      case 'env': {
        const envVar = this.opts.envVar ?? DEFAULT_ENV_VAR;
        return parseEnvAccountsV1(process.env[envVar]);
      }
      case 'file': {
        const filePath = this.storeFilePath();
        if (!fs.existsSync(filePath)) return [];
        if (!this.hasKey()) return [];
        const st = fs.statSync(filePath);
        if (this.fileCache && this.fileCache.mtimeMs === st.mtimeMs && this.fileCache.size === st.size) {
          return [...this.fileCache.accounts];
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const payload = JSON.parse(raw) as EncryptedPayload;
        const plaintext = decrypt(payload, this.requireKey());
        const accounts = JSON.parse(plaintext) as Array<Record<string, unknown>>;
        this.fileCache = { mtimeMs: st.mtimeMs, size: st.size, accounts };
        return [...accounts];
      }
    }
  }

  /** 写入账号（file/memory/env 后端各自落位；file 为加密落盘 + POSIX 0600）。 */
  save(accounts: Array<Record<string, unknown>>): void {
    switch (this.opts.backend) {
      case 'memory':
        this.memory = [...accounts];
        return;
      case 'env': {
        // 复用 T102 的 writeEnvAccountsV1（原子写盘并同步 process.env，无循环依赖）。
        const filePath = this.opts.envFilePath;
        if (!filePath) throw new Error('[CREDENTIAL] env backend requires envFilePath for save');
        writeEnvAccountsV1(filePath, accounts);
        return;
      }
      case 'file': {
        const key = this.requireKey();
        const filePath = this.storeFilePath();
        const payload = encrypt(JSON.stringify(accounts), key);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        // 原子写：临时文件 + rename，避免崩溃时留下半截密文。
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
        fs.renameSync(tmp, filePath);
        // POSIX：文件仅属主可读写。Windows/NTFS 无 POSIX 权限位，机密性依赖
        // 文件所在目录的 ACL（默认在 %USERPROFILE%\.commandcode 下，默认 ACL
        // 仅本人与 SYSTEM/Administrators 可访问；自定义路径请自行收紧 ACL）。
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(filePath, 0o600);
          } catch { /* 尽力而为：部分文件系统不支持 */ }
        }
        const st = fs.statSync(filePath);
        this.fileCache = { mtimeMs: st.mtimeMs, size: st.size, accounts: [...accounts] };
        return;
      }
    }
  }

  /**
   * 明文凭据一次性迁移（仅 file 后端）：.env 的 COMMANDCODE_ACCOUNTS_V1 与
   * auths/*.json → 加密文件；.env 摘行；旧明文文件改名 *.plain.bak 并告警提示
   * 删除。无密钥 → 抛出（调用方应先跑 assertCredentialsEncryptedOrThrow）。
   * 幂等：无明文来源时返回 migrated:false。
   */
  migratePlaintext(opts: MigratePlaintextOptions = {}): MigrationResult {
    if (this.opts.backend !== 'file') {
      throw new Error('[CREDENTIAL] migratePlaintext is only supported on the file backend');
    }
    this.requireKey(); // 校验密钥可用（未设置/格式非法在此抛出并带生成指引）
    const envFilePath = opts.envFilePath ?? resolveEnvFilePath();
    const authDir = opts.authDir ?? resolveAuthDir();

    // 收集明文来源
    const harvest = this.harvestPlaintext(envFilePath, authDir);
    const allAccounts = mergeAccountsById(harvest.encAccounts, harvest.authsAccounts);
    if (allAccounts.length === 0) {
      return { migrated: false, encryptedCount: this.load().length, removedEnvLine: false, backedUpFiles: [] };
    }

    // 与现有加密库合并（同 id 以新明文为准），整体加密落盘
    const existing = this.load();
    const merged = mergeAccountsById(existing, allAccounts);
    this.save(merged);

    // .env 摘行（其余行保留、原子写回）并清掉本进程内的明文副本
    const removedEnvLine = this.removeEnvAccountsLine(envFilePath);

    // 旧明文文件改名 *.plain.bak（保底可恢复，但不再被扫描）
    const backedUpFiles: string[] = [];
    for (const file of harvest.files) {
      const bak = `${file}.plain.bak`;
      fs.renameSync(file, bak);
      backedUpFiles.push(bak);
    }
    if (backedUpFiles.length > 0) {
      logger.warn(
        `[CREDENTIAL] Migrated plaintext auth files into encrypted store; renamed to ` +
          `${backedUpFiles.map(f => path.basename(f)).join(', ')}. Please verify the gateway works, then DELETE these *.plain.bak files.`,
      );
    }
    logger.info(
      `[CREDENTIAL] Plaintext credentials migrated to encrypted store (${path.basename(this.storeFilePath())}, ` +
        `${merged.length} account(s)); env line removed: ${removedEnvLine}.`,
    );
    return { migrated: true, encryptedCount: merged.length, removedEnvLine, backedUpFiles };
  }

  /**
   * 面板保存的增量吸收（T105 —— T103 残留收口）：同 id 以新明文覆盖、新 id 追加，
   * 整体加密落盘。仅 file 后端；无密钥抛出（调用方应先 hasKey() 分流）。
   * 返回合并后的账号总数。
   */
  upsertAccounts(accounts: Array<Record<string, unknown>>): number {
    if (this.opts.backend !== 'file') {
      throw new Error('[CREDENTIAL] upsertAccounts is only supported on the file backend');
    }
    const incoming = accounts.filter(a => a && typeof a === 'object');
    if (incoming.length === 0) return this.load().length;
    const merged = mergeAccountsById(this.load(), incoming);
    this.save(merged);
    return merged.length;
  }

  /**
   * 摘除 .env 的 COMMANDCODE_ACCOUNTS_V1 明文行（原子写回）并清理本进程副本
   * （T105 面板保存收口；迁移语义 removeEnvAccountsLine 的公开包装）。
   * 返回是否摘除。
   */
  stripPlaintextEnvLine(envFilePath: string = resolveEnvFilePath()): boolean {
    return this.removeEnvAccountsLine(envFilePath);
  }

  /** 收集 .env 明文 V1 与 auths/*.json 中的账号及来源文件。 */
  private harvestPlaintext(envFilePath: string, authDir: string): {
    encAccounts: Array<Record<string, unknown>>;
    authsAccounts: Array<Record<string, unknown>>;
    files: string[];
  } {
    const encAccounts: Array<Record<string, unknown>> = [];
    const authsAccounts: Array<Record<string, unknown>> = [];
    const files: string[] = [];

    // 来源 1：.env 的 COMMANDCODE_ACCOUNTS_V1（process.env 优先——它是最新状态）
    const envVar = this.opts.envVar ?? DEFAULT_ENV_VAR;
    let envValue = process.env[envVar] || '';
    if (!envValue && fs.existsSync(envFilePath)) {
      try {
        envValue = findEnvAccountsLine(fs.readFileSync(envFilePath, 'utf-8')).value;
      } catch { /* 读不了当作没有 */ }
    }
    if (envValue) encAccounts.push(...parseEnvAccountsV1(envValue));

    // 来源 2：auths/*.json（对象含 apiKey 或数组元素含 apiKey）
    try {
      if (fs.existsSync(authDir)) {
        for (const name of fs.readdirSync(authDir)) {
          if (!name.endsWith('.json')) continue;
          const full = path.join(authDir, name);
          try {
            const parsed = JSON.parse(fs.readFileSync(full, 'utf-8')) as unknown;
            const entries = Array.isArray(parsed) ? parsed : [parsed];
            const withKey = entries.filter(
              (o): o is Record<string, unknown> =>
                o !== null && typeof o === 'object' && typeof (o as Record<string, unknown>).apiKey === 'string' &&
                Boolean(String((o as Record<string, unknown>).apiKey).trim()),
            );
            if (withKey.length > 0) {
              authsAccounts.push(...withKey);
              files.push(full);
            }
          } catch { /* 单文件损坏跳过，不阻塞迁移 */ }
        }
      }
    } catch { /* 目录不可读当作没有 */ }

    return { encAccounts, authsAccounts, files };
  }

  /** 从 .env 摘除 COMMANDCODE_ACCOUNTS_V1 行（原子写回）；返回是否摘除。 */
  private removeEnvAccountsLine(envFilePath: string): boolean {
    const envVar = this.opts.envVar ?? DEFAULT_ENV_VAR;
    delete process.env[envVar]; // 本进程内同步清理（外部注入下次启动仍会出现，但加密库优先，无害）
    if (!fs.existsSync(envFilePath)) return false;
    try {
      const text = fs.readFileSync(envFilePath, 'utf-8');
      const { lineIndex } = findEnvAccountsLine(text);
      if (lineIndex < 0) return false;
      const lines = text.split(/\r?\n/);
      lines.splice(lineIndex, 1);
      const tmp = `${envFilePath}.tmp`;
      fs.writeFileSync(tmp, lines.join('\n'), 'utf-8');
      fs.renameSync(tmp, envFilePath);
      return true;
    } catch (err) {
      logger.error(`[CREDENTIAL] Could not remove plaintext line from .env: ${(err as Error).message}`);
      return false;
    }
  }
}

/** env 后端 save 的落盘实现：直接复用 unified-config 的原子写入。 */

// ─── 默认实例与便捷入口（config.ts / index.ts 接入用）────────────────────────

let defaultStore: CredentialStore | null = null;

/** 默认凭据存储（file 后端；路径 resolveDefaultStoreFilePath()）。惰性单例。 */
export function getDefaultCredentialStore(): CredentialStore {
  if (!defaultStore) {
    defaultStore = new CredentialStore({ backend: 'file', filePath: resolveDefaultStoreFilePath() });
  }
  return defaultStore;
}

/**
 * loadConfig 的账号来源（加密优先）：密钥可用且加密库可读 → 返回其中账号；
 * 其余情形（无密钥/无库/读失败）→ 返回 []（调用方回退 COMMANDCODE_ACCOUNTS_V1）。
 * 读失败时告警但不抛——请求路径不容异常，启动校验负责拒绝非法状态。
 */
export function loadAccountsFromCredentialStore(): Array<Record<string, unknown>> {
  const store = getDefaultCredentialStore();
  if (!store.hasKey()) return [];
  try {
    return store.load();
  } catch (err) {
    logger.error(`[CREDENTIAL] Encrypted credential store unreadable, falling back to env: ${(err as Error).message}`);
    return [];
  }
}

/**
 * index.ts 启动路径的首次迁移钩子：带密钥启动时把明文凭据（.env V1 行 +
 * auths/*.json）加密落盘并摘除明文。无密钥时静默跳过（启动校验会另行拒绝）；
 * 迁移失败只告警不阻塞启动（env 回退仍可用）。
 */
export function migratePlaintextCredentialsIfNeeded(): void {
  const store = getDefaultCredentialStore();
  if (!store.hasKey()) return;
  try {
    store.migratePlaintext({});
  } catch (err) {
    logger.error(`[CREDENTIAL] Plaintext credential migration failed: ${(err as Error).message}`);
  }
}
