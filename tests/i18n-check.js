'use strict';
/**
 * i18n 缺键检查：扫描 renderer 里用到的 key（app.js 的 tx('…') + index.html 的 data-i18n），
 * 与 renderer/i18n.js 词典比对。缺键会让界面在英文模式下回退成中文原文，属于可见缺陷，
 * 因此作为发布前的常驻检查项（npm run i18n-check），发现缺键时退出码非 0。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'renderer/i18n.js'), 'utf8');

const keys = new Set();
const reTx = new RegExp("\\btx\\(\\s*'((?:[^'\\\\]|\\\\.)*)'", 'g');
const reData = new RegExp('data-i18n="([^"]+)"', 'g');
let m;
while ((m = reTx.exec(app))) keys.add(m[1]);
while ((m = reData.exec(html))) keys.add(m[1]);

const missing = [...keys].filter((k) => {
  const esc = k.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return !i18n.includes("'" + esc + "'") && !i18n.includes('"' + k + '"');
});

if (missing.length) {
  console.error(`I18N-CHECK-FAIL: used ${keys.size} keys, missing ${missing.length}`);
  for (const k of missing) console.error(`  - ${k}`);
  process.exit(1);
}
console.log(`I18N-CHECK-OK: ${keys.size} keys, missing 0`);
