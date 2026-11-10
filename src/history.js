'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const logger = require('./logger');
const { StringDecoder } = require('string_decoder');

/**
 * 历史时序存储：按天分片的 JSONL（每行一条检测记录），便于追加写与按范围裁剪。
 * 目录：<dataDir>/history/hist-YYYYMMDD.jsonl
 * 单条记录：{ t, id, name, status, latency, total, avail, unavail, unprobed, err }
 * 单模型记录：<dataDir>/history/mhist-YYYYMMDD.jsonl，每行 { t, id, mid, ok }
 *
 * 设计取舍：不引入 SQLite 依赖，纯 JSONL 追加写；查询时只读取覆盖时间范围的分片文件，
 * 单日数据量（服务商数 × 每日轮次）在桌面场景下完全可控。
 */

const DIR_NAME = 'history';

function historyDir(dataDir) { return path.join(dataDir, DIR_NAME); }

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* ignore */ } }

// Writes are ordered per file. Queries and quit await all in-flight appends.
const writeQueue = [], writeChains = new Map(), readCache = new Map();
let writeTimer = null, revision = 0;
function enqueueWrite(file, text) {
  revision++; readCache.clear(); writeQueue.push({ file, text });
  if (!writeTimer) writeTimer = setImmediate(flushAsync);
}
function groupedQueue(batch) {
  const byFile = new Map();
  for (const job of batch) byFile.set(job.file, (byFile.get(job.file) || '') + job.text);
  return byFile;
}
function flushAsync() {
  if (writeTimer) clearImmediate(writeTimer);
  writeTimer = null;
  for (const [file, text] of groupedQueue(writeQueue.splice(0))) {
    const chain = (writeChains.get(file) || Promise.resolve()).catch(() => {}).then(() => fsp.appendFile(file, text, 'utf8'));
    writeChains.set(file, chain);
    chain.catch((err) => logger.warn(`[历史] 写入失败: ${err.message}`)).finally(() => {
      if (writeChains.get(file) === chain) writeChains.delete(file);
    });
  }
}
async function flush() {
  do { flushAsync(); await Promise.all([...writeChains.values()]); } while (writeQueue.length || writeChains.size);
}
function flushSync() {
  if (writeChains.size) return flush();
  if (writeTimer) clearImmediate(writeTimer);
  writeTimer = null;
  for (const [file, text] of groupedQueue(writeQueue.splice(0))) {
    ensureDir(path.dirname(file)); fs.appendFileSync(file, text, 'utf8');
  }
}

/** 按块读行（异步版）：每 ~2MB 让出一次事件循环，
 * 避免大分片统计期间把主进程整个卡住（窗口/托盘/IPC 全部冻结） */
async function readLinesAsync(file, onLine) {
  let fh;
  try { fh = await fsp.open(file, 'r'); } catch (e) { return; }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let leftover = '';
    let chunks = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      leftover += decoder.write(buf.subarray(0, bytesRead));
      let idx;
      while ((idx = leftover.indexOf('\n')) >= 0) {
        const line = leftover.slice(0, idx).replace(/\r$/, '');
        leftover = leftover.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
      if (leftover.length > 2 * 1024 * 1024) leftover = leftover.slice(-2048);
      if (++chunks % 32 === 0) await new Promise((r) => setImmediate(r));
    }
    leftover += decoder.end();
    if (leftover.trim()) onLine(leftover.replace(/\r$/, ''));
  } finally {
    try { await fh.close(); } catch (e) { /* ignore */ }
  }
}

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function fileFor(dataDir, ts) {
  return path.join(historyDir(dataDir), `hist-${dayKey(ts)}.jsonl`);
}

function modelFileFor(dataDir, ts) {
  return path.join(historyDir(dataDir), `mhist-${dayKey(ts)}.jsonl`);
}

/** 追加一条检测记录 */
function append(dataDir, provider, result) {
  try {
    const dir = historyDir(dataDir);
    ensureDir(dir);
    const rec = {
      t: result.checkedAt || Date.now(),
      id: provider.id,
      name: provider.name,
      status: result.status,
      intervalSec: Math.max(5, Number(provider.intervalSec) || 300),
      sloTarget: provider.sloTarget ?? null,
      latency: result.latency == null ? null : Number(result.latency),
      total: Number(result.modelsTotal) || 0,
      avail: (result.modelsAvailable || []).length,
      unavail: (result.modelsUnavailable || []).length,
      unprobed: (result.modelsUnprobed || []).length,
      err: result.error ? String(result.error).slice(0, 200) : null
    };
    enqueueWrite(fileFor(dataDir, rec.t), JSON.stringify(rec) + '\n');
    return rec;
  } catch (e) {
    logger.warn(`[历史] 写入失败: ${e.message}`);
    return null;
  }
}

/** 追加单模型探测记录（details 为 [{ id, ok }]，ok 非布尔的跳过） */
function appendModels(dataDir, providerId, checkedAt, details) {
  try {
    if (!Array.isArray(details) || !details.length) return 0;
    const t = checkedAt || Date.now();
    const lines = [];
    for (const d of details) {
      if (!d || typeof d.ok !== 'boolean') continue;
      lines.push(JSON.stringify({ t, id: providerId, mid: String(d.id), ok: d.ok ? 1 : 0 }));
    }
    if (!lines.length) return 0;
    const dir = historyDir(dataDir);
    ensureDir(dir);
    enqueueWrite(modelFileFor(dataDir, t), lines.join('\n') + '\n');
    return lines.length;
  } catch (e) {
    logger.warn(`[历史] 单模型写入失败: ${e.message}`);
    return 0;
  }
}

/** 读取某服务商指定时间范围内的单模型记录 */
async function readModelRange(dataDir, providerId, fromTs, toTs) {
  await flush();
  const dir = historyDir(dataDir);
  const out = [];
  let files;
  try { files = (await fsp.readdir(dir)).filter((f) => /^mhist-\d{8}\.jsonl$/.test(f)).sort(); }
  catch (e) { return out; }

  const fromKey = dayKey(fromTs);
  const toKey = dayKey(toTs);
  for (const f of files) {
    const key = f.slice(6, 14);
    if (key < fromKey || key > toKey) continue;
    await readLinesAsync(path.join(dir, f), (line) => {
      try {
        const r = JSON.parse(line);
        if (r.id === Number(providerId) && r.t >= fromTs && r.t <= toTs) out.push(r);
      } catch (e) { /* 跳过损坏行 */ }
    });
  }
  return out;
}

/**
 * 单模型可用率统计。
 * 返回 { rangeHours, from, to, models: [{ mid, samples, ok, rate }] }（按 rate 升序）。
 */
async function modelRates(dataDir, providerId, { hours = 24 } = {}) {
  const to = Date.now();
  const from = to - hours * 3600 * 1000;
  const recs = await readModelRange(dataDir, providerId, from, to);
  const map = new Map();
  for (const r of recs) {
    if (!map.has(r.mid)) map.set(r.mid, { samples: 0, ok: 0 });
    const e = map.get(r.mid);
    e.samples++;
    if (r.ok) e.ok++;
  }
  const models = [...map.entries()].map(([mid, e]) => ({
    mid, samples: e.samples, ok: e.ok,
    rate: e.samples ? Number(((e.ok / e.samples) * 100).toFixed(1)) : 0
  }));
  models.sort((a, b) => a.rate - b.rate || String(a.mid).localeCompare(String(b.mid)));
  return { rangeHours: hours, from, to, models };
}

/** 读取指定时间范围内的全部记录（按天分片定位，避免全量扫描） */
async function readRangeUncached(dataDir, fromTs, toTs, { providerId = null, providerIds = null } = {}) {
  await flush();
  const allowed = Array.isArray(providerIds) ? new Set(providerIds.map(Number)) : null;
  const dir = historyDir(dataDir);
  const out = [];
  let files;
  try { files = (await fsp.readdir(dir)).filter((f) => /^hist-\d{8}\.jsonl$/.test(f)).sort(); }
  catch (e) { return out; }

  const fromKey = dayKey(fromTs);
  const toKey = dayKey(toTs);
  for (const f of files) {
    const key = f.slice(5, 13);
    if (key < fromKey || key > toKey) continue;
    await readLinesAsync(path.join(dir, f), (line) => {
      try {
        const r = JSON.parse(line);
        if (r.t >= fromTs && r.t <= toTs && (providerId == null || r.id === Number(providerId)) && (!allowed || allowed.has(r.id))) out.push(r);
      } catch (e) { /* 跳过损坏行 */ }
    });
    // 分片之间也让出一次事件循环，多分片统计时界面保持可响应
    await new Promise((r) => setImmediate(r));
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function readRange(dataDir, fromTs, toTs, options = {}) {
  const key = JSON.stringify([dataDir, fromTs, toTs, options.providerId ?? null, options.providerIds ?? null, revision]);
  const cached = readCache.get(key);
  if (cached && Date.now() - cached.at < 1000) return cached.promise;
  const promise = readRangeUncached(dataDir, fromTs, toTs, options);
  readCache.set(key, { at: Date.now(), promise });
  if (readCache.size > 6) readCache.delete(readCache.keys().next().value);
  promise.catch(() => readCache.delete(key));
  return promise;
}

/** Carry a sample forward for at most two planned periods; stale time stays unknown. */
function timeMetrics(records, from, to, target = 99.9) {
  const list = records.slice().sort((a, b) => a.t - b.t);
  const gaps = list.slice(1).map((r, i) => r.t - list[i].t).filter((n) => n > 0).sort((a, b) => a - b);
  const fallback = Math.min(86400000, gaps[Math.floor(gaps.length / 2)] || 300000);
  let upMs = 0, downMs = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i], start = Math.max(from, r.t);
    const horizon = Math.max(5000, Number(r.intervalSec) * 1000 || fallback) * 2;
    const end = Math.min(to, list[i + 1]?.t ?? to, r.t + horizon);
    if (end <= start) continue;
    if (r.status === 'up') upMs += end - start;
    else if (['down', 'degraded', 'authfail'].includes(r.status)) downMs += end - start;
  }
  const windowMs = Math.max(0, to - from), observedMs = upMs + downMs;
  const unknownMs = Math.max(0, windowMs - observedMs), allowed = Math.round(windowMs * (1 - target / 100));
  return { upMs, downMs, observedMs, unknownMs, windowMs,
    timeUptime: observedMs ? Number((upMs / observedMs * 100).toFixed(4)) : null,
    coverage: windowMs ? Number((observedMs / windowMs * 100).toFixed(2)) : 0,
    sloTarget: target, allowedDowntimeMs: Math.round(allowed), budgetRemainingMs: Math.round(allowed - downMs),
    budgetUsedPercent: allowed > 0 ? Number((downMs / allowed * 100).toFixed(1)) : (downMs ? null : 0),
    sloMet: downMs > allowed ? 'breached' : unknownMs > 0 || !observedMs ? 'insufficient' : 'met'
  };
}

function aggregateTimeMetrics(rows) {
  const sum = (key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
  const observedMs = sum('observedMs'), windowMs = sum('windowMs'), downMs = sum('downMs'), allowedDowntimeMs = sum('allowedDowntimeMs');
  return { observedMs, windowMs, downMs, upMs: sum('upMs'), unknownMs: sum('unknownMs'), allowedDowntimeMs,
    timeUptime: observedMs ? Number((sum('upMs') / observedMs * 100).toFixed(4)) : null,
    coverage: windowMs ? Number((observedMs / windowMs * 100).toFixed(2)) : 0,
    budgetRemainingMs: allowedDowntimeMs - downMs,
    budgetUsedPercent: allowedDowntimeMs > 0 ? Number((downMs / allowedDowntimeMs * 100).toFixed(1)) : null
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * 汇总统计。
 * 返回 { rangeHours, overall, perProvider: [...] }
 * 可用率定义：status==='up' 的样本数 / 总样本数
 */
async function summarize(dataDir, { hours = 24, providerId = null, providers = null, includeHistorical = false, sloTarget = 99.9, now = Date.now() } = {}) {
  const to = now;
  const from = to - hours * 3600 * 1000;
  const configuredProviders = Array.isArray(providers) ? providers : [];
  // A configured list, including an empty list, is authoritative. Old IDs are opt-in.
  const providerIds = Array.isArray(providers) && !includeHistorical ? providers.map((p) => p.id) : null;
  let recs = await readRange(dataDir, from, to, { providerId, providerIds });
  if (providerId != null) recs = recs.filter((r) => r.id === Number(providerId));

  const byProvider = new Map();
  for (const r of recs) {
    if (!byProvider.has(r.id)) byProvider.set(r.id, []);
    byProvider.get(r.id).push(r);
  }

  const lookback = Math.max(86400000, ...configuredProviders.map((p) => (Number(p.intervalSec) || 300) * 2000));
  const seed = await readRange(dataDir, from - lookback, from - 1, { providerId, providerIds });
  const prior = new Map(); for (const r of seed) prior.set(r.id, r);
  for (const id of prior.keys()) if (!byProvider.has(id)) byProvider.set(id, []);
  for (const p of configuredProviders) if ((providerId == null || p.id === Number(providerId)) && !byProvider.has(p.id)) byProvider.set(p.id, []);
  const perProvider = [];
  for (const [id, list] of byProvider) {
    const total = list.length;
    const upCount = list.filter((r) => r.status === 'up').length;
    const degCount = list.filter((r) => r.status === 'degraded').length;
    const downCount = list.filter((r) => r.status === 'down').length;
    const authCount = list.filter((r) => r.status === 'authfail').length;
    const lats = list.map((r) => r.latency).filter((v) => typeof v === 'number' && v >= 0).sort((a, b) => a - b);
    const configured = configuredProviders.find((p) => p.id === id);
    const last = list[list.length - 1] || prior.get(id);
    const target = Math.min(100, Math.max(90, Number(configured?.sloTarget ?? sloTarget) || 99.9));
    const weighted = timeMetrics([...(prior.has(id) ? [prior.get(id)] : []), ...list], from, to, target);
    let incidents = 0, recovered = 0, mttrSum = 0, maxOutage = 0, openFrom = null;
    for (const r of list) {
      if (r.status === 'up') {
        if (openFrom != null) { const duration = Math.max(0, r.t - openFrom); recovered++; mttrSum += duration; maxOutage = Math.max(maxOutage, duration); openFrom = null; }
      } else if (['down', 'degraded', 'authfail'].includes(r.status) && openFrom == null) { openFrom = r.t; incidents++; }
    }
    const currentOutageMs = openFrom == null ? 0 : Math.max(0, to - openFrom);
    maxOutage = Math.max(maxOutage, currentOutageMs);
    const mttrMs = recovered ? Math.round(mttrSum / recovered) : 0;
    perProvider.push({
      id,
      name: configured?.name || last?.name || `#${id}`,
      archived: Array.isArray(providers) && !configured,
      enabled: configured?.enabled !== false,
      samples: total,
      uptime: total ? Number(((upCount / total) * 100).toFixed(2)) : 0,
      upCount, degCount, downCount,
      authCount,
      ...weighted,
      currentOutageMs, recoveredIncidents: recovered,
      incidents,
      mttrMs,
      maxOutageMs: maxOutage,
      latencyAvg: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
      latencyP50: percentile(lats, 50),
      latencyP95: percentile(lats, 95),
      latencyMax: lats.length ? lats[lats.length - 1] : null,
      lastStatus: last?.status || 'unknown',
      lastAt: last?.t || null
    });
  }
  perProvider.sort((a, b) => a.uptime - b.uptime);

  const totalSamples = recs.length;
  const totalUp = recs.filter((r) => r.status === 'up').length;
  const totalAuth = recs.filter((r) => r.status === 'authfail').length;
  const totalIncidents = perProvider.reduce((a, p) => a + (p.incidents || 0), 0);
  const allLats = recs.map((r) => r.latency).filter((v) => typeof v === 'number' && v >= 0).sort((a, b) => a - b);

  return {
    rangeHours: hours,
    from, to,
    overall: {
      ...aggregateTimeMetrics(perProvider),
      samples: totalSamples,
      providers: perProvider.length,
      uptime: totalSamples ? Number(((totalUp / totalSamples) * 100).toFixed(2)) : 0,
      authCount: totalAuth,
      incidents: totalIncidents,
      latencyAvg: allLats.length ? Math.round(allLats.reduce((a, b) => a + b, 0) / allLats.length) : null,
      latencyP95: percentile(allLats, 95)
    },
    perProvider
  };
}

/**
 * 生成用于折线图的分桶序列。
 * 返回 { buckets: [{ t, uptime, latencyAvg, samples }], bucketMs }
 */
async function series(dataDir, { hours = 24, providerId = null, providers = null, includeHistorical = false, buckets = 48 } = {}) {
  const to = Date.now();
  const from = to - hours * 3600 * 1000;
  const providerIds = Array.isArray(providers) && !includeHistorical ? providers.map((p) => p.id) : null;
  let recs = await readRange(dataDir, from, to, { providerId, providerIds });
  if (providerId != null) recs = recs.filter((r) => r.id === Number(providerId));

  const bucketMs = Math.max(60000, Math.floor((to - from) / buckets));
  const map = new Map();
  for (const r of recs) {
    const b = Math.floor((r.t - from) / bucketMs);
    if (!map.has(b)) map.set(b, []);
    map.get(b).push(r);
  }
  const out = [];
  for (let i = 0; i < buckets; i++) {
    const list = map.get(i) || [];
    const lats = list.map((r) => r.latency).filter((v) => typeof v === 'number' && v >= 0);
    out.push({
      t: from + i * bucketMs,
      samples: list.length,
      uptime: list.length ? Number(((list.filter((r) => r.status === 'up').length / list.length) * 100).toFixed(1)) : null,
      latencyAvg: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null
    });
  }
  return { from, to, bucketMs, buckets: out };
}

/**
 * 按天聚合可用率（详情弹窗 90 天色条用）。
 * 返回 { from, to, dayMs, days: [{ t(当日零点), providers: [{ id, samples, uptime }] }] }；
 * 无数据的天不出现在 days 里，由渲染层按 dayMs 补空格子。
 */
async function perDay(dataDir, { days = 90, providerId = null } = {}) {
  const to = Date.now();
  const from = to - days * 86400000;
  let recs = await readRange(dataDir, from, to, { providerId });
  if (providerId != null) recs = recs.filter((r) => r.id === Number(providerId));

  const byDay = new Map();   // 当日零点 -> Map(id -> {up, total})
  for (const r of recs) {
    const d = new Date(r.t);
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    if (!byDay.has(key)) byDay.set(key, new Map());
    const m = byDay.get(key);
    if (!m.has(r.id)) m.set(r.id, { up: 0, total: 0 });
    const e = m.get(r.id);
    e.total++;
    if (r.status === 'up') e.up++;
  }
  const out = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, m]) => ({
    t,
    providers: [...m.entries()].map(([id, e]) => ({
      id,
      samples: e.total,
      uptime: e.total ? Number(((e.up / e.total) * 100).toFixed(1)) : 0
    }))
  }));
  return { from, to, dayMs: 86400000, days: out };
}

/** 清理超过保留天数的历史分片 */
async function prune(dataDir, keepDays = 90) {
  await flush();
  const dir = historyDir(dataDir);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^(hist|mhist)-\d{8}\.jsonl$/.test(f)); } catch (e) { return 0; }
  const cutoff = dayKey(Date.now() - keepDays * 86400 * 1000);
  let removed = 0;
  for (const f of files) {
    const m = /(\d{8})/.exec(f);
    if (m && m[1] < cutoff) {
      try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (e) { /* ignore */ }
    }
  }
  if (removed) { revision++; readCache.clear(); }
  if (removed) logger.info(`[历史] 已清理 ${removed} 个过期分片（保留 ${keepDays} 天）`);
  return removed;
}

/** 导出为 CSV（供报告下载） */
async function exportCSV(dataDir, { hours = 24, providerId = null, providers = null, includeHistorical = false } = {}) {
  const to = Date.now();
  const from = to - hours * 3600 * 1000;
  const providerIds = Array.isArray(providers) && !includeHistorical ? providers.map((p) => p.id) : null;
  let recs = await readRange(dataDir, from, to, { providerId, providerIds });
  if (providerId != null) recs = recs.filter((r) => r.id === Number(providerId));
  const head = ['time', 'providerId', 'name', 'status', 'latencyMs', 'modelsTotal', 'available', 'unavailable', 'unprobed', 'error'];
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = '\t' + s;   // 公式注入防护
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = recs.map((r) => [
    new Date(r.t).toLocaleString('zh-CN'), r.id, r.name, r.status,
    r.latency ?? '', r.total, r.avail, r.unavail, r.unprobed ?? 0, r.err ?? ''
  ].map(esc).join(','));
  return [head.join(','), ...rows].join('\r\n');
}

module.exports = { append, appendModels, readRange, readModelRange, summarize, modelRates, series, perDay, prune, exportCSV, historyDir, modelFileFor, DIR_NAME, flushSync, flush, timeMetrics };
