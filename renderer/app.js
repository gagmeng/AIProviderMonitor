'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let state = { providers: [], global: {}, running: [], dataFile: '', logDir: '' };
const selected = new Set();
let editingId = null;
let view = 'dashboard';
const viewScrollPositions = new Map();
let settingsCategory = 'appearance';

// ---------- 界面语言（v1.2.0：中文原文作 key，zh 直接返回原文） ----------
const lang = () => (state.global && state.global.lang) || 'zh';
const tx = (key, vars) => (window.aipmi18n ? window.aipmi18n.t(lang(), key, vars) : key);
const applyLang = () => { if (window.aipmi18n) window.aipmi18n.applyI18n(lang()); };

// ---------- 初始化静态图标 ----------
function initStaticIcons() {
  $('#brandMark').innerHTML = icon('activity');
  $$('.nav-ic').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  $$('.search-ic').forEach((el) => { el.innerHTML = icon(el.dataset.icon || 'search'); });
  $('#dashCheckAll').innerHTML = icon('refresh') + '<span>检测全部</span>';
  $('#btnAdd').innerHTML = icon('plus') + '<span>新增服务商</span>';
  $('#btnCheckSel').textContent = '检测';
  $('#btnDelSel').innerHTML = icon('trash') + '<span>删除</span>';
  $('#btnGroupView').innerHTML = icon('list') + '<span>分组</span>';
  $$('[data-icon]', $('#view-stats')).forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  $('#hotkeyReset').innerHTML = icon('refresh');
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
  okBtn.textContent = opts.okText || tx('确定');
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
    // Cancel an in-progress channel jump before saving or restoring a page position.
    $('#main').scrollTo({ top: $('#main').scrollTop, behavior: 'instant' });
    const changing = view !== btn.dataset.view;
    if (changing) viewScrollPositions.set(view, $('#main').scrollTop);
    view = btn.dataset.view;
    $$('.nav-item').forEach((b) => {
      b.classList.toggle('active', b === btn);
      if (b === btn) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $$('.view').forEach((v) => { const active = v.id === `view-${view}`; v.classList.toggle('active', active); v.inert = !active; });
    if (view === 'logs') renderLogs();
    if (view === 'notify') renderNotify();
    if (view === 'dashboard') renderDashboard();
    if (view === 'providers') renderProviders();
    if (view === 'settings') renderNotify();
    if (view === 'stats') renderStats();
    applyLang();
    if (changing) $('#main').scrollTop = viewScrollPositions.get(view) || 0;
  });
});

// Category switches only change visibility; values and pending autosaves stay in place.
function selectSettingsCategory(category, focus = false) {
  const tabs = $$('[data-settings-category]');
  const selectedTab = tabs.find((tab) => tab.dataset.settingsCategory === category);
  if (!selectedTab) return;
  settingsCategory = category;
  tabs.forEach((tab) => {
    const active = tab === selectedTab;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
  });
  $$('[data-settings-section]').forEach((section) => {
    section.hidden = category !== 'all' && section.dataset.settingsSection !== category;
    if (category === 'all') {
      section.removeAttribute('role'); section.removeAttribute('aria-labelledby');
    } else {
      section.setAttribute('role', 'tabpanel'); section.setAttribute('aria-labelledby', selectedTab.id);
    }
  });
  if (view === 'settings') { $('#main').scrollTop = 0; viewScrollPositions.set('settings', 0); }
  if (focus) selectedTab.focus({ preventScroll: true });
}
$('.settings-categories').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-settings-category]');
  if (tab) selectSettingsCategory(tab.dataset.settingsCategory);
});
$('.settings-categories').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = $$('[data-settings-category]'), current = tabs.indexOf(event.target);
  if (current < 0) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  selectSettingsCategory(tabs[index].dataset.settingsCategory, true);
});

// ---------- 状态渲染 ----------
function statusInfo(s) {
  if (s === 'up') return { cls: 'up', text: tx('在线') };
  if (s === 'degraded') return { cls: 'degraded', text: tx('异常') };
  if (s === 'down') return { cls: 'down', text: tx('离线') };
  if (s === 'authfail') return { cls: 'authfail', text: tx('鉴权失败') };
  return { cls: 'unknown', text: tx('待检测') };
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
/** 同天只显示时刻，跨天带日期：健康面板/下次检测用，避免「最后成功 10:35」看不出是哪天 */
function fmtWhen(ts) {
  if (!ts) return '—';
  return new Date(ts).toDateString() === new Date().toDateString() ? fmtTime(ts) : fmtDate(ts);
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
  if (view === 'stats') void renderStats(false);
  if ($('#detailModal').classList.contains('show') && detailId != null) refreshOpenDetail();
  // 只刷新健康面板，不整页 renderNotify——后者会清空正在输入的密钥输入框
  if (view === 'notify' || view === 'settings') renderNotifyHealth();
  $('#footRunning').textContent = state.running.length;
  applyLang();
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
  $$('.nav-item').forEach((btn) => {
    if (btn.dataset.view === view) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  });
  $$('.view').forEach((section) => { section.inert = section.id !== `view-${view}`; });
}

// 活动流与服务商列表共用语义状态色。
const actDotColor = (cls) => cls === 'up' ? 'var(--green)'
  : cls === 'degraded' ? 'var(--orange)' : cls === 'down' ? 'var(--red)'
  : cls === 'authfail' ? 'var(--purple)' : 'var(--text-3)';

function renderDashboard() {
  const up = state.providers.filter((p) => p.status === 'up').length;
  const deg = state.providers.filter((p) => p.status === 'degraded').length;
  const down = state.providers.filter((p) => p.status === 'down').length;
  const auth = state.providers.filter((p) => p.status === 'authfail').length;
  const models = state.providers.reduce((a, p) => a + (p.modelsAvailable || []).length, 0);
  $('#statUp').textContent = up;
  $('#statDegraded').textContent = deg;
  $('#statDown').textContent = down;
  $('#statAuthfail').textContent = auth;
  $('#statModels').textContent = models;
  // 全局暂停按钮（暂停只停自动轮循，手动检测仍可用）
  const pb = $('#btnPauseAll');
  if (pb) {
    pb.innerHTML = state.paused ? icon('play') + `<span>${tx('恢复检测')}</span>` : icon('pause') + `<span>${tx('暂停检测')}</span>`;
    pb.classList.toggle('warn-on', Boolean(state.paused));
  }
  // 未读告警徽标（点击打开未读列表，可逐条或全部确认）
  const unreadN = (state.unread && state.unread.count) || 0;
  const chip = $('#unreadChip');
  if (chip) {
    chip.style.display = unreadN > 0 ? '' : 'none';
    chip.textContent = unreadN > 0 ? `${tx('未读')} ${unreadN}` : '';
    chip.title = tx('点击查看未读告警');
  }

  const recent = [...state.providers].filter((p) => p.checkedAt).sort((a, b) => b.checkedAt - a.checkedAt).slice(0, 8);
  const wrap = $('#recentList');
  const guideComplete = state.providers.length > 0 && state.providers.some((p) => p.checkedAt) && Object.keys(state.global || {}).some((k) => /^notify\w+Enabled$/.test(k) && state.global[k]);
  if (!state.global.onboardingDismissed && !guideComplete) {
    wrap.innerHTML = renderEmptyWizard();
  } else if (recent.length === 0) {
    wrap.innerHTML = `<div class="empty">${tx('暂无检测记录，点击右上角"检测全部"开始')}</div>`;
  } else {
    wrap.innerHTML = recent.map((p) => {
      const si = p.enabled === false ? { cls: 'unknown', text: tx('已停用') } : statusInfo(p.status);
      return `<button type="button" class="act-item" data-act="${p.id}" title="${tx('查看详情')}">
        <span class="act-dot" style="background: ${actDotColor(si.cls)};"></span>
        <span class="act-copy">
          <span class="act-name">${escapeHtml(p.name)}</span>
          <span class="act-sub">${(p.modelsAvailable || []).length}/${p.modelsTotal || 0} ${tx('模型可用')}${p.lastError ? ' · ' + escapeHtml(p.lastError) : ''}</span>
        </span>
        <span class="act-right">
          <span class="act-status st-${si.cls}">${si.text}</span>
          <span class="act-time">${fmtDate(p.checkedAt)}</span>
        </span>
      </button>`;
    }).join('');
  }
  const latest = recent[0];
  $('#dashUpdated').textContent = latest ? `${tx('最近活动')} ${fmtTime(latest.checkedAt)}` : '';
}

// 仪表盘侧边导航跳转（程序化触发，与手点同路径）
function navTo(v) {
  const btn = document.querySelector(`.nav-item[data-view="${v}"]`);
  if (btn) btn.click();
}

/** 空状态三步引导：无服务商时替代空文案，压低上手门槛 */
function renderEmptyWizard() {
  const g = state.global || {};
  const anyChannel = Object.keys(g).some((k) => /^notify\w+Enabled$/.test(k) && g[k]);
  const anyCheck = state.providers.some((p) => p.checkedAt);
  const steps = [
    { n: 1, done: state.providers.length > 0, title: tx('新增第一个服务商'), desc: tx('填入 API 根地址与密钥，自动拉取模型清单'), btn: tx('新增服务商'), act: () => openProviderModal() },
    { n: 2, done: anyChannel, title: tx('配置通知渠道'), desc: tx('钉钉 / 飞书 / Telegram 等 8 个渠道，先发一条测试消息'), btn: tx('去配置'), act: () => navTo('notify') },
    { n: 3, done: anyCheck, title: tx('完成首轮检测'), desc: tx('点击「检测全部」，仪表盘开始实时反映各服务商状态'), btn: tx('立即检测'), act: () => { window.aipm.checkAll(); toast(tx('已触发全部检测')); } }
  ];
  return `<div class="wizard">
    <div class="wz-lead">${tx('快速开始')} <button class="btn small ghost" data-wz-dismiss>${tx('关闭引导')}</button></div>
    ${steps.map((s) => `
      <div class="wz-step ${s.done ? 'done' : ''}">
        <span class="wz-num">${s.done ? icon('check') : s.n}</span>
        <div class="wz-main">
          <div class="wz-title">${escapeHtml(s.title)}${s.done ? ` <span class="wz-done">${tx('已完成')}</span>` : ''}</div>
          <div class="wz-desc">${escapeHtml(s.desc)}</div>
        </div>
        ${s.done ? '' : `<button class="btn small ghost" data-wz="${s.n}">${escapeHtml(s.btn)}</button>`}
      </div>`).join('')}
  </div>`;
}

$('#recentList').addEventListener('click', (e) => {
  const activity = e.target.closest('[data-act]');
  if (activity) { openDetail(Number(activity.dataset.act)); return; }
  if (e.target.closest('[data-wz-dismiss]')) {
    window.aipm.setGlobal({ onboardingDismissed: true }).then((r) => { if (r.ok) { state.global.onboardingDismissed = true; renderDashboard(); } else toast(r.error || tx('保存失败'), 'err'); });
    return;
  }
  const btn = e.target.closest('[data-wz]');
  if (!btn) return;
  const steps = { 1: () => openProviderModal(), 2: () => navTo('notify'), 3: () => { window.aipm.checkAll(); toast(tx('已触发全部检测')); } };
  const fn = steps[btn.dataset.wz];
  if (fn) fn();
});

// 全局暂停/恢复自动检测
$('#btnPauseAll').addEventListener('click', async () => {
  const next = !state.paused;
  try { await window.aipm.setPaused(next); } catch (err) { return; }
  state.paused = next;
  renderDashboard();
  toast(next ? tx('已暂停自动检测，手动检测不受影响') : tx('已恢复自动检测'));
});

// 未读徽标：打开未读列表弹窗（逐条确认 / 全部确认）
$('#unreadChip').addEventListener('click', () => openUnreadModal());

function openUnreadModal() {
  renderUnreadList();
  $('#unreadModal').classList.add('show');
}
function renderUnreadList() {
  const items = (state.unread && state.unread.items) || [];
  const wrap = $('#umList');
  if (!items.length) {
    wrap.innerHTML = `<div class="um-empty">${tx('暂无未读告警')}</div>`;
    return;
  }
  wrap.innerHTML = items.map((a) => `
    <div class="um-item">
      <span class="um-dot"></span>
      <div class="um-main">
        <div class="um-name">${escapeHtml(a.name)}</div>
        <div class="um-title">${escapeHtml(a.title)}</div>
      </div>
      <span class="um-time">${fmtDate(a.t)}</span>
      <button class="btn small ghost" data-umack="${a.id}">${tx('确认')}</button>
    </div>`).join('');
}
$('#umList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-umack]');
  if (!btn) return;
  try { await window.aipm.ackUnread(Number(btn.dataset.umack)); } catch (err) { /* 主进程不可用时忽略 */ }
  if (state.unread) {
    state.unread.items = state.unread.items.filter((a) => a.id !== Number(btn.dataset.umack));
    state.unread.count = Math.max(0, (state.unread.count || 1) - 1);
  }
  renderUnreadList();
  renderDashboard();
  toast(tx('告警已确认'));
});
$('#umAckAll').addEventListener('click', async () => {
  try { await window.aipm.clearUnread(); } catch (e) { /* 后端不可用时仅隐藏 */ }
  if (state.unread) state.unread.count = 0;
  $('#unreadModal').classList.remove('show');
  $('#unreadChip').style.display = 'none';
  renderDashboard();
  toast(tx('告警已确认'));
});
$('#umClose').innerHTML = icon('close');
$('#umClose').addEventListener('click', () => $('#unreadModal').classList.remove('show'));
$('#unreadModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });

function filteredProviders() {
  const q = ($('#searchInput').value || '').trim().toLowerCase();
  const g = $('#groupFilter') ? $('#groupFilter').value : '';
  const st = $('#statusFilter') ? $('#statusFilter').value : '';
  return state.providers.filter((p) => {
    if (g && (p.group || '') !== g) return false;
    if (st === 'disabled' ? p.enabled !== false : st && (p.enabled === false || (p.status || 'unknown') !== st)) return false;
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

// ---------- 24h 可用率缓存（列表列内嵌展示） ----------
// 一次 historySummary 拉全量，5 分钟刷新一次；可用率变化缓慢，不值得每轮检测都拉
let uptime24 = { map: new Map(), at: 0 };
async function refreshUptime24(force = false) {
  if (!force && Date.now() - uptime24.at < 5 * 60 * 1000) return;
  try {
    const r = await window.aipm.historySummary({ hours: 24 });
    if (r && r.ok) {
      uptime24 = { map: new Map((r.perProvider || []).map((p) => [p.id, p.timeUptime])), at: Date.now() };
      if (view === 'providers') renderProviders();
    }
  } catch (e) { /* 静默：列表徽标缺失不影响主功能 */ }
}

// ---------- 服务商列表：分组折叠 + 拖拽排序（扁平视图） ----------
let groupViewOn = false;
const collapsedGroups = new Set();
let dragId = null;

function providerRowHtml(p, canDrag) {
  const si = p.enabled === false ? { cls: 'unknown', text: tx('已停用') } : statusInfo(p.status);
  const checking = state.running.includes(p.id);
  const total = p.modelsTotal || 0;
  const avail = (p.modelsAvailable || []).length;
  const pct = total > 0 ? Math.round((avail / total) * 100) : 0;
  const cycleMin = fmtDuration(p.intervalSec);
  const checked = p.checkedAt ? fmtTime(p.checkedAt) : tx('未检测');
  const schedule = (state.schedule || []).find((s) => s.id === p.id);
  const nextSub = schedule && schedule.dueAt
    ? `<div class="cell-sub" title="${tx('下次检测')} ${fmtWhen(schedule.dueAt)}">${tx('下次')} ${fmtWhen(schedule.dueAt)}</div>` : '';
  const up24 = uptime24.map.get(p.id);
  const upSub = up24 != null
    ? `<div class="cell-sub ${up24 >= 99 ? 'u-up' : up24 >= 90 ? 'u-degraded' : 'u-down'}">${tx('24h 时间加权')} ${up24}%</div>` : '';
  return `<div class="row p-row ${selected.has(p.id) ? 'selected' : ''} ${checking ? 'checking' : ''} ${p.enabled === false ? 'disabled' : ''}" data-id="${p.id}"${canDrag ? ' draggable="true"' : ''}>
        <div class="col-sel"><span class="drag-handle${canDrag ? '' : ' spacer'}" title="${canDrag ? tx('拖拽排序') : ''}">${icon('grip')}</span><label class="checkbox"><input type="checkbox" data-sel="${p.id}" aria-label="${escapeHtml(tx('选择 {name}', { name: p.name }))}" ${selected.has(p.id) ? 'checked' : ''}/><span class="box">${icon('check')}</span></label></div>
        <div class="col-name"><div class="provider-cell">
          <div class="provider-name">
            <button type="button" class="name-text" data-detail="${p.id}" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>
            ${p.modelChanged ? `<span class="changed-badge">${tx('变动')}</span>` : ''}
          </div>
          <div class="provider-url" title="${escapeHtml(p.url)}">${escapeHtml(p.url)}</div>
          ${(p.group || (p.tags && p.tags.length)) ? `<div class="provider-meta">${p.group ? `<span class="chip group">${escapeHtml(p.group)}</span>` : ''}${(p.tags || []).slice(0, 3).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        </div></div>
        <div class="col-status"><span class="status-pill st-${si.cls}"><span class="status-dot ${si.cls} ${checking ? 'pulse' : ''}"></span>${checking ? tx('检测中') : si.text}</span></div>
        <div class="col-models"><div class="models-cell"><span class="models-bar"><i style="width:${pct}%;"></i></span><span class="models-text">${avail}/${total}</span></div></div>
        <div class="col-latency">${p.latency != null ? p.latency + ' ms' : '—'}</div>
        <div class="col-cycle cycle-cell">${cycleMin}${nextSub}</div>
        <div class="col-notify">${p.notifyOnModelChange ? `<span class="status-pill st-up">${tx('开启')}</span>` : `<span class="status-pill st-unknown">${tx('关闭')}</span>`}</div>
        <div class="col-checked checked-cell">${checked}${p.lastError ? `<span class="checked-error" title="${escapeHtml(p.lastError)}">${escapeHtml(p.lastError)}</span>` : ''}${upSub}</div>
        <div class="col-ops">
          <button class="op-btn run" data-run="${p.id}" title="${tx('立即检测')}" aria-label="${tx('立即检测')}">${icon('refresh')}</button>
          <button class="op-btn" data-toggle="${p.id}" title="${p.enabled === false ? tx('启用') : tx('停用')}" aria-label="${p.enabled === false ? tx('启用') : tx('停用')}">${icon(p.enabled === false ? 'play' : 'pause')}</button>
          <button class="op-btn" data-clone="${p.id}" title="${tx('克隆')}" aria-label="${tx('克隆')}">${icon('copy')}</button>
          <button class="op-btn edit" data-edit="${p.id}" title="${tx('编辑')}" aria-label="${tx('编辑')}">${icon('pencil')}</button>
          <button class="op-btn del" data-del="${p.id}" title="${tx('删除')}" aria-label="${tx('删除')}">${icon('trash')}</button>
        </div>
      </div>`;
}

function renderProviders() {
  const list = filteredProviders();
  const wrap = $('#providerList');
  const focusOrigin = document.activeElement;
  const focusedAttribute = focusOrigin?.closest('#providerList')
    ? ['data-sel', 'data-detail', 'data-run', 'data-toggle', 'data-clone', 'data-edit', 'data-del'].find((attr) => focusOrigin.hasAttribute(attr)) : null;
  const focusId = focusedAttribute ? focusOrigin.getAttribute(focusedAttribute) : null;

  // 拖拽排序只在「扁平视图 + 无筛选」下启用：筛选结果的局部顺序无法代表全量顺序
  const noFilter = !($('#searchInput').value || '').trim()
    && !($('#groupFilter') ? $('#groupFilter').value : '')
    && !($('#statusFilter') ? $('#statusFilter').value : '');
  const canDrag = !groupViewOn && noFilter && list.length > 1 && list.length === state.providers.length;

  if (list.length === 0) {
    wrap.innerHTML = `<div class="empty provider-empty">${icon(state.providers.length ? 'search' : 'server')}<span>${state.providers.length === 0 ? tx('暂无服务商，点击"新增服务商"开始添加') : tx('没有匹配的结果')}</span><button class="btn small ${state.providers.length ? 'ghost' : 'primary'}" data-provider-empty="${state.providers.length ? 'clear' : 'add'}">${state.providers.length ? tx('清空筛选') : tx('新增服务商')}</button></div>`;
  } else if (groupViewOn) {
    // 分组视图：按 group 分节（未分组垫底），节内保持现有顺序；节头可折叠
    const sections = new Map();
    for (const p of list) {
      const key = (p.group || '').trim() || tx('未分组');
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key).push(p);
    }
    let html = '';
    for (const [g, rows] of sections) {
      const collapsed = collapsedGroups.has(g);
      const online = rows.filter((p) => p.status === 'up').length;
      html += `<div class="group-head ${collapsed ? 'collapsed' : ''}" data-group="${escapeHtml(g)}">
        <span class="group-chev">${icon(collapsed ? 'chevronRight' : 'chevronDown')}</span>
        <span class="group-name">${escapeHtml(g)}</span>
        <span class="group-meta">${online}/${rows.length} ${tx('在线')}</span>
      </div>`;
      if (!collapsed) html += rows.map((p) => providerRowHtml(p, false)).join('');
    }
    wrap.innerHTML = html;
  } else {
    wrap.innerHTML = list.map((p) => providerRowHtml(p, canDrag)).join('');
  }

  // 工具栏状态
  const allChecked = list.length > 0 && list.every((p) => selected.has(p.id));
  const selCount = list.filter((p) => selected.has(p.id)).length;
  const selBox = $('#selAll');
  selBox.checked = allChecked;
  // 部分选中：显示半选态，点击后补齐为全选
  selBox.indeterminate = selCount > 0 && !allChecked;
  $('#selAllText').textContent = allChecked && list.length ? tx('取消全选') : tx('全选');
  $('#btnCheckSel').disabled = selected.size === 0;
  $('#btnEditSel').disabled = selected.size === 0;
  $('#btnDelSel').disabled = selected.size === 0;
  $('#btnDelSel').textContent = selected.size > 0 ? `${tx('删除')} (${selected.size})` : tx('删除');
  $('#providerResultCount').textContent = noFilter ? tx('共 {n} 个服务商', { n: state.providers.length }) : tx('显示 {shown} / {total} 个服务商', { shown: list.length, total: state.providers.length });
  $('#providerSelectionCount').textContent = selected.size ? tx('已选 {n} 项', { n: selected.size }) : '';
  $('#providerClearFilters').hidden = noFilter;
  $('#btnGroupView').setAttribute('aria-pressed', String(groupViewOn));
  if (focusedAttribute) wrap.querySelector(`[${focusedAttribute}="${focusId}"]`)?.focus({ preventScroll: true });
}

function clearProviderFilters() {
  $('#searchInput').value = ''; $('#groupFilter').value = ''; $('#statusFilter').value = '';
  renderProviders(); $('#searchInput').focus();
}
$('#providerClearFilters').addEventListener('click', clearProviderFilters);

// 列表事件委托
$('#providerList').addEventListener('click', async (e) => {
  const emptyAction = e.target.closest('[data-provider-empty]');
  if (emptyAction) { if (emptyAction.dataset.providerEmpty === 'add') openProviderModal(); else clearProviderFilters(); return; }
  const gh = e.target.closest('.group-head');
  if (gh) {
    const g = gh.dataset.group;
    if (collapsedGroups.has(g)) collapsedGroups.delete(g); else collapsedGroups.add(g);
    renderProviders();
    return;
  }
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
  if (run) { window.aipm.checkNow([Number(run.dataset.run)]); toast(tx('已触发检测')); return; }
  const edit = e.target.closest('[data-edit]');
  if (edit) { openProviderModal(Number(edit.dataset.edit)); return; }
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const id = Number(toggle.dataset.toggle), p = state.providers.find((x) => x.id === id);
    const r = await window.aipm.toggleEnabled(id, p?.enabled === false);
    if (!r?.ok) toast(r?.error || tx('保存失败'), 'err');
    return;
  }
  const clone = e.target.closest('[data-clone]');
  if (clone) {
    const r = await window.aipm.cloneProvider(Number(clone.dataset.clone));
    if (!r?.ok) { toast(r?.error || tx('保存失败'), 'err'); return; }
    state = await window.aipm.getState(); renderProviders(); openProviderModal(r.id);
    toast(tx('已克隆为停用副本，请补充凭据后启用'));
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    const id = Number(del.dataset.del);
    const p = state.providers.find((x) => x.id === id);
    confirmDialog(tx('删除服务商'), tx('确定删除「{name}」吗？该操作不可撤销。', { name: p ? p.name : id }), async () => {
      const r = await window.aipm.deleteProvider(id);
      if (!r?.ok) { toast(r?.error || tx('删除失败'), 'err'); return; }
      selected.delete(id);
      toast(tx('已删除'));
    });
  }
});

$('#searchInput').addEventListener('input', renderProviders);
if ($('#groupFilter')) $('#groupFilter').addEventListener('change', renderProviders);
if ($('#statusFilter')) $('#statusFilter').addEventListener('change', renderProviders);

// 分组视图开关
$('#btnGroupView').addEventListener('click', () => {
  groupViewOn = !groupViewOn;
  $('#btnGroupView').classList.toggle('on', groupViewOn);
  renderProviders();
});

// 拖拽排序（扁平视图）：拖到目标行上方松手，整体重排后乐观更新 + 落库
$('#providerList').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.p-row[draggable="true"]');
  if (!row) { e.preventDefault(); return; }
  dragId = Number(row.dataset.id);
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(dragId)); } catch (err) { /* IE 兼容占位 */ }
});
$('#providerList').addEventListener('dragover', (e) => {
  if (dragId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const row = e.target.closest('.p-row[data-id]');
  $$('#providerList .p-row').forEach((r) => r.classList.toggle('drag-over', Boolean(row) && r === row && Number(r.dataset.id) !== dragId));
});
$('#providerList').addEventListener('drop', async (e) => {
  if (dragId == null) return;
  e.preventDefault();
  const row = e.target.closest('.p-row[data-id]');
  const targetId = row ? Number(row.dataset.id) : null;
  $$('#providerList .p-row').forEach((r) => r.classList.remove('drag-over', 'dragging'));
  const moved = dragId;
  dragId = null;
  if (!targetId || targetId === moved) return;
  const ids = state.providers.map((p) => p.id);
  const from = ids.indexOf(moved);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  const byId = new Map(state.providers.map((p) => [p.id, p]));
  state.providers = ids.map((id) => byId.get(id));   // 乐观更新，落库失败由状态快照纠正
  renderProviders();
  const r = await window.aipm.reorderProviders(ids);
  if (!r || !r.ok) {
    toast((r && r.error) || tx('排序失败'), 'err');
    window.aipm.getState().then((s) => { state = s; renderProviders(); });
  }
});
$('#providerList').addEventListener('dragend', () => {
  dragId = null;
  $$('#providerList .p-row').forEach((r) => r.classList.remove('drag-over', 'dragging'));
});

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
$('#btnCheckSel').addEventListener('click', () => { window.aipm.checkNow([...selected]); toast(tx('已对 {n} 个服务商触发检测', { n: selected.size })); });

// ---------- 批量编辑 ----------
$('#bmClose').innerHTML = icon('close');
$('#btnEditSel').addEventListener('click', () => {
  if (!selected.size) return;
  $('#bError').textContent = '';
  $('#bmCount').textContent = tx('{n} 个服务商', { n: selected.size });
  $('#bInterval').value = '';
  $('#bNotify').value = '';
  $('#bGroup').value = '';
  $('#bProxy').value = '';
  $('#bulkModal').classList.add('show');
});
$('#bmClose').addEventListener('click', () => $('#bulkModal').classList.remove('show'));
$('#bmCancel').addEventListener('click', () => $('#bulkModal').classList.remove('show'));
$('#bulkModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
$('#bmSave').addEventListener('click', async () => {
  const patch = {};
  const interval = Number($('#bInterval').value);
  if ($('#bInterval').value !== '' && Number.isFinite(interval) && interval > 0) {
    // 与主进程 validateProviderConfig 的 1 年上限一致，超限整批回滚不如入口就钳住
    patch.intervalSec = Math.min(31536000, toSecondsUI(interval, $('#bIntervalUnit').value));
  } else if ($('#bInterval').value !== '') {
    $('#bError').textContent = tx('轮循周期无效'); return;
  }
  if ($('#bNotify').value === 'on') patch.notifyOnModelChange = true;
  if ($('#bNotify').value === 'off') patch.notifyOnModelChange = false;
  if ($('#bGroup').value.trim() !== '') patch.group = $('#bGroup').value.trim();
  if ($('#bProxy').value === 'on') patch.useProxy = true;
  if ($('#bProxy').value === 'off') patch.useProxy = false;
  if (!Object.keys(patch).length) { $('#bError').textContent = tx('请至少填写一项要修改的内容'); return; }
  const r = await window.aipm.bulkUpdateProviders([...selected], patch);
  if (!r || !r.ok) { $('#bError').textContent = (r && r.error) || tx('保存失败'); return; }
  $('#bulkModal').classList.remove('show');
  toast(tx('批量更新完成：{n} 个服务商', { n: r.updated }));
});
$('#btnDelSel').addEventListener('click', () => {
  const n = selected.size;
  confirmDialog(tx('批量删除'), tx('确定删除选中的 {n} 个服务商吗？该操作不可撤销。', { n }), async () => {
    const r = await window.aipm.deleteMany([...selected]);
    if (!r?.ok) { toast(r?.error || tx('删除失败'), 'err'); return; }
    selected.clear();
    toast(tx('批量删除完成'));
  });
});
$('#dashCheckAll').addEventListener('click', () => { window.aipm.checkAll(); toast(tx('已触发全部检测')); });

// ---------- 新增/编辑弹窗 ----------
// 周期单位与换算同样取自 window.durfmt，避免与主进程口径漂移。
const INTERVAL_UNITS = window.durfmt.EDITABLE_UNITS;
const toSecondsUI = (value, unitKey) => window.durfmt.toSeconds(value, unitKey);
const fromSecondsUI = (sec) => window.durfmt.fromSeconds(sec);
// 填充单位下拉
(function initIntervalUnitSelect() {
  const sel = $('#fIntervalUnit');
  sel.innerHTML = INTERVAL_UNITS.map((u) => `<option value="${u.key}">${u.label}</option>`).join('');
  const bsel = $('#bIntervalUnit');
  if (bsel) bsel.innerHTML = INTERVAL_UNITS.map((u) => `<option value="${u.key}">${u.label}</option>`).join('');
})();

// ----- API Key 眼睛/复制/清除，及自定义请求头、专用代理的「清除已保存」 -----
const pmClearState = { apiKey: false, customHeaders: false, proxyUrl: false };

function armClear(btn, armed, armedText) {
  btn.classList.toggle('armed', armed);
  if (btn.classList.contains('suffix-btn')) btn.classList.toggle('clear', true);
  if (btn.tagName === 'BUTTON' && !btn.classList.contains('suffix-btn')) {
    btn.textContent = armed ? (armedText || tx('将清除')) : tx('清除已保存');
  }
}

$('#fKeyEye').innerHTML = icon('eye');
$('#fKeyCopy').innerHTML = icon('copy');
$('#fKeyClear').innerHTML = icon('trash');
// 眼睛：明文显示时若输入框为空（编辑已有 Key），按需向主进程取回真实 Key 回填；
// 收起时清掉「由回显填入」的内容，恢复「留空则不修改」语义；用户手输的内容不受影响。
$('#fKeyEye').addEventListener('click', async () => {
  const inp = $('#fKey');
  if (inp.type === 'password') {
    if (!inp.value && editingId) {
      try {
        const r = await window.aipm.revealKey(editingId);
        if (r && r.ok && r.apiKey) { inp.value = r.apiKey; inp.dataset.revealed = '1'; }
      } catch (e) { /* 取回失败则仅切换显隐 */ }
    }
    inp.type = 'text';
    $('#fKeyEye').innerHTML = icon('eyeOff');
  } else {
    inp.type = 'password';
    if (inp.dataset.revealed === '1') { inp.value = ''; delete inp.dataset.revealed; }
    $('#fKeyEye').innerHTML = icon('eye');
  }
});
// 用户一旦手动编辑，回显内容视为已作主，收起时不再清空
$('#fKey').addEventListener('input', () => { delete $('#fKey').dataset.revealed; });
$('#fKeyCopy').addEventListener('click', async () => {
  const v = $('#fKey').value;
  if (v) { await navigator.clipboard.writeText(v); toast(tx('已复制')); return; }
  // 输入框为空但服务商已存 Key（未回显）：直接在主进程复制，明文不进渲染层
  if (editingId) {
    try {
      const r = await window.aipm.copyKey(editingId);
      if (r && r.ok) { toast(tx('已复制')); return; }
      toast((r && r.error) || tx('复制失败'), 'err');
    } catch (e) { toast(tx('复制失败'), 'err'); }
    return;
  }
  toast(tx('请先输入内容再复制'), 'err');
});
$('#fKeyClear').addEventListener('click', () => {
  pmClearState.apiKey = !pmClearState.apiKey;
  if (pmClearState.apiKey) $('#fKey').value = '';
  armClear($('#fKeyClear'), pmClearState.apiKey);
  $('#fKey').placeholder = pmClearState.apiKey ? tx('保存时将清除已保存的密钥') : ($('#fKey').dataset.keepPh || 'sk-...');
});
$('#fHeadersClear').addEventListener('click', () => {
  pmClearState.customHeaders = !pmClearState.customHeaders;
  if (pmClearState.customHeaders) $('#fCustomHeaders').value = '';
  armClear($('#fHeadersClear'), pmClearState.customHeaders);
});
$('#fProxyClear').addEventListener('click', () => {
  pmClearState.proxyUrl = !pmClearState.proxyUrl;
  if (pmClearState.proxyUrl) $('#fProxyUrl').value = '';
  armClear($('#fProxyClear'), pmClearState.proxyUrl);
});

function openProviderModal(id = null) {
  editingId = id;
  $('#pmTitle').textContent = id ? tx('编辑服务商') : tx('新增服务商');
  $('#fError').textContent = '';
  $('#fTestHint').textContent = '';
  $('#fTestHint').title = '';
  const p = id ? state.providers.find((x) => x.id === id) : null;
  pmClearState.apiKey = false;
  pmClearState.customHeaders = false;
  pmClearState.proxyUrl = false;
  armClear($('#fKeyClear'), false);
  armClear($('#fHeadersClear'), false);
  armClear($('#fProxyClear'), false);
  $('#fKeyClear').style.display = p && p.hasApiKey ? '' : 'none';
  $('#fHeadersClear').style.display = p && p.hasCustomHeaders ? '' : 'none';
  $('#fProxyClear').style.display = p && p.hasProxyUrl ? '' : 'none';
  $('#fName').value = p ? p.name : '';
  $('#fUrl').value = p ? p.url : '';
  $('#fKey').value = '';
  $('#fKey').type = 'password';
  delete $('#fKey').dataset.revealed;
  $('#fKeyEye').innerHTML = icon('eye');
  $('#fKey').dataset.keepPh = p && p.hasApiKey ? tx('已保存（{mask}），留空则不修改', { mask: p.apiKeyMasked }) : 'sk-...';
  $('#fKey').placeholder = $('#fKey').dataset.keepPh;
  const iv = fromSecondsUI(p ? p.intervalSec : 300);
  $('#fInterval').value = iv.value;
  $('#fIntervalUnit').value = iv.unit;
  $('#fNotify').checked = p ? Boolean(p.notifyOnModelChange) : false;
  $('#fNote').value = p ? (p.note || '') : '';
  $('#fGroup').value = p ? (p.group || '') : '';
  $('#fTags').value = p && Array.isArray(p.tags) ? p.tags.join(', ') : '';
  $('#fProbeMode').value = (p && p.probeMode) || 'chat';
  $('#fProbePolicy').value = p?.probePolicy || 'strict';
  $('#fSloTarget').value = p?.sloTarget ?? '';
  $('#fAdvanced').open = false;
  $('#fAdvancedHint').textContent = p ? tx('已保留当前高级配置') : '';
  $('#fTemplate').value = p ? '' : 'compatible';
  $('#fTemplateHint').textContent = p ? tx('选择模板可替换端点与探测设置') : tx(window.providerTemplates.templates[0].hint);
  $('#fProbeLimit').value = p && p.probeLimit ? p.probeLimit : '';
  $('#fProbePath').value = p ? (p.probePath || '') : '';
  $('#fProbeBody').value = p ? (p.probeBody || '') : '';
  $('#fModelsPath').value = p ? (p.modelsPath || '/v1/models') : '/v1/models';
  $('#fAuthType').value = (p && p.authType) || 'bearer';
  $('#fAuthHeader').value = p ? (p.authHeader || 'X-API-Key') : 'X-API-Key';
  $('#fAuthPrefix').value = p ? (p.authPrefix || '') : '';
  $('#fCustomHeaders').value = '';
  $('#fCustomHeaders').placeholder = p && p.hasCustomHeaders ? tx('已配置，留空保持不变') : '{"X-Tenant":"demo"}';
  const caps = new Set((p && p.capabilityModes) || []);
  $('#fCapChat').checked = caps.has('chat');
  $('#fCapEmbeddings').checked = caps.has('embeddings');
  $('#fCapCompletions').checked = caps.has('completions');
  $('#fAssertType').value = (p && p.assertType) || 'none';
  $('#fAssertValue').value = p ? (p.assertValue || '') : '';
  $('#fModelIgnorePattern').value = p ? (p.modelIgnorePattern || '') : '';
  $('#fQuotaPath').value = p ? (p.quotaPath || '') : '';
  $('#fQuotaValuePath').value = p ? (p.quotaValuePath || 'remaining') : 'remaining';
  $('#fQuotaWarnBelow').value = p && p.quotaWarnBelow != null ? p.quotaWarnBelow : '';
  $('#fMeasureStreaming').checked = p ? Boolean(p.measureStreaming) : false;
  // 通知通道路由：复选框组（空 = 广播全部已启用通道）
  const routes = new Set((p && p.notifyChannels) || []);
  $$('#fNotifyChannelsBox input[data-nch]').forEach((c) => { c.checked = routes.has(c.dataset.nch); });
  $('#fMaintWeekdays').value = p && Array.isArray(p.maintWeekdays) ? p.maintWeekdays.join(',') : '';
  $('#fMaintDates').value = p ? (p.maintDates || '') : '';
  $('#fProxyUrl').value = '';
  $('#fProxyUrl').placeholder = p && p.hasProxyUrl ? tx('已保存（{mask}），留空则不修改', { mask: p.proxyUrlMasked }) : tx('留空则使用全局代理设置');
  $('#fUseProxy').checked = p ? p.useProxy !== false : true;
  $('#fMaintEnabled').checked = p ? Boolean(p.maintEnabled) : false;
  $('#fMaintStart').value = (p && p.maintStart) || '02:00';
  $('#fMaintEnd').value = (p && p.maintEnd) || '04:00';
  $('#fTlsVerify').value = !p || p.insecureSkipVerify == null ? 'follow' : p.insecureSkipVerify === true ? 'skip' : 'verify';
  syncProbeCustomVisibility(); updateRequestPreview();
  $('#providerModal').classList.add('show');
  setTimeout(() => $('#fName').focus(), 120);
}
function syncProbeCustomVisibility() {
  const wrap = $('#fProbeCustomWrap');
  if (wrap) wrap.style.display = $('#fProbeMode').value === 'custom' ? '' : 'none';
}
const presetFields = { probeMode: '#fProbeMode', modelsPath: '#fModelsPath', authType: '#fAuthType', probePath: '#fProbePath', probeBody: '#fProbeBody', assertType: '#fAssertType', assertValue: '#fAssertValue', probePolicy: '#fProbePolicy' };
$('#fTemplate').innerHTML = '<option value="">' + tx('当前配置') + '</option>' + window.providerTemplates.templates.map((t) => `<option value="${t.id}">${tx(t.name)}</option>`).join('');
$('#fTemplate').addEventListener('change', () => {
  const template = window.providerTemplates.templates.find((t) => t.id === $('#fTemplate').value);
  if (!template) return;
  for (const [key, selector] of Object.entries(presetFields)) $(selector).value = template.config[key];
  if (!editingId && !$('#fName').value.trim()) $('#fName').value = template.name;
  if (template.url) $('#fUrl').value = template.url;
  $('#fCapChat').checked = $('#fCapEmbeddings').checked = $('#fCapCompletions').checked = false;
  $('#fMeasureStreaming').checked = false;
  $('#fTemplateHint').textContent = tx(template.hint);
  $('#fAdvanced').open = template.id === 'custom';
  $('#fAdvancedHint').textContent = tx('模板已应用');
  syncProbeCustomVisibility(); updateRequestPreview();
});
function updateRequestPreview() {
  try {
    const base = window.providerTemplates.normalizeBase($('#fUrl').value);
    const mode = $('#fProbeMode').value;
    const path = mode === 'custom' ? $('#fProbePath').value || '/v1/chat/completions' : '/v1/' + ({ chat: 'chat/completions', embeddings: 'embeddings', completions: 'completions' }[mode] || 'models');
    $('#fRequestPreview').textContent = 'GET ' + window.providerTemplates.endpoint(base, $('#fModelsPath').value || '/v1/models') + (mode === 'none' ? '' : '\nPOST ' + window.providerTemplates.endpoint(base, path));
  } catch (e) { $('#fRequestPreview').textContent = tx('填写 URL 后显示实际请求端点'); }
}
$('#providerModal').addEventListener('input', updateRequestPreview);
$('#providerModal').addEventListener('change', updateRequestPreview);
$('#fProbeMode').addEventListener('change', syncProbeCustomVisibility);
$('#btnAdd').addEventListener('click', () => openProviderModal());
$('#pmClose').addEventListener('click', () => $('#providerModal').classList.remove('show'));
$('#pmCancel').addEventListener('click', () => $('#providerModal').classList.remove('show'));

/** 表单 → 主进程 payload（保存与测试连接共用） */
function collectProviderForm() {
  const data = {
    name: $('#fName').value.trim(),
    url: window.providerTemplates.normalizeBase($('#fUrl').value),
    apiKey: $('#fKey').value.trim() || undefined,
    intervalSec: toSecondsUI($('#fInterval').value, $('#fIntervalUnit').value),
    notifyOnModelChange: $('#fNotify').checked,
    note: $('#fNote').value.trim(),
    group: $('#fGroup').value.trim(),
    tags: $('#fTags').value.split(',').map((t) => t.trim()).filter(Boolean),
    probeMode: $('#fProbeMode').value,
    probePolicy: $('#fProbePolicy').value,
    sloTarget: $('#fSloTarget').value === '' ? null : Number($('#fSloTarget').value),
    probePath: $('#fProbePath').value.trim(),
    probeBody: $('#fProbeBody').value.trim(),
    modelsPath: $('#fModelsPath').value.trim() || '/v1/models',
    authType: $('#fAuthType').value,
    authHeader: $('#fAuthHeader').value.trim() || 'X-API-Key',
    authPrefix: $('#fAuthPrefix').value,
    customHeaders: $('#fCustomHeaders').value.trim(),
    capabilityModes: [['chat', '#fCapChat'], ['embeddings', '#fCapEmbeddings'], ['completions', '#fCapCompletions']].filter(([, sel]) => $(sel).checked).map(([mode]) => mode),
    assertType: $('#fAssertType').value,
    assertValue: $('#fAssertValue').value.trim(),
    modelIgnorePattern: $('#fModelIgnorePattern').value.trim(),
    quotaPath: $('#fQuotaPath').value.trim(),
    quotaValuePath: $('#fQuotaValuePath').value.trim() || 'remaining',
    quotaWarnBelow: $('#fQuotaWarnBelow').value === '' ? null : Number($('#fQuotaWarnBelow').value),
    measureStreaming: $('#fMeasureStreaming').checked,
    notifyChannels: $$('#fNotifyChannelsBox input[data-nch]').filter((c) => c.checked).map((c) => c.dataset.nch),
    maintWeekdays: $('#fMaintWeekdays').value.split(',').map((v) => v.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    maintDates: $('#fMaintDates').value.trim(),
    probeLimit: Number($('#fProbeLimit').value) > 0 ? Number($('#fProbeLimit').value) : null,
    proxyUrl: $('#fProxyUrl').value.trim(),
    useProxy: $('#fUseProxy').checked,
    maintEnabled: $('#fMaintEnabled').checked,
    maintStart: $('#fMaintStart').value || '02:00',
    maintEnd: $('#fMaintEnd').value || '04:00',
    insecureSkipVerify: $('#fTlsVerify').value === 'follow' ? null : $('#fTlsVerify').value === 'skip'
  };
  for (const key of ['apiKey', 'customHeaders', 'proxyUrl']) {
    if (pmClearState[key]) data[key] = '';
    else if (editingId && !data[key]) delete data[key];
  }
  return data;
}

// 测试连接：不保存直接跑一轮检测，避免「保存 → 等轮循 → 失败 → 再编辑」的循环
$('#fTestConn').addEventListener('click', async () => {
  if (!$('#fName').value.trim()) { $('#fError').textContent = tx('请输入供应商名称'); return; }
  if (!$('#fUrl').value.trim()) { $('#fError').textContent = tx('请输入 URL'); return; }
  $('#fError').textContent = '';
  const hint = $('#fTestHint');
  const btn = $('#fTestConn');
  btn.disabled = true;
  hint.textContent = tx('测试中…'); hint.className = 'hint';
  try {
    const r = await window.aipm.testConnection({ id: editingId, data: collectProviderForm() });
    if (!r || !r.ok) { hint.textContent = tx('失败: ') + ((r && r.error) || ''); hint.className = 'hint bad'; return; }
    const s = r.result;
    const parts = [statusInfo(s.status).text];
    if (s.latency != null) parts.push(s.latency + ' ms');
    parts.push(`${s.available}/${s.modelsTotal} ${tx('模型可用')}`);
    if (s.unprobed > 0) parts.push(`${s.unprobed} ${tx('未探测')}`);
    if (s.error) parts.push(s.error);
    hint.textContent = parts.filter(Boolean).join(' · ');
    hint.className = 'hint ' + (s.status === 'up' ? 'ok' : 'bad');
    hint.title = (s.sampleFailures || []).join('\n');
  } catch (e) {
    hint.textContent = tx('失败: ') + (e.message || e);
    hint.className = 'hint bad';
  } finally {
    btn.disabled = false;
  }
});

$('#pmSave').addEventListener('click', async () => {
  const name = $('#fName').value.trim();
  let url = $('#fUrl').value.trim();
  const interval = toSecondsUI($('#fInterval').value, $('#fIntervalUnit').value);
  if (!name) { $('#fError').textContent = tx('请输入供应商名称'); return; }
  if (!url) { $('#fError').textContent = tx('请输入 URL'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (interval < 5) { $('#fError').textContent = tx('轮循周期不能小于 5 秒'); return; }
  if (interval > 31536000) { $('#fError').textContent = tx('轮循周期不能超过 1 年'); return; }

  const data = collectProviderForm();
  data.name = name;
  data.url = url;
  if (editingId) {
    const r = await window.aipm.updateProvider(editingId, data);
    if (!r || !r.ok) { $('#fError').textContent = (r && r.error) || tx('保存失败'); return; }
    toast(tx('已保存'));
  } else {
    if (!data.apiKey) data.apiKey = '';
    const r = await window.aipm.addProvider(data);
    if (!r || !r.ok) { $('#fError').textContent = (r && r.error) || tx('保存失败'); return; }
    toast(tx('已添加'));
  }
  $('#providerModal').classList.remove('show');
});
$('#providerModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });
$('#detailModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('show'); });

// ---------- 详情弹窗 ----------
let detailId = null, detailFingerprint = '';
let detailSeq = 0;   // 请求序号：快速重开详情时旧响应不得写入新弹窗

function refreshOpenDetail() {
  const p = state.providers.find((x) => x.id === detailId);
  if (!p || JSON.stringify(p) !== detailFingerprint) openDetail(detailId);
}
function openDetail(id) {
  const seq = ++detailSeq;
  const p = state.providers.find((x) => x.id === id);
  if (!p) { $('#detailModal').classList.remove('show'); detailId = null; return; }
  detailId = id; detailFingerprint = JSON.stringify(p);
  for (const selector of ['#dmChartWrap', '#dmUptimeBarsWrap']) $(selector).style.display = 'none';
  $('#dmChart').innerHTML = ''; $('#dmUptimeBars').innerHTML = '';
  const si = p.enabled === false ? { cls: 'unknown', text: tx('已停用') } : statusInfo(p.status);
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
      <div class="dm-banner-sub">${avail.length}/${total} ${tx('模型可用')} · ${tx('可用率')} ${pct}%</div>
    </div>
    <div class="dm-banner-lat">${p.latency != null ? p.latency + ' ms' : '—'}</div>`;
  $('#dmMeta').innerHTML = `
    <div class="dm-item"><span>URL</span><b>${escapeHtml(p.url)}</b></div>
    <div class="dm-item"><span>API Key</span><b>${p.apiKeyMasked || tx('未配置')}</b></div>
    <div class="dm-item"><span>${tx('轮循周期')}</span><b>${fmtDuration(p.intervalSec)}</b></div>
    <div class="dm-item"><span>${tx('最近检测')}</span><b>${p.checkedAt ? new Date(p.checkedAt).toLocaleString(lang() === 'en' ? 'en-US' : 'zh-CN') : '—'}</b></div>
    ${p.quotaRemaining != null ? `<div class="dm-item"><span>剩余配额</span><b class="${p.quotaWarning ? 'st-down' : ''}">${p.quotaRemaining}</b></div>` : ''}
    ${p.firstTokenMs != null ? `<div class="dm-item"><span>首 Token</span><b>${p.firstTokenMs} ms</b></div>` : ''}
    ${p.throughputTokensPerSec != null ? `<div class="dm-item"><span>流式吞吐</span><b>${p.throughputTokensPerSec} token/s</b></div>` : ''}
    ${p.note ? `<div class="dm-item wide"><span>${tx('备注')}</span><b>${escapeHtml(p.note)}</b></div>` : ''}
    ${p.lastError ? `<div class="dm-item wide"><span>${tx('连接信息')}</span><b class="st-down">${escapeHtml(p.lastError)}</b></div>` : ''}`;
  $('#dmAvailCount').textContent = avail.length;
  $('#dmUnavailCount').textContent = unavail.length;
  $('#dmAvail').innerHTML = avail.length
    ? avail.map((m) => `<span class="model-tag" data-copy="${escapeHtml(m)}">${escapeHtml(m)}</span>`).join('')
    : `<span class="empty" style="padding:8px 0;">${tx('无')}</span>`;
  $('#dmUnavail').innerHTML = unavail.length
    ? unavail.map((m) => {
        const d = detailMap.get(m);
        const reason = d && d.note ? d.note : tx('未探测');
        return `<div class="model-fail" data-copy="${escapeHtml(m)}">
          <span class="model-fail-name">${escapeHtml(m)}</span>
          <span class="model-fail-reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>
        </div>`;
      }).join('')
    : `<span class="empty" style="padding:8px 0;">${tx('无')}</span>`;
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
  (async () => {
    try {
      const r = await window.aipm.historySLO({ providerId: id });
      if (!r.ok || seq !== detailSeq) return;
      const slo = r.perProvider[0]; if (!slo) return;
      $('#dmMeta').insertAdjacentHTML('beforeend', `<div class="dm-item wide"><span>SLO · ${r.windowDays}d</span><b>${slo.timeUptime == null ? '—' : slo.timeUptime + '%'} · ${tx('覆盖率')} ${coverageText(slo)} · ${tx('剩余错误预算')} ${signedDuration(slo.budgetRemainingMs)} · ${sloStatus(slo.sloMet)}</b></div>`);
    } catch (e) { /* historical metrics are optional in the live detail */ }
  })();
  // v1.2.0：单模型 24h 可用率徽标（异步追加，失败静默；序号防串弹窗）
  (async () => {
    try {
      const r = await window.aipm.historyModelRates({ providerId: id, hours: 24 });
      if (!r || !r.ok || !Array.isArray(r.models)) return;
      if (seq !== detailSeq) return;
      const rateByMid = new Map(r.models.map((m) => [String(m.mid), m.rate]));
      $$('#dmAvail .model-tag').forEach((el) => {
        const rate = rateByMid.get(el.dataset.copy);
        if (rate == null) return;
        const s = document.createElement('span');
        s.className = 'rate-pill' + (rate >= 99 ? '' : rate >= 90 ? ' mid' : ' low');
        s.textContent = `${rate}%`;
        el.appendChild(s);
      });
    } catch (e) { /* 徽标失败不打扰 */ }
  })();
  // 90 天可用率色条（status-page 风格）：每天一格，无数据补灰格
  (async () => {
    try {
      const retainedDays = Math.min(90, state.global.historyKeepDays || 90);
      $('#dmBarsTitle').textContent = tx('最近 {n} 天', { n: retainedDays });
      const r = await window.aipm.historyPerDay({ providerId: id, days: retainedDays });
      const wrap = $('#dmUptimeBarsWrap');
      if (!wrap || !r || !r.ok || seq !== detailSeq) return;
      const byTs = new Map((r.days || []).map((d) => [d.t, (d.providers || []).find((x) => x.id === id)]));
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let cells = '';
      let hit = 0;
      for (let i = retainedDays - 1; i >= 0; i--) {
        const ts = today.getTime() - i * 86400000;
        const e = byTs.get(ts);
        let cls = 'l-none';
        let tip = `${fmtDate(ts)} · ${tx('无数据')}`;
        if (e) {
          hit++;
          cls = e.uptime >= 99 ? 'l-ok' : e.uptime >= 90 ? 'l-mid' : 'l-bad';
          tip = `${fmtDate(ts)} · ${tx('样本可用率')} ${e.uptime}%（${e.samples} ${tx('个样本')}）`;
        }
        cells += `<i class="up-bar ${cls}" title="${escapeHtml(tip)}"></i>`;
      }
      if (!hit) { wrap.style.display = 'none'; return; }
      $('#dmUptimeBars').innerHTML = cells;
      $('#dmBarsHint').textContent = ` · ${hit}/${retainedDays} ${tx('天有数据')}`;
      wrap.style.display = '';
    } catch (err) { /* 色条失败不打扰 */ }
  })();
  // 24h 可用率/延迟迷你走势：区分「刚好这轮慢」和「一直慢」；数据缺失时整块隐藏
  (async () => {
    try {
      const r = await window.aipm.historySeries({ providerId: id, hours: 24, buckets: 48 });
      const wrap = $('#dmChartWrap');
      if (!wrap || !r || !r.ok || seq !== detailSeq) return;
      const has = (r.buckets || []).some((b) => b.samples > 0);
      if (!has) { wrap.style.display = 'none'; return; }
      drawChart(r, 'dmChart', 640, 140);
      wrap.style.display = '';
    } catch (e) { /* 走势图失败不打扰 */ }
  })();
  $('#detailModal').classList.add('show');
}
$('#dmClose').addEventListener('click', () => $('#detailModal').classList.remove('show'));
$('#detailModal').addEventListener('click', async (e) => {
  const tag = e.target.closest('[data-copy]');
  if (tag) {
    await navigator.clipboard.writeText(tag.dataset.copy);
    toast(tx('已复制模型名'));
  }
});

// ---------- 通知设置 ----------
/** 设置页敏感字段：注入「清除已保存」小按钮（一次注入，renderNotify 按 Configured 标志显隐） */
const SECRET_CLEAR_FIELDS = [
  ['#wxWebhook', 'weixinWebhook'], ['#qqWebhook', 'qqWebhook'], ['#qqToken', 'qqToken'],
  ['#dtWebhook', 'dingtalkWebhook'], ['#dtSecret', 'dingtalkSecret'],
  ['#tgToken', 'telegramToken'], ['#fsWebhook', 'feishuWebhook'], ['#fsSecret', 'feishuSecret'],
  ['#skWebhook', 'slackWebhook'], ['#scKey', 'serverchanKey'],
  ['#cwWebhook', 'customWebhook'], ['#cwHeaders', 'customHeaders'],
  ['#proxyUrl', 'proxyUrl'], ['#smtpPass', 'smtpPass']
];
function initSecretClearButtons() {
  for (const [sel, key] of SECRET_CLEAR_FIELDS) {
    const el = $(sel);
    if (!el || (el.parentElement && el.parentElement.classList.contains('input-suffix'))) continue;
    const wrap = document.createElement('div');
    wrap.className = 'input-suffix';
    el.replaceWith(wrap);
    wrap.appendChild(el);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suffix-btn clear';
    btn.dataset.clear = key;
    btn.title = tx('清除已保存');
    btn.innerHTML = icon('trash');
    btn.style.display = 'none';
    wrap.appendChild(btn);
  }
}
// 事件委托：点击清除按钮 → 调 global:clearSecrets，成功后本地同步 Configured 标志
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-clear]');
  if (!btn) return;
  const key = btn.dataset.clear;
  try {
    if (!(await flushSettings()).ok) return;
    const r = await window.aipm.clearSecrets([key]);
    if (!r || !r.ok) { toast((r && r.error) || tx('保存失败'), 'err'); return; }
    if (state.global) state.global[`${key}Configured`] = false;
    const input = btn.parentElement.querySelector('input,textarea');
    if (input) { input.value = ''; input.placeholder = ''; input.dataset.i18nPh = ''; }
    if (pendingSettings) delete pendingSettings[key];
    btn.style.display = 'none';
    toast(tx('已清除'));
  } catch (err) { toast(tx('保存失败'), 'err'); }
});

let recordingHotkey = false, hotkeyCapturePending = false;
function hotkeyLabels(value) {
  const mac = /mac/i.test(navigator.platform);
  return String(value || 'CommandOrCtrl+Alt+M').split('+').map((part) => ({
    commandorctrl: mac ? '⌘' : 'Ctrl', cmdorctrl: mac ? '⌘' : 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl',
    command: '⌘', cmd: '⌘', alt: 'Alt', option: 'Alt', shift: 'Shift', super: mac ? '⌘' : 'Win',
    meta: mac ? '⌘' : 'Win', plus: '+', space: 'Space', up: '↑', down: '↓', left: '←', right: '→'
  }[part.toLowerCase()] || part));
}
function renderHotkey() {
  const button = $('#hotkeyRecorder'), enabled = $('#hotkeyEnabled').checked;
  button.disabled = !enabled || hotkeyCapturePending; $('#hotkeyReset').disabled = !enabled;
  button.classList.toggle('recording', recordingHotkey);
  button.setAttribute('aria-label', tx(recordingHotkey ? '按下新的快捷键，Esc 取消' : '点击录制快捷键'));
  button.innerHTML = recordingHotkey ? `<span class="hotkey-record-dot"></span><span>${tx('按下快捷键…')}</span>`
    : hotkeyLabels($('#hotkey').value).map((label) => `<kbd>${escapeHtml(label)}</kbd>`).join('<span class="key-plus">+</span>');
  $('#hotkeyHint').textContent = tx(recordingHotkey ? '按下新组合，Esc 取消' : !enabled ? '开启全局快捷键后可修改' : '点击右侧按键组合录制，修改后自动保存');
}
function stopHotkeyRecording() {
  recordingHotkey = false;
  void window.aipm.setHotkeyCapture(false).catch(() => {});
  renderHotkey();
}
$('#hotkeyRecorder').addEventListener('click', async () => {
  if (recordingHotkey || hotkeyCapturePending) return;
  hotkeyCapturePending = true; renderHotkey();
  try {
    const result = await window.aipm.setHotkeyCapture(true);
    if (!result.ok) throw new Error(result.error || tx('无法开始录制快捷键'));
    recordingHotkey = true;
  } catch (err) { toast(err.message, 'err'); }
  finally { hotkeyCapturePending = false; renderHotkey(); $('#hotkeyRecorder').focus(); }
});
$('#hotkeyRecorder').addEventListener('keydown', (event) => {
  if (!recordingHotkey) return;
  event.preventDefault(); event.stopPropagation();
  if (event.key === 'Escape') { stopHotkeyRecording(); return; }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
  const named = { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Enter: 'Return', Tab: 'Tab', Equal: 'Plus', Minus: '-' };
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5)
    : /^F(?:[1-9]|1\d|2[0-4])$/.test(event.key) ? event.key : named[event.code];
  if (!key || !(event.ctrlKey || event.altKey || event.metaKey)) {
    $('#hotkeyHint').textContent = tx('请包含 Ctrl、Alt 或 Win / Command 之一'); return;
  }
  const modifiers = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super'].filter(Boolean);
  $('#hotkey').value = [...modifiers, key].join('+');
  recordingHotkey = false; renderHotkey(); saveNotify();
  void flushSettings().finally(() => window.aipm.setHotkeyCapture(false).catch(() => {}));
});
$('#hotkeyRecorder').addEventListener('blur', () => { if (recordingHotkey) stopHotkeyRecording(); });
$('#hotkeyReset').addEventListener('click', () => {
  $('#hotkey').value = 'CommandOrCtrl+Alt+M'; stopHotkeyRecording(); saveNotify();
});
$('#hotkeyEnabled').addEventListener('change', () => { if (recordingHotkey) stopHotkeyRecording(); renderHotkey(); });
let notifyFormInitialized = false;
function renderNotify(force = false) {
  if (notifyFormInitialized && !force) { renderNotifyHealth(); renderHotkey(); return; }
  notifyFormInitialized = true;
  const g = state.global || {};
  const secretValue = (sel, key) => {
    const el = $(sel);
    el.dataset.secretDefaultPlaceholder ??= el.getAttribute('placeholder') || '';
    el.dataset.dynamicPlaceholder = '1';
    el.value = '';
    el.placeholder = g[`${key}Configured`] ? tx('已配置，留空保持不变') : tx(el.dataset.secretDefaultPlaceholder);
    const btn = el.parentElement.querySelector('[data-clear]');
    if (btn) btn.style.display = g[`${key}Configured`] ? '' : 'none';
  };
  $('#wxEnable').checked = Boolean(g.notifyWeixinEnabled);
  $('#qqEnable').checked = Boolean(g.notifyQQEnabled);
  $('#dtEnable').checked = Boolean(g.notifyDingtalkEnabled);
  secretValue('#wxWebhook', 'weixinWebhook');
  secretValue('#qqWebhook', 'qqWebhook');
  secretValue('#dtWebhook', 'dingtalkWebhook');
  secretValue('#dtSecret', 'dingtalkSecret');
  $('#qqTarget').value = g.qqTarget || '';
  $('#qqTargetType').value = g.qqTargetType === 'group' ? 'group' : 'private';
  secretValue('#qqToken', 'qqToken');
  $('#autoStart').checked = g.autoStartCheckOnLaunch !== false;
  $('#concurrency').value = g.concurrency || 4;
  $('#closeAction').value = g.closeAction === 'exit' ? 'exit' : 'tray';
  // 扩展通知渠道
  $('#tgEnable').checked = Boolean(g.notifyTelegramEnabled);
  secretValue('#tgToken', 'telegramToken');
  $('#tgChatId').value = g.telegramChatId || '';
  $('#tgApiBase').value = g.telegramApiBase || '';
  $('#fsEnable').checked = Boolean(g.notifyFeishuEnabled);
  secretValue('#fsWebhook', 'feishuWebhook');
  secretValue('#fsSecret', 'feishuSecret');
  $('#skEnable').checked = Boolean(g.notifySlackEnabled);
  secretValue('#skWebhook', 'slackWebhook');
  $('#scEnable').checked = Boolean(g.notifyServerChanEnabled);
  secretValue('#scKey', 'serverchanKey');
  $('#cwEnable').checked = Boolean(g.notifyCustomEnabled);
  secretValue('#cwWebhook', 'customWebhook');
  $('#cwTemplate').value = g.customTemplate || '';
  secretValue('#cwHeaders', 'customHeaders');
  // 检测参数
  $('#probeLimit').value = g.probeLimit || 20;
  $('#requestTimeoutMs').value = g.requestTimeoutMs || 20000;
  $('#probeTimeoutMs').value = g.probeTimeoutMs || 15000;
  $('#retries').value = g.retries == null ? 1 : g.retries;
  $('#probeConcurrency').value = g.probeConcurrency || 8;
  $('#probeJitterMs').value = g.probeJitterMs == null ? 120 : g.probeJitterMs;
  $('#probeRotate').checked = g.probeRotate !== false;
  $('#insecureSkipVerify').checked = Boolean(g.insecureSkipVerify);
  // 告警策略
  $('#alertFailThreshold').value = g.alertFailThreshold || 2;
  $('#alertRecoverNotify').checked = g.alertRecoverNotify !== false;
  $('#alertCooldownMin').value = g.alertCooldownMin == null ? 10 : g.alertCooldownMin;
  $('#alertEscalateMin').value = g.alertEscalateMin == null ? 0 : g.alertEscalateMin;
  $('#alertOnModelChange').checked = g.alertOnModelChange !== false;
  $('#alertQuietEnabled').checked = Boolean(g.alertQuietEnabled);
  $('#alertQuietStart').value = g.alertQuietStart || '23:00';
  $('#alertQuietEnd').value = g.alertQuietEnd || '07:00';
  $('#latencyAlertEnabled').checked = Boolean(g.latencyAlertEnabled);
  $('#latencyAlertMs').value = g.latencyAlertMs == null ? 5000 : g.latencyAlertMs;
  $('#latencyAlertConsecutive').value = g.latencyAlertConsecutive == null ? 3 : g.latencyAlertConsecutive;
  // 代理
  $('#proxyEnabled').checked = Boolean(g.proxyEnabled);
  secretValue('#proxyUrl', 'proxyUrl');
  // 历史与日志
  $('#historyEnabled').checked = g.historyEnabled !== false;
  $('#modelHistoryEnabled').checked = g.modelHistoryEnabled !== false;
  $('#historyKeepDays').value = g.historyKeepDays || 90;
  $('#sloTarget').value = g.sloTarget ?? 99.9;
  $('#sloWindowDays').value = g.sloWindowDays || 30;
  $('#logKeepDays').value = g.logKeepDays || 7;
  $('#logMaxFileMB').value = g.logMaxFileMB || 10;
  $('#logLevel').value = g.logLevel || 'info';
  // 外观与启动
  $('#theme').value = g.theme || 'system';
  $('#launchAtLogin').checked = Boolean(g.launchAtLogin);
  $('#launchMinimized').checked = Boolean(g.launchMinimized);
  $('#lang').value = g.lang || 'zh';
  $('#hotkeyEnabled').checked = g.hotkeyEnabled !== false;
  $('#hotkey').value = g.hotkey || '';
  renderHotkey();
  $('#trayBalloonEnabled').checked = g.trayBalloonEnabled !== false;
  $('#autoUpdateCheck').checked = g.autoUpdateCheck !== false;
  // 邮件日报
  $('#dailyReportEnabled').checked = Boolean(g.dailyReportEnabled);
  $('#dailyReportTime').value = g.dailyReportTime || '08:00';
  $('#smtpHost').value = g.smtpHost || '';
  $('#smtpPort').value = g.smtpPort || 465;
  $('#smtpSecure').checked = g.smtpSecure !== false;
  if ($('#smtpInsecureSkipVerify')) $('#smtpInsecureSkipVerify').checked = Boolean(g.smtpInsecureSkipVerify);
  $('#smtpUser').value = g.smtpUser || '';
  secretValue('#smtpPass', 'smtpPass');
  $('#mailFrom').value = g.mailFrom || '';
  $('#mailTo').value = g.mailTo || '';
  renderNotifyHealth();
}

/**
 * 通道是否「已启用且配置完整」（与主进程 channelEnabled 同规则）。
 * 健康记录只在真实发送后才有，因此不能只看 health 判断「未使用」——
 * 否则刚启用、还没发过消息的通道会被误标成未使用。
 */
function channelReady(g, ch) {
  switch (ch) {
    case 'weixin': return Boolean(g.notifyWeixinEnabled && g.weixinWebhookConfigured);
    case 'qq': return Boolean(g.notifyQQEnabled && g.qqWebhookConfigured && g.qqTarget);
    case 'dingtalk': return Boolean(g.notifyDingtalkEnabled && g.dingtalkWebhookConfigured);
    case 'telegram': return Boolean(g.notifyTelegramEnabled && g.telegramTokenConfigured && g.telegramChatId);
    case 'feishu': return Boolean(g.notifyFeishuEnabled && g.feishuWebhookConfigured);
    case 'slack': return Boolean(g.notifySlackEnabled && g.slackWebhookConfigured);
    case 'serverchan': return Boolean(g.notifyServerChanEnabled && g.serverchanKeyConfigured);
    case 'custom': return Boolean(g.notifyCustomEnabled && g.customWebhookConfigured);
    default: return false;
  }
}

/** 通道开关是否打开（与 channelReady 配合区分「没启用」和「启用了但没填全」） */
function channelSwitchedOn(g, ch) {
  const key = {
    weixin: 'notifyWeixinEnabled', qq: 'notifyQQEnabled', dingtalk: 'notifyDingtalkEnabled',
    telegram: 'notifyTelegramEnabled', feishu: 'notifyFeishuEnabled', slack: 'notifySlackEnabled',
    serverchan: 'notifyServerChanEnabled', custom: 'notifyCustomEnabled'
  }[ch];
  return Boolean(key && g[key]);
}

/** 通知通道健康面板：正常（绿）/ 连续失败（红）/ 已启用待发送 / 配置不完整 / 未使用 */
function renderNotifyHealth() {
  const wrap = $('#notifyHealthList');
  if (!wrap) return;
  const health = (state.selfmon && state.selfmon.notifyHealth) || {};
  const g = state.global || {};
  const LABELS = { weixin: '微信', qq: 'QQ', dingtalk: '钉钉', telegram: 'Telegram', feishu: '飞书', slack: 'Slack', serverchan: 'Server酱', custom: tx('自定义') };
  const focusChannel = document.activeElement?.closest('[data-channel]')?.dataset.channel;
  let readyCount = 0;
  let usedCount = 0;
  wrap.innerHTML = Object.keys(LABELS).map((ch) => {
    const h = health[ch];
    const ready = channelReady(g, ch);
    const on = channelSwitchedOn(g, ch);
    if (ready) readyCount++;
    let dot = 'idle';
    // 未启用/配置不全一律不展示历史成功记录，避免换成新配置后仍显示旧的绿灯；
    // 开关已开但缺地址/Token 时单独提示「配置不完整」，这比笼统的「未使用」更能指出问题。
    let meta = tx('未使用');
    if (ready) {
      if (h && h.fails > 0) {
        usedCount++;
        dot = 'bad';
        meta = `${tx('连续失败 {n} 次', { n: h.fails })} · ${fmtWhen(h.lastFailAt)}`;
      } else if (h && h.lastOkAt) {
        usedCount++;
        dot = 'ok';
        meta = `${tx('正常')} · ${tx('最后成功 {t}', { t: fmtWhen(h.lastOkAt) })}`;
      } else {
        meta = tx('已启用 · 待发送');
      }
    } else if (on) {
      meta = tx('配置不完整');
    }
    const errTip = ready && h && h.lastError ? ` title="${escapeHtml(h.lastError)}"` : '';
    return `<button type="button" class="health-item" data-channel="${ch}"${errTip} aria-label="${escapeHtml(tx('配置 {name} 通知', { name: tx(LABELS[ch]) }))}">
      <span class="health-dot ${dot}"></span>
      <span class="health-name">${escapeHtml(LABELS[ch])}</span>
      <span class="health-meta">${escapeHtml(meta)}</span>
    </button>`;
  }).join('');
  if (focusChannel) wrap.querySelector(`[data-channel="${focusChannel}"]`)?.focus({ preventScroll: true });
  const hint = $('#nhHint');
  if (!readyCount) hint.textContent = tx('尚未启用任何通知通道');
  else if (!usedCount) hint.textContent = tx('发送过通知后这里会显示各通道最近的成功 / 失败状态');
  else hint.textContent = '';
}
$('#notifyHealthList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-channel]');
  if (!button) return;
  const panel = document.getElementById('channel-' + button.dataset.channel);
  if (!panel) return;
  panel.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  panel.querySelector('.panel-body input')?.focus({ preventScroll: true });
});
let notifySaveTimer = null, pendingSettings = null;
let settingsSaving = 0;
let settingsCommit = Promise.resolve({ ok: true });
function settingsStatus(text, bad = false) {
  $$('.settings-save-status').forEach((el) => { el.textContent = text; el.classList.toggle('bad', bad); });
  const days = Number($('#sloWindowDays').value), keep = Number($('#historyKeepDays').value);
  $('#sloRetentionHint').textContent = keep < days ? tx('历史保留短于 SLO 窗口，缺失时段将记为未知') : '';
}
function captureSettings() {
    const int = (sel, def, min, max) => {
      const v = Number($(sel).value);
      if (!Number.isFinite(v)) return def;
      return Math.max(min, Math.min(max, Math.round(v)));
    };
    const secretPatch = (key, sel) => {
      const value = $(sel).value.trim();
      return value ? { [key]: value } : {};
    };
    return {
      notifyWeixinEnabled: $('#wxEnable').checked,
      ...secretPatch('weixinWebhook', '#wxWebhook'),
      notifyQQEnabled: $('#qqEnable').checked,
      ...secretPatch('qqWebhook', '#qqWebhook'),
      qqTarget: $('#qqTarget').value.trim(),
      qqTargetType: $('#qqTargetType').value,
      ...secretPatch('qqToken', '#qqToken'),
      notifyDingtalkEnabled: $('#dtEnable').checked,
      ...secretPatch('dingtalkWebhook', '#dtWebhook'),
      ...secretPatch('dingtalkSecret', '#dtSecret'),
      notifyTelegramEnabled: $('#tgEnable').checked,
      ...secretPatch('telegramToken', '#tgToken'),
      telegramChatId: $('#tgChatId').value.trim(),
      telegramApiBase: $('#tgApiBase').value.trim() || 'https://api.telegram.org',
      notifyFeishuEnabled: $('#fsEnable').checked,
      ...secretPatch('feishuWebhook', '#fsWebhook'),
      ...secretPatch('feishuSecret', '#fsSecret'),
      notifySlackEnabled: $('#skEnable').checked,
      ...secretPatch('slackWebhook', '#skWebhook'),
      notifyServerChanEnabled: $('#scEnable').checked,
      ...secretPatch('serverchanKey', '#scKey'),
      notifyCustomEnabled: $('#cwEnable').checked,
      ...secretPatch('customWebhook', '#cwWebhook'),
      customTemplate: $('#cwTemplate').value.trim(),
      ...secretPatch('customHeaders', '#cwHeaders'),
      probeLimit: int('#probeLimit', 20, 1, 100),
      requestTimeoutMs: int('#requestTimeoutMs', 20000, 1000, 120000),
      probeTimeoutMs: int('#probeTimeoutMs', 15000, 1000, 120000),
      retries: int('#retries', 1, 0, 5),
      probeConcurrency: int('#probeConcurrency', 8, 1, 16),
      probeJitterMs: int('#probeJitterMs', 120, 0, 2000),
      probeRotate: $('#probeRotate').checked,
      insecureSkipVerify: $('#insecureSkipVerify').checked,
      alertFailThreshold: int('#alertFailThreshold', 2, 1, 20),
      alertRecoverNotify: $('#alertRecoverNotify').checked,
      alertCooldownMin: int('#alertCooldownMin', 10, 0, 1440),
      alertEscalateMin: int('#alertEscalateMin', 0, 0, 1440),
      alertOnModelChange: $('#alertOnModelChange').checked,
      alertQuietEnabled: $('#alertQuietEnabled').checked,
      alertQuietStart: $('#alertQuietStart').value || '23:00',
      alertQuietEnd: $('#alertQuietEnd').value || '07:00',
      latencyAlertEnabled: $('#latencyAlertEnabled').checked,
      latencyAlertMs: int('#latencyAlertMs', 5000, 100, 3600000),
      latencyAlertConsecutive: int('#latencyAlertConsecutive', 3, 1, 100),
      proxyEnabled: $('#proxyEnabled').checked,
      ...secretPatch('proxyUrl', '#proxyUrl'),
      historyEnabled: $('#historyEnabled').checked,
      modelHistoryEnabled: $('#modelHistoryEnabled').checked,
      historyKeepDays: int('#historyKeepDays', 90, 1, 365),
      sloTarget: Math.min(100, Math.max(90, Number($('#sloTarget').value) || 99.9)),
      sloWindowDays: int('#sloWindowDays', 30, 1, 90),
      logKeepDays: int('#logKeepDays', 7, 1, 365),
      logMaxFileMB: int('#logMaxFileMB', 10, 1, 200),
      logLevel: $('#logLevel').value || 'info',
      theme: $('#theme').value || 'system',
      launchAtLogin: $('#launchAtLogin').checked,
      launchMinimized: $('#launchMinimized').checked,
      lang: $('#lang').value || 'zh',
      hotkeyEnabled: $('#hotkeyEnabled').checked,
      hotkey: $('#hotkey').value.trim(),
      trayBalloonEnabled: $('#trayBalloonEnabled').checked,
      autoUpdateCheck: $('#autoUpdateCheck').checked,
      dailyReportEnabled: $('#dailyReportEnabled').checked,
      dailyReportTime: $('#dailyReportTime').value || '08:00',
      smtpHost: $('#smtpHost').value.trim(),
      smtpPort: int('#smtpPort', 465, 1, 65535),
      smtpSecure: $('#smtpSecure').checked,
      smtpInsecureSkipVerify: Boolean($('#smtpInsecureSkipVerify') && $('#smtpInsecureSkipVerify').checked),
      smtpUser: $('#smtpUser').value.trim(),
      ...secretPatch('smtpPass', '#smtpPass'),
      mailFrom: $('#mailFrom').value.trim(),
      mailTo: $('#mailTo').value.trim(),
      autoStartCheckOnLaunch: $('#autoStart').checked,
      concurrency: Math.max(1, Math.min(16, Number($('#concurrency').value) || 4)),
      closeAction: $('#closeAction').value === 'exit' ? 'exit' : 'tray'
    };
}
function saveNotify() {
  if (!notifyFormInitialized) renderNotify();
  // Capture immediately: navigation must never replace the input before debounce fires.
  pendingSettings = { ...(pendingSettings || {}), ...captureSettings() };
  settingsStatus(tx('等待保存…'));
  clearTimeout(notifySaveTimer);
  notifySaveTimer = setTimeout(() => { void flushSettings(); }, 350);
}
function flushSettings() {
  clearTimeout(notifySaveTimer); notifySaveTimer = null;
  const patch = pendingSettings; pendingSettings = null;
  if (!patch) return settingsCommit;
  settingsSaving++;
  settingsCommit = settingsCommit.catch(() => ({ ok: false })).then(async () => {
    settingsStatus(tx('保存中…'));
    try {
      const r = await window.aipm.setGlobal(patch);
      if (!r?.ok) throw new Error(r?.error || tx('保存失败'));
      const secretKeys = new Set(SECRET_CLEAR_FIELDS.map(([, key]) => key));
      for (const [key, value] of Object.entries(patch)) {
        if (!secretKeys.has(key)) state.global[key] = value;
        else if (value) state.global[key + 'Configured'] = true;
      }
      for (const [sel, key] of SECRET_CLEAR_FIELDS) {
        if (patch[key] && $(sel).value.trim() === patch[key]) {
          $(sel).value = ''; $(sel).placeholder = tx('已配置，留空保持不变');
          const clear = $(sel).parentElement.querySelector('[data-clear]');
          if (clear) clear.style.display = '';
        }
      }
      settingsStatus(tx(pendingSettings ? '等待保存…' : '已保存'));
      applyTheme(); applyLang();
      return { ok: true };
    } catch (err) {
      pendingSettings = { ...patch, ...(pendingSettings || {}) };
      settingsStatus(tx('保存失败，点击重试'), true);
      toast(err.message || tx('保存失败'), 'err');
      return { ok: false, error: err.message };
    } finally { settingsSaving--; }
  });
  return settingsCommit;
}
$$('.settings-save-status').forEach((el) => el.addEventListener('click', () => { void flushSettings(); }));
['wxEnable', 'qqEnable', 'dtEnable', 'autoStart', 'tgEnable', 'fsEnable', 'skEnable', 'scEnable', 'cwEnable',
 'alertRecoverNotify', 'alertOnModelChange', 'alertQuietEnabled', 'proxyEnabled', 'historyEnabled',
 'launchAtLogin', 'launchMinimized', 'probeRotate', 'insecureSkipVerify', 'modelHistoryEnabled',
 'smtpInsecureSkipVerify', 'latencyAlertEnabled',
 'hotkeyEnabled', 'trayBalloonEnabled', 'autoUpdateCheck', 'dailyReportEnabled', 'smtpSecure']
  .forEach((id) => { const el = $('#' + id); if (el) el.addEventListener('change', saveNotify); });
['wxWebhook', 'qqWebhook', 'qqTarget', 'qqToken', 'dtWebhook', 'dtSecret', 'concurrency',
 'tgToken', 'tgChatId', 'tgApiBase', 'fsWebhook', 'fsSecret', 'skWebhook', 'scKey',
 'cwWebhook', 'cwTemplate', 'cwHeaders', 'probeLimit', 'requestTimeoutMs', 'probeTimeoutMs', 'retries',
 'alertFailThreshold', 'alertCooldownMin', 'alertEscalateMin', 'alertQuietStart', 'alertQuietEnd', 'proxyUrl',
 'latencyAlertMs', 'latencyAlertConsecutive',
 'sloTarget', 'sloWindowDays', 'historyKeepDays', 'logKeepDays', 'logMaxFileMB', 'probeConcurrency', 'probeJitterMs', 'hotkey',
 'dailyReportTime', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'mailFrom', 'mailTo']
  .forEach((id) => { const el = $('#' + id); if (el) el.addEventListener('input', saveNotify); });
$('#qqTargetType').addEventListener('change', saveNotify);
$('#closeAction').addEventListener('change', saveNotify);
$('#logLevel').addEventListener('change', saveNotify);
$('#theme').addEventListener('change', () => { saveNotify(); state.global.theme = $('#theme').value; applyTheme(); });
$('#lang').addEventListener('change', () => {
  saveNotify(); state.global.lang = $('#lang').value; applyLang(); render();
});

// 指引折叠
$$('.guide-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const guide = document.getElementById(btn.dataset.guide);
    if (guide) guide.closest('.guide').classList.toggle('open');
  });
});

async function testSavedSettings(buttonId, hintId, operation) {
  const button = $('#' + buttonId), hint = $('#' + hintId);
  button.disabled = true; saveNotify();
  hint.textContent = tx('保存中…'); hint.className = 'hint';
  try {
    const saved = await flushSettings();
    if (!saved.ok) throw new Error(saved.error || tx('保存失败'));
    hint.textContent = tx('发送中…');
    const result = await operation();
    hint.textContent = result.ok ? tx('发送成功') : tx('失败: ') + result.error;
    hint.className = 'hint ' + (result.ok ? 'ok' : 'bad');
  } catch (err) { hint.textContent = tx('失败: ') + err.message; hint.className = 'hint bad'; }
  finally { button.disabled = false; }
}
[['wxTest', 'wxHint', 'weixin'], ['qqTest', 'qqHint', 'qq'], ['dtTest', 'dtHint', 'dingtalk'],
 ['tgTest', 'tgHint', 'telegram'], ['fsTest', 'fsHint', 'feishu'], ['skTest', 'skHint', 'slack'],
 ['scTest', 'scHint', 'serverchan'], ['cwTest', 'cwHint', 'custom']]
  .forEach(([buttonId, hintId, channel]) => $('#' + buttonId).addEventListener('click', () => {
    void testSavedSettings(buttonId, hintId, () => window.aipm.testNotify(channel));
  }));
$('#btnMailTest').addEventListener('click', () => { void testSavedSettings('btnMailTest', 'mailHint', () => window.aipm.testMail()); });

// ---------- 统计分析 ----------
function statsHours() {
  const v = Number(($('#stRange') && $('#stRange').value) || 24);
  return v > 0 ? v : 24;
}

// 请求序号：快速切换时间范围/视图时，旧响应不得覆盖新数据
let statsSeq = 0, statsAt = 0, statsKey = '';

function statsIncludesHistory() { return $('#stScope').value === 'history'; }
function statsPercent(value) {
  return value == null ? '—' : Number(value).toLocaleString(lang() === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: 2 }) + '%';
}
function metricValue(value, unit = '') { return value == null ? '—' : Number(value).toLocaleString() + (unit ? ' ' + unit : ''); }
function providerStatsName(p) {
  const badge = p.archived ? tx('历史记录') : p.enabled === false ? tx('已停用') : '';
  return `<div class="stats-provider-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>${badge ? `<span class="stats-provider-meta">${badge}</span>` : ''}`;
}
async function renderStats(force = true) {
  const includeHistorical = statsIncludesHistory();
  const key = JSON.stringify([statsHours(), includeHistorical, state.global.sloTarget, state.global.sloWindowDays, state.providers.map((p) => [p.id, p.name, p.enabled, p.sloTarget])]);
  if (!force && key === statsKey && Date.now() - statsAt < 30000) return;
  statsAt = Date.now(); statsKey = key;
  const seq = ++statsSeq, hours = statsHours(), button = $('#stRefresh');
  button.disabled = true; button.classList.add('loading');
  $('#stScopeHint').textContent = tx(includeHistorical ? '含已不在配置中的历史记录' : '仅统计当前配置中的服务商');
  try {
    const [sum, ser, slo] = await Promise.all([
      window.aipm.historySummary({ hours, includeHistorical }),
      window.aipm.historySeries({ hours, buckets: 48, includeHistorical }),
      window.aipm.historySLO({ includeHistorical })
    ]);
    if (seq !== statsSeq) return;
    if (!sum.ok) throw new Error(sum.error || tx('统计读取失败'));
    const o = sum.overall;
    $('#stUptime').textContent = statsPercent(o.timeUptime);
    $('#stUptimeHint').textContent = tx('基于已观测时长');
    $('#stCoverageValue').textContent = coverageText(o);
    $('#stCoverage').textContent = tx('未知') + ' ' + signedDuration(o.unknownMs);
    $('#stProviders').textContent = o.providers;
    $('#stSamples').textContent = metricValue(o.samples);
    $('#stSamplesHint').textContent = tx('{n} 个服务商', { n: o.providers });
    $('#stP95').innerHTML = o.latencyP95 == null ? '—' : `${metricValue(o.latencyP95)}<small>ms</small>`;
    $('#stLatencyHint').textContent = tx('平均延迟') + ' ' + metricValue(o.latencyAvg, 'ms');
    $('#stUpdated').textContent = tx('更新于 {time}', { time: fmtTime(sum.to) });
    renderObservation(o);
    if (slo.ok) renderSLO(slo);
    else { $('#sloOverview').textContent = tx('统计读取失败：') + (slo.error || ''); $('#sloTable').innerHTML = ''; }
    if (ser.ok) drawChart(ser);
    else $('#stChart').textContent = tx('统计读取失败：') + (ser.error || '');
    $('#stChartHint').textContent = tx('按样本统计，空白区间表示无采样') + (o.samples ? ' · ' + tx('每桶 {n} 分钟', { n: Math.round((ser.bucketMs || 0) / 60000) }) : '');
    if (!sum.perProvider.length) {
      $('#stTable').innerHTML = `<div class="stats-empty">${icon('server')}<strong>${tx('当前范围内没有服务商')}</strong><span>${tx('添加服务商并完成检测后，这里会展示运行数据')}</span></div>`;
      return;
    }
    $('#stTable').innerHTML = `<table class="analytics-table detail-stats-table"><thead><tr>
      <th>${tx('服务商')}</th><th>${tx('可用率 / 覆盖率')}</th><th>${tx('检测结果')}</th><th>${tx('故障与恢复')}</th><th>${tx('延迟')}</th><th>${tx('最后状态')}</th>
      </tr></thead><tbody>` + sum.perProvider.map((p) => {
      const cls = p.timeUptime == null ? 'unknown' : p.timeUptime >= 99 ? 'up' : p.timeUptime >= 90 ? 'degraded' : 'down';
      const si = statusInfo(p.lastStatus);
      return `<tr><td>${providerStatsName(p)}</td>
        <td><strong class="st-uptime u-${cls}">${statsPercent(p.timeUptime)}</strong><span class="table-secondary">${tx('覆盖率')} ${coverageText(p)}</span></td>
        <td><div class="sample-breakdown"><span class="sample-up" title="${tx('在线')}">${p.upCount}</span><span class="sample-degraded" title="${tx('异常')}">${p.degCount}</span><span class="sample-down" title="${tx('离线')}">${p.downCount}</span><span class="sample-auth" title="${tx('鉴权失败')}">${p.authCount || 0}</span></div><span class="table-secondary">${p.samples} ${tx('个样本')}</span></td>
        <td><span>${p.incidents || 0} ${tx('次故障')}</span><span class="table-secondary ${p.currentOutageMs ? 'is-negative' : ''}">${p.currentOutageMs ? tx('当前故障') + ' ' + signedDuration(p.currentOutageMs) : 'MTTR ' + (p.recoveredIncidents ? signedDuration(p.mttrMs) : '—')}</span></td>
        <td><strong>${metricValue(p.latencyAvg, 'ms')}</strong><span class="table-secondary">P95 ${metricValue(p.latencyP95, 'ms')}</span></td>
        <td><span class="status-pill st-${si.cls}"><span class="status-dot ${si.cls}"></span>${si.text}</span><span class="table-secondary">${p.lastAt ? fmtWhen(p.lastAt) : tx('尚无检测记录')}</span></td></tr>`;
    }).join('') + '</tbody></table>';
  } catch (err) {
    if (seq === statsSeq) {
      $('#stUpdated').textContent = tx('更新失败');
      $('#stTable').textContent = tx('统计读取失败：') + err.message;
    }
  } finally { if (seq === statsSeq) { button.disabled = false; button.classList.remove('loading'); } }
}
function renderObservation(o) {
  const total = o.windowMs || 1, online = o.upMs / total * 100, failed = o.downMs / total * 100;
  const rows = [[tx('在线时长'), o.upMs, 'online'], [tx('已知故障'), o.downMs, 'failed'], [tx('未知时长'), o.unknownMs, 'unknown']];
  $('#stObservation').innerHTML = `<div class="observation-donut" style="--online-end:${online}%;--failure-end:${online + failed}%"><div><strong>${coverageText(o)}</strong><span>${tx('已观测')}</span></div></div><div class="observation-legend">` + rows.map(([label, ms, cls]) => `<div><span><i class="observation-dot ${cls}"></i>${label}</span><strong>${signedDuration(ms)}</strong></div>`).join('') + `</div><p class="observation-note">${tx('时长按服务商累计')}</p>`;
}
function signedDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const sign = ms < 0 ? '−' : '', sec = Math.floor(Math.abs(ms) / 1000);
  if (Math.abs(ms) > 0 && sec === 0) return sign + '<1s';
  if (sec < 60) return sign + sec + 's';
  if (sec < 3600) return `${sign}${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${sign}${Math.floor(sec / 3600)}h ${Math.floor(sec % 3600 / 60)}m`;
  return `${sign}${Math.floor(sec / 86400)}d ${Math.floor(sec % 86400 / 3600)}h`;
}
function coverageText(row) {
  const raw = row.windowMs ? row.observedMs / row.windowMs * 100 : 0;
  return raw > 0 && raw < 0.01 ? '<0.01%' : `${row.coverage ?? 0}%`;
}
function sloStatus(value) {
  return tx(value === 'met' ? '已达标' : value === 'breached' ? '已超预算' : '数据不足');
}
function renderSLO(sum) {
  const o = sum.overall;
  $('#sloWindow').textContent = tx('最近 {n} 天', { n: sum.windowDays });
  const breached = sum.perProvider.filter((p) => p.sloMet === 'breached').length;
  const insufficient = sum.perProvider.filter((p) => p.sloMet === 'insufficient').length;
  const met = sum.perProvider.length - breached - insufficient;
  $('#sloOverview').innerHTML = `<div class="slo-summary-cell"><span>${tx('目标达成情况')}</span><div class="slo-status-counts"><span class="met">${met}<small>${tx('已达标')}</small></span><span class="breached">${breached}<small>${tx('已超预算')}</small></span><span class="insufficient">${insufficient}<small>${tx('数据不足')}</small></span></div></div>
    <div class="slo-summary-cell"><span>${tx('剩余错误预算')}</span><strong class="${o.budgetRemainingMs < 0 ? 'is-negative' : ''}">${sum.perProvider.length ? signedDuration(o.budgetRemainingMs) : '—'}</strong><small>${tx('服务商合计')} · ${tx('允许故障')} ${signedDuration(o.allowedDowntimeMs)}</small></div>
    <div class="slo-summary-cell"><span>${tx('窗口数据覆盖率')}</span><strong>${coverageText(o)}</strong><small>${tx('未知')} ${signedDuration(o.unknownMs)} · ${tx('服务商合计')}</small></div>`;
  if (!sum.perProvider.length) { $('#sloTable').innerHTML = `<div class="stats-empty compact">${tx('当前范围内没有服务商')}</div>`; return; }
  $('#sloTable').innerHTML = `<table class="analytics-table slo-stats-table"><thead><tr><th>${tx('服务商')}</th><th>${tx('可用率 / 目标')}</th><th>${tx('数据覆盖')}</th><th>${tx('剩余错误预算')}</th><th>${tx('SLO 状态')}</th></tr></thead><tbody>` + sum.perProvider.map((p) => {
    const used = p.budgetUsedPercent == null ? (p.downMs ? 100 : 0) : p.budgetUsedPercent;
    return `<tr><td>${providerStatsName(p)}</td><td><strong>${statsPercent(p.timeUptime)}</strong><span class="table-secondary">${tx('目标')} ${p.sloTarget}%</span></td>
      <td><strong>${coverageText(p)}</strong><div class="coverage-track"><i style="width:${Math.min(100, Math.max(0, p.coverage))}%"></i></div><span class="table-secondary">${tx('未知')} ${signedDuration(p.unknownMs)}</span></td>
      <td><strong class="${p.budgetRemainingMs < 0 ? 'is-negative' : ''}">${signedDuration(p.budgetRemainingMs)}</strong><div class="slo-budget ${p.budgetRemainingMs < 0 ? 'breached' : ''}"><i style="width:${Math.min(100, Math.max(0, used))}%"></i></div><span class="table-secondary">${tx('已知故障')} ${signedDuration(p.downMs)} · ${tx('已使用')} ${p.budgetUsedPercent == null ? (p.downMs ? '∞' : '0') : p.budgetUsedPercent}%</span></td>
      <td><span class="slo-status ${p.sloMet}"><i></i>${sloStatus(p.sloMet)}</span></td></tr>`;
  }).join('') + '</tbody></table>';
}
$('#sloExport').addEventListener('click', async () => {
  const r = await window.aipm.reportExport({ format: 'html', hours: (state.global.sloWindowDays || 30) * 24, includeHistorical: statsIncludesHistory() });
  if (r.ok) toast(tx('已导出到文件')); else if (!r.canceled) toast(r.error || tx('保存失败'), 'err');
});

/** 内联 SVG 双轴折线图：可用率(绿, 0-100) + 平均延迟(蓝, 自适应)。
 * 统计页大图与详情弹窗迷你图共用；mountId 为挂载容器 id。 */
function drawChart(ser, mountId = 'stChart', W = 900, H = 200) {
  if (mountId === 'stChart') { W = Math.max(430, $('#' + mountId).clientWidth || 760); H = 240; }
  const pts = ser.buckets || [];
  const valid = pts.filter((b) => b.samples > 0);
  if (!valid.length) {
    $('#' + mountId).innerHTML = `<div class="stats-empty">${icon('chart')}<strong>${tx('暂无趋势数据')}</strong><span>${tx('检测运行一段时间后，趋势会在这里逐步形成')}</span></div>`;
    return;
  }
  const maxLat = Math.max(1, ...valid.map((b) => b.latencyAvg || 0));
  const latencyLabel = metricValue(maxLat, 'ms');
  const PAD = { l: 40, r: Math.max(60, latencyLabel.length * 7.5 + 12), t: 16, b: 28 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
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
    return out.map((c) => c.length === 1 ? `<circle cx="${c[0].split(',')[0]}" cy="${c[0].split(',')[1]}" r="3.5"/>` : `<polyline points="${c.join(' ')}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  };

  const grid = [0, 25, 50, 75, 100].map((v) =>
    `<line x1="${PAD.l}" y1="${yU(v)}" x2="${W - PAD.r}" y2="${yU(v)}" class="ch-grid"/>
     <text x="${PAD.l - 6}" y="${yU(v) + 4}" class="ch-lbl" text-anchor="end">${v}</text>`).join('');

  const t0 = new Date(ser.from), t1 = new Date(ser.to);
  const hm = (d) => ser.to - ser.from > 86400000 ? `${d.getMonth() + 1}/${d.getDate()}` : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const middle = new Date((ser.from + ser.to) / 2);

  $('#' + mountId).innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="ch-svg" role="img" aria-label="${tx('可用率与延迟趋势')}">
    ${grid}
    <g class="ch-lat">${seg('latencyAvg', yL)}</g>
    <g class="ch-up">${seg('uptime', yU)}</g>
    <text x="${PAD.l}" y="${H - 6}" class="ch-lbl">${hm(t0)}</text>
    <text x="${PAD.l + iw / 2}" y="${H - 6}" class="ch-lbl" text-anchor="middle">${hm(middle)}</text>
    <text x="${W - PAD.r}" y="${H - 6}" class="ch-lbl" text-anchor="end">${hm(t1)}</text>
    <text x="${W - 4}" y="${PAD.t + 4}" class="ch-lbl" text-anchor="end">${latencyLabel}</text>
  </svg>`;
}

if ($('#stRefresh')) {
  $('#stRefresh').addEventListener('click', renderStats);
  $('#stRange').addEventListener('change', renderStats);
  $('#stScope').addEventListener('change', renderStats);
  $('#stExportCsv').addEventListener('click', async () => {
    const r = await window.aipm.historyExportCSV({ hours: statsHours(), includeHistorical: statsIncludesHistory() });
    if (r.ok) toast(tx('历史明细已导出'));
    else if (!r.canceled) toast(tx('导出失败: ') + r.error, 'err');
  });
  $('#stExportReport').addEventListener('click', async () => {
    const r = await window.aipm.reportExport({ format: 'html', hours: statsHours(), includeHistorical: statsIncludesHistory() });
    if (r.ok) toast(tx('状态报告已导出'));
    else if (!r.canceled) toast(tx('导出失败: ') + r.error, 'err');
  });
}

// ---------- 日志 ----------
let logLines = [];
let logsLoaded = false;
function renderLogs() {
  if (!logsLoaded) {
    logsLoaded = true;
    window.aipm.getLogs().then((lines) => { logLines = (lines || []).slice(-2000); appendLogLines(logLines, true); });
  }
  refreshLogProviderFilter();
  renderLogFiles();
}

/** 服务商过滤下拉：日志行内含 [名称] 标记，按名称匹配 */
function refreshLogProviderFilter() {
  const sel = $('#logProviderFilter');
  if (!sel) return;
  const cur = sel.value;
  const names = state.providers.map((p) => p.name).filter(Boolean).sort();
  sel.innerHTML = `<option value="">${tx('全部服务商')}</option>` +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if (names.includes(cur)) sel.value = cur;
}

function logMatchesFilter(l) {
  const q = ($('#logFilter').value || '').trim().toLowerCase();
  const lv = $('#logLevelFilter') ? $('#logLevelFilter').value : '';
  const pv = $('#logProviderFilter') ? $('#logProviderFilter').value : '';
  if (lv && l.level !== lv) return false;
  if (pv && !(l.msg || '').includes(`[${pv}]`)) return false;
  if (!q) return true;
  return (l.msg || '').toLowerCase().includes(q);
}

// ---------- 日志文件管理（logs:files / logs:deleteFile） ----------
async function renderLogFiles() {
  const wrap = $('#logFilesList');
  if (!wrap) return;
  try {
    const r = await window.aipm.logFiles();
    if (!r || !r.ok) return;
    const list = r.list || [];
    const hint = $('#logFilesHint');
    if (hint) hint.textContent = list.length ? `${list.length} ${tx('个文件')} · ${tx('保留天数可在设置中调整')}` : '';
    wrap.innerHTML = list.length ? list.map((f) => {
      const d = new Date(f.mtime);
      return `<div class="bk-item">
        <span class="nav-ic bk-item-ic">${icon('terminal')}</span>
        <div class="bk-item-main">
          <div class="bk-item-name">${escapeHtml(f.file)}</div>
          <div class="bk-item-sub">${(f.size / 1024).toFixed(1)} KB · ${d.toLocaleString('zh-CN')}</div>
        </div>
        <button class="btn small ghost" data-logdel="${escapeHtml(f.file)}">${tx('删除')}</button>
      </div>`;
    }).join('') : `<div class="empty" style="padding:14px 0;">${tx('暂无日志文件')}</div>`;
  } catch (e) { /* 静默 */ }
}

$('#logFilesList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-logdel]');
  if (!btn) return;
  const name = btn.dataset.logdel;
  confirmDialog(tx('删除日志文件'), tx('确定删除 {name} 吗？该操作不可撤销。', { name }), async () => {
    const r = await window.aipm.deleteLogFile(name);
    if (r && r.ok) { toast(tx('已删除')); renderLogFiles(); }
    else toast((r && r.error) || tx('删除失败'), 'err');
  });
});

function appendLogLines(lines, replace = false) {
  const card = $('#logCard');
  if (replace) card.innerHTML = '';
  card.querySelector('.empty')?.remove();
  for (const l of lines) {
    if (!logMatchesFilter(l)) continue;
    const div = document.createElement('div');
    div.className = `log-line l-${l.level}`;
    div.innerHTML = `<span class="log-time">${escapeHtml(l.t)}</span><span class="log-msg">${escapeHtml(l.msg)}</span>`;
    card.appendChild(div);
  }
  while (card.children.length > 600) card.removeChild(card.firstChild);
  $('#logResultCount').textContent = tx('显示 {n} 条日志', { n: card.children.length });
  if (!card.children.length) {
    const filtering = $('#logFilter').value.trim() || $('#logLevelFilter').value || $('#logProviderFilter').value;
    card.innerHTML = `<div class="empty">${filtering ? tx('没有匹配的日志，请调整筛选条件') : tx('暂无日志，检测或发送通知后会在此显示')}</div>`;
  }
  if ($('#autoScroll').checked) card.scrollTop = card.scrollHeight;
}
window.aipm.onLogLine((l) => {
  logLines.push(l);
  if (logLines.length > 2000) logLines.splice(0, logLines.length - 2000);
  if (view === 'logs') appendLogLines([l]);
});

// 日志过滤：输入/切换时按当前过滤条件重放全部缓冲日志
$('#logFilter').addEventListener('input', () => {
  const card = $('#logCard');
  card.innerHTML = '';
  appendLogLines(logLines, true);
});
$('#logLevelFilter').addEventListener('change', () => {
  const card = $('#logCard');
  card.innerHTML = '';
  appendLogLines(logLines, true);
});
$('#logProviderFilter').addEventListener('change', () => {
  const card = $('#logCard');
  card.innerHTML = '';
  appendLogLines(logLines, true);
});

// 清除日志（仅清空界面与内存缓冲，不删除磁盘日志文件）
$('#logClear').innerHTML = icon('trash') + '<span>清除</span>';
$('#logClear').addEventListener('click', () => {
  confirmDialog(tx('清除日志'), tx('确定清除当前显示的日志吗？（磁盘日志文件保留）'), async () => {
    await window.aipm.clearLogs();
    logLines = [];
    appendLogLines([], true);
    toast(tx('日志已清除'));
  }, { okText: tx('清除'), danger: true });
});

// ---------- 备份与还原 ----------
let bkPickedFile = null;

function renderBackup() {
  window.aipm.backupListAuto().then((r) => {
    if (!r.ok) return;
    $('#bkOpenDir').textContent = tx('打开备份目录');
    const wrap = $('#bkList');
    if (!r.list.length) {
      wrap.innerHTML = `<div class="empty" style="padding:18px 0;">${tx('暂无自动备份记录，每天首次启动会自动生成一份')}</div>`;
      return;
    }
    wrap.innerHTML = r.list.map((f) => {
      const d = f.at ? new Date(f.at) : null;
      const when = d ? `${d.getFullYear()}/${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')} ${fmtTime(d.getTime())}` : f.file;
      return `<div class="bk-item" data-bkpath="${escapeHtml(f.path)}">
        <span class="nav-ic bk-item-ic">${icon('archive')}</span>
        <div class="bk-item-main">
          <div class="bk-item-name">${escapeHtml(f.file)}</div>
          <div class="bk-item-sub">${when} · ${f.count} ${tx('个服务商')} · ${(f.size / 1024).toFixed(1)} KB</div>
        </div>
        <button class="btn small ghost" data-bkrestore="${escapeHtml(f.path)}">${tx('还原')}</button>
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
  const doSave = async () => {
    const r = await window.aipm.backupSaveAs();
    $('#bkHint').textContent = r.ok ? tx('已备份') : (r.canceled ? '' : tx('失败: ') + r.error);
    $('#bkHint').className = 'hint ' + (r.ok ? 'ok' : 'bad');
    if (r.ok) toast(tx('备份完成'));
  };
  if (hasAnySecret()) {
    confirmDialog(tx('备份包含密钥'), tx('备份文件包含明文密钥（API Key、通知凭据等），请妥善保管。确定继续吗？'), doSave, { danger: false });
    return;
  }
  await doSave();
});

$('#bkQuick').addEventListener('click', async () => {
  $('#bkHint').textContent = '';
  const doSave = async () => {
    const r = await window.aipm.backupExport();
    $('#bkHint').textContent = r.ok ? tx('已备份到备份目录') : tx('失败: ') + r.error;
    $('#bkHint').className = 'hint ' + (r.ok ? 'ok' : 'bad');
    if (r.ok) { toast(tx('备份完成')); renderBackup(); }
  };
  if (hasAnySecret()) {
    confirmDialog(tx('备份包含密钥'), tx('备份文件包含明文密钥（API Key、通知凭据等），请妥善保管。确定继续吗？'), doSave, { danger: false });
    return;
  }
  await doSave();
});

function bkSelectedMode() {
  return document.querySelector('input[name="bkMode"]:checked').value;
}

$('#bkPick').addEventListener('click', async () => {
  const r = await window.aipm.backupPickFile();
  if (r.canceled) return;
  if (!r.ok) { toast(tx('读取备份失败: ') + r.error, 'err'); return; }
  bkPickedFile = r.path;
  $('#bkPicked').style.display = 'flex';
  $('#bkPicked').innerHTML = `${icon('check')}<span>${tx('已选择：')}<b>${escapeHtml(r.path.split(/[\\/]/).pop())}</b>（${r.count} ${tx('个服务商')}${r.hasGlobal ? tx('，含通知设置') : ''}）</span>`;
  $('#bkRestore').disabled = false;
});

$('#bkRestore').addEventListener('click', () => {
  if (!bkPickedFile) return;
  const mode = bkSelectedMode();
  const modeText = mode === 'merge' ? tx('合并还原') : tx('覆盖还原');
  confirmDialog(
    modeText,
    mode === 'merge'
      ? tx('将把备份中的服务商并入当前列表（按 URL 去重），通知设置保持不变。确定继续吗？')
      : tx('当前全部数据（服务商与通知设置）将被备份内容替换。确定继续吗？'),
    async () => {
      const r = await window.aipm.backupRestore(bkPickedFile, mode);
      if (r.ok) {
        const detail = mode === 'merge' ? tx('新增 {a}，更新 {u}', { a: r.added, u: r.updated }) : tx('共 {n} 个服务商', { n: r.providers });
        toast(tx('还原完成：{detail}', { detail }));
      } else {
        toast(tx('还原失败: ') + r.error, 'err');
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
    tx('覆盖还原'),
    tx('当前全部数据（服务商与通知设置）将被该备份替换。确定继续吗？'),
    async () => {
      const r = await window.aipm.backupRestore(filePath, 'overwrite');
      if (r.ok) toast(tx('还原完成：{detail}', { detail: tx('共 {n} 个服务商', { n: r.providers }) }));
      else toast(tx('还原失败: ') + r.error, 'err');
    }
  );
});

// ---------- 服务商批量导入 / 导出 ----------
let emState = { format: 'json', delimiter: 'tab' };
let imState = { format: 'json', delimiter: 'tab', items: null, errors: [] };

$('#btnImport').textContent = tx('导入');
$('#btnExport').textContent = tx('导出');
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
/** 当前配置里是否存有任何明文密钥（导出/备份前确认用） */
function hasAnySecret() {
  if (state.providers.some((p) => p.hasApiKey || p.hasCustomHeaders || p.hasProxyUrl)) return true;
  const g = state.global || {};
  return Object.keys(g).some((k) => k.endsWith('Configured') && g[k]);
}

$('#btnExport').addEventListener('click', () => {
  if (state.providers.length === 0) { toast(tx('暂无服务商可导出'), 'err'); return; }
  emState = { format: 'json', delimiter: 'tab' };
  $$('#emFormat .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.fmt === 'json'));
  $$('#emDelim .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.d === 'tab'));
  $('#emDelimField').style.display = 'none';
  // 默认不导出密钥：需要时再手动打开并经过一次确认
  $('#emWithKey').checked = false;
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

let exportContent = '', exportSeq = 0, exportPending = Promise.resolve();
function refreshExportPreview() {
  exportPending = loadExportPreview(); return exportPending;
}
async function loadExportPreview() {
  const seq = ++exportSeq;
  const r = await window.aipm.transferExport({ format: emState.format, delimiter: emState.delimiter, withKey: $('#emWithKey').checked });
  if (seq !== exportSeq) return;
  if (r.ok) {
    exportContent = r.content;
    $('#emPreview').textContent = r.content.length > 2000 ? r.content.slice(0, 2000) + '\n…' : r.content;
    $('#emError').textContent = '';
  } else {
    exportContent = '';
    $('#emError').textContent = r.error;
  }
}

$('#emCopy').addEventListener('click', async () => {
  await exportPending;
  if (!exportContent) return;
  if ($('#emWithKey').checked && state.providers.some((p) => p.hasApiKey || p.hasCustomHeaders || p.hasProxyUrl)) {
    confirmDialog(tx('包含凭据'), tx('复制内容包含明文凭据（API Key、请求头及代理），请注意剪贴板与目标位置的保管。确定继续吗？'), async () => {
      await navigator.clipboard.writeText(exportContent);
      toast(tx('已复制到剪贴板'));
    }, { danger: false });
    return;
  }
  await navigator.clipboard.writeText(exportContent);
  toast(tx('已复制到剪贴板'));
});

$('#emSave').addEventListener('click', async () => {
  const doSave = async () => {
    const r = await window.aipm.transferExportSaveAs({ format: emState.format, delimiter: emState.delimiter, withKey: $('#emWithKey').checked });
    if (r.canceled) return;
    if (r.ok) { toast(tx('已导出到文件')); $('#exportModal').classList.remove('show'); }
    else $('#emError').textContent = r.error;
  };
  if ($('#emWithKey').checked && state.providers.some((p) => p.hasApiKey || p.hasCustomHeaders || p.hasProxyUrl)) {
    confirmDialog(tx('包含凭据'), tx('导出文件将包含明文凭据（API Key、请求头及代理），请妥善保管。确定继续吗？'), doSave, { danger: false });
    return;
  }
  await doSave();
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
  if (!text.trim()) { $('#imError').textContent = tx('请先粘贴内容或选择文件'); return; }
  $('#imError').textContent = '';
  const r = await window.aipm.transferParse({ text, format: imState.format, delimiter: imState.delimiter });
  if (!r.ok) { $('#imError').textContent = r.error; $('#imApply').disabled = true; imParsed = null; return; }
  imParsed = r;
  const box = $('#imResult');
  box.style.display = '';
  if (r.items.length === 0) {
    box.innerHTML = `<span class="io-err">${tx('未解析到有效条目')}</span>` +
      (r.errors.length ? `<ul>${r.errors.map((e) => `<li>${tx('第 {n} 行：', { n: e.line })}${escapeHtml(e.msg)}</li>`).join('')}</ul>` : '');
    $('#imApply').disabled = true;
    return;
  }
  const errHtml = r.errors.length
    ? `<div class="io-err">${r.errors.length} ${tx('条已跳过：')}</div><ul>${r.errors.slice(0, 5).map((e) => `<li>${tx('第 {n} 行：', { n: e.line })}${escapeHtml(e.msg)}</li>`).join('')}${r.errors.length > 5 ? `<li>${tx('… 共 {n} 条', { n: r.errors.length })}</li>` : ''}</ul>`
    : '';
  box.innerHTML = `<span class="io-ok">${tx('解析成功：')}${r.items.length} ${tx('条服务商')}</span>${errHtml}
    <ul>${r.items.slice(0, 5).map((p) => `<li>${escapeHtml(p.name)} — ${escapeHtml(p.url)}（${tx('周期 {d}，上报 {s}', { d: p.intervalSec === undefined ? tx('不修改') : fmtDuration(p.intervalSec), s: p.notifyOnModelChange === undefined ? tx('不修改') : tx(p.notifyOnModelChange ? '开' : '关') })}）</li>`).join('')}${r.items.length > 5 ? `<li>${tx('… 共 {n} 条', { n: r.items.length })}</li>` : ''}</ul>`;
  $('#imApply').disabled = false;
}

$('#imApply').addEventListener('click', async () => {
  if (!imParsed || !imParsed.items.length) return;
  const mode = document.querySelector('input[name="imMode"]:checked').value;
  const modeText = mode === 'append' ? tx('追加') : tx('合并');
  confirmDialog(
    tx('确认{n}导入', { n: modeText }),
    tx('将{n}导入 {c} 条服务商', { n: modeText, c: imParsed.items.length })
      + (mode === 'append' ? tx('（URL 重复也会新增）') : tx('（URL 相同的现有服务商将被更新）')) + tx('。确定继续吗？'),
    async () => {
      const r = await window.aipm.transferApply({ items: imParsed.items, mode });
      if (r.ok) {
        toast(tx('导入完成：新增 {a}', { a: r.added }) + (r.updated ? tx('，更新 {u}', { u: r.updated }) : ''));
        $('#importModal').classList.remove('show');
      } else {
        $('#imError').textContent = tx('导入失败: ') + r.error;
      }
    },
    { okText: tx('开始导入'), danger: false }
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

// state-changed 高频到达（每轮检测一条），200ms 合并渲染：
// 短时间多服务商完成检测时不再逐条重建 DOM，打字与选中不被打断
let renderTimer = null;
function queueRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 200);
}

// ---------- 启动 ----------
// 托盘菜单点具体服务商：切到服务商视图并直接打开详情
window.aipm.onOpenProvider((id) => {
  if (view !== 'providers') navTo('providers');
  setTimeout(() => openDetail(Number(id)), 120);
});
window.aipm.onStateChanged((s) => {
  const changed = JSON.stringify(state.global) !== JSON.stringify(s.global);
  state = s;
  if (changed && notifyFormInitialized && !pendingSettings && !notifySaveTimer && !settingsSaving) renderNotify(true);
  queueRender();
});
window.aipm.getState().then((s) => { state = s; renderNotify(); render(); refreshUptime24(true); });
window.aipm.getAppVersion().then((v) => { $('#appVersion').textContent = 'V' + v; }).catch(() => {});
setInterval(() => { void refreshUptime24(); }, 5 * 60 * 1000);
initSecretClearButtons();
for (const sel of ['#fKey', '#fCustomHeaders', '#fProxyUrl', ...SECRET_CLEAR_FIELDS.map(([sel]) => sel)]) $(sel).dataset.dynamicPlaceholder = '1';
initStaticIcons();
$('#settings-appearance').parentElement.prepend($('#settings-appearance'));
selectSettingsCategory(settingsCategory);
// Connect static labels and descriptions to their fields for keyboard and screen-reader use.
$$('.field').forEach((field, index) => {
  const label = [...field.children].find((el) => el.tagName === 'LABEL' && !el.classList.contains('switch') && !el.classList.contains('checkbox'));
  const control = field.querySelector('input:not([type="hidden"]),select,textarea');
  if (!label || !control || label.contains(control)) return;
  if (control.id) label.htmlFor = control.id;
  const hint = field.querySelector('.field-hint');
  if (hint) { hint.id ||= 'field-hint-' + index; control.setAttribute('aria-describedby', hint.id); }
});
$$('.opt-row').forEach((row, index) => {
  const title = row.querySelector('.opt-title'), hint = row.querySelector('.opt-sub');
  if (!title) return;
  title.id ||= 'option-title-' + index;
  if (hint) hint.id ||= 'option-hint-' + index;
  $$('input:not([type="hidden"]),select,textarea', row).forEach((input) => {
    input.setAttribute('aria-labelledby', title.id);
    if (hint) input.setAttribute('aria-describedby', hint.id);
  });
});
$$('.notify-channel').forEach((panel) => {
  const title = panel.querySelector('h2'); title.id = panel.id + '-title';
  panel.querySelector('.panel-head input').setAttribute('aria-labelledby', title.id);
});
render();
refreshUptime24();

let modalFocusOrigin = null;
const modalObserver = new MutationObserver((changes) => {
  for (const change of changes) {
    const mask = change.target;
    if (mask.classList.contains('show') && !(change.oldValue || '').split(' ').includes('show')) {
      modalFocusOrigin = document.activeElement;
      const dialog = mask.firstElementChild;
      dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      const focusable = dialog.querySelector('input, select, button, textarea');
      if (focusable) focusable.focus();
    } else if (!mask.classList.contains('show') && (change.oldValue || '').split(' ').includes('show')) {
      if (mask.id === 'detailModal') { detailSeq++; detailId = null; }
      if (modalFocusOrigin?.isConnected) modalFocusOrigin.focus();
    }
  }
});
$$('.modal-mask').forEach((mask) => modalObserver.observe(mask, { attributes: true, attributeFilter: ['class'], attributeOldValue: true }));
document.addEventListener('keydown', (event) => {
  const modal = $('#confirmModal.show') || $$('.modal-mask.show').at(-1);
  if (!modal) return;
  if (event.key === 'Escape') { event.preventDefault(); modal.classList.remove('show'); return; }
  if (event.key === 'Enter' && modal.id === 'providerModal' && event.target.tagName === 'INPUT') { event.preventDefault(); $('#pmSave').click(); return; }
  if (event.key !== 'Tab') return;
  const nodes = $$('button:not(:disabled),input:not(:disabled),textarea,select,summary,[tabindex="0"]', modal).filter((el) => el.getClientRects().length);
  const first = nodes[0], last = nodes.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
$$('.icon-btn').forEach((el) => el.setAttribute('aria-label', tx('关闭')));
