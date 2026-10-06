// =============================================================================
// 200 流内 error 事件的重试判定
// -----------------------------------------------------------------------------
// 背景（真实事故）：请求带着 29 万 token 上下文打到上游，网关转发 provider 时失败，
// 回了一个 HTTP **200** 的流，里面是 error 事件 "Invalid error response format: Gateway
// request failed"。旧行为把它当成模型的回答返回 —— 界面里那一轮 16 分钟的工作就以这段
// 文本收场。HTTP 层的重试只覆盖非 2xx，够不到它。
//
// 这里的纯函数决定「要不要丢弃本次调用重试」，判错的两个方向都有代价：
//   - 该重试却没重试 → 用户白等一轮（本次事故）；
//   - 不该重试却重试 → 白耗额度（29 万 token 上下文单次 $0.087，两次就是 $0.26
//     换一个必然相同的错误）。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { isRetryableEventMessage, classifyProbeEvent, classifyBuffered } from '../src/adapters/commandcode/upstream.js';
import { probeUpstream } from '../src/adapters/commandcode/pipeline/stream.js';
import { UpstreamError } from '../src/adapters/commandcode/pipeline/errors.js';
import { ErrorCode } from '../src/utils/errors.js';

describe('isRetryableEventMessage — 只重试瞬时性失败', () => {
  it('典型瞬时失败值得重试', () => {
    // 本次事故里的原文
    expect(isRetryableEventMessage('Invalid error response format: Gateway request failed')).toBe(true);
    expect(isRetryableEventMessage('Our servers are currently overloaded. Please try again.')).toBe(true);
    expect(isRetryableEventMessage("No available providers match the 'only' filter")).toBe(true);
  });

  it('确定性不可用不重试（重试只会白耗额度）', () => {
    expect(isRetryableEventMessage('This model is not available in your region')).toBe(false);
    expect(isRetryableEventMessage('Model/provider not recognized: anthropic:foo')).toBe(false);
    expect(isRetryableEventMessage('This model does not exist')).toBe(false);
  });

  // 否决表此前只覆盖「确定性不可用」，落表的文案一律重试，于是上游校验层拒绝的
  // 请求也被打满预算：实测 maxRetries=2 时上游被连打 3 次、多花 1.5s 退避，
  // 换回必然相同的错误（29 万 token 上下文单次 $0.087）。
  it('请求形态类错误不重试', () => {
    // 实测出现过的上游校验拒绝原文
    expect(isRetryableEventMessage('Too big: expected number to be <=200000')).toBe(false);
    expect(isRetryableEventMessage("Unrecognized key(s) in object: 'cache_control'")).toBe(false);
    expect(isRetryableEventMessage('unrecognized_keys')).toBe(false);
    expect(isRetryableEventMessage("Invalid enum value. Expected 'auto' | 'none', received 'turbo'")).toBe(false);
    expect(isRetryableEventMessage('Prompt is too long')).toBe(false);
    expect(isRetryableEventMessage('Context length exceeded: 310000 tokens')).toBe(false);
  });

  // 关键护栏：`Invalid error response format:` 只是网关的**包装前缀**，瞬时与
  // 确定性错误都带它。谁要是想按这个前缀拉黑，会把本仓库最典型的那次瞬时故障
  // （Gateway request failed）的重试保护一起关掉。
  it('包装前缀不作为判据：同前缀下的瞬时失败仍然重试', () => {
    expect(isRetryableEventMessage('Invalid error response format: Gateway request failed')).toBe(true);
    expect(isRetryableEventMessage('Invalid error response format: No available providers')).toBe(true);
    expect(isRetryableEventMessage('Our servers are currently overloaded. Please try again.')).toBe(true);
  });

  it('计费/套餐类终止错误不重试（复用 terminalCodeFor 判定）', () => {
    expect(isRetryableEventMessage('insufficient credits')).toBe(false);
    expect(isRetryableEventMessage('premium_credits_exhausted')).toBe(false);
    expect(isRetryableEventMessage('model_not_in_plan')).toBe(false);
  });

  it('空消息不重试（判不出来就别浪费额度）', () => {
    expect(isRetryableEventMessage('')).toBe(false);
    expect(isRetryableEventMessage('   ')).toBe(false);
    expect(isRetryableEventMessage(undefined as any)).toBe(false);
  });
});

describe('classifyProbeEvent — 单个事件的判定', () => {
  it('可重试的 error 事件 → retry', () => {
    expect(classifyProbeEvent({ type: 'error', error: 'Gateway request failed' })).toBe('retry');
    expect(classifyProbeEvent({ type: 'error', error: { message: 'Gateway request failed' } })).toBe('retry');
  });

  it('确定性的 error 事件 → accept（重试也白搭，按既有逻辑原样交出去）', () => {
    expect(classifyProbeEvent({ type: 'error', error: 'This model is not available in your region' })).toBe('accept');
  });

  it('内容类事件 → accept（已经开始产出，不能再丢）', () => {
    for (const type of ['text-delta', 'reasoning-delta', 'tool-call', 'tool-call-delta', 'finish', 'finish-step']) {
      expect(classifyProbeEvent({ type })).toBe('accept');
    }
  });

  it('start / 未知事件 → ignore（不影响判定，继续看）', () => {
    // 这条是本次修复的要害：CC 的流以 start 开场，用「首事件」判定等于永不触发。
    expect(classifyProbeEvent({ type: 'start' })).toBe('ignore');
    expect(classifyProbeEvent({ type: 'usage' })).toBe('ignore');
    expect(classifyProbeEvent(null)).toBe('ignore');
    expect(classifyProbeEvent({})).toBe('ignore');
  });
});

describe('classifyBuffered — 增量扫描，处理被截断的半行', () => {
  const line = (o: unknown) => `data: ${JSON.stringify(o)}\n`;

  it('start 之后才是 error：照样判定为 retry', () => {
    const text = line({ type: 'start' }) + line({ type: 'error', error: 'Gateway request failed' });
    expect(classifyBuffered(text, 0).verdict).toBe('retry');
  });

  it('内容先到：判为 accept，不再往后看 error', () => {
    const text = line({ type: 'text-delta', text: 'hi' }) + line({ type: 'error', error: 'Gateway request failed' });
    expect(classifyBuffered(text, 0).verdict).toBe('accept');
  });

  it('半行不判定，等下一批数据', () => {
    const partial = line({ type: 'start' }) + 'data: {"type":"err';
    const r = classifyBuffered(partial, 0);
    expect(r.verdict).toBe('ignore');
    // 补齐后即可判定，且不重复扫描已处理过的行
    const full = partial + 'or","error":"Gateway request failed"}\n';
    expect(classifyBuffered(full, r.scanned).verdict).toBe('retry');
  });

  it('忽略空行、SSE 注释与 [DONE]', () => {
    const text = '\n: keepalive\n\ndata: [DONE]\n' + line({ type: 'text-delta', text: 'x' });
    expect(classifyBuffered(text, 0).verdict).toBe('accept');
  });

  it('全是中性事件 → 保持 ignore（继续攒）', () => {
    expect(classifyBuffered(line({ type: 'start' }) + line({ type: 'usage', n: 1 }), 0).verdict).toBe('ignore');
  });

  it('非法 JSON 行被跳过而不是误判', () => {
    expect(classifyBuffered('data: {broken\n' + line({ type: 'start' }), 0).verdict).toBe('ignore');
  });
});

// =============================================================================
// probeUpstream —— 预读期间「什么算失败」
// -----------------------------------------------------------------------------
// 背景（真实事故 2026-10-07 01:19）：上游在以 HTTP 200 起了流、吐了 start 之后，
// 在首个内容事件之前被掐断（客户端侧是 undici 的 TypeError: terminated）。旧实现
// 里 `close`/`error` 只调用 finish() 而不落判定，于是判成 ignore 放行 —— 把一个
// **已经死掉的流**交给路由，外层重试循环根本没被触发，用户看到的就是一轮失败。
//
// 这里的判据是「客户端是否已经收到过字节」：预读期间所有字节都只在本地缓冲里，
// 从未转发，所以此刻丢弃重试永远是安全的。反之，只要已经放行（内容事件先到、
// 或超了 30s/64KB 窗口）就不再重试 —— 那条边界由下面「中途失败不重试」的用例锁死。
// =============================================================================
describe('probeUpstream — 传输层中断的判定', () => {
  /** 依次吐出给定文本，然后以 err 结束的流（Readable.from 会把它转成 'error' 事件）。 */
  const thenError = (chunks: string[], err: unknown) =>
    Readable.from(
      (async function* () {
        for (const c of chunks) yield Buffer.from(c, 'utf8');
        throw err;
      })(),
    );

  const startLine = 'data: {"type":"start","id":"x"}\n\n';

  /** 消费放行后的流，报告它是以错误结束还是正常收尾。 */
  const outcome = (s: Readable) =>
    new Promise<string>(resolve => {
      let acc = '';
      s.on('data', (c: Buffer) => (acc += c.toString()));
      s.on('error', (e: Error) => resolve(`ERR:${e.message}`));
      s.on('end', () => resolve(`${acc}|END`));
    });

  it('吐了 start 之后被掐断 → 判为可重试的中断（本次事故的形态）', async () => {
    const probe = await probeUpstream(thenError([startLine], new TypeError('terminated')));
    expect(probe.rejected).toBe(true);
    // 成因与原文都要带出来：日志里那句 terminated 是排障时唯一的线索。
    expect(probe.reason).toBe('stream-error');
    expect(probe.detail).toBe('terminated');
  });

  it('一个字节都没吐就被掐断 → 同样判为可重试', async () => {
    const probe = await probeUpstream(thenError([], new Error('other side closed')));
    expect(probe.rejected).toBe(true);
    expect(probe.reason).toBe('stream-error');
  });

  it('流内 error 事件（既有形态）仍判为可重试，且成因标记为 error-event', async () => {
    const probe = await probeUpstream(
      Readable.from([Buffer.from('data: {"type":"start"}\n\ndata: {"type":"error","error":"Gateway request failed"}\n\n')]),
    );
    expect(probe.rejected).toBe(true);
    expect(probe.reason).toBe('error-event');
  });

  // 客户端已经走了就别替它重试（白耗额度）；两类超时注入的 UpstreamError 本就定义为
  // 不可重试，绝不能在这里被改判成可重试。
  it('中止类错误不放行重试', async () => {
    const aborted: any = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    const probe = await probeUpstream(thenError([startLine], aborted));
    expect(probe.rejected).toBe(false);
    // 放行后按既有契约把错误原样交给下游，而不是替一个已经走了的客户端再打一次上游。
    expect(await outcome(probe.stream)).toBe('ERR:The operation was aborted');
  });

  it('UpstreamError 沿用自身的 retryable 标志', async () => {
    const idle = new UpstreamError('No data from upstream for 120s', 504, false, ErrorCode.STREAM_IDLE_TIMEOUT);
    const p1 = await probeUpstream(thenError([startLine], idle));
    expect(p1.rejected).toBe(false);
    expect(await outcome(p1.stream)).toBe('ERR:No data from upstream for 120s');

    const retryable = new UpstreamError('connect ECONNRESET', undefined, true, ErrorCode.NETWORK_ERROR);
    expect((await probeUpstream(thenError([startLine], retryable))).rejected).toBe(true);
  });

  it('内容事件先到：放行而不是重试（此后中途失败不能再丢弃）', async () => {
    const probe = await probeUpstream(
      thenError([startLine, 'data: {"type":"text-delta","text":"partial"}\n\n'], new Error('terminated')),
    );
    expect(probe.rejected).toBe(false);
    // 已放行的流：中途失败按既有契约原样传给下游，不再重试。
    const seen = await new Promise<string>(resolve => {
      let acc = '';
      probe.stream.on('data', (c: Buffer) => (acc += c.toString()));
      probe.stream.on('error', (e: Error) => resolve(`${acc}|ERR:${e.message}`));
      probe.stream.on('end', () => resolve(`${acc}|END`));
    });
    expect(seen).toBe('data: {"type":"start","id":"x"}\n\ndata: {"type":"text-delta","text":"partial"}\n\n|ERR:terminated');
  });

  it('正常收尾的流（finish 事件）不判失败', async () => {
    const probe = await probeUpstream(
      Readable.from([
        Buffer.from(startLine + 'data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish"}\n\n'),
      ]),
    );
    expect(probe.rejected).toBe(false);
    const text = await new Promise<string>(resolve => {
      let acc = '';
      probe.stream.on('data', (c: Buffer) => (acc += c.toString()));
      probe.stream.on('end', () => resolve(acc));
    });
    expect(text).toContain('ok');
  });
});
