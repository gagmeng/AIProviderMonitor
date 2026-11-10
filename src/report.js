'use strict';
/** Shared report schema keeps CSV, HTML and Excel metrics consistent. */
function statusText(s) { return { up: '在线', degraded: '异常', down: '离线', authfail: '鉴权失败', unknown: '待检测' }[s] || s; }
function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const sec = Math.round(Math.abs(ms) / 1000), prefix = ms < 0 ? '−' : '';
  if (sec < 60) return `${prefix}${sec} 秒`;
  if (sec < 3600) return `${prefix}${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${prefix}${Math.floor(sec / 3600)} 时 ${Math.floor(sec % 3600 / 60)} 分`;
}
function sloText(value) { return { met: '已达标', breached: '已超预算', insufficient: '数据不足' }[value] || '数据不足'; }
const COLUMNS = [
  ['服务商', 'name'], ['样本数', 'samples'], ['样本可用率(%)', 'uptime'],
  ['时间加权可用率(%)', 'timeUptime'], ['覆盖率(%)', 'coverage'], ['SLO 目标(%)', 'sloTarget'],
  ['SLO 状态', 'sloMet', sloText], ['允许故障时长', 'allowedDowntimeMs', fmtMs],
  ['已知故障时长', 'downMs', fmtMs], ['未知时长', 'unknownMs', fmtMs], ['剩余错误预算', 'budgetRemainingMs', fmtMs],
  ['预算使用率(%)', 'budgetUsedPercent'], ['在线次数', 'upCount'], ['异常次数', 'degCount'],
  ['离线次数', 'downCount'], ['鉴权失败次数', 'authCount'], ['故障次数', 'incidents'],
  ['已恢复故障次数', 'recoveredIncidents'], ['已恢复 MTTR', 'mttrMs', (v, p) => p.recoveredIncidents ? fmtMs(v) : '—'],
  ['当前故障时长', 'currentOutageMs', fmtMs], ['最长故障', 'maxOutageMs', fmtMs],
  ['平均延迟(ms)', 'latencyAvg'], ['P50(ms)', 'latencyP50'], ['P95(ms)', 'latencyP95'],
  ['最大延迟(ms)', 'latencyMax'], ['最后状态', 'lastStatus', statusText]
];
const values = (p) => COLUMNS.map(([, key, format]) => format ? format(p[key], p) : p[key] ?? '');
function buildReportCSV(sum) {
  const esc = (v) => {
    let text = String(v ?? '');
    if (/^[=+\-@]/.test(text)) text = '\t' + text;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [COLUMNS.map(([label]) => label).map(esc).join(','), ...sum.perProvider.map((p) => values(p).map(esc).join(','))].join('\r\n');
}
function buildReportHTML(sum) {
  const o = sum.overall;
  const rows = sum.perProvider.map((p) => '<tr>' + values(p).map((v) => `<td>${escHtml(v)}</td>`).join('') + '</tr>').join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>AI Provider Monitor 状态报告</title>
  <style>body{font:14px "Segoe UI",sans-serif;margin:32px;color:#202124;background:#f5f6f8}main{background:white;padding:28px;border-radius:16px}.cards{display:flex;gap:24px;flex-wrap:wrap;margin:24px 0}.cards b{display:block;font-size:26px;margin-top:8px}table{border-collapse:collapse;font-size:12px;white-space:nowrap}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:right}td:first-child,th:first-child{text-align:left}th{background:#f2f4f8}.table{overflow:auto}.hint{color:#626b75;line-height:1.7}</style></head>
  <body><main><h1>AI Provider 状态报告</h1><p>统计区间：${escHtml(new Date(sum.from).toLocaleString('zh-CN'))} — ${escHtml(new Date(sum.to).toLocaleString('zh-CN'))}（${sum.rangeHours} 小时）</p>
  <div class="cards"><div>时间加权可用率<b>${o.timeUptime == null ? '—' : o.timeUptime + '%'}</b></div><div>覆盖率<b>${o.coverage ?? 0}%</b></div><div>剩余错误预算（服务商时间合计）<b>${fmtMs(o.budgetRemainingMs)}</b></div><div>未知时长<b>${fmtMs(o.unknownMs)}</b></div><div>检测样本<b>${o.samples}</b></div></div>
  <p class="hint">样本状态最多延续两个计划周期，超时和缺失时段记为未知。时间加权可用率 = 在线时长 / 已观测时长；错误预算 = 完整窗口 × (1 − 目标) − 已知故障时长。数据不足时不确认达标；维护窗口仅抑制通知。MTTR 只包括已恢复故障。旧数据使用相邻样本间隔的中位数估算周期（最多一天）。</p>
  <div class="table"><table><thead><tr>${COLUMNS.map(([label]) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows || '<tr><td>暂无数据</td></tr>'}</tbody></table></div></main></body></html>`;
}
async function buildReportXLSX(sum) {
  const ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook();
  wb.creator = 'AI Provider Monitor';
  const overview = wb.addWorksheet('总览'), o = sum.overall;
  overview.columns = [{ header: '指标', key: 'label', width: 32 }, { header: '数值', key: 'value', width: 40 }];
  overview.addRows([
    ['统计区间', `最近 ${sum.rangeHours} 小时`], ['时间加权可用率(%)', o.timeUptime ?? '—'], ['覆盖率(%)', o.coverage],
    ['样本可用率(%)', o.uptime], ['未知时长', fmtMs(o.unknownMs)], ['剩余错误预算', fmtMs(o.budgetRemainingMs)],
    ['样本状态有效期', '最多两个计划检测周期；之后未知'], ['维护窗口', '仅抑制通知，健康状态仍计入统计'], ['MTTR', '仅已恢复的故障事件']
  ]);
  const detail = wb.addWorksheet('服务商明细');
  detail.columns = COLUMNS.map(([header], i) => ({ header, key: String(i), width: i === 0 ? 26 : 20 }));
  for (const p of sum.perProvider) detail.addRow(values(p));
  for (const sheet of [overview, detail]) { sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: 'frozen', ySplit: 1 }]; }
  return wb.xlsx.writeBuffer();
}
module.exports = { statusText, escHtml, fmtMs, buildReportCSV, buildReportHTML, buildReportXLSX };
