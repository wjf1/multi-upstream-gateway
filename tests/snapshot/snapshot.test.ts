// =============================================================================
// Snapshot 测试(T107)—— 移植保真度锁
// -----------------------------------------------------------------------------
// 模式:与 tests/integration.test.ts 相同的「spawn 编译产物」端到端模式:
//   真实 dist/index.js + 真 HTTP 栈,mock 上游只按 fixture 回放/内置渲染。
// 断言:客户端经 /v1/chat/completions(流式与非流式)实际收到的响应体,
//   在 normalize(易变字段 → 占位符)之后,与 fixture 文件逐字节一致。
//
// 红→绿约定:
//   - fixture 缺失/不一致 = 红,并给出人话指引;
//   - UPDATE_SNAPSHOTS=1 时显式生成/更新(同时录制 upstream fixture),
//     生成后需人工检查再入库 —— 不允许测试静默改写仓库文件。
//
// 后续 T201(Freebuff)/ T204(WorkBuddy)移植时,如何添加 fixture 与
// 采集 Go 原版输出,见本目录 README.md。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createUpstreamMock,
  normalizeSnapshot,
  compareWithFixture,
  type UpstreamMock,
} from './helpers.js';
import { sentinelFor } from './scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const UPSTREAM_FIXTURES_DIR = path.join(HERE, 'fixtures', 'upstream');
const SNAPSHOT_DIR = path.join(HERE, 'fixtures', 'snapshots');
const STREAM_SNAPSHOT = path.join(SNAPSHOT_DIR, 'commandcode-chat-basic-stream.txt');
const NONSTREAM_SNAPSHOT = path.join(SNAPSHOT_DIR, 'commandcode-chat-basic-nonstream.json');

// 显式更新入口:同一条命令管「upstream fixture 录制」与「客户端快照生成」。
const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === '1';

const SCENARIO = 'commandcode-chat-basic';
const MODEL = 'claude-sonnet-5';

// ─── spawn 编译产物模式(与 integration.test.ts 同款守卫)────────────────────
// dist 缺失时不能让用例静默跳过报全绿 —— 用一条必然执行的守卫用例明确报红。

async function getFreePort(): Promise<number> {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

const DIST_ENTRY = path.join(PROJECT_ROOT, 'dist', 'index.js');
const distReady = existsSync(DIST_ENTRY);

describe('snapshot 前置条件', () => {
  it('构建产物 dist/index.js 存在(spawn 模式依赖)', () => {
    expect(distReady).toBe(true);
  });
});

let mock: UpstreamMock;
let proxyProcess: ChildProcess;
let proxyBase = '';

async function postChat(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${proxyBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (!distReady) {
    throw new Error(
      `缺少构建产物 ${DIST_ENTRY}。本套件 spawn 编译产物,请先 npm run build ` +
      `(npm run verify 已含 build,该守卫保护直接跑 npx vitest 的路径)。`,
    );
  }

  mock = await createUpstreamMock({
    fixturesDir: UPSTREAM_FIXTURES_DIR,
    // 内置渲染兜底只在录制模式(UPDATE_SNAPSHOTS=1)下允许:普通模式严格
    // fixture-only,断言对象永远是「录制基线」,防止拿内置渲染冒充移植对照。
    fallbackBuiltin: UPDATE_SNAPSHOTS,
    record: UPDATE_SNAPSHOTS,
    source: 'tests/snapshot/scenarios.mjs 内置渲染(UPDATE_SNAPSHOTS=1 录制)',
  });

  const proxyPort = await getFreePort();
  proxyBase = `http://127.0.0.1:${proxyPort}`;
  // 状态文件全部隔离到临时目录(同 integration.test.ts:不碰仓库与 ~/.commandcode)。
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-snap-'));
  proxyProcess = spawn(process.execPath, [DIST_ENTRY], {
    cwd: stateDir,
    env: {
      ...process.env,
      PORT: String(proxyPort),
      HOST: '127.0.0.1',
      COMMANDCODE_API_BASE: `http://127.0.0.1:${mock.port}`,
      // 回环 mock 上游默认被 SSRF 白名单拒绝,必须显式放行(config.ts 约定)。
      COMMANDCODE_UPSTREAM_ALLOWED_HOSTS: '127.0.0.1',
      COMMANDCODE_API_KEY: randomUUID(),
      // T106（§3.7-7）：风险门默认关闭 /v1。快照测的是翻译/流式保真度，
      // 显式确认以放行（风险门本身的拦截语义见 tests/risk-gate.test.ts）。
      ACCEPTED_RISK_DISCLAIMER: '1',
      COMMANDCODE_CONFIG_PATH: path.join(stateDir, 'config.json'),
      COMMANDCODE_ENV_PATH: path.join(stateDir, '.env'),
      // 加密库也必须隔离：否则启动校验会看到操作者真实的 ~/.commandcode/
      // credentials.enc（有库无钥）而拒绝启动，与集成测试同一套隔离约定。
      CREDENTIAL_STORE_PATH: path.join(stateDir, 'credentials.enc'),
      COMMANDCODE_MODELS_CACHE_PATH: path.join(stateDir, 'models.json'),
      COMMANDCODE_PRICING_CACHE_PATH: path.join(stateDir, 'pricing.json'),
      // pricing 页指向 mock(404 即可):防止启动期外呼官方 commandcode.ai。
      COMMANDCODE_PRICING_URL: `http://127.0.0.1:${mock.port}/pricing-fake`,
      COMMANDCODE_LOG_PATH: path.join(stateDir, 'proxy.log'),
      USAGE_HISTORY_PATH: path.join(stateDir, 'usage.jsonl'),
      NO_OPEN_BROWSER: '1',
    },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${proxyBase}/health`);
      if (res.ok) return;
    } catch {}
    if (Date.now() > deadline) break;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('proxy 未在 20s 内就绪(snapshot beforeAll)');
}, 40000);

afterAll(async () => {
  if (proxyProcess) {
    proxyProcess.kill();
    await new Promise(r => setTimeout(r, 500));
    if (proxyProcess.pid && !proxyProcess.killed) {
      try {
        spawn('taskkill', ['/pid', String(proxyProcess.pid), '/T', '/F']);
      } catch {}
    }
  }
  if (mock) await mock.close();
});

// ─── 用例:客户端实际收到什么,normalize 后必须与 fixture 逐字节一致 ──────────

describe.skipIf(!distReady)('CommandCode chat 快照(/v1/chat/completions)', () => {
  it('流式 SSE:客户端收到的字节流与 fixture 一致(易变字段已 normalize)', async () => {
    const res = await postChat({
      model: MODEL,
      messages: [{ role: 'user', content: sentinelFor(SCENARIO) }],
      max_tokens: 100,
      stream: true,
    });
    // 第二参数携带上游错误详情:mock 上游 502(回放源缺失)时给人话指引。
    expect(res.status, `上游/网关响应体: ${await res.clone().text()}`).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const raw = await res.text();
    // mock 上游必须真的来自 fixture 回放(录制链路成立后,回放才是移植基线)。
    const hit = mock.hits.find(h => h.scenario === SCENARIO);
    expect(hit?.via).toBe('fixture');

    const actual = normalizeSnapshot(raw);
    const result = await compareWithFixture(actual, STREAM_SNAPSHOT, { update: UPDATE_SNAPSHOTS });
    expect(result.ok, result.message).toBe(true);
  });

  it('非流式:聚合 JSON 响应与 fixture 一致(易变字段已 normalize)', async () => {
    const res = await postChat({
      model: MODEL,
      messages: [{ role: 'user', content: sentinelFor(SCENARIO) }],
      max_tokens: 100,
    });
    expect(res.status, `上游/网关响应体: ${await res.clone().text()}`).toBe(200);

    const raw = await res.text();
    const actual = normalizeSnapshot(raw);
    const result = await compareWithFixture(actual, NONSTREAM_SNAPSHOT, { update: UPDATE_SNAPSHOTS });
    expect(result.ok, result.message).toBe(true);
  });
});
