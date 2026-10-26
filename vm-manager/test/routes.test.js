'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertNoNull } = require('./helpers');
const r = require('../lib/routes');

const DAY = 86400000;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const inDays = (d) => new Date(NOW + d * DAY + 1000).toISOString();

function cert(over = {}) {
  return { name: 'app', source: 'acme', validation: 'http01', issuedAt: inDays(-30), expiresAt: inDays(60), attached: true, issued: true, autoRenewal: true, wildcard: false, ...over };
}
function route(over = {}) {
  return {
    hostname: 'app.cefis.cloud', tlsMode: 'firewall', access: ['internal'], backendName: 'app_pool',
    backend: { enabled: true, healthCheck: 'tcp-check', servers: [{ name: 's1', address: '10.0.0.5', port: 3000, health: 'up' }] },
    dnsAddress: '10.0.0.1', conflictingBackends: [], problems: [], certificate: cert(), ...over,
  };
}
const srv = (health, n = 1) => ({ name: `s${n}`, address: `10.0.0.${n}`, port: 80, health });

test('severity danger for dns_missing, warn for server_down, ok for none', () => {
  assert.equal(r.severity(route({ problems: ['dns_missing'] })), 'danger');
  assert.equal(r.severity(route({ problems: ['server_down', 'cert_expiring'] })), 'warn');
  assert.equal(r.severity(route({ problems: ['server_down', 'backend_down'] })), 'danger');
  assert.equal(r.severity(route()), 'ok');
  assert.equal(r.PROBLEM_LABEL.cert_expiring, 'certificado vence em menos de 30 dias');
  assert.equal(r.CERT_WARN_DAYS, 30);
});

test('daysLeft floors and is null without expiresAt', () => {
  assert.equal(r.daysLeft(cert({ expiresAt: inDays(10) }), NOW), 10);
  assert.equal(r.daysLeft(cert({ expiresAt: undefined }), NOW), null);
});

test('destino cells', () => {
  const d = (servers) => r.cells(route({ backend: { enabled: true, servers } }), NOW).destino;
  assert.deepEqual(d([srv('up')]), { text: '10.0.0.1:80', tone: 'green' });
  assert.deepEqual(d([srv('up', 1), srv('down', 2)]), { text: '1/2 servidores no ar', tone: 'yellow' });
  assert.deepEqual(d([srv('down', 1), srv('down', 2)]), { text: '0/2 servidores no ar', tone: 'red' });
  assert.deepEqual(d([srv('down')]), { text: '10.0.0.1:80', tone: 'red' });
  assert.deepEqual(d([]), { text: '—', tone: 'dim' });
  assert.deepEqual(r.cells(route({ backend: null }), NOW).destino, { text: '—', tone: 'dim' });
});

test('dns cells', () => {
  const c = (o) => r.cells(route(o), NOW).dns;
  assert.deepEqual(c({}), { text: '→ 10.0.0.1', tone: '' });
  assert.deepEqual(c({ dnsAddress: undefined, problems: ['dns_missing'] }), { text: 'sem override', tone: 'red' });
  assert.deepEqual(c({ dnsAddress: null }), { text: 'só público', tone: 'dim' });
});

test('cert cells', () => {
  const c = (o) => r.cells(route(o), NOW).cert;
  assert.equal(c({ tlsMode: 'passthrough', certificate: null }).text, 'no servidor');
  assert.deepEqual(c({ certificate: null }), { text: 'ausente', tone: 'red' });
  assert.deepEqual(c({ certificate: cert({ attached: false }) }), { text: 'fora do frontend', tone: 'red' });
  assert.equal(c({ certificate: cert({ expiresAt: undefined, source: 'other' }) }).text, 'outra CA');
  assert.deepEqual(c({ certificate: cert({ expiresAt: inDays(10) }) }), { text: 'vence em 10 dias', tone: 'yellow' });
  assert.equal(c({ certificate: cert({ expiresAt: inDays(90), wildcard: true }) }).text, '90 dias · wildcard');
  assert.equal(c({ certificate: cert({ expiresAt: inDays(90) }) }).text, '90 dias');
});

test('backend missing shows (não existe) red; null backend and cert render', () => {
  const x = r.cells(route({ backend: null, certificate: null }), NOW);
  assert.deepEqual(x.backend, { text: 'app_pool (não existe)', tone: 'red' });
  assert.equal(r.cells(route(), NOW).backend.text, 'app_pool');
  assertNoNull(x);
});

test('search matches server addr:port; filters and counts', () => {
  const list = [
    route(),
    route({ hostname: 'b.cefis.cloud', backendName: 'b', dnsAddress: undefined, tlsMode: 'passthrough', problems: ['dns_missing'], backend: { enabled: true, servers: [{ name: 'x', address: '10.9.9.9', port: 8080, health: 'up' }] } }),
  ];
  assert.deepEqual(r.filterRoutes(list, { query: ' 10.9.9.9:8080 ', filter: 'all' }).map((x) => x.hostname), ['b.cefis.cloud']);
  assert.equal(r.filterRoutes(list, { query: 'APP_POOL' }).length, 1);
  assert.equal(r.filterRoutes(list, { query: '10.0.0.1' }).length, 1);
  assert.equal(r.filterRoutes(list, { filter: 'problems' }).length, 1);
  assert.equal(r.filterRoutes(list, { filter: 'firewall' }).length, 1);
  assert.equal(r.filterRoutes(list, { filter: 'passthrough' })[0].hostname, 'b.cefis.cloud');
  assert.deepEqual(r.routeCounts(list), { all: 2, problems: 1, firewall: 1, passthrough: 1 });
});

test('routeStats', () => {
  const list = [route({ certificate: cert({ expiresAt: inDays(5) }) }), route({ hostname: 'z', backend: null, certificate: null, tlsMode: 'passthrough', problems: ['backend_missing'] })];
  assert.deepEqual(r.routeStats(list, NOW), { hostnames: 2, passthrough: 1, backends: 1, certs: 1, expiring: 1, problems: 1 });
});

test('routesView: admin, footer, loading and errors', () => {
  const list = [route(), route({ hostname: 'b.cefis.cloud', tlsMode: 'passthrough', certificate: null })];
  const v = r.routesView({ routes: list, query: 'b.cefis', filter: 'all', loadedAt: new Date(NOW).toISOString() }, { admin: true, now: NOW });
  assertNoNull(v);
  assert.equal(v.footer, '1 de 2 hostnames');
  assert.equal(v.header.newRoute, true);
  assert.equal(v.header.refresh, 'Lido agora');
  assert.equal(v.rows.length, 1);
  assert.equal(v.rows[0].open, 'route:open:b.cefis.cloud');
  assert.equal(v.rows[0].mode, 'Passthrough');
  assert.equal(v.stats[0].sub, '1 em passthrough');
  const viewer = r.routesView({ routes: list }, { admin: 'yes', now: NOW });
  assert.equal('newRoute' in viewer.header, false);
  assert.equal(viewer.header.refresh, 'Ler agora');
  const loading = r.routesView({ routes: null }, { admin: false, now: NOW });
  assertNoNull(loading);
  assert.equal(loading.empty, 'Lendo o OPNsense…');
  assert.equal(loading.stats[0].value, '…');
  const failed = r.routesView({ routes: null, error: 'boom' }, { admin: false, now: NOW });
  assert.equal(failed.empty, 'Não foi possível ler as rotas do OPNsense.');
  assert.equal(failed.stats[0].value, '–');
  assert.equal(r.routesView({ routes: [], query: 'x' }, { now: NOW }).empty, 'Nenhuma rota encontrada.');
});

const hasButton = (blocks) => JSON.stringify(blocks).includes('Remover rota');

test('admin drawer has Remover rota; viewer drawer does not', () => {
  const a = r.drawerBlocks(route(), { admin: true, now: NOW });
  assertNoNull(a);
  assert.ok(hasButton(a));
  assert.ok(JSON.stringify(a).includes('route:remove:app.cefis.cloud'));
  assert.ok(JSON.stringify(a).includes('Editar rota: no OPNsense, por enquanto'));
  assert.ok(JSON.stringify(a).includes('CERTIFICADO'));
  const v = r.drawerBlocks(route({ backend: null, certificate: null, dnsAddress: null, problems: ['backend_missing'] }), { admin: false, now: NOW });
  assertNoNull(v);
  assert.equal(hasButton(v), false);
  assert.ok(JSON.stringify(v).includes('Nenhum certificado cobre este hostname.'));
  assert.equal(hasButton(r.drawerBlocks(route(), { admin: 'true', now: NOW })), false);
  const p = r.drawerBlocks(route({ tlsMode: 'passthrough', certificate: null }), { admin: false, now: NOW });
  assert.equal(JSON.stringify(p).includes('CERTIFICADO'), false);
  assert.ok(JSON.stringify(p).includes('PASSTHROUGH_DOMAINS_mapfile'));
});

const form = (o = {}) => ({ hostname: 'App.Cefis.Cloud ', tlsMode: 'firewall', access: 'both', servers: [{ address: ' 10.0.0.5 ', port: '3000' }], healthCheck: 'tcp-check', createDnsOverride: true, ...o });

test('HOSTNAME / IPV4 / ACCESS', () => {
  assert.equal(r.HOSTNAME.test('abc'), false);
  assert.equal(r.HOSTNAME.test('app.cefis.cloud'), true);
  assert.equal(r.IPV4.test('256.1.1.1'), false);
  assert.equal(r.IPV4.test('192.168.100.57'), true);
  assert.deepEqual(r.ACCESS.both, ['internal', 'public']);
});

test('validateRoute messages', () => {
  assert.deepEqual(r.validateRoute(form()), []);
  assert.deepEqual(r.validateRoute(form({ hostname: 'abc' })), ['Hostname inválido: domínio completo, ex: app.cefis.cloud.']);
  assert.deepEqual(r.validateRoute(form({ servers: [{ address: '10.0.0.5', port: '0' }] })), ['Servidor 1: porta de 1 a 65535.']);
  assert.deepEqual(r.validateRoute(form({ servers: [{ address: '10.0.0.5', port: '65536' }] })), ['Servidor 1: porta de 1 a 65535.']);
  assert.deepEqual(r.validateRoute(form({ servers: [{ address: '10.0.0.5', port: '' }] })), ['Servidor 1: porta de 1 a 65535.']);
  assert.deepEqual(
    r.validateRoute(form({ servers: [{ address: '10.0.0.5', port: '80' }, { address: 'x', port: 'abc' }] })),
    ['Servidor 2: IP inválido.', 'Servidor 2: porta de 1 a 65535.'],
  );
});

test('routeBody', () => {
  assert.deepEqual(r.routeBody(form()), {
    hostname: 'app.cefis.cloud', tlsMode: 'firewall', access: ['internal', 'public'],
    servers: [{ address: '10.0.0.5', port: 3000 }], healthCheck: 'tcp-check', createDnsOverride: true,
  });
  const p = r.routeBody(form({ tlsMode: 'passthrough', createDnsOverride: false }));
  assert.deepEqual(p.access, []);
  assert.equal(p.createDnsOverride, false);
  assert.equal(typeof p.servers[0].port, 'number');
  assert.deepEqual(r.routeBody(form({ access: 'public' })).access, ['public']);
  assert.deepEqual(r.routeBody(form({ access: undefined })).access, ['internal']);
});

test('pickHealthCheck', () => {
  assert.equal(r.pickHealthCheck(['http', 'tcp-check']), 'tcp-check');
  assert.equal(r.pickHealthCheck(['http', 'ssl']), 'http');
  assert.equal(r.pickHealthCheck([]), 'tcp-check');
  assert.equal(r.pickHealthCheck(['http', 'ssl'], 'ssl'), 'ssl');
});

test('addServer copies previous port; removeServer keeps one', () => {
  const s = [{ address: '1.1.1.1', port: '3000' }];
  const a = r.addServer(s);
  assert.deepEqual(a, [s[0], { address: '', port: '3000' }]);
  assert.equal(s.length, 1);
  assert.equal(r.removeServer(a, 0).length, 1);
  assert.deepEqual(r.removeServer(s, 0), s);
  assert.deepEqual(r.addServer([]), [{ address: '', port: '' }]);
});

test('labels', () => {
  assert.deepEqual(r.CHANGE_LABEL.dns_override, ['Host override', 'Unbound']);
  assert.deepEqual(r.CHANGE_LABEL.certificate, ['Certificado', 'ACME']);
  assert.equal(r.STEP_LABEL.certificate, "Emitir certificado (Let's Encrypt)");
  assert.equal(Object.keys(r.STEP_LABEL).length, 18);
  assert.equal(Object.keys(r.CHANGE_LABEL).length, 7);
});

test('jobTitle and visibleSteps', () => {
  assert.equal(r.jobTitle({ kind: 'create', status: 'rolled_back' }), 'Falhou e foi desfeita');
  assert.equal(r.jobTitle({ kind: 'remove', status: 'done' }), 'Rota removida');
  assert.equal(r.jobTitle({ kind: 'create', status: 'running' }), 'Aplicando');
  assert.equal(r.jobTitle({ kind: 'remove', status: 'failed' }), 'Falhou, e o rollback ficou incompleto');
  const steps = r.visibleSteps({ steps: [
    { step: 'certificate', status: 'done', detail: null },
    { step: 'servers', status: 'skipped', detail: null },
    { step: 'verify', status: 'failed', detail: 'timeout' },
  ] });
  assertNoNull(steps);
  assert.deepEqual(steps.map((s) => s.step), ['certificate', 'verify']);
  assert.equal(steps[0].label, "Emitir certificado (Let's Encrypt)");
  assert.equal(steps[0].detail, '');
  assert.equal(steps[1].tone, 'red');
});

test('jobNext', () => {
  const running = { status: 'running' };
  assert.equal(r.jobNext(running, { status: 404, message: 'x' }), 'lost');
  assert.equal(r.jobNext(running, { status: 500 }), 'poll');
  assert.equal(r.jobNext(running, new Error('network')), 'poll');
  assert.equal(r.jobNext(running), 'poll');
  assert.equal(r.jobNext({ status: 'done' }), 'done');
  assert.equal(r.jobNext({ status: 'rolled_back' }, null), 'done');
  assert.equal(r.LOST_TEXT('Job não encontrado.'), 'Perdi o acompanhamento: Job não encontrado. Confira o resultado na Auditoria e na lista de rotas.');
});
