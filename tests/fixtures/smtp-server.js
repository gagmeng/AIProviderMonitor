'use strict';
// Local SMTP fixture only. The adjacent self-signed key/certificate are public test data.
const net = require('net'), tls = require('tls'), fs = require('fs'), path = require('path');

async function smtpServer({ secure = false, rejectAuth = false } = {}) {
  const sockets = new Set(), messages = [], authentications = [];
  const accept = (socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); socket.write('220 localhost SMTP fixture\r\n');
    let input = '', data = false, body = [], envelope = {};
    const line = (value) => {
      if (data) {
        if (value === '.') {
          messages.push({ ...envelope, body: body.join('\r\n') }); data = false; body = []; envelope = {};
          socket.write('250 queued\r\n');
        } else body.push(value.replace(/^\.\./, '.'));
        return;
      }
      if (/^(EHLO|HELO)\b/i.test(value)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
      else if (/^AUTH PLAIN /i.test(value)) {
        const credentials = Buffer.from(value.slice(11), 'base64').toString('utf8').split('\0');
        authentications.push({ user: credentials[1], pass: credentials[2] });
        socket.write(rejectAuth ? '535 authentication rejected\r\n' : '235 authenticated\r\n');
      } else if (/^MAIL FROM:/i.test(value)) { envelope.from = value; socket.write('250 sender ok\r\n'); }
      else if (/^RCPT TO:/i.test(value)) { (envelope.to ||= []).push(value); socket.write('250 recipient ok\r\n'); }
      else if (/^DATA$/i.test(value)) { data = true; socket.write('354 end with dot\r\n'); }
      else if (/^QUIT$/i.test(value)) socket.end('221 bye\r\n');
      else if (/^(RSET|NOOP)\b/i.test(value)) socket.write('250 ok\r\n');
      else socket.write('500 unsupported command\r\n');
    };
    socket.on('data', (chunk) => {
      input += chunk; let end;
      while ((end = input.indexOf('\r\n')) >= 0) { const value = input.slice(0, end); input = input.slice(end + 2); line(value); }
    });
  };
  const server = secure ? tls.createServer({ key: fs.readFileSync(path.join(__dirname, 'smtp-localhost-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'smtp-localhost-cert.pem')) }, accept) : net.createServer(accept);
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, messages, authentications, close: () => {
    for (const socket of sockets) socket.destroy(); server.close();
  } };
}
module.exports = { smtpServer };
