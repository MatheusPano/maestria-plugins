// O VM service do app rodando: pausar, continuar, step over/into/out, a pilha
// de onde ele parou e o pausar em exceções.
//
// É o protocolo que o Dart-Code e o DevTools falam — JSON-RPC 2.0 por
// websocket, na `wsUri` que o `flutter run --machine` anuncia no
// `app.debugPort`. O WebSocket é o global do Node (22+), sem dependência.
//
// O DevTools da Maestria (`devtools.js`) abre uma conexão sua, com outros
// streams: os frames e o perfil HTTP (`Extension`) e as coletas (`GC`).

'use strict';

const { EventEmitter } = require('events');

/** Os streams da central de debug: pausas, troca de isolate e o `log()`. */
const DEBUG_STREAMS = ['Debug', 'Isolate', 'Logging'];

class VmService extends EventEmitter {
  constructor(wsUri, { streams = DEBUG_STREAMS } = {}) {
    super();
    this.wsUri = wsUri;
    this.streams = streams;
    this.isolateId = null;
    this.paused = false;
    this.pause = null; // { kind, exception? }
    this._next = 1;
    this._pending = new Map();
    this._scripts = new Map();
  }

  async connect() {
    if (typeof WebSocket === 'undefined') throw new Error('este node não tem WebSocket global (precisa do 22+)');
    this.ws = new WebSocket(this.wsUri);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`não conectou em ${this.wsUri}`));
    });
    this.ws.onmessage = (e) => this._message(String(e.data));
    this.ws.onclose = () => {
      for (const p of this._pending.values()) p.reject(new Error('o VM service fechou'));
      this._pending.clear();
      this.emit('close');
    };
    // O `log()` do `dart:developer` não sai no stdout do app: ele vem pelo
    // `Logging`, e é daí que o debug console do VS Code o tira. Sem ele, um
    // app que loga com `log()` -- e não com `print` -- tem o console vazio.
    for (const streamId of this.streams) await this._call('streamListen', { streamId }).catch(() => {});
    await this._pickIsolate();
  }

  close() {
    try {
      this.ws && this.ws.close();
    } catch {}
  }

  /** Um pedido qualquer ao VM service — as extensões `ext.*` inclusive. */
  call(method, params = {}) {
    return this._call(method, params);
  }

  _call(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('o VM service não está conectado'));
    const id = String(this._next++);
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
  }

  _message(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method !== 'streamNotify') return;
    const ev = msg.params && msg.params.event;
    if (!ev) return;
    if (msg.params.streamId === 'Logging') {
      // Em fila: buscar o texto inteiro de um log longo é uma ida ao VM, e
      // sem a fila o log curto que veio depois passaria na frente dele.
      if (ev.kind === 'Logging' && ev.logRecord) {
        this._logs = (this._logs || Promise.resolve()).then(() => this._logRecord(ev)).catch(() => {});
      }
      return;
    }
    if (msg.params.streamId === 'Isolate') {
      // O hot restart troca o isolate: o de antes some e o id muda.
      if (ev.kind === 'IsolateRunnable' || ev.kind === 'IsolateExit') this._pickIsolate().catch(() => {});
      // As extensões do Flutter se registram depois do isolate subir.
      if (ev.kind === 'ServiceExtensionAdded') this.emit('extensionAdded', ev.extensionRPC);
      return;
    }
    if (msg.params.streamId === 'Extension') {
      this.emit('extension', ev);
      return;
    }
    if (msg.params.streamId === 'GC') {
      this.emit('gc', ev);
      return;
    }
    if (ev.isolate && this.isolateId && ev.isolate.id !== this.isolateId) return;
    if (ev.kind === 'Resume') {
      this.paused = false;
      this.pause = null;
      this.emit('resumed');
    } else if (ev.kind && ev.kind.startsWith('Pause') && ev.kind !== 'PausePostRequest') {
      this.paused = true;
      this.pause = { kind: ev.kind, exception: ev.exception || null };
      this.emit('paused', this.pause);
    }
  }

  /**
   * Um `log()` do app, com o texto inteiro: o VM service corta strings longas
   * no evento (`valueAsStringIsTruncated`), e um json de resposta de API
   * logado pela metade não serve pra nada.
   */
  async _logRecord(ev) {
    const r = ev.logRecord;
    const isolateId = (ev.isolate && ev.isolate.id) || this.isolateId;
    const text = async (ref) => {
      if (!ref || ref.kind === 'Null') return null;
      if (ref.valueAsString != null && !ref.valueAsStringIsTruncated) return ref.valueAsString;
      if (ref.valueAsStringIsTruncated) {
        const full = await this._call('getObject', { isolateId, objectId: ref.id, count: 200000 }).catch(() => null);
        return (full && full.valueAsString) || ref.valueAsString;
      }
      // Um objeto de verdade -- o `error:` de um `log()`, uma exceção -- não
      // vem com texto: é o `toString()` dele, como o VS Code mostra.
      const r = await this._call('invoke', {
        isolateId,
        targetId: ref.id,
        selector: 'toString',
        argumentIds: [],
        disableBreakpoints: true,
      }).catch(() => null);
      return (r && r.valueAsString) || (ref.class && ref.class.name) || null;
    };
    this.emit('log', {
      name: (await text(r.loggerName)) || '',
      message: (await text(r.message)) || '',
      level: typeof r.level === 'number' ? r.level : 0,
      error: await text(r.error),
      stack: await text(r.stackTrace),
    });
  }

  async _pickIsolate() {
    const vm = await this._call('getVM');
    const isolates = (vm.isolates || []).filter((i) => !i.isSystemIsolate);
    const main = isolates.find((i) => i.name === 'main') || isolates[0];
    this.isolateId = main ? main.id : null;
    if (this.isolateId) {
      const iso = await this._call('getIsolate', { isolateId: this.isolateId }).catch(() => null);
      const kind = iso && iso.pauseEvent && iso.pauseEvent.kind;
      this.paused = !!kind && kind.startsWith('Pause') && kind !== 'PauseStart' && kind !== 'PausePostRequest';
      if (this.exceptionMode) await this.setExceptionMode(this.exceptionMode).catch(() => {});
    }
    this.emit('isolate', this.isolateId);
  }

  requirePaused() {
    if (!this.paused) throw new Error('o app não está pausado');
  }

  pauseNow() {
    return this._call('pause', { isolateId: this.isolateId });
  }

  /** Continua, ou dá um passo: 'Over', 'Into' ou 'Out'. */
  resume(step) {
    return this._call('resume', step ? { isolateId: this.isolateId, step } : { isolateId: this.isolateId });
  }

  /** 'None', 'Unhandled' ou 'All' — o mesmo seletor de exceções do VS Code. */
  async setExceptionMode(mode) {
    this.exceptionMode = mode;
    if (!this.isolateId) return;
    try {
      await this._call('setIsolatePauseMode', { isolateId: this.isolateId, exceptionPauseMode: mode });
    } catch {
      await this._call('setExceptionPauseMode', { isolateId: this.isolateId, mode });
    }
  }

  /** O texto de uma exceção pausada: "StateError: Bad state: ...". */
  async describe(ref) {
    if (!ref) return null;
    const cls = ref.class ? ref.class.name : 'exceção';
    try {
      const r = await this._call('invoke', {
        isolateId: this.isolateId,
        targetId: ref.id,
        selector: 'toString',
        argumentIds: [],
        disableBreakpoints: true,
      });
      return r && r.valueAsString ? r.valueAsString : cls;
    } catch {
      return ref.valueAsString ? `${cls}: ${ref.valueAsString}` : cls;
    }
  }

  /** As molduras de onde ele parou: função, script e linha. */
  async stack(limit = 12) {
    const r = await this._call('getStack', { isolateId: this.isolateId, limit });
    const frames = [];
    for (const f of r.frames || []) {
      const loc = f.location;
      if (!loc || !loc.script) continue;
      const line = loc.line || (await this._lineOf(loc.script.id, loc.tokenPos));
      frames.push({
        name: (f.code && f.code.name) || '?',
        uri: loc.script.uri,
        line,
      });
    }
    return frames;
  }

  /** A linha de um token, pela tabela do script — pra VMs que não mandam `line`. */
  async _lineOf(scriptId, tokenPos) {
    if (tokenPos == null) return null;
    let table = this._scripts.get(scriptId);
    if (!table) {
      const script = await this._call('getObject', { isolateId: this.isolateId, objectId: scriptId }).catch(() => null);
      table = (script && script.tokenPosTable) || [];
      this._scripts.set(scriptId, table);
    }
    for (const row of table) {
      for (let i = 1; i < row.length; i += 2) if (row[i] === tokenPos) return row[0];
    }
    return null;
  }
}

module.exports = { VmService };
