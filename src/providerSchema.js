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
  'consecutiveFail', 'probeCursor', 'modelBaseline'
];

/** 全新的运行态（入库/还原时重置检测状态） */
function freshRuntime() {
  return {
    status: 'unknown', latency: null, modelsTotal: 0,
    modelsAvailable: [], modelsUnavailable: [], modelsUnprobed: [], modelDetails: [],
    checkedAt: null, lastError: null, modelChanged: false,
    consecutiveFail: 0, probeCursor: 0, modelBaseline: []
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
  out.id = Number(src.id) || Date.now() + Math.floor(Math.random() * 1000);
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
  out.probeLimit = Number(src.probeLimit) > 0 ? Number(src.probeLimit) : null;
  out.proxyUrl = String(src.proxyUrl || '');
  out.useProxy = src.useProxy !== false;
  out.maintEnabled = Boolean(src.maintEnabled);
  out.maintStart = String(src.maintStart || '02:00');
  out.maintEnd = String(src.maintEnd || '04:00');
  out.insecureSkipVerify = src.insecureSkipVerify === true ? true : src.insecureSkipVerify === false ? false : null;
  // 运行态一律重置
  Object.assign(out, freshRuntime());
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

module.exports = { RUNTIME_FIELDS, freshRuntime, boolVal, normalizeUrlKey, cleanUrl, normalizeProvider, mergeProvider };
