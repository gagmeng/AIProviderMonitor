'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { headersForRedirect } = require('./httpguard');

/** 懒加载 https-proxy-agent（可选依赖，缺失时退化为直连） */
function getProxyAgent(proxyUrl, insecureSkipVerify) {
  if (!proxyUrl) return null;
  try {
    const mod = require('https-proxy-agent');
    const AgentCtor = mod.HttpsProxyAgent || mod;
    if (typeof AgentCtor !== 'function') return null;
    const opts = insecureSkipVerify ? { rejectUnauthorized: false } : undefined;
    return opts ? new AgentCtor(proxyUrl, opts) : new AgentCtor(proxyUrl);
  } catch (e) { return null; }
}

/** 通知代理解析：服务商独立代理 > 全局代理；服务商可关闭 */
function resolveNotifyProxy(provider, g = {}) {
  if (provider && provider.useProxy === false) return '';
  const own = String((provider && provider.proxyUrl) || '').trim();
  if (own) return own;
  if (g.proxyEnabled && String(g.proxyUrl || '').trim()) return String(g.proxyUrl).trim();
  return '';
}
const logger = require('./logger');

/**
 * 通知器：企业微信 / 钉钉（含加签）/ QQ（OneBot v11）/ Telegram / 飞书（含加签）
 * / Slack / Server 酱 / 通用 Webhook（自定义 JSON 模板）。
 *
 * 所有通道相互独立，任一失败不影响其它通道。
 */

const CHANNELS = ['weixin', 'qq', 'dingtalk', 'telegram', 'feishu', 'slack', 'serverchan', 'custom'];

const CHANNEL_LABEL = {
  weixin: '微信', qq: 'QQ', dingtalk: '钉钉', telegram: 'Telegram',
  feishu: '飞书', slack: 'Slack', serverchan: 'Server酱', custom: '自定义Webhook'
};

function post(url, payload, { timeout = 10000, token = '', headers: extraHeaders = {}, raw = false, proxy = '', insecureSkipVerify = false, _redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Webhook URL 无效')); }
    const mod = u.protocol === 'http:' ? http : https;
    const body = raw ? String(payload) : JSON.stringify(payload);
    const headers = Object.assign(
      { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      extraHeaders
    );
    if (token) headers.Authorization = `Bearer ${token}`;
    const reqOpts = { method: 'POST', headers, timeout };
    if (mod === https && insecureSkipVerify) reqOpts.rejectUnauthorized = false;
    const agent = getProxyAgent(proxy, insecureSkipVerify);
    if (agent) reqOpts.agent = agent;
    const req = mod.request(u, reqOpts, (res) => {
      // 重定向跟随（≤3 跳；303 转 GET 对 webhook 无意义，直接报错提示检查地址）
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && _redirects < 3) {
        res.resume();
        if (res.statusCode === 303) { reject(new Error('通道重定向到 GET（HTTP 303），请检查 Webhook 地址')); return; }
        let next;
        try { next = new URL(res.headers.location, u).toString(); }
        catch (e) { reject(new Error(`重定向地址无效: ${res.headers.location}`)); return; }
        const nextHeaders = headersForRedirect(u.toString(), next, extraHeaders);
        const keepToken = Boolean(headersForRedirect(u.toString(), next, token ? { Authorization: 'keep' } : {}).Authorization);
        resolve(post(next, payload, {
          timeout, token: keepToken ? token : '', headers: nextHeaders, raw, proxy, insecureSkipVerify, _redirects: _redirects + 1
        }));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 120)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('通知请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 可重试判定：网络层错误/超时，或 HTTP 429/5xx */
function isPostRetryable(e) {
  const m = /^HTTP (\d{3})\b/.exec(String((e && e.message) || e || ''));
  if (!m) return true;
  const s = Number(m[1]);
  return s === 429 || s >= 500;
}

/** 带 1 次重试的 POST（各通道统一入口）：失败 800ms 后重试一次 */
async function postRetry(url, payload, opts = {}) {
  try {
    return await post(url, payload, opts);
  } catch (e) {
    if (!isPostRetryable(e)) throw e;
    await new Promise((r) => setTimeout(r, 800));
    return post(url, payload, opts);
  }
}

/** 组装通道请求选项：服务商独立代理 > 全局代理；TLS 跳过跟随全局 */
function sendOpts(globalCfg = {}, ctx = {}) {
  return { proxy: resolveNotifyProxy(ctx.provider, globalCfg), insecureSkipVerify: Boolean(globalCfg.insecureSkipVerify) };
}

/** 各通道连续失败计数（自监控用；成功清零，达 3 次记 error 日志预警） */
const notifyFailStreak = {};
function noteResult(channel, ok) {
  if (ok) { notifyFailStreak[channel] = 0; return; }
  const n = (notifyFailStreak[channel] || 0) + 1;
  notifyFailStreak[channel] = n;
  if (n === 3) logger.error(`[自检] 通知通道「${CHANNEL_LABEL[channel] || channel}」连续失败 ${n} 次，请检查配置与网络`);
}
function getNotifyHealth() { return { ...notifyFailStreak }; }

function fmtProvider(p) {
  return `${p.name || 'Provider#' + p.id}`;
}

function statusText(s) {
  return { up: '在线', degraded: '异常', down: '离线', authfail: '鉴权失败', unknown: '待检测' }[s] || String(s || '未知');
}

function buildModelChangeText(provider, prev, next, extra = {}) {
  const lines = [];
  lines.push('【AI Provider 模型变动】');
  lines.push(`服务商：${fmtProvider(provider)}`);
  const prevStatus = prev ? statusText(prev.status) : '未知';
  const statusChanged = !prev || prev.status !== next.status;
  const totalChanged = prev && prev.modelsTotal !== next.modelsTotal;
  const parts = [`状态：${prevStatus} → ${statusText(next.status)}`, `可用模型 ${next.modelsAvailable.length}/${next.modelsTotal}`];
  lines.push(parts.join('　'));
  const prevSet = new Set((prev?.modelsAvailable) || []);
  const nextSet = new Set(next.modelsAvailable || []);
  // 主进程在轮询覆盖下给出精确增减（extra.added/extra.lost），缺省时回退为 prev/next 差集
  const added = extra.added || next.modelsAvailable.filter((m) => !prevSet.has(m));
  const removed = extra.lost || (prev?.modelsAvailable || []).filter((m) => !nextSet.has(m));
  if (added.length) lines.push(`新增可用：${added.join(', ')}`);
  if (removed.length) lines.push(`失去可用：${removed.join(', ')}`);
  if (totalChanged && !added.length && !removed.length) lines.push(`模型清单发生变化（总数 ${prev.modelsTotal} → ${next.modelsTotal}）`);
  if (statusChanged) lines.push(`状态变化：${prevStatus} → ${statusText(next.status)}`);
  lines.push(`时间：${new Date().toLocaleString('zh-CN')}`);
  return lines.join('\n');
}

/** 故障/恢复类告警文案 */
function buildAlertText(provider, alert) {
  const lines = [];
  const head = alert.kind === 'recover' ? '【AI Provider 服务恢复】'
    : alert.kind === 'authfail' ? '【AI Provider 密钥失效】' : '【AI Provider 服务异常】';
  lines.push(head);
  lines.push(`服务商：${fmtProvider(provider)}`);
  lines.push(`地址：${provider.url || '—'}`);
  lines.push(`当前状态：${statusText(provider.status)}`);
  lines.push(`说明：${alert.reason}`);
  if (provider.latency != null) lines.push(`延迟：${provider.latency} ms`);
  lines.push(`时间：${new Date().toLocaleString('zh-CN')}`);
  return lines.join('\n');
}

// ---------- 各通道实现 ----------

async function sendWeixin(globalCfg, text, ctx = {}) {
  if (!globalCfg.weixinWebhook) throw new Error('未配置微信 Webhook');
  return postRetry(globalCfg.weixinWebhook, { msgtype: 'text', text: { content: text } }, sendOpts(globalCfg, ctx));
}

/** 钉钉群机器人：webhook + 可选加签（secret 时在 URL 上附 timestamp & sign） */
async function sendDingtalk(globalCfg, text, ctx = {}) {
  let url = String(globalCfg.dingtalkWebhook || '').trim();
  if (!url) throw new Error('未配置钉钉 Webhook');
  const secret = String(globalCfg.dingtalkSecret || '').trim();
  if (secret) {
    const ts = Date.now();
    const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  const res = await postRetry(url, { msgtype: 'text', text: { content: text } }, sendOpts(globalCfg, ctx));
  try {
    const j = JSON.parse(res);
    if (j.errcode !== undefined && Number(j.errcode) !== 0) {
      throw new Error(`钉钉返回错误 errcode=${j.errcode}${j.errmsg ? ' (' + j.errmsg + ')' : ''}`);
    }
  } catch (e) {
    if (e instanceof SyntaxError) { /* 非 JSON 响应，视为 HTTP 层已成功 */ }
    else throw e;
  }
  return res;
}

/** QQ 上报：调用 OneBot v11 HTTP API（/send_private_msg 或 /send_group_msg） */
function oneBotId(target) {
  const s = String(target || '').trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  return s;
}

async function sendQQ(globalCfg, text, ctx = {}) {
  const base = String(globalCfg.qqWebhook || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未配置 QQ 机器人服务地址');
  const target = String(globalCfg.qqTarget || '').trim();
  if (!target) throw new Error('未配置上报目标 QQ 号/群号');
  const token = String(globalCfg.qqToken || '').trim();
  const isGroup = globalCfg.qqTargetType === 'group';
  const path = isGroup ? '/send_group_msg' : '/send_private_msg';
  const id = oneBotId(target);
  const payload = isGroup ? { group_id: id, message: text } : { user_id: id, message: text };
  const res = await postRetry(base + path, payload, { token, ...sendOpts(globalCfg, ctx) });
  try {
    const j = JSON.parse(res);
    if (typeof j.retcode === 'number' && j.retcode !== 0) {
      throw new Error(`机器人返回错误 retcode=${j.retcode}${j.wording ? ' (' + j.wording + ')' : ''}`);
    }
  } catch (e) {
    if (e instanceof SyntaxError) { /* 非 JSON 响应 */ }
    else throw e;
  }
  return res;
}

/** Telegram Bot：sendMessage API */
async function sendTelegram(globalCfg, text, ctx = {}) {
  const token = String(globalCfg.telegramToken || '').trim();
  const chatId = String(globalCfg.telegramChatId || '').trim();
  if (!token) throw new Error('未配置 Telegram Bot Token');
  if (!chatId) throw new Error('未配置 Telegram Chat ID');
  const apiBase = String(globalCfg.telegramApiBase || 'https://api.telegram.org').trim().replace(/\/+$/, '');
  const res = await postRetry(`${apiBase}/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  }, sendOpts(globalCfg, ctx));
  try {
    const j = JSON.parse(res);
    if (j.ok === false) throw new Error(`Telegram 返回错误: ${j.description || 'unknown'}`);
  } catch (e) {
    if (e instanceof SyntaxError) { /* ignore */ }
    else throw e;
  }
  return res;
}

/** 飞书自定义机器人：支持加签（sign = HMAC-SHA256(timestamp\nsecret) 的 base64，密钥为空串） */
async function sendFeishu(globalCfg, text, ctx = {}) {
  const url = String(globalCfg.feishuWebhook || '').trim();
  if (!url) throw new Error('未配置飞书 Webhook');
  const secret = String(globalCfg.feishuSecret || '').trim();
  const payload = { msg_type: 'text', content: { text } };
  if (secret) {
    const ts = Math.floor(Date.now() / 1000);
    const sign = crypto.createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
    payload.timestamp = String(ts);
    payload.sign = sign;
  }
  const res = await postRetry(url, payload, sendOpts(globalCfg, ctx));
  try {
    const j = JSON.parse(res);
    if (j.code !== undefined && Number(j.code) !== 0) {
      throw new Error(`飞书返回错误 code=${j.code}${j.msg ? ' (' + j.msg + ')' : ''}`);
    }
  } catch (e) {
    if (e instanceof SyntaxError) { /* ignore */ }
    else throw e;
  }
  return res;
}

/** Slack Incoming Webhook */
async function sendSlack(globalCfg, text, ctx = {}) {
  const url = String(globalCfg.slackWebhook || '').trim();
  if (!url) throw new Error('未配置 Slack Webhook');
  return postRetry(url, { text }, sendOpts(globalCfg, ctx));
}

/** Server 酱（sct / ft）：兼容 sctapi.ftqq.com 与 sc.ftqq.com */
async function sendServerChan(globalCfg, text, ctx = {}) {
  const key = String(globalCfg.serverchanKey || '').trim();
  if (!key) throw new Error('未配置 Server 酱 SendKey');
  const lines = text.split('\n');
  const title = lines[0] || 'AI Provider Monitor';
  const desp = lines.slice(1).join('\n\n');
  const url = key.startsWith('SCT')
    ? `https://sctapi.ftqq.com/${key}.send`
    : `https://sc.ftqq.com/${key}.send`;
  const form = `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(desp)}`;
  return postRetry(url, form, { raw: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, ...sendOpts(globalCfg, ctx) });
}

/**
 * 通用 Webhook：用户提供 JSON 模板，支持占位符
 * {{text}} {{name}} {{status}} {{url}} {{time}}
 * 模板为空时退化为 { "text": "..." }
 */
async function sendCustom(globalCfg, text, ctx = {}) {
  const url = String(globalCfg.customWebhook || '').trim();
  if (!url) throw new Error('未配置通用 Webhook 地址');
  const tpl = String(globalCfg.customTemplate || '').trim();
  const jsonEsc = (s) => JSON.stringify(String(s ?? '')).slice(1, -1);
  let body;
  if (tpl) {
    body = tpl
      .replace(/\{\{\s*text\s*\}\}/g, jsonEsc(text))
      .replace(/\{\{\s*name\s*\}\}/g, jsonEsc(ctx.name || ''))
      .replace(/\{\{\s*status\s*\}\}/g, jsonEsc(ctx.status || ''))
      .replace(/\{\{\s*url\s*\}\}/g, jsonEsc(ctx.url || ''))
      .replace(/\{\{\s*time\s*\}\}/g, jsonEsc(new Date().toLocaleString('zh-CN')));
    // 校验模板渲染后仍是合法 JSON，避免把坏请求发出去
    try { JSON.parse(body); } catch (e) { throw new Error('通用 Webhook 模板渲染后不是合法 JSON'); }
  } else {
    body = JSON.stringify({ text });
  }
  const headers = {};
  const extra = String(globalCfg.customHeaders || '').trim();
  if (extra) {
    try {
      const h = JSON.parse(extra);
      if (h && typeof h === 'object') Object.assign(headers, h);
    } catch (e) { throw new Error('自定义请求头不是合法 JSON'); }
  }
  return postRetry(url, body, { raw: true, headers, ...sendOpts(globalCfg, ctx) });
}

const SENDERS = {
  weixin: sendWeixin,
  qq: sendQQ,
  dingtalk: sendDingtalk,
  telegram: sendTelegram,
  feishu: sendFeishu,
  slack: sendSlack,
  serverchan: sendServerChan,
  custom: sendCustom
};

/** 某通道是否已启用且配置完整 */
function channelEnabled(globalCfg, ch) {
  const g = globalCfg || {};
  switch (ch) {
    case 'weixin': return Boolean(g.notifyWeixinEnabled && g.weixinWebhook);
    case 'qq': return Boolean(g.notifyQQEnabled && g.qqWebhook && g.qqTarget);
    case 'dingtalk': return Boolean(g.notifyDingtalkEnabled && g.dingtalkWebhook);
    case 'telegram': return Boolean(g.notifyTelegramEnabled && g.telegramToken && g.telegramChatId);
    case 'feishu': return Boolean(g.notifyFeishuEnabled && g.feishuWebhook);
    case 'slack': return Boolean(g.notifySlackEnabled && g.slackWebhook);
    case 'serverchan': return Boolean(g.notifyServerChanEnabled && g.serverchanKey);
    case 'custom': return Boolean(g.notifyCustomEnabled && g.customWebhook);
    default: return false;
  }
}

/** 向所有已启用通道广播一段文本；任一通道失败只记日志不影响其它 */
async function broadcast(globalCfg, text, ctx = {}) {
  const jobs = [];
  for (const ch of CHANNELS) {
    if (!channelEnabled(globalCfg, ch)) continue;
    const label = CHANNEL_LABEL[ch] || ch;
    jobs.push(
      SENDERS[ch](globalCfg, text, ctx)
        .then(() => { noteResult(ch, true); logger.info(`[通知] ${label}推送成功${ctx.name ? ': ' + ctx.name : ''}`); })
        .catch((e) => { noteResult(ch, false); logger.error(`[通知] ${label}推送失败: ${e.message}`); })
    );
  }
  if (!jobs.length) logger.debug('[通知] 无已启用的通知通道，跳过推送');
  await Promise.all(jobs);
  return jobs.length;
}

/** 模型变化时推送（兼容旧签名） */
async function notifyModelChange(globalCfg, provider, prev, next, extra = {}) {
  const text = buildModelChangeText(provider, prev, next, extra);
  return broadcast(globalCfg, text, { name: provider.name, status: provider.status, url: provider.url, provider });
}

/** 故障/恢复告警推送 */
async function notifyAlert(globalCfg, provider, alert) {
  const text = buildAlertText(provider, alert);
  return broadcast(globalCfg, text, { name: provider.name, status: provider.status, url: provider.url, provider });
}

async function sendTest(globalCfg, channel) {
  const text = `【AI Provider Monitor】测试消息 ${new Date().toLocaleString('zh-CN')}`;
  const fn = SENDERS[channel];
  if (!fn) throw new Error('未知通道');
  return fn(globalCfg, text, { name: '测试', status: 'up', url: '' });
}

module.exports = {
  notifyModelChange, notifyAlert, sendTest, broadcast,
  buildModelChangeText, buildAlertText, channelEnabled,
  sendQQ, sendWeixin, sendDingtalk, sendTelegram, sendFeishu, sendSlack, sendServerChan, sendCustom,
  CHANNELS, CHANNEL_LABEL, getNotifyHealth, resolveNotifyProxy, oneBotId
};
