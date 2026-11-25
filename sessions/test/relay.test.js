'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const { Asking, Sent, fromUser, queue, lines, digest, due } = require('../lib/relay');

test('o que o plugin mandou pra uma aba é reconhecido uma vez (espaços não importam) e expira', () => {
  let now = 0;
  const sent = new Sent(() => now);
  sent.note('t', 'sigo  com\no B');
  assert.equal(sent.take('t', 'sigo com o B'), true);
  assert.equal(sent.take('t', 'sigo com o B'), false);
  sent.note('t', 'velha');
  now = 11 * 60 * 1000;
  assert.equal(sent.take('t', 'velha'), false);
});

test('a fila vai pro gerente da sessão, um "terminou o turno" por sessão, e cada linha diz o que houve', () => {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'g', manager: true });
  const a = l.add({ tabId: 'a', parent: g, name: 'TASK#1 api' });
  const b = l.add({ tabId: 'b', parent: g, name: 'front' });
  const c = l.add({ tabId: 'c', parent: g, name: 'docs' });
  assert.equal(queue(l, g, { kind: 'turn' }), false);
  queue(l, a, { kind: 'turn' }, 1);
  queue(l, a, { kind: 'direct', text: 'usa a  v2' }, 2);
  queue(l, a, { kind: 'turn' }, 3);
  queue(l, b, { kind: 'waiting', text: 'Claude needs your permission to use Bash' }, 4);
  queue(l, c, { kind: 'turn' }, 5);
  assert.deepEqual(l.nodes[g].events.map((e) => [e.key, e.kind]), [[a, 'direct'], [a, 'turn'], [b, 'waiting'], [c, 'turn']]);
  const sessions = [
    { id: 'a', title: '● TASK#1 api', status: 'idle', reply: { text: '## Pronto\n**PR** aberto', at: 9 } },
    { id: 'b', title: '● front', status: 'waitingPermission', needsYou: true },
  ];
  assert.deepEqual(lines(l, l.nodes[g].events, sessions), [
    '- O usuário escreveu direto para "TASK#1 api": "usa a v2"',
    '- "TASK#1 api" terminou o turno: "Pronto PR aberto"',
    '- "front" está esperando o usuário na aba: Claude needs your permission to use Bash',
    '- "docs" fechou.',
  ]);
});

test('só acorda o gerente o que pede ação; o resto espera o sessions_list, e o aviso já traz estado, cartão, resposta e PR novo', () => {
  const { classify, sort, markSeen, limits } = require('../lib/relay');
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'g', manager: true });
  const k = (tabId, name) => l.add({ tabId, parent: g, name });
  const a = k('a', 'TASK#1 api');
  const b = k('b', 'front');
  const c = k('c', 'docs');
  const d = k('d', 'roda');
  const e = k('e', 'pr');
  l.nodes[a].card = { state: 'working', headline: 'rodando a suíte' };
  const NOW = 10 * 60 * 1000;
  const ev = (key, kind, at = NOW - limits.settle - 1, extra = {}) => ({ key, kind, at, ...extra });
  const pr = 'https://github.com/o/r/pull/31';
  const sessions = [
    { id: 'a', title: '● TASK#1 api', status: 'idle', reply: { text: 'Suíte verde.', at: 9 } },
    { id: 'b', title: '● front', status: 'waitingPermission', needsYou: true },
    { id: 'd', title: 'roda', status: 'tool' },
    { id: 'e', title: 'pr', status: 'idle', reply: { text: 'PR aberto', links: [{ url: pr }] } },
  ];
  const cls = (x) => classify(l, x, sessions, NOW);
  assert.equal(cls(ev(a, 'turn')), 'wake', 'parada há mais de 2 min');
  assert.equal(cls(ev(a, 'turn', NOW - 1000)), 'wait', 'parou agora: pode voltar a rodar');
  assert.equal(cls(ev(e, 'turn', NOW - 1000)), 'wake', 'PR novo acorda na hora');
  assert.equal(cls(ev(d, 'turn')), 'drop', 'voltou a rodar');
  assert.equal(cls(ev(b, 'turn')), 'passive', 'esperando você na aba');
  assert.equal(cls(ev(c, 'turn')), 'wait', 'sumiu da lista: espera o fechamento confirmado (evento closed)');
  assert.equal(cls(ev('n99', 'turn')), 'drop', 'nó que saiu da árvore');
  assert.equal(cls(ev(a, 'turn', undefined)), 'wake');
  assert.equal(classify(l, ev(a, 'turn'), [{ ...sessions[0], status: 'unknown' }], NOW), 'wake', 'status desconhecido não é rodando');
  assert.equal(cls(ev(a, 'direct')), 'passive');
  assert.equal(cls(ev(b, 'waiting')), 'passive');
  assert.equal(cls(ev(a, 'error')), 'wake');

  const events = [ev(a, 'direct'), ev(a, 'turn'), ev(b, 'waiting'), ev(d, 'turn'), ev(e, 'turn', NOW - 1000), ev(c, 'error', NOW, { text: 'rate_limit' })];
  const { wake, keep, passive } = sort(l, events, sessions, NOW);
  assert.deepEqual(wake.map((x) => x.key), [a, e, c]);
  assert.deepEqual(keep.map((x) => x.kind), ['direct', 'waiting']);
  assert.equal(passive, 2);
  const text = digest(l, wake, sessions, NOW, passive);
  assert.equal(text.split('\n')[0], '[sessions] 3 sessões pedem você (aviso automático do plugin, não é mensagem do usuário):');
  assert.match(text, /- "TASK#1 api" parou há 2 min \(idle, sem agentes\)\.\n  cartão: working "rodando a suíte" → atualize\n  resposta: "Suíte verde\."/);
  assert.match(text, /- "pr" parou há 1 min .*\n  sem cartão → poste um com sessions_card\n  resposta: "PR aberto"\n  PR novo: https:\/\/github\.com\/o\/r\/pull\/31/);
  assert.match(text, /- "docs" parou com erro: rate_limit/);
  assert.match(text, /\n2 novidades sem ação .*sessions_list\./);
  assert.match(text, /"docs" parou com erro: rate_limit\.\n  a aba está fechada/);
  const twice = digest(l, [ev(a, 'error', NOW, { text: 'um' }), ev(a, 'error', NOW, { text: 'dois' })], sessions, NOW, 0, 1);
  assert.equal(twice.split('\n')[0], '[sessions] 1 sessão pede você (aviso automático do plugin, não é mensagem do usuário):');
  assert.match(twice, /- "TASK#1 api" parou com erro: um; parou com erro: dois\./);
  assert.equal((twice.match(/cartão:/g) || []).length, 1);
  assert.match(twice, /1 sessão acabou de parar: aviso se não voltarem a rodar\./);
  markSeen(l, wake, sessions);
  assert.equal(classify(l, ev(e, 'turn', NOW - 1000), sessions, NOW), 'wait', 'o PR já avisado não acorda de novo');
});

test('a fila só vai pro terminal do gerente parado, sem foco, sem pergunta, depois de um silêncio e sem repetir em menos de 5 min', () => {
  const T = 60 * 60 * 1000;
  const node = { events: [{ at: T }], relayedAt: 0 };
  const idle = { kind: 'claude', status: 'idle' };
  assert.equal(due(node, idle, T + 5000), false);
  assert.equal(due(node, idle, T + 11000), true);
  for (const busy of [{ status: 'tool' }, { focused: true }, { needsYou: true }, { hibernated: true }, { exited: true }, { kind: 'shell' }]) {
    assert.equal(due(node, { ...idle, ...busy }, T + 11000), false, JSON.stringify(busy));
  }
  assert.equal(due({ ...node, relayedAt: T }, idle, T + 4 * 60000), false, 'no máximo um aviso a cada 5 min');
  assert.equal(due({ ...node, relayedAt: T }, idle, T + 5 * 60000), true);
  assert.equal(due({ events: [] }, idle, 1e9), false);
});

test('o prompt que chega com as imagens coladas ([Image #N]) ainda é reconhecido como enviado pelo plugin', () => {
  const sent = new Sent(() => 0);
  sent.note('t', 'olha isso');
  assert.equal(sent.take('t', '[Image #1] [Image #2] olha isso'), true);
});

test('o texto que o plugin colou chega no prompt dentro do envelope <pasted_content> do Claude Code e ainda é reconhecido', () => {
  const sent = new Sent(() => 0);
  sent.note('t', 'Corrija o CI do PR #106.\nDepois me avise.');
  assert.equal(sent.take('t', '<pasted_content id="cbef">\nCorrija o CI do PR #106.\nDepois me avise.\n</pasted_content id="cbef">'), true);
});

test('só conta como do usuário o que não veio do plugin nem é aviso de tarefa em segundo plano', () => {
  const sent = new Sent(() => 0);
  sent.note('t', 'pelo gerente');
  assert.equal(fromUser(sent, 't', '<pasted_content id="1">\npelo gerente\n</pasted_content id="1">'), null);
  assert.equal(fromUser(sent, 't', '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>'), null);
  assert.equal(fromUser(sent, 't', '<agent-message from="revisor">\nachei 2 bugs\n</agent-message>'), null);
  assert.equal(fromUser(sent, 't', ''), null);
  sent.expect('Investigue a queda.');
  assert.equal(fromUser(sent, 'nova', 'Investigue a queda.'), null, 'o primeiro prompt de uma aba que ainda abria');
  assert.equal(fromUser(sent, 'outra', 'Investigue a queda.'), 'Investigue a queda.', 'vale uma vez só');
  assert.equal(fromUser(sent, 't', 'merged, reconnected as well'), 'merged, reconnected as well');
  assert.equal(fromUser(sent, 't', 'olha: <pasted_content id="9">\nerro 503\n</pasted_content id="9">'), 'olha: erro 503');
});

test('a pergunta aberta (AskUserQuestion) só fecha quando ela acaba, não quando acaba outra ferramenta; e trava a fila do gerente', () => {
  const asking = new Asking();
  asking.hook('g', 'PreToolUse', { tool_name: 'AskUserQuestion' });
  asking.hook('g', 'PostToolUse', { tool_name: 'Bash' });
  asking.hook('g', 'Notification', { notification_type: 'idle_prompt' });
  assert.equal(asking.has('g'), true);
  assert.equal(due({ events: [{ at: 0 }] }, { kind: 'claude', status: 'idle' }, 1e9, asking.has('g')), false);
  asking.hook('g', 'PostToolUse', { tool_name: 'AskUserQuestion' });
  assert.equal(asking.has('g'), false);
  for (const end of ['PostToolUseFailure', 'Stop', 'UserPromptSubmit', 'SessionEnd']) {
    asking.hook('g', 'PreToolUse', { tool_name: 'AskUserQuestion' });
    asking.hook('g', end, { tool_name: 'AskUserQuestion' });
    assert.equal(asking.has('g'), false, end);
  }
});

test('a fila cheia descarta primeiro as novidades sem ação; "esperando na aba" e "fechou" não se repetem por sessão', () => {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 'g', name: 'g', manager: true });
  const a = l.add({ tabId: 'a', parent: g, name: 'a' });
  const b = l.add({ tabId: 'b', parent: g, name: 'b' });
  queue(l, a, { kind: 'error', text: 'rate_limit' }, 1);
  for (let i = 0; i < 40; i++) queue(l, b, { kind: 'direct', text: `m${i}` }, 2 + i);
  assert.equal(l.nodes[g].events.length, 30);
  assert.equal(l.nodes[g].events[0].kind, 'error', 'o erro sobrevive');
  queue(l, a, { kind: 'waiting', text: 'x' }, 50);
  queue(l, a, { kind: 'waiting', text: 'y' }, 51);
  assert.deepEqual(l.nodes[g].events.filter((e) => e.kind === 'waiting').map((e) => e.text), ['y']);
  queue(l, a, { kind: 'closed' }, 60);
  assert.deepEqual(l.nodes[g].events.filter((e) => e.key === a).map((e) => e.kind), ['closed']);
});

test('o primeiro prompt esperado passa a ser só da aba que abriu', () => {
  const sent = new Sent(() => 0);
  sent.expect('continue');
  sent.claim('nova', 'continue');
  assert.equal(fromUser(sent, 'outra', 'continue'), 'continue', 'outra aba não consome o prompt da nova');
  assert.equal(fromUser(sent, 'nova', 'continue'), null);
});
