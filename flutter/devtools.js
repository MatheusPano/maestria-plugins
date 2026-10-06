// O DevTools dentro da Maestria: uma janela por central, com o desempenho
// (os frames), a CPU, a memória e a rede do app que ela está rodando.
//
// É o que o DevTools do navegador mostra, tirado do mesmo lugar: o VM service
// do app. A janela abre uma conexão só dela (a da central é do depurador), com
// os streams `Extension` — os frames chegam como `Flutter.Frame` — e `GC`, e
// pede o resto quando precisa: a memória a cada segundo, as amostras de CPU de
// uma gravação, o perfil HTTP do `dart:io`. Fechou a janela, a conexão fecha.
//
// Abrir a janela depois do app já estar rodando não perde os frames: o DDS
// guarda os últimos eventos do `Extension` e os repassa a quem começa a ouvir.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mx = require('./maestria');
const { VmService } = require('./vm');

const LIBRARY = path.join(__dirname, 'ui', 'devtools.rfwtxt');

/** Os frames guardados, e quantos o gráfico mostra (o resto é pra média e o pior). */
const MAX_FRAMES = 600;
const CHART_FRAMES = 240;
/** Uma amostra de memória por segundo, dois minutos no gráfico. */
const MEM_SAMPLES = 120;
const MEM_EVERY = 1000;
const NET_EVERY = 1500;
const MAX_REQUESTS = 500;
/** Uma gravação de CPU para sozinha aqui: o buffer de amostras do VM é circular. */
const CPU_MAX_MS = 60000;
/** Os dados vão pra janela no máximo a cada tanto — os frames chegam a 60–120 por segundo. */
const PUSH_MS = 250;
/** O corpo de um pedido HTTP na janela, e o que vai pra área de transferência. */
const BODY_SHOWN = 20000;

const TABS = [
  { id: 'perf', label: 'Desempenho', icon: 'clock' },
  { id: 'cpu', label: 'CPU', icon: 'cpu' },
  { id: 'mem', label: 'Memória', icon: 'layers' },
  { id: 'net', label: 'Rede', icon: 'network' },
];

/**
 * As extensões do Flutter que mudam o app na tela — os botões do topo do
 * DevTools e do Flutter Inspector. Só aparecem as que o app registrou: em
 * profile quase todas somem, e no web não há `timeDilation`.
 */
const TOGGLES = [
  {
    ext: 'ext.flutter.showPerformanceOverlay',
    label: 'performance overlay',
    hint: 'os gráficos de UI e raster desenhados em cima do app, frame a frame',
  },
  { ext: 'ext.flutter.debugPaint', label: 'debug paint', hint: 'as bordas, os paddings e os alinhamentos de cada widget' },
  { ext: 'ext.flutter.debugPaintBaselinesEnabled', label: 'linhas de base', hint: 'a linha de base de cada texto' },
  {
    ext: 'ext.flutter.repaintRainbow',
    label: 'repaint rainbow',
    hint: 'uma cor nova a cada repaint: o que fica piscando está redesenhando demais — um RepaintBoundary ajuda',
  },
  {
    ext: 'ext.flutter.invertOversizedImages',
    label: 'imagens grandes demais',
    hint: 'inverte as cores das imagens decodificadas maiores do que aparecem na tela (use cacheWidth/cacheHeight)',
  },
  {
    ext: 'ext.flutter.timeDilation',
    label: 'animações lentas',
    hint: 'as animações 5× mais devagar',
    params: (on) => ({ timeDilation: on ? '5.0' : '1.0' }),
    read: (r) => Number(r.timeDilation) > 1,
  },
  { ext: 'ext.flutter.debugAllowBanner', label: 'faixa DEBUG', hint: 'a faixa de debug no canto do app' },
];

// --- números em português ----------------------------------------------------

const dec = (n, digits = 1) => Number(n).toFixed(digits).replace('.', ',');
const ms = (us) => `${dec(us / 1000)} ms`;
const int = (n) => Math.round(n).toLocaleString('pt-BR');
const pct = (n) => `${dec(n)}%`;

function bytes(b) {
  if (b == null || b < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${v} B` : `${dec(v, v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** "+1,2 MB", "−340 B" ou "0". */
function signedBytes(b) {
  if (!b) return '0';
  return `${b > 0 ? '+' : '−'}${bytes(Math.abs(b))}`;
}

function signedInt(n) {
  if (!n) return '0';
  return `${n > 0 ? '+' : '−'}${int(Math.abs(n))}`;
}

const clockOf = (date) => date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Os bytes de um corpo HTTP (o VM manda uma lista de inteiros) como texto; json fica indentado. */
function bodyText(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const text = Buffer.from(list).toString('utf8');
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const cut = (text, max = BODY_SHOWN) =>
  text.length > max ? `${text.slice(0, max)}\n… (mais ${int(text.length - max)} caracteres — o copiar leva tudo)` : text;

const headerLines = (headers) =>
  Object.entries(headers || {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');

/**
 * Um endereço de código curto, como o Dart escreveria: `package:flutter/src/…`
 * em vez do caminho do SDK no disco, `dart:developer/…` em vez do
 * `org-dartlang-sdk:///…`. O do próprio app vira `lib/…` pelo `locate` da central.
 */
function shortUrl(url) {
  // Os patches do VM (`_internal/vm/lib`) são o `dart:core-patch` que o próprio VM mostra.
  const patch = url.match(/^org-dartlang-sdk:\/\/\/.*?\/sdk\/lib\/_internal\/vm(?:_shared)?\/lib\/(.+)$/);
  if (patch) return `dart:core-patch/${patch[1]}`;
  const sdk = url.match(/^org-dartlang-sdk:\/\/\/.*?\/sdk\/lib\/(.+)$/);
  if (sdk) return `dart:${sdk[1]}`;
  // O `dart:ui` é do engine, não do SDK do Dart.
  const ui = url.match(/^org-dartlang-sdk:\/\/\/.*?\/lib\/ui\/(.+)$/);
  if (ui) return `dart:ui/${ui[1]}`;
  if (!url.startsWith('file://')) return url;
  const file = decodeURIComponent(url.slice(7));
  // O flutter do SDK (packages/flutter/lib) e os pacotes do pub cache (nome-versão/lib).
  const pkg = file.match(/\/packages\/([\w]+)\/lib\/(.+)$/) || file.match(/\/([\w]+)-[\w.+-]+\/lib\/(.+)$/);
  return pkg ? `package:${pkg[1]}/${pkg[2]}` : file;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class DevTools {
  constructor(session) {
    this.session = session;
    this.viewId = `devtools-${crypto.createHash('sha1').update(session.root).digest('hex').slice(0, 10)}`;
    this.viewOpen = false;
    this.tab = 'perf';
    this.wsUri = null;
    this.mode = null;
    this.vm = null;
    this.state = 'off'; // off | waiting | connecting | on | error
    this.error = null;
    this.timers = {};
    this.pushTimer = null;
    this.reset();
  }

  /** Tudo que é de uma conexão: uma nova (outro app, ou a janela reaberta) recomeça do zero. */
  reset() {
    this.frames = [];
    this.lastFrameAt = 0;
    this.recording = true;
    this.selected = null;
    this.refreshRate = 60;
    this.extensions = new Set();
    this.toggles = {};
    this.mem = { samples: [], gcs: 0, gcPending: false, classes: null, loading: false, baseline: null, filter: 'app', error: null };
    this.cpu = { state: 'idle', t0: 0, startedAt: 0, result: null, error: null, filter: 'app', sort: 'total' };
    this.net = { enabled: false, paused: false, since: 0, requests: new Map(), selected: null, detail: null, error: null };
  }

  // --- a vida da janela e da conexão -------------------------------------------

  /** O app subiu (ou trocou): guarda o endereço e, com a janela aberta, conecta. */
  attach(wsUri, mode) {
    this.disconnect();
    this.wsUri = wsUri;
    this.mode = mode || 'debug';
    this.state = 'waiting';
    if (this.viewOpen) this.connect();
    else this.push();
  }

  /** O app saiu: a janela volta a dizer que ele não está rodando. */
  detach() {
    this.disconnect();
    this.wsUri = null;
    this.state = 'off';
    this.push(true);
  }

  async show() {
    if (!DevTools.rfw) {
      await mx.request('window.showBanner', { text: 'esta Maestria não desenha widgets de plugin — abrindo o DevTools no navegador' }).catch(() => {});
      return this.session.openDevtoolsBrowser();
    }
    const r = await mx.request('view.open', {
      viewId: this.viewId,
      title: this.title(),
      rfw: { library: fs.readFileSync(LIBRARY, 'utf8'), root: 'root' },
      data: this.data(),
    });
    this.tabId = r && r.tabId;
    this.viewOpen = true;
    if (this.wsUri && !this.vm) await this.connect();
  }

  title() {
    return `devtools · ${this.session.name}`;
  }

  async connect() {
    if (this.vm || !this.wsUri) return;
    const wsUri = this.wsUri;
    this.reset();
    this.state = 'connecting';
    this.push(true);
    const vm = new VmService(wsUri, { streams: ['Isolate', 'Extension', 'GC'] });
    this.vm = vm;
    vm.on('extension', (ev) => this.vm === vm && this.onExtension(ev));
    vm.on('gc', () => {
      if (this.vm !== vm) return;
      this.mem.gcs += 1;
      this.mem.gcPending = true;
    });
    vm.on('isolate', () => this.vm === vm && this.state === 'on' && this.onIsolate());
    vm.on('extensionAdded', (name) => this.vm === vm && this.onExtensionAdded(name));
    vm.on('close', () => {
      if (this.vm !== vm) return;
      this.vm = null;
      this.stopTimers();
      if (this.state === 'on') this.state = this.wsUri ? 'error' : 'off';
      this.error = 'a conexão com o VM service caiu';
      this.push(true);
    });
    try {
      await vm.connect();
    } catch (e) {
      if (this.vm !== vm) return;
      this.vm = null;
      this.state = 'error';
      this.error = e.message;
      this.push(true);
      return;
    }
    if (this.vm !== vm) return vm.close();
    this.state = 'on';
    await this.onIsolate();
    this.startTimers();
    this.push(true);
    // Reaberta numa aba que liga coisas ao entrar: liga de novo.
    if (this.tab === 'net') {
      this.net.enabled = true;
      await this.enableHttp();
      await this.pollHttp();
    }
    if (this.tab === 'mem') await this.loadClasses(false);
    this.push(true);
  }

  disconnect() {
    this.stopTimers();
    const vm = this.vm;
    this.vm = null;
    if (vm) vm.close();
  }

  /** Você fechou a janela: nada de ficar perguntando ao app o que ninguém vê. */
  closed() {
    this.viewOpen = false;
    this.disconnect();
    if (this.wsUri) this.state = 'waiting';
  }

  startTimers() {
    this.stopTimers();
    this.timers.mem = setInterval(() => this.sampleMemory(), MEM_EVERY);
    this.timers.net = setInterval(() => this.pollHttp(), NET_EVERY);
    this.sampleMemory();
  }

  stopTimers() {
    for (const t of Object.values(this.timers)) clearInterval(t);
    this.timers = {};
  }

  /** O isolate da vez (o primeiro, ou o novo de um hot restart): as extensões e a taxa da tela. */
  async onIsolate() {
    const vm = this.vm;
    if (!vm || !vm.isolateId) return;
    const iso = await vm.call('getIsolate', { isolateId: vm.isolateId }).catch(() => null);
    if (this.vm !== vm) return;
    this.extensions = new Set((iso && iso.extensionRPCs) || []);
    // A gravação de CPU e o pedido aberto eram do isolate de antes.
    if (this.cpu.state === 'recording') this.cpu.state = 'idle';
    this.net.detail = null;
    this.net.selected = null;
    await this.readRefreshRate();
    await this.readToggles();
    if (this.net.enabled) await this.enableHttp();
    this.push(true);
  }

  /** As extensões chegam uma a uma depois do isolate subir: relê os interruptores numa leva só. */
  onExtensionAdded(name) {
    this.extensions.add(name);
    clearTimeout(this.extTimer);
    this.extTimer = setTimeout(async () => {
      await this.readToggles();
      if (name === 'ext.dart.io.httpEnableTimelineLogging' && this.net.enabled) await this.enableHttp();
      this.push();
    }, 300);
  }

  /** A taxa da tela do aparelho: 60, 90, 120 Hz. É ela que diz o orçamento de um frame. */
  async readRefreshRate() {
    const vm = this.vm;
    try {
      const views = await vm.call('_flutter.listViews');
      const view = views && views.views && views.views[0];
      if (!view) return;
      const r = await vm.call('_flutter.getDisplayRefreshRate', { viewId: view.id });
      if (r && r.fps >= 30) this.refreshRate = r.fps;
    } catch {}
  }

  // --- desempenho ----------------------------------------------------------------

  onExtension(ev) {
    const kind = ev.extensionKind;
    if (kind === 'Flutter.Frame') {
      if (!this.recording) return;
      const d = ev.extensionData || {};
      this.frames.push({ n: d.number, elapsed: d.elapsed || 0, build: d.build || 0, raster: d.raster || 0, vsync: d.vsyncOverhead || 0, start: d.startTime || 0 });
      if (this.frames.length > MAX_FRAMES) this.frames.splice(0, this.frames.length - MAX_FRAMES);
      this.lastFrameAt = Date.now();
      if (this.tab === 'perf') this.push();
    } else if (kind === 'Flutter.ServiceExtensionStateChanged') {
      // Mudado por outro lado: o DevTools do navegador, ou a tecla P do `flutter run`.
      const { extension, value } = ev.extensionData || {};
      const t = TOGGLES.find((x) => x.ext === extension);
      if (t) {
        this.toggles[t.ext] = t.read ? t.read({ timeDilation: value, enabled: value }) : String(value) === 'true';
        this.push();
      }
    }
  }

  async readToggles() {
    const vm = this.vm;
    for (const t of TOGGLES) {
      if (!this.extensions.has(t.ext)) continue;
      const r = await vm.call(t.ext, { isolateId: vm.isolateId }).catch(() => null);
      if (this.vm !== vm) return;
      if (r) this.toggles[t.ext] = t.read ? t.read(r) : r.enabled === 'true';
    }
  }

  async setToggle(ext) {
    const t = TOGGLES.find((x) => x.ext === ext);
    const vm = this.vm;
    if (!t || !vm) return;
    const on = !this.toggles[ext];
    try {
      const r = await vm.call(ext, { isolateId: vm.isolateId, ...(t.params ? t.params(on) : { enabled: String(on) }) });
      this.toggles[ext] = t.read ? t.read(r) : r.enabled === 'true';
    } catch (e) {
      await mx.request('window.showBanner', { text: `${t.label}: ${e.message}` }).catch(() => {});
    }
  }

  budget() {
    return 1e6 / this.refreshRate;
  }

  perfData() {
    const budget = this.budget();
    const hz = Math.round(this.refreshRate);
    const frames = this.frames;
    const jankOf = (f) => f.build > budget || f.raster > budget;
    const costOf = (f) => Math.max(f.build, f.raster);
    const janky = frames.filter(jankOf);
    const avg = (key) => (frames.length ? frames.reduce((s, f) => s + f[key], 0) / frames.length : 0);
    const avgBuild = avg('build');
    const avgRaster = avg('raster');
    const worst = frames.reduce((w, f) => (!w || costOf(f) > costOf(w) ? f : w), null);
    // Por segundo: o Flutter só desenha quando algo muda, então parado é zero, não 60.
    const newest = frames[frames.length - 1];
    const idle = !newest || Date.now() - this.lastFrameAt > 1500;
    const fps = idle ? 0 : frames.filter((f) => f.start >= newest.start - 1e6).length;

    const stats = [
      {
        label: 'frames/s',
        value: idle ? '0 · parado' : String(fps),
        hint: 'os frames desenhados no último segundo. O Flutter só desenha quando algo muda: parado é zero, e está tudo bem',
      },
      {
        label: 'jank',
        value: frames.length ? `${janky.length} · ${pct((janky.length / frames.length) * 100)}` : '—',
        tone: janky.length ? 'red' : frames.length ? 'green' : '',
        hint: `os frames com build ou raster acima de ${ms(budget)} (${hz} Hz) — os engasgos que se veem, dos ${int(frames.length)} gravados`,
      },
      {
        label: 'build médio',
        value: frames.length ? ms(avgBuild) : '—',
        tone: avgBuild > budget ? 'red' : 'blue',
        hint: 'o tempo no UI thread: o build, o layout e o paint dos widgets, em Dart',
      },
      {
        label: 'raster médio',
        value: frames.length ? ms(avgRaster) : '—',
        tone: avgRaster > budget ? 'red' : 'cyan',
        hint: 'o tempo no raster thread: transformar as camadas em pixels na GPU',
      },
      {
        label: 'pior frame',
        value: worst ? ms(costOf(worst)) : '—',
        tone: worst && jankOf(worst) ? 'red' : '',
        hint: worst ? `o frame ${worst.n}, no ${worst.build >= worst.raster ? 'build' : 'raster'}` : '',
      },
      { label: 'orçamento', value: ms(budget), hint: `um frame a ${hz} Hz, a taxa da tela do aparelho` },
    ];

    const scale = 2 * budget;
    const flex = (v) => Math.max(1, Math.min(100, Math.round((v / scale) * 100)));
    const bars = [];
    for (let i = frames.length - 1; i >= 0 && bars.length < CHART_FRAMES; i -= 1) {
      const f = frames[i];
      const b = flex(f.build);
      const r = flex(f.raster);
      bars.push({
        b,
        bt: 100 - b,
        bc: f.build > budget ? 'red' : 'blue',
        r,
        rt: 100 - r,
        rc: f.raster > budget ? 'red' : 'cyan',
        tip: `frame ${f.n} · ${ms(f.elapsed)}\nbuild ${ms(f.build)} · raster ${ms(f.raster)}`,
        action: `frame:${f.n}`,
        sel: f.n === this.selected,
      });
    }

    const sel = this.selected != null && frames.find((f) => f.n === this.selected);
    let detail = frames.length ? 'clique numa barra pra ver o frame' : this.recording ? 'esperando frames — mexa no app' : 'a gravação está pausada';
    let hint = `cada par de barras é um frame: o build (UI thread) e o raster (GPU). A linha é o orçamento de ${ms(budget)} a ${hz} Hz — acima dela, o frame atrasou.`;
    if (sel) {
      detail = `frame ${sel.n}: build ${ms(sel.build)} · raster ${ms(sel.raster)} · vsync ${ms(sel.vsync)} · total ${ms(sel.elapsed)}`;
      if (sel.build > budget) {
        hint = 'o build passou do orçamento: o Dart demorou no UI thread (build, layout, paint). Grave a CPU enquanto isso acontece pra ver em qual função — e procure setState alto demais na árvore, listas sem builder e trabalho pesado no build.';
      } else if (sel.raster > budget) {
        hint = 'o raster passou do orçamento: a GPU demorou pra desenhar. saveLayer, Opacity, clip, sombras e imagens grandes pesam; ligue o performance overlay e o "imagens grandes demais" aqui embaixo.';
      } else {
        hint = `dentro do orçamento de ${ms(budget)}.`;
      }
    } else if (this.selected != null) {
      this.selected = null;
    }

    const worstList = [...janky].sort((a, b) => costOf(b) - costOf(a)).slice(0, 5);
    const toggles = TOGGLES.filter((t) => this.extensions.has(t.ext)).map((t) => ({
      label: t.label,
      hint: t.hint,
      on: !!this.toggles[t.ext],
      action: `toggle:${t.ext}`,
    }));
    let togglesNote = 'mudam o app rodando, como os botões do DevTools e do Flutter Inspector.';
    if (!toggles.length) togglesNote = 'o app ainda não registrou as extensões do Flutter.';
    else if (this.mode === 'profile') togglesNote = 'em profile só sobra o que não é de debug — o debug paint e as outras voltam rodando em debug.';

    return {
      warn: this.modeWarning(),
      stats,
      recording: this.recording,
      bars,
      scaleTop: ms(scale),
      scaleMid: ms(budget),
      detail,
      hint,
      toggles,
      togglesNote,
      worst: worstList.map((f) => ({
        total: ms(costOf(f)),
        name: `frame ${f.n}`,
        split: `build ${ms(f.build)} · raster ${ms(f.raster)}${f.build > budget ? ' — o build atrasou' : ' — o raster atrasou'}`,
        action: `frame:${f.n}`,
        sel: f.n === this.selected,
      })),
      worstEmpty: frames.length && !janky.length ? `nenhum frame passou de ${ms(budget)}.` : frames.length ? '' : 'sem frames ainda.',
    };
  }

  modeWarning() {
    if (this.mode !== 'debug') return '';
    return 'modo debug: sem AOT e com asserts, os tempos saem bem piores que no app de verdade. Pra medir, rode uma configuração em profile (flutterMode: "profile" no launch.json).';
  }

  // --- CPU -----------------------------------------------------------------------

  async toggleCpu() {
    if (this.cpu.state === 'recording') return this.stopCpu();
    const vm = this.vm;
    if (!vm || this.cpu.state === 'loading') return;
    try {
      // O profiler vem ligado em debug e profile; se alguém desligou, liga.
      const flags = await vm.call('getFlagList');
      const profiler = (flags.flags || []).find((f) => f.name === 'profiler');
      if (profiler && profiler.valueAsString !== 'true') await vm.call('setVMFlag', { name: 'profiler', value: 'true' });
      const t = await vm.call('getVMTimelineMicros');
      Object.assign(this.cpu, { state: 'recording', t0: t.timestamp, startedAt: Date.now(), error: null });
      this.timers.cpu = setInterval(() => {
        if (Date.now() - this.cpu.startedAt >= CPU_MAX_MS) this.stopCpu();
        else if (this.tab === 'cpu') this.push();
      }, 500);
    } catch (e) {
      Object.assign(this.cpu, { state: 'idle', error: e.message });
    }
  }

  async stopCpu() {
    const vm = this.vm;
    clearInterval(this.timers.cpu);
    delete this.timers.cpu;
    if (!vm || this.cpu.state !== 'recording') return;
    this.cpu.state = 'loading';
    const secs = (Date.now() - this.cpu.startedAt) / 1000;
    this.push(true);
    try {
      const t1 = (await vm.call('getVMTimelineMicros')).timestamp;
      const r = await vm.call('getCpuSamples', { isolateId: vm.isolateId, timeOriginMicros: this.cpu.t0, timeExtentMicros: t1 - this.cpu.t0 });
      const fns = (r.functions || [])
        .map((f, i) => ({ i, kind: f.kind, fn: f.function || {}, url: f.resolvedUrl || '', self: f.exclusiveTicks || 0, total: f.inclusiveTicks || 0 }))
        .filter((f) => f.total > 0);
      this.cpu.result = { samples: r.sampleCount || 0, period: r.samplePeriod || 0, secs, fns };
      this.cpu.state = 'done';
    } catch (e) {
      this.cpu.state = 'idle';
      this.cpu.error = e.message;
    }
  }

  isAppUrl(url) {
    const pkg = this.session.pkg;
    if (pkg && url.startsWith(`package:${pkg}/`)) return true;
    if (url.startsWith('file://')) return decodeURIComponent(url.slice(7)).startsWith(this.session.root);
    return false;
  }

  /** "Classe.método", "função.<closure>" ou o nome do nativo. */
  static fnName(fn) {
    const name = fn.name || '?';
    const owner = fn.owner;
    if (!owner || !owner.name || owner.type === '@Library') return name;
    if (owner.type === '@Function') return `${DevTools.fnName(owner)}.${name === '<anonymous closure>' ? '<closure>' : name}`;
    return `${owner.name}.${name}`;
  }

  cpuRows() {
    const res = this.cpu.result;
    if (!res) return [];
    const { filter, sort } = this.cpu;
    const shown = res.fns.filter((f) => (filter === 'app' ? this.isAppUrl(f.url) : filter === 'dart' ? f.kind === 'Dart' : true));
    shown.sort((a, b) => b[sort] - a[sort] || b.total - a.total);
    return shown.slice(0, 80);
  }

  cpuData() {
    const c = this.cpu;
    const res = c.result;
    const secs = c.state === 'recording' ? (Date.now() - c.startedAt) / 1000 : 0;
    let status = 'grave alguns segundos enquanto faz no app o que está lento: a lista diz onde o tempo foi.';
    if (c.state === 'recording') status = `gravando… ${dec(secs)} s — faça no app o que está lento e pare aqui.`;
    else if (c.state === 'loading') status = 'lendo as amostras…';
    else if (c.error) status = `não gravou: ${c.error}`;
    else if (res) status = `${int(res.samples)} amostras em ${dec(res.secs)} s, uma a cada ${int(res.period)} µs. Próprio é o tempo na função; total inclui o que ela chamou.`;

    const rows = this.cpuRows();
    let empty = '';
    if (!res) empty = c.state === 'recording' ? 'gravando…' : 'nenhuma gravação ainda.';
    else if (!rows.length) {
      empty = c.filter === 'app'
        ? 'nenhuma amostra no seu código: o app estava parado, ou o tempo foi todo no framework — veja "Dart" ou "tudo".'
        : 'nenhuma amostra nessa gravação.';
    }
    const kinds = { Native: 'nativo', Stub: 'stub do VM', Tag: 'marcador do VM', Collected: 'coletado' };
    return {
      warn: this.modeWarning(),
      button: c.state === 'recording' ? 'parar e ver' : res ? 'gravar de novo' : 'gravar',
      buttonIcon: c.state === 'recording' ? 'stop' : 'play',
      primary: c.state !== 'recording',
      status,
      filters: [
        { label: 'meu código', action: 'cpu-filtro:app', active: c.filter === 'app' },
        { label: 'Dart', action: 'cpu-filtro:dart', active: c.filter === 'dart' },
        { label: 'tudo', action: 'cpu-filtro:all', active: c.filter === 'all' },
      ],
      sorts: [
        { label: 'por total', action: 'cpu-ordem:total', active: c.sort === 'total' },
        { label: 'por próprio', action: 'cpu-ordem:self', active: c.sort === 'self' },
      ],
      empty,
      rows: rows.map((f) => {
        const self = res.samples ? (f.self / res.samples) * 100 : 0;
        const total = res.samples ? (f.total / res.samples) * 100 : 0;
        const fill = (p) => Math.max(0, Math.min(1000, Math.round(p * 10)));
        const loc = f.fn.location;
        let where = kinds[f.kind] || f.kind || '';
        if (f.kind === 'Dart' && f.url) {
          const line = loc && loc.line ? `:${loc.line}` : '';
          where = this.isAppUrl(f.url) ? this.session.locate({ uri: f.url, line: loc && loc.line }).where : `${shortUrl(f.url)}${line}`;
        }
        return {
          name: DevTools.fnName(f.fn),
          where,
          self: `${pct(self)}`,
          total: `${pct(total)}`,
          selfFill: fill(self),
          selfRest: 1000 - fill(self),
          totalFill: fill(total),
          totalRest: 1000 - fill(total),
          bySelf: c.sort === 'self',
          byTotal: c.sort === 'total',
          action: `fn:${f.i}`,
        };
      }),
    };
  }

  /** Abre no editor a função de uma linha da CPU (ou a classe de uma linha da memória). */
  async openSource(uri, location) {
    if (!uri) return;
    let line = location && location.line;
    if (!line && location && location.script && location.tokenPos != null && this.vm) {
      line = await this.vm._lineOf(location.script.id, location.tokenPos).catch(() => null);
    }
    const { file } = this.session.locate({ uri, line });
    if (!file || !fs.existsSync(file)) {
      await mx.request('window.showBanner', { text: `não achei o arquivo de ${uri}` }).catch(() => {});
      return;
    }
    await mx.request('editor.open', { path: file, line: line || undefined }).catch(() => {});
  }

  // --- memória ---------------------------------------------------------------------

  async sampleMemory() {
    const vm = this.vm;
    if (!vm || !vm.isolateId || this.sampling) return;
    this.sampling = true;
    try {
      const u = await vm.call('getMemoryUsage', { isolateId: vm.isolateId });
      // O RSS do processo inteiro: o `getVM` traz num campo privado, que é de onde o DevTools lê.
      const info = await vm.call('getVM').catch(() => null);
      if (this.vm !== vm) return;
      this.mem.samples.push({
        used: u.heapUsage || 0,
        cap: u.heapCapacity || 0,
        ext: u.externalUsage || 0,
        rss: info && typeof info._currentRSS === 'number' ? info._currentRSS : null,
        gc: this.mem.gcPending,
        at: Date.now(),
      });
      this.mem.gcPending = false;
      if (this.mem.samples.length > MEM_SAMPLES) this.mem.samples.splice(0, this.mem.samples.length - MEM_SAMPLES);
      if (this.tab === 'mem') this.push();
    } catch {
      // Um hot restart no meio: a próxima amostra já pega o isolate novo.
    } finally {
      this.sampling = false;
    }
  }

  async loadClasses(gc) {
    const vm = this.vm;
    if (!vm || !vm.isolateId || this.mem.loading) return;
    this.mem.loading = true;
    this.push(true);
    try {
      const r = await vm.call('getAllocationProfile', { isolateId: vm.isolateId, ...(gc ? { gc: true } : {}) });
      if (this.vm !== vm) return;
      this.mem.classes = (r.members || [])
        .filter((m) => m.class && (m.instancesCurrent > 0 || m.bytesCurrent > 0))
        .map((m) => ({
          id: m.class.id,
          name: m.class.name,
          lib: (m.class.library && m.class.library.uri) || '',
          location: m.class.location || null,
          count: m.instancesCurrent || 0,
          size: m.bytesCurrent || 0,
        }));
      this.mem.countedAt = new Date();
      this.mem.error = null;
    } catch (e) {
      this.mem.error = e.message;
    } finally {
      this.mem.loading = false;
    }
  }

  /** Marca o agora: dali em diante cada classe mostra quanto cresceu. É como se acha um vazamento. */
  async toggleBaseline() {
    if (this.mem.baseline) {
      this.mem.baseline = null;
      return;
    }
    await this.loadClasses(true);
    if (!this.mem.classes) return;
    this.mem.baseline = { at: new Date(), byId: new Map(this.mem.classes.map((c) => [c.id, c])) };
  }

  classRows() {
    const all = this.mem.classes || [];
    const pkg = this.session.pkg;
    const shown = this.mem.filter === 'app' ? all.filter((c) => (pkg && c.lib.startsWith(`package:${pkg}/`)) || this.isAppUrl(c.lib)) : all;
    const base = this.mem.baseline;
    const withDelta = shown.map((c) => {
      const b = base && base.byId.get(c.id);
      return { ...c, dSize: base ? c.size - (b ? b.size : 0) : 0, dCount: base ? c.count - (b ? b.count : 0) : 0 };
    });
    withDelta.sort((a, b) => (base ? b.dSize - a.dSize || b.size - a.size : b.size - a.size));
    return withDelta.slice(0, 60);
  }

  memData() {
    const m = this.mem;
    const samples = m.samples;
    const last = samples[samples.length - 1];
    const max = Math.max(1, ...samples.map((s) => s.cap + s.ext));
    const flex = (v) => Math.max(0, Math.round((v / max) * 1000));
    const bars = [];
    for (let i = 0; i < MEM_SAMPLES - samples.length; i += 1) bars.push({ empty: 1, free: 0, ext: 0, used: 0, gc: false, tip: '' });
    for (const s of samples) {
      const used = flex(s.used);
      const ext = flex(s.ext);
      const free = flex(Math.max(0, s.cap - s.used));
      bars.push({
        empty: Math.max(0, 1000 - used - ext - free),
        free,
        ext,
        used,
        gc: s.gc,
        tip: `${clockOf(new Date(s.at))}\nusado ${bytes(s.used)} de ${bytes(s.cap)}\nexterno ${bytes(s.ext)}${s.rss != null ? `\nRSS ${bytes(s.rss)}` : ''}${s.gc ? '\nhouve GC' : ''}`,
      });
    }
    const base = m.baseline;
    const rows = this.classRows();
    let note = 'o tamanho é o raso: só o objeto, sem o que ele aponta. Marque, use o app e conte de novo pra ver o que cresceu.';
    if (m.loading) note = 'contando os objetos…';
    else if (m.error) note = `não contou: ${m.error}`;
    else if (!m.classes) note = 'ainda não contou.';
    else if (!rows.length && m.filter === 'app') note = 'nenhum objeto de uma classe do app agora — veja "tudo".';
    else if (base) note = `comparando com ${clockOf(base.at)}: o Δ é quanto cresceu desde a marca. O que só cresce enquanto você usa e volta é suspeito de vazamento.`;
    if (m.classes && !m.loading && m.countedAt) note = `${note} Contado às ${clockOf(m.countedAt)}.`;

    return {
      stats: [
        { label: 'heap usado', value: last ? bytes(last.used) : '—', tone: 'blue', hint: 'os objetos Dart vivos (e o lixo que o GC ainda não passou)' },
        { label: 'capacidade', value: last ? bytes(last.cap) : '—', hint: 'o que o VM já reservou pro heap' },
        { label: 'externo', value: last ? bytes(last.ext) : '—', tone: 'cyan', hint: 'memória fora do heap presa a objetos Dart: imagens decodificadas, buffers' },
        { label: 'RSS do processo', value: last && last.rss != null ? bytes(last.rss) : '—', hint: 'o que o sistema diz que o app ocupa, com o engine, as texturas e o nativo' },
        { label: 'coletas (GC)', value: int(m.gcs), hint: 'quantas vezes o garbage collector rodou desde que a janela conectou' },
      ],
      scale: bytes(max),
      samples: bars,
      from: samples.length ? `há ${samples.length} s` : '',
      filters: [
        { label: 'do app', action: 'classes-filtro:app', active: m.filter === 'app' },
        { label: 'tudo', action: 'classes-filtro:all', active: m.filter === 'all' },
      ],
      mark: base ? 'tirar a marca' : 'marcar agora',
      markIcon: base ? 'clear' : 'star',
      marked: !!base,
      note,
      deltaHead: base ? 'Δ desde a marca' : '',
      classes: rows.map((c, i) => ({
        name: c.name,
        lib: c.lib,
        count: int(c.count),
        size: bytes(c.size),
        delta: base ? signedBytes(c.dSize) : '',
        deltaCount: base ? `${signedInt(c.dCount)} obj.` : '',
        tone: base && c.dSize > 0 ? 'red' : base && c.dSize < 0 ? 'green' : '',
        action: `classe:${i}`,
      })),
    };
  }

  // --- rede ------------------------------------------------------------------------

  /** Liga o perfil HTTP do `dart:io` — é o que o DevTools faz ao abrir a aba Network. */
  async enableHttp() {
    const vm = this.vm;
    if (!vm || !vm.isolateId) return;
    if (!this.extensions.has('ext.dart.io.httpEnableTimelineLogging')) {
      this.net.error = 'este app não expõe o perfil HTTP do dart:io (no web não há).';
      return;
    }
    try {
      await vm.call('ext.dart.io.httpEnableTimelineLogging', { isolateId: vm.isolateId, enabled: true });
      this.net.error = null;
      this.net.since = 0;
    } catch (e) {
      this.net.error = e.message;
    }
  }

  async pollHttp() {
    const vm = this.vm;
    const n = this.net;
    if (!vm || !vm.isolateId || !n.enabled || n.paused || n.error || this.polling) return;
    this.polling = true;
    try {
      const r = await vm.call('ext.dart.io.getHttpProfile', { isolateId: vm.isolateId, ...(n.since ? { updatedSince: n.since } : {}) });
      if (this.vm !== vm) return;
      if (r.timestamp) n.since = r.timestamp;
      let changed = false;
      for (const req of r.requests || []) {
        n.requests.set(String(req.id), req);
        changed = true;
      }
      if (n.requests.size > MAX_REQUESTS) {
        const old = [...n.requests.values()].sort((a, b) => a.startTime - b.startTime).slice(0, n.requests.size - MAX_REQUESTS);
        for (const o of old) n.requests.delete(String(o.id));
      }
      if (changed && this.tab === 'net') this.push();
    } catch {
      // Um hot restart no meio: o isolate novo liga o perfil de novo (`onIsolate`).
    } finally {
      this.polling = false;
    }
  }

  async openRequest(id) {
    const n = this.net;
    if (n.selected === id) {
      n.selected = null;
      n.detail = null;
      return;
    }
    n.selected = id;
    n.detail = null;
    this.push(true);
    const vm = this.vm;
    if (!vm) return;
    try {
      const r = await vm.call('ext.dart.io.getHttpProfileRequest', { isolateId: vm.isolateId, id });
      if (n.selected === id) n.detail = r;
    } catch (e) {
      if (n.selected === id) n.detail = { error: e.message };
    }
  }

  static statusOf(req) {
    const res = req.response;
    const failed = (req.request && req.request.error) || (res && res.error);
    if (failed) return { text: 'erro', tone: 'red' };
    if (!res || !res.statusCode) return { text: '…', tone: 'faint' };
    const code = res.statusCode;
    return { text: String(code), tone: code >= 500 ? 'red' : code >= 400 ? 'yellow' : code >= 300 ? 'accent' : 'green' };
  }

  /** Do começo até a resposta inteira chegar; sem resposta, só um pedido que falhou tem fim. */
  static durationOf(req) {
    const end = req.response ? req.response.endTime : req.request && req.request.error ? req.endTime : null;
    return end && req.startTime ? end - req.startTime : null;
  }

  netDetail() {
    const d = this.net.detail;
    const summary = this.net.requests.get(this.net.selected);
    if (!d || !summary) return { title: summary ? `${summary.method} ${summary.uri}` : '', kv: [{ k: '', v: 'carregando…' }], sections: [] };
    if (d.error) return { title: `${summary.method} ${summary.uri}`, kv: [{ k: 'erro', v: d.error, tone: 'red' }], sections: [] };
    const req = d.request || {};
    const res = d.response || {};
    const st = DevTools.statusOf(d);
    const dur = DevTools.durationOf(d);
    const conn = req.connectionInfo || res.connectionInfo;
    const kv = [
      { k: 'status', v: res.statusCode ? `${res.statusCode}${res.reasonPhrase ? ` ${res.reasonPhrase}` : ''}` : st.text, tone: st.tone === 'red' ? 'red' : '' },
      { k: 'duração', v: dur != null ? ms(dur) : 'ainda não terminou' },
      { k: 'início', v: clockOf(new Date(d.startTime / 1000)) },
      { k: 'tamanho', v: res.contentLength >= 0 ? bytes(res.contentLength) : d.responseBody ? bytes(d.responseBody.length) : '—' },
    ];
    if (conn && conn.remoteAddress) kv.push({ k: 'conexão', v: `${conn.remoteAddress}:${conn.remotePort}` });
    const failed = req.error || res.error;
    if (failed) kv.push({ k: 'erro', v: String(failed), tone: 'red' });
    if (d.events && d.events.length) {
      kv.push({ k: 'etapas', v: d.events.map((e) => `+${ms(e.timestamp - d.startTime)} ${e.event}`).join('\n') });
    }
    const reqBody = bodyText(d.requestBody);
    const resBody = bodyText(d.responseBody);
    this.net.copies = [headerLines(req.headers), reqBody, headerLines(res.headers), resBody];
    const sections = [
      { title: 'cabeçalhos do pedido', text: headerLines(req.headers) || '(nenhum)' },
      { title: 'corpo do pedido', text: cut(reqBody) || '(vazio)' },
      { title: 'cabeçalhos da resposta', text: headerLines(res.headers) || '(nenhum)' },
      { title: 'corpo da resposta', text: cut(resBody) || '(vazio)' },
    ].map((s, i) => ({ ...s, action: `copiar:${i}` }));
    return { title: `${d.method} ${d.uri}`, kv, sections };
  }

  /** O pedido aberto como um `curl` pra colar no terminal. */
  curl() {
    const d = this.net.detail;
    if (!d || d.error) return null;
    const parts = ['curl', '-X', d.method, shellQuote(d.uri)];
    for (const [k, v] of Object.entries((d.request && d.request.headers) || {})) {
      // O tamanho e a conexão o curl calcula; mandar os do Dart estraga o pedido.
      if (['content-length', 'host', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) continue;
      parts.push('-H', shellQuote(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`));
    }
    if (Array.isArray(d.requestBody) && d.requestBody.length) parts.push('--data-raw', shellQuote(Buffer.from(d.requestBody).toString('utf8')));
    return parts.join(' ');
  }

  netData() {
    const n = this.net;
    const reqs = [...n.requests.values()].sort((a, b) => b.startTime - a.startTime);
    const rows = reqs.map((r) => {
      let host = '';
      let where = r.uri;
      try {
        const u = new URL(r.uri);
        host = u.host;
        where = `${u.pathname}${u.search}`;
      } catch {}
      const st = DevTools.statusOf(r);
      const dur = DevTools.durationOf(r);
      const len = r.response && r.response.contentLength;
      return {
        method: r.method,
        status: st.text,
        tone: st.tone,
        path: where,
        host,
        time: dur != null ? ms(dur) : '…',
        size: len >= 0 ? bytes(len) : '—',
        action: `req:${r.id}`,
        sel: String(r.id) === n.selected,
      };
    });
    const failed = reqs.filter((r) => DevTools.statusOf(r).tone === 'red').length;
    let status = n.paused ? 'gravação pausada' : 'gravando os pedidos HTTP do dart:io (http, dio, HttpClient)';
    if (reqs.length) status = `${int(reqs.length)} pedido${reqs.length > 1 ? 's' : ''}${failed ? `, ${failed} com erro` : ''} · ${status}`;
    let empty = '';
    if (n.error) empty = n.error;
    else if (!rows.length) empty = 'nenhum pedido ainda — use o app. Entram os que passam pelo HttpClient do dart:io: o package:http e o dio usam ele por baixo. Os feitos por plugins nativos (Firebase, por exemplo) não passam por aqui.';
    const open = !!n.selected && n.requests.has(n.selected);
    return { status, paused: n.paused, empty, rows, open, detail: open ? this.netDetail() : { title: '', kv: [], sections: [] } };
  }

  // --- o que vai pra janela -------------------------------------------------------

  head() {
    const s = this.session;
    const live = this.state === 'on';
    const mode = this.mode || (s.run && s.run.mode) || 'debug';
    let offline = 'o app não está rodando — F5 (ou o ▶ da central) inicia, e o DevTools conecta sozinho.';
    let status = `${s.name} · parado`;
    let dot = 'faint';
    if (this.state === 'waiting' || (s.running && !this.wsUri)) {
      offline = s.run && s.run.mode === 'release' ? 'em release não há VM service — rode em debug ou profile.' : 'esperando o app subir…';
      status = `${s.name} · subindo`;
      dot = 'yellow';
    } else if (this.state === 'connecting') {
      offline = 'conectando no VM service do app…';
      status = `${s.name} · conectando`;
      dot = 'yellow';
    } else if (this.state === 'error') {
      offline = `não conectou no VM service: ${this.error}`;
      status = `${s.name} · sem conexão`;
      dot = 'red';
    } else if (live) {
      status = `${s.name} · ${s.deviceName()} · ${mode} · ${Math.round(this.refreshRate)} Hz`;
      dot = 'green';
    }
    return {
      live,
      tab: this.tab,
      status,
      dot,
      offline,
      tabs: TABS.map((t) => ({ label: t.label, icon: t.icon, action: `tab:${t.id}`, active: t.id === this.tab })),
    };
  }

  /** A cabeça e só a aba da vez: as outras não estão na tela. */
  data() {
    const out = { head: this.head() };
    if (this.state !== 'on') return out;
    if (this.tab === 'perf') out.perf = this.perfData();
    else if (this.tab === 'cpu') out.cpu = this.cpuData();
    else if (this.tab === 'mem') out.mem = this.memData();
    else if (this.tab === 'net') out.net = this.netData();
    return out;
  }

  /** Manda os dados, em lote: vários eventos seguidos viram um envio só. `now` pula a espera. */
  push(now = false) {
    if (!this.viewOpen) return;
    if (now) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
      this.send();
      return;
    }
    if (!this.pushTimer) this.pushTimer = setTimeout(() => this.send(), PUSH_MS);
  }

  async send() {
    this.pushTimer = null;
    if (!this.viewOpen) return;
    const r = await mx.request('view.update', { viewId: this.viewId, title: this.title(), data: this.data() }).catch(() => null);
    if (r && r.open === false) this.closed();
  }

  // --- os cliques ------------------------------------------------------------------

  async act(action, values) {
    const a = String((values && (values.a || values.action)) || action || '');
    const i = a.indexOf(':');
    const verb = i < 0 ? a : a.slice(0, i);
    const arg = i < 0 ? '' : a.slice(i + 1);
    switch (verb) {
      case 'tab':
        if (!TABS.some((t) => t.id === arg)) return;
        this.tab = arg;
        this.push(true);
        if (arg === 'net' && !this.net.enabled) {
          this.net.enabled = true;
          await this.enableHttp();
          await this.pollHttp();
        }
        if (arg === 'mem' && !this.mem.classes) await this.loadClasses(false);
        break;
      case 'navegador':
        await this.session.openDevtoolsBrowser();
        return;
      case 'frame': {
        const n = Number(arg);
        this.selected = this.selected === n ? null : n;
        break;
      }
      case 'gravar-frames':
        this.recording = !this.recording;
        break;
      case 'limpar-frames':
        this.frames = [];
        this.selected = null;
        break;
      case 'toggle':
        await this.setToggle(arg);
        break;
      case 'cpu':
        await this.toggleCpu();
        break;
      case 'cpu-filtro':
        this.cpu.filter = arg;
        break;
      case 'cpu-ordem':
        this.cpu.sort = arg === 'self' ? 'self' : 'total';
        break;
      case 'fn': {
        const f = this.cpu.result && this.cpu.result.fns.find((x) => x.i === Number(arg));
        if (f && f.kind === 'Dart') await this.openSource(f.url, f.fn.location);
        return;
      }
      case 'classes':
        await this.loadClasses(false);
        break;
      case 'gc':
        await this.loadClasses(true);
        break;
      case 'marcar':
        await this.toggleBaseline();
        break;
      case 'classes-filtro':
        this.mem.filter = arg === 'all' ? 'all' : 'app';
        break;
      case 'classe': {
        const c = this.classRows()[Number(arg)];
        if (c && c.location && c.location.script) await this.openSource(c.location.script.uri, c.location);
        return;
      }
      case 'req':
        await this.openRequest(arg);
        break;
      case 'rede-fechar':
        this.net.selected = null;
        this.net.detail = null;
        break;
      case 'rede-pausar':
        this.net.paused = !this.net.paused;
        break;
      case 'rede-limpar':
        if (this.vm && this.extensions.has('ext.dart.io.clearHttpProfile')) {
          await this.vm.call('ext.dart.io.clearHttpProfile', { isolateId: this.vm.isolateId }).catch(() => {});
        }
        this.net.requests.clear();
        this.net.selected = null;
        this.net.detail = null;
        break;
      case 'rede-curl': {
        const text = this.curl();
        if (text) {
          await mx.request('clipboard.write', { text });
          await mx.request('window.showBanner', { text: 'curl copiado' }).catch(() => {});
        }
        return;
      }
      case 'copiar': {
        const text = (this.net.copies || [])[Number(arg)];
        if (text) {
          await mx.request('clipboard.write', { text });
          await mx.request('window.showBanner', { text: 'copiado' }).catch(() => {});
        }
        return;
      }
      default:
        return;
    }
    this.push(true);
  }

  kill() {
    this.disconnect();
  }
}

/** Se a janela desenha widgets de plugin (o `rfw` do `initialize`). Sem isso, o DevTools vai pro navegador. */
DevTools.rfw = true;

module.exports = { DevTools };
