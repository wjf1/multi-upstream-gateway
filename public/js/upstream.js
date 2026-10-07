// =============================================================================
// 上游管理页（T209）+ 总览异常横幅（T208）—— 多上游 Provider 面板
// -----------------------------------------------------------------------------
// 数据源：GET /api/providers（T213 阶段 1/2：状态 / 总闸 / sidecar 进程视图 /
// defaultProvider）。写操作：POST /api/providers/:name/{enable,disable} 与
// POST /api/providers/default（经 core.js 的 fetch 包装自动附 x-admin-token）。
//
// 横幅（T213 DoD 收口项）：`renderProviderBanner` 在全局轮询（'*' 15s）与进入
// 上游页时刷新——「已配置 + 已初始化 + 已启用但 health 不健康」的 Provider 会让
// 概览页顶部出现告警横幅，恢复后自动消失。动态文本一律 esc。
// =============================================================================
function providerStateBadge(p) {
  if (!p.configured) return '<span class="text-xs font-bold px-2 py-0.5 rounded bg-slate-500/10 text-slate-400 border border-slate-500/20">未配置</span>';
  if (!p.initialized) return '<span class="text-xs font-bold px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">初始化失败</span>';
  if (!p.enabled) return '<span class="text-xs font-bold px-2 py-0.5 rounded bg-slate-500/10 text-slate-400 border border-slate-500/20">已停用</span>';
  if (p.health && p.health.healthy) return '<span class="text-xs font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">健康</span>';
  return '<span class="text-xs font-bold px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">异常</span>';
}

function providerMetricTile(label, value, tone) {
  const tones = { ok: 'text-emerald-400', bad: 'text-rose-400', plain: 'text-slate-200' };
  return '<div class="p-2.5 inset-card rounded-lg text-center"><p class="text-[10px] text-slate-500">' + esc(label) + '</p><p class="text-sm font-bold ' + (tones[tone] || tones.plain) + ' mt-0.5">' + esc(value) + '</p></div>';
}

function providerCard(p, defaultName) {
  const isDefault = p.name === defaultName;
  const h = p.health || {};
  const total = typeof h.total === 'number' ? h.total : 0;
  const disabled = typeof h.disabledCount === 'number' ? h.disabledCount : 0;
  const cooling = typeof h.cooldownCount === 'number' ? h.cooldownCount : 0;
  const usable = Math.max(0, total - disabled);
  const healthy = h && h.healthy === true;

  let sidecarLine = '';
  if (p.sidecar) {
    const sc = p.sidecar;
    const scTone = sc.state === 'running' ? 'text-emerald-400' : (sc.state === 'starting' ? 'text-amber-400' : 'text-rose-400');
    sidecarLine = '<p class="text-xs text-slate-400 mt-2 flex items-center gap-1.5"><i aria-hidden="true" class="fa-solid fa-microchip"></i> sidecar：' +
      '<span class="' + scTone + ' font-medium">' + esc(sc.state) + '</span>' +
      ' · pid ' + esc(sc.pid === null || sc.pid === undefined ? '—' : sc.pid) +
      ' · 重启 ' + esc(typeof sc.restarts === 'number' ? sc.restarts : 0) +
      (sc.lastError ? ' · <span class="text-rose-300">' + esc(String(sc.lastError).slice(0, 80)) + '</span>' : '') +
      '</p>';
  }

  let initErrLine = '';
  if (p.initError) {
    initErrLine = '<p class="text-xs text-rose-300 mt-2"><i aria-hidden="true" class="fa-solid fa-circle-exclamation"></i> 初始化失败：' + esc(String(p.initError).slice(0, 120)) + '</p>';
  }

  const actions = [];
  if (p.configured) {
    if (p.enabled) {
      actions.push('<button onclick="toggleProvider(\'' + esc(p.name) + '\',false)" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg border border-slate-700 transition">停用</button>');
    } else {
      actions.push('<button onclick="toggleProvider(\'' + esc(p.name) + '\',true)" class="px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 text-xs rounded-lg border border-emerald-600/30 transition">启用</button>');
    }
    if (isDefault) {
      actions.push('<span class="px-3 py-1.5 text-xs rounded-lg bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-medium">默认上游</span>');
    } else {
      actions.push('<button onclick="setDefaultProvider(\'' + esc(p.name) + '\')" class="px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 text-xs rounded-lg border border-indigo-600/30 transition">设为默认</button>');
    }
  }

  return '<div class="card rounded-xl p-5 space-y-3">' +
    '<div class="flex items-start justify-between gap-2">' +
      '<div><h3 class="font-bold text-white">' + esc(p.displayName) + '</h3>' +
      '<p class="text-xs text-slate-500 font-mono">' + esc(p.name) + '</p></div>' +
      providerStateBadge(p) +
    '</div>' +
    '<div class="grid grid-cols-3 gap-2">' +
      providerMetricTile('可用', usable + ' / ' + total, healthy ? 'ok' : (total ? 'bad' : 'plain')) +
      providerMetricTile('冷却', cooling, cooling ? 'bad' : 'plain') +
      providerMetricTile('停用/暂停', disabled, disabled ? 'bad' : 'plain') +
    '</div>' +
    sidecarLine + initErrLine +
    '<div class="flex flex-wrap gap-2 pt-1">' + actions.join('') + '</div>' +
    '</div>';
}

/** T208：总览页异常横幅。异常 = 已配置 + 已初始化 + 已启用但 health 不健康。 */
window.renderProviderBanner = function (providers) {
  const el = document.getElementById('providerBanner');
  if (!el) return;
  const bad = (providers || []).filter(p => p.configured && p.initialized && p.enabled && p.health && p.health.healthy !== true);
  if (!bad.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = '<p class="text-sm font-bold text-rose-300 flex items-center gap-2"><i aria-hidden="true" class="fa-solid fa-triangle-exclamation"></i> 上游健康告警</p>' +
    bad.map(p => '<p class="text-xs text-rose-200/90">' + esc(p.displayName) + '（' + esc(p.name) + '）health 异常' +
      (p.sidecar ? ' · sidecar ' + esc(p.sidecar.state) : '') +
      (p.initError ? ' · ' + esc(String(p.initError).slice(0, 100)) : '') +
      ' — 请求可能失败，请检查该上游配置或在上游页停用它</p>').join('');
};

async function loadUpstream() {
  const box = document.getElementById('providerCards');
  if (!box) return;
  const { ok, data, error } = await apiJson('/api/providers');
  if (!ok) {
    box.innerHTML = emptyState('fa-triangle-exclamation', '加载上游状态失败：' + error);
    window.renderProviderBanner([]);
    return;
  }
  const providers = data.providers || [];
  window.renderProviderBanner(providers);
  if (!providers.length) {
    box.innerHTML = emptyState('fa-server', 'Provider 运行时未装配（旧构建或未接线），多上游功能不可见');
    return;
  }
  box.innerHTML = providers.map(p => providerCard(p, data.defaultProvider)).join('');
}

function refreshUpstream() { loadUpstream(); }

window.toggleProvider = async function (name, enable) {
  const { ok, error } = await apiJson('/api/providers/' + encodeURIComponent(name) + '/' + (enable ? 'enable' : 'disable'), { method: 'POST' });
  if (!ok) { showToast('切换 ' + name + ' 失败：' + error, 'error'); return; }
  showToast((enable ? '已启用 ' : '已停用 ') + name + '（对新请求立即生效）', 'success');
  loadUpstream();
};

window.setDefaultProvider = async function (name) {
  const { ok, error } = await apiJson('/api/providers/default', { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ name }) });
  if (!ok) { showToast('设置默认上游失败：' + error, 'error'); return; }
  showToast('默认上游已切换为 ' + name + '（热生效，已持久化）', 'success');
  loadUpstream();
};

/** 空闲轮询：跨页保活横幅（健康↔异常自动出现/消失），上游页另有 15s 全量刷新。 */
async function refreshBannerQuiet() {
  const el = document.getElementById('providerBanner');
  if (!el) return;
  const { ok, data } = await apiJson('/api/providers');
  if (ok) window.renderProviderBanner((data && data.providers) || []);
}

function enter_upstream() { loadUpstream(); }
registerRefresh('upstream', loadUpstream, 15000);
registerRefresh('*', refreshBannerQuiet, 15000);
