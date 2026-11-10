'use strict';
const http = require('http');
const https = require('https');

/** Bound the whole request and settle on every response exit, including premature close. */
function requestRaw(target, { method = 'GET', headers = {}, body = null, timeout = 20000,
  deadlineAt = Date.now() + timeout, agent, insecureSkipVerify = false, signal,
  maxBytes = 5 * 1024 * 1024, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(target); } catch (e) { reject(new Error('请求 URL 无效')); return; }
    if (!['http:', 'https:'].includes(url.protocol)) { reject(new Error('请求仅支持 HTTP/HTTPS')); return; }
    if (signal && signal.aborted) { reject(new Error('检测已取消')); return; }
    let settled = false, timer, req;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (err) reject(err); else resolve(value);
    };
    const abort = () => { const err = new Error('检测已取消'); finish(err); if (req) req.destroy(err); };
    try {
      req = (url.protocol === 'http:' ? http : https).request(url, {
        method, headers, agent, rejectUnauthorized: !insecureSkipVerify
      }, (res) => {
        let data = '', bytes = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxBytes) { const err = new Error('响应过大'); finish(err); req.destroy(err); return; }
          try { if (onChunk) onChunk(chunk, res); else data += chunk; }
          catch (err) { finish(err); req.destroy(err); }
        });
        res.on('aborted', () => finish(new Error('响应中途断开')));
        res.on('error', (err) => finish(err));
        res.on('close', () => { if (!res.complete) finish(new Error('响应未完整接收')); });
        res.on('end', () => finish(null, { statusCode: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('error', (err) => finish(err));
      timer = setTimeout(() => {
        const err = new Error('请求超时'); finish(err); req.destroy(err);
      }, Math.max(1, deadlineAt - Date.now()));
      if (signal) signal.addEventListener('abort', abort, { once: true });
      if (body != null) req.write(body);
      req.end();
    } catch (err) { finish(err); if (req) req.destroy(); }
  });
}

module.exports = { requestRaw };
