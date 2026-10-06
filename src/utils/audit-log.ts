// =============================================================================
// 审计日志（JSONL，默认开启 minimal）—— 只记元数据，绝不记消息正文
// -----------------------------------------------------------------------------
// - 每个补全请求一行 JSON：{ ts, route, model, inputTokens, outputTokens,
//   status, durationMs, accountId? }。status 取值：COMPLETED / FAILED /
//   RATE_LIMITED / MODEL_FORBIDDEN（后两者来自限流与模型访问控制 guard）。
//   accountId 是上游 Command Code API key 的末 4 位（accountTail），绝不落
//   全量密钥；字段层面就不存在消息正文、system prompt 或任何用户内容。
// - 路径：AUDIT_LOG_PATH 可覆盖；默认 getProjectRootDir()/logs/audit.log
//   （与 logger.ts 的 LOG_FILE_PATH 同款目录模式，但不改 logger.ts）。
//   路径在**写入时**惰性求值，测试可用 AUDIT_LOG_PATH 指到临时目录。
// - 开关：AUDIT_LOG 默认 on，设 off 关闭（关闭时零 IO、零开销）。
// - 落盘：追加式 + 超 5MB 轮转 .old（参照 logger 的 LOG_FILE_MAX_BYTES 模式）；
//   任何写失败（目录不可创建、磁盘只读等）一律静默禁用，绝不影响请求路径。
// - API：auditRequestStart(req) 在 handler 入口创建条目并开始计时；
//   auditRequestEnd(entry, result) 在请求收敛点落盘（本仓库路由里与用量落库
//   persistOnce 同点，一次请求只记一条）。guard 拒绝路径拿不到闭包 entry，
//   用 auditReject(req, ...) 经 WeakMap 关联容错落盘。
//
// ── 4.22.4 移植说明（Phase D1）───────────────────────────────────────────────
// 参照树同名的 audit-log.ts 是**管理面审计**（T105：/api/* 写操作留痕），
// 4.22.4 同名的 audit-log.ts 是**数据面审计**（/v1 补全请求一行 JSONL）。
// 二者职责不同、文件不同源，此处把参照树的管理面审计 API 追加到本文件下方，
// 数据面审计 API 保持原样不动：两种审计落盘到不同文件（audit.log vs
// audit-log.jsonl），互不干扰。
// =============================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getProjectRootDir } from './paths.js';
import { sanitizeLog } from './sanitize.js';

const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

export interface AuditEntry {
  startTs: number;
  route: string;
}

export interface AuditResult {
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  status: string;
  accountId?: string;
}

/** entry 与请求对象弱关联，供 guard 拒绝路径（无闭包 entry）容错取回。 */
const pendingEntries = new WeakMap<object, AuditEntry>();

function auditEnabled(): boolean {
  return (process.env.AUDIT_LOG ?? 'on').trim().toLowerCase() !== 'off';
}

function auditFilePath(): string {
  return process.env.AUDIT_LOG_PATH
    ? path.resolve(process.env.AUDIT_LOG_PATH)
    : path.join(getProjectRootDir(), 'logs', 'audit.log');
}

function resolveRoute(req: { url?: string }): string {
  return String(req?.url ?? '').split('?')[0] || 'unknown';
}

/** 取密钥末 4 位作账号标识；空值返回 undefined。绝不返回全量密钥。 */
export function accountTail(key: string | undefined | null): string | undefined {
  const k = String(key ?? '').trim();
  return k ? k.slice(-4) : undefined;
}

/** handler 入口调用：创建审计条目并开始计时。 */
export function auditRequestStart(req: { url?: string }): AuditEntry {
  const entry: AuditEntry = { startTs: Date.now(), route: resolveRoute(req) };
  pendingEntries.set(req as object, entry);
  return entry;
}

/** guard 拒绝路径（限流 / 模型访问控制）在路由早期落盘一行审计。 */
export function auditReject(req: { url?: string }, status: string, model?: string | null): void {
  const entry = pendingEntries.get(req as object) ?? auditRequestStart(req);
  auditRequestEnd(entry, { model: model ?? null, status });
}

/** 请求收敛点调用：组装元数据并落盘一行。写失败静默。 */
export function auditRequestEnd(entry: AuditEntry, result: AuditResult): void {
  if (!auditEnabled()) return;
  const record: Record<string, unknown> = {
    ts: new Date(entry.startTs).toISOString(),
    route: entry.route,
    model: result.model ?? null,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
    status: result.status,
    durationMs: Math.max(0, Date.now() - entry.startTs),
  };
  if (result.accountId) record.accountId = result.accountId;
  appendAuditLine(JSON.stringify(record));
}

function appendAuditLine(line: string): void {
  try {
    const file = auditFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > AUDIT_ROTATE_BYTES) {
        fs.renameSync(file, `${file}.old`);
      }
    } catch {
      /* 文件尚不存在等场景，继续追加 */
    }
    fs.appendFileSync(file, `${line}\n`, 'utf-8');
  } catch {
    // 落盘失败（目录不可写、磁盘只读等）静默禁用：审计绝不影响请求路径。
  }
}

// =============================================================================
// 管理面审计日志（T105，执行依据 master-plan v1.2 §3.7-4）
// -----------------------------------------------------------------------------
// /api/* 的全部写操作（POST/PUT/PATCH/DELETE）追加写入 audit-log.jsonl：
//   { ts, category, target, ip, requestId, outcome }
// 硬约束：**不落消息正文与任何明文凭据** —— 只记路径、来源 IP、请求 ID 与
// 响应状态码；target/ip 经 sanitizeLog 兜底。被拒（401/403）的写操作同样留痕，
// 结果字段记录真实状态码。
//
// 挂载：dashboardRoutes 内调用 registerAuditLog(fastify)。onResponse 钩子在
// 响应完成后触发（含被 onRequest 钩子拒绝的请求），requestId 取全局安全链
// （security-guard onRequest）写入的值，缺省时自行解析/生成。
// 文件写入尽力而为：审计失败只影响审计文件本身，不阻塞管理请求。
// =============================================================================

/** 审计文件路径的环境变量名（测试/自定义部署覆盖）。 */
export const AUDIT_LOG_PATH_ENV = 'AUDIT_LOG_PATH';

/** 审计文件路径：AUDIT_LOG_PATH > 项目根 logs/audit-log.jsonl（每次调用动态求值，可测）。 */
export function getAuditLogPath(): string {
  return process.env[AUDIT_LOG_PATH_ENV]
    ? path.resolve(process.env[AUDIT_LOG_PATH_ENV])
    : path.join(getProjectRootDir(), 'logs', 'audit-log.jsonl');
}

/** 单条管理面审计记录（写盘形态 = JSONL 一行）。 */
export interface AdminAuditEntry {
  /** ISO 时间戳。 */
  ts: string;
  /** 操作类别（本阶段固定 admin.write）。 */
  category: string;
  /** 目标（/api/* 路径，不含查询串）。 */
  target: string;
  /** 来源 IP（Fastify req.ip，trustProxy 时取 X-Forwarded-For 首段）。 */
  ip: string;
  /** 全链路请求 ID（T105 传播）。 */
  requestId: string;
  /** 结果（HTTP 状态码；被钩子拒绝的写操作同样记录）。 */
  outcome: string;
}

const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 追加一条管理面审计记录（尽力而为；文件写入失败不影响请求）。 */
export function appendAuditEntry(entry: AdminAuditEntry, filePath: string = getAuditLogPath()): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // 审计落盘失败不阻塞管理请求（与 logger 的 appendFileSink 同策略）
  }
}

/** 读取管理面审计记录（测试与排查用）；坏行跳过。 */
export function readAuditEntries(filePath: string = getAuditLogPath()): AdminAuditEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const out: AdminAuditEntry[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AdminAuditEntry);
    } catch {
      // 单行损坏不阻塞整体读取
    }
  }
  return out;
}

/**
 * 在管理面 Fastify 实例上挂审计钩子。只覆盖 /api/* 的写方法；GET/HEAD/OPTIONS
 * 读操作不产生审计。
 */
export function registerAuditLog(fastify: FastifyInstance): void {
  fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const pathname = req.url.split('?')[0];
    if (!pathname.startsWith('/api/') || !AUDITED_METHODS.has(req.method)) return;
    // requestId 由全局安全链（security-guard onRequest）写入；独立挂载（测试/
    // 旧路径）时自行解析客户端头或生成。
    const rawRequest = (req as unknown as Record<string, unknown>).requestId;
    const requestId =
      typeof rawRequest === 'string' && rawRequest
        ? rawRequest
        : typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id']
          ? String(req.headers['x-request-id'])
          : `audit-${crypto.randomUUID()}`;
    appendAuditEntry({
      ts: new Date().toISOString(),
      category: 'admin.write',
      target: sanitizeLog(pathname),
      ip: sanitizeLog(req.ip || ''),
      requestId: sanitizeLog(requestId),
      outcome: String(reply.statusCode),
    });
  });
}
