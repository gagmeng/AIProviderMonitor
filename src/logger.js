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

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

let fileStream = null;
function ensureStream() {
  if (fileStream) return fileStream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const file = path.join(LOG_DIR, `aipm-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`);
    fileStream = fs.createWriteStream(file, { flags: 'a' });
  } catch (e) { fileStream = null; }
  return fileStream;
}

function write(level, msg) {
  const line = { t: stamp(), level, msg: String(msg) };
  buffer.push(line);
  if (buffer.length > MAX_IN_MEMORY) buffer.shift();
  const s = ensureStream();
  if (s) { try { s.write(`[${line.t}] [${level.toUpperCase()}] ${line.msg}\n`); } catch (e) { /* ignore */ } }
  for (const fn of subscribers) { try { fn(line); } catch (e) { /* ignore */ } }
}

module.exports = {
  info: (m) => write('info', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),
  debug: (m) => write('debug', m),
  recent: () => buffer.slice(),
  subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  LOG_DIR
};
