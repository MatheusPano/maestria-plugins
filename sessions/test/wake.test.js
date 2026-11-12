'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isOpen } = require('../lib/links');
const { awake, typeInto } = require('../lib/wake');

const sleep = async () => {};

function rig(states) {
  const calls = [];
  let i = 0;
  const io = {
    request: async (m, p) => calls.push({ m, p }),
    list: async () => [states[Math.min(i++, states.length - 1)]],
  };
  return { calls, io };
}

test('hibernada conta como aberta; fechada não', () => {
  assert.equal(isOpen({ exited: false }), true);
  assert.equal(isOpen({ exited: true, hibernated: true }), true);
  assert.equal(isOpen({ exited: true }), false);
  assert.equal(isOpen(null), false);
});

test('digitar numa hibernada acorda, espera ficar pronta e só então envia', async () => {
  const sleeping = { id: 't', title: '▲ w', hibernated: true, exited: true, status: 'ready' };
  const { calls, io } = rig([
    { id: 't', hibernated: false, exited: false, status: 'starting' },
    { id: 't', hibernated: false, exited: false, status: 'ready' },
  ]);
  await typeInto(io, sleeping, 'oi', { sleep });
  assert.deepEqual(calls, [
    { m: 'session.wake', p: { tabId: 't' } },
    { m: 'terminal.sendText', p: { tabId: 't', text: 'oi', submit: true } },
  ]);
});

test('acordada vale direto; a que não fica pronta ou some dá erro sem enviar', async () => {
  const live = { id: 't', status: 'ready' };
  const a = rig([]);
  await typeInto(a.io, live, 'x', { sleep });
  assert.deepEqual(a.calls.map((c) => c.m), ['terminal.sendText']);

  const slow = rig([{ id: 't', hibernated: false, exited: false, status: 'starting' }]);
  await assert.rejects(awake(slow.io, { id: 't', title: 'w', hibernated: true }, { sleep, timeout: 3, step: 1 }), /não ficou pronta/);
  assert.deepEqual(slow.calls.map((c) => c.m), ['session.wake']);

  const gone = { calls: [], io: { request: async () => {}, list: async () => [] } };
  await assert.rejects(awake(gone.io, { id: 't', title: 'w', hibernated: true }, { sleep }), /fechou ao acordar/);
});

test('acordou numa pergunta: não digita no meio dela', async () => {
  const { calls, io } = rig([{ id: 't', hibernated: false, exited: false, status: 'waitingPermission' }]);
  await assert.rejects(typeInto(io, { id: 't', title: 'w', hibernated: true }, 'x', { sleep }), /esperando você/);
  assert.deepEqual(calls.map((c) => c.m), ['session.wake']);
});

test('processo que morre ao acordar falha na hora; a mesma aba não acorda duas vezes ao mesmo tempo', async () => {
  const dead = rig([{ id: 't', hibernated: false, exited: true, status: 'ready' }]);
  await assert.rejects(awake(dead.io, { id: 't', title: 'w', hibernated: true }, { sleep }), /fechou ao acordar/);

  let release;
  const held = new Promise((r) => (release = r));
  const io = { request: async () => {}, list: async () => [{ id: 'z', status: 'ready' }] };
  const first = awake(io, { id: 'z', title: 'z', hibernated: true }, { sleep: () => held });
  await assert.rejects(awake(io, { id: 'z', title: 'z', hibernated: true }, { sleep }), /já estou acordando/);
  release();
  assert.equal((await first).status, 'ready');
});
