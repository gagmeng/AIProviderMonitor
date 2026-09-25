'use strict';
const logger = require('./logger');

/**
 * 告警策略引擎。
 *
 * 解决原实现「一有变动立刻推送」带来的噪声问题，提供：
 * - 连续失败消抖：连续 failThreshold 轮非 up 才触发故障告警
 * - 恢复通知：故障态恢复为 up 时推送一条恢复消息
 * - 静默时段：跨零点区间（如 23:00-07:00）内不推送
 * - 冷却去重：同一服务商同一类告警在 cooldownMin 内不重复推送
 * - 模型变动告警：沿用原语义，但同样受静默/冷却约束
 *
 * 运行态保存在内存 Map 中（进程级），不落盘。
 */

const DEFAULTS = {
  alertFailThreshold: 2,     // 连续 N 轮非 up 才告警
  alertRecoverNotify: true,  // 恢复时通知
  alertCooldownMin: 10,      // 同类告警冷却分钟
  alertQuietEnabled: false,
  alertQuietStart: '23:00',
  alertQuietEnd: '07:00',
  alertOnModelChange: true   // 模型变动是否告警（全局开关，与 provider.notifyOnModelChange 取与）
};

/** 每个 provider 的运行态：连续失败计数、当前是否处于故障告警态、各类告警上次推送时间 */
const runtime = new Map();

function stateOf(id) {
  if (!runtime.has(id)) {
    runtime.set(id, { consecutiveFail: 0, inAlarm: false, lastSent: {} });
  }
  return runtime.get(id);
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

/** 是否处于静默时段（支持跨零点区间） */
function inQuietHours(globalCfg, now = new Date()) {
  if (!cfg(globalCfg, 'alertQuietEnabled')) return false;
  const start = parseHM(cfg(globalCfg, 'alertQuietStart'));
  const end = parseHM(cfg(globalCfg, 'alertQuietEnd'));
  if (start == null || end == null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

/**
 * 是否处于该服务商的维护窗口（支持跨零点区间）。
 * 维护窗口内：故障/恢复/模型变动告警全部抑制（仅记 suppressed，不推送）。
 */
function inMaintWindow(provider, now = new Date()) {
  if (!provider || !provider.maintEnabled) return false;
  const start = parseHM(provider.maintStart);
  const end = parseHM(provider.maintEnd);
  if (start == null || end == null || start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

/** 冷却判定：同一 provider 同一 kind 在冷却窗口内只推一次 */
function inCooldown(st, kind, cooldownMin) {
  const last = st.lastSent[kind] || 0;
  return Date.now() - last < Math.max(0, Number(cooldownMin) || 0) * 60000;
}

function markSent(st, kind) { st.lastSent[kind] = Date.now(); }

/**
 * 核心决策：根据本轮检测结果决定要发出哪些告警。
 *
 * @param globalCfg 全局配置
 * @param provider  服务商（含最新状态字段）
 * @param prev      上一轮快照 { status, modelsTotal, modelsAvailable }
 * @param opts      { modelChanged:boolean, firstCheck:boolean }
 * @returns { alerts: [{kind, title, reason}], suppressed: [{kind, why}] }
 *   kind ∈ 'down' | 'authfail' | 'recover' | 'modelChange'
 */
function evaluate(globalCfg, provider, prev, { modelChanged = false, firstCheck = false } = {}) {
  const st = stateOf(provider.id);
  const alerts = [];
  const suppressed = [];
  const quiet = inQuietHours(globalCfg);
  const maint = inMaintWindow(provider);
  const cooldownMin = Number(cfg(globalCfg, 'alertCooldownMin'));
  const threshold = Math.max(1, Number(cfg(globalCfg, 'alertFailThreshold')) || 1);

  const isUp = provider.status === 'up';

  // --- 连续失败计数 ---
  if (isUp) {
    st.consecutiveFail = 0;
  } else {
    st.consecutiveFail++;
  }

  // 首次检测只建立基准，不产生任何告警
  if (firstCheck) {
    st.inAlarm = false;
    return { alerts, suppressed, consecutiveFail: st.consecutiveFail };
  }

  // --- 故障告警（消抖；down 与 authfail 共用计数/冷却，kind 区分展示与文案） ---
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
    }
    // 无论是否实际推送，都进入告警态，避免静默结束后补发一堆历史告警
    st.inAlarm = true;
  }

  // --- 恢复通知 ---
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

  // --- 模型变动告警 ---
  if (modelChanged && cfg(globalCfg, 'alertOnModelChange') && provider.notifyOnModelChange) {
    if (maint) {
      suppressed.push({ kind: 'modelChange', why: '维护窗口' });
    } else if (quiet) {
      suppressed.push({ kind: 'modelChange', why: '静默时段' });
    } else if (inCooldown(st, 'modelChange', cooldownMin)) {
      suppressed.push({ kind: 'modelChange', why: '冷却中' });
    } else {
      alerts.push({ kind: 'modelChange', title: '模型变动', reason: '可用模型集合或状态发生变化' });
      markSent(st, 'modelChange');
    }
  }

  for (const s of suppressed) {
    logger.debug(`[告警] [${provider.name}] ${s.kind} 被抑制（${s.why}）`);
  }
  return { alerts, suppressed, consecutiveFail: st.consecutiveFail };
}

module.exports = { evaluate, inQuietHours, inMaintWindow, resetState, stateOf, DEFAULTS, parseHM };
