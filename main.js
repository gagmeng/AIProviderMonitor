'use strict';
const { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const pkg = require('./package.json');
// Isolate all module-level paths before loading store/logger in the smoke process.
if (process.argv.includes('--smoke-test') && !process.env.AIPM_DATA_DIR) {
  process.env.AIPM_DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aipm-app-'));
}
const { loadAll, saveAll, DATA_DIR, DATA_FILE, DEFAULT_GLOBAL } = require('./src/store');
const logger = require('./src/logger');
const { Scheduler } = require('./src/scheduler');
const notifier = require('./src/notifier');
const { notifyModelChange, notifyAlert, getNotifyHealth } = notifier;
const backup = require('./src/backup');
const history = require('./src/history');
const alerts = require('./src/alerts');
const { diffBaseline } = require('./src/baseline');
const { statusText, buildReportHTML } = require('./src/report');
const { redactValue, redactUrl, URL_FIELDS } = require('./src/redact');

let db = { global: { ...DEFAULT_GLOBAL }, providers: [] };
let persistBlocked = false;
let win = null;
let tray = null;
let quitting = false;
let appUpdater = null;
const unreadAlerts = [];   // 未读告警（内存态，上限 50；由用户在未读弹窗逐条或一键确认）
let unreadSeq = 0;         // 未读告警自增 ID（供逐条确认）
let lastBalloonAt = 0;     // 托盘气泡上次弹出时间（5 分钟节流）
const selfmon = { slowChecks: 0, queueWarns: 0, lastQueueWarnAt: 0 };  // 自监控计数

const scheduler = new Scheduler({ concurrency: db.global.concurrency || 4 });

// ---------- 数据层 ----------
function persist() {
  if (persistBlocked) {
    const error = '配置未能成功加载，已跳过保存，避免覆盖 providers.json';
    logger.error(error);
    return { ok: false, error };
  }
  try {
    saveAll(db);
    return { ok: true };
  } catch (e) {
    const error = `保存数据失败: ${e.message}`;
    logger.error(error);
    return { ok: false, error };
  }
}

// 检测结果的高频落盘走 2 秒防抖：providers.json 里同时装着三份模型列表
// （available/unavailable/baseline），大服务商每轮全量 stringify+写盘代价高。
// 配置类 IPC（增删改/还原/导入）仍走即时 persist——它们依赖写入结果做回滚。
let persistTimer = null;
function persistSoon(delay = 2000) {
  if (persistTimer || persistBlocked) return;
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, delay);
}
function flushPersistSoon() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  persist();
}

function load() {
  try {
    const loaded = loadAll();
    db = { global: loaded.global, providers: loaded.providers };
    // 手改配置里校验不过的条目已在 loadAll 里停用，这里把原因写进日志
    for (const w of loaded.warnings || []) logger.warn(`[加载] ${w}`);
    persistBlocked = false;
  } catch (e) {
    persistBlocked = true;
    db = { global: { ...DEFAULT_GLOBAL }, providers: [] };
    logger.error(e.message);
    try {
      dialog.showErrorBox('配置未能加载', `${e.message}\n\n修复 providers.json 之前，本次运行不会保存任何配置。`);
    } catch (e2) { /* ignore */ }
  }
  scheduler.setConcurrency(db.global.concurrency || 4);
  logger.configure(db.global);
  if (!persistBlocked) applyLoginItem(db.global);
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
  provider.probeLatencyAvg = result.probeLatencyAvg == null ? null : result.probeLatencyAvg;
  provider.probeLatencyP95 = result.probeLatencyP95 == null ? null : result.probeLatencyP95;
  provider.quotaRemaining = result.quotaRemaining == null ? null : result.quotaRemaining;
  provider.quotaWarning = Boolean(result.quotaWarning);
  provider.firstTokenMs = result.firstTokenMs == null ? null : result.firstTokenMs;
  provider.throughputTokensPerSec = result.throughputTokensPerSec == null ? null : result.throughputTokensPerSec;
  provider.checkedAt = result.checkedAt;
  provider.lastError = result.error || null;

  // 轮询游标回写（detector 给出下一轮偏移；缺省保持原值）
  if (Number.isFinite(Number(result.probeCursor))) provider.probeCursor = Number(result.probeCursor);

  const firstRealCheck = !prev || prev.status === 'unknown';
  // 基线只保留仍可用的模型。未探测的不记失去；已消失或本轮不可用的记一次失去后移出基线。
  // 状态翻转不并入 modelChanged，避免绕过故障消抖。
  // 连接失败 / 拉列表前鉴权失败时没有新清单，不能把基线模型当成「已消失」。
  const listKnown = result.status === 'up' || result.status === 'degraded'
    || (result.modelsAvailable || []).length > 0
    || (result.modelsUnavailable || []).length > 0
    || (result.modelsUnprobed || []).length > 0;
  const diff = diffBaseline(provider.modelBaseline, {
    available: provider.modelsAvailable,
    unavailable: provider.modelsUnavailable,
    unprobed: provider.modelsUnprobed,
    firstCheck: firstRealCheck || (!provider.modelCatalog?.length && listKnown),
    catalog: provider.modelCatalog, unknown: provider.modelUnknown || [],
    skip: !firstRealCheck && !listKnown
  });
  provider.modelBaseline = diff.baseline;
  provider.modelCatalog = diff.catalog; provider.modelUnknown = diff.unknown;
  const added = diff.added;
  const lost = diff.lost;
  const statusChanged = !firstRealCheck && prev.status !== provider.status;
  const modelChanged = diff.modelChanged;
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
  const decision = alerts.evaluate(db.global, provider, prev, { modelChanged, firstCheck: firstRealCheck, added, lost });
  provider.consecutiveFail = decision.consecutiveFail;
  dispatchAlerts(provider, decision.alerts, prev);
  updateTrayStatus();
  return { modelChanged, alerts: decision.alerts.filter((a) => a.isNew), firstCheck: firstRealCheck };
}
const deliveryInFlight = new Set(), deliveryJobs = new Set(), deliveryLanes = new Map();
function dispatchAlerts(provider, events, prev = null) {
  const revision = scheduler.revision(provider.id);
  for (const event of events) {
    const key = `${provider.id}:${event.eventId}`;
    if (deliveryInFlight.has(key)) continue;
    deliveryInFlight.add(key);
    // Keep messages for one provider in order, including slow multi-channel deliveries.
    const job = (deliveryLanes.get(provider.id) || Promise.resolve()).catch(() => {}).then(async () => {
      const pending = provider.alertRuntime?.pending?.[event.kind];
      if (!db.providers.includes(provider) || provider.enabled === false || revision !== scheduler.revision(provider.id)
        || pending?.eventId !== event.eventId) return;
      const extra = { added: event.added || [], lost: event.lost || [], delivered: pending.delivered || [], targets: pending.targets };
      const result = await (event.kind === 'modelChange'
        ? notifyModelChange(db.global, provider, prev, provider, extra) : notifyAlert(db.global, provider, event, extra));
      if (!db.providers.includes(provider) || provider.enabled === false || revision !== scheduler.revision(provider.id)) return;
      alerts.noteDelivery(provider, event, result);
      persistSoon(); send('state-changed', publicState());
    }).catch((e) => {
      if (!db.providers.includes(provider) || provider.enabled === false || revision !== scheduler.revision(provider.id)) return;
      alerts.noteDelivery(provider, event, { attempted: 0, delivered: [], failed: [{ error: e.message }] });
      persistSoon(); logger.error(`通知失败: ${e.message}`);
    }).finally(() => {
      deliveryInFlight.delete(key); deliveryJobs.delete(job);
      if (deliveryLanes.get(provider.id) === job) deliveryLanes.delete(provider.id);
    });
    deliveryJobs.add(job); deliveryLanes.set(provider.id, job);
  }
}
function retryPendingAlerts() {
  for (const provider of db.providers) {
    if (provider.enabled === false || (!Object.keys(provider.alertRuntime?.pending || {}).length && !provider.alertRuntime?.incident)) continue;
    // Re-evaluate only delivery eligibility; do not count another failed sample.
    const decision = alerts.evaluate(db.global, provider, snapshot(provider), { deliveryOnly: true });
    dispatchAlerts(provider, decision.alerts);
    const fresh = decision.alerts.filter((a) => a.isNew);
    if (fresh.length) pushUnread(provider, fresh);
  }
}
function applyGlobalConfig() {
  scheduler.setConcurrency(db.global.concurrency || 4);
  logger.configure(db.global); applyLoginItem(db.global); registerHotkey();
  for (const provider of db.providers) alerts.retryPending(provider);
}

// ---------- 托盘（状态染色 + 每服务商状态菜单） ----------
const trayIconCache = {};
const TRAY_BADGE_FILES = { ok: 'icon-ok.png', warn: 'icon-warn.png', err: 'icon-err.png' };
const TRAY_PROVIDER_LIMIT = 15;   // 菜单里最多列出的服务商数，超出折叠为一条汇总

function trayLevel() {
  const checked = db.providers.filter((p) => p.enabled !== false && p.status && p.status !== 'unknown');
  if (!checked.length) return 'idle';
  if (checked.some((p) => p.status === 'down' || p.status === 'authfail')) return 'err';
  if (checked.some((p) => p.status === 'degraded')) return 'warn';
  return 'ok';
}
function trayImageFor(level) {
  const file = TRAY_BADGE_FILES[level];
  if (!file) return null;
  if (!trayIconCache[level]) {
    const p = path.join(__dirname, 'assets', file);
    if (!fs.existsSync(p)) return null;   // gen-icons 未跑过时回退基础图标
    trayIconCache[level] = nativeImage.createFromPath(p);
  }
  return trayIconCache[level];
}

function showMainWindow() {
  if (win) { win.show(); win.focus(); } else createWindow();
}

/** 托盘右键菜单：常用动作 + 逐服务商状态行（点击直达详情） */
function rebuildTrayMenu() {
  const items = [
    { label: '显示主界面', click: showMainWindow },
    {
      label: '立即检测全部',
      click: () => { for (const p of db.providers) { if (p.enabled !== false) scheduler.runCheck(p.id, { reason: 'manual' }); } }
    },
    { label: '暂停检测', type: 'checkbox', checked: scheduler.paused, click: (item) => setPausedMain(item.checked) },
    { type: 'separator' }
  ];
  for (const p of db.providers.slice(0, TRAY_PROVIDER_LIMIT)) {
    const st = statusText(p.status);
    const detail = p.modelsTotal ? `（${(p.modelsAvailable || []).length}/${p.modelsTotal}）` : '';
    items.push({
      label: `${st} · ${p.name}${detail}`,
      click: () => { showMainWindow(); send('open-provider', p.id); }
    });
  }
  if (db.providers.length > TRAY_PROVIDER_LIMIT) {
    items.push({ label: `… 共 ${db.providers.length} 个服务商`, enabled: false });
  }
  items.push({ type: 'separator' });
  items.push({ label: '退出', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function updateTrayStatus() {
  if (!tray) return;
  try {
    const up = db.providers.filter((p) => p.status === 'up').length;
    const deg = db.providers.filter((p) => p.status === 'degraded').length;
    const down = db.providers.filter((p) => p.status === 'down').length;
    const auth = db.providers.filter((p) => p.status === 'authfail').length;
    const unread = unreadAlerts.length;
    tray.setToolTip(`AI Provider Monitor\n在线 ${up} · 异常 ${deg} · 离线 ${down}${auth ? ` · 鉴权失败 ${auth}` : ''}${scheduler.paused ? '\n（自动检测已暂停）' : ''}${unread ? `\n未读告警 ${unread} 条（点击托盘查看）` : ''}`);
    const img = trayImageFor(trayLevel());
    if (img) tray.setImage(img);
    rebuildTrayMenu();
  } catch (e) { /* ignore */ }
}

scheduler.on('result', (provider, result, reason) => {
  const out = applyResult(provider, result, reason) || {};
  selfmonObserve(provider, result);
  if (out.alerts && out.alerts.length) pushUnread(provider, out.alerts);
  persistSoon();
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
    unreadAlerts.push({ id: ++unreadSeq, t: now, providerId: provider.id, name: provider.name, kind: a.kind, title: a.title });
  }
  trimUnread();
  const first = alertsArr[0];
  maybeBalloon('AI Provider Monitor', `${provider.name}：${first.title}${alertsArr.length > 1 ? ` 等 ${alertsArr.length} 条` : ''}`);
  updateTrayStatus();
}

function trimUnread() {
  while (unreadAlerts.length > 50) unreadAlerts.shift();
}

// 通知通道连续失败（notifier.noteResult 达到里程碑时回调）：转成未读告警 + 气泡，
// 否则「告警发不出去」只有日志一行，不看通知页永远不知道
notifier.onChannelUnhealthy((ch, fails, err) => {
  const label = notifier.CHANNEL_LABEL[ch] || ch;
  unreadAlerts.push({
    id: ++unreadSeq, t: Date.now(), providerId: null,
    name: `通知通道：${label}`, kind: 'notifyFail', title: `连续失败 ${fails} 次`
  });
  trimUnread();
  maybeBalloon('通知通道异常', `${label} 连续失败 ${fails} 次：${err || '未知错误'}`);
  updateTrayStatus();
  send('state-changed', publicState());
});

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
  logger.info(`[告警] 已确认 ${unreadAlerts.length} 条未读告警`);
  unreadAlerts.length = 0;
  updateTrayStatus();
  send('state-changed', publicState());
}

/** 逐条确认未读告警（misc IPC 调用） */
function ackUnreadById(id) {
  const i = unreadAlerts.findIndex((a) => a.id === Number(id));
  if (i < 0) return { ok: false, error: '告警不存在或已确认' };
  const [a] = unreadAlerts.splice(i, 1);
  logger.info(`[告警] 已确认 1 条未读告警（${a.name}：${a.title}）`);
  updateTrayStatus();
  send('state-changed', publicState());
  return { ok: true };
}

/** 全局暂停/恢复自动检测（手动检测不受影响；恢复时错过周期的立即补检） */
function setPausedMain(paused) {
  if (Boolean(paused) === scheduler.paused) return;
  if (paused) {
    scheduler.pause();
    logger.info('[调度] 已全局暂停自动检测（手动检测不受影响）');
  } else {
    scheduler.resume();
    logger.info('[调度] 已恢复自动检测，错过周期的立即补检');
  }
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
let hotkeyCaptureActive = false;
function registerHotkey() {
  try {
    globalShortcut.unregisterAll();
    if (db.global.hotkeyEnabled === false || hotkeyCaptureActive) return;
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
let reportInFlight = false;
async function maybeDailyMail() {
  if (reportInFlight || persistBlocked) return;
  const g = db.global;
  if (!g.dailyReportEnabled) return;
  const { mailConfigValid, sendMail } = require('./src/mailer');
  if (!mailConfigValid(g)) return;
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const reportTime = String(g.dailyReportTime || '08:00');
  // 过了发送时刻仍补发一次，避免睡眠跨过那一分钟就丢当天日报
  if (hm < reportTime) return;
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (g.lastReportDay === day) return;
  reportInFlight = true;
  const prevDay = g.lastReportDay;
  g.lastReportDay = day;
  persist();
  try {
    const sum = await history.summarize(DATA_DIR, { hours: 24, providers: db.providers, sloTarget: g.sloTarget });
    await sendMail(g, { subject: `AI Provider 日报 ${day}（可用率 ${sum.overall.uptime}%）`, html: buildReportHTML(sum) });
    logger.info(`[邮件] 日报已发送至 ${g.mailTo}`);
  } catch (e) {
    g.lastReportDay = prevDay || '';
    persist();
    logger.error(`[邮件] 日报发送失败: ${e.message}`);
  } finally {
    reportInFlight = false;
  }
}

let maintenanceDay = '', maintenanceInFlight = false;
async function dailyMaintenance() {
  const day = new Date().toLocaleDateString('sv-SE');
  if (persistBlocked || maintenanceDay === day || maintenanceInFlight) return;
  maintenanceInFlight = true;
  try {
    const file = backup.autoBackup({ global: db.global, providers: db.providers }, DATA_DIR, { keep: 10 });
    if (file) logger.info(`[备份] 每日自动备份 ${path.basename(file)}`);
    await history.prune(DATA_DIR, db.global.historyKeepDays || 90);
    logger.pruneOldLogs(); maintenanceDay = day;
  } catch (e) { logger.error(`[维护] ${e.message}`); }
  finally { maintenanceInFlight = false; }
}

// ---------- 自动启动检测 ----------
function startAutoChecks() {
  for (const p of db.providers) {
    if (p.enabled === false) continue;
    if (db.global.autoStartCheckOnLaunch) scheduler.runCheck(p.id, { reason: 'startup' });
    scheduler.schedule(p);
  }
  if (!db.global.autoStartCheckOnLaunch) logger.info('未启用"启动即检测"，已保留周期轮循调度');
}

// ---------- 状态快照 ----------
function publicProvider(p) {
  const { apiKey, customHeaders, proxyUrl, ...rest } = p;
  const display = redactValue(rest);
  for (const key of URL_FIELDS) if (rest[key] !== undefined) display[key] = redactUrl(rest[key]);
  return {
    ...display,
    hasApiKey: Boolean(apiKey), apiKeyMasked: apiKey ? maskKey(apiKey) : '',
    hasCustomHeaders: Boolean(customHeaders),
    // 代理地址常含 user:pass@ 凭据，与其它密钥同样掩码下发
    hasProxyUrl: Boolean(proxyUrl), proxyUrlMasked: proxyUrl ? maskKey(proxyUrl) : ''
  };
}
const SECRET_GLOBAL_KEYS = [
  'weixinWebhook', 'qqWebhook', 'qqToken', 'dingtalkWebhook', 'dingtalkSecret',
  'telegramToken', 'feishuWebhook', 'feishuSecret', 'slackWebhook',
  'serverchanKey', 'customWebhook', 'customHeaders', 'proxyUrl', 'smtpPass'
];
function publicGlobal(g) {
  const out = { ...(g || {}) };
  for (const key of SECRET_GLOBAL_KEYS) {
    out[`${key}Configured`] = Boolean(out[key]);
    out[key] = '';
  }
  return redactValue(out);
}
function maskKey(k) {
  if (k.length <= 8) return k.slice(0, 2) + '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}
function publicState() {
  return redactValue({
    providers: db.providers.map(publicProvider),
    global: publicGlobal(db.global),
    running: scheduler.runningList(),
    schedule: scheduler.scheduleInfo(),
    paused: Boolean(scheduler.paused),
    dataFile: DATA_FILE,
    dataDir: DATA_DIR,
    logDir: logger.LOG_DIR,
    unread: { count: unreadAlerts.length, items: unreadAlerts.slice().reverse() },
    selfmon: { slowChecks: selfmon.slowChecks, queueWarns: selfmon.queueWarns, notifyHealth: getNotifyHealth(), circuits: scheduler.circuitInfo() }
  });
}
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- IPC 装配：handler 按域拆在 src/ipc/*，这里只注入共享上下文 ----------
const ctx = {
  getDb: () => db,
  replaceDb: (v) => { db = v; },
  persist, persistSoon,
  send, publicState,
  win: () => win,
  scheduler, logger, notifier, alerts, history,
  DATA_DIR, DATA_FILE,
  pkg,
  SECRET_GLOBAL_KEYS,
  applyLoginItem, registerHotkey, applyGlobalConfig,
  commitDetectionChanges: (ids) => {
    for (const id of ids) {
      alerts.resetState(id);
      const provider = db.providers.find((p) => p.id === id);
      if (provider) scheduler.refresh(provider);
    }
    if (ids.length) updateTrayStatus();
  },
  setHotkeyCapture: (active) => { hotkeyCaptureActive = Boolean(active); registerHotkey(); },
  updateTrayStatus,
  clearAllUnread: clearUnread,
  ackUnreadById,
  setPausedMain,
  isPaused: () => scheduler.paused
};
for (const m of ['providers', 'global', 'history', 'backup', 'transfer', 'misc']) {
  require(`./src/ipc/${m}`).register(ctx);
}
logger.subscribe((line) => send('log:line', line));

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
    icon: path.join(__dirname, 'assets', 'icon.ico'),   // assets/ 随 asar 打包；build/ 是构建资源目录会被排除
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
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
        { label: '检查更新', click: () => { if (appUpdater) appUpdater.check(true); } },
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
  win.on('blur', () => { if (hotkeyCaptureActive) { hotkeyCaptureActive = false; registerHotkey(); } });
  win.webContents.on('render-process-gone', () => { hotkeyCaptureActive = false; registerHotkey(); });
  // 未读告警必须由用户显式确认，窗口获得焦点不再自动清零。
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');   // 同上：构建资源 build/ 不进 asar
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
    tray.setToolTip('AI Provider Monitor');
    rebuildTrayMenu();
    tray.on('double-click', showMainWindow);
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
      setInterval(() => { if (!quitting) { void maybeDailyMail(); retryPendingAlerts(); void dailyMaintenance(); } }, 30000);
      // 自动更新：打包版 + 开关开启时，启动 30 秒后静默检查一次
      try {
        const { createUpdater } = require('./src/updater');
        appUpdater = createUpdater({ app, dialog });
        if (app.isPackaged && db.global.autoUpdateCheck !== false) {
          setTimeout(() => { if (appUpdater) appUpdater.check(false).catch(() => {}); }, 30000);
        }
      } catch (e) { logger.warn(`[更新] 初始化失败: ${e.message}`); }
      void dailyMaintenance();
      updateTrayStatus();
    });

    let quitFlushed = false, quitFlushing = false;
    app.on('before-quit', (event) => {
      quitting = true;
      if (quitFlushed) return;
      event.preventDefault();
      if (quitFlushing) return;
      quitFlushing = true; scheduler.stop(); flushPersistSoon();
      Promise.allSettled([...deliveryJobs]).then(() => { flushPersistSoon(); return history.flush(); }).catch((err) => logger.error(`历史收尾失败: ${err.message}`)).finally(() => {
        logger.flushSync(); globalShortcut.unregisterAll(); quitFlushed = true; app.quit();
      });
    });
    app.on('window-all-closed', (e) => { /* 保持后台运行，由托盘退出 */ });
  }
}

if (process.env.AIPM_INTEGRATION_TEST === '1') module.exports = { ctx, scheduler, publicState, applyResult, retryPendingAlerts, dailyMaintenance, flushPersistSoon };
