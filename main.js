'use strict';
const { app, BrowserWindow, ipcMain, Menu, Tray, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const pkg = require('./package.json');
const { loadAll, saveAll, DATA_DIR, DATA_FILE, DEFAULT_GLOBAL } = require('./src/store');
const logger = require('./src/logger');
const { Scheduler } = require('./src/scheduler');
const { notifyModelChange, notifyAlert, sendTest, getNotifyHealth } = require('./src/notifier');
const backup = require('./src/backup');
const transfer = require('./src/transfer');
const { formatDuration } = require('./src/durfmt');
const history = require('./src/history');
const alerts = require('./src/alerts');

let db = { global: { ...DEFAULT_GLOBAL }, providers: [] };
let win = null;
let tray = null;
let quitting = false;
let appUpdater = null;
const unreadAlerts = [];   // 未读告警（内存态，上限 50；打开主界面即清零）
let lastBalloonAt = 0;     // 托盘气泡上次弹出时间（5 分钟节流）
const selfmon = { slowChecks: 0, queueWarns: 0, lastQueueWarnAt: 0 };  // 自监控计数

const scheduler = new Scheduler({ concurrency: db.global.concurrency || 4 });

// ---------- 数据层 ----------
function persist() {
  try { saveAll(db); } catch (e) { logger.error(`保存数据失败: ${e.message}`); }
}

function load() {
  db = loadAll();
  scheduler.setConcurrency(db.global.concurrency || 4);
  logger.configure(db.global);
  applyLoginItem(db.global);
}

function snapshot(provider) {
  if (!provider) return null;
  return {
    status: provider.status || 'unknown',
    modelsTotal: provider.modelsTotal || 0,
    modelsAvailable: [...(provider.modelsAvailable || [])]
  };
}

/** 开机自启：按全局配置同步到系统登录项 */
function applyLoginItem(g) {
  try {
    if (process.platform === 'linux') return;
    app.setLoginItemSettings({
      openAtLogin: Boolean(g && g.launchAtLogin),
      openAsHidden: Boolean(g && g.launchMinimized)
    });
  } catch (e) { logger.warn(`开机自启设置失败: ${e.message}`); }
}

function applyResult(provider, result, reason) {
  const prev = snapshot(provider);
  provider.status = result.status;
  provider.latency = result.latency;
  provider.modelsTotal = result.modelsTotal;
  provider.modelsAvailable = result.modelsAvailable || [];
  provider.modelsUnavailable = result.modelsUnavailable || [];
  provider.modelsUnprobed = result.modelsUnprobed || [];
  provider.modelDetails = result.modelDetails || [];
  provider.checkedAt = result.checkedAt;
  provider.lastError = result.error || null;

  // 轮询游标回写（detector 给出下一轮偏移；缺省保持原值）
  if (Number.isFinite(Number(result.probeCursor))) provider.probeCursor = Number(result.probeCursor);

  // 变动判定：状态翻转 + 基线差集（新增/失去）。
  // 基线 = 历史累计出现过的可用模型全集。轮询覆盖下每轮只探测子集，
  // 用"本轮可用 vs 全集"判新增、用"不可用命中全集"判失去，避免子集轮换造成误报。
  // 注意：不把 modelsTotal/未探测数量纳入判定，避免上游列表顺序抖动造成误报。
  const baseline = new Set(Array.isArray(provider.modelBaseline) ? provider.modelBaseline : []);
  // 首次检测（此前从未成功检测过）：仅建立基准，不算变动、不推送
  const firstRealCheck = !prev || prev.status === 'unknown';
  const unSet = new Set(provider.modelsUnavailable);
  let added = [];
  let lost = [];
  if (firstRealCheck) {
    for (const m of provider.modelsAvailable) baseline.add(m);
  } else {
    added = provider.modelsAvailable.filter((m) => !baseline.has(m));
    lost = [...baseline].filter((m) => unSet.has(m));
    for (const m of added) baseline.add(m);
  }
  provider.modelBaseline = [...baseline];
  const statusChanged = !firstRealCheck && prev.status !== provider.status;
  const modelChanged = !firstRealCheck && (statusChanged || added.length > 0 || lost.length > 0);
  provider.modelChanged = modelChanged;

  // 变动详情日志：明确列出新增/失去与状态翻转
  if (firstRealCheck) {
    logger.info(`[变动] [${provider.name}] 首次检测，基准已建立: ${result.status}，可用 ${provider.modelsAvailable.length}/${result.modelsTotal}（不计变动、不推送）`);
  } else if (modelChanged) {
    const parts = [];
    if (statusChanged) parts.push(`状态翻转 ${statusText(prev.status)} → ${statusText(provider.status)}`);
    if (prev.modelsTotal !== result.modelsTotal) parts.push(`模型总数 ${prev.modelsTotal} → ${result.modelsTotal}`);
    if (added.length) parts.push(`新增可用 ${added.length} 个: ${added.join(', ')}`);
    if (lost.length) parts.push(`失去可用 ${lost.length} 个: ${lost.join(', ')}`);
    if (!added.length && !lost.length && !statusChanged) parts.push('模型清单变化');
    logger.warn(`[变动] [${provider.name}] ${parts.join('；')}`);
  }

  logger.info(`检测完成 [${provider.name}] ${result.status} 可用 ${provider.modelsAvailable.length}/${result.modelsTotal} (来源:${reason})${modelChanged ? ' · 模型已变化' : ''}`);

  // 历史时序落盘（供可用率/延迟统计）
  if (db.global.historyEnabled !== false) {
    history.append(DATA_DIR, provider, result);
    if (db.global.modelHistoryEnabled !== false && typeof history.appendModels === 'function') {
      history.appendModels(DATA_DIR, provider.id, result.checkedAt, result.modelDetails);
    }
  }

  // 告警策略引擎：消抖 / 恢复通知 / 静默时段 / 冷却去重
  const decision = alerts.evaluate(db.global, provider, prev, { modelChanged, firstCheck: firstRealCheck });
  provider.consecutiveFail = decision.consecutiveFail;
  for (const a of decision.alerts) {
    if (a.kind === 'modelChange') {
      notifyModelChange(db.global, provider, prev, provider, { added, lost }).catch((e) => logger.error(`通知失败: ${e.message}`));
      logger.warn(`[告警] [${provider.name}] 模型变动已推送`);
    } else {
      notifyAlert(db.global, provider, a).catch((e) => logger.error(`通知失败: ${e.message}`));
      logger.warn(`[告警] [${provider.name}] ${a.title}：${a.reason}`);
    }
  }
  updateTrayStatus();
  return { modelChanged, alerts: decision.alerts, firstCheck: firstRealCheck };
}

/** 状态中英文映射（日志与通知文案用） */
function statusText(s) {
  return { up: '在线', degraded: '异常', down: '离线', authfail: '鉴权失败', unknown: '待检测' }[s] || s;
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtMs(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
}

/** 状态报告：CSV */
function buildReportCSV(sum) {
  const head = ['服务商', '样本数', '可用率(%)', '在线次数', '异常次数', '离线次数', '累计故障时长', '平均延迟(ms)', 'P50(ms)', 'P95(ms)', '最大延迟(ms)', '最后状态'];
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = '\t' + s;   // 公式注入防护
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = sum.perProvider.map((p) => [
    p.name, p.samples, p.uptime, p.upCount, p.degCount, p.downCount,
    fmtMs(p.downMs), p.latencyAvg ?? '', p.latencyP50 ?? '', p.latencyP95 ?? '', p.latencyMax ?? '', statusText(p.lastStatus)
  ].map(esc).join(','));
  return [head.join(','), ...rows].join('\r\n');
}

/** 状态报告：自包含 HTML（内联样式，可直接发邮件/存档） */
function buildReportHTML(sum) {
  const o = sum.overall;
  const rows = sum.perProvider.map((p) => {
    const color = p.uptime >= 99 ? '#34c759' : p.uptime >= 90 ? '#ff9500' : '#ff3b30';
    return `<tr>
      <td>${escHtml(p.name)}</td>
      <td style="text-align:right">${p.samples}</td>
      <td style="text-align:right;color:${color};font-weight:600">${p.uptime}%</td>
      <td style="text-align:right">${p.upCount}/${p.degCount}/${p.downCount}</td>
      <td style="text-align:right">${fmtMs(p.downMs)}</td>
      <td style="text-align:right">${p.latencyAvg ?? '—'}</td>
      <td style="text-align:right">${p.latencyP95 ?? '—'}</td>
      <td>${statusText(p.lastStatus)}</td>
    </tr>`;
  }).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>AI Provider Monitor 状态报告</title></head>
<body style="font-family:-apple-system,'Segoe UI',sans-serif;background:#f2f2f7;margin:0;padding:32px;color:#1c1c1e">
<div style="max-width:1000px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.06)">
  <h1 style="margin:0 0 6px;font-size:24px">AI Provider 状态报告</h1>
  <p style="margin:0 0 24px;color:#8e8e93;font-size:13px">统计区间：最近 ${sum.rangeHours} 小时 · 生成于 ${new Date().toLocaleString('zh-CN')}</p>
  <div style="display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap">
    <div style="flex:1;min-width:150px;background:#f2f2f7;border-radius:12px;padding:16px">
      <div style="font-size:12px;color:#8e8e93">整体可用率</div>
      <div style="font-size:28px;font-weight:700">${o.uptime}%</div></div>
    <div style="flex:1;min-width:150px;background:#f2f2f7;border-radius:12px;padding:16px">
      <div style="font-size:12px;color:#8e8e93">服务商数</div>
      <div style="font-size:28px;font-weight:700">${o.providers}</div></div>
    <div style="flex:1;min-width:150px;background:#f2f2f7;border-radius:12px;padding:16px">
      <div style="font-size:12px;color:#8e8e93">检测样本</div>
      <div style="font-size:28px;font-weight:700">${o.samples}</div></div>
    <div style="flex:1;min-width:150px;background:#f2f2f7;border-radius:12px;padding:16px">
      <div style="font-size:12px;color:#8e8e93">延迟 P95</div>
      <div style="font-size:28px;font-weight:700">${o.latencyP95 ?? '—'}<span style="font-size:14px"> ms</span></div></div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#f2f2f7">
      <th style="text-align:left;padding:10px">服务商</th>
      <th style="text-align:right;padding:10px">样本</th>
      <th style="text-align:right;padding:10px">可用率</th>
      <th style="text-align:right;padding:10px">在线/异常/离线</th>
      <th style="text-align:right;padding:10px">故障时长</th>
      <th style="text-align:right;padding:10px">平均延迟</th>
      <th style="text-align:right;padding:10px">P95</th>
      <th style="text-align:left;padding:10px">最后状态</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="8" style="padding:24px;text-align:center;color:#8e8e93">暂无数据</td></tr>'}</tbody>
  </table>
</div></body></html>`;
}

/** 状态报告：Excel（总览 + 服务商明细双表；exceljs 懒加载） */
async function buildReportXLSX(sum) {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); }
  catch (e) { throw new Error('未安装 exceljs 依赖，无法导出 Excel（请运行 npm install）'); }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI Provider Monitor';
  const o = sum.overall;
  const s1 = wb.addWorksheet('总览');
  s1.columns = [{ header: '指标', key: 'k', width: 18 }, { header: '数值', key: 'v', width: 26 }];
  s1.addRows([
    { k: '统计区间', v: `最近 ${sum.rangeHours} 小时` },
    { k: '生成时间', v: new Date().toLocaleString('zh-CN') },
    { k: '整体可用率', v: `${o.uptime}%` },
    { k: '服务商数', v: o.providers },
    { k: '检测样本', v: o.samples },
    { k: '延迟 P95(ms)', v: o.latencyP95 ?? '—' }
  ]);
  const s2 = wb.addWorksheet('服务商明细');
  s2.columns = [
    { header: '服务商', key: 'name', width: 24 },
    { header: '样本数', key: 'samples', width: 10 },
    { header: '可用率(%)', key: 'uptime', width: 12 },
    { header: '在线次数', key: 'upCount', width: 10 },
    { header: '异常次数', key: 'degCount', width: 10 },
    { header: '离线次数', key: 'downCount', width: 10 },
    { header: '累计故障时长', key: 'downFor', width: 16 },
    { header: '平均延迟(ms)', key: 'latencyAvg', width: 14 },
    { header: 'P50(ms)', key: 'latencyP50', width: 10 },
    { header: 'P95(ms)', key: 'latencyP95', width: 10 },
    { header: '最大延迟(ms)', key: 'latencyMax', width: 14 },
    { header: '最后状态', key: 'lastStatus', width: 10 }
  ];
  for (const p of sum.perProvider) {
    s2.addRow({
      name: p.name, samples: p.samples, uptime: p.uptime,
      upCount: p.upCount, degCount: p.degCount, downCount: p.downCount,
      downFor: fmtMs(p.downMs), latencyAvg: p.latencyAvg ?? '', latencyP50: p.latencyP50 ?? '',
      latencyP95: p.latencyP95 ?? '', latencyMax: p.latencyMax ?? '', lastStatus: statusText(p.lastStatus)
    });
  }
  s1.getRow(1).font = { bold: true };
  s2.getRow(1).font = { bold: true };
  return wb.xlsx.writeBuffer();
}

/** 托盘图标提示：汇总整体健康度 */
function updateTrayStatus() {
  if (!tray) return;
  try {
    const up = db.providers.filter((p) => p.status === 'up').length;
    const deg = db.providers.filter((p) => p.status === 'degraded').length;
    const down = db.providers.filter((p) => p.status === 'down').length;
    const auth = db.providers.filter((p) => p.status === 'authfail').length;
    const bad = deg + down + auth;
    const mark = (down + auth) > 0 ? '●' : deg > 0 ? '▲' : '✓';
    const unread = unreadAlerts.length;
    tray.setToolTip(`AI Provider Monitor ${mark}\n在线 ${up} · 异常 ${deg} · 离线 ${down}${auth ? ` · 鉴权失败 ${auth}` : ''}${unread ? `\n未读告警 ${unread} 条（点击托盘查看）` : ''}`);
    if (process.platform === 'win32') {
      tray.setTitle && tray.setTitle('');
    }
    if (bad > 0 && win && !win.isDestroyed()) {
      win.setOverlayIcon && win.setOverlayIcon(null, `${bad} 个服务商异常`);
    }
  } catch (e) { /* ignore */ }
}

scheduler.on('result', (provider, result, reason) => {
  const out = applyResult(provider, result, reason) || {};
  selfmonObserve(provider, result);
  if (out.alerts && out.alerts.length) pushUnread(provider, out.alerts);
  persist();
  send('state-changed', publicState());
});
scheduler.on('state', () => { selfmonQueue(); send('state-changed', publicState()); });
scheduler.getProvider = (id) => db.providers.find((p) => p.id === id);
scheduler.getGlobal = () => db.global;

// ---------- 未读告警 / 托盘气泡 / 自监控 / 快捷键 / 邮件日报 ----------

/** 新告警入未读队列 + 托盘气泡（节流、可关闭） */
function pushUnread(provider, alertsArr) {
  const now = Date.now();
  for (const a of alertsArr) {
    unreadAlerts.push({ t: now, providerId: provider.id, name: provider.name, kind: a.kind, title: a.title });
  }
  while (unreadAlerts.length > 50) unreadAlerts.shift();
  const first = alertsArr[0];
  maybeBalloon('AI Provider Monitor', `${provider.name}：${first.title}${alertsArr.length > 1 ? ` 等 ${alertsArr.length} 条` : ''}`);
  updateTrayStatus();
}

function maybeBalloon(title, content) {
  try {
    if (!tray || db.global.trayBalloonEnabled === false) return;
    const now = Date.now();
    if (now - lastBalloonAt < 5 * 60 * 1000) return;
    lastBalloonAt = now;
    tray.displayBalloon({ title, content: String(content).slice(0, 200) });
  } catch (e) { /* ignore */ }
}

function clearUnread() {
  if (!unreadAlerts.length) return;
  unreadAlerts.length = 0;
  updateTrayStatus();
  send('state-changed', publicState());
}

/** 自监控：单轮检测耗时超阈值记 warn（计数供前端展示） */
function selfmonObserve(provider, result) {
  const slowMs = Number(db.global.selfmonSlowMs) > 0 ? Number(db.global.selfmonSlowMs) : 60000;
  if (result && Number(result.durationMs) > slowMs) {
    selfmon.slowChecks++;
    logger.warn(`[自检] [${provider.name}] 本轮检测耗时 ${result.durationMs} ms，超过阈值 ${slowMs} ms`);
  }
}

/** 自监控：检测排队积压超阈值记 warn（5 分钟节流） */
function selfmonQueue() {
  try {
    const depth = scheduler.queue ? scheduler.queue.length : 0;
    const warnAt = Number(db.global.selfmonQueueWarn) > 0 ? Number(db.global.selfmonQueueWarn) : 20;
    if (depth >= warnAt && Date.now() - selfmon.lastQueueWarnAt > 5 * 60 * 1000) {
      selfmon.lastQueueWarnAt = Date.now();
      selfmon.queueWarns++;
      logger.warn(`[自检] 检测排队积压 ${depth} 个（阈值 ${warnAt}），请检查周期设置与并发数`);
    }
  } catch (e) { /* ignore */ }
}

/** 全局快捷键：显示/隐藏主界面（可改键、可关闭） */
function registerHotkey() {
  try {
    globalShortcut.unregisterAll();
    if (db.global.hotkeyEnabled === false) return;
    const acc = String(db.global.hotkey || '').trim() || 'CommandOrCtrl+Alt+M';
    const ok = globalShortcut.register(acc, () => {
      if (win) { if (win.isVisible()) win.hide(); else { win.show(); win.focus(); } }
      else createWindow();
    });
    if (!ok) logger.warn(`[快捷键] 注册失败: ${acc}（可能被其它程序占用）`);
    else logger.info(`[快捷键] 已注册 ${acc} 显示/隐藏主界面`);
  } catch (e) { logger.warn(`[快捷键] 注册异常: ${e.message}`); }
}

/** 邮件日报：每天指定时刻发送一次（30 秒粒度轮询，由启动定时器驱动） */
async function maybeDailyMail() {
  try {
    const g = db.global;
    if (!g.dailyReportEnabled) return;
    const { mailConfigValid, sendMail } = require('./src/mailer');
    if (!mailConfigValid(g)) return;
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hm !== String(g.dailyReportTime || '08:00')) return;
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (g.lastReportDay === day) return;
    const sum = history.summarize(DATA_DIR, { hours: 24 });
    await sendMail(g, { subject: `AI Provider 日报 ${day}（可用率 ${sum.overall.uptime}%）`, html: buildReportHTML(sum) });
    db.global.lastReportDay = day;
    persist();
    logger.info(`[邮件] 日报已发送至 ${g.mailTo}`);
  } catch (e) { logger.error(`[邮件] 日报发送失败: ${e.message}`); }
}

// ---------- 自动启动检测 ----------
function startAutoChecks() {
  if (!db.global.autoStartCheckOnLaunch) {
    logger.info('未启用"启动即检测"，等待手动触发');
    return;
  }
  for (const p of db.providers) {
    if (p.enabled !== false) scheduler.runCheck(p.id, { reason: 'startup' });
    if (p.enabled !== false) scheduler.schedule(p);
  }
}

// ---------- IPC ----------
function publicProvider(p) {
  const { apiKey, ...rest } = p;
  return { ...rest, hasApiKey: Boolean(apiKey), apiKeyMasked: apiKey ? maskKey(apiKey) : '' };
}
function maskKey(k) {
  if (k.length <= 8) return k.slice(0, 2) + '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}
function publicState() {
  return {
    providers: db.providers.map(publicProvider),
    global: db.global,
    running: scheduler.runningList(),
    dataFile: DATA_FILE,
    dataDir: DATA_DIR,
    logDir: logger.LOG_DIR,
    unread: { count: unreadAlerts.length, items: unreadAlerts.slice(-5).reverse() },
    selfmon: { slowChecks: selfmon.slowChecks, queueWarns: selfmon.queueWarns, notifyFails: getNotifyHealth() }
  };
}
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle('state:get', () => publicState());
ipcMain.handle('logs:get', () => logger.recent());
ipcMain.handle('logs:clear', () => { logger.clear(); return { ok: true }; });
logger.subscribe((line) => send('log:line', line));

ipcMain.handle('provider:add', (e, data) => {
  const id = Date.now() + Math.floor(Math.random() * 1000);
  const p = {
    id,
    name: String(data.name || '').trim(),
    url: String(data.url || '').trim().replace(/\/+$/, ''),
    apiKey: String(data.apiKey || '').trim(),
    intervalSec: Math.max(5, Number(data.intervalSec) || 60),
    notifyOnModelChange: Boolean(data.notifyOnModelChange),
    note: String(data.note || '').trim(),
    group: String(data.group || '').trim(),
    tags: Array.isArray(data.tags) ? data.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    probeMode: String(data.probeMode || 'chat'),
    probePath: String(data.probePath || '').trim(),
    probeBody: String(data.probeBody || '').trim(),
    probeLimit: Number(data.probeLimit) > 0 ? Number(data.probeLimit) : null,
    proxyUrl: String(data.proxyUrl || '').trim(),
    useProxy: data.useProxy !== false,
    maintEnabled: Boolean(data.maintEnabled),
    maintStart: String(data.maintStart || '02:00'),
    maintEnd: String(data.maintEnd || '04:00'),
    insecureSkipVerify: data.insecureSkipVerify === true ? true : data.insecureSkipVerify === false ? false : null,
    enabled: true,
    status: 'unknown',
    modelsAvailable: [],
    modelsUnavailable: [],
    modelsUnprobed: [],
    modelDetails: [],
    modelsTotal: 0,
    checkedAt: null,
    lastError: null,
    consecutiveFail: 0,
    probeCursor: 0,
    modelBaseline: []
  };
  db.providers.push(p);
  persist();
  if (p.enabled !== false) scheduler.schedule(p);
  logger.info(`新增 Provider [${p.name}] ${p.url}`);
  send('state-changed', publicState());
  return { ok: true, id };
});

ipcMain.handle('provider:update', (e, { id, data }) => {
  const p = db.providers.find((x) => x.id === Number(id));
  if (!p) return { ok: false, error: 'Provider 不存在' };
  const periodChanged = Number(data.intervalSec) !== Number(p.intervalSec);
  Object.assign(p, {
    name: String(data.name || p.name).trim(),
    url: String(data.url || p.url).trim().replace(/\/+$/, ''),
    apiKey: String(data.apiKey ?? p.apiKey).trim(),
    intervalSec: Math.max(5, Number(data.intervalSec) || p.intervalSec),
    notifyOnModelChange: Boolean(data.notifyOnModelChange),
    note: String(data.note ?? p.note).trim(),
    group: String(data.group ?? p.group ?? '').trim(),
    tags: Array.isArray(data.tags) ? data.tags.map((t) => String(t).trim()).filter(Boolean) : (p.tags || []),
    probeMode: String(data.probeMode || p.probeMode || 'chat'),
    probePath: String(data.probePath ?? p.probePath ?? '').trim(),
    probeBody: String(data.probeBody ?? p.probeBody ?? '').trim(),
    probeLimit: Number(data.probeLimit) > 0 ? Number(data.probeLimit) : (p.probeLimit || null),
    proxyUrl: String(data.proxyUrl ?? p.proxyUrl ?? '').trim(),
    useProxy: data.useProxy !== undefined ? data.useProxy !== false : (p.useProxy !== false),
    maintEnabled: data.maintEnabled !== undefined ? Boolean(data.maintEnabled) : Boolean(p.maintEnabled),
    maintStart: String(data.maintStart ?? p.maintStart ?? '02:00'),
    maintEnd: String(data.maintEnd ?? p.maintEnd ?? '04:00'),
    insecureSkipVerify: data.insecureSkipVerify === undefined ? (p.insecureSkipVerify ?? null)
      : (data.insecureSkipVerify === true ? true : data.insecureSkipVerify === false ? false : null)
  });
  persist();
  // 仅在周期变化时重排定时器（schedule 内部也会保护未变化的定时器），
  // 避免编辑名称/备注等操作把轮循从头计时
  if (p.enabled !== false && periodChanged) scheduler.schedule(p);
  logger.info(`更新 Provider [${p.name}]${periodChanged ? `（周期调整为 ${formatDuration(p.intervalSec)}，已重新调度）` : ''}`);
  send('state-changed', publicState());
  return { ok: true };
});

ipcMain.handle('provider:delete', (e, id) => {
  const i = db.providers.findIndex((x) => x.id === Number(id));
  if (i < 0) return { ok: false };
  const [p] = db.providers.splice(i, 1);
  scheduler.cancel(p.id);
  alerts.resetState(p.id);
  persist();
  logger.info(`删除 Provider [${p.name}]`);
  send('state-changed', publicState());
  return { ok: true };
});

ipcMain.handle('provider:deleteMany', (e, ids) => {
  const set = new Set((ids || []).map(Number));
  const removed = [];
  db.providers = db.providers.filter((p) => {
    if (set.has(p.id)) { removed.push(p); scheduler.cancel(p.id); alerts.resetState(p.id); return false; }
    return true;
  });
  persist();
  logger.info(`批量删除 ${removed.length} 个 Provider`);
  send('state-changed', publicState());
  return { ok: true, removed: removed.length };
});

ipcMain.handle('provider:checkNow', (e, ids) => {
  const list = (ids || []).map(Number);
  for (const id of list) scheduler.runCheck(id, { reason: 'manual' });
  return { ok: true, count: list.length };
});

ipcMain.handle('provider:checkAll', () => {
  for (const p of db.providers) { if (p.enabled !== false) scheduler.runCheck(p.id, { reason: 'manual' }); }
  return { ok: true };
});

ipcMain.handle('provider:toggleEnabled', (e, { id, enabled }) => {
  const p = db.providers.find((x) => x.id === Number(id));
  if (!p) return { ok: false };
  p.enabled = Boolean(enabled);
  if (p.enabled) {
    // 重新启用：以当前时间基线立即调度（schedule 内部会按 checkedAt 判断是否补检）
    scheduler.schedule(p);
  } else {
    scheduler.cancel(p.id);
    p.modelChanged = false;   // 停用时清除"变动"徽标，避免永久残留
    // 停用后旧状态不再代表现实：回到待检测，避免列表里显示成"在线"
    p.status = 'unknown';
    p.latency = null;
    p.modelsTotal = 0;
    p.modelsAvailable = [];
    p.modelsUnavailable = [];
    p.modelsUnprobed = [];
    p.modelDetails = [];
    p.checkedAt = null;
    p.lastError = null;
    p.consecutiveFail = 0;
    alerts.resetState(p.id);
  }
  persist();
  send('state-changed', publicState());
  updateTrayStatus();
  return { ok: true };
});

ipcMain.handle('global:set', (e, patch) => {
  db.global = { ...db.global, ...patch };
  scheduler.setConcurrency(db.global.concurrency || 4);
  logger.configure(db.global);
  applyLoginItem(db.global);
  registerHotkey();
  persist();
  logger.info('全局配置已更新');
  send('state-changed', publicState());
  return { ok: true };
});

ipcMain.handle('notify:test', async (e, channel) => {
  try {
    await sendTest(db.global, channel);
    logger.info(`[通知] 测试消息发送成功 (${channel})`);
    return { ok: true };
  } catch (err) {
    logger.error(`[通知] 测试失败 (${channel}): ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open:path', (e, p) => { if (!p) return { ok: false, error: '路径为空' }; shell.openPath(p); return { ok: true }; });

ipcMain.handle('app:version', () => pkg.version || app.getVersion());

// ---------- 历史统计 ----------
ipcMain.handle('history:summary', (e, { hours, providerId } = {}) => {
  try { return { ok: true, ...history.summarize(DATA_DIR, { hours: Number(hours) || 24, providerId }) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('history:series', (e, { hours, providerId, buckets } = {}) => {
  try { return { ok: true, ...history.series(DATA_DIR, { hours: Number(hours) || 24, providerId, buckets: Number(buckets) || 48 }) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('history:exportCSV', async (e, { hours, providerId } = {}) => {
  try {
    const content = history.exportCSV(DATA_DIR, { hours: Number(hours) || 24, providerId });
    const r = await dialog.showSaveDialog(win, {
      title: '导出历史记录',
      defaultPath: `aipm-history-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, '\ufeff' + content, 'utf8');
    logger.info(`[历史] 已导出 ${r.filePath}`);
    return { ok: true, path: r.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('history:prune', (e, days) => {
  try { return { ok: true, removed: history.prune(DATA_DIR, Number(days) || 30) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('history:modelRates', (e, { providerId, hours } = {}) => {
  try { return { ok: true, ...history.modelRates(DATA_DIR, providerId, { hours: Number(hours) || 24 }) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('app:clearUnread', () => { clearUnread(); return { ok: true }; });

ipcMain.handle('mail:test', async () => {
  try {
    const { sendMail } = require('./src/mailer');
    const sum = history.summarize(DATA_DIR, { hours: 24 });
    await sendMail(db.global, { subject: 'AI Provider Monitor 邮件测试', html: buildReportHTML(sum) });
    logger.info('[邮件] 测试邮件发送成功');
    return { ok: true };
  } catch (err) { logger.error(`[邮件] 测试失败: ${err.message}`); return { ok: false, error: err.message }; }
});

// ---------- 日志文件管理 ----------
ipcMain.handle('logs:files', () => {
  try { return { ok: true, list: logger.listFiles(), dir: logger.LOG_DIR }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---------- 状态报告导出 ----------
ipcMain.handle('report:export', async (e, { format = 'html', hours = 24 } = {}) => {
  try {
    const sum = history.summarize(DATA_DIR, { hours: Number(hours) || 24 });
    const defExt = format === 'csv' ? 'csv' : 'html';
    const r = await dialog.showSaveDialog(win, {
      title: '导出状态报告',
      defaultPath: `aipm-report-${new Date().toISOString().slice(0, 10)}.${defExt}`,
      // HTML 与 Excel 同框选择：按用户实际保存的后缀决定格式（统计页不新增按钮）
      filters: defExt === 'csv'
        ? [{ name: 'CSV 文件', extensions: ['csv'] }]
        : [{ name: 'HTML 文件', extensions: ['html'] }, { name: 'Excel 文件', extensions: ['xlsx'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const ext = String(r.filePath.split('.').pop() || '').toLowerCase();
    if (ext === 'xlsx') {
      const buf = await buildReportXLSX(sum);
      fs.writeFileSync(r.filePath, buf);
    } else if (ext === 'csv' || defExt === 'csv') {
      fs.writeFileSync(r.filePath, '\ufeff' + buildReportCSV(sum), 'utf8');
    } else {
      fs.writeFileSync(r.filePath, buildReportHTML(sum), 'utf8');
    }
    logger.info(`[报告] 已导出 ${r.filePath}`);
    return { ok: true, path: r.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- 备份 / 还原 ----------
ipcMain.handle('backup:export', async (e, filePath) => {
  try {
    const target = filePath || path.join(DATA_DIR, `backup-manual-${backup.stampSafe()}.json`);
    const saved = backup.exportTo({ global: db.global, providers: db.providers }, target);
    return { ok: true, path: saved };
  } catch (err) {
    logger.error(`[备份] 导出失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:saveAs', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: '备份保存到…',
    defaultPath: `aipm-backup-${backup.stampSafe()}.json`,
    filters: [{ name: '备份文件', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    const saved = backup.exportTo({ global: db.global, providers: db.providers }, r.filePath);
    return { ok: true, path: saved };
  } catch (err) {
    logger.error(`[备份] 另存失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:pickFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择备份文件',
    properties: ['openFile'],
    filters: [{ name: '备份文件', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  // 读取摘要供确认弹窗展示
  try {
    const meta = backup.parseBackupFile(r.filePaths[0]);
    return { ok: true, path: r.filePaths[0], count: meta.providers.length, hasGlobal: Boolean(meta.global) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:restore', (e, { filePath, mode }) => {
  try {
    const res = backup.restoreFrom(db, filePath, mode === 'merge' ? 'merge' : 'overwrite');
    persist();
    // 重建全部定时器并刷新前端
    scheduler.removeAll();
    for (const p of db.providers) {
      if (p.enabled !== false) scheduler.schedule(p);
    }
    send('state-changed', publicState());
    return { ok: true, ...res };
  } catch (err) {
    logger.error(`[还原] 失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:listAuto', () => {
  try { return { ok: true, list: backup.listAuto(DATA_DIR), dir: backup.backupDir(DATA_DIR) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('backup:runAuto', () => {
  try {
    const file = backup.autoBackup({ global: db.global, providers: db.providers }, DATA_DIR, { keep: 10 });
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- 服务商批量导入 / 导出 ----------
ipcMain.handle('transfer:export', (e, { format, delimiter, withKey, filePath }) => {
  try {
    const content = transfer.exportProviders(db.providers, { format, delimiter, withKey });
    const ext = format === 'csv' ? 'csv' : format === 'text' ? 'txt' : 'json';
    if (!filePath) {
      // 无路径：纯预览，只返回内容不落盘（避免在数据目录堆积 providers-*.json 快照）
      return { ok: true, path: null, content };
    }
    fs.writeFileSync(filePath, content, 'utf8');
    logger.info(`[导入导出] 已导出到 ${filePath}`);
    return { ok: true, path: filePath, content };
  } catch (err) {
    logger.error(`[导入导出] 导出失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('transfer:exportSaveAs', async (e, { format, delimiter, withKey }) => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出服务商到…',
    defaultPath: `providers-${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : format === 'text' ? 'txt' : 'json'}`,
    filters: [{ name: format === 'csv' ? 'CSV 文件' : format === 'text' ? '文本文件' : 'JSON 文件', extensions: [format === 'csv' ? 'csv' : format === 'text' ? 'txt' : 'json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    const content = transfer.exportProviders(db.providers, { format, delimiter, withKey });
    fs.writeFileSync(r.filePath, content, 'utf8');
    logger.info(`[导入导出] 已导出到 ${r.filePath}`);
    return { ok: true, path: r.filePath, content };
  } catch (err) {
    logger.error(`[导入导出] 导出失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('transfer:parse', (e, { text, format, delimiter }) => {
  try {
    return { ok: true, ...transfer.parseImport(text, { format, delimiter }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('transfer:apply', (e, { items, mode }) => {
  try {
    const res = transfer.applyImport(db, items || [], mode === 'append' ? 'append' : 'merge');
    persist();
    // 新增的服务商加入轮循
    for (const p of db.providers) {
      if (p.enabled !== false && !scheduler.timers.has(p.id)) scheduler.schedule(p);
    }
    send('state-changed', publicState());
    return { ok: true, ...res };
  } catch (err) {
    logger.error(`[导入导出] 导入失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// ---------- 窗口 / 托盘 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1020,
    minHeight: 700,
    show: false,
    backgroundColor: '#f2f2f7',
    title: 'AI Provider Monitor',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '立即检测全部', accelerator: 'CmdOrCtrl+R', click: () => { for (const p of db.providers) { if (p.enabled !== false) scheduler.runCheck(p.id, { reason: 'manual' }); } } },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'F5', click: () => win && win.reload() },
        { label: '开发者工具', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新', click: () => { if (appUpdater) appUpdater.check(false); } },
        { label: '关于', click: () => { dialog.showMessageBox(win, { type: 'info', title: '关于', message: 'AI Provider Monitor v' + pkg.version, detail: 'AI 服务商可用性监控' }); } }
      ]
    }
  ]));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (db.global.launchMinimized) win.hide();
    else win.show();
  });
  win.on('close', (ev) => {
    if (quitting) return;
    // closeAction = 'tray'（默认）：隐藏到托盘继续监控；'exit'：直接退出
    if (db.global.closeAction === 'exit') {
      quitting = true;
      app.quit();
    } else {
      ev.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
  // 主界面获得焦点即清零未读（用户已看到）
  win.on('focus', () => { if (unreadAlerts.length) clearUnread(); });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'build', 'icon.ico');
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
    tray.setToolTip('AI Provider Monitor');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主界面', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
      { label: '立即检测全部', click: () => { for (const p of db.providers) { if (p.enabled !== false) scheduler.runCheck(p.id, { reason: 'manual' }); } } },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
  } catch (e) { logger.warn(`托盘创建失败: ${e.message}`); }
}

// 单实例锁（冒烟测试模式除外；打包产物不含 tests/，回退到正常启动）
if (process.argv.includes('--smoke-test') && fs.existsSync(path.join(__dirname, 'tests', 'app-smoke.js'))) {
  require(path.join(__dirname, 'tests', 'app-smoke.js'));
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (win) { win.show(); win.focus(); } else createWindow();
    });

    app.whenReady().then(() => {
      load();
      createWindow();
      createTray();
      startAutoChecks();
      logger.info(`AI Provider Monitor 启动，数据目录: ${DATA_DIR}`);
      // 全局快捷键（显示/隐藏主界面）
      registerHotkey();
      // 邮件日报轮询（30 秒粒度）
      setInterval(() => { void maybeDailyMail(); }, 30000);
      // 自动更新：打包版 + 开关开启时，启动 30 秒后静默检查一次
      try {
        const { createUpdater } = require('./src/updater');
        appUpdater = createUpdater({ app, dialog });
        if (app.isPackaged && db.global.autoUpdateCheck !== false) {
          setTimeout(() => { if (appUpdater) appUpdater.check(true).catch(() => {}); }, 30000);
        }
      } catch (e) { logger.warn(`[更新] 初始化失败: ${e.message}`); }
      // 每日自动备份（保留最近 10 份）
      const f = backup.autoBackup({ global: db.global, providers: db.providers }, DATA_DIR, { keep: 10 });
      if (f) logger.info(`[备份] 已生成每日自动备份: ${path.basename(f)}`);
      // 清理过期历史分片（默认保留 30 天）
      try {
        const days = Number(db.global.historyKeepDays) > 0 ? Number(db.global.historyKeepDays) : 30;
        history.prune(DATA_DIR, days);
      } catch (e) { logger.warn(`[历史] 清理失败: ${e.message}`); }
      updateTrayStatus();
    });

    app.on('before-quit', () => { quitting = true; scheduler.stop(); try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ } });
    app.on('window-all-closed', (e) => { /* 保持后台运行，由托盘退出 */ });
  }
}
