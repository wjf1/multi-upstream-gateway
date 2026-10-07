// =============================================================================
// CommandCode 代理面板 · 模型页（models.js）—— 路由 #/models
// -----------------------------------------------------------------------------
// 上游实时模型目录：搜索 + 标签 + 排序（纯前端过滤，不新增 API）、GO/GOAT 档位标注、
// 家族徽章、分时价展示。价格单位与折算说明见页面副标题。
// =============================================================================

// 展示用汇率：官方目录价格为 USD/1M tokens，界面按此折算为人民币显示。
// 汇率会漂移，仅作参考 —— 修改后请同步模型页副标题的折算说明。
const USD_TO_CNY = 6.72;
function fmtPrice(v){ if(v===undefined||v===null) return '--'; if(v===0) return 'FREE'; var c=v*USD_TO_CNY; c=c>=100?Math.round(c):Math.round(c*100)/100; return '¥' + c; }
function fmtCtx(v){ if(!v) return '--'; if(v>=1000000){ var x=(v/1000000); return (x%1===0?x:x.toFixed(1)) + 'M'; } if(v>=1000){ var k=v/1000; return (k%1===0?k:k.toFixed(1)) + 'K'; } return String(v); }
// ─── 模型查询：搜索 + 标签 + 排序（纯前端过滤，不新增 API）────────────────────
let allModelsCache = [];
let modelTagFilter = 'all';
let modelSortMode = 'default';
let modelQueryTimer = null;
// 档位键名与显示名，需与 src/utils/plans.ts 的 PLAN_TIERS 保持一致。
const PLAN_LABELS = {
  'individual-free': 'Free', 'individual-go': 'Go', 'individual-goat': 'GOAT',
  'individual-pro': 'Pro', 'individual-pro-v1': 'Pro (v1)', 'individual-provider': 'Provider',
  'individual-max': 'Max', 'individual-ultra': 'Ultra', 'teams-pro': 'Team Pro',
};
// 判定「档位可用」只看该档位自己的布尔值；availability 缺失时退回旧的 onGoPlan。
function isPlanOn(m, key) {
  const a = m && m.availability;
  if (a && Object.keys(a).length) return a[key] === true;
  return key === 'individual-go' ? !!m.onGoPlan : false;
}
function higherPlanNames(avail) {
  return ['individual-pro', 'individual-pro-v1', 'individual-provider', 'individual-max', 'individual-ultra', 'teams-pro']
    .filter(k => avail[k] === true).map(k => PLAN_LABELS[k] || k);
}
// 档位药丸：可用=实心强调色，不可用=灰底。两枚固定占位，卡片高度一致，
// 整列纵向对齐后即可一眼比较 GO / GOAT 的差别。
function planPill(key, label, on, onTone) {
  const cls = on ? onTone : 'bg-slate-800/40 text-slate-400 border-slate-700/70';
  return '<span class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-semibold ' + cls +
    '" title="' + (PLAN_LABELS[key] || key) + ' 档位：' + (on ? '可用' : '不可用') + '">' +
    label + '<i aria-hidden="true" class="fa-solid ' + (on ? 'fa-check' : 'fa-xmark') + ' text-[9px] opacity-80"></i></span>';
}
// 模型家族：category 字段优先，其次按 id/name/提供商关键词推断（纯前端展示用）。
function modelFamily(m) {
  if (m && m.category) return String(m.category);
  const s = (((m && m.id) || '') + ' ' + ((m && m.name) || '') + ' ' + ((m && m.owned_by) || '')).toLowerCase();
  if (s.indexOf('claude') >= 0) return 'Claude';
  if (s.indexOf('gpt') >= 0) return 'GPT';
  if (/(^|[^a-z])o[13]([^a-z]|$)/.test(s)) return 'o 系列';
  if (s.indexOf('gemini') >= 0) return 'Gemini';
  if (s.indexOf('deepseek') >= 0) return 'DeepSeek';
  if (s.indexOf('grok') >= 0) return 'Grok';
  if (/(^|[^a-z])glm/.test(s)) return 'GLM';
  if (s.indexOf('qwen') >= 0) return 'Qwen';
  if (s.indexOf('llama') >= 0) return 'Llama';
  if (/(mistral|mixtral)/.test(s)) return 'Mistral';
  return '';
}
function modelMatchesTag(m, tag) {
  const caps = m.caps || {};
  if (tag === 'go') return isPlanOn(m, 'individual-go');
  if (tag === 'goat') return isPlanOn(m, 'individual-goat');
  if (tag === 'free') return !!(m.deal && m.deal.free);
  if (tag === 'deal') return !!(m.deal && m.deal.discountPercent);
  if (tag === 'vision') return !!(caps.vision || m.supports_vision);
  if (tag === 'reason') return !!caps.reasoning;
  return true;
}
function modelMatchesQuery(m, q) {
  if (!q) return true;
  const hay = ((m.id || '') + ' ' + (m.name || '') + ' ' + (m.owned_by || '')).toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(kw => hay.includes(kw));
}
function sortModels(list) {
  const price = (m, k) => { const v = m.pricing && m.pricing[k]; return (v === undefined || v === null) ? Infinity : v; };
  const ctx = (m) => (m.context_window || m.context_length || 0);
  const arr = list.slice();
  if (modelSortMode === 'inAsc') arr.sort((a, b) => price(a, 'input') - price(b, 'input'));
  else if (modelSortMode === 'inDesc') arr.sort((a, b) => { const pa = price(a, 'input'), pb = price(b, 'input'); return (pb === Infinity ? -1 : pb) - (pa === Infinity ? -1 : pa); });
  else if (modelSortMode === 'outAsc') arr.sort((a, b) => price(a, 'output') - price(b, 'output'));
  else if (modelSortMode === 'outDesc') arr.sort((a, b) => { const pa = price(a, 'output'), pb = price(b, 'output'); return (pb === Infinity ? -1 : pb) - (pa === Infinity ? -1 : pa); });
  else if (modelSortMode === 'cacheReadAsc') arr.sort((a, b) => price(a, 'cacheRead') - price(b, 'cacheRead'));
  else if (modelSortMode === 'cacheReadDesc') arr.sort((a, b) => { const pa = price(a, 'cacheRead'), pb = price(b, 'cacheRead'); return (pb === Infinity ? -1 : pb) - (pa === Infinity ? -1 : pa); });
  else if (modelSortMode === 'ctxDesc') arr.sort((a, b) => ctx(b) - ctx(a));
  return arr;
}
function highlightHit(text, q) {
  const safe = esc(text);
  const kw = (q || '').trim();
  if (!kw) return safe;
  const words = kw.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return safe;
  try { return safe.replace(new RegExp('(' + words.join('|') + ')', 'gi'), '<mark>$1</mark>'); }
  catch { return safe; }
}
function applyModelFilter() {
  const input = document.getElementById('modelSearch');
  const q = ((input && input.value) || '').trim().toLowerCase();
  const clearBtn = document.getElementById('modelSearchClear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !q);
  const filtered = sortModels(allModelsCache.filter(m => modelMatchesTag(m, modelTagFilter) && modelMatchesQuery(m, q)));
  const meta = document.getElementById('modelsCount');
  if (meta) {
    const goCount = allModelsCache.filter(m => isPlanOn(m, 'individual-go')).length;
    const goatCount = allModelsCache.filter(m => isPlanOn(m, 'individual-goat')).length;
    meta.innerText = '共 ' + allModelsCache.length + ' 个 · 命中 ' + filtered.length +
      ' 个 · Go 档可用 ' + goCount + ' 个 · GOAT 档可用 ' + goatCount + ' 个';
  }
  const c = document.getElementById('modelsList');
  if (!filtered.length) {
    c.innerHTML = '<div class="col-span-full">' + emptyState('fa-magnifying-glass', '没有匹配的模型，换个关键词或标签试试') + '</div>';
    return;
  }
  c.innerHTML = filtered.map(m => {
    const p = m.pricing || {};
    const caps = m.caps || {};
    const avail = m.availability || {};
    const goOn = isPlanOn(m, 'individual-go');
    const goatOn = isPlanOn(m, 'individual-goat');
    const higher = higherPlanNames(avail);
    let tags = '';
    const fam = modelFamily(m);
    if (fam) tags += badge(fam, 'sky', '模型家族');
    // T211：多上游命名空间模型（`freebuff/<id>` / `workbuddy/<id>`），路由按前缀分发。
    const slash = m.id.indexOf('/');
    if (slash > 0) tags = badge(m.id.slice(0, slash) + ' 命名空间', 'indigo', '多上游命名空间模型：路由按前缀分发到对应 Provider') + tags;
    if (m.deal && m.deal.free) tags += badge('FREE', 'rose');
    else if (m.deal && m.deal.discountPercent) tags += badge('DEAL ' + m.deal.discountPercent + '%', 'amber');
    // GO/GOAT 都不可用时，用一枚中性徽章说明它属于更高的付费档位，避免误读成"不可调用"。
    if (!goOn && !goatOn && higher.length) {
      tags += badge('更高档位', 'slate', '仅在这些档位可用：' + higher.join(' · '));
    }
    const capsStr = '文字' + (caps.text ? '✓' : '✗') + ' · 视觉' + ((caps.vision || m.supports_vision) ? '✓' : '✗') + ' · 推理' + (caps.reasoning ? '✓' : '✗');
    return '<div class="p-3 card rounded-lg hover:border-indigo-500/40 transition">' +
      '<div class="flex items-start justify-between gap-2">' +
        '<div class="min-w-0"><p class="font-bold text-xs text-white break-all">' + highlightHit(m.id, q) + '</p>' +
        '<p class="text-[11px] text-slate-400 mt-0.5">提供商：' + highlightHit(m.owned_by, q) + (m.name && m.name !== m.id ? ' · ' + highlightHit(m.name, q) : '') + '</p></div>' +
        '<div class="flex gap-1 flex-wrap justify-end shrink-0">' + tags + '</div>' +
      '</div>' +
      '<div class="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-slate-400">' +
        '<span>上下文：<span class="text-slate-200">' + fmtCtx(m.context_window || m.context_length) + '</span></span>' +
        '<span>输入：<span class="text-slate-200">' + fmtPrice(p.input) + '</span></span>' +
        '<span>输出：<span class="text-slate-200">' + fmtPrice(p.output) + '</span></span>' +
        '<span>缓存读：<span class="text-slate-200">' + fmtPrice(p.cacheRead) + '</span></span>' +
        '<span>缓存写：<span class="text-slate-200">' + fmtPrice(p.cacheWrite) + '</span></span>' +
        '<span class="text-slate-500">' + capsStr + '</span>' +
      '</div>' +
      '<div class="mt-2 pt-2 border-t border-slate-800/70 flex items-center gap-1.5">' +
        '<span class="text-[10px] text-slate-500">档位</span>' +
        planPill('individual-go', 'GO', goOn, 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40') +
        planPill('individual-goat', goatOn ? '<i aria-hidden="true" class="fa-solid fa-crown text-[9px]"></i>GOAT' : 'GOAT', goatOn, 'bg-amber-500/15 text-amber-300 border-amber-500/40') +
      '</div>' +
    '</div>';
  }).join('');
}
function bindModelQueryOnce() {
  const input = document.getElementById('modelSearch');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = '1';
  input.addEventListener('input', () => { clearTimeout(modelQueryTimer); modelQueryTimer = setTimeout(applyModelFilter, 150); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; applyModelFilter(); } });
  document.getElementById('modelSearchClear').onclick = () => { input.value = ''; input.focus(); applyModelFilter(); };
  document.getElementById('modelSort').onchange = (e) => { modelSortMode = e.target.value; applyModelFilter(); };
  document.querySelectorAll('#modelTagRow .mfilter-chip').forEach(btn => {
    btn.onclick = () => {
      modelTagFilter = btn.dataset.tag;
      document.querySelectorAll('#modelTagRow .mfilter-chip').forEach(b => b.classList.toggle('on', b === btn));
      applyModelFilter();
    };
  });
}
async function loadModels(force) {
  const btn = document.getElementById('modelsRefreshBtn');
  if (force) { const r = await apiJson('/v1/models/refresh', { method: 'POST' }); if (!r.ok) showToast('刷新模型目录失败：' + r.error, 'error'); }
  showSkeletonIfEmpty(document.getElementById('modelsList'), skeletonCards(6, 80));
  if (btn) { btn.disabled = true; btn.classList.add('opacity-60'); }
  try {
    const { ok, data, error } = await apiJson('/v1/models');
    if (!ok) { showToast('模型列表读取失败：' + error, 'error'); return; }
    allModelsCache = Array.isArray(data.data) ? data.data : [];
    bindModelQueryOnce();
    applyModelFilter();
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('opacity-60'); }
  }
}

function enter_models() { loadModels(false); }
