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
const { vmsView, overviewView, detailWindowBlocks, destroyBlocks, createBusy, flex } = require('./lib/vms');
const { cephView, defaultPool } = require('./lib/storage');
const bk = require('./lib/buckets');
const cf = require('./lib/create-form');
const { createCreateFlow } = require('./lib/create-flow');
const rt = require('./lib/routes');
const adm = require('./lib/admin');

const MAIN = 'vmm';
const TITLE = 'VM Manager';
const UI_DIR = path.join(__dirname, 'ui');
const SHELL = 'shell.rfwtxt';
const DEFAULT_URL = 'https://vm-manager.cefis.cloud';
const EXPIRED = 'Sua sessão expirou. Entre de novo.';
const PENDING_TEXT = 'Acesso pendente de aprovação.';

// Ganchos só pros testes (o smoke test encurta os tempos pelo ambiente). Sem eles,
// os valores da web: o POST /vms espera 90 s e a criação é consultada a cada 5 s.
const envMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const CREATE_TIMEOUT_MS = envMs('VMM_CREATE_TIMEOUT_MS', 90000);
const CREATE_POLL_MS = envMs('VMM_CREATE_POLL_MS', 5000);
const VMS_MS = 10000;
const OVERVIEW_MS = 15000;

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
    apiOptions: { createTimeoutMs: CREATE_TIMEOUT_MS },
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
      windowGone(viewId);
      return false;
    }
    return true;
  } catch (e) {
    mx.log('view.update:', errText(e));
    return false;
  }
}

/** Uma janela de blocos que fechou (por nós ou pelo usuário): larga o que era só dela. */
function windowGone(viewId) {
  state.views.delete(viewId);
  forgetWindow(viewId);
  routeWindowGone(viewId);
}

async function closeWindow(viewId) {
  windowGone(viewId);
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
  // Um token guardado que já venceu: o authHeader o apaga e avisa (o "Sua sessão expirou").
  if (!s.isLoggedIn()) await s.authHeader();
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

// O que as áreas guardaram de quem estava logado (a lista, o destruir pela metade).
// A criação em curso é largada (`flow.abandon()`): para de acompanhar, sem banner pra
// uma sessão que acabou; a VM, se sair, aparece na lista de quem entrar depois.
function forgetAreas() {
  Object.assign(vmsState, { vms: [], loading: true, error: '', overview: null, destroy: null });
  flow.abandon();
  create.gen++; // um catálogo que ainda chega é de quem saiu
  Object.assign(create, { form: null, options: null, bridge: '', loading: false, loadError: '', ip: freshIp(), errors: [], flowError: '', validating: false });
  forgetStorage(); // Ceph, buckets, o "Novo bucket" e as credenciais (com as secret keys)
  forgetRoutes(); // a lista, a "Nova rota", a remoção e o acompanhamento dos jobs
  forgetAdmin(); // os usuários e a auditoria
}

async function doLogout() {
  state.session.logout();
  state.poller.stopAll();
  forgetAreas();
  await closeWindows();
  state.login = { message: '', busy: false };
  state.target = 'vms';
  switchTo('login');
  await render();
}

function onExpired() {
  state.poller.stopAll();
  jobPoller.stopAll();
  // Antes de fechar as janelas: sem a sessão não há o que acompanhar, e o "continua em segundo
  // plano" de uma rota não vem junto com o recado de sessão expirada.
  wizard = null;
  removal = null;
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

const api = () => state.session.api;
const isAdmin = (user) => !!user && user.role === 'admin';
const currentAdmin = () => !!state.session && isAdmin(state.session.user());

// Máquinas virtuais (VmDashboard.tsx + OverviewBar.tsx). A lista vem a cada 10 s e
// o overview a cada 15 s, só com a janela principal aberta; o erro do overview é
// ignorado, como na web. Cada ação de linha passa pela trava por VM (`busy`).

const vmsState = { vms: [], loading: true, error: '', query: '', filter: 'all', overview: null, destroy: null };
const busy = createBusy();

async function loadVms() {
  try {
    const list = await api().vms();
    vmsState.vms = Array.isArray(list) ? list : [];
    vmsState.error = '';
  } catch (e) {
    if (!isUnauthorized(e)) vmsState.error = errText(e); // o 401 já leva ao login
  } finally {
    vmsState.loading = false;
  }
}

async function loadOverview() {
  try {
    vmsState.overview = await api().overview();
  } catch {
    // como na web: o overview some quieto
  }
}

const vmById = (vmid) => vmsState.vms.find((v) => v.vmid === vmid);

/** Liga/desliga/backup/HA/destruir: uma por VM, recarrega a lista e põe o erro na tela. */
async function runRowAction(vmid, kind, call) {
  if (busy.get(vmid)) return;
  const vm = vmById(vmid);
  vmsState.error = '';
  const p = busy.run(
    vmid,
    kind,
    async () => {
      await call();
      await loadVms();
    },
    { name: vm ? vm.name : String(vmid) },
  );
  render(); // mostra o "Aguarde…"
  const r = await p;
  if (r.ran && r.error) vmsState.error = r.error;
  await render();
}

const BUSY_DESTROY = 'essa VM ainda está no meio de outra ação; espere terminar e confirme de novo.';

const ROW_CALLS = { start: 'startVm', stop: 'stopVm', backup: 'backupVm', ha: 'haVm' };

/** A gaveta de detalhes: "Carregando…", uma busca, e as seções (ou o erro em vermelho). */
async function openDetail(vmid) {
  const viewId = `vm:${vmid}`;
  const vm = vmById(vmid);
  await openWindow(viewId, vm ? vm.name : `VM ${vmid}`, detailWindowBlocks({ loading: true }));
  let blocks;
  try {
    blocks = detailWindowBlocks({ detail: await api().vm(vmid) });
  } catch (e) {
    blocks = detailWindowBlocks({ error: errText(e) });
  }
  await updateWindow(viewId, { blocks });
}

async function openDestroy(vmid) {
  const vm = vmById(vmid);
  if (!vm) return;
  vmsState.destroy = { vmid, name: vm.name, error: '', typed: '' };
  await openWindow('vm:destroy', 'Destruir VM', destroyBlocks(vmsState.destroy));
}

async function confirmDestroy(vmid, values) {
  const d = vmsState.destroy;
  if (!d || d.vmid !== vmid) return; // já foi (um enter atrasado) ou é de outra VM
  d.typed = String(values.confirm || '');
  if (d.typed.trim() !== d.name) {
    d.error = `Digite ${d.name} para confirmar.`;
    await updateWindow('vm:destroy', { blocks: destroyBlocks(d) });
    return;
  }
  if (busy.get(vmid)) {
    // Outra ação (ligar, desligar…) ainda corre nesta VM: diz na janela em vez de engolir.
    d.error = BUSY_DESTROY;
    await updateWindow('vm:destroy', { blocks: destroyBlocks(d) });
    return;
  }
  vmsState.destroy = null;
  await closeWindow('vm:destroy');
  await runRowAction(vmid, 'destroy', () => api().destroyVm(vmid));
}

on('vm', async (arg, values) => {
  const i = arg.indexOf(':');
  const kind = i < 0 ? arg : arg.slice(0, i);
  const rest = i < 0 ? '' : arg.slice(i + 1);
  const vmid = Number(rest || values.vmid);
  if (kind === 'filter') {
    vmsState.filter = rest || values.filter || 'all';
    return render();
  }
  if (kind === 'search') {
    vmsState.query = String(values.text === undefined ? '' : values.text);
    return render();
  }
  if (!Number.isFinite(vmid)) return;
  if (kind === 'open') return openDetail(vmid);
  if (kind === 'cancel') {
    vmsState.destroy = null;
    return closeWindow('vm:destroy');
  }
  // Daqui pra baixo é escrita: só admin (o viewer nem vê os botões).
  if (!currentAdmin()) return;
  if (kind === 'destroy') return openDestroy(vmid);
  if (kind === 'confirm') return confirmDestroy(vmid, values);
  if (ROW_CALLS[kind]) return runRowAction(vmid, kind, () => api()[ROW_CALLS[kind]](vmid));
  mx.log('ação de vm desconhecida:', kind);
});

registerScreen('vms', {
  // `ctx.user` pode ser null (um render logo depois do sair): aí é só leitura.
  view: (c) => ({
    ...vmsView({ ...vmsState, busy: busy.snapshot() }, { admin: isAdmin(c.user), now: c.now() }),
    overview: overviewView(vmsState.overview),
  }),
  onEnter: (c) => {
    c.poller.loop('vms', VMS_MS, async () => {
      await loadVms();
      await render();
      return state.mainOpen;
    });
    c.poller.loop('overview', OVERVIEW_MS, async () => {
      await loadOverview();
      await render();
      return state.mainOpen;
    });
  },
  onLeave: (c) => {
    c.poller.stop('vms');
    c.poller.stop('overview');
  },
});

// Nova VM (CreateVmForm.tsx), uma janela de blocos em modal. O POST sai uma vez só
// pelo `flow` (lib/create-flow.js), que é um por processo: um `create:submit` ou um
// `nova vm…` com a criação andando só redesenha o estado dela.

const flow = createCreateFlow({
  api: {
    createVm: (body) => api().createVm(body),
    vmCreation: (name) => api().vmCreation(name),
    vms: () => api().vms(),
  },
  now: Date.now,
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  pollMs: CREATE_POLL_MS,
});

const freshIp = () => ({ auto: { cidr: '', loading: false }, check: null, checking: false, suggestEmpty: false, suggestError: '' });
const create = {
  gen: 0, form: null, options: null, bridge: '', loading: false, loadError: '',
  ip: freshIp(), errors: [], flowError: '', validating: false,
};

function createView() {
  const st = flow.state();
  return {
    phase: st.phase,
    form: create.form,
    options: create.options,
    bridge: create.bridge,
    loading: create.loading,
    loadError: create.loadError,
    ip: create.ip,
    errors: create.errors,
    flowError: create.flowError,
    result: st.result,
    name: st.name,
    message: st.error,
  };
}

/** Redesenha a "Nova VM" (ou a abre, com `open`); devolve false se ela não está aberta. */
async function renderCreate({ open = false } = {}) {
  const st = flow.state();
  if (st.phase === 'rejected' || st.phase === 'failed') {
    // A recusa volta pro formulário, com o erro em cima, e libera um novo envio.
    create.flowError = st.error;
    create.errors = [];
    flow.reset();
  }
  const blocks = cf.createBlocks(createView());
  if (open) {
    await openWindow('create', 'Nova VM', blocks);
    return true;
  }
  if (!state.views.has('create')) return false;
  return updateWindow('create', { blocks });
}

function announce(st) {
  if (st.phase === 'succeeded') return banner(`VM ${st.name} criada.`);
  if (st.phase === 'failed' || st.phase === 'rejected') return banner(`Falhou ao criar ${st.name}: ${st.error}`);
  if (st.phase === 'unconfirmed') return banner(st.error);
  return null;
}

flow.onChange((st) => {
  if (st.phase === 'idle') return; // o reset é nosso, e quem resetou redesenha
  guard('nova vm', async () => {
    const shown = await renderCreate();
    if (!shown) announce(st); // janela fechada: o fim da criação vira banner
  });
});

async function fetchAutoIp({ quiet = false } = {}) {
  const gw = String(create.form.gateway).trim();
  if (!cf.IPV4.test(gw)) {
    create.ip.auto = { cidr: '', loading: false };
    return quiet ? null : renderCreate();
  }
  if (!quiet) {
    create.ip.auto = { cidr: create.ip.auto.cidr, loading: true };
    await renderCreate();
  }
  let cidr = '';
  try {
    const free = await api().ipamNextFree(gw);
    cidr = (Array.isArray(free) && free[0]) || '';
  } catch {
    // sem IP livre / NetBox off
  }
  create.ip.auto = { cidr, loading: false };
  return quiet ? null : renderCreate();
}

async function checkIp() {
  const ip = String(create.form.ipCidr).trim();
  create.ip.suggestEmpty = false;
  create.ip.check = null;
  if (!cf.IPV4_CIDR.test(ip)) return renderCreate();
  create.ip.checking = true;
  await renderCreate();
  try {
    create.ip.check = await api().ipamCheck(ip);
  } catch {
    create.ip.check = null;
  }
  create.ip.checking = false;
  return renderCreate();
}

async function suggestIp() {
  create.ip.suggestEmpty = false;
  create.ip.suggestError = '';
  try {
    const free = await api().ipamNextFree(String(create.form.gateway).trim() || undefined);
    if (Array.isArray(free) && free[0]) {
      create.form = { ...create.form, ipCidr: free[0] };
      create.ip.check = null;
    } else create.ip.suggestEmpty = true;
  } catch (e) {
    create.ip.suggestError = errText(e);
  }
  return renderCreate();
}

async function submitCreate() {
  // Com uma criação andando (ou a anterior ainda validando), só mostra o estado dela.
  if (flow.state().phase !== 'idle' || create.validating) return renderCreate();
  create.validating = true;
  try {
    const f = create.form;
    if (!f.ipAuto) {
      const ip = String(f.ipCidr).trim();
      if (cf.IPV4_CIDR.test(ip)) {
        try {
          create.ip.check = await api().ipamCheck(ip);
        } catch {
          create.ip.check = null;
        }
      }
    } else if (!create.ip.auto.cidr) {
      await fetchAutoIp({ quiet: true });
    }
    create.flowError = '';
    create.errors = cf.validate(f, { auto: { cidr: create.ip.auto.cidr }, manual: create.ip.check });
    if (create.errors.length) return renderCreate();
    flow.submit(cf.buildBody(f)); // a fase vira `submitting` aqui mesmo; o onChange redesenha
  } finally {
    create.validating = false;
  }
  return null;
}

/** `nova vm…` e o "Nova VM": a criação em curso, se houver; senão um formulário novo. */
async function openCreateWindow() {
  const phase = flow.state().phase;
  if (phase !== 'idle' || (create.form && (create.flowError || state.views.has('create')))) {
    return renderCreate({ open: true });
  }
  const gen = ++create.gen;
  Object.assign(create, { form: null, options: null, bridge: '', loading: true, loadError: '', ip: freshIp(), errors: [], flowError: '' });
  await renderCreate({ open: true });
  try {
    const a = api();
    const [d, nodes, templates, storages] = await Promise.all([a.catalogDefaults(), a.catalogNodes(), a.catalogTemplates(), a.catalogStorages()]);
    if (gen !== create.gen) return null;
    create.form = cf.applyDefaults(cf.initialForm(), d);
    create.options = cf.optionsFrom({ nodes, storages, templates });
    create.bridge = (d && d.networkBridge) || '';
  } catch (e) {
    if (gen !== create.gen) return null;
    create.loadError = errText(e);
  }
  create.loading = false;
  await renderCreate();
  if (create.form && create.form.ipAuto) await fetchAutoIp();
  return null;
}

on('create', async (arg, values) => {
  if (arg === 'done') {
    flow.reset();
    await closeWindow('create');
    state.target = 'vms';
    // Aberta pelo `nova vm…` com a janela principal fechada: abre ela na lista.
    if (!state.mainOpen) return openMain();
    return navigate('vms');
  }
  if (arg === 'back') {
    flow.reset();
    return renderCreate();
  }
  if (!create.form || !currentAdmin()) return; // ainda carregando
  create.form = cf.mergeValues(create.form, values); // o redesenho não apaga o que foi digitado
  if (arg === 'submit') return submitCreate();
  if (arg === 'ipmode') {
    create.ip = { ...freshIp(), auto: create.ip.auto };
    if (create.form.ipAuto && !create.ip.auto.cidr) return fetchAutoIp();
    return renderCreate();
  }
  if (arg === 'nextfree') return fetchAutoIp();
  if (arg === 'check') return checkIp();
  if (arg === 'suggest') return suggestIp();
  return null;
});

registerScreen('create', { open: () => openCreateWindow() });

// Ceph (CephView.tsx). Carrega uma vez ao entrar: health, pools e lixeira juntos (o
// erro do health some quieto, como na web), depois as imagens do maior pool rbd.
// Sem polling. `ceph:pool:<nome>` troca o pool e recarrega as imagens.

const freshCeph = () => ({
  gen: 0, imagesGen: 0, health: '', pools: null, error: '', selected: '',
  images: null, imagesError: '', loadingImages: false, imagesQuery: '', trash: null, trashError: '',
});
const cephState = freshCeph();

async function loadImages(pool) {
  const gen = ++cephState.imagesGen;
  Object.assign(cephState, { selected: pool, images: null, imagesError: '', loadingImages: true, imagesQuery: '' });
  await render();
  let images = null;
  let error = '';
  try {
    const list = await api().poolImages(pool);
    images = Array.isArray(list) ? list : [];
  } catch (e) {
    if (!isUnauthorized(e)) error = errText(e);
  }
  if (gen !== cephState.imagesGen) return; // trocou de pool no meio
  Object.assign(cephState, { images, imagesError: error, loadingImages: false });
  await render();
}

async function loadCeph() {
  const gen = ++cephState.gen;
  cephState.imagesGen++;
  Object.assign(cephState, { ...freshCeph(), gen, imagesGen: cephState.imagesGen });
  const a = api();
  const [health, pools, trash] = await Promise.allSettled([a.health(), a.pools(), a.trash()]);
  if (gen !== cephState.gen) return; // saiu e entrou de novo
  const ceph = health.status === 'fulfilled' && health.value && health.value.ceph;
  cephState.health = (ceph && ceph.status) || '';
  if (pools.status === 'fulfilled') {
    cephState.pools = Array.isArray(pools.value) ? pools.value : [];
  } else if (!isUnauthorized(pools.reason)) cephState.error = errText(pools.reason);
  if (trash.status === 'fulfilled') cephState.trash = Array.isArray(trash.value) ? trash.value : [];
  else if (!isUnauthorized(trash.reason)) cephState.trashError = errText(trash.reason);
  const pool = cephState.pools ? defaultPool(cephState.pools) : '';
  if (pool) await loadImages(pool);
}

function cephScreenView() {
  const c = cephState;
  const v = cephView({
    health: c.health, pools: c.pools || [], selected: c.selected, images: c.images,
    imagesQuery: c.imagesQuery, trash: c.trash, loadingImages: c.loadingImages, trashError: c.trashError,
  });
  return {
    ...v,
    error: c.error,
    poolsLoading: c.pools === null && !c.error,
    pools: v.pools.map((p) => ({ ...p, ...flex(p.width), apps: p.apps.map((text) => ({ text })), a: `ceph:pool:${p.name}` })),
    images: {
      ...v.images,
      error: c.imagesError,
      countText: Array.isArray(c.images) ? String(v.images.count) : '',
      // Um campo por pool: trocar de pool começa a busca do zero, como na web.
      searchId: `ceph.search.${c.selected}`,
      rows: v.images.rows.map((r) => ({ ...r, ...flex(r.usedWidth), hasVmid: r.vmid !== '' })),
    },
    trash: { ...v.trash, countText: String(v.trash.count) },
  };
}

on('ceph', async (arg, values) => {
  const i = arg.indexOf(':');
  const kind = i < 0 ? arg : arg.slice(0, i);
  const rest = i < 0 ? '' : arg.slice(i + 1);
  if (kind === 'pool') {
    const name = rest || String(values.name || '');
    const pool = (cephState.pools || []).find((p) => p.name === name);
    // Só os pools rbd têm imagens; o mesmo pool de novo não recarrega (a web também não).
    if (!pool || !(pool.applications || []).includes('rbd') || name === cephState.selected) return null;
    return loadImages(name);
  }
  if (kind === 'search') {
    cephState.imagesQuery = String(values.text === undefined ? '' : values.text);
    return render();
  }
  return null;
});

registerScreen('ceph', {
  load: () => loadCeph(),
  view: () => cephScreenView(),
});

// Buckets (BucketsView.tsx). Carrega ao entrar e depois de criar um bucket; sem polling.
// O "Novo bucket" (CreateBucketDialog.tsx) e as "Credenciais S3" (S3CredentialsDialog.tsx)
// são janelas de blocos. A secret key só é buscada num "Revelar"/copiar de um admin, fica
// num Map por janela (apagado quando ela fecha, no sair e na troca de url) e nunca vai
// pro log nem pro `data` da janela principal.

const freshBuckets = () => ({ gen: 0, buckets: null, error: '', query: '', sort: { key: 'bucket', dir: 'asc' } });
const bucketsState = freshBuckets();
const SORT_KEYS = new Set(Object.keys(bk.DEFAULT_DIR));

async function loadBuckets() {
  const gen = ++bucketsState.gen;
  try {
    const list = await api().buckets();
    if (gen !== bucketsState.gen) return;
    bucketsState.buckets = Array.isArray(list) ? list : [];
    bucketsState.error = '';
  } catch (e) {
    if (gen !== bucketsState.gen) return;
    if (!isUnauthorized(e)) bucketsState.error = errText(e);
  }
}

const arrow = (dir) => (dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : '');
// Os flex das colunas (os mesmos, literais, nas linhas do storage.rfwtxt).
const BUCKET_FLEX = { bucket: 28, owner: 14, objects: 10, used: 10, quota: 20, created: 10 };

function bucketsScreenView(user) {
  const v = bk.bucketsView(bucketsState, { admin: isAdmin(user) });
  return {
    ...v,
    header: { newBucket: false, ...v.header },
    columns: v.columns.map((col) => ({ ...col, flex: BUCKET_FLEX[col.key], active: col.dir !== '', arrow: arrow(col.dir), a: `bucket:sort:${col.key}` })),
    rows: v.rows.map((r) => ({ ...r, ...flex(r.width), tenantText: r.tenant ? `${r.tenant}/` : '', a: `bucket:creds:${r.key}` })),
  };
}

// --- "Novo bucket" ---------------------------------------------------------------------

const NEW_BUCKET = 'bucket:new';
const NEW_OWNER_HINT = 'Cria o usuário no RGW com uma chave S3 só dele. As credenciais aparecem logo depois de criar.';
const freshNewBucket = () => ({ gen: 0, owners: null, error: '', errors: [], saving: false, form: { name: '', mode: 'existing', owner: '', newOwner: '' } });
let newBucket = freshNewBucket();

function mergeBucketValues(values) {
  const f = newBucket.form;
  const text = (v, cur) => (v === undefined ? cur : String(v).trim().toLowerCase());
  newBucket.form = {
    ...f,
    name: text(values.name, f.name),
    owner: values.owner === undefined ? f.owner : String(values.owner),
    newOwner: text(values.newOwner, f.newOwner),
  };
}

function newBucketBlocks() {
  const nb = newBucket;
  const f = nb.form;
  const owners = nb.owners;
  const blocks = [
    { type: 'input', id: 'name', label: 'Nome', placeholder: 'Ex: uplii-media', value: f.name },
    { type: 'text', style: f.name && !bk.BUCKET_NAME.test(f.name) ? 'error' : 'faint', text: 'Minúsculas, números e hífen; de 3 a 63 caracteres.' },
    { type: 'text', text: 'Dono' },
    {
      type: 'tabs',
      items: [
        { label: 'Usuário existente', action: 'bucket:mode:existing', active: f.mode !== 'new' },
        { label: 'Novo usuário', action: 'bucket:mode:new', active: f.mode === 'new' },
      ],
    },
  ];
  if (f.mode === 'new') {
    const uid = f.newOwner || f.name;
    const taken = !!owners && owners.includes(uid);
    blocks.push(
      { type: 'input', id: 'newOwner', placeholder: 'Ex: uplii', value: f.newOwner },
      {
        type: 'text',
        style: uid && (taken || !bk.NEW_OWNER.test(uid)) ? 'error' : 'faint',
        text: taken ? 'Esse usuário já existe; escolha em Usuário existente.' : NEW_OWNER_HINT,
      },
    );
  } else {
    const placeholder = owners === null ? 'Carregando…' : owners.length ? 'Escolha o usuário do RGW' : 'Nenhum usuário do RGW';
    blocks.push({ type: 'select', id: 'owner', options: owners || [], value: f.owner, placeholder, loading: owners === null });
  }
  if (nb.errors.length) blocks.push({ type: 'text', style: 'error', text: nb.errors.join(' · ') });
  if (nb.error) blocks.push({ type: 'text', style: 'error', text: nb.error });
  blocks.push({
    type: 'row',
    align: 'end',
    children: [
      { type: 'button', action: 'bucket:cancel', label: 'Cancelar', disabled: nb.saving },
      { type: 'button', action: 'bucket:submit', label: nb.saving ? 'Criando…' : 'Criar bucket', style: 'primary', disabled: nb.saving },
    ],
  });
  return blocks;
}

const renderNewBucket = () => (state.views.has(NEW_BUCKET) ? updateWindow(NEW_BUCKET, { blocks: newBucketBlocks() }) : false);

async function openNewBucket() {
  // Criando: só traz a janela de volta, com o "Criando…".
  if (newBucket.saving) return openWindow(NEW_BUCKET, 'Novo bucket', newBucketBlocks());
  const gen = newBucket.gen + 1;
  newBucket = { ...freshNewBucket(), gen };
  await openWindow(NEW_BUCKET, 'Novo bucket', newBucketBlocks());
  let owners = [];
  let error = '';
  try {
    const list = await api().bucketOwners();
    owners = Array.isArray(list) ? list.map(String) : [];
  } catch (e) {
    error = errText(e);
  }
  if (gen !== newBucket.gen) return null;
  newBucket.owners = owners;
  newBucket.error = error;
  return renderNewBucket();
}

async function submitNewBucket(values) {
  const nb = newBucket;
  if (nb.saving) return null; // o segundo clique (ou o enter) não manda outro POST
  mergeBucketValues(values);
  nb.errors = bk.validateBucket(nb.form, nb.owners || []);
  if (nb.errors.length) return renderNewBucket();
  const body = bk.bucketBody(nb.form);
  nb.saving = true; // antes de qualquer await
  nb.error = '';
  renderNewBucket();
  let created;
  try {
    created = await api().createBucket(body);
  } catch (e) {
    if (nb !== newBucket) return null;
    nb.saving = false;
    nb.error = errText(e);
    return renderNewBucket();
  }
  if (nb !== newBucket) return null; // saiu no meio
  newBucket = { ...freshNewBucket(), gen: nb.gen + 1 };
  await closeWindow(NEW_BUCKET);
  await loadBuckets();
  await render();
  if (body.newOwner) {
    const b = created && typeof created === 'object' ? created : {};
    await openCredentials({ name: b.name || body.name, owner: b.owner || body.owner });
  }
  return null;
}

// --- "Credenciais S3" ------------------------------------------------------------------

const CREDS = 'bucket:creds:';
const SNIPPET_TABS = [['env', '.env'], ['aws', 'AWS CLI'], ['rclone', 'rclone']];
const COPIED = 'Copiado';
const COPY_FAILED = 'Não deu para copiar; selecione o texto';
const credWindows = new Map(); // viewId → { gen, bucket, owner, creds, error, showSecret, tab, feedback, timer }
const secrets = new Map(); // viewId → a secret key revelada (só desta janela; nunca no log)
// viewId → o GET da secret em curso: cliques seguidos (Revelar, copiar) esperam o mesmo,
// porque cada GET vira um `s3.secret.reveal` na auditoria.
const pendingSecret = new Map();
let credGen = 0;

function forgetWindow(viewId) {
  const w = credWindows.get(viewId);
  if (w && w.timer) clearTimeout(w.timer);
  credWindows.delete(viewId);
  secrets.delete(viewId);
  pendingSecret.delete(viewId);
}

function forgetStorage() {
  Object.assign(cephState, freshCeph(), { gen: cephState.gen + 1, imagesGen: cephState.imagesGen + 1 });
  Object.assign(bucketsState, freshBuckets(), { gen: bucketsState.gen + 1 });
  newBucket = { ...freshNewBucket(), gen: newBucket.gen + 1 };
  for (const viewId of [...credWindows.keys()]) forgetWindow(viewId);
  secrets.clear();
  pendingSecret.clear();
}

function ownerBuckets(owner) {
  const list = bucketsState.buckets || [];
  return Math.max(1, list.filter((b) => b.owner === owner).length);
}

function credentialsBlocks(viewId) {
  const w = credWindows.get(viewId);
  const admin = currentAdmin();
  const blocks = [{ type: 'text', style: 'dim', text: `Bucket ${w.bucket} · usuário ${w.owner} do RGW` }];
  if (w.error) blocks.push({ type: 'text', style: 'error', text: w.error });
  const c = w.creds;
  if (!c) {
    if (!w.error) blocks.push({ type: 'text', style: 'dim', text: 'Carregando credenciais…' });
  } else {
    const secret = admin ? secrets.get(viewId) : undefined;
    const shown = admin && w.showSecret && !!secret;
    blocks.push({
      type: 'kv',
      items: [
        { key: 'Endpoint', value: c.endpoint || '' },
        { key: 'Região', value: c.region || '' },
        c.accessKey ? { key: 'Access key', value: c.accessKey } : { key: 'Access key', value: 'Este usuário não tem chave S3.', tone: 'dim' },
      ],
    });
    const copies = [
      { type: 'button', action: 'bucket:copy:endpoint', label: 'Endpoint', icon: 'copy', tooltip: 'Copiar' },
      { type: 'button', action: 'bucket:copy:region', label: 'Região', icon: 'copy', tooltip: 'Copiar' },
    ];
    if (c.accessKey) copies.push({ type: 'button', action: 'bucket:copy:access', label: 'Access key', icon: 'copy', tooltip: 'Copiar' });
    blocks.push({ type: 'row', children: copies });
    if (c.accessKey) {
      if (admin) {
        blocks.push(
          { type: 'kv', items: [shown ? { key: 'Secret key', value: secret } : { key: 'Secret key', value: bk.MASK, tone: 'dim' }] },
          {
            type: 'row',
            children: [
              pendingSecret.has(viewId)
                ? { type: 'button', action: 'bucket:reveal', label: 'Revelando…', disabled: true }
                : { type: 'button', action: 'bucket:reveal', label: shown ? 'Esconder' : 'Revelar' },
              { type: 'button', action: 'bucket:copy:secret', label: 'Secret key', icon: 'copy', tooltip: 'Copiar' },
            ],
          },
        );
      } else {
        blocks.push({ type: 'kv', items: [{ key: 'Secret key', value: 'Só admins veem a secret key', tone: 'dim' }] });
      }
      blocks.push(
        { type: 'tabs', items: SNIPPET_TABS.map(([id, label]) => ({ label, action: `bucket:tab:${id}`, active: w.tab === id })) },
        { type: 'code', text: bk.snippet(w.tab, { ...c, bucket: w.bucket }, shown ? secret : null, { withSecret: admin }) },
        { type: 'row', children: [{ type: 'button', action: 'bucket:copy:snippet', label: 'Copiar', icon: 'copy' }] },
      );
    }
    if (w.feedback) blocks.push({ type: 'text', style: w.feedback === COPIED ? 'success' : 'error', text: w.feedback });
    const isolate = admin ? ' Para isolar uma aplicação, crie o bucket com um usuário novo.' : '';
    blocks.push({
      type: 'text',
      style: 'faint',
      text: `As chaves são do usuário ${w.owner} e dão acesso a todos os buckets dele (${ownerBuckets(w.owner)}).${isolate}`,
    });
  }
  blocks.push({ type: 'row', align: 'end', children: [{ type: 'button', action: 'bucket:close', label: 'Fechar' }] });
  return blocks;
}

const renderCredentials = (viewId) =>
  credWindows.has(viewId) && state.views.has(viewId) ? updateWindow(viewId, { blocks: credentialsBlocks(viewId) }) : false;

async function openCredentials({ name, owner }) {
  const viewId = `${CREDS}${owner}`;
  const cur = credWindows.get(viewId);
  if (cur && state.views.has(viewId)) {
    // Já aberta pra esse dono (as chaves são do dono): só traz pra frente, com o bucket novo.
    cur.bucket = name;
    return openWindow(viewId, 'Credenciais S3', credentialsBlocks(viewId));
  }
  // Uma janela que fechou já largou a secret (windowGone → forgetWindow); aqui só sobra
  // uma entrada velha se a Maestria não avisou o fechamento.
  if (cur) forgetWindow(viewId);
  const w = { gen: ++credGen, bucket: name, owner, creds: null, error: '', showSecret: false, tab: 'env', feedback: '', timer: null };
  credWindows.set(viewId, w);
  await openWindow(viewId, 'Credenciais S3', credentialsBlocks(viewId));
  try {
    const c = await api().credentials(owner);
    if (credWindows.get(viewId) !== w) return null;
    w.creds = c && typeof c === 'object' ? c : { endpoint: '', region: '', accessKey: null, owner };
  } catch (e) {
    if (credWindows.get(viewId) !== w) return null;
    w.error = errText(e);
  }
  return renderCredentials(viewId);
}

/** A secret key da janela: do cache, ou do GET (auditado no servidor). Só pra admin. */
async function loadSecret(viewId) {
  const w = credWindows.get(viewId);
  // Sem access key não há secret a mostrar (a web nem mostra o campo).
  if (!w || !currentAdmin() || !w.creds || !w.creds.accessKey) return null;
  w.error = ''; // o erro de um Revelar anterior sai quando outro começa
  if (secrets.has(viewId)) return secrets.get(viewId);
  if (pendingSecret.has(viewId)) return pendingSecret.get(viewId);
  const p = (async () => {
    await null; // o finally nunca roda antes do `set` abaixo, nem com um erro síncrono
    try {
      const r = await api().secret(w.owner);
      const value = r && typeof r.secretKey === 'string' ? r.secretKey : '';
      if (credWindows.get(viewId) !== w || !value) return null; // fechou no meio: não guarda
      secrets.set(viewId, value);
      return value;
    } catch (e) {
      if (credWindows.get(viewId) === w) w.error = errText(e);
      return null;
    } finally {
      if (pendingSecret.get(viewId) === p) pendingSecret.delete(viewId);
    }
  })();
  pendingSecret.set(viewId, p);
  renderCredentials(viewId); // o "Revelando…"
  return p;
}

async function copyText(viewId, text) {
  const w = credWindows.get(viewId);
  if (!w || !text) return renderCredentials(viewId);
  try {
    await mx.request('clipboard.write', { text });
    w.feedback = COPIED;
  } catch {
    w.feedback = COPY_FAILED;
  }
  if (w.timer) clearTimeout(w.timer);
  w.timer = setTimeout(() => {
    w.timer = null;
    if (credWindows.get(viewId) !== w) return;
    w.feedback = '';
    renderCredentials(viewId);
  }, 1500);
  return renderCredentials(viewId);
}

async function copyField(viewId, what) {
  const w = credWindows.get(viewId);
  if (!w || !w.creds) return null;
  const c = w.creds;
  const admin = currentAdmin();
  if (what === 'endpoint') return copyText(viewId, c.endpoint);
  if (what === 'region') return copyText(viewId, c.region);
  if (what === 'access') return copyText(viewId, c.accessKey);
  if (!c.accessKey) return null;
  if (what === 'secret') {
    if (!admin) return null;
    return copyText(viewId, await loadSecret(viewId));
  }
  if (what === 'snippet') {
    const data = { ...c, bucket: w.bucket };
    if (!admin) return copyText(viewId, bk.snippet(w.tab, data, null, { withSecret: false }));
    const secret = await loadSecret(viewId);
    return copyText(viewId, secret ? bk.snippet(w.tab, data, secret, { withSecret: true }) : '');
  }
  return null;
}

async function toggleSecret(viewId) {
  const w = credWindows.get(viewId);
  if (!w || !currentAdmin() || !w.creds || !w.creds.accessKey) return null;
  if (w.showSecret) w.showSecret = false;
  else if (await loadSecret(viewId)) w.showSecret = true;
  return renderCredentials(viewId);
}

on('bucket', async (arg, values, { viewId }) => {
  const i = arg.indexOf(':');
  const kind = i < 0 ? arg : arg.slice(0, i);
  const rest = i < 0 ? '' : arg.slice(i + 1);
  // a tela
  if (kind === 'sort') {
    if (!SORT_KEYS.has(rest)) return null;
    bucketsState.sort = bk.nextSort(bucketsState.sort, rest);
    return render();
  }
  if (kind === 'search') {
    bucketsState.query = String(values.text === undefined ? '' : values.text);
    return render();
  }
  if (kind === 'creds') {
    const b = (bucketsState.buckets || []).find((x) => `${x.tenant || ''}/${x.name}` === rest);
    return b ? openCredentials({ name: b.name, owner: b.owner }) : null;
  }
  // as credenciais (todos os papéis; a secret, só admin, conferido em cada uma)
  if (viewId && viewId.startsWith(CREDS) && credWindows.has(viewId)) {
    if (kind === 'close') return closeWindow(viewId);
    if (kind === 'tab') {
      if (SNIPPET_TABS.some(([id]) => id === rest)) credWindows.get(viewId).tab = rest;
      return renderCredentials(viewId);
    }
    if (kind === 'reveal') return toggleSecret(viewId);
    if (kind === 'copy') return copyField(viewId, rest);
    return null;
  }
  // o "Novo bucket": só admin
  if (!currentAdmin()) return null;
  if (kind === 'new') return openNewBucket();
  if (viewId !== NEW_BUCKET) return null;
  if (kind === 'cancel') return newBucket.saving ? null : closeWindow(NEW_BUCKET);
  if (kind === 'mode') {
    if (newBucket.saving) return null;
    mergeBucketValues(values);
    newBucket.form.mode = rest === 'new' ? 'new' : 'existing';
    newBucket.errors = [];
    return renderNewBucket();
  }
  if (kind === 'submit') return submitNewBucket(values);
  return null;
});

registerScreen('buckets', {
  load: () => loadBuckets(),
  // `ctx.user` pode ser null (um render logo depois do sair): aí é só leitura.
  view: (c) => bucketsScreenView(c.user),
});

// Rotas (RoutesView.tsx, RouteDrawer.tsx, NewRouteDialog.tsx, RemoveRouteDialog.tsx e
// RouteJobProgress.tsx). A lista carrega ao entrar, no "Ler agora", quando a "Nova rota"
// ou a remoção fecham e quando um job termina; sem polling. Criar e remover mexem no
// firewall de produção: cada botão que chama a API tem uma trava síncrona (`busy`, ligada
// antes de qualquer await), o hostname digitado tem que bater (`confirmMatches`) e toda
// escrita confere de novo que quem pede é admin. O job é consultado a cada 2 s só com a
// janela dele aberta (`jobPoller`, à parte dos pollers da janela principal).

const ROUTE_JOB_MS = envMs('VMM_ROUTE_JOB_MS', 2000);
const ROUTE_NEW = 'route:new';
const ROUTE_REMOVE = 'route:remove';
const drawerId = (hostname) => `route:${hostname}`;

const freshRoutes = () => ({ gen: 0, routes: null, error: '', query: '', filter: 'all', loadedAt: '', loading: false });
const routesState = freshRoutes();
const jobPoller = createPoller({
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
});
let wizard = null; // a "Nova rota" aberta: { step: 'form'|'review'|'job', form, healthchecks, errors, error, busy, plan, body, typed, confirmError, job, lost }
let removal = null; // a remoção aberta: { hostname, plan, error, busy, loading, typed, confirmError, job, lost }

async function loadRoutes() {
  const gen = ++routesState.gen;
  routesState.loading = true;
  render(); // o "Lendo…" no botão
  try {
    const list = await api().routes();
    if (gen !== routesState.gen) return;
    routesState.routes = Array.isArray(list) ? list : [];
    routesState.loadedAt = new Date().toISOString();
    routesState.error = '';
  } catch (e) {
    if (gen !== routesState.gen) return;
    if (!isUnauthorized(e)) routesState.error = errText(e); // o 401 já leva ao login
  }
  routesState.loading = false;
}

/** Recarrega a lista (e redesenha) se a tela de rotas está na vista e há sessão. */
async function reloadRoutes() {
  if (state.screen !== 'routes' || !state.session || !state.session.isLoggedIn()) return;
  await loadRoutes();
  await render();
}

function routesScreenView(user, now) {
  const v = rt.routesView(routesState, { admin: isAdmin(user), now });
  const loaded = Array.isArray(routesState.routes);
  return {
    ...v,
    header: { newRoute: false, ...v.header },
    filters: v.filters.map((f) => ({ ...f, countText: loaded ? String(f.count) : '' })),
  };
}

// --- a gaveta ------------------------------------------------------------------------

async function openRouteDrawer(hostname) {
  const route = (routesState.routes || []).find((r) => r.hostname === hostname);
  if (!route) return null;
  return openWindow(drawerId(hostname), hostname, rt.drawerBlocks(route, { admin: currentAdmin(), now: Date.now() }));
}

// --- o job (compartilhado pela criação e pela remoção) ------------------------------

const STEP_ICON = { pending: 'dot', running: 'clock', done: 'check', failed: 'error', reverted: 'undo', warning: 'warning' };

function jobBlocks(job, lost) {
  const running = job.status === 'running' && !lost;
  const blocks = [
    { type: 'heading', text: `${rt.jobTitle(job)} ${job.hostname}` },
    {
      type: 'list',
      items: rt.visibleSteps(job).map((s) => ({
        title: s.label,
        subtitle: s.detail,
        icon: STEP_ICON[s.status] || 'dot',
        tone: s.tone === 'dim' ? 'faint' : s.tone,
      })),
    },
  ];
  if (job.error) blocks.push({ type: 'text', style: 'error', text: String(job.error) });
  if (lost) blocks.push({ type: 'text', style: 'error', text: rt.LOST_TEXT(lost) });
  if (running) blocks.push({ type: 'text', style: 'dim', text: rt.RUNNING_HINT[job.kind] || '' });
  blocks.push({
    type: 'row',
    align: 'end',
    children: [{ type: 'button', action: 'route:close', label: running ? 'Fechar e continuar em segundo plano' : 'Fechar' }],
  });
  return blocks;
}

/**
 * Acompanha o job da janela `viewId` a cada ROUTE_JOB_MS (a primeira consulta é depois do
 * intervalo, como na web). Para quando a janela fecha (update com open:false ou view.closed),
 * no fim do job, num 404 (perdeu o job) e no sair/troca de url. Um erro de rede só tenta de novo.
 */
function trackJob(viewId, owner) {
  let first = true;
  jobPoller.loop(viewId, ROUTE_JOB_MS, async () => {
    const w = owner();
    if (!w || !w.job) return false;
    if (first) {
      first = false;
      return true;
    }
    let job = null;
    let error = null;
    try {
      job = await api().routeJob(w.job.id);
    } catch (e) {
      error = e;
    }
    if (owner() !== w) return false; // fechou ou saiu no meio
    const next = rt.jobNext(job, error);
    if (next === 'lost') w.lost = errText(error);
    else if (job && typeof job === 'object') w.job = job;
    const open = await renderRouteWindow(viewId);
    if (!open || next === 'lost') return false;
    if (next === 'done') {
      await reloadRoutes();
      return false;
    }
    return true;
  });
}

// --- "Nova rota" -----------------------------------------------------------------------

const TLS_OPTIONS = [
  { key: 'firewall', label: 'No firewall', sub: "certificado Let's Encrypt emitido agora" },
  { key: 'passthrough', label: 'Passthrough', sub: 'a aplicação termina o TLS' },
];
const ACCESS_OPTIONS = [
  { key: 'internal', label: 'Só interno', sub: 'LOCAL_SUBDOMAINS · rede e VPN' },
  { key: 'public', label: 'Público', sub: 'PUBLIC_SUBDOMAINS · internet' },
  { key: 'both', label: 'Os dois', sub: 'as duas mapfiles' },
];

const freshRouteForm = () => ({
  hostname: '', tlsMode: 'firewall', access: 'internal', servers: [{ address: '', port: '' }],
  healthCheck: rt.DEFAULT_HEALTHCHECK, createDnsOverride: true,
});

/** O que veio digitado na janela (cada ação traz todos os campos) entra no formulário. */
function mergeRouteValues(values) {
  const f = wizard.form;
  const v = values || {};
  const servers = f.servers.map((s, i) => ({
    address: v[`addr${i}`] === undefined ? s.address : String(v[`addr${i}`]),
    port: v[`port${i}`] === undefined ? s.port : String(v[`port${i}`]).replace(/\D/g, ''),
  }));
  wizard.form = {
    ...f,
    hostname: v.hostname === undefined ? f.hostname : String(v.hostname).trim().toLowerCase(),
    servers,
    healthCheck: v.healthCheck === undefined || v.healthCheck === '' ? f.healthCheck : String(v.healthCheck),
    createDnsOverride: v.createDns === undefined ? f.createDnsOverride : v.createDns === true,
  };
}

const changeItems = (changes, numbered, tag, tagTone) =>
  changes.map((c, i) => {
    const [what, module] = rt.CHANGE_LABEL[c.kind] || [String(c.kind), ''];
    return {
      title: numbered ? `${i + 1}. ${what}` : what,
      subtitle: c.detail ? `${c.target} · ${c.detail}` : String(c.target),
      badge: module,
      meta: tag,
      metaTone: tagTone,
      tone: tagTone,
    };
  });

function wizardFormBlocks(w) {
  const f = w.form;
  const passthrough = f.tlsMode === 'passthrough';
  const tls = TLS_OPTIONS.find((o) => o.key === f.tlsMode) || TLS_OPTIONS[0];
  const access = ACCESS_OPTIONS.find((o) => o.key === f.access) || ACCESS_OPTIONS[0];
  const blocks = [
    { type: 'text', style: 'faint', text: '1 de 2 · Dados' },
    { type: 'input', id: 'hostname', label: 'Hostname', placeholder: 'Ex: status.cefis.cloud', value: f.hostname, submit: 'route:review' },
    {
      type: 'text',
      style: f.hostname && !rt.HOSTNAME.test(f.hostname) ? 'error' : 'faint',
      text: 'Domínio completo; o console confere se está livre ao revisar.',
    },
    { type: 'text', text: 'TLS' },
    { type: 'tabs', items: TLS_OPTIONS.map((o) => ({ label: o.label, action: `route:tls:${o.key}`, active: o.key === f.tlsMode })) },
    { type: 'text', style: 'faint', text: tls.sub },
  ];
  if (!passthrough) {
    blocks.push(
      { type: 'text', text: 'Quem acessa' },
      { type: 'tabs', items: ACCESS_OPTIONS.map((o) => ({ label: o.label, action: `route:access:${o.key}`, active: o.key === f.access })) },
      { type: 'text', style: 'faint', text: access.sub },
    );
  }
  blocks.push({ type: 'text', text: 'Destino' });
  f.servers.forEach((s, i) => {
    const children = [
      { type: 'input', id: `addr${i}`, width: 280, placeholder: '192.168.100.57', value: s.address },
      { type: 'input', id: `port${i}`, width: 110, placeholder: '3000', value: s.port },
    ];
    if (f.servers.length > 1) children.push({ type: 'button', action: `route:rmserver:${i}`, label: 'x', tooltip: 'Remover servidor' });
    blocks.push({ type: 'row', children });
  });
  blocks.push(
    { type: 'row', children: [{ type: 'button', action: 'route:addserver', label: 'Adicionar servidor (balanceamento)', icon: 'add' }] },
    { type: 'select', id: 'healthCheck', label: 'Health check', options: w.healthchecks, value: f.healthCheck },
    { type: 'checkbox', id: 'createDns', label: 'Criar override no DNS interno', value: f.createDnsOverride },
    { type: 'text', style: 'faint', text: `${f.hostname || 'hostname'} → HAProxy do firewall` },
  );
  if (w.errors.length) blocks.push({ type: 'text', style: 'error', text: w.errors.join(' · ') });
  if (w.error) blocks.push({ type: 'text', style: 'error', text: w.error });
  blocks.push({
    type: 'row',
    align: 'end',
    children: [
      { type: 'button', action: 'route:cancel', label: 'Cancelar', disabled: w.busy },
      { type: 'button', action: 'route:review', label: w.busy ? 'Conferindo…' : 'Revisar mudanças', style: 'primary', disabled: w.busy },
    ],
  });
  return blocks;
}

function wizardReviewBlocks(w) {
  const plan = w.plan;
  const blocks = [
    { type: 'heading', text: 'Revisar mudanças no firewall' },
    { type: 'text', style: 'faint', text: '2 de 2 · Revisão' },
    { type: 'text', style: 'dim', text: 'Isto será criado no OPNsense, nesta ordem. Nada muda até você aplicar.' },
    { type: 'list', items: changeItems(plan.changes || [], true, 'criar', 'green') },
    { type: 'text', style: 'warning', text: 'Aplicar recarrega o HAProxy' },
    {
      type: 'text',
      style: 'dim',
      text: 'Antes de recarregar, o console roda o configtest; se algo falhar até o reload, desfaz o que criou. No reload, conexões abertas dos outros sites podem cair por cerca de 1 s.',
    },
    { type: 'input', id: 'confirm', label: 'Digite o hostname para confirmar', placeholder: plan.hostname, value: w.typed, submit: 'route:apply' },
  ];
  if (w.confirmError) blocks.push({ type: 'text', style: 'error', text: w.confirmError });
  if (w.error) blocks.push({ type: 'text', style: 'error', text: w.error });
  blocks.push({
    type: 'row',
    align: 'end',
    children: [
      { type: 'button', action: 'route:back', label: 'Voltar', disabled: w.busy },
      { type: 'button', action: 'route:cancel', label: 'Cancelar', disabled: w.busy },
      { type: 'button', action: 'route:apply', label: 'Aplicar no firewall', style: 'primary', icon: 'shield', disabled: w.busy },
    ],
  });
  return blocks;
}

function wizardBlocks(w) {
  if (w.step === 'job' && w.job) return jobBlocks(w.job, w.lost);
  if (w.step === 'review' && w.plan) return wizardReviewBlocks(w);
  return wizardFormBlocks(w);
}

// --- a remoção ---------------------------------------------------------------------------

function removalBlocks(r) {
  if (r.job) return jobBlocks(r.job, r.lost);
  const blocks = [];
  if (!r.plan && !r.error) blocks.push({ type: 'text', style: 'dim', text: 'Conferindo o que a rota usa no OPNsense…' });
  if (r.plan) {
    const { remove, keep } = rt.removalGroups(r.plan);
    blocks.push(
      { type: 'text', style: 'dim', text: 'Primeiro a rota sai do ar (com rollback se algo falhar); depois o console apaga o que ficou sem uso.' },
      { type: 'section', text: 'SERÁ APAGADO' },
      { type: 'list', items: changeItems(remove, false, 'apagar', 'red') },
    );
    if (keep.length) {
      blocks.push(
        { type: 'section', text: 'FICA, PORQUE OUTRA COISA AINDA USA' },
        { type: 'list', items: changeItems(keep, false, 'fica', 'faint') },
      );
    }
    blocks.push(
      { type: 'text', style: 'warning', text: 'Remover recarrega o HAProxy' },
      { type: 'text', style: 'dim', text: 'O hostname para de responder na hora. No reload, conexões abertas dos outros sites podem cair por cerca de 1 s.' },
      { type: 'input', id: 'confirm', label: 'Digite o hostname para confirmar', placeholder: r.hostname, value: r.typed, submit: 'route:delete' },
    );
  }
  if (r.confirmError) blocks.push({ type: 'text', style: 'error', text: r.confirmError });
  if (r.error) blocks.push({ type: 'text', style: 'error', text: r.error });
  blocks.push({
    type: 'row',
    align: 'end',
    children: [
      { type: 'button', action: 'route:cancel', label: 'Cancelar', disabled: r.busy },
      { type: 'button', action: 'route:delete', label: 'Remover do firewall', style: 'danger', icon: 'trash', disabled: !r.plan || r.busy },
    ],
  });
  return blocks;
}

/** Redesenha a janela de criação ou de remoção; false se ela não está aberta. */
async function renderRouteWindow(viewId) {
  if (!state.views.has(viewId)) return false;
  if (viewId === ROUTE_NEW && wizard) return updateWindow(viewId, { blocks: wizardBlocks(wizard) });
  if (viewId === ROUTE_REMOVE && removal) return updateWindow(viewId, { blocks: removalBlocks(removal) });
  return false;
}

/** Uma janela de rotas que fechou: para o job dela, larga o estado e relê a lista. */
function routeWindowGone(viewId) {
  if (viewId !== ROUTE_NEW && viewId !== ROUTE_REMOVE) return;
  jobPoller.stop(viewId);
  const had = viewId === ROUTE_NEW ? wizard : removal;
  if (viewId === ROUTE_NEW) wizard = null;
  else removal = null;
  // Fechada pelo X da Maestria com o POST/DELETE no ar: a mudança segue na API, sem a gente
  // acompanhar. Na criação, `busy` na revisão é só o "Aplicar"; na remoção, `busy` é o DELETE.
  if (had && had.busy && (viewId === ROUTE_REMOVE || had.step === 'review')) {
    const host = viewId === ROUTE_REMOVE ? had.hostname : had.plan.hostname;
    const what = viewId === ROUTE_REMOVE ? 'remoção' : 'criação';
    banner(`A ${what} de ${host} continua em segundo plano; confira na Auditoria e use Ler agora.`);
  }
  if (had) guard('rotas', () => reloadRoutes());
}

function forgetRoutes() {
  jobPoller.stopAll();
  wizard = null;
  removal = null;
  Object.assign(routesState, freshRoutes(), { gen: routesState.gen + 1 });
}

async function openWizard() {
  // Já aberta (conferindo, revisando ou acompanhando o job): só traz pra frente.
  if (wizard && state.views.has(ROUTE_NEW)) return openWindow(ROUTE_NEW, 'Nova rota', wizardBlocks(wizard));
  const w = {
    step: 'form', form: freshRouteForm(), healthchecks: [rt.DEFAULT_HEALTHCHECK], errors: [], error: '',
    busy: false, plan: null, body: null, typed: '', confirmError: '', job: null, lost: '',
  };
  wizard = w;
  await openWindow(ROUTE_NEW, 'Nova rota', wizardBlocks(w));
  try {
    const names = await api().healthchecks();
    if (wizard !== w || !Array.isArray(names) || !names.length) return null;
    w.healthchecks = names.map(String);
    w.form = { ...w.form, healthCheck: rt.pickHealthCheck(w.healthchecks, w.form.healthCheck) };
  } catch {
    return null; // como na web: fica o tcp-check
  }
  return renderRouteWindow(ROUTE_NEW);
}

async function reviewRoute(values) {
  const w = wizard;
  if (!w || w.busy || w.step !== 'form') return null; // um clique (ou enter) por vez
  mergeRouteValues(values);
  w.errors = rt.validateRoute(w.form);
  w.error = '';
  if (w.errors.length) return renderRouteWindow(ROUTE_NEW);
  const body = rt.routeBody(w.form);
  w.busy = true; // antes de qualquer await
  renderRouteWindow(ROUTE_NEW); // o "Conferindo…"
  try {
    const plan = await api().planRoute(body);
    if (wizard !== w) return null;
    w.plan = plan && typeof plan === 'object' ? { hostname: body.hostname, ...plan, changes: Array.isArray(plan.changes) ? plan.changes : [] } : { hostname: body.hostname, changes: [] };
    w.body = body;
    w.typed = '';
    w.confirmError = '';
    w.step = 'review';
  } catch (e) {
    if (wizard !== w) return null;
    w.error = errText(e);
  }
  w.busy = false;
  return renderRouteWindow(ROUTE_NEW);
}

async function applyRoute(values) {
  const w = wizard;
  if (!w || w.busy || w.step !== 'review' || !w.plan || !w.body) return null;
  w.typed = String((values && values.confirm) || '');
  if (!rt.confirmMatches(w.typed, w.plan.hostname)) {
    w.confirmError = `Digite ${w.plan.hostname} para confirmar.`;
    return renderRouteWindow(ROUTE_NEW);
  }
  w.confirmError = '';
  w.error = '';
  w.busy = true; // antes de qualquer await: o segundo clique não manda outro POST
  renderRouteWindow(ROUTE_NEW);
  try {
    const job = await api().createRoute(w.body);
    if (wizard !== w) return null;
    w.busy = false;
    if (!job || typeof job !== 'object' || !job.id) throw new Error('a API não devolveu o job da criação');
    w.job = job;
    w.step = 'job';
  } catch (e) {
    if (wizard !== w) return null;
    w.busy = false;
    w.error = errText(e);
    return renderRouteWindow(ROUTE_NEW);
  }
  await renderRouteWindow(ROUTE_NEW);
  if (w.job.status === 'running') trackJob(ROUTE_NEW, () => wizard);
  else await reloadRoutes();
  return null;
}

async function openRemoval(hostname) {
  closeWindow(drawerId(hostname)); // como na web: a gaveta sai e a remoção entra
  // A mesma remoção já aberta (conferindo, removendo ou acompanhando): só traz pra frente.
  const cur = removal;
  if (cur && state.views.has(ROUTE_REMOVE) && (cur.hostname === hostname || cur.busy || cur.job)) {
    return openWindow(ROUTE_REMOVE, `Remover rota ${cur.hostname}`, removalBlocks(cur));
  }
  const r = { hostname, plan: null, error: '', busy: false, typed: '', confirmError: '', job: null, lost: '' };
  removal = r;
  await openWindow(ROUTE_REMOVE, `Remover rota ${hostname}`, removalBlocks(r));
  try {
    const plan = await api().removalPlan(hostname);
    if (removal !== r) return null;
    r.plan = plan && typeof plan === 'object' ? plan : null;
    if (!r.plan || !r.plan.fingerprint) {
      r.plan = null;
      r.error = 'a API não devolveu o plano de remoção';
    }
  } catch (e) {
    if (removal !== r) return null;
    r.error = errText(e);
  }
  return renderRouteWindow(ROUTE_REMOVE);
}

async function deleteRoute(values) {
  const r = removal;
  if (!r || r.busy || r.job || !r.plan) return null;
  r.typed = String((values && values.confirm) || '');
  if (!rt.confirmMatches(r.typed, r.hostname)) {
    r.confirmError = `Digite ${r.hostname} para confirmar.`;
    return renderRouteWindow(ROUTE_REMOVE);
  }
  r.confirmError = '';
  r.error = '';
  r.busy = true; // antes de qualquer await: o segundo clique não manda outro DELETE
  renderRouteWindow(ROUTE_REMOVE);
  try {
    const job = await api().removeRoute(r.hostname, r.plan.fingerprint);
    if (removal !== r) return null;
    r.busy = false;
    if (!job || typeof job !== 'object' || !job.id) throw new Error('a API não devolveu o job da remoção');
    r.job = job;
  } catch (e) {
    if (removal !== r) return null;
    r.busy = false;
    r.error = errText(e);
    return renderRouteWindow(ROUTE_REMOVE);
  }
  await renderRouteWindow(ROUTE_REMOVE);
  if (r.job.status === 'running') trackJob(ROUTE_REMOVE, () => removal);
  else await reloadRoutes();
  return null;
}

on('route', async (arg, values, { viewId }) => {
  const i = arg.indexOf(':');
  const kind = i < 0 ? arg : arg.slice(0, i);
  const rest = i < 0 ? '' : arg.slice(i + 1);
  // a tela (todos os papéis)
  if (viewId === MAIN) {
    if (kind === 'reload') {
      if (routesState.loading) return null; // como na web, o botão fica travado lendo
      await loadRoutes();
      return render();
    }
    if (kind === 'filter') {
      routesState.filter = rest || 'all';
      return render();
    }
    if (kind === 'search') {
      routesState.query = String(values.text === undefined ? '' : values.text);
      return render();
    }
    if (kind === 'open') return openRouteDrawer(rest);
  }
  // fechar é de todos (a gaveta do viewer, inclusive)
  if (kind === 'close' || kind === 'cancel') {
    if (viewId === ROUTE_NEW && wizard && wizard.busy) return null; // a web não fecha no meio de um pedido
    if (viewId === ROUTE_REMOVE && removal && removal.busy) return null;
    if (viewId && viewId.startsWith('route:')) return closeWindow(viewId);
    return null;
  }
  // daqui pra baixo, escrita no firewall: só admin, conferido de novo aqui
  if (!currentAdmin()) return null;
  if (kind === 'new' && viewId === MAIN) return openWizard();
  if (kind === 'remove' && viewId && viewId !== ROUTE_NEW && viewId !== ROUTE_REMOVE) {
    return rest && (routesState.routes || []).some((r) => r.hostname === rest) ? openRemoval(rest) : null;
  }
  if (viewId === ROUTE_NEW && wizard) {
    if (kind === 'review') return reviewRoute(values);
    if (kind === 'apply') return applyRoute(values);
    if (kind === 'back') {
      if (wizard.busy || wizard.step !== 'review') return null;
      Object.assign(wizard, { step: 'form', plan: null, body: null, error: '', confirmError: '' });
      return renderRouteWindow(ROUTE_NEW);
    }
    if (wizard.busy || wizard.step !== 'form') return null;
    mergeRouteValues(values); // a troca de aba e de servidor não apaga o que foi digitado
    if (kind === 'tls' && TLS_OPTIONS.some((o) => o.key === rest)) wizard.form.tlsMode = rest;
    else if (kind === 'access' && ACCESS_OPTIONS.some((o) => o.key === rest)) wizard.form.access = rest;
    else if (kind === 'addserver') wizard.form.servers = rt.addServer(wizard.form.servers);
    else if (kind === 'rmserver') wizard.form.servers = rt.removeServer(wizard.form.servers, Number(rest));
    return renderRouteWindow(ROUTE_NEW);
  }
  if (viewId === ROUTE_REMOVE && removal && kind === 'delete') return deleteRoute(values);
  return null;
});

registerScreen('routes', {
  load: () => loadRoutes(),
  // `ctx.user` pode ser null (um render logo depois do sair): aí é só leitura.
  view: (c) => routesScreenView(c.user, c.now()),
});

// Usuários (UsersTable.tsx) e Auditoria (AuditLog.tsx), só de admin: o `gate` já manda o
// viewer pro "só admins", e cada ação confere de novo (`currentAdmin()`). Um 403 da API
// quer dizer que o papel mudou noutro lugar: relê o /auth/me e passa pelo gating de novo.

const isForbidden = (e) => e instanceof ApiError && e.status === 403;

/** Depois de um 403: relê quem é e, se a tela não vale mais, vai pra onde o gating manda. */
async function regate() {
  const s = state.session;
  const from = state.screen;
  try {
    await s.refreshMe();
  } catch {
    return false; // o 401 já leva ao login; a rede fora fica com o erro na tela
  }
  if (s !== state.session || state.screen !== from) return true;
  const dest = gate(s.user(), from);
  if (dest === from) return false;
  switchTo(dest);
  await render();
  return true;
}

const freshUsers = () => ({ gen: 0, users: null, error: '', saving: new Set() });
const usersState = freshUsers();
// A sessão das telas de admin: só o `forgetAdmin` (sair, trocar de url) muda. O `gen` da lista
// muda a cada leitura e só serve pra largar uma lista velha; um PATCH vale enquanto a sessão for a mesma.
let adminSession = 0;

async function loadUsers() {
  const gen = ++usersState.gen;
  try {
    const list = await api().users();
    if (gen !== usersState.gen) return;
    usersState.users = Array.isArray(list) ? list : [];
    usersState.error = '';
  } catch (e) {
    if (gen !== usersState.gen || isUnauthorized(e)) return;
    if (isForbidden(e) && (await regate())) return;
    usersState.error = errText(e);
  }
}

/** Troca o papel (o "Aprovar" é `viewer`): um PATCH por linha de cada vez, nunca o próprio. */
async function changeRole(id, role) {
  if (!currentAdmin()) return null;
  const me = state.session.user();
  const list = usersState.users || [];
  const target = list.find((u) => u.id === id);
  if (!target || (me && me.id === id)) return null; // a UI nem oferece; aqui recusa
  if (!ROLE_LABEL[role] || target.role === role) return null;
  if (usersState.saving.has(id)) return null; // a linha fica travada até o PATCH voltar
  const session = adminSession;
  const saving = usersState.saving;
  saving.add(id); // antes de qualquer await
  usersState.error = '';
  render();
  try {
    const updated = await api().setRole(id, role);
    if (session !== adminSession) return null; // saiu ou trocou de url no meio
    // Mesmo que a lista tenha sido relida no meio (reentrar na tela), a linha fica com o papel novo.
    if (updated && typeof updated === 'object' && updated.id !== undefined) {
      usersState.users = (usersState.users || []).map((u) => (u.id === updated.id ? updated : u));
    }
  } catch (e) {
    if (session !== adminSession || isUnauthorized(e)) return null;
    if (isForbidden(e) && (await regate())) return null;
    usersState.error = errText(e);
  } finally {
    saving.delete(id); // sempre destrava (o forgetAdmin já troca o Set de qualquer jeito)
  }
  return render();
}

function usersScreenView(user, now) {
  const loaded = Array.isArray(usersState.users);
  const rows = adm.usersView(usersState.users || [], { meId: user ? user.id : '', saving: usersState.saving, now }).map((r) => ({
    ...r,
    saving: usersState.saving.has(r.id),
    menu: r.canChange ? adm.roleMenu(r.id, r.role) : [],
    approveA: `user:approve:${r.id}`,
  }));
  return {
    pending: adm.pendingBanner(usersState.users || []),
    error: usersState.error,
    empty: loaded ? '' : 'Carregando…',
    rows,
  };
}

on('user', async (arg, values, { viewId }) => {
  if (viewId !== MAIN || !currentAdmin() || state.screen !== 'users') return null;
  const [kind, rawId, role] = arg.split(':');
  const id = Number(rawId);
  if (!Number.isFinite(id)) return null;
  if (kind === 'approve') return changeRole(id, 'viewer');
  if (kind === 'role') return changeRole(id, role || '');
  return null;
});

registerScreen('users', {
  load: () => loadUsers(),
  // `ctx.user` pode ser null (um render logo depois do sair): aí ninguém é "eu".
  view: (c) => usersScreenView(c.user, c.now()),
});

// A auditoria: os filtros voltam pra página 1 e fecham o detalhe; a página anterior fica na
// tela enquanto a próxima chega (como na web), e uma resposta atrasada é largada (`latest`).

const freshAuditFilters = () => ({ page: 1, action: '', outcome: '', userId: '', expanded: '' });
const freshAudit = () => ({ latest: adm.createLatest(), users: [], res: null, error: '', filters: freshAuditFilters() });
const auditState = freshAudit();

async function loadAuditUsers() {
  const session = adminSession;
  let list = [];
  try {
    list = await api().users();
  } catch {
    // como na web: sem a lista, só o filtro "Todas" e os e-mails
  }
  if (session !== adminSession) return; // a lista é de quem saiu
  auditState.users = Array.isArray(list) ? list : [];
}

async function fetchAudit() {
  const latest = auditState.latest;
  const i = latest.next();
  const { page, action, outcome, userId } = auditState.filters;
  auditState.error = '';
  try {
    const res = await api().audit({ page, action, outcome, userId });
    if (!latest.isCurrent(i)) return;
    auditState.res = res && typeof res === 'object' && Array.isArray(res.data) ? res : { data: [], pagination: null };
  } catch (e) {
    if (!latest.isCurrent(i) || isUnauthorized(e)) return;
    if (isForbidden(e) && (await regate())) return;
    auditState.res = { error: true };
    auditState.error = errText(e);
  }
}

/** Busca a página dos filtros atuais e redesenha (só se a auditoria ainda está na vista). */
async function refetchAudit() {
  render(); // o detalhe fecha e o filtro novo aparece já
  await fetchAudit();
  if (state.screen === 'audit') await render();
}

function auditScreenView() {
  const f = auditState.filters;
  const v = adm.auditView(auditState.res, { users: auditState.users, expanded: f.expanded });
  return {
    ...v,
    error: auditState.error,
    filters: adm.auditFilters(f, auditState.users),
    rows: v.rows.map((r) => ({
      ...r,
      toggle: `audit:toggle:${r.id}`,
      toggleTitle: r.expanded ? 'Esconder detalhe' : 'Ver detalhe',
    })),
  };
}

on('audit', async (arg, values, { viewId }) => {
  if (viewId !== MAIN || !currentAdmin() || state.screen !== 'audit') return null;
  const i = arg.indexOf(':');
  const kind = i < 0 ? arg : arg.slice(0, i);
  const rest = i < 0 ? '' : arg.slice(i + 1);
  const f = auditState.filters;
  if (kind === 'toggle') {
    const id = Number(rest);
    if (!rest || !Number.isFinite(id)) return null;
    f.expanded = f.expanded === id ? '' : id;
    return render();
  }
  if (kind === 'page') {
    const p = auditState.res && !auditState.res.error && auditState.res.pagination;
    if (!p) return null;
    const to = rest === 'prev' ? p.currentPage - 1 : rest === 'next' ? p.currentPage + 1 : NaN;
    if (!Number.isFinite(to) || to < 1 || to > p.lastPage) return null;
    auditState.filters = { ...f, page: to, expanded: '' };
    return refetchAudit();
  }
  let key;
  let value;
  if (kind === 'action' && (rest === '' || adm.ACTION_LABEL[rest])) [key, value] = ['action', rest];
  else if (kind === 'outcome' && (rest === '' || adm.OUTCOME_LABEL[rest])) [key, value] = ['outcome', rest];
  else if (kind === 'user' && (rest === '' || auditState.users.some((u) => String(u.id) === rest))) {
    [key, value] = ['userId', rest === '' ? '' : Number(rest)];
  } else return null;
  if (f[key] === value) return null;
  auditState.filters = adm.withFilter(f, key, value);
  return refetchAudit();
});

registerScreen('audit', {
  // Entrar é como abrir a página na web: filtros limpos e "Carregando…".
  load: () => {
    Object.assign(auditState, { res: null, error: '', filters: freshAuditFilters() });
    return Promise.all([loadAuditUsers(), fetchAudit()]);
  },
  view: () => auditScreenView(),
});

/** Sair/trocar de url: a lista de usuários e a auditoria de quem estava logado vão embora. */
function forgetAdmin() {
  adminSession++;
  Object.assign(usersState, freshUsers(), { gen: usersState.gen + 1 });
  const latest = auditState.latest;
  Object.assign(auditState, freshAudit(), { latest });
  latest.next(); // uma página que ainda chega é de quem saiu
}

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
  forgetAreas();
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
  if (e && e.type === 'view.closed') windowGone(e.viewId);
});

function shutdown() {
  state.poller.stopAll();
  jobPoller.stopAll();
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
module.exports = { state, screens, registerScreen, on, render, navigate, openWindow, updateWindow, closeWindow, banner, ctx, MAIN };
