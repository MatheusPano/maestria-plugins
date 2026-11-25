'use strict';
// "Fechar abas paradas": as hibernadas (ou encerradas) há mais de um tempo, em três grupos. Marcadas por padrão só as
// que não têm nada para você: cartão feito e sem cartão. Cada uma fechada vai para o histórico.

const { bare, isOpen } = require('./links');
const { taskOf, split, plain, agentsOf } = require('./cards');

const HOUR = 3600 * 1000;
const IDLES = [
  { id: '6h', label: '6 h', ms: 6 * HOUR },
  { id: '1d', label: '1 dia', ms: 24 * HOUR },
  { id: '3d', label: '3 dias', ms: 72 * HOUR },
  { id: '7d', label: '7 dias', ms: 168 * HOUR },
];
const DEFAULT_IDLE = '1d';
const GROUPS = [
  { id: 'done', title: 'Cartão feito', why: 'marcadas por padrão', picked: true },
  { id: 'free', title: 'Sem cartão', why: 'marcadas por padrão', picked: true },
  { id: 'open', title: 'Cartão aberto', why: 'desmarcadas: ainda tinham algo para você ou pararam no meio', picked: false },
];

const idleOf = (id) => (IDLES.find((i) => i.id === id) || IDLES[1]).ms;
const parked = (s) => s.kind === 'claude' && Boolean(s.sessionId) && (s.hibernated || s.exited) && !s.focused && !s.onScreen && !agentsOf(s);

function age(ms) {
  const h = Math.floor(ms / HOUR);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** As abas paradas há mais de [idle], com o grupo, o porquê e há quanto tempo; [touched] diz quando a conversa mexeu por último. */
function candidates(links, sessions, { idle = DEFAULT_IDLE, now = Date.now(), touched = () => null } = {}) {
  const out = [];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const leads = (key) => links.subtree(key).slice(1).some((k) => {
    const t = byId.get(links.nodes[k].tabId);
    return Boolean(t && isOpen(t));
  });
  for (const s of sessions.filter(parked)) {
    const at = touched(s) || Date.parse(s.startedAt) || 0;
    if (!at || now - at < idleOf(idle)) continue;
    const key = links.byTab(s.id);
    const n = key ? links.nodes[key] : null;
    const card = (n && n.parent && n.card) || null;
    const boss = Boolean(key && leads(key));
    const midTurn = Boolean(n && n.busy);
    const keep = Boolean(card && card.state === 'done' && card.keepOpen);
    const group = boss || midTurn || keep ? 'open' : !card ? 'free' : card.state === 'done' ? 'done' : 'open';
    const name = bare((n && n.name) || s.title) || s.id;
    const task = taskOf({ title: name, branch: s.branch }) || '';
    const reply = s.reply && s.reply.text ? plain(s.reply.text).replace(/\s+/g, ' ').trim().slice(0, 140) : '';
    const sub = boss
      ? 'gerente com sessões abertas embaixo'
      : midTurn
        ? 'parou no meio do turno'
        : keep
          ? `o gerente pediu para manter aberta: ${card.doneBecause || card.headline || ''}`.replace(/: $/, '')
          : group === 'done'
        ? `feito porque: ${card.doneBecause || card.headline || 'sem motivo'}`
        : group === 'open'
          ? `${card.state === 'needs_you' ? 'precisa de você' : 'rodava'}: “${card.headline || (card.action && card.action.text) || 'sem título'}”`
          : reply
            ? `última resposta: “${reply}”`
            : n && n.manager
              ? 'gerente'
              : 'sem resposta';
    out.push({ tabId: s.id, key, group, task, title: split(name, task), sub, idleMs: now - at, age: age(now - at) });
  }
  return out.sort((a, b) => b.idleMs - a.idleMs);
}

/** O que vem marcado: os grupos marcados por padrão. */
const defaults = (list) => new Set(list.filter((c) => GROUPS.find((g) => g.id === c.group).picked).map((c) => c.tabId));

/** Os dados do modal. [picked] são os tabIds marcados. */
function view(list, picked, idle = DEFAULT_IDLE) {
  const on = list.filter((c) => picked.has(c.tabId));
  return {
    idles: IDLES.map((i) => ({ label: i.label, act: `clean-idle:${i.id}`, active: i.id === idle })),
    groups: GROUPS.map((g) => {
      const items = list.filter((c) => c.group === g.id);
      const all = items.length > 0 && items.every((c) => picked.has(c.tabId));
      return {
        title: `${g.title} · ${items.length}`,
        why: g.why,
        has: items.length > 0,
        checked: all,
        act: `clean-group:${g.id}`,
        items: items.map((c) => ({ ...c, checked: picked.has(c.tabId), act: `clean-pick:${c.tabId}` })),
      };
    }),
    isEmpty: list.length === 0,
    empty: 'Nenhuma aba parada há tanto tempo.',
    summary: `${on.length} ${on.length === 1 ? 'marcada' : 'marcadas'} · ${list.length - on.length === 1 ? 'fica 1 aberta' : `ficam ${list.length - on.length} abertas`}`,
    run: on.length ? `Fechar ${on.length} e guardar no histórico` : 'Nada marcado',
    canRun: on.length > 0,
  };
}

/** A linha da lateral: quantas paradas há mais de um dia. */
function sidebarLine(count) {
  return count ? `${count} ${count === 1 ? 'parada' : 'paradas'} há mais de 1 dia` : '';
}

module.exports = { IDLES, GROUPS, DEFAULT_IDLE, candidates, defaults, view, sidebarLine, parked };
