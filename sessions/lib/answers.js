'use strict';
// A resposta de um cartão vai pro terminal da sessão (cópia na caixa do gerente), ou pro gerente se ela não pode receber.

const { bare, isOpen } = require('./links');
const { PROMPT } = require('./cards');
const { awake } = require('./wake');

const INBOX = 50;

/** Manda [text] pela sessão do nó [key] e passa o cartão pra "trabalhando"; uma [message] avulsa mantém o pedido do cartão. Devolve por onde foi. */
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
    if (parent) parent.inbox = [...(parent.inbox || []), { tabId: s.id, title, text: body, at: now, via: 'terminal' }].slice(-INBOX);
  }
  if (message) {
    const was = node.card || {};
    const back = !was.state || was.state === 'done' ? { state: 'working', since: now, doneAt: null } : {};
    node.card = { ...was, ...back, answered: { text: body, at: now, message: true } };
  } else node.card = { ...(node.card || {}), state: 'working', action: null, headline: `Você respondeu: ${body}`, since: now, answered: { text: body, at: now } };
  return { via: toManager ? 'manager' : 'terminal', title };
}

module.exports = { deliver };
