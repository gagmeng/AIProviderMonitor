'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { normalizeProvider, mergeProvider, normalizeUrlKey } = require('./providerSchema');

/**
 * 备份/还原模块
 * - 备份文件：providers.json 全量快照（global + providers），JSON 格式
 * - 自动备份：数据目录 backup/ 下保留最近 N 份，每次应用启动时若距上次超过 24h 则滚动一份
 * - 还原：支持「覆盖」（整体替换）与「合并」（providers 按 id/url 合并，global 保留当前）
 */

const AUTO_DIR_NAME = 'backup';

function backupDir(dataDir) {
  return path.join(dataDir, AUTO_DIR_NAME);
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* ignore */ }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 导出快照到指定文件；返回写入的文件路径 */
function exportTo(data, filePath) {
  const payload = {
    app: 'AI Provider Monitor',
    schema: 1,
    exportedAt: new Date().toISOString(),
    global: data.global,
    providers: data.providers
  };
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  logger.info(`[备份] 已导出到 ${filePath}（${data.providers.length} 个服务商）`);
  return filePath;
}

/** 校验并解析备份文件，返回 { global, providers } */
function parseBackupFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error('文件不是有效的备份（缺少对象结构）');
  if (!Array.isArray(raw.providers)) throw new Error('文件不是有效的备份（缺少 providers 数组）');
  return { global: raw.global || null, providers: raw.providers };
}

/**
 * 从备份文件还原。
 * mode = 'overwrite'：global 与 providers 全部替换为备份内容
 * mode = 'merge'：providers 按 id 合并（url 相同视为同一服务商去重），global 不动
 * 返回 { providers, added, updated, skipped }
 */
function restoreFrom(data, filePath, mode = 'overwrite') {
  const backup = parseBackupFile(filePath);

  if (mode === 'overwrite') {
    if (backup.global) Object.assign(data.global, backup.global);
    data.providers = backup.providers.map(normalizeProvider);
    logger.info(`[还原] 覆盖还原完成：${data.providers.length} 个服务商`);
    return { mode, providers: data.providers.length, added: data.providers.length, updated: 0, skipped: 0 };
  }

  // merge
  let added = 0, updated = 0, skipped = 0;
  const urlIndex = new Map(data.providers.map((p) => [normalizeUrlKey(p.url), p]));
  for (const raw of backup.providers) {
    const p = normalizeProvider(raw);
    if (!p.name && !p.url) { skipped++; continue; }
    const key = normalizeUrlKey(p.url) || `id:${p.id}`;
    const exist = urlIndex.get(key);
    if (exist) {
      // 仅覆盖用户配置（运行态不动）；内容一致记为跳过
      if (mergeProvider(exist, p)) updated++;
      else skipped++;
    } else {
      data.providers.push(p);
      urlIndex.set(key, p);
      added++;
    }
  }
  logger.info(`[还原] 合并还原完成：新增 ${added}，更新 ${updated}，跳过 ${skipped}`);
  return { mode, providers: data.providers.length, added, updated, skipped };
}

// 条目归一/合并已收敛到 providerSchema（与导入导出共用同一实现）

// ---------- 自动备份（滚动保留 N 份） ----------

/** 启动时调用：距上次自动备份超过 24h 则滚动一份；超出保留数删除最旧 */
function autoBackup(data, dataDir, { keep = 10 } = {}) {
  const dir = backupDir(dataDir);
  ensureDir(dir);
  const marker = path.join(dir, '.last-auto');
  let last = 0;
  try { last = Number(fs.readFileSync(marker, 'utf8')) || 0; } catch (e) { /* first run */ }
  const now = Date.now();
  if (now - last < 24 * 3600 * 1000) return null;
  const file = path.join(dir, `auto-${stamp()}.json`);
  exportTo(data, file);
  try { fs.writeFileSync(marker, String(now), 'utf8'); } catch (e) { /* ignore */ }
  pruneAuto(dir, keep);
  return file;
}

function pruneAuto(dir, keep) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^auto-\d{8}-\d{6}\.json$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

/** 供文件名使用的时间戳（对外暴露给 main.js 命名手动备份） */
function stampSafe() {
  return stamp();
}

/** 列出数据目录下自动备份文件（新→旧） */
function listAuto(dataDir) {
  const dir = backupDir(dataDir);
  ensureDir(dir);
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^auto-\d{8}-\d{6}\.json$/.test(f))
      .sort()
      .reverse()
      .map((f) => {
        const full = path.join(dir, f);
        const meta = { count: 0, at: null };
        try {
          const j = JSON.parse(fs.readFileSync(full, 'utf8'));
          meta.count = Array.isArray(j.providers) ? j.providers.length : 0;
          meta.at = j.exportedAt || null;
        } catch (e) { /* 损坏文件也列出，标记 count=0 */ }
        return { file: f, path: full, size: fs.statSync(full).size, ...meta };
      });
  } catch (e) {
    return [];
  }
}

module.exports = { exportTo, parseBackupFile, restoreFrom, autoBackup, listAuto, backupDir, stampSafe, AUTO_DIR_NAME };
