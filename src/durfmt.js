'use strict';

/**
 * 周期时长工具：单位换算 + 智能格式化
 * 存储统一为秒（intervalSec），展示时按数值大小选择合适单位。
 */

// 单位定义：秒数因子（月按 30 天、年按 365 天，与常见监控工具惯例一致）
const UNITS = [
  { key: 'sec',  label: '秒',  factor: 1 },
  { key: 'min',  label: '分',  factor: 60 },
  { key: 'hour', label: '时',  factor: 3600 },
  { key: 'day',  label: '天',  factor: 86400 },
  { key: 'week', label: '周',  factor: 604800 },
  { key: 'month', label: '月', factor: 2592000 },
  { key: 'year', label: '年',  factor: 31536000 }
];

/** 编辑弹窗可选单位（含较小粒度，供精确配置） */
const EDITABLE_UNITS = UNITS;

/**
 * 智能格式化秒数为人类可读字符串。
 * 规则：先找「最大可用单位」，能整除 → 单级显示；不能整除 → 该单位 + 次级余数两级显示。
 * 例：45→'45 秒'，90→'1 分 30 秒'，3600→'1 时'，5400→'1 时 30 分'，
 *     86400→'1 天'，604800→'1 周'，2592000→'1 月'，31536000→'1 年'，7776000→'3 月'
 * 秒级零头（如 3601→'1 小时'）不展示，符合监控周期场景直觉。
 */
function formatDuration(sec) {
  sec = Math.max(1, Math.round(Number(sec) || 0));
  // 最大可用单位
  let bi = 0;
  for (let i = UNITS.length - 1; i >= 0; i--) {
    if (sec >= UNITS[i].factor) { bi = i; break; }
  }
  const u = UNITS[bi];
  if (sec % u.factor === 0) {
    const v = sec / u.factor;
    if (u.key === 'month' && v % 12 === 0) return `${v / 12} 年`;   // 12 个月 → 1 年
    return `${v} ${u.label}`;
  }
  if (bi === 0) return `${sec} 秒`;
  const major = Math.floor(sec / u.factor);
  const rest = sec % u.factor;
  const next = UNITS[bi - 1];
  const minor = Math.round(rest / next.factor);
  if (minor > 0) return `${major} ${u.label} ${minor} ${next.label}`;
  return `${major} ${u.label}`;
}

/**
 * 把「数值 + 单位」换算为秒（用于保存）。
 * month=30天, year=365天。
 */
function toSeconds(value, unitKey) {
  const u = UNITS.find((x) => x.key === unitKey) || UNITS[0];
  return Math.max(5, Math.round((Number(value) || 0) * u.factor));
}

/**
 * 从秒数反推「数值 + 单位」（用于编辑回填）。
 * 优先选择能整除的最大单位；都不能整除则用秒。
 */
function fromSeconds(sec) {
  sec = Math.max(1, Math.round(Number(sec) || 0));
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const u = UNITS[i];
    if (sec >= u.factor && sec % u.factor === 0) {
      // 12 个月 → 1 年
      if (u.key === 'month' && (sec / u.factor) % 12 === 0) return { value: sec / 31536000, unit: 'year' };
      return { value: sec / u.factor, unit: u.key };
    }
  }
  return { value: sec, unit: 'sec' };
}

module.exports = { UNITS, EDITABLE_UNITS, formatDuration, toSeconds, fromSeconds };
