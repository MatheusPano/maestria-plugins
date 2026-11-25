'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const { deliver, handOver } = require('../lib/answers');

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

test('sessão fechada: a resposta vai pro gerente', async () => {
  for (const [status, extra] of [['ready', { exited: true }]]) {
    const { l, g, k, calls, env } = setup(status, extra);
    const r = await deliver(k, 'Aprovado.', env);
    assert.equal(r.via, 'manager', status);
    assert.equal(calls[0].p.tabId, 'g');
    assert.match(calls[0].p.text, /^\[resposta do usuário no cartão de .+\] Aprovado\.$/);
    assert.equal(calls[0].p.submit, true);
    assert.equal(l.nodes[g].inbox, undefined);
    assert.equal(l.nodes[k].card.answered.via, 'manager');
  }
});

test('resposta vazia ou cartão que sumiu não manda nada', async () => {
  const { k, calls, env } = setup('ready');
  await assert.rejects(deliver(k, '  ', env), /vazia/);
  await assert.rejects(deliver('n99', 'x', env), /não existe/);
  assert.equal(calls.length, 0);
});

test('sessão fechada com o gerente também indisponível: recusa e não marca o cartão', async () => {
  for (const mgr of [{ status: 'waitingPermission' }, { exited: true }]) {
    const { l, k, calls, env } = setup('ready', { exited: true });
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

test('mensagem pela caixa do cartão passa a vez para a sessão: sai de "precisa de você" e mostra o que você escreveu', async () => {
  const { l, k, env } = setup('ready');
  await deliver(k, ' merged, reconnected as well ', { ...env, message: true });
  const c = l.nodes[k].card;
  assert.deepEqual([c.state, c.action, c.headline, c.since], ['working', null, 'Você escreveu: merged, reconnected as well', 5]);
  assert.deepEqual(c.answered, { text: 'merged, reconnected as well', at: 5, message: true });
  assert.deepEqual(c.bullets, ['b']);
});

test('escrever para uma sessão cujo cartão foi dispensado ou dado como feito traz ele de volta para trabalhando', () => {
  const node = { card: { state: 'done', dismissed: true, doneBecause: 'PR #1 mergeado', doneAt: 3, headline: 'Dispensado por você.' } };
  handOver(node, 'reabre o PR', 9, true);
  assert.equal(node.card.state, 'working');
  assert.equal(node.card.dismissed, undefined);
  assert.equal(node.card.doneBecause, undefined);
  assert.equal(node.card.doneAt, null);
  assert.equal(node.card.headline, 'Você escreveu: reabre o PR');
});

const { flushPending, dropPending, PENDING_MS } = require('../lib/answers');

/** O flush relê as abas por list(): a lista viva é env.sessions, que o teste muda. */
const flushOf = (env, extra = {}) => flushPending({ ...env, list: async () => env.sessions, boot: 'b1', now: 10, ...extra });

test('com a aba num prompt as respostas entram na fila, na ordem, e vão juntas para a aba quando ela sai do prompt e para', async () => {
  const { l, g, k, calls, env } = setup('waitingPermission');
  assert.deepEqual(await deliver(k, 'A: sim', { ...env, boot: 'b1' }), { via: 'pending', title: 'TASK#1 w' });
  env.sessions[1] = { ...env.sessions[1], status: 'idle' };
  assert.equal((await deliver(k, 'e roda os testes', { ...env, boot: 'b1', message: true })).via, 'pending', 'com fila, a nova entra atrás mesmo com a aba parada');
  assert.deepEqual(calls, []);
  assert.deepEqual(l.nodes[k].pending.map((p) => p.text), ['A: sim', 'e roda os testes']);

  const at = (status, extra = {}) => {
    env.sessions[1] = { ...env.sessions[1], status, focused: false, ...extra };
    return flushOf(env);
  };
  assert.deepEqual(await at('waitingPermission'), []);
  assert.deepEqual(await at('tool'), [], 'rodando depois do prompt: espera parar');
  assert.deepEqual(await at('idle', { focused: true }), [], 'você está na aba: não digita por cima');
  assert.deepEqual(await at('idle'), [{ key: k, via: 'terminal', title: 'TASK#1 w' }]);
  assert.deepEqual(calls, [{ m: 'terminal.sendText', p: { tabId: 'w', text: 'A: sim\ne roda os testes', submit: true } }]);
  assert.equal(l.nodes[k].pending, undefined);
  assert.equal(l.nodes[k].card.answered.at, 10, 'a hora da resposta é a da entrega');
  assert.deepEqual(l.nodes[g].inbox.map((x) => x.text), ['A: sim\ne roda os testes']);
  assert.deepEqual(await at('idle'), [], 'vai uma vez só');
});

test('relê a aba antes de digitar: se ela voltou a um prompt, segura', async () => {
  const { l, k, calls, env } = setup('idle');
  l.nodes[k].pending = [{ text: 'x', at: 5, boot: 'b1' }];
  const live = env.sessions.map((s) => (s.id === 'w' ? { ...s, status: 'waitingPermission' } : s));
  assert.deepEqual(await flushPending({ ...env, list: async () => live, boot: 'b1', now: 10 }), []);
  assert.deepEqual(calls, []);
});

test('vai pro gerente: aba fechada (confirmada), mais de 1 h no prompt, ou o plugin reiniciou com ela no prompt; cada uma com o porquê', async () => {
  const cases = [
    ['fechada', 'idle', { exited: true }, { boot: 'b1' }, 10, 'a aba fechou'],
    ['1 h', 'waitingPermission', {}, { boot: 'b1' }, 5 + PENDING_MS + 1, 'a aba ficou mais de 1 h num prompt'],
    ['reinício', 'waitingAnswer', {}, { boot: 'velho' }, 10, 'o plugin reiniciou com a aba num prompt'],
  ];
  for (const [name, status, tab, pend, now, why] of cases) {
    const { l, k, calls, env } = setup(status, tab);
    l.nodes[k].pending = [{ text: 'Aprovado.', at: 5, ...pend }];
    l.nodes[k].card = { state: 'working', answered: { text: 'Aprovado.', at: 5 } };
    const out = await flushOf(env, { now, closed: () => name === 'fechada' });
    assert.deepEqual(out.map((o) => o.via), ['manager'], name);
    assert.equal(calls[0].p.tabId, 'g', name);
    assert.equal(calls[0].p.text, `[resposta do usuário no cartão de ${name === 'fechada' ? 'w' : 'TASK#1 w'}, guardada às ${String(new Date(5).getHours()).padStart(2, '0')}:${String(new Date(5).getMinutes()).padStart(2, '0')} (${why})] Aprovado.`, name);
    assert.equal(l.nodes[k].card.answered.via, 'manager', name);
  }
  const { l, k, calls, env } = setup('idle', { exited: true });
  l.nodes[k].pending = [{ text: 'x', at: 5, boot: 'b1' }];
  assert.deepEqual(await flushOf(env), [], 'sumida numa leitura só não é fechada');
  assert.deepEqual(calls, []);
});

test('reiniciou com a aba já parada: vai pra aba; sem gerente que receba, vai pra aba se puder ou é descartada', async () => {
  let { l, k, calls, env } = setup('idle');
  l.nodes[k].pending = [{ text: 'x', at: 5, boot: 'velho' }];
  assert.deepEqual((await flushOf(env)).map((o) => o.via), ['terminal']);
  assert.equal(calls[0].p.tabId, 'w');

  ({ l, k, calls, env } = setup('waitingPermission'));
  env.sessions[0] = { ...env.sessions[0], exited: true };
  l.nodes[k].pending = [{ text: 'x', at: 5, boot: 'velho' }];
  assert.deepEqual((await flushOf(env)).map((o) => o.via), ['dropped']);
  assert.deepEqual([calls, l.nodes[k].pending], [[], undefined]);

  ({ l, k, calls, env } = setup('waitingPermission'));
  env.sessions[0] = { ...env.sessions[0], status: 'waitingAnswer' };
  l.nodes[k].pending = [{ text: 'x', at: 5, boot: 'velho' }];
  assert.deepEqual(await flushOf(env), [], 'gerente aberto mas num prompt: espera');
  assert.equal(l.nodes[k].pending.length, 1);
  assert.equal(dropPending(l.nodes[k]), true);
  assert.equal(l.nodes[k].pending, undefined);
});
