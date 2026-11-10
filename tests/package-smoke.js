'use strict';
// Launch only our new packages, hidden and with temporary application/profile data.
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const asar = require('@electron/asar');
const version = require('../package.json').version;
const ROOT = path.resolve(__dirname, '..'), output = path.resolve(process.argv[2] || path.join(ROOT, 'dist-v' + version));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-package-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await delay(60); }
  throw new Error('Timeout: ' + label);
}
async function freePort() {
  const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
class CDP {
  constructor(url) {
    this.socket = new globalThis.WebSocket(url); this.sequence = 0; this.pending = new Map(); this.errors = [];
    this.ready = new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
    this.socket.onmessage = ({ data }) => {
      const result = JSON.parse(data);
      if (result.id) {
        const pending = this.pending.get(result.id); if (!pending) return;
        this.pending.delete(result.id); clearTimeout(pending.timer);
        if (result.error) pending.reject(new Error(JSON.stringify(result.error))); else pending.resolve(result.result);
      } else if (result.method === 'Runtime.exceptionThrown') this.errors.push(JSON.stringify(result.params.exceptionDetails));
      else if (result.method === 'Runtime.consoleAPICalled' && result.params.type === 'error') this.errors.push(JSON.stringify(result.params.args));
    };
  }
  async call(method, params = {}) {
    await this.ready; const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 6000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async js(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.socket.close(); }
}
async function launch(executable, label) {
  const dir = path.join(TMP, label), profile = path.join(dir, 'profile'), data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'providers.json'), JSON.stringify({ global: {
    autoStartCheckOnLaunch: false, launchMinimized: true, hotkeyEnabled: false, autoUpdateCheck: false, closeAction: 'exit'
  }, providers: [] }));
  const port = await freePort(), mainPort = await freePort();
  const child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--inspect=127.0.0.1:${mainPort}`],
    { env: { ...process.env, AIPM_DATA_DIR: data, AIPM_INTEGRATION_TEST: '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false, outputText = '', code, client, mainClient;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (value) => { exited = true; code = value; resolve(value); });
  });
  child.stdout.on('data', (chunk) => { outputText += chunk; }); child.stderr.on('data', (chunk) => { outputText += chunk; });
  try {
    const target = await until(async () => {
      if (exited) throw new Error(`Package exited early (${code}): ${outputText}`);
      try { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); return targets.find((t) => t.type === 'page' && t.url.endsWith('renderer/index.html')); }
      catch (e) { return null; }
    }, label + ' renderer');
    client = new CDP(target.webSocketDebuggerUrl); await client.call('Runtime.enable');
    const mainTarget = await (await fetch(`http://127.0.0.1:${mainPort}/json/list`)).json();
    mainClient = new CDP(mainTarget[0].webSocketDebuggerUrl);
    assert.equal(await mainClient.js('process.mainModule.require("electron").app.isPackaged'), true);
    assert.equal(await mainClient.js('process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].isVisible()'), false);
    await until(() => client.js('!!window.aipm && document.querySelector("#appVersion")?.textContent === "V' + version + '"'), 'packaged preload');
    const state = await client.js('window.aipm.getState()'); assert.equal(state.dataDir, data); assert.equal(state.providers.length, 0);
    assert.equal(await client.js('window.aipm.getAppVersion()'), version);
    assert.equal((await client.js('window.aipm.historySLO()')).windowDays, 30);
    const added = await client.js('window.aipm.addProvider({ name:"Package fixture", url:"http://127.0.0.1:9", intervalSec:31536000, sloTarget:99.95 })');
    assert.equal(added.ok, true);
    const cloned = await client.js(`window.aipm.cloneProvider(${added.id})`); assert.equal(cloned.ok, true);
    const after = await client.js('window.aipm.getState()'); assert.equal(after.providers.length, 2);
    assert.equal(after.providers[1].enabled, false); assert.equal(after.providers[1].sloTarget, 99.95);
    await client.js('navTo("stats");');
    await until(() => client.js('document.querySelector("#sloTable").textContent.includes("数据不足")'), 'packaged SLO UI');
    assert.equal(await client.js('document.querySelector("#stScope").value'), 'current');
    await client.js('navTo("settings");');
    assert.equal(await client.js('[...document.querySelectorAll("#hotkeyRecorder kbd")].map((e) => e.textContent).join("+")'), 'Ctrl+Alt+M');
    assert.equal((await client.js('window.aipm.setHotkeyCapture(true)')).ok, true);
    assert.equal((await client.js('window.aipm.setHotkeyCapture(false)')).ok, true);
    assert.equal(await client.js('document.querySelector("#settings-appearance").hidden'), false);
    await client.js('document.querySelector("#settings-tab-checks").click();');
    assert.equal(await client.js('!document.querySelector("#settings-checks").hidden && document.querySelector("#settings-appearance").hidden'), true);
    await client.js('navTo("providers"); document.querySelector("#searchInput").value = "no-such-provider"; document.querySelector("#searchInput").dispatchEvent(new Event("input"));');
    assert.equal(await client.js('!!document.querySelector("[data-provider-empty=clear]")'), true);
    await client.js('document.querySelector("#providerClearFilters").click();');
    assert.equal(await client.js('document.querySelectorAll("#providerList .p-row").length'), 2);
    await client.js('navTo("providers"); openProviderModal();');
    assert.equal(await client.js('document.querySelector("#fAdvanced").open'), false);
    assert.ok(await client.js('document.querySelector("#fTemplate").options.length >= 7'));
    assert.deepEqual(client.errors, []);
    // Close the actual Electron window so the product's closeAction/quit/flush handlers run.
    await mainClient.js('setTimeout(() => process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].close(), 50); true');
    mainClient.close(); mainClient = null; client.close(); client = null;
    const exitCode = await Promise.race([closed, delay(8000).then(() => { throw new Error('Package did not exit normally'); })]);
    assert.equal(exitCode, 0);
    const persisted = JSON.parse(fs.readFileSync(path.join(data, 'providers.json'), 'utf8'));
    assert.equal(persisted.providers.length, 2); assert.equal(persisted.global.sloWindowDays, 30);
    console.log(`PASS ${label}: isolated hidden startup, real preload/IPC, clone, SLO, form, settings categories, filters and graceful exit`);
  } finally {
    if (client) client.close(); if (mainClient) mainClient.close();
    // A timeout may terminate only the exact helper process created above.
    if (!exited) child.kill();
  }
}
(async () => {
  const archive = path.join(output, 'win-unpacked', 'resources', 'app.asar');
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString()); assert.equal(packaged.version, version);
  const sourceFiles = ['main.js', 'preload.js'];
  const collect = (dir) => { for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = dir + '/' + entry.name; if (entry.isDirectory()) collect(relative); else sourceFiles.push(relative);
  } };
  collect('src'); collect('renderer'); collect('assets');
  for (const file of sourceFiles) assert.ok(asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(ROOT, file))), 'stale package source: ' + file);
  assert.equal(packaged.dependencies.nodemailer, require('../package.json').dependencies.nodemailer);
  console.log(`PASS package content: version ${version}, ${sourceFiles.length} source/assets match final workspace`);
  await launch(path.join(output, 'win-unpacked', 'AI Provider Monitor.exe'), 'unpacked');
  await launch(path.join(output, `AIProviderMonitor-Portable-${version}.exe`), 'portable');
  console.log('PACKAGE-SMOKE-OK: data isolated at ' + TMP);
})().catch((err) => { console.error('PACKAGE-SMOKE-FAILED', err); process.exitCode = 1; });
