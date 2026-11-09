'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const mx = require('./maestria');
const tools = require('./lib/tools');
const { Links, tinted, bare } = require('./lib/links');
const { sidebar } = require('./lib/tree');
const { panel, detail, RESTING } = require('./lib/cards');
const { deliver } = require('./lib/answers');
const { replies } = require('./lib/replies');

const MANAGER_BRIEF = [
  'Você é um gerente de sessões na Maestria. Divida o trabalho e delegue: abra uma sessão por frente com sessions_open',
  '(cada pedido se sustenta sozinho, a sessão nova não sabe nada desta conversa), acompanhe com sessions_list (mine: true)',
  'e mande instruções com sessions_send. As sessões que você abre ganham a sua cor. Não faça o trabalho pesado você mesmo:',
  'coordene, junte os resultados e reporte.',
].join(' ');

const state = {
  links: new Links(),
  file: null,
  dataDir: null,
  timer: null,
  panels: new Set(),
  probed: false,
  modal: null,
  live: {},
  ui: { picked: {}, rejecting: {}, clears: {}, open: {}, unfolded: {}, showOld: false, playing: null },
};
const PANEL = 'painel:';
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

/** Junta a última resposta do Claude às sessões que você respondeu pelo cartão e que já fecharam o turno. */
function withReplies(sessions) {
  const answered = new Set(Object.values(state.links.nodes).filter((n) => n.card && n.card.answered).map((n) => n.tabId));
  return sessions.map((s) => (answered.has(s.id) && s.sessionId && !s.needsYou && RESTING.has(s.status) ? { ...s, reply: readReply(s.sessionId, s.cwd) } : s));
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
  await mx.request('sidebar.update', sidebar(state.links, sessions, state.ui));
  if (!state.probed) {
    state.probed = true;
    for (const key of state.links.roots()) state.panels.add(key);
  }
  for (const key of [...state.panels]) {
    if (!state.links.nodes[key]) {
      state.panels.delete(key);
      continue;
    }
    const r = await mx.request('view.update', { viewId: PANEL + key, ...panel(state.links, key, sessions, LIBRARY, state.ui) }).catch(() => ({ open: false }));
    if (!r || r.open === false) state.panels.delete(key);
  }
  if (state.modal) {
    const d = detail(state.links, state.modal, sessions, state.ui);
    const r = d ? await mx.request('view.update', { viewId: CARD + state.modal, data: d }).catch(() => ({ open: false })) : { open: false };
    if (!r || r.open === false) state.modal = null;
  }
}

/** Abre (ou traz pra tela) a janela de cartões do gerente [key]. */
async function showPanel(key, focus = false) {
  if (state.panels.has(key) && !focus) return schedule();
  const sessions = await listSessions();
  await mx.request('view.open', { viewId: PANEL + key, ...panel(state.links, key, sessions, LIBRARY, state.ui) });
  state.panels.add(key);
}

function schedule() {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    refresh().catch((e) => mx.log('lateral:', e.message));
  }, 300);
}

async function createManager(context = {}) {
  const folders = (await mx.request('folders.list').catch(() => [])) || [];
  const items = folders.map((f) => ({ value: f.root, label: f.name || path.basename(f.root), detail: f.root }));
  if (context.cwd && !items.some((i) => i.value === context.cwd)) items.unshift({ value: context.cwd, label: path.basename(context.cwd), detail: context.cwd });
  const cwd = await mx.request('window.pick', { title: 'novo gerente: pasta', items });
  if (!cwd) return;
  const name = await mx.request('window.input', { title: 'novo gerente: nome', placeholder: 'ex.: tarefas do Wiboor' });
  if (!name) return;
  const ask = await mx.request('window.input', { title: 'novo gerente: primeiro pedido', placeholder: 'o que ele deve coordenar (vazio: só abre)' }).catch(() => null);
  const key = state.links.add({ tabId: null, name, manager: true });
  const node = state.links.nodes[key];
  const params = { cwd, label: tinted(name, node.color), prompt: ask ? `${MANAGER_BRIEF}\n\nPedido: ${ask}` : MANAGER_BRIEF };
  try {
    const { tabId } = await mx.request('session.openClaude', params);
    node.tabId = tabId;
    save();
  } catch (e) {
    delete state.links.nodes[key];
    await mx.request('window.showBanner', { text: `sessions: não abriu o gerente: ${e.message}` }).catch(() => {});
  }
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

async function answer(key, text) {
  stopAudio();
  const { via, title } = await deliver(key, text, { links: state.links, request: mx.request, sessions: await listSessions() });
  delete state.ui.picked[key];
  delete state.ui.rejecting[key];
  state.ui.clears[key] = (state.ui.clears[key] || 0) + 1;
  save();
  const where = via === 'terminal' ? title : 'o gerente (a aba está num prompt)';
  return mx.request('window.showBanner', { text: `resposta enviada para ${where}` }).catch(() => {});
}

/** As ações de um cartão; [values] traz o texto de um campo. */
async function onCard(verb, key, rest, values) {
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
  if (verb === 'play') return toggleAudio(key, rest[0], Number(rest[1]));
  if (verb === 'pick') {
    state.ui.picked[key] = Number(rest[0]);
    return schedule();
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
  const option = (i) => action.options[i] && `${action.options[i].key}: ${action.options[i].label}`;
  if (verb === 'option') return option(Number(rest[0])) ? answer(key, option(Number(rest[0]))) : null;
  if (verb === 'use') return state.ui.picked[key] != null && option(state.ui.picked[key]) ? answer(key, option(state.ui.picked[key])) : null;
  if (verb === 'approve') return answer(key, 'Aprovado.');
  if (verb === 'answer') {
    const text = String((values && values.text) || '').trim();
    if (!text) return null;
    return answer(key, state.ui.rejecting[key] ? `Rejeitado: ${text}` : text);
  }
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
    if (s) await mx.request('session.rename', { tabId: s.id, title: tinted(s.title, n.color) }).catch((e) => mx.log('rename:', e.message));
  }
}

const CARD_VERBS = ['detail', 'notes', 'reject', 'play', 'pick', 'send', 'copy', 'option', 'use', 'approve', 'answer'];

async function onAction(act, values) {
  const [verb, a, b, ...more] = act.split(':');
  if (CARD_VERBS.includes(verb)) return onCard(verb, a, [b, ...more], values);
  if (verb === 'pr' || verb === 'image') return onProof(verb, a, Number(b));
  const links = state.links;
  const titleOf = async (tabId) => ((await mx.request('sessions.list')) || []).find((s) => s.id === tabId)?.title || tabId;
  if (verb === 'novo') return createManager();
  if (verb === 'focus') return mx.request('session.focus', { tabId: a });
  if (verb === 'panel') return showPanel(a, true);
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
  if (id !== 'sidebar' && ![PANEL, CARD, IMAGE].some((p) => id.startsWith(p))) return;
  const act = String(action === 'act' ? values && values.a : action || (values && values.action) || '');
  onAction(act, values).catch((e) => {
    mx.log('ação', act, e.message);
    mx.request('window.showBanner', { text: `sessions: ${e.message}` }).catch(() => {});
  });
});

mx.start();
