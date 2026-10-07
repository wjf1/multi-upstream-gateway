// =============================================================================
// 通用 Anthropic /v1/messages 桥（T202b，master-plan v1.2 §5 T202 / §4 core/）
// -----------------------------------------------------------------------------
// 定位：Provider 层与「Anthropic Messages 协议」之间的**纯函数**转换层——
//   Anthropic 请求 → 内部 OpenAI 形态 →（Provider 上游）
//   （Provider 上游）OpenAI 响应/流 → Anthropic 消息 / SSE 事件序列
// 本模块零 IO、零依赖（只用 node:crypto 生成兜底 id）、零全局状态，供 T202b
// （Freebuff）与 T308（WorkBuddy）共用。
//
// 契约来源（Go 原版 Quorinex/Freebuff2API@a1c1035 anthropic.go，注释标注 源文件:行号）：
//   - anthropic.go:22   convertClaudeMessagesRequestToOpenAI（请求翻译）
//   - anthropic.go:508  mapClaudeThinkingToReasoningEffort / :540 budgetToReasoningEffort
//   - anthropic.go:765  convertOpenAINonStreamResponseToClaude（非流式响应）
//   - anthropic.go:828  claudeStreamState（流式状态机）
//   - anthropic.go:858  convertOpenAIStreamPayloadToClaudeEvents（单 chunk → 事件）
//   - anthropic.go:1033 finalizeClaudeStream（收尾）
//   - anthropic.go:1043 appendClaudeFinalContentEvents（块关闭）
//   - anthropic.go:1094 appendClaudeMessageDeltaAndStop
//   - anthropic.go:1146 nextClaudeBlockIndex / :1156 toolCallBlockIndex
//   - anthropic.go:1166 stopThinkingContentBlock / :1181 stopTextContentBlock
//   - anthropic.go:1322 extractOpenAIUsage / :1345 mapOpenAIFinishReasonToClaude
//   - anthropic.go:594  sanitizeClaudeToolID
//
// 与 commandcode 既有实现的关系（T202b「复用评估」结论，详见报告）：
//   底座 v5.0.0 的响应侧 Anthropic 编码共两处，都**不可直接复用**：
//     ① `adapters/commandcode/anthropic-response.ts` —— 输入是 CC 私有事件
//        （CCEvent：text-delta / reasoning-delta / tool-call / finish），不是
//        OpenAI 上游 chunk；且只有非流式。
//     ② `routes/messages.ts` 内的流式编码器 —— 未抽模块、与 CC 上游流式管线耦合，
//        且块索引采用的是「文本固定 0 / thinking 固定 1 / tool 从 2 起」的**固定槽位**
//        方案，不是 Anthropic 规范的顺序分配。
//   因此本桥**新写**（语义对齐 Go 原版 anthropic.go），不改造 commandcode 调用路径：
//   后者的 672 用例与 SSE 快照保持逐字节不变（硬约束），零回归风险。
//
// 有意的取舍（与 Go 的差异，均为本仓库既有生产约定，非缺陷）：
//   - thinking 块关闭前补一个空 `signature_delta`（Go :1166 直接 stop）：
//     严格的 Anthropic 客户端会在块关闭前校验 signature，与
//     routes/messages.ts 的既有行为一致。
//   - tool_use 的 `input_json_delta` **随分片增量下发**（Go 在收尾一次性下发）：
//     两者拼接结果相同，增量对 agent 更友好；与 routes/messages.ts 一致。
//   - `ping` 心跳属传输层保活，由路由负责，本桥不产出。
// =============================================================================

import crypto from 'node:crypto';
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicToolResultBlock,
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAITool,
} from '../../types/index.js';

// ─── 内部 OpenAI 形态（只描述本桥消费/产出的最小结构）────────────────────────

/** OpenAI 上游 usage（anthropic.go:754 openAIUsage）。 */
export interface OpenAIUsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** OpenAI 流式工具调用分片（anthropic.go:742 openAIStreamToolCall）。 */
export interface OpenAIToolCallDeltaLike {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** OpenAI 单个 choice（delta 为流式、message 为非流式）。 */
export interface OpenAIChoiceLike {
  index?: number;
  delta?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAIToolCallDeltaLike[];
  };
  message?: {
    role?: string;
    content?: unknown;
    reasoning_content?: unknown;
    tool_calls?: OpenAIToolCallDeltaLike[];
  };
  finish_reason?: string | null;
}

/** OpenAI 上游 chunk / 非流式响应体（anthropic.go:708 openAIChatCompletion）。 */
export interface OpenAIChunkLike {
  id?: string;
  model?: string;
  choices?: OpenAIChoiceLike[];
  usage?: OpenAIUsageLike | null;
}

/** 桥的输出选项。 */
export interface BridgeOptions {
  /** 希望使用的消息 id（缺省则采用上游 id，再兜底生成）。 */
  msgId?: string;
  /** 缺省模型名（上游未回 model 时使用）。 */
  model?: string;
  /** 上游 usage 缺失时的本地输入估算（保证 message_delta 不为 0）。 */
  inputTokens?: number;
}

// ─── 请求侧：Anthropic Messages → OpenAI Chat Completions（anthropic.go:22）───

/** 工具定义：Anthropic（name/description/input_schema）→ OpenAI function 形态。 */
function convertTool(tool: AnthropicRequest['tools'] extends (infer T)[] | undefined ? T : never): OpenAITool | undefined {
  if (!tool || typeof tool.name !== 'string' || tool.name.trim() === '') return undefined;
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  };
}

/** tool_choice：Anthropic（auto/any/tool/none）→ OpenAI（anthropic.go:192）。 */
function convertToolChoice(
  tc: AnthropicRequest['tool_choice'],
): OpenAIChatRequest['tool_choice'] | undefined {
  if (!tc) return undefined;
  switch (tc.type) {
    case 'none':
      return 'none';
    case 'any':
      return 'required'; // anthropic.go:192 any → required
    case 'tool':
      return tc.name ? { type: 'function', function: { name: tc.name } } : undefined;
    case 'auto':
    default:
      return 'auto';
  }
}

/** 图片块 → data URL（anthropic.go:406 convertClaudeImagePartToOpenAI）。 */
function imageBlockToDataUrl(block: AnthropicImageBlock): string {
  if (block.source.type === 'url') return block.source.url;
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

/** tool_result 内容 → OpenAI tool 消息 content（anthropic.go:440）。 */
function toolResultContent(
  block: AnthropicToolResultBlock,
): string | Array<Record<string, unknown>> {
  const prefix = block.is_error ? '[ERROR] ' : '';
  if (typeof block.content === 'string') return prefix + block.content;
  if (!Array.isArray(block.content)) return prefix;
  const parts: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  for (const part of block.content) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'image') parts.push({ type: 'image_url', image_url: { url: imageBlockToDataUrl(part) } });
  }
  if (parts.length === 0) return prefix + texts.join('\n');
  // 有图时把文本并进第一条 text part，保持 OpenAI 多模态 part 形态。
  if (texts.length) parts.unshift({ type: 'text', text: prefix + texts.join('\n') });
  return parts;
}

/** 消息内容（字符串或多个文本块）拼接为纯文本。 */
function messageText(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** thinking 配置 → reasoning_effort（anthropic.go:508/:540）。 */
export function thinkingToReasoningEffort(req: AnthropicRequest): string | undefined {
  const thinking = req.thinking;
  if (!thinking) return undefined;
  if (thinking.type === 'disabled') return 'none';
  // type === 'enabled'
  const budget = thinking.budget_tokens;
  if (budget === undefined) return 'auto';
  if (budget <= 0) return 'none';
  if (budget <= 512) return 'minimal';
  if (budget <= 1024) return 'low';
  if (budget <= 8192) return 'medium';
  if (budget <= 24576) return 'high';
  return 'xhigh';
}

/**
 * Anthropic Messages 请求 → 内部 OpenAI Chat Completions 形态（anthropic.go:22）。
 *
 * 关键映射：
 *  - system（字符串或文本块数组）→ 首条 system 消息；
 *  - user 的 tool_result 块 → role=tool 消息（携带 tool_call_id）；
 *  - user 文本/图片块 → 单条 user 消息（图片转 image_url data URL）；
 *  - assistant 的 text/thinking/tool_use 块 → 一条 assistant 消息
 *    （content / reasoning_content / tool_calls）；
 *  - tools / tool_choice / stop_sequences / max_tokens / temperature / top_p 直译。
 * 不发起任何 IO，也不读取 Provider 配置。
 */
export function anthropicToOpenAIRequest(req: AnthropicRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  // anthropic.go:228 convertClaudeSystemToOpenAIMessage —— system 归一为一条消息。
  const systemText = typeof req.system === 'string'
    ? req.system
    : Array.isArray(req.system)
      ? req.system.map((b) => b.text).join('\n\n')
      : '';
  if (systemText) messages.push({ role: 'system', content: systemText });

  for (const message of req.messages ?? []) {
    const blocks: AnthropicContentBlock[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content ?? [];

    if (message.role === 'user') {
      // tool_result 先成独立 tool 消息（Anthropic 允许与文本块混在同一 user 回合），
      // 其余内容合成一条 user 消息（anthropic.go:269 convertClaudeMessageContent）。
      const regularParts: OpenAIContentPart[] = [];
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultContent(block) as OpenAIMessage['content'],
          });
        } else if (block.type === 'text') {
          regularParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          regularParts.push({ type: 'image_url', image_url: { url: imageBlockToDataUrl(block) } });
        }
      }
      if (regularParts.length > 0) {
        // 纯文本单块归一为字符串（anthropic.go:557 normalizeOpenAIContent）。
        messages.push({
          role: 'user',
          content:
            regularParts.length === 1 && regularParts[0].type === 'text'
              ? (regularParts[0].text as string)
              : regularParts,
        });
      }
    } else {
      // assistant：文本 + thinking + tool_use 合成一条消息。
      let text = '';
      let reasoning = '';
      const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = [];
      for (const block of blocks) {
        if (block.type === 'text') text += (text ? '\n' : '') + block.text;
        else if (block.type === 'thinking') reasoning += (reasoning ? '\n' : '') + block.thinking;
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      if (!text && !reasoning && toolCalls.length === 0) continue;
      const msg: OpenAIMessage = { role: 'assistant', content: text || '' };
      if (reasoning) msg.reasoning_content = reasoning;
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }

  const tools = (req.tools ?? [])
    .map(convertTool)
    .filter((t): t is OpenAITool => t !== undefined);

  const openai: OpenAIChatRequest = {
    model: req.model,
    messages,
    ...(req.max_tokens != null ? { max_tokens: req.max_tokens } : {}),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.top_p != null ? { top_p: req.top_p } : {}),
    ...(req.stop_sequences?.length ? { stop: req.stop_sequences } : {}),
    stream: req.stream,
    ...(tools.length > 0 ? { tools } : {}),
    ...(req.thinking?.type === 'enabled' ? { thinking: { type: 'enabled', budget_tokens: req.thinking.budget_tokens } } : {}),
  };

  const toolChoice = convertToolChoice(req.tool_choice);
  if (toolChoice !== undefined) openai.tool_choice = toolChoice;
  const effort = thinkingToReasoningEffort(req);
  if (effort !== undefined) openai.reasoning_effort = effort;

  return openai;
}

// ─── 响应侧公共工具 ──────────────────────────────────────────────────────────

/** OpenAI finish_reason → Anthropic stop_reason（anthropic.go:1345）。 */
export function mapFinishReason(reason: string | null | undefined): string {
  switch (String(reason ?? '').toLowerCase().trim()) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

/** 工具 id 清洗：Anthropic 要求 `[a-zA-Z0-9_-]+`（anthropic.go:594 sanitizeClaudeToolID）。 */
export function sanitizeToolId(id: string | undefined): string {
  const raw = String(id ?? '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** OpenAI usage → Anthropic 用量片段（anthropic.go:1322 extractOpenAIUsage）。 */
function usageToAnthropic(
  usage: OpenAIUsageLike | null | undefined,
  fallbackInput: number,
): { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } {
  if (!usage) {
    return { input_tokens: Math.max(0, fallbackInput), output_tokens: 0 };
  }
  const cached = num(usage.prompt_tokens_details?.cached_tokens) ?? 0;
  const prompt = num(usage.prompt_tokens);
  const out: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } = {
    input_tokens: Math.max(0, (prompt ?? fallbackInput) - cached),
    output_tokens: num(usage.completion_tokens) ?? 0,
  };
  if (cached > 0) out.cache_read_input_tokens = cached;
  return out;
}

/** 从 content / reasoning_content 里收集文本（兼容字符串与文本块数组）。 */
function collectText(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const part of value) {
    if (part && typeof part === 'object' && (part as any).type === 'text' && typeof (part as any).text === 'string') {
      out.push((part as any).text);
    }
  }
  return out;
}

/** 非流式 content（字符串/数组）→ Anthropic text 块。 */
function contentToTextBlocks(value: unknown): AnthropicContentBlock[] {
  const texts = collectText(value);
  if (texts.length === 0) return [];
  return [{ type: 'text', text: texts.join('') }];
}

/** 解析工具 arguments（可能是 JSON 字符串或对象；anthropic.go:1305 parseJSONObject）。 */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw: trimmed };
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ─── 响应侧：非流式（anthropic.go:765）────────────────────────────────────────

/**
 * OpenAI 非流式响应体 → 完整 Anthropic 消息。
 * 内容顺序：thinking 块（reasoning_content）→ text 块 → tool_use 块，
 * 与 anthropic.go:786-805 一致。
 */
export function openAIResponseToAnthropicMessage(
  body: OpenAIChunkLike | null | undefined,
  opts: BridgeOptions = {},
): Record<string, unknown> {
  const choice = body?.choices?.[0];
  const content: AnthropicContentBlock[] = [];

  if (choice) {
    for (const text of collectText(choice.message?.reasoning_content)) {
      // 与仓库既有非流式实现同口径：补空 signature（anthropic-response.ts:92）。
      content.push({ type: 'thinking', thinking: text, signature: '' } as AnthropicContentBlock);
    }
    content.push(...contentToTextBlocks(choice.message?.content));
    for (const toolCall of choice.message?.tool_calls ?? []) {
      content.push({
        type: 'tool_use',
        id: sanitizeToolId(toolCall.id),
        name: toolCall.function?.name ?? 'tool',
        input: parseArguments(toolCall.function?.arguments),
      });
    }
  }

  const hasToolUse = content.some((b) => b.type === 'tool_use');
  let stopReason = hasToolUse ? 'tool_use' : mapFinishReason(choice?.finish_reason);
  if (stopReason === 'end_turn' && hasToolUse) stopReason = 'tool_use';

  const usage = usageToAnthropic(body?.usage, opts.inputTokens ?? 0);

  return {
    id: opts.msgId || body?.id || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    model: body?.model || opts.model || '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// ─── 响应侧：流式状态机（anthropic.go:828）────────────────────────────────────

/** SSE 帧编码（anthropic.go:1196 writeClaudeSSEEvents 的等价物）。 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface ToolBlockState {
  /** Anthropic 内容块索引（懒分配，anthropic.go:1156）。 */
  blockIndex: number;
  id: string;
  name: string;
  started: boolean;
}

/**
 * 把 OpenAI 兼容上游的流式 chunk 逐一编码为 Anthropic SSE 事件。
 *
 * 块生命周期（与 anthropic.go:858 对齐）：
 *   message_start（首个有效 chunk 时懒发，:879）
 *   → content_block_start/delta（thinking → text → 各 tool_use，按需开放）
 *   → content_block_stop（切换块或收尾时关闭）
 *   → message_delta（stop_reason + usage）→ message_stop
 *
 * 索引分配：单一递增计数器（anthropic.go:1146 nextClaudeBlockIndex），
 * 按块**实际出现顺序**编号，不做固定槽位；tool 块按上游 tool index 复用同一块
 * （anthropic.go:1156 toolCallBlockIndex），分片只追加 input_json_delta。
 */
export class AnthropicStreamEncoder {
  private readonly opts: BridgeOptions;
  private messageId: string;
  private model: string;
  private messageStarted = false;
  private thinkingStarted = false;
  private thinkingIndex = -1;
  private textStarted = false;
  private textIndex = -1;
  private nextBlockIndex = 0;
  private finishReason = '';
  private sawToolCall = false;
  private contentBlocksStopped = false;
  private terminated = false;
  private readonly toolBlocks = new Map<number, ToolBlockState>();

  constructor(opts: BridgeOptions = {}) {
    this.opts = opts;
    this.messageId = opts.msgId ?? '';
    this.model = opts.model ?? '';
  }

  /** 已确定的消息 id（供路由写日志/用量）。 */
  get id(): string {
    if (!this.messageId) {
      this.messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    }
    return this.messageId;
  }

  /** 消费一个 OpenAI chunk，返回本次要写出的 SSE 帧。 */
  pushChunk(chunk: OpenAIChunkLike): string[] {
    if (this.terminated) return [];
    const out: string[] = [];

    if (!this.messageId && chunk.id) this.messageId = chunk.id;
    if (chunk.model && chunk.model.trim()) this.model = chunk.model;

    const choice = chunk.choices?.[0];
    if (!choice) {
      // 无 choices 的收尾 chunk（部分上游把 usage 单独放在最后一帧）。
      if (chunk.usage && this.finishReason) {
        out.push(...this.emitDeltaAndStop(chunk.usage));
      }
      return out;
    }

    this.emitMessageStart(out);

    for (const text of collectText(choice.delta?.reasoning_content)) {
      this.stopTextBlock(out);
      this.openThinkingBlock(out);
      out.push(sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: this.thinkingIndex,
        delta: { type: 'thinking_delta', thinking: text },
      }));
    }

    const deltaContent = choice.delta?.content;
    if (typeof deltaContent === 'string' && deltaContent !== '') {
      this.stopThinkingBlock(out);
      this.openTextBlock(out);
      out.push(sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: this.textIndex,
        delta: { type: 'text_delta', text: deltaContent },
      }));
    }

    for (const toolCall of choice.delta?.tool_calls ?? []) {
      this.sawToolCall = true;
      this.stopThinkingBlock(out);
      this.stopTextBlock(out);
      const block = this.toolBlock(toolCall, out);
      // 参数分片增量下发（与 routes/messages.ts 一致；Go 为收尾一次性下发）。
      const args = toolCall.function?.arguments;
      if (typeof args === 'string' && args !== '') {
        out.push(sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index: block.blockIndex,
          delta: { type: 'input_json_delta', partial_json: args },
        }));
      }
    }

    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason;
      this.stopAllContentBlocks(out);
    }
    if (this.finishReason && chunk.usage) {
      out.push(...this.emitDeltaAndStop(chunk.usage));
    }

    return out;
  }

  /**
   * 上游流自然结束（含 `[DONE]` 或连接关闭）：补齐未闭合的块并收尾。
   * 幂等——重复调用不会重复产出 message_delta/message_stop。
   */
  finish(): string[] {
    if (this.terminated) return [];
    const out: string[] = [];
    this.emitMessageStart(out); // 空流也要是合法序列
    this.stopAllContentBlocks(out);
    out.push(...this.emitDeltaAndStop(undefined));
    return out;
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private emitMessageStart(out: string[]): void {
    if (this.messageStarted) return;
    this.messageStarted = true;
    out.push(sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        // 输入侧用量以真实值在 message_delta 覆盖；这里给本地估算占位。
        usage: { input_tokens: Math.max(0, this.opts.inputTokens ?? 0), output_tokens: 0 },
      },
    }));
  }

  private openThinkingBlock(out: string[]): void {
    if (this.thinkingStarted) return;
    this.thinkingStarted = true;
    this.thinkingIndex = this.nextBlockIndex++;
    out.push(sseFrame('content_block_start', {
      type: 'content_block_start',
      index: this.thinkingIndex,
      content_block: { type: 'thinking', thinking: '' },
    }));
  }

  private stopThinkingBlock(out: string[]): void {
    if (!this.thinkingStarted) return;
    this.thinkingStarted = false;
    // 严格客户端在块关闭前校验 signature（routes/messages.ts 同口径）。
    out.push(sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: this.thinkingIndex,
      delta: { type: 'signature_delta', signature: '' },
    }));
    out.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: this.thinkingIndex }));
    this.thinkingIndex = -1;
  }

  private openTextBlock(out: string[]): void {
    if (this.textStarted) return;
    this.textStarted = true;
    this.textIndex = this.nextBlockIndex++;
    out.push(sseFrame('content_block_start', {
      type: 'content_block_start',
      index: this.textIndex,
      content_block: { type: 'text', text: '' },
    }));
  }

  private stopTextBlock(out: string[]): void {
    if (!this.textStarted) return;
    this.textStarted = false;
    out.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: this.textIndex }));
    this.textIndex = -1;
  }

  private toolBlock(toolCall: OpenAIToolCallDeltaLike, out: string[]): ToolBlockState {
    const key = num(toolCall.index) ?? 0;
    let block = this.toolBlocks.get(key);
    if (!block) {
      block = { blockIndex: this.nextBlockIndex++, id: '', name: '', started: false };
      this.toolBlocks.set(key, block);
    }
    if (toolCall.id?.trim()) block.id = toolCall.id;
    if (toolCall.function?.name?.trim()) block.name = toolCall.function.name;
    // 名称已知即开放块（anthropic.go:992）；input 由后续分片填充。
    if (!block.started && block.name) {
      block.started = true;
      out.push(sseFrame('content_block_start', {
        type: 'content_block_start',
        index: block.blockIndex,
        content_block: { type: 'tool_use', id: sanitizeToolId(block.id), name: block.name, input: {} },
      }));
    }
    return block;
  }

  private stopAllContentBlocks(out: string[]): void {
    if (this.contentBlocksStopped) return;
    this.contentBlocksStopped = true;
    this.stopThinkingBlock(out);
    this.stopTextBlock(out);
    // 收尾统一关闭工具块（anthropic.go:1043 appendClaudeFinalContentEvents）。
    for (const key of [...this.toolBlocks.keys()].sort((a, b) => a - b)) {
      const block = this.toolBlocks.get(key)!;
      if (!block.started) continue;
      block.started = false;
      out.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: block.blockIndex }));
    }
  }

  private emitDeltaAndStop(usage: OpenAIUsageLike | null | undefined): string[] {
    if (this.terminated) return [];
    const out: string[] = [];
    const stopReason = this.sawToolCall
      ? 'tool_use'
      : this.finishReason
        ? mapFinishReason(this.finishReason)
        : 'end_turn';
    const usagePayload = usageToAnthropic(usage, this.opts.inputTokens ?? 0);
    out.push(sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: usagePayload,
    }));
    out.push(sseFrame('message_stop', { type: 'message_stop' }));
    this.terminated = true;
    return out;
  }
}
