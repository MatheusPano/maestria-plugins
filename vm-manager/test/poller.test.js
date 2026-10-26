'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPoller } = require('../lib/poller');
const { fakeClock, assertNoNull } = require('./helpers');

function setup() {
  const clock = fakeClock();
  return { clock, poller: createPoller({ schedule: clock.schedule }) };
}

test('ticks immediately then every ms', async () => {
  const { clock, poller } = setup();
  let n = 0;
  poller.loop('a', 1000, async () => ++n && true);
  await clock.advance(0);
  assert.equal(n, 1);
  await clock.advance(999);
  assert.equal(n, 1);
  await clock.advance(1);
  assert.equal(n, 2);
  await clock.advance(2000);
  assert.equal(n, 4);
  assert.equal(poller.running('a'), true);
});

test('stops when tick returns false', async () => {
  const { clock, poller } = setup();
  let n = 0;
  poller.loop('a', 1000, async () => ++n < 2);
  await clock.advance(5000);
  assert.equal(n, 2);
  assert.equal(poller.running('a'), false);
});

test('rejected tick keeps looping', async () => {
  const { clock, poller } = setup();
  let n = 0;
  poller.loop('a', 1000, async () => {
    n++;
    throw new Error('boom');
  });
  await clock.advance(3000);
  assert.equal(n, 4);
  assert.equal(poller.running('a'), true);
});

test('loop twice same key runs one loop', async () => {
  const { clock, poller } = setup();
  let n = 0;
  poller.loop('a', 1000, async () => ++n && true);
  poller.loop('a', 1000, async () => ++n && true);
  await clock.advance(1000);
  assert.equal(n, 2);
});

test('stopAll cancels pending timers', async () => {
  const { clock, poller } = setup();
  let a = 0;
  let b = 0;
  poller.loop('a', 1000, async () => ++a && true);
  poller.loop('b', 1000, async () => ++b && true);
  await clock.advance(0);
  poller.stopAll();
  await clock.advance(5000);
  assert.deepEqual([a, b], [1, 1]);
  assert.equal(poller.running('a'), false);
});

test('stop during an in-flight tick does not reschedule', async () => {
  const { clock, poller } = setup();
  let n = 0;
  let release;
  poller.loop('a', 1000, () => new Promise((r) => { n++; release = () => r(true); }));
  await clock.advance(0);
  poller.stop('a');
  release();
  await clock.advance(5000);
  assert.equal(n, 1);
});

test('assertNoNull reports the path', () => {
  assertNoNull({ a: [1, { b: '' }] });
  assert.throws(() => assertNoNull({ a: [1, { b: null }] }), /a\[1\]\.b/);
});
