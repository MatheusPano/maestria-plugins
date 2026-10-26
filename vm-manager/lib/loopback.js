// Servidor de retorno do login: escuta só em 127.0.0.1, porta livre, e espera
// `/callback?code=…&state=…` (ou `?error=…&state=…`). Nunca loga o code.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const page = (msg) => `<!doctype html><meta charset="utf-8"><title>VM Manager</title><p>${msg}</p>`;
const OK_HTML = page('Conectado — pode voltar ao Maestria');
const ERR_HTML = page('Não deu certo — volte ao Maestria e tente de novo');

function sameState(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function startLoopback({ state, timeoutMs = 600000 }) {
  return new Promise((resolveStart, rejectStart) => {
    let settle;
    const result = new Promise((r) => {
      settle = r;
    });
    let done = false;
    let timer = null;
    const server = http.createServer();

    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(value);
      server.close();
      server.closeIdleConnections();
    };

    server.on('request', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const send = (code, body) => {
        res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
        res.end(body);
      };
      if (u.pathname !== '/callback') return send(404, page('Não encontrado'));
      if (done || !sameState(u.searchParams.get('state'), state)) {
        return send(400, page('Pedido inválido'));
      }
      const code = u.searchParams.get('code');
      if (code) {
        send(200, OK_HTML);
        return finish({ code });
      }
      const error = u.searchParams.get('error') === 'expired' ? 'expired' : 'sso';
      send(200, ERR_HTML);
      return finish({ error });
    });

    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
      timer.unref?.();
      resolveStart({
        port: server.address().port,
        result,
        close: () => finish({ error: 'cancelled' }),
        _server: server,
      });
    });
  });
}

module.exports = { startLoopback };
