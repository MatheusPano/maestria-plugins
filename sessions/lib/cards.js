'use strict';
// Os dados do quadro do gerente (precisa de você, trabalhando, feito hoje); o desenho é ui/panel.rfwtxt.

const { colorOf, bare } = require('./links');

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

const plain = (text) => String(text || '').replace(/^#{1,6} +/gm, '').replace(/\*\*|__|`/g, '');

/** A resposta da sessão a uma resposta sua: ela fechou o turno depois que você respondeu pelo cartão. */
function repliedOf(card, session) {
  if (!card || !card.answered || !session || session.needsYou || !RESTING.has(session.status)) return null;
  const r = session.reply;
  return r && r.text && r.at > card.answered.at ? r : null;
}

function stateOf(card, session) {
  if (session && session.needsYou) return 'needs_you';
  if (repliedOf(card, session)) return 'needs_you';
  if (card && card.state) return card.state;
  if (!session) return 'done';
  return session.status === 'idle' || session.status === 'ready' ? 'done' : 'working';
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
const liveOf = (sessions) => new Map(sessions.filter((s) => !s.exited).map((s) => [s.id, s]));
const UI = () => ({ picked: {}, rejecting: {}, clears: {}, open: {}, playing: null });

/** Tira o "TASK#123" do começo do título: ele já vai na coluna do número. */
function split(title, task) {
  const t = bare(title);
  if (!task) return t;
  const rest = t.replace(new RegExp(`^\\s*${task.replace('#', '#?')}\\s*[-:·]?\\s*`, 'i'), '').trim();
  return rest || t;
}

const short = (task) => (task ? `#${task.split('#')[1]}` : '');

function proofData(proof, key, limit) {
  const p = proof || { images: [], prs: [], audio: [], log: '' };
  const images = p.images.slice(0, limit).map((im, i) => ({ path: im.rel, act: `image:${key}:${i}` }));
  return {
    images,
    hasImages: images.length > 0,
    more: p.images.length > limit ? `+${p.images.length - limit}` : '',
    prs: p.prs.map((pr, i) => ({ label: pr.label, ci: pr.ci, act: `pr:${key}:${i}` })),
    hasPrs: p.prs.length > 0,
    sounds: p.audio.map((a, i) => ({ label: a.label, act: `play:${key}:proof:${i}` })),
    hasSounds: p.audio.length > 0,
    hasLog: Boolean(p.log),
  };
}

/** Os dados de um cartão; [ui] é o estado da janela (tocando, escolhido, rejeitando, notas abertas). */
const claudeCommand = (text) => /^\s*!/.test(text);

/** Junta "/" e "-" ao que vem em volta, pra quebra de linha cair nos espaços e não no meio de um caminho. */
const shown = (text) => String(text).replace(/[/-]/g, (m) => `\u2060${m}\u2060`);

function howTo(text, canSend) {
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
    (replied && 'Respondeu, esperando você.') ||
    c.headline ||
    (kind === 'question' || kind === 'approve' ? action.text : '') ||
    (kind === 'command' ? (target ? `Rode na aba ${bare(target.title)}.` : 'Rode este comando.') : '') ||
    (kind === 'wait' ? waitOf(session) : '');
  const since = (replied && replied.at) || c.since || c.at || now;
  const activity = (session && session.activity) || {};
  return {
    state,
    key,
    task: short(task),
    title,
    color: hex(colorOf(node.color).hex),
    age: state === 'needs_you' ? ago(since, now) : state === 'working' ? `desde ${clock(since)}` : clock(c.doneAt || c.at || now),
    headline,
    context: replied ? `Você respondeu: ${c.answered.text}` : c.headline && (kind === 'question' || kind === 'approve') ? action.text : '',
    reply: replied ? plain(replied.text) : '',
    hasHeadline: Boolean(headline),
    kind,
    command: kind === 'command' ? shown(action.text) : '',
    shell: kind === 'command' && !claudeCommand(action.text),
    canSend: kind === 'command' && Boolean(target),
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
    input: kind === 'question' || kind === 'approve' ? `answer-${key}` : '',
    clear: ui.clears[key] || 0,
    live: state === 'working' ? plain(activity.lastTool || activity.lastMessage).slice(0, 140) : '',
    hasLive: state === 'working' && Boolean(activity.lastTool || activity.lastMessage),
    notes: bullets.length ? `${bullets.length} ${bullets.length === 1 ? 'nota' : 'notas'} da sessão` : '',
    hasNotes: bullets.length > 0,
    open: Boolean(ui.open[key]),
    bullets,
    closed: !session,
    acts: {
      detail: `detail:${key}`,
      notes: `notes:${key}`,
      focus: session ? `focus:${session.id}` : '',
      target: target ? `focus:${target.id}` : '',
      send: `send:${key}`,
      copy: `copy:${key}`,
      answer: `answer:${key}`,
      approve: `approve:${key}`,
      reject: `reject:${key}`,
      use: `use:${key}`,
    },
    ...proofData(c.proof, key, thumbs || (state === 'done' ? 1 : 2)),
  };
}

function order(a, b) {
  if (a.state !== b.state) return 0;
  if (a.state === 'needs_you') return a.sinceMs - b.sinceMs;
  return b.sinceMs - a.sinceMs;
}

/** Os dados do quadro do gerente [key]. */
function board(links, key, sessions, ui = {}, now = Date.now()) {
  const u = { ...UI(), ...ui };
  const live = liveOf(sessions);
  const manager = links.nodes[key];
  const all = links.subtree(key).slice(1).map((k) => {
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
    color: hex(colorOf(manager.color).hex),
    managerTab: me ? `focus:${me.id}` : '',
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
function panel(links, key, sessions, library, ui, now) {
  const data = board(links, key, sessions, ui, now);
  return { title: `painel · ${data.name}`, rfw: { library, root: 'root' }, data };
}

module.exports = { panel, board, detail, cardData, liveOf, stateOf, taskOf, STATES, MAX_BULLETS, PROMPT, RESTING, waitOf, repliedOf, plain };
