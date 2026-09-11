'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');

const REQUEST_TIMEOUT = 20000;

function fetchJSON(targetUrl, { method = 'GET', headers = {}, body = null, timeout = REQUEST_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new Error(`URL 无效: ${targetUrl}`)); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, {
      method,
      headers,
      timeout
    }, (res) => {
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
 * 检测单个服务商：连接状态 + 模型列表 + 模型可用性
 * 全过程输出详细日志：连接阶段（延迟/HTTP状态）、模型列表（格式/数量）、逐模型探测（结果/原因/耗时）、阶段汇总。
 */
async function detect(provider, { probeLimit = 8 } = {}) {
  const base = String(provider.url || '').replace(/\/+$/, '');
  const tag = `[${provider.name}]`;
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const result = {
    providerId: provider.id,
    checkedAt: Date.now(),
    status: 'down',            // up | degraded | down
    latency: null,
    modelsTotal: 0,
    modelsAvailable: [],
    modelsUnavailable: [],
    modelDetails: [],
    error: null
  };

  // --- 阶段 1：连接与模型列表 ---
  const t0 = Date.now();
  let models = [];
  logger.info(`${tag} 检测开始 → GET ${base}/v1/models`);
  try {
    const payload = await fetchJSON(`${base}/v1/models`, { headers });
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
    logger.error(`${tag} 连接失败（耗时 ${Date.now() - t0} ms）: ${e.message} → 状态 down`);
    return result;
  }

  result.modelsTotal = models.length;
  if (models.length === 0) {
    result.status = 'up';
    result.error = null;
    logger.info(`${tag} 模型列表为空，状态 up（无需探测）`);
    return result;
  }

  // --- 阶段 2：逐模型可用性探测 ---
  const probe = models.slice(0, probeLimit);
  logger.info(`${tag} 开始探测模型可用性：${probe.length} 个（上限 ${probeLimit}，并发）`);
  const t1 = Date.now();
  const probeOne = async (id) => {
    const ts = Date.now();
    try {
      await fetchJSON(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        }),
        timeout: 15000
      });
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
  const unprobed = models.slice(probeLimit);
  if (unprobed.length > 0) {
    logger.info(`${tag} ${unprobed.length} 个模型超出单轮探测上限，标记为未探测: ${unprobed.join(', ')}`);
  }
  for (const id of unprobed) {
    result.modelsUnavailable.push(id);
    details.push({ id, ok: false, note: '超出单轮探测上限，未探测' });
  }
  result.modelsUnavailable = [...new Set(result.modelsUnavailable)].filter((id) => !result.modelsAvailable.includes(id));
  // 附加详情（弹窗展示失败原因用）；未在列表中的保持原有字符串数组兼容
  result.modelDetails = details;
  result.modelsAvailable = [...new Set(result.modelsAvailable)];

  if (result.modelsAvailable.length > 0) result.status = 'up';
  else result.status = 'degraded';

  // --- 汇总 ---
  const failSummary = result.modelsUnavailable.length > 0
    ? `，失败 ${result.modelsUnavailable.length} 个: ${result.modelsUnavailable.map((id) => {
        const d = details.find((x) => x.id === id);
        return `${id}(${d && d.note ? d.note : '未探测'})`;
      }).join('; ')}`
    : '';
  logger.info(`${tag} 探测完成（耗时 ${Date.now() - t1} ms）：可用 ${result.modelsAvailable.length}/${result.modelsTotal}${failSummary}`);
  logger.info(`${tag} 检测结束 → 状态 ${result.status}${result.modelsAvailable.length > 0 ? '，可用: ' + result.modelsAvailable.join(', ') : ''}`);

  return result;
}

module.exports = { detect, fetchJSON, extractModelIds, extractContent };
