'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG_DIR = process.env.AIPM_DATA_DIR
  ? path.join(process.env.AIPM_DATA_DIR, 'logs')
  : path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'ai-provider-monitor', 'logs');

const MAX_IN_MEMORY = 600;
const buffer = [];
const subscribers = new Set();

// 轮转策略（可由主进程通过 configure() 覆盖）
let keepDays = 7;           // 保留最近 N 天的日志文件
let maxFileBytes = 10 * 1024 * 1024;  // 单文件上限，超过则切分后缀 .1 .2
let minLevel = 'debug';     // 低于该级别的日志不落盘/不广播

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function dayTag(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

let fileStream = null;
let streamDay = null;
let streamPath = null;

function baseFileFor(day) { return path.join(LOG_DIR, `aipm-${day}.log`); }

function closeStream() {
  if (fileStream) { try { fileStream.end(); } catch (e) { /* ignore */ } }
  fileStream = null;
  streamPath = null;
}

/** 单文件超限时切成 aipm-YYYYMMDD.log.1 / .2 … */
function rotateBySize(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < maxFileBytes) return false;
    let n = 1;
    while (fs.existsSync(`${file}.${n}`)) n++;
    fs.renameSync(file, `${file}.${n}`);
    return true;
  } catch (e) { return false; }
}

/** 删除超过保留天数的日志文件（含 .N 分卷） */
function pruneOldLogs() {
  try {
    const cutoff = dayTag(new Date(Date.now() - keepDays * 86400 * 1000));
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = /^aipm-(\d{8})\.log(?:\.\d+)?$/.exec(f);
      if (m && m[1] < cutoff) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
}

function ensureStream() {
  const today = dayTag();
  // 跨天：关闭旧流、清理过期文件
  if (fileStream && streamDay !== today) {
    closeStream();
    pruneOldLogs();
  }
  if (fileStream) {
    // 体积超限则切分并重开
    if (streamPath && rotateBySize(streamPath)) closeStream();
    else return fileStream;
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = baseFileFor(today);
    rotateBySize(file);
    fileStream = fs.createWriteStream(file, { flags: 'a' });
    streamDay = today;
    streamPath = file;
    pruneOldLogs();
  } catch (e) { fileStream = null; }
  return fileStream;
}

function write(level, msg) {
  if ((LEVELS[level] || 0) < (LEVELS[minLevel] || 0)) return;
  const line = { t: stamp(), level, msg: String(msg) };
  buffer.push(line);
  if (buffer.length > MAX_IN_MEMORY) buffer.shift();
  const s = ensureStream();
  if (s) { try { s.write(`[${line.t}] [${level.toUpperCase()}] ${line.msg}\n`); } catch (e) { /* ignore */ } }
  for (const fn of subscribers) { try { fn(line); } catch (e) { /* ignore */ } }
}

/** 由主进程在配置变更时调用 */
function configure({ logKeepDays, logMaxFileMB, logLevel } = {}) {
  if (Number(logKeepDays) > 0) keepDays = Math.min(365, Math.floor(Number(logKeepDays)));
  if (Number(logMaxFileMB) > 0) maxFileBytes = Math.floor(Number(logMaxFileMB) * 1024 * 1024);
  if (logLevel && LEVELS[logLevel]) minLevel = logLevel;
  pruneOldLogs();
  return { keepDays, maxFileMB: maxFileBytes / 1024 / 1024, level: minLevel };
}

/** 列出磁盘日志文件（新→旧） */
function listFiles() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((f) => /^aipm-\d{8}\.log(\.\d+)?$/.test(f))
      .map((f) => {
        const full = path.join(LOG_DIR, f);
        let size = 0, mtime = 0;
        try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) { /* ignore */ }
        return { file: f, path: full, size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}

module.exports = {
  info: (m) => write('info', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),
  debug: (m) => write('debug', m),
  recent: () => buffer.slice(),
  clear() { buffer.length = 0; },
  subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  configure,
  listFiles,
  pruneOldLogs,
  LOG_DIR
};
