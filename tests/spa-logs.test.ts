// =============================================================================
// T306 回归防线：面板运行日志页（三筛选 + RequestId 关联详情 + 5s 刷新）
// -----------------------------------------------------------------------------
// 覆盖：
// 1. HTML 骨架：三筛选选择器、详情卡片字段、tabpanel 与 data-route 语义齐备，
//    且不引入多余的 role="dialog"（确保 spa-a11y 的 4 个模态断言不回归）；
// 2. public/js/logs.js：三筛选逻辑（level / provider / keyword）、
//    RequestId 交互识别高亮、showRequestDetail 关联详情解析渲染、5s 自动刷新；
// 3. 后端 /api/logs 与 /api/logs/request/:id 端点集成测试：
//    参数化过滤可用，按 requestId/traceId 能正确查回请求模型、状态、耗时与关联日志。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { dashboardRoutes } from '../src/routes/dashboard.js';
import { logger } from '../src/utils/logger.js';
import { recordCompletion } from '../src/utils/usage-store.js';

// 用量历史落点在模块加载期就被 store 捕获（见 storage-backend.ts），故 env 必须用 `vi.hoisted`
// 在 import 之前落 —— 否则本文件的 `recordCompletion` 写的是**真实用户**的
// `~/.commandcode/usage-history.jsonl`，并与并行的 spa-settings.test.ts 抢同一个文件
// （那边 `/api/usage/clear` 之后断言长度为 0，全量跑偶发被本文件插进的一行打红）。
const isolatedUsagePath = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || '/tmp';
  const usage = `${tmp}/ccproxy-test-spa-logs-usage.jsonl`;
  process.env.USAGE_HISTORY_PATH = usage;
  return usage;
});

afterAll(() => {
  rmSync(isolatedUsagePath, { force: true });
});

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
const logsJs = readFileSync(path.join(root, 'public', 'js', 'logs.js'), 'utf-8');

describe('T306 面板骨架与无障碍', () => {
  it('日志分区保留 tab 语义并具备 data-route="logs"', () => {
    expect(html).toMatch(/id="tab-logs" role="tab"[^>]*aria-controls="content-logs"/);
    expect(html).toMatch(/id="content-logs" role="tabpanel"[^>]*data-route="logs"/);
  });

  it('三筛选工具条齐备：级别、上游、关键词搜索框与统计提示', () => {
    expect(html).toContain('id="logLevelFilter"');
    expect(html).toContain('id="logProviderFilter"');
    expect(html).toContain('id="logKeywordFilter"');
    expect(html).toContain('id="logFilterStats"');
    expect(html).toContain('onchange="applyLogFilters()"');
    expect(html).toContain('oninput="applyLogFilters()"');
  });

  it('请求全链路关联详情卡片齐备（requestId / 模型 / 上游 / 状态 / 耗时 / token成本）', () => {
    expect(html).toContain('id="logDetailCard"');
    expect(html).toContain('id="detailRequestId"');
    expect(html).toContain('id="detailModel"');
    expect(html).toContain('id="detailProvider"');
    expect(html).toContain('id="detailStatus"');
    expect(html).toContain('id="detailTiming"');
    expect(html).toContain('id="detailTokens"');
    expect(html).toContain('id="detailRelatedLogs"');
    expect(html).toContain('onclick="hideRequestDetail()"');
  });

  it('不增加破坏性 role="dialog" 元素（保持 a11y 4 弹窗守卫严格通过）', () => {
    const dialogCount = (html.match(/<div[^>]*role="dialog"/g) || []).length;
    expect(dialogCount).toBe(4);
  });
});

describe('T306 logs.js 业务逻辑与安全', () => {
  it('纯标准 JS 语法（无 TypeScript / 未编译语法）', () => {
    expect(() => new Function(logsJs)).not.toThrow();
  });

  it('三筛选实现完整（level / provider / keyword）', () => {
    expect(logsJs).toContain('function applyLogFilters()');
    expect(logsJs).toContain('levelFilter');
    expect(logsJs).toContain('providerFilter');
    expect(logsJs).toContain('kw');
    expect(logsJs).toContain('logFilterStats');
  });

  it('RequestId / TraceId 词法分析与可交互点击识别', () => {
    expect(logsJs).toContain('showRequestDetail');
    expect(logsJs).toContain('chatcmpl-');
    expect(logsJs).toContain('msg_');
  });

  it('请求详情拉取与字段渲染', () => {
    expect(logsJs).toContain("apiJson('/api/logs/request/' + encodeURIComponent(id))");
    expect(logsJs).toContain('detailModel');
    expect(logsJs).toContain('detailStatus');
    expect(logsJs).toContain('detailTiming');
  });

  it('注册 5000ms 刷新（DoD 5s 刷新要求）', () => {
    expect(logsJs).toContain("registerRefresh('logs', loadLogs, 5000)");
  });

  it('所有动态文本使用 esc 避免 XSS 注入', () => {
    expect(logsJs).toContain('esc(l.message)');
    expect(logsJs).toContain('esc(reqId)');
    expect(logsJs).toContain('esc(rec.errorCode)');
  });
});

describe('T306 后端 API 集成', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(dashboardRoutes);
    logger.clearLogs();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/logs 支持 level / provider / keyword 参数化筛选', async () => {
    logger.info('[CHAT] Model claude-sonnet-5 | Status COMPLETED');
    logger.warn('[PVD:freebuff] token quota 80% used');
    logger.error('[PVD:workbuddy] sidecar connection timeout');

    // 1. 无参返回全部
    const resAll = await app.inject({ method: 'GET', url: '/api/logs' });
    expect(resAll.statusCode).toBe(200);
    const bodyAll = JSON.parse(resAll.body);
    expect(bodyAll.logs.length).toBeGreaterThanOrEqual(3);

    // 2. 按 level 过滤
    const resErr = await app.inject({ method: 'GET', url: '/api/logs?level=error' });
    const bodyErr = JSON.parse(resErr.body);
    expect(bodyErr.logs.every((l: any) => l.level === 'error')).toBe(true);
    expect(bodyErr.logs.some((l: any) => l.message.includes('workbuddy'))).toBe(true);

    // 3. 按 provider 过滤
    const resFb = await app.inject({ method: 'GET', url: '/api/logs?provider=freebuff' });
    const bodyFb = JSON.parse(resFb.body);
    expect(bodyFb.logs.some((l: any) => l.message.includes('freebuff'))).toBe(true);

    // 4. 按 keyword 过滤
    const resKw = await app.inject({ method: 'GET', url: '/api/logs?q=claude-sonnet-5' });
    const bodyKw = JSON.parse(resKw.body);
    expect(bodyKw.logs.length).toBe(1);
    expect(bodyKw.logs[0].message).toContain('claude-sonnet-5');
  });

  it('GET /api/logs/request/:id 能够关联用量记录与日志事件', async () => {
    const testReqId = 'req_test_abc123';
    recordCompletion({
      timestamp: new Date().toISOString(),
      model: 'glm-5.2',
      provider: 'commandcode',
      inputTokens: 100,
      outputTokens: 50,
      timingMs: 420,
      costUsd: 0.0025,
      hasPricing: true,
      status: 'COMPLETED',
      requestId: testReqId,
      mode: 'chat',
    });

    logger.info(`[CHAT] Inbound request ${testReqId} for model glm-5.2`);
    logger.info(`[CHAT] Finished request ${testReqId} in 420ms`);

    const res = await app.inject({ method: 'GET', url: `/api/logs/request/${testReqId}` });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);

    expect(data.found).toBe(true);
    expect(data.record.requestId).toBe(testReqId);
    expect(data.record.model).toBe('glm-5.2');
    expect(data.record.status).toBe('COMPLETED');
    expect(data.record.timingMs).toBe(420);
    expect(data.relatedLogs.length).toBe(2);
    expect(data.relatedLogs[0].message).toContain(testReqId);
  });

  it('GET /api/logs/request/:id 未落库时能从日志推断基础信息', async () => {
    const testTraceId = 'chatcmpl-unknown-999';
    logger.error(`[CHAT] Stream error | Model gpt-4o | Trace ${testTraceId} | Status FAILED`);

    const res = await app.inject({ method: 'GET', url: `/api/logs/request/${testTraceId}` });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);

    expect(data.found).toBe(true);
    expect(data.record.requestId).toBe(testTraceId);
    expect(data.record.model).toBe('gpt-4o');
    expect(data.record.status).toBe('FAILED');
    expect(data.relatedLogs.length).toBe(1);
  });
});
