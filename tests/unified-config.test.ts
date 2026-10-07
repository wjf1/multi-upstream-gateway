// =============================================================================
// 统一配置体系测试（T102 DoD）
// -----------------------------------------------------------------------------
// 覆盖：旧形态自动迁移（幂等/凭据入 .env/未知键保留）、Zod 校验（默认值、
// 密钥键扫描拒绝加载并给出字段路径）、chokidar 热重载（2s 内生效、校验失败
// 保留旧状态）、以及 loadConfig 真实启动路径的迁移钩子 + env 账号合并集成。
// =============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UnifiedConfigSchema,
  UnifiedConfigStore,
  formatZodError,
  migrateLegacyConfig,
  migrateLegacyConfigIfNeeded,
  parseEnvAccountsV1,
  parseUnifiedConfig,
  writeEnvAccountsV1,
} from '../src/utils/unified-config.js';

const MB = 1024 * 1024;
const BODY_FALLBACK = 64 * MB;

let work: { dir: string; configFile: string; envFile: string };

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-config-'));
  work = { dir, configFile: path.join(dir, 'config.json'), envFile: path.join(dir, '.env') };
});

afterEach(() => {
  fs.rmSync(work.dir, { recursive: true, force: true });
  delete process.env.COMMANDCODE_ACCOUNTS_V1;
});

// ─── 旧形态迁移 ───────────────────────────────────────────────────────────────

const LEGACY_CONFIG = {
  port: 9090,
  host: '127.0.0.1',
  activeAccountId: 'a2',
  rotationMode: 'auto-quota',
  upstream: { apiBase: 'https://api.example.dev', timeoutMs: 12345 },
  accounts: [
    { id: 'a1', name: 'Account One', apiKey: 'sk-test-aaaa', addedAt: '2026-01-01T00:00:00Z' },
    { id: 'a2', name: 'Account Two', apiKey: 'sk-test-bbbb', addedAt: '2026-01-02T00:00:00Z' },
  ],
  customFoo: 'keep-me',
};

describe('migrateLegacyConfig（旧形态 → unified）', () => {
  it('承接 commandcode 分片、摘出凭据、保留未知键', () => {
    const outcome = migrateLegacyConfig(LEGACY_CONFIG);
    expect(outcome.migrated).toBe(true);
    const next = outcome.nextFileJson!;
    const cc = (next as any).providers.commandcode;
    expect(cc.rotationMode).toBe('auto-quota');
    expect(cc.activeAccountId).toBe('a2');
    expect(cc.upstream.apiBase).toBe('https://api.example.dev');
    expect(cc.accountsMeta).toHaveLength(2);
    expect(cc.accountsMeta[0]).not.toHaveProperty('apiKey');
    expect(next.accounts).toBeUndefined();
    expect(next.customFoo).toBe('keep-me');
    expect(outcome.credentials.map(c => c.apiKey)).toEqual(['sk-test-aaaa', 'sk-test-bbbb']);
    expect(outcome.credentials[0]).toMatchObject({ id: 'a1', name: 'Account One' });
  });

  it('幂等：已是 unified 形态（含 providers 键）不再迁移', () => {
    const unified = { providers: { commandcode: {} } };
    expect(migrateLegacyConfig(unified).migrated).toBe(false);
    expect(migrateLegacyConfig({}).migrated).toBe(false);
    expect(migrateLegacyConfig(null).migrated).toBe(false);
  });
});

describe('migrateLegacyConfigIfNeeded（落盘行为）', () => {
  it('原子写回新结构并把凭据写入 .env 的 COMMANDCODE_ACCOUNTS_V1', () => {
    fs.writeFileSync(work.configFile, JSON.stringify(LEGACY_CONFIG), 'utf-8');
    migrateLegacyConfigIfNeeded(work.configFile, work.envFile);

    const after = JSON.parse(fs.readFileSync(work.configFile, 'utf-8'));
    expect(after.providers.commandcode.upstream.timeoutMs).toBe(12345);
    expect(after.accounts).toBeUndefined();
    expect(after.customFoo).toBe('keep-me');
    expect(JSON.stringify(after)).not.toContain('sk-test-');

    const envText = fs.readFileSync(work.envFile, 'utf-8');
    const line = envText.split(/\r?\n/).find(l => l.startsWith('COMMANDCODE_ACCOUNTS_V1='));
    expect(line).toBeTruthy();
    const decoded = parseEnvAccountsV1(line!.split('=')[1]);
    expect(decoded.map(a => a.apiKey)).toEqual(['sk-test-aaaa', 'sk-test-bbbb']);
  });

  it('幂等：二次执行不重复改写（凭据行不重复）', () => {
    fs.writeFileSync(work.configFile, JSON.stringify(LEGACY_CONFIG), 'utf-8');
    migrateLegacyConfigIfNeeded(work.configFile, work.envFile);
    const once = fs.readFileSync(work.configFile, 'utf-8');
    const envOnce = fs.readFileSync(work.envFile, 'utf-8');
    migrateLegacyConfigIfNeeded(work.configFile, work.envFile);
    expect(fs.readFileSync(work.configFile, 'utf-8')).toBe(once);
    expect(fs.readFileSync(work.envFile, 'utf-8')).toBe(envOnce);
    expect(envOnce.match(/COMMANDCODE_ACCOUNTS_V1=/g)).toHaveLength(1);
  });
});

// ─── Zod 校验与密钥扫描 ───────────────────────────────────────────────────────

describe('parseUnifiedConfig（校验与默认值）', () => {
  it('空对象 → §3.2 全量默认值（strict 降级、rewriteMode=full、风险门关闭）', () => {
    const cfg = parseUnifiedConfig({}, BODY_FALLBACK);
    expect(cfg.port).toBe(9090);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.acceptedRiskDisclaimer).toBe(false);
    expect(cfg.routing.fallbackStrategy).toBe('strict');
    expect(cfg.routing.modelPrefixRouting).toBe(true);
    expect(cfg.degradation.queueMaxDepth).toBe(128);
    expect(cfg.degradation.rampStartPercent).toBe(10);
    expect(cfg.providers.workbuddy.rewriteMode).toBe('full');
    expect(cfg.providers.workbuddy.pointsPerUsdRate).toBeNull();
    expect(cfg.providers.commandcode.enabled).toBe(true);
    expect(cfg.rateLimit.global).toEqual({});
    expect(cfg.storage.statePath).toBe('data/state.json');
    expect(cfg.maxBodySize).toBe(BODY_FALLBACK);
  });

  it('providers 分片出现凭据形状的键 → 拒绝加载并给出字段路径', () => {
    for (const [json, badPath] of [
      [{ providers: { freebuff: { token: 'sk-xxx' } } }, 'providers.freebuff.token'],
      [{ providers: { workbuddy: { apiKey: 'sk-yyy' } } }, 'providers.workbuddy.apiKey'],
      [{ providers: { commandcode: { upstream: { credential: 'zzz' } } } }, 'providers.commandcode.upstream.credential'],
    ] as Array<[Record<string, unknown>, string]>) {
      let msg = '';
      try {
        parseUnifiedConfig(json, BODY_FALLBACK);
      } catch (err) {
        msg = formatZodError(err as never);
      }
      expect(msg, JSON.stringify(json)).toContain(badPath);
      expect(msg).toContain('environment');
    }
  });

  it('未知键 passthrough 保留（升级不丢自定义配置）', () => {
    const cfg = parseUnifiedConfig({ customTop: 1, providers: { freebuff: { customNested: true } } }, BODY_FALLBACK);
    expect((cfg as Record<string, unknown>).customTop).toBe(1);
  });

  it('schema 直接暴露（类型测试用）', () => {
    expect(UnifiedConfigSchema.safeParse({ acceptedRiskDisclaimer: true }).success).toBe(true);
  });
});

// ─── .env 凭据写入 ────────────────────────────────────────────────────────────

describe('writeEnvAccountsV1', () => {
  it('写入并同步 process.env；重复写入整行替换不追加', () => {
    writeEnvAccountsV1(work.envFile, [{ id: 'a1', apiKey: 'sk-1' }]);
    expect(process.env.COMMANDCODE_ACCOUNTS_V1).toBeTruthy();
    const first = fs.readFileSync(work.envFile, 'utf-8');
    writeEnvAccountsV1(work.envFile, [{ id: 'a1', apiKey: 'sk-2' }]);
    const second = fs.readFileSync(work.envFile, 'utf-8');
    expect(second.match(/COMMANDCODE_ACCOUNTS_V1=/g)).toHaveLength(1);
    expect(second).not.toBe(first);
    expect(parseEnvAccountsV1(process.env.COMMANDCODE_ACCOUNTS_V1)[0].apiKey).toBe('sk-2');
  });

  it('损坏的 COMMANDCODE_ACCOUNTS_V1 解析失败返回空数组而非抛出', () => {
    expect(parseEnvAccountsV1('not-base64-json!!!')).toEqual([]);
    expect(parseEnvAccountsV1(undefined)).toEqual([]);
  });
});

// ─── 热重载（chokidar）───────────────────────────────────────────────────────

describe('UnifiedConfigStore 热重载', () => {
  it('配置变更在 2s 内热生效；校验失败保留旧状态', async () => {
    fs.writeFileSync(work.configFile, JSON.stringify({ acceptedRiskDisclaimer: false }), 'utf-8');
    const store = new UnifiedConfigStore({
      configFilePath: work.configFile,
      envFilePath: work.envFile,
      maxBodySizeFallbackBytes: BODY_FALLBACK,
      debounceMs: 50,
    });
    await store.start();
    try {
      expect(store.get().acceptedRiskDisclaimer).toBe(false);

      // 变更 → ≤2s 热生效（DoD 断言）
      const changed = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('onChange not fired within 2s')), 2000);
        store.onChange(() => {
          clearTimeout(t);
          resolve();
        });
      });
      fs.writeFileSync(
        work.configFile,
        JSON.stringify({ acceptedRiskDisclaimer: true, routing: { defaultProvider: 'freebuff' } }),
        'utf-8',
      );
      await changed;
      expect(store.get().acceptedRiskDisclaimer).toBe(true);
      expect(store.get().routing.defaultProvider).toBe('freebuff');

      // 写入非法配置（凭据键）→ onError、旧状态保留
      const errored = new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('onLoadError not fired within 2s')), 2000);
        store.onLoadError(msg => {
          clearTimeout(t);
          resolve(msg);
        });
      });
      fs.writeFileSync(
        work.configFile,
        JSON.stringify({ acceptedRiskDisclaimer: true, providers: { freebuff: { token: 'sk-bad' } } }),
        'utf-8',
      );
      const errMsg = await errored;
      expect(errMsg).toContain('providers.freebuff.token');
      expect(store.get().routing.defaultProvider).toBe('freebuff'); // 旧状态保留
    } finally {
      await store.stop();
    }
  });
});

// ─── 集成：loadConfig 真实路径的迁移钩子 + env 账号合并 + 保存形态保持 ─────────

describe('loadConfig 集成（T102 启动迁移）', () => {
  it('旧 config.json 启动即迁移，账号凭据经 .env 合并回 loadConfig 结果', async () => {
    fs.writeFileSync(work.configFile, JSON.stringify(LEGACY_CONFIG), 'utf-8');
    process.env.COMMANDCODE_CONFIG_PATH = work.configFile;
    process.env.COMMANDCODE_ENV_PATH = work.envFile;
    vi.resetModules();
    try {
      const config = await import('../src/utils/config.js');
      const loaded = config.loadConfig();

      // 迁移发生：文件已是 unified 形态
      const after = JSON.parse(fs.readFileSync(work.configFile, 'utf-8'));
      expect(after.providers).toBeTruthy();
      expect(after.accounts).toBeUndefined();

      // 凭据经 .env 合并回来：账号列表与迁移前等价
      expect(loaded.accounts.map(a => a.id)).toEqual(['a1', 'a2']);
      expect(loaded.accounts[0].apiKey).toBe('sk-test-aaaa');
      expect(loaded.accounts[1].apiKey).toBe('sk-test-bbbb');
      expect(loaded.rotationMode).toBe('auto-quota');
      expect(loaded.activeAccountId).toBe('a2');
      expect(loaded.ccApiBase).toBe('https://api.example.dev');
      expect(loaded.upstreamTimeoutMs).toBe(12345);

      // 面板式保存：保持 unified 形态、凭据只进 .env、loadConfig 仍能读到
      config.saveConfigFile({ activeAccountId: 'a1' });
      const afterSave = JSON.parse(fs.readFileSync(work.configFile, 'utf-8'));
      expect(afterSave.providers).toBeTruthy();
      expect(afterSave.providers.commandcode.activeAccountId).toBe('a1');
      expect(JSON.stringify(afterSave)).not.toContain('sk-test-');
      expect(fs.readFileSync(work.envFile, 'utf-8')).toContain('COMMANDCODE_ACCOUNTS_V1=');

      const reloaded = config.loadConfig();
      expect(reloaded.activeAccountId).toBe('a1');
      expect(reloaded.accounts[0].apiKey).toBe('sk-test-aaaa');
    } finally {
      delete process.env.COMMANDCODE_CONFIG_PATH;
      delete process.env.COMMANDCODE_ENV_PATH;
      vi.resetModules();
    }
  });
});
