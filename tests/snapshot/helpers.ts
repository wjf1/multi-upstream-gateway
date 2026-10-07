// =============================================================================
// Snapshot 测试基建(T107)
// -----------------------------------------------------------------------------
// 为「把两个 Go 项目移植为 Provider 适配器」的保真度锁定提供底座:
//   1. mock 上游服务器 —— 回放模式(fixture 优先)/ 录制模式(把响应落盘
//      为 fixture 文件),回放与录制产物逐字节一致(场景单源在 scenarios.mjs);
//   2. normalize —— 逐字节对比前,把时间戳 / requestId / 账号 ID 等易变字段
//      按白名单替换为占位符(如 __TIMESTAMP__);
//   3. 对比工具 —— 自实现文件比对(缺失即红、可显式更新),不直接用
//      vitest 的 toMatchFileSnapshot:后者在 fixture 缺失时会静默创建并让
//      用例通过,拿不到「缺失必须显式生成」的红灯门槛,也无法与 upstream
//      fixture 的录制统一在 UPDATE_SNAPSHOTS 一个入口下。
//
// 使用方式(详见 tests/snapshot/README.md):
//   - 日常跑:npm run verify(或 npx vitest run tests/snapshot)
//   - 生成/更新 fixture:UPDATE_SNAPSHOTS=1 npx vitest run tests/snapshot
// =============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { sentinelFor, scenarioNameFromBody, renderScenario } from './scenarios.mjs';

// ─── normalize:易变字段白名单 ────────────────────────────────────────────────

export interface Normalizer {
  /** 全局正则(调用方保证以 /g 结尾,replace 会复用)。 */
  pattern: RegExp;
  /** 占位符替换文本,如 '__TIMESTAMP__'。 */
  replacement: string;
}

/**
 * 默认白名单:客户端可见响应里全部已知的易变字段。
 * 约定:pattern 尽量窄(锚定字段名与位数),避免误伤模型正文。
 * 新增易变字段时在此追加,并同步 README 的白名单表。
 */
export const DEFAULT_NORMALIZERS: Normalizer[] = [
  // OpenAI chunk/响应 id:chatcmpl-<8位随机hex>(流式每个 chunk 同值,非流式为 traceId)
  { pattern: /chatcmpl-[0-9a-f]{8}/g, replacement: '__CHATCMPL_ID__' },
  // Unix 秒时间戳(10 位,2001-3363 年区间):"created":1759...
  { pattern: /"created":\d{9,12}/g, replacement: '"created":__CREATED__' },
  // 网关账号 id:acc_<hex>(目前不出现在响应体,白名单防御性保留,
  // 供后续 Provider 把账号 ID 带进错误/元数据时使用)
  { pattern: /acc_[0-9a-f]{4,32}/g, replacement: '__ACCOUNT_ID__' },
  // ISO8601 UTC 时间戳(含可选毫秒):2026-10-06T13:00:00(.123)?Z
  { pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, replacement: '__TIMESTAMP__' },
];

/**
 * 按白名单把易变字段替换为占位符。extra 追加在默认白名单之后
 * (Provider 专属易变字段由对应用例自带,不污染全局)。
 */
export function normalizeSnapshot(text: string, extra: Normalizer[] = []): string {
  let out = text;
  for (const n of [...DEFAULT_NORMALIZERS, ...extra]) {
    out = out.replace(n.pattern, n.replacement);
  }
  return out;
}

// ─── mock 上游服务器:回放 / 录制 ─────────────────────────────────────────────

/** upstream fixture 文件结构(录制产物,入库随 git 走)。 */
export interface UpstreamFixture {
  /** 场景名(= 文件名去 .json)。 */
  name: string;
  /** 来源说明(本地内置渲染 / Go 二进制采集 / sidecar 采集),无时间戳。 */
  source: string;
  request: { match: { sentinel: string } };
  response: {
    status: number;
    /** 只保留 content-type 等关键头,不记录易变头。 */
    headers: Record<string, string>;
    /** 原始 SSE/HTTP 响应体(逐字节)。 */
    body: string;
  };
}

export interface UpstreamMockOptions {
  /** upstream fixture 目录(tests/snapshot/fixtures/upstream)。 */
  fixturesDir: string;
  /**
   * fixture 缺失时是否回退到 scenarios.mjs 内置渲染。
   * 只应在**录制模式**(UPDATE_SNAPSHOTS=1)下开启:普通模式必须严格
   * fixture-only,否则「以为在对比录制基线,实际在跑内置渲染」。
   */
  fallbackBuiltin?: boolean;
  /** 录制:内置渲染兜底时把响应写为 fixture(UPDATE_SNAPSHOTS=1 时开启)。 */
  record?: boolean;
  /** SSE 分帧回放的帧间隔 ms(默认 10,模拟真实流式节奏)。 */
  frameDelayMs?: number;
  /** fixture 来源说明文案(record 落盘时写入)。 */
  source?: string;
}

export interface UpstreamMock {
  server: http.Server;
  port: number;
  /** 关闭并等待端口释放。 */
  close(): Promise<void>;
  /** 诊断:按「fixture 回放 / 内置渲染」统计每次 generate 的来源。 */
  hits: Array<{ scenario: string; via: 'fixture' | 'builtin' | 'unknown' }>;
}

function readUpstreamFixture(fixturesDir: string, name: string): UpstreamFixture | null {
  const p = path.join(fixturesDir, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as UpstreamFixture;
  } catch (err: any) {
    throw new Error(`upstream fixture 解析失败: ${p} — ${err.message}`, { cause: err });
  }
}

/** 把响应写为 upstream fixture(目录不存在则创建;一律 LF 行尾)。 */
export function writeUpstreamFixture(fixturesDir: string, fixture: UpstreamFixture): string {
  fs.mkdirSync(fixturesDir, { recursive: true });
  const p = path.join(fixturesDir, `${fixture.name}.json`);
  fs.writeFileSync(p, JSON.stringify(fixture, null, 2) + '\n', 'utf-8');
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 起一个 CommandCode 风格的上游 mock:
 *  - POST /alpha/generate:按请求体里的 __SNAPSHOT:<name>__ 哨兵选场景;
 *    优先回放 fixtures/<name>.json,缺失时回退内置渲染(record 开启则落盘)。
 *  - 其余端点:启动期后台任务(whoami / 模型 / 订阅 / credits)的最小应答,
 *    避免 proxy 启动日志噪音与外呼。
 */
export async function createUpstreamMock(opts: UpstreamMockOptions): Promise<UpstreamMock> {
  const frameDelayMs = opts.frameDelayMs ?? 10;
  const hits: UpstreamMock['hits'] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf-8')));
    req.on('end', () => {
      const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;

      if (pathname !== '/alpha/generate') {
        res.setHeader('Content-Type', 'application/json');
        if (pathname === '/alpha/whoami') {
          res.end(JSON.stringify({ success: true, user: { id: 'u1', name: 'Snapshot Tester', userName: 'snapshot' } }));
          return;
        }
        if (pathname === '/alpha/billing/subscriptions') {
          // 固定时间字面量:任何易变值都不该出现在 mock 应答里。
          res.end(JSON.stringify({
            success: true,
            data: {
              planId: 'individual-go',
              status: 'active',
              cancelAtPeriodEnd: false,
              currentPeriodStart: '2026-01-01T00:00:00.000Z',
              currentPeriodEnd: '2026-02-01T00:00:00.000Z',
            },
          }));
          return;
        }
        if (pathname === '/provider/v1/models') {
          res.end(JSON.stringify({
            object: 'list',
            data: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 200000 }],
          }));
          return;
        }
        // 其余(credits / usage summary / pricing 页)404:fetchJson/同步静默容错。
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'snapshot upstream: not mocked' }));
        return;
      }

      // ── generate:场景选择 → fixture 回放 / 内置渲染 ──
      const scenario = scenarioNameFromBody(body);
      if (!scenario) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'no __SNAPSHOT:<name>__ sentinel in request' }));
        return;
      }

      const fixture = readUpstreamFixture(opts.fixturesDir, scenario);
      if (fixture) {
        hits.push({ scenario, via: 'fixture' });
        replayFixture(res, fixture, frameDelayMs);
        return;
      }

      const builtin = renderScenario(scenario);
      if (builtin && opts.fallbackBuiltin) {
        if (opts.record) {
          // 录制:内置渲染落盘后**立即回读回放** —— 录制完成的瞬间它就是
          // 回放基线(同一请求内 via='fixture'),与后续普通模式逐字节一致。
          writeUpstreamFixture(opts.fixturesDir, {
            name: scenario,
            source: opts.source || 'tests/snapshot/scenarios.mjs 内置渲染(UPDATE_SNAPSHOTS=1 录制)',
            request: { match: { sentinel: sentinelFor(scenario) } },
            response: {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
              body: builtin,
            },
          });
          const recorded = readUpstreamFixture(opts.fixturesDir, scenario);
          if (recorded) {
            hits.push({ scenario, via: 'fixture' });
            replayFixture(res, recorded, frameDelayMs);
            return;
          }
        }
        hits.push({ scenario, via: 'builtin' });
        replayFixture(
          res,
          { name: scenario, source: '', request: { match: { sentinel: '' } }, response: { status: 200, headers: { 'content-type': 'text/event-stream' }, body: builtin } },
          frameDelayMs,
        );
        return;
      }

      // fixture 缺失且不允许内置兜底(或场景根本不存在):明确拒绝而不是
      // 静默渲染,保证普通模式的断言对象永远是「录制基线」。
      hits.push({ scenario, via: 'unknown' });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message:
          `no upstream fixture for '${scenario}'` +
          (builtin ? '' : ` (also no builtin scenario in scenarios.mjs)`) +
          ' — 录制方式: UPDATE_SNAPSHOTS=1 npx vitest run tests/snapshot(见 tests/snapshot/README.md)',
      }));
    });
  });

  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    server,
    port,
    hits,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

/** 按 \n\n 分帧逐帧回放 fixture 响应体(保留原始字节,帧间小延迟模拟流式)。 */
function replayFixture(res: http.ServerResponse, fixture: UpstreamFixture, frameDelayMs: number): void {
  res.writeHead(fixture.response.status, fixture.response.headers);
  const frames = fixture.response.body.split('\n\n').filter(f => f.length > 0);
  void (async () => {
    for (const frame of frames) {
      res.write(frame + '\n\n');
      if (frameDelayMs > 0) await sleep(frameDelayMs);
    }
    res.end();
  })();
}

// ─── 对比工具:fixture 缺失即红,显式更新 ─────────────────────────────────────

export interface CompareOptions {
  /** true = 把 actual 写入 fixture 并通过(用于 UPDATE_SNAPSHOTS=1)。 */
  update?: boolean;
}

export interface CompareResult {
  ok: boolean;
  /** 失败时为人话指引(含生成命令与 diff),成功时为空。 */
  message: string;
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** 行级首个差异下标;完全一致返回 -1。 */
function firstDiffIndex(a: string[], b: string[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

/** 简易行级 diff:从首个差异行起并列展示(上下文即差异本身,快照是短文本)。 */
export function diffText(expected: string, actual: string, maxLines = 24): string {
  const e = toLf(expected).split('\n');
  const a = toLf(actual).split('\n');
  const idx = firstDiffIndex(e, a);
  if (idx === -1) return '';
  const lines: string[] = [`首个差异位于第 ${idx + 1} 行(- = fixture 期望,+ = 实际收到):`];
  const end = Math.min(idx + maxLines, Math.max(e.length, a.length));
  for (let i = idx; i < end; i++) {
    if (e[i] === a[i]) {
      lines.push(`    ${e[i]}`);
      continue;
    }
    if (e[i] !== undefined) lines.push(`  - ${e[i]}`);
    if (a[i] !== undefined) lines.push(`  + ${a[i]}`);
  }
  if (e.length !== a.length) {
    lines.push(`(行数不同:期望 ${e.length} 行,实际 ${a.length} 行)`);
  }
  return lines.join('\n');
}

const UPDATE_HINT =
  '生成/更新方式:UPDATE_SNAPSHOTS=1 npx vitest run tests/snapshot\n' +
  '  (PowerShell: $env:UPDATE_SNAPSHOTS="1"; npx vitest run tests/snapshot)\n' +
  '  生成后请人工检查 fixture 内容,再随代码一起提交。';

/**
 * 把 actual(normalize 后)与 fixture 文件逐行对比:
 *  - opts.update:写文件(统一 LF)并通过 —— 显式生成入口;
 *  - fixture 缺失:红,并给出生成命令(不用 toMatchFileSnapshot 的原因见文件头);
 *  - 内容不一致:红,附行级 diff(行尾 CRLF 由 git autocrlf 引入时容忍)。
 */
export async function compareWithFixture(
  actual: string,
  fixturePath: string,
  opts: CompareOptions = {},
): Promise<CompareResult> {
  const actualLf = toLf(actual);

  if (opts.update) {
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, actualLf, 'utf-8');
    return { ok: true, message: '' };
  }

  if (!fs.existsSync(fixturePath)) {
    return {
      ok: false,
      message: `快照 fixture 不存在: ${fixturePath}\n  ${UPDATE_HINT}`,
    };
  }

  const expected = toLf(fs.readFileSync(fixturePath, 'utf-8'));
  if (expected === actualLf) return { ok: true, message: '' };

  return {
    ok: false,
    message: `快照与 fixture 不一致: ${fixturePath}\n${diffText(expected, actualLf)}\n${UPDATE_HINT}`,
  };
}
