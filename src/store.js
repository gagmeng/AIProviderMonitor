'use strict';
const fs = require('fs');
const path = require('path');
// 注意：这里不能 require logger——logger 顶层从本模块取 DATA_DIR，会形成循环依赖。
// 加载告警通过 loadAll() 返回值里的 warnings 交给 main.js 记日志。
const { ensureUniqueProviderIds, normalizeProvider, validateProviderConfig } = require('./providerSchema');

const DATA_DIR = process.env.AIPM_DATA_DIR
  || (process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'AIPM-Data')
    : path.join(process.env.APPDATA || path.join(require('os').homedir(), '.config'), 'ai-provider-monitor'));

const DATA_FILE = path.join(DATA_DIR, 'providers.json');
const CURRENT_CONFIG_VERSION = 2;
const LEGACY_DEFAULT_PROBE_LIMIT = 8;

const DEFAULT_GLOBAL = {
  configVersion: CURRENT_CONFIG_VERSION,
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
  // 故障升级提醒：故障持续 N 分钟仍未恢复时重复推送，0 = 关闭
  alertEscalateMin: 0,
  // 延迟劣化告警：连接延迟连续 N 轮超过阈值时推送
  latencyAlertEnabled: false,
  latencyAlertMs: 5000,
  latencyAlertConsecutive: 3,
  // --- 检测参数 ---
  probeLimit: 20,
  requestTimeoutMs: 20000,
  probeTimeoutMs: 15000,
  retries: 1,
  circuitFailThreshold: 5,
  circuitOpenSec: 300,
  // --- 代理 ---
  proxyEnabled: false,
  proxyUrl: '',
  // --- 历史与日志 ---
  historyEnabled: true,
  historyKeepDays: 90,
  sloTarget: 99.9,
  sloWindowDays: 30,
  onboardingDismissed: false,
  logKeepDays: 7,
  logMaxFileMB: 10,
  logLevel: 'info',
  // --- 外观与启动 ---
  theme: 'system',
  launchAtLogin: false,
  launchMinimized: false,
  autoStartCheckOnLaunch: true,
  concurrency: 4,
  closeAction: 'tray',  // 'tray'：点关闭隐藏到托盘；'exit'：点关闭直接退出
  // --- 界面语言 ---
  lang: 'zh',   // 'zh' | 'en'
  // --- 探测并发与轮询 ---
  probeConcurrency: 8,
  probeJitterMs: 120,
  probeRotate: true,
  // --- TLS ---
  insecureSkipVerify: false,
  // --- 全局代理（通知发送 + 无独立代理的服务商检测） ---
  // --- 自动更新 / 托盘 / 快捷键 ---
  autoUpdateCheck: true,
  trayBalloonEnabled: true,
  hotkeyEnabled: true,
  hotkey: 'CommandOrCtrl+Alt+M',
  // --- 邮件日报 ---
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: '',
  smtpPass: '',
  mailFrom: '',
  mailTo: '',
  dailyReportEnabled: false,
  dailyReportTime: '08:00',
  // 日报「今日已发」标记：必须在已知键白名单里，否则 normalizeGlobal 会把它剥离，
  // 导致同一天保存任意设置后日报重复发送（main.js maybeDailyMail 依赖该键）
  lastReportDay: '',
  // 邮件证书校验与探测分开，避免一个开关关掉两边的 TLS 校验
  smtpInsecureSkipVerify: false,
  // --- 自监控 ---
  selfmonSlowMs: 60000,
  selfmonQueueWarn: 20,
  // --- 单模型历史 ---
  modelHistoryEnabled: true
};

// 全局配置归一化：数值钳位、时间格式校验、布尔宽容解析。
// 主进程唯一入口——load / global:set / 备份还原 都经过这里，手改配置文件或
// 还原外部备份时不可能再把越界值或乱格式时间写进 providers.json。
const NUM_RANGES = {
  concurrency: [1, 16, 4],
  probeLimit: [1, 1000, 20],
  requestTimeoutMs: [1000, 600000, 20000],
  probeTimeoutMs: [1000, 600000, 15000],
  retries: [0, 5, 1],
  probeConcurrency: [1, 16, 8],
  probeJitterMs: [0, 60000, 120],
  circuitFailThreshold: [2, 1000, 5],
  circuitOpenSec: [30, 86400, 300],
  alertFailThreshold: [1, 100, 2],
  alertCooldownMin: [0, 10080, 10],
  alertEscalateMin: [0, 10080, 0],
  latencyAlertMs: [100, 3600000, 5000],
  latencyAlertConsecutive: [1, 100, 3],
  smtpPort: [1, 65535, 465],
  historyKeepDays: [1, 365, 90],
  sloWindowDays: [1, 90, 30],
  logKeepDays: [1, 365, 7],
  logMaxFileMB: [1, 500, 10],
  selfmonSlowMs: [0, 3600000, 60000],
  selfmonQueueWarn: [0, 100000, 20]
};
const TIME_FIELDS = { alertQuietStart: '23:00', alertQuietEnd: '07:00', dailyReportTime: '08:00' };
const HM_RE = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
const BOOL_FIELDS = [
  'notifyWeixinEnabled', 'notifyQQEnabled', 'notifyDingtalkEnabled', 'notifyTelegramEnabled',
  'notifyFeishuEnabled', 'notifySlackEnabled', 'notifyServerChanEnabled', 'notifyCustomEnabled',
  'alertRecoverNotify', 'alertOnModelChange', 'alertQuietEnabled', 'proxyEnabled',
  'historyEnabled', 'modelHistoryEnabled', 'launchAtLogin', 'launchMinimized',
  'autoStartCheckOnLaunch', 'probeRotate', 'insecureSkipVerify', 'autoUpdateCheck',
  'trayBalloonEnabled', 'hotkeyEnabled', 'dailyReportEnabled', 'smtpSecure', 'smtpInsecureSkipVerify',
  'latencyAlertEnabled', 'onboardingDismissed'
];
const ENUM_FIELDS = {
  theme: ['system', 'light', 'dark'],
  closeAction: ['tray', 'exit'],
  qqTargetType: ['private', 'group'],
  lang: ['zh', 'en'],
  logLevel: ['debug', 'info', 'warn', 'error']
};

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return dflt;
}

function normalizeGlobal(rawGlobal = {}) {
  const source = rawGlobal && typeof rawGlobal === 'object' ? rawGlobal : {};
  // 只接受已知键：外部文件（备份/手改）里的未知键一律丢弃，防止垃圾字段永久滞留
  const picked = {};
  for (const k of Object.keys(DEFAULT_GLOBAL)) {
    if (k in source) picked[k] = source[k];
  }
  const g = Object.assign({}, DEFAULT_GLOBAL, picked);

  // 旧版本的全局默认探测上限是 8。升级到当前配置版本时，
  // 将未迁移配置里的旧默认值自动提升为新的默认值 20。
  const sourceVersion = Number(source.configVersion || 0);
  if (sourceVersion < CURRENT_CONFIG_VERSION && Number(source.probeLimit) === LEGACY_DEFAULT_PROBE_LIMIT) {
    g.probeLimit = DEFAULT_GLOBAL.probeLimit;
  }

  for (const k of BOOL_FIELDS) g[k] = toBool(g[k], DEFAULT_GLOBAL[k]);
  for (const [k, [min, max, dflt]] of Object.entries(NUM_RANGES)) {
    const n = Number(g[k]);
    g[k] = Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : dflt;
  }
  for (const [k, dflt] of Object.entries(TIME_FIELDS)) {
    let v = typeof g[k] === 'string' ? g[k].trim() : '';
    if (HM_RE.test(v)) {
      // 补零成两位 HH:MM：maybeDailyMail 用字符串比较判断发送时刻，
      // '9:05' >= '08:00' 恒真会让日报在任何时刻都触发补发
      const [h, m] = v.split(':');
      v = `${h.padStart(2, '0')}:${m}`;
    } else {
      v = dflt;
    }
    g[k] = v;
  }
  for (const [k, allowed] of Object.entries(ENUM_FIELDS)) {
    if (!allowed.includes(g[k])) g[k] = DEFAULT_GLOBAL[k];
  }
  // 日报标记只接受 YYYY-MM-DD，其余（含外部篡改的乱值）一律清空，宁可多发一次也不永久漏发
  g.lastReportDay = /^\d{4}-\d{2}-\d{2}$/.test(String(g.lastReportDay || '')) ? String(g.lastReportDay) : '';
  g.sloTarget = Number.isFinite(Number(g.sloTarget)) ? Math.min(100, Math.max(90, Number(g.sloTarget))) : 99.9;
  g.configVersion = CURRENT_CONFIG_VERSION;
  return g;
}

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) {
    return { global: normalizeGlobal(), providers: [] };
  }
  let text;
  try {
    text = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (e) {
    const err = new Error(`读取配置失败，已停止加载以免稍后用空配置覆盖原文件: ${e.message}`);
    err.code = 'CONFIG_READ_FAILED';
    throw err;
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('根节点不是对象');
    }
    const g = normalizeGlobal(raw.global);
    const list = ensureUniqueProviderIds((Array.isArray(raw.providers) ? raw.providers : []).filter((p) => p && typeof p === 'object' && !Array.isArray(p)));
    // 手改文件可能带来坏正则 / 坏 URL：逐条校验（校验用归一化副本，不改写已保存的运行态），
    // 非法条目停用而不是丢弃——保留用户数据，同时防止 detector 每轮在 filterIgnoredModels
    // 里抛异常导致该服务商状态永久卡在旧值。
    const warnings = [];
    for (const p of list) {
      try {
        validateProviderConfig(normalizeProvider(p));
      } catch (e) {
        p.enabled = false;
        warnings.push(`「${p.name || `#${p.id}`}」配置校验失败，已停用：${e.message}`);
      }
    }
    return { global: g, providers: list, warnings };
  } catch (e) {
    const bad = `${DATA_FILE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(DATA_FILE, bad); } catch (e2) { /* 副本失败也不改原文件 */ }
    const err = new Error(`配置文件损坏（${e.message}）。原文件未改动${fs.existsSync(bad) ? `，副本: ${bad}` : ''}。在修复前禁止以空配置覆盖。`);
    err.code = 'CONFIG_PARSE_FAILED';
    throw err;
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

module.exports = { DATA_DIR, DATA_FILE, DEFAULT_GLOBAL, loadAll, saveAll, ensureDir, normalizeGlobal };
