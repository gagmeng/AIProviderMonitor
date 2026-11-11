'use strict';
const logger = require('./logger');
const { normalizeProvider, mergeProvider, normalizeUrlKey, validateProviderConfig, ensureUniqueProviderIds } = require('./providerSchema');
const { URL_FIELDS, redactUrl, redactValue } = require('./redact');

/**
 * 服务商批量导入/导出模块
 *
 * 支持三种格式：
 * - json : 备份式结构（providers 数组，字段完整），导入可直接还原 apiKey 等全部字段
 * - csv  : 表头行 + 数据行，逗号分隔（RFC 4180 基本转义 + 公式注入防护），字段：name,url,apiKey,intervalSec,notifyOnModelChange,note,group,tags,probeMode,probeLimit,proxyUrl,useProxy
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

// 条目归一/合并已收敛到 providerSchema（与备份还原共用同一实现）

// ---------- 导出 ----------

function toJSON(providers) {
  return JSON.stringify(providers.map((p) => ({
    name: p.name, url: p.url, apiKey: p.apiKey || '', intervalSec: p.intervalSec,
    notifyOnModelChange: Boolean(p.notifyOnModelChange), note: p.note || '',
    group: p.group || '', tags: p.tags || [], enabled: p.enabled !== false,
    probeMode: p.probeMode || 'chat', probePolicy: p.probePolicy || 'strict', sloTarget: p.sloTarget ?? null, probePath: p.probePath || '', probeBody: p.probeBody || '',
    modelsPath: p.modelsPath || '/v1/models', authType: p.authType || 'bearer', authHeader: p.authHeader || '', authPrefix: p.authPrefix || '',
    customHeaders: p.customHeaders || '', capabilityModes: p.capabilityModes || [], assertType: p.assertType || 'none', assertValue: p.assertValue || '',
    modelIgnorePattern: p.modelIgnorePattern || '', quotaPath: p.quotaPath || '', quotaValuePath: p.quotaValuePath || 'remaining', quotaWarnBelow: p.quotaWarnBelow ?? null, measureStreaming: Boolean(p.measureStreaming),
    notifyChannels: p.notifyChannels || [], maintWeekdays: p.maintWeekdays || [], maintDates: p.maintDates || '',
    probeLimit: p.probeLimit ?? null, proxyUrl: p.proxyUrl || '', useProxy: p.useProxy !== false,
    maintEnabled: Boolean(p.maintEnabled), maintStart: p.maintStart || '02:00', maintEnd: p.maintEnd || '04:00',
    insecureSkipVerify: p.insecureSkipVerify === true ? true : p.insecureSkipVerify === false ? false : null
  })), null, 2);
}

function csvEscape(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = '\t' + s;   // 公式注入防护：Excel/Sheets 打开 CSV 时不执行公式
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(providers) {
  const head = ['name', 'url', 'apiKey', 'intervalSec', 'notifyOnModelChange', 'note', 'group', 'tags', 'probeMode', 'probeLimit', 'proxyUrl', 'useProxy'];
  const rows = providers.map((p) => [p.name, p.url, p.apiKey || '', p.intervalSec, p.notifyOnModelChange ? 1 : 0, p.note || '',
    p.group || '', (p.tags || []).join(';'), p.probeMode || '', p.probeLimit ?? '', p.proxyUrl || '', p.useProxy !== false ? 1 : 0].map(csvEscape).join(','));
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
  const list = (providers || []).map((p) => {
    if (opts.withKey === true) return p;
    const out = redactValue({ ...p, apiKey: '', customHeaders: '', proxyUrl: '' });
    for (const key of URL_FIELDS) if (p[key] !== undefined) out[key] = redactUrl(p[key], { remove: true });
    return out;
  });
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
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.providers) ? j.providers : null);
  if (!arr) throw new Error('JSON 中未找到服务商数组（需要数组或 { providers: [...] }）');
  return arr;
}

/** 从 CSV 文本解析（表头映射，兼容中英文表头） */
function splitCSVRecords(text) {
  const rows = []; let row = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { row += '""'; i++; continue; }
      quoted = !quoted;
    }
    if ((c === '\n' || c === '\r') && !quoted) {
      if (row.trim()) rows.push(row);
      row = ''; if (c === '\r' && text[i + 1] === '\n') i++;
    } else row += c;
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  if (row.trim()) rows.push(row);
  return rows;
}

function fromCSV(text) {
  const lines = splitCSVRecords(text.replace(/^\uFEFF/, ''));
  if (lines.length < 2) throw new Error('CSV 至少需要表头行和一行数据');
  const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (names) => header.findIndex((h) => names.includes(h));
  const iName = idx(['name', '名称', '服务商', '供应商']);
  const iUrl = idx(['url', '地址', '链接']);
  const iKey = idx(['apikey', 'api key', 'api_key', '密钥', 'key']);
  const iInt = idx(['intervalsec', 'interval', '周期', '轮循周期']);
  const iNotify = idx(['notifyonmodelchange', 'notify', '上报', '变动上报']);
  const iNote = idx(['note', '备注', '说明']);
  const iGroup = idx(['group', '分组']);
  const iTags = idx(['tags', '标签']);
  const iProbeMode = idx(['probemode', 'probe_mode', '探测模式']);
  const iProbeLimit = idx(['probelimit', '探测上限']);
  const iProxyUrl = idx(['proxyurl', 'proxy', '代理']);
  const iUseProxy = idx(['useproxy', '使用代理']);
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
    if (iGroup >= 0) item.group = cols[iGroup] || '';
    if (iTags >= 0) item.tags = String(cols[iTags] || '').split(';').map((s) => s.trim()).filter(Boolean);
    if (iProbeMode >= 0 && cols[iProbeMode]) item.probeMode = cols[iProbeMode];
    if (iProbeLimit >= 0 && cols[iProbeLimit] !== undefined && cols[iProbeLimit] !== '') item.probeLimit = Number(cols[iProbeLimit]) || null;
    if (iProxyUrl >= 0) item.proxyUrl = cols[iProxyUrl] || '';
    if (iUseProxy >= 0 && cols[iUseProxy] !== undefined && cols[iUseProxy] !== '') item.useProxy = boolVal(cols[iUseProxy]);
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
    if (!r || typeof r !== 'object') { errors.push({ line: lineNo, msg: '条目必须是对象' }); return; }
    const name = String(r.name || '').trim();
    const url = String(r.url || '').trim();
    if (!name && !url) { errors.push({ line: lineNo, msg: '名称与 URL 均为空，已跳过' }); return; }
    if (!name) { errors.push({ line: lineNo, msg: '缺少名称，已跳过' }); return; }
    if (!url) { errors.push({ line: lineNo, msg: `「${name}」缺少 URL，已跳过` }); return; }
    // host:port 简写补 http://；已带协议的按原样交给校验（file:/ws: 等会被拒绝而不是被改写）
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    const item = normalizeProvider({ ...r, name, url: hasScheme ? url : `http://${url}` });
    // 导入与手工新增走同一套校验：非法 URL/正则/周期在这里拦下并在预览中标出行号，
    // 否则坏正则会在运行时让 detector 误报「离线：Invalid regular expression」
    try {
      validateProviderConfig(item);
      const patch = {};
      for (const key of Object.keys(r)) if (Object.hasOwn(item, key)) patch[key] = item[key];
      patch.name = item.name; patch.url = item.url;
      items.push(patch);
    } catch (e) {
      errors.push({ line: lineNo, msg: `「${name}」校验失败：${e.message}` });
    }
  });
  logger.info(`[导入导出] 解析导入文本（${format}${format === 'text' ? '/' + (opts.delimiter || 'tab') : ''}）：${items.length} 条有效，${errors.length} 条问题`);
  return { items, errors };
}

/**
 * 将解析出的条目合并进当前列表。
 * mode='merge'：按 URL 去重（已存在更新配置，不存在新增）；mode='append'：全部新增（URL 重复也追加）。
 * 入库前对每条重新校验（防渲染层绕过 parseImport 直传）；校验失败计入 invalid 不入库。
 * 返回 { added, updated, skipped, invalid }
 */
function applyImport(db, items, mode = 'merge') {
  let added = 0, updated = 0, skipped = 0, invalid = 0;
  const norm = normalizeUrlKey;
  if (mode === 'append') {
    for (const it of items) {
      // 无法识别的空 URL 不入库，计为跳过
      if (!norm(it.url)) { skipped++; continue; }
      const p = normalizeProvider({ ...it, id: undefined });
      // 先归一（补默认值）再校验；校验失败丢弃，防止坏正则/坏 URL 混进轮循
      try { validateProviderConfig(p); } catch (e) { invalid++; continue; }
      db.providers.push(p);
      added++;
    }
  } else {
    const urlIndex = new Map(db.providers.map((p) => [norm(p.url), p]));
    for (const it of items) {
      const key = norm(it.url);
      if (!key) { skipped++; continue; }
      // 校验用归一化后的副本（默认值补齐后才有可比的周期/路径），
      // 但合并仍用原始条目，避免 normalize 填补的默认 enabled 等字段覆盖现有配置
      try { validateProviderConfig(normalizeProvider(it)); } catch (e) { invalid++; continue; }
      const exist = urlIndex.get(key);
      if (exist) {
        // 与现有记录逐字段一致 => 记为跳过，避免「更新数」虚高
        if (mergeProvider(exist, it)) updated++;
        else skipped++;
      } else {
        const p = normalizeProvider({ ...it, id: undefined });
        db.providers.push(p);
        urlIndex.set(key, p);
        added++;
      }
    }
  }
  ensureUniqueProviderIds(db.providers);
  logger.info(`[导入导出] 导入完成（${mode}）：新增 ${added}，更新 ${updated}，跳过 ${skipped}${invalid ? `，校验失败丢弃 ${invalid}` : ''}`);
  return { added, updated, skipped, invalid };
}

module.exports = { exportProviders, parseImport, applyImport, TEXT_DELIMITERS };
