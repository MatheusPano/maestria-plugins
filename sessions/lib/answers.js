'use strict';
// A resposta de um cartão vai pro terminal da sessão (cópia na caixa do gerente), ou pro gerente se ela não pode receber.

const { bare, isOpen } = require('./links');
const { PROMPT } = require('./cards');
const { awake } = require('./wake');

const INBOX = 50;

/** A cópia, na caixa do gerente [parent], do que você mandou pra aba [tabId]. */
function copy(parent, tabId, title, text, now) {
  parent.inbox = [...(parent.inbox || []), { tabId, title, text, at: now, via: 'terminal' }].slice(-INBOX);
}

/** Você escreveu [text] para a sessão do nó [node] (resposta do cartão, caixa de mensagem ou direto na aba): o cartão sai de "precisa de você" e a vez é dela, até o gerente postar outro. */
function handOver(node, text, now, message, viaManager = false) {
  const was = { ...(node.card || {}) };
  delete was.dismissed;
  delete was.doneBecause;
  delete was.closeFor;
  node.card = {
    ...was,
    state: 'working',
    action: null,
    headline: `${message ? 'Você escreveu' : 'Você respondeu'}: ${text}`,
    since: now,
    doneAt: null,
    answered: { text, at: now, ...(message ? { message: true } : {}), ...(viaManager ? { via: 'manager' } : {}) },
  };
}

/** Você respondeu a pergunta ou a permissão na própria aba: o cartão "precisa de você" sem ação, postado enquanto a aba esperava, passa a vez pra sessão na hora. */
function answeredInTab(node, now) {
  if (!node.card || node.card.state !== 'needs_you' || node.card.action || !node.card.onPrompt) return false;
  node.card = { ...node.card, state: 'working', action: null, headline: 'Você respondeu na aba.', since: now, doneAt: null, answered: { text: 'na aba', at: now } };
  return true;
}

/** Manda [text] pela sessão do nó [key] e passa a vez pra ela; [message] é a caixa de mensagem do cartão. Devolve por onde foi. */
async function deliver(key, text, { links, request, list, notice, sessions, now = Date.now(), message = false, wait }) {
  const io = { request, list, notice };
  const typed = (s, t) => request('terminal.sendText', { tabId: s.id, text: t, submit: true });
  const node = links.nodes[key];
  if (!node) throw new Error('esse cartão não existe mais');
  const body = String(text || '').trim();
  if (!body) throw new Error('resposta vazia');
  const parent = links.node(node.parent);
  let s = sessions.find((x) => x.id === node.tabId && isOpen(x)) || null;
  if (s && s.hibernated) s = await awake(io, s, wait);
  const title = bare(s ? s.title : node.name) || node.name;
  const toManager = !s || PROMPT.has(s.status);
  if (toManager) {
    let m = parent && sessions.find((x) => x.id === parent.tabId && isOpen(x));
    if (m && m.hibernated) m = await awake(io, m, wait);
    if (!m || PROMPT.has(m.status)) throw new Error(`${title} não pode receber agora e o gerente também não: responda na aba`);
    const why = s ? s.statusLabel || s.status : 'fechada';
    await typed(m, `[resposta do usuário no cartão de ${title} (${why})] ${body}`);
  } else {
    await typed(s, body);
    if (parent) copy(parent, s.id, title, body, now);
  }
  handOver(node, body, now, message, toManager);
  return { via: toManager ? 'manager' : 'terminal', title };
}

module.exports = { deliver, handOver, answeredInTab, copy };
