// Pomodoro: foco, pausa curta e, a cada tantos focos, a pausa longa. Dois
// lugares pro mesmo relógio: um painel pequeno que flutua por cima da janela
// (`float.show`, que a Maestria arrasta e guarda onde você largou) e a aba da
// lateral, com o relógio grande e os tempos pra ajustar.
//
// O relógio é uma hora de fim (`endsAt`) e não um contador: guardada no disco,
// ela sobrevive ao app fechar -- o foco que você começou antes de reiniciar a
// Maestria continua contando, e o que acabou enquanto ela estava fechada é dado
// como feito na volta.
//
// Os tempos moram aqui, no `state.json`, e não nas configurações da Maestria:
// quem os muda é a aba, com o − e o +, e o plugin não escreve nas configurações.
//
// Numa Maestria sem o flutuante (o `floats` do initialize), o painel pequeno
// abre numa janela comum.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mx = require('./maestria');

const FLOAT = 'timer';
const SIZE = { width: 228, height: 58 };
const PHASES = { focus: 'foco', short: 'pausa curta', long: 'pausa longa' };
const SOUND = '/System/Library/Sounds/Glass.aiff';
const OVERLAY_SRC = path.join(__dirname, 'overlay', 'overlay.swift');
const OVERLAY_LINUX = path.join(__dirname, 'overlay', 'overlay_linux.py');
// O som do fim da fase no Linux: o tema de sons do freedesktop, que o GNOME
// traz, tocado pelo primeiro destes que existir (PipeWire, PulseAudio, libcanberra).
const LINUX_SOUND = '/usr/share/sounds/freedesktop/stereo/complete.oga';
const LINUX_PLAYERS = [
  ['pw-play', [LINUX_SOUND]],
  ['paplay', [LINUX_SOUND]],
  ['canberra-gtk-play', ['-i', 'complete']],
];

// A animação de cada fase que começa: o título fixo, e o desenho e a cor que
// você escolhe na aba, entre estes.
const TITLES = { focus: 'hora do foco', short: 'hora da pausa', long: 'pausa longa' };

// Cada desenho é um SF Symbol no macOS (pintado na cor da fase) e um emoji no
// Linux, que não tem os símbolos da Apple. A aba mostra o emoji nos dois.
const ICONS = [
  { id: 'brain', label: 'cérebro', emoji: '🧠', symbol: 'brain.head.profile' },
  { id: 'flame', label: 'fogo', emoji: '🔥', symbol: 'flame.fill' },
  { id: 'target', label: 'alvo', emoji: '🎯', symbol: 'target' },
  { id: 'laptop', label: 'computador', emoji: '💻', symbol: 'laptopcomputer' },
  { id: 'alarm', label: 'despertador', emoji: '⏰', symbol: 'alarm.fill' },
  { id: 'sparkles', label: 'brilho', emoji: '✨', symbol: 'sparkles' },
  { id: 'coffee', label: 'café', emoji: '☕', symbol: 'cup.and.saucer.fill' },
  { id: 'leaf', label: 'folha', emoji: '🌿', symbol: 'leaf.fill' },
  { id: 'walk', label: 'caminhada', emoji: '🚶', symbol: 'figure.walk' },
  { id: 'meditate', label: 'meditação', emoji: '🧘', symbol: 'figure.mind.and.body' },
  { id: 'sun', label: 'sol', emoji: '☀️', symbol: 'sun.max.fill' },
  { id: 'moon', label: 'lua', emoji: '🌙', symbol: 'moon.fill' },
];
const COLORS = [
  { id: 'red', label: 'vermelho', hex: '#F07A83' },
  { id: 'orange', label: 'laranja', hex: '#F2A65A' },
  { id: 'yellow', label: 'amarelo', hex: '#F2CD73' },
  { id: 'green', label: 'verde', hex: '#8BD88B' },
  { id: 'teal', label: 'turquesa', hex: '#5EE3C1' },
  { id: 'blue', label: 'azul', hex: '#72B6F2' },
  { id: 'purple', label: 'roxo', hex: '#B69CF5' },
  { id: 'pink', label: 'rosa', hex: '#F5A3D0' },
];
const SCENE_DEFAULTS = {
  focus: { icon: 'brain', color: 'red' },
  short: { icon: 'coffee', color: 'green' },
  long: { icon: 'walk', color: 'blue' },
};

/** A cena de [phase] como você a deixou: `{ title, icon, color }`. */
function sceneOf(phase) {
  const mine = (s.config.scenes && s.config.scenes[phase]) || {};
  const def = SCENE_DEFAULTS[phase];
  return {
    title: TITLES[phase],
    icon: ICONS.find((i) => i.id === mine.icon) || ICONS.find((i) => i.id === def.icon),
    color: COLORS.find((c) => c.id === mine.color) || COLORS.find((c) => c.id === def.color),
  };
}

/** Uma cor `#RRGGBB` como o rfw lê: um inteiro 0xAARRGGBB. */
function argb(hex) {
  return 0xff000000 + parseInt(hex.slice(1), 16);
}
// O que falta, por sistema, quando a animação não sobe: vai no recado.
const OVERLAY_NEEDS = {
  darwin: 'a animação precisa do swiftc (as Command Line Tools do Xcode)',
  linux: 'a animação precisa do python3 com GTK: sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0',
};

// Os tempos ajustáveis: o passo do − e do +, e até onde vão.
const STEPS = {
  focus: { label: 'foco', unit: 'min', step: 5, min: 5, max: 120 },
  short: { label: 'pausa curta', unit: 'min', step: 1, min: 1, max: 30 },
  long: { label: 'pausa longa', unit: 'min', step: 5, min: 5, max: 60 },
  longEvery: { label: 'pausa longa a cada', unit: 'focos', step: 1, min: 2, max: 8 },
};
const PRESETS = [
  { id: '25-5', focus: 25, short: 5 },
  { id: '50-10', focus: 50, short: 10 },
  { id: '90-20', focus: 90, short: 20 },
];
const TOGGLES = [
  { id: 'autoStart', label: 'começar a próxima sozinho', hint: 'desligado, a fase nova espera o play' },
  { id: 'notify', label: 'notificação' },
  { id: 'overlay', label: 'animação na tela', hint: 'por cima de tudo, mesmo com outro app na frente' },
  { id: 'sound', label: 'som', hint: process.platform === 'darwin' ? 'o Glass do macOS' : 'o "complete" do sistema' },
];
const PANEL = { id: 'visible', label: 'painel flutuante', hint: 'o pequeno, por cima da janela; arraste pra onde quiser' };
const DEFAULTS = {
  focus: 25,
  short: 5,
  long: 15,
  longEvery: 4,
  autoStart: false,
  notify: true,
  sound: true,
  overlay: true,
  confetti: true,
};

const env = {
  dataDir: process.env.MAESTRIA_PLUGIN_DATA || '',
  floats: false, // a Maestria tem o flutuante
  float: fs.readFileSync(path.join(__dirname, 'ui', 'float.rfwtxt'), 'utf8'),
  side: fs.readFileSync(path.join(__dirname, 'ui', 'sidebar.rfwtxt'), 'utf8'),
  shown: false, // o painel já foi com a biblioteca
  sidebar: false, // a aba está na tela
  sideSent: false, // a biblioteca da aba já foi
  badgeCleared: false, // já mandou o `badge: null`
  overlay: null, // o executável da animação, depois de compilado
  building: null, // a compilação em andamento
  editing: 'focus', // a fase cuja animação a aba está mostrando pra editar
  ready: false, // o initialize já voltou: antes dele a janela não conversa
};

// O que vai pro disco. `round` é quantos focos o ciclo já teve (volta a zero
// depois da pausa longa); `left` é o que sobrou de uma fase pausada no meio.
let s = {
  phase: 'focus',
  running: false,
  endsAt: null,
  left: null,
  round: 0,
  today: { day: '', count: 0 },
  visible: true,
  config: { ...DEFAULTS },
};

let ticker = null;

// --- o relógio ----------------------------------------------------------------

function cfg(id) {
  const v = s.config[id];
  if (typeof DEFAULTS[id] === 'boolean') return typeof v === 'boolean' ? v : DEFAULTS[id];
  return Number.isFinite(v) && v > 0 ? v : DEFAULTS[id];
}

function duration(phase) {
  return Math.round(cfg(phase) * 60000);
}

function remaining() {
  if (s.running) return Math.max(0, s.endsAt - Date.now());
  return s.left ?? duration(s.phase);
}

function dayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function today() {
  if (s.today.day !== dayKey()) s.today = { day: dayKey(), count: 0 };
  return s.today.count;
}

function start() {
  if (s.running) return;
  s.endsAt = Date.now() + remaining();
  s.left = null;
  s.running = true;
  changed();
}

function pause() {
  if (!s.running) return;
  s.left = remaining();
  s.running = false;
  s.endsAt = null;
  changed();
}

function toggle() {
  s.running ? pause() : start();
}

/** A fase depois desta. Terminar o foco conta pro dia; pular não. */
function advance({ finished, quiet = false }) {
  const was = s.phase;
  if (was === 'focus') {
    s.round += 1;
    if (finished) {
      today();
      s.today.count += 1;
    }
    s.phase = s.round >= cfg('longEvery') ? 'long' : 'short';
  } else {
    if (was === 'long') s.round = 0;
    s.phase = 'focus';
  }
  s.left = null;
  s.running = finished && !quiet && cfg('autoStart');
  s.endsAt = s.running ? Date.now() + duration(s.phase) : null;
  if (finished && !quiet) announce(was);
  changed();
}

function reset() {
  s = { ...s, phase: 'focus', running: false, endsAt: null, left: null, round: 0 };
  changed();
}

function jump(phase) {
  if (s.phase === phase && !s.running && s.left == null) return;
  s = { ...s, phase, running: false, endsAt: null, left: null };
  changed();
}

/** Um tempo ajustado na aba. A fase que não começou pega o tempo novo; a que
 * está rodando ou pausada no meio termina com o que tinha. */
function setConfig(patch) {
  s.config = { ...s.config, ...patch };
  changed();
}

/** O desenho ou a cor da fase em edição. Guarda só os ids. */
function setScene(patch) {
  const cur = sceneOf(env.editing);
  const scenes = { ...(s.config.scenes || {}), [env.editing]: { icon: cur.icon.id, color: cur.color.id, ...patch } };
  setConfig({ scenes });
}

function step(id, dir) {
  const st = STEPS[id];
  if (!st) return;
  const v = cfg(id);
  // Um valor fora do passo (um 25 com passo de 10) vai pro passo mais perto
  // naquela direção, em vez de andar do lugar torto.
  const next = dir > 0 ? Math.floor(v / st.step) * st.step + st.step : Math.ceil(v / st.step) * st.step - st.step;
  setConfig({ [id]: Math.min(st.max, Math.max(st.min, next)) });
}

/** O fim de uma fase: a notificação, o som e a animação. */
function announce(was) {
  const next = `${s.phase === 'focus' ? 'o' : 'a'} ${PHASES[s.phase]} de ${cfg(s.phase)} min`;
  const then = s.running ? `começou ${next}` : `aperte o play pra começar ${next}`;
  const body =
    was === 'focus'
      ? `foco feito (${today()} hoje). Agora ${then}.`
      : `a ${PHASES[was]} acabou. Agora ${then}.`;
  if (cfg('notify')) {
    mx.request('window.notify', { title: 'Pomodoro', body }).catch((e) => mx.log('notify:', e.message));
  }
  if (cfg('sound')) sound();
  if (cfg('overlay')) overlay(was);
}

function sound() {
  if (process.platform === 'darwin') {
    if (fs.existsSync(SOUND)) play([['afplay', [SOUND]]]);
  } else if (process.platform === 'linux') {
    play(fs.existsSync(LINUX_SOUND) ? LINUX_PLAYERS : LINUX_PLAYERS.slice(2));
  }
}

/** Toca com o primeiro tocador que existir: o que falta (ou falha) passa a vez. */
function play(players) {
  const [first, ...rest] = players;
  if (!first) return;
  const p = spawn(first[0], first[1], { stdio: 'ignore', detached: true });
  p.on('error', () => play(rest));
  p.on('exit', (code) => code !== 0 && play(rest));
  p.unref();
}

// --- a animação -----------------------------------------------------------------
//
// Um programa à parte, porque é o único jeito de aparecer por cima de outro app
// sem trazer a Maestria pra frente e roubar o teclado de quem está digitando.
//
// No macOS, `overlay/overlay.swift`: compilado com o `swiftc` na primeira vez, e
// de novo só quando o código muda -- o nome do executável leva o hash dele. No
// Linux, `overlay/overlay_linux.py`, em GTK 3: nada pra compilar, só conferir
// uma vez que o python3 tem o GTK.

function overlayBinary() {
  if (process.platform !== 'darwin' || !env.dataDir || !fs.existsSync(OVERLAY_SRC)) return null;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(OVERLAY_SRC)).digest('hex').slice(0, 10);
  return path.join(env.dataDir, `overlay-${hash}`);
}

/** O jeito de rodar a animação neste sistema, `{ cmd, args(scene, subtitle), env }`,
 * ou null quando não dá. */
function buildOverlay() {
  if (process.platform === 'linux') return linuxOverlay();
  return swiftOverlay().then(
    (bin) =>
      bin && {
        cmd: bin,
        args: (scene, subtitle) => [
          ...['--title', scene.title, '--subtitle', subtitle, '--color', scene.color.hex],
          ...['--symbol', scene.icon.symbol, '--seconds', '4.5', '--confetti', cfg('confetti') ? '1' : '0'],
        ],
      },
  );
}

function linuxOverlay() {
  if (env.linux !== undefined) return Promise.resolve(env.linux);
  if (env.building) return env.building;
  // O GTK e a ponte dele com o cairo (`python3-gi-cairo`): sem ela a janela abre
  // e não desenha.
  const probe =
    "import cairo, gi; gi.require_version('Gtk', '3.0'); gi.require_foreign('cairo'); from gi.repository import Gtk";
  env.building = new Promise((resolve) => {
    const p = spawn('python3', ['-c', probe], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const done = (ok, why) => {
      if (!ok) mx.log(`${OVERLAY_NEEDS.linux} (${why})`);
      // No XWayland quando há um: lá a janela pode ser um popup por cima de
      // todas, e num Wayland puro o compositor decide se ela vem pra frente.
      const childEnv = process.env.DISPLAY ? { ...process.env, GDK_BACKEND: 'x11' } : process.env;
      env.linux = ok
        ? {
            cmd: 'python3',
            args: (scene, subtitle) => [
              OVERLAY_LINUX,
              ...['--title', scene.title, '--subtitle', subtitle, '--color', scene.color.hex],
              ...['--emoji', scene.icon.emoji, '--seconds', '4.5', '--confetti', cfg('confetti') ? '1' : '0'],
            ],
            env: childEnv,
          }
        : null;
      env.overlay = env.linux ? 'python3' : null;
      resolve(env.linux);
    };
    p.on('error', (e) => done(false, e.message));
    p.on('exit', (code) => done(code === 0, err.trim().split('\n').pop()));
  }).finally(() => (env.building = null));
  return env.building;
}

function swiftOverlay() {
  if (env.overlay) return Promise.resolve(env.overlay);
  if (env.building) return env.building;
  const bin = overlayBinary();
  if (!bin) return Promise.resolve(null);
  if (fs.existsSync(bin)) return Promise.resolve((env.overlay = bin));
  env.building = new Promise((resolve) => {
    fs.mkdirSync(env.dataDir, { recursive: true });
    const tmp = `${bin}.${process.pid}.tmp`;
    const p = spawn('swiftc', ['-O', OVERLAY_SRC, '-o', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      mx.log('sem o swiftc, a animação fica de fora (instale as Command Line Tools do Xcode):', e.message);
      resolve(null);
    });
    p.on('exit', (code) => {
      if (code !== 0) {
        mx.log(`a animação não compilou (${code}):`, err.trim());
        return resolve(null);
      }
      fs.renameSync(tmp, bin);
      // As versões antigas, de antes do código mudar.
      for (const f of fs.readdirSync(env.dataDir)) {
        if (f.startsWith('overlay-') && path.join(env.dataDir, f) !== bin) {
          fs.rmSync(path.join(env.dataDir, f), { force: true });
        }
      }
      env.overlay = bin;
      mx.log('animação compilada:', bin);
      resolve(bin);
    });
  }).finally(() => (env.building = null));
  return env.building;
}

/** A fase que vem depois da de agora, sem mexer em nada: a prévia. */
function nextPhase() {
  if (s.phase !== 'focus') return 'focus';
  return s.round + 1 >= cfg('longEvery') ? 'long' : 'short';
}

/** A animação da fase [phase] que começa depois de [was]. */
async function overlay(was, phase = s.phase, running = s.running) {
  const runner = await buildOverlay();
  if (!runner) return;
  const scene = sceneOf(phase);
  const then = running ? 'já começou' : 'aperte o play pra começar';
  const subtitle = {
    focus: `${was === 'long' ? 'ciclo novo · ' : ''}${cfg('focus')} min · ${Math.min((was === 'long' ? 0 : s.round) + 1, cfg('longEvery'))} de ${cfg('longEvery')} · ${then}`,
    short: `foco feito · ${focos(today())} hoje · ${cfg('short')} min pra respirar`,
    long: `ciclo completo · ${cfg('long')} min longe da tela`,
  }[phase];
  const p = spawn(runner.cmd, runner.args(scene, subtitle), {
    stdio: 'ignore',
    detached: true,
    env: runner.env || process.env,
  });
  p.on('error', (e) => mx.log('animação:', e.message));
  p.unref();
}

/** Uma vez por segundo enquanto roda: é o que vê a fase acabar. */
function schedule() {
  if (s.running && !ticker) {
    ticker = setInterval(() => {
      if (!s.running) return schedule();
      if (remaining() <= 0) return advance({ finished: true });
      render();
    }, 1000);
  } else if (!s.running && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function changed() {
  save();
  schedule();
  render();
}

// --- o que se desenha ---------------------------------------------------------

function clock(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  return `${String(m).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function fresh() {
  return !s.running && s.left == null;
}

function label() {
  const every = cfg('longEvery');
  let text = PHASES[s.phase];
  if (s.phase === 'focus') text += ` · ${Math.min(s.round + 1, every)} de ${every}`;
  if (!s.running && !fresh()) text += ' · pausado';
  return text;
}

function common() {
  // Longe de 0 e de 1: pelo json um número inteiro chega como int, e o rfw lê
  // o `value` do anel como double -- um 0 ou um 1 viraria o anel girando.
  const progress = Math.min(0.9999, Math.max(0.0001, 1 - remaining() / duration(s.phase)));
  return {
    phase: s.phase,
    running: s.running,
    clock: clock(remaining()),
    label: label(),
    progress,
    // A cor que você escolheu pra fase: o anel do painel e o da aba.
    color: argb(sceneOf(s.phase).color.hex),
  };
}

function focos(n) {
  return `${n} ${n === 1 ? 'foco' : 'focos'}`;
}

function floatData() {
  return {
    ...common(),
    menu: [
      { label: `hoje: ${focos(today())}`, icon: 'check', action: 'nada', disabled: true },
      { divider: true },
      { label: 'foco agora', icon: 'clock', action: 'fase:focus', disabled: s.phase === 'focus' && fresh() },
      { label: 'pausa curta agora', icon: 'pause', action: 'fase:short', disabled: s.phase === 'short' && fresh() },
      { label: 'pausa longa agora', icon: 'pause', action: 'fase:long', disabled: s.phase === 'long' && fresh() },
      { label: 'zerar o ciclo', icon: 'restart', action: 'zerar' },
      { divider: true },
      { label: 'esconder o painel', icon: 'remove', action: 'esconder' },
    ],
  };
}

function sideData() {
  const every = cfg('longEvery');
  return {
    ...common(),
    today: `hoje: ${focos(today())}`,
    // As bolinhas do ciclo: os focos já feitos acesos.
    dots: Array.from({ length: every }, (_, i) => i < s.round),
    focusColor: argb(sceneOf('focus').color.hex),
    phases: Object.entries(PHASES).map(([id, text]) => ({ id, label: text, active: s.phase === id })),
    presets: PRESETS.map((p) => ({
      id: p.id,
      label: `${p.focus} · ${p.short}`,
      active: cfg('focus') === p.focus && cfg('short') === p.short,
    })),
    steppers: Object.entries(STEPS).map(([id, st]) => ({
      id,
      label: st.label,
      value: `${cfg(id)} ${st.unit}`,
      atMin: cfg(id) <= st.min,
      atMax: cfg(id) >= st.max,
    })),
    toggles: TOGGLES.map((t) => ({ id: t.id, label: t.label, hint: t.hint ? [t.hint] : [], on: cfg(t.id) })),
    panel: [{ id: PANEL.id, label: PANEL.label, hint: [PANEL.hint], on: s.visible }],
    anim: animData(),
  };
}

/** A seção "animação" da aba: a fase em edição, os desenhos e as cores dela. */
function animData() {
  const scene = sceneOf(env.editing);
  return {
    phases: Object.entries(PHASES).map(([id, text]) => ({ id, label: text, active: env.editing === id })),
    icons: ICONS.map((i) => ({ id: i.id, label: i.label, emoji: i.emoji, active: i.id === scene.icon.id })),
    colors: COLORS.map((c) => ({ id: c.id, label: c.label, value: argb(c.hex), active: c.id === scene.color.id })),
    color: argb(scene.color.hex),
    toggles: [{ id: 'confetti', label: 'confete', hint: [], on: cfg('confetti') }],
    test: `ver a animação de ${PHASES[env.editing]}`,
  };
}

async function render() {
  if (!env.ready) return;
  await Promise.all([renderFloat(), renderSide()]);
}

async function renderSide() {
  try {
    if (env.sidebar) {
      const params = { data: sideData() };
      if (!env.sideSent) params.rfw = { library: env.side };
      // Sem selo no ícone da faixa. O `null` tira o de uma versão anterior, que
      // a Maestria guarda enquanto está aberta.
      if (!env.badgeCleared) params.badge = null;
      await mx.request('sidebar.update', params);
      env.sideSent = true;
      env.badgeCleared = true;
    } else if (!env.badgeCleared) {
      await mx.request('sidebar.update', { badge: null });
      env.badgeCleared = true;
    }
  } catch (e) {
    mx.log('aba:', e.message);
  }
}

async function renderFloat() {
  if (!s.visible) return;
  try {
    if (!env.floats) {
      if (!env.shown) {
        await mx.request('view.open', {
          viewId: FLOAT,
          title: 'pomodoro',
          rfw: { library: env.float },
          data: floatData(),
        });
        env.shown = true;
      } else if (!(await mx.request('view.update', { viewId: FLOAT, data: floatData() })).open) {
        // Você fechou a janela: é o mesmo que esconder.
        env.shown = false;
        s.visible = false;
        save();
      }
      return;
    }
    if (env.shown) {
      const r = await mx.request('float.update', { id: FLOAT, data: floatData() });
      if (r && r.shown) return;
    }
    await mx.request('float.show', {
      id: FLOAT,
      ...SIZE,
      corner: 'bottomRight',
      rfw: { library: env.float },
      data: floatData(),
    });
    env.shown = true;
  } catch (e) {
    mx.log('painel:', e.message);
  }
}

async function setVisible(on) {
  s.visible = on;
  save();
  if (!on) {
    env.shown = false;
    await mx
      .request(env.floats ? 'float.hide' : 'view.close', env.floats ? { id: FLOAT } : { viewId: FLOAT })
      .catch(() => {});
  }
  render();
}

async function act(a, id) {
  if (a === 'alternar') toggle();
  else if (a === 'pular') advance({ finished: false });
  else if (a === 'zerar') reset();
  else if (a === 'esconder') await setVisible(false);
  else if (a === 'fase' && PHASES[id]) jump(id);
  else if (a && a.startsWith('fase:') && PHASES[a.slice(5)]) jump(a.slice(5));
  else if (a === 'mais') step(id, +1);
  else if (a === 'menos') step(id, -1);
  else if (a === 'preset') {
    const p = PRESETS.find((x) => x.id === id);
    if (p) setConfig({ focus: p.focus, short: p.short });
  } else if (a === 'cena' && PHASES[id]) {
    env.editing = id;
    render();
  } else if (a === 'icone' && ICONS.some((i) => i.id === id)) {
    setScene({ icon: id });
  } else if (a === 'cor' && COLORS.some((c) => c.id === id)) {
    setScene({ color: id });
  } else if (a === 'testar') {
    // A da fase em edição na aba, como se ela começasse agora.
    const phase = env.editing;
    await overlay(phase === 'focus' ? 'short' : 'focus', phase, cfg('autoStart'));
    if (!env.overlay) {
      await mx.request('window.showBanner', {
        text: OVERLAY_NEEDS[process.platform] || 'a animação só existe no macOS e no Linux',
      });
    }
  } else if (a === 'toggle') {
    if (id === 'visible') await setVisible(!s.visible);
    else if (typeof DEFAULTS[id] === 'boolean') setConfig({ [id]: !cfg(id) });
  }
}

// --- o disco ------------------------------------------------------------------

function stateFile() {
  return env.dataDir ? path.join(env.dataDir, 'state.json') : null;
}

function load() {
  const file = stateFile();
  if (!file || !fs.existsSync(file)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    s = {
      ...s,
      ...saved,
      today: { ...s.today, ...(saved.today || {}) },
      config: { ...DEFAULTS, ...(saved.config || {}) },
    };
    if (!PHASES[s.phase]) s.phase = 'focus';
  } catch (e) {
    mx.log('state.json não leu, começando do zero:', e.message);
  }
}

function save() {
  const file = stateFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
  } catch (e) {
    mx.log('não gravou o estado:', e.message);
  }
}

// --- o protocolo --------------------------------------------------------------

mx.onRequest('initialize', (p) => {
  env.floats = p.floats >= 1;
  if (p.dataDir) env.dataDir = p.dataDir;
  load();
  // Prepara a animação já, em segundo plano (compila no macOS, confere o GTK no
  // Linux): a primeira fase que acabar não espera.
  if (cfg('overlay')) buildOverlay();
  // A fase que acabou com o app fechado: feita, sem tocar nada agora, e a
  // próxima espera o play.
  if (s.running && s.endsAt <= Date.now()) advance({ finished: true, quiet: true });
  // Depois da resposta do initialize: antes dela a janela ainda não conversa.
  setImmediate(() => {
    env.ready = true;
    schedule();
    render();
  });
  if (!env.floats) mx.log('esta Maestria não tem o flutuante (floats); o pomodoro abre numa janela');
  return {};
});

mx.onRequest('command.invoke', async ({ command }) => {
  if (command === 'painel') {
    await setVisible(!s.visible);
  } else {
    await act(command);
    if (command === 'alternar' && !s.visible) {
      await mx.request('window.showBanner', {
        text: s.running ? `${PHASES[s.phase]}: ${clock(remaining())}` : `pausado em ${clock(remaining())}`,
      });
    }
  }
  return null;
});

mx.onNotification('event', (e) => {
  if (e.type === 'sidebar.shown') {
    env.sidebar = true;
    renderSide();
  } else if (e.type === 'sidebar.hidden') {
    env.sidebar = false;
  }
});

mx.onNotification('view.action', async ({ viewId, action, values }) => {
  if (viewId !== FLOAT && viewId !== 'sidebar') return;
  const v = values || {};
  // Do menu a escolha vem em `action`; dos botões, em `a`.
  await act(v.action || v.a || action, v.id);
});

mx.onNotification('shutdown', () => {
  save();
  process.exit(0);
});

mx.start();
