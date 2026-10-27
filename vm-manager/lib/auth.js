// PKCE, url de login e arquivo do token. Nada aqui loga código, verifier ou token.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function makeVerifier(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString('base64url');
}

function makeState(randomBytes = crypto.randomBytes) {
  return randomBytes(16).toString('base64url');
}

function challengeOf(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function buildLoginUrl(url, { port, state, challenge }) {
  const q = new URLSearchParams({ client: 'maestria', port: String(port), state, challenge });
  return `${String(url).replace(/\/+$/, '')}/api/auth/login?${q}`;
}

/** Token em disco, 0600, gravado por cima num arquivo ao lado e trocado (como o ssh/hosts.js). */
function createTokenStore(file) {
  return {
    load() {
      try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        return rec && typeof rec === 'object' && rec.token ? rec : null;
      } catch {
        return null;
      }
    },
    save(rec) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    },
    clear() {
      try {
        fs.unlinkSync(file);
      } catch {
        // já não existia
      }
    },
  };
}

function needsRefresh(rec, now) {
  return now >= rec.obtainedAt + (rec.expiresAt - rec.obtainedAt) / 2 && now < rec.expiresAt;
}

function isExpired(rec, now) {
  return now >= rec.expiresAt;
}

module.exports = {
  makeVerifier,
  makeState,
  challengeOf,
  buildLoginUrl,
  createTokenStore,
  needsRefresh,
  isExpired,
};
