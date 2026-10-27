'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
const { challengeOf } = require('../lib/auth');
const { fakeFetch } = require('./helpers');

const URL_ = 'https://vm.test';
const USER = { id: 'u1', email: 'a@b.c', role: 'admin' };

function memStore(rec = null) {
  let cur = rec;
  return { load: () => cur, save: (r) => { cur = r; }, clear: () => { cur = null; } };
}

function mk({ routes = [], rec = null, now = () => 1000, loopback, url = URL_ } = {}) {
  const fetch = fakeFetch(routes);
  const store = memStore(rec);
  const opened = [];
  let started = 0;
  const startLoopback = loopback || (async () => {
    started++;
    return { port: 5555, result: Promise.resolve({ code: 'c1' }), close() {} };
  });
  const session = createSession({
    url,
    store,
    fetch,
    openUrl: (u) => opened.push(u),
    now: () => now(),
    startLoopback: async (o) => { const r = await startLoopback(o); return r; },
    randomBytes: undefined,
  });
  return { fetch, store, opened, session, started: () => started };
}

const tokenRoute = { method: 'POST', path: '/api/auth/plugin/token', json: { data: { token: 't1', expiresAt: new Date(10000).toISOString(), user: USER } } };

test('login opens browser with challenge of the exchanged verifier', async () => {
  const { fetch, store, opened, session } = mk({ routes: [tokenRoute] });
  const r = await session.login();
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'admin');
  const u = new URL(opened[0]);
  assert.equal(u.searchParams.get('port'), '5555');
  const body = fetch.calls[0].body;
  assert.equal(body.code, 'c1');
  assert.equal(challengeOf(body.verifier), u.searchParams.get('challenge'));
  const rec = store.load();
  assert.equal(rec.url, URL_);
  assert.equal(rec.token, 't1');
  assert.equal(rec.expiresAt, 10000);
  assert.equal(rec.user.role, 'admin');
  assert.equal(session.isLoggedIn(), true);
});

test('login error maps to web copy', async () => {
  const msgs = {
    sso: 'Não foi possível entrar. Tente de novo.',
    expired: 'O login demorou demais. Tente de novo.',
    timeout: 'O login expirou. Tente de novo.',
  };
  for (const [error, message] of Object.entries(msgs)) {
    const { session } = mk({ loopback: async () => ({ port: 1, result: Promise.resolve({ error }), close() {} }) });
    assert.deepEqual(await session.login(), { ok: false, message });
  }
});

test('token exchange 401 is a login failure, not expired', async () => {
  const { session, store } = mk({ routes: [{ path: '/api/auth/plugin/token', status: 401, json: { statusCode: 401, message: 'code inválido' } }] });
  let expired = 0;
  session.on('expired', () => expired++);
  assert.deepEqual(await session.login(), { ok: false, message: 'Não foi possível entrar: code inválido' });
  assert.equal(expired, 0);
  assert.equal(store.load(), null);
});

test('concurrent login() reuses one flow', async () => {
  const { session, opened, started } = mk({ routes: [tokenRoute] });
  const [a, b] = await Promise.all([session.login(), session.login()]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(started(), 1);
  assert.equal(opened.length, 1);
});

test('token for another url is ignored', async () => {
  const rec = { url: 'https://old', token: 'OLD', obtainedAt: 0, expiresAt: 10000, user: USER };
  const { session, fetch } = mk({ rec, now: () => 100, url: 'https://new', routes: [{ path: '/api/vms', json: { data: [] } }] });
  assert.equal(session.isLoggedIn(), false);
  assert.equal(session.user(), null);
  await session.api.vms();
  assert.ok(fetch.calls.every((c) => !String(c.headers.Authorization || '').includes('OLD')));
});

test('refresh past half life', async () => {
  const rec = { url: URL_, token: 'old', obtainedAt: 0, expiresAt: 1000, user: USER };
  const routes = [
    { method: 'POST', path: '/api/auth/plugin/refresh', json: { data: { token: 'new', expiresAt: new Date(5000).toISOString() } } },
    { method: 'GET', path: '/api/vms', json: { data: [] } },
  ];
  const { session, fetch, store } = mk({ rec, now: () => 600, routes });
  await Promise.all([session.api.vms(), session.api.vms()]);
  const refreshes = fetch.calls.filter((c) => c.url.endsWith('/auth/plugin/refresh'));
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].headers.Authorization, 'Bearer old');
  const vms = fetch.calls.filter((c) => c.url.endsWith('/api/vms'));
  assert.equal(vms.length, 2);
  assert.ok(vms.every((c) => c.headers.Authorization === 'Bearer new'));
  assert.equal(store.load().token, 'new');
  assert.equal(store.load().expiresAt, 5000);
  assert.equal(store.load().user.role, 'admin');
});

test('refresh failure other than 401 keeps old token', async () => {
  const rec = { url: URL_, token: 'old', obtainedAt: 0, expiresAt: 1000, user: USER };
  const routes = [
    { method: 'POST', path: '/api/auth/plugin/refresh', status: 502, text: 'bad' },
    { method: 'GET', path: '/api/vms', json: { data: [] } },
  ];
  const { session, fetch, store } = mk({ rec, now: () => 600, routes });
  await session.api.vms();
  assert.equal(store.load().token, 'old');
  assert.equal(fetch.calls[1].headers.Authorization, 'Bearer old');
});

test('refresh 401 clears session and emits expired once', async () => {
  const rec = { url: URL_, token: 'old', obtainedAt: 0, expiresAt: 1000, user: USER };
  const routes = [
    { method: 'POST', path: '/api/auth/plugin/refresh', status: 401, json: { message: 'x' } },
    { method: 'GET', path: '/api/vms', status: 401, json: { message: 'x' } },
  ];
  const { session, store } = mk({ rec, now: () => 600, routes });
  let n = 0;
  session.on('expired', () => n++);
  await assert.rejects(session.api.vms());
  assert.equal(store.load(), null);
  assert.equal(n, 1);
});

test('401 clears session and emits expired', async () => {
  const rec = { url: URL_, token: 'tk', obtainedAt: 0, expiresAt: 10000, user: USER };
  const { session, store } = mk({ rec, now: () => 100, routes: [{ path: '/api/vms', status: 401, json: { message: 'x' } }] });
  let n = 0;
  session.on('expired', () => n++);
  await assert.rejects(session.api.vms(), (e) => e.status === 401);
  assert.equal(store.load(), null);
  assert.equal(n, 1);
});

test('logout clears store without network', () => {
  const rec = { url: URL_, token: 'tk', obtainedAt: 0, expiresAt: 10000, user: USER };
  const { session, store, fetch } = mk({ rec, now: () => 100 });
  session.logout();
  assert.equal(store.load(), null);
  assert.equal(fetch.calls.length, 0);
  assert.equal(session.isLoggedIn(), false);
});

test('refreshMe updates role', async () => {
  const rec = { url: URL_, token: 'tk', obtainedAt: 0, expiresAt: 10000, user: USER };
  const { session, store } = mk({ rec, now: () => 100, routes: [{ path: '/api/auth/me', json: { data: { ...USER, role: 'viewer' } } }] });
  const u = await session.refreshMe();
  assert.equal(u.role, 'viewer');
  assert.equal(session.user().role, 'viewer');
  assert.equal(store.load().user.role, 'viewer');
});

test('logout during in-flight refresh does not resurrect the token', async () => {
  const rec = { url: URL_, token: 'old', obtainedAt: 0, expiresAt: 1000, user: USER };
  const routes = [
    { method: 'POST', path: '/api/auth/plugin/refresh', delayMs: 20, json: { data: { token: 'new', expiresAt: new Date(5000).toISOString() } } },
    { method: 'GET', path: '/api/vms', json: { data: [] } },
  ];
  const { session, store } = mk({ rec, now: () => 600, routes });
  const p = session.api.vms();
  await new Promise((r) => setTimeout(r, 5));
  session.logout();
  await p;
  assert.equal(store.load(), null);
  assert.equal(session.isLoggedIn(), false);
});

test('stale 401 after re-login keeps the new token and does not emit expired', async () => {
  const rec = { url: URL_, token: 'old', obtainedAt: 0, expiresAt: 10000, user: USER };
  const { session, store } = mk({ rec, now: () => 100, routes: [{ path: '/api/vms', delayMs: 20, status: 401, json: { message: 'x' } }] });
  let n = 0;
  session.on('expired', () => n++);
  const p = session.api.vms();
  await new Promise((r) => setTimeout(r, 5));
  store.save({ url: URL_, token: 'fresh', obtainedAt: 0, expiresAt: 10000, user: USER });
  await assert.rejects(p, (e) => e.status === 401);
  assert.equal(store.load().token, 'fresh');
  assert.equal(n, 0);
});

test('malformed token response fails login', async () => {
  const { session, store } = mk({ routes: [{ path: '/api/auth/plugin/token', json: { data: { token: 5, expiresAt: 'nope' } } }] });
  assert.deepEqual(await session.login(), { ok: false, message: 'Não foi possível entrar: resposta inválida da API.' });
  assert.equal(store.load(), null);
});

test('malformed refresh response keeps old token; changed user emits changed', async () => {
  const rec = { url: URL_, token: 'old', obtainedAt: 0, expiresAt: 1000, user: USER };
  const bad = mk({ rec, now: () => 600, routes: [{ method: 'POST', path: '/api/auth/plugin/refresh', json: { data: { token: 'x' } } }, { path: '/api/vms', json: { data: [] } }] });
  await bad.session.api.vms();
  assert.equal(bad.store.load().token, 'old');
  const ok = mk({ rec, now: () => 600, routes: [{ method: 'POST', path: '/api/auth/plugin/refresh', json: { data: { token: 'new', expiresAt: new Date(5000).toISOString(), user: { ...USER, role: 'viewer' } } } }, { path: '/api/vms', json: { data: [] } }] });
  let n = 0;
  ok.session.on('changed', () => n++);
  await ok.session.api.vms();
  assert.equal(n, 1);
});

test('locally expired token clears the session and emits expired once', async () => {
  const rec = { url: URL_, token: 'tok', obtainedAt: 0, expiresAt: 1000, user: USER };
  const { session, store, fetch } = mk({ rec, now: () => 2000, routes: [{ path: '/api/vms', status: 401, json: { statusCode: 401, message: 'Unauthorized' } }] });
  let expired = 0;
  let changed = 0;
  session.on('expired', () => expired++);
  session.on('changed', () => changed++);
  await assert.rejects(session.api.vms(), (e) => e.status === 401);
  await assert.rejects(session.api.vms(), (e) => e.status === 401);
  assert.equal(store.load(), null);
  assert.equal(expired, 1);
  assert.equal(changed, 1);
  assert.equal(session.user(), null);
  assert.ok(fetch.calls.every((c) => !c.headers.Authorization));
});
