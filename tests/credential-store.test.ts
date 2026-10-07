// =============================================================================
// 凭据加密-at-rest 测试（T103 DoD）
// -----------------------------------------------------------------------------
// 覆盖：
//   1. encrypt/decrypt 往返（AES-256-GCM、随机 IV、篡改 authTag/data 必须失败、
//      无效密钥拒绝）；
//   2. CredentialStore 三后端（file 加密 / memory / env）的 load/save 往返，
//      file 落盘内容不含任何明文 apiKey；
//   3. migratePlaintext：明文 COMMANDCODE_ACCOUNTS_V1 + auths/*.json → 加密文件、
//      .env 摘行、旧明文文件改名 *.plain.bak 并告警提示删除、幂等；
//   4. assertCredentialsEncryptedOrThrow：无密钥 + 有明文 → 抛出含生成密钥
//      指引的错误（拒绝启动语义）；
//   5. chmod 0600 断言（仅 POSIX，Windows 下 skip —— 依赖用户目录 ACL）；
//   6. loadConfig 集成：加密存储（密钥可用时）优先于 COMMANDCODE_ACCOUNTS_V1
//      （T102 兼容回退）。
// =============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CredentialStore,
  assertCredentialsEncryptedOrThrow,
  decrypt,
  detectPlaintextCredentials,
  encrypt,
  resolveEncryptionKey,
} from '../src/utils/credential-store.js';
import { logger } from '../src/utils/logger.js';
import { parseEnvAccountsV1, writeEnvAccountsV1 } from '../src/utils/unified-config.js';

const KEY = 'ab'.repeat(32); // 64 hex chars = 32 bytes = AES-256
const KEY_OTHER = 'cd'.repeat(32);

let dir: string;
let envFile: string;
let authDir: string;
let storeFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-store-'));
  envFile = path.join(dir, '.env');
  authDir = path.join(dir, 'auths');
  storeFile = path.join(dir, 'credentials.enc');
  // 隔离默认加密库路径：否则 assertCredentialsEncryptedOrThrow（不传 storeFilePath 时）
  // 会去看操作者真实的 ~/.commandcode/credentials.enc，本机存在该文件即误判为
  // "有库无钥" 而抛错 —— 用例断言的是"全无凭据"这一临时目录内的状态。
  process.env.CREDENTIAL_STORE_PATH = storeFile;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.COMMANDCODE_ACCOUNTS_V1;
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.CREDENTIAL_STORE_PATH;
  vi.restoreAllMocks();
});

const ACCOUNTS = [
  { id: 'a1', name: 'Account One', apiKey: 'sk-test-aaaa', addedAt: '2026-01-01T00:00:00Z' },
  { id: 'a2', name: 'Account Two', apiKey: 'sk-test-bbbb', addedAt: '2026-01-02T00:00:00Z' },
];

// ─── 1. encrypt / decrypt（AES-256-GCM）──────────────────────────────────────

describe('encrypt/decrypt（AES-256-GCM 往返）', () => {
  it('往返：密文解密还原原文（含中文与多行）', () => {
    const plaintext = JSON.stringify(ACCOUNTS);
    const payload = encrypt(plaintext, KEY);
    expect(payload.alg).toBe('aes-256-gcm');
    expect(payload.v).toBe(1);
    expect(decrypt(payload, KEY)).toBe(plaintext);
  });

  it('随机 IV：同一明文两次加密产生不同密文与 IV', () => {
    const p1 = encrypt('same-plaintext', KEY);
    const p2 = encrypt('same-plaintext', KEY);
    expect(p1.iv).not.toBe(p2.iv);
    expect(p1.data).not.toBe(p2.data);
  });

  it('篡改 authTag → 解密必须失败', () => {
    const payload = encrypt(JSON.stringify(ACCOUNTS), KEY);
    const tagBuf = Buffer.from(payload.tag, 'base64');
    tagBuf[0] ^= 0xff;
    payload.tag = tagBuf.toString('base64');
    expect(() => decrypt(payload, KEY)).toThrow();
  });

  it('篡改密文数据 → 解密必须失败（authTag 校验）', () => {
    const payload = encrypt(JSON.stringify(ACCOUNTS), KEY);
    const dataBuf = Buffer.from(payload.data, 'base64');
    dataBuf[dataBuf.length - 1] ^= 0xff;
    payload.data = dataBuf.toString('base64');
    expect(() => decrypt(payload, KEY)).toThrow();
  });

  it('错误密钥解密 → 抛出', () => {
    const payload = encrypt(JSON.stringify(ACCOUNTS), KEY);
    expect(() => decrypt(payload, KEY_OTHER)).toThrow();
  });
});

describe('resolveEncryptionKey', () => {
  it('未设置/空串 → null', () => {
    expect(resolveEncryptionKey({})).toBeNull();
    expect(resolveEncryptionKey({ CREDENTIAL_ENCRYPTION_KEY: '' })).toBeNull();
  });

  it('64 位 hex → 原样返回（trim 后）', () => {
    expect(resolveEncryptionKey({ CREDENTIAL_ENCRYPTION_KEY: `  ${KEY} ` })).toBe(KEY);
  });

  it('非法密钥（非 hex / 长度错）→ 抛出且消息含生成密钥指引', () => {
    for (const bad of ['zz'.repeat(32), 'a'.repeat(63), 'short-key']) {
      let msg = '';
      try {
        resolveEncryptionKey({ CREDENTIAL_ENCRYPTION_KEY: bad });
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg, `key=${bad}`).toContain('CREDENTIAL_ENCRYPTION_KEY');
      expect(msg).toContain('randomBytes(32)');
    }
  });
});

// ─── 2. CredentialStore 三后端 ───────────────────────────────────────────────

describe('CredentialStore（file 加密后端）', () => {
  it('save → 落盘为密文（不含明文 apiKey）→ load 往返一致', () => {
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    store.save(ACCOUNTS);

    expect(fs.existsSync(storeFile)).toBe(true);
    const onDisk = fs.readFileSync(storeFile, 'utf-8');
    expect(onDisk).not.toContain('sk-test-aaaa');
    expect(onDisk).not.toContain('sk-test-bbbb');
    expect(onDisk).toContain('aes-256-gcm');

    const loaded = store.load();
    expect(loaded).toEqual(ACCOUNTS);
  });

  it('密钥不匹配时 load 抛出（fail-closed，不静默返回空）', () => {
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    store.save(ACCOUNTS);
    const wrong = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY_OTHER });
    expect(() => wrong.load()).toThrow();
  });

  it('文件不存在 → load 返回空数组；无密钥 load 返回空数组', () => {
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    expect(store.load()).toEqual([]);
    const noKey = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => null });
    expect(noKey.load()).toEqual([]);
  });

  it('无密钥 save → 抛出带指引的错误', () => {
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => null });
    expect(() => store.save(ACCOUNTS)).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });
});

describe('CredentialStore（memory 后端）', () => {
  it('save/load 往返；initialMemory 可预置', () => {
    const store = new CredentialStore({ backend: 'memory', initialMemory: ACCOUNTS });
    expect(store.load()).toEqual(ACCOUNTS);
    const next = [{ id: 'b1', apiKey: 'sk-b1' }];
    store.save(next);
    expect(store.load()).toEqual(next);
  });
});

describe('CredentialStore（env 后端，T102 兼容回退）', () => {
  it('save 写 .env 与 process.env；load 读回', () => {
    const store = new CredentialStore({ backend: 'env', envVar: 'COMMANDCODE_ACCOUNTS_V1', envFilePath: envFile });
    store.save(ACCOUNTS);
    expect(parseEnvAccountsV1(process.env.COMMANDCODE_ACCOUNTS_V1)).toEqual(ACCOUNTS);
    expect(fs.readFileSync(envFile, 'utf-8')).toContain('COMMANDCODE_ACCOUNTS_V1=');
    expect(store.load()).toEqual(ACCOUNTS);
  });
});

// ─── 3. migratePlaintext（明文 → 加密文件 → .env 摘行 → .bak）────────────────

describe('CredentialStore.migratePlaintext（T103 首次带密钥迁移）', () => {
  it('明文 COMMANDCODE_ACCOUNTS_V1 → 加密文件、.env 摘行、process.env 摘除', () => {
    fs.writeFileSync(envFile, 'OTHER_KEEP_ME=1\n', 'utf-8');
    writeEnvAccountsV1(envFile, ACCOUNTS);
    expect(fs.readFileSync(envFile, 'utf-8')).toContain('COMMANDCODE_ACCOUNTS_V1=');

    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    const result = store.migratePlaintext({ envFilePath: envFile, authDir });

    expect(result.migrated).toBe(true);
    expect(result.encryptedCount).toBe(2);
    expect(result.removedEnvLine).toBe(true);
    expect(result.backedUpFiles).toEqual([]);

    // 加密文件为密文
    const onDisk = fs.readFileSync(storeFile, 'utf-8');
    expect(onDisk).not.toContain('sk-test-');
    // .env 摘行（其余内容保留）
    const envAfter = fs.readFileSync(envFile, 'utf-8');
    expect(envAfter).not.toContain('COMMANDCODE_ACCOUNTS_V1=');
    expect(envAfter).toContain('OTHER_KEEP_ME=1');
    expect(process.env.COMMANDCODE_ACCOUNTS_V1).toBeUndefined();
    // load 与迁移前一致
    expect(store.load()).toEqual(ACCOUNTS);
  });

  it('.env 中其他行在摘行时保留', () => {
    fs.writeFileSync(envFile, 'OTHER_KEEP_ME=1\n', 'utf-8');
    writeEnvAccountsV1(envFile, ACCOUNTS);
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    const result = store.migratePlaintext({ envFilePath: envFile, authDir });
    expect(result.migrated).toBe(true);
    const envAfter = fs.readFileSync(envFile, 'utf-8');
    expect(envAfter).toContain('OTHER_KEEP_ME=1');
    expect(envAfter).not.toContain('COMMANDCODE_ACCOUNTS_V1=');
  });

  it('auths/*.json 明文凭据 → 加密迁入并改名 *.plain.bak + 日志告警提示删除', () => {
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'acc.json'), JSON.stringify(ACCOUNTS), 'utf-8');

    const warnSpy = vi.spyOn(logger, 'warn');
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    const result = store.migratePlaintext({ envFilePath: envFile, authDir });

    expect(result.migrated).toBe(true);
    expect(result.encryptedCount).toBe(2);
    expect(result.backedUpFiles).toHaveLength(1);
    expect(result.backedUpFiles[0]).toMatch(/acc\.json\.plain\.bak$/);
    expect(fs.existsSync(path.join(authDir, 'acc.json'))).toBe(false);
    // 明文保留在 .bak 中（可恢复），但不再被扫描
    const bak = fs.readFileSync(path.join(authDir, 'acc.json.plain.bak'), 'utf-8');
    expect(bak).toContain('sk-test-aaaa');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('.plain.bak'))).toBe(true);

    expect(store.load()).toEqual(ACCOUNTS);
  });

  it('幂等：二次迁移为 no-op；.bak 不再被当作明文来源扫描', () => {
    writeEnvAccountsV1(envFile, ACCOUNTS);
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    store.migratePlaintext({ envFilePath: envFile, authDir });

    const once = fs.readFileSync(storeFile, 'utf-8');
    const result = store.migratePlaintext({ envFilePath: envFile, authDir });
    expect(result.migrated).toBe(false);
    expect(fs.readFileSync(storeFile, 'utf-8')).toBe(once);
    expect(store.load()).toEqual(ACCOUNTS);
  });

  it('已有加密库时再次出现明文（面板保存回写 .env）→ 增量吸收并摘行', () => {
    const first = [{ id: 'a1', apiKey: 'sk-test-aaaa' }];
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    store.save(first);

    writeEnvAccountsV1(envFile, [{ id: 'a2', apiKey: 'sk-test-bbbb' }]);
    const result = store.migratePlaintext({ envFilePath: envFile, authDir });
    expect(result.migrated).toBe(true);

    const ids = store.load().map(a => a.id).sort();
    expect(ids).toEqual(['a1', 'a2']);
    expect(fs.readFileSync(envFile, 'utf-8')).not.toContain('COMMANDCODE_ACCOUNTS_V1=');
  });

  it('无密钥 → 迁移拒绝并抛出带指引的错误', () => {
    writeEnvAccountsV1(envFile, ACCOUNTS);
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => null });
    expect(() => store.migratePlaintext({ envFilePath: envFile, authDir })).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    // 未产生任何落盘
    expect(fs.existsSync(storeFile)).toBe(false);
  });

  it('非 file 后端不支持迁移', () => {
    const store = new CredentialStore({ backend: 'memory' });
    expect(() => store.migratePlaintext({})).toThrow(/file/);
  });

  it('无明文来源 → migrated:false，不生成加密文件', () => {
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    const result = store.migratePlaintext({ envFilePath: envFile, authDir });
    expect(result.migrated).toBe(false);
    expect(fs.existsSync(storeFile)).toBe(false);
  });

  it('auths/*.json 不含 apiKey → 不算明文凭据来源，不改名', () => {
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'meta.json'), JSON.stringify([{ id: 'a1', name: 'No Key' }]), 'utf-8');
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    const result = store.migratePlaintext({ envFilePath: envFile, authDir });
    expect(result.migrated).toBe(false);
    expect(fs.existsSync(path.join(authDir, 'meta.json'))).toBe(true);
  });
});

// ─── 4. 启动校验：有明文 + 无密钥 → 拒绝启动并给出迁移指引 ────────────────────

describe('assertCredentialsEncryptedOrThrow（启动校验）', () => {
  it('无凭据 + 无密钥 → 放行', () => {
    expect(() => assertCredentialsEncryptedOrThrow({ envFilePath: envFile, authDir })).not.toThrow();
  });

  it('明文 .env + 无密钥 → 抛出含生成密钥指引的错误', () => {
    writeEnvAccountsV1(envFile, ACCOUNTS);
    let msg = '';
    try {
      assertCredentialsEncryptedOrThrow({ envFilePath: envFile, authDir });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('CREDENTIAL_ENCRYPTION_KEY');
    expect(msg).toContain('randomBytes(32)');
    expect(msg).toContain('COMMANDCODE_ACCOUNTS_V1');
  });

  it('auths/*.json 明文 + 无密钥 → 抛出', () => {
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'acc.json'), JSON.stringify(ACCOUNTS), 'utf-8');
    expect(() => assertCredentialsEncryptedOrThrow({ envFilePath: envFile, authDir })).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('已有加密库 + 无密钥 → 抛出（凭据存在但不可读）', () => {
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    store.save(ACCOUNTS);
    try {
      assertCredentialsEncryptedOrThrow({ envFilePath: envFile, authDir, storeFilePath: storeFile });
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('CREDENTIAL_ENCRYPTION_KEY');
      expect(msg).toContain('credentials.enc');
    }
  });

  it('明文 + 有效密钥 → 放行（由 migratePlaintext 完成加密）', () => {
    writeEnvAccountsV1(envFile, ACCOUNTS);
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
    expect(() => assertCredentialsEncryptedOrThrow({ envFilePath: envFile, authDir })).not.toThrow();
  });

  it('无效密钥（格式错）→ 抛出含指引的错误（fail-closed）', () => {
    writeEnvAccountsV1(envFile, ACCOUNTS);
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'not-a-hex-key';
    expect(() => assertCredentialsEncryptedOrThrow({ envFilePath: envFile, authDir })).toThrow(/randomBytes\(32\)/);
  });

  it('detectPlaintextCredentials 报告来源与加密库存在性', () => {
    expect(detectPlaintextCredentials({ envFilePath: envFile, authDir, storeFilePath: storeFile })).toEqual({
      sources: [],
      hasEncryptedStore: false,
    });
    writeEnvAccountsV1(envFile, ACCOUNTS);
    const detected = detectPlaintextCredentials({ envFilePath: envFile, authDir, storeFilePath: storeFile });
    expect(detected.sources.length).toBe(1);
    expect(detected.sources[0]).toContain('COMMANDCODE_ACCOUNTS_V1');
  });
});

// ─── 5. chmod 0600（仅 POSIX；Windows 依赖用户目录 ACL，skip）─────────────────

describe('加密文件权限（POSIX 0600）', () => {
  it.runIf(process.platform !== 'win32')('file 后端 save 后文件权限为 0600', () => {
    const store = new CredentialStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
    store.save(ACCOUNTS);
    const mode = fs.statSync(storeFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ─── 6. loadConfig 集成：加密存储优先，COMMANDCODE_ACCOUNTS_V1 兼容回退 ───────

describe('loadConfig 集成（T103 账号读取优先级）', () => {
  it('密钥可用且加密库有数据 → 账号来自加密文件（env 明文被忽略）', async () => {
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({ providers: { commandcode: { accountsMeta: [{ id: 'a1', name: 'Meta One' }] } } }),
      'utf-8',
    );
    // env 明文残留（含不同账号 a2）——密钥可用时不得采用
    writeEnvAccountsV1(envFile, [{ id: 'a2', apiKey: 'sk-test-bbbb' }]);
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
    process.env.CREDENTIAL_STORE_PATH = storeFile;
    process.env.COMMANDCODE_CONFIG_PATH = configFile;
    process.env.COMMANDCODE_ENV_PATH = envFile;
    vi.resetModules();
    try {
      const { CredentialStore: FreshStore } = await import('../src/utils/credential-store.js');
      const store = new FreshStore({ backend: 'file', filePath: storeFile, keyResolver: () => KEY });
      store.save([{ id: 'a1', name: 'Enc One', apiKey: 'sk-test-aaaa' }]);

      const config = await import('../src/utils/config.js');
      const loaded = config.loadConfig();
      expect(loaded.accounts.map(a => a.id)).toEqual(['a1']);
      expect(loaded.accounts[0].apiKey).toBe('sk-test-aaaa');
    } finally {
      delete process.env.COMMANDCODE_CONFIG_PATH;
      delete process.env.COMMANDCODE_ENV_PATH;
      vi.resetModules();
    }
  });

  it('无密钥/无加密库 → COMMANDCODE_ACCOUNTS_V1 兼容回退（T102 行为不回归）', async () => {
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({}), 'utf-8');
    writeEnvAccountsV1(envFile, [{ id: 'a2', apiKey: 'sk-test-bbbb' }]);
    process.env.COMMANDCODE_CONFIG_PATH = configFile;
    process.env.COMMANDCODE_ENV_PATH = envFile;
    vi.resetModules();
    try {
      const config = await import('../src/utils/config.js');
      const loaded = config.loadConfig();
      expect(loaded.accounts.map(a => a.id)).toEqual(['a2']);
      expect(loaded.accounts[0].apiKey).toBe('sk-test-bbbb');
    } finally {
      delete process.env.COMMANDCODE_CONFIG_PATH;
      delete process.env.COMMANDCODE_ENV_PATH;
      vi.resetModules();
    }
  });
});
