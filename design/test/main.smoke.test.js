'use strict';
// Smoke test of main.js over stdio: the test plays the Maestria (initialize,
// command.invoke, answers view.open/view.update) and checks the canvas view.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const chromeMod = require('../lib/chrome');

const MAIN = path.join(__dirname, '..', 'main.js');
const SAC = '/home/arthur/Desktop/Work/Ninepay/customer-service-design-bench';
const skipEngine = (!chromeMod.findExecutable() && 'no chrome')
  || (!fs.existsSync(path.join(SAC, 'node_modules', '.bin', 'tailwindcss')) && 'no SAC tailwind');

function host(env = {}) {
  const proc = spawn(process.execPath, [MAIN], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const msgs = [];
  const waiters = [];
  let buf = '';
  let id = 0;
  const replies = { 'view.open': { tabId: 't9' }, 'view.update': { open: true } };
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      msgs.push(m);
      if (m.method && m.id !== undefined) {
        const result = api.reply ? api.reply(m) : undefined;
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: result !== undefined ? result : (replies[m.method] ?? null) })}\n`);
      }
      if (process.env.DEBUG_SMOKE) console.error(line.length > 2000 ? line.slice(0, 120) + " ... " + line.slice(-400) : line);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(m); }
    }
  });
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  const api = {
    reply: null, // (msg) => result, or undefined for the default
    proc,
    msgs,
    exited,
    send(msg) { proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); },
    request(method, params) { const rid = ++id; this.send({ id: rid, method, params }); return this.wait((m) => m.id === rid && !m.method); },
    wait(pred, ms = 8000) {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      const err = new Error(`timeout after ${ms} ms`); // stack points at the caller
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, t: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(err); }, ms) };
        waiters.push(w);
      });
    },
  };
  return api;
}

// Waits for the first rendered board. Under heavy machine load the project's
// Tailwind can miss the engine's 5 s first-build limit ("não abriu"); the
// plugin retries a failed canvas on the next `abrir`, so the test does that once.
async function rendered(h, context) {
  const ok = (m) => m.method === 'view.update' && m.params.data && m.params.data.boards.some((b) => b.light);
  const failed = (m) => m.method === 'view.update' && m.params.data && /^não abriu/.test(m.params.data.message);
  const first = await h.wait((m) => ok(m) || failed(m), 25000);
  if (ok(first)) return first;
  const n = h.msgs.length;
  await h.request('command.invoke', { command: 'abrir', context });
  return h.wait((m) => h.msgs.indexOf(m) >= n && ok(m), 25000);
}

function makeCanvas(tmp) {
  const canvasDir = path.join(tmp, 'canvas');
  const dataDir = path.join(tmp, 'data');
  fs.cpSync(path.join(__dirname, '..', 'bench', 'sac-sidebar'), canvasDir, { recursive: true });
  const d = JSON.parse(fs.readFileSync(path.join(canvasDir, 'design.json'), 'utf8'));
  d.repo = SAC;
  fs.writeFileSync(path.join(canvasDir, 'design.json'), JSON.stringify(d));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'last.json'), JSON.stringify({ byTab: { t1: canvasDir }, byCwd: {} }));
  return { canvasDir, dataDir };
}

async function gone(dataDir, ms) {
  let left = pgrep(dataDir);
  for (let i = 0; i < ms / 100 && left.length; i++) { await sleep(100); left = pgrep(dataDir); }
  return left;
}

function cleanup(h, tmp, dataDir) {
  h.proc.kill('SIGKILL');
  for (const pid of pgrep(dataDir)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
}

const pgrep = (pattern) => {
  try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('answers initialize and exits when stdin closes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-main-'));
  const h = host();
  try {
    const r = await h.request('initialize', { apiVersion: 1, rfw: 2, dataDir: tmp });
    assert.deepStrictEqual(r.result, {});
    const c = await h.request('command.invoke', { command: 'ajustar', context: {} });
    assert.strictEqual(c.result, null);
    const b = await h.wait((m) => m.method === 'window.showBanner');
    assert.match(b.params.text, /nenhum canvas aberto/);
    h.proc.stdin.end();
    assert.strictEqual(await h.exited, 0);
  } finally {
    h.proc.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('abrir opens the canvas beside the session, renders boards, and leaves no orphans', { skip: skipEngine, timeout: 45000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-main-'));
  const canvasDir = path.join(tmp, 'canvas');
  const dataDir = path.join(tmp, 'data');
  fs.cpSync(path.join(__dirname, '..', 'bench', 'sac-sidebar'), canvasDir, { recursive: true });
  const d = JSON.parse(fs.readFileSync(path.join(canvasDir, 'design.json'), 'utf8'));
  d.repo = SAC;
  fs.writeFileSync(path.join(canvasDir, 'design.json'), JSON.stringify(d));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'last.json'), JSON.stringify({ byTab: {}, byCwd: { '/somewhere': canvasDir } }));
  const h = host();
  try {
    await h.request('initialize', { apiVersion: 1, rfw: 2, picture: 1, zoomFocus: 1, dataDir });
    await h.request('command.invoke', { command: 'abrir', context: { cwd: '/somewhere', folder: '/somewhere', sessionId: '', title: '' } });
    const open = await h.wait((m) => m.method === 'view.open');
    assert.match(open.params.viewId, /^canvas:[0-9a-f]{12}$/);
    assert.match(open.params.rfw.library, /widget root =/);
    const upd = await rendered(h, { cwd: '/somewhere', folder: '/somewhere', sessionId: '', title: '' });
    const board = upd.params.data.boards.find((b) => b.light);
    const hash = open.params.viewId.slice('canvas:'.length);
    assert.strictEqual(board.light, `${hash}/png/${board.name}.light.png`);
    assert.ok(fs.existsSync(path.join(dataDir, board.light)), 'picture path resolves inside the plugin data dir');
    assert.ok(!Number.isInteger(board.left) && !Number.isInteger(board.width), 'rfw doubles');

    // follow: a saved board is highlighted and, with the user idle, focused
    const file = path.join(canvasDir, 'boards', `${board.name}.html`);
    const src = fs.readFileSync(file, 'utf8');
    const n0 = h.msgs.length;
    fs.writeFileSync(file, src.replace('class="', 'class="[--smoke:1] '));
    const hl = await h.wait((m) => h.msgs.indexOf(m) >= n0 && m.method === 'view.update' && m.params.data
      && m.params.data.boards.some((b) => b.name === board.name && b.highlight), 10000);
    assert.strictEqual(hl.params.data.zoom.command, 'focus');
    assert.ok(hl.params.data.zoom.rev >= 1, 'jumped to the board');
    // the user's double-click focuses too
    h.send({ method: 'view.action', params: { viewId: open.params.viewId, action: 'act', values: { a: `focus:${board.name}` } } });
    const f = await h.wait((m) => m.method === 'view.update' && m.params.data && m.params.data.zoom.rev > hl.params.data.zoom.rev);
    assert.strictEqual(f.params.data.zoom.command, 'focus');
    // the user pans: the next save only highlights
    const rev1 = hl.params.data.boards.find((b) => b.name === board.name).rev;
    h.send({ method: 'view.action', params: { viewId: open.params.viewId, action: 'act', values: { a: 'move', scale: 2, x: 10, y: 10 } } });
    await h.wait((m) => m.method === 'view.update' && m.params.data && m.params.data.zoomLabel === '200%');
    const n1 = h.msgs.length;
    fs.writeFileSync(file, src.replace('class="', 'class="[--smoke:2] '));
    const hl2 = await h.wait((m) => h.msgs.indexOf(m) >= n1 && m.method === 'view.update' && m.params.data
      && m.params.data.boards.some((b) => b.name === board.name && b.highlight && b.rev > rev1), 10000);
    assert.strictEqual(hl2.params.data.zoom.rev, f.params.data.zoom.rev, 'did not steal the navigation');

    assert.ok(pgrep(dataDir).length > 0, 'chrome/tailwind running for the open canvas');
    h.proc.stdin.end(); // the Maestria going away, no shutdown first
    assert.strictEqual(await h.exited, 0);
    let left = pgrep(dataDir);
    for (let i = 0; i < 30 && left.length; i++) { await sleep(100); left = pgrep(dataDir); }
    assert.deepStrictEqual(left, [], 'no orphan chrome/tailwind');
  } finally {
    h.proc.kill('SIGKILL');
    for (const pid of pgrep(dataDir)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('view.closed closes the engine (chrome and tailwind die); sprite fallback', { skip: skipEngine, timeout: 45000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-main-'));
  const canvasDir = path.join(tmp, 'canvas');
  const dataDir = path.join(tmp, 'data');
  fs.cpSync(path.join(__dirname, '..', 'bench', 'sac-sidebar'), canvasDir, { recursive: true });
  const d = JSON.parse(fs.readFileSync(path.join(canvasDir, 'design.json'), 'utf8'));
  d.repo = SAC;
  fs.writeFileSync(path.join(canvasDir, 'design.json'), JSON.stringify(d));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'last.json'), JSON.stringify({ byTab: { t1: canvasDir }, byCwd: {} }));
  const h = host();
  try {
    const pluginDir = path.join(tmp, 'plugin'); // an old Maestria: no Picture, sprites copied here
    await h.request('initialize', { apiVersion: 1, rfw: 2, sprites: 1, dataDir, pluginDir });
    await h.request('command.invoke', { command: 'abrir', context: { cwd: '/x', tabId: 't1' } });
    const open = await h.wait((m) => m.method === 'view.open');
    const upd = await rendered(h, { cwd: '/x', tabId: 't1' });
    const board = upd.params.data.boards.find((b) => b.light);
    assert.strictEqual(upd.params.data.picture, false);
    assert.match(board.light, /^cache\/[0-9a-f]{12}\/[a-z0-9_-]+\.light\.\d+\.png$/);
    assert.ok(fs.existsSync(path.join(pluginDir, board.light)), 'sprite sheet copied into the plugin dir');
    assert.ok(pgrep(dataDir).length > 0);
    h.send({ method: 'event', params: { type: 'view.closed', viewId: open.params.viewId } });
    let left = pgrep(dataDir);
    for (let i = 0; i < 50 && left.length; i++) { await sleep(100); left = pgrep(dataDir); }
    assert.deepStrictEqual(left, []);
    assert.ok(!fs.existsSync(path.join(pluginDir, path.dirname(board.light))), 'sprite cache dropped');
    h.send({ method: 'shutdown' });
    assert.strictEqual(await h.exited, 0);
  } finally {
    h.proc.kill('SIGKILL');
    for (const pid of pgrep(dataDir)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a closed grid tab (no view.closed) is noticed by the probe and its engine dies', { skip: skipEngine, timeout: 45000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-main-'));
  const { dataDir } = makeCanvas(tmp);
  const h = host({ MAESTRIA_DESIGN_PROBE_MS: '300' });
  try {
    await h.request('initialize', { apiVersion: 1, rfw: 2, picture: 1, zoomFocus: 1, dataDir });
    await h.request('command.invoke', { command: 'abrir', context: { cwd: '/x', tabId: 't1' } });
    await rendered(h, { cwd: '/x', tabId: 't1' });
    assert.ok(pgrep(dataDir).length > 0);
    // the user closes the tab: from now on the host knows no such view
    h.reply = (m) => (m.method === 'view.update' ? { open: false } : undefined);
    const probe = await h.wait((m) => m.method === 'view.update' && Object.keys(m.params).length === 1, 3000);
    assert.match(probe.params.viewId, /^canvas:/);
    assert.deepStrictEqual(await gone(dataDir, 6000), [], 'engine gone after the probe');
    h.proc.stdin.end();
    assert.strictEqual(await h.exited, 0);
  } finally {
    cleanup(h, tmp, dataDir);
  }
});

test('the user clicking + holds off follow: a save 1 s later only highlights', { skip: skipEngine, timeout: 45000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-main-'));
  const { canvasDir, dataDir } = makeCanvas(tmp);
  const h = host();
  try {
    await h.request('initialize', { apiVersion: 1, rfw: 2, picture: 1, zoomFocus: 1, dataDir });
    await h.request('command.invoke', { command: 'abrir', context: { cwd: '/x', tabId: 't1' } });
    const open = await h.wait((m) => m.method === 'view.open');
    const upd = await rendered(h, { cwd: '/x', tabId: 't1' });
    const board = upd.params.data.boards.find((b) => b.light);
    h.send({ method: 'view.action', params: { viewId: open.params.viewId, action: 'act', values: { a: 'zoom:in' } } });
    const zin = await h.wait((m) => m.method === 'view.update' && m.params.data && m.params.data.zoom.command === 'in');
    await sleep(1000);
    const n0 = h.msgs.length;
    const file = path.join(canvasDir, 'boards', `${board.name}.html`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('class="', 'class="[--smoke:3] '));
    const hl = await h.wait((m) => h.msgs.indexOf(m) >= n0 && m.method === 'view.update' && m.params.data
      && m.params.data.boards.some((b) => b.name === board.name && b.highlight), 10000);
    assert.strictEqual(hl.params.data.zoom.rev, zin.params.data.zoom.rev, 'no jump after the user zoomed');
    assert.strictEqual(hl.params.data.zoom.command, 'in');
    h.proc.stdin.end();
    assert.strictEqual(await h.exited, 0);
  } finally {
    cleanup(h, tmp, dataDir);
  }
});

test('stdin closing while the engine is still opening leaves no chrome/tailwind', { skip: skipEngine, timeout: 45000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-main-'));
  const { dataDir } = makeCanvas(tmp);
  const h = host();
  try {
    await h.request('initialize', { apiVersion: 1, rfw: 2, picture: 1, zoomFocus: 1, dataDir });
    await h.request('command.invoke', { command: 'abrir', context: { cwd: '/x', tabId: 't1' } });
    await h.wait((m) => m.method === 'view.open');
    // wait until a child is up, but before the engine finished opening (no render yet)
    for (let i = 0; i < 100 && !pgrep(dataDir).length; i++) await sleep(20);
    assert.ok(pgrep(dataDir).length > 0, 'a child started');
    assert.ok(!h.msgs.some((m) => m.method === 'view.update' && m.params.data && m.params.data.message === ''), 'still opening');
    h.proc.stdin.end();
    assert.strictEqual(await h.exited, 0);
    assert.deepStrictEqual(await gone(dataDir, 3000), [], 'no orphan from the open in flight');
  } finally {
    cleanup(h, tmp, dataDir);
  }
});
