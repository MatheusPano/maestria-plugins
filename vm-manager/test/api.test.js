'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttp } = require('../lib/http');
const { createApi } = require('../lib/api');
const { fakeFetch } = require('./helpers');

function setup(routes = [{ json: {} }]) {
  const fetch = fakeFetch(routes);
  const http = createHttp({ baseUrl: 'https://x', fetch, getAuth: async () => 'tok' });
  return { fetch, api: createApi(http) };
}

const rows = [
  ['me', [], 'GET', '/api/auth/me'],
  ['overview', [], 'GET', '/api/overview'],
  ['vms', [], 'GET', '/api/vms'],
  ['vm', [101], 'GET', '/api/vms/101'],
  ['createVm', [{ name: 'a' }], 'POST', '/api/vms', { name: 'a' }],
  ['vmCreation', ['a b'], 'GET', '/api/vms/creations/a%20b'],
  ['startVm', [101], 'POST', '/api/vms/101/start'],
  ['stopVm', [101], 'POST', '/api/vms/101/stop'],
  ['backupVm', [101], 'POST', '/api/vms/101/backup'],
  ['haVm', [101], 'POST', '/api/vms/101/ha'],
  ['destroyVm', [101], 'DELETE', '/api/vms/101'],
  ['ipamCheck', ['10.0.0.1'], 'GET', '/api/ipam/check?ip=10.0.0.1'],
  ['ipamNextFree', [''], 'GET', '/api/ipam/next-free'],
  ['ipamNextFree', ['192.168.100.1'], 'GET', '/api/ipam/next-free?near=192.168.100.1'],
  ['catalogNodes', [], 'GET', '/api/catalog/nodes'],
  ['catalogStorages', [], 'GET', '/api/catalog/storages'],
  ['catalogTemplates', [], 'GET', '/api/catalog/templates'],
  ['catalogDefaults', [], 'GET', '/api/catalog/defaults'],
  ['health', [], 'GET', '/api/health'],
  ['pools', [], 'GET', '/api/storage/pools'],
  ['poolImages', ['rbd/x'], 'GET', '/api/storage/pools/rbd%2Fx/images'],
  ['trash', [], 'GET', '/api/storage/trash'],
  ['buckets', [], 'GET', '/api/buckets'],
  ['bucketOwners', [], 'GET', '/api/buckets/owners'],
  ['createBucket', [{ name: 'b', owner: 'o', newOwner: true }], 'POST', '/api/buckets', { name: 'b', owner: 'o', newOwner: true }],
  ['credentials', ['o w'], 'GET', '/api/buckets/owners/o%20w/credentials'],
  ['secret', ['o'], 'GET', '/api/buckets/owners/o/credentials/secret'],
  ['routes', [], 'GET', '/api/routes'],
  ['healthchecks', [], 'GET', '/api/routes/healthchecks'],
  ['planRoute', [{ h: 1 }], 'POST', '/api/routes/plan', { h: 1 }],
  ['createRoute', [{ h: 1 }], 'POST', '/api/routes', { h: 1 }],
  ['routeJob', ['j1'], 'GET', '/api/routes/jobs/j1'],
  ['removalPlan', ['app.x.io'], 'POST', '/api/routes/app.x.io/removal-plan'],
  ['removeRoute', ['app.x.io', 'fp1'], 'DELETE', '/api/routes/app.x.io', { fingerprint: 'fp1' }],
  ['users', [], 'GET', '/api/users'],
  ['setRole', [7, 'admin'], 'PATCH', '/api/users/7/role', { role: 'admin' }],
  ['pluginToken', [{ code: 'c', verifier: 'v' }], 'POST', '/api/auth/plugin/token', { code: 'c', verifier: 'v' }],
  ['pluginRefresh', ['old'], 'POST', '/api/auth/plugin/refresh'],
];

test('each endpoint hits the right method, path and body', async () => {
  for (const [fn, args, method, path, body] of rows) {
    const { fetch, api } = setup();
    await api[fn](...args);
    const c = fetch.calls[0];
    assert.equal(c.method, method, fn);
    assert.equal(c.url, `https://x${path}`, fn);
    assert.deepEqual(c.body, body, fn);
  }
});

test('createVm uses a 90s timeout', async () => {
  const calls = [];
  const http = { request: (...a) => { calls.push(a); return Promise.resolve(null); } };
  await createApi(http).createVm({ name: 'a' });
  assert.equal(calls[0][2].timeoutMs, 90000);
});

test('audit returns raw body', async () => {
  const { api } = setup([{ json: { data: [1], pagination: { page: 2 } } }]);
  assert.deepEqual(await api.audit({ page: 2 }), { data: [1], pagination: { page: 2 } });
});

test('audit sends only filled filters', async () => {
  const { fetch, api } = setup();
  await api.audit({ page: 2, action: '', outcome: 'success', userId: 3 });
  assert.equal(fetch.calls[0].url, 'https://x/api/audit?page=2&outcome=success&userId=3');
});

test('pluginToken sends no Authorization', async () => {
  const { fetch, api } = setup();
  await api.pluginToken({ code: 'c', verifier: 'v' });
  assert.equal(fetch.calls[0].headers.Authorization, undefined);
});

test('pluginRefresh sends the given bearer', async () => {
  const { fetch, api } = setup();
  await api.pluginRefresh('old');
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer old');
});
