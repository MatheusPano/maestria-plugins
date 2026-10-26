'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nav = require('../lib/nav');

const count = (groups) => groups.reduce((n, g) => n + g.items.length, 0);

test('viewer has no Admin group and no Nova VM', () => {
  const groups = nav.navFor('viewer');
  assert.ok(!groups.some((g) => g.group === 'Admin'));
  assert.ok(!groups.flatMap((g) => g.items).some((i) => i.id === 'create'));
  assert.equal(count(groups), 4);
});

test('admin sees 4 groups, 7 items', () => {
  const groups = nav.navFor('admin');
  assert.equal(groups.length, 4);
  assert.equal(count(groups), 7);
  assert.deepEqual(groups[0].items[0], { id: 'vms', label: 'Máquinas virtuais', active: false });
});

test('gate', () => {
  assert.equal(nav.gate(null, 'vms'), 'login');
  for (const s of ['vms', 'create', 'users']) assert.equal(nav.gate({ role: 'pending' }, s), 'pending');
  assert.equal(nav.gate({ role: 'viewer' }, 'users'), 'forbidden');
  assert.equal(nav.gate({ role: 'viewer' }, 'create'), 'forbidden');
  assert.equal(nav.gate({ role: 'viewer' }, 'audit'), 'forbidden');
  assert.equal(nav.gate({ role: 'viewer' }, 'vms'), 'vms');
  assert.equal(nav.gate({ role: 'admin' }, 'users'), 'users');
  assert.equal(nav.FORBIDDEN_TEXT, 'Só admins podem fazer isso.');
});

test('initials e ROLE_LABEL', () => {
  assert.equal(nav.initials('Arthur Fonseca'), 'AF');
  assert.equal(nav.initials('ti@marrow.com.br'), 'TM');
  assert.deepEqual(nav.ROLE_LABEL, { admin: 'Admin', viewer: 'Viewer', pending: 'Pendente' });
});
