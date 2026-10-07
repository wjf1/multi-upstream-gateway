// =============================================================================
// safeFetch SSRF 二跳防护测试（T105 DoD）
// -----------------------------------------------------------------------------
// safeFetch 以 undici fetch + redirect:'manual' 逐跳校验 Location:
//   - 每一跳（含初始 URL）都过 assertSafeUpstreamUrl（复用 config.ts 白名单逻辑）;
//   - 最多跟随 3 跳,第 4 个重定向响应直接拒绝（REDIRECT_LIMIT）;
//   - 白名单内重定向正常跟随;303 将 POST 降级为 GET 并丢弃 body。
// 测试用回环 HTTP server,通过 COMMANDCODE_UPSTREAM_ALLOWED_HOSTS=127.0.0.1
// 显式放行回环(config.ts 约定:私有/回环地址仅在显式允许时放行,且 http 仅回环)。
// =============================================================================

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { MAX_REDIRECT_HOPS, SafeFetchError, safeFetch } from '../src/utils/safe-fetch.js';

let server: http.Server;
let base = '';
let hits: Record<string, number>;

function startServer(): Promise<void> {
  hits = {};
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    hits[url.pathname] = (hits[url.pathname] || 0) + 1;

    const redirect = (location: string, status = 302) => {
      res.writeHead(status, { Location: location });
      res.end();
      return;
    };

    switch (url.pathname) {
      case '/redir-evil':
        return redirect('https://evil.example.com/x');
      case '/redir-private':
        return redirect('http://10.0.0.5/x');
      case '/redir-in':
        return redirect('/final');
      case '/final':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok-final');
        return;
      case '/loop':
        return redirect(`/loop?n=${Number(url.searchParams.get('n') || 0) + 1}`);
      case '/s303':
        return redirect('/s303-target', 303);
      case '/s303-target':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`method=${req.method}`);
        return;
      default:
        res.writeHead(404);
        res.end('not found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}

beforeEach(async () => {
  process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS = '127.0.0.1';
  await startServer();
});

afterEach(async () => {
  delete process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('safeFetch —— 重定向逐跳校验', () => {
  it('初始 URL 也过白名单校验(非白名单 host 直接拒绝)', async () => {
    await expect(safeFetch('https://not-allowed.example.com/v1')).rejects.toThrow(/not allowed/i);
  });

  it('302 到白名单外 host 被拦截(REDIRECT_BLOCKED)', async () => {
    await expect(safeFetch(`${base}/redir-evil`)).rejects.toMatchObject({ reason: 'REDIRECT_BLOCKED' });
    await expect(safeFetch(`${base}/redir-private`)).rejects.toMatchObject({ reason: 'REDIRECT_BLOCKED' });
    // 恶意 host 没有真的被请求过(拦截发生在本地校验层)
    expect(hits['/redir-evil']).toBe(1);
  });

  it('白名单内(同 host)重定向正常跟随', async () => {
    const res = await safeFetch(`${base}/redir-in`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok-final');
    expect(hits['/final']).toBe(1);
  });

  it(`超过 ${MAX_REDIRECT_HOPS} 跳截断(REDIRECT_LIMIT),服务端只收到 1+${MAX_REDIRECT_HOPS} 次请求`, async () => {
    const err = await safeFetch(`${base}/loop`).catch(e => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).reason).toBe('REDIRECT_LIMIT');
    expect(hits['/loop']).toBe(1 + MAX_REDIRECT_HOPS);
  });

  it('303 将 POST 降级为 GET 并丢弃 body', async () => {
    const res = await safeFetch(`${base}/s303`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'payload' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('method=GET');
  });

  it('非重定向响应原样返回(状态与 body 不变)', async () => {
    const res = await safeFetch(`${base}/final`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok-final');
  });
});
