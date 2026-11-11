'use strict';
// Exercises the normal main.js startup and real preload/IPC under an isolated data directory.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { app, BrowserWindow } = require('electron');
const version = require('../package.json').version;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-integration-'));
process.env.AIPM_DATA_DIR = TMP; process.env.AIPM_INTEGRATION_TEST = '1';
app.setPath('userData', path.join(TMP, 'electron')); app.disableHardwareAcceleration();
const { DEFAULT_GLOBAL } = require('../src/store');
fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({ global: { ...DEFAULT_GLOBAL,
  autoStartCheckOnLaunch: false, launchMinimized: true, hotkeyEnabled: false, autoUpdateCheck: false,
  retries: 0, probeJitterMs: 0 }, providers: [] }));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, limit = 6000) {
  const start = Date.now();
  while (Date.now() - start < limit) { if (await fn()) return; await delay(30); }
  throw new Error('Timeout: ' + label);
}
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS', name); }
let win, runtime, srv;
const errors = [], requests = [], deliveries = [];
let inferenceDown = false;
const alertTrace = [];
let releaseRecovery = null;
async function js(script) { return win.webContents.executeJavaScript(script.includes('await ') ? `(async () => { ${script} })()` : script, true); }
async function closeModal() { await js('document.querySelectorAll(\'.modal-mask.show\').forEach((m) => m.classList.remove(\'show\'));'); }
(async () => {
  srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body });
      if (req.url === '/alert-wx' || req.url === '/alert-qq/send_private_msg') {
        const channel = req.url === '/alert-wx' ? 'weixin' : 'qq';
        const data = JSON.parse(body), text = channel === 'weixin' ? data.text.content : data.message;
        alertTrace.push({ channel, kind: text.includes('服务恢复') ? 'recover' : 'down' });
        if (channel === 'qq' && text.includes('服务恢复')) releaseRecovery = (success = false) => res.end(JSON.stringify({ retcode: success ? 0 : 1, message: 'fixture delivery' }));
        else res.end(JSON.stringify(channel === 'weixin' ? { errcode: 0 } : { retcode: 0 }));
        return;
      }
      if (req.url === '/hook') { deliveries.push(JSON.parse(body)); res.end('{"errcode":0}'); return; }
      if (req.url === '/v1/models') { res.end('{"data":[{"id":"m1"},{"id":"m2"}]}'); return; }
      if (req.url === '/v1/chat/completions') {
        if (inferenceDown) { res.writeHead(503); res.end('{"error":{"message":"fixture down"}}'); }
        else res.end('{"choices":[{"message":{"content":"pong"}}]}');
        return;
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  runtime = require('../main'); await app.whenReady();
  await until(() => BrowserWindow.getAllWindows().length, 'normal window');
  win = BrowserWindow.getAllWindows()[0];
  win.webContents.on('console-message', (event) => { if (['error', 'warning'].includes(event.level)) errors.push(event.message); });
  win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await until(() => js(`document.querySelector('#appVersion').textContent === 'V${version}'`), 'renderer initialized');

  await check('normal startup: real state, version, history IPC; no runtime errors', async () => {
    const state = await js('window.aipm.getState()'); assert.equal(state.dataDir, TMP); assert.equal(state.providers.length, 0);
    assert.equal((await js('window.aipm.historySLO()')).windowDays, 30); assert.deepEqual(errors, []);
  });
  await check('provider form: presets, basic/advanced, no implicit Sunday, one effective test/save payload', async () => {
    const result = await js(`(() => {
      navTo('providers'); openProviderModal();
      const q = (s) => document.querySelector(s);
      const basics = !q('#fAdvanced').open && q('#fTemplate').options.length >= 7;
      q('#fTemplate').value = 'ollama'; q('#fTemplate').dispatchEvent(new Event('change'));
      const ollama = collectProviderForm();
      q('#fTemplate').value = 'compatible'; q('#fTemplate').dispatchEvent(new Event('change'));
      q('#fName').value = '本地测试服务'; q('#fUrl').value = '${base}/v1'; q('#fKey').value = 'TEST_KEY';
      q('#fCustomHeaders').value = '{"X-Test-Auth":"FAKE_HEADER"}'; q('#fSloTarget').value = '99.95';
      q('#fTestConn').click();
      return { basics, ollama, data: collectProviderForm() };
    })()`);
    assert.ok(result.basics); assert.equal(result.ollama.modelsPath, '/api/tags'); assert.equal(result.ollama.probeMode, 'custom');
    assert.equal(JSON.parse(result.ollama.probeBody).stream, false); assert.deepEqual(result.data.maintWeekdays, []);
    await until(() => js('!document.querySelector(\'#fTestConn\').disabled'), 'connection test');
    assert.ok((await js('document.querySelector(\'#fTestHint\').textContent')).includes('在线'));
    await js('document.querySelector(\'#pmSave\').click()');
    await until(() => runtime.ctx.getDb().providers[0]?.checkedAt, 'scheduled detection');
    const p = runtime.ctx.getDb().providers[0]; assert.equal(p.sloTarget, 99.95); assert.equal(p.status, 'up');
    assert.equal(p.customHeaders, '{"X-Test-Auth":"FAKE_HEADER"}');
    assert.ok(requests.filter((r) => r.url === '/v1/models').every((r) => r.headers['x-test-auth'] === 'FAKE_HEADER'));
  });
  const providerId = runtime.ctx.getDb().providers[0].id;
  await check('P2-01/11: edit preserves stored headers/proxy and key hints; clear applies to tests', async () => {
    const data = await js(`(() => {
      openProviderModal(${providerId}); applyLang();
      const preserved = collectProviderForm();
      const hint = document.querySelector('#fKey').placeholder;
      document.querySelector('#fKeyClear').click();
      return { preserved, hint, cleared: collectProviderForm() };
    })()`);
    assert.equal(data.preserved.apiKey, undefined); assert.equal(data.preserved.customHeaders, undefined); assert.equal(data.preserved.proxyUrl, undefined);
    assert.match(data.hint, /已保存/); assert.equal(data.cleared.apiKey, '');
    await closeModal();
  });
  await check('one-click clone: unique paused copy without credentials or runtime state', async () => {
    await js(`state = await window.aipm.getState(); renderProviders(); document.querySelector('[data-clone="${providerId}"]').click()`);
    await until(() => runtime.ctx.getDb().providers.length === 2, 'clone created');
    const clone = runtime.ctx.getDb().providers[1]; assert.notEqual(clone.id, providerId); assert.equal(clone.enabled, false);
    for (const field of ['apiKey', 'customHeaders', 'proxyUrl']) assert.equal(clone[field], '');
    assert.equal(clone.checkedAt, null); assert.equal(clone.status, 'unknown'); assert.equal(clone.sloTarget, 99.95);
    assert.equal(runtime.scheduler.timers.has(clone.id), false); await closeModal();
  });
  await check('P1-11: settings survive immediate navigation; test awaits durable save', async () => {
    await js(`(() => {
      navTo('notify'); const e = document.querySelector('#wxWebhook'); e.value = '${base}/hook'; e.dispatchEvent(new Event('input'));
      document.querySelector('#wxEnable').checked = true; document.querySelector('#wxEnable').dispatchEvent(new Event('change'));
      navTo('settings');
    })()`);
    await until(() => runtime.ctx.getDb().global.weixinWebhook === base + '/hook', 'debounced save');
    await js('navTo(\'notify\'); document.querySelector(\'#wxTest\').click();');
    await until(() => deliveries.length > 0, 'notification test');
    assert.equal(runtime.ctx.getDb().global.notifyWeixinEnabled, true);
    assert.equal((await js('document.querySelector(\'#wxHint\').className')), 'hint ok');
  });
  await check('P2-05: detail updates on state, resets stale charts and shows SLO', async () => {
    await js(`state = await window.aipm.getState(); openDetail(${providerId});`);
    inferenceDown = true; await runtime.scheduler.runCheck(providerId);
    await until(() => js('document.querySelector(\'#dmBanner\').textContent.includes(\'异常\')'), 'live detail updates');
    await until(() => js('document.querySelector(\'#dmMeta\').textContent.includes(\'SLO\')'), 'detail SLO');
    inferenceDown = false; await closeModal();
  });
  await check('SLO settings and rolling metrics render with coverage, unknown time and budgets', async () => {
    await js('await window.aipm.setGlobal({ sloWindowDays: 7, sloTarget: 99.99 }); state = await window.aipm.getState(); navTo(\'stats\');');
    await until(() => js('document.querySelector(\'#sloWindow\').textContent.includes(\'7\') && document.querySelector(\'#sloTable\').textContent.includes(\'数据不足\')'), 'SLO panel');
    const result = await js('window.aipm.historySLO()'); assert.equal(result.windowDays, 7);
    assert.equal(result.perProvider.find((p) => p.id === providerId).sloTarget, 99.95);
    assert.ok(result.overall.unknownMs > 0); assert.ok(result.overall.coverage < 100);
  });
  await check('analytics scope: old IDs hidden by default; explicit history shows labeled rows and updates metrics', async () => {
    runtime.ctx.history.append(TMP, { id: 900001, name: 'Archived fixture A', intervalSec: 60 }, { checkedAt: Date.now() - 60000, status: 'down', latency: 600 });
    runtime.ctx.history.append(TMP, { id: 900002, name: 'Archived fixture B', intervalSec: 60 }, { checkedAt: Date.now() - 60000, status: 'up', latency: 30 });
    const normal = await js('window.aipm.historySummary({ hours: 24 })');
    assert.equal(normal.perProvider.length, 2); assert.ok(normal.perProvider.every((p) => p.id < 900000 || p.id > 900010));
    await js('await renderStats();');
    assert.equal(await js('document.querySelector("#stTable").textContent.includes("Archived fixture")'), false);
    await js('document.querySelector("#stScope").value = "history"; document.querySelector("#stScope").dispatchEvent(new Event("change"));');
    await until(() => js('document.querySelector("#sloTable").textContent.includes("Archived fixture A")'), 'historical scope');
    assert.equal(await js('document.querySelectorAll("#sloTable .stats-provider-meta").length'), 3, 'two archived rows and one disabled row');
    assert.equal(await js('document.querySelector("#stProviders").textContent'), '4');
    await js('document.querySelector("#stScope").value = "current"; await renderStats();');
    assert.equal(await js('document.querySelector("#stTable").textContent.includes("Archived fixture")'), false);
  });
  await check('shortcut recorder: key caps, capture/save, Escape cancellation and default reset', async () => {
    await js('navTo("settings"); document.querySelector("#hotkeyEnabled").checked = true; document.querySelector("#hotkeyEnabled").dispatchEvent(new Event("change"));');
    await js('await flushSettings();');
    assert.deepEqual(await js('[...document.querySelectorAll("#hotkeyRecorder kbd")].map((e) => e.textContent)'), ['Ctrl', 'Alt', 'M']);
    await js('document.querySelector("#hotkeyRecorder").click();');
    await until(() => js('recordingHotkey'), 'shortcut recording');
    await js('document.querySelector("#hotkeyRecorder").dispatchEvent(new KeyboardEvent("keydown", { key:"k", code:"KeyK", ctrlKey:true, altKey:true, bubbles:true }));');
    await until(() => runtime.ctx.getDb().global.hotkey === 'Ctrl+Alt+K', 'recorded shortcut saved');
    assert.deepEqual(await js('[...document.querySelectorAll("#hotkeyRecorder kbd")].map((e) => e.textContent)'), ['Ctrl', 'Alt', 'K']);
    await js('document.querySelector("#hotkeyRecorder").click();'); await until(() => js('recordingHotkey'), 'cancel recording');
    await js('document.querySelector("#hotkeyRecorder").dispatchEvent(new KeyboardEvent("keydown", { key:"Escape", code:"Escape", bubbles:true }));');
    assert.equal(runtime.ctx.getDb().global.hotkey, 'Ctrl+Alt+K');
    await js('document.querySelector("#hotkeyReset").click(); await flushSettings();');
    assert.equal(runtime.ctx.getDb().global.hotkey, 'CommandOrCtrl+Alt+M');
    await js('document.querySelector("#hotkeyEnabled").checked = false; document.querySelector("#hotkeyEnabled").dispatchEvent(new Event("change")); await flushSettings();');
    assert.equal(await js('document.querySelector("#hotkeyRecorder").disabled'), true);
  });
  await check('P2-02: copy uses complete export while preview is truncated', async () => {
    await js(`await window.aipm.updateProvider(${providerId}, { note: '长备注'.repeat(1500) }); state = await window.aipm.getState(); document.querySelector('#btnExport').click();`);
    await until(() => js('document.querySelector(\'#emPreview\').textContent.endsWith(\'…\')'), 'truncated preview');
    await js('navigator.clipboard.writeText = async (text) => { window.__copiedExport = text; }; document.querySelector(\'#emCopy\').click();');
    await until(() => js('!!window.__copiedExport && JSON.parse(window.__copiedExport)[0].note.length === 4500'), 'complete copy');
    const copied = await js('window.__copiedExport'); assert.ok(copied.length > 4500); assert.doesNotMatch(copied, /TEST_KEY|FAKE_HEADER/); await closeModal();
  });
  await check('P2-09: failed deletion retains selection and reports failure', async () => {
    const original = runtime.ctx.persist; runtime.ctx.persist = () => ({ ok: false, error: 'SIMULATED_DISK_ERROR' });
    try {
      await js(`navTo('providers'); state = await window.aipm.getState(); selected.add(${providerId}); renderProviders(); document.querySelector('[data-del="${providerId}"]').click(); document.querySelector('#cfOk').click();`);
      await until(() => js('document.querySelector(\'#toastWrap\').textContent.includes(\'SIMULATED_DISK_ERROR\')'), 'failed delete toast');
      assert.ok(runtime.ctx.getDb().providers.some((p) => p.id === providerId)); assert.equal(await js(`selected.has(${providerId})`), true);
    } finally { runtime.ctx.persist = original; }
  });
  await check('enable/disable controls stop automatic schedules and display disabled filter', async () => {
    await js(`document.querySelector('[data-toggle="${providerId}"]').click();`);
    await until(() => runtime.ctx.getDb().providers[0].enabled === false, 'disabled');
    assert.equal(runtime.scheduler.timers.has(providerId), false);
    await js('state = await window.aipm.getState(); document.querySelector(\'#statusFilter\').value = \'disabled\'; renderProviders();');
    assert.equal(await js('document.querySelectorAll(\'#providerList .p-row\').length'), 2);
    await js(`document.querySelector('[data-toggle="${providerId}"]').click();`);
    await until(() => runtime.ctx.getDb().providers[0].enabled === true, 're-enabled');
  });
  await check('P2-06: restore applies global config, clears stale alerts and reschedules', async () => {
    const snapshot = path.join(TMP, 'restore.json');
    const db = runtime.ctx.getDb();
    fs.writeFileSync(snapshot, JSON.stringify({ global: { ...db.global, concurrency: 12, sloTarget: 99.8, hotkeyEnabled: false, logLevel: 'warn' }, providers: db.providers }));
    const r = await js(`window.aipm.backupRestore(${JSON.stringify(snapshot)}, 'overwrite')`);
    assert.equal(r.ok, true); assert.equal(runtime.scheduler.concurrency, 12); assert.equal(runtime.ctx.getDb().global.sloTarget, 99.8);
    assert.equal(JSON.parse(fs.readFileSync(path.join(TMP, 'providers.json'), 'utf8')).global.concurrency, 12);
  });
  await check('P2-12: onboarding stays after adding a provider and can be dismissed', async () => {
    await js('await window.aipm.setGlobal({ onboardingDismissed: false, notifyWeixinEnabled: false }); state = await window.aipm.getState(); navTo(\'dashboard\');');
    assert.equal(await js('!!document.querySelector(\'[data-wz="2"]\')'), true);
    await js('document.querySelector(\'[data-wz-dismiss]\').click();');
    await until(() => runtime.ctx.getDb().global.onboardingDismissed, 'dismiss saved');
  });
  await check('daily backup/maintenance executes in normal startup', async () => {
    await runtime.dailyMaintenance();
    assert.ok(require('../src/backup').listAuto(TMP).length >= 1);
  });
  await check('settings save failure blocks test notification', async () => {
    const old = runtime.ctx.persist, before = deliveries.length;
    runtime.ctx.persist = () => ({ ok: false, error: 'SAVE_REJECTED' });
    try {
      await js('navTo(\'notify\'); document.querySelector(\'#wxTest\').click();');
      await until(() => js('document.querySelector(\'#wxHint\').textContent.includes(\'SAVE_REJECTED\')'), 'test save failure');
      assert.equal(deliveries.length, before);
    } finally { runtime.ctx.persist = old; }
  });
  await check('D02: real edit/bulk/import/global IPC invalidate old detection and preserve state on save failure', async () => {
    const { normalizeProvider } = require('../src/providerSchema');
    await js('await window.aipm.setGlobal({ notifyWeixinEnabled: false });');
    const db = runtime.ctx.getDb(), p = normalizeProvider({ id: 202, name: 'revision fixture', url: base, intervalSec: 3600 });
    db.providers.push(p);
    const original = runtime.scheduler.detector, originalPersist = runtime.ctx.persist;
    runtime.scheduler.pause();
    try {
      const actions = [
        'window.aipm.updateProvider(202, { url: "' + base + '/new" })',
        'window.aipm.updateProvider(202, { apiKey: "FAKE_REVISION" })',
        'window.aipm.bulkUpdateProviders([202], { useProxy: false })',
        'window.aipm.transferApply({ items: [{ name: "revision fixture", url: "' + base + '/new", assertType: "contains", assertValue: "pong" }], mode: "merge" })',
        'window.aipm.setGlobal({ requestTimeoutMs: 21000 })'
      ];
      for (const action of actions) {
        let release, signal;
        runtime.scheduler.detector = (input, opts) => { signal = opts.signal; return new Promise((resolve) => { release = resolve; }); };
        const pending = runtime.scheduler.runCheck(p.id);
        const result = await js(action); assert.equal(result.ok, true, action); assert.equal(signal.aborted, true);
        assert.equal(p.status, 'unknown'); assert.deepEqual(p.modelBaseline, []);
        release({ status: 'up', checkedAt: Date.now(), modelsTotal: 1, modelsAvailable: ['OLD_ENDPOINT_RESULT'] });
        await pending; await delay(20);
        assert.equal(p.checkedAt, null); assert.deepEqual(p.modelsAvailable, []);
      }
      let release, signal;
      runtime.scheduler.detector = (input, opts) => { signal = opts.signal; return new Promise((resolve) => { release = resolve; }); };
      const pending = runtime.scheduler.runCheck(p.id), before = JSON.stringify(p), revision = runtime.scheduler.revision(p.id);
      runtime.ctx.persist = () => ({ ok: false, error: 'D02_SAVE_REJECTED' });
      assert.equal((await js('window.aipm.updateProvider(202, { apiKey: "REJECTED_KEY" })')).ok, false);
      assert.equal(JSON.stringify(p), before); assert.equal(runtime.scheduler.revision(p.id), revision); assert.equal(signal.aborted, false);
      runtime.ctx.persist = originalPersist;
      assert.equal((await js('window.aipm.updateProvider(202, { note: "keep running" })')).ok, true);
      assert.equal(signal.aborted, false);
      release({ status: 'up', latency: 1, modelsTotal: 1, modelsAvailable: ['CURRENT_RESULT'], checkedAt: Date.now() });
      await pending; await delay(20); assert.deepEqual(p.modelsAvailable, ['CURRENT_RESULT']);
      const rows = await runtime.ctx.history.readRange(TMP, 0, Date.now());
      assert.equal(rows.filter((r) => r.id === p.id).length, 1, 'discarded generations never reach history');
    } finally {
      runtime.ctx.persist = originalPersist; runtime.scheduler.detector = original;
      await js('await window.aipm.deleteProvider(202);'); runtime.scheduler.resume();
    }
  });
  await check('D15/D02: real multi-channel recovery/new fault stays ordered; old notification replies cannot revive reset state', async () => {
    const { normalizeProvider } = require('../src/providerSchema');
    const db = runtime.ctx.getDb(), before = structuredClone(db.global);
    const p = normalizeProvider({ id: 203, name: 'delivery fixture', url: base, intervalSec: 3600 });
    p.status = 'up'; p.modelBaseline = ['m1']; p.modelCatalog = ['m1']; db.providers.push(p);
    Object.assign(db.global, { alertFailThreshold: 1, alertQuietEnabled: false, alertRecoverNotify: true, alertEscalateMin: 0,
      notifyWeixinEnabled: true, weixinWebhook: base + '/alert-wx', notifyQQEnabled: true, qqWebhook: base + '/alert-qq', qqTarget: '1' });
    const sample = (status) => runtime.applyResult(p, { status, checkedAt: Date.now(), modelsTotal: status === 'up' ? 1 : 0,
      modelsAvailable: status === 'up' ? ['m1'] : [], modelDetails: [] }, 'D15 fixture');
    runtime.scheduler.pause(); alertTrace.length = 0;
    try {
      sample('down'); await until(() => p.alertRuntime?.inAlarm && !p.alertRuntime.pending.down, 'initial fault delivered');
      const firstIncident = p.alertRuntime.incident.id;
      sample('up'); await until(() => !!releaseRecovery, 'delayed QQ recovery');
      sample('down'); const newIncident = p.alertRuntime.incident.id; assert.notEqual(newIncident, firstIncident);
      const recoveryReply = releaseRecovery; releaseRecovery = null; recoveryReply(false);
      await until(() => p.alertRuntime.inAlarm && !p.alertRuntime.pending.down, 'new fault delivered after old partial recovery');
      for (const channel of ['weixin', 'qq']) assert.deepEqual(alertTrace.filter((r) => r.channel === channel).map((r) => r.kind), ['down', 'recover', 'down']);
      assert.ok(Object.values(p.alertRuntime.channels).every((r) => r.incidentId === newIncident && r.kind === 'down'));
      sample('up'); await until(() => !!releaseRecovery, 'old recovery pending during edit');
      assert.equal((await js('window.aipm.updateProvider(203, { apiKey: "FAKE_NEW_GENERATION" })')).ok, true);
      assert.equal(p.status, 'unknown'); assert.equal(p.alertRuntime, undefined);
      const oldReply = releaseRecovery; releaseRecovery = null; oldReply(true); await delay(80);
      assert.equal(p.alertRuntime, undefined, 'delivery acknowledgement from the old revision is ignored');
    } finally {
      if (releaseRecovery) { releaseRecovery(true); releaseRecovery = null; }
      runtime.scheduler.cancel(p.id); runtime.ctx.alerts.resetState(p.id);
      db.providers.splice(db.providers.indexOf(p), 1); Object.assign(db.global, before); runtime.scheduler.resume();
    }
  });
  await check('D08: public state and unchanged form preserve URL secrets without exposing them', async () => {
    const p = runtime.ctx.getDb().providers[1];
    const saved = structuredClone(p);
    const raw = base + '?Api_Key=FAKE_URL_KEY&region=cn';
    const patch = { url: raw, modelsPath: '/v1/models?token=FAKE_MODELS_KEY', probePath: '/probe?secret=FAKE_PROBE_KEY', quotaPath: '/quota?signature=FAKE_QUOTA_KEY',
      probeBody: '{"endpoint":"' + base + '?api_key=FAKE_BODY_KEY"}', note: 'Endpoint ' + base + '?token=FAKE_NOTE_KEY' };
    Object.assign(p, patch);
    try {
      const publicSnapshot = runtime.publicState(); assert.doesNotMatch(JSON.stringify(publicSnapshot), /FAKE_URL_KEY|FAKE_MODELS_KEY|FAKE_PROBE_KEY|FAKE_QUOTA_KEY|FAKE_BODY_KEY|FAKE_NOTE_KEY/);
      assert.match(publicSnapshot.providers[1].url, /region=cn/);
      await js(`state = await window.aipm.getState(); openProviderModal(${p.id});`);
      const form = await js('collectProviderForm()');
      assert.doesNotMatch(JSON.stringify(form), /FAKE_URL_KEY|FAKE_MODELS_KEY|FAKE_PROBE_KEY|FAKE_QUOTA_KEY/);
      assert.equal((await js(`window.aipm.updateProvider(${p.id}, collectProviderForm())`)).ok, true);
      for (const [key, value] of Object.entries(patch)) assert.equal(p[key], value);
      await js('document.querySelector("#fUrl").value = document.querySelector("#fUrl").value.replace("region=cn", "region=us");');
      assert.equal((await js(`window.aipm.updateProvider(${p.id}, collectProviderForm())`)).ok, true);
      assert.equal(p.url, raw.replace('region=cn', 'region=us'), 'ordinary URL edits keep masked credentials');
      const cloneResult = await js(`window.aipm.cloneProvider(${p.id})`);
      const clone = runtime.ctx.getDb().providers.find((x) => x.id === cloneResult.id);
      assert.doesNotMatch(JSON.stringify(clone), /FAKE_URL_KEY|FAKE_MODELS_KEY|FAKE_PROBE_KEY|FAKE_QUOTA_KEY/);
      await js(`await window.aipm.deleteProvider(${clone.id});`);
      await js(`document.querySelector('#fUrl').value = '${base}?region=us';`);
      assert.equal((await js(`window.aipm.updateProvider(${p.id}, collectProviderForm())`)).ok, true);
      assert.equal(p.url, base + '?region=us', 'explicit replacement can remove credentials');
    } finally { Object.keys(p).forEach((key) => delete p[key]); Object.assign(p, saved); await closeModal(); }
  });
  await check('D14: delayed key reveal cannot cross sessions, override typing/clear or affect a reopened form', async () => {
    const { ipcMain } = require('electron');
    const releases = [];
    ipcMain.removeHandler('provider:revealKey');
    ipcMain.handle('provider:revealKey', (e, id) => new Promise((resolve) => releases.push(() => resolve({ ok: true, apiKey: 'FAKE_DELAYED_KEY_' + id }))));
    const otherId = runtime.ctx.getDb().providers[1].id;
    const reveal = async () => {
      await js(`state = await window.aipm.getState(); openProviderModal(${providerId}); document.querySelector('#fKeyEye').click();`);
      await until(() => releases.length === 1, 'delayed reveal pending');
    };
    try {
      await reveal(); await closeModal(); await js(`openProviderModal(${otherId});`); releases.shift()(); await delay(40);
      assert.equal(await js('document.querySelector("#fKey").value'), ''); assert.equal(await js('collectProviderForm().apiKey'), undefined);
      await reveal(); await closeModal(); await js('openProviderModal();'); releases.shift()(); await delay(40);
      assert.equal(await js('document.querySelector("#fKey").value'), '');
      await reveal(); await closeModal(); await js(`openProviderModal(${providerId});`); releases.shift()(); await delay(40);
      assert.equal(await js('document.querySelector("#fKey").value'), '');
      await reveal();
      await js('document.querySelector("#fKey").value = "MANUAL_KEY"; document.querySelector("#fKey").dispatchEvent(new Event("input", { bubbles: true }));');
      releases.shift()(); await delay(40); assert.equal(await js('document.querySelector("#fKey").value'), 'MANUAL_KEY');
      await reveal(); await js('document.querySelector("#fKeyClear").click();'); releases.shift()(); await delay(40);
      assert.equal(await js('document.querySelector("#fKey").value'), ''); assert.equal(await js('collectProviderForm().apiKey'), '');
      await reveal(); await js('document.querySelector("#fKey").value = "typed"; document.querySelector("#fKey").dispatchEvent(new Event("input", { bubbles:true })); document.querySelector("#fKey").value = ""; document.querySelector("#fKey").dispatchEvent(new Event("input", { bubbles:true }));');
      releases.shift()(); await delay(40); assert.equal(await js('document.querySelector("#fKey").value'), '');
    } finally {
      ipcMain.removeHandler('provider:revealKey');
      ipcMain.handle('provider:revealKey', (e, id) => ({ ok: true, apiKey: runtime.ctx.getDb().providers.find((p) => p.id === Number(id))?.apiKey || '' }));
      await closeModal();
    }
  });
  await check('D14: delayed connection test and save responses cannot repaint or close a different form', async () => {
    const { ipcMain } = require('electron');
    const releases = [], otherId = runtime.ctx.getDb().providers[1].id;
    ipcMain.removeHandler('provider:testConn');
    ipcMain.handle('provider:testConn', () => new Promise((resolve) => releases.push(() => resolve({ ok: true, result: { status: 'up', latency: 777, available: 7, modelsTotal: 7 } }))));
    try {
      await js(`openProviderModal(${providerId}); document.querySelector('#fTestConn').click();`); await until(() => releases.length === 1, 'old test');
      await closeModal(); await js(`openProviderModal(${otherId}); document.querySelector('#fTestConn').click();`); await until(() => releases.length === 2, 'new test');
      releases.shift()(); await delay(40);
      assert.equal(await js('document.querySelector("#fTestHint").textContent'), '测试中…');
      assert.equal(await js('document.querySelector("#fTestConn").disabled'), true);
      releases.shift()(); await until(() => js('document.querySelector("#fTestHint").textContent.includes("777")'), 'current test result');
      await js('document.querySelector("#fTestConn").click();'); await until(() => releases.length === 1, 'edited test');
      await js('document.querySelector("#fUrl").value += "/changed"; document.querySelector("#fUrl").dispatchEvent(new Event("input", { bubbles:true }));');
      releases.shift()(); await delay(40);
      assert.equal(await js('document.querySelector("#fTestHint").textContent'), ''); assert.equal(await js('document.querySelector("#fTestConn").disabled'), false);
    } finally { ipcMain.removeHandler('provider:testConn'); await closeModal(); }
    let release;
    // Delay a successful IPC acknowledgement to exercise the renderer save callback.
    ipcMain.removeHandler('provider:update');
    ipcMain.handle('provider:update', () => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
    try {
      await js(`openProviderModal(${providerId}); document.querySelector('#pmSave').click();`); await until(() => !!release, 'delayed save');
      await closeModal(); await js(`openProviderModal(${otherId});`); release(); await delay(40);
      assert.equal(await js('document.querySelector("#providerModal").classList.contains("show")'), true);
      assert.equal(await js('editingId'), otherId); assert.equal(await js('document.querySelector("#pmSave").disabled'), false);
    } finally {
      // Restore the production handlers for the rest of this process.
      for (const name of ['add', 'clone', 'update', 'delete', 'deleteMany', 'revealKey', 'copyKey', 'testConn', 'checkNow', 'checkAll', 'toggleEnabled', 'bulkUpdate', 'reorder']) require('electron').ipcMain.removeHandler('provider:' + name);
      require('../src/ipc/providers').register(runtime.ctx); await closeModal();
    }
  });
  await check('renderer has no errors across exercised views', async () => { assert.deepEqual(errors, []); });
  // Keep useful screenshots without changing the user's desktop or actual data.
  await win.webContents.insertCSS('* { animation: none !important; transition: none !important; } .modal-mask { opacity:0 !important; } .modal-mask.show { opacity:1 !important; }');
  const shots = path.join(__dirname, '..', 'uishots'); fs.mkdirSync(shots, { recursive: true });
  const screenshot = async (name) => {
    // The first capture wakes a hidden compositor; the second records the new frame.
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await delay(120);
    fs.writeFileSync(path.join(shots, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  };
  await closeModal(); await js('pendingSettings = null; navTo(\'stats\');'); await delay(300);
  await js('document.querySelector(\'#toastWrap\').innerHTML = \'\';');
  await screenshot('v1.6-slo.png');
  await js('openProviderModal();'); await delay(400);
  assert.equal(await js('document.querySelector(\'#providerModal\').classList.contains(\'show\')'), true);
  await screenshot('v1.6-provider-basic.png');
  await js('document.querySelector(\'#fAdvanced\').open = true;'); await delay(100);
  await screenshot('v1.6-provider-advanced.png');
  await runtime.ctx.history.flush(); runtime.flushPersistSoon();
  console.log(`INTEGRATION-OK: ${checks.length} checks; isolated data ${TMP}`);
  srv.closeAllConnections(); srv.close(); app.quit();
})().catch((err) => {
  console.error('INTEGRATION-FAILED', err); console.error('Renderer errors:', errors);
  if (runtime) runtime.scheduler.stop(); if (srv) { srv.closeAllConnections(); srv.close(); }
  app.exit(1);
});
