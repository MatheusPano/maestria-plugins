'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const mx = require('./maestria');
const tools = require('./lib/tools');
const { Links, tinted, bare } = require('./lib/links');
const { sidebar } = require('./lib/tree');
const { ALL, panel, detail, managerKeys, RESTING, PROMPT } = require('./lib/cards');
const { deliver } = require('./lib/answers');
const { replies } = require('./lib/replies');

const MANAGER_BRIEF = [
  'Você é um gerente de sessões na Maestria. Divida o trabalho e delegue: abra uma sessão por frente com sessions_open',
  '(cada pedido se sustenta sozinho, a sessão nova não sabe nada desta conversa), acompanhe com sessions_list (mine: true)',
  'e mande instruções com sessions_send. As sessões que você abre ganham a sua cor. Não faça o trabalho pesado você mesmo:',
  'coordene, junte os resultados e reporte. O pedido do usuário chega na próxima mensagem.',
].join(' ');

const state = {
  links: new Links(),
  file: null,
  dataDir: null,
  timer: null,
  current: ALL,
  open: false,
  showing: Promise.resolve(),
  probed: false,
  modal: null,
  live: {},
  ui: { picked: {}, rejecting: {}, clears: {}, open: {}, writing: {}, unfolded: {}, showOld: false, playing: null, focus: null },
  title: undefined,
  retitled: new Map(),
};
const PANEL = 'painel';
const LEGACY_PANEL = 'painel:';
const CARD = 'cartao:';
const IMAGE = 'imagem:';
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

const withLive = (sessions) =>
  sessions.map((s) => (state.live[s.id] ? { ...s, activity: { ...(s.activity || {}), lastTool: state.live[s.id] } } : s));
const readReply = replies(os.homedir());

/** Junta a última resposta do Claude às conversas paradas (o cartão compara com ela, e a visão de todas a mostra). */
function withReplies(sessions) {
  return sessions.map((s) => (s.kind === 'claude' && s.sessionId && !s.needsYou && RESTING.has(s.status) ? { ...s, reply: readReply(s.sessionId, s.cwd) } : s));
}

const listSessions = async () => withReplies(withLive((await mx.request('sessions.list')) || []));

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function save() {
  if (!state.file) return;
  try {
    fs.mkdirSync(path.dirname(state.file), { recursive: true });
    fs.writeFileSync(state.file, JSON.stringify(state.links.toJSON()));
  } catch (e) {
    mx.log('não salvou os vínculos:', e.message);
  }
  schedule();
}

function load() {
  try {
    state.links = new Links(JSON.parse(fs.readFileSync(state.file, 'utf8')));
  } catch {
    state.links = new Links();
  }
}

async function refresh() {
  const sessions = await listSessions();
  if (state.links.reconcile(sessions)) {
    try {
      fs.writeFileSync(state.file, JSON.stringify(state.links.toJSON()));
    } catch {}
  }
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
  const liveTabs = new Set(sessions.filter((s) => !s.exited).map((s) => `@${s.id}`));
  for (const bag of [state.ui.writing, state.ui.clears]) for (const k of Object.keys(bag)) if (k.startsWith('@') && !liveTabs.has(k)) delete bag[k];
  if (state.open) {
    const r = await mx.request('view.update', panelUpdate(sessions)).catch(() => ({ open: false }));
    if (!r || r.open === false) {
      state.open = false;
      state.title = undefined;
    }
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

function schedule() {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    refresh().catch((e) => mx.log('lateral:', e.message));
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

const ctx = ({ tabId, cwd }) => ({
  request: (method, params) => mx.request(method, params),
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

mx.onNotification('event', ({ type, tabId, name, payload }) => {
  if (type === 'hook' && tabId) {
    if (name === 'PreToolUse') state.live[tabId] = liveLine(payload);
    else if (name === 'Stop' || name === 'SessionEnd') delete state.live[tabId];
  }
  if (type === 'sidebar.shown' || type === 'hook' || String(type).startsWith('session.')) schedule();
});

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
  const { via, title } = await deliver(key, text, { links: state.links, request: mx.request, sessions: await listSessions(), message });
  delete state.ui.picked[key];
  delete state.ui.rejecting[key];
  delete state.ui.writing[key];
  state.ui.clears[key] = (state.ui.clears[key] || 0) + 1;
  save();
  const where = via === 'terminal' ? title : 'o gerente (a aba está num prompt)';
  return mx.request('window.showBanner', { text: `enviado para ${where}` }).catch(() => {});
}

/** Manda [text] direto pro gerente do painel [key]. */
async function tell(key, text) {
  const body = String(text || '').trim();
  const node = state.links.nodes[key];
  if (!body || !node) return null;
  const m = (await listSessions()).find((s) => s.id === node.tabId && !s.exited);
  if (!m) throw new Error('a aba do gerente está fechada');
  if (m.hibernated || PROMPT.has(m.status)) throw new Error('o gerente está num prompt: responda na aba dele');
  await mx.request('terminal.sendText', { tabId: m.id, text: body, submit: true });
  if (state.ui.focus === key) delete state.ui.focus;
  const clear = `tell-${key}`;
  state.ui.clears[clear] = (state.ui.clears[clear] || 0) + 1;
  schedule();
  return mx.request('window.showBanner', { text: `enviado para ${bare(m.title)}` }).catch(() => {});
}

/** Uma conversa sem gerente (cartão "@<tabId>" na visão de todas): só abre a caixa e manda mensagem. */
async function onFree(verb, key, values) {
  if (verb === 'write') {
    state.ui.writing[key] = !state.ui.writing[key];
    return schedule();
  }
  if (verb !== 'message') return null;
  const body = String((values && values.text) || '').trim();
  if (!body) return null;
  const s = (await listSessions()).find((x) => x.id === key.slice(1) && !x.exited);
  if (!s) throw new Error('essa aba fechou');
  if (s.hibernated || PROMPT.has(s.status)) throw new Error(`${bare(s.title)} está num prompt: responda na aba`);
  await mx.request('terminal.sendText', { tabId: s.id, text: body, submit: true });
  delete state.ui.writing[key];
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
  if (verb === 'reject') return flip(state.ui.rejecting);
  if (verb === 'write') return flip(state.ui.writing);
  if (verb === 'tell') return tell(key, values && values.text);
  if (verb === 'play') return toggleAudio(key, rest[0], Number(rest[1]));
  if (verb === 'pick') {
    state.ui.picked[key] = Number(rest[0]);
    return schedule();
  }
  if (verb === 'message') {
    const text = String((values && values.text) || '').trim();
    return text ? answer(key, text, true) : null;
  }
  if (verb === 'answer') {
    const text = String((values && values.text) || '').trim();
    if (!text) return null;
    return answer(key, state.ui.rejecting[key] ? `Rejeitado: ${text}` : text);
  }
  if (!action) return null;
  if (verb === 'send' && action.kind === 'command' && action.tabId) {
    await mx.request('terminal.sendText', { tabId: action.tabId, text: action.text, submit: false });
    return mx.request('session.focus', { tabId: action.tabId });
  }
  if (verb === 'copy') {
    await mx.request('clipboard.write', { text: action.text });
    return mx.request('window.showBanner', { text: 'comando copiado' }).catch(() => {});
  }
  if (verb === 'link' && action.kind === 'command') return mx.request('window.openUrl', { url: action.text.trim() });
  const option = (i) => action.options[i] && `${action.options[i].key}: ${action.options[i].label}`;
  if (verb === 'option') return option(Number(rest[0])) ? answer(key, option(Number(rest[0]))) : null;
  if (verb === 'use') return state.ui.picked[key] != null && option(state.ui.picked[key]) ? answer(key, option(state.ui.picked[key])) : null;
  if (verb === 'approve') return answer(key, 'Aprovado.');
  return null;
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

const CARD_VERBS = ['detail', 'notes', 'reject', 'write', 'tell', 'message', 'play', 'pick', 'send', 'copy', 'link', 'option', 'use', 'approve', 'answer'];

async function onAction(act, values) {
  const [verb, a, b, ...more] = act.split(':');
  if (CARD_VERBS.includes(verb)) return onCard(verb, a, [b, ...more], values);
  if (verb === 'pr' || verb === 'image') return onProof(verb, a, Number(b));
  const links = state.links;
  const titleOf = async (tabId) => ((await mx.request('sessions.list')) || []).find((s) => s.id === tabId)?.title || tabId;
  if (verb === 'novo') return createManager();
  if (verb === 'focus') return mx.request('session.focus', { tabId: a });
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

mx.onNotification('view.action', ({ viewId, action, values }) => {
  const id = String(viewId);
  if (id !== 'sidebar' && id !== PANEL && ![CARD, IMAGE].some((p) => id.startsWith(p))) return;
  const act = String(action === 'act' ? values && values.a : action || (values && values.action) || '');
  onAction(act, values).catch((e) => {
    mx.log('ação', act, e.message);
    mx.request('window.showBanner', { text: `sessions: ${e.message}` }).catch(() => {});
  });
});

mx.start();
