// =============================================================================
// CommandCode 代理面板 · 系统设置页（settings.js）—— 路由 #/settings（T307 DoD）
// -----------------------------------------------------------------------------
// 覆盖五大区块：网络、安全、告警、存储与危险操作、面板偏好；
// 支持 2s 热生效反馈、字段级标红校验提示、需重启项标红、危险操作二次确认 + 审计留痕。
// =============================================================================

function clearFieldErrors() {
  document.querySelectorAll("[id^='err_']").forEach(el => {
    el.textContent = '';
    el.classList.add('hidden');
  });
  document.querySelectorAll("[id^='set_']").forEach(el => {
    el.classList.remove('border-rose-500');
  });
  const gMsg = document.getElementById('settingsGlobalMsg');
  if (gMsg) {
    gMsg.textContent = '';
    gMsg.className = 'hidden p-3 rounded-xl text-xs border';
  }
}

function showFieldErrors(errors) {
  if (!errors || typeof errors !== 'object') return;
  for (const [key, msg] of Object.entries(errors)) {
    const errEl = document.getElementById('err_' + key);
    const inputEl = document.getElementById('set_' + key);
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
    }
    if (inputEl) {
      inputEl.classList.add('border-rose-500');
    }
  }
}

async function loadSettings() {
  clearFieldErrors();
  const { ok, data, error } = await apiJson('/api/settings');
  if (!ok || !data) {
    showToast('加载系统设置失败：' + (error || '未知错误'), 'error');
    return;
  }

  const s = data.sections || {};
  const net = s.network || {};
  const sec = s.security || {};
  const alt = s.alerts || {};
  const sto = s.storage || {};
  const pref = s.preferences || {};

  // 1. 网络区块
  const elPort = document.getElementById('set_port');
  if (elPort) elPort.value = net.port ?? '';
  const elHost = document.getElementById('set_host');
  if (elHost) elHost.value = net.host ?? '';
  const elProxy = document.getElementById('set_proxy');
  if (elProxy) elProxy.value = net.proxy ?? '';
  const elTimeout = document.getElementById('set_upstreamTimeoutMs');
  if (elTimeout) elTimeout.value = net.upstreamTimeoutMs ?? '';
  const elIdle = document.getElementById('set_idleTimeoutMs');
  if (elIdle) elIdle.value = net.idleTimeoutMs ?? '';
  const elRetries = document.getElementById('set_maxRetries');
  if (elRetries) elRetries.value = net.maxRetries ?? '';

  // 2. 安全区块
  const elMaxBody = document.getElementById('set_maxBodyMb');
  if (elMaxBody) elMaxBody.value = sec.maxBodyMb ?? '';
  const elHosts = document.getElementById('set_allowedHosts');
  if (elHosts) elHosts.value = Array.isArray(sec.allowedHosts) ? sec.allowedHosts.join(', ') : '';

  const elRpm = document.getElementById('view_rateLimitRpm');
  if (elRpm) elRpm.textContent = sec.rateLimitRpm ? sec.rateLimitRpm + ' req/min' : '未开启 (默认无限制)';
  const elTpm = document.getElementById('view_rateLimitTpm');
  if (elTpm) elTpm.textContent = sec.rateLimitTpm ? sec.rateLimitTpm + ' tok/min' : '未开启 (默认无限制)';

  // 3. 告警区块
  const elWebhook = document.getElementById('set_webhookUrl');
  if (elWebhook) elWebhook.value = alt.webhookUrl ?? '';
  const elBudget = document.getElementById('set_dailyBudgetUsd');
  if (elBudget) elBudget.value = alt.dailyBudgetUsd ?? '';
  const elErrRate = document.getElementById('set_errorRateThreshold');
  if (elErrRate) elErrRate.value = alt.errorRateThreshold ?? '';

  // 4. 存储路径
  const pCfg = document.getElementById('path_config');
  if (pCfg) pCfg.textContent = sto.configFile || '--';
  const pLog = document.getElementById('path_log');
  if (pLog) pLog.textContent = sto.logFile || '--';
  const pUsg = document.getElementById('path_usage');
  if (pUsg) pUsg.textContent = sto.usageFile || '--';
  const pCred = document.getElementById('path_cred');
  if (pCred) pCred.textContent = sto.credentialStoreFile || '--';

  // 5. 偏好区块
  const elDefProv = document.getElementById('set_defaultProvider');
  if (elDefProv) elDefProv.value = pref.defaultProvider || 'commandcode';

  const elFbStrat = document.getElementById('set_fallbackStrategy');
  if (elFbStrat) elFbStrat.value = pref.fallbackStrategy || 'strict';

  const elSticky = document.getElementById('set_sessionStickyEnabled');
  if (elSticky) elSticky.checked = pref.sessionStickyEnabled !== false;

  const elPrefix = document.getElementById('set_modelPrefixRouting');
  if (elPrefix) elPrefix.checked = pref.modelPrefixRouting !== false;

  const rStatus = document.getElementById('view_riskStatus');
  if (rStatus) {
    if (pref.acceptedRiskDisclaimer) {
      rStatus.innerHTML = '<span class="text-emerald-400 font-bold"><i aria-hidden="true" class="fa-solid fa-circle-check"></i> 已阅读并同意风险告知</span>';
    } else {
      rStatus.innerHTML = '<span class="text-amber-400 font-bold"><i aria-hidden="true" class="fa-solid fa-circle-exclamation"></i> 尚未同意风险告知 (/v1 返回 403)</span>';
    }
  }
}

async function submitSettings() {
  clearFieldErrors();

  const btnTop = document.getElementById('saveSettingsBtnTop');
  const btnBottom = document.getElementById('saveSettingsBtnBottom');
  const setBtnState = (disabled, text) => {
    if (btnTop) { btnTop.disabled = disabled; btnTop.innerHTML = text; }
    if (btnBottom) { btnBottom.disabled = disabled; btnBottom.innerHTML = text; }
  };

  setBtnState(true, '<i aria-hidden="true" class="fa-solid fa-spinner fa-spin"></i> 正在保存...');

  const payload = {
    network: {},
    security: {},
    alerts: {},
    preferences: {},
  };

  const portVal = document.getElementById('set_port')?.value?.trim();
  if (portVal) payload.network.port = portVal;

  const hostVal = document.getElementById('set_host')?.value?.trim();
  if (hostVal !== undefined) payload.network.host = hostVal;

  const proxyVal = document.getElementById('set_proxy')?.value?.trim();
  if (proxyVal !== undefined) payload.network.proxy = proxyVal;

  const toVal = document.getElementById('set_upstreamTimeoutMs')?.value?.trim();
  if (toVal) payload.network.upstreamTimeoutMs = toVal;

  const idleVal = document.getElementById('set_idleTimeoutMs')?.value?.trim();
  if (idleVal) payload.network.idleTimeoutMs = idleVal;

  const retriesVal = document.getElementById('set_maxRetries')?.value?.trim();
  if (retriesVal) payload.network.maxRetries = retriesVal;

  const maxBodyVal = document.getElementById('set_maxBodyMb')?.value?.trim();
  if (maxBodyVal) payload.security.maxBodyMb = maxBodyVal;

  const allowedHostsVal = document.getElementById('set_allowedHosts')?.value?.trim();
  if (allowedHostsVal !== undefined) {
    payload.security.allowedHosts = allowedHostsVal ? allowedHostsVal.split(',').map(s => s.trim()).filter(Boolean) : ['127.0.0.1'];
  }

  const defProv = document.getElementById('set_defaultProvider')?.value;
  if (defProv) payload.preferences.defaultProvider = defProv;

  const fbStratVal = document.getElementById('set_fallbackStrategy')?.value;
  if (fbStratVal) payload.preferences.fallbackStrategy = fbStratVal;

  const stickyEl = document.getElementById('set_sessionStickyEnabled');
  if (stickyEl) payload.preferences.sessionStickyEnabled = stickyEl.checked;

  const prefixEl = document.getElementById('set_modelPrefixRouting');
  if (prefixEl) payload.preferences.modelPrefixRouting = prefixEl.checked;

  const { ok, data, error } = await apiJson('/api/settings', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  setBtnState(false, '<i aria-hidden="true" class="fa-solid fa-floppy-disk"></i> 保存并应用系统设置');

  if (!ok) {
    if (data && data.errors) {
      showFieldErrors(data.errors);
      showToast('设置校验失败，请检查标红提示项', 'error');
    } else {
      showToast('保存设置失败：' + (error || '未知错误'), 'error');
    }
    return;
  }

  const gMsg = document.getElementById('settingsGlobalMsg');
  if (gMsg) {
    gMsg.className = 'p-3 rounded-xl text-xs border border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    gMsg.innerHTML = '<i aria-hidden="true" class="fa-solid fa-circle-check"></i> ' + esc(data.message || '系统设置已更新并成功热生效');
    setTimeout(() => { gMsg.className = 'hidden'; }, 6000);
  }

  showToast(data.message || '系统设置已保存（2s 内热生效）', 'success');
  if (data.requiresRestart) {
    setTimeout(() => {
      showToast('提示：修改的端口/主机/代理将在网关下次启动时生效', 'info');
    }, 1500);
  }
}

async function clearUsageWithAudit() {
  if (typeof uiConfirm === 'function') {
    const ok = await uiConfirm('确定要清空全部用量历史吗？此危险操作将彻底抹除本地 usage-history.jsonl 数据，不可撤销，且该操作将被作为写操作严格记录在管理面审计日志（audit-log.jsonl）中。');
    if (!ok) return;
  }

  const { ok, error } = await apiJson('/api/usage/clear', { method: 'POST' });
  if (!ok) {
    showToast('清空用量历史失败：' + error, 'error');
  } else {
    showToast('用量历史已清空（操作已记入管理面审计日志）', 'success');
    if (typeof loadUsageHistory === 'function') loadUsageHistory();
  }
}

function enter_settings() {
  loadSettings();
}

registerRefresh('settings', loadSettings, 30000);
