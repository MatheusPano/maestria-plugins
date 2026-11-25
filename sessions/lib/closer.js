'use strict';
// O cartão "feito" fecha a aba sozinho: o done do gerente arma o fechamento para a conversa daquele momento ([card.closeFor]),
// e qualquer fechamento da aba (por aqui, pelo gerente, pelo painel ou por você) desarma. Retomar não fecha de novo até outro done.

const { isOpen } = require('./links');
const { closable } = require('./cards');

/** O sessionId que o done armou; null quando não há o que fechar. */
const armed = (c) => (c && c.state === 'done' && !c.keepOpen && !c.dismissed && c.closeFor) || null;

/** Cartões feitos de antes do fechamento automático: armam para a conversa da aba aberta agora; os de aba fechada, não. */
function migrate(links, sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let changed = false;
  for (const n of Object.values(links.nodes)) {
    const c = n.card;
    if (!c || c.state !== 'done' || 'closeFor' in c) continue;
    const s = byId.get(n.tabId);
    n.card = { ...c, closeFor: s && isOpen(s) && !c.dismissed && s.sessionId && s.sessionId === n.sessionId ? s.sessionId : null };
    changed = true;
  }
  return changed;
}

/** Fecha qualquer coisa que o done tinha armado para o nó [key]: a aba fechou por outro caminho. */
function disarm(links, key) {
  const n = key && links.nodes[key];
  if (n && n.card && n.card.closeFor) n.card = { ...n.card, closeFor: null };
}

/**
 * Os nós cuja aba já pode fechar: done armado para a conversa que está na aba, parada, fora do turno, sem você olhando
 * (em foco ou num painel na tela) e, se for gerente, sem sessões abertas embaixo.
 */
function due(links, sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const open = (k) => {
    const s = byId.get(links.nodes[k].tabId);
    return Boolean(s && isOpen(s));
  };
  const out = [];
  for (const [key, n] of Object.entries(links.nodes)) {
    const sessionId = n.parent ? armed(n.card) : null;
    const s = sessionId && byId.get(n.tabId);
    if (!s || s.kind !== 'claude' || !isOpen(s) || s.sessionId !== sessionId) continue;
    if (s.focused || s.onScreen || s.needsYou || n.busy || !closable(s)) continue;
    if (links.children(key).some(open)) continue;
    out.push({ key, session: s, by: `gerente ${links.nodes[n.parent] ? links.nodes[n.parent].name : ''}`.trim() });
  }
  return out;
}

/** A notificação de uma rodada: uma linha por sessão quando é uma, a contagem quando são várias. */
function notice(closed) {
  if (closed.length === 1) return { title: 'Sessão terminada fechada', body: `${closed[0].name}: ${closed[0].what}` };
  const names = closed.map((c) => c.name);
  const shown = names.slice(0, 5).join(', ');
  return { title: `${closed.length} sessões terminadas fechadas`, body: names.length > 5 ? `${shown} e mais ${names.length - 5}. Estão no histórico do painel.` : `${shown}. Estão no histórico do painel.` };
}

module.exports = { due, notice, migrate, disarm, armed };
