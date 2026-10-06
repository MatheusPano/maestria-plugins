// Uma central de debug: um projeto, com a janela, a barra, o console e o app
// rodando dele.
//
// Uma por projeto, e quantas você abrir: dois apps lado a lado são duas destas,
// cada uma com o seu `flutter run`, o seu depurador e o seu console — como duas
// sessões de debug no VS Code.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mx = require('./maestria');
const sdk = require('./sdk');
const { FlutterRun, devices, emulators, launchEmulator } = require('./daemon');
const { VmService } = require('./vm');
const { DevTools } = require('./devtools');
const settings = require('./settings');

const CONSOLE = 'console';
const MAX_LINES = 5000;
const SHOWN_WHEN_FILTERED = 2000;

// --- o que fica guardado por projeto --------------------------------------

const dataDir = process.env.MAESTRIA_PLUGIN_DATA || __dirname;
const savedFile = path.join(dataDir, 'projetos.json');

function loadSaved() {
  try {
    return JSON.parse(fs.readFileSync(savedFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeSaved(all) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(savedFile, JSON.stringify(all, null, 2));
  } catch {}
}

// Os aparelhos são do SDK, não do projeto: duas centrais no mesmo flutter não
// precisam perguntar duas vezes (o `flutter devices` leva segundos).
const deviceCache = new Map();
// Os emuladores também: `flutter daemon` pra listar leva o mesmo tanto.
const emulatorCache = new Map();

/** Quanto se espera o emulador aparecer no `flutter devices` depois de abrir. */
const EMULATOR_BOOT_MS = 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function banner(text, sticky = false) {
  await mx.request('window.showBanner', { text, sticky }).catch(() => {});
}

/** A linha como a janela recebe: o texto e a cor do tipo dela. */
function painted(line) {
  const tone = settings.colorOf(line.cat);
  return tone ? { text: line.text, tone } : { text: line.text };
}

class Session {
  constructor(root) {
    this.root = root;
    this.viewId = `central-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 10)}`;
    this.tabId = null;
    this.viewOpen = false;
    this.renderQueued = false;

    this.run = null;
    this.vm = null;
    this.phase = 'parado'; // parado | subindo | rodando | parando
    this.progress = null;
    this.pause = null; // { text, frames }
    this.lastStep = null;
    this.filter = '';
    this.packages = null;

    this.buffer = [];
    this.pending = [];
    this.flushTimer = null;

    this.launching = null; // o nome do emulador que está abrindo

    this.browserDevtools = null;
    this.panel = new DevTools(this);
    this.watcher = null;
    this.reloadTimer = null;
    this.adopt();
  }

  /** O nome nos títulos e avisos: o que a aba dá (`main.js`, com o worktree), senão a pasta. */
  get name() {
    return this.label || path.basename(this.root);
  }

  get running() {
    return !!this.run && !this.run.exited;
  }

  // --- o projeto ----------------------------------------------------------

  adopt() {
    this.pkg = sdk.packageName(this.root);
    const saved = loadSaved()[this.root] || {};
    this.sdk = sdk.resolveSdk(this.root, saved.sdkOverride);
    const { configs, problem } = sdk.launchConfigs(this.root);
    this.configs = configs;
    this.configProblem = problem;
    this.config = configs.some((c) => c.name === saved.config) ? saved.config : configs[0].name;
    this.device = saved.device || '';
    this.autoReload = saved.autoReload !== false;
    this.pauseExceptions = saved.pauseExceptions !== false;
    this.packages = null;
    this.devices = null;
    this.devicesError = null;
    this.refreshDevices();
    this.watch();
  }

  save() {
    const all = loadSaved();
    all[this.root] = {
      config: this.config,
      device: this.device,
      autoReload: this.autoReload,
      pauseExceptions: this.pauseExceptions,
      sdkOverride: all[this.root] && all[this.root].sdkOverride,
    };
    writeSaved(all);
  }

  currentConfig() {
    return this.configs.find((c) => c.name === this.config) || this.configs[0];
  }

  async refreshDevices(force = false) {
    if (!this.sdk) return;
    const key = this.sdk.flutter;
    if (!force && deviceCache.has(key)) {
      Object.assign(this, await deviceCache.get(key));
    } else {
      this.devices = null;
      this.render();
      const asked = devices(key, this.root).then(({ list, error }) => ({ devices: list, devicesError: error }));
      deviceCache.set(key, asked);
      // A lista de emuladores vem junto, pra estar pronta quando o botão for clicado.
      if (force || !emulatorCache.has(key)) emulatorCache.set(key, emulators(key, this.root));
      Object.assign(this, await asked);
    }
    if (this.device && !this.devices.some((d) => d.id === this.device)) this.device = '';
    this.render();
  }

  // --- o console ----------------------------------------------------------

  matches(line) {
    return !this.filter || line.text.toLowerCase().includes(this.filter.toLowerCase());
  }

  /**
   * Uma linha do console, com o tipo dela (ver `settings.js`). A cor sai do
   * tipo só na hora de mandar pra janela, então trocar uma cor nas
   * configurações recolore o console inteiro, as linhas velhas inclusive.
   *
   * O log do app que tem cara de logcat (`D/FirebaseMessaging( 1234): …`) é
   * nativo: o flutter repassa as linhas do processo do app. A tag `flutter` é
   * a exceção -- é o Dart. As de erro do lado nativo (E/ e F/) contam como erro.
   */
  append(text, category = 'tool') {
    let cat = category;
    const str = String(text);
    if (cat === 'app') {
      // A tag `flutter` é o próprio Dart (`I/flutter ( 123): …`), que é log do app.
      const m = str.match(/^([VDIWEF])\/([\w.$-]+)\s*\(\s*\d+\):/);
      if (m && m[2] !== 'flutter') cat = m[1] === 'E' || m[1] === 'F' ? 'error' : 'native';
    }
    const line = { text: str, cat };
    this.buffer.push(line);
    if (this.buffer.length > MAX_LINES) this.buffer.splice(0, this.buffer.length - MAX_LINES);
    if (!this.matches(line)) return;
    this.pending.push(line);
    // Em lotes: um build do gradle escreve centenas de linhas por segundo, e
    // uma chamada por linha seria o protocolo inteiro ocupado com isso.
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 80);
  }

  async flush() {
    this.flushTimer = null;
    if (!this.pending.length || !this.viewOpen) {
      this.pending = [];
      return;
    }
    const lines = this.pending.map(painted);
    this.pending = [];
    const r = await mx
      .request('view.appendLines', { viewId: this.viewId, id: CONSOLE, lines })
      .catch(() => ({ open: false }));
    if (!r.open) this.viewOpen = false;
  }

  visibleLines() {
    const shown = this.buffer.filter((l) => this.matches(l));
    return (this.filter ? shown.slice(-SHOWN_WHEN_FILTERED) : shown).map(painted);
  }

  // --- a janela -----------------------------------------------------------

  title() {
    return `flutter · ${this.name}`;
  }

  /** O nome do aparelho escolhido, ou "aparelho automático". */
  deviceName() {
    return this.device
      ? ((this.devices || []).find((d) => d.id === this.device) || { name: this.device }).name
      : 'aparelho automático';
  }

  /**
   * As opções do seletor de aparelho. Procurando: o `flutter devices` leva uns
   * segundos, e o campo diz isso com um spinner em vez de ficar em branco. O
   * valor é o aparelho salvo, pra ele não piscar quando a lista chegar com ele
   * dentro.
   */
  deviceOptions() {
    if (this.devices === null) return [{ value: this.device, label: 'procurando aparelhos…' }];
    return [
      { value: '', label: 'aparelho automático' },
      ...this.devices.map((d) => ({ value: d.id, label: `${d.name} · ${d.targetPlatform}` })),
    ];
  }

  statusLine() {
    if (!this.sdk) return { text: 'não achei o flutter deste projeto — diga onde ele está aqui embaixo', style: 'error' };
    const config = this.currentConfig();
    const where = `${config.name} · ${this.deviceName()} · flutter ${this.sdk.source}`;
    if (this.pause) return { text: `⏸ pausado — ${this.pause.text}`, style: 'warning' };
    if (this.launching && !this.running) return { text: `◌ abrindo o emulador ${this.launching}…`, style: 'dim' };
    const progress = this.progress ? ` · ${this.progress}` : '';
    switch (this.phase) {
      case 'subindo':
        return { text: `◌ subindo · ${where}${progress}`, style: 'dim' };
      case 'rodando':
        return { text: `● rodando · ${where}${progress}`, style: 'success' };
      case 'parando':
        return { text: '◌ parando…', style: 'dim' };
      default:
        return { text: `parado · ${where}`, style: 'dim' };
    }
  }

  /**
   * A barra de debug. `compact` é a da aba da lateral: os steps só aparecem
   * pausado, que é quando eles servem.
   */
  toolbar({ compact = false } = {}) {
    const on = this.running;
    const up = on && this.phase === 'rodando';
    const paused = !!this.pause;
    const debug = !this.run || this.run.mode === 'debug' || !this.run.mode;
    const b = (action, icon, tooltip, tone, enabled = true) => ({
      type: 'button',
      style: 'icon',
      action,
      icon,
      tooltip,
      tone,
      disabled: !enabled,
    });
    if (!on) {
      return [
        b('iniciar', 'continue', 'iniciar (F5)', 'green', !!this.sdk),
        b('emulador', 'device', 'abrir um emulador', null, !!this.sdk && !this.launching),
        b('aparelhos', 'refresh', 'procurar aparelhos de novo', null, !!this.sdk && this.devices !== null),
      ];
    }
    const steps = [
      b('over', 'step-over', 'step over (F10)', 'accent', paused),
      b('into', 'step-into', 'step into (F11)', 'accent', paused),
      b('out', 'step-out', 'step out (⇧F11)', 'accent', paused),
    ];
    return [
      paused
        ? b('continuar', 'continue', 'continuar (F5)', 'accent', up)
        : b('pausar', 'pause', 'pausar (F6)', 'accent', up && debug && !!this.vm),
      ...(compact && !paused ? [] : steps),
      b('reload', 'reload', 'hot reload (⌥⌘R)', 'yellow', up && debug),
      b('restart', 'restart', 'hot restart (⇧⌘F5)', 'green', up),
      b('parar', 'stop', 'parar (⇧F5)', 'red', this.phase !== 'parando'),
      b('devtools', 'devtools', 'DevTools: desempenho, CPU, memória e rede', 'purple', up && !!this.run.wsUri),
    ];
  }

  blocks({ withLines = false } = {}) {
    const locked = this.running;
    const scanning = this.devices === null;
    const status = this.statusLine();
    const out = [
      {
        type: 'row',
        children: [
          {
            type: 'select',
            id: 'config',
            width: 280,
            options: this.configs.map((c) => ({ value: c.name, label: c.name })),
            value: this.config,
            action: 'config',
            disabled: locked,
          },
          {
            type: 'select',
            id: 'device',
            width: 220,
            options: this.deviceOptions(),
            value: this.device,
            action: 'device',
            disabled: locked,
            loading: scanning,
          },
          ...this.toolbar(),
        ],
      },
      { type: 'text', style: status.style, text: status.text },
    ];
    if (this.configProblem) out.push({ type: 'text', style: 'warning', text: this.configProblem });
    if (this.devicesError && !(this.devices || []).length) {
      out.push({ type: 'text', style: 'warning', text: `aparelhos: ${this.devicesError}` });
    }
    if (!this.sdk) {
      out.push({
        type: 'row',
        children: [
          { type: 'input', id: 'sdk', width: 420, placeholder: '/caminho/do/flutter/bin/flutter', submit: 'sdk' },
          { type: 'button', action: 'sdk', label: 'usar este flutter' },
        ],
      });
    }
    if (this.pause && this.pause.frames.length) {
      out.push({
        type: 'list',
        items: this.pause.frames.map((f, i) => ({
          title: f.name,
          subtitle: f.where,
          icon: i === 0 ? 'play' : 'file',
          tone: i === 0 ? 'yellow' : undefined,
          action: f.file ? `frame:${i}` : undefined,
        })),
      });
    }
    out.push({
      type: 'row',
      children: [
        { type: 'checkbox', id: 'autoReload', width: 180, label: 'hot reload ao salvar', value: this.autoReload, action: 'preferencias' },
        {
          type: 'checkbox',
          id: 'pauseExceptions',
          width: 240,
          label: 'pausar em exceção não tratada',
          value: this.pauseExceptions,
          action: 'preferencias',
        },
        { type: 'input', id: 'filtro', width: 200, placeholder: 'filtrar o console (enter)', value: this.filter, submit: 'filtrar' },
        { type: 'button', style: 'icon', icon: 'clear', tooltip: 'limpar o console', action: 'limpar' },
        { type: 'button', style: 'icon', icon: 'copy', tooltip: 'copiar o console', action: 'copiar' },
      ],
    });
    const console = { type: 'console', id: CONSOLE, expand: true, empty: 'o log do app aparece aqui', max: MAX_LINES };
    if (withLines) console.lines = this.visibleLines();
    out.push(console);
    return out;
  }

  /** O estado numa palavra, pra linha do projeto na lateral. */
  shortState() {
    if (this.pause) return { text: 'pausado', icon: 'pause', tone: 'yellow' };
    switch (this.phase) {
      case 'subindo':
        return { text: `subindo em ${this.deviceName()}${this.progress ? ` · ${this.progress}` : ''}`, icon: 'play', tone: 'accent' };
      case 'rodando':
        return { text: `rodando em ${this.deviceName()}`, icon: 'play', tone: 'green' };
      case 'parando':
        return { text: 'parando…', icon: 'stop', tone: 'faint' };
      default:
        if (this.launching) return { text: `abrindo o emulador ${this.launching}…`, icon: 'device', tone: 'accent' };
        return { text: 'parado', icon: 'dot', tone: 'faint' };
    }
  }

  /**
   * O pedaço da aba da lateral que é deste projeto: o estado, os seletores e a
   * barra em ícones — o "Run and Debug" do VS Code, compacto. As ações têm os
   * mesmos nomes das da central (`act`), mais `central`, que abre a janela.
   */
  sidebarBlocks() {
    const locked = this.running;
    const status = this.statusLine();
    const out = [{ type: 'text', style: status.style, text: status.text }];
    if (this.sdk) {
      if (this.configs.length > 1) {
        out.push({
          type: 'select',
          id: 'config',
          options: this.configs.map((c) => ({ value: c.name, label: c.name })),
          value: this.config,
          action: 'config',
          disabled: locked,
        });
      }
      out.push({
        type: 'select',
        id: 'device',
        options: this.deviceOptions(),
        value: this.device,
        action: 'device',
        disabled: locked,
        loading: this.devices === null,
      });
      if (this.devicesError && !(this.devices || []).length) {
        out.push({ type: 'text', style: 'warning', text: `aparelhos: ${this.devicesError}` });
      }
    }
    out.push({
      type: 'row',
      children: [
        ...this.toolbar({ compact: true }),
        { type: 'button', style: 'icon', icon: 'open', tooltip: 'abrir a central de debug (⇧⌘D)', action: 'central' },
      ],
    });
    return out;
  }

  async openView() {
    // As linhas que ainda iam num lote já estão no `visibleLines` de agora.
    this.pending = [];
    const r = await mx.request('view.open', {
      viewId: this.viewId,
      title: this.title(),
      blocks: this.blocks({ withLines: true }),
    });
    this.tabId = r && r.tabId;
    this.viewOpen = true;
  }

  /** Redesenha a barra e os seletores; o console fica com as linhas que tem. */
  render({ withLines = false } = {}) {
    // A aba da lateral acompanha, aberta a central ou não (ver `main.js`).
    if (Session.onChange) Session.onChange(this);
    if (!this.viewOpen) return;
    const send = () =>
      mx
        .request('view.update', { viewId: this.viewId, title: this.title(), blocks: this.blocks({ withLines }) })
        .then((r) => (this.viewOpen = r.open))
        .catch(() => {});
    if (withLines) {
      this.pending = [];
      send();
      return;
    }
    // Vários eventos seguidos viram um redesenho só.
    if (this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      if (this.viewOpen) send();
    }, 30);
  }

  // --- rodar --------------------------------------------------------------

  async start() {
    if (this.running) return banner(`${this.name} já está rodando`);
    if (!this.sdk) return banner('não achei o flutter deste projeto', true);
    const config = this.currentConfig();
    const args = sdk.runArgs(config, this.device);
    this.pause = null;
    this.progress = null;
    this.phase = 'subindo';
    this.append('');
    this.append(`$ flutter ${args.join(' ')}`, 'tool');
    const run = new FlutterRun(this.sdk.flutter, args, config.cwd);
    this.run = run;
    run.on('output', (text, tone) => this.append(text, tone));
    run.on('progress', (p) => {
      if (p.finished) {
        this.progress = null;
        if (p.message) this.append(`${p.message} ✓`, 'build');
      } else {
        this.progress = p.message || null;
      }
      this.render();
    });
    run.on('start', () => this.render());
    run.on('started', () => {
      this.phase = 'rodando';
      this.render();
    });
    run.on('debugPort', (p) => {
      this.connectVm(run, p.wsUri);
      this.panel.attach(p.wsUri, run.mode);
    });
    run.on('exit', (code) => {
      if (this.run !== run) return;
      this.run = null;
      this.phase = 'parado';
      this.progress = null;
      this.pause = null;
      if (this.vm) this.vm.close();
      this.vm = null;
      this.panel.detach();
      this.append(`o app saiu (código ${code})`, code === 0 ? 'tool' : 'error');
      this.render();
    });
    this.render();
  }

  async connectVm(run, wsUri) {
    const vm = new VmService(wsUri);
    try {
      await vm.connect();
    } catch (e) {
      this.append(`sem depurador: ${e.message}`, 'warning');
      return;
    }
    if (this.run !== run) return vm.close();
    this.vm = vm;
    await vm.setExceptionMode(this.pauseExceptions ? 'Unhandled' : 'None').catch(() => {});
    vm.on('paused', async (pause) => {
      const frames = await vm.stack().catch(() => []);
      const shown = frames.map((f) => ({ ...f, ...this.locate(f) }));
      const top = shown[0];
      const stepped = this.lastStep;
      this.lastStep = null;
      let what =
        {
          PauseException: 'em exceção',
          PauseBreakpoint: stepped ? `depois do step ${stepped.toLowerCase()}` : 'num breakpoint',
          PauseInterrupted: 'pelo botão',
          PauseStart: 'no começo do isolate',
          PauseExit: 'na saída do isolate',
        }[pause.kind] || pause.kind;
      if (pause.exception) what = `${what}: ${await vm.describe(pause.exception)}`;
      // Pausado com o app ocioso não há código Dart na pilha: o isolate estava
      // esperando o próximo evento. O step leva até o primeiro que rodar.
      const where = top ? top.where : 'o app estava ocioso — um step para no próximo código Dart que rodar';
      this.pause = { text: `${what} — ${where}`, frames: shown };
      if (pause.kind === 'PauseException') this.append(`⏸ exceção${what.replace('em exceção', '')}`, 'error');
      this.render();
    });
    // O `log()` do `dart:developer`, como o VS Code mostra: `[nome] mensagem`,
    // com "log" quando o logger não tem nome, e em vermelho do SEVERE (1000)
    // pra cima -- amarelo no WARNING (900).
    vm.on('log', (r) => {
      const tone = r.level >= 1000 ? 'error' : r.level >= 900 ? 'warning' : 'developer';
      const lines = String(r.message).split('\n');
      this.append(`[${r.name || 'log'}] ${lines[0]}`, tone);
      for (const l of lines.slice(1)) this.append(l, tone);
      for (const extra of [r.error, r.stack]) {
        if (extra) for (const l of String(extra).replace(/\n$/, '').split('\n')) this.append(l, 'error');
      }
    });
    vm.on('resumed', () => {
      this.pause = null;
      this.render();
    });
    this.render();
  }

  /** O arquivo de uma moldura, pelo package_config do projeto. */
  locate(frame) {
    const uri = frame.uri || '';
    let file = null;
    if (uri.startsWith('file://')) {
      file = decodeURIComponent(uri.slice('file://'.length));
    } else if (uri.startsWith('package:')) {
      if (!this.packages) {
        this.packages = {};
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(this.root, '.dart_tool', 'package_config.json'), 'utf8'));
          for (const p of cfg.packages || []) {
            const base = new URL(p.rootUri, `file://${path.join(this.root, '.dart_tool')}/`);
            this.packages[p.name] = path.join(decodeURIComponent(base.pathname), p.packageUri || 'lib');
          }
        } catch {}
      }
      const [name, ...rest] = uri.slice('package:'.length).split('/');
      const lib = this.packages[name] || (name === this.pkg ? path.join(this.root, 'lib') : null);
      if (lib) file = path.join(lib, ...rest);
    }
    const shown = file && file.startsWith(this.root) ? path.relative(this.root, file) : uri;
    return { file, where: frame.line ? `${shown}:${frame.line}` : shown };
  }

  // --- emuladores ---------------------------------------------------------

  /**
   * O "Start ... emulator" do seletor de aparelho do VS Code: pergunta qual,
   * abre, e quando ele aparece no `flutter devices` vira o aparelho escolhido.
   */
  async openEmulator() {
    if (!this.sdk || this.launching) return;
    const key = this.sdk.flutter;
    if (!emulatorCache.has(key)) emulatorCache.set(key, emulators(key, this.root));
    const { list, error } = await emulatorCache.get(key);
    if (!list.length) {
      // Sem cache de lista vazia: pode ser que o emulador tenha sido criado agora.
      emulatorCache.delete(key);
      return banner(error ? `emuladores: ${error}` : 'nenhum emulador — crie um no Android Studio (Device Manager) ou no Xcode');
    }
    const kind = { android: 'emulador android', ios: 'simulador ios' };
    const picked = await mx.request('window.pick', {
      title: 'abrir qual emulador?',
      placeholder: 'nome do emulador',
      items: list.map((e) => ({
        value: e.id,
        label: e.name,
        detail: [kind[e.platformType] || e.platformType, e.id].filter(Boolean).join(' · '),
      })),
    });
    const emu = picked && list.find((e) => e.id === picked);
    if (!emu) return;

    const before = new Set((this.devices || []).map((d) => d.id));
    this.launching = emu.name;
    this.append('');
    this.append(`$ flutter emulators --launch ${emu.id}`, 'tool');
    this.render();
    const failed = await launchEmulator(key, this.root, emu.id);
    if (failed) {
      this.launching = null;
      this.append(`${emu.name} não abriu:`, 'error');
      for (const l of failed.split('\n')) this.append(l, 'error');
      this.render();
      // Já aberto, o Android recusa uma segunda cópia do mesmo AVD.
      const already = /already running/i.test(failed);
      return banner(already ? `${emu.name} já está aberto` : `${emu.name} não abriu — o motivo está no console`);
    }
    this.waitForEmulator(emu, before);
  }

  /**
   * Pergunta ao `flutter devices` até o emulador aparecer — sem o spinner do
   * seletor, que ficaria girando o boot inteiro.
   */
  async waitForEmulator(emu, before) {
    const key = this.sdk.flutter;
    const started = Date.now();
    let found = null;
    let list = [];
    while (!found && Date.now() - started < EMULATOR_BOOT_MS) {
      await sleep(3000);
      if (!this.sdk || this.sdk.flutter !== key) break;
      ({ list } = await devices(key, this.root));
      const same = (d) => d.emulator && String(d.targetPlatform || '').startsWith(emu.platformType || '-');
      // O `flutter devices` não diz de qual emulador o aparelho veio: vale o
      // emulador que não estava lá antes. O simulador do iOS abre o último
      // que estava ligado — se ele já estava, é ele mesmo.
      found =
        list.find((d) => same(d) && !before.has(d.id)) ||
        (emu.platformType === 'ios' && Date.now() - started > 15000 ? list.find(same) : null);
    }
    this.launching = null;
    if (!found) {
      this.append(`${emu.name} não apareceu nos aparelhos — ele pode ainda estar ligando; o ↻ procura de novo`, 'warning');
      this.render();
      return;
    }
    const result = { devices: list, devicesError: null };
    deviceCache.set(key, Promise.resolve(result));
    Object.assign(this, result);
    if (!this.running) {
      this.device = found.id;
      this.save();
    }
    this.append(`${found.name} pronto`, 'tool');
    this.render();
  }

  async stop() {
    if (!this.running) return;
    this.phase = 'parando';
    this.render();
    await this.run.stop();
  }

  async hotReload(reason) {
    if (!this.running || this.phase !== 'rodando') return;
    try {
      const msg = await this.run.restart(false);
      this.append(`hot reload${reason ? ` (${reason})` : ''}: ${msg || 'ok'}`, 'success');
    } catch (e) {
      this.append(`hot reload falhou: ${e.message}`, 'error');
    }
  }

  async hotRestart() {
    if (!this.running || this.phase !== 'rodando') return;
    this.pause = null;
    try {
      const msg = await this.run.restart(true);
      this.append(`hot restart: ${msg || 'ok'}`, 'success');
    } catch (e) {
      this.append(`hot restart falhou: ${e.message}`, 'error');
    }
    this.render();
  }

  async debugStep(step) {
    if (!this.vm) return banner(`${this.name}: o depurador não está conectado`);
    try {
      if (step === 'pause') await this.vm.pauseNow();
      else if (step === 'continue') await this.vm.resume();
      else {
        this.vm.requirePaused();
        this.lastStep = step;
        await this.vm.resume(step);
      }
    } catch (e) {
      await banner(`${this.name}: ${e.message}`);
    }
  }

  /** O DevTools numa janela da Maestria (`devtools.js`). */
  async openDevtools() {
    await this.panel.show();
  }

  /** O DevTools completo, no navegador: o `dart devtools` apontado pro app. */
  async openDevtoolsBrowser() {
    if (!this.run || !this.run.wsUri) {
      return banner(`${this.name}: o app não está rodando`);
    }
    const vmUri = this.run.wsUri.replace(/^ws/, 'http').replace(/\/ws$/, '/');
    const withUri = (base) => `${base}?uri=${encodeURIComponent(vmUri)}`;
    if (this.browserDevtools && this.browserDevtools.url) return mx.request('window.openUrl', { url: withUri(this.browserDevtools.url) });
    this.append('subindo o DevTools…', 'tool');
    const child = spawn(this.sdk.dart, ['devtools', '--machine', '--no-launch-browser'], { env: process.env });
    this.browserDevtools = { process: child, url: null };
    let text = '';
    child.stdout.on('data', async (d) => {
      text += d;
      for (const line of text.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'server.started' && this.browserDevtools && !this.browserDevtools.url) {
            this.browserDevtools.url = `http://${msg.params.host}:${msg.params.port}/`;
            await mx.request('window.openUrl', { url: withUri(this.browserDevtools.url) });
          }
        } catch {}
      }
    });
    child.on('close', () => (this.browserDevtools = null));
  }

  watch() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    const lib = path.join(this.root, 'lib');
    if (!fs.existsSync(lib)) return;
    try {
      this.watcher = fs.watch(lib, { recursive: true }, (event, file) => {
        if (!this.autoReload || !file || !String(file).endsWith('.dart')) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.hotReload('ao salvar'), 300);
      });
    } catch {}
  }

  /** Um clique ou envio na janela desta central. */
  async act(action, values) {
    if (!this.running) {
      if (values.config && values.config !== this.config) this.config = values.config;
      if (values.device !== undefined) this.device = values.device || '';
    }
    if (typeof values.autoReload === 'boolean') this.autoReload = values.autoReload;
    if (typeof values.pauseExceptions === 'boolean') this.pauseExceptions = values.pauseExceptions;
    switch (action) {
      case 'config':
      case 'device':
        this.save();
        this.render();
        break;
      case 'preferencias':
        this.save();
        if (this.vm) await this.vm.setExceptionMode(this.pauseExceptions ? 'Unhandled' : 'None').catch(() => {});
        this.render();
        break;
      case 'iniciar':
        this.save();
        await this.start();
        break;
      case 'aparelhos':
        await this.refreshDevices(true);
        break;
      case 'emulador':
        await this.openEmulator();
        break;
      case 'continuar':
        await this.debugStep('continue');
        break;
      case 'pausar':
        await this.debugStep('pause');
        break;
      case 'over':
        await this.debugStep('Over');
        break;
      case 'into':
        await this.debugStep('Into');
        break;
      case 'out':
        await this.debugStep('Out');
        break;
      case 'reload':
        await this.hotReload();
        break;
      case 'restart':
        await this.hotRestart();
        break;
      case 'parar':
        await this.stop();
        break;
      case 'devtools':
        await this.openDevtools();
        break;
      case 'filtrar':
        this.filter = (values.filtro || '').trim();
        this.render({ withLines: true });
        break;
      case 'limpar':
        this.buffer.length = 0;
        this.pending = [];
        await mx.request('view.clearLines', { viewId: this.viewId, id: CONSOLE }).catch(() => {});
        break;
      case 'copiar':
        await mx.request('clipboard.write', { text: this.visibleLines().map((l) => l.text).join('\n') });
        await banner('console copiado');
        break;
      case 'sdk': {
        const bin = (values.sdk || '').trim();
        const resolved = bin && sdk.resolveSdk(this.root, bin);
        if (!resolved || resolved.source !== 'escolhido à mão') {
          await banner('esse caminho não é um executável do flutter');
          break;
        }
        const all = loadSaved();
        all[this.root] = { ...(all[this.root] || {}), sdkOverride: bin };
        writeSaved(all);
        this.adopt();
        this.render();
        break;
      }
      default:
        if (action.startsWith('frame:') && this.pause) {
          const f = this.pause.frames[Number(action.slice(6))];
          if (f && f.file) await mx.request('editor.open', { path: f.file, line: f.line || undefined });
        }
    }
  }

  /** O fim sem conversa: fechar a Maestria fecha o app, como o VS Code faz. */
  kill() {
    if (this.run) this.run.kill();
    if (this.browserDevtools) this.browserDevtools.process.kill('SIGKILL');
    this.panel.kill();
    if (this.watcher) this.watcher.close();
  }
}

/** Chamado a cada mudança de estado de uma central — a aba da lateral escuta. */
Session.onChange = null;

module.exports = { Session };
