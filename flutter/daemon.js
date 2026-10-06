// `flutter run --machine`: o mesmo protocolo que o VS Code usa por baixo.
//
// O flutter escreve eventos json no stdout, cada um entre colchetes numa linha
// ([{"event":"app.log","params":{...}}]), e aceita comandos no stdin no mesmo
// formato. É daqui que saem o hot reload, o hot restart, o parar, os logs do
// app e a porta do VM service — que é por onde o `vm.js` pausa e dá step.

'use strict';

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');

class FlutterRun extends EventEmitter {
  /**
   * @param {string} flutter o binário
   * @param {string[]} args os argumentos do `flutter run --machine`
   * @param {string} cwd a pasta do projeto
   */
  constructor(flutter, args, cwd) {
    super();
    this.appId = null;
    this.wsUri = null;
    this.mode = null;
    this.started = false;
    this.exited = false;
    this._next = 1;
    this._pending = new Map();

    // Num grupo de processos próprio: o `flutter run` sobe filhos (o
    // flutter_tester, o adb, o xcodebuild) que não morrem junto com ele, e
    // derrubar o grupo inteiro é o que não deixa um app órfão segurando o
    // aparelho quando a Maestria fecha.
    this.child = spawn(flutter, args, { cwd, env: process.env, detached: true });
    readline.createInterface({ input: this.child.stdout }).on('line', (l) => this._line(l));
    readline.createInterface({ input: this.child.stderr }).on('line', (l) => this.emit('output', l, 'error'));
    this.child.on('error', (e) => this.emit('output', `não deu pra rodar o flutter: ${e.message}`, 'error'));
    this.child.on('close', (code) => {
      this.exited = true;
      for (const p of this._pending.values()) p.reject(new Error('o flutter saiu'));
      this._pending.clear();
      this.emit('exit', code);
    });
  }

  _line(line) {
    const trimmed = line.trim();
    if (!(trimmed.startsWith('[{') && trimmed.endsWith('}]'))) {
      // O que não é protocolo é saída de build: gradle, xcodebuild, pod.
      if (trimmed) this.emit('output', line, 'build');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(trimmed)[0];
    } catch {
      this.emit('output', line, 'build');
      return;
    }
    if (msg.id !== undefined && msg.event === undefined) {
      const waiting = this._pending.get(msg.id);
      if (!waiting) return;
      this._pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
      else waiting.resolve(msg.result);
      return;
    }
    const p = msg.params || {};
    switch (msg.event) {
      case 'app.start':
        this.appId = p.appId;
        this.mode = p.mode;
        this.emit('start', p);
        break;
      case 'app.debugPort':
        this.wsUri = p.wsUri;
        this.emit('debugPort', p);
        break;
      case 'app.started':
        this.started = true;
        this.emit('started', p);
        break;
      case 'app.log':
        for (const l of String(p.log || '').replace(/\n$/, '').split('\n')) {
          this.emit('output', l, p.error ? 'error' : 'app');
        }
        break;
      case 'app.progress':
        this.emit('progress', p);
        break;
      case 'app.stop':
        if (p.error) this.emit('output', String(p.error), 'error');
        this.emit('stop', p);
        break;
      case 'app.webLaunchUrl':
        this.emit('output', `aberto em ${p.url}`, 'tool');
        break;
      case 'daemon.logMessage':
        this.emit('output', p.message, p.level === 'error' ? 'error' : p.level === 'status' ? 'build' : 'tool');
        break;
      default:
        break;
    }
  }

  _call(method, params) {
    if (this.exited) return Promise.reject(new Error('o app não está rodando'));
    const id = this._next++;
    this.child.stdin.write(JSON.stringify([{ id, method, params }]) + '\n');
    return new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
  }

  /** Hot reload, ou hot restart com `full`. Devolve a mensagem do flutter. */
  async restart(full) {
    if (!this.appId) throw new Error('o app ainda não subiu');
    const r = await this._call('app.restart', {
      appId: this.appId,
      fullRestart: !!full,
      pause: false,
      reason: 'manual',
    });
    if (r && r.code !== 0) throw new Error(r.message || `falhou (código ${r.code})`);
    return (r && r.message) || '';
  }

  /** Para o app; se o flutter não sair sozinho em alguns segundos, derruba. */
  async stop() {
    if (this.exited) return;
    const killer = setTimeout(() => this._signal('SIGKILL'), 6000);
    try {
      if (this.appId) await Promise.race([this._call('app.stop', { appId: this.appId }), sleep(4000)]);
      else this._signal('SIGTERM');
    } catch {
      this._signal('SIGTERM');
    }
    await new Promise((resolve) => (this.exited ? resolve() : this.once('exit', resolve)));
    clearTimeout(killer);
  }

  /** O sinal pro grupo inteiro — ver o `detached` no construtor. */
  _signal(sig) {
    try {
      process.kill(-this.child.pid, sig);
    } catch {
      try {
        this.child.kill(sig);
      } catch {}
    }
  }

  kill() {
    if (!this.exited) this._signal('SIGKILL');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Os aparelhos que o `flutter devices --machine` enxerga. */
function devices(flutter, cwd) {
  return new Promise((resolve) => {
    execFile(flutter, ['devices', '--machine'], { cwd, env: process.env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const text = String(stdout || '');
      const start = text.indexOf('[');
      if (start < 0) return resolve({ list: [], error: err ? err.message : 'o flutter não listou aparelho nenhum' });
      try {
        const list = JSON.parse(text.slice(start)).filter((d) => d.isSupported !== false);
        resolve({ list, error: null });
      } catch (e) {
        resolve({ list: [], error: e.message });
      }
    });
  });
}

/**
 * Os emuladores e simuladores que dá pra abrir, como o seletor do VS Code
 * mostra embaixo dos aparelhos. O `flutter emulators` só fala texto: a lista
 * em json vem do `flutter daemon` (`emulator.getEmulators`), que é de onde o
 * Dart-Code tira a dele.
 */
function emulators(flutter, cwd) {
  return new Promise((resolve) => {
    const child = spawn(flutter, ['daemon'], { cwd, env: process.env });
    let done = false;
    const finish = (list, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ list, error });
    };
    const timer = setTimeout(() => finish([], 'o flutter demorou demais pra listar os emuladores'), 60000);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const t = line.trim();
      if (!t.startsWith('[{')) return;
      let msg;
      try {
        msg = JSON.parse(t)[0];
      } catch {
        return;
      }
      if (msg.event === 'daemon.connected') {
        child.stdin.write(JSON.stringify([{ id: 1, method: 'emulator.getEmulators' }]) + '\n');
      } else if (msg.id === 1) {
        if (msg.error) finish([], typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error));
        else finish(msg.result || [], null);
      }
    });
    child.on('error', (e) => finish([], e.message));
    child.on('close', () => finish([], 'o flutter daemon saiu sem listar os emuladores'));
  });
}

/**
 * Abre um emulador (`flutter emulators --launch`). Num grupo próprio, como o
 * `flutter run`: o emulador tem que sobreviver à Maestria fechando, que é o
 * que o VS Code faz também. O flutter volta uns 3s depois de ligar o
 * emulador, e o emulador segue. Resolve com a saída do erro, se houve.
 */
function launchEmulator(flutter, cwd, id, cold = false) {
  return new Promise((resolve) => {
    const args = ['emulators', '--launch', id, ...(cold ? ['--cold'] : [])];
    const child = spawn(flutter, args, { cwd, env: process.env, detached: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve(e.message));
    child.on('close', (code) => resolve(code === 0 ? null : out.trim() || `saiu com código ${code}`));
    child.unref();
  });
}

module.exports = { FlutterRun, devices, emulators, launchEmulator };
