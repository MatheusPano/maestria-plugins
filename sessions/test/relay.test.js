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
  const text = digest(l, l.nodes[g].events, sessions);
  assert.match(text, /^\[sessions\] Novidades/);
  assert.match(text, /de quem é a vez\.$/);
});

test('a fila só vai pro terminal do gerente parado, sem foco, sem pergunta, depois de um silêncio e sem repetir em menos de um minuto', () => {
  const node = { events: [{ at: 1000 }], relayedAt: 0 };
  const idle = { kind: 'claude', status: 'idle' };
  assert.equal(due(node, idle, 1000 + 5000), false);
  assert.equal(due(node, idle, 1000 + 61000), true);
  for (const busy of [{ status: 'tool' }, { focused: true }, { needsYou: true }, { hibernated: true }, { exited: true }, { kind: 'shell' }]) {
    assert.equal(due(node, { ...idle, ...busy }, 1000 + 61000), false, JSON.stringify(busy));
  }
  assert.equal(due({ ...node, relayedAt: 1000 + 30000 }, idle, 1000 + 61000), false);
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
  assert.equal(fromUser(sent, 't', ''), null);
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
