'use strict';
const { URL } = require('url');
const logger = require('./logger');
const { headersForRedirect } = require('./httpguard');
const { requestRaw } = require('./httpRequest');
const { endpoint } = require('./providerTemplates');
const { redactValue } = require('./redact');

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
    logger.warn('[代理] 代理地址无效');
    return null;
  }
}

/** 解析本次请求应使用的代理地址：服务商级 > 全局 > 环境变量 */
function resolveProxy(provider, globalCfg) {
  if (provider && provider.useProxy === false) return '';
  const own = String((provider && provider.proxyUrl) || '').trim();
  if (own) return own;
  const g = globalCfg || {};
  if (g.proxyEnabled && String(g.proxyUrl || '').trim()) return String(g.proxyUrl).trim();
  return '';
}

async function fetchJSON(targetUrl, { method = 'GET', headers = {}, body = null, timeout = DEFAULT_REQUEST_TIMEOUT,
  proxy = '', insecureSkipVerify = false, signal, deadlineAt = Date.now() + timeout, _redirects = 0 } = {}) {
  const res = await requestRaw(targetUrl, { method, headers, body, timeout, deadlineAt, signal,
    agent: getProxyAgent(proxy, insecureSkipVerify), insecureSkipVerify });
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && _redirects < MAX_REDIRECTS) {
    const next = new URL(res.headers.location, targetUrl).toString();
    const m = res.statusCode === 303 ? 'GET' : method;
    return fetchJSON(next, { method: m, headers: headersForRedirect(targetUrl, next, headers), body: m === 'GET' ? null : body,
      timeout, deadlineAt, proxy, insecureSkipVerify, signal, _redirects: _redirects + 1 });
  }
  if (res.statusCode >= 200 && res.statusCode < 300) {
    try { return JSON.parse(res.body); } catch (e) { throw new Error(`响应不是有效 JSON (HTTP ${res.statusCode})`); }
  }
  const err = new Error(`HTTP ${res.statusCode}`);
  err.statusCode = res.statusCode;
  err.responseBody = res.body.slice(0, 2000);
  try { err.apiError = JSON.parse(res.body).error; } catch (e) { /* optional */ }
  const retryAfter = res.headers['retry-after'];
  if (retryAfter) {
    const seconds = Number(retryAfter), at = Date.parse(retryAfter);
    err.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : (Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0);
  }
  throw err;
}

/** 判断错误是否值得重试：网络层抖动与 408/429/5xx 可重试；其余 4xx 语义明确不重试 */
function isRetryable(err) {
  const msg = String((err && err.message) || err);
  const m = /^HTTP (\d{3})\b/.exec(msg);
  if (m) {
    const code = Number(m[1]);
    if (code === 408 || code === 429) return true;   // 请求超时 / 速率受限，等一下再试有意义
    if (code >= 500) return true;
    return false;
  }
  if (/超时|timeout|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return true;
  if (/响应不是有效 JSON/.test(msg)) return false;
  return true;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(new Error('检测已取消')); return; }
  const abort = () => { clearTimeout(timer); reject(new Error('检测已取消')); };
  const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', abort); resolve(); }, ms);
  if (signal) signal.addEventListener('abort', abort, { once: true });
});

/** 带退避重试的请求封装 */
async function fetchWithRetry(url, opts, { retries = DEFAULT_RETRIES, tag = '', what = '请求' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJSON(url, opts);
    } catch (e) {
      lastErr = e;
      if ((opts.signal && opts.signal.aborted) || attempt >= retries || !isRetryable(e)) break;
      const wait = Math.min(60000, Number(e.retryAfterMs) > 0 ? Number(e.retryAfterMs) : RETRY_BACKOFF_MS * Math.pow(2, attempt));
      logger.debug(`${tag} ${what}失败（${e.message}），${wait} ms 后第 ${attempt + 1} 次重试`);
      await sleep(wait, opts.signal);
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
  if (Array.isArray(payload)) return payload.map((m) => (typeof m === 'string' ? m : m && (m.id || m.name))).filter(Boolean);
  if (payload && Array.isArray(payload.data)) return payload.data.map((m) => m && (m.id || m.name)).filter(Boolean);
  if (payload && Array.isArray(payload.models)) return payload.models.map((m) => m && (m.id || m.name)).filter(Boolean);
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
  let re;
  try { re = new RegExp(raw, 'i'); }
  catch (e) {
    // 手改配置可能绕过入口校验：坏正则直接抛会让整轮 detect 失败、状态卡死，
    // 这里降级为「本轮忽略该规则」，让检测继续跑并把问题留在日志里
    logger.warn('[探测] 模型忽略规则不是有效正则，本轮跳过该规则');
    return models;
  }
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

async function measureOpenAIStream(base, modelId, provider, { headers, timeout, proxy, insecureSkipVerify, signal }) {
  const started = Date.now();
  let firstTokenAt = 0, chars = 0, pending = '';
  const consume = (line) => {
    const delta = extractSSEDelta(line);
    if (delta) { if (!firstTokenAt) firstTokenAt = Date.now(); chars += delta.length; }
  };
  const res = await requestRaw(endpoint(base, '/v1/chat/completions'), {
    method: 'POST', headers, timeout, signal, insecureSkipVerify, agent: getProxyAgent(proxy, insecureSkipVerify),
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply with pong.' }], max_tokens: 16, stream: true }),
    onChunk(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
      if (pending.length > 1024 * 1024) throw new Error('流式响应过大');
      lines.forEach(consume);
    }
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
  consume(pending);
  if (!firstTokenAt) throw new Error('流式响应未包含有效内容');
  const generationMs = Math.max(1, Date.now() - firstTokenAt);
  return { firstTokenMs: firstTokenAt - started, throughputTokensPerSec: Number(((chars / 4) / (generationMs / 1000)).toFixed(2)), outputChars: chars };
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

/** A 2xx JSON document alone does not prove that inference succeeded. */
function validateProbeResponse(payload, mode, provider = {}) {
  const object = payload && typeof payload === 'object' && !Array.isArray(payload);
  if (object && (payload.error || Array.isArray(payload.errors) && payload.errors.length || payload.success === false || payload.ok === false)) {
    const detail = payload.error?.message || payload.error || payload.errors || payload.message || 'success=false';
    throw new Error(`推理返回业务错误：${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 160)}`);
  }
  if (provider.probePolicy !== 'reachable') {
    const text = (v) => typeof v === 'string' && v.trim().length > 0;
    const chat = (choice) => {
      const m = choice && choice.message;
      return m && (text(m.content) || Array.isArray(m.content) && m.content.some((p) => text(p?.text))
        || Array.isArray(m.tool_calls) && m.tool_calls.some((t) => text(t?.function?.name))
        || text(m.function_call?.name) || text(m.refusal) || text(m.reasoning_content) || text(m.reasoning)
        // A one-token probe can consume its entire budget before emitting visible text.
        || m.content === '' && choice.finish_reason === 'length');
    };
    const chatOK = Array.isArray(payload?.choices) && payload.choices.some(chat);
    const completionOK = Array.isArray(payload?.choices) && payload.choices.some((c) => text(c?.text) || c?.text === '' && c.finish_reason === 'length');
    const embeddingOK = Array.isArray(payload?.data) && payload.data.length > 0 && payload.data.every((d) =>
      Array.isArray(d?.embedding) && d.embedding.length > 0 && d.embedding.every((n) => typeof n === 'number' && Number.isFinite(n))
      || typeof d?.embedding === 'string' && d.embedding.length > 0 && d.embedding.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(d.embedding));
    const customAssertion = provider.assertType && provider.assertType !== 'none' && String(provider.assertValue || '').trim();
    const valid = mode === 'chat' ? chatOK : mode === 'completions' ? completionOK : mode === 'embeddings' ? embeddingOK
      : customAssertion || object && (chatOK || completionOK || embeddingOK || text(payload.message?.content) || text(payload.response) || payload.ok === true || payload.success === true);
    if (!valid) throw new Error(`推理响应无有效 ${mode} 结果${mode === 'custom' ? '，请配置自定义响应断言' : ''}`);
  }
  return assertProbeResponse(payload, provider);
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
    return { url: endpoint(base, '/v1/embeddings'), body: JSON.stringify({ model: modelId, input: 'ping' }) };
  }
  if (mode === 'completions') {
    return { url: endpoint(base, '/v1/completions'), body: JSON.stringify({ model: modelId, prompt: 'ping', max_tokens: 1 }) };
  }
  if (mode === 'custom') {
    const p = String(provider.probePath || '/v1/chat/completions');
    const path = p.startsWith('/') ? p : `/${p}`;
    let body = String(provider.probeBody || '').trim();
    if (!body) body = JSON.stringify({ model: '{{model}}', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
    // 函数替换，避免模型名里的引号、$ 破坏 JSON
    body = body.replace(/\{\{\s*model\s*\}\}/g, () => JSON.stringify(String(modelId)).slice(1, -1));
    return { url: endpoint(base, path), body };
  }
  return {
    url: endpoint(base, '/v1/chat/completions'),
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
    return redactValue({ providerId: provider.id, checkedAt: Date.now(), status: 'down', latency: null, modelsTotal: 0, modelsAvailable: [], modelsUnavailable: [], modelsUnprobed: [], modelDetails: [], error: e.message, durationMs: 0, probeCursor: 0 });
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
  const jitter = opts.probeJitterMs ?? g.probeJitterMs ?? DEFAULT_PROBE_JITTER_MS;
  const probeJitterMs = Math.max(0, Math.floor(Number(jitter) || 0));
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
  const modelsUrl = endpoint(base, modelsPath);
  logger.info(`${tag} 检测开始 → GET ${modelsUrl}${proxy ? '（经代理）' : ''}`);
  try {
    const payload = await fetchWithRetry(modelsUrl, { headers, timeout: requestTimeout, proxy, insecureSkipVerify: tlsSkip, signal: opts.signal },
      { retries, tag, what: '连接' });
    result.latency = Date.now() - t0;
    const fmt = Array.isArray(payload) ? 'array' : (payload && payload.data ? 'openai' : (payload && payload.models ? 'ollama' : 'unknown'));
    // 上游模型列表顺序可能抖动，先稳定排序再截取 probeLimit，避免每轮探测子集变化造成误报。
    const allModels = [...new Set(extractModelIds(payload).map(String))].sort((a, b) => String(a).localeCompare(String(b)));
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
      return redactValue(result);
    }
    result.error = `连接失败: ${e.message}`;
    logger.error(`${tag} 连接失败（耗时 ${Date.now() - t0} ms，已重试 ${retries} 次）: ${e.message} → 状态 down`);
    return redactValue(result);
  }

  // 可选配额端点：失败不影响服务健康状态，仅记录日志；字段路径兼容嵌套 JSON。
  if (String(provider.quotaPath || '').trim()) {
    const qp = String(provider.quotaPath).trim();
    const quotaUrl = endpoint(base, qp);
    try {
      const quotaPayload = await fetchWithRetry(quotaUrl, { headers, timeout: requestTimeout, proxy, insecureSkipVerify: tlsSkip, signal: opts.signal },
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
    return redactValue(result);
  }

  // probeMode=none：跳过单模型探测，模型全部视为可用
  if (probeMode === 'none') {
    result.modelsAvailable = [...models];
    result.modelDetails = models.map((id) => ({ id, ok: true, note: '未启用单模型探测' }));
    result.status = 'up';
    logger.info(`${tag} 探测方式为 none，跳过单模型探测 → 状态 up，模型 ${models.length} 个`);
    stampDur();
    return redactValue(result);
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
    const configured = Array.isArray(provider.capabilityModes) ? provider.capabilityModes : [];
    const modes = configured.length ? configured : [probeMode];
    const capabilities = {}, failures = [];
    let code = 200;
    const failedCodes = [];
    for (const mode of modes) {
      if (opts.signal && opts.signal.aborted) throw new Error('检测已取消');
      try {
        const { url, body } = buildProbeRequest(base, id, { ...provider, probeMode: mode });
        const payload = await fetchWithRetry(url, { method: 'POST', headers, body, timeout: probeTimeout, proxy, insecureSkipVerify: tlsSkip, signal: opts.signal },
          { retries, tag, what: `探测 [${id}/${mode}]` });
        validateProbeResponse(payload, mode, provider);
        capabilities[mode] = true;
      } catch (e) {
        code = Number(e.statusCode) || 0;
        // Reachability compatibility is opt-in and must never bypass a response assertion.
        const routed = provider.probePolicy === 'reachable' && (!provider.assertType || provider.assertType === 'none')
          && [400, 413, 422].includes(code) && !/quota|credit|balance|billing|余额|额度/i.test(JSON.stringify(e.apiError || e.responseBody || ''));
        capabilities[mode] = routed;
        if (!routed) {
          const reason = code === 404 ? '模型不存在（HTTP 404）' : [401, 403].includes(code) ? `鉴权失败或无权限（HTTP ${code}）`
            : code === 429 ? '请求速率受限（HTTP 429）' : e.apiError?.message ? `HTTP ${code}: ${String(e.apiError.message).slice(0, 160)}` : e.message;
          failures.push(`${mode}: ${reason}`); failedCodes.push(code);
        }
      }
    }
    const ok = !failures.length;
    logger[ok ? 'info' : 'warn'](`${tag} 探测 [${id}] → ${ok ? '可用' : '不可用'}（${Date.now() - ts} ms）`);
    return { id, ok, note: failures.join('；'), code: failedCodes.length && failedCodes.every((n) => [401, 403].includes(n)) ? 401 : failedCodes[0] || code, latencyMs: Date.now() - ts, capabilities };
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
      const metrics = await measureOpenAIStream(base, result.modelsAvailable[0], provider, { headers, timeout: probeTimeout, proxy, insecureSkipVerify: tlsSkip, signal: opts.signal });
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
  return redactValue(result);
}

module.exports = { detect, fetchJSON, fetchWithRetry, extractModelIds, extractContent, isRetryable, buildProbeRequest, resolveProxy, mapPool, providerHeaders, assertProbeResponse, validateProbeResponse, valueAtPath, filterIgnoredModels, extractSSEDelta, measureOpenAIStream };
