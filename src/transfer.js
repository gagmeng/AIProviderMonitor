'use strict';
const logger = require('./logger');

/**
 * 服务商批量导入/导出模块
 *
 * 支持三种格式：
 * - json : 备份式结构（providers 数组，字段完整），导入可直接还原 apiKey 等全部字段
 * - csv  : 表头行 + 数据行，逗号分隔（RFC 4180 基本转义），字段：name,url,apiKey,intervalSec,notifyOnModelChange,note
 * - text : 纯文本行，分隔符可选（Tab / 逗号 / 竖线 / 分号），每行一个服务商：
 *          名称 <sep> URL <sep> APIKey <sep> 周期秒 <sep> 上报(1/0/true/false) <sep> 备注
 *          URL 与后续字段可省略（仅有名称时 URL 需在导入时补填或留空拒绝）
 */

const TEXT_DELIMITERS = {
  tab: '\t',
  comma: ',',
  pipe: '|',
  semicolon: ';'
};

function sanitize(p) {
  return {
    id: Number(p.id) || Date.now() + Math.floor(Math.random() * 1000),
    name: String(p.name || '').trim(),
    url: String(p.url || '').trim().replace(/\/+$/, ''),
    apiKey: String(p.apiKey || ''),
    intervalSec: Math.max(5, Number(p.intervalSec) || 60),
    notifyOnModelChange: p.notifyOnModelChange === true || p.notifyOnModelChange === 1 || /^(1|true|yes|是|y)$/i.test(String(p.notifyOnModelChange)),
    note: String(p.note || ''),
    enabled: p.enabled !== false,
    status: 'unknown',
    modelsTotal: 0,
    modelsAvailable: [],
    modelsUnavailable: [],
    modelDetails: [],
    checkedAt: null,
    lastError: null,
    modelChanged: false
  };
}

// ---------- 导出 ----------

function toJSON(providers) {
  return JSON.stringify(providers.map((p) => ({
    name: p.name, url: p.url, apiKey: p.apiKey || '', intervalSec: p.intervalSec,
    notifyOnModelChange: Boolean(p.notifyOnModelChange), note: p.note || ''
  })), null, 2);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(providers) {
  const head = ['name', 'url', 'apiKey', 'intervalSec', 'notifyOnModelChange', 'note'];
  const rows = providers.map((p) => [p.name, p.url, p.apiKey || '', p.intervalSec, p.notifyOnModelChange ? 1 : 0, p.note || ''].map(csvEscape).join(','));
  return [head.join(','), ...rows].join('\r\n');
}

function toText(providers, delimiter = 'tab') {
  const sep = TEXT_DELIMITERS[delimiter] || '\t';
  return providers.map((p) => [p.name, p.url, p.apiKey || '', p.intervalSec, p.notifyOnModelChange ? 1 : 0, p.note || ''].join(sep)).join('\n');
}

/**
 * 导出为字符串。
 * opts: { format: 'json'|'csv'|'text', delimiter?: 'tab'|'comma'|'pipe'|'semicolon', withKey?: boolean }
 */
function exportProviders(providers, opts = {}) {
  const list = (providers || []).map((p) => (opts.withKey === false ? { ...p, apiKey: '' } : p));
  let content;
  if (opts.format === 'csv') content = toCSV(list);
  else if (opts.format === 'text') content = toText(list, opts.delimiter);
  else content = toJSON(list);
  logger.info(`[导入导出] 导出 ${list.length} 个服务商（${opts.format}${opts.format === 'text' ? '/' + (opts.delimiter || 'tab') : ''}）`);
  return content;
}

// ---------- 导入解析（返回解析结果供预览，不直接入库） ----------

function parseCSVLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function boolVal(v) {
  return v === true || v === 1 || /^(1|true|yes|是|y)$/i.test(String(v ?? '').trim());
}

/** 从 JSON 文本解析 */
function fromJSON(text) {
  const j = JSON.parse(text);
  const arr = Array.isArray(j) ? j : (Array.isArray(j.providers) ? j.providers : null);
  if (!arr) throw new Error('JSON 中未找到服务商数组（需要数组或 { providers: [...] }）');
  return arr;
}

/** 从 CSV 文本解析（表头映射，兼容中英文表头） */
function fromCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('CSV 至少需要表头行和一行数据');
  const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (names) => header.findIndex((h) => names.includes(h));
  const iName = idx(['name', '名称', '服务商', '供应商']);
  const iUrl = idx(['url', '地址', '链接']);
  const iKey = idx(['apikey', 'api key', 'api_key', '密钥', 'key']);
  const iInt = idx(['intervalsec', 'interval', '周期', '轮循周期']);
  const iNotify = idx(['notifyonmodelchange', 'notify', '上报', '变动上报']);
  const iNote = idx(['note', '备注', '说明']);
  if (iName < 0) throw new Error('CSV 缺少 name/名称 列');
  return lines.slice(1).map((line) => {
    const cols = parseCSVLine(line);
    const item = {};
    if (iName >= 0) item.name = cols[iName];
    if (iUrl >= 0) item.url = cols[iUrl];
    if (iKey >= 0) item.apiKey = cols[iKey];
    if (iInt >= 0) item.intervalSec = Number(cols[iInt]) || 60;
    if (iNotify >= 0) item.notifyOnModelChange = boolVal(cols[iNotify]);
    if (iNote >= 0) item.note = cols[iNote];
    return item;
  });
}

/** 从纯文本解析（可配分隔符；URL 之后的字段均可省略） */
function fromText(text, delimiter = 'tab') {
  const sep = TEXT_DELIMITERS[delimiter];
  if (!sep) throw new Error(`不支持的分隔符: ${delimiter}`);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.map((line) => {
    const cols = line.split(sep).map((c) => c.trim());
    const item = { name: cols[0] || '' };
    if (cols.length > 1) item.url = cols[1];
    if (cols.length > 2) item.apiKey = cols[2];
    if (cols.length > 3) item.intervalSec = Number(cols[3]) || 60;
    if (cols.length > 4) item.notifyOnModelChange = boolVal(cols[4]);
    if (cols.length > 5) item.note = cols.slice(5).join(sep);
    return item;
  });
}

/**
 * 解析导入文本 → 规范化条目列表（含逐行错误）。
 * 返回 { items: [...], errors: [{ line, msg }] }，items 为可入库的规范条目。
 */
function parseImport(text, opts = {}) {
  const format = opts.format || 'json';
  let raws = [];
  try {
    if (format === 'csv') raws = fromCSV(text);
    else if (format === 'text') raws = fromText(text, opts.delimiter);
    else raws = fromJSON(text);
  } catch (e) {
    return { items: [], errors: [{ line: 0, msg: e.message }] };
  }

  const items = [];
  const errors = [];
  raws.forEach((r, i) => {
    const lineNo = i + 1;
    const name = String(r.name || '').trim();
    const url = String(r.url || '').trim();
    if (!name && !url) { errors.push({ line: lineNo, msg: '名称与 URL 均为空，已跳过' }); return; }
    if (!name) { errors.push({ line: lineNo, msg: '缺少名称，已跳过' }); return; }
    if (!url) { errors.push({ line: lineNo, msg: `「${name}」缺少 URL，已跳过` }); return; }
    if (!/^https?:\/\//i.test(url) && !/^[\w.-]+:\d+/.test(url)) {
      // 允许 host:port 简写，导入时补 http://
    }
    const item = sanitize({ ...r, name, url: /^https?:\/\//i.test(url) ? url : `http://${url}` });
    items.push(item);
  });
  logger.info(`[导入导出] 解析导入文本（${format}${format === 'text' ? '/' + (opts.delimiter || 'tab') : ''}）：${items.length} 条有效，${errors.length} 条问题`);
  return { items, errors };
}

/**
 * 将解析出的条目合并进当前列表。
 * mode='merge'：按 URL 去重（已存在更新配置，不存在新增）；mode='append'：全部新增（URL 重复也追加）。
 * 返回 { added, updated, skipped }
 */
function applyImport(db, items, mode = 'merge') {
  let added = 0, updated = 0, skipped = 0;
  const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  if (mode === 'append') {
    for (const it of items) {
      // 无法识别的空 URL 不入库，计为跳过
      if (!norm(it.url)) { skipped++; continue; }
      db.providers.push(sanitize({ ...it, id: undefined }));
      added++;
    }
  } else {
    const urlIndex = new Map(db.providers.map((p) => [norm(p.url), p]));
    for (const it of items) {
      const key = norm(it.url);
      if (!key) { skipped++; continue; }
      const exist = urlIndex.get(key);
      if (exist) {
        const next = {
          name: it.name || exist.name,
          // 导入条目未带密钥时保留原密钥
          apiKey: it.apiKey ? it.apiKey : exist.apiKey,
          intervalSec: it.intervalSec || exist.intervalSec,
          notifyOnModelChange: it.notifyOnModelChange,
          note: it.note ?? exist.note,
          // URL 存储格式归一（去尾部斜杠），与导入条目一致
          url: key
        };
        // 与现有记录逐字段一致 => 记为跳过，避免「更新数」虚高
        if (!Object.keys(next).some((k) => exist[k] !== next[k])) { skipped++; continue; }
        Object.assign(exist, next);
        updated++;
      } else {
        const p = sanitize({ ...it, id: undefined });
        db.providers.push(p);
        urlIndex.set(key, p);
        added++;
      }
    }
  }
  logger.info(`[导入导出] 导入完成（${mode}）：新增 ${added}，更新 ${updated}，跳过 ${skipped}`);
  return { added, updated, skipped };
}

module.exports = { exportProviders, parseImport, applyImport, TEXT_DELIMITERS };
