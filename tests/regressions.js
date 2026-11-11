'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), vm = require('vm');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-regress-'));
process.env.AIPM_DATA_DIR = TMP;
const { detect, fetchJSON, resolveProxy, measureOpenAIStream, validateProbeResponse } = require('../src/detector');
const notifier = require('../src/notifier');
const { Scheduler } = require('../src/scheduler');
const history = require('../src/history'), alerts = require('../src/alerts');
const { normalizeProvider } = require('../src/providerSchema');
const { parseImport, applyImport, exportProviders } = require('../src/transfer');
const { templates, endpoint } = require('../src/providerTemplates');
const cases = [], test = (name, fn) => cases.push([name, fn]);
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function server(fn) {
  const srv = http.createServer(fn);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const deliver = (p, event, now) => alerts.noteDelivery(p, event, { attempted: 1, delivered: ['custom'], failed: [] }, now);

test('P1-01: truncated JSON, notification and SSE settle', async () => {
  const srv = await server((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      res.write('{"partial":'); setImmediate(() => res.destroy());
    });
  });
  try {
    await assert.rejects(fetchJSON(srv.url, { timeout: 150 }), /断开|完整|aborted|reset/i);
    await assert.rejects(notifier.post(srv.url, {}, { timeout: 150 }), /断开|完整|aborted|reset/i);
    await assert.rejects(measureOpenAIStream(srv.url, 'm', {}, { timeout: 150 }), /断开|完整|aborted|reset/i);
  } finally { srv.close(); }
});

test('P1-01: whole-request deadline bounds continuous data', async () => {
  let timer;
  const srv = await server((req, res) => {
    res.writeHead(200); timer = setInterval(() => res.write(' '), 10);
    res.on('close', () => clearInterval(timer));
  });
  try {
    const at = Date.now(); await assert.rejects(fetchJSON(srv.url, { timeout: 100 }), /超时/);
    assert.ok(Date.now() - at < 1000);
  } finally { clearInterval(timer); srv.close(); }
});

test('P1-02: queue deduplication, pause and disable', async () => {
  const starts = [], releases = [], providers = [1, 2, 3].map((id) => ({ id, name: String(id), enabled: true }));
  const scheduler = new Scheduler({ concurrency: 1, detector: (p) => new Promise((resolve) => { starts.push(p.id); releases.push(() => resolve({ status: 'up' })); }) });
  scheduler.getProvider = (id) => providers.find((p) => p.id === id);
  try {
    const a = scheduler.runCheck(1, { reason: 'auto' }), b = scheduler.runCheck(2, { reason: 'auto' });
    await scheduler.runCheck(2, { reason: 'auto' }); assert.equal(scheduler.queue.length, 1);
    scheduler.pause(); releases.shift()(); await a; await b; await turn(); assert.deepEqual(starts, [1]);
    scheduler.resume();
    const c = scheduler.runCheck(1), d = scheduler.runCheck(3, { reason: 'auto' });
    providers[2].enabled = false; scheduler.cancel(3); releases.shift()();
    await c; await d; await turn(); assert.deepEqual(starts, [1, 1]);
  } finally { scheduler.stop(); }
});

test('P1-02: period edits do not orphan timers; resume preserves due time', async () => {
  const nativeSet = global.setTimeout, nativeClear = global.clearTimeout, nativeNow = Date.now;
  let now = 100000, sequence = 0, release;
  const timers = new Map();
  global.setTimeout = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; };
  global.clearTimeout = (id) => timers.delete(id); Date.now = () => now;
  const p = { id: 8, name: 'timer', intervalSec: 60, enabled: true, checkedAt: now };
  const scheduler = new Scheduler({ detector: () => new Promise((resolve) => { release = resolve; }) });
  scheduler.getProvider = () => p;
  try {
    scheduler.schedule(p); const due = scheduler.scheduleInfo()[0].dueAt;
    scheduler.pause(); scheduler.resume(); assert.equal(scheduler.scheduleInfo()[0].dueAt, due);
    now = due;
    const entry = [...timers.entries()][0]; timers.delete(entry[0]); const tick = entry[1].fn();
    p.intervalSec = 120; scheduler.schedule(p); release({ status: 'up' }); await tick; await turn();
    assert.equal(timers.size, 1); assert.equal(scheduler.timers.size, 1);
    scheduler.stop(); assert.equal(timers.size, 0);
  } finally { scheduler.stop(); global.setTimeout = nativeSet; global.clearTimeout = nativeClear; Date.now = nativeNow; }
});

test('P1-03: cross-origin redirects strip all custom authentication', async () => {
  let received;
  const dest = await server((req, res) => { received = req.headers; req.resume(); req.on('end', () => res.end('{}')); });
  const origin = await server((req, res) => { req.resume(); req.on('end', () => { res.writeHead(302, { Location: dest.url }); res.end(); }); });
  try {
    await fetchJSON(origin.url, { headers: { Authorization: 'Bearer FAKE', 'X-API-Key': 'FAKE', 'X-Tenant-Token': 'FAKE', Cookie: 'FAKE' } });
    for (const key of ['authorization', 'x-api-key', 'x-tenant-token', 'cookie']) assert.equal(received[key], undefined);
    await notifier.post(origin.url, {}, { headers: { 'X-API-Key': 'FAKE' } }); assert.equal(received['x-api-key'], undefined);
  } finally { origin.close(); dest.close(); }
});

test('P1-04/P2-10: sparse import preserves settings; invalid routes fail', () => {
  const p = normalizeProvider({ id: 1, name: 'old', url: 'http://local', enabled: false, group: 'prod', intervalSec: 300,
    probeMode: 'custom', customHeaders: '{"X-API-Key":"FAKE"}', maintWeekdays: [1], sloTarget: 99.99 });
  const before = { ...p }, parsed = parseImport('name,url\nnew,http://local', { format: 'csv' });
  assert.deepEqual(Object.keys(parsed.items[0]).sort(), ['name', 'url']);
  applyImport({ providers: [p] }, parsed.items); assert.deepEqual(p, { ...before, name: 'new' });
  assert.equal(parseImport('[{"name":"x","url":"http://x","notifyChannels":["slcak"]}]').items.length, 0);
});

test('P1-05: merged restore cannot duplicate IDs', () => {
  const backup = require('../src/backup'), file = path.join(TMP, 'backup.json');
  fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 1, name: 'B', url: 'http://b', intervalSec: 60 }] }));
  const db = { global: {}, providers: [normalizeProvider({ id: 1, name: 'A', url: 'http://a' })] };
  backup.restoreFrom(db, file, 'merge'); assert.equal(new Set(db.providers.map((p) => p.id)).size, 2);
});

test('P1-07: delivery retries and muted recovery/model events survive restart', () => {
  alerts.resetState();
  const p = { id: 71, name: 'pending', status: 'down', notifyOnModelChange: true };
  const cfg = { alertFailThreshold: 1, alertRecoverNotify: true, alertOnModelChange: true, alertCooldownMin: 0,
    alertQuietEnabled: true, alertQuietStart: '23:00', alertQuietEnd: '07:00' };
  const at = (hour) => new Date(2026, 1, 1, hour);
  let out = alerts.evaluate(cfg, p, null, { now: at(22) });
  alerts.noteDelivery(p, out.alerts[0], { attempted: 0, delivered: [], failed: [] }, at(22).getTime());
  assert.equal(p.alertRuntime.inAlarm, false); alerts.resetState(); const count = p.alertRuntime.consecutiveFail;
  out = alerts.evaluate(cfg, p, null, { deliveryOnly: true, now: new Date(at(22).getTime() + 60000) });
  assert.equal(out.alerts.length, 1); assert.equal(p.alertRuntime.consecutiveFail, count); deliver(p, out.alerts[0], at(22).getTime());
  p.status = 'up'; out = alerts.evaluate(cfg, p, null, { now: at(23), modelChanged: true, added: ['new-model'] });
  assert.equal(out.alerts.length, 0); assert.equal(p.alertRuntime.inAlarm, true); alerts.resetState();
  out = alerts.evaluate(cfg, p, null, { deliveryOnly: true, now: new Date(2026, 1, 2, 8) });
  assert.deepEqual(out.alerts.map((e) => e.kind).sort(), ['modelChange', 'recover']); assert.ok(out.alerts.every((e) => e.isNew));
  for (const event of out.alerts) deliver(p, event);
  assert.equal(p.alertRuntime.inAlarm, false); assert.deepEqual(p.alertRuntime.pending, {});
});

test('alerts: slow fault acknowledgement after recovery still queues recovery; retries do not create fresh samples', () => {
  alerts.resetState();
  const p = { id: 72, name: 'slow delivery', status: 'down', latency: 2000 };
  const cfg = { alertFailThreshold: 1, latencyAlertEnabled: true, latencyAlertMs: 1000, latencyAlertConsecutive: 1, alertCooldownMin: 0 };
  const fault = alerts.evaluate(cfg, p, null).alerts[0];
  p.status = 'up'; alerts.evaluate(cfg, p, null);
  deliver(p, fault);
  const retry = alerts.evaluate(cfg, p, null, { deliveryOnly: true });
  assert.ok(retry.alerts.some((e) => e.kind === 'recover'));
  for (const event of retry.alerts) deliver(p, event);
  assert.equal(p.alertRuntime.inAlarm, false);
  assert.equal(alerts.evaluate(cfg, p, null, { deliveryOnly: true }).alerts.length, 0, 'delivery timer must not create new latency alerts');
});

test('P1-08: HTTP 200 business errors fail and update channel health', async () => {
  const srv = await server((req, res) => { req.resume(); req.on('end', () => res.end('{"errcode":93000,"errmsg":"invalid webhook"}')); });
  try {
    await assert.rejects(notifier.sendTest({ weixinWebhook: srv.url }, 'weixin'), /93000/); assert.ok(notifier.getNotifyHealth().weixin.fails > 0);
    assert.throws(() => notifier.checkBusinessResponse('{"code":400,"message":"bad key"}', 'serverchan'), /400/);
    assert.doesNotThrow(() => notifier.checkBusinessResponse('{"code":0}', 'serverchan'));
  } finally { srv.close(); }
});

test('P1-09/P2-03: default exports redact every credential; multiline CSV roundtrips', () => {
  const providers = [normalizeProvider({ name: 'A, "quoted"', url: 'http://a', apiKey: 'KEY_FAKE',
    customHeaders: '{"Token":"HEADER_FAKE"}', proxyUrl: 'http://user:PROXY_FAKE@localhost', note: '第一行\n第二行, "引号"' })];
  for (const format of ['json', 'csv', 'text']) assert.doesNotMatch(exportProviders(providers, { format }), /KEY_FAKE|HEADER_FAKE|PROXY_FAKE/);
  const parsed = parseImport(exportProviders(providers, { format: 'csv' }), { format: 'csv' });
  assert.equal(parsed.items[0].note, providers[0].note); assert.equal(parsed.items[0].name, providers[0].name);
  const malformed = parseImport('name,url,note\nA,http://a,"not closed', { format: 'csv' });
  assert.equal(malformed.items.length, 0); assert.match(malformed.errors[0].msg, /未闭合/);
});

test('provider schema: custom JSON is validated and cloned probe latency is reset', () => {
  const { validateProviderConfig, freshRuntime } = require('../src/providerSchema');
  const p = normalizeProvider({ name: 'custom', url: 'http://localhost', probeMode: 'custom', probeBody: '{"model":"{{model}}"}' });
  assert.doesNotThrow(() => validateProviderConfig(p));
  p.probeBody = '{"model":{{model}}}'; assert.throws(() => validateProviderConfig(p), /有效 JSON/);
  assert.equal(freshRuntime().probeLatencyAvg, null); assert.equal(freshRuntime().probeLatencyP95, null);
});

test('P1-10: quota/failed assertions stay unhealthy; capabilities run independently', async () => {
  const calls = [];
  const srv = await server((req, res) => {
    calls.push(req.url); req.resume(); req.on('end', () => {
      if (req.url.endsWith('/models')) { res.end('{"data":[{"id":"m"}]}'); return; }
      if (req.url.endsWith('/embeddings')) { res.end('{"data":[]}'); return; }
      res.writeHead(400); res.end('{"error":{"code":"insufficient_quota","message":"quota exhausted"}}');
    });
  });
  try {
    const p = { id: 10, name: 'quota', url: srv.url, probePolicy: 'reachable', capabilityModes: ['chat', 'embeddings'], assertType: 'contains', assertValue: 'pong' };
    const r = await detect(p, { retries: 0, probeJitterMs: 0 });
    assert.equal(r.status, 'degraded'); assert.deepEqual(r.modelDetails[0].capabilities, { chat: false, embeddings: false });
    assert.ok(calls.includes('/v1/embeddings')); assert.match(r.modelDetails[0].note, /quota/);
    p.assertType = 'none'; const relaxed = await detect(p, { retries: 0, probeJitterMs: 0 });
    assert.equal(relaxed.status, 'degraded'); assert.equal(relaxed.modelDetails[0].capabilities.embeddings, true);
  } finally { srv.close(); }
});

test('P2-07/08: initial rotating coverage is not a new model; proxy off overrides own proxy', () => {
  const { diffBaseline } = require('../src/baseline');
  const first = diffBaseline([], { firstCheck: true, available: ['a'], unprobed: ['b'] });
  const second = diffBaseline(first.baseline, { available: ['b'], unprobed: ['a'], catalog: first.catalog, unknown: first.unknown });
  assert.equal(second.modelChanged, false);
  assert.deepEqual(diffBaseline(second.baseline, { available: ['a', 'b', 'c'] }).added, ['c']);
  assert.equal(resolveProxy({ useProxy: false, proxyUrl: 'http://proxy' }, { proxyEnabled: true, proxyUrl: 'http://global' }), '');
});

test('history: UTF-8 decoding handles split Chinese bytes', async () => {
  const dir = path.join(TMP, 'unicode'), hdir = history.historyDir(dir); fs.mkdirSync(hdir, { recursive: true });
  const now = Date.now(), file = history.modelFileFor(dir, now), prefix = `{"t":${now},"id":1,"ok":1,"mid":"`;
  const value = prefix + 'x'.repeat(65535 - Buffer.byteLength(prefix)) + '中文"}\n'; fs.writeFileSync(file, value);
  const rows = await history.readModelRange(dir, 1, now - 1, now + 1); assert.ok(rows[0].mid.endsWith('中文')); assert.doesNotMatch(rows[0].mid, /�/);
});

test('history: reads and shutdown flush await in-flight ordered writes', async () => {
  const original = fs.promises.appendFile; let release, started;
  const waiting = new Promise((resolve) => { started = resolve; });
  fs.promises.appendFile = async (...args) => { started(); await new Promise((resolve) => { release = resolve; }); return original(...args); };
  const dir = path.join(TMP, 'flush'), now = Date.now();
  try {
    history.append(dir, { id: 1, name: 'write' }, { checkedAt: now, status: 'up' }); await waiting;
    let settled = false; const read = history.readRange(dir, now - 1, now + 1).then((r) => { settled = true; return r; });
    await turn(); assert.equal(settled, false); release(); assert.equal((await read).length, 1); await history.flush();
  } finally { fs.promises.appendFile = original; }
});

test('SLO: duration weighting, bounded freshness, unknown coverage and negative budget', () => {
  const m = history.timeMetrics([{ t: 0, status: 'up', intervalSec: 100 }, { t: 100000, status: 'down', intervalSec: 100 }, { t: 200000, status: 'up', intervalSec: 100 }], 0, 300000, 99);
  assert.equal(m.upMs, 200000); assert.equal(m.downMs, 100000); assert.equal(m.coverage, 100);
  assert.equal(m.timeUptime, 66.6667); assert.equal(m.allowedDowntimeMs, 3000); assert.equal(m.budgetRemainingMs, -97000); assert.equal(m.sloMet, 'breached');
  const gap = history.timeMetrics([{ t: 0, status: 'up', intervalSec: 5 }], 0, 100000, 99.9);
  assert.equal(gap.coverage, 10); assert.equal(gap.unknownMs, 90000); assert.equal(gap.timeUptime, 100); assert.equal(gap.sloMet, 'insufficient');
  assert.equal(history.timeMetrics([], 0, 100000, 100).timeUptime, null);
  assert.equal(history.timeMetrics([{ t: 0, status: 'down', intervalSec: 100 }], 0, 100000, 100).sloMet, 'breached');
});

test('SLO: complete window is met; sample duplication does not change time weighting', () => {
  const a = [{ t: 0, status: 'up', intervalSec: 100 }, { t: 100000, status: 'up', intervalSec: 100 }];
  const before = history.timeMetrics(a, 0, 200000, 99.9);
  const after = history.timeMetrics([...a, { t: 50000, status: 'up', intervalSec: 100 }], 0, 200000, 99.9);
  assert.equal(before.sloMet, 'met'); assert.deepEqual(after, before);
});

test('history: MTTR excludes ongoing incident; per-provider target and no samples', async () => {
  const dir = path.join(TMP, 'mttr'), now = Date.now(), p = { id: 5, name: 'MTTR', intervalSec: 60, sloTarget: 99.99 };
  for (const [delta, status] of [[-600000, 'down'], [-300000, 'up'], [-120000, 'down']]) history.append(dir, p, { checkedAt: now + delta, status });
  const sum = await history.summarize(dir, { hours: 1, now, providers: [p, { id: 6, name: 'empty' }] });
  const row = sum.perProvider.find((r) => r.id === 5), empty = sum.perProvider.find((r) => r.id === 6);
  assert.equal(row.mttrMs, 300000); assert.equal(row.currentOutageMs, 120000); assert.equal(row.recoveredIncidents, 1); assert.equal(row.sloTarget, 99.99);
  assert.equal(empty.timeUptime, null); assert.equal(empty.coverage, 0); assert.equal(empty.sloMet, 'insufficient');
});

test('SLO: a sample before the window contributes bounded time without inside samples', async () => {
  const dir = path.join(TMP, 'slo-seed'), now = Date.now();
  history.append(dir, { id: 7, name: 'seed', intervalSec: 1800 }, { checkedAt: now - 5400000, status: 'up' });
  const sum = await history.summarize(dir, { hours: 1, now });
  assert.equal(sum.perProvider.length, 1); const row = sum.perProvider[0];
  assert.equal(row.samples, 0); assert.equal(row.upMs, 1800000); assert.equal(row.unknownMs, 1800000);
  assert.equal(row.coverage, 50); assert.equal(row.sloMet, 'insufficient');
});

test('analytics: current scope excludes old IDs from totals, trends and exports; history is explicit', async () => {
  const dir = path.join(TMP, 'scoped-history'), now = Date.now();
  const current = { id: 1, name: 'Current renamed provider', intervalSec: 60 };
  history.append(dir, { ...current, name: 'Previous name' }, { checkedAt: now - 120000, status: 'up', latency: 20 });
  for (const p of [{ id: 8, name: 'Old record A', intervalSec: 60 }, { id: 9, name: 'Old record B', intervalSec: 3600 }]) {
    history.append(dir, p, { checkedAt: now - (p.id === 9 ? 5400000 : 60000), status: 'down', latency: 900 });
  }
  const sum = await history.summarize(dir, { hours: 1, now, providers: [current] });
  assert.deepEqual(sum.perProvider.map((p) => p.id), [1]); assert.equal(sum.perProvider[0].name, current.name);
  assert.equal(sum.overall.samples, 1); assert.equal(sum.overall.latencyP95, 20); assert.equal(sum.overall.downMs, 0);
  const archived = await history.summarize(dir, { hours: 1, now, providers: [current], includeHistorical: true });
  assert.equal(archived.perProvider.length, 3); assert.equal(archived.perProvider.filter((p) => p.archived).length, 2);
  const empty = await history.summarize(dir, { hours: 1, now, providers: [] });
  assert.equal(empty.overall.providers, 0); assert.equal(empty.overall.samples, 0); assert.equal(empty.overall.timeUptime, null);
  const trends = await history.series(dir, { hours: 1, providers: [current] });
  assert.equal(trends.buckets.reduce((n, p) => n + p.samples, 0), 1);
  assert.equal(trends.buckets.find((p) => p.samples).latencyAvg, 20);
  const csv = await history.exportCSV(dir, { hours: 1, providers: [current] }); assert.doesNotMatch(csv, /Old record/);
  assert.match(await history.exportCSV(dir, { hours: 1, providers: [current], includeHistorical: true }), /Old record A/);
  assert.equal((await history.readRange(dir, now - 7200000, now)).length, 3, 'scope never deletes retained history');
});

test('presets: /v1 bases, query preservation and native Ollama requests', async () => {
  assert.equal(endpoint('https://example.test/gateway/v1/?key=value', '/v1/models'), 'https://example.test/gateway/v1/models?key=value');
  const seen = [];
  const srv = await server((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.end(req.url === '/api/tags' ? '{"models":[{"name":"llama"}]}' : '{"message":{"content":"pong"}}');
    });
  });
  try {
    const template = templates.find((t) => t.id === 'ollama');
    const r = await detect({ id: 1, name: 'Ollama', url: srv.url, ...template.config }, { retries: 0, probeJitterMs: 0 });
    assert.equal(r.status, 'up'); assert.equal(seen[1].url, '/api/chat'); assert.equal(seen[1].body.stream, false);
    const browser = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/providerTemplates.js'), 'utf8'), { window: browser, URL });
    assert.equal(browser.providerTemplates.templates.length, templates.length);
  } finally { srv.close(); }
});

test('durations: large subunit remainders cannot round into 24 hours or 7 days', () => {
  const { formatDuration } = require('../src/durfmt');
  assert.equal(formatDuration(86399), '23 时 59 分');
  assert.equal(formatDuration(604799), '6 天 23 时');
});

test('reports: CSV, HTML and Excel include SLO and recovered MTTR; workbook roundtrip', async () => {
  const sum = await history.summarize(path.join(TMP, 'mttr'), { hours: 1 });
  const report = require('../src/report'); assert.match(report.buildReportCSV(sum), /时间加权可用率.*覆盖率.*SLO/);
  assert.match(report.buildReportHTML(sum), /错误预算/);
  const buf = await report.buildReportXLSX(sum), ExcelJS = require('exceljs'), wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf); assert.equal(wb.worksheets.length, 2); assert.equal(wb.worksheets[1].getCell('D1').value, '时间加权可用率(%)');
  const { v4 } = require('uuid'); assert.match(v4(), /^[a-f\d-]{36}$/i);
});

test('mailer: upgraded SMTP authenticates, preserves envelope/body and reports auth failures', async () => {
  const { smtpServer } = require('./fixtures/smtp-server'), { sendMail } = require('../src/mailer');
  const smtp = await smtpServer();
  const config = { smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecure: false,
    smtpUser: 'user@example.test', smtpPass: 'TEST_SMTP_ONLY', mailFrom: 'report@example.test', mailTo: 'ops@example.test' };
  try {
    await sendMail(config, { subject: 'SMTP daily report fixture', html: '<h1>SMTP_REPORT_FIXTURE</h1>' });
    assert.deepEqual(smtp.authentications, [{ user: config.smtpUser, pass: config.smtpPass }]);
    assert.match(smtp.messages[0].from, /<report@example.test>/); assert.match(smtp.messages[0].to[0], /<ops@example.test>/);
    assert.match(smtp.messages[0].body, /Subject: SMTP daily report fixture/);
    assert.match(smtp.messages[0].body, /Content-Type: text\/html/); assert.match(smtp.messages[0].body, /SMTP_REPORT_FIXTURE/);
  } finally { smtp.close(); }
  const rejected = await smtpServer({ rejectAuth: true });
  try { await assert.rejects(sendMail({ ...config, smtpPort: rejected.port }, { subject: 'rejected', html: 'test' }), /535/); }
  finally { rejected.close(); }
});

test('mailer: TLS rejects untrusted certificate by default and accepts explicit SMTP override', async () => {
  const { smtpServer } = require('./fixtures/smtp-server'), { sendMail } = require('../src/mailer');
  const smtp = await smtpServer({ secure: true });
  const config = { smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecure: true,
    smtpUser: 'test@example.test', smtpPass: 'TEST_TLS_ONLY', mailTo: 'ops@example.test' };
  try {
    await assert.rejects(sendMail(config, { subject: 'reject TLS', html: 'test' }), /self.signed|certificate/i);
    assert.equal(smtp.messages.length, 0);
    await sendMail({ ...config, smtpInsecureSkipVerify: true }, { subject: 'explicit TLS override', html: 'TLS_SMTP_FIXTURE' });
    assert.equal(smtp.messages.length, 1); assert.match(smtp.messages[0].body, /TLS_SMTP_FIXTURE/);
  } finally { smtp.close(); }
});

test('D01: strict inference requires protocol results and rejects HTTP 200 business errors', async () => {
  const failures = [{ error: { message: 'quota exhausted' } }, {}, { choices: [] }, { choices: [{ message: { content: '' } }] }, null];
  for (const payload of failures) assert.throws(() => validateProbeResponse(payload, 'chat'), /业务错误|无有效/);
  for (const payload of [{ data: [] }, { data: [{ embedding: [] }] }, { data: [{ embedding: [null] }] }, { data: [{ embedding: 'not-base64' }] }]) {
    assert.throws(() => validateProbeResponse(payload, 'embeddings'), /无有效/);
  }
  for (const payload of [{ choices: [{ message: { content: 'pong' } }] }, { choices: [{ message: { tool_calls: [{ function: { name: 'ping' } }] } }] },
    { choices: [{ message: { content: '', reasoning_content: 'thinking' } }] }, { choices: [{ message: { content: '' }, finish_reason: 'length' }] }]) {
    assert.doesNotThrow(() => validateProbeResponse(payload, 'chat'));
  }
  assert.doesNotThrow(() => validateProbeResponse({ choices: [{ text: 'pong' }] }, 'completions'));
  assert.doesNotThrow(() => validateProbeResponse({ data: [{ embedding: [0, 0.5, -0.3] }] }, 'embeddings'));
  assert.doesNotThrow(() => validateProbeResponse({ data: [{ embedding: 'AACAPw==' }] }, 'embeddings'));
  assert.doesNotThrow(() => validateProbeResponse({ response: 'pong' }, 'custom'));
  assert.doesNotThrow(() => validateProbeResponse({ done: true }, 'custom', { assertType: 'jsonPath', assertValue: 'done' }));
  assert.doesNotThrow(() => validateProbeResponse([{ done: true }], 'custom', { assertType: 'jsonPath', assertValue: '0.done' }));
  assert.throws(() => validateProbeResponse({ done: false }, 'custom', { assertType: 'jsonPath', assertValue: 'done' }), /断言失败/);
  assert.throws(() => validateProbeResponse({ ok: false }, 'chat', { probePolicy: 'reachable' }), /业务错误/);
  let payload = {};
  const srv = await server((req, res) => { req.resume(); req.on('end', () => res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'm' }] } : payload))); });
  try {
    for (const value of [{ error: { message: 'bad key' } }, {}, { choices: [] }]) {
      payload = value;
      const r = await detect({ id: 101, name: 'D01', url: srv.url }, { retries: 0, probeJitterMs: 0 });
      assert.equal(r.status, 'degraded'); assert.deepEqual(r.modelsAvailable, []); assert.deepEqual(r.modelsUnavailable, ['m']);
    }
    payload = { choices: [{ message: { content: 'pong' } }] };
    assert.equal((await detect({ id: 101, name: 'D01', url: srv.url }, { retries: 0, probeJitterMs: 0 })).status, 'up');
  } finally { srv.close(); }
});

test('D02: in-flight configuration edits discard old results; metadata edits remain valid', async () => {
  const { detectionKey } = require('../src/detectionConfig');
  const base = normalizeProvider({ id: 102, name: 'D02', url: 'http://old', capabilityModes: ['chat'] });
  const mutations = [
    (p) => { p.url = 'http://new'; }, (p) => { p.apiKey = 'NEW_FAKE'; }, (p) => { p.assertType = 'contains'; p.assertValue = 'new'; },
    (p) => { p.useProxy = false; }, (p) => { p.capabilityModes.push('embeddings'); }, (p, g) => { g.insecureSkipVerify = true; }
  ];
  for (const mutate of mutations) {
    const p = structuredClone(base), g = { retries: 0 }; let release, input;
    const scheduler = new Scheduler({ detector: (snapshot) => { input = snapshot; return new Promise((resolve) => { release = resolve; }); } });
    scheduler.getProvider = () => p; scheduler.getGlobal = () => g; let accepted = 0;
    scheduler.on('result', () => accepted++);
    try {
      const check = scheduler.runCheck(p.id), key = detectionKey(p, g);
      mutate(p, g); assert.notEqual(detectionKey(p, g), key);
      assert.deepEqual(input.capabilityModes, base.capabilityModes, 'nested detector input is a snapshot');
      release({ status: 'up' }); assert.equal(await check, null); await turn();
      assert.equal(accepted, 0); assert.equal(scheduler.circuits.size, 0);
    } finally { scheduler.stop(); }
  }
  const p = structuredClone(base); let release;
  const scheduler = new Scheduler({ detector: () => new Promise((resolve) => { release = resolve; }) });
  scheduler.getProvider = () => p; let accepted = 0; scheduler.on('result', () => accepted++);
  try {
    const check = scheduler.runCheck(p.id); p.note = 'changed'; p.name = 'renamed'; p.intervalSec = 120;
    release({ status: 'up' }); assert.equal((await check).status, 'up'); assert.equal(accepted, 1);
  } finally { scheduler.stop(); }
});

test('D02: refresh aborts the old request and schedules one fresh check after unwinding', async () => {
  const p = normalizeProvider({ id: 103, name: 'refresh', url: 'http://old' }); let release, signal;
  const scheduler = new Scheduler({ detector: (snapshot, opts) => { signal = opts.signal; return new Promise((resolve) => { release = resolve; }); } });
  scheduler.getProvider = () => p;
  try {
    const check = scheduler.runCheck(p.id); p.url = 'http://new'; scheduler.refresh(p);
    assert.equal(signal.aborted, true); assert.equal(scheduler.timers.size, 0);
    release({ status: 'up' }); await check; await turn();
    assert.equal(scheduler.timers.size, 1); assert.ok(scheduler.scheduleInfo()[0].dueAt <= Date.now());
  } finally { scheduler.stop(); }
});

test('D03: parseable malformed configuration retains the original and creates a recovery copy', () => {
  const store = require('../src/store');
  const shapes = [{}, { providers: {} }, { providers: null }, { providers: [null] }, { providers: ['invalid'] },
    { providers: [[]] }, { providers: [], global: null }, { providers: [], global: [] }, { providers: [], global: 'invalid' }];
  for (const shape of shapes) {
    const text = JSON.stringify(shape); fs.writeFileSync(store.DATA_FILE, text);
    assert.throws(() => store.loadAll(), (err) => err.code === 'CONFIG_PARSE_FAILED');
    assert.equal(fs.readFileSync(store.DATA_FILE, 'utf8'), text);
    assert.ok(fs.readdirSync(TMP).some((name) => name.startsWith('providers.json.corrupt-') && fs.readFileSync(path.join(TMP, name), 'utf8') === text));
  }
  fs.writeFileSync(store.DATA_FILE, '{"providers":[]}'); assert.deepEqual(store.loadAll().providers, []);
  fs.unlinkSync(store.DATA_FILE); assert.deepEqual(store.loadAll().providers, []);
});

test('D07: sparse backup merge preserves every absent setting; explicit defaults still apply', () => {
  const backup = require('../src/backup'), file = path.join(TMP, 'sparse-backup.json');
  const p = normalizeProvider({ id: 107, name: 'original', url: 'http://backup', enabled: false, probeMode: 'embeddings',
    apiKey: 'FAKE_BACKUP_KEY', customHeaders: '{"X-Auth":"FAKE"}', proxyUrl: 'http://local', maintEnabled: true,
    maintWeekdays: [1, 3], maintDates: '2026-11-10', sloTarget: 99.99, notifyChannels: ['qq'], capabilityModes: ['embeddings'] });
  p.status = 'up'; p.checkedAt = 123; p.modelBaseline = ['original'];
  const before = structuredClone(p), db = { global: { sloTarget: 99.9 }, providers: [p] };
  fs.writeFileSync(file, JSON.stringify({ providers: [{ name: 'renamed', url: p.url, apiKey: '', status: 'down', alertRuntime: { inAlarm: true } }] }));
  assert.equal(backup.restoreFrom(db, file, 'merge').updated, 1); assert.deepEqual(p, { ...before, name: 'renamed' });
  assert.equal(backup.restoreFrom(db, file, 'merge').skipped, 1);
  fs.writeFileSync(file, JSON.stringify({ providers: [{ name: p.name, url: p.url, enabled: true, maintEnabled: false,
    probeMode: 'chat', sloTarget: null, notifyChannels: [], capabilityModes: [], maintWeekdays: [] }, { id: 10701, name: 'new', url: 'http://new' }] }));
  const r = backup.restoreFrom(db, file, 'merge'); assert.equal(r.updated, 1); assert.equal(r.added, 1);
  assert.equal(p.enabled, true); assert.equal(p.maintEnabled, false); assert.equal(p.sloTarget, null); assert.deepEqual(p.notifyChannels, []);
  assert.equal(p.apiKey, before.apiKey); assert.equal(p.status, 'up'); assert.equal(db.providers[1].probeMode, 'chat');
  assert.equal(db.providers[1].status, 'unknown'); assert.equal(db.providers[1].id, 10701);
});

test('D08: URL credentials are redacted in exports, notifications and disk/subscriber logs; requests keep them', async () => {
  const { redactUrl, redactText, urlPatch } = require('../src/redact'), logger = require('../src/logger');
  const p = normalizeProvider({ name: 'URL credentials', url: 'https://FAKE_USER:FAKE_PASS@example.test/gateway?Api_Key=FAKE_QUERY&region=us&token=FAKE_DUP&token=FAKE_DUP2',
    modelsPath: '/v1/models?access%5Ftoken=FAKE_MODELS&project=alpha', probePath: '/probe?SIGNATURE=FAKE_PROBE', quotaPath: '/quota?secret=FAKE_QUOTA' });
  const secret = /FAKE_USER|FAKE_PASS|FAKE_QUERY|FAKE_DUP|FAKE_MODELS|FAKE_PROBE|FAKE_QUOTA/;
  assert.doesNotMatch(redactUrl(p.url), secret); assert.match(redactUrl(p.url), /region=us/);
  assert.doesNotMatch(redactText('error GET ' + p.url), secret);
  assert.equal(urlPatch(redactUrl(p.url).replace('region=us', 'region=cn'), p.url), p.url.replace('region=us', 'region=cn'));
  assert.equal(urlPatch('https://example.test?token=NEW_VALUE', p.url), 'https://example.test?token=NEW_VALUE');
  assert.throws(() => urlPatch('https://example.test?token=***', 'https://example.test'), /凭据/);
  for (const format of ['json', 'csv', 'text']) {
    const redacted = exportProviders([p], { format }); assert.doesNotMatch(redacted, secret); assert.match(redacted, /region=us/);
    assert.match(exportProviders([p], { format, withKey: true }), /FAKE_QUERY/);
  }
  assert.doesNotMatch(notifier.buildAlertText(p, { kind: 'down', reason: 'failed at ' + p.url }), secret);
  let line; const unsubscribe = logger.subscribe((item) => { line = item; });
  try { logger.info('D08: ' + p.url + ' route ' + p.modelsPath); logger.flushSync(); assert.doesNotMatch(line.msg, secret); }
  finally { unsubscribe(); }
  for (const file of logger.listFiles()) assert.doesNotMatch(fs.readFileSync(file.path, 'utf8'), secret);
  const received = [];
  const srv = await server((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      received.push({ url: req.url, body });
      res.end(req.url.includes('/models') ? '{"data":[{"id":"m"}]}' : req.url.includes('/hook') ? '{}' : '{"choices":[{"message":{"content":"pong"}}]}');
    });
  });
  try {
    const r = await detect({ id: 108, name: 'D08', url: srv.url + '?API_key=REQUEST_ONLY&project=alpha' }, { retries: 0, probeJitterMs: 0 });
    assert.equal(r.status, 'up'); assert.ok(received.filter((x) => !x.url.includes('/hook')).every((x) => x.url.includes('API_key=REQUEST_ONLY') && x.url.includes('project=alpha')));
    await notifier.sendCustom({ customWebhook: srv.url + '/hook', customTemplate: '{"url":"{{url}}","text":"{{text}}"}' }, 'failure ' + p.url, { url: p.url });
    assert.doesNotMatch(received.at(-1).body, secret);
  } finally { srv.close(); }
});

test('D15: partial recovery cannot block the next incident; channel retries survive restart without duplicate delivery', () => {
  alerts.resetState();
  const p = { id: 115, name: 'multi-channel', status: 'down' };
  const cfg = { alertFailThreshold: 1, alertRecoverNotify: true, notifyWeixinEnabled: true, weixinWebhook: 'http://local', notifyQQEnabled: true, qqWebhook: 'http://local', qqTarget: '1' };
  const ack = (event, channels, failed = [], complete = false) => alerts.noteDelivery(p, event, { attempted: channels.length + failed.length, delivered: channels, failed, complete });
  const fault = alerts.evaluate(cfg, p, null).alerts[0]; ack(fault, ['weixin', 'qq'], [], true);
  p.status = 'up'; const recover = alerts.evaluate(cfg, p, null).alerts[0]; ack(recover, ['weixin'], [{ channel: 'qq' }]);
  assert.equal(p.alertRuntime.inAlarm, true);
  alerts.resetState(p.id); alerts.retryPending(p);
  const retry = alerts.evaluate(cfg, p, null, { deliveryOnly: true }).alerts[0];
  assert.equal(retry.eventId, recover.eventId); assert.deepEqual(retry.delivered, ['weixin']);
  p.status = 'down'; const next = alerts.evaluate(cfg, p, null).alerts[0];
  assert.equal(next.kind, 'down'); assert.notEqual(next.incidentId, fault.incidentId); assert.notEqual(next.eventId, fault.eventId);
  assert.deepEqual(next.delivered, []); assert.equal(p.alertRuntime.pending.recover, undefined);
  ack(next, ['weixin'], [{ channel: 'qq' }]); alerts.resetState(p.id); alerts.retryPending(p);
  const nextRetry = alerts.evaluate(cfg, p, null, { deliveryOnly: true }).alerts[0];
  assert.equal(nextRetry.eventId, next.eventId); assert.deepEqual(nextRetry.delivered, ['weixin']); ack(nextRetry, ['qq'], [], true);
  ack(recover, ['weixin', 'qq'], [], true); assert.equal(p.alertRuntime.inAlarm, true, 'stale recovery cannot unlatch a new fault');
  assert.ok(Object.values(p.alertRuntime.channels).every((c) => c.incidentId === next.incidentId && c.kind === 'down'));
  p.status = 'up'; const lastRecovery = alerts.evaluate(cfg, p, null).alerts[0]; ack(lastRecovery, ['weixin', 'qq'], [], true);
  ack(fault, ['weixin', 'qq'], [], true);
  assert.equal(p.alertRuntime.inAlarm, false); assert.equal(alerts.evaluate(cfg, p, null, { deliveryOnly: true }).alerts.length, 0);
});

test('D15: newly enabled or rerouted channels receive current state without resending successful channels', () => {
  alerts.resetState();
  const p = { id: 116, name: 'routing', status: 'down', notifyChannels: ['weixin'] };
  const cfg = { alertFailThreshold: 1, notifyWeixinEnabled: true, weixinWebhook: 'http://local', notifyQQEnabled: true, qqWebhook: 'http://local', qqTarget: '1' };
  const first = alerts.evaluate(cfg, p, null).alerts[0];
  alerts.noteDelivery(p, first, { complete: true, delivered: ['weixin'], attempted: 1, failed: [] });
  p.notifyChannels = [];
  const broadened = alerts.evaluate(cfg, p, null, { deliveryOnly: true }).alerts[0]; assert.deepEqual(broadened.delivered, ['weixin']);
  alerts.noteDelivery(p, broadened, { complete: true, delivered: ['qq'], attempted: 1, failed: [] });
  p.status = 'up'; cfg.notifyQQEnabled = false;
  const recovery = alerts.evaluate(cfg, p, null).alerts[0];
  alerts.noteDelivery(p, recovery, { complete: true, delivered: ['weixin'], attempted: 1, failed: [] });
  assert.equal(alerts.evaluate(cfg, p, null, { deliveryOnly: true }).alerts.length, 0);
  cfg.notifyQQEnabled = true; alerts.resetState(p.id);
  const lateRecovery = alerts.evaluate(cfg, p, null, { deliveryOnly: true }).alerts[0];
  assert.equal(lateRecovery.kind, 'recover'); assert.deepEqual(lateRecovery.delivered, ['weixin']);
  alerts.noteDelivery(p, lateRecovery, { complete: true, delivered: ['qq'], attempted: 1, failed: [] });
  assert.equal(alerts.evaluate(cfg, p, null, { deliveryOnly: true }).alerts.length, 0);
});

test('D15: a legacy partial recovery migrates without replaying successful channels or losing recipients', () => {
  alerts.resetState();
  const p = { id: 117, name: 'legacy', status: 'up', alertRuntime: { inAlarm: true, pending: {
    recover: { kind: 'recover', title: '服务恢复', reason: 'legacy', eventId: 'old-recover', delivered: ['weixin'], attempts: 1, nextRetryAt: 0 }
  } } };
  const cfg = { notifyWeixinEnabled: true, weixinWebhook: 'http://local', notifyQQEnabled: true, qqWebhook: 'http://local', qqTarget: '1' };
  const recovery = alerts.evaluate(cfg, p, null, { deliveryOnly: true }).alerts[0];
  assert.deepEqual(recovery.delivered, ['weixin']); assert.equal(recovery.targets, undefined);
  alerts.noteDelivery(p, recovery, { complete: true, delivered: ['qq'], attempted: 1, failed: [] });
  assert.equal(p.alertRuntime.inAlarm, false); assert.equal(alerts.evaluate(cfg, p, null, { deliveryOnly: true }).alerts.length, 0);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) { try { await fn(); console.log('PASS', name); } catch (err) { failed++; console.error('FAIL', name, err); } }
  await history.flush(); require('../src/logger').flushSync();
  console.log(`${cases.length - failed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
