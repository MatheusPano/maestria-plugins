'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const { deliver } = require('../lib/answers');

function setup(status, extra = {}) {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'g', manager: true });
  const k = l.add({ tabId: 'w', parent: g, name: 'w' });
  l.nodes[k].card = { state: 'needs_you', action: { kind: 'question', text: 'q', options: [] }, bullets: ['b'] };
  const calls = [];
  const sessions = [{ id: 'g', title: 'g' }, { id: 'w', title: '▲ TASK#1 w', status, statusLabel: status, ...extra }];
  const env = { links: l, sessions, now: 5, request: async (m, p) => calls.push({ m, p }) };
  return { l, g, k, calls, env };
}

test('a resposta vai direto pro terminal da sessão, com cópia na caixa do gerente', async () => {
  const { l, g, k, calls, env } = setup('ready');
  const r = await deliver(k, '  A: sim ', env);
  assert.deepEqual(r, { via: 'terminal', title: 'TASK#1 w' });
  assert.deepEqual(calls, [{ m: 'terminal.sendText', p: { tabId: 'w', text: 'A: sim', submit: true } }]);
  assert.deepEqual(l.nodes[g].inbox, [{ tabId: 'w', title: 'TASK#1 w', text: 'A: sim', at: 5, via: 'terminal' }]);
  const c = l.nodes[k].card;
  assert.equal(c.state, 'working');
  assert.equal(c.action, null);
  assert.equal(c.headline, 'Você respondeu: A: sim');
  assert.deepEqual(c.bullets, ['b']);
});

test('sessão num prompt ou fechada: a resposta vai pro gerente', async () => {
  for (const [status, extra] of [['waitingPermission', {}], ['waitingAnswer', {}], ['ready', { exited: true }]]) {
    const { l, g, k, calls, env } = setup(status, extra);
    const r = await deliver(k, 'Aprovado.', env);
    assert.equal(r.via, 'manager', status);
    assert.equal(calls[0].p.tabId, 'g');
    assert.match(calls[0].p.text, /^\[resposta do usuário no cartão de .+\] Aprovado\.$/);
    assert.equal(calls[0].p.submit, true);
    assert.equal(l.nodes[g].inbox, undefined);
  }
});

test('resposta vazia ou cartão que sumiu não manda nada', async () => {
  const { k, calls, env } = setup('ready');
  await assert.rejects(deliver(k, '  ', env), /vazia/);
  await assert.rejects(deliver('n99', 'x', env), /não existe/);
  assert.equal(calls.length, 0);
});

test('sessão num prompt com o gerente também indisponível: recusa e não marca o cartão', async () => {
  for (const mgr of [{ status: 'waitingPermission' }, { exited: true }]) {
    const { l, k, calls, env } = setup('waitingPermission');
    Object.assign(env.sessions[0], mgr);
    await assert.rejects(deliver(k, 'ok', env), /responda na aba/);
    assert.equal(calls.length, 0);
    assert.equal(l.nodes[k].card.state, 'needs_you');
  }
});

test('sessão hibernada: acorda e responde a ela; se acordar numa pergunta, a resposta vai pro gerente', async () => {
  const wait = { sleep: async () => {} };
  for (const [woke, to, via] of [['ready', 'w', 'terminal'], ['waitingPermission', 'g', 'manager']]) {
    const { k, calls, env } = setup('ready', { hibernated: true, exited: true });
    const list = async () => [env.sessions[0], { id: 'w', title: '▲ TASK#1 w', status: woke }];
    const r = await deliver(k, 'B', { ...env, list, wait });
    assert.equal(r.via, via, woke);
    assert.deepEqual(calls.map((c) => c.m), ['session.wake', 'terminal.sendText']);
    assert.equal(calls[1].p.tabId, to);
  }
});
