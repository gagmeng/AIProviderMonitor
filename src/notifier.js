'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { headersForRedirect } = require('./httpguard');
const { requestRaw } = require('./httpRequest');
const { DATA_DIR } = require('./store');

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

async function post(url, payload, { timeout = 10000, token = '', headers: extraHeaders = {}, raw = false,
  proxy = '', insecureSkipVerify = false, deadlineAt = Date.now() + timeout, _redirects = 0 } = {}) {
  const body = raw ? String(payload) : JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', ...extraHeaders, 'Content-Length': Buffer.byteLength(body) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await requestRaw(url, { method: 'POST', headers, body, timeout, deadlineAt,
    agent: getProxyAgent(proxy, insecureSkipVerify), insecureSkipVerify, maxBytes: 1024 * 1024 });
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && _redirects < 3) {
    if (res.statusCode === 303) throw new Error('通道重定向到 GET（HTTP 303），请检查 Webhook 地址');
    const next = new URL(res.headers.location, url).toString();
    return post(next, payload, { timeout, deadlineAt, headers: headersForRedirect(url, next, headers), raw,
      proxy, insecureSkipVerify, _redirects: _redirects + 1 });
  }
  if (res.statusCode >= 200 && res.statusCode < 300) return res.body;
  throw new Error(`HTTP ${res.statusCode}: ${res.body.slice(0, 120)}`);
}

function checkBusinessResponse(text, channel) {
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`${channel} 返回无效 JSON`); }
  const checks = { weixin: ['errcode', 0], dingtalk: ['errcode', 0], qq: ['retcode', 0],
    telegram: ['ok', true], feishu: ['code', 0], serverchan: ['code', 0] };
  const [key, expected] = checks[channel];
  const value = j && j[key];
  if (value === undefined || (expected === true ? value !== true : Number(value) !== expected)) {
    throw new Error(`${CHANNEL_LABEL[channel]}返回错误 ${key}=${value ?? '缺失'} ${String(j?.errmsg || j?.msg || j?.message || j?.description || j?.wording || '').slice(0, 160)}`);
  }
  return text;
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

/** 各通道健康状态（自监控用）：连续失败计数 + 最近成功/失败时刻与错误，供设置页健康面板展示 */
const notifyHealth = {};
// 健康状态落盘：进程内内存态一重启就清空，面板会退回「未使用」，与用户已启用的配置矛盾。
// 写入频率仅由通知发送触发（告警级），量级极低，直接同步写即可，不做防抖。
const HEALTH_FILE = path.join(DATA_DIR, 'notify-health.json');
let healthLoaded = false;

function loadHealth() {
  if (healthLoaded) return;
  healthLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    for (const ch of CHANNELS) {
      const h = raw && raw[ch];
      if (!h || typeof h !== 'object') continue;
      notifyHealth[ch] = {
        fails: Math.max(0, Number(h.fails) || 0),
        lastOkAt: Number(h.lastOkAt) || 0,
        lastFailAt: Number(h.lastFailAt) || 0,
        lastError: String(h.lastError || '').slice(0, 200)
      };
    }
  } catch (e) { /* 首次运行或文件损坏：从空状态开始，不影响发送 */ }
}

function saveHealth() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${HEALTH_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(notifyHealth, null, 2), 'utf8');
    fs.renameSync(tmp, HEALTH_FILE);
  } catch (e) { /* 落盘失败只影响面板展示，不能阻断通知 */ }
}

function noteResult(channel, ok, err) {
  loadHealth();
  const h = notifyHealth[channel] || (notifyHealth[channel] = { fails: 0, lastOkAt: 0, lastFailAt: 0, lastError: '' });
  if (ok) {
    h.fails = 0;
    h.lastError = '';
    h.lastOkAt = Date.now();
  } else {
    h.fails++;
    h.lastFailAt = Date.now();
    h.lastError = String((err && err.message) || err || '').slice(0, 200);
    if (h.fails === 3) logger.error(`[自检] 通知通道「${CHANNEL_LABEL[channel] || channel}」连续失败 ${h.fails} 次，请检查配置与网络`);
    // 连续失败只有日志一行，不看界面永远不知道「告警发不出去」。
    // 首次跨过 3 次以及之后每多 5 次失败时回调主进程，转成未读告警 + 托盘气泡。
    if (healthAlertHandler && (h.fails === 3 || (h.fails > 3 && (h.fails - 3) % 5 === 0))) {
      try { healthAlertHandler(channel, h.fails, h.lastError); } catch (e) { /* 回调异常不阻断通知 */ }
    }
  }
  saveHealth();
}

let healthAlertHandler = null;
/** 注册通道连续失败回调：main.js 用它把通道故障转成未读告警与托盘气泡 */
function onChannelUnhealthy(fn) { healthAlertHandler = typeof fn === 'function' ? fn : null; }
function getNotifyHealth() {
  loadHealth();
  return JSON.parse(JSON.stringify(notifyHealth));
}

/** 清除某通道的健康记录（对应密钥被删除后，历史成功/失败不再代表当前配置） */
function resetHealth(channels) {
  loadHealth();
  let changed = false;
  for (const ch of Array.isArray(channels) ? channels : [channels]) {
    if (notifyHealth[ch]) { delete notifyHealth[ch]; changed = true; }
  }
  if (changed) saveHealth();
}

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
    : alert.kind === 'authfail' ? '【AI Provider 密钥失效】'
    : alert.kind === 'latency' ? '【AI Provider 延迟劣化】' : '【AI Provider 服务异常】';
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
  return checkBusinessResponse(await postRetry(globalCfg.weixinWebhook, { msgtype: 'text', text: { content: text } }, sendOpts(globalCfg, ctx)), 'weixin');
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
  return checkBusinessResponse(res, 'dingtalk');
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
  return checkBusinessResponse(res, 'qq');
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
  return checkBusinessResponse(res, 'telegram');
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
  return checkBusinessResponse(res, 'feishu');
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
  return checkBusinessResponse(await postRetry(url, form, { raw: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, ...sendOpts(globalCfg, ctx) }), 'serverchan');
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
  const jobs = [], eligible = [];
  const routes = ctx.provider && Array.isArray(ctx.provider.notifyChannels) ? ctx.provider.notifyChannels : [];
  for (const ch of CHANNELS) {
    if (routes.length && !routes.includes(ch)) continue;
    if (!channelEnabled(globalCfg, ch)) continue;
    eligible.push(ch);
    if ((ctx.delivered || []).includes(ch)) continue;
    const label = CHANNEL_LABEL[ch] || ch;
    jobs.push(
      SENDERS[ch](globalCfg, text, ctx)
        .then(() => { noteResult(ch, true); logger.info(`[通知] ${label}推送成功${ctx.name ? ': ' + ctx.name : ''}`); return { channel: ch, ok: true }; })
        .catch((e) => { noteResult(ch, false, e); logger.error(`[通知] ${label}推送失败: ${e.message}`); return { channel: ch, ok: false, error: e.message }; })
    );
  }
  if (!jobs.length) logger.debug('[通知] 无已启用的通知通道，跳过推送');
  const results = await Promise.all(jobs);
  return { complete: eligible.length > 0 && eligible.every((ch) => (ctx.delivered || []).includes(ch) || results.some((r) => r.channel === ch && r.ok)), attempted: results.length, delivered: results.filter((r) => r.ok).map((r) => r.channel), failed: results.filter((r) => !r.ok), results };
}

/** 模型变化时推送（兼容旧签名） */
async function notifyModelChange(globalCfg, provider, prev, next, extra = {}) {
  const text = buildModelChangeText(provider, prev, next, extra);
  return broadcast(globalCfg, text, { name: provider.name, status: provider.status, url: provider.url, provider, delivered: extra.delivered || [] });
}

/** 故障/恢复告警推送 */
async function notifyAlert(globalCfg, provider, alert, extra = {}) {
  const text = buildAlertText(provider, alert);
  return broadcast(globalCfg, text, { name: provider.name, status: provider.status, url: provider.url, provider, delivered: extra.delivered || [] });
}

async function sendTest(globalCfg, channel) {
  const text = `【AI Provider Monitor】测试消息 ${new Date().toLocaleString('zh-CN')}`;
  const fn = SENDERS[channel];
  if (!fn) throw new Error('未知通道');
  // 测试发送同样是真实请求，健康面板必须能看到结果，否则刚测通也仍显示「未使用」
  try {
    const res = await fn(globalCfg, text, { name: '测试', status: 'up', url: '' });
    noteResult(channel, true);
    return res;
  } catch (e) {
    noteResult(channel, false, e);
    throw e;
  }
}

module.exports = {
  notifyModelChange, notifyAlert, sendTest, broadcast,
  buildModelChangeText, buildAlertText, channelEnabled,
  sendQQ, sendWeixin, sendDingtalk, sendTelegram, sendFeishu, sendSlack, sendServerChan, sendCustom,
  post, checkBusinessResponse, CHANNELS, CHANNEL_LABEL, getNotifyHealth, noteResult, resetHealth, resolveNotifyProxy, oneBotId, onChannelUnhealthy
};
