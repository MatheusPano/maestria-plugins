'use strict';
// Os dados do quadro do gerente (precisa de você, trabalhando, feito hoje); o desenho é ui/panel.rfwtxt.

const { colorOf, bare, isOpen } = require('./links');

const STATES = ['working', 'needs_you', 'done'];
const MAX_BULLETS = 3;
const PROMPT = new Set(['waitingPermission', 'waitingAnswer']);
const COLUMNS = [
  { state: 'needs_you', title: 'Precisa de você', tone: 'red', empty: 'Ninguém esperando você.' },
  { state: 'working', title: 'Trabalhando', tone: 'yellow', empty: 'Nenhuma sessão trabalhando.' },
  { state: 'done', title: 'Feito hoje', tone: 'green', empty: 'Nada pronto hoje ainda.' },
];

const taskOf = (s) => {
  const m = `${s.title || ''} ${s.branch || ''}`.match(/\b(TASK|BUG)#\d+/i);
  return m ? m[0].toUpperCase() : null;
};

/** O estado que vale: a sessão esperando você ganha do que o gerente escreveu. */
const RESTING = new Set(['ready', 'idle']);
const STOPPED = new Set([...RESTING, 'ended', 'unknown']);

const REPLY_LINES = 8;
const LINE_CHARS = 40;
const shownLines = (text) => text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / LINE_CHARS)), 0);

const plain = (text) => String(text || '').replace(/^#{1,6} +/gm, '').replace(/\*\*|__|`/g, '');

/** A sessão fechou o turno depois do último cartão (ou da sua resposta) e ficou parada: está esperando você. */
function repliedOf(card, session) {
  if (!card || !session || session.needsYou || !RESTING.has(session.status)) return null;
  if (card.state !== 'working' && !card.answered) return null;
  const after = Math.max(card.at || 0, (card.answered && card.answered.at) || 0);
  const r = session.reply;
  return r && r.text && r.at > after ? r : null;
}

/** Quantos agentes a sessão ainda tem rodando em segundo plano, com o turno dela já parado. */
const agentsOf = (s) => (s && !s.hibernated && !PROMPT.has(s.status) && Number(s.backgroundAgents)) || 0;
const behind = (n) => `rodando em segundo plano (${n} ${n === 1 ? 'agente' : 'agentes'})`;

/** O estado que vale: agente em segundo plano é trabalho; a sessão esperando você ganha do que o gerente escreveu. */
function stateOf(card, session) {
  if (agentsOf(session) && !(card && card.state === 'needs_you' && card.action)) return card && card.dismissed ? 'done' : 'working';
  if (session && session.needsYou) return 'needs_you';
  if (repliedOf(card, session)) return 'needs_you';
  const running = Boolean(session) && !session.hibernated && !STOPPED.has(session.status);
  const gone = !session || session.hibernated || session.status === 'ended';
  if (card && card.state === 'done') return running && !card.dismissed ? 'working' : 'done';
  if (card && card.state === 'working' && gone) return 'done';
  if (card && card.state) return card.state;
  return running ? 'working' : 'done';
}

const hex = (h) => 0xff000000 + parseInt(String(h).replace('#', ''), 16);
const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function ago(ms, now) {
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  return `há ${Math.floor(min / 60)} h`;
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const liveOf = (sessions) => new Map(sessions.filter(isOpen).map((s) => [s.id, s]));
const ALL = '*';
const FREE = 0xff8b8b8b;
const firstLine = (text) => plain(text).split('\n').map((l) => l.trim()).find(Boolean) || '';

const UI = () => ({ picked: {}, rejecting: {}, clears: {}, open: {}, writing: {}, playing: null });

/** Tira o "TASK#123" do começo do título: ele já vai na coluna do número. */
function split(title, task) {
  const t = bare(title);
  if (!task) return t;
  const rest = t.replace(new RegExp(`^\\s*${task.replace('#', '#?')}\\s*[-:·]?\\s*`, 'i'), '').trim();
  return rest || t;
}

const short = (task) => (task ? `#${task.split('#')[1]}` : '');

const TRUNK = new Set(['main', 'master', 'develop', 'dev', 'HEAD']);

function proofData(proof, key, limit, session = null) {
  const p = proof || { images: [], prs: [], audio: [], log: '' };
  const posted = new Set(p.prs.map((pr) => pr.url));
  const found = ((session && session.reply && session.reply.links) || []).map((l, i) => ({ ...l, i })).filter((l) => !posted.has(l.url));
  const prs = [
    ...p.prs.map((pr, i) => ({ label: pr.label || pr.url, ci: pr.ci, act: `pr:${key}:${i}` })),
    ...found.map((l) => ({ label: l.label, ci: 'none', act: `url:${session.id}:${l.i}` })),
  ];
  const branch = session && session.branch && !TRUNK.has(session.branch) ? session.branch : '';
  const images = p.images.slice(0, limit).map((im, i) => ({ path: im.rel, act: `image:${key}:${i}` }));
  return {
    images,
    hasImages: images.length > 0,
    more: p.images.length > limit ? `+${p.images.length - limit}` : '',
    prs,
    branch,
    hasPrs: prs.length > 0 || Boolean(branch),
    sounds: p.audio.map((a, i) => ({ label: a.label, act: `play:${key}:proof:${i}` })),
    hasSounds: p.audio.length > 0,
    hasLog: Boolean(p.log),
  };
}

/** Os dados de um cartão; [ui] é o estado da janela (tocando, escolhido, rejeitando, notas abertas). */
const claudeCommand = (text) => /^\s*!/.test(text);

/** Junta "/" e "-" ao que vem em volta, pra quebra de linha cair nos espaços e não no meio de um caminho. */
const shown = (text) => String(text).replace(/[/-]/g, (m) => `\u2060${m}\u2060`);

const isLink = (text) => /^https?:\/\/\S+$/.test(String(text || '').trim());

function howTo(text, canSend) {
  if (isLink(text)) return 'Clique para abrir no navegador';
  if (canSend) return 'Clique em Enviar → na aba, aperte Enter';
  return claudeCommand(text) ? 'Copie e cole no prompt do Claude, depois Enter' : 'Copie e cole no terminal';
}

const WAITS = { waitingAnswer: 'Pergunta na aba.', waitingPermission: 'Permissão na aba.' };
const waitOf = (session) => WAITS[session && session.status] || `Esperando você na aba (${(session && session.statusLabel) || 'pergunta'}).`;

function cardData({ key, node, session, card }, live, ui, now, thumbs = null) {
  const state = stateOf(card, session);
  const task = session ? taskOf(session) : null;
  const title = split(session ? session.title : node.name, task) || node.name;
  const c = card || {};
  const action = c.action || null;
  const bullets = c.bullets || [];
  const target = action && action.tabId ? live.get(action.tabId) : null;
  const prompt = Boolean(session && PROMPT.has(session.status));
  const tabAsks = Boolean(session && session.needsYou) && c.state !== 'needs_you';
  const replied = repliedOf(c, session);
  let kind = action && !tabAsks ? action.kind : 'none';
  if (tabAsks || (state === 'needs_you' && !action)) kind = 'wait';
  if (replied) kind = 'reply';
  const options = action && action.options && !tabAsks ? action.options : [];
  const audible = options.some((o) => o.audio);
  const picked = ui.picked[key];
  const playing = ui.playing && ui.playing.key === key ? ui.playing.id : null;
  const headline =
    (tabAsks && waitOf(session)) ||
    (replied && (c.answered ? 'Respondeu, esperando você.' : 'Parou, esperando você.')) ||
    c.headline ||
    (kind === 'question' || kind === 'approve' ? action.text : '') ||
    (kind === 'command' ? (target ? `Rode na aba ${bare(target.title)}.` : 'Rode este comando.') : '') ||
    (kind === 'wait' ? waitOf(session) : '') ||
    (!card && session ? firstLine((session.reply && session.reply.text) || (session.activity && session.activity.lastMessage)) : '');
  const lastTurn = session && session.reply ? session.reply.at : null;
  const since = (replied && replied.at) || c.since || c.at || lastTurn || now;
  const activity = (session && session.activity) || {};
  return {
    state,
    key,
    task: short(task),
    title,
    color: node.free ? FREE : hex(colorOf(node.color).hex),
    age: !card && !lastTurn ? '' : state === 'needs_you' ? ago(since, now) : state === 'working' ? `desde ${clock(since)}` : clock(c.doneAt || c.at || lastTurn || now),
    headline,
    context: replied ? (c.answered ? `${c.answered.message ? 'Você escreveu' : 'Você respondeu'}: ${c.answered.text}` : c.headline || '') : c.headline && (kind === 'question' || kind === 'approve') ? action.text : '',
    reply: replied ? plain(replied.text) : '',
    replyLong: Boolean(replied) && shownLines(plain(replied.text)) > REPLY_LINES,
    hasHeadline: Boolean(headline),
    because: state === 'done' && c.doneBecause ? `feito porque: ${c.doneBecause}` : '',
    kind,
    command: kind === 'command' ? shown(action.text) : '',
    shell: kind === 'command' && !claudeCommand(action.text) && !isLink(action.text),
    link: kind === 'command' && isLink(action.text),
    canSend: kind === 'command' && Boolean(target) && !isLink(action.text),
    sendLabel: 'Enviar para a aba',
    howTo: kind === 'command' ? howTo(action.text, Boolean(target)) : '',
    hasTarget: Boolean(target || (session && kind !== 'command')),
    where: kind === 'command' && action.tabId && !target ? 'aba fechada' : (action && action.where) || '',
    prompt,
    options: audible
      ? []
      : options.map((o, i) => ({ k: o.key, label: o.label, rec: Boolean(o.recommended), act: `option:${key}:${i}` })),
    hasOptions: options.length > 0 && !audible,
    clips: audible
      ? options.map((o, i) => ({
          k: o.key,
          label: o.label,
          rec: Boolean(o.recommended),
          playing: playing === `opt:${i}`,
          picked: picked === i,
          play: `play:${key}:opt:${i}`,
          pick: `pick:${key}:${i}`,
        }))
      : [],
    hasClips: audible,
    useLabel: audible && picked != null && options[picked] ? `Usar ${options[picked].label}` : '',
    canUse: audible && picked != null && Boolean(options[picked]),
    rejecting: Boolean(ui.rejecting[key]),
    input: `answer-${key}`,
    canDismiss: Boolean(card) && state !== 'done' && !String(key).startsWith('@'),
    canMessage: Boolean(session) && !['question', 'approve', 'reply'].includes(kind),
    writing: Boolean(ui.writing && ui.writing[key]),
    clear: ui.clears[key] || 0,
    live: state !== 'working' ? '' : agentsOf(session) ? behind(agentsOf(session)) : plain(activity.lastTool || activity.lastMessage).slice(0, 140),
    hasLive: state === 'working' && Boolean(agentsOf(session) || activity.lastTool || activity.lastMessage),
    images: ui.images && ui.images[key] ? `${ui.images[key]} ${ui.images[key] === 1 ? 'imagem' : 'imagens'} no prompt da aba` : '',
    hasImages: Boolean(ui.images && ui.images[key]),
    notes: bullets.length ? `${bullets.length} ${bullets.length === 1 ? 'nota' : 'notas'} da sessão` : '',
    hasNotes: bullets.length > 0,
    open: Boolean(ui.open[key]),
    bullets,
    closed: !session,
    acts: {
      detail: node.free || String(key).startsWith('@') ? (session ? `focus:${session.id}` : '') : `detail:${key}`,
      notes: `notes:${key}`,
      focus: session ? `focus:${session.id}` : '',
      target: target ? `focus:${target.id}` : '',
      send: `send:${key}`,
      copy: `copy:${key}`,
      link: `browse:${key}`,
      dismiss: `dismiss:${key}`,
      answer: `answer:${key}`,
      write: `write:${key}`,
      message: `message:${key}`,
      approve: `approve:${key}`,
      reject: `reject:${key}`,
      use: `use:${key}`,
      paste: `paste:${key}`,
    },
    ...proofData(c.proof, key, thumbs || (state === 'done' ? 1 : 2), session),
  };
}

const seqOf = (key) => Number(String(key).slice(1)) || 0;

/** Ordem fixa dentro da coluna (a de entrada na árvore), pra um cartão não pular quando você mexe nele. */
function order(a, b) {
  if (a.state !== b.state) return 0;
  if (a.rank != null && b.rank != null) return a.rank - b.rank;
  return a.state === 'needs_you' ? seqOf(a.key) - seqOf(b.key) : seqOf(b.key) - seqOf(a.key);
}

/** Todas as conversas do Claude abertas, ligadas a um gerente ou não, na ordem das abas. */
function everyone(links, sessions, live, u, now) {
  const open = sessions
    .filter((s) => s.kind === 'claude' && isOpen(s))
    .map((s, rank) => {
      const k = links.byTab(s.id);
      const managed = k && links.nodes[k].parent;
      const node = k ? links.nodes[k] : { name: s.title, tabId: s.id, free: true };
      const card = (managed && node.card) || null;
      const data = cardData({ key: managed ? k : `@${s.id}`, node: managed ? node : { ...node, free: !k, name: node.name || s.title }, session: s, card }, live, u, now);
      data.rank = rank;
      const used = Boolean(s.reply || (s.activity && s.activity.lastPrompt) || !RESTING.has(s.status));
      data.sinceMs = card ? (card.state === 'done' ? card.doneAt : card.since) || card.at || 0 : (s.reply && s.reply.at) || (used ? now : 1);
      return data;
    });
  const closed = Object.keys(links.nodes)
    .filter((k) => links.nodes[k].parent && links.nodes[k].card && !live.has(links.nodes[k].tabId))
    .map((k) => {
      const card = links.nodes[k].card;
      const data = cardData({ key: k, node: links.nodes[k], session: null, card }, live, u, now);
      data.rank = open.length + seqOf(k);
      data.sinceMs = (card.state === 'done' ? card.doneAt : card.since) || card.at || 0;
      return data;
    });
  return [...open, ...closed];
}

/** Os dados do quadro do gerente [key], ou de todas as conversas com [ALL]. */
function board(links, key, sessions, ui = {}, now = Date.now()) {
  const u = { ...UI(), ...ui };
  const live = liveOf(sessions);
  const whole = key === ALL;
  const manager = whole ? { name: 'todas as sessões', color: null, tabId: null } : links.nodes[key];
  const all = whole
    ? everyone(links, sessions, live, u, now)
    : links.subtree(key).slice(1).map((k) => {
        const node = links.nodes[k];
        const card = node.card || null;
        const data = cardData({ key: k, node, session: live.get(node.tabId) || null, card }, live, u, now);
        data.sinceMs = (card && (card.state === 'done' ? card.doneAt : card.since)) || (card && card.at) || 0;
        return data;
      });
  const old = all.filter((c) => c.state === 'done' && c.sinceMs && !sameDay(c.sinceMs, now));
  const cards = all.filter((c) => u.showOld || !old.includes(c)).sort(order);
  const me = live.get(manager.tabId);
  const name = bare(manager.name);
  const folder = me && me.cwd ? me.cwd.replace(/^\/home\/[^/]+/, '~') : '';
  return {
    name,
    folder: folder === name ? '' : folder,
    total: `${all.length} ${all.length === 1 ? 'sessão' : 'sessões'}`,
    color: whole ? FREE : hex(colorOf(manager.color).hex),
    managerTab: me ? `focus:${me.id}` : '',
    tell: { input: `tell-${key}`, act: `tell:${key}`, clear: u.clears[`tell-${key}`] || 0, focus: u.focus === key },
    canTell: Boolean(me),
    cols: COLUMNS.map((col) => {
      const list = cards.filter((c) => c.state === col.state);
      return { ...col, count: String(list.length), cards: list, isEmpty: list.length === 0 };
    }),
    older: !old.length ? '' : u.showOld ? 'esconder os de antes de hoje' : `ontem e antes · ${old.length}`,
    olderAct: 'older',
  };
}

/** O cartão aberto (modal): tudo do cartão, o log inteiro e de onde a sessão é. */
function detail(links, key, sessions, ui = {}, now = Date.now()) {
  const u = { ...UI(), ...ui };
  const node = links.nodes[key];
  if (!node) return null;
  const live = liveOf(sessions);
  const session = live.get(node.tabId) || null;
  const card = node.card || null;
  const c = cardData({ key, node, session, card }, live, u, now, 12);
  const act = (session && session.activity) || {};
  const info = [
    ['Aba', session ? bare(session.title) : 'fechada'],
    ['Branch', (session && session.branch) || ''],
    ['Pasta', (session && session.cwd) || ''],
    ['Atividade', act.prompts ? `${act.prompts} pedidos · ${act.tools || 0} ferramentas` : ''],
  ].filter(([, v]) => v).map(([k, v]) => ({ k, v }));
  const touched = (act.touched || []).slice(-8).map((f) => f.split('/').slice(-2).join('/'));
  return {
    card: { ...c, open: true },
    info,
    touched,
    hasTouched: touched.length > 0,
    log: card && card.proof && card.proof.log ? card.proof.log.split('\n').slice(-40) : [],
    hasLog: Boolean(card && card.proof && card.proof.log),
    title: `${c.task ? `${c.task} ` : ''}${c.title}`,
  };
}

/** A janela do gerente [key]: título, a biblioteca rfw e os dados. */
/** Os gerentes que o painel alterna, com quantas sessões de cada um esperam você. */
const managerKeys = (links) => links.roots().filter((k) => links.nodes[k].manager || links.children(k).length);

function managers(links, sessions, current) {
  const live = liveOf(sessions);
  const waitingAll = everyone(links, sessions, live, UI(), Date.now()).filter((c) => c.state === 'needs_you').length;
  const all = { name: 'todas', color: FREE, act: `switch:${ALL}`, active: current === ALL, waiting: waitingAll ? String(waitingAll) : '' };
  return [all, ...managerKeys(links)
    .map((k) => {
      const waiting = links
        .subtree(k)
        .slice(1)
        .filter((c) => stateOf(links.nodes[c].card || null, live.get(links.nodes[c].tabId) || null) === 'needs_you').length;
      return { name: bare(links.nodes[k].name), color: hex(colorOf(links.nodes[k].color).hex), act: `switch:${k}`, active: k === current, waiting: waiting ? String(waiting) : '' };
    })];
}

function panel(links, key, sessions, library, ui, now) {
  const data = board(links, key, sessions, ui, now);
  data.managers = managers(links, sessions, key);
  data.hasSwitch = data.managers.length > 1;
  return { title: `painel · ${data.name}`, rfw: { library, root: 'root' }, data };
}

module.exports = { agentsOf, behind, ALL, panel, managers, managerKeys, board, detail, cardData, liveOf, stateOf, taskOf, STATES, MAX_BULLETS, PROMPT, RESTING, waitOf, repliedOf, plain };
