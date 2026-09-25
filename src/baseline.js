'use strict';

/**
 * 可用模型基线差集。
 * baseline 只保留最近确认仍可用的模型：
 * - 本轮不可用，或已从清单消失：记为失去，并从基线删除，避免每轮重复误报
 * - 未探测的模型留在基线里，不记失去
 * - 状态翻转不在这里处理，避免绕过故障消抖
 */
function diffBaseline(baselineArr, { available = [], unavailable = [], unprobed = [], firstCheck = false, skip = false } = {}) {
  const kept = (Array.isArray(baselineArr) ? baselineArr : []).map(String);
  if (skip) return { baseline: kept, added: [], lost: [], modelChanged: false };
  const avail = (Array.isArray(available) ? available : []).map(String);
  const unavail = (Array.isArray(unavailable) ? unavailable : []).map(String);
  const unprobedList = (Array.isArray(unprobed) ? unprobed : []).map(String);
  if (firstCheck) {
    return { baseline: [...new Set(avail)], added: [], lost: [], modelChanged: false };
  }
  const baseline = new Set((Array.isArray(baselineArr) ? baselineArr : []).map(String));
  const unSet = new Set(unavail);
  const seen = new Set([...avail, ...unavail, ...unprobedList]);
  const added = avail.filter((m) => !baseline.has(m));
  const lost = [...baseline].filter((m) => unSet.has(m) || !seen.has(m));
  for (const m of lost) baseline.delete(m);
  for (const m of added) baseline.add(m);
  return {
    baseline: [...baseline],
    added,
    lost,
    modelChanged: added.length > 0 || lost.length > 0
  };
}

module.exports = { diffBaseline };
