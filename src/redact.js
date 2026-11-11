'use strict';

const URL_FIELDS = ['url', 'modelsPath', 'probePath', 'quotaPath'];
const MASK = '***';
function sensitiveParam(key) {
  let decoded = String(key);
  try { decoded = decodeURIComponent(decoded.replace(/\+/g, ' ')); } catch (e) { /* keep malformed names */ }
  return /^(?:apikey|key|token|accesstoken|refreshtoken|idtoken|secret|clientsecret|password|passwd|pwd|auth|authorization|credential|credentials|signature|sig|sign|accesskey|accesskeyid|subscriptionkey|xapikey|xgoogapikey|code)$/i.test(decoded.replace(/[-_\s.]/g, ''));
}

/** Preserve the path, ordinary parameters, order and escaping of the original URL. */
function redactUrl(value, { remove = false } = {}) {
  const raw = String(value || '').replace(/(\bhttps?:\/\/)[^/?#\s]*@/gi, (_, scheme) => scheme + (remove ? '' : MASK + '@'));
  const at = raw.indexOf('?');
  if (at < 0) return raw;
  const hashAt = raw.indexOf('#', at), end = hashAt < 0 ? raw.length : hashAt;
  const parts = raw.slice(at + 1, end).split('&').flatMap((part) => {
    const eq = part.indexOf('='), key = eq < 0 ? part : part.slice(0, eq);
    if (!sensitiveParam(key)) return [part];
    return remove ? [] : [key + '=' + MASK];
  });
  return raw.slice(0, at) + (parts.length ? '?' + parts.join('&') : '') + raw.slice(end);
}

function redactText(value) {
  return String(value ?? '').replace(/\bhttps?:\/\/[^\s<>"'\\]+/gi, (url) => redactUrl(url))
    .replace(/([?&])([^?&#=\s<>"'\\]+)=([^&#\s<>"'\\]*)/g,
      (match, prefix, key) => sensitiveParam(key) ? prefix + key + '=' + MASK : match);
}

function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redactValue(v)]));
  return value;
}

// The UI receives display URLs. Keep saved values for unchanged masks, including when
// the user edits a non-secret parameter. Removing a parameter or entering a value replaces it.
function urlPatch(value, saved) {
  if (value === undefined || value === redactUrl(saved)) return saved;
  const previous = String(saved || ''), parameters = new Map();
  const paramKey = (key) => { try { return decodeURIComponent(key).toLowerCase(); } catch (e) { return key.toLowerCase(); } };
  const query = previous.split('?')[1]?.split('#')[0] || '';
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0 || !sensitiveParam(part.slice(0, eq))) continue;
    const key = paramKey(part.slice(0, eq));
    if (!parameters.has(key)) parameters.set(key, []);
    parameters.get(key).push(part.slice(eq + 1));
  }
  const offsets = new Map();
  return String(value).replace(/(\bhttps?:\/\/)\*\*\*@/gi, (mask, scheme) => {
    const credentials = /^https?:\/\/([^/?#]*@)/i.exec(previous);
    if (!credentials) throw new Error('请填写 URL 中的凭据，或删除已脱敏的凭据');
    return scheme + credentials[1];
  }).replace(/([?&])([^&#=]+)=([^&#]*)/g, (match, prefix, key, val) => {
    if (!sensitiveParam(key)) return match;
    const name = paramKey(key), index = offsets.get(name) || 0;
    offsets.set(name, index + 1);
    if (val !== MASK && val.toLowerCase() !== '%2a%2a%2a') return match;
    const original = parameters.get(name)?.[index];
    if (original === undefined) throw new Error('请填写 URL 参数中的凭据，或删除已脱敏参数');
    return prefix + key + '=' + original;
  });
}

module.exports = { URL_FIELDS, MASK, sensitiveParam, redactUrl, redactText, redactValue, urlPatch };
