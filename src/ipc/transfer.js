'use strict';
/**
 * 服务商批量导入 / 导出 IPC。由 main.js 注入 ctx（db 访问 / 持久化 / 调度器 / 窗口引用）。
 */
const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const transfer = require('../transfer');

function register(ctx) {
  ipcMain.handle('transfer:export', (e, { format, delimiter, withKey, filePath }) => {
    try {
      const content = transfer.exportProviders(ctx.getDb().providers, { format, delimiter, withKey });
      if (!filePath) {
        // 无路径：纯预览，只返回内容不落盘（避免在数据目录堆积 providers-*.json 快照）
        return { ok: true, path: null, content };
      }
      fs.writeFileSync(filePath, content, 'utf8');
      ctx.logger.info(`[导入导出] 已导出到 ${filePath}`);
      return { ok: true, path: filePath, content };
    } catch (err) {
      ctx.logger.error(`[导入导出] 导出失败: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('transfer:exportSaveAs', async (e, { format, delimiter, withKey }) => {
    const r = await dialog.showSaveDialog(ctx.win(), {
      title: '导出服务商到…',
      defaultPath: `providers-${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : format === 'text' ? 'txt' : 'json'}`,
      filters: [{ name: format === 'csv' ? 'CSV 文件' : format === 'text' ? '文本文件' : 'JSON 文件', extensions: [format === 'csv' ? 'csv' : format === 'text' ? 'txt' : 'json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      const content = transfer.exportProviders(ctx.getDb().providers, { format, delimiter, withKey });
      fs.writeFileSync(r.filePath, content, 'utf8');
      ctx.logger.info(`[导入导出] 已导出到 ${r.filePath}`);
      return { ok: true, path: r.filePath, content };
    } catch (err) {
      ctx.logger.error(`[导入导出] 导出失败: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('transfer:parse', (e, { text, format, delimiter }) => {
    try {
      return { ok: true, ...transfer.parseImport(text, { format, delimiter }) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('transfer:apply', (e, { items, mode }) => {
    try {
      const db = ctx.getDb();
      const before = JSON.stringify(db);
      const res = transfer.applyImport(db, items || [], mode === 'append' ? 'append' : 'merge');
      const saved = ctx.persist();
      if (!saved.ok) { ctx.replaceDb(JSON.parse(before)); return saved; }
      // 全量重排：新增的补上定时器，合并更新过周期的也按新周期重排
      // （schedule 内部对周期未变化的已有定时器是 no-op，不会打扰既有节奏）
      for (const p of db.providers) {
        if (p.enabled !== false) ctx.scheduler.schedule(p);
      }
      ctx.send('state-changed', ctx.publicState());
      return { ok: true, ...res };
    } catch (err) {
      ctx.logger.error(`[导入导出] 导入失败: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { register };
