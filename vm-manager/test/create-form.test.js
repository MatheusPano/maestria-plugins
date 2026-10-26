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

// --- Task 8: a janela "Nova VM" em blocos ---

const OPTIONS = { nodes: [{ value: 'pve1', label: 'pve1' }], storages: [{ value: 'ceph', label: 'ceph' }], templates: [{ value: 'ubuntu', label: 'ubuntu' }] };
const view = (over = {}) => ({
  phase: 'idle', form: ok({ node: 'pve1', storage: 'ceph', template: 'ubuntu' }), options: OPTIONS, bridge: 'vmbr0',
  loading: false, loadError: '', ip: { auto: { cidr: '192.168.100.80/24', loading: false }, check: null, suggestEmpty: false, suggestError: '' },
  errors: [], flowError: '', result: null, name: 'jibri-1', message: '', ...over,
});
const find = (blocks, pred) => {
  const out = [];
  const walk = (bs) => bs.forEach((b) => { if (pred(b)) out.push(b); if (b.children) walk(b.children); });
  walk(blocks);
  return out;
};
const texts = (blocks) => find(blocks, (b) => b.type === 'text').map((b) => b.text);
const byId = (blocks, id) => find(blocks, (b) => b.id === id)[0];
const button = (blocks, action) => find(blocks, (b) => b.type === 'button' && b.action === action)[0];

test('form blocks: loading and load error', () => {
  assert.deepEqual(cf.createBlocks(view({ loading: true })), [{ type: 'text', style: 'dim', text: 'Carregando…' }]);
  const e = cf.createBlocks(view({ loadError: 'catálogo fora' }));
  assert.deepEqual(e, [{ type: 'text', style: 'error', text: 'catálogo fora' }]);
});

test('form blocks: auto ip, fields, selects, checkboxes, bridge and button', () => {
  const b = cf.createBlocks(view());
  assertNoNull(b);
  assert.equal(byId(b, 'name').value, 'jibri-1');
  const ipAuto = byId(b, 'ipAuto');
  assert.deepEqual([ipAuto.type, ipAuto.label, ipAuto.value, ipAuto.action], ['checkbox', 'automático (NetBox)', true, 'create:ipmode']);
  assert.ok(texts(b).includes('192.168.100.80/24'));
  assert.ok(button(b, 'create:nextfree'));
  assert.equal(button(b, 'create:nextfree').label, 'atualizar');
  assert.equal(byId(b, 'ipCidr'), undefined);
  assert.equal(byId(b, 'gateway').value, '192.168.100.1');
  assert.equal(byId(b, 'cores').value, '2');
  assert.equal(byId(b, 'memory').value, '4096');
  assert.equal(byId(b, 'diskGiB').value, '40');
  for (const [id, v] of [['node', 'pve1'], ['storage', 'ceph'], ['template', 'ubuntu']]) {
    assert.equal(byId(b, id).type, 'select');
    assert.equal(byId(b, id).value, v);
    assert.deepEqual(byId(b, id).options, OPTIONS[`${id}s`]);
  }
  assert.equal(byId(b, 'sshKeys').multiline, true);
  assert.equal(byId(b, 'startAfterCreate').label, 'Ligar a VM após criar');
  assert.equal(byId(b, 'backup').label, 'Backup diário no PBS (entra no horário com menos VMs)');
  assert.equal(byId(b, 'ha').label, 'Alta disponibilidade (HA do cluster)');
  assert.ok(texts(b).includes('Bridge vmbr0'));
  const submit = button(b, 'create:submit');
  assert.deepEqual([submit.label, submit.style, !!submit.disabled], ['Criar VM', 'primary', false]);
});

test('form blocks: auto ip loading / none', () => {
  assert.ok(texts(cf.createBlocks(view({ ip: { auto: { cidr: '', loading: true }, check: null } }))).includes('buscando…'));
  assert.ok(texts(cf.createBlocks(view({ ip: { auto: { cidr: '', loading: false }, check: null } }))).includes('sem IP livre / NetBox off'));
});

test('form blocks: manual ip with check, hint and empty suggestion', () => {
  const form = ok({ ipAuto: false, ipCidr: '192.168.100.90/24' });
  const b = cf.createBlocks(view({ form, ip: { auto: { cidr: '', loading: false }, check: { available: true, skipped: false, managedPrefix: '192.168.100.0/24' }, suggestEmpty: true } }));
  assertNoNull(b);
  assert.equal(byId(b, 'ipCidr').value, '192.168.100.90/24');
  assert.equal(button(b, 'create:check').label, 'verificar IP');
  assert.equal(button(b, 'create:suggest').label, 'sugerir IP livre');
  assert.ok(texts(b).includes('✓ Disponível no prefixo 192.168.100.0/24'));
  assert.ok(texts(b).includes('Nenhum IP livre encontrado no prefixo (ou NetBox desligado).'));
  assert.equal(button(b, 'create:nextfree'), undefined);
});

test('form blocks: errors joined in red, flow error on top', () => {
  const b = cf.createBlocks(view({ errors: ['Informe o nome.', 'vCPU entre 1 e 64.'], flowError: 'name inválido' }));
  const red = find(b, (x) => x.type === 'text' && x.style === 'error').map((x) => x.text);
  assert.deepEqual(red, ['name inválido', 'Informe o nome. · vCPU entre 1 e 64.']);
});

test('phase blocks: submitting, tracking, succeeded, unconfirmed', () => {
  const s = cf.createBlocks(view({ phase: 'submitting' }));
  const btn = button(s, 'create:submit');
  assert.deepEqual([btn.label, btn.disabled], ['Provisionando…', true]);
  assert.ok(texts(s).includes('Clonando, configurando e ligando. Leva cerca de 1 minuto.'));
  assert.ok(!texts(s).includes('Bridge vmbr0'));

  const t = cf.createBlocks(view({ phase: 'tracking' }));
  assertNoNull(t);
  assert.ok(texts(t).includes('criando… (acompanhando)'));
  assert.equal(find(t, (x) => x.type === 'button').length, 0);

  const ok2 = cf.createBlocks(view({ phase: 'succeeded', result: { vm: { name: 'jibri-1', vmid: 177, node: 'pve1', ipConfigured: '1.2.3.4/24' }, netbox: { id: 3, url: 'https://nb/3' }, backupSlot: '02:00', ha: true, warnings: ['x'] } }));
  assertNoNull(ok2);
  assert.ok(find(ok2, (x) => x.type === 'heading' && x.text === 'VM criada 🎉').length);
  assert.ok(JSON.stringify(ok2).includes('registrado (#3)'));
  assert.ok(texts(ok2).includes('⚠ x'));
  assert.equal(button(ok2, 'create:done').label, 'Ver todas as VMs');
  assertNoNull(cf.createBlocks(view({ phase: 'succeeded', result: null })));

  const u = cf.createBlocks(view({ phase: 'unconfirmed', message: 'não deu pra confirmar — confira a lista antes de tentar de novo' }));
  assert.ok(texts(u).includes('não deu pra confirmar — confira a lista antes de tentar de novo'));
  assert.equal(button(u, 'create:back').label, 'voltar ao formulário');
});
