// =============================================================================
// T213b：配置源收口 —— store 优先 / env 回退 + legacy 明文行
// -----------------------------------------------------------------------------
// 覆盖：
//   [ ] UnifiedConfigStore bootstrap：config.json 的 modelAccess / rateLimit
//       分片驱动 checkModelAccess / checkRateLimit（store 非空 → store 赢，
//       env 被忽略）；热重载后新分片生效
//   [ ] env 回退：未装配 store 时行为与收口前一致（存量测试全绿即证）
//   [ ] legacy 扁平分支 syncEnvFile：加密库可用时不再写 COMMANDCODE_API_KEY
//       明文行且摘除旧行；密钥不可用时保持旧行为（不静默丢凭据）
// 隔离纪律：COMMANDCODE_* / USAGE_* / CREDENTIAL_* 路径全部在动态 import 之前
// 指向临时目录；store 的 watcher 在 afterAll 停掉。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let stateDir = '';
let configFile = '';
let envFile = '';

let bootstrapConfigStore: typeof import('../src/utils/config-store-runtime.js')['bootstrapConfigStore'];
let shutdownConfigStore: typeof import('../src/utils/config-store-runtime.js')['shutdownConfigStore'];
let __resetConfigStoreForTest: typeof import('../src/utils/config-store-runtime.js')['__resetConfigStoreForTest'];
let checkModelAccess: typeof import('../src/utils/model-access.js')['checkModelAccess'];
let checkRateLimit: typeof import('../src/utils/rate-limit.js')['checkRateLimit'];
let __testReset: typeof import('../src/utils/rate-limit.js')['__testReset'];
let saveConfigFile: typeof import('../src/utils/config.js')['saveConfigFile'];

function writeConfig(shape: unknown): void {
  writeFileSync(configFile, JSON.stringify(shape), 'utf-8');
}

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-t213b-'));
  configFile = path.join(stateDir, 'config.json');
  envFile = path.join(stateDir, '.env');
  process.env.COMMANDCODE_CONFIG_PATH = configFile;
  process.env.COMMANDCODE_ENV_FILE_PATH = envFile;
  process.env.COMMANDCODE_ENV_PATH = envFile;
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  process.env.CREDENTIAL_STORE_PATH = path.join(stateDir, 'credentials.enc');
  writeConfig({});

  ({
    bootstrapConfigStore,
    shutdownConfigStore,
    __resetConfigStoreForTest,
  } = await import('../src/utils/config-store-runtime.js'));
  ({ checkModelAccess } = await import('../src/utils/model-access.js'));
  ({ checkRateLimit, __testReset } = await import('../src/utils/rate-limit.js'));
  ({ saveConfigFile } = await import('../src/utils/config.js'));
});

afterEach(() => {
  delete process.env.MODEL_ALLOWLIST;
  delete process.env.MODEL_BLOCKLIST;
  delete process.env.RATE_LIMIT_RPM;
  delete process.env.RATE_LIMIT_TPM;
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  __testReset();
  __resetConfigStoreForTest();
});

afterAll(async () => {
  await shutdownConfigStore();
  rmSync(stateDir, { recursive: true, force: true });
  for (const k of ['COMMANDCODE_CONFIG_PATH', 'COMMANDCODE_ENV_FILE_PATH', 'COMMANDCODE_ENV_PATH', 'USAGE_HISTORY_PATH', 'COMMANDCODE_LOG_PATH', 'CREDENTIAL_STORE_PATH']) {
    delete process.env[k];
  }
});

describe('modelAccess：store 优先 / env 回退', () => {
  it('store 分片非空 → store 赢（env 的 allowlist 被忽略）', async () => {
    process.env.MODEL_ALLOWLIST = 'good-model';
    writeConfig({ providers: {}, modelAccess: { allowlist: [], blocklist: ['bad-model'] } });
    await bootstrapConfigStore();

    expect(checkModelAccess('bad-model').allowed).toBe(false);
    // env allowlist 若生效，'other-model' 会被拒；store 赢 → 放行。
    expect(checkModelAccess('other-model').allowed).toBe(true);
    expect(checkModelAccess('good-model').allowed).toBe(true);
  });

  it('热重载：改写 config.json 的 blocklist 后新模型名被拒', async () => {
    writeConfig({ providers: {}, modelAccess: { allowlist: [], blocklist: ['bad-model'] } });
    await bootstrapConfigStore();
    expect(checkModelAccess('worse-model').allowed).toBe(true);

    writeConfig({ providers: {}, modelAccess: { allowlist: [], blocklist: ['worse-model'] } });
    await new Promise((r) => setTimeout(r, 900)); // 防抖 200ms + watcher 触发
    expect(checkModelAccess('worse-model').allowed).toBe(false);
  });

  it('store 分片为空 → env 回退（收口前语义）', async () => {
    process.env.MODEL_BLOCKLIST = 'env-blocked';
    writeConfig({ providers: {} });
    await bootstrapConfigStore();
    expect(checkModelAccess('env-blocked').allowed).toBe(false);
    expect(checkModelAccess('free-model').allowed).toBe(true);
  });

  it('未装配 store → 纯 env 行为（与收口前逐字一致）', () => {
    process.env.MODEL_ALLOWLIST = 'a-model';
    expect(checkModelAccess('a-model').allowed).toBe(true);
    expect(checkModelAccess('b-model').allowed).toBe(false);
  });
});

describe('rateLimit.global：store 优先 / env 回退（路由级桶）', () => {
  it('store 分片注入后按 config.json 的 rpm 限流', async () => {
    writeConfig({ providers: {}, rateLimit: { global: { rpm: 2 } } });
    await bootstrapConfigStore();

    expect(checkRateLimit('k1', 0).allowed).toBe(true);
    expect(checkRateLimit('k1', 0).allowed).toBe(true);
    const third = checkRateLimit('k1', 0);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThan(0);
    expect(checkRateLimit('k2', 0).allowed).toBe(true); // per-key 桶互不影响
  });

  it('store 分片为空 → env 回退；两者皆无 → 恒放行', async () => {
    process.env.RATE_LIMIT_RPM = '1';
    writeConfig({ providers: {} });
    await bootstrapConfigStore();
    expect(checkRateLimit('k3', 0).allowed).toBe(true);
    expect(checkRateLimit('k3', 0).allowed).toBe(false);

    delete process.env.RATE_LIMIT_RPM;
    __testReset();
    expect(checkRateLimit('k3', 0).allowed).toBe(true);
    expect(checkRateLimit('k3', 0).allowed).toBe(true);
    expect(checkRateLimit('k3', 0).allowed).toBe(true);
  });
});

describe('legacy 扁平分支明文行收口（T103 残留）', () => {
  it('加密库可用：saveConfigFile 不写 COMMANDCODE_API_KEY 且摘除旧行', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'c'.repeat(64);
    writeConfig({ port: 9090, accounts: [{ id: 'acc_1', name: 'n', apiKey: 'sk-plain', addedAt: 'now' }], activeAccountId: 'acc_1' });
    writeFileSync(envFile, 'COMMANDCODE_API_KEY=sk-plain\nACCOUNTS_COUNT=1\n', 'utf-8');

    expect(saveConfigFile({ port: 9090 })).toBe(true);
    const envText = readFileSync(envFile, 'utf-8');
    expect(envText).not.toContain('COMMANDCODE_API_KEY=');
    expect(envText).not.toContain('sk-plain');
  });

  it('加密库不可用：保持旧行为（写明文行，不静默丢凭据）', () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    writeConfig({ port: 9090, accounts: [{ id: 'acc_1', name: 'n', apiKey: 'sk-plain', addedAt: 'now' }], activeAccountId: 'acc_1' });
    writeFileSync(envFile, 'ACCOUNTS_COUNT=1\n', 'utf-8');

    expect(saveConfigFile({ port: 9090 })).toBe(true);
    const envText = existsSync(envFile) ? readFileSync(envFile, 'utf-8') : '';
    expect(envText).toContain('COMMANDCODE_API_KEY=sk-plain');
  });
});
