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
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', doneBecause: 'PR mergeado' } });
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
    assert.match(open.label, /^\S \[G\] meu gerente$/u);
    assert.equal(mine.filter(([m]) => m === 'window.input').length, 3);
    const shown = mine.filter(([m]) => m === 'view.open' || m === 'view.update').pop()[1].data;
    assert.equal(shown.name, 'meu gerente');
    assert.equal(shown.tell.focus, true);
  } finally {
    sessions.splice(sessions.findIndex((s) => s.id === 'novo'), 1);
    fs.rmSync(sub, { recursive: true, force: true });
  }
});

test('mensagem pela caixa de um cartão de comando chega na aba e passa a vez para a sessão', async () => {
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
  assert.deepEqual([card.state, card.headline, card.action, card.answered.text, card.answered.message], ['working', 'Você escreveu: olha os logs antes', null, 'olha os logs antes', true]);
});

test('cartão de comando com um link: o cartão abre o link no navegador em vez de mandar para a aba', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  const url = 'https://github.com/cefis/x/compare/main...feature/TASK%2389380?expand=1';
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', headline: 'abra o PR', action: { kind: 'command', text: url, tabId: 'w' } } });
  const nodes = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(nodes).find((k) => nodes[k].tabId === 'w');
  const before = calls.length;
  handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `browse:${key}` } });
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

test('as ações do menu da lateral chegam ao que fazem: "ligar ao gerente" pendura a sessão solta no gerente', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const side = (a) => handlers.note['view.action']({ viewId: 'sidebar', action: a });
  const lastSidebar = () => calls.filter(([m]) => m === 'sidebar.update').map(([, p]) => p).pop();
  side('manager:g');
  await new Promise((r) => setTimeout(r, 400));
  const g = Object.keys(read()).find((k) => read()[k].tabId === 'g');
  const loose = lastSidebar().blocks.flatMap((b) => b.items || []).find((i) => i.action === 'focus:w');
  const link = loose.menu.find((m) => m.label === 'ligar ao gerente').children[0].action;
  side(link);
  await tick();
  const w = Object.values(read()).find((n) => n.tabId === 'w');
  assert.equal(w && w.parent, g);
});

test('links.json estragado: fica guardado ao lado e a cópia da última subida assume; o arquivo é trocado inteiro', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  const file = path.join(dataDir, 'links.json');
  fs.writeFileSync(file, JSON.stringify({ nodes: { n1: { tabId: 'g', name: 'g', manager: true, color: 'red', parent: null } }, seq: 1 }));
  handlers.req.initialize({ dataDir });
  fs.writeFileSync(file, '{"nodes": {"n1": {"tab');
  handlers.req.initialize({ dataDir });
  const kept = fs.readdirSync(dataDir).filter((f) => f.startsWith('links.json.estragado-'));
  assert.equal(kept.length, 1);
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'working' } });
  const nodes = JSON.parse(fs.readFileSync(file, 'utf8')).nodes;
  assert.equal(nodes.n1.name, 'g');
  assert.equal(Object.values(nodes).find((n) => n.tabId === 'w').parent, 'n1');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('retomar uma sessão fechada reabre a conversa com --resume, na pasta e com o nome; Maestria sem resume fecha a aba nova e avisa', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  fs.writeFileSync(path.join(dataDir, 'links.json'), JSON.stringify({ nodes: { n1: { tabId: 'velha', sessionId: 'conv1', cwd: dataDir, name: 'tarefas', color: 'green', manager: true, parent: null } }, seq: 1 }));
  handlers.req.initialize({ dataDir });
  const side = (a) => handlers.note['view.action']({ viewId: 'sidebar', action: a });
  queue['session.openClaude'] = [{ tabId: 'nova', resumed: true }];
  const before = calls.length;
  side('resume:n1');
  await tick();
  const open = calls.slice(before).find(([m]) => m === 'session.openClaude')[1];
  assert.deepEqual(open, { cwd: dataDir, label: '◆ [G] tarefas', resume: 'conv1' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes.n1.tabId, 'nova');
  fs.writeFileSync(path.join(dataDir, 'links.json'), JSON.stringify({ nodes: { n1: { tabId: 'velha', sessionId: 'conv1', cwd: dataDir, name: 'tarefas', color: 'green', manager: true, parent: null } }, seq: 1 }));
  handlers.req.initialize({ dataDir });
  queue['session.openClaude'] = [{ tabId: 'fresca' }];
  const mark = calls.length;
  side('resume:n1');
  await tick();
  const after = calls.slice(mark);
  assert.deepEqual(after.filter(([m]) => m === 'session.close').map(([, p]) => p.tabId), ['fresca']);
  assert.match(after.find(([m]) => m === 'window.showBanner')[1].text, /não retoma/);
});

test('o diagnóstico abre pela lateral e "arrumar tudo" só faz o automático', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  fs.mkdirSync(path.join(dataDir, 'proof'));
  fs.writeFileSync(path.join(dataDir, 'proof', 'solta.png'), 'x');
  fs.writeFileSync(path.join(dataDir, 'links.json'), JSON.stringify({ nodes: {
    n1: { tabId: 'g', name: 'g', manager: true, color: 'red', parent: null },
    n2: { tabId: 'fechou', name: 'vazia', color: 'red', parent: 'n1' },
    n3: { tabId: 'outra', name: 'parada', color: 'red', parent: 'n1', card: { state: 'needs_you', headline: 'x', at: 1 } },
  }, seq: 3 }));
  handlers.req.initialize({ dataDir });
  const before = calls.length;
  handlers.note['view.action']({ viewId: 'sidebar', action: 'doctor' });
  await tick();
  const opened = calls.slice(before).find(([m, p]) => m === 'view.open' && p.viewId === 'diagnostico')[1];
  assert.equal(opened.rfw.root, 'doctor');
  assert.equal(opened.data.canFixAll, true);
  handlers.note['view.action']({ viewId: 'diagnostico', action: 'act', values: { a: 'doctor-all' } });
  await tick();
  const nodes = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  assert.deepEqual(Object.keys(nodes), ['n1', 'n3']);
  assert.equal(nodes.n3.card.state, 'needs_you');
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'proof')), []);
});

test('um link maestria:// clicado abre o painel do gerente e o cartão da sessão; sessions_card devolve o link', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  const res = await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', headline: 'olha' } });
  const out = JSON.parse(res.content[0].text);
  assert.deepEqual([out.link, out.panel], ['maestria://maestria.sessions/card/w', 'maestria://maestria.sessions/panel/g']);
  const nodes = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(nodes).find((k) => nodes[k].tabId === 'w');
  const before = calls.length;
  handlers.note['view.action']({ viewId: 'link', action: 'card/w', values: { tabId: 'g' } });
  await tick();
  const card = calls.slice(before).find(([m, p]) => m === 'view.open' && p.viewId === `cartao:${key}`);
  assert.ok(card, 'abriu o cartão');
  const mark = calls.length;
  handlers.note['view.action']({ viewId: 'link', action: 'card/sumiu', values: {} });
  await tick();
  assert.match(calls.slice(mark).find(([m]) => m === 'window.showBanner')[1].text, /não está mais na árvore/);
});

test('o que você digita direto numa sessão não acorda o gerente: vai no próximo sessions_list; a mensagem mandada pelo painel não conta como digitada', async () => {
  const relay = require('../lib/relay');
  const was = { ...relay.limits };
  relay.limits.quiet = 0;
  relay.limits.gap = 0;
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
    handlers.req.initialize({ dataDir });
    await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'working' } });
    const nodes = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
    const key = Object.keys(nodes).find((k) => nodes[k].tabId === 'w');
    const hook = (name, payload) => handlers.note.event({ type: 'hook', tabId: 'w', name, payload });
    handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `message:${key}`, text: 'pelo painel' } });
    await tick();
    hook('UserPromptSubmit', { prompt: 'pelo painel' });
    await handlers.req['tool.call']({ tool: 'sessions_send', tabId: 'g', args: { tabId: 'w', text: 'Corrija o CI.\nDepois avise.' } });
    hook('UserPromptSubmit', { prompt: '<pasted_content id="ab12">\nCorrija o CI.\nDepois avise.\n</pasted_content id="ab12">' });
    hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' });
    const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes[key].card;
    assert.equal(read().answered.text, 'pelo painel');
    hook('UserPromptSubmit', { prompt: 'usa a v2 da API' });
    assert.deepEqual([read().state, read().headline, read().answered.text], ['working', 'Você escreveu: usa a v2 da API', 'usa a v2 da API']);
    const before = calls.length;
    await new Promise((r) => setTimeout(r, 900));
    const toManager = calls.slice(before).filter(([m, p]) => m === 'terminal.sendText' && p.tabId === 'g').map(([, p]) => p.text);
    assert.deepEqual(toManager, []);
    const listed = JSON.parse((await handlers.req['tool.call']({ tool: 'sessions_list', tabId: 'g', args: {} })).content[0].text).events;
    assert.deepEqual(listed, ['- O usuário escreveu direto para "w": "usa a v2 da API"']);
  } finally {
    Object.assign(relay.limits, was);
  }
});

test('se o aviso ao gerente falha, a fila volta e sai na próxima', async () => {
  const relay = require('../lib/relay');
  const was = { ...relay.limits };
  relay.limits.quiet = 0;
  relay.limits.gap = 0;
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
    handlers.req.initialize({ dataDir });
    await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'working' } });
    const realRequest = fake.request;
    let fail = true;
    fake.request = async (m, p) => {
      if (m === 'terminal.sendText' && p.tabId === 'g' && fail) {
        fail = false;
        throw new Error('aba sumiu');
      }
      return realRequest(m, p);
    };
    try {
      handlers.note.event({ type: 'hook', tabId: 'w', name: 'StopFailure', payload: { error: 'segunda tentativa' } });
      const before = calls.length;
      await new Promise((r) => setTimeout(r, 900));
      handlers.note.event({ type: 'hook', tabId: 'g', name: 'Stop', payload: {} });
      await new Promise((r) => setTimeout(r, 500));
      const got = calls.slice(before).filter(([m, p]) => m === 'terminal.sendText' && p.tabId === 'g').map(([, p]) => p.text);
      assert.equal(got.length, 1);
      assert.match(got[0], /segunda tentativa/);
    } finally {
      fake.request = realRequest;
    }
  } finally {
    Object.assign(relay.limits, was);
  }
});

test('a imagem da prova abre com anterior e próxima, e andar troca a mesma janela', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  const shots = ['a.png', 'b.png'].map((n) => {
    const f = path.join(dataDir, n);
    fs.writeFileSync(f, Buffer.from('89504e470d0a1a0a', 'hex'));
    return f;
  });
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', headline: 'olha', proof: { images: shots } } });
  const nodes = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(nodes).find((k) => nodes[k].tabId === 'w');
  const views = () => calls.filter(([m, p]) => (m === 'view.open' || m === 'view.update') && String(p.viewId).startsWith('imagem:'));
  const before = views().length;
  queue['view.update'] = [{ open: false }];
  handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `image:${key}:0` } });
  await tick();
  const [m, first] = views().slice(before).pop();
  assert.equal(m, 'view.open');
  assert.equal(first.data.label, '1 / 2 · a.png');
  assert.equal(first.data.prev, '');
  assert.equal(first.data.next, `image:${key}:1`);
  handlers.note['view.action']({ viewId: `imagem:${key}`, action: 'act', values: { a: first.data.next } });
  await tick();
  const [m2, second] = views().pop();
  assert.equal(m2, 'view.update');
  assert.equal(second.data.label, '2 / 2 · b.png');
  assert.equal(second.data.hasNext, false);
});

test('o primeiro prompt de uma sessão aberta pelo gerente (sessions_open) não conta como digitado pelo usuário', async () => {
  const relay = require('../lib/relay');
  const was = { ...relay.limits };
  relay.limits.quiet = 0;
  relay.limits.gap = 0;
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
    handlers.req.initialize({ dataDir });
    queue['session.openClaude'] = [{ tabId: 'n' }];
    await handlers.req['tool.call']({ tool: 'sessions_open', tabId: 'g', cwd: os.tmpdir(), args: { cwd: os.tmpdir(), name: 'nova', prompt: 'Investigue a queda das 07:38.' } });
    const nodes = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
    const key = Object.keys(nodes()).find((k) => nodes()[k].tabId === 'n');
    assert.ok(key);
    handlers.note.event({ type: 'hook', tabId: 'n', name: 'UserPromptSubmit', payload: { prompt: 'Investigue a queda das 07:38.' } });
    const before = calls.length;
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(calls.slice(before).filter(([m, p]) => m === 'terminal.sendText' && p.tabId === 'g').length, 0);
    assert.equal(nodes()[key].card, undefined);
    handlers.note.event({ type: 'hook', tabId: 'n', name: 'UserPromptSubmit', payload: { prompt: 'valeu' } });
    assert.equal(nodes()[key].card, undefined);
  } finally {
    Object.assign(relay.limits, was);
  }
});

test('mandar só as imagens coladas pela caixa do cartão passa a vez para a sessão e deixa a cópia para o gerente', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', headline: 'manda o print' } });
  const nodes = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(nodes()).find((k) => nodes()[k].tabId === 'w');
  const act = (a, extra = {}) => handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a, ...extra } });
  const before = calls.length;
  act(`paste:${key}`);
  await tick();
  act(`paste:${key}`);
  await tick();
  act(`message:${key}`, { text: '  ' });
  await tick();
  const mine = calls.slice(before).filter(([m]) => m === 'terminal.pasteClipboard' || m === 'terminal.sendText').map(([m, p]) => [m, p.tabId, p.text]);
  assert.deepEqual(mine, [['terminal.pasteClipboard', 'w', undefined], ['terminal.pasteClipboard', 'w', undefined], ['terminal.sendText', 'w', '']]);
  const card = nodes()[key].card;
  assert.deepEqual([card.state, card.headline], ['working', 'Você escreveu: [2 imagens]']);
  const inbox = Object.values(nodes()).find((n) => n.tabId === 'g').inbox;
  assert.equal(inbox[inbox.length - 1].text, '[2 imagens]');
});

test('o aviso ao gerente espera ele sair da pergunta e vai uma vez só, com tudo o que juntou', async () => {
  const relay = require('../lib/relay');
  const was = { ...relay.limits };
  relay.limits.quiet = 0;
  relay.limits.gap = 0;
  const g = sessions[0];
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
    handlers.req.initialize({ dataDir });
    await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'working' } });
    const toManager = (from) => calls.slice(from).filter(([m, p]) => m === 'terminal.sendText' && p.tabId === 'g').map(([, p]) => p.text);
    const hook = (tabId, name, payload = {}) => handlers.note.event({ type: 'hook', tabId, name, payload });
    const before = calls.length;
    Object.assign(g, { status: 'waitingAnswer', needsYou: true });
    hook('w', 'StopFailure', { error: 'primeira' });
    hook('w', 'StopFailure', { error: 'segunda' });
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(toManager(before), []);
    Object.assign(g, { status: 'idle', needsYou: false });
    hook('g', 'Stop');
    await new Promise((r) => setTimeout(r, 700));
    hook('g', 'Stop');
    await new Promise((r) => setTimeout(r, 700));
    const got = toManager(before);
    assert.equal(got.length, 1);
    assert.match(got[0], /primeira[\s\S]*segunda/);
  } finally {
    Object.assign(g, { status: 'idle', needsYou: false });
    Object.assign(relay.limits, was);
  }
});

test('com a pergunta ainda aberta nos hooks, o aviso não é digitado nem quando a Maestria mostra o gerente parado', async () => {
  const relay = require('../lib/relay');
  const was = { ...relay.limits };
  relay.limits.quiet = 0;
  relay.limits.gap = 0;
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
    handlers.req.initialize({ dataDir });
    await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'working' } });
    const toManager = (from) => calls.slice(from).filter(([m, p]) => m === 'terminal.sendText' && p.tabId === 'g').length;
    const hook = (tabId, name, payload = {}) => handlers.note.event({ type: 'hook', tabId, name, payload });
    const before = calls.length;
    hook('g', 'PreToolUse', { tool_name: 'AskUserQuestion' });
    hook('g', 'PostToolUse', { tool_name: 'Read' });
    hook('w', 'StopFailure', { error: 'enquanto ele pergunta' });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(toManager(before), 0);
    hook('g', 'PostToolUse', { tool_name: 'AskUserQuestion' });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(toManager(before), 1);
  } finally {
    Object.assign(relay.limits, was);
  }
});

test('o cabeçalho do cartão tem o botão "ir para a aba", que leva direto à sessão', async () => {
  const lib = fs.readFileSync(path.join(root, 'ui', 'panel.rfwtxt'), 'utf8');
  const head = lib.slice(lib.indexOf('widget TitleRow'), lib.indexOf('widget Gap'));
  assert.match(head, /switch args\.c\.acts\.focus \{\s*"": SizedBox\(\),\s*default: IconButton\(icon: "open", tooltip: "ir para a aba"[^\n]*a: args\.c\.acts\.focus/);
  const before = calls.length;
  handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: 'focus:w' } });
  await tick();
  assert.deepEqual(calls.slice(before).filter(([m]) => m === 'session.focus'), [['session.focus', { tabId: 'w' }]]);
});

test('responder a pergunta ou a permissão na própria aba tira da coluna na hora o cartão que só apontava pra aba; o que pede outra coisa fica', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  const card = (args) => handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'needs_you', ...args } });
  const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const w = sessions.find((s) => s.id === 'w');
  const hook = (name, payload) => handlers.note.event({ type: 'hook', tabId: 'w', name, payload });
  await card({ headline: 'PR #12 aberto, falta o merge' });
  const key = Object.keys(read()).find((k) => read()[k].tabId === 'w');
  hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q0' });
  hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q0' });
  assert.equal(read()[key].card.headline, 'PR #12 aberto, falta o merge', 'o cartão postado com a aba parada não é sobre a pergunta');
  w.status = 'waitingAnswer';
  try {
    await card({ headline: 'responda na aba' });
    hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'r1' });
    assert.equal(read()[key].card.state, 'needs_you');
    hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' });
    hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' });
    assert.deepEqual([read()[key].card.state, read()[key].card.headline], ['working', 'Você respondeu na aba.']);

    await card({ headline: 'libera o push' });
    hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'b1' });
    hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'b1' });
    hook('Notification', { notification_type: 'permission_prompt', message: 'atrasada' });
    hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'r2' });
    assert.equal(read()[key].card.state, 'needs_you', 'a notificação que chega depois da ferramenta não vale para a próxima');
    hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'b2' });
    hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'b2' });
    assert.equal(read()[key].card.state, 'working');

    await card({ action: { kind: 'approve', text: 'mergear o PR #12?' } });
    hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q2' });
    hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q2' });
    assert.deepEqual([read()[key].card.state, read()[key].card.action.kind], ['needs_you', 'approve']);
  } finally {
    w.status = 'idle';
  }
});

test('o turno da sessão fica gravado no nó e no cartão: a aba que some no meio dele vira interrompida', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'working', headline: 'build' } });
  const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  const key = Object.keys(read()).find((k) => read()[k].tabId === 'w');
  const hook = (name, payload = {}) => handlers.note.event({ type: 'hook', tabId: 'w', name, payload });
  hook('UserPromptSubmit', { prompt: 'roda o build' });
  assert.deepEqual([read()[key].busy, read()[key].card.busy], [true, true]);
  await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'w', state: 'working', headline: 'build 2' } });
  assert.equal(read()[key].card.busy, true);
  hook('Stop');
  assert.deepEqual([read()[key].busy, read()[key].card.busy], [false, false]);

  hook('UserPromptSubmit', { prompt: 'de novo' });
  hook('PostToolUseFailure', { tool_name: 'Bash', is_interrupt: true });
  assert.equal(read()[key].busy, false, 'Esc no meio da ferramenta encerra o turno');
  hook('UserPromptSubmit', { prompt: 'de novo' });
  hook('SessionEnd', { reason: 'other' });
  assert.equal(read()[key].busy, true, 'a sessão morta por sinal continua no meio do turno');
  hook('SessionEnd', { reason: 'clear' });
  assert.equal(read()[key].busy, false);
  hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'c1' });
  assert.equal(read()[key].busy, true, 'ferramenta rodando volta o turno (depois de um auto-compact, por exemplo)');

  hook('UserPromptSubmit', { prompt: 'pensa' });
  const real = Date.now;
  const w = sessions.find((s) => s.id === 'w');
  const later = async () => {
    Date.now = () => real() + 31 * 1000;
    try {
      handlers.note.event({ type: 'session.changed' });
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      Date.now = real;
    }
  };
  w.status = 'ready';
  try {
    await later();
  } finally {
    w.status = 'idle';
  }
  assert.equal(read()[key].busy, true, '"ready" no meio do turno (auto-compact) não encerra o turno');
  await later();
  assert.deepEqual([read()[key].busy, read()[key].card.busy], [false, false], 'parada há mais de 30 s depois do pedido (Esc pensando) não está no turno');
});

test('a aba fechada vai para o histórico: na própria aba, pelo painel (sem repetir) e volta com retomar', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  const file = path.join(dataDir, 'links.json');
  const hist = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).history || [] : []);
  const changed = async () => {
    handlers.note.event({ type: 'session.changed' });
    await new Promise((r) => setTimeout(r, 400));
  };
  const act = async (a) => {
    handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a } });
    await new Promise((r) => setTimeout(r, 400));
  };
  const drop = (id) => sessions.splice(sessions.findIndex((s) => s.id === id), 1);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-cwd-'));
  sessions.push({ id: 'z', kind: 'claude', title: 'TASK#5 solta', status: 'idle', sessionId: 's-z', cwd });
  sessions.push({ id: 'k', kind: 'claude', title: 'pronta', status: 'idle', sessionId: 's-k', cwd });
  try {
    await changed();
    drop('z');
    await changed();
    assert.deepEqual(hist(), [], 'só entra se continuar sumida na leitura seguinte');
    await changed();
    assert.deepEqual(hist().map((h) => [h.tabId, h.by, h.task]), [['z', 'você, na aba', 'TASK#5']]);

    sessions.push({ id: 'q', kind: 'claude', title: 'piscou', status: 'idle', sessionId: 's-q', cwd });
    await changed();
    const q = sessions.splice(sessions.findIndex((s) => s.id === 'q'), 1)[0];
    await changed();
    sessions.push(q);
    await changed();
    drop('q');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hist().some((h) => h.tabId === 'q'), false, 'uma leitura que perdeu a aba e a achou de novo não registra');
    sessions.push(q);
    await changed();

    const before = calls.length;
    await act('close:@k');
    assert.deepEqual(calls.slice(before).filter(([m]) => m === 'session.close'), [['session.close', { tabId: 'k' }]]);
    drop('k');
    await changed();
    assert.deepEqual(hist().map((h) => [h.tabId, h.by]), [['k', 'você, no painel'], ['z', 'você, na aba']]);

    const panelData = () => calls.filter(([m, p]) => (m === 'view.update' || m === 'view.open') && p.viewId === 'painel').pop()[1].data;
    await act('history');
    assert.equal(panelData().history.open, true);
    assert.equal(panelData().history.rows.length, 2);
    await act('history:week');
    assert.deepEqual(panelData().history.ranges.map((r) => r.active), [false, false, true, false]);
    await act('history');
    assert.equal(panelData().history.open, false);

    queue['session.openClaude'] = [{ tabId: 'z2', resumed: true }];
    const mark = calls.length;
    await act(`reopen:${hist().find((h) => h.tabId === 'z').id}`);
    assert.deepEqual(calls.slice(mark).filter(([m]) => m === 'session.openClaude').map(([, p]) => p), [{ cwd, label: 'TASK#5 solta', resume: 's-z' }]);
  } finally {
    for (const id of ['z', 'k', 'q']) if (sessions.some((s) => s.id === id)) drop(id);
  }
});

test('o cartão feito fecha a aba sozinho quando ela para, uma notificação por rodada; keepOpen e a aba retomada ficam', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8'));
  const changed = async () => {
    handlers.note.event({ type: 'session.changed' });
    await new Promise((r) => setTimeout(r, 400));
  };
  const tabs = ['c1', 'c2', 'c3'].map((id) => ({ id, kind: 'claude', title: `TASK#${id.slice(1)} ${id}`, status: 'working', sessionId: `s-${id}` }));
  sessions.push(...tabs);
  try {
    const done = (tabId, extra = {}) => handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId, state: 'done', doneBecause: 'PR mergeado', ...extra } });
    for (const t of tabs) await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: t.id, state: 'working', headline: 'rodando' } });
    for (const t of tabs) t.status = 'idle';
    const r = await done('c1');
    assert.match(r.content[0].text, /fecha sozinha/);
    await done('c2');
    await done('c3', { keepOpen: true });
    const mark = calls.length;
    await changed();
    const after = calls.slice(mark);
    assert.deepEqual(after.filter(([m]) => m === 'session.close').map(([, p]) => p.tabId), ['c1', 'c2']);
    assert.deepEqual(after.filter(([m]) => m === 'window.notify').map(([, p]) => p.title), ['2 sessões terminadas fechadas']);
    assert.deepEqual(read().history.map((h) => [h.tabId, h.by, h.why]), [['c2', 'gerente g', 'PR mergeado'], ['c1', 'gerente g', 'PR mergeado']]);

    const again = calls.length;
    await changed();
    assert.equal(calls.slice(again).some(([m]) => m === 'session.close'), false, 'a aba já fechada uma vez não é fechada de novo');

    const nodes = read().nodes;
    const c3 = Object.keys(nodes).find((k) => nodes[k].tabId === 'c3');
    assert.deepEqual([nodes[c3].card.keepOpen, nodes[c3].card.closeFor], [true, null]);
    assert.equal(nodes[Object.keys(nodes).find((k) => nodes[k].tabId === 'c1')].card.closeFor, null, 'fechou e desarmou');

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-cwd-'));
    const c4 = { id: 'c4', kind: 'claude', title: 'c4', status: 'idle', sessionId: 's-c4', cwd, focused: true };
    sessions.push(c4);
    tabs.push(c4);
    await done('c4');
    await changed();
    assert.equal(calls.slice(again).some(([m, p]) => m === 'session.close' && p.tabId === 'c4'), false, 'a aba na sua frente espera você sair dela');
    tabs.pop();
    sessions.splice(sessions.indexOf(c4), 1);
    const k4 = Object.keys(read().nodes).find((k) => read().nodes[k].tabId === 'c4');
    queue['session.openClaude'] = [{ tabId: 'c5', resumed: true }];
    handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `resume:${k4}` } });
    await new Promise((r) => setTimeout(r, 100));
    const c5 = { id: 'c5', kind: 'claude', title: 'c4', status: 'idle', sessionId: 's-c4', cwd };
    sessions.push(c5);
    tabs.push(c5);
    const before = calls.length;
    await changed();
    assert.equal(calls.slice(before).some(([m]) => m === 'session.close'), false, 'a conversa retomada não fecha de novo');
    assert.equal(read().nodes[k4].card.closeFor, null);
  } finally {
    for (const t of tabs) if (sessions.includes(t)) sessions.splice(sessions.indexOf(t), 1);
  }
});

test('a limpeza abre com os grupos padrão marcados, troca o tempo, desmarca e fecha as marcadas para o histórico', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const tabs = ['p1', 'p2', 'p3'].map((id) => ({ id, kind: 'claude', title: `TASK#9${id.slice(1)} ${id}`, status: 'idle', hibernated: true, sessionId: `s-${id}`, startedAt: old }));
  const recent = { id: 'p4', kind: 'claude', title: 'recente', status: 'idle', hibernated: true, sessionId: 's-p4', startedAt: new Date(Date.now() - 8 * 3600 * 1000).toISOString() };
  sessions.push(...tabs, recent);
  const act = async (viewId, a) => {
    handlers.note['view.action']({ viewId, action: 'act', values: { a } });
    await new Promise((r) => setTimeout(r, 100));
  };
  const last = (viewId) => calls.filter(([m, p]) => (m === 'view.open' || m === 'view.update') && p.viewId === viewId).pop()[1].data;
  try {
    await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'p3', state: 'needs_you', headline: 'PR #40 esperando revisão' } });
    handlers.note.event({ type: 'session.changed' });
    await new Promise((r) => setTimeout(r, 400));
    const side = calls.filter(([m]) => m === 'sidebar.update').pop()[1];
    assert.ok(side.blocks.some((b) => b.items && b.items.some((i) => i.action === 'cleanup' && i.title === '3 paradas há mais de 1 dia')));

    await act('sidebar', 'cleanup');
    const open = calls.filter(([m, p]) => m === 'view.open' && p.viewId === 'limpeza').pop()[1];
    assert.deepEqual([open.modal, open.rfw.root], [true, 'cleanup']);
    assert.equal(last('limpeza').summary, '2 marcadas · fica 1 aberta');
    await act('limpeza', 'clean-idle:6h');
    assert.equal(last('limpeza').summary, '3 marcadas · fica 1 aberta', 'com 6 h entra a de 8 h');
    await act('limpeza', 'clean-pick:p4');
    await act('limpeza', 'clean-group:open');
    assert.equal(last('limpeza').summary, '3 marcadas · fica 1 aberta');
    await act('limpeza', 'clean-group:open');
    await act('limpeza', 'clean-pick:p1');
    assert.equal(last('limpeza').summary, '1 marcada · ficam 3 abertas');

    const mark = calls.length;
    await act('limpeza', 'clean-run');
    const after = calls.slice(mark);
    assert.deepEqual(after.filter(([m]) => m === 'session.close').map(([, p]) => p.tabId), ['p2']);
    assert.ok(after.some(([m, p]) => m === 'view.close' && p.viewId === 'limpeza'));
    assert.ok(after.some(([m, p]) => m === 'window.showBanner' && p.text === '1 aba fechada e guardada no histórico'));
    const hist = JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).history;
    assert.deepEqual(hist.filter((h) => h.tabId.startsWith('p')).map((h) => [h.tabId, h.by]), [['p2', 'você, na limpeza']]);

    sessions.splice(sessions.indexOf(tabs[1]), 1);
    await act('sidebar', 'cleanup');
    assert.equal(last('limpeza').summary, '1 marcada · fica 1 aberta');
    await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'p1', state: 'needs_you', headline: 'olha isso' } });
    const again = calls.length;
    await act('limpeza', 'clean-run');
    assert.equal(calls.slice(again).some(([m]) => m === 'session.close'), false, 'a que mudou de grupo depois que você viu não fecha');
    assert.ok(calls.slice(again).some(([m, p]) => m === 'window.showBanner' && /nada foi fechado/.test(p.text)));
  } finally {
    for (const t of [...tabs, recent]) if (sessions.includes(t)) sessions.splice(sessions.indexOf(t), 1);
  }
});

test('responder o cartão com a aba num prompt guarda a resposta e manda quando ela sai do prompt', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
  handlers.req.initialize({ dataDir });
  const tab = { id: 'pp', kind: 'claude', title: 'pp', status: 'idle', sessionId: 's-pp' };
  sessions.push(tab);
  const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'links.json'), 'utf8')).nodes;
  try {
    await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'pp', state: 'needs_you', action: { kind: 'question', text: 'sigo?' } } });
    const key = Object.keys(read()).find((k) => read()[k].tabId === 'pp');
    tab.status = 'waitingPermission';
    const mark = calls.length;
    handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `answer:${key}`, text: 'sim, segue' } });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(calls.slice(mark).some(([m, p]) => m === 'window.showBanner' && p.text === 'resposta guardada: vai para pp quando ela sair do prompt'));
    assert.equal(calls.slice(mark).some(([m]) => m === 'terminal.sendText'), false);
    assert.deepEqual(read()[key].pending.map((x) => x.text), ['sim, segue']);

    tab.status = 'idle';
    handlers.note.event({ type: 'session.changed' });
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(calls.slice(mark).filter(([m]) => m === 'terminal.sendText').map(([, p]) => [p.tabId, p.text]), [['pp', 'sim, segue']]);
    assert.equal(read()[key].pending, undefined);
    assert.ok(calls.slice(mark).some(([m, p]) => m === 'window.showBanner' && p.text === 'resposta guardada enviada para pp'));

    tab.status = 'waitingAnswer';
    handlers.note['view.action']({ viewId: 'painel', action: 'act', values: { a: `message:${key}`, text: 'velha' } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(read()[key].pending.length, 1);
    handlers.note.event({ type: 'hook', tabId: 'pp', name: 'UserPromptSubmit', payload: { prompt: 'não, faz B' } });
    assert.equal(read()[key].pending, undefined, 'você escreveu direto na aba: a guardada deixou de valer');
  } finally {
    sessions.splice(sessions.indexOf(tab), 1);
  }
});

test('fim de turno só acorda o gerente quando a sessão parou de vez; a aba fechada por você também acorda; a fechada pelo plugin, não', async () => {
  const relay = require('../lib/relay');
  const was = { ...relay.limits };
  relay.limits.quiet = 0;
  relay.limits.gap = 0;
  const tab = { id: 'st', kind: 'claude', title: 'st', status: 'idle', sessionId: 's-st' };
  sessions.push(tab);
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-main-'));
    handlers.req.initialize({ dataDir });
    await handlers.req['tool.call']({ tool: 'sessions_card', tabId: 'g', args: { tabId: 'st', state: 'working', headline: 'rodando' } });
    const toManager = (from) => calls.slice(from).filter(([m, p]) => m === 'terminal.sendText' && p.tabId === 'g').map(([, p]) => p.text);
    const changed = async () => {
      handlers.note.event({ type: 'session.changed' });
      await new Promise((r) => setTimeout(r, 400));
    };
    const before = calls.length;
    handlers.note.event({ type: 'hook', tabId: 'st', name: 'Stop', payload: {} });
    await changed();
    assert.deepEqual(toManager(before), [], 'parou agora: pode voltar a rodar');
    relay.limits.settle = 0;
    await changed();
    const got = toManager(before);
    assert.equal(got.length, 1);
    assert.match(got[0], /^\[sessions\] 1 sessão pede você[\s\S]*"st" parou há 1 min[\s\S]*cartão: working "rodando" → atualize/);

    const mark = calls.length;
    sessions.splice(sessions.indexOf(tab), 1);
    await changed();
    await changed();
    assert.match(toManager(mark).join('\n'), /"st" foi fechada pelo usuário\./);
  } finally {
    if (sessions.includes(tab)) sessions.splice(sessions.indexOf(tab), 1);
    Object.assign(relay.limits, was);
  }
});
