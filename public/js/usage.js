// =============================================================================
// 多上游 AI 网关面板 · 用量与额度页（usage.js）—— 路由 #/usage
// -----------------------------------------------------------------------------
// 官方用量总览（Total Tokens / Runs / 成功率 / 月度限额）、5 小时 / 每周 / 计费周期
// 三个额度窗口、会话明细表（过滤 / 排序 / 行下钻 / CSV 导出）、每日趋势与模型分布
// 图表、项目与会话归因、端到端性能表、峰谷计费提示。
// =============================================================================

// 当前选中的账号与最近一次 /api/usage/aggregate 结果（额度页多个渲染入口共用）。
let selectedUsageAccountId = '';
let globalUsageCache = [];

async function loadUsageInit() {
  loadUsageOverview();
  const { ok, data, error } = await apiJson('/api/usage/aggregate');
  const select = document.getElementById('usageAccountSelect');
  if (!ok || !Array.isArray(data.accountsUsage)) {
    globalUsageCache = [];
    select.innerHTML = '';
    showToast('额度数据读取失败：' + (error || '响应缺少 accountsUsage'), 'error');
    return;
  }
  globalUsageCache = data.accountsUsage;
  select.innerHTML = globalUsageCache.map(u => { const a = u.account || {}; return '<option value="' + esc(orDash(a.id)) + '">' + esc(orDash(a.name)) + ' (' + esc(orDash(a.apiKeyMasked)) + ')' + (a.isActive?' [当前]':'') + '</option>'; }).join('');
  // 选中的账号可能已被删除：不在列表里就回落到第一个，否则下拉框空白而卡片
  // 还留着上一个账号的数字。
  if (!globalUsageCache.some(u => u.account && u.account.id === selectedUsageAccountId)) {
    selectedUsageAccountId = globalUsageCache.length > 0 ? globalUsageCache[0].account.id : null;
  }
  select.value = selectedUsageAccountId || '';
  renderUsageForAccount(selectedUsageAccountId);
}

// ─── 官方用量总览（Total Tokens / Total Runs / 成功率 / 月度限额）──────────────

function ovFmtNum(n){ return Number(n || 0).toLocaleString('en-US'); }
function ovFmtCost(v){ const c = Number(v || 0); return '$' + (c >= 1 ? c.toFixed(2) : c.toFixed(4).replace(/0+$/, '').replace(/.$/, '')); }
function ovFmtPct(p){ return (Math.round((Number(p) || 0) * 10) / 10) + '%'; }
function ovFmtDate(ms){
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '--';
  const p = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// 进度条统一上色：宽度与颜色都走内联样式，布局交给 .meter，覆盖时不会丢样式。
function paintMeter(id, pct, base){
  const el = document.getElementById(id);
  if (!el) return;
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  el.style.width = p + '%';
  el.style.minWidth = p > 0 ? '0.5rem' : '0';
  el.style.background = p >= 90 ? 'var(--c-danger)' : p >= 70 ? 'var(--c-warn)' : base;
}

async function loadUsageOverview() {
  const accEl = document.getElementById('ovPeriod');
  try {
    const { ok, data: d, error } = await apiJson('/api/usage/overview');
    if (!ok || (d && d.error)) {
      const msg = (d && d.error) || error || '未知错误';
      accEl.innerText = String(msg);
      // 之前这里 return 但四张卡片留着上一次的成功数值，且没有任何"这是旧数据"的
      // 标记；出错时至少让卡片显式存疑。
      ['ovTotalTokens','ovTotalRuns','ovSuccessRate'].forEach(id => { const e=document.getElementById(id); if(e) e.innerText='—'; });
      const det = document.getElementById('ovTokensDetail'); if (det) det.innerText = '';
      return;
    }
    const s = d.summary || {};
    document.getElementById('ovTotalTokens').innerText = ovFmtNum(s.totalTokens);
    document.getElementById('ovTokensDetail').innerText = '输入 ' + ovFmtNum(s.totalTokensIn) + ' · 输出 ' + ovFmtNum(s.totalTokensOut);
    document.getElementById('ovTotalRuns').innerText = ovFmtNum(s.totalRuns);
    document.getElementById('ovRunsDetail').innerText = '成功 ' + ovFmtNum(s.completedCount) + ' · 失败 ' + ovFmtNum(s.failedCount);
    document.getElementById('ovSuccessRate').innerText = s.successRate != null ? ovFmtPct(s.successRate) : '--';
    accEl.innerText = s.periodBasis === 'last-30-days' ? '统计口径：近 30 天' : '统计口径：当前计费月';

    const mo = (d.limits || {}).monthly;
    if (mo && mo.cap > 0) {
      document.getElementById('ovMonthly').innerText = ovFmtPct(mo.pct);
      const bar = document.getElementById('ovMonthlyBar');
      bar.style.width = Math.min(100, Math.max(0, mo.pct)) + '%';
      bar.className = 'h-1.5 rounded-full transition-all duration-500 ' + (mo.pct >= 90 ? 'bg-rose-500' : mo.pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500');
      document.getElementById('ovMonthlyDetail').innerText = '已用 ' + ovFmtCost(mo.used) + ' / ' + ovFmtCost(mo.cap) + ' · 剩余 ' + ovFmtCost(mo.remaining);
    } else {
      document.getElementById('ovMonthly').innerText = '无限制';
      document.getElementById('ovMonthlyDetail').innerText = '按量计费';
    }

    const pl = d.plan;
    if (pl) {
      document.getElementById('cyclePlan').innerText = pl.name ? '· ' + pl.name : '';
      document.getElementById('cycleRenew').innerText = pl.cancelAtPeriodEnd ? '到期不续费' : '到期自动续费';
      document.getElementById('cycleDays').innerText = (pl.daysLeft != null) ? pl.daysLeft : '--';
      const cpct = Math.min(100, Math.max(0, Number(pl.cyclePct) || 0));
      paintMeter('cycleBar', cpct, 'var(--c-success)');
      document.getElementById('cycleRange').innerText = (pl.currentPeriodStart && pl.currentPeriodEnd)
        ? ovFmtDate(pl.currentPeriodStart) + ' → ' + ovFmtDate(pl.currentPeriodEnd) + ' · 已过 ' + ovFmtPct(pl.cyclePct)
        : '周期时间未知';
    } else {
      document.getElementById('cyclePlan').innerText = '';
      document.getElementById('cycleRenew').innerText = '--';
      document.getElementById('cycleDays').innerText = '--';
      document.getElementById('cycleRange').innerText = '无法获取订阅信息';
    }
  } catch (e) { accEl.innerText = '总览加载失败'; }
}

function renderUsageForAccount(accId) {
  selectedUsageAccountId = accId;
  const t = globalUsageCache.find(u => u.account.id === accId) || globalUsageCache[0];
  if (!t) return;
  const credits = t.credits?.credits || {};
  document.getElementById('creditMonthly').innerText = '$' + (credits.monthlyCredits||0).toFixed(2);
  document.getElementById('creditPurchased').innerText = '$' + (credits.purchasedCredits||0).toFixed(2);
  document.getElementById('creditFree').innerText = '$' + (credits.freeCredits||0).toFixed(2);
  document.getElementById('creditTotalCost').innerText = '$' + (t.summary?.totalCost||0).toFixed(2);

  // 先全部重置成"无数据"再按分支填充：下面两个窗口块都只有 if 没有 else，
  // 切到一个没有 windowLimits 的账号时，屏上会留着**上一个账号**的 $x/$y 与进度条。
  document.getElementById('window5hText').innerText = '无数据';
  document.getElementById('window5hReset').innerText = '';
  document.getElementById('windowWeeklyText').innerText = '无数据';
  document.getElementById('windowWeeklyReset').innerText = '';
  paintMeter('window5hBar', 0, 'var(--c-accent)');
  paintMeter('windowWeeklyBar', 0, 'var(--c-violet)');

  const w5h = t.credits?.windowLimits?.fiveHour;
  if (w5h) {
    // 上游字段直接来自 /api/usage/aggregate 的原样转发，缺字段或字符串化都要能撑住：
    // 此前 w5h.used.toFixed(2) 一旦拿到 undefined/字符串就抛错，整个用量标签页留白。
    const u5 = Number(w5h.used) || 0, c5 = Number(w5h.cap) || 0;
    document.getElementById('window5hText').innerText = '$' + u5.toFixed(2) + ' / $' + c5.toFixed(2);
    const ratio = c5 > 0 ? (u5/c5)*100 : 0;
    paintMeter('window5hBar', ratio, 'var(--c-accent)');
    const mins = w5h.resetAt ? Math.max(0,Math.ceil((Number(w5h.resetAt)-Date.now())/60000)) : 0;
    document.getElementById('window5hReset').innerText = '重置时间：'+mins+' 分钟';
    // 燃烧速率预测：由官方 used 的时间差分外推（本地历史只覆盖代理流量，
    // 不能用来预测全账号额度）。
    const proj = usageHistoryCache && usageHistoryCache.quotaProjection;
    const pNote = document.getElementById('window5hProjection');
    if (pNote) {
      // 四个分支里只有告警分支设 className，导致变过一次红之后
      // "采样中"/"当前无消耗"这些正常状态仍挂着告警色，看着像长期警报。
      pNote.className = 'win-note';
      if (!proj || proj.samples < 2 || proj.burnPerHour == null) {
        pNote.innerText = '速率预测：采样中（需 10 分钟以上数据）';
      } else if (proj.burnPerHour <= 0) {
        pNote.innerText = '速率预测：当前无消耗';
      } else if (proj.willHitCapBeforeReset === true) {
        pNote.className = 'win-note warn';
        pNote.innerHTML = '<i aria-hidden="true" class="fa-solid fa-triangle-exclamation"></i> 按当前 $' + proj.burnPerHour.toFixed(2) + '/h，约 <b>' + fmtDur(proj.minutesToCap) + '</b>后撞上限额（早于重置）';
      } else {
        pNote.className = 'win-note';
        pNote.innerText = '按当前 $' + proj.burnPerHour.toFixed(2) + '/h 约需 ' + fmtDur(proj.minutesToCap) + ' 用完 · 重置更早到来';
      }
    }
  }
  const wk = t.credits?.windowLimits?.weekly;
  if (wk) {
    const uw = Number(wk.used) || 0, cw = Number(wk.cap) || 0;
    document.getElementById('windowWeeklyText').innerText = '$' + uw.toFixed(2) + ' / $' + cw.toFixed(2);
    const ratio = cw > 0 ? (uw/cw)*100 : 0;
    paintMeter('windowWeeklyBar', ratio, 'var(--c-violet)');
    const hrs = wk.resetAt ? Math.max(0,Math.ceil((Number(wk.resetAt)-Date.now())/3600000)) : 0;
    document.getElementById('windowWeeklyReset').innerText = '重置时间：'+hrs+' 小时';
  }
}

// ─── 会话明细 ────────────────────────────────────────────────────────────────
let usageTrendChart = null;
let usageModelChart = null;
let usageHistoryCache = null;

function fmtTokens(n){ if(!n) return '0'; if(n>=1000000){var x=n/1000000; return (x%1===0?x:x.toFixed(1))+'M';} if(n>=1000){var k=n/1000; return (k%1===0?k:k.toFixed(1))+'K';} return String(n); }
function fmtTokensM(n){ if(!n) return '0'; var x=n/1000000; return (x>=100?Math.round(x):x>=10?x.toFixed(1):x.toFixed(2))+'M'; }
function fmtUsd(v){ return '$' + (v||0).toFixed(4); }
function fmtUsdShort(v){ var x=v||0; if(x>=1000) return '$'+(x/1000).toFixed(2)+'k'; if(x>=1) return '$'+x.toFixed(2); return '$'+x.toFixed(4); }
function fmtMs(ms){ if(!ms) return '--'; if(ms>=60000){var m=Math.floor(ms/60000),s=(ms%60000)/1000; return m+'m '+s.toFixed(1)+'s';} if(ms>=1000) return (ms/1000).toFixed(1)+'s'; return Math.round(ms)+'ms'; }
function fmtDur(mins){ if(mins==null) return '--'; if(mins>=1440) return Math.floor(mins/1440)+'天'; if(mins>=60) return Math.floor(mins/60)+'h '+String(mins%60).padStart(2,'0')+'m'; return mins+'m'; }
// 服务端同名的展示函数在前端不可用，这里用等价实现：只取路径末段
// （完整路径可能含用户名，默认不直接展示，悬停才看全路径）。
function projectDisplayName(p){ if(!p) return '未识别'; var parts=String(p).split(/[\/]/).filter(Boolean); return parts.length?parts[parts.length-1]:String(p); }
// 端到端吞吐：口径与后端 throughputTokS 一致（含排队/重试/网络，非模型生成速度）。
function fmtTokS(out, ms){ if(!out||out<=0||!ms||ms<=0) return '<span class="text-slate-600">—</span>'; var v=out/(ms/1000); return v.toFixed(1)+' t/s'; }
function fmtTime(ts){ try { const d=new Date(ts); return d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); } catch { return ts; } }

async function loadUsageHistory(){
  showSkeletonIfEmpty(document.getElementById('usageTableBody'), skeletonRows(10, 6));
  showSkeletonIfEmpty(document.getElementById('perfTableBody'), skeletonRows(6, 4));
  showSkeletonIfEmpty(document.getElementById('projectTableBody'), skeletonRows(4, 4));
  showSkeletonIfEmpty(document.getElementById('sessionTableBody'), skeletonRows(4, 4));
  const { ok, data: hist, error } = await apiJson('/api/usage/history');
  if (!ok) { showToast('用量历史读取失败：' + error, 'error'); return; }
  usageHistoryCache = hist;
  const data = usageHistoryCache;
  const s = data.total;

  document.getElementById('usageTodayToken').innerText = fmtTokensM(data.today.input + data.today.output) + ' token';
  document.getElementById('usageTodayRuns').innerText = data.today.runs + ' 次请求';
  document.getElementById('usageWeekCost').innerText = fmtUsd(data.week.cost);
  document.getElementById('usageWeekToken').innerText = fmtTokensM(data.week.input + data.week.output) + ' token · ' + data.week.runs + ' 次';
  document.getElementById('usageMonthCost').innerText = fmtUsd(data.month.cost);
  document.getElementById('usageMonthToken').innerText = fmtTokensM(data.month.input + data.month.output) + ' token · ' + data.month.runs + ' 次';
  document.getElementById('usageTotalToken').innerText = fmtTokensM(s.inputTokens + s.outputTokens) + ' token';
  document.getElementById('usageTotalRuns').innerText = s.runs + ' 次请求 · 失败 ' + s.failures;

  // 缓存节省：命中缓存的输入按缓存读单价计费（约输入价的 1/50），
  // 这里显示相比"全价输入"省下的金额 —— 解释账单为何远低于直觉值。
  const savEl = document.getElementById('usageSavings');
  const savNote = document.getElementById('usageSavingsNote');
  if (savEl) {
    const saved = s.savingsUsd || 0;
    savEl.innerText = saved > 0 ? fmtUsdShort(saved) : '--';
    if (saved > 0) {
      const mult = s.savingsMultiple || 0;
      savNote.innerText = mult > 0
        ? '约为账面成本 ' + fmtUsdShort(s.costUsd || 0) + ' 的 ' + mult.toFixed(1) + ' 倍'
        : '相比全价输入省下';
    } else {
      savNote.innerText = '暂无缓存命中记录';
    }
  }

  // 缓存命中率：agent 场景常达 90%+，是成本远低于"输入×输入价"的主因。
  const hitEl = document.getElementById('usageCacheHit');
  if (hitEl) {
    const rate = (s.cacheHitRate || 0) * 100;
    hitEl.innerText = rate > 0
      ? '缓存命中 ' + rate.toFixed(1) + '% · ' + fmtTokensM(s.cacheReadTokens || 0) + ' token'
      : '缓存命中 --';
  }

  renderBillingWindow(data.billing);

  const hasAnyPricing = (data.recent||[]).some(r => r.hasPricing);
  document.getElementById('usagePricingNote').classList.toggle('hidden', hasAnyPricing);
  usageRows = data.recent || [];
  bindUsageTableOnce();
  bindUsageFilterOnce();
  renderUsageTableCurrent();
  renderUsageCharts(data);
  renderAttribution(data);
  renderModelPerf(data.byModelPerf||[]);
}

// 每模型端到端吞吐/延迟分布。失败的请求不计入。
// 吞吐与延迟的样本口径不同：输出过短（<32 token）的响应会让 tok/s 的分母趋零，
// 得出几千 t/s 的无意义比值，因此只进延迟统计、不进吞吐统计。「样本」列显示延迟
// 样本数，悬停可看到吞吐样本数。
function renderModelPerf(rows){
  const body = document.getElementById('perfTableBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = emptyState('fa-gauge-high', '暂无性能数据：成功请求后这里显示吞吐与延迟分布', 6);
    return;
  }
  body.innerHTML = rows.slice(0, 20).map(r => {
    const t = v => (v==null ? '<span class="text-slate-600">—</span>' : v.toFixed(1)+' t/s');
    const l = v => (v==null ? '<span class="text-slate-600">—</span>' : (v>=1000 ? (v/1000).toFixed(1)+'s' : Math.round(v)+'ms'));
    // 旧后端（尚未重启、payload 里还没有 throughputSamples）时回退到 samples，
    // 保持「闸门关闭」的旧观感，而不是把每一行都标成被筛选。
    const hasGate = r.throughputSamples != null;
    const ts = hasGate ? r.throughputSamples : r.samples;
    const gated = hasGate && r.throughputSamples === 0;
    const tip = hasGate
      ? '吞吐样本 ' + ts + '（仅计输出 ≥32 token）· 延迟样本 ' + r.samples
      : '延迟样本 ' + r.samples;
    return '<tr class="hover:bg-slate-800/40 transition">' +
      '<td class="px-2 py-2 font-mono text-slate-200 truncate max-w-[260px]" title="' + esc(r.model) + '">' + esc(r.model) + '</td>' +
      '<td class="px-2 py-2 text-right ' + (gated ? 'text-slate-600' : 'text-slate-400') + '" title="' + esc(tip) + '">' + r.samples +
        (gated ? ' <i aria-hidden="true" class="fa-solid fa-filter text-[9px]"></i>' : '') + '</td>' +
      '<td class="px-2 py-2 text-right text-slate-300">' + t(r.tokSP50) + '</td>' +
      '<td class="px-2 py-2 text-right text-slate-400">' + t(r.tokSP95) + '</td>' +
      '<td class="px-2 py-2 text-right text-slate-300">' + l(r.latencyP50Ms) + '</td>' +
      '<td class="px-2 py-2 text-right text-slate-400">' + l(r.latencyP95Ms) + '</td>' +
    '</tr>';
  }).join('');
}

// 项目（推断）与会话（声明）两个维度的呈现。
// 关键：推断值必须与事实值在视觉上区分，不能让用户误以为是权威数据。
function renderAttribution(data){
  const a = data.attribution || {};
  const projBody = document.getElementById('projectTableBody');
  const sessBody = document.getElementById('sessionTableBody');

  // ── 项目 ──
  const projects = data.byProject || [];
  const cov = document.getElementById('projectCoverage');
  if (cov) {
    const n = projects.filter(p => p.project).length;
    cov.innerText = n + ' 个项目 · 已归因 ' + (a.projectsIdentified||0) + '/' + (a.totalRecords||0) + ' 条';
  }
  if (projBody) {
    if (!projects.length) {
      projBody.innerHTML = emptyState('fa-folder-tree', '暂无项目归因数据', 4);
    } else {
      projBody.innerHTML = projects.slice(0, 50).map(p => {
        const name = p.project ? projectDisplayName(p.project) : '未识别';
        // 置信度徽章：label = 较可靠；heuristic = 明确标记为推测
        let badge = '';
        if (p.projectSource === 'label') {
          badge = '<span class="ml-1 px-1 py-0.5 rounded text-[9px] bg-sky-500/10 text-sky-400 border border-sky-500/20" title="来自 system prompt 的工作目录字段">标签</span>';
        } else if (p.projectSource === 'heuristic') {
          badge = '<span class="ml-1 px-1 py-0.5 rounded text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20" title="按路径出现频次推测，不保证准确">推测</span>';
        }
        const title = p.project ? ' title="' + esc(p.project) + '"' : '';
        const dim = p.project ? 'text-slate-200' : 'text-slate-500 italic';
        return '<tr class="hover:bg-slate-800/40 transition">' +
          '<td class="px-2 py-2 truncate max-w-[220px]"><span class="' + dim + '"' + title + '>' + esc(name) + '</span>' + badge + '</td>' +
          '<td class="px-2 py-2 text-right text-slate-400">' + p.runs + (p.sessionCount ? ' <span class="text-slate-600">/' + p.sessionCount + '会话</span>' : '') + '</td>' +
          '<td class="px-2 py-2 text-right text-slate-400">' + fmtTokensM((p.inputTokens||0)+(p.outputTokens||0)) + '</td>' +
          '<td class="px-2 py-2 text-right text-emerald-400">' + fmtUsdShort(p.costUsd) + '</td>' +
        '</tr>';
      }).join('');
    }
  }

  // ── 会话 ──
  const sessions = data.bySession || [];
  const scov = document.getElementById('sessionCoverage');
  if (scov) {
    scov.innerText = sessions.length + ' 个会话 · 已识别 ' + (a.sessionsIdentified||0) + '/' + (a.totalRecords||0) + ' 条';
  }
  if (sessBody) {
    if (!sessions.length) {
      sessBody.innerHTML = emptyState('fa-comments', '暂无携带会话 ID 的请求', 4);
    } else {
      sessBody.innerHTML = sessions.slice(0, 50).map(s => {
        const shortId = esc(String(s.sessionId).slice(0, 8));
        const pname = s.project ? esc(projectDisplayName(s.project)) : '<span class="text-slate-600">—</span>';
        const pTitle = s.project ? ' title="' + esc(s.project) + (s.projectSource === 'heuristic' ? '（推测）' : '') + '"' : '';
        const typeBadge = s.sessionType && s.sessionType !== 'main'
          ? '<span class="ml-1 px-1 py-0.5 rounded text-[9px] bg-violet-500/10 text-violet-400 border border-violet-500/20">' + esc(s.sessionType) + '</span>'
          : '';
        const span = fmtDur(Math.max(0, Math.round((new Date(s.lastAt) - new Date(s.firstAt)) / 60000)));
        return '<tr class="hover:bg-slate-800/40 transition">' +
          '<td class="px-2 py-2"><span class="font-mono text-slate-200" title="' + esc(s.sessionId) + '">' + shortId + '</span>' + typeBadge +
            '<span class="block text-[10px] text-slate-500">' + (s.agent ? esc(s.agent) + ' · ' : '') + span + '</span></td>' +
          '<td class="px-2 py-2 text-slate-400 truncate max-w-[120px]"><span' + pTitle + '>' + pname + '</span></td>' +
          '<td class="px-2 py-2 text-right text-slate-400">' + s.runs + '</td>' +
          '<td class="px-2 py-2 text-right text-emerald-400">' + fmtUsdShort(s.costUsd) + '</td>' +
        '</tr>';
      }).join('');
    }
  }
}

// 峰谷计费提示：官方对部分模型（deepseek 系列）设分时价，
// 峰时为 UTC 周一至周五 01–04 与 06–10。此处提示当前档位与切换倒计时。
function renderBillingWindow(billing){
  const el = document.getElementById('billingWindow');
  if (!el) return;
  const w = billing && billing.window;
  const models = (billing && billing.models) || [];
  if (!w || !models.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');

  const peak = !!w.isPeak;
  const tone = peak
    ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
    : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300';
  const icon = peak ? 'fa-solid fa-fire' : 'fa-solid fa-leaf';
  const label = peak ? '峰时计费中' : '谷时计费中';

  let when = '';
  if (w.minutesUntilChange != null) {
    when = ' · ' + fmtDur(w.minutesUntilChange) + '后转为' + (w.nextIsPeak ? '峰时' : '谷时');
  }

  // 各模型当前生效费率（只列有分时价的模型，通常 4 个）。
  const rows = models.map(m => {
    const a = m.activeRates || {};
    return '<span class="inline-flex items-center gap-1.5 inset-card rounded px-2 py-1">' +
      '<span class="text-slate-300 font-mono">' + esc(m.id) + '</span>' +
      '<span class="text-slate-500">输入</span><span class="text-slate-200">' + fmtPrice(a.input) + '</span>' +
      '<span class="text-slate-500">输出</span><span class="text-slate-200">' + fmtPrice(a.output) + '</span>' +
      '<span class="text-slate-500">缓存读</span><span class="text-slate-200">' + fmtPrice(a.cacheRead) + '</span>' +
    '</span>';
  }).join('');

  const windowsNote = w.windows ? '官方窗口：' + esc(w.windows) + ' UTC' + (w.peakHoursPerDay ? '（' + w.peakHoursPerDay + 'h/天）' : '') : '';

  el.innerHTML =
    '<div class="border ' + tone + ' rounded-lg p-3">' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<span class="font-semibold text-xs"><i aria-hidden="true" class="' + icon + '"></i> ' + label + '</span>' +
        '<span class="text-xs opacity-90">' + when + '</span>' +
        (windowsNote ? '<span class="text-[11px] opacity-70 ml-auto">' + windowsNote + '</span>' : '') +
      '</div>' +
      '<div class="flex gap-2 flex-wrap mt-2 text-[11px]">' + rows + '</div>' +
    '</div>';
}

async function exportUsageCsv() {
  // 表格里的 usageHistoryCache 只有展示用的最近 200 条；导出必须另取全量，否则
  // "已导出 N 条"报的是被服务端截断之后的数字，拿去对账的人拿到的是残缺文件。
  const { ok, data, error } = await apiJson('/api/usage/history?limit=50000');
  if (!ok) { showToast('导出失败：' + error, 'error'); return; }
  const rows = Array.isArray(data.recent) ? data.recent : [];
  if (!rows.length) { showToast('暂无可导出的记录', 'info'); return; }
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['timestamp','model','inputTokens','cacheReadTokens','outputTokens','timingMs','costUsd','costSource','status','mode','sessionId','project'];
  const lines = [head.join(',')].concat(rows.map(r => [r.timestamp, r.model, r.inputTokens || 0, r.cacheReadTokens || 0, r.outputTokens || 0, r.timingMs || 0,
    r.costUsd || 0, r.costSource || '', r.status, r.mode, r.sessionId || '', r.project || ''].map(q).join(',')));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'commandcode-usage-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  const stored = data.storedRecords || rows.length;
  showToast(rows.length < stored
    ? '已导出最近 ' + rows.length + ' 条（本地共留存 ' + stored + ' 条，更早的已被轮转清理）'
    : '已导出 ' + rows.length + ' 条记录', 'success');
}

// --- 请求明细：过滤 / 排序 / 行下钻 -------------------------------------------
// 默认零状态：不过滤、不排序（保持后端时间倒序）、行全部收起 —— 首屏与旧版一致。
let usageRows = [];
let usageSortKey = '';
let usageSortDir = -1;
let usageFilterQ = '';
const usageExpanded = new Set();
// 可排序列与表头 id 后缀；吞吐列口径复杂（输出/端到端耗时计算值），不参与排序。
const USAGE_SORT_COLS = [
  ['ts', '时间'], ['inputTokens', '输入'], ['cacheReadTokens', '缓存命中'],
  ['outputTokens', '输出'], ['timingMs', '耗时'], ['costUsd', '成本'],
];
function usageRowKey(r) {
  return r.timestamp + '|' + r.model + '|' + (r.inputTokens || 0) + '|' + (r.outputTokens || 0) + '|' + (r.timingMs || 0);
}
function usageMatchesQuery(r, q) {
  if (!q) return true;
  const hay = [(r.model || ''), (r.status || ''), (r.mode || ''), (r.sessionId || ''), (r.project || ''), (r.costSource || '')].join(' ').toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(kw => hay.includes(kw));
}
function sortUsageRows(rows) {
  if (!usageSortKey) return rows; // 默认：后端顺序（时间倒序）
  const val = (r) => usageSortKey === 'ts' ? (new Date(r.timestamp).getTime() || 0) : (Number(r[usageSortKey]) || 0);
  const dir = usageSortDir === 1 ? 1 : -1;
  return rows.slice().sort((a, b) => (val(a) - val(b)) * dir);
}
// 行下钻详情：全部走 esc() / 既有格式化函数，不裸拼上游字段。
function usageDetailHtml(r) {
  const dash = '<span class="text-slate-600">—</span>';
  const item = (k, v) => '<span class="text-slate-500">' + k + '</span><span class="text-slate-300 break-all">' + v + '</span>';
  return '<div class="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 px-4 py-2 text-[11px] bg-slate-950/60">'
    + item('会话', r.sessionId ? esc(r.sessionId) : dash)
    + item('项目', r.project ? esc(projectDisplayName(r.project)) + (r.projectSource === 'heuristic' ? ' <span class="text-amber-400">（推测）</span>' : '') : dash)
    + item('缓存读', fmtTokens(r.cacheReadTokens || 0) + ' token')
    + item('成本口径', r.costSource === 'official' ? '官方账单' : (r.costSource === 'estimated' ? '本地估算' : '—'))
    + item('本地估算', r.estimatedCostUsd != null ? '$' + (r.estimatedCostUsd || 0).toFixed(6) : dash)
    + item('原始时间戳', esc(r.timestamp))
    + '</div>';
}
function toggleUsageDetail(key) {
  if (usageExpanded.has(key)) usageExpanded.delete(key); else usageExpanded.add(key);
  renderUsageTableCurrent();
}
function toggleUsageSort(key) {
  if (usageSortKey !== key) { usageSortKey = key; usageSortDir = -1; }
  else if (usageSortDir === -1) usageSortDir = 1;
  else { usageSortKey = ''; usageSortDir = -1; }
  updateUsageSortIndicators();
  renderUsageTableCurrent();
}
function updateUsageSortIndicators() {
  USAGE_SORT_COLS.forEach(pair => {
    const th = document.getElementById('usage-th-' + pair[0]);
    if (!th) return;
    const arrow = th.querySelector('.th-arrow');
    if (arrow) arrow.textContent = usageSortKey === pair[0] ? (usageSortDir === 1 ? '\u2191' : '\u2193') : '';
    th.setAttribute('aria-sort', usageSortKey === pair[0] ? (usageSortDir === 1 ? 'ascending' : 'descending') : 'none');
  });
}
function renderUsageTableCurrent() {
  const q = usageFilterQ.trim().toLowerCase();
  renderUsageTable(sortUsageRows(usageRows.filter(r => usageMatchesQuery(r, q))), usageRows.length);
}
function renderUsageTable(rows, totalCount) {
  const body = document.getElementById('usageTableBody');
  const empty = document.getElementById('usageEmpty');
  const countEl = document.getElementById('usageRecentCount');
  if (countEl) countEl.innerText = '最近 ' + totalCount + ' 条' + (rows.length !== totalCount ? ' · 命中 ' + rows.length + ' 条' : '');
  if (!rows.length) {
    // 有数据但被过滤光 → 过滤空态；真没数据 → 原静态空提示。
    body.innerHTML = totalCount ? '<tr><td colspan="10">' + emptyState('fa-magnifying-glass', '没有匹配的请求，试试清除过滤条件') + '</td></tr>' : '';
    empty.classList.toggle('hidden', !!totalCount);
    return;
  }
  empty.classList.add('hidden');
  body.innerHTML = rows.map(r => {
    const key = usageRowKey(r);
    const open = usageExpanded.has(key);
    const badge = r.status === 'FAILED'
      ? '<span class="px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">失败</span>'
      : '<span class="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">完成</span>';
    const pc = r.hasPricing ? '' : '<span class="text-amber-400" title="未同步官方定价">*</span>';
    const mode = r.mode === 'messages' ? 'Messages' : 'Chat';
    // 官方账单金额优先，本地估算加 "~" 前缀区分；悬停显示本地估算值便于对照。
    const src = r.costSource === 'official' ? '' : '~';
    const costTip = r.estimatedCostUsd != null && r.costSource === 'official'
      ? ' title="官方账单；本地估算 $' + (r.estimatedCostUsd || 0).toFixed(6) + '"'
      : (r.costSource === 'estimated' ? ' title="本地按官方定价估算（上游未返回账单金额）"' : '');
    const cache = r.cacheReadTokens || 0;
    const cacheCell = cache > 0
      ? '<span class="text-sky-400" title="缓存命中 ' + cache.toLocaleString('en-US') + ' / 输入 ' + (r.inputTokens || 0).toLocaleString('en-US') + '">' +
          fmtTokens(cache) + ' <span class="text-slate-500">(' + Math.round(cache / Math.max(1, r.inputTokens || 1) * 100) + '%)</span></span>'
      : '<span class="text-slate-600">—</span>';
    return '<tr class="hover:bg-slate-800/40 transition cursor-pointer" data-key="' + esc(key) + '" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '" title="点击展开/收起详情">' +
      '<td class="px-4 py-2.5 whitespace-nowrap text-slate-300">' + esc(fmtTime(r.timestamp)) + '</td>' +
      '<td class="px-4 py-2.5 text-slate-200 font-mono">' + esc(r.model) + '</td>' +
      '<td class="px-4 py-2.5 text-right text-slate-300">' + fmtTokens(r.inputTokens) + '</td>' +
      '<td class="px-4 py-2.5 text-right">' + cacheCell + '</td>' +
      '<td class="px-4 py-2.5 text-right text-slate-300">' + fmtTokens(r.outputTokens) + '</td>' +
      '<td class="px-4 py-2.5 text-right text-slate-400">' + fmtTokS(r.outputTokens, r.timingMs) + '</td>' +
      '<td class="px-4 py-2.5 text-right text-slate-400">' + fmtMs(r.timingMs) + '</td>' +
      '<td class="px-4 py-2.5 text-right text-emerald-400"' + costTip + '>' + src + fmtUsd(r.costUsd) + pc + '</td>' +
      '<td class="px-4 py-2.5">' + badge + '</td>' +
      '<td class="px-4 py-2.5 text-slate-400">' + mode + '</td>' +
    '</tr>' + (open ? '<tr class="usage-detail"><td colspan="10">' + usageDetailHtml(r) + '</td></tr>' : '');
  }).join('');
}
// 行点击/回车下钻：事件委托绑一次；tr 自身聚焦时才响应键盘，避免吃掉行内控件事件。
function bindUsageTableOnce() {
  const body = document.getElementById('usageTableBody');
  if (!body || body.dataset.bound) return;
  body.dataset.bound = '1';
  body.addEventListener('click', (e) => {
    const tr = e.target instanceof Element ? e.target.closest('tr[data-key]') : null;
    if (tr) toggleUsageDetail(tr.dataset.key);
  });
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target instanceof Element ? e.target.closest('tr[data-key]') : null;
    // 仅行自身聚焦时响应；closest 往上找是为了不受未来行内控件影响。
    if (!tr || tr !== e.target) return;
    e.preventDefault();
    toggleUsageDetail(tr.dataset.key);
  });
}
function bindUsageFilterOnce() {
  const input = document.getElementById('usageFilterInput');
  const clearBtn = document.getElementById('usageFilterClear');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = '1';
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      usageFilterQ = input.value;
      if (clearBtn) clearBtn.classList.toggle('hidden', !usageFilterQ);
      renderUsageTableCurrent();
    }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; usageFilterQ = ''; if (clearBtn) clearBtn.classList.add('hidden'); renderUsageTableCurrent(); }
  });
  if (clearBtn) clearBtn.onclick = () => { input.value = ''; usageFilterQ = ''; clearBtn.classList.add('hidden'); input.focus(); renderUsageTableCurrent(); };
}

function renderUsageCharts(data){
  // 每日趋势
  const tctx = document.getElementById('usageTrendChart').getContext('2d');
  if (usageTrendChart) usageTrendChart.destroy();
  usageTrendChart = new Chart(tctx, {
    type: 'line',
    data: {
      labels: data.byDay.map(d => d.date),
      datasets: [
        { label:'输入', data: data.byDay.map(d => d.inputTokens), borderColor:'#818cf8', backgroundColor:'rgba(129,140,248,.1)', fill:true, tension:.3, pointRadius:2 },
        { label:'输出', data: data.byDay.map(d => d.outputTokens), borderColor:'#34d399', backgroundColor:'rgba(52,211,153,.1)', fill:true, tension:.3, pointRadius:2 }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{ labels:{ color:'#94a3b8', font:{size:11} } }, tooltip:{ backgroundColor:'#0f172a', borderColor:'#334155', borderWidth:1 } },
      scales:{ x:{ ticks:{ color:'#64748b', font:{size:10} }, grid:{ color:'rgba(51,65,85,.3)' } }, y:{ ticks:{ color:'#64748b', font:{size:10} }, grid:{ color:'rgba(51,65,85,.3)' }, beginAtZero:true } }
    }
  });

  // 模型分布
  const mctx = document.getElementById('usageModelChart').getContext('2d');
  if (usageModelChart) usageModelChart.destroy();
  const palette = ['#818cf8','#34d399','#f59e0b','#f472b6','#38bdf8','#a78bfa','#fb923c'];
  usageModelChart = new Chart(mctx, {
    type: 'doughnut',
    data: {
      labels: data.byModel.map(m => m.model),
      datasets: [{
        data: data.byModel.map(m => m.runs),
        backgroundColor: data.byModel.map((_,i) => palette[i % palette.length]),
        borderColor:'#0f172a', borderWidth:2
      }]
    },
    options: {
      responsive:true, maintainAspectRatio:false, cutout:'55%',
      plugins:{ legend:{ labels:{ color:'#94a3b8', font:{size:11} } }, tooltip:{ backgroundColor:'#0f172a', borderColor:'#334155', borderWidth:1, callbacks:{ label: c => ' ' + c.label + ' · ' + c.parsed + ' 次' } } }
    }
  });
}

async function clearUsageHistory(){
  if(!(await uiConfirm('确定清空全部会话历史？此操作不可撤销。'))) return;
  const {ok,error}=await apiJson('/api/usage/clear',{method:'POST'});
  if(!ok){ showToast('清空失败：'+error,'error'); } else { showToast('会话历史已清空','success'); }
  loadUsageHistory();
}

// T212：分上游口径（§3.9）。数据源 GET /api/usage/by-provider（本地用量历史聚合）；
// 成本列按上游口径分别渲染：commandcode 记美元、freebuff 免费、workbuddy 积分，
// 不做跨上游加总。
const PROVIDER_LABELS = { commandcode: 'CommandCode', freebuff: 'Freebuff', workbuddy: 'WorkBuddy' };
function providerCostCell(r) {
  if (r.provider === 'commandcode') return '$' + Number(r.costUsd || 0).toFixed(4);
  if (r.provider === 'freebuff') return (r.native && r.native.freeSessionSec) ? (Math.round(r.native.freeSessionSec) + 's 免费') : '免费';
  if (r.native && r.native.points) return r.native.points + ' pts';
  return '积分（暂无记录）';
}
async function loadProviderUsage() {
  const body = document.getElementById('providerUsageBody');
  if (!body) return;
  const { ok, data, error } = await apiJson('/api/usage/by-provider');
  if (!ok) { body.innerHTML = emptyState('fa-triangle-exclamation', '加载分上游口径失败：' + error); return; }
  const rows = data.summary || [];
  if (!rows.length) { body.innerHTML = emptyState('fa-chart-pie', '暂无用量记录'); return; }
  body.innerHTML = '<div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr class="text-slate-400 text-left">' +
    '<th scope="col" class="py-1.5 pr-3 font-medium">上游</th><th scope="col" class="py-1.5 pr-3 font-medium">请求数</th>' +
    '<th scope="col" class="py-1.5 pr-3 font-medium">输入 tokens</th><th scope="col" class="py-1.5 pr-3 font-medium">输出 tokens</th>' +
    '<th scope="col" class="py-1.5 pr-3 font-medium">缓存读</th><th scope="col" class="py-1.5 font-medium">成本口径</th></tr></thead><tbody>' +
    rows.map(r => '<tr class="border-t border-slate-800">' +
      '<td class="py-1.5 pr-3 text-slate-200 font-semibold">' + esc(PROVIDER_LABELS[r.provider] || r.provider) + '</td>' +
      '<td class="py-1.5 pr-3 text-slate-300">' + esc(r.runs) + '</td>' +
      '<td class="py-1.5 pr-3 text-slate-300">' + esc(Number(r.inputTokens || 0).toLocaleString('en-US')) + '</td>' +
      '<td class="py-1.5 pr-3 text-slate-300">' + esc(Number(r.outputTokens || 0).toLocaleString('en-US')) + '</td>' +
      '<td class="py-1.5 pr-3 text-slate-300">' + esc(Number(r.cacheReadTokens || 0).toLocaleString('en-US')) + '</td>' +
      '<td class="py-1.5 text-emerald-400 font-medium">' + esc(providerCostCell(r)) + '</td></tr>').join('') +
    '</tbody></table></div>';
}
function enter_usage() { loadUsageInit(); loadUsageHistory(); loadProviderUsage(); }
registerRefresh('usage', loadUsageHistory, 30000);
registerRefresh('usage', loadProviderUsage, 30000);
