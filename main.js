'use strict';
const { app, BrowserWindow, ipcMain, Menu, Tray, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadAll, saveAll, DATA_DIR, DATA_FILE, DEFAULT_GLOBAL } = require('./src/store');
const logger = require('./src/logger');
const { Scheduler } = require('./src/scheduler');
const { notifyModelChange, sendTest } = require('./src/notifier');
const backup = require('./src/backup');
const transfer = require('./src/transfer');
const { formatDuration } = require('./src/durfmt');

let db = { global: { ...DEFAULT_GLOBAL }, providers: [] };
let win = null;
let tray = null;
let quitting = false;

const scheduler = new Scheduler({ concurrency: db.global.concurrency || 4 });

// ---------- 数据层 ----------
function persist() {
  try { saveAll(db); } catch (e) { logger.error(`保存数据失败: ${e.message}`); }
}

function load() {
  db = loadAll();
  scheduler.setConcurrency(db.global.concurrency || 4);
}

function snapshot(provider) {
  if (!provider) return null;
  return {
    status: provider.status || 'unknown',
    modelsTotal: provider.modelsTotal || 0,
    modelsAvailable: [...(provider.modelsAvailable || [])]
  };
}

function applyResult(provider, result, reason) {
  const prev = snapshot(provider);
  provider.status = result.status;
  provider.latency = result.latency;
  provider.modelsTotal = result.modelsTotal;
  provider.modelsAvailable = result.modelsAvailable || [];
  provider.modelsUnavailable = result.modelsUnavailable || [];
  provider.modelDetails = result.modelDetails || [];
  provider.checkedAt = result.checkedAt;
  provider.lastError = result.error || null;

  // 变动判定：状态 + 可用模型集合 + 模型总数 任一变化即视为变动
  const prevKey = prev ? `${prev.status}|${prev.modelsTotal}|${[...prev.modelsAvailable].sort().join(',')}` : null;
  const nextKey = `${result.status}|${result.modelsTotal}|${[...(result.modelsAvailable || [])].sort().join(',')}`;
  // 首次检测（此前从未成功检测过）：仅建立基准，不算变动、不推送
  const firstRealCheck = !prev || prev.status === 'unknown';
  const modelChanged = !firstRealCheck && prevKey !== nextKey;
  provider.modelChanged = modelChanged;

  // 变动详情日志：明确列出新增/失去与状态翻转
  if (firstRealCheck) {
    logger.info(`[变动] [${provider.name}] 首次检测，基准已建立: ${result.status}，可用 ${provider.modelsAvailable.length}/${result.modelsTotal}（不计变动、不推送）`);
  } else if (modelChanged) {
    const prevSet = new Set(prev.modelsAvailable);
    const nextSet = new Set(provider.modelsAvailable);
    const added = provider.modelsAvailable.filter((m) => !prevSet.has(m));
    const removed = prev.modelsAvailable.filter((m) => !nextSet.has(m));
    const parts = [];
    if (prev.status !== provider.status) parts.push(`状态翻转 ${statusText(prev.status)} → ${statusText(provider.status)}`);
    if (prev.modelsTotal !== result.modelsTotal) parts.push(`模型总数 ${prev.modelsTotal} → ${result.modelsTotal}`);
    if (added.length) parts.push(`新增可用 ${added.length} 个: ${added.join(', ')}`);
    if (removed.length) parts.push(`失去可用 ${removed.length} 个: ${removed.join(', ')}`);
    if (!added.length && !removed.length && prev.status === provider.status) parts.push('模型清单变化');
    logger.warn(`[变动] [${provider.name}] ${parts.join('；')}`);
  }

  logger.info(`检测完成 [${provider.name}] ${result.status} 可用 ${provider.modelsAvailable.length}/${result.modelsTotal} (来源:${reason})${modelChanged ? ' · 模型已变化' : ''}`);

  if (modelChanged && provider.notifyOnModelChange) {
    notifyModelChange(db.global, provider, prev, provider).catch((e) => logger.error(`通知失败: ${e.message}`));
  }
}

/** 状态中英文映射（日志与通知文案用） */
function statusText(s) {
  return { up: '在线', degraded: '异常', down: '离线', unknown: '待检测' }[s] || s;
}

scheduler.on('result', (provider, result, reason) => {
  applyResult(provider, result, reason);
  persist();
  send('state-changed', publicState());
});
scheduler.on('state', () => send('state-changed', publicState()));
scheduler.getProvider = (id) => db.providers.find((p) => p.id === id);

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
    logDir: logger.LOG_DIR
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
    enabled: true,
    status: 'unknown',
    modelsAvailable: [],
    modelsUnavailable: [],
    modelDetails: [],
    modelsTotal: 0,
    checkedAt: null,
    lastError: null
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
    note: String(data.note ?? p.note).trim()
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
  persist();
  logger.info(`删除 Provider [${p.name}]`);
  send('state-changed', publicState());
  return { ok: true };
});

ipcMain.handle('provider:deleteMany', (e, ids) => {
  const set = new Set((ids || []).map(Number));
  const removed = [];
  db.providers = db.providers.filter((p) => {
    if (set.has(p.id)) { removed.push(p); scheduler.cancel(p.id); return false; }
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
  for (const p of db.providers) scheduler.runCheck(p.id, { reason: 'manual' });
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
  }
  persist();
  send('state-changed', publicState());
  return { ok: true };
});

ipcMain.handle('global:set', (e, patch) => {
  db.global = { ...db.global, ...patch };
  scheduler.setConcurrency(db.global.concurrency || 4);
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

ipcMain.handle('open:path', (e, p) => { shell.openPath(p); return { ok: true }; });

ipcMain.handle('app:version', () => app.getVersion());

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
      // 无路径：写入数据目录并返回（供前端复制到剪贴板）
      const safe = `providers-${new Date().toISOString().slice(0, 10)}.${ext}`;
      const out = path.join(DATA_DIR, safe);
      fs.writeFileSync(out, content, 'utf8');
      return { ok: true, path: out, content };
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
    const known = new Set(res._knownIds || []);
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
        { label: '立即检测全部', accelerator: 'CmdOrCtrl+R', click: () => { for (const p of db.providers) scheduler.runCheck(p.id, { reason: 'manual' }); } },
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
    }
  ]));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.show(); });
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
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'build', 'icon.ico');
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
    tray.setToolTip('AI Provider Monitor');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主界面', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
      { label: '立即检测全部', click: () => { for (const p of db.providers) scheduler.runCheck(p.id, { reason: 'manual' }); } },
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
      // 每日自动备份（保留最近 10 份）
      const f = backup.autoBackup({ global: db.global, providers: db.providers }, DATA_DIR, { keep: 10 });
      if (f) logger.info(`[备份] 已生成每日自动备份: ${path.basename(f)}`);
    });

    app.on('before-quit', () => { quitting = true; scheduler.stop(); });
    app.on('window-all-closed', (e) => { /* 保持后台运行，由托盘退出 */ });
  }
}
