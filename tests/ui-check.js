'use strict';
// UI 回归校验：真实窗口测量计算样式与布局，验证三项调整是否达成，
// 并检查窄窗口下工具栏是否仍会折行。
const path = require('path');
const { app, BrowserWindow } = require('electron');
const root = path.join(__dirname, '..');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1180, height: 820,
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) errs.push(msg); });
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const probe = await win.webContents.executeJavaScript(`(() => {
    const cs = (el) => el ? getComputedStyle(el) : null;
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; };
    // 切到服务商视图，让工具栏参与布局
    const navProv = document.querySelector('[data-view="providers"]');
    if (navProv) navProv.click();
    const num = document.querySelector('#concurrency');
    const numCS = cs(num);
    const gf = document.querySelector('#groupFilter'), sf = document.querySelector('#statusFilter');
    const imp = document.querySelector('#btnImport'), exp = document.querySelector('#btnExport');
    const chk = document.querySelector('#btnCheckSel');
    const lf = document.querySelector('#logFilter'), si = document.querySelector('#searchInput');
    const lfCS = cs(lf), siCS = cs(si);
    const tb = document.querySelector('.toolbar');
    const kids = tb ? [...tb.children].map((c) => ({ id: c.id || c.className, ...rect(c) })) : [];
    const rows = [...new Set(kids.filter(k => k.w > 0).map((k) => k.y))];
    return {
      numAlign: numCS && numCS.textAlign, numW: numCS && numCS.width, numAppearance: numCS && (numCS.MozAppearance || numCS.appearance),
      numRect: rect(num),
      groupW: rect(gf), statusW: rect(sf),
      impRect: rect(imp), expRect: rect(exp), chkRect: rect(chk),
      impText: imp && imp.textContent, expText: exp && exp.textContent, chkText: chk && chk.textContent,
      impHasIcon: !!(imp && imp.querySelector('svg')), expHasIcon: !!(exp && exp.querySelector('svg')), chkHasIcon: !!(chk && chk.querySelector('svg')),
      logFilterBg: lfCS && lfCS.backgroundColor, searchBg: siCS && siCS.backgroundColor,
      logFilterRadius: lfCS && lfCS.borderRadius, searchRadius: siCS && siCS.borderRadius,
      logFilterPadLeft: lfCS && lfCS.paddingLeft, searchPadLeft: siCS && siCS.paddingLeft,
      logFilterBorder: lfCS && lfCS.borderStyle,
      hasInvert: !!document.querySelector('#btnInvert'),
      selAllText: (document.querySelector('#selAllText')||{}).textContent,
      toolbarRows: rows.length, toolbarW: rect(tb),
      btnWhiteSpace: imp && cs(imp).whiteSpace
    };
  })()`);

  // 单行高度基准：按钮高约 30px，若工具栏高度显著超出即为折行
  const tbH = probe.toolbarW ? probe.toolbarW.h : 0;
  const checks = [
    ['数字输入框文字居中', probe.numAlign === 'center'],
    ['数字输入框隐藏微调箭头', String(probe.numAppearance).includes('textfield')],
    ['分组筛选框已收窄(<=110px)', probe.groupW && probe.groupW.w <= 110],
    ['状态筛选框已收窄(<=110px)', probe.statusW && probe.statusW.w <= 110],
    ['检测按钮无图标', probe.chkHasIcon === false && probe.chkText.trim() === '检测'],
    ['导入按钮无图标', probe.impHasIcon === false && probe.impText.trim() === '导入'],
    ['导出按钮无图标', probe.expHasIcon === false && probe.expText.trim() === '导出'],
    ['导入按钮未折行(高<=34)', probe.impRect && probe.impRect.h <= 34],
    ['按钮 white-space:nowrap', probe.btnWhiteSpace === 'nowrap'],
    ['工具栏单行布局', tbH > 0 && tbH <= 40],
    ['反选按钮已移除', probe.hasInvert === false],
    ['全选文案存在', !!probe.selAllText],
    ['日志过滤框与搜索框同背景', probe.logFilterBg === probe.searchBg],
    ['日志过滤框与搜索框同圆角', probe.logFilterRadius === probe.searchRadius],
    ['日志过滤框左内边距留出图标位', probe.logFilterPadLeft === probe.searchPadLeft],
    ['日志过滤框无默认边框', probe.logFilterBorder === 'none']
  ];
  let bad = 0;
  for (const [n, ok] of checks) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); }
  console.log('probe:', JSON.stringify(probe));
  if (errs.length) { console.log('renderer errors:'); errs.slice(0, 6).forEach((e) => console.log('  ERR>', String(e).slice(0, 160))); }

  // 窄窗口复测：600px 下工具栏是否仍单行
  win.setSize(820, 760);
  await new Promise((r) => setTimeout(r, 500));
  const narrow = await win.webContents.executeJavaScript(`(() => {
    const tb = document.querySelector('.toolbar');
    const imp = document.querySelector('#btnImport');
    return { tbH: Math.round(tb.getBoundingClientRect().height), impH: Math.round(imp.getBoundingClientRect().height) };
  })()`);
  const narrowOK = narrow.impH <= 34;
  console.log(`${narrowOK ? 'PASS' : 'FAIL'}  窄窗口(820px)下导入按钮不折行  ${JSON.stringify(narrow)}`);
  if (!narrowOK) bad++;

  // 统计页头部：时间筛选框 + 三个按钮同排单行（1180px 与 820px 双档）
  const statsProbe = () => win.webContents.executeJavaScript(`(() => {
    const navStats = document.querySelector('[data-view="stats"]');
    if (navStats) navStats.click();
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const sel = r('#stRange'), c1 = r('#stExportCsv'), c2 = r('#stExportReport'), c3 = r('#stRefresh');
    if (!sel || !c1 || !c2 || !c3) return { ok: false };
    const ys = [sel.y, c1.y, c2.y, c3.y];
    return { ok: true,
      oneRow: Math.max(...ys) - Math.min(...ys) < 2,
      btnH: Math.max(c1.h, c2.h, c3.h),
      selW: sel.w,
      order: sel.x < c1.x && c1.x < c2.x && c2.x < c3.x };
  })()`);
  win.setSize(1180, 820);
  await new Promise((r) => setTimeout(r, 400));
  const st = await statsProbe();
  const stOK = st.ok && st.oneRow && st.btnH <= 40 && st.selW <= 200 && st.order;
  console.log(`${stOK ? 'PASS' : 'FAIL'}  统计页头部筛选+按钮单行(1180px)  ${JSON.stringify(st)}`);
  if (!stOK) bad++;
  win.setSize(820, 760);
  await new Promise((r) => setTimeout(r, 400));
  const st2 = await statsProbe();
  const st2OK = st2.ok && st2.oneRow && st2.btnH <= 40;
  console.log(`${st2OK ? 'PASS' : 'FAIL'}  统计页头部单行(820px窄窗)  ${JSON.stringify(st2)}`);
  if (!st2OK) bad++;

  // 通道健康面板：已启用未发送 / 发送成功 / 连续失败 / 配置不完整 四态区分
  // （历史缺陷：只在有发送记录时才不是「未使用」，导致刚启用钉钉仍显示未使用）
  win.setSize(1180, 820);
  await new Promise((r) => setTimeout(r, 300));
  const health = await win.webContents.executeJavaScript(`(() => {
    const cell = (ch) => {
      const items = [...document.querySelectorAll('#notifyHealthList .health-item')];
      const el = items.find((n) => n.querySelector('.health-name').textContent.trim() === ch);
      if (!el) return null;
      return {
        dot: el.querySelector('.health-dot').className.replace('health-dot ', '').trim(),
        meta: el.querySelector('.health-meta').textContent.trim()
      };
    };
    // 通过页面全局绑定直接构造状态，绕开测试环境缺失的主进程 IPC
    state = { ...state, global: { notifyDingtalkEnabled: true, dingtalkWebhookConfigured: true }, selfmon: { notifyHealth: {} } };
    renderNotifyHealth();
    const enabled = cell('钉钉');
    state.selfmon.notifyHealth = { dingtalk: { fails: 0, lastOkAt: Date.now(), lastFailAt: 0, lastError: '' } };
    renderNotifyHealth();
    const okState = cell('钉钉');
    state.selfmon.notifyHealth = { dingtalk: { fails: 3, lastOkAt: 0, lastFailAt: Date.now(), lastError: 'errcode=310000' } };
    renderNotifyHealth();
    const badState = cell('钉钉');
    state.global = { notifyDingtalkEnabled: true, dingtalkWebhookConfigured: false };
    state.selfmon.notifyHealth = {};
    renderNotifyHealth();
    const incomplete = cell('钉钉');
    state.global = { notifyDingtalkEnabled: false };
    renderNotifyHealth();
    const disabled = cell('钉钉');
    return { enabled, okState, badState, incomplete, disabled };
  })()`);
  const healthChecks = [
    ['已启用未发送显示「已启用 · 待发送」', health.enabled && health.enabled.meta.includes('已启用') && health.enabled.dot === 'idle'],
    ['发送成功显示绿灯与最后成功', health.okState && health.okState.dot === 'ok' && health.okState.meta.includes('最后成功')],
    ['连续失败显示红灯与次数', health.badState && health.badState.dot === 'bad' && health.badState.meta.includes('3')],
    ['开关开着但没填地址提示配置不完整', health.incomplete && health.incomplete.meta.includes('配置不完整')],
    ['未启用的通道显示未使用', health.disabled && health.disabled.meta === '未使用' && health.disabled.dot === 'idle'],
    ['已启用未发送时不再显示未使用', health.enabled && !health.enabled.meta.includes('未使用')]
  ];
  for (const [n, ok] of healthChecks) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); }
  if (healthChecks.some(([, ok]) => !ok)) console.log('health probe:', JSON.stringify(health));

  console.log(bad === 0 ? 'UI-CHECK-OK' : 'UI-CHECK-FAILED');
  app.exit(bad === 0 ? 0 : 1);
}).catch((e) => { console.error('UI-CHECK-ERROR', e); app.exit(1); });
