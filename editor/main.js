// Editor: a Maestria como IDE. A aba da lateral é a árvore da pasta (com o estado
// de cada arquivo no git) e a busca em todos os arquivos; a tela do plugin é o
// editor, com os arquivos em abas.
//
// O editor em si é o `CodeEditor` da Maestria (`ui/editor.rfwtxt`): o texto que
// você digita mora nela, num buffer por arquivo, e chega aqui num "change" um
// pouco depois de você parar de digitar e num "save" no ⌘S. O que é do plugin é
// o arquivo: ler, gravar, dizer o que não está salvo, perguntar antes de fechar
// e vigiar o disco -- quando o claude mexe num arquivo aberto e você não, a aba
// recarrega sozinha; quando os dois mexeram, ela pergunta qual fica.
//
// A aba da lateral é feita de blocos, e não de widgets: a lista do OrbStack já
// tem o recuo, a seta de abrir e fechar e o menu do botão direito, e só os
// blocos têm um campo de texto -- o da busca.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mx = require('./maestria');
const files = require('./files');
const icons = require('./icons');

const VIEW = 'editor';
const SIDEBAR = 'sidebar';
const LIBRARY = fs.readFileSync(path.join(__dirname, 'ui', 'editor.rfwtxt'), 'utf8');
// A árvore aberta inteira num monorepo vira dezenas de milhares de linhas; a aba
// para aqui e diz que parou.
const MAX_ROWS = 3000;
// Quanto o plugin espera o último "change" antes de decidir que uma aba está
// salva: o editor manda o texto 350 ms depois da última tecla.
const SETTLE_MS = 450;

const state = {
  dataDir: process.env.MAESTRIA_PLUGIN_DATA || '',
  settings: {},
  // O que esta Maestria sabe fazer (o `initialize`).
  caps: { editor: false, rfw: false, input: false, form: false, blocks: 1 },
  root: null, // a pasta aberta, caminho absoluto
  repo: null, // a raiz do repositório dela, se for um
  branch: '',
  git: new Map(), // caminho absoluto → M, A, U, D, C ou I (ver files.gitStatus)
  gitKey: '',
  expanded: new Set(), // as pastas abertas na árvore, caminhos absolutos
  recent: [], // as pastas abertas antes, a mais nova primeiro
  // As abas: { path, text (o que está no disco), buffer (o do editor, quando
  // difere), mtime, eol, rev, language, line, column, jump, deleted, conflict,
  // disk (o texto do disco num conflito), error }.
  tabs: [],
  active: -1,
  cursor: { line: 1, column: 1, selected: 0 },
  lastKey: 0, // quando chegou o último cursor: alguém está digitando
  jumpSeq: 0,
  // O que o editor já recebeu do arquivo da vez: mandar `file` de novo é mandar
  // o texto inteiro, então só quando ele muda.
  sent: '',
  viewOpen: false,
  sidebarShown: false,
  sidebarKey: '',
  mode: 'files', // a aba da lateral: 'files' | 'search'
  search: { query: '', regex: false, scope: null, results: [], total: 0, truncated: false, running: false, error: '', collapsed: new Set(), engine: '' },
};

const setting = (id, fallback) => (state.settings[id] === undefined || state.settings[id] === null ? fallback : state.settings[id]);

const hidden = () =>
  new Set(
    String(setting('hide', '.git, .DS_Store'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = os.homedir();
const tilde = (p) => (p.startsWith(home + path.sep) || p === home ? `~${p.slice(home.length)}` : p);

/** O caminho como a tela diz: relativo à pasta aberta quando está dentro dela. */
function rel(p) {
  if (state.root && (p === state.root || p.startsWith(state.root + path.sep))) return path.relative(state.root, p) || path.basename(p);
  return tilde(p);
}

const activeTab = () => state.tabs[state.active] || null;
const dirty = (t) => t.buffer !== null && t.buffer !== undefined;
const tabOf = (p) => state.tabs.find((t) => t.path === p) || null;

/** As ações chegam como `verbo:argumento`, e o argumento é um caminho com `:` às vezes. */
function split(action) {
  const i = action.indexOf(':');
  return i < 0 ? [action, ''] : [action.slice(0, i), action.slice(i + 1)];
}

async function safe(what, fn) {
  try {
    return await fn();
  } catch (e) {
    mx.log(`${what}:`, String((e && e.stack) || e));
    banner(`${what}: ${(e && e.message) || e}`);
    return undefined;
  }
}

function banner(text) {
  mx.request('window.showBanner', { text }).catch(() => {});
}

// --- o que fica no disco -------------------------------------------------------------

const stateFile = () => path.join(state.dataDir, 'state.json');
const unsavedFile = () => path.join(state.dataDir, 'unsaved.json');

function persist() {
  if (!state.dataDir) return;
  try {
    fs.mkdirSync(state.dataDir, { recursive: true });
    fs.writeFileSync(
      stateFile(),
      JSON.stringify(
        {
          root: state.root,
          recent: state.recent,
          expanded: [...state.expanded],
          tabs: state.tabs.map((t) => t.path),
          active: state.active,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    mx.log('guardar o estado:', e.message);
  }
}

// O que você não salvou sobrevive a fechar o app (o "hot exit" do VS Code): o
// texto das abas sujas vai pra cá a cada mudança, e volta como não salvo.
let backupTimer = null;
function backup(now = false) {
  if (!state.dataDir) return;
  clearTimeout(backupTimer);
  const write = () => {
    const unsaved = {};
    for (const t of state.tabs) if (dirty(t)) unsaved[t.path] = t.buffer;
    try {
      fs.mkdirSync(state.dataDir, { recursive: true });
      if (Object.keys(unsaved).length) fs.writeFileSync(unsavedFile(), JSON.stringify(unsaved));
      else fs.rmSync(unsavedFile(), { force: true });
    } catch (e) {
      mx.log('guardar o não salvo:', e.message);
    }
  };
  if (now) write();
  else backupTimer = setTimeout(write, 1500);
}

function restore() {
  let saved = {};
  let unsaved = {};
  try {
    saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    // primeira vez
  }
  try {
    unsaved = JSON.parse(fs.readFileSync(unsavedFile(), 'utf8'));
  } catch {
    // nada guardado
  }
  state.recent = Array.isArray(saved.recent) ? saved.recent.filter((p) => isDir(p)).slice(0, 8) : [];
  state.expanded = new Set(Array.isArray(saved.expanded) ? saved.expanded : []);
  if (saved.root && isDir(saved.root)) state.root = saved.root;
  for (const p of Array.isArray(saved.tabs) ? saved.tabs : []) {
    const t = load(p);
    if (typeof unsaved[p] === 'string' && unsaved[p] !== t.text) t.buffer = unsaved[p];
    if (t.error && !dirty(t)) continue;
    state.tabs.push(t);
  }
  state.active = Math.min(Math.max(Number(saved.active) || 0, 0), state.tabs.length - 1);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// --- a pasta aberta ------------------------------------------------------------------

async function setRoot(dir) {
  state.root = dir;
  state.repo = await files.gitRoot(dir);
  state.branch = state.repo ? await files.branch(dir) : '';
  state.recent = [dir, ...state.recent.filter((p) => p !== dir)].slice(0, 8);
  state.search = { ...state.search, results: [], total: 0, error: '', scope: null };
  await refreshGit();
  persist();
}

/**
 * Garante uma pasta aberta: a de antes, a do painel em foco, a primeira da
 * lateral -- nessa ordem --, e senão pergunta.
 */
async function ensureRoot({ ask = true } = {}) {
  if (state.root && isDir(state.root)) {
    if (!state.repo && state.git.size === 0) {
      state.repo = await files.gitRoot(state.root);
      state.branch = state.repo ? await files.branch(state.root) : '';
      await refreshGit();
    }
    return true;
  }
  const focused = await mx.request('sessions.focused').catch(() => null);
  if (focused && focused.cwd && isDir(focused.cwd)) {
    await setRoot((await files.gitRoot(focused.cwd)) || focused.cwd);
    return true;
  }
  if (!ask) return false;
  return pickRoot();
}

/** O seletor de pasta: as da lateral (e as worktrees delas), as recentes, ou um caminho. */
async function pickRoot() {
  const folders = await mx.request('folders.list').catch(() => []);
  const items = [];
  const seen = new Set();
  const add = (p, label, detail) => {
    if (!p || seen.has(p) || !isDir(p)) return;
    seen.add(p);
    items.push({ value: p, label, detail });
  };
  for (const f of folders || []) {
    add(f.root, f.name || path.basename(f.root), [tilde(f.root), f.branch].filter(Boolean).join(' · '));
    for (const w of f.worktrees || []) {
      if (!w.isMain) add(w.path, `${f.name || path.basename(f.root)} · ${w.label || path.basename(w.path)}`, [w.branch, tilde(w.path)].filter(Boolean).join(' · '));
    }
  }
  for (const p of state.recent) add(p, path.basename(p), `recente · ${tilde(p)}`);
  items.push({ value: '::path', label: 'outra pasta…', detail: 'digitar o caminho' });
  const choice = await mx.request('window.pick', { title: 'abrir uma pasta no editor', placeholder: 'nome da pasta', items });
  if (!choice) return false;
  let dir = choice;
  if (choice === '::path') {
    const typed = await mx.request('window.input', { title: 'abrir uma pasta', placeholder: '~/repos/projeto', prompt: 'o caminho da pasta' });
    if (!typed) return false;
    dir = path.resolve(typed.replace(/^~(?=$|\/)/, home));
    if (!isDir(dir)) {
      banner(`não achei a pasta ${tilde(dir)}`);
      return false;
    }
  }
  await setRoot(dir);
  await pushSidebar(true);
  return true;
}

async function refreshGit() {
  const status = await files.gitStatus(state.repo);
  const key = [...status].map(([k, v]) => `${k}${v}`).join('|');
  const changed = key !== state.gitKey;
  state.git = status;
  state.gitKey = key;
  return changed;
}

// --- as abas -------------------------------------------------------------------------

/** Uma aba nova pro arquivo, já lido. */
function load(p) {
  const r = files.read(p);
  return {
    path: p,
    text: r.text === undefined ? '' : r.text,
    buffer: null,
    mtime: r.mtime || null,
    eol: r.eol || 'lf',
    rev: 1,
    language: files.language(p),
    line: null,
    column: null,
    jump: 0,
    deleted: r.error === 'o arquivo não existe mais',
    conflict: false,
    disk: null,
    error: r.error && r.error !== 'o arquivo não existe mais' ? r.error : null,
  };
}

/** Abre (ou traz) o arquivo numa aba, e leva o cursor à linha, se vier. */
async function openFile(p, { line, column } = {}) {
  let i = state.tabs.findIndex((t) => t.path === p);
  if (i < 0) {
    const t = load(p);
    if (t.deleted) {
      banner(`${rel(p)} não existe mais`);
      return;
    }
    // Ao lado da aba da vez, como no VS Code.
    i = state.active < 0 ? state.tabs.length : state.active + 1;
    state.tabs.splice(i, 0, t);
  }
  state.active = i;
  const t = state.tabs[i];
  if (line) {
    t.line = line;
    t.column = column || 1;
    t.jump = ++state.jumpSeq;
  }
  reveal(p);
  persist();
  await paint({ raise: true });
  await pushSidebar();
}

/** Abre as pastas de cima de `p` na árvore. */
function reveal(p) {
  if (!state.root || !p.startsWith(state.root + path.sep)) return;
  let up = path.dirname(p);
  while (up.length > state.root.length) {
    state.expanded.add(up);
    up = path.dirname(up);
  }
}

/** Espera o último "change" quando alguém acabou de digitar. */
async function settle() {
  const wait = SETTLE_MS - (Date.now() - state.lastKey);
  if (wait > 0) await sleep(wait);
}

/** Fecha as abas; uma não salva pergunta antes. Devolve `false` se você desistiu. */
async function closeTabs(paths) {
  await settle();
  for (const p of paths) {
    const t = tabOf(p);
    if (!t) continue;
    if (dirty(t)) {
      state.active = state.tabs.indexOf(t);
      await paint();
      const choice = await askSave(t);
      if (choice === 'cancel' || !choice) return false;
      if (choice === 'save' && !(await save(t, t.buffer))) return false;
    }
    const i = state.tabs.indexOf(t);
    state.tabs.splice(i, 1);
    if (state.active > i || state.active >= state.tabs.length) state.active -= 1;
    if (state.active < 0 && state.tabs.length) state.active = 0;
  }
  persist();
  backup();
  await paint();
  await pushSidebar();
  return true;
}

async function askSave(t) {
  const title = `Salvar as alterações em ${path.basename(t.path)}?`;
  if (state.caps.form) {
    const r = await mx.request('window.form', {
      title,
      fields: [],
      buttons: [
        { action: 'save', label: 'Salvar', style: 'primary' },
        { action: 'discard', label: 'Não salvar', style: 'danger' },
        { action: 'cancel', label: 'Cancelar' },
      ],
    });
    return r ? r.action : 'cancel';
  }
  return mx.request('window.pick', {
    title,
    items: [
      { value: 'save', label: 'salvar' },
      { value: 'discard', label: 'não salvar', detail: 'o que você mudou se perde' },
      { value: 'cancel', label: 'cancelar' },
    ],
  });
}

/** Grava o texto da aba. */
async function save(t, text) {
  try {
    fs.mkdirSync(path.dirname(t.path), { recursive: true });
    t.mtime = files.write(t.path, text, t.eol);
  } catch (e) {
    banner(`não salvou ${rel(t.path)}: ${e.message}`);
    return false;
  }
  t.text = text;
  t.buffer = null;
  t.conflict = false;
  t.disk = null;
  t.deleted = false;
  backup();
  await paint();
  // O git muda com o arquivo: a letra na árvore.
  if (await refreshGit()) await pushSidebar();
  return true;
}

// --- a vigia do disco ----------------------------------------------------------------

let ticks = 0;
async function poll() {
  ticks++;
  let repaint = false;
  if (state.viewOpen) {
    for (const t of state.tabs) {
      if (t.error) continue;
      const m = files.mtime(t.path);
      if (m === null) {
        if (!t.deleted) {
          t.deleted = true;
          repaint = true;
        }
        continue;
      }
      if (m === t.mtime && !t.deleted) continue;
      const r = files.read(t.path);
      t.mtime = r.mtime || m;
      if (r.error) continue;
      if (t.deleted) {
        t.deleted = false;
        repaint = true;
      }
      if (r.text === t.text) continue;
      if (!dirty(t) || r.text === t.buffer) {
        // Ninguém mexeu aqui: o disco ganha, e o cursor fica onde estava.
        t.text = r.text;
        t.buffer = null;
        t.eol = r.eol;
        t.rev += 1;
        t.conflict = false;
      } else {
        t.conflict = true;
        t.disk = r.text;
      }
      repaint = true;
    }
  }
  if (repaint) await paint();
  if (state.sidebarShown && state.root && ticks % 2 === 0) {
    const changed = await refreshGit();
    await pushSidebar(changed);
  }
}

setInterval(() => {
  poll().catch((e) => mx.log('vigia:', String(e.stack || e)));
}, 1500);

// --- a janela do editor --------------------------------------------------------------

function tabsData() {
  const names = new Map();
  for (const t of state.tabs) names.set(path.basename(t.path), (names.get(path.basename(t.path)) || 0) + 1);
  return state.tabs.map((t, i) => {
    const name = path.basename(t.path);
    return {
      name,
      svg: icons.fileIcon(name),
      // Dois abertos com o mesmo nome: a pasta de cada um, apagada, ao lado.
      hint: names.get(name) > 1 ? [path.basename(path.dirname(t.path))] : [],
      active: i === state.active,
      dirty: dirty(t),
      deleted: t.deleted,
      open: `focus:${t.path}`,
      close: `close:${t.path}`,
      menu: [
        { label: 'Fechar', action: `close:${t.path}`, icon: 'clear' },
        { label: 'Fechar as outras', action: `close-others:${t.path}` },
        { label: 'Fechar as da direita', action: `close-right:${t.path}` },
        { label: 'Fechar as salvas', action: 'close-saved' },
        { label: 'Fechar todas', action: 'close-all' },
        { divider: true },
        { label: 'Copiar o caminho', action: `copy:${t.path}`, icon: 'copy' },
        { label: 'Copiar o caminho relativo', action: `copy-rel:${t.path}` },
        { label: 'Mostrar na árvore', action: `reveal:${t.path}`, icon: 'folder' },
        { label: 'Abrir no VS Code', action: `vscode:${t.path}`, icon: 'open' },
      ],
    };
  });
}

function bannerData(t) {
  if (t && t.conflict) {
    return {
      show: true,
      text: 'Este arquivo mudou no disco enquanto você também mexia nele.',
      actions: [
        { label: 'Usar o do disco', a: 'take-disk', primary: false },
        { label: 'Manter o meu', a: 'keep-mine', primary: true },
      ],
    };
  }
  if (t && t.deleted) {
    return {
      show: true,
      text: 'O arquivo foi apagado do disco. O ⌘S cria ele de novo com o que está aqui.',
      actions: [{ label: 'Fechar a aba', a: `close:${t.path}`, primary: false }],
    };
  }
  return { show: false, text: '', actions: [] };
}

function statusData(t) {
  const left = [];
  const right = [];
  if (t && !t.error) {
    const c = state.cursor;
    const sel = c.selected ? ` (${c.selected} selecionado${c.selected > 1 ? 's' : ''})` : '';
    left.push({ text: `Ln ${c.line}, Col ${c.column}${sel}`, a: 'goto', icon: [], tone: '' });
    if (dirty(t)) left.push({ text: 'não salvo', a: 'save-active', icon: [], tone: 'yellow' });
  }
  if (state.branch) right.push({ text: state.branch, a: '', icon: ['branch'], tone: '' });
  if (t && !t.error) {
    right.push({ text: t.eol === 'crlf' ? 'CRLF' : 'LF', a: '', icon: [], tone: '' });
    right.push({ text: files.languageLabel(t.language), a: 'language', icon: [], tone: '' });
  }
  return { left, right };
}

function emptyData() {
  const recent = state.recent.filter((p) => p !== state.root).slice(0, 5);
  return {
    title: state.root ? path.basename(state.root) : 'Editor',
    sub: state.root ? [tilde(state.root), state.branch].filter(Boolean).join(' · ') : 'nenhuma pasta aberta',
    actions: [
      { icon: 'search', label: 'Abrir arquivo pelo nome', chord: '⌘P', a: 'quick', detail: [] },
      { icon: 'search', label: 'Buscar em todos os arquivos', chord: '⇧⌘F', a: 'search', detail: [] },
      { icon: 'add', label: 'Novo arquivo', chord: '', a: state.root ? `new-file:${state.root}` : 'pick-root', detail: [] },
      { icon: 'folder', label: state.root ? 'Abrir outra pasta…' : 'Abrir uma pasta…', chord: '', a: 'pick-root', detail: [] },
    ],
    recentTitle: recent.length ? ['PASTAS RECENTES'] : [],
    recent: recent.map((p) => ({ icon: 'folder', label: path.basename(p), detail: [tilde(p)], chord: '', a: `root:${p}` })),
  };
}

/** O que vai em `data`. `file` só quando o editor ainda não tem o arquivo da vez. */
function viewData(full) {
  const t = activeTab();
  const mode = !t ? 'empty' : t.error ? 'error' : 'editor';
  const data = {
    mode,
    tabs: tabsData(),
    crumb: {
      path: t ? rel(t.path).split(path.sep).join('  ›  ') : '',
      buttons: t
        ? [
            { icon: 'folder', tooltip: 'mostrar na árvore', a: `reveal:${t.path}` },
            { icon: 'open', tooltip: 'abrir no VS Code', a: `vscode:${t.path}` },
          ]
        : [],
    },
    banner: bannerData(t),
    status: statusData(t),
    opts: { fontSize: Number(setting('fontSize', 13)) || 13, wordWrap: !!setting('wordWrap', false) },
    empty: emptyData(),
    error: t && t.error
      ? {
          title: path.basename(t.path),
          text: `Não abre aqui: ${t.error}.`,
          actions: [
            { label: 'Abrir no VS Code', a: `vscode:${t.path}` },
            { label: 'Mostrar no Finder', a: `finder:${t.path}` },
            { label: 'Fechar a aba', a: `close:${t.path}` },
          ],
        }
      : { title: '', text: '', actions: [] },
  };
  if (t && !t.error) {
    const key = `${t.path}\0${t.rev}\0${t.jump}\0${t.language}`;
    if (full || key !== state.sent) {
      data.file = {
        path: t.path,
        // O editor só lê o texto quando ainda não tem o arquivo, ou numa `rev` nova.
        text: dirty(t) ? t.buffer : t.text,
        rev: t.rev,
        language: t.language,
        jump: t.jump,
        readOnly: false,
      };
      // O rfw não aceita null nos dados: sem pulo pedido, os campos nem vão.
      if (t.line) {
        data.file.line = t.line;
        data.file.column = t.column || 1;
      }
      state.sent = key;
    }
  }
  return data;
}

const viewTitle = () => {
  const t = activeTab();
  return t ? `${dirty(t) ? '● ' : ''}${path.basename(t.path)}` : state.root ? path.basename(state.root) : 'Editor';
};

/**
 * Desenha a janela do editor. `raise` a abre (ou traz pra frente); sem ele, só
 * atualiza a que está aberta -- fechada por você, ela fica fechada.
 */
async function paint({ raise = false } = {}) {
  if (!state.caps.editor) {
    if (!raise && !state.viewOpen) return;
    await mx.request('view.open', {
      viewId: VIEW,
      title: 'Editor',
      blocks: [
        { type: 'heading', text: 'Atualize a Maestria' },
        {
          type: 'text',
          text: 'O editor precisa do CodeEditor, que veio numa versão mais nova da Maestria. Atualize o app e reinicie o plugin.',
        },
      ],
    });
    state.viewOpen = true;
    return;
  }
  if (raise || !state.viewOpen) {
    if (!raise) return;
    state.sent = '';
    await mx.request('view.open', {
      viewId: VIEW,
      title: viewTitle(),
      rfw: { library: LIBRARY, root: 'root' },
      data: viewData(true),
    });
    state.viewOpen = true;
    return;
  }
  const r = await mx.request('view.update', { viewId: VIEW, title: viewTitle(), data: viewData(false) });
  if (r && r.open === false) {
    // Você fechou a janela: os buffers dela foram junto, e o próximo abrir manda
    // o texto de novo (o não salvo vem daqui).
    state.viewOpen = false;
    state.sent = '';
  }
}

/** Só a barra de baixo: o cursor anda a cada tecla. */
async function paintStatus() {
  if (!state.viewOpen || !state.caps.editor) return;
  const r = await mx.request('view.update', { viewId: VIEW, data: { status: statusData(activeTab()) } });
  if (r && r.open === false) {
    state.viewOpen = false;
    state.sent = '';
  }
}

// --- a aba da lateral ----------------------------------------------------------------

const TONE = { M: 'yellow', A: 'green', U: 'green', D: 'red', C: 'red' };

function fileMenu(p) {
  return [
    { action: `open:${p}`, label: 'Abrir', icon: 'file' },
    { action: `new-file:${path.dirname(p)}`, label: 'Novo arquivo aqui…', icon: 'add' },
    { type: 'divider' },
    { action: `rename:${p}`, label: 'Renomear…', icon: 'edit' },
    { action: `delete:${p}`, label: 'Apagar…', icon: 'trash', tone: 'red' },
    { type: 'divider' },
    { action: `copy:${p}`, label: 'Copiar o caminho', icon: 'copy' },
    { action: `copy-rel:${p}`, label: 'Copiar o caminho relativo' },
    { action: `finder:${p}`, label: 'Mostrar no Finder', icon: 'folder' },
    { action: `vscode:${p}`, label: 'Abrir no VS Code', icon: 'open' },
  ];
}

function dirMenu(p) {
  return [
    { action: `new-file:${p}`, label: 'Novo arquivo…', icon: 'add' },
    { action: `new-folder:${p}`, label: 'Nova pasta…', icon: 'folder' },
    { action: `search-in:${p}`, label: 'Buscar nesta pasta…', icon: 'search' },
    { type: 'divider' },
    { action: `rename:${p}`, label: 'Renomear…', icon: 'edit' },
    { action: `delete:${p}`, label: 'Apagar…', icon: 'trash', tone: 'red' },
    { type: 'divider' },
    { action: `terminal:${p}`, label: 'Abrir um terminal aqui', icon: 'terminal' },
    { action: `claude:${p}`, label: 'Abrir o claude aqui', icon: 'play' },
    { action: `copy:${p}`, label: 'Copiar o caminho', icon: 'copy' },
    { action: `finder:${p}`, label: 'Mostrar no Finder', icon: 'folder' },
  ];
}

function treeItems() {
  const items = [];
  const hide = hidden();
  const activePath = activeTab() && activeTab().path;
  let cut = false;
  const walk = (dir, depth) => {
    for (const e of files.list(dir, hide)) {
      if (items.length >= MAX_ROWS) {
        cut = true;
        return;
      }
      const p = path.join(dir, e.name);
      const code = state.git.get(p);
      const ignored = code === 'I' || files.ignored(state.git, p, state.repo);
      const t = tabOf(p);
      const item = {
        title: e.name,
        // `icon` e `tone` são pra uma Maestria que ainda não desenha o `avatar`.
        icon: e.dir ? 'folder' : 'file',
        avatar: { svg: icons.iconFor(p, { dir: e.dir, open: e.dir && state.expanded.has(p) }), size: 16 },
        indent: depth,
        dim: ignored,
        menu: e.dir ? dirMenu(p) : fileMenu(p),
      };
      if (!ignored && TONE[code]) {
        item.tone = TONE[code];
        // O nome na cor do git, como na árvore do VS Code: o ícone é do tipo.
        item.titleTone = TONE[code];
        // A pasta só fica colorida; a letra é do arquivo.
        if (!e.dir) {
          item.meta = code === 'U' ? 'U' : code;
          item.metaTone = TONE[code];
        }
      }
      if (t && dirty(t)) {
        item.meta = '●';
        delete item.metaTone;
      }
      if (e.dir) {
        const open = state.expanded.has(p);
        item.expanded = open;
        item.action = `toggle:${p}`;
        item.toggle = `toggle:${p}`;
        items.push(item);
        if (open) walk(p, depth + 1);
      } else {
        item.action = `open:${p}`;
        item.selected = p === activePath;
        items.push(item);
      }
    }
  };
  walk(state.root, 0);
  return { items, cut };
}

function header() {
  return {
    type: 'header',
    title: path.basename(state.root),
    subtitle: [state.branch, tilde(path.dirname(state.root))].filter(Boolean).join(' · '),
    avatar: { icon: 'icons/code.svg', color: 'accent' },
    actions: [
      { action: `new-file:${state.root}`, icon: 'add', tooltip: 'novo arquivo' },
      { action: 'collapse', icon: 'remove', tooltip: 'recolher as pastas' },
      {
        icon: 'more',
        tooltip: 'mais',
        menu: [
          { action: 'quick', label: 'Abrir arquivo pelo nome…  ⌘P', icon: 'search' },
          { action: `new-folder:${state.root}`, label: 'Nova pasta…', icon: 'folder' },
          { action: 'pick-root', label: 'Abrir outra pasta…', icon: 'folder' },
          { action: 'refresh', label: 'Reler a pasta', icon: 'refresh' },
          { type: 'divider' },
          { action: `terminal:${state.root}`, label: 'Abrir um terminal aqui', icon: 'terminal' },
          { action: `claude:${state.root}`, label: 'Abrir o claude aqui', icon: 'play' },
          { action: `finder:${state.root}`, label: 'Mostrar no Finder', icon: 'folder' },
        ],
      },
    ],
  };
}

function modeTabs() {
  const s = state.search;
  return {
    type: 'tabs',
    align: 'center',
    items: [
      { label: 'Arquivos', action: 'mode:files', active: state.mode === 'files', icon: 'file' },
      { label: 'Buscar', action: 'mode:search', active: state.mode === 'search', icon: 'search', count: s.total || undefined },
    ],
  };
}

function searchBlocks() {
  const s = state.search;
  const blocks = [
    { type: 'input', id: 'query', icon: 'search', placeholder: 'buscar em todos os arquivos', submit: 'search-run', value: s.query },
    { type: 'checkbox', id: 'regex', label: 'expressão regular', value: s.regex, action: 'search-regex' },
  ];
  if (s.scope && s.scope !== state.root) {
    blocks.push({
      type: 'row',
      children: [
        { type: 'button', action: 'search-scope-clear', icon: 'clear', label: `só em ${rel(s.scope)}`, style: 'icon', tooltip: 'buscar na pasta toda' },
      ],
    });
  }
  if (s.running) {
    blocks.push({ type: 'progress', label: 'buscando…' });
    return blocks;
  }
  if (s.error) {
    blocks.push({ type: 'text', text: s.error, style: 'error' });
    return blocks;
  }
  if (!s.query) {
    blocks.push({ type: 'text', text: 'Enter busca. Maiúsculas só contam quando a busca tem alguma.', style: 'faint' });
    return blocks;
  }
  const byFile = new Map();
  for (const r of s.results) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  const more = s.truncated ? ` (mostrando ${s.results.length} de ${s.total})` : '';
  blocks.push({
    type: 'text',
    text: s.total ? `${s.total} resultado${s.total > 1 ? 's' : ''} em ${byFile.size} arquivo${byFile.size > 1 ? 's' : ''}${more}` : 'nada encontrado',
    style: 'faint',
  });
  const base = s.scope || state.root;
  const items = [];
  for (const [file, hits] of byFile) {
    const abs = path.join(base, file);
    const open = !s.collapsed.has(file);
    items.push({
      title: path.basename(file),
      subtitle: path.dirname(file) === '.' ? undefined : path.dirname(file),
      icon: 'file',
      avatar: { svg: icons.fileIcon(path.basename(file)), size: 16 },
      expanded: open,
      action: `hit:${hits[0].line}:${hits[0].column}:${abs}`,
      toggle: `sfold:${file}`,
      meta: String(hits.length),
      menu: fileMenu(abs),
    });
    if (!open) continue;
    for (const h of hits) {
      items.push({
        title: h.text.trim().slice(0, 160) || ' ',
        indent: 1,
        meta: String(h.line),
        action: `hit:${h.line}:${h.column}:${abs}`,
      });
    }
  }
  if (items.length) blocks.push({ type: 'list', flat: true, items });
  return blocks;
}

function sidebarBlocks() {
  if (!state.root) {
    return [
      { type: 'text', text: 'Nenhuma pasta aberta no editor.', style: 'dim' },
      { type: 'button', action: 'pick-root', label: 'abrir uma pasta…', style: 'primary', icon: 'folder' },
    ];
  }
  const blocks = [header(), modeTabs()];
  if (state.mode === 'search') return blocks.concat(searchBlocks());
  const { items, cut } = treeItems();
  blocks.push({ type: 'list', flat: true, items, empty: 'pasta vazia' });
  if (cut) blocks.push({ type: 'text', text: `parei em ${MAX_ROWS} linhas — feche algumas pastas`, style: 'faint' });
  return blocks;
}

/** Manda a aba, se ela mudou (ou `force`). A vigia chama isto a cada 3 s. */
async function pushSidebar(force = false) {
  const blocks = sidebarBlocks();
  const key = JSON.stringify(blocks);
  if (!force && key === state.sidebarKey) return;
  state.sidebarKey = key;
  const dirtyCount = state.tabs.filter(dirty).length;
  try {
    await mx.request('sidebar.update', { blocks, badge: dirtyCount ? String(dirtyCount) : '' });
  } catch (e) {
    mx.log('sidebar.update:', e.message);
  }
}

// --- as ações ------------------------------------------------------------------------

async function runSearch(query, regex) {
  if (!(await ensureRoot())) return;
  const s = state.search;
  s.query = query;
  s.regex = regex;
  s.results = [];
  s.total = 0;
  s.error = '';
  s.collapsed = new Set();
  state.mode = 'search';
  if (!query) return pushSidebar();
  s.running = true;
  await pushSidebar();
  try {
    const r = await files.search(s.scope || state.root, query, { hide: hidden(), regex });
    s.results = r.results;
    s.total = r.total;
    s.truncated = r.truncated;
    s.engine = r.engine;
  } catch (e) {
    s.error = e.message;
  }
  s.running = false;
  await pushSidebar();
}

async function quickOpen() {
  if (!(await ensureRoot())) return;
  const list = await files.allFiles(state.root, hidden());
  const open = new Set(state.tabs.map((t) => t.path));
  const items = list.map((f) => ({
    value: f,
    label: path.basename(f),
    detail: path.dirname(f) === '.' ? (open.has(path.join(state.root, f)) ? 'aberto' : '') : path.dirname(f),
  }));
  // Os abertos primeiro: trocar de arquivo é a maior parte do ⌘P.
  items.sort((a, b) => open.has(path.join(state.root, b.value)) - open.has(path.join(state.root, a.value)));
  const choice = await mx.request('window.pick', {
    title: `abrir em ${path.basename(state.root)}`,
    placeholder: 'nome do arquivo',
    items,
  });
  if (choice) await openFile(path.join(state.root, choice));
}

async function gotoLine() {
  const t = activeTab();
  if (!t || t.error) return;
  const typed = await mx.request('window.input', {
    title: 'ir pra linha',
    placeholder: `1 a ${(dirty(t) ? t.buffer : t.text).split('\n').length}`,
    prompt: 'linha, ou linha:coluna',
  });
  const m = /^(\d+)(?::(\d+))?$/.exec(typed || '');
  if (!m) return;
  t.line = Number(m[1]);
  t.column = Number(m[2] || 1);
  t.jump = ++state.jumpSeq;
  await paint();
}

async function pickLanguage() {
  const t = activeTab();
  if (!t) return;
  const langs = ['plaintext', 'dart', 'javascript', 'typescript', 'json', 'yaml', 'markdown', 'python', 'ruby', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'objectivec', 'php', 'bash', 'powershell', 'css', 'scss', 'less', 'xml', 'vue', 'sql', 'dockerfile', 'makefile', 'ini', 'properties', 'graphql', 'protobuf', 'gradle', 'groovy', 'lua', 'elixir', 'scala', 'haskell', 'perl', 'r', 'nginx', 'diff'];
  const choice = await mx.request('window.pick', {
    title: 'linguagem deste arquivo',
    items: langs.map((l) => ({ value: l, label: files.languageLabel(l), detail: l === t.language ? 'a de agora' : '' })),
  });
  if (!choice) return;
  t.language = choice;
  await paint();
}

/** Um nome digitado a partir de uma pasta: pode ter subpastas, não pode sair dela. */
function inside(dir, name) {
  const p = path.resolve(dir, name);
  return p.startsWith(dir + path.sep) ? p : null;
}

async function newEntry(dir, kind) {
  const typed = await mx.request('window.input', {
    title: kind === 'file' ? 'novo arquivo' : 'nova pasta',
    placeholder: kind === 'file' ? 'nome.ext, ou pasta/nome.ext' : 'nome',
    prompt: `em ${rel(dir)}`,
  });
  if (!typed) return;
  const p = inside(dir, typed);
  if (!p) return banner('o nome tem que ficar dentro da pasta');
  if (fs.existsSync(p)) {
    if (kind === 'file' && !isDir(p)) return openFile(p);
    return banner(`${rel(p)} já existe`);
  }
  if (kind === 'file') {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
    reveal(p);
    await refreshGit();
    await openFile(p);
  } else {
    fs.mkdirSync(p, { recursive: true });
    reveal(p);
    state.expanded.add(p);
    persist();
    await refreshGit();
    await pushSidebar(true);
  }
}

async function rename(p) {
  const typed = await mx.request('window.input', { title: 'renomear', value: path.basename(p), prompt: `em ${rel(path.dirname(p))}` });
  if (!typed || typed === path.basename(p)) return;
  const to = inside(path.dirname(p), typed);
  if (!to) return banner('o nome tem que ficar na mesma pasta');
  if (fs.existsSync(to)) return banner(`${rel(to)} já existe`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(p, to);
  // As abas do arquivo (ou de dentro da pasta) seguem o nome novo.
  for (const t of state.tabs) {
    if (t.path === p || t.path.startsWith(p + path.sep)) {
      t.path = to + t.path.slice(p.length);
      t.language = files.language(t.path);
      t.rev += 1;
    }
  }
  if (state.expanded.delete(p)) state.expanded.add(to);
  reveal(to);
  persist();
  await refreshGit();
  await paint();
  await pushSidebar(true);
}

async function remove(p) {
  const dir = isDir(p);
  const title = `Apagar ${dir ? 'a pasta' : ''} ${path.basename(p)}?`.replace('  ', ' ');
  let choice;
  if (state.caps.form) {
    const r = await mx.request('window.form', {
      title,
      fields: [],
      buttons: [
        { action: 'trash', label: 'Mandar pra lixeira', style: 'danger' },
        { action: 'cancel', label: 'Cancelar' },
      ],
    });
    choice = r && r.action;
  } else {
    choice = await mx.request('window.pick', { title, items: [{ value: 'trash', label: 'mandar pra lixeira' }, { value: 'cancel', label: 'cancelar' }] });
  }
  if (choice !== 'trash') return;
  if (!(await files.trash(p))) {
    const r = await mx.request('window.pick', {
      title: 'Não deu pra mandar pra lixeira. Apagar de vez?',
      items: [{ value: 'rm', label: 'apagar de vez', detail: 'não dá pra desfazer' }, { value: 'cancel', label: 'cancelar' }],
    });
    if (r !== 'rm') return;
    fs.rmSync(p, { recursive: true, force: true });
  }
  // As abas do que sumiu: as salvas fecham, as não salvas ficam avisando.
  state.tabs = state.tabs.filter((t) => {
    const gone = t.path === p || t.path.startsWith(p + path.sep);
    if (gone && dirty(t)) t.deleted = true;
    return !gone || dirty(t);
  });
  state.active = Math.min(state.active, state.tabs.length - 1);
  persist();
  await refreshGit();
  await paint();
  await pushSidebar(true);
}

async function act(action) {
  if (!action) return;
  const [verb, arg] = split(action);
  switch (verb) {
    case 'open':
      return openFile(arg);
    case 'focus': {
      const i = state.tabs.findIndex((t) => t.path === arg);
      if (i < 0 || i === state.active) return;
      state.active = i;
      persist();
      await paint();
      return pushSidebar();
    }
    case 'hit': {
      const [line, column, ...rest] = arg.split(':');
      return openFile(rest.join(':'), { line: Number(line), column: Number(column) });
    }
    case 'toggle':
      if (state.expanded.has(arg)) state.expanded.delete(arg);
      else state.expanded.add(arg);
      persist();
      return pushSidebar();
    case 'collapse':
      state.expanded.clear();
      persist();
      return pushSidebar();
    case 'refresh':
      state.branch = state.repo ? await files.branch(state.root) : '';
      await refreshGit();
      return pushSidebar(true);
    case 'mode':
      state.mode = arg === 'search' ? 'search' : 'files';
      return pushSidebar();
    case 'sfold':
      if (state.search.collapsed.has(arg)) state.search.collapsed.delete(arg);
      else state.search.collapsed.add(arg);
      return pushSidebar();
    case 'search-scope-clear':
      state.search.scope = null;
      return runSearch(state.search.query, state.search.regex);
    case 'search-in':
      state.search.scope = arg;
      state.mode = 'search';
      return startSearch();
    case 'close':
      return closeTabs([arg]);
    case 'close-others':
      return closeTabs(state.tabs.map((t) => t.path).filter((p) => p !== arg));
    case 'close-right': {
      const i = state.tabs.findIndex((t) => t.path === arg);
      return closeTabs(state.tabs.slice(i + 1).map((t) => t.path));
    }
    case 'close-saved':
      await settle();
      return closeTabs(state.tabs.filter((t) => !dirty(t)).map((t) => t.path));
    case 'close-all':
      return closeTabs(state.tabs.map((t) => t.path));
    case 'save-active': {
      await settle();
      const t = activeTab();
      if (t && dirty(t)) await save(t, t.buffer);
      return;
    }
    case 'take-disk': {
      const t = activeTab();
      if (!t || t.disk === null) return;
      t.text = t.disk;
      t.buffer = null;
      t.disk = null;
      t.conflict = false;
      t.rev += 1;
      backup();
      return paint();
    }
    case 'keep-mine': {
      // O seu fica, ainda não salvo: o ⌘S grava por cima do que está no disco.
      const t = activeTab();
      if (!t) return;
      t.conflict = false;
      if (t.disk !== null) t.text = t.disk;
      t.disk = null;
      return paint();
    }
    case 'goto':
      return gotoLine();
    case 'language':
      return pickLanguage();
    case 'quick':
      return quickOpen();
    case 'search':
      return startSearch();
    case 'pick-root':
      if (await pickRoot()) await paint();
      return;
    case 'root':
      if (!isDir(arg)) return banner(`a pasta ${tilde(arg)} não existe mais`);
      await setRoot(arg);
      await paint();
      return pushSidebar(true);
    case 'reveal':
      reveal(arg);
      state.mode = 'files';
      persist();
      return pushSidebar();
    case 'new-file':
      return newEntry(arg, 'file');
    case 'new-folder':
      return newEntry(arg, 'folder');
    case 'rename':
      return rename(arg);
    case 'delete':
      return remove(arg);
    case 'copy':
      return mx.request('clipboard.write', { text: arg });
    case 'copy-rel':
      return mx.request('clipboard.write', { text: state.root ? path.relative(state.root, arg) : arg });
    case 'vscode': {
      const t = tabOf(arg);
      return mx.request('editor.open', { path: arg, line: t && t === activeTab() ? state.cursor.line : undefined });
    }
    case 'finder':
      if (process.platform === 'darwin') await files.run('open', ['-R', arg], path.dirname(arg));
      else await files.run('xdg-open', [isDir(arg) ? arg : path.dirname(arg)], path.dirname(arg));
      return;
    case 'terminal':
      return mx.request('session.openShell', { cwd: arg, label: path.basename(arg) });
    case 'claude':
      return mx.request('session.openClaude', { cwd: arg });
    default:
      mx.log('ação desconhecida:', action);
  }
}

/** O ⇧⌘F: a aba na busca, perguntando o quê quando ainda não há nada digitado. */
async function startSearch() {
  if (!(await ensureRoot())) return;
  state.mode = 'search';
  await paint({ raise: true });
  await pushSidebar(true);
  if (state.caps.input) {
    const typed = await mx.request('window.input', {
      title: state.search.scope ? `buscar em ${rel(state.search.scope)}` : `buscar em ${path.basename(state.root)}`,
      value: state.search.query,
      placeholder: 'texto',
    });
    if (typed) await runSearch(typed, state.search.regex);
  }
}

// --- o editor: o que você digitou ----------------------------------------------------

async function changed({ doc, text }) {
  const t = tabOf(doc);
  if (!t || typeof text !== 'string') return;
  const was = dirty(t);
  t.buffer = text === t.text ? null : text;
  backup();
  if (dirty(t) && setting('autoSave', false)) {
    await save(t, t.buffer);
    return;
  }
  if (was !== dirty(t)) {
    await paint();
    await pushSidebar();
  }
}

async function saved({ doc, text }) {
  const t = tabOf(doc);
  if (!t || typeof text !== 'string') return;
  await save(t, text);
  await pushSidebar();
}

async function cursor({ doc, line, column, selected }) {
  state.lastKey = Date.now();
  const t = activeTab();
  if (!t || t.path !== doc) return;
  state.cursor = { line: Number(line) || 1, column: Number(column) || 1, selected: Number(selected) || 0 };
  await paintStatus();
}

// --- o protocolo ---------------------------------------------------------------------

mx.onNotification('view.action', async ({ viewId, action, values = {} }) => {
  if (viewId === VIEW) {
    if (action === 'change') return changed(values);
    if (action === 'save') return saved(values);
    if (action === 'cursor') return cursor(values);
    if (action === 'act') return safe('editor', () => act(values.a || values.action));
    return safe('editor', () => act(action));
  }
  if (viewId === SIDEBAR) {
    if (action === 'search-run') return safe('buscar', () => runSearch(String(values.query || '').trim(), !!values.regex));
    if (action === 'search-regex') {
      state.search.regex = !!values.regex;
      if (values.query) return safe('buscar', () => runSearch(String(values.query).trim(), state.search.regex));
      return;
    }
    return safe('editor', () => act(action));
  }
});

mx.onNotification('event', async (e) => {
  switch (e.type) {
    case 'sidebar.shown':
      state.sidebarShown = true;
      await ensureRoot({ ask: false });
      if (state.root) await refreshGit();
      return pushSidebar(true);
    case 'sidebar.hidden':
      state.sidebarShown = false;
      return;
    default:
  }
});

mx.onNotification('settings.changed', async ({ settings }) => {
  state.settings = settings || {};
  state.sent = ''; // o tamanho da letra mora em `opts`, mas a quebra de linha é do editor inteiro
  await paint();
  await pushSidebar(true);
});

mx.onNotification('shutdown', () => {
  backup(true);
  persist();
  process.exit(0);
});

mx.onRequest('initialize', (params) => {
  state.dataDir = params.dataDir || state.dataDir;
  state.settings = params.settings || {};
  state.caps = {
    editor: Number(params.editor) >= 1,
    rfw: Number(params.rfw) >= 1,
    input: Number(params.input) >= 1,
    form: Number(params.form) >= 1,
    blocks: Number(params.blocks) || 1,
  };
  restore();
  return {};
});

mx.onRequest('command.invoke', async ({ command, context = {} }) => {
  // Sem await nos que perguntam: o seletor espera você, e o command.invoke tem 30s.
  const later = (what, fn) => {
    fn().catch((e) => mx.log(`${what}:`, String((e && e.stack) || e)));
  };
  switch (command) {
    case 'abrir':
      later('abrir', async () => {
        await ensureRoot();
        await paint({ raise: true });
        await pushSidebar(true);
      });
      break;
    case 'arquivo':
      later('arquivo', quickOpen);
      break;
    case 'buscar':
      later('buscar', startSearch);
      break;
    case 'pasta-do-painel':
      later('pasta-do-painel', async () => {
        const cwd = context.cwd && isDir(context.cwd) ? context.cwd : null;
        if (!cwd) return banner('este painel não tem uma pasta');
        await setRoot((await files.gitRoot(cwd)) || cwd);
        await paint({ raise: true });
        await pushSidebar(true);
      });
      break;
    default:
      throw new Error(`comando desconhecido: ${command}`);
  }
  return null;
});

mx.start();
