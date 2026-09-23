'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * 历史时序存储：按天分片的 JSONL（每行一条检测记录），便于追加写与按范围裁剪。
 * 目录：<dataDir>/history/hist-YYYYMMDD.jsonl
 * 单条记录：{ t, id, name, status, latency, total, avail, unavail, unprobed, err }
 *
 * 设计取舍：不引入 SQLite 依赖，纯 JSONL 追加写；查询时只读取覆盖时间范围的分片文件，
 * 单日数据量（服务商数 × 每日轮次）在桌面场景下完全可控。
 */

const DIR_NAME = 'history';

function historyDir(dataDir) { return path.join(dataDir, DIR_NAME); }

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* ignore */ } }

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function fileFor(dataDir, ts) {
  return path.join(historyDir(dataDir), `hist-${dayKey(ts)}.jsonl`);
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
      latency: result.latency == null ? null : Number(result.latency),
      total: Number(result.modelsTotal) || 0,
      avail: (result.modelsAvailable || []).length,
      unavail: (result.modelsUnavailable || []).length,
      unprobed: (result.modelsUnprobed || []).length,
      err: result.error ? String(result.error).slice(0, 200) : null
    };
    fs.appendFileSync(fileFor(dataDir, rec.t), JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  } catch (e) {
    logger.warn(`[历史] 写入失败: ${e.message}`);
    return null;
  }
}

/** 读取指定时间范围内的全部记录（按天分片定位，避免全量扫描） */
function readRange(dataDir, fromTs, toTs) {
  const dir = historyDir(dataDir);
  const out = [];
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^hist-\d{8}\.jsonl$/.test(f)).sort(); }
  catch (e) { return out; }

  const fromKey = dayKey(fromTs);
  const toKey = dayKey(toTs);
  for (const f of files) {
    const key = f.slice(5, 13);
    if (key < fromKey || key > toKey) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.t >= fromTs && r.t <= toTs) out.push(r);
      } catch (e) { /* 跳过损坏行 */ }
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
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
function summarize(dataDir, { hours = 24, providerId = null } = {}) {
  const to = Date.now();
  const from = to - hours * 3600 * 1000;
  let recs = readRange(dataDir, from, to);
  if (providerId != null) recs = recs.filter((r) => r.id === Number(providerId));

  const byProvider = new Map();
  for (const r of recs) {
    if (!byProvider.has(r.id)) byProvider.set(r.id, []);
    byProvider.get(r.id).push(r);
  }

  const perProvider = [];
  for (const [id, list] of byProvider) {
    const total = list.length;
    const upCount = list.filter((r) => r.status === 'up').length;
    const degCount = list.filter((r) => r.status === 'degraded').length;
    const downCount = list.filter((r) => r.status === 'down').length;
    const lats = list.map((r) => r.latency).filter((v) => typeof v === 'number' && v >= 0).sort((a, b) => a - b);
    // 故障时长：连续非 up 样本按相邻采样间隔累加
    let downMs = 0;
    const gaps = [];
    for (let i = 1; i < list.length; i++) {
      const gap = Math.max(0, list[i].t - list[i - 1].t);
      gaps.push(gap);
      if (list[i - 1].status !== 'up') downMs += gap;
    }
    // 末尾样本仍处于非 up 时，故障仍在持续：按典型采样间隔把尾段补进统计，
    // 否则「正在发生的故障」会始终显示为 0。用间隔中位数的 2 倍封顶，
    // 避免长期无采样（数据陈旧）把故障时长放大成不真实的数值。
    const lastRec = list[list.length - 1];
    if (lastRec && lastRec.status !== 'up') {
      const tail = Math.max(0, to - lastRec.t);
      if (gaps.length) {
        const sorted = gaps.slice().sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] || 0;
        downMs += median > 0 ? Math.min(tail, median * 2) : tail;
      } else {
        downMs += tail;
      }
    }
    perProvider.push({
      id,
      name: list[list.length - 1].name,
      samples: total,
      uptime: total ? Number(((upCount / total) * 100).toFixed(2)) : 0,
      upCount, degCount, downCount,
      downMs,
      latencyAvg: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
      latencyP50: percentile(lats, 50),
      latencyP95: percentile(lats, 95),
      latencyMax: lats.length ? lats[lats.length - 1] : null,
      lastStatus: list[list.length - 1].status,
      lastAt: list[list.length - 1].t
    });
  }
  perProvider.sort((a, b) => a.uptime - b.uptime);

  const totalSamples = recs.length;
  const totalUp = recs.filter((r) => r.status === 'up').length;
  const allLats = recs.map((r) => r.latency).filter((v) => typeof v === 'number' && v >= 0).sort((a, b) => a - b);

  return {
    rangeHours: hours,
    from, to,
    overall: {
      samples: totalSamples,
      providers: perProvider.length,
      uptime: totalSamples ? Number(((totalUp / totalSamples) * 100).toFixed(2)) : 0,
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
function series(dataDir, { hours = 24, providerId = null, buckets = 48 } = {}) {
  const to = Date.now();
  const from = to - hours * 3600 * 1000;
  let recs = readRange(dataDir, from, to);
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

/** 清理超过保留天数的历史分片 */
function prune(dataDir, keepDays = 30) {
  const dir = historyDir(dataDir);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^hist-\d{8}\.jsonl$/.test(f)); } catch (e) { return 0; }
  const cutoff = dayKey(Date.now() - keepDays * 86400 * 1000);
  let removed = 0;
  for (const f of files) {
    if (f.slice(5, 13) < cutoff) {
      try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (e) { /* ignore */ }
    }
  }
  if (removed) logger.info(`[历史] 已清理 ${removed} 个过期分片（保留 ${keepDays} 天）`);
  return removed;
}

/** 导出为 CSV（供报告下载） */
function exportCSV(dataDir, { hours = 24, providerId = null } = {}) {
  const to = Date.now();
  const from = to - hours * 3600 * 1000;
  let recs = readRange(dataDir, from, to);
  if (providerId != null) recs = recs.filter((r) => r.id === Number(providerId));
  const head = ['time', 'providerId', 'name', 'status', 'latencyMs', 'modelsTotal', 'available', 'unavailable', 'unprobed', 'error'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = recs.map((r) => [
    new Date(r.t).toLocaleString('zh-CN'), r.id, r.name, r.status,
    r.latency ?? '', r.total, r.avail, r.unavail, r.unprobed ?? 0, r.err ?? ''
  ].map(esc).join(','));
  return [head.join(','), ...rows].join('\r\n');
}

module.exports = { append, readRange, summarize, series, prune, exportCSV, historyDir, DIR_NAME };
