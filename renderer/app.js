'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let state = { providers: [], global: {}, running: [], dataFile: '', logDir: '' };
const selected = new Set();
let editingId = null;
let view = 'dashboard';

// ---------- 初始化静态图标 ----------
function initStaticIcons() {
  $('#brandMark').innerHTML = icon('activity');
  $$('.nav-ic').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  $$('.search-ic').forEach((el) => { el.innerHTML = icon(el.dataset.icon || 'search'); });
  $('#dashCheckAll').innerHTML = icon('refresh') + '<span>检测全部</span>';
  $('#btnAdd').innerHTML = icon('plus') + '<span>新增服务商</span>';
  $('#btnCheckSel').textContent = '检测';
  $('#btnDelSel').innerHTML = icon('trash') + '<span>删除</span>';
  $('.search-ic').innerHTML = icon('search');
  $('#pmClose').innerHTML = icon('close');
  $('#dmClose').innerHTML = icon('close');
  $('#cfIcon').innerHTML = icon('trash');
  $$('.panel-ic').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  $$('.stat-ic').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  $('#selAll').insertAdjacentHTML('afterend', '');
}

// ---------- Toast ----------
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = icon(type === 'ok' ? 'check' : type === 'err' ? 'close' : 'info') + `<span>${escapeHtml(msg)}</span>`;
  $('#toastWrap').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 240); }, 2600);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 确认弹窗 ----------
let confirmCb = null;
/**
 * 确认弹窗。
 * opts.okText：确认按钮文字（默认"确定"）；opts.danger：危险操作红色样式（默认 true）。
 */
function confirmDialog(title, text, cb, opts = {}) {
  $('#cfTitle').textContent = title;
  $('#cfText').textContent = text;
  $('#cfIcon').innerHTML = icon(opts.danger === false ? 'info' : 'trash');
  const okBtn = $('#cfOk');
  okBtn.textContent = opts.okText || '确定';
  okBtn.classList.toggle('danger', opts.danger !== false);
  okBtn.classList.toggle('solid', opts.danger !== false);
  okBtn.classList.toggle('primary', opts.danger === false);
  confirmCb = cb;
  $('#confirmModal').classList.add('show');
}
$('#cfCancel').addEventListener('click', () => { $('#confirmModal').classList.remove('show'); confirmCb = null; });
$('#cfOk').addEventListener('click', () => { $('#confirmModal').classList.remove('show'); if (confirmCb) confirmCb(); confirmCb = null; });

// ---------- 视图切换 ----------
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    view = btn.dataset.view;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    if (view === 'logs') renderLogs();
    if (view === 'notify') renderNotify();
    if (view === 'dashboard') renderDashboard();
    if (view === 'providers') renderProviders();
    if (view === 'settings') renderNotify();
    if (view === 'stats') renderStats();
  });
});

// ---------- 状态渲染 ----------
function statusInfo(s) {
  if (s === 'up') return { cls: 'up', text: '在线' };
  if (s === 'degraded') return { cls: 'degraded', text: '异常' };
  if (s === 'down') return { cls: 'down', text: '离线' };
  return { cls: 'unknown', text: '待检测' };
}
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${p(d.getDate())} ${fmtTime(ts)}`;
}
// 周期格式化/换算统一复用 src/durfmt.js（由 index.html 以 <script> 先行加载，挂在 window.durfmt）。
// 此前渲染层另有一份同规则实现，两处口径易漂移，现已合并为单一事实来源。
const fmtDuration = (sec) => window.durfmt.formatDuration(sec);

function render() {
  renderNav();
  refreshGroupOptions();
  applyTheme();
  if (view === 'dashboard') renderDashboard();
  if (view === 'providers') renderProviders();
  if (view === 'stats') renderStats();
  $('#footRunning').textContent = state.running.length;
}

/** 主题：system 跟随系统偏好，light/dark 强制 */
function applyTheme() {
  const t = (state.global && state.global.theme) || 'system';
  const dark = t === 'dark' || (t === 'system' && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
if (window.matchMedia) {
  try {
    window.matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => applyTheme());
  } catch (e) { /* older engines */ }
}

function renderNav() {
  $('#navProviderCount').textContent = state.providers.length;
}

function renderDashboard() {
  const up = state.providers.filter((p) => p.status === 'up').length;
  const deg = state.providers.filter((p) => p.status === 'degraded').length;
  const down = state.providers.filter((p) => p.status === 'down').length;
  const models = state.providers.reduce((a, p) => a + (p.modelsAvailable || []).length, 0);
  $('#statUp').textContent = up;
  $('#statDegraded').textContent = deg;
  $('#statDown').textContent = down;
  $('#statModels').textContent = models;

  const recent = [...state.providers].filter((p) => p.checkedAt).sort((a, b) => b.checkedAt - a.checkedAt).slice(0, 8);
  const wrap = $('#recentList');
  if (recent.length === 0) {
    wrap.innerHTML = '<div class="empty">暂无检测记录，点击右上角"检测全部"开始</div>';
  } else {
    wrap.innerHTML = recent.map((p) => {
      const si = statusInfo(p.status);
      return `<div class="act-item" data-act="${p.id}" title="双击查看详情">
        <span class="act-dot" style="background: var(--${si.cls === 'up' ? 'green' : si.cls === 'degraded' ? 'orange' : si.cls === 'down' ? 'red' : 'gray'});"></span>
        <div>
          <div class="act-name">${escapeHtml(p.name)}</div>
          <div class="act-sub">${p.modelsAvailable.length}/${p.modelsTotal} 模型可用${p.lastError ? ' · ' + escapeHtml(p.lastError) : ''}</div>
        </div>
        <div class="act-right">
          <div class="act-status st-${si.cls}">${si.text}</div>
          <div class="act-time">${fmtDate(p.checkedAt)}</div>
        </div>
      </div>`;
    }).join('');
  }
  const latest = recent[0];
  $('#dashUpdated').textContent = latest ? `最近活动 ${fmtTime(latest.checkedAt)}` : '';
}

// 仪表盘最近检测条目：双击打开详情
$('#recentList').addEventListener('dblclick', (e) => {
  const item = e.target.closest('[data-act]');
  if (item) openDetail(Number(item.dataset.act));
});

function filteredProviders() {
  const q = ($('#searchInput').value || '').trim().toLowerCase();
  const g = $('#groupFilter') ? $('#groupFilter').value : '';
  const st = $('#statusFilter') ? $('#statusFilter').value : '';
  return state.providers.filter((p) => {
    if (g && (p.group || '') !== g) return false;
    if (st && (p.status || 'unknown') !== st) return false;
    if (!q) return true;
    const tags = (p.tags || []).join(',').toLowerCase();
    return (p.name || '').toLowerCase().includes(q)
      || (p.url || '').toLowerCase().includes(q)
      || (p.note || '').toLowerCase().includes(q)
      || (p.group || '').toLowerCase().includes(q)
      || tags.includes(q);
  });
}

/** 同步分组下拉与新增表单的 datalist */
function refreshGroupOptions() {
  const groups = [...new Set(state.providers.map((p) => (p.group || '').trim()).filter(Boolean))].sort();
  const sel = $('#groupFilter');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部分组</option>' +
      groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
    if (groups.includes(cur)) sel.value = cur;
  }
  const dl = $('#groupOptions');
  if (dl) dl.innerHTML = groups.map((g) => `<option value="${escapeHtml(g)}"></option>`).join('');
}

function renderProviders() {
  const list = filteredProviders();
  const wrap = $('#providerList');

  if (list.length === 0) {
    wrap.innerHTML = `<div class="empty">${state.providers.length === 0 ? '暂无服务商，点击"新增服务商"开始添加' : '没有匹配的结果'}</div>`;
  } else {
    wrap.innerHTML = list.map((p) => {
      const si = statusInfo(p.status);
      const checking = state.running.includes(p.id);
      const total = p.modelsTotal || 0;
      const avail = (p.modelsAvailable || []).length;
      const pct = total > 0 ? Math.round((avail / total) * 100) : 0;
      const cycleMin = fmtDuration(p.intervalSec);
      const checked = p.checkedAt ? fmtTime(p.checkedAt) : '未检测';
      return `<div class="row p-row ${selected.has(p.id) ? 'selected' : ''} ${checking ? 'checking' : ''}" data-id="${p.id}">
        <div class="col-sel"><label class="checkbox"><input type="checkbox" data-sel="${p.id}" ${selected.has(p.id) ? 'checked' : ''}/><span class="box">${icon('check')}</span></label></div>
        <div class="col-name"><div class="provider-cell">
          <div class="provider-name">
            <span class="name-text" data-detail="${p.id}">${escapeHtml(p.name)}</span>
            ${p.modelChanged ? '<span class="changed-badge">变动</span>' : ''}
          </div>
          <div class="provider-url">${escapeHtml(p.url)}</div>
          ${(p.group || (p.tags && p.tags.length)) ? `<div class="provider-meta">${p.group ? `<span class="chip group">${escapeHtml(p.group)}</span>` : ''}${(p.tags || []).slice(0, 3).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        </div></div>
        <div class="col-status"><span class="status-pill st-${si.cls}"><span class="status-dot ${si.cls} ${checking ? 'pulse' : ''}"></span>${checking ? '检测中' : si.text}</span></div>
        <div class="col-models"><div class="models-cell"><span class="models-bar"><i style="width:${pct}%;"></i></span><span class="models-text">${avail}/${total}</span></div></div>
        <div class="col-latency">${p.latency != null ? p.latency + ' ms' : '—'}</div>
        <div class="col-cycle cycle-cell">${cycleMin}</div>
        <div class="col-notify">${p.notifyOnModelChange ? '<span class="status-pill st-up">开启</span>' : '<span class="status-pill st-unknown">关闭</span>'}</div>
        <div class="col-checked checked-cell">${checked}${p.lastError ? `<br/><span class="st-down" style="font-size:11px;">${escapeHtml(p.lastError).slice(0, 26)}</span>` : ''}</div>
        <div class="col-ops">
          <button class="op-btn run" data-run="${p.id}" title="立即检测">${icon('refresh')}</button>
          <button class="op-btn edit" data-edit="${p.id}" title="编辑">${icon('pencil')}</button>
          <button class="op-btn del" data-del="${p.id}" title="删除">${icon('trash')}</button>
        </div>
      </div>`;
    }).join('');
  }

  // 工具栏状态
  const allChecked = list.length > 0 && list.every((p) => selected.has(p.id));
  const selCount = list.filter((p) => selected.has(p.id)).length;
  const selBox = $('#selAll');
  selBox.checked = allChecked;
  // 部分选中：显示半选态，点击后补齐为全选
  selBox.indeterminate = selCount > 0 && !allChecked;
  $('#selAllText').textContent = allChecked && list.length ? '取消全选' : '全选';
  $('#btnCheckSel').disabled = selected.size === 0;
  $('#btnDelSel').disabled = selected.size === 0;
  $('#btnDelSel').textContent = selected.size > 0 ? `删除 (${selected.size})` : '删除';
}

// 列表事件委托
$('#providerList').addEventListener('click', (e) => {
  const sel = e.target.closest('[data-sel]');
  if (sel) {
    const id = Number(sel.dataset.sel);
    sel.checked ? selected.add(id) : selected.delete(id);
    renderProviders();
    return;
  }
  const detail = e.target.closest('[data-detail]');
  if (detail) { openDetail(Number(detail.dataset.detail)); return; }
  const run = e.target.closest('[data-run]');
  if (run) { window.aipm.checkNow([Number(run.dataset.run)]); toast('已触发检测'); return; }
  const edit = e.target.closest('[data-edit]');
  if (edit) { openProviderModal(Number(edit.dataset.edit)); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    const id = Number(del.dataset.del);
    const p = state.providers.find((x) => x.id === id);
    confirmDialog('删除服务商', `确定删除「${p ? p.name : id}」吗？该操作不可撤销。`, async () => {
      await window.aipm.deleteProvider(id);
      selected.delete(id);
      toast('已删除');
    });
  }
});

$('#searchInput').addEventListener('input', renderProviders);
if ($('#groupFilter')) $('#groupFilter').addEventListener('change', renderProviders);
if ($('#statusFilter')) $('#statusFilter').addEventListener('change', renderProviders);

// 双击行任意位置打开详情（排除操作按钮与复选框）
$('#providerList').addEventListener('dblclick', (e) => {
  if (e.target.closest('.op-btn, .checkbox, input')) return;
  const row = e.target.closest('.p-row[data-id]');
  if (row) openDetail(Number(row.dataset.id));
});

// 全选 / 取消全选（单一三态勾选框：部分选中时显示 indeterminate）
$('#selAll').addEventListener('change', () => {
  const list = filteredProviders();
  // 只要当前筛选结果未被全选，就补齐为全选；已全选则清空，两种行为互斥。
  const allSelected = list.length > 0 && list.every((p) => selected.has(p.id));
  if (allSelected) list.forEach((p) => selected.delete(p.id));
  else list.forEach((p) => selected.add(p.id));
  renderProviders();
});
$('#btnCheckSel').addEventListener('click', () => { window.aipm.checkNow([...selected]); toast(`已对 ${selected.size} 个服务商触发检测`); });
$('#btnDelSel').addEventListener('click', () => {
  const n = selected.size;
  confirmDialog('批量删除', `确定删除选中的 ${n} 个服务商吗？该操作不可撤销。`, async () => {
    await window.aipm.deleteMany([...selected]);
    selected.clear();
    toast('批量删除完成');
  });
});
$('#dashCheckAll').addEventListener('click', () => { window.aipm.checkAll(); toast('已触发全部检测'); });

// ---------- 新增/编辑弹窗 ----------
// 周期单位与换算同样取自 window.durfmt，避免与主进程口径漂移。
const INTERVAL_UNITS = window.durfmt.EDITABLE_UNITS;
const toSecondsUI = (value, unitKey) => window.durfmt.toSeconds(value, unitKey);
const fromSecondsUI = (sec) => window.durfmt.fromSeconds(sec);
// 填充单位下拉
(function initIntervalUnitSelect() {
  const sel = $('#fIntervalUnit');
  sel.innerHTML = INTERVAL_UNITS.map((u) => `<option value="${u.key}">${u.label}</option>`).join('');
})();

function openProviderModal(id = null) {
  editingId = id;
  $('#pmTitle').textContent = id ? '编辑服务商' : '新增服务商';
  $('#fError').textContent = '';
  const p = id ? state.providers.find((x) => x.id === id) : null;
  $('#fName').value = p ? p.name : '';
  $('#fUrl').value = p ? p.url : '';
  $('#fKey').value = '';
  $('#fKey').placeholder = p && p.hasApiKey ? `已保存（${p.apiKeyMasked}），留空则不修改` : 'sk-...';
  const iv = fromSecondsUI(p ? p.intervalSec : 300);
  $('#fInterval').value = iv.value;
  $('#fIntervalUnit').value = iv.unit;
  $('#fNotify').checked = p ? Boolean(p.notifyOnModelChange) : false;
  $('#fNote').value = p ? (p.note || '') : '';
  $('#fGroup').value = p ? (p.group || '') : '';
  $('#fTags').value = p && Array.isArray(p.tags) ? p.tags.join(', ') : '';
  $('#fProbeMode').value = (p && p.probeMode) || 'chat';
  $('#fProbeLimit').value = p && p.probeLimit ? p.probeLimit : '';
  $('#fProbePath').value = p ? (p.probePath || '') : '';
  $('#fProbeBody').value = p ? (p.probeBody || '') : '';
  $('#fProxyUrl').value = p ? (p.proxyUrl || '') : '';
  $('#fUseProxy').checked = p ? p.useProxy !== false : true;
  syncProbeCustomVisibility();
  $('#providerModal').classList.add('show');
  setTimeout(() => $('#fName').focus(), 120);
}
function syncProbeCustomVisibility() {
  const wrap = $('#fProbeCustomWrap');
  if (wrap) wrap.style.display = $('#fProbeMode').value === 'custom' ? '' : 'none';
}
$('#fProbeMode').addEventListener('change', syncProbeCustomVisibility);
$('#btnAdd').addEventListener('click', () => openProviderModal());
$('#pmClose').addEventListener('click', () => $('#providerModal').classList.remove('show'));
$('#pmCancel').addEventListener('click', () => $('#providerModal').classList.remove('show'));

$('#pmSave').addEventListener('click', async () => {
  const name = $('#fName').value.trim();
  let url = $('#fUrl').value.trim();
  const interval = toSecondsUI($('#fInterval').value, $('#fIntervalUnit').value);
  if (!name) { $('#fError').textContent = '请输入供应商名称'; return; }
  if (!url) { $('#fError').textContent = '请输入 URL'; return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (interval < 5) { $('#fError').textContent = '轮循周期不能小于 5 秒'; return; }

  const data = {
    name, url,
    apiKey: $('#fKey').value.trim() || undefined,
    intervalSec: interval,
    notifyOnModelChange: $('#fNotify').checked,
    note: $('#fNote').value.trim(),
    group: $('#fGroup').value.trim(),
    tags: $('#fTags').value.split(',').map((t) => t.trim()).filter(Boolean),
    probeMode: $('#fProbeMode').value,
    probePath: $('#fProbePath').value.trim(),
    probeBody: $('#fProbeBody').value.trim(),
    probeLimit: Number($('#fProbeLimit').value) > 0 ? Number($('#fProbeLimit').value) : null,
    proxyUrl: $('#fProxyUrl').value.trim(),
    useProxy: $('#fUseProxy').checked
  };
  if (editingId) {
    if (!data.apiKey) delete data.apiKey;
    await window.aipm.updateProvider(editingId, data);
    toast('已保存');
  } else {
    if (!data.apiKey) data.apiKey = '';
    await window.aipm.addProvider(data);
    toast('已添加');
  }
  $('#providerModal').classList.remove('show');
});
$('#providerModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
$('#detailModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });

// ---------- 详情弹窗 ----------
function openDetail(id) {
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  const si = statusInfo(p.status);
  const avail = p.modelsAvailable || [];
  const unavail = p.modelsUnavailable || [];
  const total = p.modelsTotal || (avail.length + unavail.length);
  const pct = total > 0 ? Math.round((avail.length / total) * 100) : 0;
  const details = p.modelDetails || [];
  const detailMap = new Map(details.map((d) => [d.id, d]));

  $('#dmTitle').textContent = p.name;
  $('#dmBanner').className = `dm-banner b-${si.cls}`;
  $('#dmBanner').innerHTML = `
    <span class="status-dot ${si.cls}"></span>
    <div class="dm-banner-main">
      <div class="dm-banner-status">${si.text}</div>
      <div class="dm-banner-sub">${avail.length}/${total} 模型可用 · 可用率 ${pct}%</div>
    </div>
    <div class="dm-banner-lat">${p.latency != null ? p.latency + ' ms' : '—'}</div>`;
  $('#dmMeta').innerHTML = `
    <div class="dm-item"><span>URL</span><b>${escapeHtml(p.url)}</b></div>
    <div class="dm-item"><span>API Key</span><b>${p.apiKeyMasked || '未配置'}</b></div>
    <div class="dm-item"><span>轮循周期</span><b>${fmtDuration(p.intervalSec)}</b></div>
    <div class="dm-item"><span>最近检测</span><b>${p.checkedAt ? new Date(p.checkedAt).toLocaleString('zh-CN') : '—'}</b></div>
    ${p.note ? `<div class="dm-item wide"><span>备注</span><b>${escapeHtml(p.note)}</b></div>` : ''}
    ${p.lastError ? `<div class="dm-item wide"><span>连接信息</span><b class="st-down">${escapeHtml(p.lastError)}</b></div>` : ''}`;
  $('#dmAvailCount').textContent = avail.length;
  $('#dmUnavailCount').textContent = unavail.length;
  $('#dmAvail').innerHTML = avail.length
    ? avail.map((m) => `<span class="model-tag" data-copy="${escapeHtml(m)}">${escapeHtml(m)}</span>`).join('')
    : '<span class="empty" style="padding:8px 0;">无</span>';
  $('#dmUnavail').innerHTML = unavail.length
    ? unavail.map((m) => {
        const d = detailMap.get(m);
        const reason = d && d.note ? d.note : '未探测';
        return `<div class="model-fail" data-copy="${escapeHtml(m)}">
          <span class="model-fail-name">${escapeHtml(m)}</span>
          <span class="model-fail-reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>
        </div>`;
      }).join('')
    : '<span class="empty" style="padding:8px 0;">无</span>';
  // 未探测模型（超出单轮上限）单独展示，避免与真实失败混淆
  const unprobed = p.modelsUnprobed || [];
  const upWrap = $('#dmUnprobedWrap');
  if (upWrap) {
    if (unprobed.length) {
      upWrap.style.display = '';
      $('#dmUnprobedCount').textContent = unprobed.length;
      $('#dmUnprobed').innerHTML = unprobed
        .map((m) => `<span class="model-tag muted" data-copy="${escapeHtml(m)}">${escapeHtml(m)}</span>`).join('');
    } else {
      upWrap.style.display = 'none';
    }
  }
  $('#detailModal').classList.add('show');
}
$('#dmClose').addEventListener('click', () => $('#detailModal').classList.remove('show'));
$('#detailModal').addEventListener('click', async (e) => {
  const tag = e.target.closest('[data-copy]');
  if (tag) {
    await navigator.clipboard.writeText(tag.dataset.copy);
    toast('已复制模型名');
  }
});

// ---------- 通知设置 ----------
function renderNotify() {
  const g = state.global || {};
  $('#wxEnable').checked = Boolean(g.notifyWeixinEnabled);
  $('#qqEnable').checked = Boolean(g.notifyQQEnabled);
  $('#dtEnable').checked = Boolean(g.notifyDingtalkEnabled);
  $('#wxWebhook').value = g.weixinWebhook || '';
  $('#qqWebhook').value = g.qqWebhook || '';
  $('#dtWebhook').value = g.dingtalkWebhook || '';
  $('#dtSecret').value = g.dingtalkSecret || '';
  $('#qqTarget').value = g.qqTarget || '';
  $('#qqTargetType').value = g.qqTargetType === 'group' ? 'group' : 'private';
  $('#qqToken').value = g.qqToken || '';
  $('#autoStart').checked = g.autoStartCheckOnLaunch !== false;
  $('#concurrency').value = g.concurrency || 4;
  $('#closeAction').value = g.closeAction === 'exit' ? 'exit' : 'tray';
  // 扩展通知渠道
  $('#tgEnable').checked = Boolean(g.notifyTelegramEnabled);
  $('#tgToken').value = g.telegramToken || '';
  $('#tgChatId').value = g.telegramChatId || '';
  $('#tgApiBase').value = g.telegramApiBase || '';
  $('#fsEnable').checked = Boolean(g.notifyFeishuEnabled);
  $('#fsWebhook').value = g.feishuWebhook || '';
  $('#fsSecret').value = g.feishuSecret || '';
  $('#skEnable').checked = Boolean(g.notifySlackEnabled);
  $('#skWebhook').value = g.slackWebhook || '';
  $('#scEnable').checked = Boolean(g.notifyServerChanEnabled);
  $('#scKey').value = g.serverchanKey || '';
  $('#cwEnable').checked = Boolean(g.notifyCustomEnabled);
  $('#cwWebhook').value = g.customWebhook || '';
  $('#cwTemplate').value = g.customTemplate || '';
  $('#cwHeaders').value = g.customHeaders || '';
  // 检测参数
  $('#probeLimit').value = g.probeLimit || 20;
  $('#requestTimeoutMs').value = g.requestTimeoutMs || 20000;
  $('#probeTimeoutMs').value = g.probeTimeoutMs || 15000;
  $('#retries').value = g.retries == null ? 1 : g.retries;
  // 告警策略
  $('#alertFailThreshold').value = g.alertFailThreshold || 2;
  $('#alertRecoverNotify').checked = g.alertRecoverNotify !== false;
  $('#alertCooldownMin').value = g.alertCooldownMin == null ? 10 : g.alertCooldownMin;
  $('#alertOnModelChange').checked = g.alertOnModelChange !== false;
  $('#alertQuietEnabled').checked = Boolean(g.alertQuietEnabled);
  $('#alertQuietStart').value = g.alertQuietStart || '23:00';
  $('#alertQuietEnd').value = g.alertQuietEnd || '07:00';
  // 代理
  $('#proxyEnabled').checked = Boolean(g.proxyEnabled);
  $('#proxyUrl').value = g.proxyUrl || '';
  // 历史与日志
  $('#historyEnabled').checked = g.historyEnabled !== false;
  $('#historyKeepDays').value = g.historyKeepDays || 30;
  $('#logKeepDays').value = g.logKeepDays || 7;
  $('#logMaxFileMB').value = g.logMaxFileMB || 10;
  $('#logLevel').value = g.logLevel || 'info';
  // 外观与启动
  $('#theme').value = g.theme || 'system';
  $('#launchAtLogin').checked = Boolean(g.launchAtLogin);
  $('#launchMinimized').checked = Boolean(g.launchMinimized);
}
let notifySaveTimer = null;
function saveNotify() {
  clearTimeout(notifySaveTimer);
  notifySaveTimer = setTimeout(async () => {
    const int = (sel, def, min, max) => {
      const v = Number($(sel).value);
      if (!Number.isFinite(v)) return def;
      return Math.max(min, Math.min(max, Math.round(v)));
    };
    await window.aipm.setGlobal({
      notifyWeixinEnabled: $('#wxEnable').checked,
      weixinWebhook: $('#wxWebhook').value.trim(),
      notifyQQEnabled: $('#qqEnable').checked,
      qqWebhook: $('#qqWebhook').value.trim(),
      qqTarget: $('#qqTarget').value.trim(),
      qqTargetType: $('#qqTargetType').value,
      qqToken: $('#qqToken').value.trim(),
      notifyDingtalkEnabled: $('#dtEnable').checked,
      dingtalkWebhook: $('#dtWebhook').value.trim(),
      dingtalkSecret: $('#dtSecret').value.trim(),
      notifyTelegramEnabled: $('#tgEnable').checked,
      telegramToken: $('#tgToken').value.trim(),
      telegramChatId: $('#tgChatId').value.trim(),
      telegramApiBase: $('#tgApiBase').value.trim() || 'https://api.telegram.org',
      notifyFeishuEnabled: $('#fsEnable').checked,
      feishuWebhook: $('#fsWebhook').value.trim(),
      feishuSecret: $('#fsSecret').value.trim(),
      notifySlackEnabled: $('#skEnable').checked,
      slackWebhook: $('#skWebhook').value.trim(),
      notifyServerChanEnabled: $('#scEnable').checked,
      serverchanKey: $('#scKey').value.trim(),
      notifyCustomEnabled: $('#cwEnable').checked,
      customWebhook: $('#cwWebhook').value.trim(),
      customTemplate: $('#cwTemplate').value.trim(),
      customHeaders: $('#cwHeaders').value.trim(),
      probeLimit: int('#probeLimit', 20, 1, 100),
      requestTimeoutMs: int('#requestTimeoutMs', 20000, 1000, 120000),
      probeTimeoutMs: int('#probeTimeoutMs', 15000, 1000, 120000),
      retries: int('#retries', 1, 0, 5),
      alertFailThreshold: int('#alertFailThreshold', 2, 1, 20),
      alertRecoverNotify: $('#alertRecoverNotify').checked,
      alertCooldownMin: int('#alertCooldownMin', 10, 0, 1440),
      alertOnModelChange: $('#alertOnModelChange').checked,
      alertQuietEnabled: $('#alertQuietEnabled').checked,
      alertQuietStart: $('#alertQuietStart').value || '23:00',
      alertQuietEnd: $('#alertQuietEnd').value || '07:00',
      proxyEnabled: $('#proxyEnabled').checked,
      proxyUrl: $('#proxyUrl').value.trim(),
      historyEnabled: $('#historyEnabled').checked,
      historyKeepDays: int('#historyKeepDays', 30, 1, 365),
      logKeepDays: int('#logKeepDays', 7, 1, 365),
      logMaxFileMB: int('#logMaxFileMB', 10, 1, 200),
      logLevel: $('#logLevel').value || 'info',
      theme: $('#theme').value || 'system',
      launchAtLogin: $('#launchAtLogin').checked,
      launchMinimized: $('#launchMinimized').checked,
      autoStartCheckOnLaunch: $('#autoStart').checked,
      concurrency: Math.max(1, Math.min(16, Number($('#concurrency').value) || 4)),
      closeAction: $('#closeAction').value === 'exit' ? 'exit' : 'tray'
    });
  }, 350);
}
['wxEnable', 'qqEnable', 'dtEnable', 'autoStart', 'tgEnable', 'fsEnable', 'skEnable', 'scEnable', 'cwEnable',
 'alertRecoverNotify', 'alertOnModelChange', 'alertQuietEnabled', 'proxyEnabled', 'historyEnabled',
 'launchAtLogin', 'launchMinimized']
  .forEach((id) => { const el = $('#' + id); if (el) el.addEventListener('change', saveNotify); });
['wxWebhook', 'qqWebhook', 'qqTarget', 'qqToken', 'dtWebhook', 'dtSecret', 'concurrency',
 'tgToken', 'tgChatId', 'tgApiBase', 'fsWebhook', 'fsSecret', 'skWebhook', 'scKey',
 'cwWebhook', 'cwTemplate', 'cwHeaders', 'probeLimit', 'requestTimeoutMs', 'probeTimeoutMs', 'retries',
 'alertFailThreshold', 'alertCooldownMin', 'alertQuietStart', 'alertQuietEnd', 'proxyUrl',
 'historyKeepDays', 'logKeepDays', 'logMaxFileMB']
  .forEach((id) => { const el = $('#' + id); if (el) el.addEventListener('input', saveNotify); });
$('#qqTargetType').addEventListener('change', saveNotify);
$('#closeAction').addEventListener('change', saveNotify);
$('#logLevel').addEventListener('change', saveNotify);
$('#theme').addEventListener('change', () => { saveNotify(); setTimeout(applyTheme, 400); });

// 指引折叠
$$('.guide-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const guide = document.getElementById(btn.dataset.guide);
    if (guide) guide.closest('.guide').classList.toggle('open');
  });
});

$('#wxTest').addEventListener('click', async () => {
  saveNotify();
  $('#wxHint').textContent = '发送中…'; $('#wxHint').className = 'hint';
  const r = await window.aipm.testNotify('weixin');
  $('#wxHint').textContent = r.ok ? '发送成功' : '失败: ' + r.error;
  $('#wxHint').className = 'hint ' + (r.ok ? 'ok' : 'bad');
});
$('#qqTest').addEventListener('click', async () => {
  saveNotify();
  $('#qqHint').textContent = '发送中…'; $('#qqHint').className = 'hint';
  const r = await window.aipm.testNotify('qq');
  $('#qqHint').textContent = r.ok ? '发送成功' : '失败: ' + r.error;
  $('#qqHint').className = 'hint ' + (r.ok ? 'ok' : 'bad');
});
$('#dtTest').addEventListener('click', async () => {
  saveNotify();
  $('#dtHint').textContent = '发送中…'; $('#dtHint').className = 'hint';
  const r = await window.aipm.testNotify('dingtalk');
  $('#dtHint').textContent = r.ok ? '发送成功' : '失败: ' + r.error;
  $('#dtHint').className = 'hint ' + (r.ok ? 'ok' : 'bad');
});

/** 扩展渠道测试按钮：先落盘配置再发测试，避免用刚输入但未保存的值失败 */
[['tgTest', 'tgHint', 'telegram'], ['fsTest', 'fsHint', 'feishu'], ['skTest', 'skHint', 'slack'],
 ['scTest', 'scHint', 'serverchan'], ['cwTest', 'cwHint', 'custom']]
  .forEach(([btnId, hintId, channel]) => {
    const btn = $('#' + btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      saveNotify();
      const hint = $('#' + hintId);
      hint.textContent = '发送中…'; hint.className = 'hint';
      // 等待防抖保存落盘后再发送
      await new Promise((r) => setTimeout(r, 420));
      const r = await window.aipm.testNotify(channel);
      hint.textContent = r.ok ? '发送成功' : '失败: ' + r.error;
      hint.className = 'hint ' + (r.ok ? 'ok' : 'bad');
    });
  });

// ---------- 统计分析 ----------
function statsHours() {
  const v = Number(($('#stRange') && $('#stRange').value) || 24);
  return v > 0 ? v : 24;
}

async function renderStats() {
  const hours = statsHours();
  const [sum, ser] = await Promise.all([
    window.aipm.historySummary({ hours }),
    window.aipm.historySeries({ hours, buckets: 48 })
  ]);
  if (!sum.ok) { $('#stTable').innerHTML = `<div class="empty">统计读取失败：${escapeHtml(sum.error || '')}</div>`; return; }

  const o = sum.overall;
  $('#stUptime').textContent = o.samples ? o.uptime + '%' : '—';
  $('#stProviders').textContent = o.providers;
  $('#stSamples').textContent = o.samples;
  $('#stP95').textContent = o.latencyP95 != null ? o.latencyP95 + ' ms' : '—';

  if (ser.ok) drawChart(ser);
  $('#stChartHint').textContent = o.samples
    ? `${o.samples} 个样本 · 每桶约 ${Math.round((ser.bucketMs || 0) / 60000)} 分钟`
    : '暂无历史数据，检测运行一段时间后自动积累';

  const rows = sum.perProvider;
  if (!rows.length) {
    $('#stTable').innerHTML = '<div class="empty">该时间范围内暂无检测记录</div>';
    return;
  }
  $('#stTable').innerHTML = `
    <div class="st-row st-head">
      <div>服务商</div><div>样本</div><div>可用率</div>
      <div>在线/异常/离线</div><div>故障时长</div><div>平均延迟</div><div>P95</div><div>最后状态</div>
    </div>` + rows.map((p) => {
    const cls = p.uptime >= 99 ? 'up' : p.uptime >= 90 ? 'degraded' : 'down';
    const si = statusInfo(p.lastStatus);
    return `<div class="st-row">
      <div class="st-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
      <div>${p.samples}</div>
      <div><span class="st-uptime u-${cls}">${p.uptime}%</span></div>
      <div class="st-mini">${p.upCount}/${p.degCount}/${p.downCount}</div>
      <div class="st-mini">${fmtMsShort(p.downMs)}</div>
      <div>${p.latencyAvg != null ? p.latencyAvg + ' ms' : '—'}</div>
      <div>${p.latencyP95 != null ? p.latencyP95 + ' ms' : '—'}</div>
      <div><span class="status-pill st-${si.cls}">${si.text}</span></div>
    </div>`;
  }).join('');
}

function fmtMsShort(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  if (s <= 0) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** 内联 SVG 双轴折线图：可用率(绿, 0-100) + 平均延迟(蓝, 自适应) */
function drawChart(ser) {
  const W = 900, H = 200, PAD = { l: 38, r: 44, t: 12, b: 22 };
  const pts = ser.buckets || [];
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const valid = pts.filter((b) => b.samples > 0);
  if (!valid.length) {
    $('#stChart').innerHTML = '<div class="empty" style="padding:48px 0;">暂无数据</div>';
    return;
  }
  const maxLat = Math.max(1, ...valid.map((b) => b.latencyAvg || 0));
  const x = (i) => PAD.l + (pts.length <= 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const yU = (v) => PAD.t + ih - (v / 100) * ih;
  const yL = (v) => PAD.t + ih - (v / maxLat) * ih;

  const seg = (key, yfn) => {
    const out = [];
    let cur = [];
    pts.forEach((b, i) => {
      const v = b[key];
      if (v == null) { if (cur.length) { out.push(cur); cur = []; } return; }
      cur.push(`${x(i).toFixed(1)},${yfn(v).toFixed(1)}`);
    });
    if (cur.length) out.push(cur);
    return out.map((c) => `<polyline points="${c.join(' ')}" fill="none" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  };

  const grid = [0, 25, 50, 75, 100].map((v) =>
    `<line x1="${PAD.l}" y1="${yU(v)}" x2="${W - PAD.r}" y2="${yU(v)}" class="ch-grid"/>
     <text x="${PAD.l - 6}" y="${yU(v) + 4}" class="ch-lbl" text-anchor="end">${v}</text>`).join('');

  const t0 = new Date(ser.from), t1 = new Date(ser.to);
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  $('#stChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="ch-svg">
    ${grid}
    <g class="ch-lat">${seg('latencyAvg', yL)}</g>
    <g class="ch-up">${seg('uptime', yU)}</g>
    <text x="${PAD.l}" y="${H - 6}" class="ch-lbl">${hm(t0)}</text>
    <text x="${W - PAD.r}" y="${H - 6}" class="ch-lbl" text-anchor="end">${hm(t1)}</text>
    <text x="${W - PAD.r + 6}" y="${PAD.t + 8}" class="ch-lbl">${maxLat}ms</text>
  </svg>`;
}

if ($('#stRefresh')) {
  $('#stRefresh').addEventListener('click', renderStats);
  $('#stRange').addEventListener('change', renderStats);
  $('#stExportCsv').addEventListener('click', async () => {
    const r = await window.aipm.historyExportCSV({ hours: statsHours() });
    if (r.ok) toast('历史明细已导出');
    else if (!r.canceled) toast('导出失败: ' + r.error, 'err');
  });
  $('#stExportReport').addEventListener('click', async () => {
    const r = await window.aipm.reportExport({ format: 'html', hours: statsHours() });
    if (r.ok) toast('状态报告已导出');
    else if (!r.canceled) toast('导出失败: ' + r.error, 'err');
  });
}

// ---------- 日志 ----------
let logLines = [];
let logsLoaded = false;
function renderLogs() {
  if (!logsLoaded) {
    logsLoaded = true;
    window.aipm.getLogs().then((lines) => { logLines = lines; appendLogLines(lines, true); });
  }
}
function logMatchesFilter(l) {
  const q = ($('#logFilter').value || '').trim().toLowerCase();
  if (!q) return true;
  return (l.msg || '').toLowerCase().includes(q);
}

function appendLogLines(lines, replace = false) {
  const card = $('#logCard');
  if (replace) card.innerHTML = '';
  for (const l of lines) {
    if (!logMatchesFilter(l)) continue;
    const div = document.createElement('div');
    div.className = `log-line l-${l.level}`;
    div.innerHTML = `<span class="log-time">${escapeHtml(l.t)}</span><span class="log-msg">${escapeHtml(l.msg)}</span>`;
    card.appendChild(div);
  }
  while (card.children.length > 600) card.removeChild(card.firstChild);
  if ($('#autoScroll').checked) card.scrollTop = card.scrollHeight;
}
window.aipm.onLogLine((l) => {
  logLines.push(l);
  if (view === 'logs') appendLogLines([l]);
});

// 日志过滤：输入时按当前过滤条件重放全部缓冲日志
$('#logFilter').addEventListener('input', () => {
  const card = $('#logCard');
  card.innerHTML = '';
  appendLogLines(logLines, true);
});

// 清除日志（仅清空界面与内存缓冲，不删除磁盘日志文件）
$('#logClear').innerHTML = icon('trash') + '<span>清除</span>';
$('#logClear').addEventListener('click', () => {
  confirmDialog('清除日志', '确定清除当前显示的日志吗？（磁盘日志文件保留）', async () => {
    await window.aipm.clearLogs();
    logLines = [];
    $('#logCard').innerHTML = '';
    toast('日志已清除');
  }, { okText: '清除', danger: true });
});

// ---------- 备份与还原 ----------
let bkPickedFile = null;

function renderBackup() {
  window.aipm.backupListAuto().then((r) => {
    if (!r.ok) return;
    $('#bkOpenDir').textContent = '打开备份目录';
    const wrap = $('#bkList');
    if (!r.list.length) {
      wrap.innerHTML = '<div class="empty" style="padding:18px 0;">暂无自动备份记录，每天首次启动会自动生成一份</div>';
      return;
    }
    wrap.innerHTML = r.list.map((f) => {
      const d = f.at ? new Date(f.at) : null;
      const when = d ? `${d.getFullYear()}/${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')} ${fmtTime(d.getTime())}` : f.file;
      return `<div class="bk-item" data-bkpath="${escapeHtml(f.path)}">
        <span class="nav-ic bk-item-ic">${icon('archive')}</span>
        <div class="bk-item-main">
          <div class="bk-item-name">${escapeHtml(f.file)}</div>
          <div class="bk-item-sub">${when} · ${f.count} 个服务商 · ${(f.size / 1024).toFixed(1)} KB</div>
        </div>
        <button class="btn small ghost" data-bkrestore="${escapeHtml(f.path)}">还原</button>
      </div>`;
    }).join('');
  }).catch(() => {});
}

$('#nav-backup').addEventListener('click', renderBackup);
$('#bkRefresh').addEventListener('click', renderBackup);
$('#bkOpenDir').addEventListener('click', async () => {
  const r = await window.aipm.backupListAuto();
  if (r.ok && r.dir) window.aipm.openPath(r.dir);
});

$('#bkSaveAs').addEventListener('click', async () => {
  $('#bkHint').textContent = '';
  const r = await window.aipm.backupSaveAs();
  $('#bkHint').textContent = r.ok ? '已备份' : (r.canceled ? '' : '失败: ' + r.error);
  $('#bkHint').className = 'hint ' + (r.ok ? 'ok' : 'bad');
  if (r.ok) toast('备份完成');
});

$('#bkQuick').addEventListener('click', async () => {
  $('#bkHint').textContent = '';
  const r = await window.aipm.backupExport();
  $('#bkHint').textContent = r.ok ? '已备份到备份目录' : '失败: ' + r.error;
  $('#bkHint').className = 'hint ' + (r.ok ? 'ok' : 'bad');
  if (r.ok) { toast('备份完成'); renderBackup(); }
});

function bkSelectedMode() {
  return document.querySelector('input[name="bkMode"]:checked').value;
}

$('#bkPick').addEventListener('click', async () => {
  const r = await window.aipm.backupPickFile();
  if (r.canceled) return;
  if (!r.ok) { toast('读取备份失败: ' + r.error, 'err'); return; }
  bkPickedFile = r.path;
  $('#bkPicked').style.display = 'flex';
  $('#bkPicked').innerHTML = `${icon('check')}<span>已选择：<b>${escapeHtml(r.path.split(/[\\/]/).pop())}</b>（${r.count} 个服务商${r.hasGlobal ? '，含通知设置' : ''}）</span>`;
  $('#bkRestore').disabled = false;
});

$('#bkRestore').addEventListener('click', () => {
  if (!bkPickedFile) return;
  const mode = bkSelectedMode();
  const modeText = mode === 'merge' ? '合并还原' : '覆盖还原';
  confirmDialog(
    modeText,
    mode === 'merge'
      ? '将把备份中的服务商并入当前列表（按 URL 去重），通知设置保持不变。确定继续吗？'
      : '当前全部数据（服务商与通知设置）将被备份内容替换。确定继续吗？',
    async () => {
      const r = await window.aipm.backupRestore(bkPickedFile, mode);
      if (r.ok) {
        const detail = mode === 'merge' ? `新增 ${r.added}，更新 ${r.updated}` : `共 ${r.providers} 个服务商`;
        toast(`还原完成：${detail}`);
      } else {
        toast('还原失败: ' + r.error, 'err');
      }
    }
  );
});

// 自动备份列表「还原」按钮
$('#bkList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bkrestore]');
  if (!btn) return;
  const filePath = btn.dataset.bkrestore;
  confirmDialog(
    '覆盖还原',
    '当前全部数据（服务商与通知设置）将被该备份替换。确定继续吗？',
    async () => {
      const r = await window.aipm.backupRestore(filePath, 'overwrite');
      if (r.ok) toast(`还原完成：共 ${r.providers} 个服务商`);
      else toast('还原失败: ' + r.error, 'err');
    }
  );
});

// ---------- 服务商批量导入 / 导出 ----------
let emState = { format: 'json', delimiter: 'tab' };
let imState = { format: 'json', delimiter: 'tab', items: null, errors: [] };

$('#btnImport').textContent = '导入';
$('#btnExport').textContent = '导出';
$('#emClose').innerHTML = icon('close');
$('#imClose').innerHTML = icon('close');

function bindSeg(segId, onPick) {
  const seg = $('#' + segId);
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-item');
    if (!btn) return;
    $$('.seg-item', seg).forEach((b) => b.classList.toggle('active', b === btn));
    onPick(btn);
  });
}

// ----- 导出 -----
$('#btnExport').addEventListener('click', () => {
  if (state.providers.length === 0) { toast('暂无服务商可导出', 'err'); return; }
  emState = { format: 'json', delimiter: 'tab' };
  $$('#emFormat .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.fmt === 'json'));
  $$('#emDelim .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.d === 'tab'));
  $('#emDelimField').style.display = 'none';
  $('#emWithKey').checked = true;
  $('#emError').textContent = '';
  refreshExportPreview();
  $('#exportModal').classList.add('show');
});
$('#emClose').addEventListener('click', () => $('#exportModal').classList.remove('show'));
$('#emCancel').addEventListener('click', () => $('#exportModal').classList.remove('show'));
$('#exportModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });

bindSeg('emFormat', (btn) => {
  emState.format = btn.dataset.fmt;
  $('#emDelimField').style.display = emState.format === 'text' ? '' : 'none';
  refreshExportPreview();
});
bindSeg('emDelim', (btn) => { emState.delimiter = btn.dataset.d; refreshExportPreview(); });
$('#emWithKey').addEventListener('change', refreshExportPreview);

async function refreshExportPreview() {
  const r = await window.aipm.transferExport({ format: emState.format, delimiter: emState.delimiter, withKey: $('#emWithKey').checked });
  if (r.ok) {
    $('#emPreview').textContent = r.content.length > 2000 ? r.content.slice(0, 2000) + '\n…' : r.content;
    $('#emError').textContent = '';
  } else {
    $('#emError').textContent = r.error;
  }
}

$('#emCopy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#emPreview').textContent);
  toast('已复制到剪贴板');
});

$('#emSave').addEventListener('click', async () => {
  const r = await window.aipm.transferExportSaveAs({ format: emState.format, delimiter: emState.delimiter, withKey: $('#emWithKey').checked });
  if (r.canceled) return;
  if (r.ok) { toast('已导出到文件'); $('#exportModal').classList.remove('show'); }
  else $('#emError').textContent = r.error;
});

// ----- 导入 -----
let imParsed = null;
$('#btnImport').addEventListener('click', () => {
  imParsed = null;
  imState = { format: 'json', delimiter: 'tab', items: null, errors: [] };
  $$('#imFormat .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.fmt === 'json'));
  $$('#imDelim .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.d === 'tab'));
  $('#imDelimField').style.display = 'none';
  $('#imText').value = '';
  $('#imResult').style.display = 'none';
  $('#imError').textContent = '';
  $('#imHint').textContent = '';
  $('#imApply').disabled = true;
  document.querySelector('input[name="imMode"][value="merge"]').checked = true;
  $('#importModal').classList.add('show');
});
$('#imClose').addEventListener('click', () => $('#importModal').classList.remove('show'));
$('#imCancel').addEventListener('click', () => $('#importModal').classList.remove('show'));
$('#importModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });

bindSeg('imFormat', (btn) => {
  imState.format = btn.dataset.fmt;
  $('#imDelimField').style.display = imState.format === 'text' ? '' : 'none';
});
bindSeg('imDelim', (btn) => { imState.delimiter = btn.dataset.d; });

$('#imPick').addEventListener('click', async () => {
  // 复用隐藏 file input 读取文本
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.csv,.txt,text/plain,application/json';
  input.onchange = async () => {
    if (!input.files.length) return;
    const f = input.files[0];
    const text = await f.text();
    $('#imText').value = text;
    // 按扩展名自动猜测格式
    if (/\.csv$/i.test(f.name)) { imState.format = 'csv'; $$('#imFormat .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.fmt === 'csv')); $('#imDelimField').style.display = 'none'; }
    else if (/\.txt$/i.test(f.name)) { imState.format = 'text'; $$('#imFormat .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.fmt === 'text')); $('#imDelimField').style.display = ''; }
    else { imState.format = 'json'; $$('#imFormat .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.fmt === 'json')); $('#imDelimField').style.display = 'none'; }
    parseAndPreviewImport();
  };
  input.click();
});

$('#imPreviewBtn').addEventListener('click', parseAndPreviewImport);

async function parseAndPreviewImport() {
  const text = $('#imText').value;
  if (!text.trim()) { $('#imError').textContent = '请先粘贴内容或选择文件'; return; }
  $('#imError').textContent = '';
  const r = await window.aipm.transferParse({ text, format: imState.format, delimiter: imState.delimiter });
  if (!r.ok) { $('#imError').textContent = r.error; $('#imApply').disabled = true; imParsed = null; return; }
  imParsed = r;
  const box = $('#imResult');
  box.style.display = '';
  if (r.items.length === 0) {
    box.innerHTML = '<span class="io-err">未解析到有效条目</span>' +
      (r.errors.length ? `<ul>${r.errors.map((e) => `<li>第 ${e.line} 行：${escapeHtml(e.msg)}</li>`).join('')}</ul>` : '');
    $('#imApply').disabled = true;
    return;
  }
  const errHtml = r.errors.length
    ? `<div class="io-err">${r.errors.length} 条已跳过：</div><ul>${r.errors.slice(0, 5).map((e) => `<li>第 ${e.line} 行：${escapeHtml(e.msg)}</li>`).join('')}${r.errors.length > 5 ? `<li>… 共 ${r.errors.length} 条</li>` : ''}</ul>`
    : '';
  box.innerHTML = `<span class="io-ok">解析成功：${r.items.length} 条服务商</span>${errHtml}
    <ul>${r.items.slice(0, 5).map((p) => `<li>${escapeHtml(p.name)} — ${escapeHtml(p.url)}（周期 ${fmtDuration(p.intervalSec)}，上报 ${p.notifyOnModelChange ? '开' : '关'}）</li>`).join('')}${r.items.length > 5 ? `<li>… 共 ${r.items.length} 条</li>` : ''}</ul>`;
  $('#imApply').disabled = false;
}

$('#imApply').addEventListener('click', async () => {
  if (!imParsed || !imParsed.items.length) return;
  const mode = document.querySelector('input[name="imMode"]:checked').value;
  const modeText = mode === 'append' ? '追加' : '合并';
  confirmDialog(
    `确认${modeText}导入`,
    `将${modeText}导入 ${imParsed.items.length} 条服务商${mode === 'append' ? '（URL 重复也会新增）' : '（URL 相同的现有服务商将被更新）'}。确定继续吗？`,
    async () => {
      const r = await window.aipm.transferApply({ items: imParsed.items, mode });
      if (r.ok) {
        toast(`导入完成：新增 ${r.added}${r.updated ? `，更新 ${r.updated}` : ''}`);
        $('#importModal').classList.remove('show');
      } else {
        $('#imError').textContent = '导入失败: ' + r.error;
      }
    },
    { okText: '开始导入', danger: false }
  );
});

// ---------- 其它 ----------
// 注意：渲染进程无 require（contextIsolation + nodeIntegration:false），
// 数据目录由主进程通过 publicState().dataDir 下发
$('#openDataDir').addEventListener('click', () => {
  const dir = state.dataDir || (state.dataFile ? state.dataFile.replace(/[\\/][^\\/]*$/, '') : '');
  if (dir) window.aipm.openPath(dir);
});
$('#openLogDir').addEventListener('click', () => window.aipm.openPath(state.logDir || ''));

// ---------- 启动 ----------
window.aipm.onStateChanged((s) => { state = s; render(); });
window.aipm.getState().then((s) => { state = s; render(); });
window.aipm.getAppVersion().then((v) => { $('#appVersion').textContent = 'V' + v; }).catch(() => {});
initStaticIcons();
render();
