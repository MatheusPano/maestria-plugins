'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const cleanup = require('../lib/cleanup');

const NOW = Date.parse('2026-11-25T12:00:00Z');
const HOUR = 3600 * 1000;

function setup() {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'maestria', manager: true });
  const kid = (tabId, name, card, parent = g) => {
    const k = l.add({ tabId, parent, name });
    if (card) l.nodes[k].card = card;
    return k;
  };
  const touched = {};
  const s = (id, hours, extra = {}) => {
    touched[id] = NOW - hours * HOUR;
    return { id, kind: 'claude', title: id, status: 'idle', hibernated: true, sessionId: `s-${id}`, ...extra };
  };
  return { l, g, kid, s, opts: (idle) => ({ idle, now: NOW, touched: (x) => touched[x.id] || null }) };
}

test('as paradas há mais de 1 dia, em três grupos, com o porquê e a idade; fora as da sua vista e as vivas', () => {
  const { l, kid, s, opts } = setup();
  kid('feito', 'TASK#1 CI do Drive', { state: 'done', doneBecause: 'PR #88 mergeado' });
  kid('aberto', 'TASK#2 token', { state: 'needs_you', headline: 'PR #40 esperando revisão' });
  kid('rodava', 'TASK#3 nota', { state: 'working', headline: 'gh pr checks' });
  kid('semcartao', 'TASK#4 avaliação', null);
  const sub = kid('sub', 'subgerente', null);
  l.nodes[sub].manager = true;
  kid('filha', 'filha', { state: 'working' }, sub);
  const sessions = [
    s('feito', 50),
    s('aberto', 30),
    s('rodava', 96, { hibernated: false, exited: true, status: 'ended' }),
    s('semcartao', 72, { reply: { text: 'Causa no **filtro** de data.' } }),
    s('solta', 26, { title: '⚡ solta' }),
    s('nova', 5),
    s('olhando', 40, { focused: true }),
    s('na-tela', 40, { onScreen: true }),
    s('viva', 40, { hibernated: false }),
    s('terminal', 40, { kind: 'terminal' }),
    s('sub', 48),
    s('filha', 1, { hibernated: false }),
  ];
  const list = cleanup.candidates(l, sessions, opts('1d'));
  assert.deepEqual(list.map((c) => [c.tabId, c.group, c.task, c.title, c.sub, c.age]), [
    ['rodava', 'open', 'TASK#3', 'nota', 'rodava: “gh pr checks”', '4 d'],
    ['semcartao', 'free', 'TASK#4', 'avaliação', 'última resposta: “Causa no filtro de data.”', '3 d'],
    ['feito', 'done', 'TASK#1', 'CI do Drive', 'feito porque: PR #88 mergeado', '2 d'],
    ['sub', 'open', '', 'subgerente', 'gerente com sessões abertas embaixo', '2 d'],
    ['aberto', 'open', 'TASK#2', 'token', 'precisa de você: “PR #40 esperando revisão”', '1 d'],
    ['solta', 'free', '', '⚡ solta', 'sem resposta', '1 d'],
  ]);
  assert.deepEqual([...cleanup.defaults(list)], ['semcartao', 'feito', 'solta']);
  assert.deepEqual(cleanup.candidates(l, sessions, opts('6h')).map((c) => c.tabId).includes('nova'), false);
  assert.deepEqual(cleanup.candidates(l, sessions, opts('3d')).map((c) => c.tabId), ['rodava', 'semcartao']);
  assert.deepEqual(cleanup.candidates(l, [s('sem-hora', 0, { startedAt: '2026-11-20T12:00:00Z' })], { now: NOW }).map((c) => c.age), ['5 d'], 'sem transcript, conta desde a abertura da aba');
});

test('o modal mostra os grupos, o que está marcado e o botão com a contagem', () => {
  const { l, kid, s, opts } = setup();
  kid('feito', 'feito', { state: 'done', doneBecause: 'x' });
  kid('aberto', 'aberto', { state: 'needs_you', headline: 'y' });
  const list = cleanup.candidates(l, [s('feito', 30), s('aberto', 30), s('solta', 30)], opts('1d'));
  const picked = cleanup.defaults(list);
  let v = cleanup.view(list, picked, '1d');
  assert.deepEqual(v.idles.map((i) => [i.label, i.active]), [['6 h', false], ['1 dia', true], ['3 dias', false], ['7 dias', false]]);
  assert.deepEqual(v.groups.map((g) => [g.title, g.checked, g.items.map((c) => c.checked)]), [['Cartão feito · 1', true, [true]], ['Sem cartão · 1', true, [true]], ['Cartão aberto · 1', false, [false]]]);
  assert.deepEqual([v.summary, v.run, v.canRun], ['2 marcadas · fica 1 aberta', 'Fechar 2 e guardar no histórico', true]);
  v = cleanup.view(list, new Set(), '1d');
  assert.deepEqual([v.summary, v.run, v.canRun], ['0 marcadas · ficam 3 abertas', 'Nada marcado', false]);
  assert.equal(cleanup.view([], new Set()).isEmpty, true);
  assert.deepEqual([cleanup.sidebarLine(0), cleanup.sidebarLine(1), cleanup.sidebarLine(35)], ['', '1 parada há mais de 1 dia', '35 paradas há mais de 1 dia']);
});

test('ficam desmarcadas a de keepOpen, a que parou no meio do turno e o gerente com sessão hibernada embaixo; sem sessionId nem entra', () => {
  const { l, kid, s, opts } = setup();
  kid('manter', 'manter', { state: 'done', doneBecause: 'PR mergeado', keepOpen: true });
  const meio = kid('meio', 'meio', null);
  l.nodes[meio].busy = true;
  const chefe = kid('chefe', 'chefe', null);
  l.nodes[chefe].manager = true;
  kid('neta', 'neta', null, kid('filha', 'filha', null, chefe));
  const list = cleanup.candidates(l, [s('manter', 30), s('meio', 30), s('chefe', 30), s('neta', 2), s('anonima', 30, { sessionId: null })], opts('1d'));
  assert.deepEqual(list.map((c) => [c.tabId, c.group, c.sub]), [
    ['manter', 'open', 'o gerente pediu para manter aberta: PR mergeado'],
    ['meio', 'open', 'parou no meio do turno'],
    ['chefe', 'open', 'gerente com sessões abertas embaixo'],
  ]);
  assert.deepEqual([...cleanup.defaults(list)], []);
});
