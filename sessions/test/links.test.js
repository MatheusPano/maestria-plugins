'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Links, tinted, bare } = require('../lib/links');
const { sidebar } = require('../lib/tree');

test('tinted troca a cor e o papel da frente em vez de empilhar', () => {
  assert.equal(tinted('a', 'red'), '● [S] a');
  assert.equal(tinted('a', 'red', true), '● [G] a');
  assert.equal(tinted('▲ [G] a', 'red'), '● [S] a');
  assert.equal(tinted('▲▲ a', 'red', true), '● [G] a');
  assert.equal(bare('🟩  b'), 'b');
  assert.equal(bare('[G] solta'), '[G] solta');
});

test('reconcile segue o sessionId quando o tabId muda e esquece o que sumiu há dias', () => {
  let now = 0;
  const l = new Links({}, () => now);
  const root = l.add({ tabId: 't1', name: 'g', manager: true });
  const child = l.add({ tabId: 't2', parent: root, name: 'c' });
  const gone = l.add({ tabId: 't3', parent: child, name: 'x' });
  l.reconcile([{ id: 't1', sessionId: 's1' }, { id: 't2', sessionId: 's2' }]);
  assert.equal(l.nodes[root].sessionId, 's1');
  now = 1000;
  l.reconcile([{ id: 'novo1', sessionId: 's1' }, { id: 'novo2', sessionId: 's2' }]);
  assert.equal(l.nodes[root].tabId, 'novo1');
  assert.equal(l.nodes[child].tabId, 'novo2');
  assert.ok(l.nodes[gone]);
  now = 4 * 24 * 3600 * 1000;
  l.reconcile([{ id: 'novo1', sessionId: 's1' }, { id: 'novo2', sessionId: 's2' }]);
  assert.equal(l.nodes[gone], undefined);
});

test('depois do /clear a aba ganha outro sessionId e o nó segue a aba; se a conversa antiga está noutra aba, o nó vai com ela', () => {
  let now = 0;
  const l = new Links({}, () => now);
  const k = l.add({ tabId: 't1', name: 'g' });
  const other = l.add({ tabId: 't9', name: 'o' });
  l.reconcile([{ id: 't1', sessionId: 's1', cwd: '/r' }, { id: 't9', sessionId: 's9' }]);
  now = 10;
  l.reconcile([{ id: 't1', sessionId: 's2', cwd: '/r' }, { id: 't9', sessionId: 's9' }]);
  assert.deepEqual([l.nodes[k].tabId, l.nodes[k].sessionId, l.nodes[k].seenAt, l.nodes[k].cwd], ['t1', 's2', 10, '/r']);
  l.reconcile([{ id: 't1', sessionId: 's9' }, { id: 't2', sessionId: 's2' }]);
  assert.equal(l.nodes[k].tabId, 't2');
  assert.equal(l.nodes[other].sessionId, 's9');
});

test('reconcile só pede pra salvar quando algo muda (ou o visto ficou velho), não a cada evento', () => {
  let now = 0;
  const l = new Links({}, () => now);
  l.add({ tabId: 't1', name: 'g' });
  assert.equal(l.reconcile([{ id: 't1', sessionId: 's1', cwd: '/r' }]), true);
  now = 1000;
  assert.equal(l.reconcile([{ id: 't1', sessionId: 's1', cwd: '/r' }]), false);
  now = 2 * 3600 * 1000;
  assert.equal(l.reconcile([{ id: 't1', sessionId: 's1', cwd: '/r' }]), true);
});

test('a lateral põe quem precisa de você primeiro, com o pedido do cartão, e dobra as prontas', () => {
  const now = 10 * 60000;
  const l = new Links({}, () => 0);
  const root = l.add({ tabId: 't1', name: 'gerente', manager: true });
  const done = l.add({ tabId: 't4', parent: root, name: 'pronto' });
  const work = l.add({ tabId: 't3', parent: root, name: 'trabalha' });
  const ask = l.add({ tabId: 't2', parent: root, name: 'pergunta' });
  l.nodes[done].card = { state: 'done', headline: 'feito', doneAt: 0 };
  l.nodes[work].card = { state: 'working', since: 0 };
  l.nodes[ask].card = { state: 'needs_you', headline: 'Aprova as telas?', since: 4 * 60000 };
  const sessions = [
    { id: 't1', title: '● gerente', status: 'working', statusLabel: 'pensando' },
    { id: 't2', title: '● TASK#2 pergunta', status: 'ready', needsYou: true },
    { id: 't3', title: '● trabalha', status: 'tool', activity: { lastTool: 'npm test' } },
    { id: 't4', title: '● pronto', status: 'idle' },
  ];
  let { blocks, badge } = sidebar(l, sessions, {}, now);
  let items = blocks[1].items;
  assert.deepEqual(items.map((i) => [i.title, i.indent]), [['gerente', 0], ['TASK#2 pergunta', 1], ['trabalha', 1], ['1 pronta', 1]]);
  assert.equal(items[0].subtitle, '1 precisa de você · 1 trabalhando · 1 pronta');
  assert.equal(items[0].avatar.color, '#E5534B');
  assert.deepEqual([items[1].subtitle, items[1].avatar.color, items[1].meta, items[1].metaTone], ['Aprova as telas?', 'red', '6 min', 'red']);
  assert.deepEqual([items[2].subtitle, items[2].avatar.color], ['npm test', 'yellow']);
  assert.equal(items[1].action, 'focus:t2');
  assert.equal(items[3].action, `fold:${root}`);
  assert.equal(badge, '1');
  sessions[2] = { ...sessions[2], status: 'waitingAnswer', needsYou: true };
  assert.equal(sidebar(l, sessions, {}, now).blocks[1].items.find((i) => i.title === 'trabalha').subtitle, 'Pergunta na aba.');
  l.nodes[work].card = { state: 'working', since: 0, answered: { text: 'x', at: 60000 } };
  sessions[2] = { ...sessions[2], status: 'idle', needsYou: false, reply: { text: '\nTudo pronto.\nmais', at: 9 * 60000 } };
  const replied = sidebar(l, sessions, {}, now).blocks[1].items.find((i) => i.title === 'trabalha');
  assert.deepEqual([replied.subtitle, replied.meta, replied.avatar.color], ['Respondeu: Tudo pronto.', '1 min', 'red']);
  l.nodes[work].card = { state: 'working', since: 0 };
  sessions[2] = { ...sessions[2], status: 'tool', reply: undefined };
  items = sidebar(l, sessions, { unfolded: { [root]: true } }, now).blocks[1].items;
  assert.deepEqual(items.map((i) => i.title), ['gerente', 'TASK#2 pergunta', 'trabalha', 'pronto', 'esconder as prontas']);
});

test('a árvore recua cada nível e um sub-gerente vem antes das sessões', () => {
  const l = new Links({}, () => 0);
  const r = l.add({ tabId: 'a', name: 'g', manager: true });
  const c1 = l.add({ tabId: 'b', parent: r, name: 'c1' });
  l.add({ tabId: 'c', parent: c1, name: 'n1' });
  l.add({ tabId: 'd', parent: r, name: 'c2' });
  const live = ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id, status: 'tool' }));
  const items = sidebar(l, live).blocks[1].items;
  assert.deepEqual(items.map((i) => [i.title, i.indent]), [['a', 0], ['b', 1], ['c', 2], ['d', 1]]);
  assert.equal(items[1].strong, true);
});

test('as sessões soltas aparecem embaixo com tornar gerente e ligar a um gerente', () => {
  const l = new Links({}, () => 0);
  const r = l.add({ tabId: 'a', name: 'g', manager: true });
  const { blocks } = sidebar(l, [{ id: 'a', kind: 'claude', title: 'g' }, { id: 'x', kind: 'claude', title: 'solta' }, { id: 'sh', kind: 'shell', title: 'sh' }]);
  assert.equal(blocks[2].type, 'section');
  const [solta] = blocks[3].items;
  assert.equal(solta.title, 'solta');
  assert.equal(solta.menu[0].action, 'manager:x');
  assert.deepEqual(solta.menu[1].children.map((c) => c.action), [`link:${r}:x`]);
});

test('link move a subárvore pra cor do novo pai e recusa ciclo; promote dá cor nova; remove sobe os filhos', () => {
  const l = new Links({}, () => 0);
  const red = l.add({ tabId: 'a', name: 'r', manager: true });
  const blue = l.add({ tabId: 'b', name: 'b', manager: true });
  const kid = l.add({ tabId: 'k', parent: blue, name: 'k' });
  const grand = l.add({ tabId: 'g', parent: kid, name: 'g' });
  l.link('k', red);
  assert.equal(l.nodes[kid].parent, red);
  assert.equal(l.nodes[grand].color, 'red');
  assert.throws(() => l.link('a', grand), /ciclo/);
  l.promote(kid);
  assert.equal(l.nodes[kid].parent, null);
  assert.notEqual(l.nodes[kid].color, 'red');
  assert.equal(l.nodes[grand].color, l.nodes[kid].color);
  l.remove(kid);
  assert.equal(l.nodes[grand].parent, null);
  const fresh = l.link('novo', red, 'novo');
  assert.equal(l.nodes[fresh].color, 'red');
});

test('gerente leva [G] e sessão [S]; retitles só pede o que perdeu a marca e mantém o nome que a aba tem', () => {
  const l = new Links({}, () => 1);
  const g = l.add({ tabId: 'g', name: 'coord', manager: true });
  l.add({ tabId: 'a', parent: g, name: 'a' });
  l.add({ tabId: 'b', parent: g, name: 'b' });
  const mark = tinted('x', l.nodes[g].color).split(' ')[0];
  const sessions = [
    { id: 'g', title: `${mark} renomeado` },
    { id: 'a', title: `${mark} [S] a` },
    { id: 'b', title: 'b sem marca' },
  ];
  assert.deepEqual(l.retitles(sessions), [
    { tabId: 'g', title: `${mark} [G] renomeado` },
    { tabId: 'b', title: `${mark} [S] b sem marca` },
  ]);
  assert.equal(bare(`${mark}${mark} renomeado`), 'renomeado');
});

test('um título que é só a pasta (a aba retomada na mão) volta ao nome do nó, com a marca', () => {
  const l = new Links({}, () => 0);
  const g = l.add({ tabId: 't1', name: 'tarefas', manager: true });
  const mark = (name) => tinted(name, l.nodes[g].color, true);
  assert.deepEqual(l.retitles([{ id: 't1', title: '~', cwd: '/home/u' }, { id: 't2', title: 'x' }]), [{ tabId: 't1', title: mark('tarefas') }]);
  assert.deepEqual(l.retitles([{ id: 't1', title: 'repo', cwd: '/srv/repo' }]), [{ tabId: 't1', title: mark('tarefas') }]);
  assert.deepEqual(l.retitles([{ id: 't1', title: 'outro nome', cwd: '/srv/repo' }]), [{ tabId: 't1', title: mark('outro nome') }]);
});

test('gerente com a aba fechada diz "fechada" e o clique retoma a conversa; sessão fechada também retoma', () => {
  const l = new Links({}, () => 0);
  const r = l.add({ tabId: 'velha', name: 'tarefas', manager: true });
  const kid = l.add({ tabId: 'k', parent: r, name: 'filha' });
  const gone = l.add({ tabId: 'sumiu', parent: r, name: 'fechou' });
  l.nodes[gone].card = { state: 'needs_you', headline: 'merge o PR' };
  const items = sidebar(l, [{ id: 'k', title: 'filha', status: 'tool' }]).blocks[1].items;
  const [boss, closed, live] = items;
  assert.deepEqual([boss.title, boss.subtitle, boss.action, boss.menu[0].action], ['tarefas', 'fechada · 1 precisa de você · 1 trabalhando', `resume:${r}`, `resume:${r}`]);
  assert.deepEqual([closed.title, closed.action, closed.menu.map((m) => m.action)], ['fechou', `resume:${gone}`, [`resume:${gone}`, `forget:${gone}`]]);
  assert.equal(live.action, 'focus:k');
  assert.ok(kid);
});
