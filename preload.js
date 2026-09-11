'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aipm', {
  getState: () => ipcRenderer.invoke('state:get'),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  addProvider: (data) => ipcRenderer.invoke('provider:add', data),
  updateProvider: (id, data) => ipcRenderer.invoke('provider:update', { id, data }),
  deleteProvider: (id) => ipcRenderer.invoke('provider:delete', id),
  deleteMany: (ids) => ipcRenderer.invoke('provider:deleteMany', ids),
  checkNow: (ids) => ipcRenderer.invoke('provider:checkNow', ids),
  checkAll: () => ipcRenderer.invoke('provider:checkAll'),
  toggleEnabled: (id, enabled) => ipcRenderer.invoke('provider:toggleEnabled', { id, enabled }),
  setGlobal: (patch) => ipcRenderer.invoke('global:set', patch),
  testNotify: (channel) => ipcRenderer.invoke('notify:test', channel),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  backupExport: (filePath) => ipcRenderer.invoke('backup:export', filePath),
  backupSaveAs: () => ipcRenderer.invoke('backup:saveAs'),
  backupPickFile: () => ipcRenderer.invoke('backup:pickFile'),
  backupRestore: (filePath, mode) => ipcRenderer.invoke('backup:restore', { filePath, mode }),
  backupListAuto: () => ipcRenderer.invoke('backup:listAuto'),
  backupRunAuto: () => ipcRenderer.invoke('backup:runAuto'),
  onStateChanged: (fn) => { const h = (_e, s) => fn(s); ipcRenderer.on('state-changed', h); return () => ipcRenderer.removeListener('state-changed', h); },
  onLogLine: (fn) => { const h = (_e, l) => fn(l); ipcRenderer.on('log:line', h); return () => ipcRenderer.removeListener('log:line', h); }
});
