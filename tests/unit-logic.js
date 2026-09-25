'use strict';
// 不依赖 Electron 的逻辑单测。运行：node tests/unit-logic.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-unit-'));
process.env.AIPM_DATA_DIR = TMP;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`);
  }
}

test('scheduler: 月/年周期不会超过 setTimeout 上限', () => {
  const { clampTimerMs, MAX_TIMER_MS } = require('../src/scheduler');
  assert.strictEqual(clampTimerMs(1000), 1000);
  assert.strictEqual(clampTimerMs(0), 0);
  assert.strictEqual(clampTimerMs(2592000 * 1000), MAX_TIMER_MS);
  assert.ok(clampTimerMs(31536000 * 1000) <= 2147483647);
});

test('baseline: 失去只报一次，未探测不报失去，消失要报', () => {
  const { diffBaseline } = require('../src/baseline');
  const first = diffBaseline(['old'], {
    available: ['a', 'b'], unavailable: ['c'], unprobed: [], firstCheck: true
  });
  assert.deepStrictEqual(first.baseline.slice().sort(), ['a', 'b']);
  assert.strictEqual(first.modelChanged, false);

  const lost = diffBaseline(first.baseline, {
    available: ['a'], unavailable: ['b'], unprobed: [], firstCheck: false
  });
  assert.deepStrictEqual(lost.lost, ['b']);
  assert.strictEqual(lost.modelChanged, true);

  const again = diffBaseline(lost.baseline, {
    available: ['a'], unavailable: ['b'], unprobed: [], firstCheck: false
  });
  assert.deepStrictEqual(again.lost, []);
  assert.strictEqual(again.modelChanged, false);

  const gone = diffBaseline(['a', 'b', 'gone'], {
    available: ['a'], unavailable: [], unprobed: ['b'], firstCheck: false
  });
  assert.ok(gone.lost.includes('gone'));
  assert.ok(!gone.lost.includes('b'));
  assert.ok(gone.baseline.includes('a'));
  assert.ok(gone.baseline.includes('b'));
});

test('http: 跨源重定向去掉 Authorization', () => {
  const { headersForRedirect } = require('../src/httpguard');
  const h = headersForRedirect('https://api.example.com/v1/models', 'https://evil.example/x', {
    Authorization: 'Bearer sk', 'Content-Type': 'application/json'
  });
  assert.strictEqual(h.Authorization, undefined);
  assert.strictEqual(h['Content-Type'], 'application/json');
  const same = headersForRedirect('https://api.example.com/v1', 'https://api.example.com/v2', {
    Authorization: 'Bearer sk'
  });
  assert.strictEqual(same.Authorization, 'Bearer sk');
});

test('detector: 自定义探测模板转义模型名', () => {
  const { buildProbeRequest } = require('../src/detector');
  const r = buildProbeRequest('https://x', 'a"b\\c', {
    probeMode: 'custom', probePath: '/p', probeBody: '{"model":"{{model}}"}'
  });
  assert.strictEqual(JSON.parse(r.body).model, 'a"b\\c');
});

test('notifier: 全局代理开关与 QQ 数字 id', () => {
  const { resolveNotifyProxy, oneBotId } = require('../src/notifier');
  assert.strictEqual(resolveNotifyProxy({ useProxy: true }, { proxyEnabled: false, proxyUrl: 'http://p:1' }), '');
  assert.strictEqual(resolveNotifyProxy({ useProxy: true, proxyUrl: 'http://own:2' }, { proxyEnabled: false }), 'http://own:2');
  assert.strictEqual(resolveNotifyProxy({}, { proxyEnabled: true, proxyUrl: 'http://p:1' }), 'http://p:1');
  assert.strictEqual(oneBotId('12345'), 12345);
  assert.strictEqual(oneBotId('not-a-number'), 'not-a-number');
});

test('alerts: 静默不记已告警，结束后补发一次', () => {
  const alerts = require('../src/alerts');
  const id = 88001;
  alerts.resetState(id);
  const provider = { id, name: 'q', status: 'down', lastError: 'x', notifyOnModelChange: false };
  const g = {
    alertFailThreshold: 1, alertQuietEnabled: true, alertQuietStart: '00:00', alertQuietEnd: '12:00',
    alertRecoverNotify: true, alertCooldownMin: 0, alertOnModelChange: false
  };
  const d1 = alerts.evaluate(g, provider, { status: 'up' }, { firstCheck: false, now: new Date(2026, 0, 2, 1, 0) });
  assert.strictEqual(d1.alerts.length, 0);
  assert.strictEqual(d1.inAlarm, false);
  alerts.resetState(id);
  const d2 = alerts.evaluate(g, provider, { status: 'up' }, { firstCheck: false, now: new Date(2026, 0, 2, 13, 0) });
  assert.strictEqual(d2.alerts.length, 1);
  assert.strictEqual(d2.alerts[0].kind, 'down');
  assert.strictEqual(d2.inAlarm, true);
});

test('store: 损坏配置不当成空库，也不改原文件', () => {
  const store = require('../src/store');
  fs.mkdirSync(path.dirname(store.DATA_FILE), { recursive: true });
  fs.writeFileSync(store.DATA_FILE, '{bad', 'utf8');
  assert.throws(() => store.loadAll(), /损坏|覆盖/);
  assert.strictEqual(fs.readFileSync(store.DATA_FILE, 'utf8'), '{bad');
  fs.unlinkSync(store.DATA_FILE);
  const empty = store.loadAll();
  assert.ok(Array.isArray(empty.providers));
  assert.strictEqual(empty.providers.length, 0);
  assert.strictEqual(empty.global.smtpInsecureSkipVerify, false);
});

test('history: 鉴权失败单独计数，且写入后立即可读', () => {
  const history = require('../src/history');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-h-'));
  history.append(dir, { id: 1, name: 'P' }, {
    checkedAt: Date.now(), status: 'authfail', latency: 3,
    modelsTotal: 1, modelsAvailable: [], modelsUnavailable: ['m'], modelsUnprobed: [], error: '401'
  });
  const sum = history.summarize(dir, { hours: 24 });
  assert.strictEqual(sum.overall.samples, 1);
  assert.strictEqual(sum.overall.authCount, 1);
  assert.strictEqual(sum.perProvider[0].authCount, 1);
  assert.strictEqual(sum.perProvider[0].downCount, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
