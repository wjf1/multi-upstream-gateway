// =============================================================================
// 统一配置体系（执行依据：master-plan v1.2 §3.2 / 任务卡 T102）
// -----------------------------------------------------------------------------
// 职责：
//   1. UnifiedConfig 的 Zod schema —— 多上游网关的目标配置形态，含 §3.2 全部
//      字段与默认值；未知键 passthrough 保留（升级不丢自定义配置）；
//   2. 旧版扁平 config.json 的自动迁移 —— 幂等、原子写回；凭据（accounts[].apiKey）
//      迁出 config.json 落入 .env 的 COMMANDCODE_ACCOUNTS_V1（T103 再升级为
//      加密 CredentialStore），实现"config.json 不落任何明文凭据"（§3.7-2）；
//   3. 凭据键扫描 —— providers 分片中任何形如 token/apiKey/secret 的键都会让
//      校验失败并给出具体字段路径（密钥只从环境变量读取）；
//   4. chokidar 热重载 —— 防抖重读 → 校验 → 深合并 → 原子替换内部状态 →
//      onChange 回调；校验失败保留旧状态并报错。
//
// 与底座 config.ts 的关系：config.ts 的 loadConfig() 在读取前调用
// migrateLegacyConfigIfNeeded()（迁移钩子），并用 env 账号合并保持存量行为；
// 本文件的 UnifiedConfigStore 供 T104/T105/T106 等新消费方使用。
// =============================================================================

import fs from 'fs';
import { z } from 'zod';
import chokidar, { type FSWatcher } from 'chokidar';
import { logger } from './logger.js';

// ─── Schema（§3.2 全字段）─────────────────────────────────────────────────────

const ProviderEnabled = z.object({
  /** Provider 总闸（T213 面板启停；默认开启）。 */
  enabled: z.boolean().default(true),
});

/**
 * commandcode 分片：只放非凭据字段。账号凭据一律走环境变量
 * （COMMANDCODE_ACCOUNTS_V1 / COMMANDCODE_API_KEY），config.json 不落明文。
 */
export const CommandCodeConfigSchema = ProviderEnabled.extend({
  rotationMode: z.enum(['manual', 'auto-quota']).default('manual'),
  activeAccountId: z.string().default(''),
  upstream: z
    .object({
      apiBase: z.string().optional(),
      ccVersion: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      idleTimeoutMs: z.number().int().positive().optional(),
      maxRetries: z.number().int().min(0).optional(),
    })
    .passthrough()
    .default({}),
  /** 账号元数据（名称/邮箱等展示信息，不含凭据）。 */
  accountsMeta: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        userName: z.string().optional(),
        email: z.string().optional(),
        userId: z.string().optional(),
        addedAt: z.string().optional(),
      }),
    )
    .default([]),
}).passthrough();

/**
 * freebuff 分片：tokens 只从环境变量 FREEBUFF_TOKENS（逗号分隔）读取。
 *
 * T201 小幅扩展（均为非凭据字段，报告已登记）：rotationIntervalMs /
 * requestTimeoutMs / userAgent —— 对应 Go 原版 config.go 的 ROTATION_INTERVAL /
 * REQUEST_TIMEOUT / UserAgent；缺省时由 providers/freebuff/config.ts 兜底。
 * 注意：键名不得含 token/apiKey/secret 等形状，否则 superRefine 会拒绝。
 */
export const FreebuffConfigSchema = ProviderEnabled.extend({
  apiBase: z.string().optional(),
  modelRegistryUrl: z.string().optional(),
  /** Run 轮换周期（ms，默认 6h）。 */
  rotationIntervalMs: z.number().int().positive().optional(),
  /** 单请求上游超时（ms，默认 15m）。 */
  requestTimeoutMs: z.number().int().positive().optional(),
  /** 自定义 User-Agent（默认与官方 openai-compatible 客户端一致）。 */
  userAgent: z.string().optional(),
}).passthrough();

/**
 * workbuddy 分片（联邦路线，G0-T2 裁决）：
 * authDir 指向 sidecar 数据目录；rewriteMode 总开关见 §3.2 ——
 * 'full'（默认，改写特性全生效）| 'passthrough'（跳过全部行为改写，故障一键回退）。
 */
export const WorkBuddyConfigSchema = ProviderEnabled.extend({
  authDir: z.string().optional(),
  rewriteMode: z.enum(['full', 'passthrough']).default('full'),
  /** 积分 → USD 折算价；null = 不折算（§3.9 分口径展示）。 */
  pointsPerUsdRate: z.number().positive().nullable().default(null),
  sidecar: z
    .object({
      /** sidecar 二进制路径（联邦回退最小路径 §3.11）。 */
      binPath: z.string().optional(),
      /** sidecar 监听端口（默认由 sidecar 自选，配置后固定）。 */
      port: z.number().int().positive().optional(),
    })
    .passthrough()
    .default({}),
}).passthrough();

export const RoutingConfigSchema = z
  .object({
    defaultProvider: z.enum(['commandcode', 'freebuff', 'workbuddy']).default('commandcode'),
    /** 默认 strict：上游不可用直接 503；auto 必须显式开启（§3.6）。 */
    fallbackStrategy: z.enum(['strict', 'auto', 'same-model']).default('strict'),
    upstreamPriority: z.array(z.enum(['commandcode', 'freebuff', 'workbuddy'])).default([]),
    sessionStickyEnabled: z.boolean().default(true),
    modelPrefixRouting: z.boolean().default(true),
  })
  .default({});

export const DegradationConfigSchema = z
  .object({
    rampStartPercent: z.number().min(0).max(100).default(10),
    rampStepPercent: z.number().min(1).max(100).default(10),
    fallbackAbortHits: z.number().int().min(1).default(2),
    fallbackAbortWindowMs: z.number().int().positive().default(30_000),
    queueMaxDepth: z.number().int().positive().default(128),
  })
  .default({});

const RateBucketSchema = z.object({
  rpm: z.number().int().positive(),
  tpm: z.number().int().positive(),
});

export const RateLimitConfigSchema = z
  .object({
    global: RateBucketSchema.partial({ rpm: true, tpm: true }).default({}),
    /** per-provider 桶；'inherit' 表示沿用全局值（§3.2 P2-6）。 */
    perProvider: z
      .record(z.union([RateBucketSchema, z.literal('inherit')]))
      .default({}),
  })
  .default({});

export const ModelAccessConfigSchema = z
  .object({
    allowlist: z.array(z.string()).default([]),
    blocklist: z.array(z.string()).default([]),
  })
  .default({});

export const AlertsConfigSchema = z
  .object({
    webhookUrl: z.string().default(''),
    /** 0 = 不启用日预算告警。 */
    dailyBudgetUsd: z.number().nonnegative().default(0),
    /** 错误率阈值（0..1）；0 = 不启用。 */
    errorRateThreshold: z.number().min(0).max(1).default(0),
  })
  .default({});

export const StorageConfigSchema = z
  .object({
    usageHistoryPath: z.string().default('~/.commandcode/usage-history.jsonl'),
    logPath: z.string().default(''),
    retentionDays: z.number().int().positive().default(30),
    statePath: z.string().default('data/state.json'),
  })
  .default({});

export const SecurityConfigSchema = z
  .object({
    corsOrigins: z.array(z.string()).default([]),
    ssrfBlocklist: z.array(z.string()).default([]),
  })
  .default({});

export const UnifiedConfigSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(9090),
    host: z.string().default('127.0.0.1'),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /**
     * 入站请求体上限（字节）。默认走底座 resolveBodyLimit()（MAX_BODY_MB，
     * 缺省 64MB）：视觉/多图请求的 base64 负载经常超过 10MB，采用 v1.2 §3.2
     * 建议的 10MB 会造成存量视觉请求 413 回归，故以存量值兜底、可配置覆盖。
     */
    maxBodySize: z.number().int().positive().optional(),
    /** 合规风险门（§3.7-7/T106）：false 时网关拒绝处理任何 /v1 请求。 */
    acceptedRiskDisclaimer: z.boolean().default(false),
    providers: z
      .object({
        commandcode: CommandCodeConfigSchema.default({}),
        freebuff: FreebuffConfigSchema.default({}),
        workbuddy: WorkBuddyConfigSchema.default({}),
      })
      .default({}),
    routing: RoutingConfigSchema,
    degradation: DegradationConfigSchema,
    rateLimit: RateLimitConfigSchema,
    modelAccess: ModelAccessConfigSchema,
    alerts: AlertsConfigSchema,
    storage: StorageConfigSchema,
    security: SecurityConfigSchema,
  })
  .passthrough()
  .superRefine((val, ctx) => {
    // §3.7-2：密钥类字段只从环境变量读取。扫描 providers 分片（config.json
    // 的落盘形态），发现凭据形状的键 → 校验失败并给出具体字段路径。
    const providerNames = ['commandcode', 'freebuff', 'workbuddy'] as const;
    const secretKeyRe = /token|apikey|api_key|secret|password|credential/i;
    for (const name of providerNames) {
      scanForSecretKeys(val.providers[name], ['providers', name], ctx);
    }
    function scanForSecretKeys(node: unknown, path: string[], ctx: z.RefinementCtx): void {
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const here = [...path, k];
        if (secretKeyRe.test(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: here,
            message: `config.json must not contain credential-like key '${k}' (set it via environment variables instead)`,
          });
        } else if (v && typeof v === 'object') {
          scanForSecretKeys(v, here, ctx);
        }
      }
    }
  });

export type UnifiedConfig = z.infer<typeof UnifiedConfigSchema>;

// ─── 旧形态检测与迁移 ─────────────────────────────────────────────────────────

/** 旧版扁平 config.json 的判定：无 providers 键且命中任一旧顶层字段。 */
function isLegacyConfigFile(raw: unknown): raw is Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if ('providers' in obj) return false;
  const legacyKeys = ['port', 'host', 'accounts', 'upstream', 'rotationMode', 'activeAccountId'];
  return legacyKeys.some(k => k in obj);
}

/** 从 .env 文本中解析 COMMANDCODE_ACCOUNTS_V1 的行号与值（未找到返回 -1）。 */
export function findEnvAccountsLine(envText: string): { lineIndex: number; value: string } {
  const lines = envText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('COMMANDCODE_ACCOUNTS_V1=')) {
      return { lineIndex: i, value: line.slice('COMMANDCODE_ACCOUNTS_V1='.length).trim() };
    }
  }
  return { lineIndex: -1, value: '' };
}

/**
 * 把账号凭据（含 apiKey）写入 .env 的 COMMANDCODE_ACCOUNTS_V1（base64 JSON），
 * 并同步进 process.env（本次进程立即可用）。已存在该行则整行替换。
 * .env 在 .gitignore 中（gitignore:4），不会被提交。
 */
export function writeEnvAccountsV1(envFilePath: string, accounts: unknown[]): void {
  const encoded = Buffer.from(JSON.stringify(accounts), 'utf-8').toString('base64');
  let envText = '';
  if (fs.existsSync(envFilePath)) {
    envText = fs.readFileSync(envFilePath, 'utf-8');
  }
  const { lineIndex } = findEnvAccountsLine(envText);
  const newLine = `COMMANDCODE_ACCOUNTS_V1=${encoded}`;
  let nextText: string;
  if (lineIndex >= 0) {
    const lines = envText.split(/\r?\n/);
    lines[lineIndex] = newLine;
    nextText = lines.join('\n');
  } else {
    const sep = envText && !envText.endsWith('\n') ? '\n' : '';
    nextText = envText + sep + newLine + '\n';
  }
  const tmp = `${envFilePath}.tmp`;
  fs.writeFileSync(tmp, nextText, 'utf-8');
  fs.renameSync(tmp, envFilePath);
  // 本次写入即最新状态：同步覆盖 process.env，让同进程内的后续读取立即生效
  // （迁移钩子在 loadEnvFileOnce 之后运行，不手动注入就读不到刚写入的行）。
  process.env.COMMANDCODE_ACCOUNTS_V1 = encoded;
}

/** 解析 process.env 里的 COMMANDCODE_ACCOUNTS_V1；损坏时告警并返回 []。 */
export function parseEnvAccountsV1(encoded: string | undefined): Array<Record<string, unknown>> {
  if (!encoded) return [];
  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    if (!Array.isArray(decoded)) throw new Error('not an array');
    return decoded as Array<Record<string, unknown>>;
  } catch (err) {
    logger.warn(`[CONFIG] COMMANDCODE_ACCOUNTS_V1 is corrupt, ignoring: ${(err as Error).message}`);
    return [];
  }
}

/**
 * 迁移结果：除返回迁移后的 UnifiedConfig 草稿外，还返回需要调用方落盘的内容。
 */
export interface MigrationOutcome {
  migrated: boolean;
  /** 迁移写回的完整新结构（含 passthrough 保留的未知键）；未迁移时为 null。 */
  nextFileJson: Record<string, unknown> | null;
  /** 被摘出 config.json 的账号凭据（含 apiKey）；调用方负责写入 .env。 */
  credentials: Array<Record<string, unknown>>;
}

/**
 * 旧版扁平 config.json → UnifiedConfig 文件形态的一次性迁移。
 *
 * - providers.commandcode 承接 rotationMode/activeAccountId/upstream；
 * - accounts[].apiKey 提取为凭据数组（调用方写入 .env），config.json 只保留
 *   无凭据的 accountsMeta；
 * - 顶层未知键原样保留（passthrough）；
 * - 幂等：已含 providers 键的文件直接返回 migrated=false。
 */
export function migrateLegacyConfig(raw: unknown): MigrationOutcome {
  if (!isLegacyConfigFile(raw)) return { migrated: false, nextFileJson: null, credentials: [] };
  const legacy = raw as Record<string, unknown>;

  const accounts = Array.isArray(legacy.accounts) ? (legacy.accounts as Array<Record<string, unknown>>) : [];
  const credentials: Array<Record<string, unknown>> = [];
  const accountsMeta: Array<Record<string, unknown>> = [];
  for (const acc of accounts) {
    const { apiKey, ...meta } = acc;
    if (typeof apiKey === 'string' && apiKey.trim()) {
      credentials.push({ ...meta, apiKey: apiKey.trim() });
    }
    accountsMeta.push(meta);
  }

  const next: Record<string, unknown> = {
    ...legacy, // 未知键保留
    port: legacy.port,
    host: legacy.host,
    providers: {
      commandcode: {
        ...(typeof legacy.rotationMode === 'string' ? { rotationMode: legacy.rotationMode } : {}),
        ...(typeof legacy.activeAccountId === 'string' && legacy.activeAccountId
          ? { activeAccountId: legacy.activeAccountId }
          : {}),
        ...(legacy.upstream && typeof legacy.upstream === 'object' ? { upstream: legacy.upstream } : {}),
        accountsMeta,
      },
    },
  };
  delete next.accounts;
  delete next.rotationMode;
  delete next.activeAccountId;
  delete next.upstream;

  return { migrated: true, nextFileJson: next, credentials };
}

// ─── 深合并（热重载用：默认值 < 文件值，未知键保留）───────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMergeKeepUnknown<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMergeKeepUnknown(out[k] as Record<string, unknown>, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// ─── 加载与迁移钩子（供 config.ts 的 loadConfig 调用）─────────────────────────

export interface ConfigLoadResult {
  unified: UnifiedConfig;
  /** 原始文件 JSON（迁移后形态），供排查与未知键读取。 */
  rawFile: Record<string, unknown>;
}

/** 解析+校验文件 JSON → UnifiedConfig；失败抛出带字段路径的 Error。 */
export function parseUnifiedConfig(rawJson: unknown, maxBodySizeFallbackBytes: number): UnifiedConfig {
  const withBody = isPlainObject(rawJson) && !('maxBodySize' in rawJson)
    ? { ...rawJson, maxBodySize: maxBodySizeFallbackBytes }
    : rawJson;
  const parsed = UnifiedConfigSchema.parse(withBody) as UnifiedConfig;
  return parsed;
}

/** 把 ZodError 渲染成"字段路径: 消息"多行文本（DoD：输出具体字段路径）。 */
export function formatZodError(err: z.ZodError): string {
  return err.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/**
 * 迁移钩子：若 config.json 是旧形态则原子写回新结构、凭据写入 .env。
 * 幂等；任何失败只告警不阻塞启动（存量加载路径继续按旧文件工作）。
 */
export function migrateLegacyConfigIfNeeded(configFilePath: string, envFilePath: string): void {
  try {
    if (!fs.existsSync(configFilePath)) return;
    const raw = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    const outcome = migrateLegacyConfig(raw);
    if (!outcome.migrated) return;

    if (outcome.credentials.length > 0) {
      writeEnvAccountsV1(envFilePath, outcome.credentials);
      logger.warn(
        `[CONFIG] Migrated ${outcome.credentials.length} account credential(s) out of config.json into .env ` +
          `(COMMANDCODE_ACCOUNTS_V1). Plain-text copies are no longer stored in config.json.`,
      );
    }
    const tmp = `${configFilePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(outcome.nextFileJson, null, 2), 'utf-8');
    fs.renameSync(tmp, configFilePath);
    logger.info('[CONFIG] Legacy config.json migrated to unified providers layout.');
  } catch (err) {
    logger.warn(`[CONFIG] Legacy config migration skipped: ${(err as Error).message}`);
  }
}

// ─── 热重载（chokidar）────────────────────────────────────────────────────────

export interface UnifiedConfigStoreOptions {
  configFilePath: string;
  envFilePath: string;
  maxBodySizeFallbackBytes: number;
  /** 文件变更到重载之间的防抖（毫秒），默认 200。 */
  debounceMs?: number;
}

type Listener = (config: UnifiedConfig) => void;

/**
 * 统一配置的运行期载体：start() 时加载 + 监听文件，变更后防抖重载。
 * 校验失败时保留旧状态（get() 不变）并触发 onError——禁止半载状态。
 */
export class UnifiedConfigStore {
  private config: UnifiedConfig | null = null;
  private rawFile: Record<string, unknown> = {};
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly onErrorListeners = new Set<(msg: string) => void>();
  private stopped = false;

  constructor(private readonly opts: UnifiedConfigStoreOptions) {}

  /** 首次加载（迁移钩子 → 校验），失败直接抛（启动失败语义）。 */
  load(): UnifiedConfig {
    migrateLegacyConfigIfNeeded(this.opts.configFilePath, this.opts.envFilePath);
    return this.reloadOrThrow();
  }

  get(): UnifiedConfig {
    if (!this.config) throw new Error('UnifiedConfigStore not loaded; call load() first');
    return this.config;
  }

  getRawFile(): Record<string, unknown> {
    return this.rawFile;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onLoadError(fn: (msg: string) => void): () => void {
    this.onErrorListeners.add(fn);
    return () => this.onErrorListeners.delete(fn);
  }

  /** 开始监听 config.json；变更在 debounceMs 后生效（DoD：2s 内热生效）。 */
  async start(): Promise<void> {
    this.load();
    this.stopped = false;
    this.watcher = chokidar.watch(this.opts.configFilePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    this.watcher.on('add', () => this.scheduleReload());
    this.watcher.on('change', () => this.scheduleReload());
    // watcher 就绪前的文件变更会被 fs.watch 丢弃——等 ready 再返回，
    // 保证 start() 之后的第一次写入必然触发热重载。
    await new Promise<void>(resolve => this.watcher!.once('ready', () => resolve()));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reloadQuiet();
    }, this.opts.debounceMs ?? 200);
  }

  private reloadOrThrow(): UnifiedConfig {
    let raw: unknown = {};
    if (fs.existsSync(this.opts.configFilePath)) {
      raw = JSON.parse(fs.readFileSync(this.opts.configFilePath, 'utf-8'));
    }
    const next = parseUnifiedConfig(raw, this.opts.maxBodySizeFallbackBytes);
    this.config = next;
    this.rawFile = (isPlainObject(raw) ? raw : {}) as Record<string, unknown>;
    return next;
  }

  /** 热重载：失败保留旧状态并通知 onError（禁止半载）。 */
  private reloadQuiet(): void {
    try {
      const prev = this.config;
      const next = this.reloadOrThrow();
      if (prev !== next) {
        for (const fn of this.listeners) fn(next);
      }
    } catch (err) {
      const msg =
        err instanceof z.ZodError
          ? `config hot-reload rejected: ${formatZodError(err)}`
          : `config hot-reload failed: ${(err as Error).message}`;
      logger.error(`[CONFIG] ${msg}`);
      for (const fn of this.onErrorListeners) fn(msg);
    }
  }
}
