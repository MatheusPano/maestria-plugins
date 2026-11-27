'use strict';
// A manager that sits idle with a big context gets /compact: its notices re-read the whole context each time.

const { isOpen } = require('./links');
const { RESTING } = require('./cards');
const relay = require('./relay');

const COOLDOWN = 15 * 60 * 1000;

/** The tabs of managers worth compacting now. [usageOf](session) gives { context }; [compacted] maps tabId to when it was last asked; [threshold] is in tokens (0 disables). */
function due(links, sessions, usageOf, { threshold, compacted = new Map(), now = Date.now(), cooldown = COOLDOWN }) {
  if (!threshold || threshold < 0) return [];
  const out = [];
  for (const node of Object.values(links.nodes)) {
    if (!node.manager) continue;
    const s = sessions.find((x) => x.id === node.tabId && isOpen(x));
    if (!s || s.kind !== 'claude' || s.hibernated || s.exited || s.focused || s.needsYou || !RESTING.has(s.status)) continue;
    if ((node.events || []).some((e) => !relay.isPassive(e))) continue;
    if (now - (compacted.get(s.id) || 0) < cooldown) continue;
    const usage = usageOf(s);
    if (usage && usage.context > threshold) out.push(s.id);
  }
  return out;
}

module.exports = { due, COOLDOWN };
