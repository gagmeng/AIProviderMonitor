'use strict';

function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch (e) {
    return false;
  }
}

/** 跨源重定向时去掉鉴权头，避免把 API Key / Token 带到新主机 */
function headersForRedirect(fromUrl, toUrl, headers) {
  const next = Object.assign({}, headers || {});
  if (!sameOrigin(fromUrl, toUrl)) {
    for (const k of Object.keys(next)) {
      if (/^(authorization|cookie|proxy-authorization)$/i.test(k)) delete next[k];
    }
  }
  return next;
}

module.exports = { sameOrigin, headersForRedirect };
