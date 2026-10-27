'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { visiblePools, defaultPool, healthTone, cephView } = require('../lib/storage');
const { assertNoNull } = require('./helpers');

const pool = (name, applications, extra = {}) => ({
  name, applications, proxmoxStorages: [], objects: 1234, usedPct: 10, storedBytes: 100, availBytes: 900, ...extra,
});

const POOLS = [
  pool('rbd-a', ['rbd'], { storedBytes: 5, proxmoxStorages: ['ceph-a'] }),
  pool('rbd-b', ['rbd'], { storedBytes: 50, usedPct: 80 }),
  pool('.mgr', ['mgr']),
  pool('default.rgw.log', ['rgw']),
  pool('default.rgw.buckets.data', ['rgw']),
  pool('cephfs_data', ['cephfs']),
  pool('cephfs_metadata', ['cephfs']),
];

test('pool filter keeps rbd, buckets.data rgw, non-metadata cephfs', () => {
  assert.deepEqual(visiblePools(POOLS).map((p) => p.name), ['rbd-a', 'rbd-b', 'default.rgw.buckets.data', 'cephfs_data']);
});

test('defaultPool picks largest rbd', () => {
  assert.equal(defaultPool(POOLS), 'rbd-b');
  assert.equal(defaultPool([pool('x', ['rgw'])]), '');
  assert.equal(defaultPool([]), '');
});

test('healthTone', () => {
  assert.equal(healthTone('HEALTH_OK'), 'green');
  assert.equal(healthTone('HEALTH_WARN'), 'yellow');
  assert.equal(healthTone('HEALTH_ERR'), 'red');
});

test('non-rbd pool is not selectable; selected and subline', () => {
  const v = cephView({ health: 'HEALTH_OK', pools: POOLS, selected: 'rbd-b', images: [], imagesQuery: '', trash: [], loadingImages: false, trashError: '' });
  assertNoNull(v);
  const by = Object.fromEntries(v.pools.map((p) => [p.name, p]));
  assert.equal(by['rbd-b'].selectable, true);
  assert.equal(by['rbd-b'].selected, true);
  assert.equal(by['rbd-b'].tone, 'yellow');
  assert.equal(by['rbd-a'].tone, 'accent');
  assert.equal(by['rbd-a'].sub, 'Proxmox: ceph-a');
  assert.equal(by['default.rgw.buckets.data'].selectable, false);
  assert.equal(by['default.rgw.buckets.data'].sub, 'Buckets (RGW)');
  assert.equal(by['cephfs_data'].sub, 'CephFS');
  assert.equal(by['rbd-a'].usage, '5 B de 905 B');
  assert.equal(by['rbd-a'].objects, '1.234 obj');
  assert.equal(v.header.tone, 'green');
  assert.equal(v.images.title, 'Imagens em rbd-b');
});

const IMAGES = [
  { name: 'vm-100-disk-0', vmName: 'web', vmid: 100, removing: false, sizeBytes: 1000, usedBytes: 800, snapshots: 2 },
  { name: 'vm-200-disk-0', vmid: 200, removing: false, sizeBytes: 1000, snapshots: 0 },
  { name: 'vm-300-disk-0', vmName: 'x', vmid: 300, removing: true, sizeBytes: 1000, usedBytes: 10, snapshots: 0 },
];
const view = (extra) => cephView({ health: '', pools: POOLS, selected: 'rbd-b', images: IMAGES, imagesQuery: '', trash: null, loadingImages: false, trashError: '', ...extra });

test("image removing -> 'remoção interrompida' red", () => {
  const v = view();
  assertNoNull(v);
  const r = v.images.rows[2];
  assert.equal(r.vm, 'remoção interrompida');
  assert.equal(r.vmTone, 'red');
  assert.equal(r.rowTone, 'red');
  assert.equal(v.images.rows[0].vm, 'web');
  assert.equal(v.images.rows[0].vmid, '100');
  assert.equal(v.images.rows[0].usedTone, 'yellow');
  assert.equal(v.images.count, 3);
});

test("vmid without vmName -> 'sem VM'; no usedBytes -> 'sem dado'", () => {
  const r = view().images.rows[1];
  assert.equal(r.vm, 'sem VM');
  assert.equal(r.vmTone, 'yellow');
  assert.equal(r.used, 'sem dado');
  assert.equal(r.hasUsed, false);
});

test('image search matches vmid, vmName and name', () => {
  assert.deepEqual(view({ imagesQuery: ' 200 ' }).images.rows.map((r) => r.name), ['vm-200-disk-0']);
  assert.deepEqual(view({ imagesQuery: 'WEB' }).images.rows.map((r) => r.name), ['vm-100-disk-0']);
  const none = view({ imagesQuery: 'zzz' });
  assert.equal(none.images.empty, 'Nenhuma imagem encontrada.');
});

test('images loading and trash states', () => {
  const loading = view({ images: null, loadingImages: true });
  assertNoNull(loading);
  assert.equal(loading.images.empty, 'Lendo as imagens do pool, pode levar alguns segundos…');
  assert.equal(loading.trash.visible, false);
  const t = view({ trash: [], trashError: 'falhou' });
  assert.equal(t.trash.empty, 'Lixeira vazia.');
  assert.equal(t.trash.error, 'Lixeira: falhou');
  const full = view({ trash: [{ id: '1', name: 'img', pool: 'p', source: 'REMOVING', deletedAt: '2026-01-05T12:00:00Z' }, { id: '2', name: 'b', pool: 'p', source: 'USER', deletedAt: '2026-01-06T12:00:00Z' }] });
  assertNoNull(full);
  assert.equal(full.trash.rows[0].tone, 'red');
  assert.equal(full.trash.rows[0].rowTone, 'red');
  assert.equal(full.trash.rows[1].tone, 'dim');
  assert.equal(full.trash.count, 2);
});

test('no selection and empty input produce a null-free view', () => {
  assertNoNull(cephView({}));
  assert.equal(cephView({}).images.visible, false);
});
