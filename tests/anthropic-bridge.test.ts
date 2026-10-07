// =============================================================================
// Anthropic 桥测试（T202b）
// -----------------------------------------------------------------------------
// 覆盖 `src/providers/core/anthropic-bridge.ts` 的三个面 + 辅助函数：
//   1. 请求侧：Anthropic Messages → OpenAI Chat Completions（`anthropicToOpenAIRequest`）；
//   2. 非流式响应侧：OpenAI chat.completion → Anthropic message 信封；
//   3. **流式侧**：`AnthropicStreamEncoder` 的块生命周期（本卡的核心 DoD）——
//      message_start → content_block_start → delta… → content_block_stop →
//      message_delta → message_stop，thinking / tool_use 块的开关与 index 分配正确。
//
// 断言口径：结构优先（事件名、顺序、块类型、index 互斥、文本可还原），
// 而非逐字节比对整个 data 载荷——后者会被无关字段变动打断，且本卡的 DoD 是
// 「块生命周期完整」与「tools schema 规范化后上游接收正确」（后者在 T202a 已覆盖）。
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { AnthropicRequest } from '../src/types/index.js';
import {
  AnthropicStreamEncoder,
  anthropicToOpenAIRequest,
  mapFinishReason,
  openAIResponseToAnthropicMessage,
  sanitizeToolId,
  sseFrame,
  thinkingToReasoningEffort,
  type OpenAIChunkLike,
} from '../src/providers/core/anthropic-bridge.js';

/** 把 SSE 帧解析成 {event, data}；帧格式固定为 "event: X\ndata: {...}\n\n"。 */
function parseFrames(frames: string[]): Array<{ event: string; data: any }> {
  return frames.map(f => {
    const lines = f.split('\n');
    const event = String(lines[0]).replace(/^event:\s*/, '');
    const dataLine = lines.find(l => l.startsWith('data: ')) ?? 'data: {}';
    return { event, data: JSON.parse(dataLine.slice(6)) };
  });
}

// ─── 1. 请求侧 ───────────────────────────────────────────────────────────────

describe('anthropicToOpenAIRequest（Anthropic → OpenAI，anthropic.go:22）', () => {
  it('system 前置为 system 消息；纯文本 user 归一为字符串 content', () => {
    const out = anthropicToOpenAIRequest({
      model: 'claude-x',
      max_tokens: 128,
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages[0]).toMatchObject({ role: 'system', content: 'You are terse.' });
    expect(out.messages[1]).toMatchObject({ role: 'user', content: 'hi' });
    expect(out.max_tokens).toBe(128);
  });

  it('system 数组形态（[{type:text,text}]）与字符串等价', () => {
    const out = anthropicToOpenAIRequest({
      system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
      messages: [{ role: 'user', content: 'x' }],
    } as AnthropicRequest);
    expect(JSON.stringify(out.messages[0].content)).toContain('A');
    expect(JSON.stringify(out.messages[0].content)).toContain('B');
  });

  it('assistant 的 tool_use → tool_calls（id/name/arguments 为 JSON 字符串）', () => {
    const out = anthropicToOpenAIRequest({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } }],
        },
      ],
    } as AnthropicRequest);
    const asst = out.messages.find(m => m.role === 'assistant')!;
    expect(asst.tool_calls?.[0]).toMatchObject({
      id: 'tu_1',
      type: 'function',
      function: { name: 'read_file' },
    });
    expect(JSON.parse(String(asst.tool_calls?.[0].function.arguments))).toEqual({ path: 'a.txt' });
  });

  it('tool_result → role:tool 且带 tool_call_id', () => {
    const out = anthropicToOpenAIRequest({
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_9', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: 'ok' }] },
      ],
    } as AnthropicRequest);
    const toolMsg = out.messages.find(m => m.role === 'tool')!;
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.tool_call_id).toBe('tu_9');
    expect(String(toolMsg.content)).toContain('ok');
  });

  it('Anthropic tools → OpenAI function 形态（input_schema → parameters）', () => {
    const out = anthropicToOpenAIRequest({
      max_tokens: 16,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }],
    } as AnthropicRequest);
    expect(out.tools?.[0]).toMatchObject({
      type: 'function',
      function: { name: 'f', description: 'd' },
    });
    expect(out.tools?.[0].function?.parameters).toMatchObject({ type: 'object' });
  });

  it('thinking.budget_tokens → reasoning_effort（思考预算映射到档位）', () => {
    const effort = thinkingToReasoningEffort({
      thinking: { type: 'enabled', budget_tokens: 4096 },
    } as AnthropicRequest);
    expect(typeof effort).toBe('string');
    const out = anthropicToOpenAIRequest({
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled', budget_tokens: 4096 },
    } as AnthropicRequest);
    expect(out.reasoning_effort).toBe(effort);
  });

  it('stream 标志透传（供上游按流式请求）', () => {
    const out = anthropicToOpenAIRequest({
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    } as AnthropicRequest);
    expect(out.stream).toBe(true);
  });

  it('image 块 → image_url part（base64 转 data URL）', () => {
    const out = anthropicToOpenAIRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    } as AnthropicRequest);
    const parts = out.messages.find(m => m.role === 'user')!.content;
    expect(Array.isArray(parts)).toBe(true);
    expect(JSON.stringify(parts)).toContain('image_url');
    expect(JSON.stringify(parts)).toContain('data:image/png;base64,AAAA');
  });
});

// ─── 2. 非流式响应侧 ─────────────────────────────────────────────────────────

describe('openAIResponseToAnthropicMessage（非流式出口）', () => {
  it('产出自洽的 Anthropic message 信封（content 数组 + stop_reason + usage）', () => {
    const msg = openAIResponseToAnthropicMessage(
      {
        id: 'up_1',
        model: 'glm-5.2',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      } as OpenAIChunkLike,
      { msgId: 'msg_x', model: 'claude-x' },
    );
    expect(msg).toMatchObject({ type: 'message', role: 'assistant', id: 'msg_x' });
    expect(Array.isArray(msg.content)).toBe(true);
    expect(JSON.stringify(msg.content)).toContain('hi');
    expect((msg.usage as any).input_tokens).toBe(7);
    expect((msg.usage as any).output_tokens).toBe(3);
  });

  it('tool_calls → tool_use 内容块', () => {
    const msg = openAIResponseToAnthropicMessage(
      {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      } as OpenAIChunkLike,
      { msgId: 'msg_y' },
    );
    const blocks = msg.content as any[];
    const toolUse = blocks.find(b => b.type === 'tool_use');
    expect(toolUse).toBeTruthy();
    expect(toolUse.name).toBe('f');
    expect(toolUse.input).toEqual({ a: 1 });
  });
});

// ─── 3. 流式：块生命周期（核心 DoD）──────────────────────────────────────────

describe('AnthropicStreamEncoder：流式块生命周期', () => {
  it('文本流的事件序列完整且有序，delta 可还原全文', () => {
    const enc = new AnthropicStreamEncoder({ msgId: 'msg_test', model: 'claude-x' });
    const frames: string[] = [];
    frames.push(...enc.pushChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] } as OpenAIChunkLike));
    frames.push(...enc.pushChunk({ choices: [{ index: 0, delta: { content: ' world' } }] } as OpenAIChunkLike));
    frames.push(
      ...enc.pushChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      } as OpenAIChunkLike),
    );
    frames.push(...enc.finish());

    const parsed = parseFrames(frames);
    const names = parsed.map(p => p.event);

    // 顺序约束：message_start 起、message_stop 收，且成对出现开闭块
    expect(names[0]).toBe('message_start');
    expect(names[names.length - 1]).toBe('message_stop');
    expect(names.indexOf('message_delta')).toBeGreaterThan(names.lastIndexOf('content_block_stop'));
    expect(names.filter(n => n === 'content_block_start').length).toBe(
      names.filter(n => n === 'content_block_stop').length,
    );

    // 文本增量可还原
    const text = parsed
      .filter(p => p.event === 'content_block_delta' && p.data.delta?.type === 'text_delta')
      .map(p => p.data.delta.text)
      .join('');
    expect(text).toBe('Hello world');

    // 收尾块给出 stop_reason 与 usage
    const md = parsed.find(p => p.event === 'message_delta')!;
    expect(md.data.delta?.stop_reason).toBeTruthy();
    expect(md.data.usage?.output_tokens).toBeGreaterThan(0);
  });

  it('reasoning_content → thinking 块，且与 text 块各自成对开闭、index 互斥', () => {
    const enc = new AnthropicStreamEncoder({ msgId: 'm', model: 'claude-x' });
    const frames: string[] = [];
    frames.push(...enc.pushChunk({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think' } }] } as OpenAIChunkLike));
    frames.push(...enc.pushChunk({ choices: [{ index: 0, delta: { content: 'answer' } }] } as OpenAIChunkLike));
    frames.push(...enc.pushChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as OpenAIChunkLike));
    frames.push(...enc.finish());

    const parsed = parseFrames(frames);
    const starts = parsed.filter(p => p.event === 'content_block_start');
    const types = starts.map(s => s.data.content_block?.type);
    expect(types).toContain('thinking');
    expect(types).toContain('text');

    const indices = starts.map(s => s.data.index);
    expect(new Set(indices).size).toBe(indices.length); // 每个块独立 index

    // thinking 块的增量是 thinking_delta（不是 text_delta）
    expect(
      parsed.some(p => p.event === 'content_block_delta' && p.data.delta?.type === 'thinking_delta'),
    ).toBe(true);
    // 两个块都各自关闭
    expect(parsed.filter(p => p.event === 'content_block_stop').length).toBe(starts.length);
  });

  it('tool_calls 分片 → tool_use 块（index 分配不与既有块冲突）', () => {
    const enc = new AnthropicStreamEncoder({ msgId: 'm', model: 'claude-x' });
    const frames: string[] = [];
    frames.push(...enc.pushChunk({ choices: [{ index: 0, delta: { content: 'prefix' } }] } as OpenAIChunkLike));
    frames.push(
      ...enc.pushChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":' } }],
            },
          },
        ],
      } as OpenAIChunkLike),
    );
    frames.push(
      ...enc.pushChunk({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }],
      } as OpenAIChunkLike),
    );
    frames.push(...enc.pushChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } as OpenAIChunkLike));
    frames.push(...enc.finish());

    const parsed = parseFrames(frames);
    const starts = parsed.filter(p => p.event === 'content_block_start');
    const toolStart = starts.find(s => s.data.content_block?.type === 'tool_use')!;
    expect(toolStart).toBeTruthy();
    expect(toolStart.data.content_block.name).toBe('f');

    // 工具参数的 JSON 分片被拼回完整参数
    const jsonDeltas = parsed
      .filter(p => p.event === 'content_block_delta' && p.data.delta?.type === 'input_json_delta')
      .map(p => p.data.delta.partial_json)
      .join('');
    expect(JSON.parse(jsonDeltas)).toEqual({ a: 1 });

    // 文本块先关、工具块后开 → index 不冲突
    expect(new Set(starts.map(s => s.data.index)).size).toBe(starts.length);
  });

  it('空流也能给出合法的开始/结束序列（不产出半个块）', () => {
    const enc = new AnthropicStreamEncoder({ msgId: 'm' });
    const frames = [...enc.finish()];
    const names = parseFrames(frames).map(p => p.event);
    expect(names[0]).toBe('message_start');
    expect(names[names.length - 1]).toBe('message_stop');
    expect(names.filter(n => n === 'content_block_stop').length).toBe(
      names.filter(n => n === 'content_block_start').length,
    );
  });
});

// ─── 4. 辅助函数 ─────────────────────────────────────────────────────────────

describe('辅助函数', () => {
  it('mapFinishReason：stop→end_turn / length→max_tokens / tool_calls→tool_use', () => {
    expect(mapFinishReason('stop')).toBe('end_turn');
    expect(mapFinishReason('length')).toBe('max_tokens');
    expect(mapFinishReason('tool_calls')).toBe('tool_use');
    expect(mapFinishReason(null)).toBeTruthy(); // 兜底值存在
  });

  it('sanitizeToolId：去掉 Anthropic 工具 id 不允许的字符', () => {
    const out = sanitizeToolId('a b/c#d');
    expect(out).not.toContain(' ');
    expect(out).not.toContain('/');
    expect(out).not.toContain('#');
  });

  it('sseFrame：输出 Anthropic SSE 帧格式（event + data + 空行收尾）', () => {
    const frame = sseFrame('ping', { a: 1 });
    expect(frame).toMatch(/^event: ping\ndata: .*\n\n$/);
    const parsed = parseFrames([frame]);
    expect(parsed[0].event).toBe('ping');
    expect(parsed[0].data).toEqual({ a: 1 });
  });
});
