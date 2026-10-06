// A API pública do Wiboor (api.azzimuti.com.br/v1), só com o fetch do node.
//
// A chave é um JWT que carrega o `userId` de quem a gerou: é daí que sai o "eu"
// do quadro, sem pedir mais nada. Ela é procurada em $WIBOOR_API_KEY e depois no
// ~/.config/wiboor/config.json -- o mesmo arquivo das skills do Wiboor, então a
// chave configurada lá vale aqui, e a colada aqui vale lá.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_DEFAULT = 'https://api.azzimuti.com.br/v1';
const CONFIG = process.env.WIBOOR_CONFIG || path.join(os.homedir(), '.config', 'wiboor', 'config.json');
// Uma página da lista vem com no máximo isso; mais que MAX_PAGES delas é um
// filtro largo demais pra um quadro.
const PAGE = 200;
const MAX_PAGES = 10;
const TIMEOUT = 20000;

// O que o quadro abre por padrão: o filtro de status só aceita estes quatro
// (PENDING, REQUESTED e CANCELED dão 400).
const OPEN = ['NOT_STARTED', 'STARTED', 'PAUSED'];

let auth = null; // { key, baseUrl, userId, email, source }

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

/** O payload do JWT, sem conferir assinatura (quem confere é a API). */
function decode(key) {
  try {
    const part = String(key).trim().split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Lê a chave de novo (a env, depois o arquivo). `null` quando não há. */
function load() {
  const cfg = readConfig();
  const key = (process.env.WIBOOR_API_KEY || cfg.apiKey || '').trim();
  if (!key) {
    auth = null;
    return null;
  }
  const jwt = decode(key) || {};
  auth = {
    key,
    baseUrl: (process.env.WIBOOR_BASE_URL || cfg.baseUrl || BASE_DEFAULT).replace(/\/+$/, ''),
    userId: jwt.userId || null,
    email: jwt.email || null,
    exp: jwt.exp ? jwt.exp * 1000 : null,
    source: process.env.WIBOOR_API_KEY ? 'env' : 'config',
  };
  return auth;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(method, route, body, key, signal) {
  const a = key ? { key, baseUrl: (auth && auth.baseUrl) || BASE_DEFAULT } : auth;
  if (!a) throw new ApiError('sem chave da API do Wiboor', 0);
  let res;
  try {
    res = await fetch(a.baseUrl + route, {
      method,
      headers: {
        Authorization: `Bearer ${a.key}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    // Cancelada por quem pediu (o filtro mudou no meio): não é erro do Wiboor.
    if (signal && signal.aborted) throw new ApiError('cancelada', -1);
    throw new ApiError(`sem resposta do Wiboor (${(e && e.message) || e})`, 0);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    // O NestJS manda { message: string | string[], statusCode }.
    const m = json && json.message;
    const why = Array.isArray(m) ? m.join('; ') : m || text.slice(0, 200) || res.statusText;
    throw new ApiError(res.status === 401 ? 'a chave foi recusada (401)' : `${res.status}: ${why}`, res.status);
  }
  return json;
}

/** Confere a chave e grava no config das skills (chmod 600), mantendo o resto dele. */
async function saveKey(key) {
  key = String(key || '').trim();
  const jwt = decode(key);
  if (!jwt || !jwt.userId) throw new ApiError('isso não parece uma chave do Wiboor (um JWT com userId)', 0);
  await call('GET', '/departments', undefined, key);
  const cfg = readConfig();
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(
    CONFIG,
    JSON.stringify({ ...cfg, apiKey: key, authHeader: 'Authorization', authScheme: 'Bearer ', baseUrl: cfg.baseUrl || BASE_DEFAULT }, null, 2),
    { mode: 0o600 },
  );
  fs.chmodSync(CONFIG, 0o600);
  return load();
}

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) q.append(`${k}[]`, x);
    else q.append(k, String(v));
  }
  return q.toString();
}

// As finalizadas de poucos dias de uma pessoa cabem quase sempre numa página
// desta; as de um espaço inteiro passam, e as próximas vêm de BURST em BURST.
// (O servidor custa bem mais por página grande com o join: 50 é o que anda.)
const RECENT_PAGE = 50;
const BURST = 3;

/**
 * As tarefas de um filtro, todas as páginas. `join` traz o checklist e os
 * comentários junto (os dois de uma vez só funcionam como array).
 *
 * A primeira página diz quantas são; as outras vão todas juntas. Com `since`
 * (as finalizadas dos últimos dias) é o contrário: a lista vem da finalizada
 * mais recente pra mais antiga (o `order` e o `startDate` são ignorados, mas
 * essa ordem é a de sempre), então as páginas vão em lotes pequenos e param no
 * que passa da data -- em vez de trazer as milhares de finalizadas de sempre.
 */
async function tasks({ executor, requester, department, statuses = OPEN, join = true, search, since, signal } = {}) {
  const params = {
    userExecutorId: executor,
    userRequesterId: requester,
    // O escalar `departmentId` é aceito e ignorado: o filtro é o array.
    departmentIds: department ? [department] : undefined,
    status: statuses,
    join: join ? ['checklist', 'comments'] : undefined,
    search,
    count: since ? RECENT_PAGE : PAGE,
  };
  const get = (page) => call('GET', `/tasks?${query({ ...params, page })}`, undefined, undefined, signal);
  const rows = (r) => (r && r.data) || [];
  const first = await get(1);
  const last = Math.min(MAX_PAGES, (first && first.pagination && first.pagination.lastPage) || 1);
  const out = rows(first);
  if (since) {
    const old = (list) => {
      const t = list.length && list[list.length - 1].finishedAt;
      return !t || new Date(t).getTime() < since;
    };
    for (let page = 2; page <= last && !old(out); page += BURST) {
      const burst = Array.from({ length: Math.min(BURST, last - page + 1) }, (_, i) => get(page + i));
      for (const r of await Promise.all(burst)) out.push(...rows(r));
    }
    return out.filter((t) => t.finishedAt && new Date(t.finishedAt).getTime() >= since);
  }
  const rest = await Promise.all(Array.from({ length: last - 1 }, (_, i) => get(i + 2)));
  for (const r of rest) out.push(...rows(r));
  return out;
}

/**
 * Uma tarefa inteira: o GET dela, mais o checklist e os comentários (que só a
 * lista traz). Com o número já conhecido (`number`), os dois vão juntos.
 */
async function task(id, number) {
  const extras = (n) =>
    call('GET', `/tasks?${query({ search: n, join: ['checklist', 'comments'], count: 20 })}`).catch(() => null); // sem os extras a janela ainda mostra a tarefa
  const [t, early] = await Promise.all([call('GET', `/tasks/${encodeURIComponent(id)}`), number ? extras(number) : null]);
  const r = early || (await extras(t.taskNumber));
  const row = ((r && r.data) || []).find((x) => x.id === t.id);
  if (row) {
    t.checklist = row.checklist || [];
    t.comments = row.comments || [];
  }
  return t;
}

const departments = () => call('GET', '/departments');
const start = (id) => call('POST', `/tasks/${encodeURIComponent(id)}/start`, {});
const pause = (id) => call('POST', `/tasks/${encodeURIComponent(id)}/pause`, {});
const end = (id) => call('POST', `/tasks/${encodeURIComponent(id)}/end`, {});
const comment = (id, message) => call('POST', `/tasks/${encodeURIComponent(id)}/comments`, { message });
const checklistAdd = (id, description) => call('POST', `/tasks/${encodeURIComponent(id)}/checklist`, { description });
const check = (id, item, on) =>
  call('POST', `/tasks/${encodeURIComponent(id)}/checklist/${encodeURIComponent(item)}/${on ? 'check' : 'uncheck'}`, {});
const create = (body) => call('POST', '/tasks', body);

module.exports = {
  CONFIG,
  OPEN,
  ApiError,
  load,
  saveKey,
  get auth() {
    return auth;
  },
  tasks,
  task,
  departments,
  start,
  pause,
  end,
  comment,
  checklistAdd,
  check,
  create,
};
