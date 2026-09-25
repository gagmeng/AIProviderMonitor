'use strict';
/**
 * 自动更新（electron-updater 懒加载）：GitHub Release 检查 + 下载后提示重启安装。
 */
const logger = require('./logger');

function createUpdater({ app, dialog }) {
  let autoUpdater = null;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    logger.warn('[更新] 未安装 electron-updater，跳过自动更新');
    return { check: async () => ({ ok: false, error: '未安装更新模块' }) };
  }
  autoUpdater.autoDownload = true;
  autoUpdater.on('error', (e) => logger.warn(`[更新] 检查失败: ${e && e.message}`));
  autoUpdater.on('update-downloaded', (info) => {
    logger.info(`[更新] 新版本 v${info.version} 已下载，等待重启安装`);
    try {
      dialog.showMessageBox({
        type: 'info',
        title: '更新就绪',
        message: `新版本 v${info.version} 已下载完成`,
        detail: '重启应用即可完成安装。',
        buttons: ['现在重启安装', '稍后']
      }).then(({ response }) => {
        if (response === 0) { try { autoUpdater.quitAndInstall(); } catch (e) { /* ignore */ } }
      });
    } catch (e) { /* ignore */ }
  });

  async function check(manual) {
    if (!app.isPackaged) {
      if (manual) dialog.showMessageBox({ type: 'info', title: '检查更新', message: '开发模式无需检查更新' });
      return { ok: false, dev: true };
    }
    try {
      const r = await autoUpdater.checkForUpdates();
      const v = r && r.updateInfo && r.updateInfo.version;
      logger.info(`[更新] 检查完成，远端版本: ${v || '未知'}`);
      if (manual && v && v === app.getVersion()) {
        dialog.showMessageBox({ type: 'info', title: '检查更新', message: `当前已是最新版本（v${v}）` });
      }
      return { ok: true, version: v };
    } catch (e) {
      logger.warn(`[更新] 检查失败: ${e.message}`);
      if (manual) dialog.showMessageBox({ type: 'warning', title: '检查更新', message: '检查更新失败', detail: String(e.message || e) });
      return { ok: false, error: e.message };
    }
  }
  return { check };
}

module.exports = { createUpdater };
