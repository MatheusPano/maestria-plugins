'use strict';
// A resposta de um cartão vai pro terminal da sessão (cópia na caixa do gerente), ou pro gerente se ela não pode receber.

const { bare, isOpen } = require('./links');
const { PROMPT, RESTING } = require('./cards');
const { awake } = require('./wake');

const INBOX = 50;
const PENDING_MS = 3600 * 1000;

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

/** Manda [text] pela sessão do nó [key] e passa a vez pra ela; [message] é a caixa de mensagem do cartão. Devolve por onde foi.
 *  Com a aba num prompt (ou com respostas já na fila), a resposta entra na fila do nó e vai quando a aba sair do prompt. */
async function deliver(key, text, { links, request, list, notice, sessions, now = Date.now(), message = false, wait, boot = null }) {
  const io = { request, list, notice };
  const typed = (s, t) => request('terminal.sendText', { tabId: s.id, text: t, submit: true });
  const node = links.nodes[key];
  if (!node) throw new Error('esse cartão não existe mais');
  const body = String(text || '').trim();
  if (!body) throw new Error('resposta vazia');
  const parent = links.node(node.parent);
  let s = sessions.find((x) => x.id === node.tabId && isOpen(x)) || null;
  const title = bare(s ? s.title : node.name) || node.name;
  if (s && (PROMPT.has(s.status) || (node.pending && node.pending.length))) {
    node.pending = [...(node.pending || []), { text: body, at: now, message, boot }];
    handOver(node, body, now, message);
    return { via: 'pending', title };
  }
  if (s && s.hibernated) s = await awake(io, s, wait);
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

const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const joined = (items) => items.map((p) => p.text).join('\n');
const fresh = async (io, id) => ((await io.list()) || []).find((x) => x.id === id && isOpen(x)) || null;

/** Quem vai receber a fila do nó agora: a aba ('tab'), o gerente ('manager', com o porquê), ou ninguém ainda (null). */
function routeOf(node, s, { boot, now, closed }) {
  const p = node.pending;
  if (!s) return closed ? { to: 'manager', why: 'a aba fechou' } : null;
  if (PROMPT.has(s.status)) {
    if (p.some((x) => x.boot !== boot)) return { to: 'manager', why: 'o plugin reiniciou com a aba num prompt' };
    if (now - p[0].at > PENDING_MS) return { to: 'manager', why: 'a aba ficou mais de 1 h num prompt' };
    return null;
  }
  if (s.focused || !(s.hibernated || RESTING.has(s.status))) return null;
  return { to: 'tab' };
}

/**
 * Entrega as filas de respostas guardadas: pra aba quando ela sai do prompt e para (e você não está nela); pro gerente
 * quando a aba fechou, ficou mais de 1 h no prompt ou o plugin reiniciou com ela no prompt. Sem gerente que receba, vai
 * pra aba se ela puder, senão a fila é descartada e volta em [dropped]. Relê a aba logo antes de digitar.
 */
async function flushPending({ links, sessions, request, list, notice, boot, now = Date.now(), wait, closed = () => false }) {
  const io = { request, list, notice };
  const out = [];
  for (const [key, node] of Object.entries(links.nodes)) {
    const items = node.pending;
    if (!items || !items.length) continue;
    const s0 = sessions.find((x) => x.id === node.tabId && isOpen(x)) || null;
    const title = bare(s0 ? s0.title : node.name) || node.name;
    const route = routeOf(node, s0, { boot, now, closed: closed(node.tabId) });
    if (!route) continue;
    const done = (via) => {
      node.pending = (node.pending || []).filter((x) => !items.includes(x));
      if (!node.pending.length) delete node.pending;
      if (node.card && node.card.answered) node.card = { ...node.card, answered: { ...node.card.answered, at: now, ...(via === 'manager' ? { via: 'manager' } : {}) } };
      out.push({ key, via, title });
    };
    const parent = links.node(node.parent);
    if (route.to === 'tab') {
      let s = await fresh(io, s0.id);
      if (!s || s.focused || PROMPT.has(s.status) || !(s.hibernated || RESTING.has(s.status))) continue;
      if (s.hibernated) s = await awake(io, s, wait);
      if (PROMPT.has(s.status)) continue;
      await request('terminal.sendText', { tabId: s.id, text: joined(items), submit: true });
      if (parent) copy(parent, s.id, title, joined(items), now);
      done('terminal');
      continue;
    }
    let m = parent && (await fresh(io, parent.tabId));
    if (m && m.hibernated) m = await awake(io, m, wait);
    if (m && !m.focused && !PROMPT.has(m.status)) {
      await request('terminal.sendText', { tabId: m.id, text: `[resposta do usuário no cartão de ${title}, guardada às ${clock(items[0].at)} (${route.why})] ${joined(items)}`, submit: true });
      done('manager');
      continue;
    }
    if (m) continue;
    const s = s0 && (await fresh(io, s0.id));
    if (s && !s.focused && !PROMPT.has(s.status) && (s.hibernated || RESTING.has(s.status))) {
      await request('terminal.sendText', { tabId: (await awake(io, s, wait)).id, text: joined(items), submit: true });
      done('terminal');
      continue;
    }
    node.pending = (node.pending || []).filter((x) => !items.includes(x));
    if (!node.pending.length) delete node.pending;
    out.push({ key, via: 'dropped', title });
  }
  return out;
}

/** Sua resposta guardada deixou de valer: você escreveu direto na aba, o gerente postou outro cartão ou você dispensou. */
function dropPending(node) {
  if (!node || !node.pending) return false;
  delete node.pending;
  return true;
}

module.exports = { deliver, flushPending, dropPending, handOver, answeredInTab, copy, PENDING_MS };
