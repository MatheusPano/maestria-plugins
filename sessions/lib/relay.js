'use strict';
// O que acontece nas sessões de um gerente chega a ele: turno terminado, sessão esperando você, e o que você escreveu direto nela.

const { bare, isOpen } = require('./links');
const { PROMPT, RESTING, plain } = require('./cards');

const KEEP = 30;
const SENT_MS = 10 * 60 * 1000;
const limits = { quiet: 10 * 1000, gap: 60 * 1000 };
const LINE = 160;

const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const clip = (text) => {
  const t = norm(plain(text));
  return t.length > LINE ? `${t.slice(0, LINE)}…` : t;
};

/** As mensagens que o plugin pôs numa aba (do gerente ou do painel), pra não contar como digitadas por você. */
class Sent {
  constructor(now = Date.now) {
    this.now = now;
    this.byTab = new Map();
  }

  note(tabId, text) {
    const list = (this.byTab.get(tabId) || []).filter((m) => this.now() - m.at < SENT_MS);
    list.push({ text: norm(text), at: this.now() });
    this.byTab.set(tabId, list);
  }

  /** Se [text] foi o plugin que mandou pra [tabId], consome e diz true. */
  take(tabId, text) {
    const list = (this.byTab.get(tabId) || []).filter((m) => this.now() - m.at < SENT_MS);
    const typed = norm(String(text || '').replace(/\[Image #\d+\]\s*/g, ''));
    const i = list.findIndex((m) => m.text === typed);
    if (i >= 0) list.splice(i, 1);
    this.byTab.set(tabId, list);
    return i >= 0;
  }
}

/** Põe o evento [event] da sessão [key] na fila do gerente dela; devolve true se enfileirou. */
function queue(links, key, event, now = Date.now()) {
  const node = links.nodes[key];
  const parent = node && links.node(node.parent);
  if (!parent) return false;
  const events = (parent.events || []).filter((e) => !(event.kind === 'turn' && e.kind === 'turn' && e.key === key));
  parent.events = [...events, { ...event, key, at: now }].slice(-KEEP);
  return true;
}

/** Uma linha por evento, com o nome da sessão e o que ela disse por último. */
function lines(links, events, sessions) {
  const live = new Map(sessions.filter(isOpen).map((s) => [s.id, s]));
  return events.map((e) => {
    const node = links.nodes[e.key];
    const s = node && live.get(node.tabId);
    const name = bare(s ? s.title : node ? node.name : e.key) || e.key;
    if (e.kind === 'direct') return `- O usuário escreveu direto para "${name}": "${clip(e.text)}"`;
    if (e.kind === 'waiting') return `- "${name}" está esperando o usuário na aba${e.text ? `: ${clip(e.text)}` : ''}`;
    if (!s) return `- "${name}" fechou.`;
    if (s.needsYou || PROMPT.has(s.status)) return `- "${name}" terminou o turno e está esperando o usuário (${s.statusLabel || s.status}).`;
    const said = s.reply && s.reply.text ? `: "${clip(s.reply.text)}"` : '.';
    return `- "${name}" terminou o turno${said}`;
  });
}

const HEAD = '[sessions] Novidades das suas sessões (aviso automático do plugin, não é mensagem do usuário):';
const TAIL =
  'Confira cada uma (sessions_list, a aba dela), atualize os cartões com sessions_card e me reporte só o que mudou: uma linha por sessão, com o estado real, o que falta e de quem é a vez.';

function digest(links, events, sessions) {
  return [HEAD, ...lines(links, events, sessions), TAIL].join('\n');
}

/** A fila do gerente [key] pode ir agora pro terminal dele: parado, sem pergunta, sem foco (você pode estar digitando) e sem ter recebido nada há pouco. */
function due(node, manager, now = Date.now()) {
  const events = node.events || [];
  if (!events.length || !manager || manager.exited || manager.kind !== 'claude') return false;
  if (manager.hibernated || manager.needsYou || manager.focused || !RESTING.has(manager.status)) return false;
  if (now - events[events.length - 1].at < limits.quiet) return false;
  return now - (node.relayedAt || 0) >= limits.gap;
}

module.exports = { Sent, queue, lines, digest, due, limits };
