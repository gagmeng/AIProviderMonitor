'use strict';
/**
 * 邮件发送（日报用）：nodemailer 懒加载，未安装依赖时给出明确提示。
 */
const logger = require('./logger');

function mailConfigValid(g) {
  return Boolean(g && g.smtpHost && g.smtpUser && g.smtpPass && g.mailTo);
}

async function sendMail(g, { subject, html }) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { throw new Error('未安装 nodemailer 依赖，无法发送邮件（请运行 npm install）'); }
  const port = Number(g.smtpPort) || 465;
  const transporter = nodemailer.createTransport({
    host: String(g.smtpHost).trim(),
    port,
    secure: g.smtpSecure !== false && (port === 465 || g.smtpSecure === true),
    auth: { user: String(g.smtpUser).trim(), pass: String(g.smtpPass) },
    tls: g.smtpInsecureSkipVerify ? { rejectUnauthorized: false } : undefined
  });
  const from = String(g.mailFrom || g.smtpUser).trim();
  await transporter.sendMail({ from, to: String(g.mailTo).trim(), subject, html });
  logger.info(`[邮件] 已发送: ${subject}`);
}

module.exports = { mailConfigValid, sendMail };
