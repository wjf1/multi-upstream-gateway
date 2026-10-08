// =============================================================================
// 多上游 AI 网关面板 · 账号与鉴权页（accounts.js）—— 路由 #/accounts
// -----------------------------------------------------------------------------
// 多账号列表、浏览器 OAuth 登录、手动粘贴 API Key、轮换策略、账号额度徽标。
// 三个写操作（设为当前 / 删除 / 切换轮换模式）都必须看结果：后端失败会返回 500，
// 此前把响应整个丢掉、无条件重载列表，用户看到"已切换/已删除"但其实没写进 config.json。
// =============================================================================

async function startBrowserLogin() {
  const btn = document.getElementById('browserAuthBtn');
  const original = btn.innerHTML;
  btn.innerHTML = '<i aria-hidden="true" class="fa-solid fa-spinner fa-spin"></i> 正在等待浏览器授权...';
  btn.disabled = true;
  try {
    const { ok, data, error } = await apiJson('/api/auth/browser-login', { method:'POST' });
    if (ok && data.status === 'success') { showToast('登录成功：' + ((data.account && data.account.name) || '新账号'), 'success'); loadAccounts(); fetchStatus(); }
    else showToast('浏览器登录失败：' + ((data && data.error) || error), 'error');
  } catch (e) { showToast('浏览器登录失败：' + e.message, 'error'); }
  finally { btn.innerHTML = original; btn.disabled = false; }
}

function showLoginModal(){ modalReturnFocus = document.activeElement; document.getElementById('loginModal').classList.remove('hidden'); document.getElementById('loginApiKey').focus(); }
// 重开弹窗时清掉上一次的报错，否则空字段旁边还挂着"API Key 不能为空"。
function hideLoginModal(){
  document.getElementById('loginModal').classList.add('hidden');
  const e = document.getElementById('loginError'); if (e) { e.classList.add('hidden'); e.innerText = ''; }
  // 在 showLoginModal 里同步记下的触发元素上归还焦点。放在 MutationObserver 里取
  // activeElement 是不可靠的：那时弹窗内部的 focus() 已经执行过了（实测会把焦点
  // 留在弹窗里的输入框上，而它已经随弹窗一起隐藏）。
  const back = modalReturnFocus;
  modalReturnFocus = null;
  if (back && document.contains(back) && back.getClientRects().length) back.focus();
}

async function submitLogin() {
  const apiKey = document.getElementById('loginApiKey').value.trim();
  const name = document.getElementById('loginNickname').value.trim();
  const errEl = document.getElementById('loginError');
  if (!apiKey) { errEl.innerText='API Key 不能为空'; errEl.classList.remove('hidden'); return; }
  const { ok, data, error } = await apiJson('/api/auth/manual-login', { method:'POST', headers: JSON_HDR, body: JSON.stringify({ apiKey, name }) });
  if (ok && data.status === 'success') { hideLoginModal(); document.getElementById('loginApiKey').value=''; loadAccounts(); fetchStatus(); }
  else { errEl.innerText = (data && data.error) || error || '登录失败'; errEl.classList.remove('hidden'); }
}

async function loadAccounts() {
  const grid = document.getElementById('accountsGrid');
  showSkeletonIfEmpty(grid, skeletonCards(2, 60));
  // 账号列表与额度并行取：额度失败只降级（不显示额度徽标），不阻塞账号卡片。
  const [accRes, usageRes] = await Promise.all([apiJson('/api/accounts'), apiJson('/api/usage/aggregate')]);
  const { ok, data, error } = accRes;
  if (!ok || !Array.isArray(data.accounts)) {
    // 后端 500 时 data 形如 {error:...}，照原样 .map 会 TypeError，网格停在旧列表上 ——
    // 于是"删除账号失败"在界面上的表现是"点了没反应"。
    grid.innerHTML = '<div class="col-span-full text-amber-400 text-sm">账号列表读取失败：'
      + esc(error || (data && data.error) || '响应缺少 accounts 字段') + '</div>';
    return;
  }
  if (!data.accounts.length) { grid.innerHTML = emptyState('fa-users-gear', '暂无账号，用右上角按钮添加第一个账号'); return; }
  // account.id -> 额度数据映射，供卡片渲染额度徽标。
  const usageById = {};
  if (usageRes.ok && usageRes.data && Array.isArray(usageRes.data.accountsUsage)) {
    usageRes.data.accountsUsage.forEach(u => { if (u.account && u.account.id) usageById[u.account.id] = u; });
  }
  grid.innerHTML = data.accounts.map(acc =>
    '<div class="bg-slate-900 border ' + (acc.isActive ? 'border-indigo-500 shadow-lg shadow-indigo-500/10' : 'border-slate-800') + ' p-5 rounded-xl space-y-3">' +
      '<div class="flex items-center justify-between">' +
        '<div class="flex items-center space-x-3">' +
          '<div class="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-bold text-xs">' + esc((acc.name||'?').charAt(0).toUpperCase()) + '</div>' +
          '<div><h4 class="font-bold text-sm text-white flex items-center gap-2">' + esc(acc.name) +
          (acc.isActive ? ' <span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">当前</span>' : '') +
          ' ' + (acc.userName || acc.email ? badge('OAuth', 'sky', '浏览器授权登录的账号') : badge('API Key', 'slate', '手动粘贴 API Key 的账号')) +
          '</h4><p class="text-xs text-slate-400">' + esc(acc.userName ? '@'+acc.userName : (acc.email || 'API Key')) + '</p></div>' +
        '</div>' +
        '<div class="flex items-center space-x-2">' +
          (!acc.isActive ? '<button data-action="activate" data-id="' + esc(acc.id) + '" class="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-indigo-400 rounded-lg border border-slate-700">设为当前</button>' : '') +
          '<button data-action="delete" aria-label="移除该账号" data-id="' + esc(acc.id) + '" class="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition"><i aria-hidden="true" class="fa-solid fa-trash-can text-xs"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">' +
        '<span>Key：<code class="font-mono text-slate-300">' + esc(acc.apiKeyMasked) + '</code></span>' +
        '<span class="flex items-center gap-1.5">' + quotaBadge(usageById[acc.id]) + '<span>添加于：' + esc(new Date(acc.addedAt).toLocaleDateString()) + '</span></span>' +
      '</div>' +
    '</div>'
  ).join('');
}

// 账号卡片按钮走事件委托：不用内联 onclick 拼 JS 字符串，转义面更小。
function bindAccountActionsOnce() {
  const grid = document.getElementById('accountsGrid');
  if (!grid || grid.dataset.bound) return;
  grid.dataset.bound = '1';
  grid.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    const id = btn.dataset.id || '';
    if (btn.dataset.action === 'activate') setActiveAcc(id);
    else if (btn.dataset.action === 'delete') deleteAcc(id);
  });
}

// 三个写操作都必须看结果：后端现在失败会返回 500，而这里此前把响应整个丢掉、
// 无条件重载列表，用户看到"已切换/已删除"但其实没写进 config.json。
async function setActiveAcc(id){ const {ok,error}=await apiJson('/api/accounts/active',{method:'POST',headers:JSON_HDR,body:JSON.stringify({accountId:id})}); if(!ok){ showToast('切换账号失败：'+error,'error'); } loadAccounts(); fetchStatus(); }
async function deleteAcc(id){ if(!(await uiConfirm('确定移除该账号？'))) return; const {ok,error}=await apiJson('/api/accounts/delete',{method:'POST',headers:JSON_HDR,body:JSON.stringify({accountId:id})}); if(!ok){ showToast('删除账号失败：'+error,'error'); } else { showToast('账号已移除','success'); } loadAccounts(); fetchStatus(); }
async function changeRotationMode(mode){ const {ok,error}=await apiJson('/api/accounts/rotation',{method:'POST',headers:JSON_HDR,body:JSON.stringify({rotationMode:mode})}); if(!ok){ showToast('保存轮转模式失败：'+error+'（下拉框将在下次轮询被弹回）','error'); } loadAccounts(); fetchStatus(); }

// 账号额度徽标：5h 窗口使用率，数据来自 /api/usage/aggregate 的原样转发。
// credits 缺失或无上限（cap<=0）时不显示，避免把「未知」画成「正常」。
function quotaBadge(u) {
  const w = u && u.credits && u.credits.windowLimits && u.credits.windowLimits.fiveHour;
  const cap = w ? Number(w.cap) || 0 : 0;
  if (!w || cap <= 0) return '';
  const pct = Math.round((Number(w.used) || 0) / cap * 100);
  if (pct >= 90) return badge('额度告急', 'rose', '5 小时窗口已用 ' + pct + '%');
  if (pct >= 70) return badge('额度偏高', 'amber', '5 小时窗口已用 ' + pct + '%');
  return badge('额度正常', 'emerald', '5 小时窗口已用 ' + pct + '%');
}

// T210：多上游账号（Freebuff / WorkBuddy）。数据源 GET /api/providers 与
// GET /api/providers/:name/accounts（listAccounts 契约：凭据已脱敏）。
// T301：WorkBuddy 卡片增「添加账号（授权）」入口（面板内完成 OAuth）与「待刷新」徽章。
let wbPendingRefresh = new Set();   // 刷新连续失败、需重新授权的账号 id
let wbRealmChoice = 'cn';           // 最近一次选择的 realm（重渲染后保留）
let wbLoginBusy = false;            // 授权轮询进行中（防重复发起）
let wbBalanceSnapshot = null;       // F07：最近一次 GET /api/upstreams/workbuddy/balance 的快照
let wbBalanceBusy = false;          // 手动刷新进行中（防重复点击）

function workbuddyAddFooter() {
  return '<div class="flex items-center gap-2 pt-1">' +
    '<label for="wbLoginRealm" class="sr-only">WorkBuddy 授权区服</label>' +
    '<select id="wbLoginRealm" class="text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-200">' +
    '<option value="cn"' + (wbRealmChoice === 'cn' ? ' selected' : '') + '>国内版（codebuddy.cn）</option>' +
    '<option value="global"' + (wbRealmChoice === 'global' ? ' selected' : '') + '>国际版（workbuddy.ai）</option>' +
    '</select>' +
    '<button type="button" data-wb-action="login" class="text-xs px-3 py-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20">' +
    '<i aria-hidden="true" class="fa-solid fa-user-plus mr-1"></i>添加账号（授权）</button></div>';
}

async function startWorkBuddyLogin() {
  if (wbLoginBusy) { showToast('授权流程正在进行中，请先完成或等待超时', 'info'); return; }
  // realm 以 wbRealmChoice 为准：下拉框按它渲染 selected，change 事件同步回写。
  // 不从 DOM 回读 id（该 select 是动态渲染的，静态 id 引用会被面板回归测试判为悬空）。
  const started = await apiJson('/api/upstreams/workbuddy/login/start', {
    method: 'POST', headers: JSON_HDR, body: JSON.stringify({ realm: wbRealmChoice }),
  });
  if (!started.ok) { showToast('发起授权失败：' + started.error, 'error'); return; }
  const url = started.data && started.data.url;
  const state = started.data && started.data.state;
  if (!url || !state) { showToast('授权响应缺少 url/state，请检查 sidecar 版本', 'error'); return; }
  showToast('已生成授权链接，请在浏览器完成后返回本页', 'info');
  try { window.open(url, '_blank', 'noopener'); } catch (e) { /* 弹窗被拦：用户可从地址栏重开 */ }
  wbLoginBusy = true;
  const deadline = Date.now() + 15 * 60 * 1000;
  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      const polled = await apiJson('/api/upstreams/workbuddy/login/poll?state=' + encodeURIComponent(state));
      if (!polled.ok) {
        if (/unknown or expired/.test(polled.error || '')) { showToast('授权会话已过期，请重新发起', 'error'); return; }
        continue; // 瞬时故障：继续轮询
      }
      if (polled.data && polled.data.done) {
        showToast('账号已添加：' + (polled.data.nickname || polled.data.uid || '（未命名）'), 'success');
        loadMultiSourceAccounts(); fetchStatus();
        return;
      }
    }
    showToast('授权超时（15 分钟），请重新发起', 'error');
  } finally { wbLoginBusy = false; }
}

// ─── F07：WorkBuddy 账号池可视化的「积分条」──────────────────────────────────
// 数据源 GET /api/upstreams/workbuddy/balance（T302 的只读镜像；真正的刷新执行者是
// sidecar，网关只是镜像 + 原子持久化）。两条语义红线：
// 1. **未知 ≠ 0**：credits / creditsTotal 缺失时画不成进度条，也不能把 undefined 当 0
//    算成「已用光」；creditsTotal <= 0 同样算不出百分比。此时只报余量原值（可能也是「—」）。
// 2. **degraded 必须显式标红**：镜像不可信（从未成功 / 连续失败 / 损坏未重建）时，
//    这批数字只是最后一次已知值，不能当实时余额展示。
function formatCredits(v) {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '—';
}

function creditsBar(entry) {
  const { credits, creditsTotal } = entry;
  if (typeof credits !== 'number' || typeof creditsTotal !== 'number' || creditsTotal <= 0) {
    return '<p class="text-xs text-slate-400">余量：<span class="text-slate-200 font-semibold">' + esc(formatCredits(credits)) + '</span></p>';
  }
  const pct = Math.max(0, Math.min(100, Math.round(credits / creditsTotal * 100)));
  const tone = pct <= 10 ? 'bg-rose-500' : (pct <= 30 ? 'bg-amber-500' : 'bg-emerald-500');
  const expiring = typeof entry.creditsExpiring === 'number' && entry.creditsExpiring > 0
    ? '<p class="text-[10px] text-amber-300">即将过期：' + esc(formatCredits(entry.creditsExpiring)) + ' 积分' +
      (typeof entry.earliestExpiry === 'number' ? '（最早 ' + esc(new Date(entry.earliestExpiry).toLocaleDateString()) + '）' : '') + '</p>'
    : '';
  return '<div class="space-y-1">' +
    '<div class="flex items-center justify-between text-xs text-slate-400"><span>余量 <span class="text-slate-200 font-semibold">' +
    esc(formatCredits(credits)) + '</span> / ' + esc(formatCredits(creditsTotal)) + '</span><span>' + pct + '%</span></div>' +
    '<div class="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
    '<div class="h-full ' + tone + '" style="width:' + pct + '%"></div></div>' + expiring + '</div>';
}

/** 池状态徽章（T302 落盘的 paused/disabled/cooling 三态，此前只有后端有）。 */
function poolStateBadges(entry) {
  const out = [];
  if (entry.paused) out.push(badge('暂停', 'amber', '该账号在池中被暂停，不参与派发'));
  if (entry.disabled) out.push(badge('停用', 'rose', '该账号已停用（凭据失效或人工摘除）'));
  if (entry.cooling) out.push(badge('冷却中', 'slate', '连续失败进入冷却，冷却期内不派发'));
  return out.join(' ');
}

function workbuddyBalancePanel(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.accounts)) return '';
  const degraded = snapshot.degraded === true;
  const head = '<div class="flex items-center justify-between">' +
    '<p class="text-xs font-bold text-slate-300">WorkBuddy 账号池 · 积分</p>' +
    '<button type="button" data-wb-action="refresh-balance" aria-label="立即刷新 WorkBuddy 积分镜像"' +
    (wbBalanceBusy ? ' disabled' : '') +
    ' class="text-[10px] px-2 py-1 rounded border border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700 transition">' +
    (wbBalanceBusy ? '刷新中…' : '刷新积分') + '</button></div>' +
    '<p class="text-[10px] text-slate-500">最近成功刷新：' +
    esc(snapshot.refreshedAt ? new Date(snapshot.refreshedAt).toLocaleString() : '—') +
    ' · 间隔 ' + esc(Math.round((Number(snapshot.intervalMs) || 0) / 60000)) + ' 分钟</p>';
  const warn = degraded
    ? '<p class="text-xs text-rose-300"><i aria-hidden="true" class="fa-solid fa-triangle-exclamation"></i> 积分镜像不可信（' +
      esc(snapshot.degradedReason || '刷新失败') + '），下面是最后一次已知值</p>'
    : '';
  const rows = snapshot.accounts.length
    ? '<div class="space-y-2">' + snapshot.accounts.map(e => {
        const title = e.nickname || e.uid || '（未命名）';
        return '<div class="inset-card rounded-lg px-3 py-2 space-y-1">' +
          '<div class="flex items-center justify-between gap-2"><span class="text-xs text-slate-200">' + esc(title) + '</span>' +
          '<span class="flex items-center gap-1">' + poolStateBadges(e) + '</span></div>' +
          creditsBar(e) + '</div>';
      }).join('') + '</div>'
    : '<p class="text-xs text-slate-500">池内暂无账号（积分镜像为空）</p>';
  return '<div class="space-y-2 border-t border-slate-800/80 pt-2 mt-2">' + head + warn + rows + '</div>';
}

async function refreshWorkBuddyBalance() {
  if (wbBalanceBusy) return;
  wbBalanceBusy = true;
  try {
    const r = await apiJson('/api/upstreams/workbuddy/balance/refresh', { method: 'POST' });
    if (r.ok) showToast('WorkBuddy 积分已刷新', 'success');
    else showToast('刷新积分失败：' + (r.error || 'sidecar 暂不可用，镜像保持上次已知值'), 'error');
  } finally { wbBalanceBusy = false; }
  loadMultiSourceAccounts();
}

function bindWorkBuddyActionsOnce() {
  const body = document.getElementById('multiSourceAccountsBody');
  if (!body || body.dataset.wbBound) return;
  body.dataset.wbBound = '1';
  body.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-wb-action]') : null;
    if (!btn) return;
    if (btn.dataset.wbAction === 'login') void startWorkBuddyLogin();
    else if (btn.dataset.wbAction === 'refresh-balance') void refreshWorkBuddyBalance();
  });
  body.addEventListener('change', (e) => {
    const sel = e.target;
    if (sel instanceof HTMLSelectElement && sel.id === 'wbLoginRealm') wbRealmChoice = sel.value === 'global' ? 'global' : 'cn';
  });
}

async function loadMultiSourceAccounts() {
  const body = document.getElementById('multiSourceAccountsBody');
  if (!body) return;
  const { ok, data, error } = await apiJson('/api/providers');
  if (!ok) { body.innerHTML = emptyState('fa-triangle-exclamation', '加载多上游账号失败：' + error); return; }
  const providers = (data.providers || []).filter(p => p.name !== 'commandcode' && p.configured && p.initialized);
  if (!providers.length) {
    body.innerHTML = emptyState('fa-server', '暂无其它上游 Provider（Freebuff / WorkBuddy 未配置或未接线）');
    return;
  }
  // T301：取「待刷新」集合（刷新连续失败需重新授权的号），供账号行徽章使用。
  wbPendingRefresh = new Set();
  wbBalanceSnapshot = null;
  if (providers.some(p => p.name === 'workbuddy')) {
    // 待刷新集合与积分镜像并行取：镜像失败只降级（不渲染积分条），不阻塞账号列表。
    const [t, b] = await Promise.all([
      apiJson('/api/upstreams/workbuddy/tokens'),
      apiJson('/api/upstreams/workbuddy/balance'),
    ]);
    if (t.ok && t.data && Array.isArray(t.data.pendingRefresh)) wbPendingRefresh = new Set(t.data.pendingRefresh);
    if (b.ok && b.data) wbBalanceSnapshot = b.data;
  }
  const parts = await Promise.all(providers.map(async p => {
    const r = await apiJson('/api/providers/' + encodeURIComponent(p.name) + '/accounts');
    const rows = (r.ok && r.data && r.data.accounts) || [];
    const isWb = p.name === 'workbuddy';
    const list = rows.length
      ? '<div class="space-y-1.5">' + rows.map(a =>
          '<div class="flex items-center justify-between inset-card rounded-lg px-3 py-2 text-xs">' +
          '<span class="text-slate-200">' + esc(a.name || a.id) + '</span>' +
          '<span class="flex items-center gap-2 font-mono text-slate-400">' +
          (isWb && wbPendingRefresh.has(a.id) ? badge('待刷新', 'rose', '刷新连续失败，请重新授权该账号') : '') +
          esc(a.apiKey || '凭据不出上游侧') + '</span></div>').join('') + '</div>'
      : '<p class="text-xs text-slate-500">该上游暂无账号' + (isWb ? '（点击下方「添加账号（授权）」完成 OAuth 登录）' : '') + '</p>';
    return '<div class="space-y-2"><p class="text-xs font-bold text-slate-300">' + esc(p.displayName) +
      '（' + esc(p.name) + '）· ' + rows.length + ' 个账号</p>' + list +
      (isWb ? workbuddyBalancePanel(wbBalanceSnapshot) + workbuddyAddFooter() : '') + '</div>';
  }));
  body.innerHTML = '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">' + parts.join('') + '</div>';
  bindWorkBuddyActionsOnce();
}
registerRefresh('accounts', loadMultiSourceAccounts, 30000);
function enter_accounts() { loadAccounts(); loadMultiSourceAccounts(); }
bindAccountActionsOnce();
