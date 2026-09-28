'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');
const { headersForRedirect } = require('./httpguard');

const DEFAULT_REQUEST_TIMEOUT = 20000;
const DEFAULT_PROBE_TIMEOUT = 15000;
const DEFAULT_PROBE_LIMIT = 20;
const DEFAULT_PROBE_CONCURRENCY = 8;
const DEFAULT_PROBE_JITTER_MS = 120;
const DEFAULT_RETRIES = 1;
const RETRY_BACKOFF_MS = 800;
const MAX_REDIRECTS = 3;

/** 惰性加载代理 agent（仅在配置了代理时才需要 https-proxy-agent，缺失则降级直连） */
let ProxyAgentCtor = null;
let proxyAgentChecked = false;
function getProxyAgent(proxyUrl, insecureSkipVerify) {
  if (!proxyUrl) return null;
  if (!proxyAgentChecked) {
    proxyAgentChecked = true;
    try {
      ProxyAgentCtor = require('https-proxy-agent').HttpsProxyAgent;
    } catch (e) {
      logger.warn('[代理] 未安装 https-proxy-agent，代理配置将被忽略（npm i https-proxy-agent）');
      ProxyAgentCtor = null;
    }
  }
  if (!ProxyAgentCtor) return null;
  try {
    // 代理自己建 TLS，request 上的 rejectUnauthorized 不一定生效
    const opts = insecureSkipVerify ? { rejectUnauthorized: false } : undefined;
    return opts ? new ProxyAgentCtor(proxyUrl, opts) : new ProxyAgentCtor(proxyUrl);
  } catch (e) {
    logger.warn(`[代理] 代理地址无效: ${proxyUrl}`);
    return null;
  }
}

/** 解析本次请求应使用的代理地址：服务商级 > 全局 > 环境变量 */
function resolveProxy(provider, globalCfg) {
  const own = String((provider && provider.proxyUrl) || '').trim();
  if (own) return own;
  if (provider && provider.useProxy === false) return '';
  const g = globalCfg || {};
  if (g.proxyEnabled && String(g.proxyUrl || '').trim()) return String(g.proxyUrl).trim();
  return '';
}

function fetchJSON(targetUrl, { method = 'GET', headers = {}, body = null, timeout = DEFAULT_REQUEST_TIMEOUT, proxy = '', insecureSkipVerify = false, _redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new Error(`URL 无效: ${targetUrl}`)); }
    const mod = u.protocol === 'http:' ? http : https;
    const opts = { method, headers, timeout };
    if (mod === https && insecureSkipVerify) opts.rejectUnauthorized = false;
    const agent = getProxyAgent(proxy, insecureSkipVerify);
    if (agent) opts.agent = agent;
    const req = mod.request(u, opts, (res) => {
      // 重定向跟随（≤3 跳）：http→https 等站点不再被误判离线
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && _redirects < MAX_REDIRECTS) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); }
        catch (e) { reject(new Error(`重定向地址无效: ${res.headers.location}`)); return; }
        const m = res.statusCode === 303 ? 'GET' : method;
        resolve(fetchJSON(next, {
          method: m,
          headers: headersForRedirect(u.toString(), next, headers),
          body: m === 'GET' ? null : body,
          timeout, proxy, insecureSkipVerify, _redirects: _redirects + 1
        }));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 5 * 1024 * 1024) req.destroy(new Error('响应过大')); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`响应不是有效 JSON (HTTP ${res.statusCode})`)); }
        } else {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          const retryAfter = res.headers['retry-after'];
          if (retryAfter) {
            const seconds = Number(retryAfter);
            const at = Date.parse(retryAfter);
            err.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : (Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0);
          }
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => reject(e));
    if (body != null) req.write(body);
    req.end();
  });
}

/** 判断错误是否值得重试：网络层抖动与 5xx/429 可重试；4xx 语义明确不重试 */
function isRetryable(err) {
  const msg = String((err && err.message) || err);
  if (/^HTTP 4(0[0-9]|1[0-9]|2[0-9])\b/.test(msg) && !/^HTTP 429\b/.test(msg)) return false;
  if (/^HTTP 429\b/.test(msg)) return true;
  if (/^HTTP 5\d\d\b/.test(msg)) return true;
  if (/超时|timeout|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return true;
  if (/响应不是有效 JSON/.test(msg)) return false;
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带退避重试的请求封装 */
async function fetchWithRetry(url, opts, { retries = DEFAULT_RETRIES, tag = '', what = '请求' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJSON(url, opts);
    } catch (e) {
      lastErr = e;
      if (attempt >= retries || !isRetryable(e)) break;
      const wait = Math.min(60000, Number(e.retryAfterMs) > 0 ? Number(e.retryAfterMs) : RETRY_BACKOFF_MS * Math.pow(2, attempt));
      logger.debug(`${tag} ${what}失败（${e.message}），${wait} ms 后第 ${attempt + 1} 次重试`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * 限流并发池：最多 limit 路并行，每项启动前随机抖动 0-jitterMs，
 * 避免大列表探测形成请求突发（自触发 429 / 占满 socket）。
 */
async function mapPool(items, limit, fn, jitterMs = 0) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit > 0 ? limit : 1, items.length || 1));
  const workers = new Array(n).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      if (jitterMs > 0) await sleep(Math.floor(Math.random() * jitterMs));
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function extractModelIds(payload) {
  // OpenAI: { data: [{id}] }; Ollama: { models: [{name}] }
  if (Array.isArray(payload)) return payload.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  if (payload && Array.isArray(payload.data)) return payload.data.map((m) => m.id || m.name).filter(Boolean);
  if (payload && Array.isArray(payload.models)) return payload.models.map((m) => m.id || m.name).filter(Boolean);
  return [];
}

function extractContent(payload) {
  try {
    return payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? '';
  } catch (e) { return ''; }
}

function valueAtPath(payload, path) {
  return String(path || '').split('.').filter(Boolean)
    .reduce((cur, key) => cur == null ? undefined : cur[key], payload);
}

function filterIgnoredModels(models, pattern) {
  const raw = String(pattern || '').trim();
  if (!raw) return models;
  const re = new RegExp(raw, 'i');
  return models.filter((id) => !re.test(String(id)));
}

function extractSSEDelta(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('data:')) return '';
  const raw = text.slice(5).trim();
  if (!raw || raw === '[DONE]') return '';
  try {
    const obj = JSON.parse(raw);
    return String(obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.text ?? '');
  } catch (e) { return ''; }
}

function measureOpenAIStream(base, modelId, provider, { headers, timeout, proxy, insecureSkipVerify }) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}/v1/chat/completions`);
    const mod = u.protocol === 'http:' ? http : https;
    const opts = { method: 'POST', headers, timeout };
    if (mod === https && insecureSkipVerify) opts.rejectUnauthorized = false;
    const agent = getProxyAgent(proxy, insecureSkipVerify);
    if (agent) opts.agent = agent;
    const started = Date.now();
    let firstTokenAt = 0, chars = 0, pending = '';
    const req = mod.request(u, opts, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); const err = new Error(`HTTP ${res.statusCode}`); err.statusCode = res.statusCode; reject(err); return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
        for (const line of lines) {
          const delta = extractSSEDelta(line);
          if (delta) { if (!firstTokenAt) firstTokenAt = Date.now(); chars += delta.length; }
        }
      });
      res.on('end', () => {
        const ended = Date.now();
        const generationMs = firstTokenAt ? Math.max(1, ended - firstTokenAt) : 0;
        resolve({ firstTokenMs: firstTokenAt ? firstTokenAt - started : null, throughputTokensPerSec: generationMs ? Number(((chars / 4) / (generationMs / 1000)).toFixed(2)) : null, outputChars: chars });
      });
    });
    req.on('timeout', () => req.destroy(new Error('流式探测超时')));
    req.on('error', reject);
    req.write(JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply with pong.' }], max_tokens: 16, stream: true }));
    req.end();
  });
}

function providerHeaders(provider) {
  const headers = { 'Content-Type': 'application/json' };
  const type = String((provider && provider.authType) || 'bearer');
  if (provider && provider.apiKey && type !== 'none') {
    const name = type === 'header' ? String(provider.authHeader || 'X-API-Key').trim() : 'Authorization';
    const prefix = type === 'header' ? String(provider.authPrefix || '') : 'Bearer ';
    if (name) headers[name] = `${prefix}${provider.apiKey}`;
  }
  const raw = String((provider && provider.customHeaders) || '').trim();
  if (raw) {
    let extra;
    try { extra = JSON.parse(raw); } catch (e) { throw new Error('自定义请求头不是合法 JSON'); }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('自定义请求头必须是 JSON 对象');
    for (const [k, v] of Object.entries(extra)) if (k && v != null) headers[k] = String(v);
  }
  return headers;
}

function assertProbeResponse(payload, provider) {
  const type = String((provider && provider.assertType) || 'none');
  const expected = String((provider && provider.assertValue) || '');
  if (type === 'none' || !expected) return true;
  if (type === 'contains') {
    if (!JSON.stringify(payload).includes(expected)) throw new Error(`响应断言失败：未包含 ${expected}`);
    return true;
  }
  if (type === 'jsonPath') {
    const value = expected.split('.').filter(Boolean).reduce((cur, key) => cur == null ? undefined : cur[key], payload);
    if (value === undefined || value === null || value === false) throw new Error(`响应断言失败：路径 ${expected} 不存在或为空`);
    return true;
  }
  throw new Error(`不支持的响应断言类型: ${type}`);
}

/**
 * 构造单模型探测请求。probeMode 决定探测端点与请求体：
 * - chat（默认）：POST /v1/chat/completions
 * - embeddings   ：POST /v1/embeddings（适用于纯向量服务）
 * - completions  ：POST /v1/completions（老式补全接口）
 * - custom       ：POST provider.probePath，请求体为 provider.probeBody 模板（{{model}} 占位）
 * - none         ：不做单模型探测，仅凭模型列表判定
 */
function buildProbeRequest(base, modelId, provider) {
  const mode = String((provider && provider.probeMode) || 'chat');
  if (mode === 'embeddings') {
    return { url: `${base}/v1/embeddings`, body: JSON.stringify({ model: modelId, input: 'ping' }) };
  }
  if (mode === 'completions') {
    return { url: `${base}/v1/completions`, body: JSON.stringify({ model: modelId, prompt: 'ping', max_tokens: 1 }) };
  }
  if (mode === 'custom') {
    const p = String(provider.probePath || '/v1/chat/completions');
    const path = p.startsWith('/') ? p : `/${p}`;
    let body = String(provider.probeBody || '').trim();
    if (!body) body = JSON.stringify({ model: '{{model}}', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
    // 函数替换，避免模型名里的引号、$ 破坏 JSON
    body = body.replace(/\{\{\s*model\s*\}\}/g, () => JSON.stringify(String(modelId)).slice(1, -1));
    return { url: `${base}${path}`, body };
  }
  return {
    url: `${base}/v1/chat/completions`,
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false })
  };
}

/**
 * 检测单个服务商：连接状态 + 模型列表 + 模型可用性
 * 全过程输出详细日志：连接阶段（延迟/HTTP状态）、模型列表（格式/数量）、逐模型探测（结果/原因/耗时）、阶段汇总。
 *
 * opts: { probeLimit, requestTimeout, probeTimeout, retries, globalCfg }
 * 未传时回退到服务商字段 → 全局配置 → 内置默认值。
 */
async function detect(provider, opts = {}) {
  const g = opts.globalCfg || {};
  const base = String(provider.url || '').replace(/\/+$/, '');
  const tag = `[${provider.name}]`;
  let headers;
  try { headers = providerHeaders(provider); }
  catch (e) {
    return { providerId: provider.id, checkedAt: Date.now(), status: 'down', latency: null, modelsTotal: 0, modelsAvailable: [], modelsUnavailable: [], modelsUnprobed: [], modelDetails: [], error: e.message, durationMs: 0, probeCursor: 0 };
  }

  const num = (...vals) => {
    for (const v of vals) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; }
    return undefined;
  };
  const probeLimit = num(opts.probeLimit, provider.probeLimit, g.probeLimit) || DEFAULT_PROBE_LIMIT;
  const requestTimeout = num(opts.requestTimeout, provider.requestTimeoutMs, g.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT;
  const probeTimeout = num(opts.probeTimeout, provider.probeTimeoutMs, g.probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT;
  const retries = Number.isFinite(Number(opts.retries)) ? Number(opts.retries)
    : (Number.isFinite(Number(g.retries)) ? Number(g.retries) : DEFAULT_RETRIES);
  const proxy = resolveProxy(provider, g);
  const probeMode = String(provider.probeMode || 'chat');
  const probeConcurrency = Math.max(1, Math.floor(num(opts.probeConcurrency, g.probeConcurrency) || DEFAULT_PROBE_CONCURRENCY));
  const probeJitterMs = Math.max(0, Math.floor(num(opts.probeJitterMs, g.probeJitterMs) || DEFAULT_PROBE_JITTER_MS));
  const probeRotate = opts.probeRotate !== undefined ? Boolean(opts.probeRotate) : g.probeRotate !== false;
  const tlsSkip = provider.insecureSkipVerify === true ? true
    : provider.insecureSkipVerify === false ? false : Boolean(g.insecureSkipVerify);

  const result = {
    providerId: provider.id,
    checkedAt: Date.now(),
    status: 'down',            // up | degraded | down
    latency: null,
    modelsTotal: 0,
    modelsAvailable: [],
    modelsUnavailable: [],
    modelsUnprobed: [],
    modelDetails: [],
    quotaRemaining: null,
    quotaWarning: false,
    firstTokenMs: null,
    throughputTokensPerSec: null,
    error: null,
    durationMs: null,
    probeCursor: 0
  };

  // --- 阶段 1：连接与模型列表 ---
  const t0 = Date.now();
  const stampDur = () => { result.durationMs = Date.now() - t0; };
  let models = [];
  let cursor = 0;
  const modelsPath = String(provider.modelsPath || '/v1/models');
  const modelsUrl = `${base}${modelsPath.startsWith('/') ? modelsPath : '/' + modelsPath}`;
  logger.info(`${tag} 检测开始 → GET ${modelsUrl}${proxy ? `（经代理 ${proxy}）` : ''}`);
  try {
    const payload = await fetchWithRetry(modelsUrl, { headers, timeout: requestTimeout, proxy, insecureSkipVerify: tlsSkip },
      { retries, tag, what: '连接' });
    result.latency = Date.now() - t0;
    const fmt = Array.isArray(payload) ? 'array' : (payload && payload.data ? 'openai' : (payload && payload.models ? 'ollama' : 'unknown'));
    // 上游模型列表顺序可能抖动，先稳定排序再截取 probeLimit，避免每轮探测子集变化造成误报。
    const allModels = extractModelIds(payload).sort((a, b) => String(a).localeCompare(String(b)));
    models = filterIgnoredModels(allModels, provider.modelIgnorePattern);
    if (models.length !== allModels.length) logger.info(`${tag} 模型忽略规则已排除 ${allModels.length - models.length} 个模型`);
    // 轮询覆盖：超出上限时按游标旋转，本轮探测不同子集，多轮覆盖全量（游标由主进程回写）。
    cursor = 0;
    if (probeRotate && models.length > probeLimit) {
      cursor = ((Number(provider.probeCursor) || 0) % models.length + models.length) % models.length;
      models = models.slice(cursor).concat(models.slice(0, cursor));
    }
    result.probeCursor = cursor;
    logger.info(`${tag} 连接成功（HTTP 200，${result.latency} ms，响应格式: ${fmt}）`);
    logger.info(`${tag} 获取模型列表：共 ${models.length} 个${models.length === 0 ? '（列表为空）' : ''}`);
    if (models.length > 0 && models.length <= 20) {
      logger.debug(`${tag} 模型清单: ${models.join(', ')}`);
    }
  } catch (e) {
    stampDur();
    // 401/403：密钥问题而非服务不可达，独立为鉴权失败
    if (/^HTTP 40[13]\b/.test(String(e.message || e))) {
      result.status = 'authfail';
      result.error = `鉴权失败: ${e.message}（请检查 API Key）`;
      logger.error(`${tag} 鉴权失败（${e.message}）→ 状态 authfail`);
      return result;
    }
    result.error = `连接失败: ${e.message}`;
    logger.error(`${tag} 连接失败（耗时 ${Date.now() - t0} ms，已重试 ${retries} 次）: ${e.message} → 状态 down`);
    return result;
  }

  // 可选配额端点：失败不影响服务健康状态，仅记录日志；字段路径兼容嵌套 JSON。
  if (String(provider.quotaPath || '').trim()) {
    const qp = String(provider.quotaPath).trim();
    const quotaUrl = `${base}${qp.startsWith('/') ? qp : '/' + qp}`;
    try {
      const quotaPayload = await fetchWithRetry(quotaUrl, { headers, timeout: requestTimeout, proxy, insecureSkipVerify: tlsSkip },
        { retries, tag, what: '配额查询' });
      const value = Number(valueAtPath(quotaPayload, provider.quotaValuePath || 'remaining'));
      if (Number.isFinite(value)) {
        result.quotaRemaining = value;
        const threshold = Number(provider.quotaWarnBelow);
        result.quotaWarning = Number.isFinite(threshold) && threshold >= 0 && value <= threshold;
        logger.info(`${tag} 配额剩余 ${value}${result.quotaWarning ? `（低于告警阈值 ${threshold}）` : ''}`);
      } else logger.warn(`${tag} 配额字段 ${provider.quotaValuePath || 'remaining'} 不是有效数值`);
    } catch (e) { logger.warn(`${tag} 配额查询失败（不影响健康状态）: ${e.message}`); }
  }

  result.modelsTotal = models.length;
  if (models.length === 0) {
    // 连接成功但一个模型都没有：服务在、能力为零 → degraded（与「在线=至少1个模型可用」的定义保持一致）
    result.status = 'degraded';
    result.error = '模型列表为空';
    logger.warn(`${tag} 模型列表为空 → 状态 degraded（连接正常但无可用能力）`);
    stampDur();
    return result;
  }

  // probeMode=none：跳过单模型探测，模型全部视为可用
  if (probeMode === 'none') {
    result.modelsAvailable = [...models];
    result.modelDetails = models.map((id) => ({ id, ok: true, note: '未启用单模型探测' }));
    result.status = 'up';
    logger.info(`${tag} 探测方式为 none，跳过单模型探测 → 状态 up，模型 ${models.length} 个`);
    stampDur();
    return result;
  }

  // --- 阶段 2：逐模型可用性探测 ---
  const probe = models.slice(0, probeLimit);
  const unprobed = models.slice(probeLimit);
  const rotating = probeRotate && models.length > probeLimit;
  result.probeCursor = rotating ? (cursor + probe.length) % models.length : cursor;
  logger.info(`${tag} 开始探测模型可用性：${probe.length} 个（上限 ${probeLimit}，方式 ${probeMode}，并发池 ${probeConcurrency}，抖动 ${probeJitterMs}ms${rotating ? `，轮询偏移 ${cursor}` : ''}）`);
  const t1 = Date.now();
  const probeOne = async (id) => {
    const ts = Date.now();
    try {
      const configured = Array.isArray(provider.capabilityModes) ? provider.capabilityModes : [];
      const modes = configured.length ? configured : [probeMode];
      const capabilities = {};
      for (const mode of modes) {
        const { url, body } = buildProbeRequest(base, id, { ...provider, probeMode: mode });
        const payload = await fetchWithRetry(url, { method: 'POST', headers, body, timeout: probeTimeout, proxy, insecureSkipVerify: tlsSkip },
          { retries, tag, what: `探测 [${id}/${mode}]` });
        assertProbeResponse(payload, provider);
        capabilities[mode] = true;
      }
      logger.info(`${tag} 探测 [${id}] → 可用（HTTP 200，${Date.now() - ts} ms）`);
      return { id, ok: true, note: '', code: 200, latencyMs: Date.now() - ts, capabilities };
    } catch (e) {
      const msg = String(e.message || e);
      const codeMatch = /^HTTP (\d{3})\b/.exec(msg);
      const code = codeMatch ? Number(codeMatch[1]) : 0;
      // 400/413/422：请求已路由到模型但参数被拒 => 服务可用；404 = 模型不存在，401/403 = 鉴权失败
      if (/^HTTP (400|413|422)\b/.test(msg)) {
        logger.info(`${tag} 探测 [${id}] → 可用（${msg}，参数被拒但路由可达，${Date.now() - ts} ms）`);
        return { id, ok: true, note: msg, code, latencyMs: Date.now() - ts };
      }
      let reason;
      if (/^HTTP 404\b/.test(msg)) reason = '模型不存在（HTTP 404）';
      else if (/^HTTP 40[13]\b/.test(msg)) reason = '鉴权失败或无权限（' + msg + '）';
      else if (/^HTTP 429\b/.test(msg)) reason = '请求速率受限（HTTP 429）';
      else if (/^HTTP 5\d\d\b/.test(msg)) reason = '服务端错误（' + msg + '）';
      else if (/超时/.test(msg)) reason = '探测请求超时';
      else reason = msg;
      logger.warn(`${tag} 探测 [${id}] → 不可用（${reason}，${Date.now() - ts} ms）`);
      return { id, ok: false, note: reason, code, latencyMs: Date.now() - ts };
    }
  };

  const settled = await mapPool(probe, probeConcurrency, (id) => probeOne(id), probeJitterMs);
  const details = settled.map((s) => ({ id: s.id, ok: s.ok, note: s.note, latencyMs: s.latencyMs, capabilities: s.capabilities || {} }));
  for (const s of settled) {
    if (s.ok) result.modelsAvailable.push(s.id);
    else result.modelsUnavailable.push(s.id);
  }

  // 超出上限的模型单独归入 modelsUnprobed，不再混入「不可用」
  if (unprobed.length > 0) {
    logger.info(`${tag} ${unprobed.length} 个模型超出单轮探测上限，标记为未探测: ${unprobed.join(', ')}`);
    for (const id of unprobed) details.push({ id, ok: null, note: '超出单轮探测上限，未探测' });
  }
  result.modelsUnprobed = [...unprobed];
  result.modelsAvailable = [...new Set(result.modelsAvailable)];
  result.modelsUnavailable = [...new Set(result.modelsUnavailable)].filter((id) => !result.modelsAvailable.includes(id));
  result.modelDetails = details;
  const latencies = settled.map((s) => Number(s.latencyMs)).filter(Number.isFinite).sort((a, b) => a - b);
  result.probeLatencyAvg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  result.probeLatencyP95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null;

  // 可选的 OpenAI 兼容流式性能探测，只选一个已验证模型，避免成倍放大请求量。
  if (provider.measureStreaming && result.modelsAvailable.length) {
    try {
      const metrics = await measureOpenAIStream(base, result.modelsAvailable[0], provider, { headers, timeout: probeTimeout, proxy, insecureSkipVerify: tlsSkip });
      result.firstTokenMs = metrics.firstTokenMs;
      result.throughputTokensPerSec = metrics.throughputTokensPerSec;
      logger.info(`${tag} 流式性能：首 Token ${metrics.firstTokenMs ?? '—'} ms，吞吐 ${metrics.throughputTokensPerSec ?? '—'} token/s`);
    } catch (e) { logger.warn(`${tag} 流式性能探测失败（不影响健康状态）: ${e.message}`); }
  }

  if (result.modelsAvailable.length > 0) result.status = 'up';
  else if (probe.length > 0 && settled.every((s) => s.code === 401 || s.code === 403)) {
    // 列表可拉但全部探测 401/403：Key 无探测权限 → 鉴权失败
    result.status = 'authfail';
    result.error = '鉴权失败：API Key 无效或无权限（全部探测返回 401/403）';
  }
  else result.status = 'degraded';

  // --- 汇总 ---
  const failSummary = result.modelsUnavailable.length > 0
    ? `，失败 ${result.modelsUnavailable.length} 个: ${result.modelsUnavailable.map((id) => {
        const d = details.find((x) => x.id === id);
        return `${id}(${d && d.note ? d.note : '未知原因'})`;
      }).join('; ')}`
    : '';
  const unprobedSummary = result.modelsUnprobed.length > 0 ? `，未探测 ${result.modelsUnprobed.length} 个` : '';
  logger.info(`${tag} 探测完成（耗时 ${Date.now() - t1} ms）：可用 ${result.modelsAvailable.length}/${probe.length} 已探测${unprobedSummary}${failSummary}`);
  logger.info(`${tag} 检测结束 → 状态 ${result.status}${result.modelsAvailable.length > 0 ? '，可用: ' + result.modelsAvailable.join(', ') : ''}`);

  stampDur();
  return result;
}

module.exports = { detect, fetchJSON, fetchWithRetry, extractModelIds, extractContent, isRetryable, buildProbeRequest, resolveProxy, mapPool, providerHeaders, assertProbeResponse, valueAtPath, filterIgnoredModels, extractSSEDelta, measureOpenAIStream };
