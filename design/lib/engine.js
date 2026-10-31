'use strict';
// Render engine for one canvas: watches boards/components/canvas.json, expands
// components, lets the project's Tailwind rebuild, and screenshots light+dark.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const canvasMod = require('./canvas');
const chromeMod = require('./chrome');
const components = require('./components');
const page = require('./page');
const renderMod = require('./render');

const DEBOUNCE_MS = 40;
const CSS_GRACE_MS = 200; // render by then; a slower rebuild re-renders when it lands
const CLAUDE_MAX_SIDE = 1568; // longest side of the images handed to Claude (design_render)
const CLASS_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

const read = (p) => fs.readFileSync(p, 'utf8');
const rm = (p) => fs.rmSync(p, { force: true });
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

function classTokens(html) {
  const out = new Set();
  for (const m of html.matchAll(CLASS_RE)) for (const t of (m[1] ?? m[2]).split(/\s+/)) if (t) out.add(t);
  return out;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`; // not .html: stays out of the Tailwind content glob
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

class Engine extends EventEmitter {
  constructor(canvasDir, { dataDir, log }) {
    super();
    this.dir = canvasDir;
    this.dataDir = dataDir;
    this.log = log || (() => {});
    this.outCss = path.join(dataDir, 'tailwind.css');
    this.chromeOpts = { profileDir: path.join(dataDir, 'chrome-profile'), log: (m) => this.log(`chrome: ${m}`) };
    this.chrome = null;
    this.tw = null;
    this.closed = false;
    this.canvas = null; // last good canvas.read(), plus engine warnings
    this.design = null;
    this.comps = null;
    this.states = new Map(); // name -> last emitted state
    this.revs = new Map(); // name -> counter, bumped on every save/delete
    this.gone = new Set(); // names whose file was deleted
    this.uses = new Map(); // name -> Set of components used
    this.tokens = new Map(); // name -> class tokens in the last expanded page
    this.expandedText = new Map();
    this.started = new Map(); // name -> ms of the first pending change
    this.timers = new Map();
    this.watchers = [];
    this.queue = Promise.resolve();
    this.deaths = 0; // chrome deaths since the last good render; one relaunch is allowed
    this.cssSeen = new Map(); // name -> mtime of the css its last render used
    this.chromeError = null;
  }

  // ---- files -------------------------------------------------------------
  boardFile(name) { return path.join(this.dir, 'boards', `${name}.html`); }
  expandedFile(name) { return path.join(this.dataDir, 'expanded', `${name}.html`); }
  renderFile(name) { return path.join(this.dataDir, 'render', `${name}.html`); }
  pngFile(name, theme) { return path.join(this.dataDir, 'png', `${name}.${theme}.png`); }
  claudeFile(name, theme) { return path.join(this.dataDir, 'png', `${name}.${theme}.claude.png`); }

  boardNames() {
    let files = [];
    try { files = fs.readdirSync(path.join(this.dir, 'boards')); } catch { /* none yet */ }
    return files.filter((f) => f.endsWith('.html') && canvasMod.validName(f.slice(0, -5))).map((f) => f.slice(0, -5));
  }

  loadDesign() {
    const d = JSON.parse(read(path.join(this.dir, 'design.json')));
    const brandFile = d.brand ? path.resolve(this.dir, d.brand) : null;
    let brandCss = '';
    if (brandFile) { try { brandCss = read(brandFile); } catch (e) { this.log(`brand: ${e.message}`); } }
    this.design = d;
    this.brandCss = brandCss;
  }

  loadCanvas(emit) {
    let c;
    try { c = canvasMod.read(this.dir); } catch (e) {
      if (!this.canvas) throw e;
      this.log(`canvas.json: ${e.message}`);
      c = { ...this.canvas, warnings: [...this.canvas.warnings.filter((w) => !w.startsWith('canvas.json:')), `canvas.json: ${e.message}`] };
      this.canvas = c;
      if (emit) this.emit('canvas', c);
      return;
    }
    this._applyCanvas(c, emit);
  }

  _applyCanvas(c, emit) {
    this.comps = components.load(this.dir);
    const orphans = this.boardNames().filter((n) => !Object.prototype.hasOwnProperty.call(c.boards, n))
      .map((n) => `board "${n}" sem posição no canvas.json`);
    this.canvas = { ...c, warnings: [...c.warnings, ...this.comps.errors, ...orphans] };
    if (emit) this.emit('canvas', this.canvas);
  }

  // ---- scheduling --------------------------------------------------------
  touch(name) {
    this.revs.set(name, (this.revs.get(name) || 0) + 1);
    if (!this.started.has(name)) this.started.set(name, Date.now());
  }

  schedule(names, { force = false, forClaude = false } = {}) {
    if (this.closed) return Promise.resolve(new Map());
    const list = [...new Set(names)];
    const revs = new Map(list.map((n) => { this.touch(n); return [n, this.revs.get(n)]; }));
    const job = this.queue.then(() => this._job(revs, force, forClaude));
    this.queue = job.catch((e) => this.log(`job: ${e.message}`));
    return job;
  }

  debounce(key, fn) {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); if (!this.closed) fn(); }, DEBOUNCE_MS));
  }

  _watch(dir, onFile) {
    try {
      const w = fs.watch(dir, (ev, filename) => { if (filename && !this.closed) onFile(String(filename)); });
      w.on('error', () => {});
      this.watchers.push(w);
    } catch (e) { this.log(`watch ${dir}: ${e.message}`); }
  }

  _startWatching() {
    const markStart = (name) => { if (!this.started.has(name)) this.started.set(name, Date.now()); };
    this._watch(this.dir, (f) => {
      if (f === 'canvas.json') this.debounce('canvas', () => this._onCanvas());
      else if (f === 'design.json') this.debounce('design', () => this._onDesign());
    });
    this._watch(path.join(this.dir, 'boards'), (f) => {
      if (!f.endsWith('.html')) return;
      const name = f.slice(0, -5);
      if (!canvasMod.validName(name)) return;
      markStart(name);
      this.debounce(`b:${name}`, () => this._onBoard(name));
    });
    this._watch(path.join(this.dir, 'components'), (f) => {
      if (f.endsWith('.html')) this.debounce(`c:${f}`, () => this._onComponent(f.slice(0, -5)));
    });
    const brand = this.design.brand ? path.dirname(path.resolve(this.dir, this.design.brand)) : null;
    const own = [this.dir, path.join(this.dir, 'boards'), path.join(this.dir, 'components')];
    if (brand && !own.includes(brand) && fs.existsSync(brand)) {
      this._watch(brand, () => this.debounce('brand', () => this._onDesign()));
    }
  }

  renderable() {
    return this.boardNames().filter((n) => this.canvas && Object.prototype.hasOwnProperty.call(this.canvas.boards, n));
  }

  _onBoard(name) {
    if (!fs.existsSync(this.boardFile(name))) { this._deleted(name); return; }
    this.gone.delete(name);
    const known = () => Object.prototype.hasOwnProperty.call(this.canvas.boards, name);
    if (!known()) this.loadCanvas(true); // the board may have been saved just before its canvas.json entry
    if (known()) this.schedule([name]); // otherwise _onCanvas renders it once it has a position
  }

  _deleted(name) {
    this.revs.set(name, (this.revs.get(name) || 0) + 1); // drops any render in flight
    this.gone.add(name);
    this.started.delete(name);
    const had = this.states.has(name);
    this.states.delete(name);
    this.uses.delete(name);
    this.tokens.delete(name);
    this.expandedText.delete(name);
    this.cssSeen.delete(name);
    for (const f of [this.expandedFile(name), this.renderFile(name), this.pngFile(name, 'light'), this.pngFile(name, 'dark'),
      this.claudeFile(name, 'light'), this.claudeFile(name, 'dark')]) rm(f);
    if (had) this.emit('board', name, null);
  }

  _onCanvas() {
    this.loadCanvas(true);
    // boards that now have a position, or whose size changed, need a render
    const need = this.renderable().filter((n) => {
      const s = this.states.get(n);
      const b = this.canvas.boards[n];
      return !s || (!s.error && (s.width !== b.w || (b.h != null && s.height !== b.h)));
    });
    if (need.length) this.schedule(need);
  }

  _onDesign() {
    try { this.loadDesign(); } catch (e) { this.log(`design.json: ${e.message}`); return; }
    this.schedule(this.renderable());
  }

  _onComponent(changed) {
    const comps = components.load(this.dir);
    this.comps = comps;
    if (this.canvas) {
      const w = this.canvas.warnings.filter((x) => !x.startsWith('nome de componente inválido') && !/^[^ ]+\.html: /.test(x));
      this.canvas = { ...this.canvas, warnings: [...w, ...comps.errors] };
      this.emit('canvas', this.canvas);
    }
    const hit = components.dependents(this.uses, changed);
    for (const [n, s] of this.states) if (s && s.error) hit.add(n); // a new component may fix a broken board
    const names = [...hit].filter((n) => this.renderable().includes(n));
    if (names.length) this.schedule(names);
  }

  // ---- the render job ----------------------------------------------------
  async _job(revs, force, forClaude) {
    const results = new Map();
    const t0s = new Map();
    const live = [];
    for (const [name, rev] of revs) {
      t0s.set(name, this.started.get(name) ?? Date.now());
      this.started.delete(name);
      if (this.closed || this.revs.get(name) !== rev) continue; // superseded: a newer job has it
      if (!Object.prototype.hasOwnProperty.call(this.canvas.boards, name)) continue; // no position yet
      live.push(name);
    }
    // 1. expand all, write pages
    const prepared = [];
    const since = Date.now();
    let needBuild = false;
    for (const name of live) {
      const p = this._prepare(name, force);
      if (p.error || p.gone) { this._finish(name, revs.get(name), t0s.get(name), p, results); continue; }
      if (p.build) needBuild = true;
      prepared.push(name);
    }
    let late = null;
    if (prepared.length && this.tw && needBuild) {
      const css = await this._waitCss(since);
      if (css.error) {
        for (const name of prepared) this._finish(name, revs.get(name), t0s.get(name), { error: css.error }, results);
        return results;
      }
      late = css.late;
    }
    // 2. render, serialized (one shared Chrome target)
    for (const name of prepared) {
      if (this.closed) break;
      if (this.revs.get(name) !== revs.get(name)) continue; // re-saved meanwhile
      const cssAt = mtime(this.outCss);
      const out = await this._render(name, revs.get(name), forClaude);
      if (!out.error && !out.stale) this.cssSeen.set(name, cssAt);
      this._finish(name, revs.get(name), t0s.get(name), out, results);
    }
    if (late) this._afterLateBuild(late, prepared, revs);
    if (this.closed) return results;
    for (const name of revs.keys()) if (!results.has(name)) results.set(name, this.states.get(name) ?? null);
    return results;
  }

  _prepare(name, force) {
    let src;
    try { src = read(this.boardFile(name)); } catch { return { gone: true }; }
    const markup = page.checkMarkup(src);
    if (markup) return { error: `marcação inválida: ${markup}` };
    const exp = components.expand(src, this.comps);
    this.uses.set(name, exp.uses);
    if (exp.errors.length) return { error: exp.errors.join('; ') };
    const tail = page.checkMarkup(exp.html);
    if (tail) return { error: `marcação inválida: ${tail}` };
    const body = page.buildPage({ outCss: this.outCss, brandCss: this.brandCss, head: this.design.head, body: exp.html });
    const same = this.expandedText.get(name) === body && fs.existsSync(this.expandedFile(name));
    let build = false;
    if (!same || force) {
      if (!same) {
        writeAtomic(this.expandedFile(name), body);
        this.expandedText.set(name, body);
        // does the page bring a class no other page (or this one, before) had?
        const now = classTokens(exp.html);
        const known = new Set(this.tokens.get(name) || []);
        for (const [n, t] of this.tokens) if (n !== name) for (const x of t) known.add(x);
        for (const x of now) if (!known.has(x)) { build = true; break; }
        this.tokens.set(name, now);
      }
    }
    return { build };
  }

  // Waits for the css of a changed page. Past a grace period it stops waiting
  // (the change may add no css, or the machine is slow) and hands back `late`,
  // the build still in flight; loud only when Tailwind is dead.
  async _waitCss(since) {
    const built = this.tw.whenBuilt(since);
    const settled = built.then(() => null, (e) => e);
    let timer;
    const grace = new Promise((r) => { timer = setTimeout(() => r('grace'), CSS_GRACE_MS); });
    const r = await Promise.race([settled, grace]);
    clearTimeout(timer);
    if (r === 'grace') {
      if (this.tw.failed) { built.cancel(); return { error: this.tw.failed.message }; }
      return { error: null, late: settled };
    }
    return { error: r ? r.message : null };
  }

  // The build we stopped waiting for landed: boards rendered with the older css
  // (and not re-saved since) render once more.
  _afterLateBuild(late, names, revs) {
    late.then((err) => {
      if (err || this.closed) return;
      const now = mtime(this.outCss);
      const again = names.filter((n) => this.revs.get(n) === revs.get(n) && this.cssSeen.has(n) && this.cssSeen.get(n) !== now);
      if (again.length) this.schedule(again);
    });
  }

  async _chrome() {
    if (this.chromeError) throw new Error(this.chromeError);
    if (this.chrome && !this.chrome.exited) return this.chrome;
    if (this.deaths >= 2) throw new Error(this.chromeError = `o chrome não subiu: caiu duas vezes (${this.lastDeath})`);
    try {
      const c = await chromeMod.launch(this.chromeOpts);
      this._track(c);
      this.chrome = c;
      return c;
    } catch (e) {
      this.deaths++;
      this.lastDeath = e.message;
      if (this.deaths >= 2) throw new Error(this.chromeError = `o chrome não subiu: ${e.message}`);
      throw e;
    }
  }

  _track(c) {
    c.once('exit', () => { if (!this.closed) { this.deaths++; this.lastDeath = 'o processo terminou'; } });
  }

  // Renders both themes into per-rev temp files; _finish promotes them to the
  // stable paths only if the board was not deleted or re-saved meanwhile.
  async _render(name, rev, forClaude = false) {
    const b = this.canvas.boards[name];
    const t0 = Date.now();
    const stale = () => this.closed || this.revs.get(name) !== rev;
    const tmp = (theme) => path.join(this.dataDir, 'png', `${name}.${theme}.${rev}.tmp.png`);
    const temps = [tmp('light'), tmp('dark')];
    if (forClaude) temps.push(tmp('light.claude'), tmp('dark.claude'));
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const chrome = await this._chrome();
        if (stale()) return { stale: true, temps };
        const src = this.expandedText.get(name);
        const version = fs.statSync(this.outCss).mtimeMs;
        const copy = this.renderFile(name);
        writeAtomic(copy, src.replace(`href="file://${this.outCss}"`, `href="file://${this.outCss}?v=${version}"`));
        fs.mkdirSync(path.join(this.dataDir, 'png'), { recursive: true });
        const base = { htmlPath: copy, width: b.w, height: b.h };
        const small = (i) => (forClaude ? { small: { out: temps[i], maxSide: CLAUDE_MAX_SIDE } } : {});
        const light = await renderMod.renderPage(chrome, { ...base, dark: null, out: temps[0], ...small(2) });
        if (stale()) return { stale: true, temps };
        const dark = await renderMod.renderPage(chrome, { ...base, dark: this.design.darkMode, out: temps[1], ...small(3) });
        this.deaths = 0; // a good render: only consecutive deaths are final
        this.log(`render ${name}: ${Date.now() - t0} ms (light ${light.ms} + dark ${dark.ms})`);
        return { temps, width: light.width, height: light.height, cut: light.cut };
      } catch (e) {
        lastErr = e;
        for (const t of temps) rm(t);
        if (this.chromeError || !(this.chrome && this.chrome.exited) || this.deaths >= 2) break;
      }
    }
    return { error: this.chromeError || lastErr.message, temps };
  }

  _finish(name, rev, t0, out, results) {
    const stale = this.closed || this.revs.get(name) !== rev;
    if (stale || out.error) for (const t of out.temps || []) rm(t);
    if (stale || out.stale) return; // deleted or re-saved: drop
    if (out.gone) { this._deleted(name); results.set(name, null); return; }
    const prev = this.states.get(name);
    const b = this.canvas.boards[name] || {};
    let state;
    if (out.error) {
      state = { ...(prev || { width: b.w, height: b.h, cut: false }), error: out.error, ms: Date.now() - t0, rev };
      this.log(`board ${name}: ${out.error}`);
    } else {
      const light = this.pngFile(name, 'light');
      const dark = this.pngFile(name, 'dark');
      fs.renameSync(out.temps[0], light);
      fs.renameSync(out.temps[1], dark);
      state = { light, dark, width: out.width, height: out.height, cut: out.cut, ms: Date.now() - t0, rev };
      if (out.temps.length === 4) {
        const claude = { light: this.claudeFile(name, 'light'), dark: this.claudeFile(name, 'dark') };
        fs.renameSync(out.temps[2], claude.light);
        fs.renameSync(out.temps[3], claude.dark);
        state.claude = claude;
      }
      this.log(`board ${name}: ${state.ms} ms (save to image)`);
    }
    this.states.set(name, state);
    results.set(name, state);
    this.emit('board', name, state);
  }

  // ---- public ------------------------------------------------------------
  // `forClaude`: also capture each theme with the longest side ≤ 1568 px
  // (state.claude.light/dark) for the images design_render returns.
  // A board saved again while this render runs (the file watcher) supersedes
  // it: wait for that job and render the board once more, so the caller gets
  // the board as it is now.
  async render(names, { forClaude = false } = {}) {
    const list = names && names.length ? names : this.renderable();
    const opts = { force: true, forClaude };
    const results = await this.schedule(list, opts);
    const done = (n, s) => s && s.rev === this.revs.get(n) && (s.error || !forClaude || s.claude);
    for (let i = 0; i < 2 && !this.closed; i++) {
      const redo = list.filter((n) => !done(n, results.get(n)) && fs.existsSync(this.boardFile(n))
        && this.canvas && Object.prototype.hasOwnProperty.call(this.canvas.boards, n));
      if (!redo.length) break;
      await this.idle();
      for (const [n, s] of await this.schedule(redo, opts)) results.set(n, s);
    }
    return results;
  }

  idle() { return this.queue; }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const w of this.watchers) { try { w.close(); } catch { /* already closed */ } }
    this.watchers = [];
    await Promise.all([
      this.tw ? this.tw.stop() : null,
      this.chrome ? this.chrome.close() : null,
    ]);
    await this.queue;
    // a render may have launched Chrome while we were closing
    if (this.chrome && !this.chrome.exited) await this.chrome.close();
  }
}

async function open(canvasDir, { dataDir, log } = {}) {
  if (!dataDir) throw new Error('dataDir é obrigatório');
  const dir = path.resolve(canvasDir);
  const eng = new Engine(dir, { dataDir: path.resolve(dataDir), log });
  fs.mkdirSync(path.join(dir, 'boards'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'components'), { recursive: true });
  // Tailwind v3 only watches content dirs that exist when it starts
  fs.mkdirSync(path.join(eng.dataDir, 'expanded'), { recursive: true });
  eng.loadDesign();
  eng.loadCanvas(false);
  // pages first, so Tailwind's first build already knows every class
  const names = eng.renderable();
  for (const n of names) {
    eng.revs.set(n, 1);
    const p = eng._prepare(n, false);
    if (p.error) eng.log(`board ${n}: ${p.error}`);
  }
  let chromeP;
  let twP;
  try {
    chromeP = chromeMod.launch(eng.chromeOpts);
    twP = page.startTailwind({ canvasDir: dir, design: eng.design, dataDir: eng.dataDir, outCss: eng.outCss, log: (m) => eng.log(`tailwind: ${m}`) });
    [eng.chrome, eng.tw] = await Promise.all([chromeP, twP]);
    eng._track(eng.chrome);
  } catch (e) {
    const [c, t] = await Promise.allSettled([chromeP, twP]);
    if (c.status === 'fulfilled' && c.value) await c.value.close();
    if (t.status === 'fulfilled' && t.value) await t.value.stop();
    throw e;
  }
  eng._startWatching();
  // first render happens after open() returns, so listeners attached by the caller see it
  setImmediate(() => { if (!eng.closed && names.length) eng.schedule(names); });
  return eng;
}

module.exports = { open, Engine };
