// Git: o controle de código do VS Code numa janela. A branch e o quanto ela
// está à frente ou atrás, as mudanças separadas em preparadas e não
// preparadas, o diff de cada arquivo no leitor, commit (com mensagem sugerida
// pelo claude), fetch, pull, push, trocar e criar branch e os últimos commits.
// A mesma coisa, compacta, na aba do plugin na lateral: o "Source Control" da
// barra de atividades, com o número de arquivos mudados no ícone.

'use strict';

const path = require('path');
const mx = require('./maestria');
const git = require('./git');

const VIEW = 'git';
const DIFF_VIEW = 'diff';
const SIDEBAR = 'sidebar'; // o viewId dos cliques da aba da lateral
const SIDEBAR_COMMITS = 5;
const LIST_LIMIT = 400; // mais que isso é um node_modules sem .gitignore
const PREVIEW_LIMIT = 200000;

const state = {
  settings: {},
  root: null,
  repos: [], // as opções do seletor: [{ value, label }]
  st: null, // o status lido por último (git.status)
  op: null, // rebase/merge/… parado no meio
  commits: [],
  busy: null, // o que está rodando agora, pra faixa de progresso
  error: null,
  viewOpen: false,
  // A aba da lateral: se está na tela (sidebar.shown/hidden) e o último selo
  // mandado, pra não repetir o mesmo a cada conferida.
  sidebarShown: false,
  badge: null,
  // `gen` entra no id dos campos: a janela guarda o que foi digitado por id,
  // então esvaziar a mensagem depois de um commit pede um id novo.
  gen: 0,
  message: '',
  newBranch: false,
  timer: null,
  // A janela do diff, ao lado: { where, path } de um arquivo ou { commit }.
  // `diffGen` entra no id do console, pra outro arquivo começar do topo.
  diff: null,
  diffText: null,
  diffOpen: false,
  diffGen: 0,
};

const setting = (id, fallback) => (id in state.settings ? state.settings[id] : fallback);

// Uma operação por vez: um push no meio de um commit só confunde.
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// --- leitura -----------------------------------------------------------------

async function loadRepos() {
  let folders = [];
  try {
    folders = await mx.request('folders.list');
  } catch (e) {
    mx.log('folders.list:', e.message);
  }
  const out = [];
  for (const f of folders) {
    if (!f.isRepo) continue;
    out.push({ value: f.root, label: f.name, branch: f.branch });
    for (const w of f.worktrees || []) {
      if (w.isMain || w.prunable) continue;
      out.push({ value: w.path, label: `${f.name} · ${w.label || w.branch || path.basename(w.path)}`, branch: w.branch });
    }
  }
  if (state.root && !out.some((o) => o.value === state.root)) {
    out.unshift({ value: state.root, label: path.basename(state.root) });
  }
  state.repos = out;
}

async function reload() {
  if (!state.root) return;
  try {
    state.st = await git.status(state.root);
    state.op = await git.operation(state.root);
    state.commits = await git.log(state.root, Math.max(0, Number(setting('commits', 15)) || 0));
  } catch (e) {
    state.st = null;
    state.error = e.message;
  }
}

// --- janela ------------------------------------------------------------------

const TONES = { M: 'yellow', A: 'green', U: 'green', D: 'red', R: 'accent', C: 'accent', T: 'yellow', '!': 'red' };

function fileItem(f, where) {
  const dir = path.dirname(f.path);
  let subtitle = dir === '.' ? undefined : dir;
  if (f.from) subtitle = `${subtitle ? subtitle + ' · ' : ''}era ${f.from}`;
  return {
    title: path.basename(f.path),
    subtitle,
    icon: f.code === 'D' ? 'clear' : f.code === '!' ? 'warning' : 'file',
    tone: TONES[f.code] || 'faint',
    badge: f.code,
    action: `f:${where}:${f.path}`,
    actions: fileActions(f, where).map((a) => ({ ...a, action: `${a.verb}:${where}:${f.path}` })),
  };
}

/** Os botões do arquivo, na linha e na janela do diff: os do VS Code. */
function fileActions(f, where) {
  const open = f.code === 'D' ? null : { verb: 'o', icon: 'open', label: 'abrir', tooltip: 'abrir no editor' };
  if (where === 'x') return [open, { verb: 'a', icon: 'check', label: 'resolvido', tooltip: 'marcar como resolvido (git add)' }].filter(Boolean);
  if (where === 's') return [open, { verb: 'r', icon: 'remove', label: 'tirar', tooltip: 'tirar da preparação' }].filter(Boolean);
  return [
    open,
    {
      verb: 'd',
      icon: 'undo',
      label: f.untracked ? 'apagar' : 'descartar',
      tooltip: f.untracked ? 'apagar o arquivo novo' : 'descartar as mudanças',
    },
    { verb: 'a', icon: 'add', label: 'preparar', tooltip: 'preparar (git add)' },
  ].filter(Boolean);
}

function fileList(files, where, empty, { flat = false } = {}) {
  const items = files.slice(0, LIST_LIMIT).map((f) => fileItem(f, where));
  const blocks = [{ type: 'list', items, empty, flat: flat || undefined }];
  if (files.length > LIST_LIMIT) {
    blocks.push({ type: 'text', style: 'faint', text: `e mais ${files.length - LIST_LIMIT} — use o terminal pra ver todos` });
  }
  return blocks;
}

function branchLine(st) {
  if (!st.oid) return { key: 'branch', value: `${st.head || '—'} (sem commit ainda)` };
  if (!st.head) return { key: 'branch', value: `HEAD destacado em ${st.oid.slice(0, 7)}`, tone: 'yellow' };
  return { key: 'branch', value: st.head, tone: 'accent' };
}

function syncLine(st) {
  if (!st.head) return null;
  if (!st.upstream) return { key: 'remoto', value: 'branch não publicada', tone: 'faint' };
  const tone = st.behind ? 'yellow' : st.ahead ? 'accent' : 'green';
  return { key: 'remoto', value: `${st.upstream} · ${st.behind}↓ ${st.ahead}↑`, tone };
}

function blocks() {
  const out = [];
  if (state.repos.length > 1) {
    out.push({ type: 'select', id: 'repo', label: 'repositório', options: state.repos, value: state.root, action: 'repo' });
  }
  const st = state.st;
  if (!st) {
    out.push({ type: 'text', style: 'error', text: state.error || 'não consegui ler o repositório' });
    out.push({ type: 'button', action: 'atualizar', label: 'tentar de novo', icon: 'refresh' });
    return out;
  }
  const busy = !!state.busy;
  out.push({
    type: 'kv',
    items: [
      branchLine(st),
      syncLine(st),
      state.op ? { key: 'parado no meio', value: `${state.op} — resolva e continue no terminal`, tone: 'yellow' } : null,
    ].filter(Boolean),
  });
  out.push({
    type: 'row',
    children: [
      { type: 'button', action: 'branch', label: 'branch', icon: 'task', tooltip: 'trocar ou criar branch', disabled: busy },
      { type: 'button', action: 'pull', label: st.behind ? `pull ${st.behind}↓` : 'pull', icon: 'step-into', disabled: busy || !st.upstream },
      st.head && !st.upstream
        ? { type: 'button', action: 'push', label: 'publicar', icon: 'step-out', disabled: busy }
        : { type: 'button', action: 'push', label: st.ahead ? `push ${st.ahead}↑` : 'push', icon: 'step-out', disabled: busy || !st.head },
      { type: 'button', action: 'fetch', icon: 'refresh', tooltip: 'fetch', disabled: busy },
      { type: 'button', action: 'terminal', icon: 'terminal', tooltip: 'abrir um terminal no repositório' },
    ],
  });
  if (state.newBranch) {
    out.push({ type: 'input', id: `nb.${state.gen}`, label: 'nova branch', placeholder: 'feature/TASK#00000', submit: 'criar-branch' });
    out.push({
      type: 'row',
      children: [
        { type: 'button', action: 'criar-branch', label: 'criar e trocar', style: 'primary', disabled: busy },
        { type: 'button', action: 'cancelar-branch', label: 'cancelar' },
      ],
    });
  }
  if (state.busy) out.push({ type: 'progress', label: state.busy });
  if (state.error) out.push({ type: 'text', style: 'error', text: state.error });

  const { pending, everything, canCommit } = commitState(st);
  out.push({ type: 'divider' });
  out.push({
    type: 'input',
    id: `msg.${state.gen}`,
    placeholder: `mensagem (enter faz o commit${st.head ? ` em "${st.head}"` : ''})`,
    value: state.message,
    submit: 'commit',
  });
  out.push({
    type: 'row',
    children: [
      {
        type: 'button',
        action: 'commit',
        label: everything && pending ? 'commit de tudo' : 'commit',
        style: 'primary',
        icon: 'check',
        disabled: busy || !canCommit,
      },
      { type: 'button', action: 'sugerir', icon: 'star', tooltip: 'sugerir a mensagem com o claude', disabled: busy || !pending },
      { type: 'button', action: 'atualizar', icon: 'reload', tooltip: 'atualizar' },
    ],
  });

  if (st.conflicts.length) {
    out.push({ type: 'heading', text: `Conflitos (${st.conflicts.length})` });
    out.push(...fileList(st.conflicts, 'x'));
  }
  if (st.staged.length) {
    out.push({ type: 'heading', text: `Preparadas (${st.staged.length})` });
    out.push({ type: 'row', children: [{ type: 'button', action: 'tirar-tudo', label: 'tirar tudo', icon: 'clear', disabled: busy }] });
    out.push(...fileList(st.staged, 's'));
  }
  if (st.changes.length || !pending) {
    out.push({ type: 'heading', text: `Mudanças (${st.changes.length})` });
    if (st.changes.length) {
      out.push({ type: 'row', children: [{ type: 'button', action: 'preparar-tudo', label: 'preparar tudo', icon: 'check', disabled: busy }] });
    }
    out.push(...fileList(st.changes, 'w', 'nada pra commitar, a árvore está limpa'));
  }

  if (state.commits.length) {
    out.push({ type: 'divider' });
    out.push({ type: 'heading', text: 'Commits recentes' });
    out.push({
      type: 'list',
      items: state.commits.map((c, i) => ({
        title: c.subject,
        subtitle: `${c.hash} · ${c.author} · ${c.when}`,
        icon: 'clock',
        tone: i < st.ahead ? 'accent' : 'faint',
        badge: refBadge(c.refs),
        action: `c:${c.hash}`,
      })),
    });
    if (st.ahead) out.push({ type: 'text', style: 'faint', text: st.ahead === 1 ? 'o em destaque ainda não subiu' : `os ${st.ahead} em destaque ainda não subiram` });
  }
  return out;
}

/** O que decide o botão de commit, na janela e na aba. */
function commitState(st) {
  const pending = st.staged.length + st.changes.length + st.conflicts.length;
  const everything = !st.staged.length && setting('smartCommit', true);
  const canCommit = pending > 0 && !st.conflicts.length && (st.staged.length > 0 || everything);
  return { pending, everything, canCommit };
}

/** "HEAD -> main, origin/main, tag: v2" → "origin/main" ou a tag: o que ajuda a se achar. */
function refBadge(refs) {
  if (!refs) return undefined;
  const list = refs.split(', ').map((r) => r.replace(/^HEAD -> /, ''));
  const tag = list.find((r) => r.startsWith('tag: '));
  if (tag) return tag.slice(5);
  const remote = list.find((r) => r.includes('/') && !r.endsWith('/HEAD'));
  return remote || undefined;
}

function title() {
  return state.root ? `git · ${path.basename(state.root)}` : 'git';
}

// --- a aba da lateral --------------------------------------------------------

/** Quantos arquivos mudaram — um arquivo preparado e mexido de novo conta uma vez. */
function changedCount(st) {
  if (!st) return 0;
  return new Set([...st.staged, ...st.changes, ...st.conflicts].map((f) => f.path)).size;
}

/** O selo do ícone na faixa: o número de arquivos mudados, e nada quando limpo. */
function badgeText() {
  const n = changedCount(state.st);
  return n > 99 ? '99+' : n ? String(n) : '';
}

/** A linha da branch: clicar troca, como o nome da branch na barra do VS Code. */
function branchItem(st) {
  let title = st.head || (st.oid ? `HEAD em ${st.oid.slice(0, 7)}` : '—');
  let subtitle;
  let tone = 'accent';
  if (!st.oid) subtitle = 'sem commit ainda';
  else if (!st.head) {
    subtitle = 'HEAD destacado';
    tone = 'yellow';
  } else if (!st.upstream) subtitle = 'branch não publicada';
  else subtitle = st.upstream;
  const badge = st.upstream && (st.ahead || st.behind) ? `${st.behind}↓ ${st.ahead}↑` : undefined;
  if (st.upstream && st.behind) tone = 'yellow';
  return { title, subtitle, icon: 'branch', tone, badge, action: 'branch' };
}

function sidebarBlocks() {
  const out = [];
  if (state.repos.length > 1) {
    out.push({ type: 'select', id: 'repo', options: state.repos, value: state.root, action: 'repo' });
  }
  if (!state.root) {
    out.push({ type: 'text', style: 'dim', text: 'nenhum repositório git nas pastas da lateral' });
    out.push({ type: 'row', children: [{ type: 'button', action: 'atualizar', icon: 'refresh', style: 'icon', tooltip: 'procurar de novo' }] });
    return out;
  }
  const st = state.st;
  if (!st) {
    out.push({ type: 'text', style: 'error', text: state.error || 'não consegui ler o repositório' });
    out.push({ type: 'row', children: [{ type: 'button', action: 'atualizar', icon: 'refresh', style: 'icon', tooltip: 'tentar de novo' }] });
    return out;
  }
  const busy = !!state.busy;
  const { canCommit, everything, pending } = commitState(st);
  const icon = (action, iconName, tooltip, disabled) => ({ type: 'button', style: 'icon', action, icon: iconName, tooltip, disabled: !!disabled });

  out.push({ type: 'list', flat: true, items: [branchItem(st)] });
  if (state.op) out.push({ type: 'text', style: 'warning', text: `${state.op} parado no meio — resolva e continue no terminal` });

  const publish = st.head && !st.upstream;
  out.push({
    type: 'row',
    children: [
      icon('atualizar', 'refresh', 'atualizar'),
      icon('commit', 'commit', everything && pending ? 'commit de tudo' : 'commit', busy || !canCommit),
      icon('pull', 'pull', st.behind ? `pull (${st.behind}↓)` : 'pull', busy || !st.upstream),
      icon('push', 'push', publish ? 'publicar a branch' : st.ahead ? `push (${st.ahead}↑)` : 'push', busy || !st.head),
      icon('fetch', 'sync', 'fetch', busy),
      icon('preparar-tudo', 'add', 'preparar tudo', busy || !st.changes.length),
      icon('painel', 'open', 'abrir a janela do git'),
    ],
  });
  out.push({
    type: 'input',
    id: `msg.${state.gen}`,
    placeholder: `mensagem (enter faz o commit)`,
    value: state.message,
    submit: 'commit',
  });
  if (state.newBranch) {
    out.push({ type: 'input', id: `nb.${state.gen}`, placeholder: 'nova branch (enter cria e troca)', submit: 'criar-branch' });
    out.push({ type: 'row', children: [icon('criar-branch', 'check', 'criar e trocar', busy), icon('cancelar-branch', 'clear', 'cancelar')] });
  }
  if (state.busy) out.push({ type: 'progress', label: state.busy });
  if (state.error) out.push({ type: 'text', style: 'error', text: state.error });

  if (st.conflicts.length) {
    out.push({ type: 'section', text: 'conflitos', count: st.conflicts.length });
    out.push(...fileList(st.conflicts, 'x', undefined, { flat: true }));
  }
  if (st.staged.length) {
    out.push({ type: 'section', text: 'preparadas', count: st.staged.length });
    out.push(...fileList(st.staged, 's', undefined, { flat: true }));
  }
  if (st.changes.length) {
    out.push({ type: 'section', text: 'mudanças', count: st.changes.length });
    out.push(...fileList(st.changes, 'w', undefined, { flat: true }));
  }
  if (!pending) out.push({ type: 'text', style: 'faint', text: 'nada pra commitar, a árvore está limpa' });

  const commits = state.commits.slice(0, SIDEBAR_COMMITS);
  if (commits.length) {
    out.push({ type: 'section', text: 'commits' });
    out.push({
      type: 'list',
      flat: true,
      items: commits.map((c, i) => ({
        title: c.subject,
        subtitle: `${c.hash} · ${c.when}`,
        icon: 'commit',
        tone: i < st.ahead ? 'accent' : 'faint',
        action: `c:${c.hash}`,
      })),
    });
  }
  return out;
}

/**
 * Redesenha a aba se ela está na tela. Escondida, só o selo acompanha — e só
 * quando mudou; os blocos vão inteiros no próximo sidebar.shown.
 */
async function refreshSidebar() {
  const badge = badgeText();
  try {
    if (state.sidebarShown) {
      const { shown } = await mx.request('sidebar.update', { blocks: sidebarBlocks(), badge });
      state.sidebarShown = shown;
      state.badge = badge;
    } else if (badge !== state.badge) {
      await mx.request('sidebar.update', { badge });
      state.badge = badge;
    }
  } catch (e) {
    mx.log('sidebar.update:', e.message);
  }
}

/** O repositório da aba quando ainda não tem um: o do painel em foco, ou o primeiro. */
async function defaultRoot() {
  try {
    const focused = await mx.request('sessions.focused');
    const here = focused && (await git.toplevel(focused.cwd));
    if (here) return here;
  } catch (e) {
    mx.log('sessions.focused:', e.message);
  }
  return state.repos.length ? state.repos[0].value : null;
}

/** Alguém está olhando: a janela, o diff ou a aba. Só aí vale conferir sozinho. */
function watching() {
  return state.viewOpen || state.diffOpen || state.sidebarShown;
}

async function refresh() {
  if (state.viewOpen) {
    const { open } = await mx.request('view.update', { viewId: VIEW, title: title(), blocks: blocks() });
    state.viewOpen = open;
  }
  if (state.diffOpen) await refreshDiff();
  await refreshSidebar();
  if (!watching()) stopPolling();
}

// --- abrir -------------------------------------------------------------------

/** O repositório do painel em foco; se ele não está num, pergunta. */
async function resolveRoot(cwd) {
  const here = await git.toplevel(cwd);
  if (here) return here;
  if (state.root) return state.root;
  await loadRepos();
  if (!state.repos.length) return null;
  if (state.repos.length === 1) return state.repos[0].value;
  return mx.request('window.pick', {
    title: 'git de qual repositório?',
    placeholder: 'nome da pasta',
    items: state.repos.map((r) => ({ value: r.value, label: r.label, detail: r.value })),
  });
}

/**
 * O botão do rodapé: sempre pergunta. O repositório do painel em foco vem
 * primeiro, pra enter abrir o óbvio.
 */
async function pickRoot(cwd) {
  await loadRepos();
  const here = await git.toplevel(cwd);
  const repos = [...state.repos];
  if (here && !repos.some((r) => r.value === here)) repos.unshift({ value: here, label: path.basename(here) });
  if (!repos.length) return null;
  const rank = (r) => (r.value === here ? 0 : r.value === state.root ? 1 : 2);
  repos.sort((a, b) => rank(a) - rank(b));
  return mx.request('window.pick', {
    title: 'git de qual repositório?',
    placeholder: 'nome da pasta',
    items: repos.map((r) => ({
      value: r.value,
      label: r.value === here ? `${r.label} · painel em foco` : r.value === state.root && state.viewOpen ? `${r.label} · aberto` : r.label,
      detail: r.branch ? `${r.branch} · ${r.value}` : r.value,
    })),
  });
}

async function open(context, { pick = false } = {}) {
  const cwd = context && context.cwd;
  const root = pick ? await pickRoot(cwd) : await resolveRoot(cwd);
  if (!root) {
    // null do seletor é você apertando esc: nada a avisar.
    if (pick && state.repos.length) return;
    await mx.request('window.showBanner', { text: 'nenhum repositório git por aqui — abra um painel numa pasta com git' });
    return;
  }
  if (root !== state.root) {
    state.root = root;
    state.message = '';
    state.gen += 1;
    await closeDiff();
  }
  state.error = null;
  state.newBranch = false;
  await loadRepos();
  await reload();
  await mx.request('view.open', { viewId: VIEW, title: title(), blocks: blocks() });
  state.viewOpen = true;
  startPolling();
}

// --- conferir sozinho --------------------------------------------------------

function startPolling() {
  stopPolling();
  const seconds = Number(setting('poll', 2));
  if (!(seconds > 0)) return;
  state.timer = setInterval(() => {
    if (state.busy || !state.root || !watching()) return;
    serial(async () => {
      let raw;
      try {
        raw = (await git.status(state.root)).raw;
      } catch {
        return;
      }
      if (state.st && raw === state.st.raw) return;
      await reload();
      await refresh();
    }).catch((e) => mx.log('conferir:', String(e.stack || e)));
  }, Math.max(0.5, seconds) * 1000);
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// --- ações -------------------------------------------------------------------

/** Roda `fn` com a faixa de progresso; o erro vira o texto vermelho da janela. */
async function task(label, fn) {
  state.busy = label;
  state.error = null;
  await refresh();
  try {
    await fn();
  } catch (e) {
    state.error = e.message;
  } finally {
    state.busy = null;
    await reload();
    await refresh();
  }
}

async function remoteName() {
  const remotes = (await git.must(state.root, ['remote'])).split('\n').filter(Boolean);
  if (!remotes.length) throw new Error('o repositório não tem remote — adicione um com git remote add');
  return remotes.includes('origin') ? 'origin' : remotes[0];
}

async function commit(values) {
  const message = String(values[`msg.${state.gen}`] || '').trim();
  state.message = message;
  if (!message) {
    state.error = 'escreva a mensagem do commit (ou peça uma ao claude na estrela)';
    return refresh();
  }
  const st = state.st;
  if (!st) return;
  const all = !st.staged.length;
  if (all && !setting('smartCommit', true)) {
    state.error = 'nada preparado — prepare os arquivos ou ligue o commit de tudo nas configurações';
    return refresh();
  }
  await task('fazendo o commit…', async () => {
    if (all) await git.must(state.root, ['add', '-A']);
    // Os hooks de pre-commit rodam aqui, e podem demorar.
    await git.must(state.root, ['commit', '-m', message], { timeout: 10 * 60 * 1000 });
    state.message = '';
    state.gen += 1;
    await mx.request('window.showBanner', { text: `commit feito: ${message}` });
  });
}

async function suggest(values) {
  state.message = String(values[`msg.${state.gen}`] || '');
  const st = state.st;
  if (!st) return;
  await task('pedindo a mensagem ao claude…', async () => {
    const text = await git.diffForMessage(state.root, st.staged.length > 0);
    if (!text.trim()) throw new Error('não há diff pra descrever');
    const recent = state.commits.length ? state.commits : await git.log(state.root, 15);
    const line = await git.suggestMessage(state.root, text, recent.slice(0, 15));
    state.message = line;
    state.gen += 1;
  });
}

// --- a janela do diff --------------------------------------------------------

function findFile(where, file) {
  const st = state.st;
  if (!st) return null;
  const list = where === 's' ? st.staged : where === 'x' ? st.conflicts : st.changes;
  return list.find((x) => x.path === file) || null;
}

/**
 * O diff em linhas de console coloridas: o número da linha antes e depois, e
 * a linha com o + ou o -. Os cabeçalhos do git (index, ---, +++) saem: quem
 * diz de que arquivo é o título da janela. Num commit, cada arquivo ganha uma
 * linha de título, e o que vem antes do primeiro (autor, mensagem, --stat)
 * aparece como está.
 */
function diffLines(text, { commit = false } = {}) {
  const src = text.replace(/\n$/, '').split('\n');
  const out = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let seenFile = false;
  let width = 4;
  for (const m of text.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    width = Math.max(width, String(Number(m[3]) + Number(m[4] || 1)).length, String(Number(m[1]) + Number(m[2] || 1)).length);
  }
  const blank = ' '.repeat(width);
  const num = (n) => String(n).padStart(width);
  for (const raw of src) {
    const line = raw.replace(/\t/g, '    ');
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      seenFile = true;
      if (commit) {
        const m = line.match(/ b\/(.*)$/);
        if (out.length) out.push('');
        out.push({ text: `── ${m ? m[1] : line.slice(11)}`, tone: 'purple' });
      }
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      if (out.length && seenFile) out.push('');
      out.push({ text: `${blank} ${blank}  ${line}`, tone: 'accent' });
      continue;
    }
    if (!inHunk) {
      if (!seenFile) out.push({ text: line, tone: line.startsWith('    ') ? undefined : 'faint' });
      else if (/^(Binary files|new file mode|deleted file mode|old mode|new mode|similarity|rename )/.test(line)) {
        out.push({ text: line, tone: 'faint' });
      }
      continue;
    }
    if (line.startsWith('+')) out.push({ text: `${blank} ${num(newNo++)}  ${line}`, tone: 'green' });
    else if (line.startsWith('-')) out.push({ text: `${num(oldNo++)} ${blank}  ${line}`, tone: 'red' });
    else if (line.startsWith('\\')) out.push({ text: `${blank} ${blank}  ${line}`, tone: 'faint' });
    else out.push({ text: `${num(oldNo++)} ${num(newNo++)}  ${line}` });
  }
  return out;
}

function countChanges(text) {
  let plus = 0;
  let minus = 0;
  for (const l of text.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) plus++;
    else if (l.startsWith('-') && !l.startsWith('---')) minus++;
  }
  return { plus, minus };
}

const WHERE_LABEL = { w: 'mudança não preparada', s: 'preparado', x: 'em conflito' };

function diffBlocks() {
  const d = state.diff;
  const text = state.diffText || '';
  const cut = text.length > PREVIEW_LIMIT ? text.slice(0, PREVIEW_LIMIT) : text;
  const { plus, minus } = countChanges(text);
  const out = [];
  if (d.commit) {
    out.push({ type: 'text', style: 'faint', text: `commit ${d.commit} · +${plus} −${minus}` });
  } else {
    const f = findFile(d.where, d.path);
    out.push({
      type: 'text',
      style: 'faint',
      text: f ? `${d.path} · ${WHERE_LABEL[d.where]} · +${plus} −${minus}` : `${d.path} · sem mudanças agora`,
    });
    if (f) {
      out.push({
        type: 'row',
        children: fileActions(f, d.where).map((a) => ({
          type: 'button',
          action: `${a.verb}:${d.where}:${d.path}`,
          label: a.label,
          icon: a.icon,
          tooltip: a.tooltip,
          style: a.verb === 'd' ? 'danger' : undefined,
          disabled: !!state.busy,
        })),
      });
    }
  }
  const lines = text.trim() ? diffLines(cut, { commit: !!d.commit }) : [];
  if (cut.length < text.length) lines.push({ text: '… (cortado — o resto no terminal)', tone: 'faint' });
  out.push({
    type: 'console',
    id: `d.${state.diffGen}`,
    lines,
    max: Math.max(5000, lines.length),
    expand: true,
    follow: false,
    empty: d.commit ? 'commit vazio' : 'sem diferença de texto (arquivo binário, ou só a permissão mudou)',
  });
  return out;
}

function diffTitle() {
  const d = state.diff;
  return d.commit ? `commit ${d.commit}` : `diff · ${path.basename(d.path)}${d.where === 's' ? ' (preparado)' : ''}`;
}

async function readDiff() {
  const d = state.diff;
  if (d.commit) return git.must(state.root, ['show', '--no-color', '--stat', '--patch', '-M', d.commit]);
  const f = findFile(d.where, d.path);
  if (!f) return '';
  return git.diff(state.root, f.path, { staged: d.where === 's', untracked: !!f.untracked });
}

/** Abre (ou troca) a janela do diff, ao lado da do git. */
async function showDiff(target) {
  state.diff = target;
  state.diffGen += 1;
  try {
    state.diffText = await readDiff();
  } catch (e) {
    state.diffText = '';
    await mx.request('window.showBanner', { text: e.message, sticky: true });
  }
  await mx.request('view.open', { viewId: DIFF_VIEW, title: diffTitle(), blocks: diffBlocks() });
  state.diffOpen = true;
  state.diffBusy = !!state.busy;
  startPolling();
}

/** O diff é de um arquivo do repositório de antes: trocou, ele fecha. */
async function closeDiff() {
  if (!state.diffOpen) return;
  state.diffOpen = false;
  state.diff = null;
  await mx.request('view.close', { viewId: DIFF_VIEW });
}

/**
 * Depois de cada mudança: o arquivo pode ter trocado de lista (preparou,
 * tirou) ou mudado no disco. Segue o arquivo, e só redesenha quando o diff
 * mudou — um redesenho à toa a cada 2s tiraria a seleção de quem está lendo.
 */
async function refreshDiff() {
  const d = state.diff;
  if (!d) return;
  let changedList = false;
  if (!d.commit && !findFile(d.where, d.path)) {
    const other = ['w', 's', 'x'].find((w) => findFile(w, d.path));
    if (other) {
      d.where = other;
      changedList = true;
    }
  }
  let text;
  try {
    text = await readDiff();
  } catch {
    text = '';
  }
  // O busy também conta: os botões da janela travam enquanto algo roda.
  if (text === state.diffText && !changedList && state.diffBusy === !!state.busy) return;
  state.diffText = text;
  state.diffBusy = !!state.busy;
  const { open } = await mx.request('view.update', { viewId: DIFF_VIEW, title: diffTitle(), blocks: diffBlocks() });
  state.diffOpen = open;
}

async function fileAction(verb, where, file) {
  const f = findFile(where, file);
  if (!f) return refresh();
  switch (verb) {
    case 'f':
      return showDiff({ where, path: f.path });
    case 'o':
      return mx.request('editor.open', { path: path.join(state.root, f.path) });
    case 'a':
      return task(where === 'x' ? 'marcando como resolvido…' : 'preparando…', () => git.must(state.root, ['add', '--', f.path]));
    case 'r':
      return task('tirando da preparação…', () => git.must(state.root, ['restore', '--staged', '--', f.path]));
    case 'd': {
      const sure = await mx.request('window.pick', {
        title: f.untracked ? `apagar ${f.path}?` : `descartar as mudanças em ${f.path}?`,
        items: [
          { value: 'nao', label: 'não, deixa' },
          { value: 'sim', label: f.untracked ? 'sim, apagar o arquivo' : 'sim, descartar', detail: 'não dá pra desfazer' },
        ],
      });
      if (sure !== 'sim') return;
      return task('descartando…', () =>
        f.untracked
          ? git.must(state.root, ['clean', '-f', '--', f.path])
          : git.must(state.root, ['restore', '--worktree', '--', f.path]),
      );
    }
    default:
  }
}

async function pickBranch() {
  const { local, remote } = await git.branches(state.root);
  const current = state.st && state.st.head;
  const choice = await mx.request('window.pick', {
    title: current ? `trocar de branch (agora em ${current})` : 'trocar de branch',
    placeholder: 'nome da branch',
    items: [
      { value: '+', label: '+ nova branch a partir daqui…' },
      ...local.map((b) => ({
        value: `l:${b.name}`,
        label: b.name === current ? `${b.name} · atual` : b.name,
        detail: `${b.when} · ${b.subject}`,
      })),
      ...remote.map((b) => ({ value: `r:${b.name}`, label: b.name, detail: `remota · ${b.when} · ${b.subject}` })),
    ],
  });
  if (!choice) return;
  if (choice === '+') {
    state.newBranch = true;
    state.gen += 1;
    return refresh();
  }
  const name = choice.slice(2);
  if (choice.startsWith('l:') && name === current) return;
  const args = choice.startsWith('l:') ? ['switch', name] : ['switch', '--track', name];
  await task(`trocando pra ${name}…`, () => git.must(state.root, args));
}

async function createBranch(values) {
  const name = String(values[`nb.${state.gen}`] || '').trim();
  if (!name) {
    state.error = 'dê um nome pra branch';
    return refresh();
  }
  const ok = await git.run(state.root, ['check-ref-format', '--branch', name]);
  if (ok.code !== 0) {
    state.error = `"${name}" não é um nome de branch válido`;
    return refresh();
  }
  state.newBranch = false;
  await task(`criando ${name}…`, () => git.must(state.root, ['switch', '-c', name]));
}

mx.onNotification('view.action', async ({ viewId, action, values }) => {
  if (viewId !== VIEW && viewId !== DIFF_VIEW && viewId !== SIDEBAR) return;
  values = values || {};
  const at = action.indexOf(':');
  const verb = at < 0 ? action : action.slice(0, at);
  const arg = at < 0 ? '' : action.slice(at + 1);
  // O que está no campo da mensagem sobrevive a qualquer redesenho.
  if (`msg.${state.gen}` in values) state.message = String(values[`msg.${state.gen}`] || '');
  await serial(async () => {
    switch (verb) {
      case 'repo':
        if (values.repo && values.repo !== state.root) {
          state.root = values.repo;
          state.message = '';
          state.newBranch = false;
          state.error = null;
          state.gen += 1;
          await closeDiff();
        }
        await reload();
        return refresh();
      case 'atualizar':
        state.error = null;
        await loadRepos();
        await reload();
        return refresh();
      case 'commit':
        return commit(values);
      case 'sugerir':
        return suggest(values);
      case 'fetch':
        return task('fetch…', async () => git.must(state.root, ['fetch', '--prune', await remoteName()], { timeout: 5 * 60 * 1000 }));
      case 'pull':
        return task('pull…', () => git.must(state.root, ['pull'], { timeout: 5 * 60 * 1000 }));
      case 'push':
        return task(state.st && !state.st.upstream ? 'publicando a branch…' : 'push…', async () => {
          const args = state.st && !state.st.upstream ? ['push', '-u', await remoteName(), 'HEAD'] : ['push'];
          await git.must(state.root, args, { timeout: 10 * 60 * 1000 });
        });
      case 'terminal':
        return mx.request('session.openShell', { cwd: state.root, label: path.basename(state.root) }).catch(() =>
          mx.request('window.showBanner', { text: 'abrir terminal pede a permissão sessions.create' }),
        );
      case 'branch':
        return pickBranch();
      case 'criar-branch':
        return createBranch(values);
      case 'cancelar-branch':
        state.newBranch = false;
        return refresh();
      case 'preparar-tudo':
        return task('preparando tudo…', () => git.must(state.root, ['add', '-A']));
      case 'tirar-tudo':
        return task('tirando tudo da preparação…', () => git.must(state.root, ['restore', '--staged', '--', '.']));
      case 'f':
      case 'o':
      case 'a':
      case 'r':
      case 'd': {
        const [where, ...rest] = arg.split(':');
        return fileAction(verb, where, rest.join(':'));
      }
      case 'c':
        return showDiff({ commit: arg });
      case 'painel':
        // O botão da aba: a janela completa, no repositório escolhido nela.
        return open(null);
      default:
        mx.log('ação desconhecida:', action);
    }
  });
});

mx.onRequest('initialize', (params) => {
  state.settings = params.settings || {};
  return {};
});

mx.onNotification('settings.changed', async ({ settings }) => {
  state.settings = settings || {};
  if (!watching()) return;
  startPolling();
  await serial(async () => {
    await reload();
    await refresh();
  });
});

mx.onNotification('event', async ({ type }) => {
  if (type === 'sidebar.shown') {
    // De novo a cada clique no ícone: a deixa pra reler tudo.
    state.sidebarShown = true;
    await serial(async () => {
      await loadRepos();
      if (!state.root) state.root = await defaultRoot();
      await reload();
      await refresh();
    });
    if (!state.timer) startPolling();
  } else if (type === 'sidebar.hidden') {
    state.sidebarShown = false;
    if (!state.viewOpen && !state.diffOpen) stopPolling();
  }
});

mx.onRequest('command.invoke', async ({ command, context }) => {
  // Sem await: o seletor de repositório espera você, e o command.invoke tem
  // 30s pra voltar.
  const go = (opts) => serial(() => open(context, opts)).catch((e) => mx.log(command, String(e.stack || e)));
  if (command === 'painel') go();
  else if (command === 'repos') go({ pick: true });
  else if (command === 'branch') {
    go().then(() => state.viewOpen && serial(pickBranch)).catch((e) => mx.log('branch:', String(e.stack || e)));
  } else throw new Error(`comando desconhecido: ${command}`);
  return null;
});

mx.start();
