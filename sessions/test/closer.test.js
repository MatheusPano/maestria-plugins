'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const closer = require('../lib/closer');
const history = require('../lib/history');

function setup() {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'maestria', manager: true });
  const kid = (tabId, card, extra = {}) => {
    const k = l.add({ tabId, parent: extra.parent || g, name: tabId });
    l.nodes[k].sessionId = `s-${tabId}`;
    l.nodes[k].card = card && { closeFor: `s-${tabId}`, ...card };
    Object.assign(l.nodes[k], extra.node || {});
    return k;
  };
  const s = (id, extra = {}) => ({ id, kind: 'claude', title: id, status: 'idle', sessionId: `s-${id}`, ...extra });
  return { l, g, kid, s };
}

const done = { state: 'done', doneBecause: 'PR mergeado' };

test('fecha só a aba do done armado para a conversa dela, parada, fora do turno e fora da sua vista', () => {
  const { l, kid, s } = setup();
  for (const t of ['pronta', 'dorme', 'olhando', 'na-tela', 'rodando', 'agentes', 'no-turno', 'outra-conversa']) kid(t, done, t === 'no-turno' ? { node: { busy: true } } : {});
  kid('manter', { ...done, keepOpen: true, closeFor: null });
  kid('dispensada', { ...done, dismissed: true });
  kid('desarmada', { ...done, closeFor: null });
  kid('trabalhando', { state: 'working' });
  const sub = kid('sub', done, { node: { manager: true } });
  kid('neta', { state: 'working' }, { parent: sub });
  const sessions = [
    s('g'),
    s('pronta'),
    s('dorme', { status: 'working', hibernated: true, exited: true }),
    s('olhando', { focused: true }),
    s('na-tela', { onScreen: true }),
    s('rodando', { status: 'tool' }),
    s('agentes', { backgroundAgents: 2 }),
    s('no-turno', { status: 'ready' }),
    s('outra-conversa', { sessionId: 's-outra' }),
    s('manter'),
    s('dispensada'),
    s('desarmada'),
    s('trabalhando'),
    s('sub'),
    s('neta'),
  ];
  assert.deepEqual(closer.due(l, sessions).map((d) => [d.session.id, d.by]), [['pronta', 'gerente maestria'], ['dorme', 'gerente maestria']]);
  assert.deepEqual(closer.due(l, sessions.filter((x) => x.id !== 'neta')).map((d) => d.session.id), ['pronta', 'dorme', 'sub'], 'o gerente fecha quando não tem mais sessões abertas embaixo');
});

test('qualquer fechamento registrado desarma o done; os cartões de antes armam só com a aba aberta agora', () => {
  const { l, kid, s } = setup();
  const k = kid('w', done);
  history.record(l, { key: k, session: s('w'), by: 'você, na aba' });
  assert.equal(l.nodes[k].card.closeFor, null);
  assert.deepEqual(closer.due(l, [s('w')]), [], 'a conversa retomada não fecha de novo');

  const aberta = kid('aberta', null);
  const fechada = kid('fechada', null);
  const dispensada = kid('dispensada', null);
  l.nodes[aberta].card = { ...done };
  l.nodes[fechada].card = { ...done };
  l.nodes[dispensada].card = { ...done, dismissed: true };
  assert.equal(closer.migrate(l, [s('aberta'), s('dispensada')]), true);
  assert.deepEqual([aberta, fechada, dispensada].map((x) => l.nodes[x].card.closeFor), ['s-aberta', null, null]);
  assert.equal(closer.migrate(l, [s('aberta')]), false, 'migra uma vez só');
});

test('a notificação de uma rodada é uma só', () => {
  assert.deepEqual(closer.notice([{ name: 'a', what: 'PR #1 mergeado' }]), { title: 'Sessão terminada fechada', body: 'a: PR #1 mergeado' });
  const many = 'abcdefg'.split('').map((name) => ({ name, what: '' }));
  assert.deepEqual(closer.notice(many), { title: '7 sessões terminadas fechadas', body: 'a, b, c, d, e e mais 2. Estão no histórico do painel.' });
  assert.equal(closer.notice(many.slice(0, 2)).body, 'a, b. Estão no histórico do painel.');
});
