'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttp, ApiError } = require('../lib/http');
const { fakeFetch } = require('./helpers');

const mk = (routes, extra = {}) => {
  const fetch = fakeFetch(routes);
  const http = createHttp({ baseUrl: 'https://x', fetch, getAuth: async () => 'tok', ...extra });
  return { fetch, http };
};

test('sends bearer and json headers', async () => {
  const { fetch, http } = mk([{ method: 'GET', path: '/api/vms', json: { data: [] } }]);
  await http.request('GET', '/vms');
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(fetch.calls[0].headers['Content-Type'], 'application/json');
  assert.equal(fetch.calls[0].url, 'https://x/api/vms');
});

test('unwraps data envelope', async () => {
  const { http } = mk([
    { path: '/api/a', json: { data: [1] } },
    { path: '/api/b', json: { a: 1 } },
    { path: '/api/c', json: { data: [1], pagination: {} } },
  ]);
  assert.deepEqual(await http.request('GET', '/a'), [1]);
  assert.deepEqual(await http.request('GET', '/b'), { a: 1 });
  assert.deepEqual(await http.request('GET', '/c', { raw: true }), { data: [1], pagination: {} });
});

test('204 returns null and invalid json returns null', async () => {
  const { http } = mk([
    { path: '/api/a', status: 204 },
    { path: '/api/b', text: 'nao e json' },
  ]);
  assert.equal(await http.request('POST', '/a'), null);
  assert.equal(await http.request('GET', '/b'), null);
});

test('nest error with string message', async () => {
  const { http } = mk([{ path: '/api/vms', status: 409, json: { statusCode: 409, message: 'A VM "a" já está sendo criada.' } }]);
  await assert.rejects(http.request('POST', '/vms'), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 409);
    assert.equal(e.nest, true);
    assert.equal(e.kind, 'http');
    assert.equal(e.message, 'A VM "a" já está sendo criada.');
    return true;
  });
});

test("nest error with array message joins with ' · '", async () => {
  const { http } = mk([{ path: '/api/vms', status: 400, json: { statusCode: 400, message: ['a', 'b'] } }]);
  await assert.rejects(http.request('POST', '/vms'), (e) => e.message === 'a · b' && e.nest === true);
});

test('non-json 502 is not nest', async () => {
  const { http } = mk([{ path: '/api/vms', status: 502, text: '<html>Bad Gateway</html>' }]);
  await assert.rejects(http.request('GET', '/vms'), (e) => e.status === 502 && e.nest === false && e.message === 'HTTP 502');
});

test('401 calls onUnauthorized then throws', async () => {
  let n = 0;
  const { http } = mk([{ path: '/api/vms', status: 401, json: { message: 'nope' } }], { onUnauthorized: () => { n++; } });
  await assert.rejects(http.request('GET', '/vms'), (e) => e.status === 401);
  assert.equal(n, 1);
});

test('timeout becomes kind timeout', async () => {
  const { http } = mk([{ path: '/api/vms', delayMs: 50, json: {} }]);
  await assert.rejects(http.request('GET', '/vms', { timeoutMs: 10 }), (e) => {
    return e instanceof ApiError && e.kind === 'timeout' && e.status === 0 && e.message === 'A API não respondeu a tempo.';
  });
});

test('network error message has no token', async () => {
  const { http } = mk([{ path: '/api/vms', throws: new TypeError('fetch failed') }]);
  await assert.rejects(http.request('GET', '/vms'), (e) => {
    return e.kind === 'network' && e.status === 0 && e.message === 'Sem conexão com a API: fetch failed' && !e.message.includes('tok');
  });
});

test('query skips empty values', async () => {
  const { fetch, http } = mk([{ path: '/api/audit?page=2', json: { data: [] } }]);
  await http.request('GET', '/audit', { query: { page: 2, action: '', userId: undefined } });
  assert.equal(fetch.calls[0].url, 'https://x/api/audit?page=2');
});
