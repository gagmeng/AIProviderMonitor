'use strict';
/**
 * 全局配置 IPC：global:set / global:clearSecrets。
 * 由 main.js 注入 ctx（db 访问 / 持久化 / 状态推送 / 登录项与快捷键重挂）。
 */
const { ipcMain } = require('electron');
const { normalizeGlobal } = require('../store');
const { prepareDetectionChanges, restoreProvider } = require('../detectionConfig');

function saveConfig(ctx, db, before) {
  const oldProviders = db.providers.map((p) => JSON.parse(JSON.stringify(p)));
  const changed = prepareDetectionChanges(db, { global: before, providers: oldProviders });
  const saved = ctx.persist();
  if (!saved.ok) {
    db.global = before;
    db.providers.forEach((p, i) => restoreProvider(p, oldProviders[i]));
  } else ctx.commitDetectionChanges(changed);
  return saved;
}

function register(ctx) {
  ipcMain.handle('global:set', (e, patch) => {
    const db = ctx.getDb();
    const before = db.global;
    // configVersion 与 lastReportDay 只由主进程维护：前者是迁移标记，后者是日报去重状态，
    // 允许渲染层写入会让日报被误跳过或迁移逻辑失效
    const READONLY_GLOBAL = new Set(['configVersion', 'lastReportDay']);
    const allowed = new Set(Object.keys(db.global || {}).filter((k) => !READONLY_GLOBAL.has(k)));
    const safePatch = {};
    for (const [key, value] of Object.entries((patch && typeof patch === 'object') ? patch : {})) {
      if (allowed.has(key)) safePatch[key] = value;
      else ctx.logger.warn(`[配置] 忽略未授权全局字段: ${key}`);
    }
    // 归一化兜底：钳位数值、校验时间与枚举格式（前端约束之外的最后一道防线）
    db.global = normalizeGlobal({ ...db.global, ...safePatch });
    const saved = saveConfig(ctx, db, before);
    if (!saved.ok) { db.global = before; return saved; }
    const affected = {
      weixinWebhook: 'weixin', qqWebhook: 'qq', qqToken: 'qq', qqTarget: 'qq', qqTargetType: 'qq',
      dingtalkWebhook: 'dingtalk', dingtalkSecret: 'dingtalk', telegramToken: 'telegram', telegramChatId: 'telegram',
      telegramApiBase: 'telegram', feishuWebhook: 'feishu', feishuSecret: 'feishu', slackWebhook: 'slack',
      serverchanKey: 'serverchan', customWebhook: 'custom', customHeaders: 'custom', customTemplate: 'custom'
    };
    const channels = new Set(Object.keys(safePatch).filter((k) => before[k] !== db.global[k]).map((k) => affected[k]).filter(Boolean));
    if (channels.size) ctx.notifier.resetHealth([...channels]);
    ctx.applyGlobalConfig();
    ctx.logger.info('全局配置已更新');
    ctx.send('state-changed', ctx.publicState());
    return { ok: true };
  });

  /** 清除已保存的全局敏感配置（只允许 SECRET_GLOBAL_KEYS 内的键） */
  ipcMain.handle('global:clearSecrets', (e, keys) => {
    const db = ctx.getDb();
    const list = (Array.isArray(keys) ? keys : []).map(String).filter((k) => ctx.SECRET_GLOBAL_KEYS.includes(k));
    if (!list.length) return { ok: false, error: '未指定要清除的密钥' };
    const before = db.global;
    db.global = { ...db.global };
    for (const k of list) db.global[k] = '';
    const saved = saveConfig(ctx, db, before);
    if (!saved.ok) { db.global = before; return saved; }
    // 通道凭据被清空后，旧的成功/失败记录不再代表当前配置，一并清掉健康状态
    const AFFECTED = {
      weixinWebhook: ['weixin'], qqWebhook: ['qq'], qqToken: ['qq'], dingtalkWebhook: ['dingtalk'], dingtalkSecret: ['dingtalk'],
      telegramToken: ['telegram'], feishuWebhook: ['feishu'], feishuSecret: ['feishu'], slackWebhook: ['slack'],
      serverchanKey: ['serverchan'], customWebhook: ['custom'], customHeaders: ['custom']
    };
    const stale = new Set();
    for (const k of list) for (const ch of AFFECTED[k] || []) stale.add(ch);
    if (stale.size) ctx.notifier.resetHealth([...stale]);
    ctx.applyGlobalConfig();
    ctx.logger.info(`[配置] 已清除 ${list.length} 项敏感配置（${list.join(', ')}）`);
    ctx.send('state-changed', ctx.publicState());
    return { ok: true };
  });
}

module.exports = { register };
