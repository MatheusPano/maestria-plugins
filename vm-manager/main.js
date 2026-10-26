'use strict';

// O VM Manager na Maestria: a cola entre o protocolo (`mx`) e os módulos puros de
// lib/. Uma janela principal ('vmm', em widgets) com a lateral do CCS Console e
// uma tela por área; formulários, gavetas e confirmações são janelas de blocos
// (em modal quando a Maestria tem). Nunca escreva no stdout: é o protocolo.
//
// Para as áreas (Tasks 6+): `registerScreen(id, { load, view, onAction, onEnter,
// onLeave })` liga uma tela; `on('verbo', fn)` atende as ações "verbo:arg";
// `render()` redesenha; `openWindow`/`updateWindow`/`closeWindow` cuidam das
// janelas de blocos; `banner(text)` dá o recado. Veja `ctx()`.
//
// Nos `values` da janela principal, `a` e `action` são reservados: um
// `event "act" { a: "verbo:arg" }` e o `onMenu` de um `Pressable` (que põe a
// escolha em `action`) roteiam por eles. Nas janelas de blocos vale só a
// `action` do botão, e os campos podem ter qualquer id.
//
// Os pollers só correm com a janela principal aberta: o `onEnter` de uma tela
// (onde ela liga os dela) só roda com a janela na tela, e roda de novo quando
// ela reabre; um `view.update` com `open: false` para todos.

const fs = require('fs');
const os = require('os');
const path = require('path');
const mx = require('./maestria');
const { createSession } = require('./lib/session');
const { createTokenStore } = require('./lib/auth');
const { startLoopback } = require('./lib/loopback');
const { ApiError } = require('./lib/http');
const { navFor, gate, initials, ROLE_LABEL, FORBIDDEN_TEXT } = require('./lib/nav');
const { createPoller } = require('./lib/poller');

const MAIN = 'vmm';
const TITLE = 'VM Manager';
const UI_DIR = path.join(__dirname, 'ui');
const SHELL = 'shell.rfwtxt';
const DEFAULT_URL = 'https://vm-manager.cefis.cloud';
const EXPIRED = 'Sua sessão expirou. Entre de novo.';
const PENDING_TEXT = 'Acesso pendente de aprovação.';

const OUTDATED = [
  { type: 'heading', text: 'Este Maestria não desenha a tela do VM Manager' },
  { type: 'text', text: 'As telas do plugin precisam de uma versão do Maestria com widgets (rfw). Atualize o app e abra de novo.' },
];

// Os ícones da lateral (os da web são do lucide; aqui, os da tabela da Maestria).
const NAV_ICON = { vms: 'device', create: 'add', ceph: 'drive', buckets: 'box', routes: 'network', users: 'user', audit: 'report' };

const state = {
  caps: { rfw: false, modal: false },
  dataDir: '',
  settings: {},
  url: DEFAULT_URL,
  session: null,
  screen: 'vms', // a tela na vista: uma área ou login/pending/fatal/forbidden
  target: 'vms', // a última área pedida, pra onde o login e o "tentar de novo" voltam
  login: { message: '', busy: false },
  fatal: '',
  mainOpen: false,
  poller: createPoller({
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  }),
  views: new Set(), // as janelas de blocos abertas (formulários, gavetas, confirmações)
  lb: null, // o servidor do loopback do login em andamento
};

const screens = new Map();
const routes = new Map();

// --- utilidades --------------------------------------------------------------------

const setting = (id, fallback) => (state.settings[id] === undefined || state.settings[id] === '' ? fallback : state.settings[id]);
const urlSetting = () => String(setting('url', DEFAULT_URL)).trim().replace(/\/+$/, '') || DEFAULT_URL;
const errText = (e) => String((e && e.message) || e);
const isUnauthorized = (e) => e instanceof ApiError && e.status === 401;

/** O RFW não aceita null no `data`: o que escapar vira ''. Rede de segurança; as telas já mandam sem. */
function scrub(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(scrub);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x);
    return out;
  }
  return v;
}

function guard(what, fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((e) => mx.log(`${what}:`, errText(e)));
  } catch (e) {
    mx.log(`${what}:`, errText(e));
  }
}

function banner(text) {
  return mx.request('window.showBanner', { text }).catch(() => {});
}

/** A biblioteca RFW: a casca primeiro (com os imports) e depois as telas, sem imports. */
function library() {
  const extra = fs
    .readdirSync(UI_DIR)
    .filter((f) => f.endsWith('.rfwtxt') && f !== SHELL)
    .sort();
  return [SHELL, ...extra].map((f) => fs.readFileSync(path.join(UI_DIR, f), 'utf8')).join('\n');
}

// --- a sessão ----------------------------------------------------------------------

/** O loopback do login, guardado pra fechar no shutdown. */
async function trackedLoopback(opts) {
  const lb = await startLoopback(opts);
  const tracked = {
    ...lb,
    close() {
      if (state.lb === tracked) state.lb = null;
      lb.close();
    },
  };
  state.lb = tracked;
  return tracked;
}

function buildSession() {
  if (state.lb) state.lb.close();
  const s = createSession({
    url: state.url,
    store: createTokenStore(path.join(state.dataDir, 'auth.json')),
    fetch: globalThis.fetch,
    // Sem logar o endereço: ele leva o state e o challenge do login.
    openUrl: (u) => mx.request('window.openUrl', { url: u }).catch((e) => mx.log('não abriu o navegador:', errText(e))),
    startLoopback: trackedLoopback,
  });
  s.on('expired', () => {
    if (s === state.session) onExpired();
  });
  s.on('changed', () => {
    if (s === state.session) render();
  });
  state.session = s;
  return s;
}

// --- as telas e o contexto ------------------------------------------------------------

/**
 * Liga uma tela da janela principal. Todas as funções são opcionais e recebem `ctx()`:
 * - `load(ctx)`: busca os dados ao entrar na tela (e no "tentar de novo"); um erro
 *   que não é 401 leva à tela `fatal`.
 * - `view(ctx)`: o objeto que vai em `data[id]` (sem null).
 * - `onAction(action, values, ctx)`: as ações da janela principal que nenhum `on()` atende.
 * - `onEnter(ctx)` / `onLeave(ctx)`: ao entrar e sair (ligar e desligar os pollers).
 * - `open(ctx)`: só pra `create`, que é uma janela e não uma tela (Task 8).
 */
function registerScreen(id, spec) {
  screens.set(id, spec || {});
}

/** Atende as ações "verbo:arg" de qualquer janela: `handler(arg, values, { viewId, action })`. */
function on(prefix, handler) {
  routes.set(prefix, handler);
}

function ctx() {
  return {
    api: state.session.api,
    user: state.session.user(),
    now: Date.now,
    poller: state.poller,
    render,
    openWindow,
    updateWindow,
    closeWindow,
    banner,
    navigate,
    mx,
  };
}

function buildData() {
  const user = state.session ? state.session.user() : null;
  const showNav = user && user.role !== 'pending';
  const nav = showNav
    ? navFor(user.role).map((g) => ({
        group: g.group,
        items: g.items.map((i) => ({ ...i, icon: NAV_ICON[i.id] || 'dot', active: i.id === state.screen })),
      }))
    : [];
  const name = user ? user.name || user.email || '' : '';
  const data = {
    screen: state.screen,
    nav,
    me: {
      initials: user ? initials(name) : '',
      name,
      email: user ? user.email || '' : '',
      role: user ? ROLE_LABEL[user.role] || '' : '',
    },
    login: { message: state.login.message, busy: state.login.busy },
    fatal: { message: state.fatal },
  };
  const scr = screens.get(state.screen);
  if (scr && scr.view) {
    try {
      data[state.screen] = scr.view(ctx());
    } catch (e) {
      mx.log(`view ${state.screen}:`, errText(e));
    }
  }
  return scrub(data);
}

/** Redesenha a janela principal. Fechada (`open: false`), para todos os pollers. */
async function render() {
  if (!state.caps.rfw || !state.mainOpen || !state.session) return;
  let res;
  try {
    res = await mx.request('view.update', { viewId: MAIN, data: buildData() });
  } catch (e) {
    mx.log('view.update:', errText(e));
    return;
  }
  if (res && res.open === false) {
    state.mainOpen = false;
    state.poller.stopAll();
  }
}

/** O onEnter da tela na vista, só com a janela principal aberta (é onde os pollers ligam). */
function enterScreen() {
  if (!state.mainOpen) return;
  const scr = screens.get(state.screen);
  if (scr && scr.onEnter) guard(`onEnter ${state.screen}`, () => scr.onEnter(ctx()));
}

/** Troca a tela na vista, com o onLeave da que sai e o onEnter da que entra. */
function switchTo(dest, { force = false } = {}) {
  if (state.screen === dest && !force) return;
  const old = screens.get(state.screen);
  if (old && old.onLeave) guard(`onLeave ${state.screen}`, () => old.onLeave(ctx()));
  state.screen = dest;
  enterScreen();
}

/** Mostra uma tela e carrega o que ela precisa. */
async function show(dest) {
  switchTo(dest);
  await render();
  const scr = screens.get(dest);
  if (!scr || !scr.load) return;
  try {
    await scr.load(ctx());
  } catch (e) {
    if (state.screen !== dest || isUnauthorized(e)) return; // o 401 já levou ao login
    state.fatal = errText(e);
    switchTo('fatal');
  }
  await render();
}

/** Vai pra uma área: confere quem é (`/auth/me`), passa pelo gating e mostra. */
async function navigate(to) {
  const s = state.session;
  const target = String(to || state.target);
  if (target !== 'create') state.target = target;
  if (!s.isLoggedIn()) {
    switchTo('login');
    return render();
  }
  try {
    await s.refreshMe();
  } catch (e) {
    if (s !== state.session) return;
    if (isUnauthorized(e)) {
      if (!s.isLoggedIn() && state.screen !== 'login') {
        switchTo('login');
        await render();
      }
      return;
    }
    state.fatal = errText(e);
    switchTo('fatal');
    return render();
  }
  if (s !== state.session) return;
  const dest = gate(s.user(), target);
  if (dest === 'create') return openCreate();
  // `nova vm…` com a janela fechada: sem tela pra mostrar o porquê, o recado.
  if (target === 'create' && !state.mainOpen && (dest === 'forbidden' || dest === 'pending')) {
    return banner(dest === 'forbidden' ? FORBIDDEN_TEXT : PENDING_TEXT);
  }
  return show(dest);
}

/** "Nova VM" é uma janela por cima, não uma tela (Task 8). */
async function openCreate() {
  const scr = screens.get('create');
  if (scr && scr.open) return scr.open(ctx());
  return banner('vm-manager: a criação de VM ainda não chegou neste plugin');
}

// --- as janelas de blocos ------------------------------------------------------------

/** Abre (ou traz pra frente) uma janela de blocos; em modal só se a Maestria tem. */
async function openWindow(viewId, title, blocks, { modal = true } = {}) {
  const params = { viewId, title, blocks };
  if (modal && state.caps.modal) params.modal = true;
  state.views.add(viewId);
  return mx.request('view.open', params);
}

/** Troca o conteúdo de uma janela de blocos; devolve false se ela já fechou. */
async function updateWindow(viewId, { title, blocks } = {}) {
  const params = { viewId };
  if (title !== undefined) params.title = title;
  if (blocks !== undefined) params.blocks = blocks;
  try {
    const res = await mx.request('view.update', params);
    if (res && res.open === false) {
      state.views.delete(viewId);
      return false;
    }
    return true;
  } catch (e) {
    mx.log('view.update:', errText(e));
    return false;
  }
}

async function closeWindow(viewId) {
  state.views.delete(viewId);
  await mx.request('view.close', { viewId }).catch(() => {});
}

async function closeWindows() {
  for (const viewId of [...state.views]) await closeWindow(viewId);
}

// --- abrir, entrar e sair --------------------------------------------------------------

async function openMain() {
  if (!state.caps.rfw) {
    await mx.request('view.open', { viewId: MAIN, title: TITLE, blocks: OUTDATED });
    return;
  }
  const s = state.session;
  const dest = s.isLoggedIn() ? gate(s.user(), state.target) : 'login';
  // Abre sempre do zero: a janela pode ter fechado sem a gente saber.
  state.poller.stopAll();
  const old = screens.get(state.screen);
  if (old && old.onLeave) guard(`onLeave ${state.screen}`, () => old.onLeave(ctx()));
  state.screen = dest;
  await mx.request('view.open', { viewId: MAIN, title: TITLE, rfw: { library: library(), root: 'root' }, data: buildData() });
  state.mainOpen = true;
  enterScreen();
  if (s.isLoggedIn()) await navigate(state.target);
}

async function doLogin() {
  const s = state.session;
  if (state.login.busy) return;
  state.login = { message: '', busy: true };
  switchTo('login');
  await render();
  const r = await s.login();
  if (s !== state.session) return; // o url mudou no meio
  state.login = { message: r.ok ? '' : r.message || '', busy: false };
  if (!r.ok) return render();
  return navigate(state.target);
}

async function doLogout() {
  state.session.logout();
  state.poller.stopAll();
  await closeWindows();
  state.login = { message: '', busy: false };
  state.target = 'vms';
  switchTo('login');
  await render();
}

function onExpired() {
  state.poller.stopAll();
  closeWindows();
  state.login = { message: EXPIRED, busy: false };
  switchTo('login');
  render();
}

// --- as ações -------------------------------------------------------------------------

on('nav', (arg, values) => navigate(values.to || arg));
on('login', () => doLogin());
on('logout', () => doLogout());
on('retry', () => navigate(state.target));

// --- as telas das áreas ------------------------------------------------------------------
// (Tasks 6+: registerScreen('vms', …), registerScreen('ceph', …), …)

// --- o protocolo -----------------------------------------------------------------------

mx.onRequest('initialize', (params) => {
  state.caps = { rfw: Number(params.rfw) >= 1, modal: Number(params.modal) >= 1 };
  state.dataDir = params.dataDir || path.join(os.homedir(), '.maestria', 'data', 'maestria.vm-manager');
  state.settings = params.settings || {};
  state.url = urlSetting();
  buildSession();
  return {};
});

mx.onNotification('settings.changed', async ({ settings }) => {
  state.settings = settings || {};
  const url = urlSetting();
  if (url === state.url) return;
  // O token do console antigo não vale aqui (a sessão nem o enxerga): volta pro login.
  state.url = url;
  state.poller.stopAll();
  await closeWindows();
  buildSession();
  state.login = { message: '', busy: false };
  state.target = 'vms';
  switchTo('login');
  await render();
});

mx.onRequest('command.invoke', ({ command }) => {
  // Responde na hora e trabalha depois: o command.invoke tem 30s, e o login espera o navegador.
  const run = (fn) =>
    Promise.resolve()
      .then(fn)
      .catch((e) => {
        mx.log(command, errText(e));
        banner(`vm-manager: ${errText(e)}`);
      });
  if (command === 'abrir') run(openMain);
  else if (command === 'entrar') {
    run(async () => {
      await openMain();
      if (state.caps.rfw && !state.session.isLoggedIn()) await doLogin();
    });
  } else if (command === 'sair') run(doLogout);
  else if (command === 'nova') {
    run(async () => {
      if (!state.caps.rfw || !state.session.isLoggedIn()) return openMain();
      return navigate('create');
    });
  } else throw new Error(`comando desconhecido: ${command}`);
  return null;
});

mx.onNotification('view.action', async ({ viewId, action, values }) => {
  const vals = values || {};
  // Na janela principal, `values.a` (event "act") e `values.action` (onMenu do
  // Pressable) mandam; numa janela de blocos, só a `action` do botão.
  const act = String((viewId === MAIN && (vals.a || vals.action)) || action || '');
  const i = act.indexOf(':');
  const verb = i < 0 ? act : act.slice(0, i);
  const arg = i < 0 ? '' : act.slice(i + 1);
  try {
    const handler = routes.get(verb);
    if (handler) return await handler(arg, vals, { viewId, action: act });
    const scr = screens.get(state.screen);
    if (viewId === MAIN && scr && scr.onAction) return await scr.onAction(act, vals, ctx());
    mx.log('ação desconhecida:', act);
  } catch (e) {
    mx.log(`ação ${verb}:`, errText(e));
    banner(`vm-manager: ${errText(e)}`);
  }
});

mx.onNotification('event', (e) => {
  if (e && e.type === 'view.closed') state.views.delete(e.viewId);
});

function shutdown() {
  state.poller.stopAll();
  if (state.lb) state.lb.close();
}

mx.onNotification('shutdown', () => {
  shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

mx.start();

// Pras telas das áreas e pros testes (o smoke test liga telas de mentira por aqui).
module.exports = { state, registerScreen, on, render, navigate, openWindow, updateWindow, closeWindow, banner, ctx, MAIN };
