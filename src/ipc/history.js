'use strict';
/**
 * 历史统计与状态报告导出 IPC。
 * 由 main.js 注入 ctx（DATA_DIR / 窗口引用），报表生成在 src/report.js。
 */
const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const report = require('../report');

function register(ctx) {
  ipcMain.handle('history:summary', async (e, { hours, providerId } = {}) => {
    try { return { ok: true, ...(await ctx.history.summarize(ctx.DATA_DIR, { hours: Number(hours) || 24, providerId })) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('history:series', async (e, { hours, providerId, buckets } = {}) => {
    try { return { ok: true, ...(await ctx.history.series(ctx.DATA_DIR, { hours: Number(hours) || 24, providerId, buckets: Number(buckets) || 48 })) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  /** 按天聚合可用率（详情弹窗 90 天色条用） */
  ipcMain.handle('history:perDay', async (e, { days, providerId } = {}) => {
    try { return { ok: true, ...(await ctx.history.perDay(ctx.DATA_DIR, { days: Math.min(365, Math.max(1, Number(days) || 90)), providerId })) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('history:exportCSV', async (e, { hours, providerId } = {}) => {
    try {
      const content = await ctx.history.exportCSV(ctx.DATA_DIR, { hours: Number(hours) || 24, providerId });
      const r = await dialog.showSaveDialog(ctx.win(), {
        title: '导出历史记录',
        defaultPath: `aipm-history-${new Date().toISOString().slice(0, 10)}.csv`,
        filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(r.filePath, '\ufeff' + content, 'utf8');
      ctx.logger.info(`[历史] 已导出 ${r.filePath}`);
      return { ok: true, path: r.filePath };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('history:prune', (e, days) => {
    try { return { ok: true, removed: ctx.history.prune(ctx.DATA_DIR, Number(days) || 30) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('history:modelRates', async (e, { providerId, hours } = {}) => {
    try { return { ok: true, ...(await ctx.history.modelRates(ctx.DATA_DIR, providerId, { hours: Number(hours) || 24 })) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // ---------- 状态报告导出 ----------
  ipcMain.handle('report:export', async (e, { format = 'html', hours = 24 } = {}) => {
    try {
      const sum = await ctx.history.summarize(ctx.DATA_DIR, { hours: Number(hours) || 24 });
      const defExt = format === 'csv' ? 'csv' : 'html';
      const r = await dialog.showSaveDialog(ctx.win(), {
        title: '导出状态报告',
        defaultPath: `aipm-report-${new Date().toISOString().slice(0, 10)}.${defExt}`,
        // HTML 与 Excel 同框选择：按用户实际保存的后缀决定格式（统计页不新增按钮）
        filters: defExt === 'csv'
          ? [{ name: 'CSV 文件', extensions: ['csv'] }]
          : [{ name: 'HTML 文件', extensions: ['html'] }, { name: 'Excel 文件', extensions: ['xlsx'] }]
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      const ext = String(r.filePath.split('.').pop() || '').toLowerCase();
      if (ext === 'xlsx') {
        const buf = await report.buildReportXLSX(sum);
        fs.writeFileSync(r.filePath, buf);
      } else if (ext === 'csv' || defExt === 'csv') {
        fs.writeFileSync(r.filePath, '\ufeff' + report.buildReportCSV(sum), 'utf8');
      } else {
        fs.writeFileSync(r.filePath, report.buildReportHTML(sum), 'utf8');
      }
      ctx.logger.info(`[报告] 已导出 ${r.filePath}`);
      return { ok: true, path: r.filePath };
    } catch (err) { return { ok: false, error: err.message }; }
  });
}

module.exports = { register };
