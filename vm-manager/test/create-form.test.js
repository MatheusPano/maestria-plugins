'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertNoNull } = require('./helpers');
const cf = require('../lib/create-form');

const ok = (over = {}) => ({ ...cf.initialForm(), name: 'jibri-1', gateway: '192.168.100.1', ...over });
const auto = { auto: { cidr: '192.168.100.80/24' }, manual: null };

test('initial form and defaults', () => {
  const f = cf.initialForm();
  assert.deepEqual(f, {
    name: '', ipCidr: '', gateway: '', cores: 2, memory: 4096, diskGiB: 40, node: '', template: '', storage: '',
    sshKeys: '', startAfterCreate: true, backup: true, ha: true, ipAuto: true,
  });
  const d = cf.applyDefaults(f, { gateway: '10.0.0.1', cores: 4, memory: 8192, diskGiB: 80, node: 'pve1', template: 't', storage: 's', networkBridge: 'vmbr0' });
  assert.equal(d.gateway, '10.0.0.1');
  assert.equal(d.cores, 4);
  assert.equal(d.name, '');
  assert.equal(f.cores, 2);
  assertNoNull(d);
});

test('options from catalog', () => {
  const o = cf.optionsFrom({
    nodes: [{ name: 'a', status: 'online' }, { name: 'b', status: 'offline' }],
    storages: [{ name: 'ceph', type: 'rbd', supportsImages: true }, { name: 'r2', type: 'rbd', supportsImages: false }, { name: 'l', type: 'dir', supportsImages: true }],
    templates: [{ vmid: 9000, name: 'ubuntu', node: 'a' }],
  });
  assertNoNull(o);
  assert.deepEqual(o.nodes.map((x) => x.value), ['a']);
  assert.deepEqual(o.storages.map((x) => x.value), ['ceph']);
  assert.deepEqual(o.templates, [{ value: 'ubuntu', label: 'ubuntu' }]);
  assertNoNull(cf.optionsFrom({}));
});

test('regexes', () => {
  assert.ok(cf.IPV4.test('192.168.100.1'));
  assert.ok(!cf.IPV4.test('192.168.100.256'));
  assert.ok(cf.IPV4_CIDR.test('192.168.100.80/24'));
  assert.ok(!cf.IPV4_CIDR.test('192.168.100.80'));
});

test('mergeValues keeps strings and booleans', () => {
  const m = cf.mergeValues(ok(), { name: 'x', cores: '8', backup: false, ipAuto: false, bogus: 'y' });
  assert.equal(m.name, 'x');
  assert.equal(m.cores, '8');
  assert.equal(m.backup, false);
  assert.equal(m.ipAuto, false);
  assert.equal('bogus' in m, false);
});

test('buildBody auto omits ipCidr and empty sshKeys', () => {
  const b = cf.buildBody(ok({ ipCidr: '1.1.1.1/24', sshKeys: '  \n ', name: ' jibri-1 ', gateway: ' 192.168.100.1 ' }));
  assert.equal('ipCidr' in b, false);
  assert.equal('sshKeys' in b, false);
  assert.equal(b.name, 'jibri-1');
  assert.equal(b.gateway, '192.168.100.1');
  assertNoNull(b);
  assert.deepEqual(Object.keys(b).sort(), ['backup', 'cores', 'diskGiB', 'gateway', 'ha', 'memory', 'name', 'node', 'startAfterCreate', 'storage', 'template']);
});

test('buildBody manual trims ipCidr', () => {
  const b = cf.buildBody(ok({ ipAuto: false, ipCidr: ' 192.168.100.80/24 ', sshKeys: ' ssh-ed25519 AAA \n' }));
  assert.equal(b.ipCidr, '192.168.100.80/24');
  assert.equal(b.sshKeys, 'ssh-ed25519 AAA');
});

test('numbers are numbers', () => {
  const b = cf.buildBody(ok({ cores: '4', memory: '2048', diskGiB: '50' }));
  assert.strictEqual(b.cores, 4);
  assert.strictEqual(b.memory, 2048);
  assert.strictEqual(b.diskGiB, 50);
});

test('validate', () => {
  assert.deepEqual(cf.validate(ok(), auto), []);
  assert.deepEqual(cf.validate(ok({ name: '  ' }), auto), ['Informe o nome.']);
  assert.deepEqual(cf.validate(ok({ gateway: '192.168.1' }), auto), ['Gateway deve ser um IPv4, ex: 192.168.100.1.']);
  assert.deepEqual(cf.validate(ok({ ipAuto: false, ipCidr: '1.2.3.4' }), { auto: { cidr: null }, manual: null }), ['IP / CIDR deve ser um IPv4 com CIDR, ex: 192.168.100.80/24.']);
  assert.deepEqual(
    cf.validate(ok({ ipAuto: false, ipCidr: '192.168.100.80/24' }), { auto: { cidr: null }, manual: { available: false, skipped: false, reason: 'em uso' } }),
    ['IP indisponível: em uso'],
  );
  assert.deepEqual(
    cf.validate(ok({ ipAuto: false, ipCidr: '192.168.100.80/24' }), { auto: { cidr: null }, manual: { available: false, skipped: true, reason: null } }),
    [],
  );
  assert.deepEqual(cf.validate(ok(), { auto: { cidr: null }, manual: null }), ['Sem IP livre no NetBox: desligue o automático e informe o IP.']);
  assert.deepEqual(cf.validate(ok(), undefined), ['Sem IP livre no NetBox: desligue o automático e informe o IP.']);
  assert.deepEqual(cf.validate(ok({ cores: 65 }), auto), ['vCPU entre 1 e 64.']);
  assert.deepEqual(cf.validate(ok({ cores: '0' }), auto), ['vCPU entre 1 e 64.']);
  assert.deepEqual(cf.validate(ok({ memory: 1000 }), auto), ['Memória: no mínimo 512 MiB, em passos de 512.']);
  assert.deepEqual(cf.validate(ok({ memory: '' }), auto), ['Memória: no mínimo 512 MiB, em passos de 512.']);
  assert.deepEqual(cf.validate(ok({ diskGiB: 3 }), auto), ['Disco: no mínimo 4 GiB.']);
  assert.equal(cf.validate(ok({ name: '', gateway: 'x', cores: 0, memory: 1, diskGiB: 1 }), auto).length, 5);
});

test('ipHint texts', () => {
  assert.deepEqual(cf.ipHint({ available: true, skipped: true, managedPrefix: null, reason: null }), { text: 'NetBox desligado, IP não verificado.', tone: 'yellow' });
  assert.deepEqual(cf.ipHint({ available: true, skipped: false, managedPrefix: '192.168.100.0/24', reason: null }), { text: '✓ Disponível no prefixo 192.168.100.0/24', tone: 'green' });
  assert.equal(cf.ipHint({ available: true, skipped: false, managedPrefix: null, reason: 'fora' }).text, '✓ Disponível (fora)');
  assert.deepEqual(cf.ipHint({ available: false, skipped: false, managedPrefix: null, reason: 'em uso' }), { text: '✕ Indisponível: em uso', tone: 'red' });
  assertNoNull(cf.ipHint(null));
  assertNoNull(cf.ipHint({ available: false, skipped: false, managedPrefix: null, reason: null }));
});

test('success blocks', () => {
  const r = { vm: { name: 'jibri-1', vmid: 177, node: 'pve1', ipConfigured: '192.168.100.80' }, netbox: { id: 12, url: 'https://nb/12' }, backupSlot: '02:00', ha: true, warnings: ['x'] };
  const b = cf.successBlocks(r);
  assertNoNull(b);
  const s = JSON.stringify(b);
  for (const t of ['VM criada 🎉', '#177', 'registrado (#12)', 'diário às 02:00', 'ativo', '⚠ x', '192.168.100.80', 'pve1']) assert.ok(s.includes(t), t);
  const bare = JSON.stringify(cf.successBlocks({ vm: { name: 'a', vmid: 1, node: 'n', ipConfigured: null }, netbox: null, backupSlot: null, ha: false, warnings: [] }));
  for (const t of ['sem IP', 'não registrado', 'fora do backup', 'fora do HA']) assert.ok(bare.includes(t), t);
  assertNoNull(cf.successBlocks({ vm: { name: 'a', vmid: 1, node: 'n', ipConfigured: null }, netbox: null, backupSlot: null, ha: false }));
});
