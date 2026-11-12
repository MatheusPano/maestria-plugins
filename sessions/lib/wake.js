'use strict';
// Escrever numa aba hibernada: acorda, espera o Claude voltar e só então digita.

const { bare } = require('./links');
const { RESTING, PROMPT } = require('./cards');

const limits = { timeout: 60 * 1000, step: 1000 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const waking = new Set();

const name = (s) => bare(s.title) || s.id;

/** Acorda [s] se ela hibernou e espera ficar pronta (ou numa pergunta); devolve a sessão acordada. */
async function awake(io, s, { timeout = limits.timeout, step = limits.step, sleep = pause } = {}) {
  if (!s.hibernated) return s;
  if (waking.has(s.id)) throw new Error(`já estou acordando "${name(s)}"; a mensagem anterior vai quando ela estiver pronta`);
  waking.add(s.id);
  try {
    if (io.notice) io.notice(s);
    await io.request('session.wake', { tabId: s.id });
    for (let waited = 0; waited < timeout; waited += step) {
      await sleep(step);
      const now = ((await io.list()) || []).find((x) => x.id === s.id);
      if (!now || (now.exited && !now.hibernated)) throw new Error(`"${name(s)}" fechou ao acordar`);
      if (!now.hibernated && (RESTING.has(now.status) || PROMPT.has(now.status))) return now;
    }
    throw new Error(`"${name(s)}" acordou mas não ficou pronta a tempo; mande de novo`);
  } finally {
    waking.delete(s.id);
  }
}

/** Digita [text] em [s] e envia, acordando-a antes se ela hibernou. Recusa se ela estiver numa pergunta. */
async function typeInto(io, s, text, opts) {
  const ready = await awake(io, s, opts);
  if (PROMPT.has(ready.status)) throw new Error(`"${name(ready)}" está esperando você na aba: responda lá`);
  await io.request('terminal.sendText', { tabId: ready.id, text, submit: true });
  return ready;
}

module.exports = { awake, typeInto, limits };
