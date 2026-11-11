'use strict';
/**
 * 备份 / 还原 IPC。由 main.js 注入 ctx（db 访问 / 持久化 / 调度器 / 窗口引用）。
 */
const { ipcMain, dialog } = require('electron');
const path = require('path');
const backup = require('../backup');
const { prepareDetectionChanges } = require('../detectionConfig');

function register(ctx) {
  ipcMain.handle('backup:export', async (e, filePath) => {
    try {
      const db = ctx.getDb();
      const target = filePath || path.join(ctx.DATA_DIR, `backup-manual-${backup.stampSafe()}.json`);
      const saved = backup.exportTo({ global: db.global, providers: db.providers }, target);
      return { ok: true, path: saved };
    } catch (err) {
      ctx.logger.error(`[备份] 导出失败: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('backup:saveAs', async () => {
    const r = await dialog.showSaveDialog(ctx.win(), {
      title: '备份保存到…',
      defaultPath: `aipm-backup-${backup.stampSafe()}.json`,
      filters: [{ name: '备份文件', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      const db = ctx.getDb();
      const saved = backup.exportTo({ global: db.global, providers: db.providers }, r.filePath);
      return { ok: true, path: saved };
    } catch (err) {
      ctx.logger.error(`[备份] 另存失败: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('backup:pickFile', async () => {
    const r = await dialog.showOpenDialog(ctx.win(), {
      title: '选择备份文件',
      properties: ['openFile'],
      filters: [{ name: '备份文件', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    // 读取摘要供确认弹窗展示
    try {
      const meta = backup.parseBackupFile(r.filePaths[0]);
      return { ok: true, path: r.filePaths[0], count: meta.providers.length, hasGlobal: Boolean(meta.global) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('backup:restore', (e, { filePath, mode }) => {
    const db = ctx.getDb();
    const before = JSON.stringify(db);
    let committed = false;
    try {
      const res = backup.restoreFrom(db, filePath, mode === 'merge' ? 'merge' : 'overwrite');
      prepareDetectionChanges(db, JSON.parse(before));
      const saved = ctx.persist();
      if (!saved.ok) { ctx.replaceDb(JSON.parse(before)); return saved; }
      committed = true;
      // 重建全部定时器并刷新前端；旧熔断记录对应的 provider 可能已不在列表里，一并清空
      ctx.scheduler.removeAll();
      ctx.scheduler.resetAllCircuits();
      ctx.alerts.resetState(); ctx.applyGlobalConfig();
      for (const p of db.providers) {
        if (p.enabled !== false) ctx.scheduler.schedule(p);
      }
      ctx.updateTrayStatus();
      ctx.send('state-changed', ctx.publicState());
      return { ok: true, ...res };
    } catch (err) {
      if (!committed) ctx.replaceDb(JSON.parse(before));
      ctx.logger.error(`[还原] 失败: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('backup:listAuto', () => {
    try { return { ok: true, list: backup.listAuto(ctx.DATA_DIR), dir: backup.backupDir(ctx.DATA_DIR) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('backup:runAuto', () => {
    try {
      const db = ctx.getDb();
      const file = backup.autoBackup({ global: db.global, providers: db.providers }, ctx.DATA_DIR, { keep: 10 });
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { register };
