'use strict';
// As abas que fecharam: quem fechou, o que a sessão fez e como voltar para ela. Fica 30 dias em links.json.

const { bare } = require('./links');
const { taskOf, plain, split, ALL } = require('./cards');

const REPLY_CHARS = 200;
const MAX_ROWS = 50;
const NOTED_MS = 2 * 60 * 1000;
const RANGES = [
  { id: 'today', label: 'hoje' },
  { id: 'yesterday', label: 'ontem' },
  { id: 'week', label: '7 dias' },
  { id: 'month', label: '30 dias' },
];

/** O começo do dia [back] dias antes de [ms], pelo calendário (um dia de horário de verão não tem 24 h). */
const dayStart = (ms, back = 0) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
};

function inRange(at, range, now) {
  if (range === 'today') return at >= dayStart(now);
  if (range === 'yesterday') return at >= dayStart(now, 1) && at < dayStart(now);
  if (range === 'week') return at >= dayStart(now, 6);
  return true;
}

const pad = (n) => String(n).padStart(2, '0');
function when(at, now) {
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (at >= dayStart(now)) return hm;
  if (at >= dayStart(now, 1)) return `ontem ${hm}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}

/** Os PRs do cartão e os que a última resposta citou, sem repetir. */
function prsOf(card, reply) {
  const seen = new Set();
  const out = [];
  const add = (url, label) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label: label || url.replace(/^https?:\/\/(www\.)?github\.com\//, '') });
  };
  for (const p of (card && card.proof && card.proof.prs) || []) add(p.url, p.label);
  for (const l of (reply && reply.links) || []) add(l.url, l.label);
  return out;
}

/** O registro de uma aba que fechou: o cartão (ou a última resposta), os PRs e o que precisa para retomar. */
function entryOf({ links, key = null, session = null, by, now = Date.now() }) {
  const node = key ? links.nodes[key] : null;
  const card = (node && node.card) || null;
  const reply = (session && session.reply) || null;
  const name = bare((node && node.name) || (session && session.title)) || (session && session.id) || '';
  const stale = Boolean(card && card.state !== 'done' && reply && reply.text && (reply.at || 0) > (card.at || 0));
  return {
    at: now,
    by,
    key,
    root: key ? links.rootOf(key) : null,
    tabId: (session && session.id) || (node && node.tabId) || null,
    name,
    task: taskOf({ title: name, branch: session && session.branch }),
    state: card ? card.state : null,
    headline: (!stale && card && card.headline) || '',
    why: (card && card.doneBecause) || '',
    reply: reply && reply.text ? plain(reply.text).replace(/\s+/g, ' ').trim().slice(0, REPLY_CHARS) : '',
    prs: prsOf(card, reply),
    branch: (session && session.branch) || '',
    cwd: (session && session.cwd) || (node && node.cwd) || '',
    sessionId: (session && session.sessionId) || (node && node.sessionId) || null,
    color: (node && node.color) || null,
    manager: Boolean(node && node.manager),
  };
}

/** O que a sessão fez, numa frase: o motivo do done, o cartão, ou a última resposta. */
function whatOf(h) {
  if (h.why) return h.headline && h.headline !== h.why ? `${h.why}. ${h.headline}` : h.why;
  if (h.headline) return h.headline;
  if (h.reply) return `${h.state ? '' : 'Sem cartão. '}Última resposta: “${h.reply}”`;
  return h.state ? 'Sem resumo no cartão.' : 'Sem cartão nem resposta.';
}

/** Grava a aba [session] (ou o nó [key]) no histórico. */
function record(links, { key = null, session = null, by, now = Date.now() }) {
  return links.remember(entryOf({ links, key, session, by, now }));
}

/** Desfaz um registro (o fechamento falhou). */
function forget(links, id) {
  links.history = links.history.filter((h) => h.id !== id);
}

/** As abas que sumiram da lista desde a última olhada e que ninguém acabou de registrar (o main.js confirma na leitura seguinte). */
function vanished(links, before, sessions, now = Date.now()) {
  const still = new Set(sessions.map((s) => s.id));
  const noted = new Set(links.history.filter((h) => now - h.at < NOTED_MS).map((h) => h.tabId));
  return before.filter((s) => s.kind === 'claude' && s.sessionId && !still.has(s.id) && !noted.has(s.id));
}

/** A seção do painel: as fechadas do período [range], do gerente [current] ou de todos. */
function view(links, current, range, now = Date.now()) {
  const mine = links.history.filter((h) => current === ALL || h.root === current).sort((x, y) => y.at - x.at);
  const shown = range ? mine.filter((h) => inRange(h.at, range, now)) : [];
  const today = mine.filter((h) => inRange(h.at, 'today', now)).length;
  return {
    open: Boolean(range),
    toggle: 'history',
    label: `Histórico das fechadas · ${today} hoje · ${mine.length} em 30 dias`,
    has: mine.length > 0,
    ranges: RANGES.map((r) => ({ label: r.label, act: `history:${r.id}`, active: r.id === range })),
    empty: 'Nenhuma aba fechada nesse período.',
    isEmpty: shown.length === 0,
    more: shown.length > MAX_ROWS ? `mostrando as ${MAX_ROWS} mais recentes de ${shown.length}` : '',
    rows: shown.slice(0, MAX_ROWS).map((h) => ({
      when: when(h.at, now),
      task: h.task || '',
      title: split(h.name, h.task),
      what: whatOf(h),
      by: h.by,
      prs: h.prs.map((p, i) => ({ label: p.label, act: `hpr:${h.id}:${i}` })),
      hasPrs: h.prs.length > 0,
      canResume: Boolean(h.sessionId),
      resume: `reopen:${h.id}`,
    })),
  };
}

/** A linha da lateral: quantas fecharam hoje e na semana. */
function summary(links, now = Date.now()) {
  const today = links.history.filter((h) => inRange(h.at, 'today', now)).length;
  const week = links.history.filter((h) => inRange(h.at, 'week', now)).length;
  return `${today} ${today === 1 ? 'fechada' : 'fechadas'} hoje · ${week} nos últimos 7 dias`;
}

module.exports = { RANGES, entryOf, record, forget, vanished, view, summary, whatOf, when };
