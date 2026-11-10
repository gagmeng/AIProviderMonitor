'use strict';
/**
 * 服务商相关 IPC：增删改查、启停、批量编辑、排序、连接测试。
 * 由 main.js 注入 ctx（db 访问 / 持久化 / 状态推送 / 调度器等），本模块只注册 handler。
 */
const { ipcMain, clipboard } = require('electron');
const { validateProviderConfig, newNumericId, freshRuntime } = require('../providerSchema');
const { normalizeBase } = require('../providerTemplates');
const { detect } = require('../detector');
const { formatDuration } = require('../durfmt');

/** 渲染层表单 → Provider 配置对象（provider:add 与连接测试共用同一套默认值） */
function buildProviderInput(data) {
  return {
    name: String(data.name || '').trim(),
    url: normalizeBase(data.url).replace(/\/+$/, ''),
    apiKey: String(data.apiKey || '').trim(),
    intervalSec: Math.max(5, Number(data.intervalSec) || 60),
    notifyOnModelChange: Boolean(data.notifyOnModelChange),
    note: String(data.note || '').trim(),
    group: String(data.group || '').trim(),
    tags: Array.isArray(data.tags) ? data.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    probeMode: String(data.probeMode || 'chat'),
    probePolicy: data.probePolicy || 'strict',
    sloTarget: data.sloTarget == null || data.sloTarget === '' ? null : Number(data.sloTarget),
    probePath: String(data.probePath || '').trim(),
    probeBody: String(data.probeBody || '').trim(),
    modelsPath: String(data.modelsPath || '/v1/models').trim(),
    authType: ['bearer', 'header', 'none'].includes(data.authType) ? data.authType : 'bearer',
    authHeader: String(data.authHeader || 'X-API-Key').trim(),
    authPrefix: String(data.authPrefix || ''),
    customHeaders: String(data.customHeaders || '').trim(),
    capabilityModes: Array.isArray(data.capabilityModes) ? data.capabilityModes : [],
    assertType: String(data.assertType || 'none'),
    assertValue: String(data.assertValue || '').trim(),
    modelIgnorePattern: String(data.modelIgnorePattern || '').trim(),
    quotaPath: String(data.quotaPath || '').trim(),
    quotaValuePath: String(data.quotaValuePath || 'remaining').trim(),
    quotaWarnBelow: data.quotaWarnBelow === '' || data.quotaWarnBelow == null ? null : Number(data.quotaWarnBelow),
    measureStreaming: Boolean(data.measureStreaming),
    notifyChannels: Array.isArray(data.notifyChannels) ? data.notifyChannels : [],
    maintWeekdays: Array.isArray(data.maintWeekdays) ? data.maintWeekdays : [],
    maintDates: String(data.maintDates || '').trim(),
    probeLimit: Number(data.probeLimit) > 0 ? Number(data.probeLimit) : null,
    proxyUrl: String(data.proxyUrl || '').trim(),
    useProxy: data.useProxy !== false,
    maintEnabled: Boolean(data.maintEnabled),
    maintStart: String(data.maintStart || '02:00'),
    maintEnd: String(data.maintEnd || '04:00'),
    insecureSkipVerify: data.insecureSkipVerify === true ? true : data.insecureSkipVerify === false ? false : null,
    enabled: true,
    status: 'unknown',
    modelsAvailable: [],
    modelsUnavailable: [],
    modelsUnprobed: [],
    modelDetails: [],
    modelsTotal: 0,
    checkedAt: null,
    lastError: null,
    consecutiveFail: 0,
    probeCursor: 0,
    modelBaseline: []
  };
}

/** 编辑表单覆盖到已有 Provider（provider:update 与连接测试共用）：undefined=保留，空串=清除 */
function applyProviderPatch(p, data) {
  Object.assign(p, {
    name: String(data.name || p.name).trim(),
    url: normalizeBase(data.url ?? p.url).replace(/\/+$/, ''),
    apiKey: String(data.apiKey ?? p.apiKey ?? '').trim(),
    intervalSec: Math.max(5, Number(data.intervalSec) || p.intervalSec),
    notifyOnModelChange: data.notifyOnModelChange === undefined ? Boolean(p.notifyOnModelChange) : Boolean(data.notifyOnModelChange),
    note: String(data.note ?? p.note ?? '').trim(),
    group: String(data.group ?? p.group ?? '').trim(),
    tags: Array.isArray(data.tags) ? data.tags.map((t) => String(t).trim()).filter(Boolean) : (p.tags || []),
    probeMode: String(data.probeMode || p.probeMode || 'chat'),
    probePolicy: data.probePolicy ?? p.probePolicy ?? 'strict',
    sloTarget: data.sloTarget === undefined ? (p.sloTarget ?? null) : data.sloTarget == null || data.sloTarget === '' ? null : Number(data.sloTarget),
    probePath: String(data.probePath ?? p.probePath ?? '').trim(),
    probeBody: String(data.probeBody ?? p.probeBody ?? '').trim(),
    modelsPath: String(data.modelsPath ?? p.modelsPath ?? '/v1/models').trim(),
    authType: ['bearer', 'header', 'none'].includes(data.authType) ? data.authType : (p.authType || 'bearer'),
    authHeader: String(data.authHeader ?? p.authHeader ?? 'X-API-Key').trim(),
    authPrefix: String(data.authPrefix ?? p.authPrefix ?? ''),
    customHeaders: String(data.customHeaders ?? p.customHeaders ?? '').trim(),
    capabilityModes: Array.isArray(data.capabilityModes) ? data.capabilityModes : (p.capabilityModes || []),
    assertType: String(data.assertType ?? p.assertType ?? 'none'),
    assertValue: String(data.assertValue ?? p.assertValue ?? '').trim(),
    modelIgnorePattern: String(data.modelIgnorePattern ?? p.modelIgnorePattern ?? '').trim(),
    quotaPath: String(data.quotaPath ?? p.quotaPath ?? '').trim(),
    quotaValuePath: String(data.quotaValuePath ?? p.quotaValuePath ?? 'remaining').trim(),
    quotaWarnBelow: data.quotaWarnBelow === '' || data.quotaWarnBelow === null ? null : (Number.isFinite(Number(data.quotaWarnBelow)) ? Number(data.quotaWarnBelow) : (p.quotaWarnBelow ?? null)),
    measureStreaming: data.measureStreaming !== undefined ? Boolean(data.measureStreaming) : Boolean(p.measureStreaming),
    notifyChannels: Array.isArray(data.notifyChannels) ? data.notifyChannels : (p.notifyChannels || []),
    maintWeekdays: Array.isArray(data.maintWeekdays) ? data.maintWeekdays : (p.maintWeekdays || []),
    maintDates: String(data.maintDates ?? p.maintDates ?? '').trim(),
    probeLimit: data.probeLimit === null ? null : (Number(data.probeLimit) > 0 ? Number(data.probeLimit) : (p.probeLimit || null)),
    proxyUrl: String(data.proxyUrl ?? p.proxyUrl ?? '').trim(),
    useProxy: data.useProxy !== undefined ? data.useProxy !== false : (p.useProxy !== false),
    maintEnabled: data.maintEnabled !== undefined ? Boolean(data.maintEnabled) : Boolean(p.maintEnabled),
    maintStart: String(data.maintStart ?? p.maintStart ?? '02:00'),
    maintEnd: String(data.maintEnd ?? p.maintEnd ?? '04:00'),
    insecureSkipVerify: data.insecureSkipVerify === undefined ? (p.insecureSkipVerify ?? null)
      : (data.insecureSkipVerify === true ? true : data.insecureSkipVerify === false ? false : null)
  });
}

function register(ctx) {
  ipcMain.handle('provider:add', (e, data) => {
    const db = ctx.getDb();
    const id = newNumericId(new Set(db.providers.map((p) => p.id)));
    const p = { id, ...buildProviderInput(data) };
    try { validateProviderConfig(p); } catch (err) { return { ok: false, error: err.message }; }
    db.providers.push(p);
    const saved = ctx.persist();
    if (!saved.ok) { db.providers.pop(); return saved; }
    if (p.enabled !== false) ctx.scheduler.schedule(p);
    ctx.logger.info(`新增 Provider [${p.name}] ${p.url}`);
    ctx.send('state-changed', ctx.publicState());
    return { ok: true, id };
  });

  ipcMain.handle('provider:clone', (e, id) => {
    const db = ctx.getDb(), source = db.providers.find((p) => p.id === Number(id));
    if (!source) return { ok: false, error: 'Provider 不存在' };
    // Clone configuration without credentials or runtime state; start paused.
    const p = { ...JSON.parse(JSON.stringify(source)), ...freshRuntime(),
      id: newNumericId(new Set(db.providers.map((x) => x.id))), enabled: false };
    delete p.alertRuntime; p.apiKey = ''; p.customHeaders = ''; p.proxyUrl = '';
    const stem = `${source.name.slice(0, 180)} 副本`;
    p.name = stem; let suffix = 2;
    while (db.providers.some((x) => x.name === p.name)) p.name = `${stem} ${suffix++}`;
    db.providers.push(p);
    const saved = ctx.persist();
    if (!saved.ok) { db.providers.pop(); return saved; }
    ctx.send('state-changed', ctx.publicState());
    ctx.logger.info(`克隆 Provider [${source.name}] → [${p.name}]（停用）`);
    return { ok: true, id: p.id };
  });

  ipcMain.handle('provider:update', (e, { id, data }) => {
    const db = ctx.getDb();
    const p = db.providers.find((x) => x.id === Number(id));
    if (!p) return { ok: false, error: 'Provider 不存在' };
    const periodChanged = data.intervalSec !== undefined && Number(data.intervalSec) !== Number(p.intervalSec);
    const before = { ...p, tags: [...(p.tags || [])] };
    applyProviderPatch(p, data);
    try { validateProviderConfig(p); } catch (err) { Object.assign(p, before); return { ok: false, error: err.message }; }
    const saved = ctx.persist();
    if (!saved.ok) { Object.assign(p, before); return saved; }
    // 仅在周期变化时重排定时器（schedule 内部也会保护未变化的定时器），
    // 避免编辑名称/备注等操作把轮循从头计时
    if (p.enabled !== false && periodChanged) ctx.scheduler.schedule(p);
    ctx.logger.info(`更新 Provider [${p.name}]${periodChanged ? `（周期调整为 ${formatDuration(p.intervalSec)}，已重新调度）` : ''}`);
    ctx.send('state-changed', ctx.publicState());
    return { ok: true };
  });

  ipcMain.handle('provider:delete', (e, id) => {
    const db = ctx.getDb();
    const i = db.providers.findIndex((x) => x.id === Number(id));
    if (i < 0) return { ok: false };
    const [p] = db.providers.splice(i, 1);
    const saved = ctx.persist();
    if (!saved.ok) { db.providers.splice(i, 0, p); return saved; }
    ctx.scheduler.cancel(p.id);
    ctx.scheduler.resetCircuit(p.id);
    ctx.alerts.resetState(p.id);
    ctx.logger.info(`删除 Provider [${p.name}]`);
    ctx.send('state-changed', ctx.publicState());
    return { ok: true };
  });

  ipcMain.handle('provider:deleteMany', (e, ids) => {
    const db = ctx.getDb();
    const set = new Set((ids || []).map(Number));
    const removed = [];
    const before = db.providers;
    db.providers = db.providers.filter((p) => {
      if (set.has(p.id)) { removed.push(p); return false; }
      return true;
    });
    const saved = ctx.persist();
    if (!saved.ok) { db.providers = before; return saved; }
    for (const p of removed) { ctx.scheduler.cancel(p.id); ctx.scheduler.resetCircuit(p.id); ctx.alerts.resetState(p.id); }
    ctx.logger.info(`批量删除 ${removed.length} 个 Provider`);
    ctx.send('state-changed', ctx.publicState());
    return { ok: true, removed: removed.length };
  });

  /** 按需取回明文 Key（编辑弹窗眼睛图标用）：状态快照始终掩码，仅显式请求时返回 */
  ipcMain.handle('provider:revealKey', (e, id) => {
    const p = ctx.getDb().providers.find((x) => x.id === Number(id));
    if (!p) return { ok: false, error: 'Provider 不存在' };
    return { ok: true, apiKey: String(p.apiKey || '') };
  });

  /** 复制 Key 到剪贴板：在主进程完成，明文不进渲染层 */
  ipcMain.handle('provider:copyKey', (e, id) => {
    const p = ctx.getDb().providers.find((x) => x.id === Number(id));
    if (!p || !p.apiKey) return { ok: false, error: '未保存 API Key' };
    clipboard.writeText(String(p.apiKey));
    return { ok: true };
  });

  /**
   * 连接测试：不保存、不入调度，直接跑一轮 detect 返回摘要。
   * 编辑已有服务商时以已存配置为底（含明文 Key）再套表单补丁——
   * 否则密钥留空（=不修改语义）会让测试用空 Key 误报鉴权失败。
   */
  ipcMain.handle('provider:testConn', async (e, { id, data } = {}) => {
    const existing = Number(id) ? ctx.getDb().providers.find((x) => x.id === Number(id)) : null;
    let p;
    if (existing) {
      p = JSON.parse(JSON.stringify(existing));
      applyProviderPatch(p, data || {});
    } else {
      p = { id: 0, ...buildProviderInput(data || {}) };
    }
    p.enabled = true;
    try { validateProviderConfig(p); } catch (err) { return { ok: false, error: err.message }; }
    try {
      const r = await detect(p, { globalCfg: ctx.getDb().global });
      return {
        ok: true,
        result: {
          status: r.status, latency: r.latency, modelsTotal: r.modelsTotal,
          available: (r.modelsAvailable || []).length,
          unavailable: (r.modelsUnavailable || []).length,
          unprobed: (r.modelsUnprobed || []).length,
          error: r.error || null,
          durationMs: r.durationMs,
          sampleFailures: (r.modelDetails || []).filter((d) => d && d.ok === false).slice(0, 3).map((d) => `${d.id}：${d.note || ''}`)
        }
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('provider:checkNow', (e, ids) => {
    const list = (ids || []).map(Number);
    for (const id of list) ctx.scheduler.runCheck(id, { reason: 'manual' });
    return { ok: true, count: list.length };
  });

  ipcMain.handle('provider:checkAll', () => {
    for (const p of ctx.getDb().providers) { if (p.enabled !== false) ctx.scheduler.runCheck(p.id, { reason: 'manual' }); }
    return { ok: true };
  });

  ipcMain.handle('provider:toggleEnabled', (e, { id, enabled }) => {
    const db = ctx.getDb();
    const p = db.providers.find((x) => x.id === Number(id));
    if (!p) return { ok: false };
    const before = JSON.parse(JSON.stringify(p));
    p.enabled = Boolean(enabled);
    if (!p.enabled) { Object.assign(p, freshRuntime()); delete p.alertRuntime; }
    const saved = ctx.persist();
    if (!saved.ok) { Object.keys(p).forEach((key) => delete p[key]); Object.assign(p, before); return saved; }
    if (p.enabled) ctx.scheduler.schedule(p);
    else {
      ctx.scheduler.cancel(p.id); ctx.scheduler.resetCircuit(p.id); ctx.alerts.resetState(p.id);
    }
    ctx.send('state-changed', ctx.publicState());
    ctx.updateTrayStatus();
    return { ok: true };
  });

  /** 批量编辑选中的服务商：仅应用提交的字段，整体一次落盘 */
  ipcMain.handle('provider:bulkUpdate', (e, { ids, patch } = {}) => {
    const db = ctx.getDb();
    const set = new Set((ids || []).map(Number));
    const targets = db.providers.filter((p) => set.has(p.id));
    if (!targets.length) return { ok: false, error: '未选中任何服务商' };
    const tri = (v) => (v === true || v === false ? v : undefined);
    const clean = {};
    if (patch && Number(patch.intervalSec) > 0) clean.intervalSec = Math.min(31536000, Math.max(5, Math.round(Number(patch.intervalSec))));
    if (patch) {
      const n = tri(patch.notifyOnModelChange);
      if (n !== undefined) clean.notifyOnModelChange = n;
      const u = tri(patch.useProxy);
      if (u !== undefined) clean.useProxy = u;
    }
    if (patch && typeof patch.group === 'string') clean.group = patch.group.trim();
    if (!Object.keys(clean).length) return { ok: false, error: '没有要修改的字段' };
    const before = new Map(targets.map((p) => [p, { intervalSec: p.intervalSec, notifyOnModelChange: p.notifyOnModelChange, group: p.group, useProxy: p.useProxy }]));
    let invalid = null;
    for (const p of targets) {
      Object.assign(p, clean);
      try { validateProviderConfig(p); }
      catch (err) { invalid = `[${p.name}] ${err.message}`; break; }
    }
    if (invalid) {
      for (const p of targets) Object.assign(p, before.get(p));
      return { ok: false, error: invalid };
    }
    const saved = ctx.persist();
    if (!saved.ok) { for (const p of targets) Object.assign(p, before.get(p)); return saved; }
    // 周期变了才重排定时器，其余字段改动不打扰既有节奏
    if (clean.intervalSec !== undefined) {
      for (const p of targets) { if (p.enabled !== false) ctx.scheduler.schedule(p); }
    }
    ctx.logger.info(`批量更新 ${targets.length} 个 Provider（${Object.keys(clean).join(', ')}）`);
    ctx.send('state-changed', ctx.publicState());
    return { ok: true, updated: targets.length };
  });

  /** 拖拽排序：接收完整 ID 顺序，整体重排并落盘 */
  ipcMain.handle('provider:reorder', (e, { ids } = {}) => {
    const db = ctx.getDb();
    if (!Array.isArray(ids) || !ids.length) return { ok: false, error: '无效的排序数据' };
    const want = ids.map(Number);
    if (new Set(want).size !== want.length) return { ok: false, error: '排序数据含重复 ID' };
    const current = new Set(db.providers.map((p) => p.id));
    if (want.length !== db.providers.length || want.some((id) => !current.has(id))) {
      return { ok: false, error: '排序数据与服务商列表不一致' };
    }
    const byId = new Map(db.providers.map((p) => [p.id, p]));
    const before = db.providers.slice();
    db.providers = want.map((id) => byId.get(id));
    const saved = ctx.persist();
    if (!saved.ok) { db.providers = before; return saved; }
    ctx.logger.info(`[排序] 已更新服务商显示顺序（${want.length} 个）`);
    ctx.send('state-changed', ctx.publicState());
    return { ok: true };
  });
}

module.exports = { register, buildProviderInput, applyProviderPatch };
