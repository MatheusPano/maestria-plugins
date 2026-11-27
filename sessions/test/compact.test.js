'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const { due } = require('../lib/compact');

const NOW = 1e9;

function setup() {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'g', manager: true });
  l.add({ tabId: 'a', parent: g, name: 'a' });
  const session = (over = {}) => ({ id: 'g', kind: 'claude', status: 'idle', ...over });
  return { l, g, session };
}

test('an idle manager above the threshold is compacted, once per cooldown', () => {
  const { l, session } = setup();
  const big = () => ({ context: 130000 });
  const opts = { threshold: 120000, now: NOW };
  assert.deepEqual(due(l, [session()], big, opts), ['g']);
  assert.deepEqual(due(l, [session()], () => ({ context: 100000 }), opts), []);
  assert.deepEqual(due(l, [session()], big, { ...opts, compacted: new Map([['g', NOW - 60000]]) }), []);
  assert.deepEqual(due(l, [session()], big, { ...opts, compacted: new Map([['g', NOW - 16 * 60000]]) }), ['g']);
  assert.deepEqual(due(l, [session()], big, { ...opts, threshold: 0 }), []);
});

test('a manager that is busy, focused, hibernated, waiting or has a notice queued is left alone, and so is a plain session', () => {
  const { l, g, session } = setup();
  const big = () => ({ context: 999999 });
  const opts = { threshold: 120000, now: NOW };
  for (const over of [{ status: 'tool' }, { focused: true }, { hibernated: true }, { needsYou: true, status: 'waitingAnswer' }, { id: 'a' }]) {
    assert.deepEqual(due(l, [session(over)], big, opts), [], JSON.stringify(over));
  }
  l.nodes[g].events = [{ key: 'x', kind: 'error', at: NOW }];
  assert.deepEqual(due(l, [session()], big, opts), []);
});
