'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cdp = require('./cdp');

const CALL_TIMEOUT_MS = 10000;

const ARGS = [
  '--headless=new', '--remote-debugging-pipe', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
];

function isExec(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

function inPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isExec(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

function revision(dir) {
  const m = /-(\d+)$/.exec(dir);
  return m ? Number(m[1]) : 0;
}

// Order: $MAESTRIA_DESIGN_CHROME, newest playwright headless shell, google-chrome, chromium.
function findExecutable() {
  const env = process.env.MAESTRIA_DESIGN_CHROME;
  if (env && isExec(env)) return env;
  const root = path.join(os.homedir(), '.cache', 'ms-playwright');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-'));
  } catch { /* no playwright cache */ }
  dirs.sort((a, b) => revision(b) - revision(a));
  for (const d of dirs) {
    for (const rel of ['chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const p = path.join(root, d, rel);
      if (isExec(p)) return p;
    }
  }
  return inPath('google-chrome') || inPath('chromium');
}

class Chrome extends EventEmitter {
  constructor(proc, profileDir, ownsProfile, log) {
    super();
    this.proc = proc;
    this.profileDir = profileDir;
    this.ownsProfile = ownsProfile;
    this.log = log || (() => {});
    this.exited = false;
    this.nextId = 1;
    this.pending = new Map();
    this.decoder = new cdp.Decoder();
    this.decoder.on('message', (m) => this._onMessage(m));
    this.decoder.on('error', (e) => this.log('cdp decode error: ' + e.message));
    proc.stdio[4].on('data', (d) => this.decoder.push(d));
    proc.stdio[4].on('error', () => {});
    proc.stdio[3].on('error', () => {});
    proc.stdio[2].on('data', (d) => this.log('chrome: ' + d.toString().trimEnd()));
    proc.on('exit', (code, signal) => this._onExit(code, signal));
    proc.on('error', (e) => { this.log('chrome error: ' + e.message); this._onExit(null, 'error'); });
  }

  _onMessage(m) {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    } else if (m.method) {
      this.emit('event', m);
      this.emit(m.method, m.params, m.sessionId);
    }
  }

  _onExit(code, signal) {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) p.reject(new Error('chrome exited'));
    this.pending.clear();
    this._killGroup('SIGKILL'); // reap helper processes that outlive the main one
    if (this.ownsProfile) fs.rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    this.emit('exit', code, signal);
  }

  _killGroup(signal) {
    try { process.kill(-this.proc.pid, signal); } catch { /* group already gone */ }
  }

  // Kill the whole process group and mark this Chrome as exited right away,
  // so ensure() relaunches instead of reusing a wedged instance.
  abort(reason) {
    if (this.exited) return;
    this.log('chrome aborted: ' + reason);
    this._killGroup('SIGKILL');
    this._onExit(null, 'SIGKILL');
  }

  send(method, params = {}, sessionId, timeoutMs = CALL_TIMEOUT_MS) {
    if (this.exited) return Promise.reject(new Error('chrome exited'));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout after ${timeoutMs}ms`));
        this.abort(`${method} timeout`);
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdio[3].write(cdp.encode(msg));
    });
  }

  close() {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      this.once('exit', resolve);
      this._killGroup('SIGTERM');
      const t = setTimeout(() => this._killGroup('SIGKILL'), 2000);
      t.unref();
    });
  }
}

async function launch({ executable, log, profileDir } = {}) {
  const exe = executable || findExecutable();
  if (!exe) throw new Error('chrome not found (set MAESTRIA_DESIGN_CHROME)');
  const ownsProfile = !profileDir;
  const profile = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'maestria-design-profile-'));
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(exe, [...ARGS, `--user-data-dir=${profile}`], {
    detached: true, // own process group so close() reaps every helper process
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const chrome = new Chrome(proc, profile, ownsProfile, log);
  try {
    await chrome.send('Browser.getVersion');
  } catch (e) {
    await chrome.close();
    throw e;
  }
  return chrome;
}

// Relaunch once if `current` is missing or has exited.
async function ensure(current, opts) {
  if (current && !current.exited) return current;
  return launch(opts);
}

module.exports = { launch, ensure, findExecutable, Chrome };
