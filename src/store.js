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
  notifyDingtalkEnabled: false,
  dingtalkWebhook: '',
  dingtalkSecret: '',
  autoStartCheckOnLaunch: true,
  concurrency: 4
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
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { DATA_DIR, DATA_FILE, DEFAULT_GLOBAL, loadAll, saveAll, ensureDir };
