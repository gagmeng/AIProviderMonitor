'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');

const DEFAULT_REQUEST_TIMEOUT = 20000;
const DEFAULT_PROBE_TIMEOUT = 15000;
const DEFAULT_PROBE_LIMIT = 8;
const DEFAULT_RETRIES = 1;
const RETRY_BACKOFF_MS = 800;

/** 惰性加载代理 agent（仅在配置了代理时才需要 https-proxy-agent，缺失则降级直连） */
let ProxyAgentCtor = null;
let proxyAgentChecked = false;
function getProxyAgent(proxyUrl) {
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
  try { return new ProxyAgentCtor(proxyUrl); } catch (e) {
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

function fetchJSON(targetUrl, { method = 'GET', headers = {}, body = null, timeout = DEFAULT_REQUEST_TIMEOUT, proxy = '' } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new Error(`URL 无效: ${targetUrl}`)); }
    const mod = u.protocol === 'http:' ? http : https;
    const opts = { method, headers, timeout };
    const agent = getProxyAgent(proxy);
    if (agent) opts.agent = agent;
    const req = mod.request(u, opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 5 * 1024 * 1024) req.destroy(new Error('响应过大')); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`响应不是有效 JSON (HTTP ${res.statusCode})`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
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
      const wait = RETRY_BACKOFF_MS * Math.pow(2, attempt);
      logger.debug(`${tag} ${what}失败（${e.message}），${wait} ms 后第 ${attempt + 1} 次重试`);
      await sleep(wait);
    }
  }
  throw lastErr;
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
    body = body.replace(/\{\{\s*model\s*\}\}/g, modelId);
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
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

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
    error: null
  };

  // --- 阶段 1：连接与模型列表 ---
  const t0 = Date.now();
  let models = [];
  logger.info(`${tag} 检测开始 → GET ${base}/v1/models${proxy ? `（经代理 ${proxy}）` : ''}`);
  try {
    const payload = await fetchWithRetry(`${base}/v1/models`, { headers, timeout: requestTimeout, proxy },
      { retries, tag, what: '连接' });
    result.latency = Date.now() - t0;
    const fmt = Array.isArray(payload) ? 'array' : (payload && payload.data ? 'openai' : (payload && payload.models ? 'ollama' : 'unknown'));
    models = extractModelIds(payload);
    logger.info(`${tag} 连接成功（HTTP 200，${result.latency} ms，响应格式: ${fmt}）`);
    logger.info(`${tag} 获取模型列表：共 ${models.length} 个${models.length === 0 ? '（列表为空）' : ''}`);
    if (models.length > 0 && models.length <= 20) {
      logger.debug(`${tag} 模型清单: ${models.join(', ')}`);
    }
  } catch (e) {
    result.error = `连接失败: ${e.message}`;
    logger.error(`${tag} 连接失败（耗时 ${Date.now() - t0} ms，已重试 ${retries} 次）: ${e.message} → 状态 down`);
    return result;
  }

  result.modelsTotal = models.length;
  if (models.length === 0) {
    // 连接成功但一个模型都没有：服务在、能力为零 → degraded（与「在线=至少1个模型可用」的定义保持一致）
    result.status = 'degraded';
    result.error = '模型列表为空';
    logger.warn(`${tag} 模型列表为空 → 状态 degraded（连接正常但无可用能力）`);
    return result;
  }

  // probeMode=none：跳过单模型探测，模型全部视为可用
  if (probeMode === 'none') {
    result.modelsAvailable = [...models];
    result.modelDetails = models.map((id) => ({ id, ok: true, note: '未启用单模型探测' }));
    result.status = 'up';
    logger.info(`${tag} 探测方式为 none，跳过单模型探测 → 状态 up，模型 ${models.length} 个`);
    return result;
  }

  // --- 阶段 2：逐模型可用性探测 ---
  const probe = models.slice(0, probeLimit);
  const unprobed = models.slice(probeLimit);
  logger.info(`${tag} 开始探测模型可用性：${probe.length} 个（上限 ${probeLimit}，方式 ${probeMode}，并发）`);
  const t1 = Date.now();
  const probeOne = async (id) => {
    const ts = Date.now();
    const { url, body } = buildProbeRequest(base, id, provider);
    try {
      await fetchWithRetry(url, { method: 'POST', headers, body, timeout: probeTimeout, proxy },
        { retries, tag, what: `探测 [${id}]` });
      logger.info(`${tag} 探测 [${id}] → 可用（HTTP 200，${Date.now() - ts} ms）`);
      return { id, ok: true, note: '' };
    } catch (e) {
      const msg = String(e.message || e);
      // 400/413/422：请求已路由到模型但参数被拒 => 服务可用；404 = 模型不存在，401/403 = 鉴权失败
      if (/^HTTP (400|413|422)\b/.test(msg)) {
        logger.info(`${tag} 探测 [${id}] → 可用（${msg}，参数被拒但路由可达，${Date.now() - ts} ms）`);
        return { id, ok: true, note: msg };
      }
      let reason;
      if (/^HTTP 404\b/.test(msg)) reason = '模型不存在（HTTP 404）';
      else if (/^HTTP 40[13]\b/.test(msg)) reason = '鉴权失败或无权限（' + msg + '）';
      else if (/^HTTP 429\b/.test(msg)) reason = '请求速率受限（HTTP 429）';
      else if (/^HTTP 5\d\d\b/.test(msg)) reason = '服务端错误（' + msg + '）';
      else if (/超时/.test(msg)) reason = '探测请求超时';
      else reason = msg;
      logger.warn(`${tag} 探测 [${id}] → 不可用（${reason}，${Date.now() - ts} ms）`);
      return { id, ok: false, note: reason };
    }
  };

  const settled = await Promise.all(probe.map(probeOne));
  const details = settled.map((s) => ({ id: s.id, ok: s.ok, note: s.note }));
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

  if (result.modelsAvailable.length > 0) result.status = 'up';
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

  return result;
}

module.exports = { detect, fetchJSON, fetchWithRetry, extractModelIds, extractContent, isRetryable, buildProbeRequest, resolveProxy };
