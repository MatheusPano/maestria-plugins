'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links } = require('../lib/links');
const { ALL, board, detail, managers, panel, stateOf, taskOf } = require('../lib/cards');

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
  assert.equal(stateOf({ state: 'working', at: NOW }, { status: 'idle' }, NOW), 'working');
  assert.equal(stateOf(null, { status: 'tool' }), 'working');
  assert.equal(stateOf(null, { status: 'idle' }), 'done');
  assert.equal(taskOf({ title: 'faz a task#88832', branch: '' }), 'TASK#88832');
});

test('sessão hibernada, encerrada ou fechada não está trabalhando; cartão "working" dela vira interrompida; dispensado fica em Feito mesmo rodando', () => {
  assert.equal(stateOf(null, { status: 'ended', hibernated: true }), 'done');
  assert.equal(stateOf({ state: 'done' }, { status: 'ended', hibernated: true }), 'done');
  assert.equal(stateOf({ state: 'done' }, { status: 'tool', hibernated: true }), 'done');
  assert.equal(stateOf({ state: 'working', busy: true }, { status: 'ended' }), 'needs_you');
  assert.equal(stateOf({ state: 'working', busy: true }, null), 'needs_you');
  assert.equal(stateOf({ state: 'working', busy: true }, { status: 'idle', hibernated: true }), 'needs_you');
  assert.equal(stateOf({ state: 'working' }, { status: 'idle', hibernated: true }), 'done');
  assert.equal(stateOf({ state: 'working' }, null), 'done');
  assert.equal(stateOf({ state: 'needs_you' }, null), 'needs_you');
  assert.equal(stateOf({ state: 'done' }, { status: 'tool' }), 'working');
  assert.equal(stateOf({ state: 'done', dismissed: true }, { status: 'tool' }), 'done');
});

test('o quadro separa as três colunas (precisa de você: quem espera há mais tempo primeiro), feito só de hoje', () => {
  const { l, g, kid } = setup();
  kid('a', { state: 'needs_you', since: min(5) });
  kid('b', { state: 'needs_you', since: min(90) });
  kid('c', { state: 'working', since: min(30), at: min(1) });
  kid('d', { state: 'working', since: min(3), at: min(1) });
  kid('e', { state: 'done', doneAt: min(10) });
  kid('f', { state: 'done', doneAt: NOW - 30 * 3600000 });
  const sessions = ['g', 'a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, title: `TASK#${id.charCodeAt(0)} ${id}`, status: 'ready', cwd: '/home/w/r' }));
  const b = board(l, g, sessions, {}, NOW);
  const c = cols(b);
  assert.deepEqual(c.needs_you.map((x) => x.title), ['b', 'a']);
  assert.deepEqual(c.needs_you.map((x) => x.waiting), ['espera você há 1 h', 'espera você há 5 min']);
  assert.deepEqual(c.working.map((x) => x.title), ['d', 'c']);
  assert.deepEqual(c.done.map((x) => x.title), ['e']);
  assert.equal(b.older, 'ontem e antes · 1');
  assert.deepEqual(b.cols.map((x) => x.count), ['2', '2', '1']);
  assert.equal(c.needs_you[1].age, 'há 5 min');
  assert.equal(c.needs_you[0].age, 'há 1 h');
  assert.equal(c.needs_you[1].task, '#97');
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
  kid('o', { state: 'working', headline: 'Você respondeu: C', answered: { text: 'C', at: min(1) } });
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

test('cada cartão tem a sua caixa de resposta, e limpar uma não limpa as outras', () => {
  const { l, g, kid } = setup();
  const a = kid('a', { state: 'working', answered: { text: 'x', at: 1 } });
  kid('b', { state: 'working', answered: { text: 'y', at: 1 } });
  const sessions = [{ id: 'g' }, { id: 'a', title: 'a', status: 'idle', reply: { text: 'ra', at: 2 } }, { id: 'b', title: 'b', status: 'ready', reply: { text: 'rb', at: 2 } }];
  const ui = { picked: {}, rejecting: {}, clears: { [a]: 3 }, open: {}, playing: null };
  const c = cols(board(l, g, sessions, ui, NOW)).needs_you;
  assert.deepEqual(c.map((x) => x.kind), ['reply', 'reply']);
  assert.notEqual(c[0].input, c[1].input);
  assert.ok(c.every((x) => x.input === `answer-${x.key}`));
  assert.deepEqual(Object.fromEntries(c.map((x) => [x.title, x.clear])), { a: 3, b: 0 });
});

test('responder um cartão do meio não o tira do lugar; quem espera há mais tempo vem primeiro', () => {
  const { l, g, kid } = setup();
  const ks = ['a', 'b', 'c'].map((t) => kid(t, { state: 'working', since: min(30) }));
  const ses = (over = {}) => [{ id: 'g' }, ...['a', 'b', 'c'].map((id) => ({ id, title: id, status: 'tool', ...over[id] }))];
  const order = (b) => Object.fromEntries(b.cols.map((x) => [x.state, x.cards.map((y) => y.title)]));
  assert.deepEqual(order(board(l, g, ses(), {}, NOW)).working, ['c', 'b', 'a']);
  l.nodes[ks[1]].card = { ...l.nodes[ks[1]].card, since: NOW, answered: { text: 'ok', at: NOW } };
  assert.deepEqual(order(board(l, g, ses(), {}, NOW)).working, ['c', 'b', 'a']);
  for (const k of ks) l.nodes[k].card = { state: 'working', since: NOW - 1000, answered: { text: 'ok', at: NOW - 1000 } };
  const replied = { a: { status: 'idle', reply: { text: 'r', at: NOW } }, b: { status: 'idle', reply: { text: 'r', at: NOW - 600 } }, c: { status: 'idle', reply: { text: 'r', at: NOW - 900 } } };
  assert.deepEqual(order(board(l, g, ses(replied), {}, NOW)).needs_you, ['c', 'b', 'a']);
});

test('resposta longa: o cartão mostra o começo e oferece a inteira no cartão aberto', () => {
  const { l, g, kid } = setup();
  kid('a', { state: 'working', answered: { text: 'x', at: 1 } });
  kid('b', { state: 'working', answered: { text: 'y', at: 1 } });
  kid('c', { state: 'working', answered: { text: 'z', at: 1 } });
  const sessions = [
    { id: 'g' },
    { id: 'a', title: 'a', status: 'idle', reply: { text: 'l\n'.repeat(12), at: 2 } },
    { id: 'b', title: 'b', status: 'idle', reply: { text: 'curta', at: 2 } },
    { id: 'c', title: 'c', status: 'idle', reply: { text: 'palavra '.repeat(50), at: 2 } },
  ];
  const by = Object.fromEntries(cols(board(l, g, sessions, {}, NOW)).needs_you.map((x) => [x.title, x]));
  assert.deepEqual([by.a.replyLong, by.b.replyLong, by.c.replyLong], [true, false, true]);
  assert.equal(by.a.acts.detail, `detail:${by.a.key}`);
});

test('cartão "trabalhando" cuja sessão parou depois dele vai pra Precisa de você; o que o gerente escreveu depois fica', () => {
  const { l, g, kid } = setup();
  kid('s', { state: 'working', headline: 'rodando a suíte', at: 100 });
  kid('p', { state: 'working', headline: 'pausada: esperando a NinePay', at: min(2) });
  const sessions = [
    { id: 'g' },
    { id: 's', title: 's', status: 'idle', reply: { text: 'suíte verde', at: 200 } },
    { id: 'p', title: 'p', status: 'idle', reply: { text: 'parei', at: 200 } },
  ];
  const c = cols(board(l, g, sessions, {}, NOW));
  assert.deepEqual(c.needs_you.map((x) => [x.title, x.kind, x.headline, x.context, x.reply, x.badge]), [['s', 'reply', 'Parou, esperando você.', 'rodando a suíte', 'suíte verde', 'respondeu']]);
  assert.deepEqual(c.working.map((x) => x.title), ['p']);
});

test('todo cartão com sessão viva tem caixa de mensagem; o feito só abre a caixa quando pedida; o topo fala com o gerente', () => {
  const { l, g, kid } = setup();
  const w = kid('w', { state: 'working', at: 1 });
  kid('q', { state: 'needs_you', action: { kind: 'question', text: 'sigo?' }, at: 1 });
  const d = kid('d', { state: 'done', at: 1, doneAt: NOW });
  kid('x', { state: 'working', at: NOW });
  const sessions = [{ id: 'g', title: 'g' }, { id: 'w', title: 'w', status: 'tool' }, { id: 'q', title: 'q', status: 'idle' }, { id: 'd', title: 'd', status: 'idle' }];
  const ui = { writing: { [d]: true } };
  const b = board(l, g, sessions, ui, NOW);
  const all = Object.fromEntries(b.cols.flatMap((c) => c.cards).map((c) => [c.title, c]));
  assert.deepEqual(['w', 'q', 'd', 'x'].map((t) => all[t].canMessage), [true, false, true, false]);
  assert.deepEqual([all.w.writing, all.d.writing], [false, true]);
  const closeOf = (s) => board(l, g, [sessions[0], { id: 'd', title: 'd', ...s }], {}, NOW).cols.flatMap((c) => c.cards).find((c) => c.title === 'd').canClose;
  assert.deepEqual(
    [{ status: 'idle' }, { status: 'unknown' }, { status: 'idle', backgroundAgents: 1 }, { status: 'working', hibernated: true }].map(closeOf),
    [true, false, false, true],
    'fechar a aba só aparece quando o fechamento vai passar',
  );
  assert.equal(all.w.acts.write, `write:${w}`);
  assert.deepEqual([b.canTell, b.tell.input, b.tell.act], [true, `tell-${g}`, `tell:${g}`]);
  assert.equal(board(l, g, sessions.slice(1), {}, NOW).canTell, false);
});

test('todas: cada conversa do Claude aberta, com ou sem gerente, classificada; terminal e aba fechada ficam de fora', () => {
  const { l, g, kid } = setup();
  kid('w', { state: 'working', headline: 'rodando', at: NOW });
  const sessions = [
    { id: 'g', kind: 'claude', title: 'g', status: 'idle', reply: { text: 'coordenando', at: NOW } },
    { id: 'w', kind: 'claude', title: 'w', status: 'tool' },
    { id: 'p', kind: 'claude', title: 'pergunta', status: 'waitingAnswer', needsYou: true },
    { id: 'f', kind: 'claude', title: 'feita', status: 'idle', reply: { text: '## Pronto\nPR aberto', at: NOW } },
    { id: 'v', kind: 'claude', title: 'vazia', status: 'ready' },
    { id: 'sh', kind: 'shell', title: 'zsh', status: 'unknown' },
    { id: 'x', kind: 'claude', title: 'fechada', status: 'idle', exited: true },
  ];
  const b = board(l, ALL, sessions, {}, NOW);
  const c = cols(b);
  assert.deepEqual(c.needs_you.map((x) => x.title), ['pergunta']);
  assert.deepEqual(c.working.map((x) => x.title), ['w']);
  assert.deepEqual(c.done.map((x) => x.title), ['g', 'feita']);
  assert.equal(b.older, 'ontem e antes · 1');
  const feita = c.done.find((x) => x.title === 'feita');
  assert.deepEqual([feita.key, feita.headline, feita.color, feita.acts.detail, feita.canMessage], ['@f', 'Pronto', 0xff8b8b8b, 'focus:f', true]);
  assert.deepEqual([b.name, b.canTell, b.managerTab], ['todas as sessões', false, '']);
  const chips = managers(l, sessions, ALL);
  assert.deepEqual(chips.map((m) => [m.name, m.active, m.waiting]), [['todas', true, '1'], ['gerente', false, '']]);
  assert.equal(panel(l, ALL, sessions, 'lib', {}, NOW).data.hasSwitch, true);
});

test('todas: o gerente vira conversa direta (sem cartão), o cartão de aba fechada aparece, aba nunca usada dobra', () => {
  const { l, g, kid } = setup();
  kid('gone', { state: 'needs_you', headline: 'aprova o deploy?', at: NOW });
  const sessions = [
    { id: 'g', kind: 'claude', title: 'g', status: 'tool' },
    { id: 'nova', kind: 'claude', title: 'nova', status: 'ready' },
    { id: 'usada', kind: 'claude', title: 'usada', status: 'idle', activity: { lastPrompt: 'faz x' } },
  ];
  const c = cols(board(l, ALL, sessions, {}, NOW));
  const gc = c.working.find((x) => x.title === 'g');
  assert.deepEqual([gc.key, gc.acts.detail, gc.acts.message, gc.color === 0xff8b8b8b], ['@g', 'focus:g', 'message:@g', false]);
  assert.deepEqual(c.needs_you.map((x) => [x.title, x.closed]), [['gone', true]]);
  assert.deepEqual(c.done.map((x) => [x.title, x.age]), [['usada', '']]);
  assert.equal(managers(l, sessions, ALL)[0].waiting, '1');
});

test('cartão "feito" de uma sessão que voltou a rodar aparece em Trabalhando', () => {
  assert.equal(stateOf({ state: 'done' }, { status: 'working' }), 'working');
  assert.equal(stateOf({ state: 'done' }, { status: 'tool' }), 'working');
  assert.equal(stateOf({ state: 'done' }, { status: 'idle' }), 'done');
  assert.equal(stateOf({ state: 'done' }, null), 'done');
  assert.equal(stateOf({ state: 'needs_you' }, { status: 'tool' }), 'needs_you');
  const { l, g, kid } = setup();
  kid('w', { state: 'done', headline: 'PR aberto', at: NOW, doneAt: NOW });
  const c = cols(board(l, g, [{ id: 'g' }, { id: 'w', title: 'w', status: 'tool', activity: { lastTool: 'Bash npm test' } }], {}, NOW));
  assert.deepEqual(c.working.map((x) => [x.title, x.hasLive]), [['w', true]]);
  assert.equal(c.done.length, 0);
});

test('comando que é só um link vira link: sem "$", sem enviar para a aba, com o verbo browse', () => {
  const links = new Links();
  const g = links.add({ tabId: 'g', name: 'g', manager: true });
  const w = links.add({ tabId: 'w', name: 'w', parent: g });
  links.nodes[w].card = { state: 'needs_you', headline: 'abra o PR', action: { kind: 'command', text: 'https://github.com/a/b/pull/1', tabId: 'w' }, at: 1 };
  const sessions = [{ id: 'g', kind: 'claude', title: 'g', status: 'idle' }, { id: 'w', kind: 'claude', title: 'w', status: 'idle' }];
  const c = board(links, g, sessions, { picked: {}, rejecting: {}, clears: {}, open: {}, writing: {} }).cols[0].cards[0];
  assert.deepEqual([c.link, c.shell, c.canSend, c.acts.link], [true, false, false, `browse:${w}`]);
});

test('o cartão mostra a branch da sessão e os PRs achados no transcript, sem repetir o que o gerente postou', () => {
  const links = new Links();
  const g = links.add({ tabId: 'g', name: 'g', manager: true });
  const w = links.add({ tabId: 'w', name: 'w', parent: g });
  links.nodes[w].card = { state: 'working', headline: 'x', at: 1, proof: { images: [], audio: [], log: '', prs: [{ url: 'https://github.com/a/b/pull/1', label: 'b#1', ci: 'ok' }] } };
  const reply = { text: 'pronto', at: 5, links: [{ url: 'https://github.com/a/b/pull/1', label: 'PR #1 · b' }, { url: 'https://github.com/a/c/pull/2', label: 'PR #2 · c' }] };
  const sessions = [{ id: 'g', kind: 'claude', title: 'g', status: 'idle' }, { id: 'w', kind: 'claude', title: 'w', status: 'idle', branch: 'feature/TASK#1', reply }];
  const c = board(links, g, sessions, { picked: {}, rejecting: {}, clears: {}, open: {}, writing: {} }).cols[0].cards[0];
  assert.equal(c.branch, 'feature/TASK#1');
  assert.deepEqual(c.prs.map((p) => [p.label, p.act]), [['b#1', `pr:${w}:0`], ['PR #2 · c', 'url:w:1']]);
});

test('agente em segundo plano é trabalho, não "precisa de você"; numa pergunta, a pergunta ganha', () => {
  const { stateOf, agentsOf, behind } = require('../lib/cards');
  const s = { id: 't', status: 'ready', needsYou: true, backgroundAgents: 2, reply: { text: 'feito', at: 9 } };
  assert.equal(agentsOf(s), 2);
  assert.equal(stateOf({ state: 'working', at: 1 }, s), 'working');
  assert.equal(stateOf({ state: 'working', at: 1, dismissed: true }, s), 'done');
  assert.equal(stateOf(null, { ...s, status: 'waitingPermission' }), 'needs_you');
  assert.equal(agentsOf({ ...s, hibernated: true }), 0);
  assert.equal(behind(1), 'rodando em segundo plano (1 agente)');
});

test('cartão pedindo você (com ação) continua em "precisa de você" mesmo com agente em segundo plano', () => {
  const { stateOf } = require('../lib/cards');
  const s = { id: 't', status: 'ready', backgroundAgents: 1 };
  assert.equal(stateOf({ state: 'needs_you', action: { kind: 'approve', text: 'ok?' } }, s), 'needs_you');
});

test('depois que você escreve para a sessão, o cartão fica em Trabalhando com o que você escreveu, a hora e de quem é a vez', () => {
  const { l, g, kid } = setup();
  kid('m', { state: 'working', headline: 'Você escreveu: merged, reconnected as well', since: min(3), answered: { text: 'merged, reconnected as well', at: min(3), message: true } });
  const [m] = cols(board(l, g, [{ id: 'g' }, { id: 'm', title: 'm', status: 'tool' }], {}, NOW)).working;
  assert.equal(m.headline, 'Você escreveu: merged, reconnected as well');
  assert.equal(m.context, 'Enviada às 11:57: a vez é da sessão.');
  assert.equal(m.age, 'desde 11:57');
});

test('a resposta que foi para o gerente (a aba estava num prompt) não diz que a vez é da sessão', () => {
  const { l, g, kid } = setup();
  kid('p', { state: 'working', headline: 'Você respondeu: sim', answered: { text: 'sim', at: min(2), via: 'manager' } });
  const [p] = cols(board(l, g, [{ id: 'g' }, { id: 'p', title: 'p', status: 'tool' }], {}, NOW)).working;
  assert.equal(p.context, 'Enviada às 11:58 para o gerente: a aba estava num prompt.');
});

test('cartão "working" com a aba parada há mais de 3 min vira "parou?", com a última resposta e o cartão como contexto', () => {
  const { l, g, kid } = setup();
  kid('p', { state: 'working', headline: 'pausada: esperando a NinePay', at: min(10) });
  kid('q', { state: 'working', headline: 'quase', at: min(2) });
  const sessions = [
    { id: 'g' },
    { id: 'p', title: 'p', status: 'idle', reply: { text: 'preciso do acesso ao DNS', at: min(12) } },
    { id: 'q', title: 'q', status: 'idle', reply: { text: 'x', at: min(12) } },
  ];
  const c = cols(board(l, g, sessions, {}, NOW));
  assert.deepEqual(c.needs_you.map((x) => [x.title, x.badge, x.kind, x.headline, x.context, x.reply]), [
    ['p', 'parou?', 'reply', 'Parada há 10 min, mas o cartão dizia que estava trabalhando.', 'No cartão: pausada: esperando a NinePay', 'preciso do acesso ao DNS'],
  ]);
  assert.deepEqual(c.working.map((x) => [x.title, x.badge]), [['q', '']]);
});

test('cartão "working" de aba que hibernou, encerrou ou fechou no meio de um turno vira "interrompida", com retomar; fora de um turno vai para Feito', () => {
  const { l, g, kid } = setup();
  const h = kid('h', { state: 'working', headline: 'gerando capas', at: min(1), busy: true });
  const f = kid('f', { state: 'working', headline: 'rodando build', at: min(1), busy: true });
  kid('e', { state: 'working', at: min(1), busy: true });
  kid('q', { state: 'working', at: min(1), busy: false });
  const sessions = [
    { id: 'g' },
    { id: 'h', title: 'h', status: 'idle', hibernated: true, exited: true },
    { id: 'e', title: 'e', status: 'ended' },
    { id: 'q', title: 'q', status: 'idle', hibernated: true, exited: true },
  ];
  const c = cols(board(l, g, sessions, {}, NOW));
  const by = Object.fromEntries(c.needs_you.map((x) => [x.title, x]));
  assert.deepEqual([by.h.badge, by.h.kind, by.h.headline, by.h.context, by.h.acts.resume], ['interrompida', 'resume', 'A aba hibernou no meio do trabalho.', 'No cartão: gerando capas', 'focus:h']);
  assert.deepEqual([by.f.headline, by.f.acts.resume], ['A aba fechou no meio do trabalho.', `resume:${f}`]);
  assert.equal(by.e.headline, 'A sessão encerrou no meio do trabalho.');
  assert.deepEqual(c.done.map((x) => x.title), ['q']);
  assert.ok(h);
});

test('o selo diz por que o cartão está na coluna: rodando, agentes, na aba, decisão', () => {
  const { l, g, kid } = setup();
  kid('r', { state: 'working', at: NOW });
  kid('a', { state: 'working', at: NOW });
  kid('d', { state: 'needs_you', action: { kind: 'approve', text: 'merge?' }, at: NOW });
  kid('n', null);
  const sessions = [
    { id: 'g' },
    { id: 'r', title: 'r', status: 'tool' },
    { id: 'a', title: 'a', status: 'idle', backgroundAgents: 2 },
    { id: 'd', title: 'd', status: 'idle' },
    { id: 'n', title: 'n', status: 'waitingPermission', needsYou: true },
  ];
  const all = Object.fromEntries(board(l, g, sessions, {}, NOW).cols.flatMap((c) => c.cards).map((c) => [c.title, [c.badge, c.badgeTone]]));
  assert.deepEqual(all, { r: ['rodando', 'accent'], a: ['agentes', 'accent'], d: ['decisão', 'red'], n: ['na aba', 'red'] });
});

test('a resposta guardada aparece no cartão, também com a aba no prompt, até ir para a aba', () => {
  const { l, g, kid } = setup();
  const w = kid('w', { state: 'working', headline: 'Você respondeu: A: sim', at: NOW - 60000, answered: { text: 'A: sim', at: NOW - 60000 } });
  const at = new Date(NOW - 60000);
  l.nodes[w].pending = [{ text: 'A: sim', at: at.getTime(), boot: 'b' }, { text: 'e roda os testes', at: NOW, boot: 'b' }];
  const sessions = [{ id: 'g', title: 'g' }, { id: 'w', title: 'w', status: 'waitingPermission', needsYou: true }];
  const card = () => board(l, g, sessions, {}, NOW).cols.flatMap((c) => c.cards).find((c) => c.title === 'w');
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  assert.equal(card().state, 'needs_you');
  assert.equal(card().context, `Resposta guardada (2) às ${hm}: “e roda os testes”. Vai para a aba quando ela sair do prompt.`);
  delete l.nodes[w].pending;
  sessions[1] = { id: 'w', title: 'w', status: 'tool' };
  assert.match(card().context, /^Enviada às \d\d:\d\d: a vez é da sessão\.$/);
});

test('a card the plugin wrote from the last reply shows that reply and its headline, as "respondeu"', () => {
  const { l, g, kid } = setup();
  kid('s', { state: 'needs_you', headline: 'Suite is green', at: min(1), auto: true });
  const sessions = [{ id: 'g' }, { id: 's', title: 's', status: 'idle', reply: { text: 'Suite is green\nAll pass.', at: min(2) } }];
  const c = cols(board(l, g, sessions, {}, NOW));
  assert.deepEqual(c.needs_you.map((x) => [x.kind, x.headline, x.reply, x.badge]), [['reply', 'Suite is green', 'Suite is green\nAll pass.', 'respondeu']]);
});

test('every card has a way to the tab (or to resume it) and a menu with dismiss', () => {
  const { l, g, kid } = setup();
  kid('open', { state: 'needs_you' });
  kid('gone', { state: 'working', busy: true });
  kid('sleepy', { state: 'needs_you', at: NOW });
  const sessions = [{ id: 'g' }, { id: 'open', title: 'open', status: 'idle' }, { id: 'sleepy', title: 'sleepy', status: 'idle', hibernated: true }];
  const all = Object.values(cols(board(l, g, sessions, {}, NOW))).flat();
  const by = Object.fromEntries(all.map((x) => [x.title, x]));
  assert.deepEqual([by.open.acts.go, by.open.goTip], ['focus:open', 'ir para a aba']);
  assert.match(by.gone.acts.go, /^resume:/);
  assert.equal(by.gone.goTip, 'retomar a conversa');
  assert.deepEqual(by.open.menu.map((m) => m.action.split(':')[0]), ['detail', 'dismiss']);
  assert.deepEqual(by.sleepy.menu.map((m) => m.action.split(':')[0]), ['detail', 'dismiss', 'wake']);
  assert.deepEqual(by.gone.menu.map((m) => m.action.split(':')[0]), ['detail', 'dismiss', 'resume']);
});

test('tokens per hour show on the card and on the panel header, for the manager and its sessions', () => {
  const { l, g, kid } = setup();
  kid('a', { state: 'working', at: NOW });
  const sessions = [
    { id: 'g', usage: { perHour: 1800000, context: 130000 } },
    { id: 'a', title: 'a', status: 'tool', usage: { perHour: 340000, context: 90000 } },
  ];
  const b = board(l, g, sessions, { archivable: 2 }, NOW);
  assert.equal(cols(b).working[0].tokens, '340k tokens/h · contexto 90k');
  assert.equal(b.usage, 'gerente 1.8M tokens/h, contexto 130k · sessões 340k tokens/h');
  assert.equal(b.archive, 'arquivar 2 paradas há mais de 3 dias');
});
