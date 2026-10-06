// =============================================================================
// T202a：Freebuff tools schema 规范化（server.go:405-686 移植回归）
// -----------------------------------------------------------------------------
// 覆盖两件事，缺一不可：
//   1) 单元层：normalizeToolSchemas 的 $ref 解析与 nullable 简化语义；
//   2) 端到端层：mock 上游**实际收到**的请求体里，tools[].function.parameters
//      已完成规范化（而不是只有内部函数自测通过）。
//
// 契约来源：F:/AI/Qdor/review/Freebuff2API/server.go
//   - server.go:408 normalizeToolSchemas
//   - server.go:479/$ref 解析（tryResolveRef:632）
//   - server.go:493/495/496 nullable 简化（simplifyNullableCombinator:515）
//
// 隔离纪律：logger 的 LOG_FILE_PATH 是模块加载期常量，必须在动态 import 之前
// 用环境变量把路径指到临时目录（本仓库踩过坑）。Freebuff 的 provider/config 本身
// 不做加载期求值（见 config.ts 文件头），故可在 env 就位后再动态 import。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

let server: http.Server;
let base = '';
let stateDir = '';
/** chat/completions 真正收到的请求体（解析后的对象）。 */
let chatBodies: any[] = [];

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-freebuff-schema-'));

  // 模块加载期常量隔离（必须在任何 src/** 动态 import 之前设好）。
  process.env.COMMANDCODE_LOG_PATH = path.join(stateDir, 'proxy.log');
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  process.env.FREEBUFF_TOKENS = 'freebuff-test-token';

  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';

      // 1) 模型注册表源（free-agents.ts 片段）。
      if (url.startsWith('/free-agents.ts')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end("export const freeAgents = {\n  'base2-free': new Set(['mock-model']),\n};\n");
        return;
      }
      // 2) free session。
      if (url.startsWith('/api/v1/freebuff/session')) {
        if (req.method === 'DELETE') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'active',
            instanceId: 'inst-1',
            expiresAt: '',
            position: 0,
            queueDepth: 0,
            queuedAt: '',
            remainingMs: 0,
            estimatedWaitMs: 0,
            gracePeriodRemainingMs: 0,
            message: '',
          }),
        );
        return;
      }
      // 3) run 生命周期。
      if (url.startsWith('/api/v1/agent-runs')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId: 'run-1' }));
        return;
      }
      // 4) 对话补全：抓取请求体后返回一个非流式成功体。
      if (url.startsWith('/api/v1/chat/completions')) {
        chatBodies.push(raw ? JSON.parse(raw) : null);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** 带 $ref + definitions 的 parameters（模拟 LobeChat 风格客户端）。 */
function paramsWithRef() {
  return {
    type: 'object',
    properties: {
      user: { $ref: '#/definitions/User' },
      tags: { anyOf: [{ type: 'null' }, { type: 'array', items: { type: 'string' } }] },
    },
    definitions: {
      User: {
        type: 'object',
        properties: { name: { type: 'string', nullable: true } },
        required: ['name'],
      },
    },
    required: ['user'],
  };
}

describe('normalizeToolSchemas（server.go:408 单元语义）', () => {
  it('解析 $ref 为内联定义，并删除 definitions/$defs', async () => {
    const { normalizeToolSchemas } = await import('../src/providers/freebuff/tool-schema.js');
    const tools = [
      { type: 'function', function: { name: 'lookup', parameters: paramsWithRef() } },
    ];
    const out = normalizeToolSchemas(tools as any);
    const params = (out[0] as any).function.parameters;

    expect(params.properties.user).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(params.definitions).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain('$ref');
  });

  it('简化 nullable：anyOf[null, T] 内联为 T，type:["T","null"] 取 T，nullable 删除', async () => {
    const { normalizeToolSchemas } = await import('../src/providers/freebuff/tool-schema.js');
    const tools = [
      {
        type: 'function',
        function: {
          name: 'simple',
          parameters: {
            type: 'object',
            properties: {
              a: { anyOf: [{ type: 'null' }, { type: 'string' }] },
              b: { type: ['integer', 'null'] },
              c: { type: 'string', nullable: true },
            },
          },
        },
      },
    ];
    const params = (normalizeToolSchemas(tools as any)[0] as any).function.parameters;

    expect(params.properties.a).toEqual({ type: 'string' });
    expect(params.properties.b).toEqual({ type: 'integer' });
    expect(params.properties.c).toEqual({ type: 'string' });
    expect(JSON.stringify(params)).not.toContain('nullable');
  });

  it('非 tools 请求不受影响（无 function/parameters 时原样返回）', async () => {
    const { normalizeToolSchemas } = await import('../src/providers/freebuff/tool-schema.js');
    const tools = [{ type: 'custom', custom: { name: 'x' } }, 'not-an-object'];
    expect(normalizeToolSchemas(tools as any)).toEqual(tools);
  });

  it('不修改调用方传入的对象（Go 侧先 cloneMap，语义一致）', async () => {
    const { normalizeToolSchemas } = await import('../src/providers/freebuff/tool-schema.js');
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: paramsWithRef() } }];
    const snapshot = JSON.parse(JSON.stringify(tools));
    normalizeToolSchemas(tools as any);
    expect(tools).toEqual(snapshot);
  });
});

describe('buildUpstreamBody → mock 上游实际收到的体', () => {
  it('$ref 已内联为定义、nullable 已简化', async () => {
    const { FreebuffProvider } = await import('../src/providers/freebuff/provider.js');
    const provider = new FreebuffProvider();
    await provider.initialize({
      apiBase: base,
      modelRegistryUrl: `${base}/free-agents.ts`,
      requestTimeoutMs: 5_000,
      rotationIntervalMs: 60_000,
    });

    const req = {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: paramsWithRef() } }],
    };

    chatBodies = [];
    const chunks: string[] = [];
    try {
      for await (const piece of provider.chatCompletion(req as any, { requestId: 't-schema-1' })) {
        chunks.push(piece);
      }
    } finally {
      await provider.destroy();
    }

    expect(chunks.join('')).toBe('ok');
    expect(chatBodies.length).toBe(1);

    const sent = chatBodies[0];
    const params = sent.tools[0].function.parameters;

    // ① $ref 已解析成内联定义。
    expect(params.properties.user).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(JSON.stringify(sent)).not.toContain('$ref');
    expect(params.definitions).toBeUndefined();

    // ② nullable 已简化（anyOf[null,T] → T；type:["T","null"] → T）。
    expect(params.properties.tags).toEqual({ type: 'array', items: { type: 'string' } });
    expect(JSON.stringify(sent)).not.toContain('nullable');

    // 调用方原始请求未被就地改写。
    expect((req.tools[0].function.parameters as any).properties.user).toEqual({
      $ref: '#/definitions/User',
    });
  }, 20_000);
});
