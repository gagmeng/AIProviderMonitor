'use strict';
/* global icon */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let state = { providers: [], global: {}, running: [], dataFile: '', logDir: '' };
let selected = new Set();
let editingId = null;
let view = 'dashboard';

// ---------- 初始化静态图标 ----------
function initStaticIcons() {
  $('#brandMark').innerHTML = icon('activity');
  $$('.nav-ic').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  $$('.search-ic').forEach((el) => { el.innerHTML = icon(el.dataset.icon || 'search'); });
  $('#dashCheckAll').innerHTML = icon('refresh') + '<span>检测全部</span>';
  $('#btnAdd').innerHTML = icon('plus') + '<span>新增服务商</span>';
  $('#btnCheckSel').innerHTML = icon('play') + '<span>检测</span>';
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
// 周期智能格式化（与主进程 durfmt.js 同规则；列表空间有限，分钟/小时用短单位）
const DUR_UNITS = [
  { label: '秒', factor: 1 }, { label: '分', factor: 60 }, { label: '时', factor: 3600 },
  { label: '天', factor: 86400 }, { label: '周', factor: 604800 },
  { label: '月', factor: 2592000 }, { label: '年', factor: 31536000 }
];
function fmtDuration(sec) {
  sec = Math.max(1, Math.round(Number(sec) || 0));
  let bi = 0;
  for (let i = DUR_UNITS.length - 1; i >= 0; i--) { if (sec >= DUR_UNITS[i].factor) { bi = i; break; } }
  const u = DUR_UNITS[bi];
  if (sec % u.factor === 0) {
    const v = sec / u.factor;
    if (u.label === '月' && v % 12 === 0) return `${v / 12} 年`;
    return `${v} ${u.label}`;
  }
  if (bi === 0) return `${sec} 秒`;
  const major = Math.floor(sec / u.factor);
  const minor = Math.round((sec % u.factor) / DUR_UNITS[bi - 1].factor);
  if (minor > 0) return `${major} ${u.label} ${minor} ${DUR_UNITS[bi - 1].label}`;
  return `${major} ${u.label}`;
}

function render() {
  renderNav();
  if (view === 'dashboard') renderDashboard();
  if (view === 'providers') renderProviders();
  $('#footRunning').textContent = state.running.length;
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
  if (!q) return state.providers;
  return state.providers.filter((p) =>
    (p.name || '').toLowerCase().includes(q) ||
    (p.url || '').toLowerCase().includes(q) ||
    (p.note || '').toLowerCase().includes(q));
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
  $('#selAll').checked = allChecked;
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

// 双击行任意位置打开详情（排除操作按钮与复选框）
$('#providerList').addEventListener('dblclick', (e) => {
  if (e.target.closest('.op-btn, .checkbox, input')) return;
  const row = e.target.closest('.p-row[data-id]');
  if (row) openDetail(Number(row.dataset.id));
});

// 全选 / 反选
$('#selAll').addEventListener('change', () => {
  const list = filteredProviders();
  if ($('#selAll').checked) list.forEach((p) => selected.add(p.id));
  else list.forEach((p) => selected.delete(p.id));
  renderProviders();
});
$('#btnInvert').addEventListener('click', () => {
  filteredProviders().forEach((p) => selected.has(p.id) ? selected.delete(p.id) : selected.add(p.id));
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
// 周期单位（与主进程 durfmt.js 保持一致）
const INTERVAL_UNITS = [
  { key: 'sec', label: '秒', factor: 1 },
  { key: 'min', label: '分', factor: 60 },
  { key: 'hour', label: '时', factor: 3600 },
  { key: 'day', label: '天', factor: 86400 },
  { key: 'week', label: '周', factor: 604800 },
  { key: 'month', label: '月', factor: 2592000 },
  { key: 'year', label: '年', factor: 31536000 }
];
function toSecondsUI(value, unitKey) {
  const u = INTERVAL_UNITS.find((x) => x.key === unitKey) || INTERVAL_UNITS[0];
  return Math.max(5, Math.round((Number(value) || 0) * u.factor));
}
function fromSecondsUI(sec) {
  sec = Math.max(1, Math.round(Number(sec) || 0));
  for (let i = INTERVAL_UNITS.length - 1; i >= 0; i--) {
    const u = INTERVAL_UNITS[i];
    if (sec >= u.factor && sec % u.factor === 0) {
      if (u.key === 'month' && (sec / u.factor) % 12 === 0) return { value: sec / 31536000, unit: 'year' };
      return { value: sec / u.factor, unit: u.key };
    }
  }
  return { value: sec, unit: 'sec' };
}
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
  $('#providerModal').classList.add('show');
  setTimeout(() => $('#fName').focus(), 120);
}
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
    note: $('#fNote').value.trim()
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
}
let notifySaveTimer = null;
function saveNotify() {
  clearTimeout(notifySaveTimer);
  notifySaveTimer = setTimeout(async () => {
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
      autoStartCheckOnLaunch: $('#autoStart').checked,
      concurrency: Math.max(1, Math.min(16, Number($('#concurrency').value) || 4)),
      closeAction: $('#closeAction').value === 'exit' ? 'exit' : 'tray'
    });
  }, 350);
}
['wxEnable', 'qqEnable', 'dtEnable', 'autoStart'].forEach((id) => $('#' + id).addEventListener('change', saveNotify));
['wxWebhook', 'qqWebhook', 'qqTarget', 'qqToken', 'dtWebhook', 'dtSecret', 'concurrency'].forEach((id) => $('#' + id).addEventListener('input', saveNotify));
$('#qqTargetType').addEventListener('change', saveNotify);
$('#closeAction').addEventListener('change', saveNotify);

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

$('#btnImport').innerHTML = icon('inbox') + '<span>导入</span>';
$('#btnExport').innerHTML = icon('copy') + '<span>导出</span>';
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
    box.innerHTML = `<span class="io-err">未解析到有效条目</span>` +
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
$('#openDataDir').addEventListener('click', () => window.aipm.openPath(state.dataFile ? require('path').dirname(state.dataFile) : ''));
$('#openLogDir').addEventListener('click', () => window.aipm.openPath(state.logDir || ''));

// ---------- 启动 ----------
window.aipm.onStateChanged((s) => { state = s; render(); });
window.aipm.getState().then((s) => { state = s; render(); });
window.aipm.getAppVersion().then((v) => { $('#appVersion').textContent = 'V' + v; }).catch(() => {});
initStaticIcons();
render();
