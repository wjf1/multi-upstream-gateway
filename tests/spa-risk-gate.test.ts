// =============================================================================
// T110（Phase E）回归防线：面板外置后的静态通路 + T106 风险告知门。
// -----------------------------------------------------------------------------
// 两件事在这里一起锁：
// 1. /js/* 静态路由与既有 /assets/vendor/* 共用同一套路径穿越拒绝逻辑 —— 外置脚本
//    新增了一条读盘通路，穿越面必须与老通路一致地封住。
// 2. 风险告知是硬门：acceptedRiskDisclaimer=false 时 /v1 全 403，面板必须首屏强制
//    弹窗且**不可绕过**（无关闭按钮、Esc 不生效）。这里既断言接线完整，也断言
//    Esc 处理器没有碰 riskModal —— 后者最容易在后续改键盘交互时被顺手加上。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
// T209（2026-10-07）：新增 upstream.js（上游管理页），取证源清单随之声明式扩容。
const PANEL_JS_FILES = ['core', 'overview', 'upstream', 'accounts', 'usage', 'models', 'logs'];
const panelJs: Record<string, string> = {};
for (const f of PANEL_JS_FILES) panelJs[f] = readFileSync(path.join(root, 'public', 'js', f + '.js'), 'utf-8');
const core = panelJs.core;
const overview = panelJs.overview;

describe('index.html 只留骨架 + 外置脚本引用', () => {
  it('行数受控（≤1000 行）', () => {
    expect(html.split('\n').length).toBeLessThanOrEqual(1000);
  });

  it('六个既有分区齐备且带 data-route（hash 路由的落点；T209 增 upstream）', () => {
    for (const t of ['overview', 'upstream', 'accounts', 'usage', 'models', 'logs']) {
      expect(html).toMatch(new RegExp(`id="content-${t}"[^>]*data-route="${t}"`));
      expect(html).toContain(`id="tab-${t}"`);
    }
  });

  it('全部页面脚本按序 defer 外链，且没有内联业务脚本', () => {
    for (const f of PANEL_JS_FILES) {
      expect(html).toContain(`<script src="/js/${f}.js" defer></script>`);
    }
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(inline.length, '业务内联脚本应已全部外置').toBe(1); // 仅剩 head 主题防闪屏 1 行
    expect(inline[0]).toContain('ccproxy-theme');
  });

  it('无外部 CDN 外链（资源已本地化）', () => {
    expect(html).not.toMatch(/https?:\/\/cdn\.|https?:\/\/cdnjs\.cloudflare\.com|https?:\/\/cdn\.jsdelivr\.net/);
  });
});

describe('T106 风险告知门', () => {
  it('#riskModal 具备模态语义，且四类风险 + 个人学习 + 不分发凭据 + 403 说明齐备', () => {
    expect(html).toMatch(/<div id="riskModal" role="dialog" aria-modal="true" aria-label="[^"]+"/);
    for (const s of ['账号风险', '服务稳定性', '合规风险', '凭据安全', '个人学习', '不分发任何凭据', '403']) {
      expect(html, `风险告知缺少「${s}」`).toContain(s);
    }
  });

  it('弹窗无关闭按钮：唯一的 onclick 是 acceptRiskGate', () => {
    const start = html.indexOf('<div id="riskModal"');
    const modal = html.slice(start, html.indexOf('</div>', html.indexOf('我已阅读并自行承担风险')));
    const onclicks = [...modal.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]);
    expect(onclicks).toEqual(['acceptRiskGate']);
  });

  it('core.js 定义风险门三件套，确认走 POST /api/risk/accept', () => {
    expect(core).toContain('function showRiskGate(');
    expect(core).toContain('function hideRiskGate(');
    expect(core).toContain('async function acceptRiskGate(');
    expect(core).toContain('function maybeShowRiskGate(');
    expect(core).toContain("apiJson('/api/risk/accept'");
  });

  it('fetchStatus 依据 /api/status 的 acceptedRiskDisclaimer 驱动弹窗', () => {
    expect(core).toContain('status.acceptedRiskDisclaimer');
    expect(overview).toContain('maybeShowRiskGate(data)');
  });

  it('Esc 处理器不碰 riskModal（硬门：Esc 不生效）', () => {
    const escBlock = core.slice(core.indexOf("if (e.key === 'Escape')"), core.indexOf("if (e.key === 'Enter'"));
    expect(escBlock, 'Esc 处理器里有 riskGate/riskModal 就等于给硬门开了后门')
      .not.toMatch(/riskGate|riskModal/);
  });
});

describe('/js/* 静态路由（build 产物 dist 下读 public/js）', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-paneljs-'));
    process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
    process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
    process.env.COMMANDCODE_PRICING_CACHE_PATH = path.join(stateDir, 'pricing.json');
    process.env.COMMANDCODE_ENV_FILE_PATH = path.join(stateDir, '.env');
    process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
    delete process.env.COMMANDCODE_API_KEY;
    const { dashboardRoutes } = await import('../src/routes/dashboard.js');
    app = Fastify();
    await app.register(dashboardRoutes);
    await app.ready();
  });

  afterAll(async () => { await app?.close(); });

  it('6 个页面脚本均可取到，且是 JS content-type', async () => {
    for (const f of PANEL_JS_FILES) {
      const res = await app.inject({ method: 'GET', url: `/js/${f}.js` });
      expect(res.statusCode, `/js/${f}.js`).toBe(200);
      expect(res.headers['content-type']).toContain('application/javascript');
      expect(res.body).toBe(panelJs[f]);
    }
  });

  it('路径穿越被拒（与 /assets/vendor/* 同一套拒绝逻辑）', async () => {
    for (const url of ['/js/../package.json', '/js/..%2F..%2Fpackage.json', '/js/sub/../../package.json']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('不存在的脚本返回 404 而不是报错', async () => {
    const res = await app.inject({ method: 'GET', url: '/js/nope.js' });
    expect(res.statusCode).toBe(404);
  });

  it('GET / 下发的是外置后的骨架，且不再内联业务脚本', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-route="overview"');
    expect(res.body).toContain('<script src="/js/core.js" defer></script>');
    expect(res.body.split('\n').length).toBeLessThanOrEqual(1000);
  });
});
