'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const { board, detail, panel, stateOf, taskOf } = require('../lib/cards');

const NOW = Date.parse('2026-11-09T12:00:00');
const min = (m) => NOW - m * 60000;

function setup() {
  const l = new Links({}, () => NOW);
  const g = l.add({ tabId: 'g', name: 'gerente', manager: true });
  const kid = (tabId, card) => {
    const k = l.add({ tabId, parent: g, name: tabId });
    l.nodes[k].card = card;
    return k;
  };
  return { l, g, kid };
}

const cols = (b) => Object.fromEntries(b.cols.map((c) => [c.state, c.cards]));

test('quem espera você ganha do cartão; sem cartão, o status ao vivo decide', () => {
  assert.equal(stateOf({ state: 'done' }, { needsYou: true }), 'needs_you');
  assert.equal(stateOf({ state: 'working' }, { status: 'idle' }), 'working');
  assert.equal(stateOf(null, { status: 'tool' }), 'working');
  assert.equal(stateOf(null, { status: 'idle' }), 'done');
  assert.equal(taskOf({ title: 'faz a task#88832', branch: '' }), 'TASK#88832');
});

test('o quadro separa as três colunas: quem espera mais em cima, trabalhando mais recente em cima, feito só de hoje', () => {
  const { l, g, kid } = setup();
  kid('a', { state: 'needs_you', since: min(5) });
  kid('b', { state: 'needs_you', since: min(90) });
  kid('c', { state: 'working', since: min(30) });
  kid('d', { state: 'working', since: min(3) });
  kid('e', { state: 'done', doneAt: min(10) });
  kid('f', { state: 'done', doneAt: NOW - 30 * 3600000 });
  const sessions = ['g', 'a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, title: `TASK#${id.charCodeAt(0)} ${id}`, status: 'ready', cwd: '/home/w/r' }));
  const b = board(l, g, sessions, {}, NOW);
  const c = cols(b);
  assert.deepEqual(c.needs_you.map((x) => x.title), ['b', 'a']);
  assert.deepEqual(c.working.map((x) => x.title), ['d', 'c']);
  assert.deepEqual(c.done.map((x) => x.title), ['e']);
  assert.equal(b.older, 'ontem e antes · 1');
  assert.deepEqual(b.cols.map((x) => x.count), ['2', '2', '1']);
  assert.equal(c.needs_you[0].age, 'há 1 h');
  assert.equal(c.needs_you[1].age, 'há 5 min');
  assert.equal(c.needs_you[0].task, '#98');
  assert.equal(b.folder, '~/r');
  assert.equal(b.total, '6 sessões');
});

test('cartão de comando: enviar para a aba quando ela existe, copiar quando não', () => {
  const { l, g, kid } = setup();
  const a = kid('a', { state: 'needs_you', action: { kind: 'command', text: 'npm test', tabId: 'alvo', options: [] } });
  kid('b', { state: 'needs_you', action: { kind: 'command', text: 'ls', tabId: 'sumiu', options: [] } });
  const sessions = [{ id: 'g' }, { id: 'a', title: 'a' }, { id: 'b', title: 'b' }, { id: 'alvo', title: '● TASK#9 thumb' }];
  const [x, y] = cols(board(l, g, sessions, {}, NOW)).needs_you;
  assert.equal(x.kind, 'command');
  assert.equal(x.canSend, true);
  assert.equal(x.sendLabel, 'Enviar para a aba');
  assert.equal(x.shell, true);
  assert.equal(x.howTo, 'Clique em Enviar → na aba, aperte Enter');
  assert.equal(x.headline, 'Rode na aba TASK#9 thumb.');
  assert.equal(x.acts.send, `send:${a}`);
  assert.equal(x.acts.target, 'focus:alvo');
  assert.equal(y.canSend, false);
  assert.equal(y.where, 'aba fechada');
  assert.equal(y.howTo, 'Copie e cole no terminal');
});

test('comando "!" é pro prompt do Claude: sem "$", e caminhos não quebram no meio', () => {
  const { l, g, kid } = setup();
  kid('a', { state: 'needs_you', action: { kind: 'command', text: '! python3 /tmp/a-b/run.py | jq .', options: [] } });
  const [x] = cols(board(l, g, [{ id: 'g' }, { id: 'a', title: 'a' }], {}, NOW)).needs_you;
  assert.equal(x.shell, false);
  assert.equal(x.howTo, 'Copie e cole no prompt do Claude, depois Enter');
  assert.equal(x.command.replace(/\u2060/g, ''), '! python3 /tmp/a-b/run.py | jq .');
  assert.match(x.command, /python3 \u2060\/\u2060tmp\u2060\/\u2060a\u2060-\u2060b/);
});

test('pergunta com opções vira botões; com áudio, vira a lista de ouvir e escolher', () => {
  const { l, g, kid } = setup();
  kid('a', { state: 'needs_you', headline: 'Sigo?', action: { kind: 'question', text: 'detalhe', options: [{ key: 'A', label: 'sim', recommended: true }, { key: 'B', label: 'não' }] } });
  const v = kid('v', { state: 'needs_you', action: { kind: 'question', text: 'qual voz?', options: [{ key: 'A', label: 'f_01', audio: '/a.mp3' }, { key: 'B', label: 'f_04', audio: '/b.mp3' }] } });
  const sessions = [{ id: 'g' }, { id: 'a', title: 'a', status: 'ready' }, { id: 'v', title: 'v', status: 'ready' }];
  const ui = { picked: { [v]: 1 }, playing: { key: v, id: 'opt:0' } };
  const [q, voice] = cols(board(l, g, sessions, ui, NOW)).needs_you;
  assert.equal(q.headline, 'Sigo?');
  assert.equal(q.context, 'detalhe');
  assert.deepEqual(q.options.map((o) => [o.k, o.label, o.rec]), [['A', 'sim', true], ['B', 'não', false]]);
  assert.equal(q.hasClips, false);
  assert.equal(voice.headline, 'qual voz?');
  assert.equal(voice.hasOptions, false);
  assert.deepEqual(voice.clips.map((c) => [c.label, c.playing, c.picked]), [['f_01', true, false], ['f_04', false, true]]);
  assert.equal(voice.useLabel, 'Usar f_04');
  assert.equal(voice.input, `answer-${v}`);
});

test('sessão num prompt avisa que a resposta vai pro gerente; sem cartão, pede pra ir até a aba', () => {
  const { l, g, kid } = setup();
  kid('a', { state: 'needs_you', action: { kind: 'approve', text: 'aprova?', options: [] } });
  l.add({ tabId: 'p', parent: g, name: 'p' });
  const sessions = [{ id: 'g' }, { id: 'a', title: 'a', status: 'waitingPermission', needsYou: true }, { id: 'p', title: 'p', status: 'waitingAnswer', statusLabel: 'Pergunta', needsYou: true }];
  const c = cols(board(l, g, sessions, {}, NOW)).needs_you;
  const a = c.find((x) => x.title === 'a');
  const p = c.find((x) => x.title === 'p');
  assert.equal(a.prompt, true);
  assert.equal(a.kind, 'approve');
  assert.equal(p.kind, 'wait');
  assert.equal(p.headline, 'Pergunta na aba.');
  assert.equal(p.acts.focus, 'focus:p');
});

test('provas: miniaturas limitadas por coluna, PRs com ci, áudio e log', () => {
  const { l, g, kid } = setup();
  const images = ['x', 'y', 'z'].map((n) => ({ path: `/s/${n}.png`, rel: `proof/${n}.png` }));
  const proof = { images, prs: [{ url: 'https://u', label: 'api #1', ci: 'ok' }], audio: [{ path: '/a.mp3', label: 'demo' }], log: 'ok\nfim' };
  const w = kid('w', { state: 'working', proof });
  kid('d', { state: 'done', doneAt: min(1), proof });
  const sessions = [{ id: 'g' }, { id: 'w', title: 'w', status: 'tool', activity: { lastTool: 'npm test' } }, { id: 'd', title: 'd', status: 'idle' }];
  const c = cols(board(l, g, sessions, {}, NOW));
  const [work] = c.working;
  assert.deepEqual(work.images.map((i) => i.path), ['proof/x.png', 'proof/y.png']);
  assert.equal(work.more, '+1');
  assert.deepEqual(work.prs, [{ label: 'api #1', ci: 'ok', act: `pr:${w}:0` }]);
  assert.equal(work.sounds[0].act, `play:${w}:proof:0`);
  assert.equal(work.hasLog, true);
  assert.equal(work.live, 'npm test');
  assert.equal(c.done[0].images.length, 1);
  assert.equal(c.done[0].more, '+2');
  sessions[1].activity = { ...sessions[1].activity, prompts: 0, touched: ['/var/www/repo/src/a.ts'] };
  const d = detail(l, w, sessions, {}, NOW);
  assert.equal(d.card.images.length, 3);
  assert.equal(d.info.some((i) => i.k === 'Atividade'), false);
  assert.deepEqual(d.touched, ['src/a.ts']);
  assert.deepEqual(d.log, ['ok', 'fim']);
});

test('o painel manda a biblioteca rfw e o título do gerente', () => {
  const { l, g } = setup();
  const p = panel(l, g, [{ id: 'g', title: '▲ gerente' }], 'widget root = Text();', {}, NOW);
  assert.equal(p.title, 'painel · gerente');
  assert.deepEqual(p.rfw, { library: 'widget root = Text();', root: 'root' });
  assert.equal(p.data.cols[0].isEmpty, true);
});

test('o de antes de hoje abre e fecha, e o topo não repete a pasta quando ela é o nome', () => {
  const { l, g, kid } = setup();
  l.nodes[g].name = '~';
  kid('f', { state: 'done', doneAt: NOW - 30 * 3600000 });
  const sessions = [{ id: 'g', title: '▲ ~', cwd: '/home/w' }, { id: 'f', title: 'f', status: 'idle' }];
  let b = board(l, g, sessions, {}, NOW);
  assert.equal(b.folder, '');
  assert.equal(b.older, 'ontem e antes · 1');
  assert.equal(cols(b).done.length, 0);
  b = board(l, g, sessions, { showOld: true }, NOW);
  assert.equal(b.older, 'esconder os de antes de hoje');
  assert.equal(cols(b).done.length, 1);
});

test('a aba pedindo você passa por cima de um cartão velho: vai pra Precisa de você com o pedido da aba', () => {
  const { l, g, kid } = setup();
  kid('p', { state: 'working', headline: 'Rotulando', action: { kind: 'command', text: 'ls', tabId: 'p', options: [] } });
  kid('q', { state: 'done', headline: 'feito' });
  kid('m', { state: 'needs_you', headline: 'Aprova?', action: { kind: 'approve', text: 'Aprova?', options: [] } });
  const sessions = [
    { id: 'g' },
    { id: 'p', title: 'p', status: 'waitingAnswer', needsYou: true },
    { id: 'q', title: 'q', status: 'waitingPermission', needsYou: true },
    { id: 'm', title: 'm', status: 'waitingPermission', needsYou: true },
  ];
  const c = cols(board(l, g, sessions, {}, NOW));
  assert.equal(c.working.length + c.done.length, 0);
  const by = Object.fromEntries(c.needs_you.map((x) => [x.title, x]));
  assert.deepEqual([by.p.kind, by.p.headline, by.p.command], ['wait', 'Pergunta na aba.', '']);
  assert.deepEqual([by.q.kind, by.q.headline], ['wait', 'Permissão na aba.']);
  assert.deepEqual([by.m.kind, by.m.headline, by.m.prompt], ['approve', 'Aprova?', true]);
});

test('a sessão que respondeu à sua resposta volta pra Precisa de você, com a resposta inteira', () => {
  const { l, g, kid } = setup();
  kid('r', { state: 'working', headline: 'Você respondeu: A', answered: { text: 'A: sim', at: 100 } });
  kid('w', { state: 'working', headline: 'Você respondeu: B', answered: { text: 'B', at: 100 } });
  kid('o', { state: 'working', headline: 'Você respondeu: C', answered: { text: 'C', at: 100 } });
  const sessions = [
    { id: 'g' },
    { id: 'r', title: 'r', status: 'idle', reply: { text: '## Feito.\n**Detalhes** em `a.ts`', at: 200 } },
    { id: 'w', title: 'w', status: 'tool', reply: { text: 'parcial', at: 200 } },
    { id: 'o', title: 'o', status: 'ready', reply: { text: 'antiga', at: 50 } },
  ];
  const c = cols(board(l, g, sessions, {}, NOW));
  assert.deepEqual(c.needs_you.map((x) => x.title), ['r']);
  const [r] = c.needs_you;
  assert.deepEqual([r.kind, r.headline, r.reply, r.context], ['reply', 'Respondeu, esperando você.', 'Feito.\nDetalhes em a.ts', 'Você respondeu: A: sim']);
  assert.equal(r.acts.focus, 'focus:r');
  assert.deepEqual(c.working.map((x) => x.title).sort(), ['o', 'w']);
});
