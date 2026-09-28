'use strict';
/**
 * 服务商字段 schema（导入/备份/还原/主进程共用）。
 * - normalizeProvider: 任意形态条目归一为可入库记录（保留未知字段、补默认、重置运行态）
 * - mergeProvider: 导入条目合并进已存在记录（apiKey 为空不覆盖、运行态字段不覆盖）
 */

/** 运行态字段：入库/合并/还原时一律不从外部接受 */
const RUNTIME_FIELDS = [
  'status', 'latency', 'modelsTotal', 'modelsAvailable', 'modelsUnavailable',
  'modelsUnprobed', 'modelDetails', 'checkedAt', 'lastError', 'modelChanged',
  'consecutiveFail', 'probeCursor', 'modelBaseline', 'alertRuntime', 'quotaRemaining', 'quotaWarning', 'firstTokenMs', 'throughputTokensPerSec'
];
const PROBE_MODES = new Set(['chat', 'embeddings', 'completions', 'custom', 'none']);

function newNumericId(used = new Set()) {
  let id;
  do { id = Date.now() * 1000 + Math.floor(Math.random() * 1000); } while (used.has(id));
  return id;
}

function ensureUniqueProviderIds(list) {
  const used = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    let id = Number(p && p.id);
    if (!Number.isSafeInteger(id) || id <= 0 || used.has(id)) id = newNumericId(used);
    p.id = id;
    used.add(id);
  }
  return list;
}

function validateProviderConfig(p) {
  const name = String((p && p.name) || '').trim();
  const rawUrl = String((p && p.url) || '').trim();
  if (!name) throw new Error('服务商名称不能为空');
  if (name.length > 200) throw new Error('服务商名称不能超过 200 个字符');
  if (!rawUrl) throw new Error('服务商 URL 不能为空');
  let u;
  try { u = new URL(rawUrl); } catch (e) { throw new Error('服务商 URL 无效'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('服务商 URL 仅支持 HTTP/HTTPS');
  if (rawUrl.length > 2048) throw new Error('服务商 URL 过长');
  const interval = Number(p.intervalSec);
  if (!Number.isFinite(interval) || interval < 5 || interval > 31536000) throw new Error('轮循周期必须在 5 秒到 1 年之间');
  const mode = String(p.probeMode || 'chat');
  if (!PROBE_MODES.has(mode)) throw new Error(`不支持的探测模式: ${mode}`);
  if (p.probeLimit != null && (!Number.isFinite(Number(p.probeLimit)) || Number(p.probeLimit) < 1 || Number(p.probeLimit) > 1000)) {
    throw new Error('单轮探测上限必须在 1-1000 之间');
  }
  for (const key of ['maintStart', 'maintEnd']) {
    if (p[key] != null && !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(String(p[key]))) throw new Error(`${key} 时间格式无效`);
  }
  if (String(p.probeBody || '').length > 100000) throw new Error('自定义探测请求体过大');
  if (p.modelsPath != null && !String(p.modelsPath).trim().startsWith('/')) throw new Error('模型列表路径必须以 / 开头');
  if (p.customHeaders) {
    let headers;
    try { headers = JSON.parse(String(p.customHeaders)); } catch (e) { throw new Error('自定义请求头不是合法 JSON'); }
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error('自定义请求头必须是 JSON 对象');
  }
  if (!['none', 'contains', 'jsonPath'].includes(String(p.assertType || 'none'))) throw new Error('响应断言类型无效');
  if (p.modelIgnorePattern) { try { new RegExp(String(p.modelIgnorePattern)); } catch (e) { throw new Error('模型忽略规则不是有效正则表达式'); } }
  if (p.quotaPath && !String(p.quotaPath).trim().startsWith('/')) throw new Error('配额路径必须以 / 开头');
  if (p.quotaWarnBelow != null && p.quotaWarnBelow !== '' && !Number.isFinite(Number(p.quotaWarnBelow))) throw new Error('配额告警阈值必须是数字');
  return true;
}

/** 全新的运行态（入库/还原时重置检测状态） */
function freshRuntime() {
  return {
    status: 'unknown', latency: null, modelsTotal: 0,
    modelsAvailable: [], modelsUnavailable: [], modelsUnprobed: [], modelDetails: [],
    checkedAt: null, lastError: null, modelChanged: false,
    consecutiveFail: 0, probeCursor: 0, modelBaseline: [], quotaRemaining: null, quotaWarning: false, firstTokenMs: null, throughputTokensPerSec: null
  };
}

/** 布尔宽容解析（CSV/文本的 1/true/yes/是/y） */
function boolVal(v) {
  return v === true || v === 1 || /^(1|true|yes|是|y)$/i.test(String(v ?? '').trim());
}

/** URL 匹配键：去首尾空白+尾部斜杠+小写（仅用于去重比对，不回写入库值） */
function normalizeUrlKey(u) {
  return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
}

/** URL 入库值：去首尾空白+尾部斜杠，保留大小写 */
function cleanUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

function normalizeProvider(p) {
  const src = (p && typeof p === 'object') ? p : {};
  const out = { ...src };  // 保留未知字段（前向兼容：新字段导出再导入不丢失）
  out.id = Number(src.id) || newNumericId();
  out.name = String(src.name || '').trim();
  out.url = cleanUrl(src.url);
  out.apiKey = String(src.apiKey || '');
  out.intervalSec = Math.max(5, Number(src.intervalSec) || 60);
  out.notifyOnModelChange = typeof src.notifyOnModelChange === 'boolean' ? src.notifyOnModelChange : boolVal(src.notifyOnModelChange);
  out.note = String(src.note || '');
  out.enabled = src.enabled !== false;
  // 扩展配置字段（缺失补默认，已有保留）
  out.group = String(src.group || '');
  out.tags = Array.isArray(src.tags) ? src.tags.map((t) => String(t)) : [];
  out.probeMode = String(src.probeMode || 'chat');
  out.probePath = String(src.probePath || '');
  out.probeBody = String(src.probeBody || '');
  out.modelsPath = String(src.modelsPath || '/v1/models');
  out.authType = ['bearer', 'header', 'none'].includes(src.authType) ? src.authType : 'bearer';
  out.authHeader = String(src.authHeader || 'X-API-Key');
  out.authPrefix = String(src.authPrefix || '');
  out.customHeaders = String(src.customHeaders || '');
  out.capabilityModes = Array.isArray(src.capabilityModes) ? src.capabilityModes.filter((m) => ['chat', 'embeddings', 'completions'].includes(m)) : [];
  out.assertType = ['none', 'contains', 'jsonPath'].includes(src.assertType) ? src.assertType : 'none';
  out.assertValue = String(src.assertValue || '');
  out.modelIgnorePattern = String(src.modelIgnorePattern || '');
  out.quotaPath = String(src.quotaPath || '');
  out.quotaValuePath = String(src.quotaValuePath || 'remaining');
  out.quotaWarnBelow = src.quotaWarnBelow === '' || src.quotaWarnBelow == null ? null : Number(src.quotaWarnBelow);
  out.measureStreaming = Boolean(src.measureStreaming);
  out.notifyChannels = Array.isArray(src.notifyChannels) ? src.notifyChannels.map(String) : [];
  out.maintWeekdays = Array.isArray(src.maintWeekdays) ? src.maintWeekdays.map(Number).filter((n) => n >= 0 && n <= 6) : [];
  out.maintDates = String(src.maintDates || '');
  out.probeLimit = Number(src.probeLimit) > 0 ? Number(src.probeLimit) : null;
  out.proxyUrl = String(src.proxyUrl || '');
  out.useProxy = src.useProxy !== false;
  out.maintEnabled = Boolean(src.maintEnabled);
  out.maintStart = String(src.maintStart || '02:00');
  out.maintEnd = String(src.maintEnd || '04:00');
  out.insecureSkipVerify = src.insecureSkipVerify === true ? true : src.insecureSkipVerify === false ? false : null;
  // 运行态一律重置
  Object.assign(out, freshRuntime());
  delete out.alertRuntime;
  return out;
}

const MERGE_SKIP = new Set(['id', ...RUNTIME_FIELDS]);

/**
 * 合并：incoming 的配置字段覆盖 exist（apiKey 为空不覆盖、运行态不碰）。
 * 返回 true 表示至少一个字段发生变化。
 */
function mergeProvider(exist, incoming) {
  let changed = false;
  for (const k of Object.keys(incoming)) {
    if (MERGE_SKIP.has(k)) continue;
    let v = incoming[k];
    if (k === 'apiKey' && !v) continue;
    if (k === 'url') v = cleanUrl(v);
    if (k === 'intervalSec') v = Math.max(5, Number(v) || exist.intervalSec || 60);
    if (k === 'notifyOnModelChange' && typeof v !== 'boolean') v = boolVal(v);
    if (JSON.stringify(exist[k]) !== JSON.stringify(v)) { exist[k] = v; changed = true; }
  }
  return changed;
}

module.exports = { RUNTIME_FIELDS, freshRuntime, boolVal, normalizeUrlKey, cleanUrl, normalizeProvider, mergeProvider, validateProviderConfig, ensureUniqueProviderIds, newNumericId };
