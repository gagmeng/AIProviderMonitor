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
// 用例注册表 + 异步执行：history 读取路径异步化后，部分用例需要 await
const testCases = [];
function test(name, fn) { testCases.push([name, fn]); }

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

test('detector: 自定义鉴权头与响应断言', () => {
  const { providerHeaders, assertProbeResponse } = require('../src/detector');
  const h = providerHeaders({ apiKey: 'secret', authType: 'header', authHeader: 'X-Key', authPrefix: 'Token ', customHeaders: '{"X-Tenant":"a"}' });
  assert.strictEqual(h['X-Key'], 'Token secret');
  assert.strictEqual(h['X-Tenant'], 'a');
  assert.strictEqual(assertProbeResponse({ choices: [{ ok: true }] }, { assertType: 'jsonPath', assertValue: 'choices.0.ok' }), true);
  assert.throws(() => assertProbeResponse({ a: 1 }, { assertType: 'contains', assertValue: 'missing' }), /断言失败/);
});

test('provider schema: 拒绝危险协议并修复重复 ID', () => {
  const { validateProviderConfig, ensureUniqueProviderIds } = require('../src/providerSchema');
  assert.throws(() => validateProviderConfig({ name: 'x', url: 'file:///x', intervalSec: 60 }), /HTTP/);
  assert.doesNotThrow(() => validateProviderConfig({ name: 'x', url: 'https://x.test', intervalSec: 60, modelsPath: '/models' }));
  const list = ensureUniqueProviderIds([{ id: 1 }, { id: 1 }, { id: 0 }]);
  assert.strictEqual(new Set(list.map((p) => p.id)).size, 3);
});

test('detector: 模型忽略、JSON 路径与 SSE 增量解析', () => {
  const { filterIgnoredModels, valueAtPath, extractSSEDelta } = require('../src/detector');
  assert.deepStrictEqual(filterIgnoredModels(['gpt-4', 'deprecated-old', 'embed-1'], '^(deprecated|embed)'), ['gpt-4']);
  assert.strictEqual(valueAtPath({ data: { remaining: 12 } }, 'data.remaining'), 12);
  assert.strictEqual(extractSSEDelta('data: {"choices":[{"delta":{"content":"pong"}}]}'), 'pong');
  assert.strictEqual(extractSSEDelta('data: [DONE]'), '');
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

test('alerts: 维护日期与星期规则', () => {
  const { inMaintWindow } = require('../src/alerts');
  const p = { maintEnabled: true, maintStart: '01:00', maintEnd: '03:00', maintDates: '2026-01-02', maintWeekdays: [5] };
  assert.strictEqual(inMaintWindow(p, new Date(2026, 0, 2, 2, 0)), true);
  assert.strictEqual(inMaintWindow(p, new Date(2026, 0, 3, 2, 0)), false);
});

test('alerts: 配额低于阈值触发独立告警', () => {
  const { evaluate, resetState } = require('../src/alerts');
  const p = { id: 987654, name: 'quota', status: 'up', quotaWarning: true, quotaRemaining: 3, quotaWarnBelow: 5 };
  resetState(p.id);
  const out = evaluate({ alertCooldownMin: 10 }, p, { status: 'up' }, { firstCheck: false });
  assert.strictEqual(out.alerts.some((a) => a.kind === 'quota'), true);
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

test('history: 鉴权失败单独计数，且写入后立即可读', async () => {
  const history = require('../src/history');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-h-'));
  history.append(dir, { id: 1, name: 'P' }, {
    checkedAt: Date.now(), status: 'authfail', latency: 3,
    modelsTotal: 1, modelsAvailable: [], modelsUnavailable: ['m'], modelsUnprobed: [], error: '401'
  });
  const sum = await history.summarize(dir, { hours: 24 });
  assert.strictEqual(sum.overall.samples, 1);
  assert.strictEqual(sum.overall.authCount, 1);
  assert.strictEqual(sum.perProvider[0].authCount, 1);
  assert.strictEqual(sum.perProvider[0].downCount, 0);
});

// ---------- v1.4：global 归一 / 408 重试 / 导入校验 / SLA / 延迟告警 / 升级 / 通道健康 ----------

test('store: normalizeGlobal 钳位数值、校验时间、丢弃未知键、宽容布尔', () => {
  const store = require('../src/store');
  const g = store.normalizeGlobal({
    concurrency: 999, retries: -3, alertQuietStart: '25:99', dailyReportTime: 'bad',
    notifyWeixinEnabled: 'true', historyEnabled: 0, unknownJunkKey: 'x',
    probeLimit: 8, configVersion: 1
  });
  assert.strictEqual(g.concurrency, 16, '越界数值钳到上限');
  assert.strictEqual(g.retries, 0, '负数钳到下限');
  assert.strictEqual(g.alertQuietStart, '23:00', '非法时间回退默认');
  assert.strictEqual(g.dailyReportTime, '08:00');
  assert.strictEqual(g.notifyWeixinEnabled, true, '字符串 true 解析为布尔');
  assert.strictEqual(g.historyEnabled, false, '0 解析为 false');
  assert.strictEqual('unknownJunkKey' in g, false, '未知键一律丢弃');
  assert.strictEqual(g.probeLimit, 20, '旧默认 8 迁移到 20');
  assert.strictEqual(g.latencyAlertEnabled, false, '新字段有默认值');
});

test('store: lastReportDay 保留合法日期、丢弃乱值（日报去重标记不得被剥离）', () => {
  const store = require('../src/store');
  const kept = store.normalizeGlobal({ ...store.DEFAULT_GLOBAL, lastReportDay: '2026-10-30' });
  assert.strictEqual(kept.lastReportDay, '2026-10-30', '合法 YYYY-MM-DD 必须保留');
  const cleaned = store.normalizeGlobal({ ...store.DEFAULT_GLOBAL, lastReportDay: 'yesterday' });
  assert.strictEqual(cleaned.lastReportDay, '', '乱值清空，宁可多发一次');
  assert.strictEqual(store.normalizeGlobal({}).lastReportDay, '', '缺省为空串');
  // 模拟 global:set 路径：合并旧配置后再归一，标记不能丢
  const merged = store.normalizeGlobal({ ...store.DEFAULT_GLOBAL, lastReportDay: '2026-10-30', theme: 'dark' });
  assert.strictEqual(merged.lastReportDay, '2026-10-30', '保存其它设置后日报标记仍在');
});

test('detector: isRetryable 408/429/5xx 可重试，其余 4xx 不可', () => {
  const { isRetryable } = require('../src/detector');
  assert.strictEqual(isRetryable(new Error('HTTP 408')), true);
  assert.strictEqual(isRetryable(new Error('HTTP 429')), true);
  assert.strictEqual(isRetryable(new Error('HTTP 502')), true);
  assert.strictEqual(isRetryable(new Error('HTTP 404')), false);
  assert.strictEqual(isRetryable(new Error('HTTP 400')), false);
  assert.strictEqual(isRetryable(new Error('HTTP 401')), false);
  assert.strictEqual(isRetryable(new Error('请求超时')), true);
});

test('transfer: parseImport 校验非法正则与非法 URL 并按行报错', () => {
  const { parseImport } = require('../src/transfer');
  const r = parseImport(JSON.stringify([
    { name: 'OK', url: 'http://a', intervalSec: 60 },
    { name: 'BadRegex', url: 'http://b', intervalSec: 60, modelIgnorePattern: '(unclosed' },
    { name: 'BadProto', url: 'file:///etc', intervalSec: 60 }
  ]), { format: 'json' });
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.errors.length, 2, '两条非法条目都应报错');
  assert.ok(r.errors.some((e) => /BadRegex/.test(e.msg)));
  assert.ok(r.errors.some((e) => /BadProto/.test(e.msg)));
});

test('transfer: applyImport 入库前二次校验，非法条目计入 invalid', () => {
  const { applyImport } = require('../src/transfer');
  const db = { providers: [] };
  const r = applyImport(db, [
    { name: 'Good', url: 'http://a', intervalSec: 60 },
    { name: 'Bad', url: 'http://b', intervalSec: 60, modelIgnorePattern: '[' }
  ], 'append');
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.invalid, 1);
  assert.strictEqual(db.providers.length, 1);
});

test('backup: 还原跳过非法条目，global 未知键被丢弃', () => {
  const backup = require('../src/backup');
  const fs2 = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-bk-'));
  const file = path.join(dir, 'bk.json');
  fs2.writeFileSync(file, JSON.stringify({
    global: { concurrency: 6, evilKey: 'x', alertQuietStart: '99:99' },
    providers: [
      { name: 'Good', url: 'http://a', intervalSec: 60 },
      { name: 'Bad', url: 'http://b', intervalSec: 60, modelIgnorePattern: '[' }
    ]
  }));
  const target = { global: { concurrency: 4 }, providers: [] };
  const r = backup.restoreFrom(target, file, 'overwrite');
  assert.strictEqual(r.providers, 1, '非法条目不入库');
  assert.strictEqual(r.invalid, 1);
  assert.strictEqual(target.global.concurrency, 6);
  assert.strictEqual('evilKey' in target.global, false, 'global 未知键丢弃');
  assert.strictEqual(target.global.alertQuietStart, '23:00', '非法时间回退默认');
});

test('history: 故障次数 / MTTR / 最长故障', async () => {
  const history = require('../src/history');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-sla-'));
  const mk = (id, name) => ({ id, name });
  const base = Date.now() - 100 * 60000;
  const rec = (t, status) => ({ checkedAt: t, status, latency: 10, modelsTotal: 1, modelsAvailable: status === 'up' ? ['m'] : [], modelsUnavailable: [], modelsUnprobed: [], error: null });
  // up 10m → down 20m → up 30m → degraded 10m → up（末段开放故障无）
  const seq = [['up', 10], ['down', 20], ['up', 30], ['degraded', 10], ['up', 30]];
  let t = base;
  for (const [st, mins] of seq) { history.append(dir, mk(7, 'sla'), rec(t, st)); t += mins * 60000; }
  const p = (await history.summarize(dir, { hours: 24 })).perProvider.find((x) => x.id === 7);
  assert.strictEqual(p.incidents, 2, '两次故障事件');
  assert.strictEqual(p.mttrMs, 15 * 60000, 'MTTR 为 (20+10)/2 分钟');
  assert.strictEqual(p.maxOutageMs, 20 * 60000, '最长故障 20 分钟');
});

test('alerts: 延迟劣化连续超阈值触发、回落后清零', () => {
  const alerts = require('../src/alerts');
  const id = 771001;
  alerts.resetState(id);
  const g = { latencyAlertEnabled: true, latencyAlertMs: 1000, latencyAlertConsecutive: 3, alertCooldownMin: 0, alertFailThreshold: 2 };
  const mk = (latency) => ({ id, name: 'lat', status: 'up', latency, notifyOnModelChange: false, modelsAvailable: ['m'], modelsTotal: 1 });
  assert.strictEqual(alerts.evaluate(g, mk(2000), { status: 'up' }, {}).alerts.length, 0, '第 1 轮不告警');
  assert.strictEqual(alerts.evaluate(g, mk(2000), { status: 'up' }, {}).alerts.length, 0, '第 2 轮不告警');
  const d3 = alerts.evaluate(g, mk(2000), { status: 'up' }, {});
  assert.strictEqual(d3.alerts.length, 1, '第 3 轮触发');
  assert.strictEqual(d3.alerts[0].kind, 'latency');
  // 延迟告警不像故障告警那样闩锁：劣化持续期间按冷却节奏重复提醒（冷却为 0 即每轮提醒）
  const d4 = alerts.evaluate(g, mk(2000), { status: 'up' }, {});
  assert.strictEqual(d4.alerts.length, 1, '冷却为 0 时按轮重复提醒');
  const d5 = alerts.evaluate(g, mk(50), { status: 'up' }, {});
  assert.strictEqual(d5.alerts.length, 0, '回落后不告警');
  const d6 = alerts.evaluate(g, mk(2000), { status: 'up' }, {});
  assert.strictEqual(d6.alerts.length, 0, '计数已清零，需重新累积');
  alerts.resetState(id);
});

test('alerts: 延迟告警不受静默时段丢计数，静默期间只抑制推送', () => {
  const alerts = require('../src/alerts');
  const id = 771002;
  alerts.resetState(id);
  const g = { latencyAlertEnabled: true, latencyAlertMs: 1000, latencyAlertConsecutive: 2, alertCooldownMin: 0, alertQuietEnabled: true, alertQuietStart: '00:00', alertQuietEnd: '12:00' };
  const mk = (latency) => ({ id, name: 'lat2', status: 'up', latency, notifyOnModelChange: false });
  const quietNow = new Date(2026, 0, 2, 1, 0);
  assert.strictEqual(alerts.evaluate(g, mk(2000), { status: 'up' }, { now: quietNow }).alerts.length, 0);
  const d2 = alerts.evaluate(g, mk(2000), { status: 'up' }, { now: new Date(2026, 0, 2, 1, 1) });
  assert.strictEqual(d2.alerts.length, 0, '静默期不推送');
  assert.strictEqual(d2.suppressed.some((s) => s.kind === 'latency'), true, '但被记录为抑制');
  // 静默结束后：计数已到 3，仍超阈值 → 立即补推一次
  const d3 = alerts.evaluate(g, mk(2000), { status: 'up' }, { now: new Date(2026, 0, 2, 13, 0) });
  assert.strictEqual(d3.alerts.some((a) => a.kind === 'latency'), true, '静默结束后补发');
  alerts.resetState(id);
});

test('alerts: 故障持续超过升级分钟数重复提醒', () => {
  const alerts = require('../src/alerts');
  const id = 771003;
  const g = { alertFailThreshold: 1, alertCooldownMin: 0, alertEscalateMin: 30, alertRecoverNotify: true };
  const p = { id, name: 'esc', status: 'down', lastError: 'x', notifyOnModelChange: false };
  const t0 = Date.now();
  alerts.resetState(id);
  const d1 = alerts.evaluate(g, p, { status: 'up' }, {});
  assert.strictEqual(d1.alerts.length, 1, '首推故障告警');
  assert.strictEqual(d1.inAlarm, true);
  // runtime 按 id 缓存，重绑持久态前先 resetState（模拟进程重启后的恢复路径）
  const rebind = (runtime) => { alerts.resetState(id); return alerts.evaluate(g, { ...p, alertRuntime: runtime }, { status: 'up' }, {}); };
  const d2 = rebind({ consecutiveFail: 1, inAlarm: true, lastSent: { down: t0 - 10 * 60000 } });
  assert.strictEqual(d2.alerts.length, 0, '10 分钟内不升级');
  const d3 = rebind({ consecutiveFail: 2, inAlarm: true, lastSent: { down: t0 - 31 * 60000 } });
  assert.strictEqual(d3.alerts.length, 1, '超过 30 分钟补推');
  assert.ok(/持续未恢复/.test(d3.alerts[0].title));
  alerts.resetState(id);
});

test('notifier: noteResult 记录连续失败与最近成功时刻', () => {
  const notifier = require('../src/notifier');
  notifier.noteResult('__test_ch__', false, new Error('boom'));
  notifier.noteResult('__test_ch__', false, new Error('boom2'));
  let h = notifier.getNotifyHealth().__test_ch__;
  assert.strictEqual(h.fails, 2);
  assert.ok(h.lastFailAt > 0);
  assert.ok(/boom2/.test(h.lastError));
  notifier.noteResult('__test_ch__', true);
  h = notifier.getNotifyHealth().__test_ch__;
  assert.strictEqual(h.fails, 0, '成功清零');
  assert.ok(h.lastOkAt > 0);
  assert.ok(h.lastOkAt >= h.lastFailAt);
});

test('notifier: 健康状态落盘后重启仍在，resetHealth 清空对应通道', () => {
  const notifier = require('../src/notifier');
  const healthFile = path.join(TMP, 'notify-health.json');
  notifier.noteResult('dingtalk', false, new Error('errcode=310000'));
  assert.ok(fs.existsSync(healthFile), '健康状态必须落盘，否则重启后面板退回「未使用」');
  const onDisk = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
  assert.strictEqual(onDisk.dingtalk.fails, 1);
  assert.ok(/310000/.test(onDisk.dingtalk.lastError));
  notifier.resetHealth(['dingtalk']);
  assert.strictEqual(notifier.getNotifyHealth().dingtalk, undefined, '清空后不再有该通道记录');
  assert.strictEqual(JSON.parse(fs.readFileSync(healthFile, 'utf8')).dingtalk, undefined);
});

// ---------- v1.4.1：加载校验 / 坏正则降级 / 时间补零 / 通道故障回调 ----------

test('store: loadAll 停用手改坏正则条目并给出告警（数据不丢弃）', () => {
  const store = require('../src/store');
  fs.mkdirSync(path.dirname(store.DATA_FILE), { recursive: true });
  fs.writeFileSync(store.DATA_FILE, JSON.stringify({
    global: store.DEFAULT_GLOBAL,
    providers: [
      { id: 1, name: 'Good', url: 'http://a', intervalSec: 60, enabled: true },
      { id: 2, name: 'BadRegex', url: 'http://b', intervalSec: 60, enabled: true, modelIgnorePattern: '(unclosed' }
    ]
  }), 'utf8');
  const loaded = store.loadAll();
  assert.strictEqual(loaded.providers.length, 2, '条目保留不丢弃');
  assert.strictEqual(loaded.providers[0].enabled, true);
  assert.strictEqual(loaded.providers[1].enabled, false, '非法条目已停用，detector 不会再每轮抛异常');
  assert.ok(Array.isArray(loaded.warnings) && loaded.warnings.some((w) => /BadRegex/.test(w)), '告警交给 main 记日志');
  fs.unlinkSync(store.DATA_FILE);
});

test('detector: 坏正则忽略规则降级为跳过本轮规则，不抛异常', () => {
  const { filterIgnoredModels } = require('../src/detector');
  const models = ['gpt-4', 'o3'];
  assert.deepStrictEqual(filterIgnoredModels(models, '(unclosed'), models, '坏正则不抛、不过滤');
  assert.deepStrictEqual(filterIgnoredModels(models, '^gpt'), ['o3'], '好正则照常过滤');
});

test('store: 时间字段补零成两位（日报字符串比较依赖）', () => {
  const store = require('../src/store');
  const g = store.normalizeGlobal({ dailyReportTime: '9:05', alertQuietStart: '7:30', alertQuietEnd: '23:0' });
  assert.strictEqual(g.dailyReportTime, '09:05', "9:05 补成 09:05，'9:05' >= '08:00' 的字符串陷阱消除");
  assert.strictEqual(g.alertQuietStart, '07:30');
  assert.strictEqual(g.alertQuietEnd, '07:00', '分钟位不合法回退默认');
});

test('notifier: 通道连续失败跨过里程碑触发回调（3 次起、之后每 5 次）', () => {
  const notifier = require('../src/notifier');
  const calls = [];
  notifier.onChannelUnhealthy((ch, fails, err) => calls.push([ch, fails, err]));
  for (let i = 0; i < 3; i++) notifier.noteResult('slack', false, new Error('boom'));
  assert.strictEqual(calls.length, 1, '第 3 次失败首次告警');
  assert.strictEqual(calls[0][0], 'slack');
  assert.strictEqual(calls[0][1], 3);
  assert.ok(/boom/.test(calls[0][2]));
  for (let i = 0; i < 4; i++) notifier.noteResult('slack', false, new Error('boom'));
  assert.strictEqual(calls.length, 1, '4-7 次之间不重复告警');
  notifier.noteResult('slack', false, new Error('boom'));   // 第 8 次：(8-3) % 5 === 0
  assert.strictEqual(calls.length, 2, '第 8 次再次告警');
  notifier.noteResult('slack', true);
  assert.strictEqual(notifier.getNotifyHealth().slack.fails, 0, '成功清零');
  notifier.onChannelUnhealthy(null);
  notifier.resetHealth(['slack']);
});

test('scheduler: 全局暂停/恢复，恢复后立即到期补检', () => {
  const { Scheduler } = require('../src/scheduler');
  const s = new Scheduler({ concurrency: 1 });
  const prov = { id: 555001, name: 'pz', intervalSec: 60, checkedAt: Date.now() - 600000, enabled: true, url: 'http://unit.test' };
  s.getProvider = () => prov;
  s.schedule(prov);
  s.pause();
  assert.strictEqual(s.paused, true);
  s.resume();
  assert.strictEqual(s.paused, false);
  const t = s.timers.get(555001);
  assert.ok(t && t.dueAt - Date.now() < 200, '恢复后应立即到期，错过周期的补检');
  s.stop();
  assert.strictEqual(s.timers.size, 0);
});

test('history: perDay 按天聚合可用率（跨天各自独立）', async () => {
  const history = require('../src/history');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-pd-'));
  const mk = (t, status) => ({ checkedAt: t, status, latency: 10, modelsTotal: 1, modelsAvailable: status === 'up' ? ['m'] : [], modelsUnavailable: [], modelsUnprobed: [] });
  // 键为当日本地零点（perDay 的分桶口径），样本取当天午前午後
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const today = today0.getTime();
  const yesterday = today - 86400000;
  // 今天 1 up + 1 down → 50%；昨天 1 up → 100%；前天无数据
  history.append(dir, { id: 1, name: 'P' }, mk(today + 3600000, 'up'));
  history.append(dir, { id: 1, name: 'P' }, mk(today + 7200000, 'down'));
  history.append(dir, { id: 1, name: 'P' }, mk(yesterday + 3600000, 'up'));
  const r = await history.perDay(dir, { days: 7, providerId: 1 });
  const byTs = new Map(r.days.map((d) => [d.t, d.providers[0]]));
  assert.strictEqual(byTs.get(today).uptime, 50);
  assert.strictEqual(byTs.get(today).samples, 2);
  assert.strictEqual(byTs.get(yesterday).uptime, 100);
  assert.strictEqual(r.days.length, 2, '无数据的天不出现');
  assert.strictEqual(r.dayMs, 86400000);
});

(async () => {
  for (const [name, fn] of testCases) {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
