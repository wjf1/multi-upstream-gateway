// =============================================================================
// CommandCode 代理面板 · 实时日志页（logs.js）—— 路由 #/logs
// -----------------------------------------------------------------------------
// 网关事件控制台（T306 DoD）：
//   1. 多维三筛选：级别/频道、上游 Provider、关键词；
//   2. RequestId 交互识别与请求全链路关联详情查看；
//   3. 5s 自动轮询刷新与智能滚动跟随。
// =============================================================================

let rawLogsCache = [];
let currentViewingRequestId = null;

// 日志结构化高亮：先 esc 再按词法着色（模型名 / 错误码 / RequestId / TraceId），插入的 span/button 均为本页自有标签。
const LOG_TOKEN_RE = /\b(HTTP ?-?\d{3}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EACCES|EPIPE)\b|\b([45]\d{2})\b|\b((?:claude|gpt|gemini|deepseek|glm|qwen|grok|mistral|mixtral)[\w.\-]*)\b|\b(chatcmpl-[a-zA-Z0-9]+|msg_[a-zA-Z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

function logHighlight(msg) {
  return esc(msg).replace(LOG_TOKEN_RE, function (m, errTok, code, model, reqId) {
    if (errTok) return '<span class="lg-err">' + errTok + '</span>';
    if (code) return '<span class="lg-err">' + code + '</span>';
    if (model) return '<span class="lg-model">' + model + '</span>';
    if (reqId) {
      return '<button onclick="showRequestDetail(\'' + esc(reqId) + '\')" title="点击查看请求明细" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 font-mono transition cursor-pointer"><i aria-hidden="true" class="fa-solid fa-link text-[9px]"></i>' + reqId + '</button>';
    }
    return m;
  });
}

function clearKeywordFilter() {
  const kw = document.getElementById('logKeywordFilter');
  if (kw) kw.value = '';
  const btn = document.getElementById('clearLogKwBtn');
  if (btn) btn.classList.add('hidden');
  applyLogFilters();
}

function applyLogFilters() {
  const box = document.getElementById('logsBox');
  if (!box) return;

  const levelFilter = (document.getElementById('logLevelFilter')?.value || 'all').toLowerCase();
  const providerFilter = (document.getElementById('logProviderFilter')?.value || 'all').toLowerCase();
  const kwInput = document.getElementById('logKeywordFilter');
  const kw = (kwInput?.value || '').toLowerCase().trim();

  const clearBtn = document.getElementById('clearLogKwBtn');
  if (clearBtn) {
    if (kw) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
  }

  const filtered = rawLogsCache.filter(l => {
    // 1. 级别筛选
    if (levelFilter !== 'all') {
      if ((l.level || '').toLowerCase() !== levelFilter) return false;
    }
    // 2. 上游 Provider 筛选
    if (providerFilter !== 'all') {
      const msg = (l.message || '').toLowerCase();
      if (providerFilter === 'freebuff') {
        if (!msg.includes('freebuff') && !msg.includes('pvd:freebuff')) return false;
      } else if (providerFilter === 'workbuddy') {
        if (!msg.includes('workbuddy') && !msg.includes('pvd:workbuddy') && !msg.includes('codebuddy')) return false;
      } else if (providerFilter === 'commandcode') {
        if (msg.includes('freebuff') || msg.includes('workbuddy')) return false;
      }
    }
    // 3. 关键词过滤
    if (kw) {
      const fullText = `[${l.timestamp}] [${l.level}] ${l.message}`.toLowerCase();
      if (!fullText.includes(kw)) return false;
    }
    return true;
  });

  const stats = document.getElementById('logFilterStats');
  if (stats) {
    stats.textContent = `显示 ${filtered.length} / ${rawLogsCache.length} 条`;
  }

  if (!filtered.length) {
    if (rawLogsCache.length > 0) {
      box.innerHTML = emptyState('fa-filter', '没有匹配筛选条件的日志行（共 ' + rawLogsCache.length + ' 条原始日志）');
    } else {
      box.innerHTML = emptyState('fa-terminal', '暂无日志，网关事件会在这里滚动显示');
    }
    return;
  }

  const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;

  box.innerHTML = filtered.map(l => {
    const lc = l.level === 'error' ? 'text-rose-400' : l.level === 'warn' ? 'text-amber-400' : 'text-slate-300';
    const lv = String(l.level || 'info').toUpperCase();
    const lvCls = l.level === 'error' ? 'lg-lv-err' : l.level === 'warn' ? 'lg-lv-warn' : 'lg-lv-info';
    return '<p class="' + lc + ' font-mono text-[11px] py-0.5 break-all leading-relaxed hover:bg-slate-900/60 rounded px-1 transition">' +
      '<span class="text-slate-500">[' + esc(l.timestamp) + ']</span> ' +
      '<span class="lg-lv ' + lvCls + '">' + esc(lv) + '</span> ' +
      logHighlight(l.message) +
    '</p>';
  }).join('');

  if (wasAtBottom) box.scrollTop = box.scrollHeight;
}

async function loadLogs() {
  const { ok, data, error } = await apiJson('/api/logs');
  const box = document.getElementById('logsBox');
  if (!box) return;

  if (!ok || !Array.isArray(data.logs)) {
    box.innerHTML = '<p class="text-amber-400 font-mono text-[11px]">日志读取失败：' + esc(error || '响应缺少 logs') + '</p>';
    return;
  }

  rawLogsCache = data.logs;
  applyLogFilters();
}

async function clearLogs() {
  if (typeof uiConfirm === 'function') {
    const ok = await uiConfirm('确定清空当前日志控制台？此操作将重置内存中的日志缓冲。');
    if (!ok) return;
  }
  const { ok, error } = await apiJson('/api/logs/clear', { method: 'POST' });
  if (!ok) {
    if (typeof showToast === 'function') showToast('清空日志失败：' + error, 'error');
  } else {
    rawLogsCache = [];
    hideRequestDetail();
    loadLogs();
  }
}

async function showRequestDetail(id) {
  if (!id) return;
  currentViewingRequestId = id;
  const card = document.getElementById('logDetailCard');
  if (!card) return;

  card.classList.remove('hidden');
  const badge = document.getElementById('detailTraceBadge');
  if (badge) badge.textContent = id;

  const reqEl = document.getElementById('detailRequestId');
  if (reqEl) { reqEl.textContent = id; reqEl.title = id; }

  const modelEl = document.getElementById('detailModel');
  const provEl = document.getElementById('detailProvider');
  const statusEl = document.getElementById('detailStatus');
  const timeEl = document.getElementById('detailTiming');
  const tokEl = document.getElementById('detailTokens');
  const relEl = document.getElementById('detailRelatedLogs');

  if (modelEl) modelEl.textContent = '加载中...';
  if (relEl) relEl.innerHTML = '<p class="text-slate-500">正在检索关联记录...</p>';

  const { ok, data, error } = await apiJson('/api/logs/request/' + encodeURIComponent(id));
  if (!ok || !data) {
    if (modelEl) modelEl.textContent = '加载失败: ' + (error || '未知错误');
    return;
  }

  const rec = data.record || {};
  if (modelEl) modelEl.textContent = rec.model || '--';
  if (provEl) {
    const pName = rec.provider || 'commandcode';
    provEl.textContent = pName === 'commandcode' ? 'CommandCode' : pName === 'freebuff' ? 'Freebuff' : pName === 'workbuddy' ? 'WorkBuddy' : pName;
  }
  if (statusEl) {
    const isOk = rec.status === 'COMPLETED';
    statusEl.innerHTML = isOk
      ? '<span class="text-emerald-400 font-bold"><i aria-hidden="true" class="fa-solid fa-circle-check"></i> 成功</span>'
      : '<span class="text-rose-400 font-bold"><i aria-hidden="true" class="fa-solid fa-circle-xmark"></i> 失败' + (rec.errorCode ? ' (' + esc(rec.errorCode) + ')' : '') + '</span>';
  }
  if (timeEl) {
    const ms = rec.timingMs || 0;
    timeEl.textContent = ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms';
  }
  if (tokEl) {
    const inp = rec.inputTokens || 0;
    const out = rec.outputTokens || 0;
    let costText = '';
    if (typeof rec.costUsd === 'number') costText = ' / $' + rec.costUsd.toFixed(4);
    else if (rec.native?.points) costText = ' / ' + rec.native.points + ' pts';
    tokEl.textContent = `入 ${inp} / 出 ${out}${costText}`;
    tokEl.title = `输入: ${inp}, 输出: ${out}, 缓存: ${rec.cacheReadTokens || 0}`;
  }

  if (relEl) {
    const list = data.relatedLogs || [];
    if (!list.length) {
      relEl.innerHTML = '<p class="text-slate-500 italic">内存中暂未检索到直接匹配该 ID 的单行日志（可能在落库前已轮转）</p>';
    } else {
      relEl.innerHTML = list.map(l =>
        `<div class="py-0.5 border-b border-slate-900/60 last:border-0"><span class="text-slate-500">[${esc(l.timestamp)}]</span> <span class="text-slate-400">${esc(l.level.toUpperCase())}</span>: ${esc(l.message)}</div>`
      ).join('');
    }
  }
}

function hideRequestDetail() {
  currentViewingRequestId = null;
  const card = document.getElementById('logDetailCard');
  if (card) card.classList.add('hidden');
}

function enter_logs() {
  loadLogs();
}

registerRefresh('logs', loadLogs, 5000);

