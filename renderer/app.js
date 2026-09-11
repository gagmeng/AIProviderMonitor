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
function confirmDialog(title, text, cb) {
  $('#cfTitle').textContent = title;
  $('#cfText').textContent = text;
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
      const cycleMin = p.intervalSec >= 60 ? `${Math.round(p.intervalSec / 60)} 分钟` : `${p.intervalSec} 秒`;
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
function openProviderModal(id = null) {
  editingId = id;
  $('#pmTitle').textContent = id ? '编辑服务商' : '新增服务商';
  $('#fError').textContent = '';
  const p = id ? state.providers.find((x) => x.id === id) : null;
  $('#fName').value = p ? p.name : '';
  $('#fUrl').value = p ? p.url : '';
  $('#fKey').value = '';
  $('#fKey').placeholder = p && p.hasApiKey ? `已保存（${p.apiKeyMasked}），留空则不修改` : 'sk-...';
  $('#fInterval').value = p ? p.intervalSec : 60;
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
  const interval = Number($('#fInterval').value) || 60;
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
    <div class="dm-item"><span>轮循周期</span><b>${p.intervalSec >= 60 ? Math.round(p.intervalSec / 60) + ' 分钟' : p.intervalSec + ' 秒'}</b></div>
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
      concurrency: Math.max(1, Math.min(16, Number($('#concurrency').value) || 4))
    });
  }, 350);
}
['wxEnable', 'qqEnable', 'dtEnable', 'autoStart'].forEach((id) => $('#' + id).addEventListener('change', saveNotify));
['wxWebhook', 'qqWebhook', 'qqTarget', 'qqToken', 'dtWebhook', 'dtSecret', 'concurrency'].forEach((id) => $('#' + id).addEventListener('input', saveNotify));
$('#qqTargetType').addEventListener('change', saveNotify);

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

// ---------- 其它 ----------
$('#openDataDir').addEventListener('click', () => window.aipm.openPath(state.dataFile ? require('path').dirname(state.dataFile) : ''));
$('#openLogDir').addEventListener('click', () => window.aipm.openPath(state.logDir || ''));

// ---------- 启动 ----------
window.aipm.onStateChanged((s) => { state = s; render(); });
window.aipm.getState().then((s) => { state = s; render(); });
initStaticIcons();
render();
