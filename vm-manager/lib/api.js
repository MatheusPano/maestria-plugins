// A tabela de endpoints da API do CCS Console (caminhos relativos a /api).

'use strict';

const enc = encodeURIComponent;

function createApi(http) {
  const get = (path, opts) => http.request('GET', path, opts);
  const post = (path, body, opts) => http.request('POST', path, { body, ...opts });

  return {
    // auth
    pluginToken: ({ code, verifier }) => post('/auth/plugin/token', { code, verifier }, { auth: false }),
    pluginRefresh: (token) =>
      post('/auth/plugin/refresh', undefined, { auth: false, headers: { Authorization: `Bearer ${token}` } }),
    me: () => get('/auth/me'),

    // vms
    overview: () => get('/overview'),
    vms: () => get('/vms'),
    vm: (vmid) => get(`/vms/${enc(vmid)}`),
    createVm: (body) => post('/vms', body, { timeoutMs: 90000 }),
    vmCreation: (name) => get(`/vms/creations/${enc(name)}`),
    startVm: (vmid) => post(`/vms/${enc(vmid)}/start`),
    stopVm: (vmid) => post(`/vms/${enc(vmid)}/stop`),
    backupVm: (vmid) => post(`/vms/${enc(vmid)}/backup`),
    haVm: (vmid) => post(`/vms/${enc(vmid)}/ha`),
    destroyVm: (vmid) => http.request('DELETE', `/vms/${enc(vmid)}`),

    // ipam / catalog
    ipamCheck: (ip) => get('/ipam/check', { query: { ip } }),
    ipamNextFree: (near) => get('/ipam/next-free', { query: { near } }),
    catalogNodes: () => get('/catalog/nodes'),
    catalogStorages: () => get('/catalog/storages'),
    catalogTemplates: () => get('/catalog/templates'),
    catalogDefaults: () => get('/catalog/defaults'),

    // storage
    health: () => get('/health'),
    pools: () => get('/storage/pools'),
    poolImages: (pool) => get(`/storage/pools/${enc(pool)}/images`),
    trash: () => get('/storage/trash'),

    // buckets
    buckets: () => get('/buckets'),
    bucketOwners: () => get('/buckets/owners'),
    createBucket: ({ name, owner, newOwner }) => post('/buckets', { name, owner, newOwner }),
    credentials: (owner) => get(`/buckets/owners/${enc(owner)}/credentials`),
    secret: (owner) => get(`/buckets/owners/${enc(owner)}/credentials/secret`),

    // routes
    routes: () => get('/routes'),
    healthchecks: () => get('/routes/healthchecks'),
    planRoute: (body) => post('/routes/plan', body),
    createRoute: (body) => post('/routes', body),
    routeJob: (id) => get(`/routes/jobs/${enc(id)}`),
    removalPlan: (hostname) => post(`/routes/${enc(hostname)}/removal-plan`),
    removeRoute: (hostname, fingerprint) => http.request('DELETE', `/routes/${enc(hostname)}`, { body: { fingerprint } }),

    // admin
    users: () => get('/users'),
    setRole: (id, role) => http.request('PATCH', `/users/${enc(id)}/role`, { body: { role } }),
    audit: ({ page, action, outcome, userId } = {}) => get('/audit', { query: { page, action, outcome, userId }, raw: true }),
  };
}

module.exports = { createApi };
