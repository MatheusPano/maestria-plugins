'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tools = require('../lib/tools');
const { Links } = require('../lib/links');

function makeCtx(over = {}) {
  const calls = [];
  const sessions = over.sessions || [{ id: 'me', kind: 'claude', title: 'coordenador', cwd: '/home/u' }];
  let saved = 0;
  const ctx = {
    calls,
    home: '/home/u',
    tabId: 'me',
    isDir: (p) => ['/home/u', '/home/u/repo', '/srv/app'].includes(p),
    links: new Links({}, () => 1000),
    save: () => saved++,
    saves: () => saved,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'session.openClaude') return { tabId: 'tab9' };
      if (method === 'sessions.list') return sessions;
      if (method === 'session.rename') return { title: params.title };
      return null;
    },
    log: () => {},
    ...over,
  };
  return ctx;
}

const body = (res) => JSON.parse(res.content[0].text);
const opened = (ctx) => ctx.calls.find((c) => c.method === 'session.openClaude');

test('sessions_open abre em segundo plano, com a cor de quem chama no nome e o primeiro pedido', async () => {
  const ctx = makeCtx();
  const res = await tools.handle('sessions_open', { cwd: '~/repo', name: 'TASK#1', prompt: '  faz X  ' }, ctx);
  assert.equal(res.isError, undefined);
  assert.deepEqual(opened(ctx).params, { cwd: '/home/u/repo', label: '● [S] TASK#1', background: true, prompt: 'faz X' });
  assert.deepEqual(body(res), { tabId: 'tab9', name: '● [S] TASK#1', cwd: '/home/u/repo', prompted: true, color: 'red' });
});

test('quem chama vira gerente: a aba dele ganha a cor, e a nova fica ligada a ele', async () => {
  const ctx = makeCtx();
  await tools.handle('sessions_open', { cwd: '/srv/app', name: 'a' }, ctx);
  assert.deepEqual(ctx.calls.find((c) => c.method === 'session.rename').params, { tabId: 'me', title: '● [G] coordenador' });
  const me = ctx.links.byTab('me');
  const child = ctx.links.byTab('tab9');
  assert.equal(ctx.links.nodes[me].manager, true);
  assert.equal(ctx.links.nodes[child].parent, me);
  assert.equal(ctx.links.nodes[child].color, 'red');
  assert.equal(ctx.saves(), 1);
});

test('um filho que abre outra sessão passa a mesma cor adiante, sem renomear de novo', async () => {
  const ctx = makeCtx();
  await tools.handle('sessions_open', { cwd: '/srv/app', name: 'filho' }, ctx);
  ctx.tabId = 'tab9';
  ctx.calls.length = 0;
  ctx.request = async (method, params) => {
    ctx.calls.push({ method, params });
    return method === 'session.openClaude' ? { tabId: 'tab10' } : [];
  };
  const res = await tools.handle('sessions_open', { cwd: '/srv/app', name: 'neto' }, ctx);
  assert.equal(body(res).color, 'red');
  assert.equal(ctx.calls.some((c) => c.method === 'session.rename'), false);
  assert.equal(ctx.links.nodes[ctx.links.byTab('tab10')].parent, ctx.links.byTab('tab9'));
});

test('gerentes diferentes ganham cores diferentes', async () => {
  const ctx = makeCtx({ sessions: [{ id: 'me', title: 'a' }, { id: 'other', title: 'b' }] });
  await tools.handle('sessions_open', { cwd: '/srv/app', name: 'x' }, ctx);
  ctx.tabId = 'other';
  const res = await tools.handle('sessions_open', { cwd: '/srv/app', name: 'y' }, ctx);
  assert.equal(body(res).color, 'blue');
});

test('sessions_open sem pedido não manda prompt', async () => {
  const ctx = makeCtx();
  const res = await tools.handle('sessions_open', { cwd: '/srv/app', name: 'app' }, ctx);
  assert.equal(opened(ctx).params.prompt, undefined);
  assert.equal(body(res).prompted, false);
});

test('sessions_open resolve pasta relativa contra o cwd de quem chama e tira a barra do fim', async () => {
  const ctx = makeCtx({ cwd: '/home/u' });
  const res = await tools.handle('sessions_open', { cwd: 'repo/', name: 'a' }, ctx);
  assert.equal(opened(ctx).params.cwd, '/home/u/repo');
  assert.equal(body(res).cwd, '/home/u/repo');
});

test('sessions_open recusa pasta relativa sem cwd de quem chama, inexistente e nome vazio sem abrir nada', async () => {
  for (const args of [{ cwd: 'repo', name: 'a' }, { cwd: '/nada', name: 'a' }, { cwd: '/srv/app', name: '  ' }, { name: 'a' }]) {
    const ctx = makeCtx();
    const res = await tools.handle('sessions_open', args, ctx);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.equal(ctx.calls.length, 0);
  }
});

test('sessions_open falha quando a Maestria não devolve tabId', async () => {
  const ctx = makeCtx();
  const base = ctx.request;
  ctx.request = async (m, p) => (m === 'session.openClaude' ? {} : base(m, p));
  const res = await tools.handle('sessions_open', { cwd: '/srv/app', name: 'a' }, ctx);
  assert.equal(res.isError, true);
});

test('erro da Maestria vira resultado de erro e vai pro log', async () => {
  const logged = [];
  const ctx = makeCtx({ tabId: null, request: async () => { throw new Error('sem permissão sessions.create'); }, log: (...a) => logged.push(a.join(' ')) });
  const res = await tools.handle('sessions_open', { cwd: '/srv/app', name: 'a' }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /sessions\.create/);
  assert.equal(logged.length, 1);
});

test('sessions_list resume, traz gerente, cor e última atividade, e deixa de fora encerradas e embutidas', async () => {
  const sessions = [
    { id: 'me', kind: 'claude', title: 'A', cwd: '/r', branch: 'main', status: 'idle', statusLabel: 'Parado', sessionId: 's1' },
    { id: 'tab2', kind: 'shell', title: 'B', cwd: '/r', exited: true },
    { id: 'tab3', kind: 'shell', title: 'C', cwd: '/r', embedded: true },
    { id: 'tab9', kind: 'claude', title: 'D', cwd: '/s', status: 'waitingAnswer', needsYou: true, activity: { lastPrompt: 'faz', lastMessage: 'pergunta?' } },
  ];
  const ctx = makeCtx({ sessions });
  await tools.handle('sessions_open', { cwd: '/srv/app', name: 'D' }, ctx);
  const all = body(await tools.handle('sessions_list', {}, ctx)).sessions;
  assert.deepEqual(all.map((s) => s.tabId), ['me', 'tab9']);
  assert.deepEqual(all[1], {
    tabId: 'tab9', kind: 'claude', title: 'D', cwd: '/s', branch: null, status: 'waitingAnswer', statusLabel: null,
    needsYou: true, hibernated: false, color: 'red', parentTabId: 'me', manager: false, lastPrompt: 'faz', lastMessage: 'pergunta?',
  });
  assert.equal(all[0].manager, true);
  const mine = body(await tools.handle('sessions_list', { mine: true }, ctx)).sessions;
  assert.deepEqual(mine.map((s) => s.tabId), ['tab9']);
});

test('sessions_send manda pro terminal e recusa quando não dá', async () => {
  const sessions = [
    { id: 'me', kind: 'claude' },
    { id: 'ok', kind: 'claude', status: 'idle' },
    { id: 'sh', kind: 'shell' },
    { id: 'zz', kind: 'claude', hibernated: true },
    { id: 'ask', kind: 'claude', status: 'waitingPermission' },
  ];
  const ctx = makeCtx({ sessions });
  const res = await tools.handle('sessions_send', { tabId: 'ok', text: ' vai ' }, ctx);
  assert.deepEqual(ctx.calls.at(-1), { method: 'terminal.sendText', params: { tabId: 'ok', text: 'vai', submit: true } });
  assert.equal(body(res).sent, true);
  for (const args of [{ tabId: 'me', text: 'x' }, { tabId: 'nada', text: 'x' }, { tabId: 'sh', text: 'x' }, { tabId: 'zz', text: 'x' }, { tabId: 'ask', text: 'x' }, { tabId: 'ok', text: ' ' }]) {
    ctx.calls.length = 0;
    const r = await tools.handle('sessions_send', args, ctx);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(ctx.calls.some((c) => c.method === 'terminal.sendText'), false);
  }
});

test('sessions_rename mantém a cor de uma sessão ligada', async () => {
  const ctx = makeCtx({ sessions: [{ id: 'me', title: 'a' }, { id: 'tab9', title: '● x' }, { id: 'loose', title: 'y' }] });
  await tools.handle('sessions_open', { cwd: '/srv/app', name: 'x' }, ctx);
  let res = await tools.handle('sessions_rename', { tabId: 'tab9', name: 'novo nome' }, ctx);
  assert.equal(body(res).title, '● [S] novo nome');
  res = await tools.handle('sessions_rename', { tabId: 'loose', name: 'solto' }, ctx);
  assert.equal(body(res).title, 'solto');
  assert.equal((await tools.handle('sessions_rename', { tabId: 'nada', name: 'z' }, ctx)).isError, true);
});

test('ferramenta desconhecida', async () => {
  const res = await tools.handle('sessions_nada', {}, makeCtx());
  assert.equal(res.isError, true);
});

test('sessions_card guarda o cartão, liga a sessão ao gerente e abre o painel', async () => {
  const sessions = [{ id: 'me', kind: 'claude', title: 'g' }, { id: 'w', kind: 'claude', title: 'TASK#5 worker' }];
  const shown = [];
  const ctx = makeCtx({ sessions, showPanel: async (k) => shown.push(k) });
  const res = await tools.handle('sessions_card', { tabId: 'w', state: 'needs_you', bullets: ['a', ' ', 'b'], action: { kind: 'question', text: 'posso?' } }, ctx);
  assert.equal(res.isError, undefined);
  const me = ctx.links.byTab('me');
  const w = ctx.links.nodes[ctx.links.byTab('w')];
  assert.equal(w.parent, me);
  assert.deepEqual({ ...w.card, at: 0, since: 0 }, {
    state: 'needs_you', headline: null, bullets: ['a', 'b'], action: { kind: 'question', text: 'posso?', where: null, tabId: null, options: [] },
    proof: null, at: 0, since: 0, doneAt: null, doneBecause: null,
  });
  assert.deepEqual(shown, [me]);
  assert.ok(ctx.calls.some((c) => c.method === 'session.rename' && c.params.tabId === 'w' && c.params.title === '● [S] TASK#5 worker'));
});

test('sessions_card recusa estado, bullets e action inválidos', async () => {
  const sessions = [{ id: 'me', kind: 'claude' }, { id: 'w', kind: 'claude' }];
  for (const args of [
    { tabId: 'w', state: 'feito' },
    { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', bullets: ['1', '2', '3', '4'] },
    { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', action: { kind: 'x', text: 'a' } },
    { tabId: 'nada', state: 'done', doneBecause: 'PR mergeado' },
    { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', action: { kind: 'command', text: 'ls', tabId: 'nada' } },
    { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', action: { kind: 'command', text: 'ls', options: [{ label: 'a' }] } },
    { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', action: { kind: 'question', text: 'q', options: [{ label: ' ' }] } },
    { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', action: { kind: 'question', text: 'q', options: [{ label: 'a', audio: '/nada.mp3' }] } },
    { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', proof: { images: ['relativo.png'] } },
    { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', proof: { prs: [{ url: 'ftp://x' }] } },
    { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', proof: { prs: [{ url: 'https://x', ci: 'verde' }] } },
  ]) {
    const ctx = makeCtx({ sessions });
    assert.equal((await tools.handle('sessions_card', args, ctx)).isError, true, JSON.stringify(args));
  }
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
const worker = [{ id: 'me', kind: 'claude', title: 'g' }, { id: 'w', kind: 'claude', title: 'w' }];

test('sessions_card guarda headline, opções com áudio e aprovação', async () => {
  const dir = tmp();
  const clip = path.join(dir, 'f_04 viva.mp3');
  fs.writeFileSync(clip, 'x');
  const ctx = makeCtx({ sessions: worker });
  const action = { kind: 'question', text: 'qual voz?', options: [{ label: 'f_01' }, { label: 'f_04', recommended: true, audio: clip }] };
  await tools.handle('sessions_card', { tabId: 'w', state: 'needs_you', headline: ' Escolha a voz. ', action }, ctx);
  const c = ctx.links.nodes[ctx.links.byTab('w')].card;
  assert.equal(c.headline, 'Escolha a voz.');
  assert.deepEqual(c.action.options, [
    { key: 'A', label: 'f_01', recommended: false, audio: null },
    { key: 'B', label: 'f_04', recommended: true, audio: clip },
  ]);
  const res = await tools.handle('sessions_card', { tabId: 'w', state: 'needs_you', action: { kind: 'approve', text: 'aprova as telas?' } }, ctx);
  assert.equal(res.isError, undefined);
  assert.equal(ctx.links.nodes[ctx.links.byTab('w')].card.action.kind, 'approve');
});

test('sessions_card copia as imagens da prova pra pasta de dados e normaliza PRs, áudio e log', async () => {
  const src = tmp();
  const dataDir = tmp();
  const shot = path.join(src, 'Tela.PNG');
  fs.writeFileSync(shot, 'png');
  const ctx = makeCtx({ sessions: worker, dataDir });
  const proof = { images: [shot], prs: ['https://github.com/cefis/atrium-backend/pull/97', { url: 'https://x/y', label: 'docs', ci: 'ok' }], log: '  11 passed  ' };
  await tools.handle('sessions_card', { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', proof }, ctx);
  const p = ctx.links.nodes[ctx.links.byTab('w')].card.proof;
  assert.match(p.images[0].rel, /^proof\/[0-9a-f]{16}\.png$/);
  assert.equal(p.images[0].path, shot);
  assert.equal(fs.readFileSync(path.join(dataDir, p.images[0].rel), 'utf8'), 'png');
  assert.deepEqual(p.prs, [{ url: 'https://github.com/cefis/atrium-backend/pull/97', label: 'atrium-backend #97', ci: 'none' }, { url: 'https://x/y', label: 'docs', ci: 'ok' }]);
  assert.equal(p.log, '11 passed');
  assert.equal((await tools.handle('sessions_card', { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', proof: { images: [shot] } }, makeCtx({ sessions: worker }))).isError, true);
});

test('sessions_card marca desde quando o estado vale e quando ficou pronto', async () => {
  const ctx = makeCtx({ sessions: worker });
  const card = () => ctx.links.nodes[ctx.links.byTab('w')].card;
  await tools.handle('sessions_card', { tabId: 'w', state: 'working' }, ctx);
  const since = card().since;
  card().since = since - 5000;
  await tools.handle('sessions_card', { tabId: 'w', state: 'working', bullets: ['x'] }, ctx);
  assert.equal(card().since, since - 5000);
  assert.equal(card().doneAt, null);
  await tools.handle('sessions_card', { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', doneBecause: 'PR mergeado' }, ctx);
  const doneAt = card().doneAt;
  assert.ok(doneAt >= since);
  card().doneAt = 7;
  await tools.handle('sessions_card', { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', bullets: ['y'] }, ctx);
  assert.equal(card().doneAt, 7);
});

test('as respostas dadas nos cartões chegam uma vez ao gerente, no sessions_list e no sessions_card', async () => {
  const ctx = makeCtx({ sessions: worker });
  await tools.handle('sessions_card', { tabId: 'w', state: 'needs_you' }, ctx);
  const me = ctx.links.nodes[ctx.links.byTab('me')];
  const answer = { tabId: 'w', title: 'w', text: 'A', at: 1, via: 'terminal' };
  me.inbox = [answer];
  assert.deepEqual(body(await tools.handle('sessions_list', {}, ctx)).answers, [answer]);
  assert.equal(body(await tools.handle('sessions_list', {}, ctx)).answers, undefined);
  me.inbox = [{ tabId: 'w', title: 'w', text: 'B', at: 2, via: 'manager' }];
  assert.equal(body(await tools.handle('sessions_card', { tabId: 'w', state: 'working' }, ctx)).answers[0].text, 'B');
});

test('sessions_card com prova inválida não transforma quem chama em gerente', async () => {
  const ctx = makeCtx({ sessions: [{ id: 'me', kind: 'claude', title: 'solta' }, { id: 'w', kind: 'claude', title: 'w' }] });
  const res = await tools.handle('sessions_card', { tabId: 'w', state: 'done', doneBecause: 'PR mergeado', proof: { prs: ['ftp://x'] } }, ctx);
  assert.equal(res.isError, true);
  assert.deepEqual(ctx.links.nodes, {});
  assert.equal(ctx.calls.some((c) => c.method === 'session.rename'), false);
});

test('sessions_close fecha só uma sessão da sua árvore que terminou o turno', async () => {
  const sessions = [
    { id: 'me', kind: 'claude', title: 'gerente' },
    { id: 'pronta', kind: 'claude', title: 'p', status: 'idle' },
    { id: 'dorme', kind: 'claude', title: 'd', status: 'working', hibernated: true },
    { id: 'ocupada', kind: 'claude', title: 'o', status: 'tool', statusLabel: 'Rodando' },
    { id: 'prompt', kind: 'claude', title: 'q', status: 'waitingPermission', statusLabel: 'Permissão' },
    { id: 'alheia', kind: 'claude', title: 'a', status: 'idle' },
  ];
  const ctx = makeCtx({ sessions });
  const me = ctx.links.add({ tabId: 'me', name: 'gerente', manager: true });
  for (const t of ['pronta', 'dorme', 'ocupada', 'prompt']) ctx.links.add({ tabId: t, parent: me, name: t });
  ctx.links.add({ tabId: 'outro', name: 'outro', manager: true });
  ctx.links.add({ tabId: 'alheia', parent: ctx.links.byTab('outro'), name: 'alheia' });
  const closed = () => ctx.calls.filter((c) => c.method === 'session.close').map((c) => c.params.tabId);
  for (const t of ['pronta', 'dorme']) assert.deepEqual(body(await tools.handle('sessions_close', { tabId: t }, ctx)), { tabId: t, closed: true });
  for (const [t, re] of [['ocupada', /Rodando/], ['prompt', /Permissão/], ['alheia', /árvore/], ['me', /própria/], [undefined, /obrigatório/]]) {
    const r = await tools.handle('sessions_close', { tabId: t }, ctx);
    assert.equal(r.isError, true, t);
    assert.match(r.content[0].text, re);
  }
  assert.deepEqual(closed(), ['pronta', 'dorme']);
});

test('sessions_card recusa a própria aba e uma aba da árvore de outro gerente, sem mexer na árvore', async () => {
  const sessions = [{ id: 'me', kind: 'claude', title: 'g' }, { id: 'o', kind: 'claude', title: 'outro' }, { id: 'x', kind: 'claude', title: 'x' }];
  const ctx = makeCtx({ sessions });
  const other = ctx.links.add({ tabId: 'o', name: 'outro', manager: true });
  const x = ctx.links.add({ tabId: 'x', parent: other, name: 'x' });
  const before = JSON.stringify(ctx.links.nodes);
  for (const tabId of ['me', 'o', 'x']) assert.equal((await tools.handle('sessions_card', { tabId, state: 'working' }, ctx)).isError, true, tabId);
  assert.equal(JSON.stringify(ctx.links.nodes), before);
  assert.equal(ctx.links.nodes[x].card, undefined);
});

test('done exige doneBecause e é recusado com a sessão rodando, PR aberto ou commit sem push; pasta suja só avisa', async () => {
  const run = (status, outs = {}) => {
    const sessions = [{ id: 'me', kind: 'claude', title: 'g' }, { id: 'w', kind: 'claude', title: 'w', status, cwd: '/repo' }];
    const ctx = makeCtx({ sessions, prsOf: () => ['https://github.com/o/r/pull/9#issuecomment-1'], exec: async (cmd, args) => {
      const k = `${cmd} ${args.filter((a) => a !== '-C' && a !== '/repo').join(' ')}`;
      return outs[k] || { code: 1, stdout: '' };
    } });
    return tools.handle('sessions_card', { tabId: 'w', state: 'done', doneBecause: 'PR mergeado' }, ctx).then((r) => ({ r, ctx }));
  };
  const text = (r) => r.content[0].text;
  const noBecause = await tools.handle('sessions_card', { tabId: 'w', state: 'done' }, makeCtx({ sessions: worker }));
  assert.match(text(noBecause), /doneBecause/);
  assert.match(text((await run('tool')).r), /ainda está trabalhando/);
  assert.match(text((await run('waitingAnswer')).r), /esperando o usuário/);
  const open = { 'gh pr view https://github.com/o/r/pull/9 --json state -q .state': { code: 0, stdout: 'OPEN\n' } };
  assert.match(text((await run('idle', open)).r), /PR https:\/\/github.com\/o\/r\/pull\/9 ainda está aberto/);
  const git = { 'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'feature/x\n' }, 'git rev-list --count @{u}..HEAD': { code: 0, stdout: '2\n' } };
  assert.match(text((await run('idle', git)).r), /2 commit\(s\) sem push em feature\/x/);
  const never = { 'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'feature/x\n' }, 'git rev-list --count HEAD --not --remotes': { code: 0, stdout: '3\n' } };
  assert.match(text((await run('idle', never)).r), /nunca foi enviada \(3 commit/);
  const dirty = { 'gh pr view https://github.com/o/r/pull/9 --json state -q .state': { code: 0, stdout: 'MERGED' }, 'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'main\n' }, 'git rev-list --count @{u}..HEAD': { code: 0, stdout: '0' }, 'git status --porcelain': { code: 0, stdout: ' M a\n?? b\n' } };
  const { r, ctx } = await run('idle', dirty);
  assert.equal(r.isError, undefined);
  assert.deepEqual(body(r).warnings, ['2 arquivo(s) alterados sem commit em /repo']);
  assert.equal(ctx.links.nodes[ctx.links.byTab('w')].card.doneBecause, 'PR mergeado');
});

test('sessions_list traz o estado do cartão de cada sessão e as novidades da fila, uma vez', async () => {
  const sessions = [{ id: 'me', kind: 'claude', title: 'g' }, { id: 'w', kind: 'claude', title: 'w', status: 'idle' }];
  const ctx = makeCtx({ sessions });
  await tools.handle('sessions_card', { tabId: 'w', state: 'needs_you', headline: 'merge o PR' }, ctx);
  const me = ctx.links.byTab('me');
  ctx.links.nodes[me].events = [{ key: ctx.links.byTab('w'), kind: 'direct', text: 'para', at: 1 }];
  const first = body(await tools.handle('sessions_list', { mine: true }, ctx));
  assert.deepEqual([first.sessions[0].cardState, first.sessions[0].cardHeadline], ['needs_you', 'merge o PR']);
  assert.deepEqual(first.events, ['- O usuário escreveu direto para "w": "para"']);
  assert.equal(body(await tools.handle('sessions_list', { mine: true }, ctx)).events, undefined);
});
