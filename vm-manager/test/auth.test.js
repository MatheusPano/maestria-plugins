'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const auth = require('../lib/auth');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-auth-')), 'auth.json');
}

const REC = {
  url: 'https://h',
  token: 't',
  expiresAt: 2000,
  obtainedAt: 1000,
  user: { id: 'u1', name: 'N', email: 'e@x', role: 'admin' },
};

test('challenge is base64url sha256 of verifier', () => {
  assert.equal(
    auth.challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('verifier is 43 base64url chars', () => {
  assert.match(auth.makeVerifier(), /^[A-Za-z0-9_-]{43}$/);
  assert.match(auth.makeState(), /^[A-Za-z0-9_-]{22}$/);
});

test('login url carries client, port, state, challenge', () => {
  const a = auth.buildLoginUrl('https://h/', { port: 1234, state: 's', challenge: 'c' });
  const b = auth.buildLoginUrl('https://h', { port: 1234, state: 's', challenge: 'c' });
  assert.equal(a, b);
  const u = new URL(a);
  assert.equal(u.pathname, '/api/auth/login');
  assert.equal(u.searchParams.get('client'), 'maestria');
  assert.equal(u.searchParams.get('port'), '1234');
  assert.equal(u.searchParams.get('state'), 's');
  assert.equal(u.searchParams.get('challenge'), 'c');
});

test('store roundtrip', () => {
  const f = tmpFile();
  const s = auth.createTokenStore(f);
  assert.equal(s.load(), null);
  s.save(REC);
  assert.deepEqual(s.load(), REC);
});

test('saved file is 0600 and not world-readable', () => {
  const f = tmpFile();
  auth.createTokenStore(f).save(REC);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('no tmp file left behind', () => {
  const f = tmpFile();
  auth.createTokenStore(f).save(REC);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['auth.json']);
});

test('corrupt file loads as null', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{nope');
  assert.equal(auth.createTokenStore(f).load(), null);
});

test('clear removes the file', () => {
  const f = tmpFile();
  const s = auth.createTokenStore(f);
  s.save(REC);
  s.clear();
  assert.equal(fs.existsSync(f), false);
  s.clear();
});

test('needsRefresh at half life', () => {
  const r = { ...REC, obtainedAt: 0, expiresAt: 1000 };
  assert.equal(auth.needsRefresh(r, 499), false);
  assert.equal(auth.needsRefresh(r, 500), true);
  assert.equal(auth.needsRefresh(r, 1000), false);
  assert.equal(auth.isExpired(r, 999), false);
  assert.equal(auth.isExpired(r, 1000), true);
});
