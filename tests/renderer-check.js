'use strict';
// 渲染层加载校验：真实创建 BrowserWindow 载入 index.html，
// 验证 CSP 未拦截 ../src/durfmt.js，且 window.durfmt / fmtDuration 可用。
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const msgs = [];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.on('console-message', (_e, level, message) => {
    msgs.push({ level, message });
  });

  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const probe = await win.webContents.executeJavaScript(`(() => ({
    hasDurfmt: typeof window.durfmt === 'object' && window.durfmt !== null,
    fmtOK: (() => { try { return window.durfmt.formatDuration(5400); } catch (e) { return 'ERR:' + e.message; } })(),
    unitsLen: (() => { try { return window.durfmt.EDITABLE_UNITS.length; } catch (e) { return -1; } })(),
    fromSec: (() => { try { return JSON.stringify(window.durfmt.fromSeconds(3600)); } catch (e) { return 'ERR'; } })(),
    unitSelectFilled: (() => { const s = document.querySelector('#fIntervalUnit'); return s ? s.options.length : -1; })(),
    navCount: document.querySelectorAll('.nav-item, [data-view]').length
  }))()`);

  const csp = msgs.filter((m) => /Content Security Policy|Refused to load/i.test(m.message));
  const errs = msgs.filter((m) => m.level >= 2);

  const checks = [
    ['window.durfmt 已挂载', probe.hasDurfmt],
    ['formatDuration(5400) = 1 时 30 分', probe.fmtOK === '1 时 30 分'],
    ['EDITABLE_UNITS 有 7 个单位', probe.unitsLen === 7],
    ['fromSeconds(3600) = hour', probe.fromSec === '{"value":1,"unit":"hour"}'],
    ['单位下拉已填充', probe.unitSelectFilled === 7],
    ['CSP 未拦截任何资源', csp.length === 0]
  ];

  for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
  console.log('probe:', JSON.stringify(probe));
  if (csp.length) for (const m of csp) console.log('  CSP>', m.message);
  if (errs.length) {
    console.log(`渲染层 error 级日志 ${errs.length} 条：`);
    for (const m of errs.slice(0, 12)) console.log('  ERR>', String(m.message).slice(0, 220));
  }

  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(failed === 0 ? 'RENDERER-CHECK-OK' : 'RENDERER-CHECK-FAILED');
  app.exit(failed === 0 ? 0 : 1);
}).catch((e) => { console.error('RENDERER-CHECK-ERROR', e); app.exit(1); });
