'use strict';

const fs = require('fs');
const { spawn, execFile } = require('child_process');
const os = require('os');
const path = require('path');
const mx = require('./maestria');
const tools = require('./lib/tools');
const { Links, tinted, bare, isOpen } = require('./lib/links');
const { awake, typeInto } = require('./lib/wake');
const { sidebar } = require('./lib/tree');
const { ALL, panel, detail, managerKeys, RESTING, PROMPT, agentsOf, closable } = require('./lib/cards');
const { deliver, flushPending, dropPending, handOver, answeredInTab, copy, PENDING_MS } = require('./lib/answers');
const { replies, cwdOf } = require('./lib/replies');
const doctor = require('./lib/doctor');
const relay = require('./lib/relay');
const history = require('./lib/history');
const closer = require('./lib/closer');
const cleanup = require('./lib/cleanup');

const MANAGER_BRIEF = [
  'Você é um gerente de sessões na Maestria. Divida o trabalho e delegue: abra uma sessão por frente com sessions_open',
  '(cada pedido se sustenta sozinho, a sessão nova não sabe nada desta conversa), acompanhe com sessions_list (mine: true)',
  'e mande instruções com sessions_send. As sessões que você abre ganham a sua cor. Não faça o trabalho pesado você mesmo:',
  'coordene, junte os resultados e reporte. Um cartão só vai para done quando não sobra nada: PR mergeado ou em produção e tarefa fechada; push feito esperando PR ou merge é needs_you. O cartão done fecha a aba da sessão sozinho quando ela para (fica no histórico do painel, com retomar; depois disso você não fala mais com ela, só o usuário a retoma); passe keepOpen: true só quando o usuário ainda precisa da aba. Mandar mais trabalho com sessions_send desarma o fechamento até o próximo done. Uma sessão que terminou sem nada para mostrar você fecha com sessions_close. Quando citar um cartão ou o painel, cole o link maestria:// que o sessions_card devolve, sozinho na linha: clicado, ele abre o cartão. Você recebe um aviso [sessions] só quando uma sessão pede ação (parou de vez, citou um PR novo, deu erro ou o usuário fechou a aba), no máximo um a cada 5 min e já com estado, cartão, resposta e PRs: não abra o transcript para isso. O que não pede ação (o usuário escreveu direto, sessão esperando na aba) vem nos events do próximo sessions_list. Atualize os cartões e reporte ao usuário uma linha por sessão, com o estado real, o que falta e de quem é a vez. Nunca diga que algo está pronto sem ter conferido. O pedido do usuário chega na próxima mensagem.',
].join(' ');

const state = {
  links: new Links(),
  file: null,
  dataDir: null,
  timer: null,
  refreshing: Promise.resolve(),
  current: ALL,
  open: false,
  showing: Promise.resolve(),
  probed: false,
  modal: null,
  live: {},
  ui: { picked: {}, rejecting: {}, clears: {}, open: {}, writing: {}, images: {}, unfolded: {}, showOld: false, history: null, playing: null, focus: null },
  title: undefined,
  doctor: false,
  sent: new relay.Sent(),
  asking: new relay.Asking(),
  permitting: new Map(),
  pre: new Map(),
  lastSessions: [],
  missing: new Map(),
  closeFailed: new Map(),
  cleanup: null,
  flushing: false,
  flushAfter: 0,
  retitled: new Map(),
  tinted: new Map(),
};
const PANEL = 'painel';
const LEGACY_PANEL = 'painel:';
const CARD = 'cartao:';
const IMAGE = 'imagem:';
const DOCTOR = 'diagnostico';
const CLEANUP = 'limpeza';
/** Esta subida do plugin: uma resposta pendente de antes do reinício vai pro gerente, não pra aba. */
const BOOT = `${process.pid}-${Date.now()}`;
const LIBRARY = fs.readFileSync(path.join(__dirname, 'ui', 'panel.rfwtxt'), 'utf8');

/** O que a sessão está fazendo agora, a partir do último PreToolUse. */
function liveLine(payload) {
  const name = (payload && payload.tool_name) || '';
  const input = (payload && payload.tool_input) || {};
  if (input.description) return String(input.description);
  if (input.file_path) return `${name} ${path.basename(String(input.file_path))}`;
  if (name === 'Bash' && input.command) return String(input.command).split('\n')[0].slice(0, 100);
  return name;
}

/** O mx.request, guardando o que o plugin escreve numa aba (e o primeiro prompt de uma sessão que ele abre): isso não é você digitando direto nela. */
async function request(method, params) {
  if (method === 'terminal.sendText' && params && params.tabId) state.sent.note(params.tabId, params.text);
  if (method === 'session.openClaude' && params && params.prompt) state.sent.expect(params.prompt);
  const r = await mx.request(method, params);
  if (method === 'session.openClaude' && params && params.prompt && r && r.tabId) state.sent.claim(r.tabId, params.prompt);
  return r;
}

const withLive = (sessions) =>
  sessions.map((s) => (state.live[s.id] ? { ...s, activity: { ...(s.activity || {}), lastTool: state.live[s.id] } } : s));
const readReply = replies(os.homedir());

/** Junta a última resposta do Claude às conversas paradas (o cartão compara com ela, e a visão de todas a mostra). */
function withReplies(sessions) {
  return sessions.map((s) => (s.kind === 'claude' && s.sessionId && !s.needsYou && (RESTING.has(s.status) || s.hibernated) ? { ...s, reply: readReply(s.sessionId, s.cwd) } : s));
}

const listSessions = async () => withReplies(withLive((await mx.request('sessions.list')) || []));

/** Como o plugin acorda uma aba hibernada antes de digitar nela: avisa com um banner e relê as abas até ela ficar pronta. */
const wakeIo = {
  request,
  list: () => mx.request('sessions.list'),
  notice: (s) => mx.request('window.showBanner', { text: `acordando ${bare(s.title)}; a mensagem vai quando ela estiver pronta` }).catch(() => {}),
};

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function writeLinks() {
  if (!state.file) return;
  const tmp = `${state.file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(state.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state.links.toJSON()));
    fs.renameSync(tmp, state.file);
  } catch (e) {
    mx.log('não salvou os vínculos:', e.message);
  }
}

function save() {
  writeLinks();
  schedule();
}

/** Lê os vínculos; um arquivo estragado fica guardado ao lado e a cópia da última subida assume. */
function load() {
  const bak = `${state.file}.bak`;
  try {
    state.links = new Links(JSON.parse(fs.readFileSync(state.file, 'utf8')));
    fs.copyFileSync(state.file, bak);
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      mx.log('links.json ilegível, usando a cópia:', e.message);
      try {
        fs.renameSync(state.file, `${state.file}.estragado-${Date.now()}`);
      } catch {}
    }
  }
  try {
    state.links = new Links(JSON.parse(fs.readFileSync(bak, 'utf8')));
  } catch {
    state.links = new Links();
  }
}

/** Manda a cada aba só o conserto que ainda não foi pedido ([value] diz qual); quem já está certo sai de [memo]. */
function sendOnce(memo, wrong, value, send) {
  for (const tabId of [...memo.keys()]) if (!wrong.some((w) => w.tabId === tabId)) memo.delete(tabId);
  const fresh = wrong.filter((w) => memo.get(w.tabId) !== value(w));
  for (const w of fresh) memo.set(w.tabId, value(w));
  return Promise.all(fresh.map(send));
}

/** Uma aba que sumiu só entra no histórico se continuar sumida na leitura seguinte: lista falha ou a Maestria saindo não contam. */
const CONFIRM_MS = 2000;
function closedByYou(sessions) {
  const ids = new Set(sessions.map((s) => s.id));
  const confirmed = [...state.missing.values()].filter((s) => !ids.has(s.id));
  state.missing = new Map(history.vanished(state.links, state.lastSessions, sessions).map((s) => [s.id, s]));
  if (state.missing.size) setTimeout(schedule, CONFIRM_MS);
  for (const s of confirmed) {
    const key = state.links.byTab(s.id);
    history.record(state.links, { key, session: { ...s, reply: s.reply || (s.sessionId ? readReply(s.sessionId, s.cwd) : null) }, by: 'você, na aba' });
    if (key) relay.queue(state.links, key, { kind: 'closed' });
  }
  return confirmed;
}

/** Fecha as abas dos cartões feitos que já pararam; uma notificação só por rodada. Uma aba que não fechou espera um tempo e avisa. */
const RETRY_MS = 10 * 60 * 1000;
async function closeDone(sessions) {
  const closed = [];
  const now = Date.now();
  for (const { key, session, by } of closer.due(state.links, sessions)) {
    if (now - (state.closeFailed.get(session.id) || 0) < RETRY_MS) continue;
    const h = history.record(state.links, { key, session: { ...session, reply: session.reply || (session.sessionId ? readReply(session.sessionId, session.cwd) : null) }, by });
    try {
      await mx.request('session.close', { tabId: session.id });
    } catch (e) {
      history.forget(state.links, h.id);
      const n = state.links.nodes[key];
      if (n && n.card && n.card.state === 'done') n.card = { ...n.card, closeFor: session.sessionId };
      state.closeFailed.set(session.id, now);
      mx.request('window.showBanner', { text: `sessions: não fechou ${h.name} (${e.message}); tento de novo em 10 min` }).catch(() => {});
      continue;
    }
    relay.forget(state.links, key);
    closed.push({ name: h.name, what: history.whatOf(h) });
  }
  if (closed.length) await mx.request('window.notify', closer.notice(closed)).catch(() => mx.request('window.showBanner', { text: closer.notice(closed).title }).catch(() => {}));
  return closed.length > 0;
}

/** As abas paradas há mais de [idle], com a última resposta e a hora em que a conversa mexeu por último. */
function parkedOf(sessions, idle = cleanup.DEFAULT_IDLE) {
  const withReply = sessions.map((s) => (cleanup.parked(s) && !s.reply && s.sessionId ? { ...s, reply: readReply(s.sessionId, s.cwd) } : s));
  return cleanup.candidates(state.links, withReply, { idle, touched: (s) => readReply.touched(s.sessionId, s.cwd) });
}

const cleanupData = () => cleanup.view(state.cleanup.list, state.cleanup.picked, state.cleanup.idle);

/** Abre "Fechar abas paradas" com as de 1 dia e os grupos padrão marcados. */
async function openCleanup() {
  const list = parkedOf(await listSessions());
  state.cleanup = { idle: cleanup.DEFAULT_IDLE, list, picked: cleanup.defaults(list) };
  return mx.request('view.open', { viewId: CLEANUP, title: 'fechar abas paradas', modal: true, width: 760, height: 640, rfw: { library: LIBRARY, root: 'cleanup' }, data: cleanupData() });
}

async function onCleanup(verb, arg) {
  const c = state.cleanup;
  if (!c) return null;
  if (verb === 'cancel') {
    state.cleanup = null;
    return mx.request('view.close', { viewId: CLEANUP }).catch(() => {});
  }
  if (verb === 'idle') {
    c.idle = arg;
    const list = parkedOf(await listSessions(), arg);
    if (state.cleanup !== c || c.idle !== arg) return null;
    c.list = list;
    c.picked = cleanup.defaults(c.list);
  } else if (verb === 'pick') {
    if (!c.list.some((x) => x.tabId === arg)) return null;
    if (c.picked.has(arg)) c.picked.delete(arg);
    else c.picked.add(arg);
  } else if (verb === 'group') {
    const ids = c.list.filter((x) => x.group === arg).map((x) => x.tabId);
    const all = ids.every((id) => c.picked.has(id));
    for (const id of ids) all ? c.picked.delete(id) : c.picked.add(id);
  } else if (verb === 'run') return runCleanup();
  return mx.request('view.update', { viewId: CLEANUP, data: cleanupData() }).catch(() => {});
}

/** Fecha as marcadas que continuam paradas e no grupo que você viu, cada uma para o histórico, e conta numa linha. */
async function runCleanup() {
  const { picked, idle, list: seen } = state.cleanup;
  state.cleanup = null;
  await mx.request('view.close', { viewId: CLEANUP }).catch(() => {});
  const sessions = await listSessions();
  const groupSeen = new Map(seen.map((x) => [x.tabId, x.group]));
  const still = new Set(parkedOf(sessions, idle).filter((x) => picked.has(x.tabId) && groupSeen.get(x.tabId) === x.group).map((x) => x.tabId));
  let closed = 0;
  let failed = 0;
  for (const s of sessions.filter((x) => still.has(x.id))) {
    const key = state.links.byTab(s.id);
    const was = key && state.links.nodes[key].card;
    const reply = s.reply || readReply(s.sessionId, s.cwd);
    const h = history.record(state.links, { key, session: { ...s, reply }, by: 'você, na limpeza' });
    try {
      await mx.request('session.close', { tabId: s.id });
      if (key) relay.queue(state.links, key, { kind: 'closed', text: 'na limpeza' });
      closed++;
    } catch (e) {
      history.forget(state.links, h.id);
      const n = key && state.links.nodes[key];
      if (n && was && was.closeFor && n.card) n.card = { ...n.card, closeFor: was.closeFor };
      failed++;
      mx.log('limpeza não fechou', s.id, e.message);
    }
  }
  save();
  const skipped = picked.size - still.size;
  const text = !closed && !failed
    ? 'nada foi fechado: as marcadas acordaram, mudaram ou já fecharam'
    : `${closed} ${closed === 1 ? 'aba fechada e guardada' : 'abas fechadas e guardadas'} no histórico${failed ? `; ${failed} não fecharam` : ''}${skipped ? `; ${skipped} mudaram e ficaram` : ''}`;
  return mx.request('window.showBanner', { text }).catch(() => {});
}

/** Entrega as respostas guardadas fora do refresh (acordar uma aba leva até 1 min); uma rodada por vez, e espera 2 min depois de um erro. */
const PENDING_RETRY_MS = 2 * 60 * 1000;
function deliverPending(sessions) {
  if (state.flushing || Date.now() < state.flushAfter) return;
  if (!Object.values(state.links.nodes).some((n) => n.pending && n.pending.length)) return;
  state.flushing = true;
  const closed = (tabId) => state.links.history.some((h) => h.tabId === tabId);
  flushPending({ ...wakeIo, links: state.links, sessions, boot: BOOT, closed })
    .then(async (out) => {
      if (!out.length) return;
      save();
      for (const f of out) {
        const text =
          f.via === 'terminal' ? `resposta guardada enviada para ${f.title}`
          : f.via === 'manager' ? `resposta guardada de ${f.title} enviada para o gerente`
          : `resposta guardada de ${f.title} descartada: nem a aba nem o gerente podem receber; responda na aba`;
        await mx.request('window.showBanner', { text }).catch(() => {});
      }
    })
    .catch((e) => {
      state.flushAfter = Date.now() + PENDING_RETRY_MS;
      mx.log('respostas guardadas:', e.message);
    })
    .finally(() => {
      state.flushing = false;
    });
}

async function refresh() {
  const sessions = await listSessions();
  const gone = closedByYou(sessions);
  state.lastSessions = sessions;
  state.ui.parked = cleanup.candidates(state.links, sessions, { touched: (s) => readReply.touched(s.sessionId, s.cwd) }).length;
  const settled = settleTurns(sessions);
  const reconciled = state.links.reconcile(sessions);
  const migrated = closer.migrate(state.links, sessions);
  const auto = await closeDone(sessions);
  deliverPending(sessions);
  if (reconciled || migrated || gone.length || settled || auto) writeLinks();
  await flushRelays(sessions);
  await sendOnce(state.retitled, state.links.retitles(sessions), (w) => w.title, ({ tabId, title }) =>
    mx.request('session.rename', { tabId, title }).catch((e) => mx.log('rename:', e.message)),
  );
  await sendOnce(state.tinted, state.links.tints(sessions), (w) => w.tint, ({ tabId, tint }) =>
    mx.request('session.tint', { tabId, tint }).catch((e) => mx.log('tint:', e.message)),
  );
  await mx.request('sidebar.update', sidebar(state.links, sessions, state.ui));
  if (!state.probed) {
    state.probed = true;
    await adopt(sessions);
  }
  if (state.current !== ALL && !managerKeys(state.links).includes(state.current)) state.current = ALL;
  const liveTabs = new Set(sessions.filter(isOpen).map((s) => `@${s.id}`));
  for (const bag of [state.ui.writing, state.ui.clears]) for (const k of Object.keys(bag)) if (k.startsWith('@') && !liveTabs.has(k)) delete bag[k];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const k of Object.keys(state.ui.images)) {
    const s = byId.get(k.startsWith('@') ? k.slice(1) : state.links.nodes[k] && state.links.nodes[k].tabId);
    if (!s || !isOpen(s) || s.hibernated || !RESTING.has(s.status)) delete state.ui.images[k];
  }
  if (state.open) {
    const r = await mx.request('view.update', panelUpdate(sessions)).catch(() => ({ open: false }));
    if (!r || r.open === false) {
      state.open = false;
      state.title = undefined;
    }
  }
  if (state.doctor) {
    const r = await mx.request('view.update', { viewId: DOCTOR, data: doctorData(sessions) }).catch(() => ({ open: false }));
    if (!r || r.open === false) state.doctor = false;
  }
  if (state.modal) {
    const d = detail(state.links, state.modal, sessions, state.ui);
    const r = d ? await mx.request('view.update', { viewId: CARD + state.modal, data: d }).catch(() => ({ open: false })) : { open: false };
    if (!r || r.open === false) state.modal = null;
  }
}

/** O template só vai na primeira vez por processo: reenviá-lo reconstrói a janela e zera a rolagem. */
function panelOf(sessions) {
  const p = panel(state.links, state.current, sessions, LIBRARY, state.ui);
  p.data.history = history.view(state.links, state.current, state.ui.history);
  return p;
}

function panelUpdate(sessions) {
  const p = panelOf(sessions);
  const was = state.title;
  state.title = p.title;
  if (was === undefined) return { viewId: PANEL, ...p };
  return { viewId: PANEL, data: p.data, ...(p.title !== was ? { title: p.title } : {}) };
}

/** Na subida: o painel único que ficou aberto continua; na primeira vez, os de antes (um por gerente) viram ele. */
async function adopt(sessions) {
  const keys = managerKeys(state.links);
  if (state.current !== ALL && !keys.includes(state.current)) state.current = ALL;
  const r = await mx.request('view.update', panelUpdate(sessions)).catch(() => ({ open: false }));
  state.open = Boolean(r && r.open !== false);
  if (!state.open) state.title = undefined;
  const mark = state.dataDir && path.join(state.dataDir, 'painel-unico');
  if (!mark || fs.existsSync(mark)) return;
  try {
    fs.writeFileSync(mark, '');
  } catch {}
  for (const key of [state.current, ...keys.filter((k) => k !== state.current)].filter((k) => k && k !== ALL)) {
    const p = panel(state.links, key, sessions, LIBRARY, state.ui);
    const r = await mx.request('view.update', { viewId: LEGACY_PANEL + key, ...p }).catch(() => ({ open: false }));
    if (!r || r.open === false) continue;
    await mx.request('view.close', { viewId: LEGACY_PANEL + key }).catch(() => {});
    if (!state.open) await showPanel(key, 'raise');
  }
}

/**
 * Mostra o gerente [key] no painel único. [how]: 'card' (um cartão novo: não tira o painel de quem você olha),
 * 'switch' (um chip do painel: troca no lugar) ou 'raise' (a lateral: troca e traz o painel pra frente).
 */
function showPanel(key, how = 'card') {
  const run = state.showing.then(() => showPanelNow(key, how));
  state.showing = run.catch(() => {});
  return run;
}

async function showPanelNow(key, how) {
  if (key !== ALL && !state.links.nodes[key]) return null;
  const sessions = await listSessions();
  if (state.open) {
    if (how !== 'card') state.current = key;
    const r = await mx.request('view.update', panelUpdate(sessions)).catch(() => ({ open: false }));
    if (r && r.open !== false && how !== 'raise') return null;
    if (!r || r.open === false) state.open = false;
  }
  if (state.open && how === 'card') return null;
  if (how !== 'card') state.current = key;
  else if (state.current !== key) state.current = ALL;
  state.open = true;
  const p = panelOf(sessions);
  state.title = p.title;
  await mx.request('view.open', { viewId: PANEL, ...p }).catch((e) => {
    state.open = false;
    state.title = undefined;
    throw e;
  });
  return null;
}

/** Um refresh por vez: um mais velho que terminasse por último mostraria a lista de antes. */
/** A sugestão do Claude Code aparece um pouco depois do fim do turno, sem evento: o painel olha de novo nesses tempos. */
const SUGGESTION_WAIT = [1500, 4000];

function schedule() {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.refreshing = state.refreshing.then(refresh).catch((e) => mx.log('lateral:', e.message));
  }, 300);
}

const OTHER = ':outra-pasta';

/** Pede um caminho até ser uma pasta que existe; null se cancelar. */
async function askFolder() {
  let value = '';
  for (;;) {
    const typed = await mx.request('window.input', { title: 'novo gerente: caminho da pasta', placeholder: '~/projetos/x ou /var/www/x', value });
    value = String(typed || '').trim();
    if (!value) return null;
    const dir = path.resolve(os.homedir(), value.replace(/^~(?=$|\/)/, os.homedir()));
    if (isDir(dir)) return dir;
    await mx.request('window.showBanner', { text: `não é uma pasta: ${dir}` }).catch(() => {});
  }
}

async function createManager(context = {}) {
  const folders = (await mx.request('folders.list').catch(() => [])) || [];
  const items = folders.map((f) => ({ value: f.root, label: f.name || path.basename(f.root), detail: f.root }));
  if (context.cwd && !items.some((i) => i.value === context.cwd)) items.unshift({ value: context.cwd, label: path.basename(context.cwd), detail: context.cwd });
  items.push({ value: OTHER, label: 'outra pasta…', detail: 'digitar o caminho' });
  const picked = await mx.request('window.pick', { title: 'novo gerente: pasta', items });
  const cwd = picked === OTHER ? await askFolder() : picked;
  if (!cwd) return;
  const name = await mx.request('window.input', { title: 'novo gerente: nome', placeholder: 'ex.: tarefas do Wiboor' });
  if (!name) return;
  const key = state.links.add({ tabId: null, name, manager: true });
  const node = state.links.nodes[key];
  const params = { cwd, label: tinted(name, node.color, true), prompt: MANAGER_BRIEF };
  try {
    const { tabId } = await mx.request('session.openClaude', params);
    node.tabId = tabId;
    state.ui.focus = key;
    save();
  } catch (e) {
    delete state.links.nodes[key];
    await mx.request('window.showBanner', { text: `sessions: não abriu o gerente: ${e.message}` }).catch(() => {});
    return;
  }
  await showPanel(key, 'raise').catch((e) => mx.log('painel:', e.message));
}

const exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout) => resolve({ code: err ? (Number.isInteger(err.code) ? err.code : 1) : 0, stdout: String(stdout || '') }));
  });

const prsOf = (s) => {
  const r = s && s.sessionId ? readReply(s.sessionId, s.cwd) : null;
  return ((r && r.links) || []).map((l) => l.url);
};

const ctx = ({ tabId, cwd }) => ({
  request,
  exec,
  prsOf,
  replyOf: (s) => (s && s.sessionId ? readReply(s.sessionId, s.cwd) : null),
  home: os.homedir(),
  cwd,
  tabId,
  isDir,
  dataDir: state.dataDir,
  links: state.links,
  save,
  showPanel,
  log: (...a) => mx.log(...a),
});

mx.onRequest('initialize', (params) => {
  state.dataDir = params.dataDir || null;
  state.file = path.join(state.dataDir || path.join(os.homedir(), '.maestria-rs', 'plugin-data', 'maestria.sessions'), 'links.json');
  load();
  return {};
});

mx.onRequest('tool.call', ({ tool, args, tabId, cwd }) => tools.handle(tool, args, ctx({ tabId, cwd })));

mx.onRequest('command.invoke', ({ command, context }) => {
  if (command === 'gerente') createManager(context).catch((e) => mx.log('gerente:', e.message));
  return null;
});

/** SessionEnd por sinal (aba fechada, queda) não encerra o turno: é o que mostra que a sessão parou no meio. */
const CLEAN_END = new Set(['clear', 'resume', 'logout', 'prompt_input_exit']);
/** Ferramenta rodando é turno rodando: volta o busy que o settle tirou (o auto-compact põe a aba em "ready" no meio do turno). */
const IN_TURN = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
const turnEnded = (name, p) =>
  name === 'Stop' || name === 'StopFailure' || (name === 'PostToolUseFailure' && Boolean(p.is_interrupt)) || (name === 'SessionEnd' && CLEAN_END.has(p.reason));

function setBusy(node, busy) {
  if (Boolean(node.busy) === busy) return false;
  node.busy = busy;
  if (node.card) node.card = { ...node.card, busy };
  return true;
}

/** Esc no meio do pensamento não manda hook: a aba vista parada um tempo depois do último pedido não está mais no turno. */
const BUSY_GRACE = 30 * 1000;
function settleTurns(sessions, now = Date.now()) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let changed = false;
  for (const n of Object.values(state.links.nodes)) {
    const s = n.busy && byId.get(n.tabId);
    if (s && isOpen(s) && !s.hibernated && s.status === 'idle' && now - (n.busyAt || 0) > BUSY_GRACE && setBusy(n, false)) changed = true;
  }
  return changed;
}

/**
 * O turno da sessão pelos hooks: [node.busy] (gravado, sobrevive ao restart) diz se ela estava no meio de um turno quando a aba sumiu,
 * e a pergunta ou a permissão respondida na aba passa a vez na hora. A permissão vale só pra ferramenta que a pediu ([tool_use_id]).
 */
function trackTurn(node, name, tabId, p) {
  let changed = false;
  const busy = IN_TURN.has(name) ? true : turnEnded(name, p) ? false : null;
  if (busy) node.busyAt = Date.now();
  if (busy !== null && setBusy(node, busy)) changed = true;
  const id = p.tool_use_id;
  if (name === 'PreToolUse') state.pre.set(tabId, { id, done: false });
  if ((name === 'PostToolUse' || name === 'PostToolUseFailure') && state.pre.get(tabId) && state.pre.get(tabId).id === id) state.pre.get(tabId).done = true;
  if (name === 'Notification' && p.notification_type === 'permission_prompt') {
    const pre = state.pre.get(tabId);
    if (pre && !pre.done && pre.id) state.permitting.set(tabId, pre.id);
  }
  const permitted = name === 'PostToolUse' && id && state.permitting.get(tabId) === id;
  if (permitted || ((name === 'PostToolUseFailure' || name === 'PostToolUse') && state.permitting.get(tabId) === id) || busy !== null) state.permitting.delete(tabId);
  if (name === 'PostToolUse' && (p.tool_name === 'AskUserQuestion' || permitted) && answeredInTab(node, Date.now())) changed = true;
  return changed;
}

/** Um hook de uma sessão com gerente vira evento na fila dele: turno terminado, esperando você, ou o que você digitou direto nela. */
function relayHook(name, tabId, payload) {
  const key = state.links.byTab(tabId);
  if (!key || !state.links.nodes[key].parent) return;
  const p = payload || {};
  const node = state.links.nodes[key];
  if (trackTurn(node, name, tabId, p)) writeLinks();
  let event = null;
  if (name === 'UserPromptSubmit') {
    const text = relay.fromUser(state.sent, tabId, p.prompt);
    if (text) dropPending(state.links.nodes[key]);
    if (text && state.links.nodes[key].card) {
      handOver(state.links.nodes[key], text, Date.now(), true);
      writeLinks();
    }
    if (text) event = { kind: 'direct', text };
  } else if (name === 'Stop') event = { kind: 'turn' };
  else if (name === 'StopFailure') event = { kind: 'error', text: String(p.error || p.message || '') };
  else if (name === 'Notification' && !/waiting for your input/i.test(String(p.message || ''))) event = { kind: 'waiting', text: String(p.message || '') };
  if (!event || !relay.queue(state.links, key, event)) return;
  writeLinks();
  setTimeout(schedule, relay.limits.quiet + 500);
}

/** Manda a fila de cada gerente que pode receber agora (parado, sem foco, sem pergunta). */
async function flushRelays(sessions) {
  const now = Date.now();
  for (const node of Object.values(state.links.nodes)) {
    const manager = sessions.find((s) => s.id === node.tabId);
    if (!relay.due(node, manager, now, state.asking.has(node.tabId))) continue;
    const { wake, keep, passive, waiting } = relay.sort(state.links, node.events, sessions, now);
    if (!wake.length) {
      if (keep.length !== node.events.length) {
        node.events = keep;
        writeLinks();
      }
      continue;
    }
    node.events = keep;
    node.relayedAt = now;
    try {
      await request('terminal.sendText', { tabId: manager.id, text: relay.digest(state.links, wake, sessions, now, passive, waiting), submit: true });
      relay.markSeen(state.links, wake, sessions);
    } catch (e) {
      mx.log('aviso ao gerente:', e.message);
      node.events = [...wake, ...(node.events || [])];
      node.relayedAt = 0;
    }
    writeLinks();
  }
}

mx.onNotification('event', ({ type, tabId, name, payload }) => {
  if (type === 'hook' && tabId) {
    if (name === 'PreToolUse') state.live[tabId] = liveLine(payload);
    else if (name === 'Stop' || name === 'SessionEnd') delete state.live[tabId];
    if (name === 'Stop') for (const ms of SUGGESTION_WAIT) setTimeout(schedule, ms);
    state.asking.hook(tabId, name, payload);
    relayHook(name, tabId, payload);
  }
  if (type === 'sidebar.shown' || type === 'hook' || String(type).startsWith('session.')) schedule();
});

const findings = (sessions) => doctor.diagnose(state.links, sessions, { dataDir: state.dataDir });
const doctorData = (sessions) => doctor.report(findings(sessions), state.links, sessions);

async function openDoctor() {
  const sessions = await listSessions();
  state.doctor = true;
  return mx.request('view.open', { viewId: DOCTOR, title: 'diagnóstico das sessões', modal: true, width: 760, height: 560, rfw: { library: LIBRARY, root: 'doctor' }, data: doctorData(sessions) });
}

/** "Arrumar tudo": só o que o diagnóstico marca como seguro (esquecer fechadas sem cartão, apagar arquivos soltos). */
async function fixAll() {
  for (const f of findings(await listSessions()).filter((x) => x.auto)) await onAction(f.fix);
  return schedule();
}

async function openCard(key) {
  const d = detail(state.links, key, await listSessions(), state.ui);
  if (!d) return null;
  state.modal = key;
  return mx.request('view.open', { viewId: CARD + key, title: d.title, modal: true, width: 980, height: 720, rfw: { library: LIBRARY, root: 'detail' }, data: d });
}

function stopAudio() {
  const p = state.ui.playing;
  state.ui.playing = null;
  if (p && p.proc) p.proc.kill();
}

/** Toca (ou para) um áudio do cartão: as opções de uma pergunta ou os áudios da prova. */
function toggleAudio(key, kind, i) {
  const id = `${kind}:${i}`;
  const was = state.ui.playing;
  stopAudio();
  if (was && was.key === key && was.id === id) return schedule();
  const card = state.links.nodes[key] && state.links.nodes[key].card;
  const file = kind === 'opt' ? card && card.action && card.action.options[i] && card.action.options[i].audio : card && card.proof && card.proof.audio[i] && card.proof.audio[i].path;
  if (!file) return null;
  const [cmd, args] = process.platform === 'darwin' ? ['afplay', [file]] : ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]];
  const proc = spawn(cmd, args, { stdio: 'ignore' });
  const playing = { key, id, proc };
  const done = () => {
    if (state.ui.playing === playing) {
      state.ui.playing = null;
      schedule();
    }
  };
  proc.on('exit', done);
  proc.on('error', (e) => {
    done();
    mx.request('window.showBanner', { text: `sessions: não tocou o áudio (${cmd}: ${e.message})` }).catch(() => {});
  });
  state.ui.playing = playing;
  return schedule();
}

async function answer(key, text, message = false) {
  stopAudio();
  const { via, title } = await deliver(key, text, { ...wakeIo, links: state.links, sessions: await listSessions(), message, boot: BOOT });
  delete state.ui.picked[key];
  delete state.ui.rejecting[key];
  delete state.ui.writing[key];
  if (via === 'terminal') delete state.ui.images[key];
  state.ui.clears[key] = (state.ui.clears[key] || 0) + 1;
  save();
  if (via === 'pending') {
    schedule();
    setTimeout(schedule, PENDING_MS + 1000).unref();
    return mx.request('window.showBanner', { text: `resposta guardada: vai para ${title} quando ela sair do prompt` }).catch(() => {});
  }
  const where = via === 'terminal' ? title : 'o gerente (a aba fechou)';
  return mx.request('window.showBanner', { text: `enviado para ${where}` }).catch(() => {});
}

/** Tira o cartão [key] de "esperam você"/"rodando agora": vai para "terminaram hoje", até o gerente postar outro. */
function dismiss(key) {
  const node = state.links.nodes[key];
  if (!node || !node.card) return null;
  const now = Date.now();
  node.card = { ...node.card, state: 'done', dismissed: true, action: null, answered: null, headline: 'Dispensado por você.', at: now, doneAt: now };
  dropPending(node);
  delete state.ui.writing[key];
  delete state.ui.rejecting[key];
  save();
  return schedule();
}

/** Reabre a conversa de um nó cuja aba fechou (com --resume), na pasta e com o nome dele; se a aba está aberta, vai pra ela. */
async function resume(key) {
  const n = state.links.nodes[key];
  if (!n) return null;
  const open = (await listSessions()).find((s) => s.id === n.tabId && isOpen(s));
  if (open) return mx.request('session.focus', { tabId: open.id });
  closer.disarm(state.links, key);
  const r = await reopenConversation(n);
  n.tabId = r.tabId;
  n.cwd = r.cwd;
  save();
  return null;
}

/** Abre de novo a conversa [sessionId] (com --resume) numa aba nova, na pasta e com o nome dela. */
async function reopenConversation({ name, color, manager, sessionId, cwd: was }) {
  if (!sessionId) throw new Error(`não sei qual conversa era "${name}": ela nunca reportou o sessionId`);
  const cwd = (was && isDir(was) && was) || cwdOf(os.homedir(), sessionId);
  if (!cwd || !isDir(cwd)) throw new Error(`não achei a pasta da conversa "${name}"`);
  const label = color ? tinted(name, color, manager) : name;
  const r = await mx.request('session.openClaude', { cwd, label, resume: sessionId });
  if (!r || !r.resumed) {
    if (r && r.tabId) await mx.request('session.close', { tabId: r.tabId }).catch(() => {});
    throw new Error('esta Maestria ainda não retoma conversas por plugin; atualize a Maestria');
  }
  return { tabId: r.tabId, cwd };
}

/** Retomar uma linha do histórico: pelo nó, se ele ainda é dessa conversa; senão, uma aba solta. */
async function reopen(id) {
  const h = state.links.history.find((x) => x.id === id);
  if (!h) return null;
  const n = h.key && state.links.nodes[h.key];
  if (n && n.sessionId === h.sessionId) return resume(h.key);
  const open = (await listSessions()).find((s) => s.sessionId === h.sessionId && isOpen(s));
  if (open) return mx.request('session.focus', { tabId: open.id });
  await reopenConversation({ ...h, color: null });
  return null;
}

/** "Fechar a aba" num cartão feito: guarda no histórico e fecha. */
async function closeTab(key) {
  const tabId = key.startsWith('@') ? key.slice(1) : state.links.nodes[key] && state.links.nodes[key].tabId;
  const s = tabId && (await listSessions()).find((x) => x.id === tabId && isOpen(x));
  if (!s) return null;
  if (!closable(s)) throw new Error(`"${bare(s.title)}" está ${agentsOf(s) ? 'com agentes rodando em segundo plano' : s.statusLabel || s.status}; espere o turno acabar`);
  const h = history.record(state.links, { key: state.links.byTab(s.id), session: { ...s, reply: s.reply || readReply(s.sessionId, s.cwd) }, by: 'você, no painel' });
  try {
    await mx.request('session.close', { tabId: s.id });
  } catch (e) {
    history.forget(state.links, h.id);
    throw e;
  }
  if (h.key) relay.queue(state.links, h.key, { kind: 'closed', text: 'no painel' });
  save();
  return mx.request('window.showBanner', { text: `fechada e guardada no histórico: ${h.name}` }).catch(() => {});
}

/** Manda [text] direto pro gerente do painel [key]. */
async function tell(key, text) {
  const body = String(text || '').trim();
  const node = state.links.nodes[key];
  if (!body || !node) return null;
  const m = (await listSessions()).find((s) => s.id === node.tabId && isOpen(s));
  if (!m) throw new Error('a aba do gerente está fechada');
  await typeInto(wakeIo, m, body);
  if (state.ui.focus === key) delete state.ui.focus;
  const clear = `tell-${key}`;
  state.ui.clears[clear] = (state.ui.clears[clear] || 0) + 1;
  schedule();
  return mx.request('window.showBanner', { text: `enviado para ${bare(m.title)}` }).catch(() => {});
}

/** A aba que recebe o que se escreve no cartão [key]: a da sessão, ou a conversa solta "@<tabId>". */
async function tabOfCard(key) {
  const node = state.links.nodes[key];
  const id = String(key).startsWith('@') ? key.slice(1) : node && node.tabId;
  const s = id && ((await mx.request('sessions.list')) || []).find((x) => x.id === id && isOpen(x));
  if (!s) throw new Error('essa aba fechou');
  return s;
}

/** A aba do cartão [key] acordada e fora de pergunta: pronta pra receber o que vem do cartão. */
async function readyTabOf(key) {
  const s = await awake(wakeIo, await tabOfCard(key));
  if (PROMPT.has(s.status)) throw new Error(`"${bare(s.title)}" está esperando você na aba: responda lá`);
  return s;
}

/** Cola na aba do cartão [key] a imagem da área de transferência: ela fica no prompt da aba até a mensagem ir. */
async function pasteImage(key) {
  const s = await readyTabOf(key);
  await request('terminal.pasteClipboard', { tabId: s.id });
  state.ui.images[key] = (state.ui.images[key] || 0) + 1;
  return schedule();
}

/** Só as imagens coladas, sem texto: manda o prompt da aba como está. */
async function sendImages(key) {
  const s = await readyTabOf(key);
  await request('terminal.sendText', { tabId: s.id, text: '', submit: true });
  const node = state.links.nodes[key];
  const parent = node && state.links.node(node.parent);
  if (parent) {
    const n = state.ui.images[key];
    const text = `[${n} ${n === 1 ? 'imagem' : 'imagens'}]`;
    const now = Date.now();
    handOver(node, text, now, true);
    copy(parent, s.id, bare(s.title), text, now);
  }
  delete state.ui.images[key];
  delete state.ui.writing[key];
  state.ui.clears[key] = (state.ui.clears[key] || 0) + 1;
  return save();
}

/** Manda a sugestão que o Claude Code mostra no prompt da aba do cartão [key], como se você a tivesse escrito. */
async function useSuggestion(key) {
  const s = await tabOfCard(key);
  if (!s.promptSuggestion) return null;
  if (PROMPT.has(s.status)) throw new Error(`"${bare(s.title)}" está esperando você na aba: responda lá`);
  return String(key).startsWith('@') ? onFree('message', key, { text: s.promptSuggestion }) : answer(key, s.promptSuggestion, true);
}

/** Uma conversa sem gerente (cartão "@<tabId>" na visão de todas): só abre a caixa e manda mensagem. */
async function onFree(verb, key, values) {
  if (verb === 'write') {
    state.ui.writing[key] = !state.ui.writing[key];
    return schedule();
  }
  if (verb === 'paste') return pasteImage(key);
  if (verb === 'suggest') return useSuggestion(key);
  if (verb !== 'message') return null;
  const body = String((values && values.text) || '').trim();
  if (!body) return state.ui.images[key] ? sendImages(key) : null;
  const s = await tabOfCard(key);
  await typeInto(wakeIo, s, body);
  delete state.ui.writing[key];
  delete state.ui.images[key];
  state.ui.clears[key] = (state.ui.clears[key] || 0) + 1;
  schedule();
  return mx.request('window.showBanner', { text: `enviado para ${bare(s.title)}` }).catch(() => {});
}

/** As ações de um cartão; [values] traz o texto de um campo. */
async function onCard(verb, key, rest, values) {
  if (String(key).startsWith('@')) return onFree(verb, key, values);
  const node = state.links.nodes[key];
  const card = node && node.card;
  const action = card && card.action;
  const flip = (bag) => {
    bag[key] = !bag[key];
    return schedule();
  };
  if (verb === 'detail') return openCard(key);
  if (verb === 'notes') return flip(state.ui.open);
  if (verb === 'dismiss') return dismiss(key);
  if (verb === 'reject') return flip(state.ui.rejecting);
  if (verb === 'write') return flip(state.ui.writing);
  if (verb === 'tell') return tell(key, values && values.text);
  if (verb === 'play') return toggleAudio(key, rest[0], Number(rest[1]));
  if (verb === 'pick') {
    state.ui.picked[key] = Number(rest[0]);
    return schedule();
  }
  if (verb === 'paste') return pasteImage(key);
  if (verb === 'suggest') return useSuggestion(key);
  if (verb === 'message') {
    const text = String((values && values.text) || '').trim();
    if (!text) return state.ui.images[key] ? sendImages(key) : null;
    return answer(key, text, true);
  }
  if (verb === 'answer') {
    const text = String((values && values.text) || '').trim();
    if (!text) return null;
    return answer(key, state.ui.rejecting[key] ? `Rejeitado: ${text}` : text);
  }
  if (!action) return null;
  if (verb === 'send' && action.kind === 'command' && action.tabId) {
    await request('terminal.sendText', { tabId: action.tabId, text: action.text, submit: false });
    return mx.request('session.focus', { tabId: action.tabId });
  }
  if (verb === 'copy') {
    await mx.request('clipboard.write', { text: action.text });
    return mx.request('window.showBanner', { text: 'comando copiado' }).catch(() => {});
  }
  if (verb === 'browse' && action.kind === 'command') return mx.request('window.openUrl', { url: action.text.trim() });
  const option = (i) => action.options[i] && `${action.options[i].key}: ${action.options[i].label}`;
  if (verb === 'option') return option(Number(rest[0])) ? answer(key, option(Number(rest[0]))) : null;
  if (verb === 'use') return state.ui.picked[key] != null && option(state.ui.picked[key]) ? answer(key, option(state.ui.picked[key])) : null;
  if (verb === 'approve') return answer(key, 'Aprovado.');
  return null;
}

/** Um PR achado no transcript da sessão [tabId]. */
async function openFound(tabId, i) {
  const s = (await listSessions()).find((x) => x.id === tabId);
  const link = s && s.reply && s.reply.links && s.reply.links[i];
  return link ? mx.request('window.openUrl', { url: link.url }) : null;
}

async function onProof(verb, key, i) {
  const card = state.links.nodes[key] && state.links.nodes[key].card;
  const proof = card && card.proof;
  if (!proof) return null;
  if (verb === 'pr' && proof.prs[i]) return mx.request('window.openUrl', { url: proof.prs[i].url });
  if (verb === 'image' && proof.images[i]) {
    const view = { viewId: IMAGE + key, title: path.basename(proof.images[i].path), data: imageData(key, proof.images, i) };
    const shown = await mx.request('view.update', view).catch(() => ({ open: false }));
    if (shown && shown.open !== false) return shown;
    return mx.request('view.open', { ...view, modal: true, rfw: { library: LIBRARY, root: 'image' } });
  }
  return null;
}

/** A imagem [i] das provas do cartão [key], com o anterior e o próximo (as setas também andam). */
function imageData(key, images, i) {
  const at = (j) => (j >= 0 && j < images.length ? `image:${key}:${j}` : '');
  return {
    path: images[i].rel,
    label: `${i + 1} / ${images.length} · ${path.basename(images[i].path)}`,
    many: images.length > 1,
    prev: at(i - 1),
    next: at(i + 1),
    hasPrev: i > 0,
    hasNext: i < images.length - 1,
  };
}

async function retitle(keys) {
  const sessions = (await mx.request('sessions.list')) || [];
  for (const key of keys) {
    const n = state.links.nodes[key];
    const s = n && sessions.find((x) => x.id === n.tabId);
    if (s) await mx.request('session.rename', { tabId: s.id, title: tinted(s.title, n.color, n.manager) }).catch((e) => mx.log('rename:', e.message));
  }
}

const CARD_VERBS = ['paste', 'suggest', 'detail', 'notes', 'reject', 'write', 'tell', 'message', 'play', 'pick', 'send', 'copy', 'browse', 'dismiss', 'option', 'use', 'approve', 'answer'];

async function onAction(act, values) {
  const [verb, a, b, ...more] = act.split(':');
  if (CARD_VERBS.includes(verb)) return onCard(verb, a, [b, ...more], values);
  if (verb === 'pr' || verb === 'image') return onProof(verb, a, Number(b));
  if (verb === 'url') return openFound(a, Number(b));
  const links = state.links;
  const titleOf = async (tabId) => ((await mx.request('sessions.list')) || []).find((s) => s.id === tabId)?.title || tabId;
  if (verb === 'novo') return createManager();
  if (verb === 'focus') return mx.request('session.focus', { tabId: a });
  if (verb === 'resume') return resume(a);
  if (verb === 'reopen') return reopen(a);
  if (verb === 'close') return closeTab(a);
  if (verb === 'hpr') {
    const h = links.history.find((x) => x.id === a);
    const pr = h && h.prs[Number(b)];
    return pr ? mx.request('window.openUrl', { url: pr.url }) : null;
  }
  if (verb === 'history') {
    state.ui.history = a || (state.ui.history ? null : 'today');
    if (b === 'show') return showPanel(ALL, 'raise');
    return schedule();
  }
  if (verb === 'doctor') return openDoctor();
  if (verb === 'cleanup') return openCleanup();
  if (verb.startsWith('clean-')) return onCleanup(verb.slice(6), a);
  if (verb === 'doctor-all') return fixAll();
  if (verb === 'sweep') {
    doctor.sweep(a, links, state.dataDir);
    return schedule();
  }
  if (verb === 'panel') return showPanel(a, 'raise');
  if (verb === 'switch') return showPanel(a, 'switch');
  if (verb === 'older') {
    state.ui.showOld = !state.ui.showOld;
    return schedule();
  }
  if (verb === 'fold') {
    state.ui.unfolded[a] = !state.ui.unfolded[a];
    return schedule();
  }
  if (verb === 'manager') {
    const { key } = links.ensure(a, await titleOf(a));
    save();
    return retitle([key]);
  }
  if (verb === 'promote') {
    links.promote(a);
    save();
    return retitle(links.subtree(a));
  }
  if (verb === 'link') {
    const key = links.link(b, a, await titleOf(b));
    save();
    return retitle(links.subtree(key));
  }
  if (verb === 'unlink') {
    const n = links.nodes[a];
    relay.forget(links, a);
    links.remove(a);
    save();
    if (n) await mx.request('session.rename', { tabId: n.tabId, title: bare(await titleOf(n.tabId)) }).catch(() => {});
    if (n) await mx.request('session.tint', { tabId: n.tabId, tint: null }).catch(() => {});
    return null;
  }
  if (verb === 'forget') {
    relay.forget(links, a);
    links.remove(a);
    save();
  }
  return null;
}

/** Um link maestria://maestria.sessions/<card|panel>/<tabId> clicado num terminal. */
async function onLink(path) {
  const [what, tabId] = String(path || '').split('/');
  const key = tabId ? state.links.byTab(tabId) : null;
  if (!key) {
    await showPanel(ALL, 'raise');
    return what === 'card' ? mx.request('window.showBanner', { text: 'essa sessão não está mais na árvore' }).catch(() => {}) : null;
  }
  await showPanel(state.links.rootOf(key), 'raise');
  return what === 'card' && state.links.nodes[key].parent ? openCard(key) : null;
}

mx.onNotification('view.action', ({ viewId, action, values }) => {
  const id = String(viewId);
  if (id === 'link') {
    onLink(action).catch((e) => mx.log('link', action, e.message));
    return;
  }
  if (id !== 'sidebar' && id !== PANEL && id !== DOCTOR && id !== CLEANUP && ![CARD, IMAGE].some((p) => id.startsWith(p))) return;
  const act = String(action === 'act' ? values && values.a : action || (values && values.action) || '');
  onAction(act, values).catch((e) => {
    mx.log('ação', act, e.message);
    mx.request('window.showBanner', { text: `sessions: ${e.message}` }).catch(() => {});
  });
});

/** Cartão "working" de aba aberta e parada pode virar "parou?" sem nenhum evento: o painel olha de novo. */
const watched = (n) => n.card && n.card.state === 'working' && state.lastSessions.some((s) => s.id === n.tabId && isOpen(s) && !s.hibernated);

setInterval(() => {
  if (Object.values(state.links.nodes).some((n) => (n.events || []).some((e) => !relay.isPassive(e)) || watched(n))) schedule();
}, 30 * 1000).unref();

mx.start();
