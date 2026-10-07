// =============================================================================
// Provider 数据面分发（T213 阶段 2）—— chat / messages 双出口共用
// -----------------------------------------------------------------------------
// 路由层经 RequestRouter 决策出非 commandcode 的 Provider 时，由此模块把
// IProvider.chatCompletion 的文本增量流渲染成对应出口协议：
//   - 'chat'     → OpenAI chat.completion.chunk SSE（或非流式 chat.completion）
//   - 'messages' → Anthropic 事件序列（复用 core/anthropic-bridge 的
//     AnthropicStreamEncoder：message_start → content_block_* → message_delta →
//     message_stop 的块生命周期由它保证）
//
// 边界（刻意保持最小）：
//   - 文本增量契约：tool-call 等结构化增量由 Provider 内部聚合后以文本表达
//     （§3.1），本模块不做工具调用分片重组；
//   - 用量：文本增量流拿不到上游事件，按本地估算落库（与 CommandCode 路径
//     「上游未回 usage 时回落估算」同一哲学），`finalize` 只保证一次请求一条；
//   - 客户端中止：与 chat.ts 既有语义一致——直接收尾，不落用量、不重试。
// =============================================================================
import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { OpenAIChatRequest } from '../types/index.js';
import { estimateTextTokens, isAbortError } from '../adapters/commandcode/upstream.js';
import { writeSSEHeaders } from './sse-common.js';
import { ErrorCode, ProxyError, toProxyError } from '../utils/errors.js';
import { AnthropicStreamEncoder, sseFrame } from '../providers/core/anthropic-bridge.js';
import type { ProviderRuntime } from '../providers/runtime.js';
import type { RouteDecision } from '../providers/core/router.js';
import { logger } from '../utils/logger.js';

/** 空闲防断注释行（与 chat.ts 同频：15s 一条 `:`，防 CDN/代理掐空闲连接）。 */
const PING_INTERVAL_MS = 15_000;

export interface ProviderFinalizeInfo {
  status: 'COMPLETED' | 'FAILED';
  errorCode?: string;
  traceId?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderDispatchArgs {
  runtime: ProviderRuntime;
  decision: RouteDecision;
  /** 已把 model 规范化为 decision.model 的 OpenAI 形态请求（messages 模式为桥转换产物）。 */
  openaiReq: OpenAIChatRequest;
  requestId: string;
  abortSignal: AbortSignal;
  reply: FastifyReply;
  /** 出口协议：'chat' = OpenAI chunk 流；'messages' = Anthropic SSE。 */
  mode: 'chat' | 'messages';
  startTime: number;
  /** 路由侧回调：审计 + 用量落库（本模块保证每个请求至多调用一次；客户端中止不调用）。 */
  finalize: (info: ProviderFinalizeInfo) => void;
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function errorOf(err: unknown): ProxyError {
  if (err instanceof ProxyError) return err;
  return toProxyError(err, ErrorCode.PROVIDER_PROTOCOL_ERROR);
}

export async function respondViaProvider(args: ProviderDispatchArgs): Promise<unknown> {
  const { runtime, decision, openaiReq, requestId, abortSignal, reply, mode, startTime, finalize } = args;
  const provider = runtime.get(decision.provider);
  const stream = openaiReq.stream === true;
  const modelName = decision.model;

  // 本地估算口径：文本增量流没有上游 usage 事件（与 CommandCode 路径「未回 usage
  // 时回落估算」一致）。输入按序列化消息长度估，输出按分片累计。
  const inputTokens = Math.max(1, estimateTextTokens(JSON.stringify(openaiReq.messages ?? '')));
  let outputTokens = 0;
  let settled = false;
  const finish = (status: 'COMPLETED' | 'FAILED', errorCode?: string, traceId?: string): void => {
    if (settled) return;
    settled = true;
    finalize({ status, errorCode, traceId, inputTokens, outputTokens });
  };
  /** 客户端中止：与既有路由同语义——直接收尾，不落用量。 */
  const abandon = (): void => {
    settled = true;
  };

  if (!provider) {
    const err = new ProxyError(
      ErrorCode.NO_PROVIDER_AVAILABLE,
      `Provider "${decision.provider}" was routed but is not available in the runtime.`,
      { context: { requestId } },
    );
    finish('FAILED', err.code);
    return sendErrorEnvelope(reply, mode, err, stream, false);
  }

  // ── 出口协议渲染器（惰性初始化：首字节前不写任何头）────────────────────────
  let ping: NodeJS.Timeout | null = null;
  const armPing = (): void => {
    ping = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(':\n\n');
    }, PING_INTERVAL_MS);
  };
  const disarmPing = (): void => {
    if (ping) clearInterval(ping);
    ping = null;
  };

  if (mode === 'chat') {
    const chunkId = `chatcmpl-${randomUUID().slice(0, 8)}`;
    const created = Math.floor(startTime / 1000);
    const base = { id: chunkId, object: 'chat.completion.chunk', created, model: modelName };
    let began = false;
    const begin = (): void => {
      if (began) return;
      began = true;
      writeSSEHeaders(reply);
      armPing();
      reply.raw.write(sseData({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
    };

    // 非流式：聚合文本增量 → 单个 chat.completion 响应体。
    if (!stream) {
      let fullText = '';
      try {
        for await (const delta of provider.chatCompletion(openaiReq, { requestId, abortSignal })) {
          if (abortSignal.aborted) {
            abandon();
            return reply.status(499).send({ error: 'client aborted' });
          }
          outputTokens += estimateTextTokens(delta);
          fullText += delta;
        }
        finish('COMPLETED', undefined, chunkId);
        return reply.status(200).send({
          id: chunkId,
          object: 'chat.completion',
          created,
          model: modelName,
          choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        });
      } catch (err) {
        const proxyErr = errorOf(err);
        if (isAbortError(err) || (err as { isAbort?: boolean })?.isAbort) {
          abandon();
          return reply.status(499).send({ error: 'client aborted' });
        }
        logger.error(`[DISPATCH] ${decision.provider} chat error | Model ${modelName} | ${proxyErr.code}: ${proxyErr.message}`);
        finish('FAILED', proxyErr.code);
        return reply.status(proxyErr.status).send({ error: proxyErr.openAIPayload() });
      }
    }

    // 流式：OpenAI chunk 序列（role 起始 → 内容增量 → finish [+usage]）。
    try {
      for await (const delta of provider.chatCompletion(openaiReq, { requestId, abortSignal })) {
        if (abortSignal.aborted) {
          disarmPing();
          abandon();
          if (!reply.raw.writableEnded) reply.raw.end();
          return reply;
        }
        outputTokens += estimateTextTokens(delta);
        begin();
        reply.raw.write(sseData({ ...base, choices: [{ index: 0, delta: { content: delta } }] }));
      }
      if (began) {
        reply.raw.write(sseData({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        if (openaiReq.stream_options?.include_usage === true) {
          reply.raw.write(
            sseData({
              ...base,
              choices: [],
              usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
            }),
          );
        }
      }
      disarmPing();
      if (!reply.raw.writableEnded) reply.raw.end();
      if (!began) {
        // 零增量完成：视为空内容成功（非流式路径同样允许空文本）。
        finish('COMPLETED');
        return sendEmptyChatCompletion(reply, modelName, inputTokens, outputTokens);
      }
      finish('COMPLETED', undefined, chunkId);
      return reply;
    } catch (err) {
      disarmPing();
      const proxyErr = errorOf(err);
      if (isAbortError(err) || (err as { isAbort?: boolean })?.isAbort) {
        abandon();
        if (!reply.raw.writableEnded) reply.raw.end();
        return reply;
      }
      logger.error(`[DISPATCH] ${decision.provider} chat stream error | Model ${modelName} | ${proxyErr.code}: ${proxyErr.message}`);
      if (!began) {
        finish('FAILED', proxyErr.code);
        return sendErrorEnvelope(reply, mode, proxyErr, false, true);
      }
      finish('FAILED', proxyErr.code, chunkId);
      // 流已开始：把稳定错误码并入内容流（与 chat.ts 同语义，HTTP 状态已不可改）。
      reply.raw.write(sseData({ ...base, choices: [{ index: 0, delta: {} }], error: { message: `${proxyErr.code}: ${proxyErr.message}` } }));
      reply.raw.write(sseData({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      if (!reply.raw.writableEnded) reply.raw.end();
      return reply;
    }
  }

  // ── messages 出口（Anthropic 事件序列，块生命周期由桥编码器保证）───────────
  // 非流式：聚合文本增量 → 单个 Anthropic message 响应体。
  if (!stream) {
    let fullText = '';
    try {
      for await (const delta of provider.chatCompletion(openaiReq, { requestId, abortSignal })) {
        if (abortSignal.aborted) {
          abandon();
          return reply.status(499).send({ type: 'error', error: { type: 'api_error', message: 'client aborted' } });
        }
        outputTokens += estimateTextTokens(delta);
        fullText += delta;
      }
      finish('COMPLETED');
      return reply.status(200).send({
        id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'message',
        role: 'assistant',
        model: modelName,
        content: [{ type: 'text', text: fullText }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
    } catch (err) {
      const proxyErr = errorOf(err);
      if (isAbortError(err) || (err as { isAbort?: boolean })?.isAbort) {
        abandon();
        return reply.status(499).send({ type: 'error', error: { type: 'api_error', message: 'client aborted' } });
      }
      logger.error(`[DISPATCH] ${decision.provider} messages error | Model ${modelName} | ${proxyErr.code}: ${proxyErr.message}`);
      finish('FAILED', proxyErr.code);
      return reply.status(proxyErr.status).send(proxyErr.anthropicPayload());
    }
  }

  const encoder = new AnthropicStreamEncoder({ model: modelName });
  let began = false;
  const begin = (): void => {
    if (began) return;
    began = true;
    writeSSEHeaders(reply);
    armPing();
  };
  try {
    for await (const delta of provider.chatCompletion(openaiReq, { requestId, abortSignal })) {
      if (abortSignal.aborted) {
        disarmPing();
        abandon();
        if (!reply.raw.writableEnded) reply.raw.end();
        return reply;
      }
      outputTokens += estimateTextTokens(delta);
      begin();
      for (const frame of encoder.pushChunk({ id: encoder.id, choices: [{ index: 0, delta: { content: delta } }] })) {
        reply.raw.write(frame);
      }
    }
    disarmPing();
    if (!began) {
      // 零增量完成：仍要产出合法的空 Anthropic 消息（encoder.finish 兜底全序列）。
      begin();
    }
    for (const frame of encoder.pushChunk({
      id: encoder.id,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    })) {
      reply.raw.write(frame);
    }
    for (const frame of encoder.finish()) reply.raw.write(frame);
    if (!reply.raw.writableEnded) reply.raw.end();
    finish('COMPLETED', undefined, encoder.id);
    return reply;
  } catch (err) {
    disarmPing();
    const proxyErr = errorOf(err);
    if (isAbortError(err) || (err as { isAbort?: boolean })?.isAbort) {
      abandon();
      if (!reply.raw.writableEnded) reply.raw.end();
      return reply;
    }
    logger.error(`[DISPATCH] ${decision.provider} messages stream error | Model ${modelName} | ${proxyErr.code}: ${proxyErr.message}`);
    if (!began) {
      finish('FAILED', proxyErr.code);
      return sendErrorEnvelope(reply, mode, proxyErr, false, true);
    }
    finish('FAILED', proxyErr.code, encoder.id);
    reply.raw.write(sseFrame('error', { type: 'error', error: { type: 'api_error', message: `${proxyErr.code}: ${proxyErr.message}` } }));
    if (!reply.raw.writableEnded) reply.raw.end();
    return reply;
  }
}

// ─── 错误 / 空响应信封（按出口协议选形态，语义对齐 chat.ts / messages.ts）─────

function sendErrorEnvelope(
  reply: FastifyReply,
  mode: 'chat' | 'messages',
  err: ProxyError,
  streamRequested: boolean,
  _headersSent: boolean,
): unknown {
  if (streamRequested) {
    // 流式请求但尚未产出任何字节：与 chat.ts 相同——流已无法改 HTTP 状态码时
    // 才并入内容；这里还没写头，直接回 HTTP 状态码更利于客户端自愈。
    return reply.status(err.status).send(
      mode === 'messages' ? err.anthropicPayload() : { error: err.openAIPayload() },
    );
  }
  return reply.status(err.status).send(
    mode === 'messages' ? err.anthropicPayload() : { error: err.openAIPayload() },
  );
}

function sendEmptyChatCompletion(
  reply: FastifyReply,
  model: string,
  inputTokens: number,
  outputTokens: number,
): unknown {
  return reply.status(200).send({
    id: `chatcmpl-${randomUUID().slice(0, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  });
}
