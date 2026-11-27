'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const { ciOf, poll, due } = require('../lib/ci');

const URL = 'https://github.com/o/r/pull/7';

test('ciOf reads gh checks: any failure fails, anything unfinished runs, all green is ok, none is none', () => {
  const run = { status: 'COMPLETED', conclusion: 'SUCCESS' };
  assert.equal(ciOf([]), 'none');
  assert.equal(ciOf([run, { status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'ok');
  assert.equal(ciOf([run, { status: 'IN_PROGRESS', conclusion: '' }]), 'running');
  assert.equal(ciOf([run, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failed');
  assert.equal(ciOf([{ state: 'SUCCESS' }, { state: 'PENDING' }]), 'running');
  assert.equal(ciOf([{ state: 'FAILURE' }]), 'failed');
});

function setup(state = 'needs_you', extra = {}) {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'g', manager: true });
  const a = l.add({ tabId: 'a', parent: g, name: 'a' });
  l.nodes[a].card = { state, at: 1000, proof: { images: [], audio: [], log: '', prs: [{ url: URL, label: 'PR #7', ci: 'running' }, { url: 'https://example.com/x', label: 'x', ci: 'none' }] }, ...extra };
  return { l, a };
}

test('poll updates the badge of a GitHub PR in a card and asks again later, not at once', async () => {
  const { l, a } = setup();
  const asked = new Map();
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args[2]);
    return { code: 0, stdout: JSON.stringify({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }) };
  };
  assert.equal(await poll(l, exec, asked, 100000), true);
  assert.equal(l.nodes[a].card.proof.prs[0].ci, 'failed');
  assert.equal(l.nodes[a].card.proof.prs[1].ci, 'none');
  assert.deepEqual(calls, [URL]);
  assert.equal(await poll(l, exec, asked, 100001), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(due(l, asked, 100000 + 11 * 60 * 1000).map((d) => d.url), [URL]);
});

test('a gh failure or garbage leaves the badge alone, and an old done card is not polled', async () => {
  const { l, a } = setup();
  assert.equal(await poll(l, async () => ({ code: 1, stdout: '' }), new Map(), 5000), false);
  assert.equal(await poll(l, async () => ({ code: 0, stdout: 'nope' }), new Map(), 5000), false);
  assert.equal(l.nodes[a].card.proof.prs[0].ci, 'running');
  const old = setup('done', { doneAt: 1000 });
  assert.deepEqual(due(old.l, new Map(), 1000 + 25 * 60 * 60 * 1000), []);
});
