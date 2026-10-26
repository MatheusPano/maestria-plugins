'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { assertNoNull } = require('./helpers');
const admin = require('../lib/admin');

const NOW = Date.parse('2026-10-26T12:00:00Z');
const users = [
  { id: 1, email: 'ana@x.com', name: 'Ana', role: 'admin', lastSeenAt: '2026-10-26T11:58:00Z' },
  { id: 2, email: 'bia@x.com', name: null, role: 'pending', lastSeenAt: null },
  { id: 3, email: 'caio@x.com', name: 'Caio', role: 'viewer', lastSeenAt: null },
];

test('banner singular/plural/none', () => {
  assert.strictEqual(admin.pendingBanner(users), '1 pessoa aguardando aprovação');
  assert.strictEqual(admin.pendingBanner([...users, { id: 4, role: 'pending' }]), '2 pessoas aguardando aprovação');
  assert.strictEqual(admin.pendingBanner([users[0]]), '');
  assert.strictEqual(admin.pendingBanner(null), '');
});

test('own row cannot change role', () => {
  const rows = admin.usersView(users, { meId: 1, saving: new Set(), now: NOW });
  assertNoNull(rows);
  assert.strictEqual(rows[0].canChange, false);
  assert.strictEqual(rows[0].lockedTitle, 'Você não pode alterar o próprio papel');
  assert.strictEqual(rows[1].canChange, true);
  assert.strictEqual(rows[1].lockedTitle, '');
  assert.strictEqual(rows[0].roleLabel, 'Admin');
  assert.strictEqual(rows[0].lastSeen, 'agora');
  assert.strictEqual(rows[1].name, 'bia@x.com');
  assert.strictEqual(rows[1].lastSeen, 'nunca');
});

test('saving row locked', () => {
  const rows = admin.usersView(users, { meId: 1, saving: new Set([3]), now: NOW });
  assert.strictEqual(rows[2].canChange, false);
  assert.strictEqual(rows[2].lockedTitle, '');
  assert.strictEqual(rows[1].canChange, true);
});

test('approve only on pending', () => {
  const rows = admin.usersView(users, { meId: 1, saving: new Set(), now: NOW });
  assert.deepStrictEqual(rows.map((r) => r.approve), [false, true, false]);
  assert.strictEqual(rows[1].roleTone, 'yellow');
});

test('ACTION_LABEL has 14 entries', () => {
  assert.strictEqual(Object.keys(admin.ACTION_LABEL).length, 14);
  assert.strictEqual(admin.ACTION_LABEL['route.apply'], 'Criar rota no firewall');
});

test('auditQuery omits empty', () => {
  assert.strictEqual(admin.auditQuery({ page: 1, action: '', outcome: '', userId: 0 }), 'page=1');
  assert.strictEqual(
    admin.auditQuery({ page: 2, action: 'vm.create', outcome: 'failure', userId: 5 }),
    'page=2&action=vm.create&outcome=failure&userId=5',
  );
  assert.strictEqual(admin.auditQuery({}), 'page=1');
});

test('withFilter resets page and expanded', () => {
  const next = admin.withFilter({ page: 3, expanded: 'x', outcome: 'failure' }, 'action', 'vm.start');
  assert.deepStrictEqual(next, { page: 1, expanded: '', outcome: 'failure', action: 'vm.start' });
});

const pageRes = (over = {}, data) => ({
  data: data || [
    { id: 10, userId: 1, userEmail: 'ana@x.com', action: 'user.role.update', target: 'user:2', outcome: 'success', detail: { role: 'viewer' }, error: null, ip: '1.2.3.4', createdAt: '2026-10-26T12:00:00' },
    { id: 11, userId: null, userEmail: null, action: 'weird.new', target: null, outcome: 'failure', detail: null, error: 'boom', ip: null, createdAt: '2026-10-26T12:00:00' },
  ],
  pagination: { totalItems: 45, perPage: 20, currentPage: 2, lastPage: 3, ...over },
});

test('target user:<id> resolves email', () => {
  const v = admin.auditView(pageRes(), { users, filters: { page: 2 }, expanded: 10 });
  assertNoNull(v);
  assert.strictEqual(v.rows[0].target, 'bia@x.com');
  assert.strictEqual(v.rows[0].who, 'Ana');
  assert.strictEqual(v.rows[0].whoSub, 'ana@x.com');
  assert.strictEqual(v.rows[0].actionLabel, 'Mudar papel');
  assert.strictEqual(v.rows[0].outcomeTone, 'green');
  assert.strictEqual(v.rows[0].expanded, true);
  assert.strictEqual(v.rows[0].detail.json, JSON.stringify({ role: 'viewer' }, null, 2));
  assert.strictEqual(v.rows[0].detail.ip, '1.2.3.4');
  assert.strictEqual(v.rows[0].detail.error, '');
  assert.strictEqual(v.rows[1].expanded, false);
  assert.strictEqual(v.rows[1].target, '—');
  assert.strictEqual(v.rows[1].actionLabel, 'weird.new');
  assert.strictEqual(v.rows[1].detail.json, '');
  assert.strictEqual(v.rows[1].detail.ip, '—');
  assert.strictEqual(v.rows[1].detail.error, 'boom');
  assert.strictEqual(v.rows[1].outcomeTone, 'red');
});

test('who falls back to email then sem sessão', () => {
  const v = admin.auditView(pageRes(), { users, filters: {}, expanded: '' });
  assert.strictEqual(v.rows[1].who, 'sem sessão');
  assert.strictEqual(v.rows[1].whoSub, '');
  const w = admin.auditView(pageRes({}, [{ id: 1, userId: 99, userEmail: 'z@x.com', action: 'auth.login', target: 'user:77', outcome: 'success', createdAt: '2026-10-26T12:00:00' }]), { users, filters: {}, expanded: '' });
  assert.strictEqual(w.rows[0].who, 'z@x.com');
  assert.strictEqual(w.rows[0].whoSub, '');
  assert.strictEqual(w.rows[0].target, 'user:77');
  assertNoNull(w);
});

test('range for page 2 of 45 at 20/page is 21–40 de 45', () => {
  const v = admin.auditView(pageRes(), { users, filters: {}, expanded: '' });
  assert.strictEqual(v.range, '21–40 de 45');
  assert.strictEqual(v.count, '45 eventos');
  assert.strictEqual(v.page, '2 / 3');
  assert.strictEqual(v.prevDisabled, false);
  assert.strictEqual(v.nextDisabled, false);
});

test('next disabled on last page', () => {
  const v = admin.auditView(pageRes({ currentPage: 3 }), { users, filters: {}, expanded: '' });
  assert.strictEqual(v.range, '41–45 de 45');
  assert.strictEqual(v.nextDisabled, true);
  const f = admin.auditView(pageRes({ currentPage: 1 }), { users, filters: {}, expanded: '' });
  assert.strictEqual(f.prevDisabled, true);
});

test('empty and loading states', () => {
  const o = { users, filters: {}, expanded: '' };
  const loading = admin.auditView(null, o);
  assertNoNull(loading);
  assert.strictEqual(loading.empty, 'Carregando…');
  assert.strictEqual(admin.auditView({ error: 'x' }, o).empty, 'Não deu para carregar a auditoria.');
  const none = admin.auditView({ data: [], pagination: { totalItems: 0, perPage: 20, currentPage: 1, lastPage: 1 } }, o);
  assert.strictEqual(none.empty, 'Nenhum evento com esses filtros.');
  assert.strictEqual(none.range, '');
  assert.strictEqual(none.count, '0 eventos');
  assert.strictEqual(admin.auditView(pageRes({ totalItems: 1 }), o).count, '1 evento');
  assert.strictEqual(admin.auditView(pageRes(), o).empty, '');
});

test('stale response ignored', () => {
  const latest = admin.createLatest();
  const a = latest.next();
  const b = latest.next();
  assert.strictEqual(latest.isCurrent(a), false);
  assert.strictEqual(latest.isCurrent(b), true);
});
