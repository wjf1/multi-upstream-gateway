#!/usr/bin/env node
// =============================================================================
// scripts/bench-baseline.mjs —— P0 阶段门性能基线 + E2E 冒烟（T111）
// -----------------------------------------------------------------------------
// 为什么用本地 mock 上游：本脚本要测的是**代理自身引入的开销**（翻译、SSE
// 编解码、用量落盘、中间件链）。真实上游的延迟由模型决定，与代理质量无关，
// 混在一起测既不稳定也不可归因。本地 mock 以零延迟回一段固定 SSE 流，因此
// 测得的是"代理开销的上界"——真机端到端 = 上游耗时 + 本数值。
//
// 覆盖：
//   1. E2E 冒烟：启动 → /v1/chat/completions（流式）→ 收到内容 → 用量记录落盘
//      → 面板 /（HTML）与 /api/status 可用；
//   2. 单并发 P50 与 50 并发 P99（并发用同一批请求压满，测尾部延迟）；
//   3. 短时内存趋势（RSS 采样；1h soak 归 T504 终验）。
//
// 用法：node scripts/bench-baseline.mjs [--concurrency 50] [--requests 200]
// 全部状态隔离在临时目录，绝不触碰仓库 config.json / 真实用量历史。
// =============================================================================
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

const CONCURRENCY = argOf('concurrency', 50);
const REQUESTS = argOf('requests', 200);
const MOCK_PORT = 19871;
const PROXY_PORT = 19872;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** 零延迟 mock 上游：POST /alpha/generate 回一段固定 CC wire SSE 流。 */
function startMock() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const frames = [
        { type: 'start' },
        { type: 'text-delta', text: 'Hello, ' },
        { type: 'text-delta', text: 'world!' },
        { type: 'finish', finishReason: 'stop', data: { usage: { inputTokens: 12, outputTokens: 3 } } },
      ];
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      res.end();
    });
  });
  return new Promise(resolve => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccproxy-bench-'));
  const usageFile = path.join(stateDir, 'usage-history.jsonl');
  const mock = await startMock();

  // cwd 必须是项目根：面板 HTML / vendor 资源按 getProjectRootDir()(=cwd) 解析，
  // 真实部署的 cwd 就是仓库根。全部运行期状态仍经 env 隔离到临时目录。
  const proxy = spawn(process.execPath, [path.join(ROOT, 'dist', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      HOST: '127.0.0.1',
      COMMANDCODE_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      COMMANDCODE_UPSTREAM_ALLOWED_HOSTS: '127.0.0.1',
      COMMANDCODE_API_KEY: 'bench-placeholder-key',
      // T106 风险门：基线测数据面，显式确认放行。
      ACCEPTED_RISK_DISCLAIMER: '1',
      COMMANDCODE_CONFIG_PATH: path.join(stateDir, 'config.json'),
      COMMANDCODE_ENV_PATH: path.join(stateDir, '.env'),
      COMMANDCODE_MODELS_CACHE_PATH: path.join(stateDir, 'models.json'),
      COMMANDCODE_PRICING_CACHE_PATH: path.join(stateDir, 'pricing.json'),
      COMMANDCODE_PRICING_URL: `http://127.0.0.1:${MOCK_PORT}/pricing-fake`,
      USAGE_HISTORY_PATH: usageFile,
      NO_OPEN_BROWSER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout.on('data', () => {});
  proxy.stderr.on('data', () => {});

  const base = `http://127.0.0.1:${PROXY_PORT}`;
  const results = { e2e: {}, single: {}, concurrent: {}, memory: {} };

  try {
    // ── 等待就绪 ────────────────────────────────────────────────────────────
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
        ready = r.ok;
      } catch { await sleep(100); }
    }
    if (!ready) throw new Error('proxy did not become ready');
    await sleep(500);

    // ── 1. E2E 冒烟 ────────────────────────────────────────────────────────
    const t0 = Date.now();
    const chatRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'ping' }] }),
    });
    const chatBody = await chatRes.text();
    results.e2e.chatStatus = chatRes.status;
    results.e2e.sawContent = /Hello, world!/.test(chatBody);
    results.e2e.latencyMs = Date.now() - t0;
    results.e2e.usageFileAppeared = fs.existsSync(usageFile);

    const page = await fetch(`${base}/`);
    const pageHtml = await page.text();
    results.e2e.panelStatus = page.status;
    results.e2e.panelHasRoutes = /data-route="overview"/.test(pageHtml) && /\/js\/core\.js/.test(pageHtml);
    // 静态资源通路：面板脚本(/js/*) 与第三方库(/assets/vendor/*) 都要真能取到——
    // 只断言 HTML 里有引用是不够的（路由缺失时页面照样渲染，只是脚本全 404）。
    const jsAsset = await fetch(`${base}/js/core.js`);
    const vendorAsset = await fetch(`${base}/assets/vendor/tailwind.js`);
    results.e2e.panelJsStatus = jsAsset.status;
    results.e2e.vendorStatus = vendorAsset.status;
    results.e2e.jsAssetsOk = jsAsset.ok && vendorAsset.ok;
    const status = await fetch(`${base}/api/status`);
    const statusJson = await status.json();
    results.e2e.statusOk = status.ok;
    results.e2e.riskAccepted = statusJson.acceptedRiskDisclaimer === true;

    // 用量落盘（异步写，稍等）
    for (let i = 0; i < 20 && !fs.existsSync(usageFile); i++) await sleep(100);
    const usageLines = fs.existsSync(usageFile)
      ? fs.readFileSync(usageFile, 'utf-8').trim().split('\n').filter(Boolean)
      : [];
    results.e2e.usageRecords = usageLines.length;
    if (usageLines.length) {
      const rec = JSON.parse(usageLines[usageLines.length - 1]);
      results.e2e.usageProvider = rec.provider;
      results.e2e.usageStatus = rec.status;
    }

    // ── 2. 单并发基线 ──────────────────────────────────────────────────────
    const singleLat = [];
    const singleN = 30;
    for (let i = 0; i < singleN; i++) {
      const s = Date.now();
      await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] }),
      }).then(r => r.text());
      singleLat.push(Date.now() - s);
    }
    singleLat.sort((a, b) => a - b);
    results.single = { n: singleN, p50: Math.round(percentile(singleLat, 0.5)), p95: Math.round(percentile(singleLat, 0.95)) };

    // ── 3. 并发基线 ────────────────────────────────────────────────────────
    const concLat = [];
    let cursor = 0;
    let errors = 0;
    async function worker() {
      while (cursor < REQUESTS) {
        cursor++;
        const s = Date.now();
        try {
          const r = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] }),
          });
          await r.text();
          if (!r.ok) errors++;
        } catch { errors++; }
        concLat.push(Date.now() - s);
      }
    }
    const cStart = Date.now();
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    concLat.sort((a, b) => a - b);
    results.concurrent = {
      concurrency: CONCURRENCY,
      requests: REQUESTS,
      errors,
      wallMs: Date.now() - cStart,
      throughputRps: Math.round((REQUESTS / (Date.now() - cStart)) * 1000),
      p50: Math.round(percentile(concLat, 0.5)),
      p95: Math.round(percentile(concLat, 0.95)),
      p99: Math.round(percentile(concLat, 0.99)),
    };

    // ── 4. 短时内存趋势（1h soak 归 T504）──────────────────────────────────
    const rssSamples = [];
    for (let i = 0; i < 6; i++) {
      rssSamples.push(processMemoryOf(proxy.pid));
      await sleep(5000);
      // 期间保持轻量负载，避免"空转无增长"的假阴性
      await Promise.all(Array.from({ length: 5 }, () =>
        fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'soak' }] }),
        }).then(r => r.text()).catch(() => {}),
      ));
    }
    const first = rssSamples[0], last = rssSamples[rssSamples.length - 1];
    results.memory = {
      samplesMb: rssSamples.map(v => Math.round(v / 1048576)),
      growthMb: Math.round((last - first) / 1048576),
      note: '短时 (~30s) 采样；1h soak 由 T504 终验',
    };
  } finally {
    try { proxy.kill(); } catch {}
    try { mock.close(); } catch {}
    await sleep(300);
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  }

  console.log(JSON.stringify(results, null, 2));

  // ── 门禁判定（阈值来自 master-plan v1.2 T111）────────────────────────────
  const checks = [
    ['E2E: /v1 响应含内容', results.e2e.sawContent === true],
    ['E2E: 用量记录落盘且 provider 字段存在', results.e2e.usageRecords > 0 && results.e2e.usageProvider === 'commandcode'],
    ['E2E: 面板与 /api/status 可用', results.e2e.statusOk === true && results.e2e.panelHasRoutes === true],
    ['E2E: 面板 JS 与 vendor 静态资源可获取', results.e2e.jsAssetsOk === true],
    ['单并发 P50 < 500ms', results.single.p50 !== null && results.single.p50 < 500],
    [`${CONCURRENCY} 并发 P99 < 3000ms`, results.concurrent.p99 !== null && results.concurrent.p99 < 3000],
    ['并发无请求错误', results.concurrent.errors === 0],
  ];
  console.log('\n=== 门禁判定 ===');
  let allPass = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) allPass = false;
  }
  console.log(allPass ? '\n结果: PASS\n' : '\n结果: FAIL\n');
  process.exit(allPass ? 0 : 1);
}

/** 跨平台读取进程 RSS（字节）。失败返回 0。 */
function processMemoryOf(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8' },
      );
      const m = out.match(/"([\d,]+) K"/);
      return m ? parseInt(m[1].replace(/,/g, ''), 10) * 1024 : 0;
    }
    const out = fs.readFileSync(`/proc/${pid}/statm`, 'utf-8').split(' ');
    return parseInt(out[1], 10) * 4096;
  } catch {
    return 0;
  }
}

main().catch(err => {
  console.error(`[bench] failed: ${err?.message || err}`);
  process.exit(1);
});
