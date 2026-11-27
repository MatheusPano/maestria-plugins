'use strict';
// Opens a claude tab on a chosen model: the host's openClaude has no model option, so the plugin types /model into the fresh tab before the first prompt.

const { RESTING } = require('./cards');

const READY_MS = 30 * 1000;
const STEP_MS = 250;
const SETTLE_MS = 1500;
const MODEL = /^[\w.:[\]-]{1,60}$/;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const valid = (model) => MODEL.test(String(model || '').trim());

/** session.openClaude with [params]; with a [model], the prompt goes after `/model <model>` once the tab is ready. Returns { tabId, model } where model is the one that was set, or null. */
async function openClaude(request, params, model, { sleep = pause, readyMs = READY_MS } = {}) {
  const wanted = String(model || '').trim();
  if (!wanted || !valid(wanted)) return { ...(await request('session.openClaude', params)), model: null };
  const { prompt, ...rest } = params;
  const opened = await request('session.openClaude', rest);
  const tabId = opened && opened.tabId;
  if (!tabId) return { ...opened, model: null };
  let ready = false;
  for (let waited = 0; waited < readyMs && !ready; waited += STEP_MS) {
    const now = ((await request('sessions.list')) || []).find((s) => s.id === tabId);
    ready = Boolean(now && RESTING.has(now.status));
    if (!ready) await sleep(STEP_MS);
  }
  if (ready) {
    await request('terminal.sendText', { tabId, text: `/model ${wanted}`, submit: true });
    await sleep(SETTLE_MS);
  }
  if (prompt) await request('terminal.sendText', { tabId, text: prompt, submit: true });
  return { ...opened, model: ready ? wanted : null };
}

module.exports = { openClaude, valid };
