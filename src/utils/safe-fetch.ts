// =============================================================================
// SSRF 防护的出站请求封装（T105，执行依据 §3.7-6）
// -----------------------------------------------------------------------------
// undici fetch + redirect:'manual'：把重定向控制权收回来，对 Location **逐跳**
// 复用 config.ts 的 assertSafeUpstreamUrl（allowlist / 私有地址 / 协议降级 /
// 内嵌凭据）校验，最多跟随 3 跳。undici 的全局 fetch 自动跟随重定向时不暴露
// 中间跳，攻击者可借上游 302 把带凭据的请求引向内网 —— manual + 逐跳校验
// 封死二跳 SSRF。
//
// 应用点：providers/commandcode/upstream.ts 的 sendToCC（/alpha/generate）与
// config.ts 的 fetchJson（用量统计）。初始 URL 同样过校验（幂等，调用方原本
// 已各自校验）。
// =============================================================================

import { fetch as undiciFetch } from 'undici';
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from 'undici';
import { assertSafeUpstreamUrl } from './security-guard.js';

/** 最大重定向跟随次数（超过即拒绝，第 max+1 个 3xx 响应触发）。 */
export const MAX_REDIRECT_HOPS = 3;

export type SafeFetchErrorReason = 'REDIRECT_BLOCKED' | 'REDIRECT_LIMIT' | 'INVALID_LOCATION';

/** safeFetch 的防护性失败。upstream.ts 据此映射 BLOCKED_HOST / NETWORK_ERROR。 */
export class SafeFetchError extends Error {
  constructor(
    message: string,
    public readonly reason: SafeFetchErrorReason,
    public readonly upstreamCause?: unknown,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 带逐跳 SSRF 校验的出站请求。
 *
 * - 初始 URL 与每个 Location 都过 assertSafeUpstreamUrl（fail-closed）；
 * - 最多跟随 `maxRedirects`（默认 3）跳，超限抛 SafeFetchError(REDIRECT_LIMIT)；
 * - 303 将方法降级为 GET 并丢弃 body（307/308 保留方法与 body）；
 * - 3xx 响应体立即取消，避免悬挂连接。
 */
export async function safeFetch(
  rawUrl: string,
  init: UndiciRequestInit = {},
  opts: { maxRedirects?: number } = {},
): Promise<UndiciResponse> {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECT_HOPS;

  let current: string;
  try {
    current = assertSafeUpstreamUrl(rawUrl).toString();
  } catch (err) {
    throw new SafeFetchError(
      `Blocked initial upstream URL: ${(err as Error).message}`,
      'REDIRECT_BLOCKED',
      err,
    );
  }

  let requestInit: UndiciRequestInit = { ...init, redirect: 'manual' };

  for (let hop = 0; ; hop++) {
    const res = await undiciFetch(current, requestInit);

    if (!REDIRECT_STATUSES.has(res.status)) return res;

    // 3xx 响应体为空，取消以释放底层连接。
    try {
      res.body?.cancel();
    } catch { /* 尽力而为 */ }

    const location = res.headers.get('location');
    if (!location) {
      throw new SafeFetchError(`Redirect ${res.status} without Location header`, 'INVALID_LOCATION');
    }
    if (hop >= maxRedirects) {
      throw new SafeFetchError(
        `Redirect hop limit (${maxRedirects}) exceeded; refusing to follow -> ${location}`,
        'REDIRECT_LIMIT',
      );
    }

    let nextUrl: string;
    try {
      // 相对 Location 以当前 URL 为基准解析；解析结果仍必须落在 allowlist 内。
      nextUrl = assertSafeUpstreamUrl(new URL(location, current).toString()).toString();
    } catch (err) {
      throw new SafeFetchError(
        `Redirect target blocked by SSRF guard: ${(err as Error).message}`,
        'REDIRECT_BLOCKED',
        err,
      );
    }

    if (res.status === 303) {
      requestInit = { ...requestInit, method: 'GET', body: undefined };
    }
    current = nextUrl;
  }
}
