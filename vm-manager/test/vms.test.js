'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertNoNull } = require('./helpers');
const vms = require('../lib/vms');

const H = 3600 * 1000;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (hours) => new Date(NOW - hours * H).toISOString();

function vm(over = {}) {
  return {
    vmid: 177, name: 'jibri-1', node: 'pve1', status: 'running', isTemplate: false,
    cores: 2, memoryMiB: 4096, diskGiB: 40, uptimeSeconds: 90000,
    ipConfigured: '192.168.100.80', ipDetected: null, tags: ['prod'],
    cpuUsagePct: 12.4, memUsedMiB: 2048, diskUsedGiB: 10, haState: 'started', pool: null,
    backupSlot: '02:00', lastBackupAt: ago(10), backupKnown: true, memFromGuest: true,
    ...over,
  };
}

test('backup states and texts', () => {
  const c = (o) => vms.backupCell(vm(o), NOW);
  assert.equal(c({ backupKnown: false }).text, 'PBS indisponível');
  assert.equal(c({ lastBackupAt: null }).text, 'nenhum ainda');
  assert.equal(c({ lastBackupAt: null, backupSlot: null }).text, 'sem backup');
  assert.equal(c({}).text, 'há 10h');
  assert.equal(c({}).tooltip, 'Job diário das 02:00');
  assert.equal(c({ lastBackupAt: ago(40) }).text, 'há 40h · atrasado');
  assert.equal(c({ backupSlot: null, lastBackupAt: ago(72) }).text, 'há 3 dias · fora do job');
  assert.equal(vms.backupState(vm({}), NOW), 'ok');
  for (const o of [{ backupKnown: false }, {}, { lastBackupAt: null }]) assertNoNull(c(o));
});

test('filters and search', () => {
  const list = [
    vm(),
    vm({ vmid: 2, name: 'db', node: 'pve2', status: 'stopped', ipConfigured: null, ipDetected: '10.0.0.5', tags: ['Staging'], lastBackupAt: ago(72) }),
    vm({ vmid: 3, name: 'x', backupKnown: false }),
  ];
  assert.deepEqual(vms.counts(list, NOW), { all: 3, running: 2, stopped: 1, backup: 1 });
  const f = (query, filter = 'all') => vms.filterVms(list, { query, filter }, NOW).map((v) => v.vmid);
  assert.deepEqual(f('JIBRI'), [177]);
  assert.deepEqual(f('pve2'), [2]);
  assert.deepEqual(f('177'), [177]);
  assert.deepEqual(f('10.0.0'), [2]);
  assert.deepEqual(f('stag'), [2]);
  assert.deepEqual(f('', 'stopped'), [2]);
  assert.deepEqual(f('', 'running'), [177, 3]);
  assert.deepEqual(f('', 'backup'), [2]);
  assert.deepEqual(f('  '), [177, 2, 3]);
});

test('viewer rows have no actions', () => {
  const v = vms.vmsView({ vms: [vm()], loading: false, error: '', query: '', filter: 'all', busy: {} }, { admin: false, now: NOW });
  assertNoNull(v);
  assert.equal('actions' in v.rows[0], false);
  assert.equal(v.header.readOnly, true);
  const n = vms.vmsView({ vms: [vm()] }, { admin: undefined, now: NOW });
  assert.equal('actions' in n.rows[0], false);
});

test('admin row menu hides backup when backupSlot and ha when haState', () => {
  const ids = (o) => vms.vmsView({ vms: [vm(o)] }, { admin: true, now: NOW }).rows[0].actions.menu.map((m) => m.id);
  assert.deepEqual(ids({}), ['details', 'destroy']);
  assert.deepEqual(ids({ backupSlot: null, haState: null }), ['details', 'backup', 'ha', 'destroy']);
  const v = vms.vmsView({ vms: [vm(), vm({ vmid: 9, status: 'stopped' })] }, { admin: true, now: NOW });
  assertNoNull(v);
  assert.equal(v.rows[0].actions.primary.id, 'stop');
  assert.equal(v.rows[1].actions.primary.id, 'start');
  assert.equal(v.header.readOnly, false);
});

test('ram cell without guest data, stopped vm, busy and empty states', () => {
  const v = vms.vmsView({ vms: [vm({ memFromGuest: false }), vm({ vmid: 5, status: 'stopped' })], busy: { 177: 'stop' } }, { admin: true, now: NOW });
  assertNoNull(v);
  assert.equal(v.rows[0].ram.text, 'sem dado do guest');
  assert.equal(v.rows[0].busy, true);
  assert.equal(v.rows[0].busyLabel, 'Aguarde…');
  assert.equal(v.rows[1].cpu.text, '');
  assert.equal(v.rows[1].ram.text, '');
  assert.equal(v.rows[1].uptime, 'parada');
  assert.equal(v.rows[0].sub, '2 vCPU, 4 GB, 40 GB');
  assert.equal(v.rows[0].cpu.text, '12%');
  assert.equal(vms.vmsView({ vms: [], loading: true }, { admin: false, now: NOW }).empty, 'Carregando VMs…');
  assert.equal(vms.vmsView({ vms: [], loading: false }, { admin: false, now: NOW }).empty, 'Nenhuma VM encontrada.');
  assert.equal(vms.vmsView({ vms: [vm()], error: 'jibri-1: x' }, { admin: false, now: NOW }).error, 'jibri-1: x');
  const f = vms.vmsView({ vms: [vm()] }, { admin: false, now: NOW }).filters;
  assert.equal(f[3].label, 'Backup a revisar · 0');
});

test('ha cell', () => {
  assert.deepEqual(vms.haCell('started'), { text: 'HA', tone: 'green' });
  assert.deepEqual(vms.haCell('fence'), { text: 'HA fence', tone: 'red' });
  assert.deepEqual(vms.haCell('stopped'), { text: 'HA stopped', tone: 'dim' });
  assert.deepEqual(vms.haCell(null), { text: '–', tone: 'dim' });
});

test('overview with ipam null', () => {
  const ov = {
    nodes: { online: 3, total: 4, cpuUsagePct: 20, memUsedGiB: 50, memTotalGiB: 100 },
    vms: { total: 5, running: 3, stopped: 2 },
    storages: [{ storage: 'ceph-vm', type: 'rbd', usedGiB: 1024, totalGiB: 4096, usedPct: 25 }, { storage: 'local', type: 'dir', usedGiB: 1, totalGiB: 2, usedPct: 50 }],
    ipam: null,
  };
  const v = vms.overviewView(ov);
  assertNoNull(v);
  assert.equal(v.ipam.text, 'NetBox indisponível');
  assert.equal(v.ipam.available, false);
  assert.equal(v.cluster.aside, '3 de 4 nodes');
  assert.equal(v.cluster.lines[1].value, '50/100 GB');
  assert.equal(v.ceph.length, 1);
  assert.equal(v.ceph[0].value, '1,0/4,0 TB');
  const ok = vms.overviewView({ ...ov, ipam: { prefix: '192.168.100.0/24', size: 254, used: 54, free: 200, usedPct: 21 } });
  assertNoNull(ok);
  assert.equal(ok.ipam.text, '200 IPs livres');
  assert.equal(ok.ipam.detail, '54 de 254 em uso');
  assertNoNull(vms.overviewView(null));
});

test('detail blocks with netbox null and null fields', () => {
  const detail = {
    vm: vm({ status: 'stopped', diskUsedGiB: null, haState: null, ipConfigured: null, tags: [] }),
    proxmox: {
      vcpus: 2, cores: 2, sockets: 1, cpuType: null, memoryProvisionedMiB: 4096, balloonMinMiB: null,
      memUsedMiB: null, memSource: null, osType: null, machine: null, boot: null, agentEnabled: false,
      disks: [{ slot: 'scsi0', storage: 'ceph', sizeGiB: null }],
      networks: [{ name: 'net0', model: 'virtio', bridge: 'vmbr0', macAddress: 'AA', vlan: 10, firewall: true }],
    },
    netbox: null,
  };
  const blocks = vms.detailBlocks(detail);
  assertNoNull(blocks);
  const s = JSON.stringify(blocks);
  assert.deepEqual(blocks.map((b) => b.title), ['Provisionamento', 'Uso ao vivo', 'Rede', 'NetBox']);
  assert.match(s, /Não registrada no NetBox\./);
  assert.match(s, /sem dado/);
  assert.match(s, /2 \(2 cores × 1 socket\)/);
  assert.match(s, /\? GB em ceph/);
  assert.match(s, /virtio, vmbr0, vlan 10, fw, AA/);
  assert.match(s, /VM desligada/);
  assert.match(s, /sem dado do guest/);
  assert.doesNotMatch(s, /Balloon/);
  const full = vms.detailBlocks({
    ...detail,
    vm: vm({ diskUsedGiB: 8 }),
    proxmox: { ...detail.proxmox, sockets: 2, balloonMinMiB: 1024, memUsedMiB: 2048, memSource: 'guest' },
    netbox: { id: 1, url: 'https://nb/1', role: 'web', tenant: null, platform: null, status: 'active', description: null, ips: ['1.1.1.1/24'], interfaces: [{ name: 'eth0', mac: null }] },
  });
  assertNoNull(full);
  const f = JSON.stringify(full);
  assert.match(f, /sockets/);
  assert.match(f, /Balloon mín\./);
  assert.match(f, /2 \/ 4 GB/);
  assert.match(f, /sem MAC/);
  assert.match(f, /Abrir no NetBox/);
});

test('busy ignores second action on same vm', async () => {
  const busy = vms.createBusy();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = busy.run(177, 'stop', async () => { calls++; await gate; });
  assert.equal(busy.get(177), 'stop');
  const second = await busy.run(177, 'start', async () => { calls++; });
  assert.deepEqual(second, { ran: false });
  release();
  assert.deepEqual(await first, { ran: true });
  assert.equal(calls, 1);
  assert.equal(busy.get(177), undefined);
});

test('busy error message is "{name}: {message}"', async () => {
  const busy = vms.createBusy();
  const r = await busy.run(1, 'stop', async () => { throw new Error('boom'); }, { name: 'jibri-1' });
  assert.deepEqual(r, { ran: true, error: 'jibri-1: boom' });
  assert.equal(busy.get(1), undefined);
  const r2 = await busy.run(1, 'stop', async () => { throw new Error('boom'); });
  assert.equal(r2.error, 'boom');
});
