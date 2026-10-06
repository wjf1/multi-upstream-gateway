// =============================================================================
// 管理面鉴权边界（批次 B）
// -----------------------------------------------------------------------------
// 三条互相咬合的规则，缺一不可：
//   B2 Host 回环白名单 —— 旧防线 isSameOriginIfPresent 比的是**攻击者可控的 Host 头**。
//      DNS rebinding 把 evil.tld 指到 127.0.0.1 后，Origin 与 Host 天然相等，必然放行。
//   B1 管理面一次性 token —— 只卡写操作；PROXY_API_KEY 从此只管 /v1/*，实现权限分离。
//      token 注入进页面 HTML，所以它**依赖 B2**：Host 不先关进白名单，rebinding 的
//      页面能把带着 token 的 HTML 一起读走。
//   B3 非回环绑定且无密钥时拒绝启动；B4 OAuth 缺 state 不再放行。
// 全部判据做成纯函数，便于单测锁定（tests/admin-boundary.test.ts）。
// =============================================================================
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/** 管理面写操作的一次性凭据。显式设置 ADMIN_API_TOKEN 可固定（脚本用）。 */
export const ADMIN_TOKEN: string = process.env.ADMIN_API_TOKEN?.trim() || randomUUID();

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** 把 `name:port` / `[v6]:port` 形态的 Host 值拆成小写主机名；无法解析时返回 null。 */
function hostNameOf(value: string): string | null {
  try {
    // 借 URL 解析：凭据（user@host）、路径、通配等畸形写法都会被归到真实 hostname 上。
    const url = new URL(`http://${value}`);
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * 入站 Host 是否属于回环名（或 ADMIN_ALLOWED_HOSTS 追加的名字）。
 * 端口不参与判定：同源检查已经约束了 host:port 的一致性。
 */
export function isLoopbackHostHeader(host: string | undefined, extraCsv?: string): boolean {
  if (!host) return false;
  const name = hostNameOf(host.trim());
  if (!name) return false;
  if (LOOPBACK_NAMES.has(name)) return true;
  const allowed = (extraCsv ?? process.env.ADMIN_ALLOWED_HOSTS ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/^\[|\]$/g, ''))
    .filter(Boolean);
  return allowed.includes(name);
}

/** 常量时间比较，避免用计时侧信道逐字节猜 token。长度不同也要走完哈希。 */
export function adminTokenOk(presented: string | undefined): boolean {
  if (!presented) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(ADMIN_TOKEN).digest();
  return timingSafeEqual(a, b);
}

/** 绑定地址不是回环、又没有数据面密钥、也没显式逃生阀 = 不允许启动。 */
export function isInsecureBind(opts: {
  host: string;
  hasProxyKey: boolean;
  allowInsecure: boolean;
}): boolean {
  if (opts.hasProxyKey || opts.allowInsecure) return false;
  const h = opts.host.trim().toLowerCase();
  return !(LOOPBACK_NAMES.has(h) || h === '' || h === '0' || h.startsWith('127.'));
}

/**
 * OAuth 回调的 state 判定。默认要求回显且与本流程生成的一致；
 * 只有显式打开兼容开关（旧版 CLI 不回显 state）时才允许缺失。
 */
export function oauthStateAcceptable(
  presented: string | null,
  expected: string,
  legacyFlowAllowed: boolean,
): boolean {
  if (presented === null || presented === undefined) return legacyFlowAllowed;
  return presented === expected;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 以 meta 而非内联 script 投递 token：不依赖 script-src 放宽，也不被 CSP 拦。 */
export function injectAdminTokenMeta(html: string): string {
  const tag = `<meta name="ccproxy-admin-token" content="${escapeAttr(ADMIN_TOKEN)}">`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `  ${tag}\n</head>`);
  return `${tag}\n${html}`;
}

/**
 * B5：只上零风险项。刻意**不含 script-src** —— index.html 里有一整块内联脚本
 * 加大量 onclick / onchange，一旦收紧仪表盘直接全废。
 * 把内联脚本外置化属独立重构批次，届时再补 script-src。
 */
export const ADMIN_CSP =
  "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'";
