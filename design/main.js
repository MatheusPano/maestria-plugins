'use strict';

// O Design na Maestria: a cola entre o protocolo (`mx`) e o motor (lib/engine).
// Cada canvas aberto é uma janela rfw (`canvas:<hash>`) com o seu motor (um
// Chrome e um Tailwind); fechar a janela fecha o motor. Nunca escreva no
// stdout: é o protocolo.
//
// Pra Task 11 (ferramentas MCP): `openCanvas(dir, { tabId, cwd })` abre ou traz
// pra frente o canvas ao lado da sessão; `focusBoard(viewOrDir, name)` foca uma
// prancheta; `viewOf(dir)` devolve a janela aberta (com `.engine`).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mx = require('./maestria');
const canvasMod = require('./lib/canvas');
const engineMod = require('./lib/engine');
const view = require('./lib/view');
const follow = require('./lib/follow');

const PLUGIN_ID = 'maestria.design';
const UI_FILE = path.join(__dirname, 'ui', 'canvas.rfwtxt');
const HIGHLIGHT_MS = 3000;
const CLOSE_GRACE_MS = 600; // the host SIGTERMs 0.8 s after `shutdown`
// The host only tells about closed modals (view.closed), not closed grid tabs:
// probe each open view with an empty view.update and close it on {open:false}.
const PROBE_MS = Number(process.env.MAESTRIA_DESIGN_PROBE_MS) > 0 ? Number(process.env.MAESTRIA_DESIGN_PROBE_MS) : 5000;

const OUTDATED = [
  { type: 'heading', text: 'este maestria não desenha o canvas do design' },
  { type: 'text', text: 'o canvas precisa de uma versão do maestria com widgets (rfw). atualize o app e abra de novo.' },
];

const state = {
  caps: { rfw: false, picture: 0, zoomFocus: 0 },
  pluginDir: __dirname,
  dataDir: process.env.MAESTRIA_PLUGIN_DATA || path.join(os.homedir(), '.maestria-rs', 'plugin-data', PLUGIN_ID),
  views: new Map(), // viewId -> V
  current: null, // the canvas the user touched last (for `ajustar`)
  last: { byTab: {}, byCwd: {} }, // the last canvas opened per session / cwd
  engines: new Set(), // engines not yet closed (killed on exit, even mid-close)
  pending: new Map(), // engine dataDir -> engineMod.open() still in flight
  probe: null, // the timer of the closed-tab probe
  exiting: false,
};

const errText = (e) => String((e && e.message) || e);
const hashOf = (dir) => crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12);
const viewIdOf = (dir) => `canvas:${hashOf(dir)}`;
const viewOf = (dir) => state.views.get(viewIdOf(dir)) || null;
const banner = (text) => mx.request('window.showBanner', { text }).catch(() => {});

function library() {
  return fs.readFileSync(UI_FILE, 'utf8');
}

// --- o último canvas de cada sessão ------------------------------------------------

const lastFile = () => path.join(state.dataDir, 'last.json');

function loadLast() {
  try {
    const j = JSON.parse(fs.readFileSync(lastFile(), 'utf8'));
    state.last = { byTab: j.byTab || {}, byCwd: j.byCwd || {} };
  } catch { /* first run */ }
}

function remember(dir, { tabId, cwd } = {}) {
  if (tabId) state.last.byTab[tabId] = dir;
  if (cwd) state.last.byCwd[cwd] = dir;
  try {
    fs.mkdirSync(state.dataDir, { recursive: true });
    fs.writeFileSync(lastFile(), `${JSON.stringify(state.last, null, 2)}\n`);
  } catch (e) { mx.log('last.json:', errText(e)); }
}

function lastFor({ tabId, cwd }) {
  const dir = (tabId && state.last.byTab[tabId]) || (cwd && state.last.byCwd[cwd]) || null;
  return dir && fs.existsSync(path.join(dir, 'canvas.json')) ? dir : null;
}

// --- a janela -----------------------------------------------------------------------

function data(V) {
  const d = view.build({ canvas: V.canvas, states: V.states, ui: V.ui, caps: state.caps, hash: V.hash });
  return view.wire(d);
}

async function render(V) {
  if (V.closed || !V.shown) return; // an update before view.open answers would read as "closed"
  if (!state.caps.picture) {
    try { view.cacheSprites({ pluginDir: state.pluginDir, hash: V.hash, states: V.states }); } catch (e) { mx.log('sprites:', errText(e)); }
  }
  let res;
  try {
    res = await mx.request('view.update', { viewId: V.viewId, title: V.title, data: data(V) });
  } catch (e) {
    mx.log('view.update:', errText(e));
    return;
  }
  if (res && res.open === false) await closeView(V.viewId);
}

function command(V, cmd) {
  V.ui.command = cmd;
  V.ui.rev += 1;
  V.lastCommand = Date.now();
  return render(V);
}

function focusBoard(target, name) {
  const V = typeof target === 'string' ? viewOf(target) : target;
  if (!V) throw new Error('o canvas não está aberto');
  if (!V.canvas || !Object.prototype.hasOwnProperty.call(V.canvas.boards, name)) throw new Error(`prancheta não existe: ${name}`);
  return command(V, { kind: 'focus', board: name });
}

function highlight(V, name) {
  clearTimeout(V.highlightTimer);
  V.ui.highlight = name;
  V.highlightTimer = setTimeout(() => {
    if (V.ui.highlight !== name) return;
    V.ui.highlight = null;
    render(V);
  }, HIGHLIGHT_MS);
}

function onBoard(V, name, s) {
  if (s) V.states.set(name, s);
  else V.states.delete(name);
  // the first render of the boards that were there at open is not news
  if (V.fresh.delete(name) || !s) return render(V);
  highlight(V, name);
  if (follow.shouldJump({ now: Date.now(), lastUserMove: V.lastUserMove, follow: V.ui.follow })) {
    return command(V, { kind: 'focus', board: name });
  }
  return render(V);
}

/** Abre (ou traz pra frente) o canvas da pasta `dir`, ao lado da sessão `tabId`. */
async function openCanvas(input, { tabId, cwd } = {}) {
  const dir = path.resolve(input);
  if (tabId) await mx.request('session.focus', { tabId }).catch((e) => mx.log('session.focus:', errText(e)));
  const viewId = viewIdOf(dir);
  if (!state.caps.rfw) {
    await mx.request('view.open', { viewId, title: 'Design', blocks: OUTDATED });
    return null;
  }
  remember(dir, { tabId, cwd });
  state.current = viewId;
  const open = state.views.get(viewId);
  if (open) {
    if (open.failed) { // the last open failed (no design.json, chrome missing…): try again
      open.failed = false;
      open.ui.message = 'abrindo o canvas…';
      open.ready = startEngine(open);
    }
    await mx.request('view.open', { viewId, title: open.title, rfw: { library: library(), root: 'root' }, data: data(open) });
    await open.ready;
    return open;
  }
  let canvas;
  try { canvas = canvasMod.read(dir); } catch { canvas = { title: path.basename(dir), boards: {}, order: [], warnings: [] }; }
  const V = {
    viewId,
    dir,
    hash: hashOf(dir),
    title: `design: ${canvas.title}`,
    canvas,
    states: new Map(),
    ui: { theme: 'both', follow: true, highlight: null, command: null, rev: 0, scale: 1, message: 'abrindo o canvas…' },
    engine: null,
    fresh: new Set(),
    lastUserMove: 0,
    lastCommand: 0,
    highlightTimer: null,
    closed: false,
    shown: false,
    failed: false,
  };
  state.views.set(viewId, V);
  startProbe();
  V.ready = startEngine(V); // Chrome and Tailwind start while the view opens
  await mx.request('view.open', { viewId, title: V.title, rfw: { library: library(), root: 'root' }, data: data(V) });
  V.shown = true;
  await render(V); // whatever arrived while view.open was in flight
  await V.ready;
  return V;
}

async function startEngine(V) {
  let eng;
  const dataDir = path.join(state.dataDir, V.hash);
  const opening = engineMod.open(V.dir, { dataDir, log: (m) => mx.log(m) });
  state.pending.set(dataDir, opening);
  try {
    eng = await opening;
  } catch (e) {
    if (state.pending.get(dataDir) === opening) state.pending.delete(dataDir);
    mx.log(`abrir ${V.dir}:`, errText(e));
    V.ui.message = `não abriu: ${errText(e)}`;
    V.failed = true;
    await render(V);
    return;
  }
  state.engines.add(eng);
  if (state.pending.get(dataDir) === opening) state.pending.delete(dataDir);
  if (V.closed || state.exiting) { await closeEngine(eng); return; }
  V.engine = eng;
  V.canvas = eng.canvas;
  V.title = `design: ${eng.canvas.title}`;
  V.fresh = new Set(eng.renderable());
  V.ui.message = '';
  eng.on('board', (name, s) => onBoard(V, name, s));
  eng.on('canvas', (c) => { V.canvas = c; V.title = `design: ${c.title}`; render(V); });
  await render(V);
}

async function closeView(viewId) {
  const V = state.views.get(viewId);
  if (!V) return;
  state.views.delete(viewId);
  if (!state.views.size) stopProbe();
  V.closed = true;
  clearTimeout(V.highlightTimer);
  if (state.current === viewId) state.current = null;
  if (!state.caps.picture) { try { view.clearSprites({ pluginDir: state.pluginDir, hash: V.hash }); } catch { /* best effort */ } }
  if (V.engine) await closeEngine(V.engine);
}

async function closeEngine(eng) {
  await eng.close().catch((e) => mx.log('fechar o motor:', errText(e)));
  state.engines.delete(eng);
}

function startProbe() {
  if (state.probe) return;
  state.probe = setInterval(probeViews, PROBE_MS);
  state.probe.unref();
}

function stopProbe() {
  clearInterval(state.probe);
  state.probe = null;
}

async function probeViews() {
  for (const V of [...state.views.values()]) {
    if (!V.shown || V.closed) continue;
    let res;
    try { res = await mx.request('view.update', { viewId: V.viewId }); } catch { continue; }
    if (res && res.open === false) await closeView(V.viewId);
  }
}

// --- as ações da janela ---------------------------------------------------------------

async function onAction(V, act, values) {
  state.current = V.viewId;
  const i = act.indexOf(':');
  const verb = i < 0 ? act : act.slice(0, i);
  const arg = i < 0 ? '' : act.slice(i + 1);
  const now = Date.now();
  // the user's own navigation (buttons, double-click, the board list): follow backs off
  if (verb === 'zoom' && ['in', 'out', 'fit'].includes(arg)) { V.lastUserMove = now; return command(V, { kind: arg }); }
  if (act === 'zoom') {
    // onZoom also reports the end of our own commands
    if (follow.isUserMove({ now, lastCommand: V.lastCommand })) V.lastUserMove = now;
    if (typeof values.scale === 'number') V.ui.scale = values.scale;
    return render(V);
  }
  if (act === 'move') {
    V.lastUserMove = now; // onMove only fires for the user's own pan or wheel
    if (typeof values.scale === 'number' && Math.abs(values.scale - V.ui.scale) >= 0.005) {
      V.ui.scale = values.scale;
      return render(V);
    }
    return null;
  }
  if (act === 'seguir') { V.ui.follow = !V.ui.follow; return render(V); }
  if (verb === 'tema' && ['light', 'dark', 'both'].includes(arg)) { V.ui.theme = arg; return render(V); }
  if (verb === 'focus' && arg) { V.lastUserMove = now; return focusBoard(V, arg); }
  mx.log('ação desconhecida:', act);
  return null;
}

// --- os comandos ----------------------------------------------------------------------

/** As pastas de canvas em `<empresa>/design/`, pro `design: abrir` sem histórico. */
function canvasesNear(cwd) {
  let probe;
  try { probe = canvasMod.defaultDir({ cwd, name: 'x' }); } catch { probe = null; }
  if (!probe) return { root: null, dirs: [] };
  const root = path.dirname(probe);
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { /* none yet */ }
  const dirs = names.map((n) => path.join(root, n)).filter((d) => fs.existsSync(path.join(d, 'canvas.json')));
  return { root, dirs };
}

async function abrir(context) {
  const { cwd, tabId } = context || {};
  const known = lastFor({ tabId, cwd });
  if (known) return openCanvas(known, { tabId, cwd });
  const { root, dirs } = canvasesNear(cwd || os.homedir());
  if (!root) return banner('não sei onde ficam os canvas desta pasta: peça ao claude pra abrir um (design_open)');
  if (!dirs.length) return banner(`nenhum canvas em ${root}: peça ao claude pra criar um (design_open)`);
  const dir = dirs.length === 1 ? dirs[0] : await mx.request('window.pick', {
    title: 'design: abrir',
    placeholder: 'qual canvas?',
    items: dirs.map((d) => ({ value: d, label: path.basename(d), detail: d })),
  });
  if (!dir) return null;
  return openCanvas(dir, { tabId, cwd });
}

function ajustar() {
  const V = state.views.get(state.current) || [...state.views.values()].pop();
  if (!V) return banner('nenhum canvas aberto');
  return command(V, { kind: 'fit' });
}

// --- o protocolo ----------------------------------------------------------------------

mx.onRequest('initialize', (params) => {
  state.caps = {
    rfw: Number(params.rfw) >= 1,
    picture: Number(params.picture) || 0,
    zoomFocus: Number(params.zoomFocus) || 0,
  };
  if (params.dataDir) state.dataDir = params.dataDir;
  if (params.pluginDir) state.pluginDir = params.pluginDir;
  loadLast();
  return {};
});

mx.onRequest('command.invoke', ({ command: id, context }) => {
  // Responde na hora e trabalha depois: o command.invoke tem 30 s, e o pick espera o usuário.
  const run = (fn) => Promise.resolve().then(fn).catch((e) => {
    mx.log(id, errText(e));
    banner(errText(e));
  });
  if (id === 'abrir') run(() => abrir(context));
  else if (id === 'ajustar') run(ajustar);
  else throw new Error(`comando desconhecido: ${id}`);
  return null;
});

mx.onNotification('view.action', async ({ viewId, action, values }) => {
  const V = state.views.get(viewId);
  if (!V) return;
  const vals = values || {};
  const act = String(vals.a || vals.action || action || '');
  try {
    await onAction(V, act, vals);
  } catch (e) {
    mx.log(`ação ${act}:`, errText(e));
    banner(errText(e));
  }
});

mx.onNotification('event', (e) => {
  if (e && e.type === 'view.closed') closeView(e.viewId);
});

// --- sem órfãos: o Chrome e o Tailwind morrem com o plugin ------------------------------

// Engines still inside engineMod.open() have no handle yet: find their Chrome and
// Tailwind by the engine data dir in the command line (Linux /proc).
function killByDirSync(dir) {
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let cmd;
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (!cmd.includes(dir)) continue;
    try { process.kill(-Number(pid), 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
  }
}

function killAllSync() {
  state.exiting = true;
  for (const dir of state.pending.keys()) killByDirSync(dir);
  for (const eng of state.engines) {
    const c = eng.chrome;
    if (c && !c.exited && c.proc && c.proc.pid) { try { process.kill(-c.proc.pid, 'SIGKILL'); } catch { /* gone */ } }
    const t = eng.tw && eng.tw.child;
    if (t && t.pid) { try { t.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

async function closeAll() {
  state.exiting = true;
  stopProbe();
  // opens in flight close themselves on `exiting` once they finish
  const all = [...state.views.keys()].map((id) => closeView(id)).concat([...state.pending.values()].map((p) => p.catch(() => {})));
  await Promise.race([Promise.all(all), new Promise((r) => { setTimeout(r, CLOSE_GRACE_MS).unref(); })]);
}

mx.onNotification('shutdown', async () => {
  await closeAll();
  killAllSync(); // whatever did not close in time
  process.exit(0);
});

process.on('exit', killAllSync);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    killAllSync();
    process.exit(0);
  });
}

mx.start();

module.exports = { state, openCanvas, focusBoard, viewOf, hashOf, render, closeView, command };
