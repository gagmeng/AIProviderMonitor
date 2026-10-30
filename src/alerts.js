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
  return { consecutiveFail: 0, inAlarm: false, latencyHigh: 0, lastSent: {} };
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
    lastSent: { ...st.lastSent }
  };
}

function resetState(id) { runtime.delete(id); }

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

function inCooldown(st, kind, cooldownMin) {
  const last = st.lastSent[kind] || 0;
  return Date.now() - last < Math.max(0, Number(cooldownMin) || 0) * 60000;
}

function markSent(st, kind) { st.lastSent[kind] = Date.now(); }

/**
 * @param opts.now 测试或补发判定用的当前时间，缺省为现在
 * @returns { alerts, suppressed, consecutiveFail, inAlarm }
 */
function evaluate(globalCfg, provider, prev, { modelChanged = false, firstCheck = false, now = null } = {}) {
  const st = bindState(provider);
  const alerts = [];
  const suppressed = [];
  const at = now || new Date();
  const quiet = inQuietHours(globalCfg, at);
  const maint = inMaintWindow(provider, at);
  const cooldownMin = Number(cfg(globalCfg, 'alertCooldownMin'));
  const threshold = Math.max(1, Number(cfg(globalCfg, 'alertFailThreshold')) || 1);
  const isUp = provider.status === 'up';

  if (isUp) st.consecutiveFail = 0;
  else st.consecutiveFail++;

  if (firstCheck) {
    st.inAlarm = false;
    writeState(provider, st);
    return { alerts, suppressed, consecutiveFail: st.consecutiveFail, inAlarm: st.inAlarm };
  }

  const failKind = provider.status === 'authfail' ? 'authfail' : 'down';
  const failTitle = provider.status === 'authfail' ? '密钥失效' : '服务异常';
  if (!isUp && st.consecutiveFail >= threshold && !st.inAlarm) {
    if (maint) {
      suppressed.push({ kind: failKind, why: '维护窗口' });
    } else if (quiet) {
      suppressed.push({ kind: failKind, why: '静默时段' });
    } else if (inCooldown(st, failKind, cooldownMin)) {
      suppressed.push({ kind: failKind, why: '冷却中' });
    } else {
      alerts.push({
        kind: failKind,
        title: failTitle,
        reason: failKind === 'authfail'
          ? `鉴权失败（API Key 无效或无权限）${provider.lastError ? '：' + provider.lastError : ''}`
          : `连续 ${st.consecutiveFail} 轮检测未恢复（当前 ${provider.status}）${provider.lastError ? '：' + provider.lastError : ''}`
      });
      markSent(st, failKind);
      st.inAlarm = true;
    }
  }

  // 故障升级：故障持续 N 分钟仍未恢复时重复提醒（0 = 关闭），受维护窗口与静默时段约束
  const escalateMin = Math.max(0, Number(cfg(globalCfg, 'alertEscalateMin')) || 0);
  if (!isUp && st.inAlarm && escalateMin > 0 && !alerts.some((a) => a.kind === failKind)) {
    if (maint) {
      suppressed.push({ kind: 'escalate', why: '维护窗口' });
    } else if (quiet) {
      suppressed.push({ kind: 'escalate', why: '静默时段' });
    } else if (Date.now() - (st.lastSent[failKind] || 0) >= escalateMin * 60000) {
      alerts.push({
        kind: failKind,
        title: `${failTitle}（持续未恢复）`,
        reason: `故障已持续超过 ${escalateMin} 分钟仍未恢复（当前 ${provider.status}）${provider.lastError ? '：' + provider.lastError : ''}`
      });
      markSent(st, failKind);
    }
  }

  // 延迟劣化：仅统计在线状态下的连接延迟，连续 N 轮超过阈值才告警；
  // 计数不受静默/维护影响（持续累积），推送仍受冷却约束，劣化持续期间按冷却节奏重复提醒。
  const latMs = Number(provider.latency);
  const latThreshold = Number(cfg(globalCfg, 'latencyAlertMs'));
  const latConsec = Math.max(1, Number(cfg(globalCfg, 'latencyAlertConsecutive')) || 1);
  const latBad = Boolean(cfg(globalCfg, 'latencyAlertEnabled'))
    && isUp && Number.isFinite(latMs) && latMs > 0 && latMs >= latThreshold;
  st.latencyHigh = latBad ? (st.latencyHigh || 0) + 1 : 0;
  if (st.latencyHigh >= latConsec) {
    if (maint) {
      suppressed.push({ kind: 'latency', why: '维护窗口' });
    } else if (quiet) {
      suppressed.push({ kind: 'latency', why: '静默时段' });
    } else if (inCooldown(st, 'latency', cooldownMin)) {
      suppressed.push({ kind: 'latency', why: '冷却中' });
    } else {
      alerts.push({
        kind: 'latency',
        title: '延迟劣化',
        reason: `连续 ${st.latencyHigh} 轮连接延迟 ≥ ${latThreshold} ms（当前 ${latMs} ms）`
      });
      markSent(st, 'latency');
    }
  }

  if (isUp && st.inAlarm) {
    st.inAlarm = false;
    if (!cfg(globalCfg, 'alertRecoverNotify')) {
      suppressed.push({ kind: 'recover', why: '恢复通知已关闭' });
    } else if (maint) {
      suppressed.push({ kind: 'recover', why: '维护窗口' });
    } else if (quiet) {
      suppressed.push({ kind: 'recover', why: '静默时段' });
    } else {
      alerts.push({
        kind: 'recover',
        title: '服务恢复',
        reason: `已恢复在线，可用模型 ${(provider.modelsAvailable || []).length}/${provider.modelsTotal || 0}`
      });
      markSent(st, 'recover');
    }
  }

  if (modelChanged && cfg(globalCfg, 'alertOnModelChange') && provider.notifyOnModelChange) {
    if (maint) {
      suppressed.push({ kind: 'modelChange', why: '维护窗口' });
    } else if (quiet) {
      suppressed.push({ kind: 'modelChange', why: '静默时段' });
    } else if (inCooldown(st, 'modelChange', cooldownMin)) {
      suppressed.push({ kind: 'modelChange', why: '冷却中' });
    } else {
      alerts.push({ kind: 'modelChange', title: '模型变动', reason: '可用模型集合发生变化' });
      markSent(st, 'modelChange');
    }
  }

  if (provider.quotaWarning) {
    if (maint) suppressed.push({ kind: 'quota', why: '维护窗口' });
    else if (quiet) suppressed.push({ kind: 'quota', why: '静默时段' });
    else if (inCooldown(st, 'quota', cooldownMin)) suppressed.push({ kind: 'quota', why: '冷却中' });
    else {
      alerts.push({ kind: 'quota', title: '配额不足', reason: `当前剩余 ${provider.quotaRemaining}，告警阈值 ${provider.quotaWarnBelow}` });
      markSent(st, 'quota');
    }
  }

  for (const s of suppressed) {
    logger.debug(`[告警] [${provider.name}] ${s.kind} 被抑制（${s.why}）`);
  }
  writeState(provider, st);
  return { alerts, suppressed, consecutiveFail: st.consecutiveFail, inAlarm: st.inAlarm };
}

module.exports = { evaluate, inQuietHours, inMaintWindow, resetState, stateOf, DEFAULTS, parseHM };
