'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const { run, headlineOf } = require('../lib/autocard');
const { limits } = require('../lib/relay');

const NOW = 10 * 60 * 1000;
const PR = 'https://github.com/o/r/pull/31';

function setup(card, reply, extra = {}) {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'g', manager: true });
  const a = l.add({ tabId: 'a', parent: g, name: 'api' });
  if (card) l.nodes[a].card = card;
  l.nodes[g].events = [{ key: a, kind: 'turn', at: NOW - limits.quiet - 1 }];
  const sessions = [{ id: 'a', kind: 'claude', title: '● api', status: 'idle', reply, ...extra }];
  return { l, g, a, sessions };
}

test('a finished turn with nothing to decide updates the card from the reply and does not wake the manager', () => {
  const { l, g, a, sessions } = setup({ state: 'working', headline: 'running', at: 100, since: 100 }, { text: '## Suite is green\n\nAll 40 pass.', at: NOW - 5000 });
  assert.equal(run(l, sessions, NOW), true);
  assert.deepEqual(l.nodes[g].events, []);
  assert.deepEqual(
    { state: l.nodes[a].card.state, headline: l.nodes[a].card.headline, auto: l.nodes[a].card.auto, since: l.nodes[a].card.since },
    { state: 'needs_you', headline: 'Suite is green', auto: true, since: NOW },
  );
});

test('a question, a new PR, a card the manager wrote, a stopped-but-running tab and a session without a card keep the event for the manager', () => {
  const working = { state: 'working', headline: 'x', at: 100 };
  const cases = [
    setup(working, { text: 'Which one do you want?', at: NOW - 5000 }),
    setup(working, { text: `Done: ${PR}`, at: NOW - 5000, links: [{ url: PR }] }),
    setup({ state: 'needs_you', headline: 'q', at: 100, action: { kind: 'question', text: 'q', options: [] } }, { text: 'Done.', at: NOW - 5000 }),
    setup(working, { text: 'Done.', at: NOW - 5000 }, { status: 'tool' }),
    setup(null, { text: 'Done.', at: NOW - 5000 }),
    setup(working, { text: 'old reply', at: 50 }),
  ];
  for (const { l, g, sessions } of cases) {
    assert.equal(run(l, sessions, NOW), false);
    assert.equal(l.nodes[g].events.length, 1);
  }
});

test('an auto card is refreshed by the next reply, and the headline is clipped', () => {
  const { l, a, sessions } = setup({ state: 'needs_you', headline: 'old', at: 100, since: 50, auto: true }, { text: 'x'.repeat(300), at: NOW - 5000 });
  assert.equal(run(l, sessions, NOW), true);
  assert.equal(l.nodes[a].card.since, 50);
  assert.equal(Array.from(l.nodes[a].card.headline).length, 201);
  assert.equal(headlineOf('**bold** line\nsecond'), 'bold line');
});
