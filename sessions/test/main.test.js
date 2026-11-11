'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const handlers = { req: {}, note: {} };
const calls = [];
const queue = {};
const sessions = [
  { id: 'g', kind: 'claude', title: 'g', status: 'idle' },
  { id: 'w', kind: 'claude', title: 'w', status: 'idle', sessionId: null },
];
const fake = {
  request: async (m, p) => {
    calls.push([m, p]);
    if (queue[m] && queue[m].length) return queue[m].shift();
    if (m === 'sessions.list') return sessions;
    if (m === 'view.update' || m === 'view.open') return { open: true };
    return null;
  },
  onRequest: (m, fn) => (handlers.req[m] = fn),
  onNotification: (m, fn) => (handlers.note[m] = fn),
  start() {},
  log() {},
};
const load = Module._load;
Module._load = function (r, parent, ...rest) {
  if (r === './maestria' && parent && parent.filename === path.join(root, 'main.js')) return fake;
  return load.call(this, r, parent, ...rest);
};
require(path.join(root, 'main.js'));
Module._load = load;

const tick = () => new Promise((r) => setTimeout(r, 20));

test('um cartão já respondido (action null) ainda manda a resposta nova pro terminal', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', action: { kind: 'question', text: 'sigo?', options: [{ label: 'sim' }] } } });
  const nodes = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(nodes).find((k) => nodes[k].tabId === 'w');
  const act = (a, extra = {}) => handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a, ...extra } });
  const sent = () => calls.filter(([m]) => m === 'terminal.sendText').map(([, p]) => [p.tabId, p.text]);
  act(`option:${key}:0`);
  await tick();
  const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes[key].card;
  assert.equal(after.action, null);
  assert.equal(after.answered.text, 'A: sim');
  act(`answer:${key}`, { text: '  e agora o backend  ' });
  await tick();
  assert.deepEqual(sent(), [['w', 'A: sim'], ['w', 'e agora o backend']]);
});

test('depois de abrir o painel, os refresh mandam só os dados (o template de novo zera a rolagem)', async () => {
  const panels = () => calls.filter(([m, p]) => (m === 'view.open' || m === 'view.update') && p.viewId === 'painel');
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'working', headline: 'de novo' } });
  await new Promise((r) => setTimeout(r, 400));
  const all = panels();
  const first = all.findIndex(([, p]) => p.rfw);
  assert.ok(first >= 0);
  const later = all.slice(first + 1);
  assert.ok(later.length > 0);
  for (const [, p] of later) {
    assert.equal(p.rfw, undefined);
    assert.ok(p.data);
  }
});

test('a caixa do topo manda direto pro gerente e a do cartão feito abre e fecha', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'done' } });
  const nodes = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const g = Object.keys(nodes).find((k) => nodes[k].tabId === 'g');
  const before = calls.length;
  handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `tell:${g}`, text: '  como está o ceph?  ' } });
  await tick();
  const sent = calls.slice(before).filter(([m]) => m === 'terminal.sendText').map(([, p]) => [p.tabId, p.text, p.submit]);
  assert.deepEqual(sent, [['g', 'como está o ceph?', true]]);
});

test('novo gerente em outra pasta: pede o caminho até ser uma pasta, aceita ~, e abre o painel dele com a caixa de mensagem em foco', async () => {
  const home = os.homedir();
  const sub = fs.mkdtempSync(path.join(home, '.sessions-test-'));
  try {
    queue['folders.list'] = [[{ root: '/var/www/x', name: 'x' }]];
    queue['window.pick'] = [':outra-pasta'];
    queue['window.input'] = ['/nao/existe/mesmo', `~/${path.basename(sub)}`, 'meu gerente'];
    queue['session.openClaude'] = [{ tabId: 'novo' }];
    sessions.push({ id: 'novo', kind: 'claude', title: 'meu gerente', status: 'thinking' });
    const before = calls.length;
    handlers.note['view.action']({ viewId: 'sidebar', action: 'novo' });
    await tick();
    const mine = calls.slice(before);
    const pick = mine.find(([m]) => m === 'window.pick')[1];
    assert.deepEqual(pick.items.map((i) => i.value), ['/var/www/x', ':outra-pasta']);
    assert.ok(mine.some(([m, p]) => m === 'window.showBanner' && p.text === 'não é uma pasta: /nao/existe/mesmo'));
    const open = mine.find(([m]) => m === 'session.openClaude')[1];
    assert.equal(open.cwd, sub);
    assert.match(open.label, /^(\S)\1 meu gerente$/u);
    assert.equal(mine.filter(([m]) => m === 'window.input').length, 3);
    const shown = mine.filter(([m]) => m === 'view.open' || m === 'view.update').pop()[1].data;
    assert.equal(shown.name, 'meu gerente');
    assert.equal(shown.tell.focus, true);
  } finally {
    sessions.splice(sessions.findIndex((s) => s.id === 'novo'), 1);
    fs.rmSync(sub, { recursive: true, force: true });
  }
});

test('mensagem pela caixa de um cartão de comando chega na aba sem apagar o comando nem mudar o estado', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', headline: 'rode isso', action: { kind: 'command', text: 'make deploy' } } });
  const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(read()).find((k) => read()[k].tabId === 'w');
  const before = calls.length;
  handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `message:${key}`, text: 'olha os logs antes' } });
  await tick();
  assert.deepEqual(calls.slice(before).filter(([m]) => m === 'terminal.sendText').map(([, p]) => [p.tabId, p.text]), [['w', 'olha os logs antes']]);
  const card = read()[key].card;
  assert.deepEqual([card.state, card.headline, card.action.text, card.answered.text, card.answered.message], ['needs_you', 'rode isso', 'make deploy', 'olha os logs antes', true]);
});

test('cartão de comando com um link: o cartão abre o link no navegador em vez de mandar para a aba', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  const url = 'https://github.com/cefis/x/compare/main...feature/TASK%2389380?expand=1';
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', headline: 'abra o PR', action: { kind: 'command', text: url, tabId: 'w' } } });
  const nodes = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(nodes).find((k) => nodes[k].tabId === 'w');
  const before = calls.length;
  handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `link:${key}` } });
  await tick();
  assert.deepEqual(calls.slice(before).filter(([m]) => m === 'window.openUrl' || m === 'terminal.sendText').map(([m, p]) => [m, p.url]), [['window.openUrl', url]]);
});

test('um painel só: trocar de gerente atualiza o mesmo painel, e o cartão de outro gerente não o tira de quem você olha', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  sessions.push({ id: 'h', kind: 'claude', title: 'h', status: 'idle' }, { id: 'h2', kind: 'claude', title: 'h2', status: 'tool' });
  try {
    await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'working' } });
    await tick();
    const nodes = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
    const keyOf = (tab) => Object.keys(nodes()).find((k) => nodes()[k].tabId === tab);
    const shown = () => {
      const last = calls.filter(([m, p]) => (m === 'view.open' || m === 'view.update') && p.viewId === 'painel' && p.data).pop();
      return last && last[1].data.name;
    };
    handlers.note['view.action']({ viewId: 'sidebar', action: `panel:${keyOf('g')}` });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(shown(), 'g');
    await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'h', args: { tabId: 'h2', state: 'working' } });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(shown(), 'g');
    const before = calls.length;
    handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `switch:${keyOf('h')}` } });
    await new Promise((r) => setTimeout(r, 400));
    const mine = calls.slice(before).filter(([m, p]) => p && p.viewId === 'painel');
    assert.ok(mine.length > 0 && mine.every(([m]) => m === 'view.update'));
    assert.equal(shown(), 'h');
    const chips = mine.pop()[1].data.managers;
    assert.deepEqual(chips.map((m) => [m.name, m.active, m.act]), [['todas', false, 'switch:*'], ['g', false, `switch:${keyOf('g')}`], ['h', true, `switch:${keyOf('h')}`]]);
    const raised = calls.length;
    handlers.note['view.action']({ viewId: 'sidebar', action: `panel:${keyOf('g')}` });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(calls.slice(raised).some(([m, p]) => m === 'view.open' && p.viewId === 'painel'));
    assert.equal(shown(), 'g');
  } finally {
    sessions.splice(2);
  }
});

test('o painel abre em todas as conversas e manda mensagem a uma sem gerente', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  sessions.push({ id: 'solta', kind: 'claude', title: 'solta', status: 'tool' });
  try {
    handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: 'switch:*' } });
    await new Promise((r) => setTimeout(r, 400));
    const last = calls.filter(([m, p]) => (m === 'view.open' || m === 'view.update') && p.viewId === 'painel' && p.data).pop()[1].data;
    assert.equal(last.name, 'todas as sessões');
    const titles = last.cols.flatMap((c) => c.cards).map((c) => c.title);
    assert.ok(titles.includes('solta'));
    const before = calls.length;
    handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: 'message:@solta', text: 'oi' } });
    await tick();
    assert.deepEqual(calls.slice(before).filter(([m]) => m === 'terminal.sendText').map(([, p]) => [p.tabId, p.text]), [['solta', 'oi']]);
  } finally {
    sessions.splice(2);
  }
});

test('dispensar um cartão leva ele para Feito, sem ação, até o gerente postar outro', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', headline: 'responda na aba', action: { kind: 'question', text: 'A ou B?' } } });
  const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(read()).find((k) => read()[k].tabId === 'w');
  handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `dismiss:${key}` } });
  await tick();
  const card = read()[key].card;
  assert.deepEqual([card.state, card.action, card.headline], ['done', null, 'Dispensado por você.']);
});
