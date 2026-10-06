// =============================================================================
// 回归：上游在产出任何内容之前把流掐断（传输层中断），必须重试而不是直接失败
// -----------------------------------------------------------------------------
// 真实事故（2026-10-07 01:19:05，会话 sess_7430d017）：一次 1001 条消息的请求打到
// 上游，7 秒后流被掐断。代理日志只有一行
//   [MESSAGES] Upstream stream error | Trace msg_edb441fe | terminated
// 然后就没有下文了 —— 客户端收到 PROVIDER_PROTOCOL_ERROR、retryable=false，那一轮
// 直接失败。而当时 maxRetries=2，重试预算充足。
//
// 根因不在 HTTP 层：非 2xx 的重试一直是好的。缺口在首事件探测 —— 它只在「上游用
// 200 的流回 error 事件」时判定重试，传输层中断（undici 的 TypeError: terminated）
// 被 `close`/`error` 处理器判成 ignore 放行，把一个**已经死掉的流**交给了路由，
// 重试循环根本没机会跑。
//
// 这里断言的是可观测行为：第二次尝试的输出被完整交付，且第一次尝试的半个流不会被
// 重复投递（客户端一字节都没收到，所以丢弃是安全的）。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const START = 'data: {"type":"start","id":"x"}\n\n';
const TEXT = 'data: {"type":"text-delta","text":"recovered"}\n\n';
/** 中途失败剧本专用：故意用不同的文本，避免与重试成功后的输出混为一谈。 */
const TEXT_MID = 'data: {"type":"text-delta","text":"partial-before-cut"}\n\n';
const FINISH = 'data: {"type":"finish"}\n\n';

let server: http.Server;
let base = '';
let stateDir = '';
/** 每次请求到达时，按序记录该次尝试发给上游的 model。 */
let attempts: string[] = [];
/** 用哪套剧本：'cut-before-content' 在首个内容事件之前掐断；'cut-mid-stream' 产出一段后再掐断。 */
let scenario: 'cut-before-content' | 'cut-mid-stream' = 'cut-before-content';

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-stream-retry-'));

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const attempt = attempts.length + 1;
      attempts.push(JSON.parse(body || '{}')?.params?.model ?? '?');

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(START);

      if (attempt === 1 && scenario === 'cut-before-content') {
        // 吐了 start 就把 socket 拆了：客户端侧表现为 undici 的 terminated。
        // 延迟一拍确保 start 已经冲刷出去，否则客户端什么都读不到，测的就不是这条路径。
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (attempt === 1 && scenario === 'cut-mid-stream') {
        // 已经产出内容之后才断：这条不能再丢弃重试（会重复投递内容）。
        res.write(TEXT_MID);
        setTimeout(() => res.destroy(), 20);
        return;
      }

      res.write(TEXT);
      res.write(FINISH);
      res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({
      upstream: { timeoutMs: 20_000, idleTimeoutMs: 5_000, maxRetries: 2 },
    }),
  );
  process.env.COMMANDCODE_API_BASE = base;
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
  process.env.COMMANDCODE_PRICING_CACHE_PATH = path.join(stateDir, 'pricing.json');
  process.env.COMMANDCODE_ENV_FILE_PATH = path.join(stateDir, '.env');
  process.env.COMMANDCODE_API_KEY = 'ck-stream-retry-fake-credential';
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

function makeBody() {
  return {
    threadId: 't-stream-retry',
    params: { model: 'claude-sonnet-5', stream: false, messages: [{ role: 'user', content: 'hi' }] },
    config: { workingDir: stateDir },
  } as any;
}

/** 消费 sendToCC 返回的流，把「收到的字节」与「是否以错误结束」分开报告。 */
function drain(stream: NodeJS.ReadableStream): Promise<{ text: string; error?: string }> {
  return new Promise(resolve => {
    let acc = '';
    stream.on('data', (c: Buffer) => (acc += c.toString()));
    stream.on('error', (e: Error) => resolve({ text: acc, error: e.message }));
    stream.on('end', () => resolve({ text: acc }));
  });
}

describe('上游在产出内容前被掐断 → 丢弃本次尝试重试', () => {
  it('第一次的流被掐断后，重试拿到的完整回答被交付（本次事故的形态）', async () => {
    const { sendToCC } = await import('../src/adapters/commandcode/upstream.js');
    attempts = [];
    scenario = 'cut-before-content';

    const stream = await sendToCC(makeBody(), { apiKey: 'ck-a' });
    const got = await drain(stream);

    // 关键断言：上游被打了两次（说明重试真的发生了），且客户端拿到的是完整回答。
    expect(attempts.length).toBe(2);
    expect(got.error).toBeUndefined();
    expect(got.text).toContain('recovered');
    // 第一次尝试的 start 不能被重复投递（客户端一字节未收，所以丢弃是安全的）——
    // start 只应出现一次。
    expect(got.text.match(/"type":"start"/g)?.length).toBe(1);
  }, 20_000);

  it('已经产出内容之后才断 → 不重试（内容不能重复投递）', async () => {
    const { sendToCC } = await import('../src/adapters/commandcode/upstream.js');
    attempts = [];
    scenario = 'cut-mid-stream';

    const got = await drain(await sendToCC(makeBody(), { apiKey: 'ck-a' }));

    // 这条边界是本次修改的范围上限：中途失败按既有契约原样交给调用方（并入流），
    // 重试只覆盖「什么都没产出」的那一段。
    expect(attempts.length).toBe(1);
    expect(got.text).toContain('partial-before-cut');
    expect(got.error).toMatch(/terminated|other side closed|ECONNRESET/i);
  }, 20_000);
});
