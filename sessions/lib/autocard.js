'use strict';
// The card of a session whose turn ended with nothing to decide: the plugin writes it from the last reply, so the manager is not woken for it.

const relay = require('./relay');
const { stateOf, plain } = require('./cards');
const { isOpen } = require('./links');

const HEADLINE = 200;

/** The first line of the reply, as a headline. */
function headlineOf(text) {
  const line = plain(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
  const chars = Array.from(line);
  return chars.length > HEADLINE ? `${chars.slice(0, HEADLINE).join('')}…` : line;
}

/** Writes the card of [key] from the session's last reply; false when the card says something the plugin must not overwrite. */
function write(links, key, session, now) {
  const node = links.nodes[key];
  const prev = node.card;
  if (!prev || prev.dismissed || !(prev.state === 'working' || (prev.auto && prev.state === 'needs_you'))) return false;
  if (prev.state === 'working' && stateOf(prev, session, now) !== 'needs_you') return false;
  if (!session.reply || !session.reply.text || session.reply.at <= (prev.at || 0)) return false;
  node.card = {
    state: 'needs_you',
    headline: headlineOf(session.reply.text),
    bullets: [],
    action: null,
    proof: prev.proof || null,
    at: now,
    since: prev.state === 'needs_you' && prev.since ? prev.since : now,
    doneAt: null,
    doneBecause: null,
    busy: false,
    onPrompt: false,
    keepOpen: false,
    auto: true,
  };
  return true;
}

/** Walks every manager's queue and settles the autoable turns; returns true if a card or a queue changed. */
function run(links, sessions, now = Date.now()) {
  let changed = false;
  for (const parent of Object.values(links.nodes)) {
    if (!parent.events || !parent.events.length) continue;
    const keep = parent.events.filter((e) => {
      if (!relay.autoable(links, e, sessions, now)) return true;
      const node = links.nodes[e.key];
      const session = sessions.find((s) => s.id === node.tabId && isOpen(s));
      return !write(links, e.key, session, now);
    });
    if (keep.length !== parent.events.length) {
      parent.events = keep;
      changed = true;
    }
  }
  return changed;
}

module.exports = { run, write, headlineOf };
