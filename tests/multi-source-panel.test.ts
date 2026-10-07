// =============================================================================
// T210/T211/T212 回归防线：多源面板的后端消费面
// -----------------------------------------------------------------------------
// 1. GET /api/providers/:name/accounts（T210）—— listAccounts 委托（凭据脱敏
//    由 Provider 契约保证）；未知 provider / 未装配 runtime → 404；
// 2. GET /api/usage/by-provider（T212，§3.9）—— summarizeByProvider 分口径：
//    provider 各自成行、美元不跨上游混加、native.points 并列展示；
// 3. 前端接线（T211）：models.js 对命名空间模型（freebuff/<id>）打徽章。
// 取证源：index.html + public/js/{models,accounts,usage,upstream}.js。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderRuntime } from '../src/providers/runtime.js';

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
const modelsJs = readFileSync(path.join(root, 'public', 'js', 'models.js'), 'utf-8');
const accountsJs = readFileSync(path.join(root, 'public', 'js', 'accounts.js'), 'utf-8');
const usageJs = readFileSync(path.join(root, 'public', 'js', 'usage.js'), 'utf-8');

let stateDir = '';
let usageFile = '';
let dashboardRoutes: typeof import('../src/routes/dashboard.js')['dashboardRoutes'];

/** 空转 runtime：只有 get(name) 需要（accounts 端点委托 listAccounts）。 */
function makeStub(accountsByProvider: Record<string, Array<Record<string, unknown>>>): ProviderRuntime {
  return {
    get: (name: string) => {
      if (!(name in accountsByProvider)) return undefined;
      return { listAccounts: () => accountsByProvider[name] };
    },
  } as unknown as ProviderRuntime;
}

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-t210-'));
  usageFile = path.join(stateDir, 'usage.jsonl');
  process.env.USAGE_HISTORY_PATH = usageFile;
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_ENV_PATH = path.join(stateDir, '.env');
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  // 两条本地用量记录：commandcode 计美元、workbuddy 积分（§3.9 分口径的输入）。
  const now = new Date().toISOString();
  writeFileSync(usageFile, [
    JSON.stringify({ timestamp: now, provider: 'commandcode', model: 'glm-4.7', inputTokens: 100, outputTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 0, timingMs: 120, costUsd: 0.01, costSource: 'official', status: 'COMPLETED', mode: 'chat' }),
    JSON.stringify({ timestamp: now, provider: 'workbuddy', model: 'glm-5.2', inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, timingMs: 90, costUsd: 0, costSource: 'estimated', status: 'COMPLETED', mode: 'chat', native: { points: 7 } }),
    JSON.stringify({ timestamp: now, model: 'legacy-model', inputTokens: 10, outputTokens: 5, timingMs: 30, costUsd: 0, status: 'COMPLETED', mode: 'chat' }),
  ].join('\n'), 'utf-8');
  ({ dashboardRoutes } = await import('../src/routes/dashboard.js'));
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.USAGE_HISTORY_PATH;
});

function appWith(stub?: ProviderRuntime): FastifyInstance {
  const app = Fastify();
  if (stub) app.decorate('providerRuntime', stub);
  void app.register(dashboardRoutes);
  return app;
}

describe('GET /api/providers/:name/accounts（T210）', () => {
  it('委托 listAccounts；未装配 runtime / 未知 provider → 404', async () => {
    const stub = makeStub({
      freebuff: [{ id: 'fb-1', name: 'Freebuff fb-1', apiKey: '****abcd', addedAt: '' }],
      workbuddy: [],
    });
    const app = appWith(stub);
    await app.ready();
    try {
      const ok = await app.inject({ method: 'GET', url: '/api/providers/freebuff/accounts' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ provider: 'freebuff', accounts: [{ id: 'fb-1', name: 'Freebuff fb-1', apiKey: '****abcd', addedAt: '' }] });

      const empty = await app.inject({ method: 'GET', url: '/api/providers/workbuddy/accounts' });
      expect(empty.statusCode).toBe(200);
      expect(empty.json().accounts).toEqual([]);

      const unknown = await app.inject({ method: 'GET', url: '/api/providers/nope/accounts' });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await app.close();
    }

    const bare = appWith();
    await bare.ready();
    try {
      const r = await bare.inject({ method: 'GET', url: '/api/providers/freebuff/accounts' });
      expect(r.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe('GET /api/usage/by-provider（T212，§3.9 分口径）', () => {
  it('按上游成行汇总；旧记录归一 commandcode；native.points 并列展示', async () => {
    const app = appWith();
    await app.ready();
    try {
      const r = await app.inject({ method: 'GET', url: '/api/usage/by-provider' });
      expect(r.statusCode).toBe(200);
      const summary = r.json().summary;
      expect(summary.map((s: { provider: string }) => s.provider)).toEqual(['commandcode', 'workbuddy']);
      const cc = summary[0];
      expect(cc.runs).toBe(2); // 含缺 provider 字段的 legacy 行（归一为 commandcode）
      expect(cc.inputTokens).toBe(110);
      expect(cc.outputTokens).toBe(45);
      expect(cc.cacheReadTokens).toBe(30);
      expect(cc.costUsd).toBeCloseTo(0.01, 6);
      const wb = summary[1];
      expect(wb.runs).toBe(1);
      expect(wb.costUsd).toBe(0);
      expect(wb.native).toEqual({ points: 7 });
    } finally {
      await app.close();
    }
  });
});

describe('前端接线（T210/T211/T212）', () => {
  it('accounts.js 消费 /api/providers 与 /api/providers/:name/accounts', () => {
    expect(accountsJs).toContain("apiJson('/api/providers')");
    expect(accountsJs).toContain("'/api/providers/' + encodeURIComponent(p.name) + '/accounts'");
    expect(accountsJs).toContain('loadMultiSourceAccounts');
    expect(html).toContain('id="multiSourceAccountsBody"');
  });

  it('usage.js 消费 /api/usage/by-provider 且不做跨上游加总', () => {
    expect(usageJs).toContain("apiJson('/api/usage/by-provider')");
    expect(usageJs).toContain('providerCostCell');
    expect(usageJs).toContain("registerRefresh('usage', loadProviderUsage, 30000)");
    expect(html).toContain('id="providerUsageBody"');
  });

  it('models.js 对命名空间模型打徽章（freebuff/<id> / workbuddy/<id>）', () => {
    expect(modelsJs).toContain("m.id.indexOf('/')");
    expect(modelsJs).toContain('多上游命名空间模型');
  });

  it('页面脚本仍是纯 JS（无 TS 语法），动态文本 esc', () => {
    for (const s of [modelsJs, accountsJs, usageJs]) {
      expect(() => new Function(s)).not.toThrow();
    }
    expect(accountsJs).toContain("esc(a.name || a.id)");
    expect(usageJs).toContain("esc(PROVIDER_LABELS[r.provider] || r.provider)");
  });
});
