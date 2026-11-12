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
const { ALL, panel, detail, managerKeys, RESTING, PROMPT } = require('./lib/cards');
const { deliver } = require('./lib/answers');
const { replies, cwdOf } = require('./lib/replies');
const doctor = require('./lib/doctor');
const relay = require('./lib/relay');

const MANAGER_BRIEF = [
  'Você é um gerente de sessões na Maestria. Divida o trabalho e delegue: abra uma sessão por frente com sessions_open',
  '(cada pedido se sustenta sozinho, a sessão nova não sabe nada desta conversa), acompanhe com sessions_list (mine: true)',
  'e mande instruções com sessions_send. As sessões que você abre ganham a sua cor. Não faça o trabalho pesado você mesmo:',
  'coordene, junte os resultados e reporte. Um cartão só vai para done quando não sobra nada: PR mergeado ou em produção e tarefa fechada; push feito esperando PR ou merge é needs_you. Quando citar um cartão ou o painel, cole o link maestria:// que o sessions_card devolve, sozinho na linha: clicado, ele abre o cartão. Você recebe avisos [sessions] Novidades (e events nos resultados das ferramentas) quando uma sessão termina o turno, espera o usuário, ou quando o usuário escreve direto nela: confira, atualize o cartão e reporte ao usuário uma linha por sessão, com o estado real, o que falta e de quem é a vez. Nunca diga que algo está pronto sem ter conferido. O pedido do usuário chega na próxima mensagem.',
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
  ui: { picked: {}, rejecting: {}, clears: {}, open: {}, writing: {}, images: {}, unfolded: {}, showOld: false, playing: null, focus: null },
  title: undefined,
  doctor: false,
  sent: new relay.Sent(),
  retitled: new Map(),
};
const PANEL = 'painel';
const LEGACY_PANEL = 'painel:';
const CARD = 'cartao:';
const IMAGE = 'imagem:';
const DOCTOR = 'diagnostico';
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

/** O mx.request, guardando o que o plugin escreve numa aba: isso não é você digitando direto nela. */
function request(method, params) {
  if (method === 'terminal.sendText' && params && params.tabId) state.sent.note(params.tabId, params.text);
  return mx.request(method, params);
}

const withLive = (sessions) =>
  sessions.map((s) => (state.live[s.id] ? { ...s, activity: { ...(s.activity || {}), lastTool: state.live[s.id] } } : s));
const readReply = replies(os.homedir());

/** Junta a última resposta do Claude às conversas paradas (o cartão compara com ela, e a visão de todas a mostra). */
function withReplies(sessions) {
  return sessions.map((s) => (s.kind === 'claude' && s.sessionId && !s.needsYou && RESTING.has(s.status) ? { ...s, reply: readReply(s.sessionId, s.cwd) } : s));
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

async function refresh() {
  const sessions = await listSessions();
  if (state.links.reconcile(sessions)) writeLinks();
  await flushRelays(sessions);
  const wrong = state.links.retitles(sessions);
  for (const tabId of [...state.retitled.keys()]) if (!wrong.some((w) => w.tabId === tabId)) state.retitled.delete(tabId);
  await Promise.all(
    wrong
      .filter(({ tabId, title }) => state.retitled.get(tabId) !== title)
      .map(({ tabId, title }) => {
        state.retitled.set(tabId, title);
        return mx.request('session.rename', { tabId, title }).catch((e) => mx.log('rename:', e.message));
      }),
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
function panelUpdate(sessions) {
  const p = panel(state.links, state.current, sessions, LIBRARY, state.ui);
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
  const p = panel(state.links, state.current, sessions, LIBRARY, state.ui);
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

/** Um hook de uma sessão com gerente vira evento na fila dele: turno terminado, esperando você, ou o que você digitou direto nela. */
function relayHook(name, tabId, payload) {
  const key = state.links.byTab(tabId);
  if (!key || !state.links.nodes[key].parent) return;
  const p = payload || {};
  let event = null;
  if (name === 'UserPromptSubmit' && p.prompt && !state.sent.take(tabId, p.prompt)) event = { kind: 'direct', text: String(p.prompt) };
  else if (name === 'Stop') event = { kind: 'turn' };
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
    if (!relay.due(node, manager, now)) continue;
    const sent = node.events;
    node.events = [];
    node.relayedAt = now;
    try {
      await request('terminal.sendText', { tabId: manager.id, text: relay.digest(state.links, sent, sessions), submit: true });
    } catch (e) {
      mx.log('aviso ao gerente:', e.message);
      node.events = [...sent, ...(node.events || [])];
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
  const { via, title } = await deliver(key, text, { ...wakeIo, links: state.links, sessions: await listSessions(), message });
  delete state.ui.picked[key];
  delete state.ui.rejecting[key];
  delete state.ui.writing[key];
  if (via === 'terminal') delete state.ui.images[key];
  state.ui.clears[key] = (state.ui.clears[key] || 0) + 1;
  save();
  const where = via === 'terminal' ? title : 'o gerente (a aba está num prompt)';
  return mx.request('window.showBanner', { text: `enviado para ${where}` }).catch(() => {});
}

/** Tira o cartão [key] de "precisa de você"/"trabalhando": vai para Feito, até o gerente postar outro. */
function dismiss(key) {
  const node = state.links.nodes[key];
  if (!node || !node.card) return null;
  const now = Date.now();
  node.card = { ...node.card, state: 'done', dismissed: true, action: null, answered: null, headline: 'Dispensado por você.', at: now, doneAt: now };
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
  if (!n.sessionId) throw new Error(`não sei qual conversa era "${n.name}": ela nunca reportou o sessionId`);
  const cwd = (n.cwd && isDir(n.cwd) && n.cwd) || cwdOf(os.homedir(), n.sessionId);
  if (!cwd || !isDir(cwd)) throw new Error(`não achei a pasta da conversa "${n.name}"`);
  const r = await mx.request('session.openClaude', { cwd, label: tinted(n.name, n.color, n.manager), resume: n.sessionId });
  if (!r || !r.resumed) {
    if (r && r.tabId) await mx.request('session.close', { tabId: r.tabId }).catch(() => {});
    throw new Error('esta Maestria ainda não retoma conversas por plugin; atualize a Maestria');
  }
  n.tabId = r.tabId;
  n.cwd = cwd;
  save();
  return null;
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
  delete state.ui.images[key];
  return schedule();
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
    return mx.request('view.open', {
      viewId: IMAGE + key,
      title: path.basename(proof.images[i].path),
      modal: true,
      rfw: { library: LIBRARY, root: 'image' },
      data: { path: proof.images[i].rel },
    });
  }
  return null;
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
  if (verb === 'doctor') return openDoctor();
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
    links.remove(a);
    save();
    if (n) await mx.request('session.rename', { tabId: n.tabId, title: bare(await titleOf(n.tabId)) }).catch(() => {});
    return null;
  }
  if (verb === 'forget') {
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
  if (id !== 'sidebar' && id !== PANEL && id !== DOCTOR && ![CARD, IMAGE].some((p) => id.startsWith(p))) return;
  const act = String(action === 'act' ? values && values.a : action || (values && values.action) || '');
  onAction(act, values).catch((e) => {
    mx.log('ação', act, e.message);
    mx.request('window.showBanner', { text: `sessions: ${e.message}` }).catch(() => {});
  });
});

setInterval(() => {
  if (Object.values(state.links.nodes).some((n) => n.events && n.events.length)) schedule();
}, relay.limits.gap / 2).unref();

mx.start();
