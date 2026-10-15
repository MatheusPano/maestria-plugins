// Worktrees: todas as worktrees dos repositórios da lateral num lugar só, cada
// uma com a descrição da branch (o `git branch --edit-description`), quanto ela
// está à frente da base, o que falta commitar e se tem um claude trabalhando
// nela. Pra lembrar o que era cada uma sem abrir.
//
// A descrição de uma branch com TASK#/BUG# vem sozinha do Wiboor (o título da
// tarefa), na primeira vez que ela aparece sem uma.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mx = require('./maestria');
const git = require('./git');
const wiboor = require('./wiboor');

const SIDEBAR = 'sidebar';
const DETAIL = 'wt.'; // + a chave da worktree: uma janela por worktree
const CLEAN = 'limpar'; // o modal das worktrees já mergeadas

const state = {
  settings: {},
  ui: 1, // o `blocks` do initialize
  dataDir: null,
  repos: [], // [{ key, root, name, base, items: [wt] }]
  sessions: [],
  collapsed: new Set(), // as raízes dos repositórios recolhidos na aba
  sidebarShown: false,
  details: new Set(), // as chaves das janelas abertas
  clean: null, // { found, asking } enquanto o modal de limpar está aberto
  timer: null,
  error: null,
};

const setting = (id, fallback) => (id in state.settings ? state.settings[id] : fallback);
const tilde = (p) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Uma leitura por vez: o poll e um clique não brigam pelo estado.
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch((e) => mx.log(String((e && e.stack) || e)));
  return next;
}

// A chave curta de cada pasta, a mesma enquanto o processo vive: vai nas
// ações e no id da janela.
const keyByPath = new Map();
const pathByKey = new Map();
function keyOf(p) {
  let k = keyByPath.get(p);
  if (!k) {
    k = String(keyByPath.size + 1);
    keyByPath.set(p, k);
    pathByKey.set(k, p);
  }
  return k;
}

function findWt(key) {
  for (const r of state.repos) for (const w of r.items) if (w.key === key) return w;
  return null;
}
const repoOf = (w) => state.repos.find((r) => r.root === w.root);

// --- o que fica guardado ----------------------------------------------------

function loadState() {
  if (!state.dataDir) return;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(state.dataDir, 'state.json'), 'utf8'));
    state.collapsed = new Set(s.collapsed || []);
  } catch {}
}

function saveState() {
  if (!state.dataDir) return;
  try {
    fs.mkdirSync(state.dataDir, { recursive: true });
    fs.writeFileSync(path.join(state.dataDir, 'state.json'), JSON.stringify({ collapsed: [...state.collapsed] }, null, 2));
  } catch (e) {
    mx.log('state.json:', e.message);
  }
}

// --- ler ------------------------------------------------------------------

const bases = new Map(); // raiz → a branch base, que quase nunca muda

/** Um repositório da lateral: as worktrees dele, com descrição e números. */
async function readRepo(folder, { fresh }) {
  const all = await git.worktrees(folder.root);
  const list = all.filter((w) => !w.bare);
  if (!list.length) return null;
  // A raiz é a do checkout principal (o primeiro da lista), mesmo que a pasta
  // da lateral seja uma worktree; num repositório bare, a pasta dele.
  const root = all[0].path;
  if (fresh || !bases.has(root)) bases.set(root, await git.baseRef(root));
  const base = bases.get(root);
  const descs = await git.descriptions(root);
  const items = await Promise.all(
    list.map(async (w) => {
      const s = w.prunable ? { missing: true } : await git.stats(w.path, base);
      return {
        key: keyOf(w.path),
        root,
        path: w.path,
        branch: w.branch,
        head: w.head,
        main: w.path === root,
        locked: w.locked,
        missing: !!s.missing,
        desc: w.branch ? descs.get(w.branch) || null : null,
        ...s,
      };
    }),
  );
  // A principal primeiro; depois a que mexeu por último em cima, e as que sumiram no fim.
  const when = (w) => (w.missing ? -1 : w.last ? w.last.at : 0);
  items.sort((a, b) => b.main - a.main || when(b) - when(a));
  return { key: keyOf(`repo:${root}`), root, name: folder.root === root ? folder.name : path.basename(root), base, items };
}

async function loadSessions() {
  state.sessions = await mx.request('sessions.list').catch(() => []);
}

/** Relê tudo: as pastas da lateral, as worktrees de cada uma e as sessões. */
async function load({ fresh = false } = {}) {
  let folders = [];
  try {
    folders = await mx.request('folders.list');
    state.error = null;
  } catch (e) {
    state.error = `folders.list: ${e.message}`;
  }
  const repos = await Promise.all(folders.filter((f) => f.isRepo).map((f) => readRepo(f, { fresh }).catch((e) => (mx.log(f.root, e.message), null))));
  // Duas pastas da lateral do mesmo repositório (a principal e uma worktree
  // dela) viram um só.
  const seen = new Set();
  state.repos = repos.filter((r) => r && !seen.has(r.root) && seen.add(r.root));
  await loadSessions();
}

/**
 * A sessão que está numa worktree. A pasta principal contém as worktrees de
 * `.claude/worktrees/`, então ganha a worktree de caminho mais comprido.
 */
function sessionAt(w) {
  const all = state.repos.flatMap((r) => r.items);
  const inside = (cwd, p) => cwd === p || cwd.startsWith(p + path.sep);
  const mine = state.sessions.filter((s) => {
    if (!s.cwd || s.exited || !inside(s.cwd, w.path)) return false;
    const best = all.filter((x) => inside(s.cwd, x.path)).sort((a, b) => b.path.length - a.path.length)[0];
    return best && best.key === w.key;
  });
  return mine.find((s) => s.kind === 'claude') || mine[0] || null;
}

// --- o Wiboor ---------------------------------------------------------------

const tried = new Set(); // as branches que já foram perguntadas ao Wiboor

/** As branches com TASK#/BUG# e sem descrição ganham o título da tarefa. */
async function fillFromWiboor() {
  if (!setting('wiboor', true) || !wiboor.hasKey()) return false;
  const todo = state.repos.flatMap((r) => r.items).filter((w) => w.branch && !w.desc && wiboor.refOf(w.branch) && !tried.has(`${w.root}\n${w.branch}`));
  if (!todo.length) return false;
  let changed = false;
  await Promise.all(
    todo.map(async (w) => {
      tried.add(`${w.root}\n${w.branch}`);
      try {
        const title = await wiboor.titleFor(w.branch);
        if (!title) return;
        await git.setDescription(w.root, w.branch, title);
        for (const r of state.repos) for (const x of r.items) if (x.root === w.root && x.branch === w.branch) x.desc = title;
        changed = true;
      } catch (e) {
        mx.log(`wiboor (${w.branch}):`, e.message);
      }
    }),
  );
  return changed;
}

// --- desenhar ---------------------------------------------------------------

/** "agora", "há 5 min", "há 3 h", "há 2 dias", "há 3 sem.", "há 4 meses". */
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  if (d < 14) return `há ${plural(d, 'dia', 'dias')}`;
  if (d < 60) return `há ${Math.floor(d / 7)} sem.`;
  return `há ${plural(Math.floor(d / 30), 'mês', 'meses')}`;
}

const titleOf = (w) => w.desc || w.branch || `destacada em ${(w.head || '').slice(0, 7)}`;

/** Os números da worktree numa linha: "feature/TASK#1 · 2 commits · 3 sem commit". */
function summary(w, { withBranch = true } = {}) {
  if (w.missing) return 'a pasta não existe mais';
  const parts = [];
  if (withBranch && w.desc && w.branch) parts.push(w.branch);
  if (w.main) parts.push('principal');
  if (w.ahead) parts.push(plural(w.ahead, 'commit', 'commits'));
  if (w.dirty) parts.push(`${w.dirty} sem commit`);
  if (parts.length < 2 && w.last) parts.push(`último commit ${ago(w.last.at)}`);
  return parts.join(' · ');
}

function sessionTone(s) {
  if (!s) return undefined;
  return s.needsYou ? 'yellow' : s.kind === 'claude' ? 'green' : 'faint';
}

function rowMenu(w) {
  const k = w.key;
  const s = sessionAt(w);
  const out = [];
  if (w.branch) out.push({ action: `desc:${k}`, label: w.desc ? 'editar a descrição…' : 'descrever…', icon: 'edit' });
  if (w.branch && wiboor.refOf(w.branch)) out.push({ action: `wiboor:${k}`, label: 'usar o título da tarefa do Wiboor', icon: 'task' });
  if (w.missing) {
    if (w.branch) out.push({ action: `copiar-branch:${k}`, label: 'copiar a branch', icon: 'branch' });
    out.push({ action: `podar:${k}`, label: 'limpar do git (prune)', icon: 'trash', tone: 'red' });
    return out;
  }
  out.push({ type: 'divider' });
  out.push(s ? { action: `sessao:${k}`, label: 'ir pra sessão', icon: 'continue' } : { action: `claude:${k}`, label: 'abrir o claude aqui', icon: 'continue' });
  out.push({ action: `terminal:${k}`, label: 'abrir um terminal aqui', icon: 'terminal' });
  out.push({ action: `editor:${k}`, label: 'abrir no VS Code', icon: 'open' });
  out.push({ type: 'divider' });
  if (w.branch) out.push({ action: `copiar-branch:${k}`, label: 'copiar a branch', icon: 'branch' });
  out.push({ action: `copiar-pasta:${k}`, label: 'copiar o caminho', icon: 'copy' });
  if (!w.main) {
    out.push({ type: 'divider' });
    out.push({ action: `remover:${k}`, label: 'remover a worktree…', icon: 'trash', tone: 'red' });
  }
  return out.filter((x, i, a) => !(x.type === 'divider' && (i === 0 || a[i - 1].type === 'divider')));
}

function row(w, indent) {
  const s = sessionAt(w);
  const tone = w.missing ? 'red' : w.dirty ? 'yellow' : 'faint';
  return {
    title: titleOf(w),
    subtitle: summary(w),
    icon: w.main ? 'folder' : 'branch',
    tone,
    avatar: { icon: w.main ? 'folder' : 'branch', color: tone },
    status: sessionTone(s),
    dim: w.missing || undefined,
    indent: indent || undefined,
    meta: s ? (s.needsYou ? 'esperando você' : s.kind === 'claude' ? 'claude' : 'terminal') : undefined,
    metaTone: sessionTone(s),
    badge: state.ui < 2 && s ? 'claude' : undefined,
    selected: state.details.has(w.key) || undefined,
    action: `abrir:${w.key}`,
    actions: w.missing ? [{ action: `podar:${w.key}`, icon: 'trash', tooltip: 'limpar do git (prune)', tone: 'red' }] : [
      ...(w.branch ? [{ action: `desc:${w.key}`, icon: 'edit', tooltip: 'descrever' }] : []),
      s ? { action: `sessao:${w.key}`, icon: 'continue', tooltip: 'ir pra sessão' } : { action: `claude:${w.key}`, icon: 'continue', tooltip: 'abrir o claude aqui' },
    ],
    menu: rowMenu(w),
  };
}

/** Os repositórios que aparecem: com a opção ligada, só os que têm worktree além da principal. */
function visibleRepos() {
  if (!setting('onlyWithWorktrees', true)) return state.repos;
  return state.repos.filter((r) => r.items.some((w) => !w.main));
}

function sidebarBlocks() {
  const repos = visibleRepos();
  const total = repos.reduce((n, r) => n + r.items.filter((w) => !w.main).length, 0);
  const out = [];
  if (state.ui >= 2) {
    out.push({
      type: 'header',
      title: 'Worktrees',
      subtitle: repos.length ? `${plural(total, 'worktree', 'worktrees')} em ${plural(repos.length, 'repositório', 'repositórios')}` : undefined,
      actions: [
        { action: 'limpar', icon: 'clean', tooltip: 'limpar as worktrees já mergeadas…' },
        { action: 'atualizar', icon: 'refresh', tooltip: 'atualizar (e reler a branch base)' },
      ],
    });
  }
  if (state.error) out.push({ type: 'text', style: 'error', text: state.error });
  if (!repos.length) {
    out.push({
      type: 'text',
      style: 'faint',
      text: state.repos.length ? 'nenhum repositório da lateral tem worktree além da pasta principal' : 'nenhum repositório git nas pastas da lateral',
    });
    return out;
  }
  if (state.ui >= 2) {
    const items = [];
    for (const r of repos) {
      const open = !state.collapsed.has(r.root);
      const extra = r.items.filter((w) => !w.main);
      const busy = extra.filter((w) => sessionAt(w)).length;
      items.push({
        title: r.name,
        subtitle: open ? tilde(r.root) : [plural(extra.length, 'worktree', 'worktrees'), busy ? `${busy} com sessão` : null].filter(Boolean).join(' · '),
        strong: true,
        avatar: { icon: 'folder', plain: true },
        expanded: open,
        toggle: `recolher:${r.key}`,
        action: `recolher:${r.key}`,
      });
      if (open) for (const w of r.items) items.push(row(w, 1));
    }
    out.push({ type: 'list', flat: true, items });
    return out;
  }
  // Uma Maestria sem a lista do OrbStack: uma régua por repositório.
  for (const r of repos) {
    const open = !state.collapsed.has(r.root);
    out.push({ type: 'section', text: r.name, collapsed: !open, action: `recolher:${r.key}` });
    if (open) out.push({ type: 'list', flat: true, items: r.items.map((w) => row(w)) });
  }
  out.push({
    type: 'row',
    children: [
      { type: 'button', action: 'atualizar', label: 'atualizar', icon: 'refresh' },
      { type: 'button', action: 'limpar', label: 'limpar as mergeadas…', icon: 'clean' },
    ],
  });
  return out;
}

async function pushSidebar() {
  if (!state.sidebarShown) return;
  try {
    const { shown } = await mx.request('sidebar.update', { blocks: sidebarBlocks() });
    state.sidebarShown = shown;
  } catch (e) {
    mx.log('sidebar.update:', e.message);
  }
}

// --- a janela de uma worktree ---------------------------------------------

const CODE = { M: 'modificado', A: 'novo', D: 'apagado', R: 'renomeado', C: 'copiado', U: 'em conflito', '?': 'não rastreado' };
function codeText(code) {
  const c = code.trim()[0] || '?';
  return CODE[c] || code.trim();
}

async function detailBlocks(w) {
  const r = repoOf(w);
  const base = r && r.base;
  const s = sessionAt(w);
  const k = w.key;
  const max = Math.max(1, Number(setting('commits', 10)) || 10);
  const [commits, files] = w.missing ? [[], []] : await Promise.all([git.commits(w.path, w.main ? null : base, max), git.changes(w.path)]);
  const out = [];
  const headerActions = [
    ...(w.branch ? [{ action: `desc:${k}`, icon: 'edit', tooltip: w.desc ? 'editar a descrição' : 'descrever' }] : []),
    { action: `atualizar:${k}`, icon: 'refresh', tooltip: 'atualizar' },
  ];
  if (state.ui >= 2) {
    out.push({ type: 'header', title: titleOf(w), subtitle: w.desc ? w.branch : w.branch ? 'sem descrição' : 'HEAD destacada', wrap: true, avatar: w.main ? 'folder' : 'branch', status: sessionTone(s), actions: headerActions });
  } else {
    out.push({ type: 'heading', text: titleOf(w) });
    if (w.desc) out.push({ type: 'text', style: 'dim', text: w.branch });
  }
  if (w.branch && !w.desc) {
    const hint = wiboor.refOf(w.branch)
      ? wiboor.hasKey()
        ? 'sem descrição: o lápis escreve uma, ou use o título da tarefa do Wiboor (no botão abaixo).'
        : 'sem descrição: o lápis escreve uma. Com a chave do Wiboor configurada, ela viria do título da tarefa.'
      : 'sem descrição: o lápis escreve uma (é o mesmo que git branch --edit-description).';
    out.push({ type: 'text', style: 'faint', text: hint });
  }
  if (w.missing) out.push({ type: 'text', style: 'warning', text: `a pasta ${tilde(w.path)} não existe mais: o git ainda lembra dela até um prune.` });
  const kv = [
    { key: 'repositório', value: r ? r.name : path.basename(w.root) },
    { key: 'pasta', value: tilde(w.path) },
  ];
  if (!w.missing) {
    if (base && !w.main) kv.push({ key: `em relação a ${base}`, value: `${plural(w.ahead || 0, 'commit', 'commits')} à frente · ${w.behind || 0} atrás`, tone: w.behind ? 'yellow' : undefined });
    kv.push({ key: 'sem commit', value: w.dirty ? plural(w.dirty, 'arquivo', 'arquivos') : 'nada', tone: w.dirty ? 'yellow' : 'green' });
    if (w.last) kv.push({ key: 'último commit', value: `${w.last.subject} (${ago(w.last.at)})` });
  }
  if (s) kv.push({ key: 'sessão', value: `${s.title || s.kind}${s.statusLabel ? ` · ${s.statusLabel}` : ''}`, tone: sessionTone(s) });
  out.push({ type: 'kv', items: kv });
  if (!w.missing) {
    out.push({
      type: 'row',
      children: [
        s ? { type: 'button', action: `sessao:${k}`, label: 'ir pra sessão', style: 'primary', icon: 'continue' } : { type: 'button', action: `claude:${k}`, label: 'abrir o claude aqui', style: 'primary', icon: 'continue' },
        { type: 'button', action: `terminal:${k}`, label: 'terminal', icon: 'terminal' },
        { type: 'button', action: `editor:${k}`, label: 'VS Code', icon: 'open' },
        ...(w.branch && wiboor.refOf(w.branch) && wiboor.hasKey() ? [{ type: 'button', action: `wiboor:${k}`, label: 'título do Wiboor', icon: 'task' }] : []),
      ],
    });
    const what = w.main || !base ? 'últimos commits' : `commits que não estão em ${base}`;
    out.push({ type: 'section', text: what, count: commits.length });
    out.push({
      type: 'list',
      flat: true,
      empty: 'nenhum',
      items: commits.map((c) => ({ title: c.subject, subtitle: `${c.hash} · ${ago(c.at)}`, icon: 'commit', tone: 'faint', actions: [{ action: `copiar-hash:${c.hash}`, icon: 'copy', tooltip: 'copiar o hash' }] })),
    });
    out.push({ type: 'section', text: 'não commitados', count: files.length });
    out.push({
      type: 'list',
      flat: true,
      empty: 'nada pra commitar',
      items: files.slice(0, 50).map((f) => ({
        title: f.path,
        subtitle: codeText(f.code),
        icon: 'file',
        tone: f.code.includes('?') ? 'green' : f.code.includes('D') ? 'red' : 'yellow',
        action: `arquivo:${k}:${f.path}`,
      })),
    });
    if (files.length > 50) out.push({ type: 'text', style: 'faint', text: `e mais ${files.length - 50}` });
  }
  if (!w.main) {
    out.push({ type: 'divider' });
    out.push(
      w.missing
        ? { type: 'button', action: `podar:${k}`, label: 'limpar do git (prune)', style: 'danger', icon: 'trash' }
        : { type: 'button', action: `remover:${k}`, label: 'remover a worktree…', style: 'danger', icon: 'trash' },
    );
  }
  return out;
}

const detailTitle = (w) => (w.branch ? w.branch.replace(/^(feature|hotfix)\//, '') : path.basename(w.path));

async function openDetail(w) {
  state.details.add(w.key);
  await mx.request('view.open', { viewId: DETAIL + w.key, title: detailTitle(w), blocks: await detailBlocks(w) });
  ensurePolling();
  await pushSidebar();
}

async function refreshDetails() {
  for (const k of [...state.details]) {
    const w = findWt(k);
    if (!w) {
      await mx.request('view.close', { viewId: DETAIL + k }).catch(() => {});
      state.details.delete(k);
      continue;
    }
    const { open } = await mx.request('view.update', { viewId: DETAIL + k, title: detailTitle(w), blocks: await detailBlocks(w) }).catch(() => ({ open: false }));
    if (!open) state.details.delete(k);
  }
}

async function render() {
  await pushSidebar();
  await refreshDetails();
}

/** Relê e redesenha; depois, as descrições que faltam vêm do Wiboor. */
async function refresh(opts) {
  await load(opts);
  await render();
  if (await fillFromWiboor()) await render();
}

// --- o poll -----------------------------------------------------------------

const watching = () => state.sidebarShown || state.details.size > 0;

function ensurePolling() {
  const secs = Number(setting('poll', 10)) || 0;
  if (state.timer || !secs || !watching()) return;
  state.timer = setInterval(() => {
    if (!watching()) return stopPolling();
    serial(() => refresh());
  }, secs * 1000);
}

function stopPolling() {
  clearInterval(state.timer);
  state.timer = null;
}

// --- ações ------------------------------------------------------------------

const banner = (text) => mx.request('window.showBanner', { text }).catch(() => {});
const labelOf = (w) => {
  const ref = w.branch && wiboor.refOf(w.branch);
  return ref ? `${ref.kind}#${ref.number}` : path.basename(w.path);
};

async function describe(w) {
  if (!w.branch) return banner('worktrees: uma HEAD destacada não tem branch pra descrever');
  const text = await mx.request('window.input', {
    title: `descrição de ${w.branch}`,
    placeholder: 'o que se faz nesta branch',
    value: w.desc || '',
    prompt: 'fica no .git/config do repositório (git branch --edit-description) e não sobe no push. Um - sozinho apaga.',
  });
  if (text === null || text === undefined) return;
  await git.setDescription(w.root, w.branch, text === '-' ? '' : text);
  // Apagada de propósito: o Wiboor não a escreve de volta neste processo.
  tried.add(`${w.root}\n${w.branch}`);
  await refresh();
}

async function useWiboor(w) {
  if (!wiboor.hasKey()) return banner('worktrees: sem a chave do Wiboor ($WIBOOR_API_KEY ou ~/.config/wiboor/config.json)');
  const title = await wiboor.titleFor(w.branch).catch((e) => (banner(`worktrees: ${e.message}`), undefined));
  if (title === undefined) return;
  if (!title) return banner(`worktrees: não achei a tarefa de ${w.branch} no Wiboor`);
  await git.setDescription(w.root, w.branch, title);
  await refresh();
}

async function remove(w) {
  const s = sessionAt(w);
  const warn = [w.dirty ? `${plural(w.dirty, 'arquivo', 'arquivos')} sem commit ${w.dirty === 1 ? 'vai' : 'vão'} junto` : null, s ? 'tem uma sessão aberta nela' : null].filter(Boolean).join('; ');
  const choice = await mx.request('window.pick', {
    title: `remover a worktree ${tilde(w.path)}?`,
    placeholder: warn || titleOf(w),
    items: [
      { value: 'pasta', label: 'remover a worktree', detail: `apaga a pasta; a branch ${w.branch || ''} fica` },
      ...(w.branch ? [{ value: 'branch', label: 'remover a worktree e apagar a branch', detail: 'git branch -d: a branch só sai se já estiver na base' }] : []),
      { value: '', label: 'cancelar' },
    ],
  });
  if (!choice) return;
  try {
    await git.must(w.root, ['worktree', 'remove', ...(w.dirty || w.locked ? ['--force', '--force'] : []), w.path]);
  } catch (e) {
    return banner(`worktrees: ${e.message}`);
  }
  if (choice === 'branch') {
    const r = await git.run(w.root, ['branch', '-d', w.branch]);
    if (r.code !== 0) await banner(`worktrees: a branch ${w.branch} ficou (ainda não está na base). Pra apagar assim mesmo: git branch -D ${w.branch}`);
  }
  await mx.request('view.close', { viewId: DETAIL + w.key }).catch(() => {});
  state.details.delete(w.key);
  await refresh();
}

// --- limpar as mergeadas ----------------------------------------------------

const splitNames = (text) => String(text || '').split(/[\s,]+/).filter(Boolean);

/**
 * As branches onde as worktrees de um repositório entram: a escolha dele (no
 * .git/config), senão a da configuração. `null` quando ninguém disse ainda.
 */
async function intoOf(r) {
  const own = await git.getConfig(r.root, git.MERGE_INTO);
  const names = splitNames(own || setting('mergeInto', ''));
  return names.length ? names : null;
}

/**
 * As worktrees que dá pra tirar sem perder nada: a branch já entrou numa das
 * branches do repositório por um merge, não há o que commitar e nenhuma sessão
 * está nelas. As que sumiram do disco vão junto (é só o prune). As mergeadas
 * que não dá pra tirar voltam em `skipped`, com o porquê. Os repositórios sem
 * branch escolhida voltam em `ask`, com a sugestão.
 */
async function findMerged({ fetch = true } = {}) {
  const items = [];
  const skipped = [];
  const ask = [];
  const into = new Map(); // raiz → [ref]
  const missing = []; // branches que não existem
  if (fetch) await Promise.all(state.repos.map((r) => git.fetch(r.root)));
  await load();
  for (const r of visibleRepos()) {
    const names = state.clean && state.clean.asking.has(r.root) ? null : await intoOf(r);
    if (!names) {
      ask.push({ r, names: (await intoOf(r)) || (await git.suggestTargets(r.root, r.base)) });
      continue;
    }
    const { refs, unknown } = await git.resolveTargets(r.root, names);
    into.set(r.root, refs);
    for (const n of unknown) missing.push(`${r.name}: ${n}`);
    const lines = await Promise.all(refs.map((t) => git.firstParents(r.root, t)));
    for (const w of r.items) {
      if (w.main) continue;
      if (w.missing) {
        items.push({ w, into: null });
        continue;
      }
      // Mergeada é a que está na história de um alvo mas fora da linha principal
      // de todos: uma branch recém-criada também está na história, só que num
      // commit do próprio main ou develop, e essa não entrou em lugar nenhum.
      if (!w.head || lines.some((l) => l.has(w.head))) continue;
      let to = null;
      for (const t of refs) if (!to && (await git.contains(r.root, t, w.head))) to = t;
      if (!to) continue;
      const why = [w.dirty ? `${w.dirty} sem commit` : null, sessionAt(w) ? 'tem uma sessão aberta' : null, w.locked ? 'travada (git worktree lock)' : null].filter(Boolean);
      if (why.length) skipped.push({ w, why: why.join(', ') });
      else items.push({ w, into: to });
    }
  }
  return { items, skipped, ask, into, missing };
}

function cleanBlocks() {
  const out = [{ type: 'header', title: 'Limpar as worktrees mergeadas', subtitle: 'só as sem nada pra commitar e sem sessão aberta' }];
  const c = state.clean;
  if (!c || !c.found) {
    out.push({ type: 'text', style: 'faint', text: 'buscando o origin e conferindo o que já entrou…' });
    return out;
  }
  const { items, skipped, ask, into, missing } = c.found;
  if (ask.length) {
    out.push({
      type: 'text',
      style: 'dim',
      text: 'Em quais branches as worktrees entram? Uma worktree conta como mergeada quando o último commit dela já está numa delas. Separe por vírgula; a escolha fica no .git/config de cada repositório.',
    });
    for (const { r, names } of ask) out.push({ type: 'input', id: `into:${r.key}`, label: r.name, placeholder: 'main, develop', value: names.join(', '), submit: 'limpar-alvos' });
    out.push({
      type: 'row',
      children: [
        { type: 'button', action: 'limpar-alvos', label: 'salvar e conferir', style: 'primary', icon: 'check' },
        { type: 'button', action: 'limpar-cancelar', label: 'cancelar' },
      ],
    });
    return out;
  }
  if (missing.length) out.push({ type: 'text', style: 'warning', text: `não achei a branch ${missing.join('; ')}` });
  if (!items.length) out.push({ type: 'text', style: 'faint', text: 'nenhuma worktree mergeada pra limpar.' });
  for (const r of visibleRepos()) {
    const mine = items.filter((x) => x.w.root === r.root);
    const refs = into.get(r.root) || [];
    out.push({
      type: 'row',
      align: 'between',
      children: [
        { type: 'text', style: 'dim', text: `${r.name} · ${refs.length ? `entra em ${refs.join(', ')}` : 'sem branch válida'}` },
        { type: 'button', action: `limpar-trocar:${r.key}`, label: 'trocar', icon: 'edit', style: 'icon', tooltip: 'trocar as branches deste repositório' },
      ],
    });
    for (const { w, into: to } of mine) {
      const where = to ? `entrou em ${to}` : 'a pasta não existe mais';
      out.push({ type: 'checkbox', id: `wt:${w.key}`, label: `${titleOf(w)}${w.desc && w.branch ? ` (${w.branch})` : ''} · ${where}`, value: true });
    }
  }
  if (skipped.length) {
    out.push({ type: 'section', text: 'mergeadas que ficam' });
    out.push({ type: 'list', flat: true, items: skipped.map(({ w, why }) => ({ title: titleOf(w), subtitle: why, icon: 'branch', tone: 'faint', avatar: { icon: 'branch', color: 'faint' } })) });
  }
  out.push({ type: 'divider' });
  if (items.some((x) => x.w.branch)) out.push({ type: 'checkbox', id: 'branches', label: 'apagar as branches locais também', value: true });
  out.push({
    type: 'row',
    children: [
      ...(items.length ? [{ type: 'button', action: 'limpar-ok', label: 'remover as marcadas', style: 'danger', icon: 'trash' }] : []),
      { type: 'button', action: 'limpar-cancelar', label: items.length ? 'cancelar' : 'fechar' },
    ],
  });
  return out;
}

/** Confere de novo e redesenha o modal. */
async function checkClean(opts) {
  try {
    state.clean.found = await findMerged(opts);
  } catch (e) {
    state.clean.found = { items: [], skipped: [], ask: [], into: new Map(), missing: [] };
    await banner(`worktrees: ${e.message}`);
  }
  await mx.request('view.update', { viewId: CLEAN, blocks: cleanBlocks() }).catch(() => {});
  await render();
}

async function openClean() {
  state.clean = { found: null, asking: new Set() };
  await mx.request('view.open', { viewId: CLEAN, title: 'limpar worktrees', blocks: cleanBlocks(), modal: true });
  await checkClean();
}

/** Grava as branches que o modal perguntou e confere de novo (sem outro fetch). */
async function saveTargets(values) {
  if (!state.clean || !state.clean.found) return;
  for (const { r } of state.clean.found.ask) {
    const names = splitNames(values[`into:${r.key}`]);
    if (names.length) await git.setConfig(r.root, git.MERGE_INTO, names.join(', '));
    state.clean.asking.delete(r.root);
  }
  state.clean.found = null;
  await mx.request('view.update', { viewId: CLEAN, blocks: cleanBlocks() }).catch(() => {});
  await checkClean({ fetch: false });
}

async function askTargets(repoKey) {
  const r = state.repos.find((x) => x.key === repoKey);
  if (!r || !state.clean) return;
  state.clean.asking.add(r.root);
  await checkClean({ fetch: false });
}

async function runClean(values) {
  const chosen = ((state.clean && state.clean.found && state.clean.found.items) || []).filter((x) => values[`wt:${x.w.key}`] !== false);
  state.clean = null;
  await mx.request('view.close', { viewId: CLEAN }).catch(() => {});
  const failed = [];
  const roots = new Set();
  for (const { w } of chosen) {
    if (w.missing) {
      roots.add(w.root);
      continue;
    }
    try {
      await git.must(w.root, ['worktree', 'remove', w.path]);
    } catch (e) {
      failed.push(`${labelOf(w)}: ${e.message}`);
      continue;
    }
    // -D e não -d: o -d compara com a HEAD da pasta principal (o develop, às
    // vezes), e a gente já conferiu que a branch entrou no origin.
    if (w.branch && values.branches !== false) await git.run(w.root, ['branch', '-D', w.branch]);
    await mx.request('view.close', { viewId: DETAIL + w.key }).catch(() => {});
    state.details.delete(w.key);
  }
  for (const root of roots) await git.run(root, ['worktree', 'prune']);
  if (failed.length) await banner(`worktrees: não deu pra remover ${failed.join('; ')}`);
  await refresh();
}

async function act(action, values = {}) {
  const at = action.indexOf(':');
  const verb = at < 0 ? action : action.slice(0, at);
  const rest = at < 0 ? '' : action.slice(at + 1);
  if (verb === 'atualizar') {
    if (rest) bases.delete(findWt(rest)?.root);
    return refresh({ fresh: !rest });
  }
  if (verb === 'copiar-hash') return mx.request('clipboard.write', { text: rest });
  if (verb === 'limpar') return openClean();
  if (verb === 'limpar-ok') return runClean(values);
  if (verb === 'limpar-alvos') return saveTargets(values);
  if (verb === 'limpar-trocar') return askTargets(rest);
  if (verb === 'limpar-cancelar') {
    state.clean = null;
    return mx.request('view.close', { viewId: CLEAN }).catch(() => {});
  }
  if (verb === 'recolher') {
    const r = state.repos.find((x) => x.key === rest);
    if (!r) return;
    if (state.collapsed.has(r.root)) state.collapsed.delete(r.root);
    else state.collapsed.add(r.root);
    saveState();
    return pushSidebar();
  }
  const [k, ...tail] = rest.split(':');
  const w = findWt(k);
  if (!w) return refresh();
  switch (verb) {
    case 'abrir':
      return openDetail(w);
    case 'desc':
      return describe(w);
    case 'wiboor':
      return useWiboor(w);
    case 'sessao': {
      const s = sessionAt(w);
      return s ? mx.request('session.focus', { tabId: s.id }) : act(`claude:${k}`);
    }
    case 'claude':
      await mx.request('session.openClaude', { cwd: w.path, label: labelOf(w) }).catch((e) => banner(`worktrees: ${e.message}`));
      await loadSessions();
      return render();
    case 'terminal':
      return mx.request('session.openShell', { cwd: w.path, label: labelOf(w) }).catch((e) => banner(`worktrees: ${e.message}`));
    case 'editor':
      return mx.request('editor.open', { path: w.path });
    case 'arquivo':
      return mx.request('editor.open', { path: path.join(w.path, tail.join(':')) });
    case 'copiar-branch':
      return mx.request('clipboard.write', { text: w.branch || '' });
    case 'copiar-pasta':
      return mx.request('clipboard.write', { text: w.path });
    case 'remover':
      return remove(w);
    case 'podar':
      await git.run(w.root, ['worktree', 'prune']);
      return refresh();
    default:
      mx.log('ação desconhecida:', action);
  }
}

/** O seletor rápido: todas as worktrees, pela descrição, pela branch ou pelo repositório. */
async function pickAndOpen() {
  await load();
  const items = [];
  for (const r of state.repos) {
    for (const w of r.items) {
      if (w.main && r.items.length > 1 && setting('onlyWithWorktrees', true)) continue;
      items.push({ value: w.key, label: titleOf(w), detail: [r.name, summary(w)].filter(Boolean).join(' · ') });
    }
  }
  if (!items.length) return banner('worktrees: nenhuma worktree nos repositórios da lateral');
  const k = await mx.request('window.pick', { title: 'abrir qual worktree?', placeholder: 'descrição, branch ou repositório', items });
  if (k) await serial(() => act(`abrir:${k}`));
}

/** "Descrever esta branch": a do painel em foco, como o git wt desc. */
async function describeHere(context) {
  const cwd = context && context.cwd;
  if (!cwd) return banner('worktrees: nenhum painel em foco com pasta');
  const top = await git.run(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return banner(`worktrees: ${tilde(cwd)} não é um repositório git`);
  await load();
  const w = state.repos.flatMap((r) => r.items).find((x) => x.path === top.stdout.trim());
  if (!w) return banner('worktrees: a pasta do painel não está num repositório da lateral');
  return describe(w);
}

mx.onNotification('view.action', async ({ viewId, action, values }) => {
  if (viewId !== SIDEBAR && viewId !== CLEAN && !String(viewId).startsWith(DETAIL)) return;
  await serial(() => act(action, values || {}));
});

mx.onNotification('event', async (e) => {
  switch (e.type) {
    case 'sidebar.shown':
      state.sidebarShown = true;
      await serial(() => refresh());
      return ensurePolling();
    case 'sidebar.hidden':
      state.sidebarShown = false;
      return;
    case 'session.opened':
    case 'session.closed':
    case 'session.status':
      if (!watching()) return;
      return serial(async () => {
        await loadSessions();
        await render();
      });
    default:
  }
});

mx.onRequest('initialize', (params) => {
  state.settings = params.settings || {};
  state.ui = Number(params.blocks) || 1;
  state.dataDir = params.dataDir || null;
  loadState();
  return {};
});

mx.onNotification('settings.changed', async ({ settings }) => {
  state.settings = settings || {};
  stopPolling();
  ensurePolling();
  if (watching()) await serial(() => refresh());
});

mx.onRequest('command.invoke', async ({ command, context }) => {
  // Sem await: o seletor espera você, e o command.invoke tem 30s pra voltar.
  const go = (fn) => fn().catch((e) => mx.log(command, String((e && e.stack) || e)));
  if (command === 'lista') go(pickAndOpen);
  else if (command === 'limpar') go(() => serial(openClean));
  else if (command === 'descrever') go(() => serial(() => describeHere(context)));
  else throw new Error(`comando desconhecido: ${command}`);
  return null;
});

mx.start();
