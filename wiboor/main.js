// Wiboor: as tarefas num quadro Kanban, pela API pública. As colunas são os
// estados do Wiboor (não iniciada, em andamento, pausada, finalizada), cada
// tarefa um cartão com o tipo, o número, o prazo, o checklist e os comentários,
// e os botões do cartão iniciam, pausam e finalizam. O clique abre a janela da
// tarefa: a descrição, o checklist pra marcar, os comentários e um campo pra
// comentar. A aba da lateral é a sua fila: o que está rodando, o pausado e o
// que falta começar.
//
// O quadro é de quem você escolher (você, o que você pediu, outra pessoa, ou
// um espaço inteiro), e a escolha fica guardada.

'use strict';

const fs = require('fs');
const path = require('path');
const mx = require('./maestria');
const api = require('./api');
const html = require('./html');
const work = require('./work');

const BOARD = 'quadro';
const FORM = 'nova';
const DETAIL = 'tarefa.'; // + o id: uma janela por tarefa
const WEB = 'https://wiboor.com.br/tasks';

// `hint` é o que a coluna diz com um cartão em cima; `invite`, o que a vazia
// diz pra quem pode arrastar.
const COLUMNS = [
  { id: 'NOT_STARTED', label: 'Não iniciadas', tone: 'faint', icon: 'clock', empty: 'nada na fila', invite: '', hint: '' },
  { id: 'STARTED', label: 'Em andamento', tone: 'accent', icon: 'play', empty: 'nada rodando agora', invite: 'arraste um cartão pra cá pra iniciar', hint: 'solte pra iniciar' },
  { id: 'PAUSED', label: 'Pausadas', tone: 'yellow', icon: 'pause', empty: 'nada pausado', invite: 'arraste o que está em andamento pra pausar', hint: 'solte pra pausar' },
  { id: 'FINISHED', label: 'Finalizadas', tone: 'green', icon: 'check', empty: '', invite: 'arraste um cartão pra cá pra finalizar', hint: 'solte pra finalizar' }, // o vazio diz quantos dias
];
// Pra onde um cartão pode ir arrastado. Voltar pra "não iniciada" a API não
// faz, e pausar o que nem começou não quer dizer nada.
const MOVES = { NOT_STARTED: ['STARTED', 'FINISHED'], STARTED: ['PAUSED', 'FINISHED'], PAUSED: ['STARTED', 'FINISHED'] };
const VERB_TO = { STARTED: 'start', PAUSED: 'pause', FINISHED: 'end' };
const PEEK = 4; // quantos cartões a coluna leva quando é arrastada
const PEOPLE_TONES = ['blue', 'purple', 'green', 'yellow', 'cyan', 'magenta', 'accent'];
const STATUS = {
  NOT_STARTED: 'não iniciada',
  STARTED: 'em andamento',
  PAUSED: 'pausada',
  FINISHED: 'finalizada',
  PENDING: 'pendente',
  CANCELED: 'cancelada',
  REQUESTED: 'solicitada',
};
const STATUS_TONE = { STARTED: 'accent', PAUSED: 'yellow', FINISHED: 'green', CANCELED: 'red', NOT_STARTED: 'faint' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const state = {
  dataDir: process.env.MAESTRIA_PLUGIN_DATA || '',
  settings: {},
  rfw: false,
  drag: false, // a Maestria tem o Draggable e o DropTarget (rfw: 2)
  modal: false, // a Maestria abre janela em modal (`view.open` com `modal`)
  // De quem é o quadro. `who`: 'me', o id de alguém, ou '' (todos, só com um
  // espaço escolhido). `role`: 'executor' ou 'requester'. `space`: '' (todos),
  // 'd:<id>' (um espaço) ou 'g:<id>' (um sub-espaço).
  filter: { who: 'me', role: 'executor', space: '' },
  board: [], // as abertas do filtro
  finished: [], // as finalizadas do filtro, dos últimos dias
  mine: [], // as abertas que você executa: a aba da lateral
  mineAt: 0, // quando a fila da lateral foi lida
  loadedAt: null,
  loading: false,
  // De qual filtro (ver filterKey) são as tarefas na tela; diferente do atual,
  // as colunas mostram os cartões de mentira até a leitura nova chegar.
  shownKey: null,
  finishedKey: null, // o mesmo, das finalizadas: chegam depois das abertas
  // As últimas leituras de cada filtro: voltar a um já visto mostra na hora o
  // que havia, e a leitura nova só atualiza.
  cache: new Map(), // filterKey → { board, finished }
  abort: null, // o AbortController da leitura em curso
  error: null,
  notice: null, // { text, tone }: o que está rodando agora, ou o que acabou de dar errado
  dirs: null, // { people: Map, spaces: [] }, de GET /departments
  boardOpen: false,
  boardRfw: false, // a biblioteca já foi com o quadro aberto
  sidebarShown: false,
  badge: null,
  busy: new Set(), // ids de tarefa com uma ação no caminho
  // Os cartões arrastados cuja resposta ainda não veio: id → estado novo. Uma
  // leitura no meio traria o estado antigo do servidor e o cartão voltaria.
  pending: new Map(),
  details: new Map(), // viewId → { id, task, error, gen }
  form: null, // { gen, space, error, sending }
  // As sessões da Maestria (sessions.list), e qual tarefa foi aberta em qual
  // pasta: taskId → { cwd, branch, tabId }. Guardado, porque a sessão volta
  // quando o app reabre, com outro tabId e a mesma pasta.
  sessions: [],
  links: {},
  tab: 'NOT_STARTED', // a coluna à vista no quadro em blocos
  // Como cada pessoa arrumou o quadro, pelo userId da chave: quem troca de
  // chave troca de quadro. Ver layout().
  layouts: {},
  quick: '', // a pílula do topo que filtra o quadro agora (ver QUICK)
  gen: 0,
  seq: 0,
  timer: null,
};

const RFW_LIBRARY = fs.readFileSync(path.join(__dirname, 'ui', 'kanban.rfwtxt'), 'utf8');

function setting(id, fallback) {
  const v = state.settings[id];
  return v === undefined || v === null || v === '' ? fallback : v;
}

// --- o que fica guardado ---------------------------------------------------------

function stateFile() {
  return state.dataDir ? path.join(state.dataDir, 'state.json') : null;
}

function loadState() {
  const file = stateFile();
  if (!file) return;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.filter) state.filter = { ...state.filter, ...saved.filter };
    if (saved.formSpace) state.formSpace = saved.formSpace;
    if (saved.links) state.links = saved.links;
    if (saved.tab) state.tab = saved.tab;
    if (saved.layouts) state.layouts = saved.layouts;
  } catch {
    // primeira vez
  }
}

function saveState() {
  const file = stateFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ filter: state.filter, formSpace: state.formSpace || '', links: state.links, tab: state.tab, layouts: state.layouts }, null, 2));
  } catch (e) {
    mx.log('guardar o estado:', e.message);
  }
}

// --- pessoas e espaços -----------------------------------------------------------

/**
 * Os espaços e quem está em cada um. Não há endpoint de usuários: as pessoas
 * saem dos membros dos espaços. Os sub-espaços aninham (`children`), e uma
 * tarefa num deles guarda o espaço de cima em `departmentId` e o de baixo em
 * `departmentGroupId`.
 */
let dirsLoading = null;
function loadDirs(force = false) {
  if (state.dirs && !force) return Promise.resolve(state.dirs);
  if (!dirsLoading) dirsLoading = readDirs().finally(() => (dirsLoading = null));
  return dirsLoading;
}

async function readDirs() {
  const deps = (await api.departments()) || [];
  const people = new Map();
  const spaces = [];
  const addPeople = (list) => {
    for (const u of list || []) if (u && u.id && !people.has(u.id)) people.set(u.id, { id: u.id, name: u.name || u.email || u.id, email: u.email || '' });
  };
  const walk = (dep, group, trail) => {
    const name = `${dep.name} / ${trail.join(' / ')}`;
    const entry = { key: `g:${group.id}`, id: dep.id, group: group.id, name, users: group.users || [], ids: new Set([group.id]) };
    spaces.push(entry);
    addPeople(group.users);
    for (const child of group.children || []) {
      const sub = walk(dep, child, [...trail, child.name]);
      for (const x of sub.ids) entry.ids.add(x);
    }
    return entry;
  };
  for (const dep of deps) {
    spaces.push({ key: `d:${dep.id}`, id: dep.id, group: null, name: dep.name, users: dep.users || [], ids: null });
    addPeople(dep.users);
    for (const g of dep.groups || []) walk(dep, g, [g.name]);
  }
  state.dirs = { people, spaces };
  return state.dirs;
}

function space(key) {
  return (state.dirs && state.dirs.spaces.find((s) => s.key === key)) || null;
}

/** Onde uma tarefa mora, pelo nome: o sub-espaço quando tem, senão o espaço. */
function spaceName(t) {
  if (!state.dirs) return '';
  const s = (t.departmentGroupId && space(`g:${t.departmentGroupId}`)) || space(`d:${t.departmentId}`);
  return s ? s.name : '';
}

function personName(id) {
  if (!id) return '';
  if (api.auth && id === api.auth.userId) return 'você';
  const p = state.dirs && state.dirs.people.get(id);
  return p ? p.name : '';
}

function firstName(name) {
  return String(name || '').split(/\s+/)[0];
}

// --- datas e nomes ---------------------------------------------------------------

function day(d) {
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
}

/** "hoje", "amanhã", "ontem", "27 set" (e o ano, se não é este). */
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Math.round((day(d) - day(Date.now())) / 86400000);
  if (diff === 0) return 'hoje';
  if (diff === 1) return 'amanhã';
  if (diff === -1) return 'ontem';
  const s = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date().getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

function whenFull(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${when(iso)}, ${hh}:${mm}`;
}

function late(t) {
  return !!t.endedAt && t.status !== 'FINISHED' && day(t.endedAt) < day(Date.now());
}

/** Quantos dias faltam pro prazo (negativo: venceu). `null` sem prazo. */
function daysLeft(t) {
  if (!t.endedAt || Number.isNaN(new Date(t.endedAt).getTime())) return null;
  return Math.round((day(t.endedAt) - day(Date.now())) / 86400000);
}

/** Vence hoje ou amanhã. */
function soon(t) {
  const n = daysLeft(t);
  return t.status !== 'FINISHED' && n !== null && n >= 0 && n <= 1;
}

/** O prazo no cartão, e a cor dele: vermelho venceu, amarelo hoje e amanhã. */
function dueOf(t) {
  const n = daysLeft(t);
  if (n === null) return { text: '', tone: '' };
  if (n < 0) return { text: n === -1 ? 'venceu ontem' : `venceu ${when(t.endedAt)}`, tone: 'red' };
  if (n <= 1) return { text: when(t.endedAt), tone: 'yellow' };
  if (n <= 6) return { text: `em ${n} dias`, tone: '' };
  return { text: when(t.endedAt), tone: '' };
}

// Os filtros das pílulas do topo: um clique deixa no quadro só o que passa,
// outro clique tira. Não fica guardado: é uma olhada, não um jeito do quadro.
const QUICK = {
  vencidas: { test: late, label: (n) => `${n} com o prazo vencido`, tone: 'red' },
  logo: { test: soon, label: (n) => `${n} pra hoje ou amanhã`, tone: 'yellow' },
  urgentes: { test: (t) => t.priority >= 8, label: (n) => `${n} com prioridade 8+`, tone: 'magenta' },
  claude: { test: (t) => !!sessionFor(t), label: (n) => `${n} com o claude`, tone: 'purple' },
};

const tag = (t) => `${t.type === 'BUG' ? 'BUG' : 'TASK'}#${t.taskNumber}`;
const isCourse = (t) => Array.isArray(t.courses) && t.courses.length > 0;
// A convenção do time: correção em hotfix/BUG#…, trabalho novo em feature/TASK#….
const branchOf = (t) => `${t.type === 'BUG' ? 'hotfix' : 'feature'}/${tag(t)}`;
const linkOf = (t) => `${WEB}?taskId=${t.id}`;

/**
 * Os anexos da tarefa: o que está na descrição e nos comentários (a API
 * pública não tem anexo à parte). Um mesmo arquivo citado duas vezes conta uma.
 */
function attachmentsOf(t) {
  const seen = new Set();
  const out = [];
  const add = (list, from) => {
    for (const a of list) {
      const key = a.url.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...a, from });
    }
  };
  add(html.media(t.description), 'descrição');
  const comments = (t.comments || []).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const c of comments) {
    const who = personName(c.userId);
    add(html.media(c.message), `comentário${who ? ` de ${who === 'você' ? 'você' : firstName(who)}` : ''} · ${when(c.createdAt)}`);
  }
  return out;
}

const KIND_ICON = { image: 'image', video: 'play', audio: 'play', file: 'file' };
const KIND_LABEL = { image: 'imagem', video: 'vídeo', audio: 'áudio', file: 'arquivo' };

/** Um nome que ainda não existe na pasta: `print.png`, `print (2).png`… */
function freePath(dir, name) {
  const safe = name.replace(/[/\\:*?"<>|]+/g, '-').slice(0, 120) || 'arquivo';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let p = path.join(dir, safe);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

async function download(url, file, limit = 200 * 1024 * 1024) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${res.status} ao baixar ${path.basename(file)}`);
  const size = Number(res.headers.get('content-length') || 0);
  if (size > limit) throw new Error(`${path.basename(file)} tem ${Math.round(size / 1048576)} MB, mais que o limite`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

/** Abre um arquivo no app do sistema (Preview, QuickTime…), ou mostra no Finder. */
function openFile(file, reveal = false) {
  const { spawn } = require('child_process');
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'darwin' && reveal ? ['-R', file] : [reveal ? path.dirname(file) : file];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

/**
 * As imagens da tarefa numa pasta do plugin, fora do repositório, pro claude
 * poder olhar os prints: ele lê imagem pelo caminho. Os outros anexos vão como
 * link no prompt.
 */
async function imagesForClaude(t) {
  const images = attachmentsOf(t).filter((a) => a.kind === 'image').slice(0, 12);
  if (!images.length || !state.dataDir) return [];
  const dir = path.join(state.dataDir, 'anexos', tag(t).replace('#', '-'));
  const out = [];
  for (const a of images) {
    const file = path.join(dir, `${out.length + 1}-${a.name.replace(/[/\\:*?"<>|]+/g, '-')}`);
    try {
      if (!fs.existsSync(file)) await download(a.url, file, 20 * 1024 * 1024);
      out.push({ ...a, file });
    } catch (e) {
      mx.log('baixar pro claude:', e.message);
    }
  }
  return out;
}

function checks(t) {
  const list = t.checklist || [];
  if (!list.length) return '';
  return `${list.filter((c) => c.status === 'CHECKED').length}/${list.length}`;
}

const SORTS = {
  prioridade: { label: 'prioridade', fn: (a, b) => byPriority(a, b) },
  prazo: { label: 'prazo mais perto', fn: (a, b) => (a.endedAt || '9').localeCompare(b.endedAt || '9') || byPriority(a, b) },
  recentes: { label: 'mais recentes', fn: (a, b) => b.taskNumber - a.taskNumber },
  antigas: { label: 'mais antigas', fn: (a, b) => a.taskNumber - b.taskNumber },
  finalizadas: { label: 'finalizada por último', fn: (a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')) },
};

function byPriority(a, b) {
  return (b.priority || 0) - (a.priority || 0) || (a.endedAt || '9').localeCompare(b.endedAt || '9') || b.taskNumber - a.taskNumber;
}

// --- o filtro --------------------------------------------------------------------

function filterParams() {
  const f = state.filter;
  const me = api.auth && api.auth.userId;
  const s = f.space ? space(f.space) : null;
  const who = f.who === 'me' ? me : f.who || (s ? '' : me);
  const params = { department: s ? s.id : undefined };
  if (who) params[f.role === 'requester' ? 'requester' : 'executor'] = who;
  return { params, group: s && s.ids ? s.ids : null };
}

function filterTitle() {
  const f = state.filter;
  const s = f.space ? space(f.space) : null;
  let who;
  if (f.who === 'me' || (!f.who && !s)) who = f.role === 'requester' ? 'O que você pediu' : 'Suas tarefas';
  else if (!f.who) who = 'Todas as tarefas';
  else {
    const name = personName(f.who) || 'alguém';
    who = f.role === 'requester' ? `O que ${firstName(name)} pediu` : `Tarefas de ${firstName(name)}`;
  }
  return s ? `${who} · ${s.name}` : who;
}

/** O filtro e os dias de finalizadas: o que muda o que o quadro lê. */
function filterKey() {
  const f = state.filter;
  return [f.who, f.role, f.space, Math.max(0, Number(setting('finishedDays', 7)) || 0)].join('|');
}

/** As colunas ainda não têm nada do filtro atual: é a vez dos cartões de mentira. */
function waiting() {
  return !state.error && state.shownKey !== filterKey();
}

/** As finalizadas do filtro atual ainda não chegaram (as abertas podem já estar na tela). */
function finishedWaiting() {
  return !state.error && state.finishedKey !== filterKey();
}

const CACHE_MAX = 8;

function remember(key) {
  state.cache.delete(key);
  state.cache.set(key, { board: state.board, finished: state.finished });
  while (state.cache.size > CACHE_MAX) state.cache.delete(state.cache.keys().next().value);
}

function isMineFilter() {
  const f = state.filter;
  return f.who === 'me' && f.role === 'executor' && !f.space;
}

// --- ler -------------------------------------------------------------------------

// A fila da lateral não muda com o filtro: trocar de filtro só a relê se ela
// tiver mais que isso.
const MINE_FRESH = 30000;

/**
 * Relê o quadro e a sua fila. Uma leitura nova cancela a que estava no meio
 * (o filtro mudou: a velha não interessa mais), em vez de esperar por ela.
 * `quiet` é a do relógio: com outra em curso, ela não entra.
 */
async function reload({ quiet = false, mine: wantMine = true } = {}) {
  if (!api.auth) api.load();
  if (!api.auth) {
    state.error = null;
    await pushAll();
    return;
  }
  if (quiet && state.loading) return;
  if (state.abort) state.abort.abort();
  const abort = new AbortController();
  state.abort = abort;
  const signal = abort.signal;
  const seq = ++state.seq;
  const key = filterKey();
  state.loading = true;
  await pushAll();
  try {
    // Os espaços só seguram a leitura quando o filtro é de um deles e ainda não
    // chegaram; senão vêm junto.
    const dirs = loadDirs();
    if (state.filter.space && !state.dirs) await dirs;
    const me = api.auth.userId;
    const days = Math.max(0, Number(setting('finishedDays', 7)) || 0);
    const { params, group } = filterParams();
    const inGroup = (t) => !group || group.has(t.departmentGroupId);
    const since = day(Date.now()) - days * 86400000;
    const readMine = !isMineFilter() && (wantMine || Date.now() - state.mineAt > MINE_FRESH || !state.mineAt);
    // As abertas vão pra tela assim que chegam; as finalizadas (as mais lentas,
    // num espaço inteiro) seguem com o skeleton na coluna delas até chegarem.
    const open = state.boardOpen || isMineFilter() ? api.tasks({ ...params, signal }) : Promise.resolve(null);
    const early = open.then((list) => {
      if (!list || seq !== state.seq) return;
      state.board = list.filter(inGroup);
      state.shownKey = key;
      return pushBoard();
    });
    const [board, done, mine] = await Promise.all([
      open,
      state.boardOpen && days ? api.tasks({ ...params, statuses: ['FINISHED'], since, signal }) : Promise.resolve([]),
      readMine ? api.tasks({ executor: me, signal }) : Promise.resolve(null),
      dirs,
      loadSessions(),
      early,
    ]);
    if (seq !== state.seq) return;
    if (board) state.board = board.filter(inGroup);
    state.finished = (done || []).filter(inGroup).sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
    if (mine) {
      state.mine = mine;
      state.mineAt = Date.now();
    } else if (isMineFilter() && board) {
      state.mine = state.board;
      state.mineAt = Date.now();
    }
    for (const [id, to] of state.pending) {
      const t = findTask(id);
      if (t && t.status !== to) moveLocally(t, to);
    }
    if (board) {
      state.shownKey = key;
      state.finishedKey = key;
      remember(key);
    }
    state.loadedAt = new Date();
    state.error = null;
    state.keyRefused = false;
  } catch (e) {
    if (seq !== state.seq) return;
    state.error = e.message;
    if (e.status === 401) {
      // Uma chave recusada: a tela volta a pedir uma.
      state.error = `${e.message}. Cole uma chave nova.`;
      state.keyRefused = true;
    }
    mx.log('ler:', String(e.stack || e));
  } finally {
    if (seq === state.seq) {
      state.loading = false;
      state.abort = null;
    }
  }
  if (seq === state.seq) await pushAll();
}

function pushAll() {
  return Promise.all([pushBoard(), pushSidebar()]);
}

// --- ações -----------------------------------------------------------------------

function findTask(id) {
  for (const list of [state.board, state.finished, state.mine]) {
    const t = list.find((x) => x.id === id);
    if (t) return t;
  }
  for (const d of state.details.values()) if (d.task && d.task.id === id) return d.task;
  return null;
}

async function withNotice(text, fn) {
  const mine = { text, tone: 'dim' };
  state.notice = mine;
  await pushBoard();
  try {
    await fn();
    // Só o próprio recado: um erro de outra ação no meio tempo fica.
    if (state.notice === mine) state.notice = null;
    return true;
  } catch (e) {
    const shown = { text: e.message, tone: 'red' };
    state.notice = shown;
    await mx.request('window.showBanner', { text: `wiboor: ${e.message}` }).catch(() => {});
    // O erro fica em cima das colunas um tempo, e some sozinho.
    setTimeout(() => {
      if (state.notice !== shown) return;
      state.notice = null;
      pushBoard();
    }, 10000).unref();
    return false;
  }
}

/**
 * Iniciar, pausar ou finalizar; depois relê o quadro e a janela da tarefa. O
 * cartão já muda de coluna antes da resposta, e volta se a API recusar.
 *
 * Finalizar só pergunta quando o checklist tem item aberto: com tudo marcado
 * (ou sem checklist), é o que se queria.
 */
async function changeState(id, verb) {
  const t = findTask(id);
  const name = t ? tag(t) : 'a tarefa';
  if (t && isCourse(t)) {
    await mx.request('window.showBanner', { text: `${name} é uma tarefa de curso: quem muda o estado dela é a CEFIS.` });
    return;
  }
  if (verb === 'end') {
    const open = ((t && t.checklist) || []).filter((c) => c.status !== 'CHECKED').length;
    if (open) {
      const ok = await mx.request('window.pick', {
        title: `finalizar ${name} com ${open} ${open === 1 ? 'item aberto' : 'itens abertos'} no checklist?`,
        placeholder: t.title,
        items: [
          { value: 'sim', label: 'finalizar mesmo assim', detail: 'marca a tarefa como finalizada no Wiboor' },
          { value: 'nao', label: 'deixar como está' },
        ],
      });
      if (ok !== 'sim') return;
    }
  }
  if (state.busy.has(id)) return;
  state.busy.add(id);
  const to = { start: 'STARTED', pause: 'PAUSED', end: 'FINISHED' }[verb];
  const undo = t ? moveLocally(t, to) : null;
  if (undo) state.pending.set(id, to);
  await pushAll();
  const label = { start: 'iniciando', pause: 'pausando', end: 'finalizando' }[verb];
  const ok = await withNotice(`${label} ${name}…`, async () => {
    try {
      await api[verb](id);
    } finally {
      state.busy.delete(id);
      state.pending.delete(id);
    }
  });
  if (!ok && undo) undo();
  if (ok && verb === 'end') await mx.request('window.showBanner', { text: `${name} finalizada` }).catch(() => {});
  await Promise.all([reload(), refreshDetail(DETAIL + id)]);
}

/** Põe o cartão na coluna nova na hora; devolve como desfazer. */
function moveLocally(t, to) {
  const before = { status: t.status, finishedAt: t.finishedAt };
  const wasBoard = state.board.includes(t);
  t.status = to;
  if (to === 'FINISHED') {
    t.finishedAt = new Date().toISOString();
    state.board = state.board.filter((x) => x !== t);
    state.finished = [t, ...state.finished];
  }
  return () => {
    Object.assign(t, before);
    if (to === 'FINISHED') {
      state.finished = state.finished.filter((x) => x !== t);
      if (wasBoard) state.board = [...state.board, t];
    }
  };
}

/** Um cartão solto numa coluna, ou uma coluna solta no lugar de outra. */
async function dropped(id, to) {
  if (String(id).startsWith('col:')) {
    if (!String(to).startsWith('col:')) return;
    return changeLayout((l) => moveColumn(l, id.slice(4), to.slice(4)));
  }
  const t = findTask(id);
  const verb = VERB_TO[to];
  if (!t || !verb || !(MOVES[t.status] || []).includes(to)) return;
  return changeState(id, verb);
}

async function copyBranch(id) {
  const t = findTask(id);
  if (!t) return;
  await mx.request('clipboard.write', { text: branchOf(t) });
  await mx.request('window.showBanner', { text: `copiado: ${branchOf(t)}` });
}

async function copyLink(id) {
  const t = findTask(id);
  if (!t) return;
  await mx.request('clipboard.write', { text: linkOf(t) });
  await mx.request('window.showBanner', { text: `link de ${tag(t)} copiado` });
}

async function openWeb(id) {
  const t = findTask(id);
  await mx.request('window.openUrl', { url: t ? linkOf(t) : WEB });
}

// --- as sessões do claude --------------------------------------------------------------
//
// Uma tarefa e uma sessão da Maestria ficam ligadas: "trabalhar nesta tarefa"
// abre (ou reabre) a worktree dela e um claude lá dentro, e daí em diante o
// cartão mostra o que a sessão está fazendo, e o clique no botão dela vai pra
// ela. A ligação é pela pasta, que sobrevive ao app reabrir, e pela branch ou
// pelo título com o número -- uma worktree aberta à mão pela lateral conta.

const STATUS_CHIP = {
  working: 'accent',
  tool: 'accent',
  waitingInput: 'yellow',
  waitingAnswer: 'yellow',
  waitingPermission: 'red',
  idle: 'green',
  ready: 'green',
  starting: 'purple',
};

const dirOf = (t) => tag(t).replace('#', '-');

async function loadSessions() {
  try {
    state.sessions = (await mx.request('sessions.list')) || [];
  } catch (e) {
    mx.log('sessions.list:', e.message);
  }
}

function sessionFor(t) {
  const live = state.sessions.filter((s) => s.kind === 'claude' && !s.exited);
  const link = state.links[t.id];
  if (link) {
    const s = live.find((x) => x.id === link.tabId) || live.find((x) => x.cwd === link.cwd);
    if (s) return s;
  }
  const re = new RegExp(`#${t.taskNumber}(?!\\d)`);
  return live.find((s) => re.test(s.branch || '') || re.test(s.title || '')) || null;
}

/** O que o cartão diz da sessão: "claude · pensando", na cor que a lateral usa. */
function sessionChip(s) {
  if (!s) return { text: '', tone: '' };
  if (s.hibernated) return { text: 'claude · hibernando', tone: 'faint' };
  return { text: `claude · ${s.statusLabel || 'aberto'}`, tone: STATUS_CHIP[s.status] || 'faint' };
}

function promptFor(t, images = []) {
  const desc = html.toMarkdown(t.description);
  const local = new Set(images.map((a) => a.url));
  const others = attachmentsOf(t).filter((a) => !local.has(a.url));
  const files = [
    ...images.map((a) => `- ${a.file} (${KIND_LABEL[a.kind]}, da ${a.from})`),
    ...others.map((a) => `- ${a.url} (${KIND_LABEL[a.kind]} ${a.name}, da ${a.from})`),
  ].join('\n');
  const list = (t.checklist || []).map((c) => `- [${c.status === 'CHECKED' ? 'x' : ' '}] ${c.description}`).join('\n');
  return [
    `Vamos trabalhar na ${tag(t)} do Wiboor (${linkOf(t)}): ${t.title}`,
    desc && `\n${desc}`,
    list && `\nChecklist:\n${list}`,
    files && `\nAnexos da tarefa${images.length ? ' (as imagens já estão baixadas: leia os arquivos pra ver os prints)' : ''}:\n${files}`,
    `\nVocê está na branch \`${branchOf(t)}\`. Leia o código antes de propor o plano.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Os repositórios da lateral, o do painel em foco primeiro, cada um dizendo o que vai acontecer nele. */
async function pickRepo(t) {
  const folders = ((await mx.request('folders.list').catch(() => [])) || []).filter((f) => f.isRepo);
  const focused = await mx.request('sessions.focused').catch(() => null);
  const here = focused && focused.folder;
  folders.sort((a, b) => (b.root === here) - (a.root === here) || a.name.localeCompare(b.name, 'pt-BR'));
  const branch = branchOf(t);
  const items = folders.map((f) => {
    const wt = (f.worktrees || []).find((w) => w.branch === branch && !w.prunable);
    return {
      value: f.root,
      label: f.name,
      detail: wt ? `já tem a worktree de ${branch} — abre nela` : `worktree nova: .claude/worktrees/${dirOf(t)}, branch ${branch}`,
    };
  });
  if (focused && focused.cwd) items.push({ value: `aqui:${focused.cwd}`, label: 'sem worktree', detail: `na pasta do painel em foco, como está: ${focused.cwd}` });
  if (!items.length) {
    await mx.request('window.showBanner', { text: 'nenhum repositório na lateral: adicione a pasta do projeto na Maestria primeiro' });
    return null;
  }
  return mx.request('window.pick', { title: `trabalhar na ${tag(t)} em qual repositório?`, placeholder: t.title, items });
}

/**
 * "Trabalhar nesta tarefa": com uma sessão já ligada, vai pra ela. Sem, pergunta
 * o repositório, faz (ou reaproveita) a worktree, abre o claude lá com a
 * tarefa no prompt e inicia a tarefa no Wiboor.
 */
async function workOn(id) {
  let t = findTask(id);
  if (!t || t.description === undefined) t = await api.task(id);
  await loadSessions();
  const open = sessionFor(t);
  if (open) {
    await mx.request('session.focus', { tabId: open.id });
    return;
  }
  const where = await pickRepo(t);
  if (!where) return;
  let cwd;
  if (where.startsWith('aqui:')) cwd = where.slice(5);
  else {
    state.notice = { text: `preparando a worktree de ${branchOf(t)}…`, tone: 'dim' };
    await pushBoard();
    try {
      const wt = await work.ensureWorktree(where, dirOf(t), branchOf(t));
      cwd = wt.path;
      state.notice = null;
      await work.describe(cwd, branchOf(t), t.title).catch((e) => mx.log('descrição da branch:', e.message));
    } catch (e) {
      state.notice = { text: `worktree: ${e.message}`, tone: 'red' };
      await pushBoard();
      await mx.request('window.showBanner', { text: `wiboor: ${e.message}`, sticky: true }).catch(() => {});
      return;
    }
  }
  const images = await imagesForClaude(t);
  const { tabId } = await mx.request('session.openClaude', { cwd, prompt: promptFor(t, images), label: tag(t) });
  state.links[t.id] = { cwd, branch: branchOf(t), tabId };
  saveState();
  if (setting('autoStart', true) && !isCourse(t) && t.status !== 'STARTED' && t.status !== 'FINISHED') {
    await api.start(t.id).catch((e) => mx.log('iniciar ao trabalhar:', e.message));
  }
  await loadSessions();
  await Promise.all([reload(), refreshDetail(DETAIL + t.id)]);
}

/**
 * O "criar e começar" de uma tarefa que nasceu de uma sugestão: a tarefa
 * existe, e a vez volta pra Maestria (`suggestion.created`), que faz o que foi
 * escolhido no cartão -- a worktree com a branch daqui, uma sessão na mesma
 * pasta ou o pedido na própria sessão --, já com a tarefa no pedido.
 *
 * A ligação tarefa-sessão do quadro vem da resposta: com ela, o cartão da
 * tarefa mostra a sessão e o botão vai pra lá.
 */
async function handOver(t, { suggestion }) {
  const opened = await mx.request('suggestion.created', {
    suggestionId: suggestion.id,
    ref: tag(t),
    intro: `Vamos trabalhar na ${tag(t)} do Wiboor (${linkOf(t)}): ${t.title}`,
    branch: branchOf(t),
    dir: dirOf(t),
  });
  if (opened && opened.tabId) {
    state.links[t.id] = { cwd: opened.cwd, branch: branchOf(t), tabId: opened.tabId };
    saveState();
  }
  // A worktree (ou a pasta) é da Maestria; a descrição da branch é daqui.
  if (opened && opened.cwd) await work.describe(opened.cwd, branchOf(t), t.title).catch((e) => mx.log('descrição da branch:', e.message));
  if (setting('autoStart', true)) await api.start(t.id).catch((e) => mx.log('iniciar ao trabalhar:', e.message));
  await loadSessions();
}

/** Um rascunho do comentário com o que a sessão fez, no campo da janela da tarefa, pra você revisar. */
async function draftComment(viewId) {
  const d = state.details.get(viewId);
  if (!d || !d.task || d.drafting) return;
  await loadSessions();
  const s = sessionFor(d.task);
  const cwd = (s && s.cwd) || (state.links[d.task.id] && state.links[d.task.id].cwd);
  if (!cwd) {
    d.error = 'nenhuma sessão ou pasta ligada a esta tarefa: use "trabalhar nesta tarefa" primeiro';
    return pushDetail(viewId);
  }
  d.drafting = true;
  d.error = null;
  await pushDetail(viewId);
  try {
    d.draft = await work.draftComment(cwd, { tag: tag(d.task), title: d.task.title, description: html.toMarkdown(d.task.description) });
  } catch (e) {
    d.error = `rascunho: ${e.message}`;
  }
  d.drafting = false;
  await pushDetail(viewId);
}

async function pickTask(title, list) {
  if (!list.length) {
    await mx.request('window.showBanner', { text: 'nenhuma tarefa pra escolher' });
    return null;
  }
  return mx.request('window.pick', {
    title,
    placeholder: 'o título ou o número',
    items: list.map((t) => ({
      value: t.id,
      label: `#${t.taskNumber}  ${t.title}`,
      detail: [STATUS[t.status] || t.status, spaceName(t), t.endedAt ? `prazo ${when(t.endedAt)}` : ''].filter(Boolean).join(' · '),
    })),
  });
}

async function pickPerson() {
  const dirs = await loadDirs();
  const s = state.filter.space ? space(state.filter.space) : null;
  const pool = s ? s.users.map((u) => dirs.people.get(u.id)).filter(Boolean) : [...dirs.people.values()];
  const items = pool
    .filter((p) => !api.auth || p.id !== api.auth.userId)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    .map((p) => ({ value: p.id, label: p.name, detail: p.email }));
  return mx.request('window.pick', { title: s ? `de quem, em ${s.name}?` : 'de quem?', placeholder: 'o nome ou o e-mail', items });
}

async function pickSpace() {
  const dirs = await loadDirs();
  return mx.request('window.pick', {
    title: 'qual espaço?',
    placeholder: 'o nome do espaço',
    items: [{ value: '', label: 'todos os espaços' }, ...dirs.spaces.map((s) => ({ value: s.key, label: s.name, detail: s.group ? 'sub-espaço' : `${s.users.length} pessoas` }))],
  });
}

async function setFilter(action) {
  const f = { ...state.filter };
  if (action === 'quem:me') Object.assign(f, { who: 'me', role: 'executor' });
  else if (action === 'quem:pedi') Object.assign(f, { who: 'me', role: 'requester' });
  else if (action === 'quem:todos') Object.assign(f, { who: '' });
  else if (action === 'papel:executor' || action === 'papel:requester') f.role = action.slice(6);
  else if (action === 'quem:outra') {
    const who = await pickPerson();
    if (!who) return;
    f.who = who;
  } else if (action === 'espaco:escolher') {
    const key = await pickSpace();
    if (key === null || key === undefined) return;
    f.space = key;
    if (!key && !f.who) f.who = 'me';
  } else if (action === 'espaco:todos') {
    f.space = '';
    if (!f.who) f.who = 'me';
  }
  state.filter = f;
  state.quick = '';
  saveState();
  showCached();
  await reload({ mine: false });
}

/** Põe na tela o que já se leu do filtro atual, se houver; senão, nada (e o skeleton). */
function showCached() {
  const key = filterKey();
  const hit = state.cache.get(key);
  state.board = hit ? hit.board : [];
  state.finished = hit ? hit.finished : [];
  state.shownKey = hit ? key : null;
  state.finishedKey = state.shownKey;
  state.error = null;
}

async function saveKey(values) {
  const key = String(values.chave || '').trim();
  if (!key) return;
  state.keyError = null;
  try {
    await api.saveKey(key);
    state.keyRefused = false;
    state.dirs = null;
    state.gen++;
  } catch (e) {
    state.keyError = e.message;
  }
  await reload();
}

// --- o quadro ----------------------------------------------------------------------

/**
 * Os botões do rodapé do cartão: o próximo passo da tarefa, na cor de
 * destaque, e o claude quando ainda não há sessão (com uma, quem leva pra ela
 * é a faixa da sessão no cartão). O resto mora no botão direito.
 */
function cardActions(t) {
  if (state.busy.has(t.id) || t.status === 'FINISHED' || isCourse(t)) return [];
  const out = [];
  if (!sessionFor(t)) out.push({ icon: 'terminal', tooltip: 'trabalhar nesta tarefa com o claude', action: `trabalhar:${t.id}`, primary: false });
  if (t.status === 'STARTED') out.push({ icon: 'pause', tooltip: 'pausar', action: `pause:${t.id}`, primary: false }, { icon: 'check', tooltip: 'finalizar', action: `end:${t.id}`, primary: true });
  else out.push({ icon: 'play', tooltip: t.status === 'PAUSED' ? 'retomar' : 'iniciar', action: `start:${t.id}`, primary: true });
  return out;
}

function cardMenu(t) {
  const course = isCourse(t);
  const s = sessionFor(t);
  return [
    { action: `abrir:${t.id}`, label: 'abrir a tarefa', icon: 'open' },
    { action: `trabalhar:${t.id}`, label: s ? `ir pra sessão do claude (${s.statusLabel || 'aberta'})` : 'trabalhar nesta tarefa com o claude', icon: 'terminal' },
    { type: 'divider' },
    { action: `start:${t.id}`, label: t.status === 'PAUSED' ? 'retomar' : 'iniciar', icon: 'play', disabled: course || t.status === 'STARTED' },
    { action: `pause:${t.id}`, label: 'pausar', icon: 'pause', disabled: course || t.status !== 'STARTED' },
    { action: `end:${t.id}`, label: 'finalizar', icon: 'check', disabled: course || t.status === 'FINISHED' },
    { type: 'divider' },
    { action: `branch:${t.id}`, label: `copiar a branch (${branchOf(t)})`, icon: 'branch' },
    { action: `link:${t.id}`, label: 'copiar o link', icon: 'link' },
    { action: `web:${t.id}`, label: 'abrir no Wiboor', icon: 'globe' },
  ];
}

function cardSub(t) {
  const f = state.filter;
  const other =
    f.role === 'executor' && f.who
      ? t.userRequester && t.userRequester.name && t.userRequesterId !== (api.auth && api.auth.userId)
        ? `pedida por ${firstName(t.userRequester.name)}`
        : ''
      : t.userExecutor && t.userExecutor.name
        ? firstName(t.userExecutor.name)
        : '';
  return [spaceName(t), other].filter(Boolean).join(' · ');
}

function dropTargets(t) {
  if (isCourse(t) || state.busy.has(t.id)) return [];
  return MOVES[t.status] || [];
}

function initials(name) {
  const parts = String(name || '').replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Uma cor fixa por pessoa, das do terminal: a mesma pessoa, a mesma bolinha. */
function toneOf(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PEOPLE_TONES[h % PEOPLE_TONES.length];
}

/** Quem aparece na bolinha: quem pediu, no seu quadro; quem faz, nos outros. */
function whoOf(t) {
  const f = state.filter;
  const me = api.auth && api.auth.userId;
  const requester = f.role === 'executor' && f.who;
  const id = requester ? t.userRequesterId : t.userExecutorId;
  const name = (requester ? t.userRequester && t.userRequester.name : t.userExecutor && t.userExecutor.name) || personName(id);
  if (!name || id === me) return { initials: '', name: '', tone: '' };
  return { initials: initials(name), name: `${requester ? 'pedida por' : 'com'} ${name}`, tone: toneOf(id) };
}

/** A barra do cartão: o checklist, ou o curso assistido. Um 0 ou 1 inteiro o json não leva como double. */
function barOf(t) {
  const frac = (x) => Math.min(0.999, Math.max(0.02, x));
  if (isCourse(t)) {
    const p = Number(t.progress) || 0;
    return { show: true, value: frac(p / 100), label: `${p}%`, done: p >= 100 };
  }
  const list = t.checklist || [];
  if (!list.length) return { show: false, value: 0.5, label: '', done: false };
  const n = list.filter((c) => c.status === 'CHECKED').length;
  return { show: true, value: frac(n / list.length), label: `${n}/${list.length}`, done: n === list.length };
}

function card(t) {
  const done = t.status === 'FINISHED';
  let due = done ? { text: t.finishedAt ? `feita ${when(t.finishedAt)}` : '', tone: 'green' } : dueOf(t);
  if (state.busy.has(t.id)) due = { text: 'um instante…', tone: '' };
  return {
    id: t.id,
    action: `abrir:${t.id}`,
    kind: t.type === 'BUG' ? 'BUG' : 'TASK',
    num: `#${t.taskNumber}`,
    title: String(t.title || '(sem título)'),
    sub: cardSub(t),
    due: due.text,
    dueTone: due.tone,
    late: !done && late(t),
    checks: checks(t),
    comments: t.comments && t.comments.length ? String(t.comments.length) : '',
    files: (() => {
      const n = attachmentsOf(t).length;
      return n ? String(n) : '';
    })(),
    progress: isCourse(t) ? `${t.progress || 0}%` : '',
    prio: t.priority ? `P${t.priority}` : '',
    prioTone: t.priority >= 8 ? 'red' : t.priority >= 6 ? 'yellow' : 'faint',
    running: t.status === 'STARTED',
    claude: { ...sessionChip(sessionFor(t)), action: `trabalhar:${t.id}` },
    targets: dropTargets(t),
    fixed: !dropTargets(t).length,
    who: whoOf(t),
    bar: barOf(t),
    acts: cardActions(t),
    menu: cardMenu(t),
  };
}

// --- o quadro de cada um ------------------------------------------------------------
//
// A ordem das colunas, as escondidas e as recolhidas, a ordenação de cada uma,
// a largura e o que aparece no cartão. Fica no dataDir do plugin, pelo userId
// da chave do Wiboor.

const CARD_FIELDS = [
  ['sub', 'o espaço e quem pediu'],
  ['who', 'as iniciais de quem pediu (ou de quem faz)'],
  ['bar', 'a barra do checklist e do curso'],
  ['due', 'o prazo'],
  ['meta', 'checklist, comentários e anexos'],
  ['claude', 'a sessão do claude'],
];
const WIDTHS = [
  ['narrow', 'estreitas'],
  ['normal', 'normais'],
  ['wide', 'largas'],
];

function defaultLayout() {
  return {
    order: COLUMNS.map((c) => c.id),
    hidden: [],
    collapsed: [],
    sort: {},
    width: 'normal',
    show: Object.fromEntries(CARD_FIELDS.map(([k]) => [k, true])),
  };
}

/** O layout de quem está usando, completo: o que foi guardado por cima do padrão. */
function layout() {
  const saved = state.layouts[(api.auth && api.auth.userId) || '_'] || {};
  const l = defaultLayout();
  const ids = COLUMNS.map((c) => c.id);
  if (Array.isArray(saved.order)) l.order = [...saved.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !saved.order.includes(id))];
  if (Array.isArray(saved.hidden)) l.hidden = saved.hidden.filter((id) => ids.includes(id));
  if (Array.isArray(saved.collapsed)) l.collapsed = saved.collapsed.filter((id) => ids.includes(id));
  if (saved.sort && typeof saved.sort === 'object') l.sort = { ...saved.sort };
  if (WIDTHS.some(([k]) => k === saved.width)) l.width = saved.width;
  if (saved.show && typeof saved.show === 'object') Object.assign(l.show, saved.show);
  return l;
}

async function changeLayout(fn) {
  const l = layout();
  fn(l);
  state.layouts[(api.auth && api.auth.userId) || '_'] = l;
  saveState();
  await Promise.all([pushBoard(), pushConfig()]);
}

const sortOf = (l, id) => (SORTS[l.sort[id]] ? l.sort[id] : id === 'FINISHED' ? 'finalizadas' : 'prioridade');
const toggle = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/** Leva a coluna `id` pro lugar de `target` (antes dela indo pra esquerda, depois indo pra direita). */
function moveColumn(l, id, target) {
  const from = l.order.indexOf(id);
  const to = l.order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return;
  l.order.splice(from, 1);
  l.order.splice(to, 0, id);
}

/** Um passo pra esquerda ou pra direita, pulando as escondidas. */
function stepColumn(l, id, dir) {
  const visible = l.order.filter((x) => !l.hidden.includes(x));
  const i = visible.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= visible.length) return;
  moveColumn(l, id, visible[j]);
}

function columns({ all = false } = {}) {
  const days = Math.max(0, Number(setting('finishedDays', 7)) || 0);
  const l = layout();
  const byId = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));
  return l.order
    .map((id) => byId[id])
    .filter((c) => c.id !== 'FINISHED' || days > 0)
    .filter((c) => all || !l.hidden.includes(c.id))
    .map((c) => {
      const sort = sortOf(l, c.id);
      const quick = QUICK[state.quick];
      const source = (c.id === 'FINISHED' ? state.finished : state.board.filter((t) => t.status === c.id)).filter((t) => !quick || quick.test(t));
      const list = source.slice().sort(SORTS[sort].fn);
      let empty = c.id === 'FINISHED' ? `nada finalizado ${days === 1 ? 'hoje' : `nos últimos ${days} dias`}` : c.empty;
      if (quick) empty = 'nada aqui com esse filtro';
      if (waiting() || !state.loadedAt) empty = state.error ? 'não deu pra ler o Wiboor' : 'lendo…';
      return { ...c, empty, list, sort, hidden: l.hidden.includes(c.id), collapsed: l.collapsed.includes(c.id) };
    });
}

function laneMenu(c, visible) {
  const i = visible.findIndex((x) => x.id === c.id);
  return [
    { action: `coluna:${c.id}:esquerda`, label: 'mover pra esquerda', icon: 'undo', disabled: i <= 0 },
    { action: `coluna:${c.id}:direita`, label: 'mover pra direita', icon: 'continue', disabled: i < 0 || i >= visible.length - 1 },
    { action: `coluna:${c.id}:recolher`, label: c.collapsed ? 'abrir a coluna' : 'recolher a coluna', icon: 'remove' },
    { type: 'divider' },
    ...Object.entries(SORTS)
      .filter(([k]) => k !== 'finalizadas' || c.id === 'FINISHED')
      .map(([k, v]) => ({ action: `coluna:${c.id}:ordem:${k}`, label: `${c.sort === k ? '✓  ' : '    '}ordenar por ${v.label}`, icon: 'filter' })),
    { type: 'divider' },
    { action: `coluna:${c.id}:esconder`, label: 'esconder a coluna', icon: 'clear', disabled: visible.length <= 1 },
    { action: 'personalizar', label: 'personalizar o quadro…', icon: 'settings' },
  ];
}

async function columnAction(id, what, arg) {
  return changeLayout((l) => {
    if (what === 'esquerda') stepColumn(l, id, -1);
    else if (what === 'direita') stepColumn(l, id, 1);
    else if (what === 'recolher') l.collapsed = toggle(l.collapsed, id);
    else if (what === 'esconder') l.hidden = toggle(l.hidden, id);
    else if (what === 'ordem' && SORTS[arg]) l.sort[id] = arg;
    else if (what === 'subir') stepColumn(l, id, -1);
  });
}

// --- personalizar o quadro (a janela) ---------------------------------------------------

const CONFIG = 'quadro.personalizar';
let configOpen = false;

async function openConfig() {
  configOpen = true;
  await mx.request('view.open', { viewId: CONFIG, title: 'personalizar o quadro', blocks: configBlocks() });
}

async function pushConfig() {
  if (!configOpen) return;
  try {
    const r = await mx.request('view.update', { viewId: CONFIG, blocks: configBlocks() });
    if (r && r.open === false) configOpen = false;
  } catch (e) {
    mx.log('personalizar:', e.message);
  }
}

function configBlocks() {
  const l = layout();
  const cols = columns({ all: true });
  const who = (api.auth && api.auth.email) || 'você';
  const blocks = [
    { type: 'header', avatar: { icon: 'settings', color: 'accent' }, title: 'Personalizar o quadro', subtitle: `o jeito de ${who}: fica guardado só pra você` },
    { type: 'section', text: 'Colunas', count: cols.filter((c) => !c.hidden).length },
    { type: 'text', style: 'faint', text: 'A ordem aqui é a do quadro. Lá, dá pra arrastar o cabeçalho de uma coluna pra outro lugar.' },
  ];
  cols.forEach((c, i) => {
    blocks.push({
      type: 'card',
      children: [
        {
          type: 'header',
          avatar: { icon: c.icon, color: c.tone === 'faint' ? 'faint' : c.tone },
          title: c.label,
          subtitle: c.hidden ? 'escondida' : c.collapsed ? `recolhida · ${c.list.length}` : `${c.list.length} · ordenada por ${SORTS[c.sort].label}`,
          dim: c.hidden,
          actions: [
            { action: `cfg:subir:${c.id}`, icon: 'step-out', tooltip: 'mais pra esquerda', disabled: i === 0 },
            { action: `cfg:descer:${c.id}`, icon: 'step-into', tooltip: 'mais pra direita', disabled: i === cols.length - 1 },
          ],
        },
        {
          type: 'columns',
          children: [
            { type: 'checkbox', id: `cfg.visivel.${c.id}`, label: 'mostrar', value: !c.hidden, action: `cfg:visivel:${c.id}` },
            { type: 'checkbox', id: `cfg.recolhida.${c.id}`, label: 'recolhida', value: c.collapsed, action: `cfg:recolhida:${c.id}`, disabled: c.hidden },
            {
              type: 'select',
              id: `cfg.ordem.${c.id}`,
              value: c.sort,
              action: `cfg:ordem:${c.id}`,
              options: Object.entries(SORTS)
                .filter(([k]) => k !== 'finalizadas' || c.id === 'FINISHED')
                .map(([k, v]) => ({ value: k, label: v.label })),
            },
          ],
        },
      ],
    });
  });
  blocks.push({ type: 'section', text: 'Largura das colunas' });
  blocks.push({ type: 'select', id: 'cfg.largura', value: l.width, action: 'cfg:largura', options: WIDTHS.map(([value, label]) => ({ value, label })) });
  blocks.push({ type: 'section', text: 'No cartão' });
  for (const [k, label] of CARD_FIELDS) blocks.push({ type: 'checkbox', id: `cfg.show.${k}`, label, value: l.show[k] !== false, action: `cfg:show:${k}` });
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'row', align: 'between', children: [{ type: 'button', action: 'cfg:padrao', label: 'voltar ao padrão', icon: 'undo' }, { type: 'button', action: 'cfg:fechar', label: 'pronto', style: 'primary' }] });
  return blocks;
}

async function configAction(action, values) {
  const [, what, id] = action.split(':');
  if (what === 'fechar') {
    configOpen = false;
    return mx.request('view.close', { viewId: CONFIG });
  }
  return changeLayout((l) => {
    if (what === 'subir' || what === 'descer') {
      const i = l.order.indexOf(id);
      const j = i + (what === 'subir' ? -1 : 1);
      if (i >= 0 && j >= 0 && j < l.order.length) [l.order[i], l.order[j]] = [l.order[j], l.order[i]];
    } else if (what === 'visivel') {
      const on = !!values[`cfg.visivel.${id}`];
      const visible = l.order.filter((x) => !l.hidden.includes(x));
      // Pelo menos uma coluna fica.
      if (!on && visible.length <= 1 && visible[0] === id) return;
      l.hidden = on ? l.hidden.filter((x) => x !== id) : [...new Set([...l.hidden, id])];
    } else if (what === 'recolhida') {
      const on = !!values[`cfg.recolhida.${id}`];
      l.collapsed = on ? [...new Set([...l.collapsed, id])] : l.collapsed.filter((x) => x !== id);
    } else if (what === 'ordem' && SORTS[values[`cfg.ordem.${id}`]]) l.sort[id] = values[`cfg.ordem.${id}`];
    else if (what === 'largura' && WIDTHS.some(([k]) => k === values['cfg.largura'])) l.width = values['cfg.largura'];
    else if (what === 'show') l.show[id] = !!values[`cfg.show.${id}`];
    else if (what === 'padrao') Object.assign(l, defaultLayout());
  });
}

function filterMenu() {
  const f = state.filter;
  const mark = (on, label) => (on ? `✓  ${label}` : `    ${label}`);
  const s = f.space ? space(f.space) : null;
  return [
    { action: 'quem:me', label: mark(f.who === 'me' && f.role === 'executor', 'as que eu executo'), icon: 'user' },
    { action: 'quem:pedi', label: mark(f.who === 'me' && f.role === 'requester', 'as que eu pedi'), icon: 'user' },
    { action: 'quem:outra', label: mark(!!f.who && f.who !== 'me', 'de outra pessoa…'), icon: 'user' },
    { action: 'quem:todos', label: mark(!f.who && !!s, 'de todo mundo do espaço'), icon: 'user', disabled: !s },
    { type: 'divider' },
    ...(f.who && f.who !== 'me'
      ? [
          { action: 'papel:executor', label: mark(f.role === 'executor', 'que a pessoa executa'), icon: 'task' },
          { action: 'papel:requester', label: mark(f.role === 'requester', 'que a pessoa pediu'), icon: 'task' },
          { type: 'divider' },
        ]
      : []),
    { action: 'espaco:todos', label: mark(!s, 'todos os espaços'), icon: 'layers' },
    { action: 'espaco:escolher', label: s ? mark(true, `${s.name}…`) : mark(false, 'um espaço…'), icon: 'layers' },
    { type: 'divider' },
    { action: 'personalizar', label: 'personalizar o quadro…', icon: 'settings' },
    { action: 'web', label: 'abrir o Wiboor', icon: 'globe' },
  ];
}

function boardSub() {
  if (waiting()) return 'lendo…';
  const open = state.board.length;
  const running = state.board.filter((t) => t.status === 'STARTED').length;
  const parts = [`${open} ${open === 1 ? 'aberta' : 'abertas'}`];
  if (running) parts.push(`${running} em andamento`);
  const overdue = state.board.filter(late).length;
  if (overdue) parts.push(`${overdue} com o prazo vencido`);
  if (state.loading) parts.push('atualizando…');
  else if (state.loadedAt) parts.push(`atualizado ${whenFull(state.loadedAt).split(', ')[1]}`);
  return parts.join(' · ');
}

/** O recado em cima das colunas. Um erro de leitura vem com o "tentar de novo". */
function notice() {
  if (state.notice) return { retry: false, ...state.notice };
  if (state.error) return { text: state.error, tone: 'red', retry: !state.keyRefused };
  return { text: '', tone: '', retry: false };
}

function rfwMenu(menu) {
  return menu.map((m) => (m.type === 'divider' ? { divider: true } : { label: m.label, icon: m.icon || '', action: m.action, red: m.tone === 'red', disabled: !!m.disabled }));
}

/**
 * As pílulas do topo, contadas nas abertas. Cada uma é um filtro: o clique
 * deixa só as dela, e o "abertas" (ou a acesa, de novo) tira. A acesa fica
 * mesmo quando o número dela chega a zero, pra dar pra sair dela.
 */
function stats() {
  const open = state.board.length;
  const pills = [{ text: `${open} ${open === 1 ? 'aberta' : 'abertas'}`, tone: 'accent', action: 'rapido:', active: !state.quick }];
  for (const [k, q] of Object.entries(QUICK)) {
    const n = state.board.filter(q.test).length;
    if (n || state.quick === k) pills.push({ text: q.label(n), tone: q.tone, action: `rapido:${k}`, active: state.quick === k });
  }
  return pills;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** De quem é o quadro, à vista: as suas, as que você pediu, de outra pessoa, de um espaço. */
function scopes() {
  const f = state.filter;
  const s = f.space ? space(f.space) : null;
  const other = !!f.who && f.who !== 'me';
  return [
    { label: 'minhas', icon: 'user', action: 'quem:me', active: f.who === 'me' && f.role === 'executor' },
    { label: 'que pedi', icon: 'task', action: 'quem:pedi', active: f.who === 'me' && f.role === 'requester' },
    { label: other ? clip(firstName(personName(f.who)) || 'outra pessoa', 18) : 'outra pessoa…', icon: 'user', action: 'quem:outra', active: other },
    { label: s ? clip(s.name, 28) : 'um espaço…', icon: 'folder', action: 'espaco:escolher', active: !!s },
  ];
}

function boardData() {
  const loaded = state.loadedAt ? `atualizado às ${whenFull(state.loadedAt).split(', ')[1]}` : '';
  const wait = waiting();
  const sub = state.loading ? (wait ? 'lendo…' : 'atualizando…') : loaded;
  return {
    drag: state.drag,
    head: {
      title: filterTitle(),
      sub: [sub, state.drag && !wait ? 'arraste os cartões entre as colunas' : ''].filter(Boolean).join(' · '),
      busy: state.loading,
      menu: rfwMenu(filterMenu()),
      scopes: scopes(),
    },
    stats: wait ? [] : stats(),
    // Enquanto lê um filtro novo, as pílulas dos números também são de mentira.
    statsSkeleton: wait && !state.error,
    notice: notice(),
    layout: { width: layout().width },
    cols: lanes(),
  };
}

/** O cartão com só o que a pessoa quer ver nele. */
function shown(x, show) {
  const bar = show.bar ? x.bar : { ...x.bar, show: false };
  return {
    ...x,
    sub: show.sub ? x.sub : '',
    who: show.who ? x.who : { initials: '', name: '', tone: '' },
    bar,
    due: show.due ? x.due : '',
    checks: show.meta && !bar.show ? x.checks : '',
    comments: show.meta ? x.comments : '',
    files: show.meta ? x.files : '',
    claude: show.claude ? x.claude : { text: '', tone: '', action: '' },
  };
}

function lanes() {
  const l = layout();
  const visible = columns();
  const waitOpen = waiting();
  const waitDone = finishedWaiting();
  // `slot` é o id da coluna como alvo de outra coluna: os cartões caem no
  // `id` (o estado), as colunas no `slot`.
  return visible.map((c) => {
    const cards = c.list.map(card).map((x) => ({ ...shown(x, l.show), menu: rfwMenu(x.menu) }));
    const wait = c.id === 'FINISHED' ? waitDone : waitOpen;
    return {
      id: c.id,
      slot: `col:${c.id}`,
      slots: visible.filter((x) => x.id !== c.id).map((x) => `col:${x.id}`),
      label: c.label,
      tone: c.tone,
      icon: c.icon,
      hint: c.hint,
      empty: c.empty,
      invite: state.drag && !wait ? c.invite : '',
      count: wait ? '…' : String(cards.length),
      // Enquanto o filtro atual não chega (a primeira leitura, ou a troca pra um
      // filtro ainda não visto), cartões de mentira no lugar do "lendo…".
      skeleton: wait,
      collapsed: c.collapsed,
      toggle: `coluna:${c.id}:recolher`,
      sortLabel: c.sort === 'prioridade' || (c.id === 'FINISHED' && c.sort === 'finalizadas') ? '' : `por ${SORTS[c.sort].label}`,
      menu: rfwMenu(laneMenu(c, visible)),
      cards,
      // A coluna no ar leva os primeiros cartões e diz quantos ficaram.
      peek: cards.slice(0, PEEK),
      more: cards.length > PEEK ? `+ ${cards.length - PEEK} ${cards.length - PEEK === 1 ? 'cartão' : 'cartões'}` : '',
    };
  });
}

// Numa Maestria sem widgets, o quadro são blocos. Quatro colunas lado a lado
// não cabem na largura de uma janela de blocos: aqui é uma coluna por vez, nas
// abas, com a largura toda pra ler o título.
function boardBlocks() {
  const n = notice();
  const cols = columns();
  const current = cols.find((c) => c.id === state.tab) || cols[0];
  const blocks = [
    {
      type: 'header',
      title: filterTitle(),
      subtitle: boardSub(),
      actions: [
        { action: 'buscar', icon: 'search', tooltip: 'achar uma tarefa do quadro' },
        { action: 'nova', icon: 'add', tooltip: 'nova tarefa' },
        { icon: 'filter', tooltip: 'de quem e de qual espaço', menu: filterMenu() },
        { action: 'atualizar', icon: 'refresh', tooltip: 'atualizar' },
      ],
    },
  ];
  if (!state.rfw) {
    blocks.push({ type: 'text', style: 'faint', text: 'esta Maestria desenha o quadro simplificado: reabra o app (uma versão com a interface em widgets) pra ver as colunas lado a lado.' });
  }
  if (n.text) blocks.push({ type: 'text', style: n.tone === 'red' ? 'error' : 'dim', text: n.text });
  blocks.push({
    type: 'tabs',
    items: cols.map((c) => ({ label: c.label, action: `aba:${c.id}`, active: c.id === current.id, count: c.list.length })),
  });
  blocks.push({
    type: 'card',
    children: [
      {
        type: 'list',
        flat: true,
        empty: current.empty,
        items: current.list.map((t) => {
          const x = card(t);
          const s = sessionFor(t);
          return {
            title: x.title,
            subtitle: [x.num, x.due, x.checks && `checklist ${x.checks}`, x.comments && `${x.comments} coment.`, x.files && `${x.files} anexo${x.files === '1' ? '' : 's'}`, x.sub, x.claude.text].filter(Boolean).join(' · '),
            subtitleTone: x.late ? 'red' : undefined,
            icon: t.type === 'BUG' ? 'bug' : 'task',
            tone: t.type === 'BUG' ? 'red' : 'accent',
            avatar: { icon: t.type === 'BUG' ? 'bug' : 'task', color: t.type === 'BUG' ? 'red' : 'accent' },
            status: s ? x.claude.tone : undefined,
            meta: x.prio,
            metaTone: x.prioTone === 'faint' ? undefined : x.prioTone,
            action: x.action,
            actions: x.acts,
            menu: x.menu,
          };
        }),
      },
    ],
  });
  return blocks;
}

function keyBlocks(where) {
  const blocks = [
    { type: 'header', avatar: { icon: 'icons/wiboor.svg', color: 'accent' }, title: 'Conectar ao Wiboor', subtitle: 'pela API pública, com a sua chave' },
    {
      type: 'markdown',
      text:
        'Cole a **API key** do Wiboor. Ela vale por você: o quadro, os comentários e as mudanças de estado saem no seu nome.\n\n' +
        `Fica em \`${api.CONFIG.replace(require('os').homedir(), '~')}\` (só você lê), o mesmo arquivo das skills do Wiboor — se você já configurou uma delas, é só apertar **conectar** de novo.`,
    },
    { type: 'input', id: `chave.${state.gen}`, label: 'API key', placeholder: 'eyJhbGciOi…', submit: 'chave' },
  ];
  if (state.keyError) blocks.push({ type: 'text', style: 'error', text: state.keyError });
  else if (state.error) blocks.push({ type: 'text', style: 'error', text: state.error });
  blocks.push({ type: 'row', children: [{ type: 'button', action: 'chave', label: 'conectar', style: 'primary' }, { type: 'button', action: 'web', label: 'abrir o Wiboor' }] });
  if (where === 'sidebar') blocks.splice(1, 1, { type: 'text', style: 'dim', text: 'Cole a API key do Wiboor pra ver as suas tarefas.' });
  return blocks;
}

function needsKey() {
  return !api.auth || state.keyRefused;
}

async function openBoard() {
  state.boardOpen = true;
  state.boardRfw = false;
  await pushBoard(true);
  await reload();
}

async function pushBoard(open = false) {
  if (!state.boardOpen) return;
  const method = open ? 'view.open' : 'view.update';
  const params = { viewId: BOARD, title: 'Wiboor' };
  if (needsKey()) {
    params.blocks = keyBlocks('board');
    state.boardRfw = false;
  } else if (state.rfw) {
    params.data = boardData();
    if (!state.boardRfw) params.rfw = { library: RFW_LIBRARY, root: 'root' };
  } else params.blocks = boardBlocks();
  try {
    const r = await mx.request(method, params);
    if (params.rfw) state.boardRfw = true;
    if (!open && r && r.open === false) {
      state.boardOpen = false;
      state.boardRfw = false;
    }
  } catch (e) {
    mx.log(`${method}:`, e.message);
  }
}

// --- a aba da lateral ------------------------------------------------------------------

function sidebarItem(t) {
  const x = card(t);
  return {
    title: x.title,
    subtitle: [x.num, x.claude.text || x.due, x.checks].filter(Boolean).join(' · '),
    subtitleTone: x.claude.text ? undefined : x.dueTone || undefined,
    icon: t.type === 'BUG' ? 'bug' : 'task',
    tone: t.type === 'BUG' ? 'red' : STATUS_TONE[t.status] || 'faint',
    avatar: { icon: t.type === 'BUG' ? 'bug' : 'task', color: t.type === 'BUG' ? 'red' : 'accent' },
    // A bolinha é a da sessão do claude quando há uma: é o que pede atenção.
    status: x.claude.tone || (t.status === 'STARTED' ? 'green' : t.status === 'PAUSED' ? 'yellow' : undefined),
    action: x.action,
    actions: x.acts,
    menu: x.menu,
  };
}

function sidebarBlocks() {
  if (needsKey()) return keyBlocks('sidebar');
  const me = api.auth && api.auth.email;
  const blocks = [
    {
      type: 'header',
      title: 'Wiboor',
      subtitle: state.loading && !state.loadedAt ? 'lendo…' : me || '',
      actions: [
        { action: 'quadro', icon: 'layers', tooltip: 'abrir o quadro' },
        { action: 'nova', icon: 'add', tooltip: 'nova tarefa' },
        { action: 'atualizar', icon: 'refresh', tooltip: 'atualizar' },
      ],
    },
  ];
  if (state.error) blocks.push({ type: 'text', style: 'error', text: state.error });
  const groups = [
    ['STARTED', 'Em andamento'],
    ['PAUSED', 'Pausadas'],
    ['NOT_STARTED', 'Não iniciadas'],
  ];
  state.collapsed = state.collapsed || {};
  for (const [status, label] of groups) {
    const list = state.mine.filter((t) => t.status === status).sort(byPriority);
    if (!list.length && status !== 'STARTED') continue;
    const collapsed = !!state.collapsed[status];
    blocks.push({ type: 'section', text: label, count: list.length, collapsed, action: `secao:${status}` });
    if (collapsed) continue;
    blocks.push({ type: 'list', flat: true, empty: state.loadedAt ? 'nada rodando agora' : 'lendo…', items: list.map(sidebarItem) });
  }
  return blocks;
}

function badgeText() {
  const n = state.mine.filter((t) => t.status === 'STARTED').length;
  return n ? String(n) : '';
}

async function pushSidebar() {
  const badge = needsKey() ? '' : badgeText();
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

// --- a janela de uma tarefa ------------------------------------------------------------

async function openDetail(id) {
  const viewId = DETAIL + id;
  let d = state.details.get(viewId);
  if (!d) {
    d = { id, task: findTask(id), error: null, gen: 0 };
    state.details.set(viewId, d);
  }
  // Em modal, por cima do quadro, quando a Maestria tem e você não desligou; o
  // botão "abrir como painel" do próprio modal a põe na grade.
  const modal = state.modal && setting('detailModal', true) !== false;
  await mx.request('view.open', { viewId, title: d.task ? tag(d.task) : 'tarefa', blocks: detailBlocks(d), modal });
  await refreshDetail(viewId);
}

async function refreshDetail(viewId) {
  const d = state.details.get(viewId);
  if (!d) return;
  try {
    d.task = await api.task(d.id, d.task && d.task.taskNumber);
    d.error = null;
  } catch (e) {
    d.error = e.message;
  }
  await pushDetail(viewId);
}

async function pushDetail(viewId) {
  const d = state.details.get(viewId);
  if (!d) return;
  try {
    const r = await mx.request('view.update', { viewId, title: d.task ? tag(d.task) : 'tarefa', blocks: detailBlocks(d) });
    if (r && r.open === false) state.details.delete(viewId);
  } catch (e) {
    mx.log('view.update:', e.message);
  }
}

function detailBlocks(d) {
  const t = d.task;
  if (!t) return [{ type: 'progress', label: 'abrindo a tarefa…' }, ...(d.error ? [{ type: 'text', style: 'error', text: d.error }] : [])];
  const course = isCourse(t);
  const busy = state.busy.has(t.id);
  const session = sessionFor(t);
  const due = dueOf(t);
  const open = t.status !== 'FINISHED';
  const blocks = [
    // O título inteiro, quebrando a linha (`wrap`), e embaixo o número, o
    // estado e o espaço. O número já está no topo da janela.
    {
      type: 'header',
      avatar: { icon: t.type === 'BUG' ? 'bug' : 'task', color: t.type === 'BUG' ? 'red' : 'accent' },
      status: t.status === 'STARTED' ? 'green' : t.status === 'PAUSED' ? 'yellow' : undefined,
      title: t.title,
      wrap: true,
      subtitle: [tag(t), busy ? 'um instante…' : STATUS[t.status] || t.status, spaceName(t)].filter(Boolean).join(' · '),
      tone: STATUS_TONE[t.status],
      actions: [
        { action: `web:${t.id}`, icon: 'globe', tooltip: 'abrir no Wiboor' },
        {
          icon: 'more',
          tooltip: 'mais',
          menu: [
            { action: `branch:${t.id}`, label: `copiar a branch (${branchOf(t)})`, icon: 'branch' },
            { action: `link:${t.id}`, label: 'copiar o link', icon: 'link' },
            { type: 'divider' },
            { action: `recarregar:${t.id}`, label: 'atualizar', icon: 'refresh' },
          ],
        },
      ],
    },
  ];

  // As ações da tarefa em botões com nome, logo embaixo do título. O próximo
  // passo vai em destaque: sem sessão, trabalhar com o claude (que já inicia);
  // com uma, mexer no estado.
  const buttons = [];
  const step = !course && !busy && open ? (t.status === 'STARTED' ? 'end' : 'start') : '';
  if (open && !course) {
    buttons.push({
      type: 'button',
      action: `trabalhar:${t.id}`,
      icon: 'terminal',
      label: session ? 'ir pra sessão do claude' : 'trabalhar com o claude',
      tooltip: session ? undefined : 'cria a worktree, abre o claude lá com a tarefa no prompt e a inicia no Wiboor',
      style: session ? undefined : 'primary',
    });
  }
  if (step === 'start') buttons.push({ type: 'button', action: `start:${t.id}`, icon: 'play', label: t.status === 'PAUSED' ? 'retomar' : 'iniciar', style: session ? 'primary' : undefined });
  if (step === 'end') {
    buttons.push({ type: 'button', action: `pause:${t.id}`, icon: 'pause', label: 'pausar' });
    buttons.push({ type: 'button', action: `end:${t.id}`, icon: 'check', label: 'finalizar', style: session ? 'primary' : undefined });
  }
  if (buttons.length) blocks.push({ type: 'row', children: buttons });
  if (d.error) blocks.push({ type: 'text', style: 'error', text: d.error });
  if (course) {
    blocks.push({ type: 'progress', value: Math.min(1, (t.progress || 0) / 100), label: 'curso assistido', detail: `${t.progress || 0}%`, tone: 'accent' });
    blocks.push({ type: 'text', style: 'faint', text: 'Tarefa de curso: quem a fecha é a CEFIS, quando o curso termina. O estado dela não muda por aqui.' });
  }

  blocks.push(...factsBlocks(t, open, due));

  // A sessão do claude desta tarefa: o que ela está fazendo, ir pra ela, e o
  // rascunho do comentário com o que mudou na pasta dela. Sem sessão nem pasta,
  // o botão lá de cima já diz o que fazer.
  const link = state.links[t.id];
  const cwd = (session && session.cwd) || (link && link.cwd);
  if (session || cwd) {
    const chip = sessionChip(session);
    blocks.push({ type: 'section', text: 'Claude' });
    blocks.push({
      type: 'list',
      items: [
        {
          title: session ? session.title || tag(t) : 'sessão fechada',
          subtitle: [session ? chip.text : 'reabre na mesma pasta', cwd && cwd.replace(require('os').homedir(), '~')].filter(Boolean).join(' · '),
          avatar: { icon: 'terminal', color: session ? chip.tone || 'accent' : 'faint' },
          status: session ? chip.tone || undefined : undefined,
          dim: !session,
          action: `trabalhar:${t.id}`,
          actions: [{ action: `trabalhar:${t.id}`, icon: session ? 'open' : 'play', tooltip: session ? 'ir pra sessão' : 'abrir o claude de novo nesta pasta' }],
        },
      ],
      alwaysActions: true,
    });
    blocks.push({
      type: 'row',
      children: [
        { type: 'button', action: `rascunho:${t.id}`, icon: 'star', label: d.drafting ? 'o claude está escrevendo…' : 'rascunhar o comentário do que foi feito', disabled: !!d.drafting || !cwd },
      ],
    });
  }

  const desc = html.toMarkdown(t.description);
  d.attachments = attachmentsOf(t);
  blocks.push({ type: 'section', text: 'Descrição' });
  blocks.push(desc ? { type: 'card', children: [{ type: 'markdown', text: desc }] } : { type: 'text', style: 'faint', text: 'sem descrição' });

  // O checklist logo depois da descrição: é o que se mexe enquanto trabalha.
  const list = t.checklist || [];
  const ticked = list.filter((c) => c.status === 'CHECKED').length;
  blocks.push({ type: 'section', text: 'Checklist', count: list.length ? checks(t) : undefined });
  const listBlocks = [];
  if (list.length) {
    listBlocks.push({ type: 'progress', value: ticked / list.length, label: ticked === list.length ? 'tudo feito' : 'feito', detail: `${ticked} de ${list.length}`, tone: ticked === list.length ? 'green' : 'accent' });
  }
  for (const c of list) {
    listBlocks.push({ type: 'checkbox', id: `ck.${d.gen}.${c.id}`, label: c.description, value: c.status === 'CHECKED', action: `check:${t.id}:${c.id}` });
  }
  listBlocks.push({ type: 'input', id: `item.${d.gen}`, placeholder: list.length ? 'mais um item (enter adiciona)' : 'o primeiro item do checklist (enter adiciona)', icon: 'add', submit: `additem:${t.id}` });
  blocks.push(list.length ? { type: 'card', children: listBlocks } : listBlocks[0]);

  // Os anexos: as imagens em miniatura, três por linha, e a lista de tudo, com
  // abrir, baixar e copiar o link.
  if (d.attachments.length) {
    blocks.push({ type: 'section', text: 'Anexos', count: d.attachments.length });
    const images = d.attachments.map((a, i) => ({ ...a, i })).filter((a) => a.kind === 'image');
    for (let r = 0; r < images.length; r += 3) {
      const row = images.slice(r, r + 3);
      while (row.length < 3) row.push(null);
      blocks.push({
        type: 'columns',
        children: row.map((a) =>
          a
            ? { type: 'card', padding: 6, children: [{ type: 'markdown', text: `[![${a.name}](${a.url})](${a.url})` }, { type: 'text', style: 'faint', text: a.name }] }
            : { type: 'text', text: '' },
        ),
      });
    }
    blocks.push({
      type: 'list',
      items: d.attachments.map((a, i) => {
        const saved = d.downloaded && d.downloaded[a.url];
        return {
          title: a.name,
          subtitle: [KIND_LABEL[a.kind], a.from, saved && `baixado em ${saved.replace(require('os').homedir(), '~')}`].filter(Boolean).join(' · '),
          icon: KIND_ICON[a.kind],
          tone: a.kind === 'image' ? 'accent' : a.kind === 'file' ? 'faint' : 'purple',
          avatar: { icon: KIND_ICON[a.kind], color: a.kind === 'image' ? 'accent' : a.kind === 'file' ? 'faint' : 'purple' },
          action: `anexo:${t.id}:${i}:abrir`,
          actions: [
            { action: `anexo:${t.id}:${i}:abrir`, icon: 'open', tooltip: 'abrir no navegador' },
            saved
              ? { action: `anexo:${t.id}:${i}:mostrar`, icon: 'folder', tooltip: 'mostrar no Finder' }
              : { action: `anexo:${t.id}:${i}:baixar`, icon: 'pull', tooltip: 'baixar pra pasta Downloads' },
            { action: `anexo:${t.id}:${i}:link`, icon: 'link', tooltip: 'copiar o link' },
          ],
        };
      }),
    });
  }

  const comments = (t.comments || []).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  blocks.push({ type: 'section', text: 'Comentários', count: comments.length || undefined });
  if (!comments.length) blocks.push({ type: 'text', style: 'faint', text: 'ninguém comentou ainda' });
  for (const c of comments) {
    const who = personName(c.userId) || 'alguém';
    blocks.push({
      type: 'card',
      children: [
        {
          type: 'list',
          flat: true,
          items: [
            {
              title: who === 'você' ? 'Você' : who,
              subtitle: `${whenFull(c.createdAt)}${c.isEdited ? ' · editado' : ''}`,
              avatar: { text: initials(who === 'você' ? me() : who), shape: 'circle', color: toneOf(c.userId) },
            },
          ],
        },
        { type: 'markdown', text: html.toMarkdown(c.message) || '—' },
      ],
    });
  }
  blocks.push({
    type: 'input',
    id: `comentario.${d.gen}`,
    multiline: true,
    // O rascunho do claude entra aqui pra você revisar; nada vai sem o "comentar".
    value: d.draft || undefined,
    placeholder: 'escreva um comentário… (**negrito**, `código`, - lista, - [ ] passo)',
  });
  blocks.push({
    type: 'row',
    align: 'end',
    children: [{ type: 'button', action: `comentar:${t.id}`, label: d.sending ? 'enviando…' : 'comentar', style: 'primary', disabled: !!d.sending }],
  });
  return blocks;
}

/** O nome de quem é dono da chave, pras iniciais do "você". */
function me() {
  const id = api.auth && api.auth.userId;
  return (id && state.dirs && state.dirs.people.get(id) && state.dirs.people.get(id).name) || (api.auth && api.auth.email) || 'você';
}

/**
 * A ficha da tarefa: prioridade, prazo e as datas em cartõezinhos lado a lado
 * (o que se olha primeiro), e embaixo quem faz, quem pediu, o espaço e a
 * branch, cada um com a bolinha ou o desenho dele.
 */
function factsBlocks(t, open, due) {
  // O `style` do bloco de texto é a cor: error vermelho, warning amarelo, success verde.
  const toneStyle = { red: 'error', yellow: 'warning', green: 'success' };
  const fact = (label, value, tone) => ({
    type: 'card',
    padding: 10,
    children: [
      { type: 'text', style: 'faint', text: label },
      { type: 'text', style: toneStyle[tone], text: value },
    ],
  });
  const facts = [];
  if (t.priority) facts.push(fact('prioridade', `P${t.priority}`, t.priority >= 8 ? 'red' : t.priority >= 6 ? 'yellow' : undefined));
  if (t.endedAt) {
    const left = open && due.text && due.text !== when(t.endedAt) ? ` · ${due.text}` : '';
    facts.push(fact('prazo', `${whenFull(t.endedAt)}${left}`, open ? due.tone : undefined));
  }
  if (t.finishedAt) facts.push(fact('finalizada', whenFull(t.finishedAt), 'green'));
  else if (t.startedAt) facts.push(fact('início planejado', whenFull(t.startedAt)));
  const out = [];
  if (facts.length) out.push({ type: 'columns', children: facts });

  const person = (role, id, name) => ({
    title: name || '—',
    subtitle: role,
    avatar: name ? { text: initials(name), shape: 'circle', color: toneOf(id) } : { icon: 'user', color: 'faint' },
  });
  const executor = (t.userExecutor && t.userExecutor.name) || personName(t.userExecutorId);
  const requester = (t.userRequester && t.userRequester.name) || personName(t.userRequesterId);
  out.push({
    type: 'columns',
    children: [
      { type: 'card', padding: 6, children: [{ type: 'list', flat: true, items: [person('executor', t.userExecutorId, executor), person('solicitante', t.userRequesterId, requester)] }] },
      {
        type: 'card',
        padding: 6,
        children: [
          {
            type: 'list',
            flat: true,
            alwaysActions: true,
            items: [
              { title: spaceName(t) || '—', subtitle: 'espaço', avatar: { icon: 'folder', color: 'faint' } },
              { title: branchOf(t), subtitle: 'branch', avatar: { icon: 'branch', color: 'faint' }, actions: [{ action: `branch:${t.id}`, icon: 'copy', tooltip: 'copiar a branch' }] },
            ],
          },
        ],
      },
    ],
  });
  return out;
}

async function attachmentAction(viewId, index, what) {
  const d = state.details.get(viewId);
  const a = d && d.attachments && d.attachments[index];
  if (!a) return;
  if (what === 'abrir') return mx.request('window.openUrl', { url: a.url });
  if (what === 'link') {
    await mx.request('clipboard.write', { text: a.url });
    return mx.request('window.showBanner', { text: `link de ${a.name} copiado` });
  }
  d.downloaded = d.downloaded || {};
  if (what === 'mostrar' && d.downloaded[a.url]) return openFile(d.downloaded[a.url], true);
  if (what !== 'baixar') return;
  const dir = path.join(require('os').homedir(), 'Downloads');
  try {
    await mx.request('window.showBanner', { text: `baixando ${a.name}…` });
    const file = await download(a.url, freePath(dir, a.name));
    d.downloaded[a.url] = file;
    await mx.request('window.showBanner', { text: `baixado: ${file.replace(require('os').homedir(), '~')}` });
  } catch (e) {
    d.error = `baixar: ${e.message}`;
  }
  return pushDetail(viewId);
}

async function detailAction(viewId, action, values) {
  const d = state.details.get(viewId);
  if (!d) return;
  const [verb, id, item] = action.split(':');
  if (verb === 'check') {
    const on = !!values[`ck.${d.gen}.${item}`];
    try {
      await api.check(id, item, on);
    } catch (e) {
      d.error = e.message;
    }
    d.gen++; // o valor de cada caixa volta do servidor
    await refreshDetail(viewId);
    return reload();
  }
  if (verb === 'additem') {
    const text = String(values[`item.${d.gen}`] || '').trim();
    if (!text) return;
    if (text.length > 191) {
      d.error = `um item tem no máximo 191 caracteres (esse tem ${text.length})`;
      return pushDetail(viewId);
    }
    try {
      await api.checklistAdd(id, text);
      d.gen++;
    } catch (e) {
      d.error = e.message;
    }
    await refreshDetail(viewId);
    return reload();
  }
  if (verb === 'comentar') {
    const text = String(values[`comentario.${d.gen}`] || '').trim();
    if (!text || d.sending) return;
    d.sending = true;
    await pushDetail(viewId);
    try {
      await api.comment(id, html.fromMarkdown(text));
      d.gen++;
      d.draft = null;
    } catch (e) {
      d.error = e.message;
    }
    d.sending = false;
    await refreshDetail(viewId);
    return reload();
  }
  if (verb === 'recarregar') return refreshDetail(viewId);
  if (verb === 'rascunho') return draftComment(viewId);
  if (verb === 'anexo') return attachmentAction(viewId, Number(item), action.split(':')[3]);
  return boardAction(action, values);
}

// --- nova tarefa -----------------------------------------------------------------------

/**
 * O formulário de tarefa nova. Com [from] -- uma tarefa sugerida que a Maestria
 * entregou (`suggestion.start`) --, ele vem preenchido com ela, e criar devolve
 * a tarefa à Maestria (`suggestion.created`), que faz o que foi escolhido no
 * cartão: worktree, sessão nova na mesma pasta, ou o pedido pra sessão que
 * sugeriu.
 */
async function openForm(from = null) {
  if (needsKey()) return openBoard();
  await loadDirs();
  const fromFilter = state.filter.space || '';
  state.form = {
    gen: ++state.gen,
    space: fromFilter || state.formSpace || (state.dirs.spaces[0] && state.dirs.spaces[0].key) || '',
    error: null,
    sending: false,
    from,
    // O que você digitou, pra uma troca de espaço (que redesenha o formulário)
    // não voltar o campo pro texto da sugestão.
    typed: from ? { title: from.suggestion.title || '', desc: suggestionText(from.suggestion) } : null,
  };
  await mx.request('view.open', { viewId: FORM, title: from ? 'nova tarefa da sugestão' : 'nova tarefa', blocks: formBlocks() });
}

/** O que acontece depois de criar, conforme a saída escolhida no cartão da Maestria. */
const AFTER = {
  worktree: 'criar já abre a worktree dela e uma sessão lá',
  local: 'criar já abre uma sessão nova nesta pasta',
  here: 'criar já manda o pedido pra sessão que sugeriu',
};

/** A descrição da tarefa que nasce de uma sugestão: o resumo, e o pedido inteiro embaixo. */
function suggestionText(s) {
  return [s.tldr, s.prompt].filter((x) => x && x.trim()).join('\n\n');
}

function formBlocks() {
  const f = state.form;
  const g = f.gen;
  const s = space(f.space);
  const me = api.auth && api.auth.userId;
  const members = (s ? s.users : []).map((u) => ({ value: u.id, label: u.name || u.email })).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  const executor = f.executor && members.some((m) => m.value === f.executor) ? f.executor : members.some((m) => m.value === me) ? me : '';
  const typed = f.typed || {};
  return [
    f.from
      ? { type: 'header', avatar: { icon: 'add', color: 'accent' }, title: 'Nova tarefa da sugestão', subtitle: `do claude em ${f.from.origin.folder} — ${AFTER[f.from.choice] || AFTER.worktree}` }
      : { type: 'header', avatar: { icon: 'add', color: 'accent' }, title: 'Nova tarefa', subtitle: 'vai pro Wiboor no seu nome' },
    { type: 'input', id: `titulo.${g}`, label: 'título', placeholder: 'o que precisa ser feito', ...(typed.title !== undefined && { value: typed.title }) },
    { type: 'input', id: `descricao.${g}`, label: 'descrição', multiline: true, placeholder: 'contexto, passos… (markdown simples: - lista, - [ ] passo, **negrito**)', ...(typed.desc !== undefined && { value: typed.desc }) },
    {
      type: 'columns',
      children: [
        { type: 'select', id: `tipo.${g}`, label: 'tipo', value: 'TASK', options: [{ value: 'TASK', label: 'tarefa' }, { value: 'BUG', label: 'bug' }] },
        { type: 'select', id: `prioridade.${g}`, label: 'prioridade', value: '5', options: Array.from({ length: 10 }, (_, i) => String(i + 1)) },
      ],
    },
    {
      type: 'columns',
      children: [
        { type: 'select', id: 'espaco', label: 'espaço', value: f.space, options: state.dirs.spaces.map((x) => ({ value: x.key, label: x.name })), action: 'form:espaco' },
        { type: 'select', id: `executor.${f.space}`, label: 'executor', value: executor, placeholder: members.length ? 'quem faz' : 'ninguém neste espaço', options: members },
      ],
    },
    { type: 'section', text: 'Prazo (opcional)' },
    { type: 'calendar', id: `prazo.${g}`, mode: 'single', min: 'today' },
    ...(f.error ? [{ type: 'text', style: 'error', text: f.error }] : []),
    {
      type: 'row',
      align: 'end',
      children: [
        { type: 'button', action: 'form:cancelar', label: 'cancelar' },
        { type: 'button', action: 'form:criar', label: f.sending ? 'criando…' : f.from ? 'criar e começar' : 'criar a tarefa', style: 'primary', disabled: f.sending },
      ],
    },
  ];
}

async function formAction(action, values) {
  const f = state.form;
  if (!f) return;
  // Todo clique traz os campos: guardados, o redesenho não apaga o que você mudou.
  if (f.typed) {
    const t = values[`titulo.${f.gen}`];
    const d = values[`descricao.${f.gen}`];
    if (typeof t === 'string') f.typed.title = t;
    if (typeof d === 'string') f.typed.desc = d;
  }
  if (action === 'form:cancelar') {
    state.form = null;
    return mx.request('view.close', { viewId: FORM });
  }
  if (action === 'form:espaco') {
    f.space = values.espaco || f.space;
    return mx.request('view.update', { viewId: FORM, blocks: formBlocks() });
  }
  if (action !== 'form:criar' || f.sending) return;
  const g = f.gen;
  const title = String(values[`titulo.${g}`] || '').trim();
  const s = space(values.espaco || f.space);
  const executor = values[`executor.${f.space}`] || (s && s.users.some((u) => u.id === api.auth.userId) ? api.auth.userId : '');
  f.error = !title ? 'falta o título' : title.length > 191 ? `o título tem no máximo 191 caracteres (esse tem ${title.length})` : !s ? 'escolha o espaço' : !executor ? 'escolha quem executa' : null;
  if (f.error) return mx.request('view.update', { viewId: FORM, blocks: formBlocks() });
  const body = {
    title,
    type: values[`tipo.${g}`] || 'TASK',
    userExecutorId: executor,
    priority: Number(values[`prioridade.${g}`] || 5),
    departmentId: s.id,
    description: html.fromMarkdown(values[`descricao.${g}`] || ''),
  };
  if (s.group) body.departmentGroupId = s.group;
  const due = values[`prazo.${g}`];
  // O prazo é o fim do dia escolhido, na hora daqui.
  if (typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due)) body.endedAt = new Date(`${due}T18:00:00`).toISOString();
  f.sending = true;
  f.executor = executor;
  await mx.request('view.update', { viewId: FORM, blocks: formBlocks() });
  try {
    const t = await api.create(body);
    state.formSpace = s.key;
    saveState();
    state.form = null;
    await mx.request('view.close', { viewId: FORM });
    await mx.request('window.showBanner', { text: `criada: ${tag(t)} — ${t.title}` });
    if (f.from) await handOver(t, f.from).catch(async (e) => {
      mx.log('suggestion.created', String(e.stack || e));
      await mx.request('window.showBanner', { text: `wiboor: ${tag(t)} criada, mas não deu pra começar: ${e.message}`, sticky: true }).catch(() => {});
    });
    else await openDetail(t.id);
    await reload();
  } catch (e) {
    f.sending = false;
    f.error = e.message;
    await mx.request('view.update', { viewId: FORM, blocks: formBlocks() });
  }
}

// --- os cliques ------------------------------------------------------------------------

async function boardAction(action, values) {
  const [verb, id] = action.split(':');
  switch (verb) {
    case 'abrir':
      return openDetail(id);
    case 'start':
    case 'pause':
    case 'end':
      return changeState(id, verb);
    case 'branch':
      return copyBranch(id);
    case 'link':
      return copyLink(id);
    case 'web':
      return openWeb(id);
    case 'trabalhar':
      return workOn(id);
    case 'rapido':
      state.quick = id && id !== state.quick && QUICK[id] ? id : '';
      return pushBoard();
    case 'aba':
      state.tab = id;
      saveState();
      return pushBoard();
    case 'quem':
    case 'papel':
    case 'espaco':
      return setFilter(action);
    case 'coluna': {
      const [, col, what, arg] = action.split(':');
      return columnAction(col, what, arg);
    }
    case 'personalizar':
      return openConfig();
    case 'secao':
      state.collapsed = state.collapsed || {};
      state.collapsed[id] = !state.collapsed[id];
      return pushSidebar();
    case 'quadro':
      return openBoard();
    case 'nova':
      return openForm();
    case 'buscar': {
      const all = [...state.board, ...state.finished];
      const picked = await pickTask('abrir qual tarefa?', all.length ? all : state.mine);
      if (picked) await openDetail(picked);
      return;
    }
    case 'atualizar':
      state.dirs = null;
      return reload();
    case 'chave': {
      const key = Object.entries(values).find(([k]) => k.startsWith('chave.'));
      return saveKey({ chave: key ? key[1] : '' });
    }
    default:
      mx.log('ação desconhecida:', action);
  }
}

mx.onNotification('view.action', async ({ viewId, action, values = {} }) => {
  // O menu de um cartão no quadro em widgets manda a escolha em `action` dentro dos valores.
  const act = values.a || values.action || action;
  if (viewId === BOARD && action === 'drop') return dropped(values.payload, values.to);
  if (viewId === BOARD && action === 'act') return boardAction(act, values);
  if (viewId === FORM) return formAction(act, values);
  if (viewId === CONFIG) return configAction(act, values);
  if (viewId.startsWith(DETAIL)) return detailAction(viewId, act, values);
  return boardAction(act, values);
});

// --- a tarefa da branch ------------------------------------------------------------------

/** A tarefa do painel em foco, pelo número na branch (feature/TASK#47730) ou no título. */
async function openFromBranch() {
  const s = await mx.request('sessions.focused').catch(() => null);
  const text = [s && s.branch, s && s.title].filter(Boolean).join(' ');
  const m = text.match(/(?:TASK|BUG)#?(\d{3,})/i) || text.match(/#(\d{3,})/);
  if (!m) {
    await mx.request('window.showBanner', { text: 'o painel em foco não está numa branch de tarefa (feature/TASK#… ou hotfix/BUG#…)' });
    return;
  }
  const n = Number(m[1]);
  const found = await api.tasks({ search: n, statuses: null, join: false });
  const t = found.find((x) => x.taskNumber === n);
  if (!t) {
    await mx.request('window.showBanner', { text: `#${n} não apareceu no Wiboor com a sua chave` });
    return;
  }
  await loadDirs().catch(() => {});
  await openDetail(t.id);
}

// --- o relógio -------------------------------------------------------------------------

function schedule() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  const secs = Number(setting('refresh', 60)) || 0;
  if (secs <= 0) return;
  state.timer = setInterval(() => {
    if (!state.boardOpen && !state.sidebarShown) return;
    if (state.busy.size || needsKey()) return;
    reload({ quiet: true }).catch((e) => mx.log('atualizar:', String(e.stack || e)));
  }, Math.max(15, secs) * 1000);
  state.timer.unref();
}

// --- a janela conversa com a gente ----------------------------------------------------------

// Uma sessão mudou de estado, abriu ou fechou: os cartões ligados a ela se
// redesenham. Uma rajada de eventos vira um redesenho só.
let sessionsTimer = null;
function sessionsChanged() {
  if (sessionsTimer) return;
  sessionsTimer = setTimeout(async () => {
    sessionsTimer = null;
    await loadSessions();
    await pushAll();
    for (const viewId of state.details.keys()) await pushDetail(viewId);
  }, 400);
}

mx.onNotification('event', async (e) => {
  if (e.type === 'session.opened' || e.type === 'session.closed' || e.type === 'session.status' || e.type === 'session.exited') {
    if (state.boardOpen || state.sidebarShown || state.details.size) sessionsChanged();
    return;
  }
  if (e.type === 'sidebar.shown') {
    state.sidebarShown = true;
    await pushSidebar();
    return reload({ quiet: true });
  }
  if (e.type === 'sidebar.hidden') state.sidebarShown = false;
});

mx.onRequest('initialize', (params) => {
  state.dataDir = params.dataDir || state.dataDir;
  state.settings = params.settings || {};
  state.rfw = Number(params.rfw) >= 1;
  state.drag = Number(params.rfw) >= 2;
  state.modal = Number(params.modal) >= 1;
  loadState();
  api.load();
  schedule();
  return {};
});

mx.onNotification('settings.changed', async ({ settings }) => {
  state.settings = settings || {};
  schedule();
  await reload();
});

mx.onRequest('command.invoke', async ({ command }) => {
  // Sem await: o seletor espera você, e o command.invoke tem 30s pra voltar.
  const go = (fn) =>
    fn().catch(async (e) => {
      mx.log(command, String(e.stack || e));
      await mx.request('window.showBanner', { text: `wiboor: ${e.message}` }).catch(() => {});
    });
  if (command === 'quadro') go(openBoard);
  else if (command === 'nova') go(openForm);
  else if (command === 'branch') go(openFromBranch);
  else if (command === 'abrir') {
    go(async () => {
      if (needsKey()) return openBoard();
      await loadDirs();
      if (!state.loadedAt) await reload();
      const id = await pickTask('abrir qual tarefa sua?', state.mine);
      if (id) await openDetail(id);
    });
  } else throw new Error(`comando desconhecido: ${command}`);
  return null;
});

// Uma tarefa sugerida por uma sessão do claude, com o switch "criar a task no
// Wiboor" ligado no cartão dela. Responde na hora: o formulário espera você, e
// o pedido tem 30s.
mx.onRequest('suggestion.start', async ({ suggestion, origin, choice = 'worktree' }) => {
  if (!suggestion || !origin) throw new Error('suggestion.start sem a sugestão ou a origem');
  if (choice === 'worktree' && !origin.isRepo) throw new Error('a sessão que sugeriu não está num repositório: não há onde criar a worktree');
  openForm({ suggestion, origin, choice }).catch(async (e) => {
    mx.log('suggestion.start', String(e.stack || e));
    await mx.request('window.showBanner', { text: `wiboor: ${e.message}` }).catch(() => {});
  });
  return null;
});

process.on('SIGTERM', () => process.exit(0));

mx.start();
