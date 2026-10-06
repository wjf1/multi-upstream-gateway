#!/usr/bin/env node
// =============================================================================
// scripts/collect-fixtures.mjs —— upstream fixture 采集脚本(T107 框架)
// -----------------------------------------------------------------------------
// 用途:对一个「上游实现」(真实 Go 二进制 / sidecar,或脚本内建的 demo 上游)
// 发送 CC wire 请求(POST /alpha/generate,携带 __SNAPSHOT:<场景>__ 哨兵),
// 把 HTTP/SSE 响应体逐字节采集为 tests/snapshot/fixtures/upstream/<场景>.json。
//
// 模式:
//   1. demo 模式(默认,无 --target):脚本内起一个只渲染 scenarios.mjs 内置
//      场景的本地 mock 上游,自采自录 —— 用于验证采集链路本身,不强求对接
//      真实 Go 程序。
//   2. target 模式(--target <url>):对真实上游采集。T201 Freebuff 用 Go
//      二进制监听本地端口后采集;T204 WorkBuddy(联邦路线)采集时先手动
//      启动 Go sidecar,--target 指向其监听地址。sidecar 自动拉起托管成熟后,
//      可在 collectFromSidecar() 钩子内接管生命周期。
//
// 用法:
//   node scripts/collect-fixtures.mjs
//   node scripts/collect-fixtures.mjs --target http://127.0.0.1:8080 \
//        --scenario freebuff-chat-basic --out tests/snapshot/fixtures/upstream
//
// 注意:采集产物会覆盖同名 fixture;git diff 人工审查后入库。
// =============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sentinelFor, scenarioNameFromBody, renderScenario } from '../tests/snapshot/scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, '..', 'tests', 'snapshot', 'fixtures', 'upstream');
const DEFAULT_SCENARIO = 'commandcode-chat-basic';
const DEFAULT_MODEL = 'claude-sonnet-5';

/** 解析 --key value 形式的命令行参数。 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

/** 起一个只渲染内置场景的 demo 上游(演示采集链路用)。 */
function startDemoUpstream() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c.toString('utf-8')));
    req.on('end', () => {
      const name = scenarioNameFromBody(body);
      const sse = name ? renderScenario(name) : null;
      if (!sse) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `demo upstream: unknown scenario '${name}'` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

/** 对目标上游发 CC wire 请求,返回 { status, contentType, bodyText }。 */
async function collectResponse(targetBase, scenario, model) {
  const wireBody = {
    params: {
      model,
      messages: [{ role: 'user', content: sentinelFor(scenario) }],
      max_tokens: 1024,
      stream: true,
    },
  };
  const res = await fetch(`${targetBase}/alpha/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer collect-fixtures-placeholder',
      'user-agent': 'cli',
      'x-cli-environment': 'cli',
    },
    body: JSON.stringify(wireBody),
  });
  const bodyText = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type') || '', bodyText };
}

/**
 * T204 WorkBuddy(sidecar)预留钩子:sidecar 生命周期托管成熟后在此实现
 * 「自动拉起 Go 二进制 → 健康检查 → 采集 → 回收」。当前采集前请手动启动
 * sidecar 并保持其就绪,--target 指向其监听地址即可。
 */
async function collectFromSidecar(_targetBase, _scenario) {
  throw new Error(
    'collectFromSidecar(): sidecar 自动拉起尚未实现 —— 请先手动启动 WorkBuddy Go sidecar,\n' +
    '  再用 --target http://127.0.0.1:<sidecar端口> 采集(见 tests/snapshot/README.md T204 节)。',
  );
}

/** 把采集结果写为 upstream fixture(headers 只留 content-type,不录易变头)。 */
function writeFixture(outDir, scenario, model, collected) {
  const fixture = {
    name: scenario,
    source: 'scripts/collect-fixtures.mjs 采集(--target 见 README;demo 模式为内置场景渲染)',
    request: { match: { sentinel: sentinelFor(scenario), model } },
    response: {
      status: collected.status,
      headers: { 'content-type': collected.contentType },
      body: collected.bodyText,
    },
  };
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${scenario}.json`);
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n', 'utf-8');
  return outPath;
}

const args = parseArgs(process.argv.slice(2));
const scenario = args.scenario || DEFAULT_SCENARIO;
const model = args.model || DEFAULT_MODEL;
const outDir = args.out ? path.resolve(args.out) : DEFAULT_OUT;

let demoServer = null;
let targetBase = args.target;
let mode = 'target';

try {
  if (targetBase === 'sidecar') {
    // --target sidecar:走 T204 预留钩子(当前明确报错并给出操作指引)。
    await collectFromSidecar(targetBase, scenario);
  }
  if (!targetBase) {
    mode = 'demo';
    const demo = await startDemoUpstream();
    demoServer = demo.server;
    targetBase = demo.base;
  }

  const collected = await collectResponse(targetBase, scenario, model);
  if (collected.status !== 200 || !collected.bodyText) {
    throw new Error(
      `采集失败:上游 ${targetBase} 返回 status=${collected.status},body 长度=${collected.bodyText.length}`,
    );
  }

  const outPath = writeFixture(outDir, scenario, model, collected);
  const bytes = Buffer.byteLength(collected.bodyText, 'utf-8');
  console.log(`[collect] 模式=${mode} 场景=${scenario} 目标=${targetBase}`);
  console.log(`[collect] 已写入 ${outPath}(响应体 ${bytes} 字节,status=${collected.status})`);
  console.log('[collect] 请 git diff 人工审查后入库;vitest 侧 mock 将优先回放该 fixture。');
} finally {
  if (demoServer) await new Promise((r) => demoServer.close(r));
}
