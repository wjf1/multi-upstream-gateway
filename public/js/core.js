// =============================================================================
// CommandCode 代理面板 · 公共核心（core.js）
// -----------------------------------------------------------------------------
// T110：原 public/index.html 中那一整块内联脚本（第 474 行起）按页外置，本文件是
// 公共层。index.html 只留骨架 + 6 个 defer 外部脚本：
//   /js/core.js → 本文件；overview / accounts / usage / models / logs 见同目录。
//
// 职责：HTML 转义、apiJson 统一取数（含 x-admin-token 注入与 401 重取 token）、
//   toast / confirm、hash 路由（#/overview | #/accounts | #/usage | #/models |
//   #/logs）、按路由的刷新调度、明暗主题（CSS 变量 + localStorage 持久化）、
//   T106 合规风险告知门。
//
// 注意：本文件由服务端 /js/* 静态通路直接读盘下发（不经编译），必须保持纯
// JavaScript —— tests/dashboard-spa.test.ts 有 new Function() 语法锁。
// =============================================================================

// ─── HTML 转义（全站共用；tests/spa-*-functions 依赖此单行声明形态）──────────
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

/**
 * 统一的接口调用：把「连不上 / HTTP 非 2xx / 响应体不是 JSON」三类失败变成**返回值**，
 * 而不是各自 await fetch 再 .json()。此前 18 处 fetch 只有 2 处检查 res.ok —— 后端把账号
 * 相关写端点改成失败返回 500 之后，`data.accounts.map(...)` 会直接 TypeError，
 * 用户看到的就是"点了删除没反应、列表还是老样子"。
 *
 * 永不抛异常，因此调用点也不会产生未处理的 rejection。
 */
async function apiJson(url, opts) {
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { return { ok: false, data: null, error: '无法连接代理：' + ((e && e.message) || e) }; }
  let text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const e = data && data.error;
    const msg = (typeof e === 'string' ? e : (e && e.message)) || ('HTTP ' + res.status);
    return { ok: false, data, error: String(msg) };
  }
  if (data === null) return { ok: false, data: null, error: '响应体不是 JSON' };
  return { ok: true, data, error: null };
}
const JSON_HDR = { 'Content-Type': 'application/json' };
/** 卡片取数兜底：字段缺失显示占位，而不是把 undefined 写进界面。 */
function orDash(v){ return (v === undefined || v === null || v === '') ? '—' : v; }

// --- 统一空状态与骨架屏 -----------------------------------------------------
// 空状态：图标 + 一句中文；表格场景传 colSpan 合并单元格。动态文本一律走 esc。
function emptyState(icon, text, colSpan) {
  const inner = '<div class="empty-state"><i aria-hidden="true" class="fa-solid ' + esc(icon) + '"></i>' + esc(text) + '</div>';
  return colSpan ? '<tr><td colspan="' + colSpan + '">' + inner + '</td></tr>' : inner;
}
// 骨架屏：仅在容器为空时铺 shimmer 占位（30s 轮询重渲染不闪骨架）。
function skelBar(w) { return '<div class="skel" style="width:' + (w || 100) + '%"></div>'; }
function skeletonCards(n, h) {
  let out = '';
  for (let i = 0; i < n; i++) out += '<div class="card rounded-xl p-5 space-y-2">' + skelBar(40) + skelBar(h || 70) + skelBar(55) + '</div>';
  return out;
}
function skeletonRows(cols, n) {
  const cell = '<div class="skel" style="height:.7rem"></div>';
  let rows = '';
  for (let i = 0; i < n; i++) rows += '<tr><td colspan="' + cols + '"><div class="grid gap-2 py-1.5" style="grid-template-columns:repeat(' + cols + ',1fr)">' + cell.repeat(cols) + '</div></td></tr>';
  return rows;
}
function showSkeletonIfEmpty(el, fill) { if (el && !el.children.length) el.innerHTML = fill; }

// ─── 徽标（账号页与模型页共用；text 与 title 都必须转义）──────────────────────
const BADGE_TONES = {
  rose: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  slate: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  sky: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
};
function badge(text, tone, title) {
  return '<span class="text-[10px] px-2 py-0.5 rounded border font-semibold ' + BADGE_TONES[tone] + '"' +
    (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';
}

// ─── 轻量 toast 与确认框（替代原生 alert/confirm，风格与面板一致）─────────────
function showToast(msg, type) {
  type = type || 'info';
  const tones = {
    success: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200',
    error: 'bg-rose-500/10 border-rose-500/30 text-rose-200',
    info: 'bg-slate-800 border-slate-600 text-slate-200'
  };
  const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };
  const el = document.createElement('div');
  el.className = 'px-4 py-2.5 rounded-lg border text-xs font-medium shadow-lg backdrop-blur flex items-center gap-2 max-w-sm ' + (tones[type] || tones.info);
  el.innerHTML = '<i aria-hidden="true" class="fa-solid ' + (icons[type] || icons.info) + '"></i><span>' + esc(msg) + '</span>';
  document.getElementById('toastBox').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 4000);
}
function uiConfirm(message) {
  return new Promise(resolve => {
    window.__confirmResolve = resolve;
    document.getElementById('confirmMsg').textContent = message;
    document.getElementById('confirmModal').classList.remove('hidden');
  });
}
function settleConfirm(ok) {
  document.getElementById('confirmModal').classList.add('hidden');
  const r = window.__confirmResolve;
  window.__confirmResolve = null;
  if (r) r(!!ok);
}

// ─── 管理面鉴权（批次 B，原样平移）───────────────────────────────────────────
// /api/* 的写操作要 x-admin-token：它由服务端注入在本页的 <meta name="ccproxy-admin-token">
// 里（回环 Host 才会被投递，见 src/utils/admin-guard.ts）。PROXY_API_KEY 从此只覆盖
// /v1/*，不再充当管理面凭据。收到 /api 401 基本只有一种解释：网关重启换了一代 token，
// 而这是旧页面 —— 刷新一次拿新 token，且不允许连环刷新。
const realFetch = window.fetch.bind(window);
const ADMIN_TOKEN = (() => {
  const meta = document.querySelector('meta[name="ccproxy-admin-token"]');
  return meta ? (meta.getAttribute('content') || '') : '';
})();
function authHeadersFor(url, init) {
  const headers = new Headers((init && init.headers) || {});
  let touched = false;
  if (url.startsWith('/api/') && ADMIN_TOKEN) { headers.set('x-admin-token', ADMIN_TOKEN); touched = true; }
  if (url.startsWith('/v1/')) {
    const key = sessionStorage.getItem('adminKey') || '';
    if (key) { headers.set('x-api-key', key); touched = true; }
  }
  return touched ? Object.assign({}, init, { headers }) : init;
}
function methodOf(input, init) {
  if (init && init.method) return String(init.method).toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}
let adminKeyWaiters = [];
let adminKeyMutedUntil = 0;
function promptAdminKeyOnce() {
  // 并发 401 共享同一次输入；用户取消后 60s 内不再打扰（轮询还在跑）
  if (Date.now() < adminKeyMutedUntil) return Promise.resolve(null);
  if (!adminKeyWaiters.length) {
    const input = document.getElementById('adminKeyInput');
    document.getElementById('adminKeyModal').classList.remove('hidden');
    input.value = sessionStorage.getItem('adminKey') || '';
    input.focus();
    adminKeyWaiters.push(new Promise(resolve => { window.__adminKeyResolve = resolve; }));
  }
  return adminKeyWaiters[0];
}
function settleAdminKey(key) {
  document.getElementById('adminKeyModal').classList.add('hidden');
  const resolve = window.__adminKeyResolve;
  adminKeyWaiters = [];
  window.__adminKeyResolve = null;
  if (key) sessionStorage.setItem('adminKey', key);
  if (resolve) resolve(key || null);
}
function submitAdminKey() {
  const key = document.getElementById('adminKeyInput').value.trim();
  if (!key) return;
  settleAdminKey(key);
  fetchStatus();
}
function dismissAdminKeyModal() {
  adminKeyMutedUntil = Date.now() + 60_000;
  settleAdminKey(null);
}
window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(methodOf(input, init));
  let res = await realFetch(input, authHeadersFor(url, init));
  if (res.status === 401 && url.startsWith('/api/') && write) {
    if (!sessionStorage.getItem('adminTokenReloaded')) {
      sessionStorage.setItem('adminTokenReloaded', '1');
      location.reload();
    } else {
      showToast('管理凭据无效：本页携带的 token 与网关当前值不一致，请确认没有另开实例或固定 ADMIN_API_TOKEN。', 'error');
    }
    return res;
  }
  if (res.ok && url.startsWith('/api/') && write) sessionStorage.removeItem('adminTokenReloaded');
  if (res.status === 401 && url.startsWith('/v1/')) {
    const key = await promptAdminKeyOnce();
    if (key) res = await realFetch(input, authHeadersFor(url, init));
  }
  return res;
};

// ─── 明暗主题（T110）：CSS 变量双套 + localStorage 持久化 ─────────────────────
// 变量定义在 index.html 的 <style> 里（html.light 覆盖中性色）；head 内联一行脚本
// 在首帧前同步初值，避免亮色偏好用户看到一闪而过的暗色。图表配色画在 canvas 上、
// 不认 CSS 变量，theme 切换时尽力重绘一次（失败不阻塞）。
const THEME_KEY = 'ccproxy-theme';
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.classList.toggle('light', light);
  document.documentElement.classList.toggle('dark', !light);
  const icon = document.getElementById('themeIcon');
  if (icon) icon.className = 'fa-solid ' + (light ? 'fa-moon' : 'fa-sun');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.title = light ? '切换到深色主题' : '切换到浅色主题';
}
function toggleTheme() {
  const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  applyTheme(next);
  // 用量页有数据时立即重绘图表；否则等下一次刷新自然重建。
  try {
    if (typeof renderUsageCharts === 'function' && usageHistoryCache) renderUsageCharts(usageHistoryCache);
  } catch {}
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; } })());

// ─── hash 路由（#/overview | #/accounts | #/usage | #/models | #/logs）────────
// 只有这 5 个既有分区，不造新页；刷新/直链按 hash 恢复页面，tab 点击行为不变。
const ROUTES = ['overview', 'accounts', 'usage', 'models', 'logs'];
let currentTab = 'overview';
function routeFromHash() {
  const m = (location.hash || '').match(/^#\/(\w+)/);
  return m && ROUTES.includes(m[1]) ? m[1] : 'overview';
}
// 按页刷新调度：切换分区时重建定时器。'*' 为全局任务（header 状态 5s 轮询），
// 页面任务只在对应分区激活时运行；页面在后台（document.hidden）时跳过。
const refreshJobs = [];
function registerRefresh(route, fn, ms) { refreshJobs.push({ route, fn, ms, timer: null }); }
function startRefreshJobs(tab) {
  refreshJobs.forEach(j => { if (j.timer) { clearInterval(j.timer); j.timer = null; } });
  refreshJobs.forEach(j => {
    if (j.route === tab || j.route === '*') {
      j.timer = setInterval(() => { if (!document.hidden) j.fn(); }, j.ms);
    }
  });
}
// 各页面脚本提供 enter_<route>() 作为进入钩子（首次取数）。
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const on = b.id === 'tab-' + tab;
    b.classList.toggle('active', on);
    // 此前只切 CSS 类：读屏用户无法知道当前在哪个分区，且五个标签都能被 Tab 命中，
    // 与 ARIA tablist 的"仅选中项可聚焦 + 方向键切换"约定不符。
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
  const content = document.getElementById('content-' + tab);
  if (content) content.classList.remove('hidden');
  currentTab = tab;
  startRefreshJobs(tab);
  const enter = window['enter_' + tab];
  if (typeof enter === 'function') { try { enter(); } catch (e) { console.error('[panel] enter ' + tab, e); } }
  const target = '#/' + tab;
  if (location.hash !== target) location.hash = target;
}
window.addEventListener('hashchange', () => {
  const tab = routeFromHash();
  if (tab !== currentTab) switchTab(tab);
});

// ─── T106（§3.7-7）：合规风险告知门 ──────────────────────────────────────────
// acceptedRiskDisclaimer=false 时服务端对全部 /v1/* 返回 403，这里首屏强制弹窗
// （无关闭按钮、Esc 不生效 —— 它是硬门，不是提示）。用户确认后调
// POST /api/risk/accept（经 apiJson → fetch 包装自动带 x-admin-token），服务端写回
// config.json 并热生效；随后 hideRiskGate() 放行页面。
// 状态源是 /api/status.acceptedRiskDisclaimer（服务端为准）。
let riskGateAccepted = null;
function showRiskGate() {
  const el = document.getElementById('riskModal');
  if (el) el.classList.remove('hidden');
}
function hideRiskGate() {
  const el = document.getElementById('riskModal');
  if (el) el.classList.add('hidden');
}
async function acceptRiskGate() {
  const { ok, error } = await apiJson('/api/risk/accept', { method: 'POST' });
  if (ok) {
    riskGateAccepted = true;
    hideRiskGate();
    showToast('已确认风险告知，/v1 请求现已放行。', 'success');
    fetchStatus();
  } else {
    showToast('确认失败：' + (error || '无法写入配置') + '（请确认本页携带有效管理凭据，刷新页面可获取新 token）', 'error');
  }
}
// 由 /api/status 的响应驱动（overview.js 的 fetchStatus 里调用）。
// 字段缺失（旧版本服务端）时不动，避免把面板锁死在弹窗上。
function maybeShowRiskGate(status) {
  if (!status || typeof status.acceptedRiskDisclaimer !== 'boolean') return;
  riskGateAccepted = status.acceptedRiskDisclaimer;
  if (!riskGateAccepted) showRiskGate(); else hideRiskGate();
}

// ─── 焦点归还锚点（showLoginModal 在 accounts.js 里同步记录）─────────────────
let modalReturnFocus = null;

// ─── 全局键盘：管理密钥模态 Enter 提交、Esc 取消；确认框 Esc/Enter；登录模态 ───
document.getElementById('adminKeyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAdminKey(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!document.getElementById('adminKeyModal').classList.contains('hidden')) dismissAdminKeyModal();
    if (!document.getElementById('confirmModal').classList.contains('hidden')) settleConfirm(false);
  }
  if (e.key === 'Enter' && !document.getElementById('confirmModal').classList.contains('hidden')) settleConfirm(true);
});
// 登录模态：Enter 提交、Esc 关闭。
document.getElementById('loginApiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
document.getElementById('loginNickname').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.getElementById('loginModal').classList.contains('hidden')) hideLoginModal(); });

// ─── 键盘可达性：标签页方向键切换 + 弹窗焦点约束 ─────────────────────────────
// ARIA tablist 的约定是"只有选中标签可被 Tab 命中，方向键在标签间移动"。
document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
  const tabs = Array.from(document.querySelectorAll('.tab-btn'));
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  let next = null;
  if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
  else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
  else if (e.key === 'Home') next = tabs[0];
  else if (e.key === 'End') next = tabs[tabs.length - 1];
  if (!next) return;
  e.preventDefault();
  next.focus();
  switchTab(next.id.replace(/^tab-/, ''));
});

const FOCUSABLE_SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function visibleFocusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE_SEL)).filter(el => el.getClientRects().length > 0);
}
// 三个弹窗（+ 风险门）此前没有任何焦点约束：Tab 能穿到弹窗背后的页面继续操作按钮。
document.querySelectorAll('[role="dialog"]').forEach(m => {
  new MutationObserver(() => {
    // 只负责"打开时把焦点移进弹窗"。焦点归还由各弹窗的关闭函数同步做，
    // 见 hideLoginModal —— 在微任务里读 activeElement 已经太晚了。
    if (m.classList.contains('hidden')) return;
    // 调用方已经把焦点放进弹窗就别抢：showLoginModal 刻意聚焦 API Key 输入框，
    // 而弹窗里第一个可聚焦元素是昵称框。
    if (m.contains(document.activeElement)) return;
    const f = visibleFocusables(m);
    if (f.length) f[0].focus();
  }).observe(m, { attributes: true, attributeFilter: ['class'] });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const open = Array.from(document.querySelectorAll('[role="dialog"]')).find(d => !d.classList.contains('hidden'));
  if (!open) return;
  const items = visibleFocusables(open);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (!open.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}, true);

// ─── 初始路由：所有 defer 脚本执行完毕后按 hash 激活对应页面 ──────────────────
document.addEventListener('DOMContentLoaded', () => switchTab(routeFromHash()));
