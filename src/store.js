'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AIPM_DATA_DIR
  || (process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'AIPM-Data')
    : path.join(process.env.APPDATA || path.join(require('os').homedir(), '.config'), 'ai-provider-monitor'));

const DATA_FILE = path.join(DATA_DIR, 'providers.json');

const DEFAULT_GLOBAL = {
  notifyWeixinEnabled: false,
  weixinWebhook: '',
  notifyQQEnabled: false,
  qqWebhook: '',
  qqTarget: '',
  qqTargetType: 'private',
  qqToken: '',
  notifyDingtalkEnabled: false,
  dingtalkWebhook: '',
  dingtalkSecret: '',
  // --- 扩展通知渠道 ---
  notifyTelegramEnabled: false,
  telegramToken: '',
  telegramChatId: '',
  telegramApiBase: 'https://api.telegram.org',
  notifyFeishuEnabled: false,
  feishuWebhook: '',
  feishuSecret: '',
  notifySlackEnabled: false,
  slackWebhook: '',
  notifyServerChanEnabled: false,
  serverchanKey: '',
  notifyCustomEnabled: false,
  customWebhook: '',
  customTemplate: '',
  customHeaders: '',
  // --- 告警策略 ---
  alertFailThreshold: 2,
  alertRecoverNotify: true,
  alertCooldownMin: 10,
  alertQuietEnabled: false,
  alertQuietStart: '23:00',
  alertQuietEnd: '07:00',
  alertOnModelChange: true,
  // --- 检测参数 ---
  probeLimit: 8,
  requestTimeoutMs: 20000,
  probeTimeoutMs: 15000,
  retries: 1,
  // --- 代理 ---
  proxyEnabled: false,
  proxyUrl: '',
  // --- 历史与日志 ---
  historyEnabled: true,
  historyKeepDays: 30,
  logKeepDays: 7,
  logMaxFileMB: 10,
  logLevel: 'info',
  // --- 外观与启动 ---
  theme: 'system',
  launchAtLogin: false,
  launchMinimized: false,
  autoStartCheckOnLaunch: true,
  concurrency: 4,
  closeAction: 'tray'   // 'tray'：点关闭隐藏到托盘；'exit'：点关闭直接退出
};

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function loadAll() {
  ensureDir();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const g = Object.assign({}, DEFAULT_GLOBAL, raw.global || {});
    const list = Array.isArray(raw.providers) ? raw.providers : [];
    return { global: g, providers: list };
  } catch (e) {
    return { global: { ...DEFAULT_GLOBAL }, providers: [] };
  }
}

function saveAll(data) {
  ensureDir();
  // 原子写入：先写同目录临时文件再 rename，避免写入中途崩溃导致 providers.json 截断损坏
  const tmp = `${DATA_FILE}.tmp-${process.pid}`;
  const text = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    throw e;
  }
}

module.exports = { DATA_DIR, DATA_FILE, DEFAULT_GLOBAL, loadAll, saveAll, ensureDir };
