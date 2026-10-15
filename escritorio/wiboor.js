// O mínimo do Wiboor pra daily: achar a tarefa pelo número da branch
// (`TASK#123`, `BUG#45`) e deixar um comentário nela.
//
// A chave é a mesma do plugin do Wiboor, do `worktrees` e das skills:
// $WIBOOR_API_KEY, senão o ~/.config/wiboor/config.json.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_DEFAULT = 'https://api.azzimuti.com.br/v1';
const CONFIG = process.env.WIBOOR_CONFIG || path.join(os.homedir(), '.config', 'wiboor', 'config.json');
const STATUSES = ['NOT_STARTED', 'STARTED', 'PAUSED', 'FINISHED'];
const TIMEOUT = 15000;

function auth() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {}
  const key = (process.env.WIBOOR_API_KEY || cfg.apiKey || '').trim();
  if (!key) return null;
  return { key, baseUrl: (process.env.WIBOOR_BASE_URL || cfg.baseUrl || BASE_DEFAULT).replace(/\/+$/, '') };
}

/** `{ kind: 'TASK' | 'BUG', number }` de um texto (a branch, o nome), ou null. */
function refOf(text) {
  const m = /\b(TASK|BUG)\s*#?\s*(\d+)\b/i.exec(text || '');
  return m ? { kind: m[1].toUpperCase(), number: Number(m[2]) } : null;
}

async function call(method, url, body) {
  const a = auth();
  if (!a) throw new Error('sem a chave do Wiboor ($WIBOOR_API_KEY ou ~/.config/wiboor/config.json)');
  const res = await fetch(`${a.baseUrl}${url}`, {
    method,
    headers: { Authorization: `Bearer ${a.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'a chave do Wiboor foi recusada (401)' : `o Wiboor respondeu ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

/** A tarefa de [ref]: `{ id, title }`, ou null. */
async function findTask(ref) {
  const q = new URLSearchParams({ search: String(ref.number), count: '20' });
  for (const s of STATUSES) q.append('status[]', s);
  const rows = ((await call('GET', `/tasks?${q}`)) || {}).data || [];
  const same = rows.filter((t) => t.taskNumber === ref.number);
  const t = same.find((x) => (x.type === 'BUG' ? 'BUG' : 'TASK') === ref.kind) || same[0];
  return t ? { id: t.id, title: String(t.title || '') } : null;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Comenta na tarefa [ref] as [parts] (`[[rótulo, texto]]`), em parágrafos. */
async function comment(ref, parts) {
  const t = await findTask(ref);
  if (!t) throw new Error(`não achei a ${ref.kind}#${ref.number} no Wiboor`);
  const html = parts
    .filter(([, text]) => text)
    .map(([label, text]) => `<p><strong>${esc(label)}:</strong> ${esc(text)}</p>`)
    .join('');
  await call('POST', `/tasks/${encodeURIComponent(t.id)}/comments`, { message: html });
  return t;
}

module.exports = { refOf, comment, hasKey: () => !!auth() };
