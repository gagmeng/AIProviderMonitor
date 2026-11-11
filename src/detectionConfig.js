'use strict';
const { freshRuntime } = require('./providerSchema');

// Only fields that change what is checked or how the request is made belong here.
const PROVIDER_FIELDS = ['enabled', 'url', 'apiKey', 'authType', 'authHeader', 'authPrefix', 'customHeaders',
  'modelsPath', 'probeMode', 'probePolicy', 'probePath', 'probeBody', 'probeLimit', 'capabilityModes',
  'assertType', 'assertValue', 'modelIgnorePattern', 'quotaPath', 'quotaValuePath', 'quotaWarnBelow',
  'measureStreaming', 'proxyUrl', 'useProxy', 'insecureSkipVerify', 'requestTimeoutMs', 'probeTimeoutMs'];
const GLOBAL_FIELDS = ['probeLimit', 'requestTimeoutMs', 'probeTimeoutMs', 'retries', 'probeConcurrency',
  'probeJitterMs', 'probeRotate', 'proxyEnabled', 'proxyUrl', 'insecureSkipVerify'];

function detectionKey(provider = {}, globalCfg = {}) {
  return JSON.stringify([PROVIDER_FIELDS.map((key) => provider[key] ?? null), GLOBAL_FIELDS.map((key) => globalCfg[key] ?? null)]);
}

/** Stage runtime resets in the same persistence transaction as the configuration. */
function prepareDetectionChanges(db, before) {
  const previous = new Map(before.providers.map((p) => [p.id, p]));
  const changed = [];
  for (const p of db.providers) {
    const old = previous.get(p.id);
    if (old && detectionKey(old, before.global) !== detectionKey(p, db.global)) {
      Object.assign(p, freshRuntime()); delete p.alertRuntime;
      changed.push(p.id);
    }
  }
  return changed;
}

function restoreProvider(provider, before) {
  for (const key of Object.keys(provider)) delete provider[key];
  Object.assign(provider, before);
}

module.exports = { detectionKey, prepareDetectionChanges, restoreProvider };
