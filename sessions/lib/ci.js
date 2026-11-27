'use strict';
// Live CI of the PRs in a card's proof: the plugin asks gh and updates the badge itself, without waking the manager.

const PULL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
const RUNNING_MS = 90 * 1000;
const SETTLED_MS = 10 * 60 * 1000;
const FRESH_DONE_MS = 24 * 60 * 60 * 1000;
const PER_TICK = 4;

const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** ok, running, failed or none, from the statusCheckRollup that gh prints. */
function ciOf(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (!checks.length) return 'none';
  const result = (c) => String(c.conclusion || c.state || '').toUpperCase();
  if (checks.some((c) => FAILED.has(result(c)))) return 'failed';
  const done = (c) => (c.status ? String(c.status).toUpperCase() === 'COMPLETED' : PASSED.has(result(c)));
  if (!checks.every(done)) return 'running';
  return checks.every((c) => PASSED.has(result(c))) ? 'ok' : 'running';
}

/** The PRs worth asking about now: in the proof of a card that is not an old done one, and not asked too recently. */
function due(links, asked, now = Date.now()) {
  const out = [];
  for (const [key, node] of Object.entries(links.nodes)) {
    const card = node.card;
    if (!card || !card.proof || !card.proof.prs) continue;
    if (card.state === 'done' && now - (card.doneAt || card.at || 0) > FRESH_DONE_MS) continue;
    card.proof.prs.forEach((pr, i) => {
      if (!PULL.test(pr.url)) return;
      const every = pr.ci === 'ok' || pr.ci === 'failed' ? SETTLED_MS : RUNNING_MS;
      if (now - (asked.get(pr.url) || 0) >= every) out.push({ key, i, url: pr.url.match(PULL)[0] });
    });
  }
  return out.slice(0, PER_TICK);
}

/** Asks gh for the due PRs and writes the CI into the cards; true if a badge changed. */
async function poll(links, exec, asked, now = Date.now()) {
  let changed = false;
  for (const { key, i, url } of due(links, asked, now)) {
    asked.set(url, now);
    const r = await exec('gh', ['pr', 'view', url, '--json', 'statusCheckRollup']);
    if (r.code !== 0) continue;
    let ci;
    try {
      ci = ciOf(JSON.parse(r.stdout).statusCheckRollup);
    } catch {
      continue;
    }
    const card = links.nodes[key] && links.nodes[key].card;
    const pr = card && card.proof && card.proof.prs[i];
    if (pr && pr.url.startsWith(url) && pr.ci !== ci) {
      pr.ci = ci;
      changed = true;
    }
  }
  return changed;
}

module.exports = { ciOf, due, poll };
