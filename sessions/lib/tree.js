'use strict';
// A aba da lateral: cada gerente com as sessões dele embaixo, quem precisa de você primeiro, e as prontas dobradas.

const { colorOf, bare } = require('./links');
const { stateOf, liveOf, waitOf, repliedOf, plain } = require('./cards');

const STATUS_TONE = {
  working: 'accent',
  tool: 'accent',
  starting: 'purple',
  waitingPermission: 'red',
  waitingAnswer: 'yellow',
  waitingInput: 'yellow',
  idle: 'green',
  ready: 'green',
};
const STATE_TONE = { needs_you: 'red', working: 'yellow', done: 'green' };
const RANK = { needs_you: 0, working: 1, done: 2 };

function ago(ms, now) {
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return 'agora';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`;
}

function managersMenu(links, except) {
  const roots = links.roots().filter((k) => !except.includes(k));
  if (!roots.length) return [];
  return [{
    action: 'noop',
    label: 'ligar ao gerente',
    icon: 'link',
    children: roots.map((k) => ({ action: `link:${k}`, label: bare(links.nodes[k].name) || k, tone: colorOf(links.nodes[k].color).hex })),
  }];
}

/** O que a linha diz embaixo do nome: o pedido do cartão, o que está fazendo, ou o status. */
function subtitleOf(st, card, session) {
  const act = (session && session.activity) || {};
  const replied = repliedOf(card, session);
  if (replied) return `Respondeu: ${plain(replied.text).split('\n').find((l) => l.trim()) || ''}`;
  if (st === 'needs_you' && card && card.state === 'needs_you') return card.headline || (card.action && card.action.text) || waitOf(session);
  if (st === 'needs_you') return waitOf(session);
  if (st === 'working') return act.lastTool || (card && card.headline) || act.lastPrompt || (session && session.statusLabel) || '';
  return (card && card.headline) || (session && session.statusLabel) || '';
}

function counts(links, key, live) {
  const n = { needs_you: 0, working: 0, done: 0 };
  for (const k of links.subtree(key).slice(1)) {
    const node = links.nodes[k];
    n[stateOf(node.card, live.get(node.tabId) || null)]++;
  }
  return n;
}

function managerItem(links, key, live, depth) {
  const node = links.nodes[key];
  const session = live.get(node.tabId) || null;
  const color = colorOf(node.color);
  const n = counts(links, key, live);
  const parts = [n.needs_you && `${n.needs_you} precisa${n.needs_you > 1 ? 'm' : ''} de você`, n.working && `${n.working} trabalhando`, n.done && `${n.done} pronta${n.done > 1 ? 's' : ''}`].filter(Boolean);
  const menu = [
    { action: `panel:${key}`, label: 'abrir painel', icon: 'stack' },
    ...(depth > 0 ? [{ action: `unlink:${key}`, label: 'tirar da árvore', icon: 'remove' }] : []),
  ];
  return {
    title: bare(session ? session.title : node.name) || node.name,
    subtitle: parts.join(' · ') || (session ? session.statusLabel || session.status || '' : 'fechada'),
    subtitleTone: n.needs_you ? 'red' : undefined,
    avatar: { plain: true, icon: 'dot', color: color.hex, size: 18 },
    strong: true,
    indent: depth,
    dim: !session,
    status: session ? STATUS_TONE[session.status] || 'faint' : undefined,
    meta: n.needs_you ? String(n.needs_you) : undefined,
    metaTone: n.needs_you ? 'red' : undefined,
    action: session ? `focus:${session.id}` : `panel:${key}`,
    actions: [{ action: `panel:${key}`, icon: 'stack', tooltip: 'painel' }],
    menu,
  };
}

function sessionItem(links, key, live, depth, now) {
  const node = links.nodes[key];
  const session = live.get(node.tabId) || null;
  const card = node.card || null;
  const st = stateOf(card, session);
  const name = bare(session ? session.title : node.name) || node.name;
  const replied = repliedOf(card, session);
  const since = replied ? replied.at : card && (st === 'done' ? card.doneAt : card.since);
  if (!session) {
    return { title: name, subtitle: 'fechada', dim: true, indent: depth, icon: 'dot', tone: 'faint', menu: [{ action: `forget:${key}`, label: 'esquecer', icon: 'trash' }] };
  }
  return {
    title: name,
    subtitle: subtitleOf(st, card, session),
    subtitleTone: st === 'needs_you' ? undefined : 'faint',
    avatar: { plain: true, icon: 'dot', color: STATE_TONE[st], size: 16 },
    indent: depth,
    meta: since ? ago(since, now) : undefined,
    metaTone: st === 'needs_you' ? 'red' : undefined,
    action: `focus:${session.id}`,
    menu: [
      { action: `promote:${key}`, label: 'tornar gerente', icon: 'star' },
      ...managersMenu(links, links.subtree(key)).map((m) => ({ ...m, children: m.children.map((c) => ({ ...c, action: `${c.action}:${session.id}` })) })),
      { action: `unlink:${key}`, label: 'tirar da árvore', icon: 'remove' },
    ],
  };
}

/** As linhas da árvore: em cada nível, quem precisa de você primeiro; as prontas viram uma linha que abre. */
function rows(links, sessions, ui = {}, now = Date.now()) {
  const live = liveOf(sessions);
  const unfolded = ui.unfolded || {};
  const out = [];
  const rank = (k) => {
    const n = links.nodes[k];
    if (links.children(k).length) return -1;
    return RANK[stateOf(n.card, live.get(n.tabId) || null)];
  };
  const walk = (key, depth) => {
    const kids = links.children(key);
    out.push(depth === 0 || kids.length ? managerItem(links, key, live, depth) : sessionItem(links, key, live, depth, now));
    const sorted = kids.map((k, i) => ({ k, r: rank(k), i })).sort((a, b) => a.r - b.r || a.i - b.i);
    const done = sorted.filter((x) => x.r === RANK.done);
    for (const { k, r } of sorted) if (r !== RANK.done || unfolded[key]) walk(k, depth + 1);
    if (done.length) {
      out.push({
        title: unfolded[key] ? 'esconder as prontas' : `${done.length} pronta${done.length > 1 ? 's' : ''}`,
        icon: 'check',
        tone: 'green',
        indent: depth + 1,
        expanded: Boolean(unfolded[key]),
        action: `fold:${key}`,
      });
    }
  };
  for (const k of links.roots()) walk(k, 0);
  return out;
}

function looseItem(links, s) {
  return {
    title: s.title || s.id,
    subtitle: s.statusLabel || s.status || '',
    icon: 'dot',
    status: STATUS_TONE[s.status] || 'faint',
    action: `focus:${s.id}`,
    menu: [
      { action: `manager:${s.id}`, label: 'tornar gerente', icon: 'star' },
      ...managersMenu(links, []).map((m) => ({ ...m, children: m.children.map((c) => ({ ...c, action: `${c.action}:${s.id}` })) })),
    ],
  };
}

function sidebar(links, sessions, ui = {}, now = Date.now()) {
  const linked = new Set(Object.values(links.nodes).map((n) => n.tabId));
  const loose = sessions.filter((s) => s.kind === 'claude' && !s.exited && !s.embedded && !linked.has(s.id));
  const waiting = sessions.filter((s) => !s.exited && s.needsYou && linked.has(s.id)).length;
  const blocks = [
    { type: 'header', title: 'Gerentes', actions: [{ action: 'novo', icon: 'add', tooltip: 'novo gerente' }] },
    {
      type: 'list',
      flat: true,
      items: rows(links, sessions, ui, now),
      empty: 'Nenhum gerente. Crie um no +, ou clique com o botão direito numa sessão abaixo e "tornar gerente".',
    },
  ];
  if (loose.length) {
    blocks.push({ type: 'section', text: 'outras sessões', count: loose.length });
    blocks.push({ type: 'list', flat: true, items: loose.map((s) => looseItem(links, s)) });
  }
  return { blocks, badge: waiting ? String(waiting) : '' };
}

module.exports = { sidebar, rows, STATUS_TONE };
