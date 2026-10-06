// =============================================================================
// CommandCode 代理面板 · 实时日志页（logs.js）—— 路由 #/logs
// -----------------------------------------------------------------------------
// 网关事件控制台：日志读取与清空、按词法着色（模型名 / 错误码）、只在本来就在
// 底部时才跟随滚动。
// =============================================================================

// 日志结构化高亮：先 esc 再按词法着色（模型名 / 错误码），插入的 span 均为本页自有标签。
// 单遍 alternation 替换：replace 不会重扫已产出的替换文本，天然避免标签嵌套污染。
const LOG_TOKEN_RE = /\b(HTTP ?-?\d{3}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EACCES|EPIPE)\b|\b([45]\d{2})\b|\b((?:claude|gpt|gemini|deepseek|glm|qwen|grok|mistral|mixtral)[\w.\-]*)/gi;
function logHighlight(msg) {
  return esc(msg).replace(LOG_TOKEN_RE, function (m, errTok, code, model) {
    if (errTok) return '<span class="lg-err">' + errTok + '</span>';
    if (code) return '<span class="lg-err">' + code + '</span>';
    return '<span class="lg-model">' + model + '</span>';
  });
}

async function loadLogs() {
  const { ok, data, error } = await apiJson('/api/logs');
  const box = document.getElementById('logsBox');
  if (!ok || !Array.isArray(data.logs)) {
    box.innerHTML = '<p class="text-amber-400 font-mono text-[11px]">日志读取失败：' + esc(error || '响应缺少 logs') + '</p>';
    return;
  }
  if (!data.logs.length) { box.innerHTML = emptyState('fa-terminal', '暂无日志，网关事件会在这里滚动显示'); return; }
  box.innerHTML = data.logs.map(l => {
    const lc = l.level==='error'?'text-rose-400':l.level==='warn'?'text-amber-400':'text-slate-300';
    const lv = String(l.level || 'info').toUpperCase();
    const lvCls = l.level==='error'?'lg-lv-err':l.level==='warn'?'lg-lv-warn':'lg-lv-info';
    return '<p class="'+lc+' font-mono text-[11px] py-0.5 break-all"><span class="text-slate-500">['+esc(l.timestamp)+']</span> <span class="lg-lv '+lvCls+'">'+esc(lv)+'</span> '+logHighlight(l.message)+'</p>';
  }).join('');
  // 只有本来就在底部时才跟随滚动。此前每 5s 无条件跳到最新一行，
  // 想往上翻一条旧日志会在 5 秒内被弹回去，实际上没法读。
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 40) box.scrollTop = box.scrollHeight;
}

async function clearLogs(){ const {ok,error}=await apiJson('/api/logs/clear',{method:'POST'}); if(!ok) showToast('清空日志失败：'+error,'error'); loadLogs(); }

function enter_logs() { loadLogs(); }
registerRefresh('logs', loadLogs, 5000);
