// O título de uma tarefa do Wiboor pelo número que está na branch
// (`feature/TASK#123`, `hotfix/BUG#123`), pra virar a descrição dela.
//
// A chave é a mesma do plugin do Wiboor e das skills: $WIBOOR_API_KEY, senão o
// ~/.config/wiboor/config.json. Sem ela, este arquivo só não acha nada.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_DEFAULT = 'https://api.azzimuti.com.br/v1';
const CONFIG = process.env.WIBOOR_CONFIG || path.join(os.homedir(), '.config', 'wiboor', 'config.json');
// O filtro de status só aceita estes quatro; a tarefa pode estar em qualquer um.
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

/** `{ kind: 'TASK' | 'BUG', number }` da branch, ou null quando ela não tem id. */
function refOf(branch) {
  const m = /\b(TASK|BUG)#(\d+)\b/i.exec(branch || '');
  return m ? { kind: m[1].toUpperCase(), number: Number(m[2]) } : null;
}

/** O título da tarefa da branch, ou null (sem id, sem chave, não achou). Rejeita quando a API falha. */
async function titleFor(branch) {
  const ref = refOf(branch);
  const a = auth();
  if (!ref || !a) return null;
  const q = new URLSearchParams({ search: String(ref.number), count: '20' });
  for (const s of STATUSES) q.append('status[]', s);
  const res = await fetch(`${a.baseUrl}/tasks?${q}`, {
    headers: { Authorization: `Bearer ${a.key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'a chave do Wiboor foi recusada (401)' : `Wiboor respondeu ${res.status}`);
  const rows = ((await res.json()) || {}).data || [];
  const same = rows.filter((t) => t.taskNumber === ref.number);
  const t = same.find((x) => (x.type === 'BUG' ? 'BUG' : 'TASK') === ref.kind) || same[0];
  return t && t.title ? String(t.title).trim() : null;
}

module.exports = { refOf, titleFor, hasKey: () => !!auth() };
