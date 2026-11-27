'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openClaude, valid } = require('../lib/model');

function fake(statuses) {
  const calls = [];
  const queue = [...statuses];
  const request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'session.openClaude') return { tabId: 't1' };
    if (method === 'sessions.list') return [{ id: 't1', status: queue.length > 1 ? queue.shift() : queue[0] }];
    return null;
  };
  return { calls, request };
}

test('without a model the prompt goes in openClaude as before', async () => {
  const { calls, request } = fake(['ready']);
  const r = await openClaude(request, { cwd: '/x', prompt: 'hi' }, '');
  assert.deepEqual(calls, [['session.openClaude', { cwd: '/x', prompt: 'hi' }]]);
  assert.equal(r.model, null);
});

test('with a model, /model is typed once the tab is ready, then the prompt', async () => {
  const { calls, request } = fake(['starting', 'starting', 'ready']);
  const r = await openClaude(request, { cwd: '/x', prompt: 'hi' }, 'sonnet', { sleep: async () => {} });
  assert.deepEqual(calls.filter(([m]) => m !== 'sessions.list'), [
    ['session.openClaude', { cwd: '/x' }],
    ['terminal.sendText', { tabId: 't1', text: '/model sonnet', submit: true }],
    ['terminal.sendText', { tabId: 't1', text: 'hi', submit: true }],
  ]);
  assert.deepEqual(r, { tabId: 't1', model: 'sonnet' });
});

test('a tab that never gets ready still receives the prompt, and the result says no model was set', async () => {
  const { calls, request } = fake(['starting']);
  const r = await openClaude(request, { cwd: '/x', prompt: 'hi' }, 'opus', { sleep: async () => {}, readyMs: 1000 });
  assert.deepEqual(calls.filter(([m]) => m === 'terminal.sendText'), [['terminal.sendText', { tabId: 't1', text: 'hi', submit: true }]]);
  assert.equal(r.model, null);
});

test('model names with spaces or newlines are refused', () => {
  assert.deepEqual([valid('sonnet'), valid('claude-opus-5-5'), valid('opus\nrm'), valid('a b'), valid('')], [true, true, false, false, false]);
});
