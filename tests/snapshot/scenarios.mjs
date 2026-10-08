// =============================================================================
// 场景单源(T107)—— 录制与内置渲染共用
// -----------------------------------------------------------------------------
// 为什么是 .mjs:本文件被 vitest 用例(tests/snapshot/helpers.ts、snapshot.test.ts、
//   tests/freebuff-snapshot.test.ts)与采集脚本(scripts/collect-fixtures.mjs)
//   同时 import,后者是纯 Node ESM 脚本,不走 tsc —— 用 .mjs 让两边共用同一份单源。
//
// ⚠️ 本文件**必须入库**:仓库 .gitignore 有一条全局 `*.mjs` 规则(为挡掉本机临时
//   脚本),它曾把本文件静默吞掉 —— 结果全新克隆上 `npm run typecheck` 报
//   TS2307 三条、`npm run verify` 因快照基建 import 失败而红,而开发机上(文件
//   只在磁盘、未跟踪)一切正常。故 .gitignore 的例外清单里必须有本文件;
//   新增任何被测试/脚本引用的 .mjs 后,都要 `git check-ignore -v <file>` 复核。
//
// 契约:
//   - sentinelFor(name)          → 请求体里的哨兵串;mock 上游据此选场景。
//   - scenarioNameFromBody(body) → 从请求体反解场景名(无哨兵返回 null)。
//   - renderScenario(name)       → 内置渲染的**上游原始响应体**(SSE 或 JSON);
//                                  未知场景返回 null(fixture-only 模式据此报 502)。
//
// 哨兵只进上游请求、不进任何响应体 —— 否则它会漂进快照基线。
// =============================================================================

/** 哨兵形状:__SNAPSHOT:<场景名>__。场景名限定在文件名安全字符内。 */
const SENTINEL_RE = /__SNAPSHOT:([A-Za-z0-9._-]+)__/;

/** 构造某场景的哨兵串(用例把它放进用户消息文本,上游据此选场景)。 */
export function sentinelFor(name) {
  return `__SNAPSHOT:${name}__`;
}

/** 从上游收到的请求体里反解场景名;没有哨兵时返回 null(调用方据此报 400)。 */
export function scenarioNameFromBody(body) {
  const match = SENTINEL_RE.exec(String(body ?? ''));
  return match ? match[1] : null;
}

// ─── CC wire 场景:场景名 → 事件序列 ─────────────────────────────────────────
// 事件序列逐条对应 CC /alpha/generate 的 `data:` 帧(content 不含 `data: ` 前缀
// 与空行,渲染时统一补上)。`[DONE]` 是唯一的非 JSON 帧。
// 修改任一条目都会改写快照基线:改完须 UPDATE_SNAPSHOTS=1 重录并人工复核 diff。

/** 终止帧字面量(SSE 流的收尾)。 */
const DONE_FRAME = '[DONE]';

export const CC_SCENARIOS = {
  'commandcode-chat-basic': [
    { type: 'start' },
    { type: 'text-delta', text: 'Hello, ' },
    { type: 'text-delta', text: 'snapshot world!' },
    { type: 'finish', finishReason: 'stop', data: { usage: { inputTokens: 7, outputTokens: 5 } } },
    DONE_FRAME,
  ],
};

/** 把一条事件渲染为 SSE 帧(JSON 序列化 + 空行;`[DONE]` 原样)。 */
function sseFrameOf(event) {
  const payload = event === DONE_FRAME ? DONE_FRAME : JSON.stringify(event);
  return `data: ${payload}\n\n`;
}

/**
 * 内置渲染:返回该场景的上游原始响应体,未知场景返回 null。
 *
 * 只有 CC 场景有内置渲染 —— Freebuff/WorkBuddy 的 upstream fixture 来自
 * Go 原版/手工构造(见 tests/snapshot/README.md),没有可推导的单一事件序列,
 * 故此处不臆造;它们的录制必须走 `--target` 真实采集。
 */
export function renderScenario(name) {
  const events = CC_SCENARIOS[name];
  if (!events) return null;
  return events.map(sseFrameOf).join('');
}
