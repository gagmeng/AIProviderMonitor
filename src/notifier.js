'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const logger = require('./logger');

/**
 * 通知器：支持企业微信群机器人 Webhook、钉钉群机器人 Webhook（含加签）
 * 与 QQ（OneBot v11 HTTP 服务：NapCat / Lagrange / go-cqhttp）。
 */

function post(url, payload, { timeout = 10000, token = '' } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`Webhook URL 无效`)); }
    const mod = u.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = mod.request(u, { method: 'POST', headers, timeout }, (res) => {
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

function fmtProvider(p) {
  return `${p.name || 'Provider#' + p.id}`;
}

function statusText(s) {
  return { up: '在线', degraded: '异常', down: '离线', unknown: '待检测' }[s] || String(s || '未知');
}

function buildModelChangeText(provider, prev, next) {
  const lines = [];
  lines.push(`【AI Provider 模型变动】`);
  lines.push(`服务商：${fmtProvider(provider)}`);
  const prevStatus = prev ? statusText(prev.status) : '未知';
  const statusChanged = !prev || prev.status !== next.status;
  const totalChanged = prev && prev.modelsTotal !== next.modelsTotal;
  const parts = [`状态：${prevStatus} → ${statusText(next.status)}`, `可用模型 ${next.modelsAvailable.length}/${next.modelsTotal}`];
  lines.push(parts.join('　'));
  const prevSet = new Set((prev?.modelsAvailable) || []);
  const nextSet = new Set(next.modelsAvailable || []);
  const added = next.modelsAvailable.filter((m) => !prevSet.has(m));
  const removed = (prev?.modelsAvailable || []).filter((m) => !nextSet.has(m));
  if (added.length) lines.push(`新增可用：${added.join(', ')}`);
  if (removed.length) lines.push(`失去可用：${removed.join(', ')}`);
  if (totalChanged && !added.length && !removed.length) lines.push(`模型清单发生变化（总数 ${prev.modelsTotal} → ${next.modelsTotal}）`);
  if (statusChanged) lines.push(`状态变化：${prevStatus} → ${statusText(next.status)}`);
  lines.push(`时间：${new Date().toLocaleString('zh-CN')}`);
  return lines.join('\n');
}

async function sendWeixin(globalCfg, text) {
  if (!globalCfg.weixinWebhook) throw new Error('未配置微信 Webhook');
  return post(globalCfg.weixinWebhook, { msgtype: 'text', text: { content: text } });
}

/** 钉钉群机器人：webhook + 可选加签（secret 时在 URL 上附 timestamp & sign） */
async function sendDingtalk(globalCfg, text) {
  let url = String(globalCfg.dingtalkWebhook || '').trim();
  if (!url) throw new Error('未配置钉钉 Webhook');
  const secret = String(globalCfg.dingtalkSecret || '').trim();
  if (secret) {
    const ts = Date.now();
    const sign = crypto
      .createHmac('sha256', secret)
      .update(`${ts}\n${secret}`)
      .digest('base64');
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  const res = await post(url, { msgtype: 'text', text: { content: text } });
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
async function sendQQ(globalCfg, text) {
  const base = String(globalCfg.qqWebhook || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未配置 QQ 机器人服务地址');
  const target = String(globalCfg.qqTarget || '').trim();
  if (!target) throw new Error('未配置上报目标 QQ 号/群号');
  const token = String(globalCfg.qqToken || '').trim();
  const isGroup = globalCfg.qqTargetType === 'group';
  const path = isGroup ? '/send_group_msg' : '/send_private_msg';
  const payload = isGroup
    ? { group_id: target, message: text }
    : { user_id: target, message: text };
  const res = await post(base + path, payload, { token });
  // OneBot v11 返回 { status, retcode, data, echo }，retcode=0 表示成功
  try {
    const j = JSON.parse(res);
    if (typeof j.retcode === 'number' && j.retcode !== 0) {
      throw new Error(`机器人返回错误 retcode=${j.retcode}${j.wording ? ' (' + j.wording + ')' : ''}`);
    }
  } catch (e) {
    if (e instanceof SyntaxError) { /* 非 JSON 响应，视为 HTTP 层已成功 */ }
    else throw e;
  }
  return res;
}

/** 模型变化时按全局配置推送微信/QQ/钉钉 */
async function notifyModelChange(globalCfg, provider, prev, next) {
  const text = buildModelChangeText(provider, prev, next);
  const jobs = [];
  if (globalCfg.notifyWeixinEnabled && globalCfg.weixinWebhook) {
    jobs.push(sendWeixin(globalCfg, text).then(() => logger.info(`[通知] 微信推送成功: ${provider.name}`)).catch((e) => logger.error(`[通知] 微信推送失败: ${e.message}`)));
  }
  if (globalCfg.notifyQQEnabled && globalCfg.qqWebhook) {
    jobs.push(sendQQ(globalCfg, text).then(() => logger.info(`[通知] QQ推送成功: ${provider.name}`)).catch((e) => logger.error(`[通知] QQ推送失败: ${e.message}`)));
  }
  if (globalCfg.notifyDingtalkEnabled && globalCfg.dingtalkWebhook) {
    jobs.push(sendDingtalk(globalCfg, text).then(() => logger.info(`[通知] 钉钉推送成功: ${provider.name}`)).catch((e) => logger.error(`[通知] 钉钉推送失败: ${e.message}`)));
  }
  await Promise.all(jobs);
}

async function sendTest(globalCfg, channel) {
  const text = `【AI Provider Monitor】测试消息 ${new Date().toLocaleString('zh-CN')}`;
  if (channel === 'weixin') return sendWeixin(globalCfg, text);
  if (channel === 'qq') return sendQQ(globalCfg, text);
  if (channel === 'dingtalk') return sendDingtalk(globalCfg, text);
  throw new Error('未知通道');
}

module.exports = { notifyModelChange, sendTest, buildModelChangeText, sendQQ, sendWeixin, sendDingtalk };
