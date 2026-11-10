'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.AIPM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-render-'));
const { app, ipcMain } = require('electron');
app.setPath('userData', path.join(process.env.AIPM_DATA_DIR, 'electron'));
const { DEFAULT_GLOBAL } = require('../src/store');
const fixture = {
  global: { ...DEFAULT_GLOBAL }, providers: [], running: [], schedule: [], paused: false,
  unread: { count: 0, items: [] }, selfmon: { notifyHealth: {} }, dataDir: process.env.AIPM_DATA_DIR,
  logDir: process.env.AIPM_DATA_DIR, dataFile: path.join(process.env.AIPM_DATA_DIR, 'providers.json'),
  logLines: [], logFileList: [], backupList: []
};
function registerFixture() {
  const history = require('../src/history');
  const handle = (name, fn) => ipcMain.handle(name, (_e, payload) => fn(payload));
  handle('state:get', () => fixture);
  handle('app:version', () => require('../package.json').version);
  handle('app:hotkeyCapture', () => ({ ok: true }));
  handle('history:summary', (opts) => history.summarize(process.env.AIPM_DATA_DIR, { ...opts, providers: fixture.providers }).then((r) => ({ ok: true, ...r })));
  handle('history:slo', (opts) => history.summarize(process.env.AIPM_DATA_DIR, { hours: fixture.global.sloWindowDays * 24, ...opts, providers: fixture.providers }).then((r) => ({ ok: true, windowDays: fixture.global.sloWindowDays, ...r })));
  handle('history:series', (opts) => history.series(process.env.AIPM_DATA_DIR, { ...opts, providers: fixture.providers }).then((r) => ({ ok: true, ...r })));
  handle('history:perDay', (opts) => history.perDay(process.env.AIPM_DATA_DIR, opts).then((r) => ({ ok: true, ...r })));
  handle('history:modelRates', (opts) => history.modelRates(process.env.AIPM_DATA_DIR, opts.providerId, opts).then((r) => ({ ok: true, ...r })));
  handle('global:set', (patch) => { Object.assign(fixture.global, patch); return { ok: true }; });
  handle('global:clearSecrets', (keys) => { for (const key of keys) fixture.global[key] = ''; return { ok: true }; });
  handle('logs:get', () => fixture.logLines);
  handle('logs:files', () => ({ ok: true, list: fixture.logFileList }));
  handle('backup:listAuto', () => ({ ok: true, list: fixture.backupList }));
  handle('provider:checkAll', () => ({ ok: true }));
  handle('provider:checkNow', () => ({ ok: true }));
  handle('app:setPaused', (paused) => { fixture.paused = paused; return { ok: true }; });
}
module.exports = { registerFixture, fixture };
