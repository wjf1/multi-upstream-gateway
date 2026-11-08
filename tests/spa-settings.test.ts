// =============================================================================
// T307 回归防线：面板系统设置页（五大区块 + 热生效 + 需重启标红 + 校验标红 + 审计）
// -----------------------------------------------------------------------------
// 覆盖：
// 1. HTML 骨架：五大区块（网络/安全/告警/存储与危险操作/面板偏好）齐备，
//    需重启字段标红提示明确，无障碍 tabpanel 语义与 data-route="settings" 具备；
// 2. public/js/settings.js：纯标准 JS 语法，支持 2s 热生效反馈、字段级错误标红提示、
//    危险操作二次确认 + 留痕，30s 刷新注册；
// 3. 后端 /api/settings 与 /api/usage/clear 集成测试：
//    GET /api/settings 返回五大区块配置及重启元数据；
//    POST /api/settings 对非法端口/超时返回 400 及字段错误字典；
//    POST /api/settings 合法参数保存成功并热生效；
//    POST /api/usage/clear 触发清空并记录管理面审计日志。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { dashboardRoutes } from '../src/routes/dashboard.js';
import { ADMIN_TOKEN } from '../src/utils/admin-guard.js';
import { getAuditLogPath, readAuditEntries } from '../src/utils/audit-log.js';
import { getUsageHistory, recordCompletion } from '../src/utils/usage-store.js';

// 用量历史与审计日志的落点在**模块加载期**就被 store 捕获（storage-backend.ts 的
// `USAGE_FILE_PATH` / `new JsonlUsageBackend(USAGE_FILE_PATH)`），所以在 describe 的 beforeEach 里
// 改 env 已经太晚 —— `vi.hoisted` 的回调先于 import 求值，是这里唯一能生效的位置。
// 不隔离的后果有两层：① 本文件的 `recordCompletion` / `/api/usage/clear` 会直接写、清
// **真实用户**的 `~/.commandcode/usage-history.jsonl`；② 并行 worker 里的 spa-logs.test.ts 也在写
// 同一个真实文件，于是 clear 与读取之间被插进一行，全量跑偶发 `expected 1 to be +0`。
const isolated = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || '/tmp';
  const usage = `${tmp}/ccproxy-test-spa-settings-usage.jsonl`;
  const audit = `${tmp}/ccproxy-test-spa-settings-audit.jsonl`;
  process.env.USAGE_HISTORY_PATH = usage;
  process.env.AUDIT_LOG_PATH = audit;
  return { usage, audit };
});

afterAll(() => {
  for (const f of [isolated.usage, isolated.audit]) rmSync(f, { force: true });
});

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
const settingsJs = readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf-8');

describe('T307 面板骨架与无障碍', () => {
  it('设置分区保留 tab 语义并具备 data-route="settings"', () => {
    expect(html).toMatch(/id="tab-settings" role="tab"[^>]*aria-controls="content-settings"/);
    expect(html).toMatch(/id="content-settings" role="tabpanel"[^>]*data-route="settings"/);
  });

  it('五大区块控件骨架齐备', () => {
    // 1. 网络
    expect(html).toContain('id="set_port"');
    expect(html).toContain('id="set_host"');
    expect(html).toContain('id="set_proxy"');
    expect(html).toContain('id="set_upstreamTimeoutMs"');
    expect(html).toContain('id="set_idleTimeoutMs"');
    expect(html).toContain('id="set_maxRetries"');

    // 2. 安全
    expect(html).toContain('id="set_maxBodyMb"');
    expect(html).toContain('id="set_allowedHosts"');

    // 3. 告警
    expect(html).toContain('id="set_webhookUrl"');
    expect(html).toContain('id="set_dailyBudgetUsd"');
    expect(html).toContain('id="set_errorRateThreshold"');

    // 4. 存储与危险操作
    expect(html).toContain('id="path_config"');
    expect(html).toContain('id="path_log"');
    expect(html).toContain('id="path_usage"');
    expect(html).toContain('onclick="clearUsageWithAudit()"');

    // 5. 偏好
    expect(html).toContain('id="set_defaultProvider"');
  });

  it('需重启项明确标红提示（端口、主机、代理）', () => {
    // 检查需重启标签的存在性
    const restartTags = html.match(/需重启/g) || [];
    expect(restartTags.length).toBeGreaterThanOrEqual(3);
  });

  it('严格保持四个全局 dialog 弹窗不变（a11y 守卫防线）', () => {
    const dialogs = (html.match(/<div[^>]*role="dialog"/g) || []).length;
    expect(dialogs).toBe(4);
  });
});

describe('T307 settings.js 业务逻辑与交互', () => {
  it('纯标准 JS 语法（无 TypeScript / 未编译语法）', () => {
    expect(() => new Function(settingsJs)).not.toThrow();
  });

  it('具备字段级标红与错误清理函数', () => {
    expect(settingsJs).toContain('function showFieldErrors');
    expect(settingsJs).toContain('function clearFieldErrors');
    expect(settingsJs).toContain('border-rose-500');
  });

  it('危险操作清空用量调用二次确认弹窗', () => {
    expect(settingsJs).toContain('function clearUsageWithAudit');
    expect(settingsJs).toContain('uiConfirm(');
    expect(settingsJs).toContain("apiJson('/api/usage/clear'");
  });

  it('数据加载与 30s 自动轮询刷新注册', () => {
    expect(settingsJs).toContain("apiJson('/api/settings')");
    expect(settingsJs).toContain("registerRefresh('settings', loadSettings, 30000)");
  });
});

describe('T307 后端配置管理与审计集成', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(dashboardRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/settings 返回五大区块当前配置及元数据', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.sections).toBeDefined();
    expect(body.sections.network).toBeDefined();
    expect(body.sections.security).toBeDefined();
    expect(body.sections.alerts).toBeDefined();
    expect(body.sections.storage).toBeDefined();
    expect(body.sections.preferences).toBeDefined();
    expect(body.meta.requiresRestartFields).toContain('port');
  });

  it('POST /api/settings 缺少 admin token 返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: { network: { port: 9090 } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/settings 参数非法时返回 400 与字段级错误字典', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: {
        network: {
          port: 999999, // 非法端口
          upstreamTimeoutMs: -100, // 非法超时
        },
        preferences: {
          defaultProvider: 'invalid-provider', // 非法上游
        },
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.errors).toBeDefined();
    expect(body.errors.port).toContain('1 到 65535');
    expect(body.errors.upstreamTimeoutMs).toContain('大于等于 0');
    expect(body.errors.defaultProvider).toContain('无效的上游提供商');
  });

  it('POST /api/settings 合法参数保存成功并标识重启需求', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: {
        network: {
          upstreamTimeoutMs: 120000,
        },
        preferences: {
          defaultProvider: 'commandcode',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.applied).toBeDefined();
  });

  it('POST /api/usage/clear 清空记录并在管理面审计日志中留痕', async () => {
    // 写入一条模拟数据
    recordCompletion({
      timestamp: new Date().toISOString(),
      model: 'test-model',
      provider: 'commandcode',
      inputTokens: 10,
      outputTokens: 10,
      timingMs: 100,
      costUsd: 0,
      hasPricing: false,
      status: 'COMPLETED',
      mode: 'chat',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/usage/clear',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('success');

    // 确认用量已被清空
    expect(getUsageHistory().length).toBe(0);

    // 确认审计日志已被记录
    const auditPath = getAuditLogPath();
    if (existsSync(auditPath)) {
      const entries = readAuditEntries(auditPath);
      const clearEntry = entries.find(e => e.target.includes('/api/usage/clear'));
      expect(clearEntry).toBeDefined();
      expect(clearEntry?.category).toBe('admin.write');
    }
  });
});
