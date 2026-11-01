'use strict';
/**
 * 状态报告生成（CSV / 自包含 HTML / Excel）。
 * 从 main.js 迁出的纯函数模块：输入 history.summarize 的结果，输出字符串或 Buffer。
 */

/** 状态中英文映射（日志与报告文案用） */
function statusText(s) {
  return { up: '在线', degraded: '异常', down: '离线', authfail: '鉴权失败', unknown: '待检测' }[s] || s;
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtMs(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
}

/** 状态报告：CSV */
function buildReportCSV(sum) {
  const head = ['服务商', '样本数', '可用率(%)', '在线次数', '异常次数', '离线次数', '鉴权失败次数', '累计故障时长', '故障次数', 'MTTR', '最长故障', '平均延迟(ms)', 'P50(ms)', 'P95(ms)', '最大延迟(ms)', '最后状态'];
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = '\t' + s;   // 公式注入防护
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = sum.perProvider.map((p) => [
    p.name, p.samples, p.uptime, p.upCount, p.degCount, p.downCount,
    p.authCount || 0,
    fmtMs(p.downMs), p.incidents || 0, fmtMs(p.mttrMs), fmtMs(p.maxOutageMs),
    p.latencyAvg ?? '', p.latencyP50 ?? '', p.latencyP95 ?? '', p.latencyMax ?? '', statusText(p.lastStatus)
  ].map(esc).join(','));
  return [head.join(','), ...rows].join('\r\n');
}

/** 状态报告：自包含 HTML（内联样式，可直接发邮件/存档） */
function buildReportHTML(sum) {
  const o = sum.overall;
  const rows = sum.perProvider.map((p) => {
    const color = p.uptime >= 99 ? '#34c759' : p.uptime >= 90 ? '#ff9500' : '#ff3b30';
    return `<tr>
      <td>${escHtml(p.name)}</td>
      <td style="text-align:right">${p.samples}</td>
      <td style="text-align:right;color:${color};font-weight:600">${p.uptime}%</td>
      <td style="text-align:right">${p.upCount}/${p.degCount}/${p.downCount}</td>
      <td style="text-align:right">${p.authCount || 0}</td>
      <td style="text-align:right">${fmtMs(p.downMs)}</td>
      <td style="text-align:right">${p.incidents || 0}</td>
      <td style="text-align:right">${fmtMs(p.mttrMs)}</td>
      <td style="text-align:right">${fmtMs(p.maxOutageMs)}</td>
      <td style="text-align:right">${p.latencyAvg ?? '—'}</td>
      <td style="text-align:right">${p.latencyP95 ?? '—'}</td>
      <td>${statusText(p.lastStatus)}</td>
    </tr>`;
  }).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>AI Provider Monitor 状态报告</title></head>
<body style="font-family:-apple-system,'Segoe UI',sans-serif;background:#f2f2f7;margin:0;padding:32px;color:#1c1c1e">
<div style="max-width:1000px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.06)">
  <h1 style="margin:0 0 6px;font-size:24px">AI Provider 状态报告</h1>
  <p style="margin:0 0 24px;color:#8e8e93;font-size:13px">统计区间：最近 ${sum.rangeHours} 小时 · 生成于 ${new Date().toLocaleString('zh-CN')}</p>
  <div style="display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap">
    <div style="flex:1;min-width:150px;background:#f2f2f7;border-radius:12px;padding:16px">
      <div style="font-size:12px;color:#8e8e93">整体可用率</div>
      <div style="font-size:28px;font-weight:700">${o.uptime}%</div></div>
    <div style="flex:1;min-width:150px;background:#f2f2f7;border-radius:12px;padding:16px">
      <div style="font-size:12px;color:#8e8e93">服务商数</div>
      <div style="font-size:28px;font-weight:700">${o.providers}</div></div>
    <div style="flex:1;min-width:150px;background:#f2f2f7;border-radius:12px;padding:16px">
      <div style="font-size:12px;color:#8e8e93">检测样本</div>
      <div style="font-size:28px;font-weight:700">${o.samples}</div></div>
    <div style="flex:1;min-width:150px;background:#f2f2f7;border-radius:12px;padding:16px">
      <div style="font-size:12px;color:#8e8e93">延迟 P95</div>
      <div style="font-size:28px;font-weight:700">${o.latencyP95 ?? '—'}<span style="font-size:14px"> ms</span></div></div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#f2f2f7">
      <th style="text-align:left;padding:10px">服务商</th>
      <th style="text-align:right;padding:10px">样本</th>
      <th style="text-align:right;padding:10px">可用率</th>
      <th style="text-align:right;padding:10px">在线/异常/离线</th>
      <th style="text-align:right;padding:10px">鉴权失败</th>
      <th style="text-align:right;padding:10px">故障时长</th>
      <th style="text-align:right;padding:10px">故障次数</th>
      <th style="text-align:right;padding:10px">MTTR</th>
      <th style="text-align:right;padding:10px">最长故障</th>
      <th style="text-align:right;padding:10px">平均延迟</th>
      <th style="text-align:right;padding:10px">P95</th>
      <th style="text-align:left;padding:10px">最后状态</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="12" style="padding:24px;text-align:center;color:#8e8e93">暂无数据</td></tr>'}</tbody>
  </table>
</div></body></html>`;
}

/** 状态报告：Excel（总览 + 服务商明细双表；exceljs 懒加载） */
async function buildReportXLSX(sum) {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); }
  catch (e) { throw new Error('未安装 exceljs 依赖，无法导出 Excel（请运行 npm install）'); }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI Provider Monitor';
  const o = sum.overall;
  const s1 = wb.addWorksheet('总览');
  s1.columns = [{ header: '指标', key: 'k', width: 18 }, { header: '数值', key: 'v', width: 26 }];
  s1.addRows([
    { k: '统计区间', v: `最近 ${sum.rangeHours} 小时` },
    { k: '生成时间', v: new Date().toLocaleString('zh-CN') },
    { k: '整体可用率', v: `${o.uptime}%` },
    { k: '服务商数', v: o.providers },
    { k: '检测样本', v: o.samples },
    { k: '延迟 P95(ms)', v: o.latencyP95 ?? '—' }
  ]);
  const s2 = wb.addWorksheet('服务商明细');
  s2.columns = [
    { header: '服务商', key: 'name', width: 24 },
    { header: '样本数', key: 'samples', width: 10 },
    { header: '可用率(%)', key: 'uptime', width: 12 },
    { header: '在线次数', key: 'upCount', width: 10 },
    { header: '异常次数', key: 'degCount', width: 10 },
    { header: '离线次数', key: 'downCount', width: 10 },
    { header: '鉴权失败', key: 'authCount', width: 10 },
    { header: '累计故障时长', key: 'downFor', width: 16 },
    { header: '故障次数', key: 'incidents', width: 10 },
    { header: 'MTTR', key: 'mttr', width: 14 },
    { header: '最长故障', key: 'maxOutage', width: 14 },
    { header: '平均延迟(ms)', key: 'latencyAvg', width: 14 },
    { header: 'P50(ms)', key: 'latencyP50', width: 10 },
    { header: 'P95(ms)', key: 'latencyP95', width: 10 },
    { header: '最大延迟(ms)', key: 'latencyMax', width: 14 },
    { header: '最后状态', key: 'lastStatus', width: 10 }
  ];
  for (const p of sum.perProvider) {
    s2.addRow({
      name: p.name, samples: p.samples, uptime: p.uptime,
      upCount: p.upCount, degCount: p.degCount, downCount: p.downCount,
      authCount: p.authCount || 0,
      downFor: fmtMs(p.downMs), incidents: p.incidents || 0,
      mttr: fmtMs(p.mttrMs), maxOutage: fmtMs(p.maxOutageMs),
      latencyAvg: p.latencyAvg ?? '', latencyP50: p.latencyP50 ?? '',
      latencyP95: p.latencyP95 ?? '', latencyMax: p.latencyMax ?? '', lastStatus: statusText(p.lastStatus)
    });
  }
  s1.getRow(1).font = { bold: true };
  s2.getRow(1).font = { bold: true };
  return wb.xlsx.writeBuffer();
}

module.exports = { statusText, escHtml, fmtMs, buildReportCSV, buildReportHTML, buildReportXLSX };
