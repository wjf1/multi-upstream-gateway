// =============================================================================
// WorkBuddy sidecar 启动契约（T310 演练发现并修复）
// -----------------------------------------------------------------------------
// 背景：T310 的「OAuth 全链路演练」首次用真实 Go 二进制（workbuddy2api-panel）
// 拉起 sidecar，立刻暴露一处契约断点——网关原先传 `--listen/--auth-dir/--api-key`，
// 而二进制只认 `-config`（Go flag 包遇未知参数直接 usage + exit 2）：
//
//   $ workbuddy-sidecar.exe --listen 127.0.0.1:8787 --api-key k
//   flag provided but not defined: -listen      → EXIT=2
//
// 后果：网关拉起的 sidecar 立刻崩，F06 真机演练根本进不去；单测因为全用假 sidecar
// 而全绿（mock 掩盖了真实 CLI 契约）。故本文件把**真实二进制的契约**钉死：
//   [x] 启动参数只有 `-config <path>`，且**不得出现 `--listen` 等未知标志**；
//   [x] 网关把 listen/api_key/auth_dir/state_file 落进该配置文件（二进制读它）；
//   [x] 面板可热改的其它键在重写时被保留（深合并，不整份覆盖）；
//   [x] `WORKBUDDY_SIDECAR_CONFIG` 可显式指定落点；
//   [x] 配置文件写不进去时**不 spawn**（宁可侧车缺席，也不留一个必然崩的进程）。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WorkBuddyProvider,
  WORKBUDDY_SIDECAR_BIN_ENV,
  WORKBUDDY_SIDECAR_CONFIG_ENV,
} from '../src/providers/workbuddy/provider.js';
import type { WorkBuddySidecar, WorkBuddySidecarOptions } from '../src/providers/workbuddy/sidecar.js';
import type { WorkBuddyBalanceWatch } from '../src/providers/workbuddy/balance-watch.js';

let dir = '';
const BIN = 'C:/fake/workbuddy-sidecar.exe';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wb-launch-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeSidecar(): WorkBuddySidecar {
  return {
    baseUrl: 'http://127.0.0.1:8787',
    status: () => null,
    start: async () => undefined,
    stop: async () => undefined,
  } as unknown as WorkBuddySidecar;
}

/** 注入假余额镜像，避免测试触碰真实 data/state.json。 */
function fakeBalanceWatch(): WorkBuddyBalanceWatch {
  return {
    initialize: async () => undefined,
    drain: async () => undefined,
  } as unknown as WorkBuddyBalanceWatch;
}

interface Launch {
  opts: WorkBuddySidecarOptions | null;
  configPath: string;
  read: () => Record<string, unknown>;
}

async function launch(over: { env?: NodeJS.ProcessEnv; provider?: Record<string, unknown> } = {}): Promise<Launch> {
  let captured: WorkBuddySidecarOptions | null = null;
  const provider = new WorkBuddyProvider({
    env: {
      [WORKBUDDY_SIDECAR_BIN_ENV]: BIN,
      COMMANDCODE_STATE_PATH: path.join(dir, 'state.json'),
      ...(over.env ?? {}),
    },
    createSidecar: (opts) => {
      captured = opts;
      return fakeSidecar();
    },
    balanceWatch: fakeBalanceWatch(),
    fetchFn: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
  });
  // initialize 收的是 provider-scoped 扁平配置（与本仓其它 workbuddy 测试一致）。
  await provider.initialize({ enabled: true, ...(over.provider ?? {}) });
  const configPath = (captured as WorkBuddySidecarOptions | null)?.args?.[1] ?? '';
  return {
    get opts() {
      return captured;
    },
    configPath,
    read: () => JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>,
  };
}

describe('sidecar 启动参数（真实二进制契约）', () => {
  it('只传 -config <绝对路径>，且不含 --listen 等未知标志', async () => {
    const l = await launch();
    expect(l.opts?.args).toEqual(['-config', path.join(dir, 'workbuddy-sidecar', 'config.json')]);
    for (const bad of ['--listen', '--auth-dir', '--api-key']) {
      expect(l.opts?.args ?? []).not.toContain(bad);
    }
    expect(path.isAbsolute(l.configPath)).toBe(true);
  });

  it('配置文件按二进制字段名落 listen/api_key/auth_dir/state_file', async () => {
    const l = await launch();
    const cfg = l.read();
    expect(cfg.listen).toBe('127.0.0.1:8787');
    expect(cfg.api_key).toBe('');
    expect(cfg.auth_dir).toBe(path.join(dir, 'workbuddy-sidecar', 'auths'));
    expect(cfg.state_file).toBe(path.join(dir, 'workbuddy-sidecar', 'state.json'));
  });

  it('WORKBUDDY_SIDECAR_PORT 进 listen；sidecar.apiKey 进 api_key', async () => {
    const l = await launch({
      env: { WORKBUDDY_SIDECAR_PORT: '9911', WORKBUDDY_SIDECAR_KEY: 'sk-secret' },
    });
    const cfg = l.read();
    expect(cfg.listen).toBe('127.0.0.1:9911');
    expect(cfg.api_key).toBe('sk-secret');
  });

  it('authDir 显式配置时覆盖默认落点', async () => {
    const l = await launch({ provider: { authDir: 'D:/wb-auths' } });
    expect(l.read().auth_dir).toBe('D:/wb-auths');
  });

  it('重写时保留面板可热改的既有键（深合并不整份覆盖）', async () => {
    const target = path.join(dir, 'workbuddy-sidecar', 'config.json');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ cooldown: { soft_rate: '900s' }, custom: 42 }), 'utf8');

    const l = await launch();
    const cfg = l.read();
    expect(cfg.cooldown).toEqual({ soft_rate: '900s' });
    expect(cfg.custom).toBe(42);
    expect(cfg.listen).toBe('127.0.0.1:8787');
  });

  it('WORKBUDDY_SIDECAR_CONFIG 可显式指定落点', async () => {
    const explicit = path.join(dir, 'elsewhere', 'wb.json');
    const l = await launch({ env: { [WORKBUDDY_SIDECAR_CONFIG_ENV]: explicit } });
    expect(l.configPath).toBe(explicit);
    expect(l.read().listen).toBe('127.0.0.1:8787');
  });
});

describe('配置写不进去时不 spawn', () => {
  it('落点是文件之父目录（ENOTDIR）时静默跳过 spawn，initialized 仍为 true', async () => {
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const l = await launch({ env: { [WORKBUDDY_SIDECAR_CONFIG_ENV]: path.join(blocker, 'wb.json') } });
    expect(l.opts).toBeNull();
  });
});
