// =============================================================================
// saveConfigFile 凭据加密收口测试（T105 —— T103 残留收口 DoD）
// -----------------------------------------------------------------------------
// T102 语义:面板保存把账号凭据明文回写 .env 的 COMMANDCODE_ACCOUNTS_V1。
// T105 收口:
//   - CREDENTIAL_ENCRYPTION_KEY 可用 → 凭据写加密存储(credentials.enc),
//     并摘除 .env 明文行(含 process.env 副本);
//   - 密钥不可用 → 保持现行为(运行可用;下次启动被
//     assertCredentialsEncryptedOrThrow 拒绝并给出密钥指引);
//   - 未显式传 accounts 的保存(切活跃账号/改名)不得清空账号元数据 ——
//     加密库账号优先于 .env/空列表。
// =============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ab'.repeat(32);

let dir: string;
let envFile: string;
let configFile: string;
let storeFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccproxy-savecfg-'));
  configFile = path.join(dir, 'config.json');
  envFile = path.join(dir, '.env');
  storeFile = path.join(dir, 'credentials.enc');
  process.env.COMMANDCODE_CONFIG_PATH = configFile;
  process.env.COMMANDCODE_ENV_PATH = envFile;
  process.env.CREDENTIAL_STORE_PATH = storeFile;
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.COMMANDCODE_ACCOUNTS_V1;
  delete process.env.COMMANDCODE_API_KEY;
  // 真实部署形态：loadConfig 的启动迁移后 config.json 已是 unified providers
  // 形态 —— 面板保存走 unified 分支（旧扁平分支仅在迁移失败的异常路径触达）。
  fs.writeFileSync(configFile, JSON.stringify({ providers: { commandcode: {} } }), 'utf-8');
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.COMMANDCODE_CONFIG_PATH;
  delete process.env.COMMANDCODE_ENV_PATH;
  delete process.env.CREDENTIAL_STORE_PATH;
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.COMMANDCODE_ACCOUNTS_V1;
  vi.resetModules();
});

const ACC = { id: 'acc_t', name: 'Test Account', apiKey: 'sk-live-test-key-0123456789', addedAt: '2026-01-01T00:00:00Z' };

async function loadConfigModule() {
  return await import('../src/utils/config.js');
}

describe('saveConfigFile —— 密钥可用:凭据入加密存储并摘除 .env 明文行', () => {
  it('凭据写入 credentials.enc,.env 无 COMMANDCODE_ACCOUNTS_V1 行,config.json 无明文', async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
    const config = await loadConfigModule();

    config.saveConfigFile({ accounts: [ACC], activeAccountId: ACC.id });

    expect(fs.existsSync(storeFile)).toBe(true);
    // 加密文件不含明文 key
    const encRaw = fs.readFileSync(storeFile, 'utf-8');
    expect(encRaw).not.toContain(ACC.apiKey);

    // .env 明文行被摘除(本进程副本同步清理)
    if (fs.existsSync(envFile)) expect(fs.readFileSync(envFile, 'utf-8')).not.toContain('COMMANDCODE_ACCOUNTS_V1=');
    expect(process.env.COMMANDCODE_ACCOUNTS_V1).toBeUndefined();

    // config.json 只保留展示元数据,无明文凭据
    const after = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    const meta = after.providers.commandcode.accountsMeta;
    expect(meta.some((m: any) => m.id === ACC.id)).toBe(true);
    expect(JSON.stringify(after)).not.toContain(ACC.apiKey);
  });

  it('saveConfigFile 后 loadConfig 从加密库读回完整凭据', async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
    const config = await loadConfigModule();
    config.saveConfigFile({ accounts: [ACC], activeAccountId: ACC.id });

    const loaded = config.loadConfig();
    expect(loaded.accounts.map((a: any) => a.id)).toContain(ACC.id);
    const acc = loaded.accounts.find((a: any) => a.id === ACC.id);
    expect(acc.apiKey).toBe(ACC.apiKey);
  });

  it('未显式传 accounts 的保存(切活跃账号)不清空账号元数据', async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
    const config = await loadConfigModule();
    config.saveConfigFile({ accounts: [ACC], activeAccountId: ACC.id });

    config.saveConfigFile({ activeAccountId: ACC.id });

    const after = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(after.providers.commandcode.accountsMeta.some((m: any) => m.id === ACC.id)).toBe(true);
    expect(after.providers.commandcode.activeAccountId).toBe(ACC.id);
  });

  it('再次保存时加密库账号同 id 覆盖(增量吸收)', async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
    const config = await loadConfigModule();
    config.saveConfigFile({ accounts: [ACC], activeAccountId: ACC.id });

    const renamed = { ...ACC, name: 'Renamed' };
    config.saveConfigFile({ accounts: [renamed] });

    const loaded = config.loadConfig();
    const acc = loaded.accounts.find((a: any) => a.id === ACC.id);
    expect(acc.name).toBe('Renamed');
    expect(loaded.accounts.length).toBe(1); // 无重复条目
  });
});

describe('saveConfigFile —— 密钥不可用:保持 T102 现行为(明文回写 .env)', () => {
  it('凭据仍写 COMMANDCODE_ACCOUNTS_V1(下次启动被拒启指引),运行可用', async () => {
    const config = await loadConfigModule();
    config.saveConfigFile({ accounts: [ACC], activeAccountId: ACC.id });

    const envRaw = fs.readFileSync(envFile, 'utf-8');
    expect(envRaw).toContain('COMMANDCODE_ACCOUNTS_V1=');
    expect(process.env.COMMANDCODE_ACCOUNTS_V1).toBeTruthy();

    const reloaded = config.loadConfig();
    const acc = reloaded.accounts.find((a: any) => a.id === ACC.id);
    expect(acc?.apiKey).toBe(ACC.apiKey);

    // config.json 依旧不落明文(T102 语义保持)
    const after = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(JSON.stringify(after)).not.toContain(ACC.apiKey);
  });
});
