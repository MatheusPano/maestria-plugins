'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../lib/buckets');
const { assertNoNull } = require('./helpers');

const mk = (name, extra = {}) => ({ name, owner: 'o', objects: 1, usedBytes: 10, quotaBytes: null, createdAt: null, ...extra });
const names = (l) => l.map((b) => b.name);

test('sort default directions and nulls last', () => {
  assert.deepEqual(B.DEFAULT_DIR, { bucket: 'asc', owner: 'asc', objects: 'desc', used: 'desc', quota: 'desc', created: 'desc' });
  assert.deepEqual(B.nextSort({ key: 'bucket', dir: 'asc' }, 'objects'), { key: 'objects', dir: 'desc' });
  assert.deepEqual(B.nextSort({ key: 'objects', dir: 'desc' }, 'objects'), { key: 'objects', dir: 'asc' });
  const l = [mk('a', { createdAt: null }), mk('b', { createdAt: '2026-01-01T00:00:00Z' }), mk('c', { createdAt: '2026-02-01T00:00:00Z' })];
  assert.deepEqual(names(B.sortBuckets(l, 'created', 'desc')), ['c', 'b', 'a']);
  assert.deepEqual(names(B.sortBuckets(l, 'created', 'asc')), ['b', 'c', 'a']);
  assert.deepEqual(names(B.sortBuckets([mk('b10'), mk('b9')], 'bucket', 'asc')), ['b9', 'b10']);
  assert.deepEqual(names(B.sortBuckets([mk('a', { tenant: 'z' }), mk('b', { tenant: 'a' })], 'bucket', 'asc')), ['b', 'a']);
});

test('quota sorts by used/quota', () => {
  const l = [
    mk('half', { usedBytes: 50, quotaBytes: 100 }),
    mk('none'),
    mk('full', { usedBytes: 90, quotaBytes: 100 }),
    mk('big-low', { usedBytes: 500, quotaBytes: 10000 }),
  ];
  assert.deepEqual(names(B.sortBuckets(l, 'quota', 'desc')), ['full', 'half', 'big-low', 'none']);
  assert.deepEqual(names(B.sortBuckets(l, 'quota', 'asc')), ['big-low', 'half', 'full', 'none']);
});

test('stats counts distinct owners', () => {
  const s = B.stats([mk('a', { owner: 'x', objects: 2, usedBytes: 5 }), mk('b', { owner: 'x', objects: 3, usedBytes: 6 }), mk('c', { owner: 'y' })]);
  assert.deepEqual(s, { buckets: 3, used: 21, objects: 6, owners: 2 });
});

test('viewer view has no newBucket but has credentials', () => {
  const state = { buckets: [mk('a', { quotaBytes: 100, usedBytes: 80, createdAt: '2026-01-05T12:00:00Z' }), mk('b')], error: '', query: '', sort: { key: 'bucket', dir: 'asc' } };
  const viewer = B.bucketsView(state, { admin: false });
  assertNoNull(viewer);
  assert.equal('newBucket' in viewer.header, false);
  assert.equal(viewer.header.badge, 'Somente leitura');
  assert.ok(viewer.rows.every((r) => r.actions.includes('credentials')));
  assert.equal(viewer.rows[0].quota, '80% de 100 B');
  assert.equal(viewer.rows[0].tone, 'yellow');
  assert.equal(viewer.rows[1].quota, 'sem cota');
  assert.equal(B.bucketsView(state, {}).header.newBucket, undefined);
  assert.equal(B.bucketsView(state, { admin: 'true' }).header.newBucket, undefined);
  const admin = B.bucketsView(state, { admin: true });
  assertNoNull(admin);
  assert.equal(admin.header.newBucket, true);
  assert.equal(admin.columns[0].dir, 'asc');
});

test('bucketsView loading, error, empty, search', () => {
  const loading = B.bucketsView({ buckets: null, error: '', query: '', sort: { key: 'bucket', dir: 'asc' } }, { admin: true });
  assertNoNull(loading);
  assert.equal(loading.empty, 'Carregando buckets…');
  assert.equal(loading.stats[0].value, '…');
  const err = B.bucketsView({ buckets: null, error: 'x', query: '' }, { admin: true });
  assert.equal(err.empty, 'Não foi possível carregar os buckets.');
  assert.equal(err.stats[0].value, '–');
  const none = B.bucketsView({ buckets: [mk('a')], query: 'zz' }, { admin: true });
  assert.equal(none.empty, 'Nenhum bucket encontrado.');
  assert.equal(B.bucketsView({ buckets: [mk('a', { owner: 'Zed' })], query: ' zed ' }, { admin: true }).rows.length, 1);
});

test('bucketBody defaults newOwner to name', () => {
  assert.deepEqual(B.bucketBody({ name: ' Uplii-Media ', mode: 'new', owner: '', newOwner: '' }), { name: 'uplii-media', owner: 'uplii-media', newOwner: true });
  assert.deepEqual(B.bucketBody({ name: 'abc', mode: 'new', owner: 'x', newOwner: ' Foo ' }), { name: 'abc', owner: 'foo', newOwner: true });
  assert.deepEqual(B.bucketBody({ name: 'abc', mode: 'existing', owner: 'bob', newOwner: 'zzz' }), { name: 'abc', owner: 'bob', newOwner: false });
});

test('validation messages', () => {
  assert.deepEqual(B.validateBucket({ name: 'ab', mode: 'existing', owner: 'x' }, []), ['Minúsculas, números e hífen; de 3 a 63 caracteres.']);
  assert.deepEqual(B.validateBucket({ name: 'abc', mode: 'existing', owner: '' }, []), ['Escolha o usuário do RGW']);
  assert.deepEqual(B.validateBucket({ name: 'abc', mode: 'existing', owner: 'x' }, []), []);
  assert.deepEqual(B.validateBucket({ name: 'abc', mode: 'new', newOwner: '' }, ['abc']), ['Esse usuário já existe; escolha em Usuário existente.']);
  assert.deepEqual(B.validateBucket({ name: 'abc', mode: 'new', newOwner: 'a!' }, []), ['Usuário novo: minúsculas, números, _ e hífen; de 3 a 64 caracteres.']);
  assert.deepEqual(B.validateBucket({ name: 'abc', mode: 'new', newOwner: 'a_b' }, []), []);
  assert.deepEqual(B.validateBucket({ name: '-abc', mode: 'new', newOwner: 'a_b' }, []), [B.validateBucket({ name: '-abc', mode: 'existing', owner: 'x' }, [])[0]]);
});

test('taken new owner rejected with exact message', () => {
  assert.deepEqual(B.validateBucket({ name: 'uplii', mode: 'new', newOwner: ' UPLII ' }, ['uplii']), ['Esse usuário já existe; escolha em Usuário existente.']);
});

test("profileName('up.lii') === 'up-lii'", () => {
  assert.equal(B.profileName('up.lii'), 'up-lii');
  assert.equal(B.profileName('Up_lii-1'), 'Up_lii-1');
});

const C = { endpoint: 'https://s3.x', region: 'us', bucket: 'bk', accessKey: 'AK', owner: 'up.lii' };

test('env snippet without secret for viewer has no S3_SECRET_KEY line', () => {
  const t = B.snippet('env', C, null, { withSecret: false });
  assert.equal(t, 'S3_ENDPOINT=https://s3.x\nS3_REGION=us\nS3_BUCKET=bk\nS3_ACCESS_KEY=AK');
  assert.ok(!t.includes('S3_SECRET_KEY'));
});

test('secret placeholder and real secret', () => {
  assert.ok(B.snippet('env', C, null).endsWith('S3_SECRET_KEY=<secret key>'));
  assert.ok(B.snippet('env', C, 'SK').endsWith('S3_SECRET_KEY=SK'));
});

test('aws snippet with secret has aws_secret_access_key line', () => {
  assert.equal(
    B.snippet('aws', C, 'SK'),
    [
      'aws configure set aws_access_key_id AK --profile up-lii',
      'aws configure set aws_secret_access_key SK --profile up-lii',
      'aws configure set region us --profile up-lii',
      'aws --profile up-lii --endpoint-url https://s3.x s3 ls s3://bk',
    ].join('\n'),
  );
  assert.ok(!B.snippet('aws', C, 'SK', { withSecret: false }).includes('secret'));
});

test('rclone snippet has provider = Ceph', () => {
  const t = B.snippet('rclone', C, 'SK');
  assert.ok(t.startsWith('[up-lii]\ntype = s3\nprovider = Ceph\n'));
  assert.ok(t.endsWith('secret_access_key = SK'));
  assert.ok(!B.snippet('rclone', C, null, { withSecret: false }).includes('secret_access_key'));
});

test('MASK is 40 bullets; regexes', () => {
  assert.equal(B.MASK, '•'.repeat(40));
  assert.ok(B.BUCKET_NAME.test('uplii-media'));
  assert.ok(!B.BUCKET_NAME.test('Uplii'));
  assert.ok(B.NEW_OWNER.test('up_lii'));
});
