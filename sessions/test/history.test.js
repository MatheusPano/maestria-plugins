'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links, HISTORY_MS } = require('../lib/links');
const { ALL } = require('../lib/cards');
const history = require('../lib/history');

const NOW = new Date(2026, 10, 25, 15, 0).getTime();
const HOUR = 3600 * 1000;

function tree() {
  let now = NOW;
  const links = new Links({}, () => now);
  const g = links.add({ tabId: 'g', name: 'maestria', manager: true });
  const w = links.add({ tabId: 'w', parent: g, name: 'TASK#7 CI do Drive' });
  links.nodes[w].sessionId = 's-w';
  links.nodes[w].card = {
    state: 'done',
    headline: 'Pipeline de 9 para 3 min',
    doneBecause: 'PR #88 mergeado',
    proof: { prs: [{ url: 'https://github.com/o/r/pull/88', label: 'PR #88' }] },
  };
  return { links, g, w, at: (ms) => (now = ms) };
}

test('o registro guarda o cartão, os PRs do cartão e da resposta sem repetir, e o que precisa para retomar', () => {
  const { links, g, w } = tree();
  const reply = { text: '**Pronto.** PR #88 e PR #89', links: [{ url: 'https://github.com/o/r/pull/88' }, { url: 'https://github.com/o/r/pull/89' }] };
  const h = history.record(links, { key: w, session: { id: 'w', title: 'x', branch: 'feature/TASK#7', cwd: '/r', sessionId: 's-w', reply }, by: 'gerente maestria', now: NOW });
  assert.equal(links.history[0], h);
  assert.match(h.id, /^h\d+$/);
  assert.deepEqual(
    { name: h.name, task: h.task, root: h.root, by: h.by, branch: h.branch, cwd: h.cwd, sessionId: h.sessionId, tabId: h.tabId, reply: h.reply },
    { name: 'TASK#7 CI do Drive', task: 'TASK#7', root: g, by: 'gerente maestria', branch: 'feature/TASK#7', cwd: '/r', sessionId: 's-w', tabId: 'w', reply: 'Pronto. PR #88 e PR #89' },
  );
  assert.deepEqual(h.prs.map((p) => p.label), ['PR #88', 'o/r/pull/89']);
  assert.equal(history.whatOf(h), 'PR #88 mergeado. Pipeline de 9 para 3 min');
});

test('sem cartão, o que foi feito é a última resposta', () => {
  const { links } = tree();
  const h = history.record(links, { session: { id: 'z', title: 'solta', sessionId: 's-z', reply: { text: 'Causa no `filtro`\nde data.' } }, by: 'você, na aba', now: NOW });
  assert.equal(h.key, null);
  assert.equal(history.whatOf(h), 'Sem cartão. Última resposta: “Causa no filtro de data.”');
  assert.equal(history.whatOf({ ...h, reply: '' }), 'Sem cartão nem resposta.');
});

test('o painel mostra o período escolhido, mais recente primeiro, e só as do gerente aberto', () => {
  const { links, w } = tree();
  const other = links.add({ tabId: 'o', name: 'infra', manager: true });
  history.record(links, { key: w, session: { id: 'w', sessionId: 's-w' }, by: 'gerente maestria', now: NOW - 2 * HOUR });
  history.record(links, { session: { id: 'z', title: 'solta', sessionId: 's-z' }, by: 'você, na aba', now: NOW - HOUR });
  history.record(links, { key: other, session: { id: 'o', sessionId: 's-o' }, by: 'você, no painel', now: NOW - 26 * HOUR });
  history.record(links, { session: { id: 'v', title: 'velha' }, by: 'você, na aba', now: NOW - 10 * 24 * HOUR });

  const closed = history.view(links, ALL, null, NOW);
  assert.deepEqual([closed.open, closed.rows, closed.label], [false, [], 'Histórico das fechadas · 2 hoje · 4 em 30 dias']);

  const today = history.view(links, ALL, 'today', NOW);
  assert.deepEqual(today.rows.map((r) => [r.when, r.task, r.title, r.by, r.canResume]), [
    ['14:00', '', 'solta', 'você, na aba', true],
    ['13:00', 'TASK#7', 'CI do Drive', 'gerente maestria', true],
  ]);
  assert.deepEqual(today.ranges.map((r) => r.active), [true, false, false, false]);
  assert.equal(today.rows[1].prs[0].act, `hpr:${links.history.find((h) => h.key === w).id}:0`);
  assert.deepEqual(history.view(links, ALL, 'yesterday', NOW).rows.map((r) => r.when), ['ontem 13:00']);
  assert.equal(history.view(links, ALL, 'week', NOW).rows.length, 3);
  assert.deepEqual(history.view(links, ALL, 'month', NOW).rows.map((r) => [r.when, r.canResume]).pop(), ['15/11 15:00', false]);
  assert.deepEqual(history.view(links, other, 'month', NOW).rows.map((r) => r.by), ['você, no painel']);
  assert.equal(history.summary(links, NOW), '2 fechadas hoje · 3 nos últimos 7 dias');
});

test('uma aba que sumiu da lista entra como fechada por você, a não ser que já tenha sido registrada', () => {
  const { links } = tree();
  const before = [
    { id: 'a', kind: 'claude', sessionId: 's-a' },
    { id: 'b', kind: 'claude', sessionId: 's-b' },
    { id: 'c', kind: 'claude', sessionId: null },
    { id: 'd', kind: 'terminal', sessionId: 's-d' },
    { id: 'e', kind: 'claude', sessionId: 's-e', exited: true },
    { id: 'f', kind: 'claude', sessionId: 's-f' },
  ];
  history.record(links, { session: { id: 'b', sessionId: 's-b' }, by: 'gerente maestria', now: NOW });
  assert.deepEqual(history.vanished(links, before, [{ id: 'f' }], NOW).map((s) => s.id), ['a', 'e'], 'a aba já encerrada (exited) também conta');
});

test('desfazer tira o registro; o histórico some depois de 30 dias e tem um teto', () => {
  const { links, at } = tree();
  const h = history.record(links, { session: { id: 'a', sessionId: 's-a' }, by: 'x', now: NOW });
  history.forget(links, h.id);
  assert.deepEqual(links.history, []);
  history.record(links, { session: { id: 'a', sessionId: 's-a' }, by: 'x', now: NOW - HISTORY_MS - 1 });
  history.record(links, { session: { id: 'b', sessionId: 's-b' }, by: 'x', now: NOW - HOUR });
  at(NOW);
  assert.equal(links.reconcile([]), true);
  assert.deepEqual(links.history.map((x) => x.tabId), ['b']);
  for (let i = 0; i < 600; i++) links.remember({ at: NOW, tabId: `t${i}` });
  assert.equal(links.history.length, 500);
  assert.equal(links.history[0].tabId, 't599');
  assert.deepEqual(Object.keys(new Links(JSON.parse(JSON.stringify(links))).toJSON()), ['nodes', 'seq', 'history']);
});

test('várias abas sumindo de uma vez, ou a última, contam todas; só o registro recente evita a repetição', () => {
  const { links } = tree();
  const tab = (id) => ({ id, kind: 'claude', sessionId: `s-${id}` });
  assert.deepEqual(history.vanished(links, [tab('a')], [], NOW).map((s) => s.id), ['a']);
  assert.deepEqual(history.vanished(links, ['a', 'b', 'c', 'd', 'x'].map(tab), [tab('x')], NOW).map((s) => s.id), ['a', 'b', 'c', 'd']);
  history.record(links, { session: tab('a'), by: 'gerente', now: NOW - 3 * 60 * 1000 });
  assert.deepEqual(history.vanished(links, ['a', 'x'].map(tab), [tab('x')], NOW).map((s) => s.id), ['a'], 'só o registro recente evita a repetição');
});

test('a resposta mais nova que o cartão "trabalhando" é o que fica como feito; o done mantém o motivo', () => {
  const { links, w } = tree();
  links.nodes[w].card = { state: 'working', headline: 'rodando a suíte', at: 100 };
  const h = history.record(links, { key: w, session: { id: 'w', reply: { text: 'suíte verde, PR #9 aberto', at: 200 } }, by: 'x', now: NOW });
  assert.equal(history.whatOf(h), 'Última resposta: “suíte verde, PR #9 aberto”');
  links.nodes[w].card = { state: 'working', headline: 'rodando a suíte', at: 300 };
  assert.equal(history.whatOf(history.record(links, { key: w, session: { id: 'w', reply: { text: 'velha', at: 200 } }, by: 'x', now: NOW })), 'rodando a suíte');
  assert.equal(history.view(links, ALL, 'today', NOW).rows[0].title, 'CI do Drive');
  links.nodes[w].name = 'task#7 minúsculo';
  assert.equal(history.view(links, ALL, 'today', NOW).rows[0].title, 'CI do Drive', 'o registro guarda o nome da hora');
  assert.equal(history.view({ history: [{ ...links.history[0], name: 'task#7 minúsculo', task: 'TASK#7' }] }, ALL, 'today', NOW).rows[0].title, 'minúsculo');
});
