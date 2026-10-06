// =============================================================================
// 统一日志脱敏（T105）
// -----------------------------------------------------------------------------
// 全路径日志的唯一脱敏通道：logger.ts 的 push、安全中间件链的请求完成日志、
// 审计的 target/ip、错误消息与堆栈都经由 sanitizeLog 输出。规则（按序应用）：
//   1. `Bearer <token>` → `Bearer ***REDACTED***`（大小写不敏感）；
//   2. Cookie / Set-Cookie 的整段值 → `***REDACTED***`（cookie 值内含分号，
//      不能按键值对截断，整值抹除）；
//   3. 敏感头键值对（authorization / proxy-authorization / x-api-key /
//      x-admin-token）→ 值抹除；
//   4. api_key= / token= / secret= / password= 形态的查询串与文本 → 值抹除；
//   5. `sk-` 前缀 key（10 位以上）→ `sk-***REDACTED***`；
//   6. 24 位以上连续 [A-Za-z0-9_-] 兜底（无前缀 hex/base64 凭据）→ 抹除；
//   7. 控制字符与 ANSI 转义清除（沿用 logger 旧规则，防日志注入）。
//
// 误伤权衡：24+ 连续段在正常业务日志里几乎只有密钥/哈希/长 base64。UUID 的最长
// 连续段为 12（hex 段带连字符）、路径/模型名段更短，均不受影响；40 位 commit
// hash 会被抹除——日志没有依赖完整 hash 的场景，可接受。
// 本文件不 import logger（logger 反向 import 本文件），保持零循环依赖。
// =============================================================================

const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const COOKIE_RE = /(["']?(?:set-cookie|cookie)["']?\s*[:=]\s*)([^\r\n]+)/gi;
const HEADER_SECRET_RE =
  /(["']?(?:authorization|proxy-authorization|x-api-key|x-admin-token)["']?\s*[:=]\s*)(["']?)[^\s"',;]+\2/gi;
const KEYVAL_SECRET_RE =
  /(["']?(?:api[_-]?key|access[_-]?token|token|secret|password)["']?\s*[:=]\s*)(["']?)[A-Za-z0-9._~+/=-]{8,}\2/gi;
const SK_KEY_RE = /sk-[A-Za-z0-9_-]{10,}/gi;
// 连续段不含 '-','_'：UUID（连字符分段的 hex）与带连字符的标识符不再误伤；
// 无前缀 hex/base64 凭据（连续 24+ 位字母数字）仍被兜底抹除。
const LONG_SECRET_RE = /[A-Za-z0-9]{24,}/g;
// eslint-disable-next-line no-control-regex -- 控制字符即清洗目标
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex -- \u001B(ESC) 即目标清洗字符
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** 把任意值渲染为安全日志字符串：凭据抹除 + ANSI/控制字符清理。 */
export function sanitizeLog(input: unknown): string {
  let s = String(input ?? '');
  if (!s) return '';
  s = s.replace(BEARER_RE, 'Bearer ***REDACTED***');
  s = s.replace(COOKIE_RE, '$1***REDACTED***');
  s = s.replace(HEADER_SECRET_RE, '$1$2***REDACTED***$2');
  s = s.replace(KEYVAL_SECRET_RE, '$1$2***REDACTED***$2');
  s = s.replace(SK_KEY_RE, 'sk-***REDACTED***');
  s = s.replace(LONG_SECRET_RE, '***REDACTED***');
  // 先剥完整 ANSI 序列（以 ESC 开头），再清残余控制字符 —— 顺序反了会把
  // ESC 先吃掉，留下 '[31m' 这类残骸。
  s = s.replace(ANSI_RE, '');
  s = s.replace(CONTROL_RE, '');
  return s;
}

/** 错误消息与堆栈的统一脱敏出口（错误经常内嵌上游响应头/URL 凭据）。 */
export function sanitizeErrorDetail(err: unknown): string {
  if (err instanceof Error) {
    const parts = [err.message];
    if (err.stack) parts.push(err.stack);
    return sanitizeLog(parts.join('\n'));
  }
  return sanitizeLog(err == null ? '' : String(err));
}

/**
 * NODE_DEBUG 里的 undici/http/http2 会让 Node 原生客户端把完整请求头（含
 * Authorization）打到 stderr —— 那条通路绕过所有日志脱敏。启动时剥离这些项
 * 并返回剥离清单（调用方负责告警）。`*` 通配会一并开启 undici 调试，同样剥离。
 */
const DANGEROUS_NODE_DEBUG = new Set(['undici', 'http', 'https', 'http2', '*']);

export function stripDangerousNodeDebug(
  env: NodeJS.ProcessEnv = process.env,
): { changed: boolean; removed: string[] } {
  const raw = env.NODE_DEBUG || '';
  if (!raw) return { changed: false, removed: [] };
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const removed = parts.filter(p => DANGEROUS_NODE_DEBUG.has(p.toLowerCase()));
  if (removed.length === 0) return { changed: false, removed: [] };
  const kept = parts.filter(p => !DANGEROUS_NODE_DEBUG.has(p.toLowerCase()));
  env.NODE_DEBUG = kept.join(',');
  return { changed: true, removed };
}
