'use strict';
// 应用启动冒烟测试：由 electron 主进程在 --smoke-test 模式下执行后自动退出
// 用法：electron . --smoke-test
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.AIPM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-app-'));

const { app } = require('electron');

app.whenReady().then(async () => {
  const checks = [];
  const ok = (name, cond) => checks.push({ name, cond: Boolean(cond) });

  ok('app ready', true);
  ok('data dir isolated', process.env.AIPM_DATA_DIR.length > 0);

  // 模块可加载（app-smoke.js 位于 tests/ 下，以 main.js 的 __dirname 为基准）
  const root = path.join(__dirname, '..');
  const store = require(path.join(root, 'src', 'store'));
  ok('store loads', Array.isArray(store.loadAll().providers));
  const { detect } = require(path.join(root, 'src', 'detector'));
  ok('detector loads', typeof detect === 'function');
  const { Scheduler } = require(path.join(root, 'src', 'scheduler'));
  ok('scheduler loads', typeof Scheduler === 'function');
  const notifier = require(path.join(root, 'src', 'notifier'));
  ok('notifier loads', typeof notifier.notifyModelChange === 'function');
  const backup = require(path.join(root, 'src', 'backup'));
  ok('backup loads', typeof backup.exportTo === 'function' && typeof backup.restoreFrom === 'function');

  // 渲染资源存在
  ok('index.html exists', fs.existsSync(path.join(root, 'renderer', 'index.html')));
  ok('styles.css exists', fs.existsSync(path.join(root, 'renderer', 'styles.css')));
  ok('app.js exists', fs.existsSync(path.join(root, 'renderer', 'app.js')));
  ok('icons.js exists', fs.existsSync(path.join(root, 'renderer', 'icons.js')));
  ok('preload exists', fs.existsSync(path.join(root, 'preload.js')));

  const failed = checks.filter((c) => !c.cond);
  for (const c of checks) console.log(`${c.cond ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(failed.length === 0 ? 'APP-SMOKE-OK' : 'APP-SMOKE-FAILED');
  app.exit(failed.length === 0 ? 0 : 1);
}).catch((e) => {
  console.error('APP-SMOKE-ERROR', e);
  app.exit(1);
});
