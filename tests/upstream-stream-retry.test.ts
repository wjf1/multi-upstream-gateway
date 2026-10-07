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
/** 用哪套剧本：'cut-before-content' 在首个内容事件之前掐断；'cut-mid-stream' 产出一段后再掐断；
 *  'stall-before-content' 起了流（响应头已发）但一个字节都不吐，只由空闲看门狗定性；
 *  'stall-after-start' 吐了 start（元数据，不等于内容）后既不吐内容也不断连，同由看门狗定性
 *  —— v5.0.2 按「有没有字节」判，这条会被放行，正是 2026-10-07 20:36 的线上形态。 */
let scenario: 'cut-before-content' | 'cut-mid-stream' | 'stall-before-content' | 'stall-after-start' =
  'cut-before-content';

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-stream-retry-'));

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const attempt = attempts.length + 1;
      attempts.push(JSON.parse(body || '{}')?.params?.model ?? '?');

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      if (attempt === 1 && scenario === 'stall-before-content') {
        // 起了流（响应头已发）但一个字节都不吐，也不断连：只有空闲看门狗能定性。
        // 头必须先冲刷出去，否则客户端连响应头都收不到，走的是「等响应头阶段的空闲
        // 超时」—— 那条路径本来就判为可重试（response-error.ts），测不到本次要修的
        // 缺口：响应头已到、body 一个字节都没有。
        res.flushHeaders();
        return;
      }

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
      if (attempt === 1 && scenario === 'stall-after-start') {
        // start 已经写进去了（上面的 res.write(START)），之后既不吐内容也不断连：字节
        // 到过、内容没到，只有空闲看门狗能定性 —— v5.0.2 按「有没有字节」判会放行。
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

  // 2026-10-07 10:03 的事故形态：上游回了响应头，之后一个字节都不给，直到空闲看门狗
  // （本用例配置为 5s）把它判死。修复前这一轮直接失败（retryable=false、预算没用），
  // 修复后按「产出内容前失败」丢弃重试 —— 与同族的 terminated 形态同判。
  it('响应头已到但一个字节都不吐 → 空闲看门狗定性后重试', async () => {
    const { sendToCC } = await import('../src/adapters/commandcode/upstream.js');
    attempts = [];
    scenario = 'stall-before-content';

    const stream = await sendToCC(makeBody(), { apiKey: 'ck-a' });
    const got = await drain(stream);

    expect(attempts.length).toBe(2);
    expect(got.error).toBeUndefined();
    expect(got.text).toContain('recovered');
  }, 20_000);

  // 2026-10-07 20:36 的线上形态（v5.0.2 漏掉的那条）：CC 的流以 start 事件开场，字节在
  // 第一毫秒就到了，随后彻底静默直到空闲看门狗判死。注入点按「上游有没有吐过字节」给的
  // retryable 是 false（字节到过），旧探测层据此放行 → 客户端白等 30s 探测 + 120s 看门狗
  // 才拿到不可重试的 504（实测 timingMs=151274）。判据改成「有没有内容事件」后，这条与
  // 同族的零字节形态同判。
  it('只吐了 start 就彻底静默 → 按「没有内容事件」丢弃重试', async () => {
    const { sendToCC } = await import('../src/adapters/commandcode/upstream.js');
    attempts = [];
    scenario = 'stall-after-start';

    const stream = await sendToCC(makeBody(), { apiKey: 'ck-a' });
    const got = await drain(stream);

    expect(attempts.length).toBe(2);
    expect(got.error).toBeUndefined();
    expect(got.text).toContain('recovered');
    // 第一次尝试的 start 只该出现一次：它在预读缓冲里、从未转发，随丢弃一起没了。
    expect(got.text.match(/"type":"start"/g)?.length).toBe(1);
  }, 20_000);
});
