'use strict';
// Token usage of a conversation, read incrementally from the usage fields of its transcript.

const fs = require('fs');

const HOUR = 60 * 60 * 1000;
const KEEP = 2 * HOUR;
const FIRST_READ = 2 * 1024 * 1024;

/** Everything the model processed for one request: fresh input, cache writes, cache reads and output. */
const processed = (u) => (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
/** What sits in the context window after the request: its whole input. */
const contextOf = (u) => (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);

/** Folds the transcript lines of [text] into [entries] (a Map by message id: a message repeats its usage on each content block). */
function fold(entries, text) {
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const m = j && j.type === 'assistant' && !j.isSidechain && j.message;
    if (!m || !m.usage || !m.id) continue;
    const at = Date.parse(j.timestamp) || 0;
    const was = entries.get(m.id);
    if (!was || processed(m.usage) >= was.tokens) entries.set(m.id, { at, tokens: processed(m.usage), context: contextOf(m.usage) });
  }
}

/** [fileOf](sessionId, cwd) finds the transcript. The reader keeps per file how far it read and the last two hours of requests. */
function reader(fileOf, now = Date.now) {
  const cache = new Map();
  return (sessionId, cwd) => {
    const file = fileOf(sessionId, cwd);
    if (!file) return null;
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return null;
    }
    let c = cache.get(file);
    if (!c || size < c.offset) {
      const from = Math.max(0, size - FIRST_READ);
      c = { offset: from, aligned: from === 0, entries: new Map() };
      cache.set(file, c);
    }
    if (size > c.offset) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - c.offset);
        fs.readSync(fd, buf, 0, buf.length, c.offset);
        const end = buf.lastIndexOf(10) + 1;
        const text = buf.subarray(0, end).toString('utf8');
        fold(c.entries, text.slice(c.aligned ? 0 : text.indexOf('\n') + 1));
        c.aligned = true;
        c.offset += end;
      } finally {
        fs.closeSync(fd);
      }
    }
    const t = now();
    for (const e of c.entries.values()) if (!c.last || e.at >= c.last.at) c.last = e;
    for (const [id, e] of c.entries) if (t - e.at > KEEP) c.entries.delete(id);
    const recent = [...c.entries.values()];
    return {
      perHour: recent.filter((e) => t - e.at <= HOUR).reduce((n, e) => n + e.tokens, 0),
      context: c.last ? c.last.context : 0,
    };
  };
}

/** 1.2M, 340k, 900. */
function compact(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(v);
}

module.exports = { reader, compact, processed, contextOf, HOUR };
