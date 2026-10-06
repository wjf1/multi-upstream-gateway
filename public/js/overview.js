// =============================================================================
// CommandCode 代理面板 · 总览页（overview.js）—— 路由 #/overview
// -----------------------------------------------------------------------------
// header 引擎状态与启停、总览统计卡、运行能力可见性（通道健康 / 运行开关）、
// 概览今日用量速览，以及 T110 首启引导卡片（纯前端：仅用 /api/status 既有字段，
// 字段不足或请求失败时降级为静态指引；不改后端响应结构）。
// =============================================================================

// 最近一次**成功**轮询到的引擎状态。toggleEngine 用它取反，而不是再 GET 一次
// （GET-then-invert 会让快速连点两次提交同一个值）。
let lastEngineRunning = true;

async function fetchStatus() {
  const { ok, data, error } = await apiJson('/api/status');
  const dot = document.getElementById('statusDot'), txt = document.getElementById('statusText'), btn = document.getElementById('toggleBtnText');
  if (!ok) {
    // 此前整个函数包在 try{}catch{} 里，代理挂掉时这几行永远停在最后一次成功状态，
    // 头部状态胶囊可以连续几小时谎报"引擎运行中"。
    // 只改文字、不弹 toast：这个函数 5s 轮一次，弹出来会刷屏。
    dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500';
    txt.innerText = String(error);
    txt.className = 'font-medium text-amber-400';
    // 状态读取失败时引导卡片降级为通用步骤（数据源不可信）。
    renderOnboardCard(null);
    return;
  }
  if (data.running === undefined) {
    // 拿到 200 但没有 running 字段：宁可显式存疑，也不要把 undefined 当成"已停止"，
    // 那会让按钮文案与实际相反。
    dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500';
    txt.innerText = '状态字段缺失';
    txt.className = 'font-medium text-amber-400';
  } else {
    lastEngineRunning = !!data.running;
    if (data.running) { dot.className='w-2.5 h-2.5 rounded-full bg-emerald-500'; txt.innerText='引擎运行中'; txt.className='font-medium text-emerald-400'; btn.innerText='停止引擎'; }
    else { dot.className='w-2.5 h-2.5 rounded-full bg-rose-500'; txt.innerText='引擎已停止'; txt.className='font-medium text-rose-400'; btn.innerText='启动引擎'; }
    // 头部徽标跟随真实版本号（/api/status 返回 PROXY_VERSION）；拿不到就保持占位 "v4"。
    if (data.version) {
      const vb = document.getElementById('versionBadge');
      if (vb) vb.innerText = 'v' + data.version;
    }
  }
  document.getElementById('statPort').innerText = 'Port :' + orDash(data.port);
  document.getElementById('statUptime').innerText = '运行时间：' + orDash(data.uptime);
  document.getElementById('statAccount').innerText = data.activeAccountName || '无';
  document.getElementById('statAccountsCount').innerText = '已注册 ' + orDash(data.accountsCount) + ' 个账号';
  const bindEl = document.getElementById('statBind');
  if (data.boundNonLoopback && !data.authRequired) {
    bindEl.className = 'text-xl font-bold text-rose-400 mt-1 break-all';
    bindEl.innerText = orDash(data.host) + '（未鉴权暴露！）';
    bindEl.title = '已绑定到非回环地址且未设置 PROXY_API_KEY：局域网内任何人都可以调用 API 并管理本网关（增删账号、清空历史）。建议设置 PROXY_API_KEY，或改回 127.0.0.1。';
  } else {
    bindEl.className = 'text-xl font-bold text-emerald-400 mt-1 break-all';
    bindEl.innerText = data.host === '0.0.0.0' ? '0.0.0.0（局域网）' : orDash(data.host);
    bindEl.title = '';
  }
  document.getElementById('statAuth').innerText = 'API 鉴权：' + (data.authRequired ? '开' : '关');
  const ub = document.getElementById('updateBadge');
  if (ub && data.update && data.update.available) {
    ub.classList.remove('hidden');
    document.getElementById('updateVer').innerText = data.update.latest;
  }
  document.getElementById('statModels').innerText = orDash(data.modelsCount);
  document.getElementById('statActiveAccounts').innerText = orDash(data.accountsCount);
  document.getElementById('statActiveDetail').innerText = '当前：' + (data.activeAccountName || '无');
  // 轮转模式下拉只在后端真的给了值时回写，否则会把用户刚选的选择框重置成 undefined。
  if (data.rotationMode) document.getElementById('rotationSelect').value = data.rotationMode;
  renderOnboardCard(data);
  // T106：风险告知门状态以服务端为准（acceptedRiskDisclaimer），未确认时首屏弹窗。
  maybeShowRiskGate(data);
}

// 概览页「今日请求 / 今日成本」速览：复用既有 /api/usage/history 的 today 汇总，
// 不新增后端端点。静默失败：概览页 30s 轮询，弹 toast 会刷屏。
async function loadOverviewUsage() {
  const { ok, data } = await apiJson('/api/usage/history');
  if (!ok || !data || !data.today) return;
  document.getElementById('statTodayRuns').innerText = ovFmtNum(data.today.runs);
  document.getElementById('statTodayCost').innerText = '成本 ' + fmtUsdShort(data.today.cost || 0);
}

// ─── 运行能力可见性：通道健康 + 运行开关（/api/features，纯只读）──────────────
// 4.21.0 起的一批默认关闭/旁路能力（健康检查、webhook、prompt 版本、限流、
// 模型访问、审计）此前只在日志可见；这里挂进概览页 30s 轮询做只读展示，
// 无任何修改控件。失败/告警着色统一走语义色板变量（--c-warn / --c-danger）。
function fmtInterval(ms) {
  const n = Number(ms) || 0;
  if (n >= 60000) return (n / 60000) + ' 分钟';
  if (n >= 1000) return (n / 1000) + ' 秒';
  return n + ' ms';
}
// 开关徽标：开启=accent 色、关闭=灰，全部走语义色板变量（不用 Tailwind 硬编码色）。
function featFlag(on) {
  return on
    ? '<span class="text-[10px] px-2 py-0.5 rounded border font-semibold shrink-0" style="color:var(--c-accent-2);border-color:var(--c-accent);background:rgba(99,102,241,.12)">开启</span>'
    : '<span class="text-[10px] px-2 py-0.5 rounded border font-semibold shrink-0" style="color:var(--c-text-mute);border-color:var(--c-line);background:var(--c-inset-soft)">关闭</span>';
}
// 名称与 detail 里的动态值必须先 esc 再拼接。
function featRow(name, on, detail) {
  return '<div class="flex items-start justify-between gap-3 py-2 border-t border-slate-800/60">' +
    '<div class="min-w-0"><p class="text-xs font-semibold text-slate-200">' + name + '</p>' +
    (detail ? '<p class="text-[11px] text-slate-400 mt-0.5 break-all">' + detail + '</p>' : '') + '</div>' +
    featFlag(on) + '</div>';
}
function renderChannelHealth(hc) {
  const el = document.getElementById('healthCardBody');
  if (!el) return;
  if (!hc || hc.enabled !== true) {
    el.innerHTML = emptyState('fa-heart-pulse', '探活未启用（设置 HEALTH_CHECK_INTERVAL_MS 后开启）');
    return;
  }
  const ch = hc.channel;
  // 启动后还没跑过第一个探活周期：lastResult 为 null，显式说"等待首次探活"。
  if (!ch || !ch.lastResult) {
    el.innerHTML = emptyState('fa-hourglass-half', '等待首次探活（每 ' + esc(fmtInterval(hc.intervalMs)) + ' 一轮）');
    return;
  }
  const last = ch.lastResult;
  const ok = last.ok === true;
  const failures = Number(ch.consecutiveFailures) || 0;
  const up = Number(ch.uptimePercent);
  const cell = (label, valueHtml) =>
    '<div class="inset-card-soft rounded-lg p-3"><p class="text-[11px] text-slate-400 font-medium">' + label + '</p>' +
    '<div class="text-sm font-bold mt-1">' + valueHtml + '</div></div>';
  const stateHtml = ok
    ? '<span style="color:var(--c-success)"><i aria-hidden="true" class="fa-solid fa-circle-check"></i> 成功' + (last.status != null ? ' · HTTP ' + esc(last.status) : '') + '</span>'
    : '<span style="color:var(--c-danger-2)"><i aria-hidden="true" class="fa-solid fa-circle-xmark"></i> 失败' + (last.status != null ? ' · HTTP ' + esc(last.status) : '（网络层）') + '</span>';
  // 连续失败 ≥2 是后端开始告警的阈值，用 danger；单次抖动用 warn；健康用 success。
  const failColor = failures >= 2 ? 'var(--c-danger-2)' : failures > 0 ? 'var(--c-warn)' : 'var(--c-success)';
  el.innerHTML =
    '<div class="grid grid-cols-2 gap-2">' +
      cell('最近探活', stateHtml) +
      cell('延迟', (last.durationMs != null ? esc(last.durationMs) : '—') + (last.durationMs != null ? ' ms' : '')) +
      cell('连续失败', '<span style="color:' + failColor + '">' + failures + ' 次</span>') +
      cell('可用率', '<span style="color:' + (up < 100 ? 'var(--c-warn)' : 'var(--c-success)') + '">' + esc(up) + '%</span>') +
    '</div>' +
    (!ok && last.error ? '<p class="text-[11px] mt-2 break-all" style="color:var(--c-warn)">失败原因：' + esc(last.error) + '</p>' : '') +
    (last.at ? '<p class="text-[11px] text-slate-500 mt-2">探活时刻：' + esc(fmtTime(last.at)) + '</p>' : '');
}
function renderFeatureFlags(d) {
  const el = document.getElementById('featuresCardBody');
  if (!el) return;
  const hc = d.healthCheck || {};
  const wh = d.webhook || {};
  const pv = d.promptVersions || {};
  const rl = d.rateLimit || {};
  const ma = d.modelAccess || {};
  const al = d.auditLog || {};
  const whParts = [];
  if (wh.costThreshold != null) whParts.push('成本 ≥ $' + esc(wh.costThreshold));
  if (wh.errorRateThreshold != null) whParts.push('错误率 ≥ ' + esc(Math.round(Number(wh.errorRateThreshold) * 1000) / 10) + '%');
  const mode = String(ma.mode || 'off');
  const modeNames = { allowlist: '白名单模式（MODEL_ALLOWLIST）', blocklist: '黑名单模式（MODEL_BLOCKLIST）' };
  const listHtml = Array.isArray(ma.list) && ma.list.length ? '：' + esc(ma.list.join(', ')) : '';
  el.innerHTML =
    featRow('通道健康检查', hc.enabled === true, '每 ' + esc(fmtInterval(hc.intervalMs)) + ' 探活一次（HEALTH_CHECK_INTERVAL_MS）') +
    featRow('Webhook 告警', wh.enabled === true,
      whParts.length ? whParts.join(' · ') + '（WEBHOOK_URL 已配置，地址不回显）' : '未配置 WEBHOOK_URL') +
    featRow('Prompt 版本', pv.enabled === true,
      pv.enabled ? '快照目录：' + esc(pv.dir) : '设置 PROMPT_VERSIONS=on 后启用') +
    featRow('请求限流', rl.rpm != null || rl.tpm != null,
      (rl.rpm != null ? 'RPM ' + esc(rl.rpm) : 'RPM 未设') + ' · ' + (rl.tpm != null ? 'TPM ' + esc(rl.tpm) : 'TPM 未设')) +
    featRow('模型访问控制', mode !== 'off',
      (modeNames[mode] || esc(mode)) + listHtml + (mode === 'off' ? '（未设置名单，全部放行）' : '')) +
    featRow('审计日志', al.enabled === true, '落盘路径：' + esc(al.path || '—'));
}
async function loadFeatures() {
  const healthEl = document.getElementById('healthCardBody');
  const featEl = document.getElementById('featuresCardBody');
  if (!healthEl || !featEl) return;
  showSkeletonIfEmpty(healthEl, skeletonCards(1, 40));
  showSkeletonIfEmpty(featEl, skeletonCards(1, 40));
  const { ok, data, error } = await apiJson('/api/features');
  if (!ok || !data) {
    // 30s 轮询静默降级：不弹 toast 刷屏，卡片里显式存疑即可。
    const msg = '运行能力状态读取失败：' + (error || '响应缺少数据');
    healthEl.innerHTML = emptyState('fa-plug-circle-exclamation', msg);
    featEl.innerHTML = emptyState('fa-plug-circle-exclamation', msg);
    return;
  }
  renderChannelHealth(data.healthCheck);
  renderFeatureFlags(data);
}

async function refreshOverview() {
  await Promise.all([fetchStatus(), loadOverviewUsage(), loadFeatures()]);
  showToast('状态已刷新', 'success');
}

async function toggleEngine() {
  const want = !lastEngineRunning;
  const { ok, data, error } = await apiJson('/api/gateway/toggle', {
    method: 'POST', headers: JSON_HDR, body: JSON.stringify({ running: want }),
  });
  if (!ok) { showToast('切换引擎状态失败：' + error, 'error'); fetchStatus(); return; }
  // 以后端回显为准，而不是假设它一定按我们提交的值改了。
  if (data && data.running !== undefined) lastEngineRunning = !!data.running;
  showToast(want ? '引擎已启动' : '引擎已暂停，新的 /v1/* 请求会被拒绝', want ? 'success' : 'info');
  fetchStatus();
}

// ─── 首启引导卡片（T110，纯前端，不改 /api/status）───────────────────────────
// 判定依据（仅用 status 现有字段）：accountsCount===0 → 缺账号；hasApiKey=false →
// 活动凭据未就绪；boundNonLoopback && !authRequired → 风险门未关。
// CREDENTIAL_ENCRYPTION_KEY 是否已设置面板无法探测（响应无该字段），以静态指引
// 文案提示用户自查。data 为 null（状态请求失败）→ 降级为通用三步指引并注明原因。
function renderOnboardCard(data) {
  const el = document.getElementById('onboardCard');
  if (!el) return;
  if (data && data.accountsCount > 0 && data.hasApiKey) {
    el.dataset.state = 'ok';
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  if (!data) {
    el.dataset.state = 'fallback';
    el.innerHTML =
      '<div class="flex items-start gap-3">' +
        '<i aria-hidden="true" class="fa-solid fa-circle-info text-amber-400 mt-0.5"></i>' +
        '<div class="space-y-2 text-xs text-slate-300">' +
          '<p class="font-semibold text-sm text-white">首次使用指引 <span class="text-[11px] font-normal text-slate-500">（无法读取网关状态，以下为通用步骤）</span></p>' +
          '<ol class="list-decimal ml-4 space-y-1 text-slate-300">' +
            '<li>按需设置环境变量：<code class="font-mono text-slate-200">PROXY_API_KEY</code>（保护数据面）与 <code class="font-mono text-slate-200">CREDENTIAL_ENCRYPTION_KEY</code>（账号凭据加密存储，建议设置）。</li>' +
            '<li>在「账号与鉴权」页添加 Command Code 账号（浏览器 OAuth 登录或粘贴 API Key）。</li>' +
            '<li>确认风险门：网关绑定 127.0.0.1，或已设置 PROXY_API_KEY。</li>' +
          '</ol>' +
        '</div>' +
      '</div>';
    return;
  }
  const risk = data.boundNonLoopback && !data.authRequired;
  el.dataset.state = data.accountsCount === 0 ? 'no-accounts' : 'no-credential';
  const step = (n, icon, html) =>
    '<li class="flex items-start gap-2"><span class="shrink-0 w-5 h-5 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 text-[11px] font-bold flex items-center justify-center">' + n + '</span>' +
    '<i aria-hidden="true" class="fa-solid ' + icon + ' text-slate-500 text-[11px] mt-1"></i><div class="text-xs text-slate-300">' + html + '</div></li>';
  el.innerHTML =
    '<div class="flex items-start justify-between gap-3 flex-wrap">' +
      '<div class="flex items-start gap-3">' +
        '<i aria-hidden="true" class="fa-solid fa-rocket text-indigo-400 mt-1"></i>' +
        '<div>' +
          '<p class="font-semibold text-sm text-white">完成三步，启用网关</p>' +
          '<p class="text-[11px] text-slate-400 mt-0.5">检测到账号或凭据尚未就绪，按顺序操作即可。</p>' +
        '</div>' +
      '</div>' +
      '<a href="#/accounts" class="btn-solid px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition shrink-0"><i aria-hidden="true" class="fa-solid fa-users-gear"></i> 去账号与鉴权页</a>' +
    '</div>' +
    '<ol class="mt-3 space-y-2">' +
      step(1, 'fa-terminal',
        '设置环境变量：<code class="font-mono text-slate-200">CREDENTIAL_ENCRYPTION_KEY</code>（账号凭据加密存储，建议设置；面板无法探测该变量是否已生效，请自查进程环境）与 <code class="font-mono text-slate-200">PROXY_API_KEY</code>（保护 /v1/* 数据面与管理面边界）。') +
      step(2, 'fa-users-gear',
        (data.accountsCount === 0
          ? '在「账号与鉴权」页添加账号：浏览器 OAuth 登录，或直接粘贴 API Key。'
          : '账号已添加（' + esc(String(data.accountsCount)) + ' 个），但活动凭据尚未就绪（hasApiKey=false），请确认账号状态或重新登录。')) +
      step(3, 'fa-shield-halved',
        risk
          ? '<span class="text-rose-300 font-semibold">风险门未关：</span>网关绑定在非回环地址且未设置 PROXY_API_KEY，局域网内任何人可调用并管理本网关。请设置 PROXY_API_KEY 或改回 127.0.0.1。'
          : '确认风险门：网关绑定 127.0.0.1（回环），或已设置 PROXY_API_KEY。当前配置安全。') +
    '</ol>';
}

// 首屏立即取数（defer 脚本执行时 DOM 已就绪）；此后由刷新调度接管。
fetchStatus();
loadOverviewUsage();
loadFeatures();
registerRefresh('*', fetchStatus, 5000);
registerRefresh('overview', () => { loadOverviewUsage(); loadFeatures(); }, 30000);
