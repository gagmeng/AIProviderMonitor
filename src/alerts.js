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
  alertOnModelChange: true
};

const runtime = new Map();

function freshState() {
  return { consecutiveFail: 0, inAlarm: false, lastSent: {} };
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

  for (const s of suppressed) {
    logger.debug(`[告警] [${provider.name}] ${s.kind} 被抑制（${s.why}）`);
  }
  writeState(provider, st);
  return { alerts, suppressed, consecutiveFail: st.consecutiveFail, inAlarm: st.inAlarm };
}

module.exports = { evaluate, inQuietHours, inMaintWindow, resetState, stateOf, DEFAULTS, parseHM };
