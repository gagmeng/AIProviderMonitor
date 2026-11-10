'use strict';
/**
 * 杂项 IPC：状态快照、日志（读取/清空/文件管理）、打开路径、未读告警、暂停检测、通知与邮件测试。
 * 由 main.js 注入 ctx（publicState / 未读队列操作 / 暂停控制等）。
 */
const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const report = require('../report');

function register(ctx) {
  ipcMain.handle('state:get', () => ctx.publicState());
  ipcMain.handle('logs:get', () => ctx.logger.recent());
  ipcMain.handle('logs:clear', () => { ctx.logger.clear(); return { ok: true }; });

  ipcMain.handle('logs:files', () => {
    try { return { ok: true, list: ctx.logger.listFiles(), dir: ctx.logger.LOG_DIR }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  /** 删除单个日志文件：只接受本模块命名规则的文件名，杜绝路径穿越 */
  ipcMain.handle('logs:deleteFile', (e, name) => {
    const file = String(name || '');
    if (!/^aipm-\d{8}\.log(\.\d+)?$/.test(file)) return { ok: false, error: '非法的日志文件名' };
    const full = path.join(ctx.logger.LOG_DIR, file);
    try {
      fs.unlinkSync(full);
      ctx.logger.info(`[日志] 已删除日志文件 ${file}`);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('open:path', (e, p) => { if (!p) return { ok: false, error: '路径为空' }; shell.openPath(p); return { ok: true }; });

  ipcMain.handle('app:version', () => ctx.pkg.version || require('electron').app.getVersion());
  ipcMain.handle('app:hotkeyCapture', (e, active) => { ctx.setHotkeyCapture(active === true); return { ok: true }; });

  ipcMain.handle('app:clearUnread', () => { ctx.clearAllUnread(); return { ok: true }; });

  /** 逐条确认未读告警 */
  ipcMain.handle('app:ackUnread', (e, id) => ctx.ackUnreadById(Number(id)));

  /** 全局暂停/恢复自动检测（手动检测不受影响） */
  ipcMain.handle('app:setPaused', (e, paused) => {
    ctx.setPausedMain(Boolean(paused));
    return { ok: true, paused: ctx.isPaused() };
  });

  ipcMain.handle('notify:test', async (e, channel) => {
    try {
      await ctx.notifier.sendTest(ctx.getDb().global, channel);
      ctx.logger.info(`[通知] 测试消息发送成功 (${channel})`);
      // 测试结果已计入通道健康，立即推状态让面板刷新（否则要等下一次轮询才变绿）
      ctx.send('state-changed', ctx.publicState());
      return { ok: true };
    } catch (err) {
      ctx.logger.error(`[通知] 测试失败 (${channel}): ${err.message}`);
      ctx.send('state-changed', ctx.publicState());
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('mail:test', async () => {
    try {
      const { sendMail } = require('../mailer');
      const sum = await ctx.history.summarize(ctx.DATA_DIR, { hours: 24, providers: ctx.getDb().providers, sloTarget: ctx.getDb().global.sloTarget });
      await sendMail(ctx.getDb().global, { subject: 'AI Provider Monitor 邮件测试', html: report.buildReportHTML(sum) });
      ctx.logger.info('[邮件] 测试邮件发送成功');
      return { ok: true };
    } catch (err) { ctx.logger.error(`[邮件] 测试失败: ${err.message}`); return { ok: false, error: err.message }; }
  });
}

module.exports = { register };
