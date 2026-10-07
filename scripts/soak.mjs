// =============================================================================
// 泄漏 / 稳定性监控（执行依据：master-plan v1.2 T214 阶段门「5 分钟泄漏监控」，
// T504 终验「24h 内存 <50MB」复用本脚本，调大 SOAK_DURATION_MS 即可）
// -----------------------------------------------------------------------------
// 手法：启动一个**完全隔离**的网关实例（临时状态目录 + 本地 mock 上游），
// 以固定节奏持续打非流式对话请求，周期性采样子进程常驻内存（RSS），
// 最后给出「首样本 → 末样本」增长量与判定。
//
// 隔离纪律（对齐 tests/integration.test.ts）：所有状态路径、凭据、加密库都落在
// 临时目录，绝不触碰 ~/.commandcode；凭据是随机占位符，不是任何真实 key。
//
// 用法：
//   node scripts/soak.mjs                       # 5 分钟，20 并发，15s 采样
//   SOAK_DURATION_MS=60000 node scripts/soak.mjs # 快速自检
// 退出码：0 = 增长在阈值内；1 = 超阈值或启动失败。
// =============================================================================
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DURATION_MS = Number(process.env.SOAK_DURATION_MS ?? 5 * 60_000);
const SAMPLE_MS = Number(process.env.SOAK_SAMPLE_MS ?? 15_000);
const CONCURRENCY = Number(process.env.SOAK_CONCURRENCY ?? 20);
// 阈值取 T111/P0-PORT-F 口径（1h <100MB）在 5 分钟窗口下的保守裁剪。
const MAX_GROWTH_MB = Number(process.env.SOAK_MAX_GROWTH_MB ?? 60);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** 采样子进程 RSS（KB → MB）。Windows 走 tasklist，其它平台回退 /proc。 */
async function sampleRssMb(pid) {
  if (process.platform === 'win32') {
    const out = await new Promise((resolve) => {
      const p = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      p.stdout.on('data', (d) => (buf += d));
      p.on('close', () => resolve(buf));
      p.on('error', () => resolve(''));
    });
    const m = /","([\d,\s]+) K"/.exec(out);
    return m ? Number(m[1].replace(/[,\s]/g, '')) / 1024 : null;
  }
  try {
    const { readFileSync } = await import('node:fs');
    const stat = readFileSync(`/proc/${pid}/status`, 'utf-8');
    const m = /VmRSS:\s+(\d+) kB/.exec(stat);
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
}

const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ccproxy-soak-'));
const PROXY_PORT = await getFreePort();
const base = `http://127.0.0.1:${PROXY_PORT}`;
const adminToken = `soak-${randomUUID()}`;

// 本地 mock 上游：只回一条最小 SSE，验证网关全链路可用即可。
const mockUpstream = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"type":"start"}\n\n' +
        'data: {"type":"text-delta","text":"soak-ok"}\n\n' +
        'data: {"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":10,"outputTokens":2}}\n\n' +
        'data: [DONE]\n\n',
    );
  });
});
await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
const mockPort = mockUpstream.address().port;

const child = spawn(process.execPath, ['dist/index.js'], {
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(PROXY_PORT),
    HOST: '127.0.0.1',
    COMMANDCODE_API_BASE: `http://127.0.0.1:${mockPort}`,
    COMMANDCODE_UPSTREAM_ALLOWED_HOSTS: '127.0.0.1',
    COMMANDCODE_API_KEY: randomUUID(),
    ADMIN_API_TOKEN: adminToken,
    COMMANDCODE_CONFIG_PATH: path.join(stateDir, 'config.json'),
    COMMANDCODE_MODELS_CACHE_PATH: path.join(stateDir, 'models.json'),
    COMMANDCODE_PRICING_CACHE_PATH: path.join(stateDir, 'pricing.json'),
    COMMANDCODE_PRICING_URL: `http://127.0.0.1:${mockPort}/pricing-fake`,
    USAGE_HISTORY_PATH: path.join(stateDir, 'usage.jsonl'),
    ACCEPTED_RISK_DISCLAIMER: '1',
    COMMANDCODE_ACCOUNTS_V1: '',
    CREDENTIAL_STORE_PATH: path.join(stateDir, 'credentials.enc'),
    NO_OPEN_BROWSER: '1',
  },
});

let stopped = false;
async function cleanup(code) {
  if (stopped) return;
  stopped = true;
  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
  try { mockUpstream.close(); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => cleanup(1));

async function waitReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('网关未在 20s 内就绪');
}

/** 打一轮并发请求，返回成功数。 */
async function burst() {
  const jobs = Array.from({ length: CONCURRENCY }, () =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'soak' }] }),
    })
      .then((r) => r.ok)
      .catch(() => false),
  );
  const results = await Promise.all(jobs);
  return results.filter(Boolean).length;
}

try {
  await waitReady();
} catch (err) {
  console.error(`启动失败：${err.message}`);
  await cleanup(1);
}

console.log(`soak 开始：时长 ${(DURATION_MS / 1000).toFixed(0)}s，每 ${(SAMPLE_MS / 1000).toFixed(0)}s 采样，每轮 ${CONCURRENCY} 并发`);
const samples = [];
const t0 = Date.now();
let rounds = 0;
let okTotal = 0;
let failTotal = 0;

while (Date.now() - t0 < DURATION_MS) {
  const ok = await burst();
  okTotal += ok;
  failTotal += CONCURRENCY - ok;
  rounds += 1;
  const rss = await sampleRssMb(child.pid);
  const elapsed = (Date.now() - t0) / 1000;
  if (rss != null) samples.push({ elapsed, rss });
  console.log(
    `t=${elapsed.toFixed(0).padStart(4)}s  rss=${rss == null ? 'n/a' : rss.toFixed(1) + ' MB'}  ` +
      `轮次=${rounds}  本轮到齐=${ok}/${CONCURRENCY}`,
  );
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
}

const first = samples[0];
const last = samples[samples.length - 1];
let growth = null;
if (first && last) growth = last.rss - first.rss;

console.log('──────────────────────────────────────────');
console.log(`请求合计：${rounds * CONCURRENCY}（成功 ${okTotal} / 失败 ${failTotal}）`);
if (growth == null) {
  console.log('内存采样不可用，无法判定增长');
  await cleanup(1);
}
console.log(`内存：首样本 ${first.rss.toFixed(1)} MB → 末样本 ${last.rss.toFixed(1)} MB（增长 ${growth >= 0 ? '+' : ''}${growth.toFixed(1)} MB）`);
const pass = growth <= MAX_GROWTH_MB && failTotal === 0;
console.log(`判定：${pass ? 'PASS' : 'FAIL'}（阈值 ≤${MAX_GROWTH_MB} MB 且 0 失败）`);
await cleanup(pass ? 0 : 1);
