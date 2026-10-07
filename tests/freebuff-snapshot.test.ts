// =============================================================================
// Freebuff 快照测试（T201）
// -----------------------------------------------------------------------------
// 移植保真度锁的 Freebuff 侧：把「上游 OpenAI 兼容响应」经 Provider 的文本增量
// 契约口径产出，normalize 后与 fixture 逐字节对比（基建见 tests/snapshot/README.md）。
//
// 与 CommandCode 快照用例的差异（已在 T201 报告登记）：
//   - freebuff Provider 尚未接入 /v1 路由（T213 接线），因此本用例不经
//     spawn 的 dist/index.js，而是直接驱动 FreebuffProvider.chatCompletion；
//     断言对象是 IProvider 契约要求的 AsyncIterable<string>（文本增量），
//     而非网关 HTTP/SSE 字节。
//   - upstream fixture 为手工构造：Go 原版对 /api/v1/chat/completions 是字节
//     透传（upstream.go:139 / server.go:351），"Go 原版输出"即上游响应原文；
//     本卡无 Go 工具链且无真实凭据，故按源码路径推导确定性输出（README 允许）。
//
// 快照生成：UPDATE_SNAPSHOTS=1 npx vitest run tests/freebuff-snapshot.test.ts
// =============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FreebuffProvider } from '../src/providers/freebuff/provider.js';
import { normalizeSnapshot, compareWithFixture } from './snapshot/helpers.js';
import { sentinelFor } from './snapshot/scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM_FIXTURES_DIR = path.join(HERE, 'snapshot', 'fixtures', 'upstream');
const SNAPSHOT_DIR = path.join(HERE, 'snapshot', 'fixtures', 'snapshots');

const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === '1';

const MODEL = 'z-ai/glm-5.1';
const AGENT = 'snapshot-agent';
const REGISTRY_SOURCE = `export const freeAgents = {
  '${AGENT}': new Set(['${MODEL}']),
};\n`;

const STREAM_SCENARIO = 'freebuff-chat-basic';
const NONSTREAM_SCENARIO = 'freebuff-chat-basic-nonstream';

const ORIGINAL_ALLOWED = process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS;
const ORIGINAL_TOKENS = process.env.FREEBUFF_TOKENS;

let mock: http.Server;
let base = '';
let provider: FreebuffProvider;

function findScenario(bodyText: string): string | null {
  const m = /__SNAPSHOT:([a-z0-9][a-z0-9-]*)__/i.exec(bodyText);
  return m ? m[1] : null;
}

beforeAll(async () => {
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf-8')));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const p = url.pathname;
      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (p === '/free-agents.ts') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(REGISTRY_SOURCE);
        return;
      }
      if (p === '/api/v1/freebuff/session') {
        if (req.method === 'DELETE') return sendJson(200, { ok: true });
        return sendJson(200, {
          status: 'active',
          instanceId: 'inst-snap',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (p === '/api/v1/agent-runs') {
        const body = JSON.parse(raw || '{}');
        if (body.action === 'START') return sendJson(200, { runId: 'run-snap-1' });
        return sendJson(200, { ok: true });
      }
      if (p === '/api/v1/chat/completions') {
        const scenario = findScenario(raw);
        if (!scenario) return sendJson(400, { message: 'no sentinel in request' });
        const fixturePath = path.join(UPSTREAM_FIXTURES_DIR, `${scenario}.json`);
        if (!fs.existsSync(fixturePath)) {
          return sendJson(502, { message: `no upstream fixture for '${scenario}'` });
        }
        const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
          response: { status: number; headers: Record<string, string>; body: string };
        };
        res.writeHead(fixture.response.status, fixture.response.headers);
        res.end(fixture.response.body);
        return;
      }
      return sendJson(404, { message: `mock upstream: unhandled ${p}` });
    });
  });

  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const address = mock.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;

  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  process.env.FREEBUFF_TOKENS = 'snapshot-token';
  provider = new FreebuffProvider();
  await provider.initialize({
    apiBase: base,
    modelRegistryUrl: `${base}/free-agents.ts`,
  });
});

afterAll(async () => {
  if (provider) await provider.destroy();
  if (mock) await new Promise<void>((r) => mock.close(() => r()));
  if (ORIGINAL_ALLOWED === undefined) delete process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS;
  else process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = ORIGINAL_ALLOWED;
  if (ORIGINAL_TOKENS === undefined) delete process.env.FREEBUFF_TOKENS;
  else process.env.FREEBUFF_TOKENS = ORIGINAL_TOKENS;
});

async function collectDeltas(scenario: string, stream: boolean): Promise<string> {
  const deltas: string[] = [];
  for await (const delta of provider.chatCompletion(
    {
      model: MODEL,
      messages: [{ role: 'user', content: sentinelFor(scenario) }],
      stream,
    },
    { requestId: `snap-${scenario}` },
  )) {
    deltas.push(delta);
  }
  // 一增量一行：既锁内容也锁分帧边界。
  return `${deltas.join('\n')}\n`;
}

describe('Freebuff 文本增量快照（upstream fixture 回放）', () => {
  it('流式：SSE chunk → 文本增量与 fixture 逐字节一致', async () => {
    const actual = normalizeSnapshot(await collectDeltas(STREAM_SCENARIO, true));
    const result = await compareWithFixture(
      actual,
      path.join(SNAPSHOT_DIR, `${STREAM_SCENARIO}-stream.txt`),
      { update: UPDATE_SNAPSHOTS },
    );
    expect(result.ok, result.message).toBe(true);
  });

  it('非流式：JSON 响应 → 单块文本与 fixture 逐字节一致', async () => {
    const actual = normalizeSnapshot(await collectDeltas(NONSTREAM_SCENARIO, false));
    const result = await compareWithFixture(
      actual,
      path.join(SNAPSHOT_DIR, `${NONSTREAM_SCENARIO}.json`),
      { update: UPDATE_SNAPSHOTS },
    );
    expect(result.ok, result.message).toBe(true);
  });
});
