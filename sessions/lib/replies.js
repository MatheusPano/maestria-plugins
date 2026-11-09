'use strict';
// A última resposta do Claude numa sessão, lida do fim do transcript (o lastMessage do sessions.list vem cortado).

const fs = require('fs');
const path = require('path');

const TAIL = 512 * 1024;
const MAX = 8000;
const RETRY = 30000;

const slug = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

function transcriptOf(projects, sessionId, cwd, found) {
  const name = `${sessionId}.jsonl`;
  const guess = cwd && path.join(projects, slug(cwd), name);
  if (guess && fs.existsSync(guess)) return guess;
  const was = found.get(sessionId);
  if (was && (was.file || Date.now() - was.at < RETRY)) return was.file;
  let hit = null;
  try {
    for (const dir of fs.readdirSync(projects)) {
      const p = path.join(projects, dir, name);
      if (fs.existsSync(p)) {
        hit = p;
        break;
      }
    }
  } catch {}
  found.set(sessionId, { file: hit, at: Date.now() });
  return hit;
}

/** Texto e hora da última mensagem do assistente no fim do arquivo, fora de subagentes. */
function lastReplyIn(file) {
  const fd = fs.openSync(file, 'r');
  let raw;
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    raw = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = raw.split('\n');
  let seen = false;
  let id;
  let at = null;
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let j;
    try {
      j = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (j.type === 'user' && !j.isSidechain && seen) break;
    if (j.type !== 'assistant' || j.isSidechain || !j.message) continue;
    const texts = (Array.isArray(j.message.content) ? j.message.content : []).filter((c) => c && c.type === 'text' && c.text);
    if (!texts.length) continue;
    if (seen && j.message.id !== id) break;
    seen = true;
    id = j.message.id;
    at = at || Date.parse(j.timestamp) || null;
    parts.unshift(texts.map((c) => c.text).join('\n'));
  }
  if (!parts.length) return null;
  const text = parts.join('\n').trim();
  return { text: text.length > MAX ? `${text.slice(0, MAX)}…` : text, at };
}

/** Lê as respostas com cache por arquivo (tamanho + mtime), pra não reler a cada refresh. */
function replies(home) {
  const projects = path.join(home, '.claude', 'projects');
  const found = new Map();
  const cache = new Map();
  return (sessionId, cwd) => {
    if (!sessionId) return null;
    const file = transcriptOf(projects, sessionId, cwd, found);
    if (!file) return null;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      found.delete(sessionId);
      return null;
    }
    const was = cache.get(file);
    if (was && was.size === st.size && was.mtime === st.mtimeMs) return was.reply;
    let reply = null;
    try {
      reply = lastReplyIn(file);
    } catch {}
    cache.set(file, { size: st.size, mtime: st.mtimeMs, reply });
    return reply;
  };
}

module.exports = { replies, lastReplyIn, slug };
