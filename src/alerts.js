'use strict';
const logger = require('./logger');

/**
 * 告警策略引擎。
 *
 * - 连续失败消抖：连续 failThreshold 轮非 up 才触发故障告警
 * - 恢复通知：故障态恢复为 up 时推送一条恢复消息
 * - 静默时段 / 维护窗口 / 冷却：当时不推送，但不把本轮记成已告警
 *   窗口结束后若故障仍在，下一轮补发一次，不会把窗口内每一轮都补发
 * - 模型变动告警：受静默/冷却约束，不承担故障消抖
 *
 * 运行态优先在内存；同时写回 provider.alertRuntime，随 providers.json 落盘，重启后可恢复。
 */

const DEFAULTS = {
  alertFailThreshold: 2,
  alertRecoverNotify: true,
  alertCooldownMin: 10,
  alertQuietEnabled: false,
  alertQuietStart: '23:00',
  alertQuietEnd: '07:00',
  alertOnModelChange: true,
  alertEscalateMin: 0,
  latencyAlertEnabled: false,
  latencyAlertMs: 5000,
  latencyAlertConsecutive: 3
};

const runtime = new Map();

function freshState() {
  return { consecutiveFail: 0, inAlarm: false, latencyHigh: 0, lastSent: {}, pending: {} };
}

function stateOf(id) {
  if (!runtime.has(id)) runtime.set(id, freshState());
  return runtime.get(id);
}

function bindState(provider) {
  const id = provider && provider.id;
  if (runtime.has(id)) return runtime.get(id);
  const saved = provider && provider.alertRuntime;
  const st = freshState();
  if (saved && typeof saved === 'object') {
    const n = Number(saved.consecutiveFail);
    st.consecutiveFail = Number.isFinite(n) && n > 0 ? n : 0;
    const lh = Number(saved.latencyHigh);
    st.latencyHigh = Number.isFinite(lh) && lh > 0 ? lh : 0;
    st.inAlarm = Boolean(saved.inAlarm);
    if (saved.pending && typeof saved.pending === 'object') st.pending = JSON.parse(JSON.stringify(saved.pending));
    if (saved.lastSent && typeof saved.lastSent === 'object') st.lastSent = { ...saved.lastSent };
  }
  runtime.set(id, st);
  return st;
}

function writeState(provider, st) {
  if (!provider) return;
  provider.alertRuntime = {
    consecutiveFail: st.consecutiveFail,
    inAlarm: Boolean(st.inAlarm),
    latencyHigh: st.latencyHigh || 0,
    pending: JSON.parse(JSON.stringify(st.pending || {})),
    lastSent: { ...st.lastSent }
  };
}

function resetState(id) { if (id == null) runtime.clear(); else runtime.delete(id); }

function cfg(globalCfg, key) {
  const v = globalCfg ? globalCfg[key] : undefined;
  return v === undefined || v === null || v === '' ? DEFAULTS[key] : v;
}

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function inQuietHours(globalCfg, now = new Date()) {
  if (!cfg(globalCfg, 'alertQuietEnabled')) return false;
  const start = parseHM(cfg(globalCfg, 'alertQuietStart'));
  const end = parseHM(cfg(globalCfg, 'alertQuietEnd'));
  if (start == null || end == null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

function inMaintWindow(provider, now = new Date()) {
  if (!provider || !provider.maintEnabled) return false;
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dates = String(provider.maintDates || '').split(',').map((s) => s.trim()).filter(Boolean);
  const weekdays = Array.isArray(provider.maintWeekdays) ? provider.maintWeekdays.map(Number) : [];
  if (dates.length && !dates.includes(date)) return false;
  if (weekdays.length && !weekdays.includes(now.getDay())) return false;
  const start = parseHM(provider.maintStart);
  const end = parseHM(provider.maintEnd);
  if (start == null || end == null || start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

let eventSequence = 0;
function queueAlert(st, kind, title, reason, extra = {}) {
  if (!st.pending[kind]) {
    st.pending[kind] = { kind, title, reason, eventId: `${Date.now()}-${++eventSequence}`, delivered: [], attempts: 0, nextRetryAt: 0, ...extra };
  } else if (kind === 'modelChange') {
    const pending = st.pending[kind];
    // Coalesce opposite transitions while muted into the final net change.
    const added = new Set(pending.added || []), lost = new Set(pending.lost || []);
    for (const id of extra.added || []) { if (!lost.delete(id)) added.add(id); }
    for (const id of extra.lost || []) { if (!added.delete(id)) lost.add(id); }
    pending.added = [...added]; pending.lost = [...lost];
    pending.reason = reason;
    if (pending.presented) {
      pending.eventId = `${Date.now()}-${++eventSequence}`; pending.delivered = [];
      pending.presented = false; pending.attempts = 0; pending.nextRetryAt = 0;
    }
    if (!added.size && !lost.size && ((extra.added || []).length || (extra.lost || []).length)) delete st.pending[kind];
  }
}

/** Evaluation creates durable pending events; delivery is committed separately. */
function evaluate(globalCfg, provider, prev, { modelChanged = false, firstCheck = false, now = null, added = [], lost = [], deliveryOnly = false } = {}) {
  const st = bindState(provider), at = now || new Date(), timestamp = at.getTime();
  const suppressed = [], output = [];
  const isUp = provider.status === 'up';
  if (!deliveryOnly) st.consecutiveFail = isUp ? 0 : st.consecutiveFail + 1;
  if (firstCheck) { writeState(provider, st); return { alerts: output, suppressed, consecutiveFail: st.consecutiveFail, inAlarm: st.inAlarm }; }
  const failKind = provider.status === 'authfail' ? 'authfail' : 'down';
  const threshold = Math.max(1, Number(cfg(globalCfg, 'alertFailThreshold')) || 1);
  if (!deliveryOnly && !isUp) {
    delete st.pending.recover;
    delete st.pending[failKind === 'down' ? 'authfail' : 'down'];
    if (st.consecutiveFail >= threshold && !st.inAlarm) {
      queueAlert(st, failKind, failKind === 'authfail' ? '密钥失效' : '服务异常',
        `连续 ${st.consecutiveFail} 轮检测未恢复（当前 ${provider.status}）${provider.lastError ? '：' + provider.lastError : ''}`);
    }
    const escalation = Number(cfg(globalCfg, 'alertEscalateMin')) || 0;
    if (st.inAlarm && escalation > 0 && timestamp - Math.max(st.lastSent.down || 0, st.lastSent.authfail || 0) >= escalation * 60000) {
      queueAlert(st, failKind, '服务异常（持续未恢复）', `故障持续未恢复（当前 ${provider.status}）${provider.lastError ? '：' + provider.lastError : ''}`);
    }
  } else if (!deliveryOnly) {
    delete st.pending.down; delete st.pending.authfail;
    if (st.inAlarm) {
      if (cfg(globalCfg, 'alertRecoverNotify')) queueAlert(st, 'recover', '服务恢复', `已恢复在线，可用模型 ${(provider.modelsAvailable || []).length}/${provider.modelsTotal || 0}`);
      else { st.inAlarm = false; delete st.pending.recover; }
    }
  }
  const latBad = cfg(globalCfg, 'latencyAlertEnabled') && isUp && Number(provider.latency) >= Number(cfg(globalCfg, 'latencyAlertMs'));
  if (!deliveryOnly) st.latencyHigh = latBad ? st.latencyHigh + 1 : 0;
  if (!deliveryOnly && latBad && st.latencyHigh >= Math.max(1, Number(cfg(globalCfg, 'latencyAlertConsecutive')) || 1)) {
    queueAlert(st, 'latency', '延迟劣化', `连续 ${st.latencyHigh} 轮连接延迟超阈值（当前 ${provider.latency} ms）`);
  } else if (!latBad) delete st.pending.latency;
  if (modelChanged && cfg(globalCfg, 'alertOnModelChange') && provider.notifyOnModelChange) {
    queueAlert(st, 'modelChange', '模型变动', '可用模型集合发生变化', { added, lost });
  }
  if (!cfg(globalCfg, 'alertOnModelChange') || !provider.notifyOnModelChange) delete st.pending.modelChange;
  if (!deliveryOnly && provider.quotaWarning) queueAlert(st, 'quota', '配额不足', `当前剩余 ${provider.quotaRemaining}，告警阈值 ${provider.quotaWarnBelow}`);
  else if (!provider.quotaWarning) delete st.pending.quota;
  const muted = inMaintWindow(provider, at) ? '维护窗口' : inQuietHours(globalCfg, at) ? '静默时段' : '';
  for (const pending of Object.values(st.pending)) {
    const cooldown = pending.attempts > 0 || ['down', 'authfail', 'recover'].includes(pending.kind) ? 0 : Math.max(0, Number(cfg(globalCfg, 'alertCooldownMin')) || 0) * 60000;
    const why = muted || (timestamp - (st.lastSent[pending.kind] || 0) < cooldown ? '冷却中' : '')
      || (pending.nextRetryAt > timestamp ? '等待重试' : '');
    if (why) suppressed.push({ kind: pending.kind, why });
    else { output.push({ ...pending, isNew: !pending.presented }); pending.presented = true; }
  }
  writeState(provider, st);
  return { alerts: output, suppressed, consecutiveFail: st.consecutiveFail, inAlarm: st.inAlarm };
}

function noteDelivery(provider, alert, result, timestamp = Date.now()) {
  const st = bindState(provider), pending = st.pending[alert.kind];
  const delivered = result && Array.isArray(result.delivered) ? result.delivered : [];
  if (!pending || pending.eventId !== alert.eventId) {
    // A slow fault delivery may complete after the next sample already recovered.
    // Retain that acknowledgement so recipients also receive a recovery.
    if (delivered.length && ['down', 'authfail'].includes(alert.kind)) {
      st.inAlarm = true; st.lastSent[alert.kind] = timestamp;
      if (provider.status === 'up') queueAlert(st, 'recover', '服务恢复', '故障通知送达时服务已恢复在线');
      writeState(provider, st);
    }
    return;
  }
  pending.delivered = [...new Set([...(pending.delivered || []), ...delivered])];
  if (delivered.length) {
    st.lastSent[alert.kind] = timestamp;
    if (['down', 'authfail'].includes(alert.kind)) st.inAlarm = true;
  }
  if (result && (result.complete === true || result.attempted > 0 && !(result.failed || []).length)) {
    if (alert.kind === 'recover' && provider.status === 'up') st.inAlarm = false;
    delete st.pending[alert.kind];
  } else {
    pending.attempts++;
    pending.nextRetryAt = timestamp + Math.min(300000, 30000 * Math.pow(2, Math.min(4, pending.attempts - 1)));
    logger.warn(`[告警] [${provider.name}] ${alert.title} 尚未全部送达，保留待发送事件`);
  }
  writeState(provider, st);
}
function retryPending(provider) {
  const st = bindState(provider);
  for (const pending of Object.values(st.pending)) pending.nextRetryAt = 0;
  writeState(provider, st);
}
module.exports = { evaluate, noteDelivery, retryPending, inQuietHours, inMaintWindow, resetState, stateOf, DEFAULTS, parseHM };
