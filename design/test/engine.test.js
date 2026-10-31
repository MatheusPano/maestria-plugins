'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chromeMod = require('../lib/chrome');
const engineMod = require('../lib/engine');
const canvasMod = require('../lib/canvas');

const SAC = '/home/arthur/Desktop/Work/Ninepay/customer-service-design-bench';
const skip = (!chromeMod.findExecutable() && 'no chrome')
  || (!fs.existsSync(path.join(SAC, 'node_modules', '.bin', 'tailwindcss')) && 'no SAC tailwind');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-engine-'));
const canvasDir = path.join(tmp, 'canvas');
const dataDir = path.join(tmp, 'data');
let eng = null;
const events = []; // { name, state, at }
const logs = [];

const boardFile = (n) => path.join(canvasDir, 'boards', `${n}.html`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitBoard(pred, ms = 8000) {
  const hit = events.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { eng.off('board', on); reject(new Error('timeout waiting for board event')); }, ms);
    const on = () => {
      const e = events.find(pred);
      if (e) { clearTimeout(t); eng.off('board', on); resolve(e); }
    };
    eng.on('board', on);
  });
}

function addBoard(name, html, w = 400) {
  const c = canvasMod.read(canvasDir);
  const { canvas } = canvasMod.upsertBoard(c, { name, w });
  fs.writeFileSync(boardFile(name), html);
  canvasMod.write(canvasDir, canvas);
}

test.before(async () => {
  if (skip) return;
  fs.cpSync(path.join(__dirname, '..', 'bench', 'sac-sidebar'), canvasDir, { recursive: true });
  const d = JSON.parse(fs.readFileSync(path.join(canvasDir, 'design.json'), 'utf8'));
  d.repo = SAC;
  fs.writeFileSync(path.join(canvasDir, 'design.json'), JSON.stringify(d));
  eng = await engineMod.open(canvasDir, { dataDir, log: (m) => logs.push(m) });
  eng.on('board', (name, state) => events.push({ name, state, at: Date.now() }));
});

test.after(async () => {
  if (eng) await eng.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('renders every board once on open', { skip }, async () => {
  const e = await waitBoard((x) => x.name === 'conversas' && x.state && x.state.light);
  assert.ok(fs.existsSync(e.state.light));
  assert.ok(fs.existsSync(e.state.dark));
  assert.strictEqual(e.state.light, path.join(dataDir, 'png', 'conversas.light.png'));
  assert.strictEqual(e.state.width, 1280);
  assert.ok(e.state.height > 100);
});

test('saving a board emits both PNGs under 1 s and logs the render ms', { skip }, async () => {
  events.length = 0;
  const src = fs.readFileSync(boardFile('conversas'), 'utf8');
  const t0 = Date.now();
  fs.writeFileSync(boardFile('conversas'), src.replace('class="', 'class="[--engine-test:1] '));
  const e = await waitBoard((x) => x.name === 'conversas');
  assert.ok(e.state.light && e.state.dark && !e.state.error, JSON.stringify(e.state));
  assert.ok(fs.existsSync(e.state.light) && fs.existsSync(e.state.dark));
  assert.ok(e.state.ms < 1000, `ms ${e.state.ms}`);
  assert.ok(e.at - t0 < 1000, `save to event ${e.at - t0}`);
  assert.strictEqual(typeof e.state.rev, 'number');
  assert.ok(logs.some((m) => /^render conversas: \d+ ms/.test(m)));
});

test('a text-only save (no new class) still renders promptly', { skip }, async () => {
  events.length = 0;
  const src = fs.readFileSync(boardFile('conversas'), 'utf8');
  fs.writeFileSync(boardFile('conversas'), src.replace('Ninepay', 'Ninepay texto'));
  const e = await waitBoard((x) => x.name === 'conversas');
  assert.ok(e.state.light && !e.state.error);
  assert.ok(e.state.ms < 1000, `ms ${e.state.ms}`);
});

test('a broken board emits error and keeps the previous PNG paths', { skip }, async () => {
  const before = events.filter((x) => x.name === 'conversas').pop().state;
  events.length = 0;
  fs.writeFileSync(boardFile('conversas'), '<div class="');
  const e = await waitBoard((x) => x.name === 'conversas');
  assert.match(e.state.error, /marcação inválida/);
  assert.strictEqual(e.state.light, before.light);
  assert.strictEqual(e.state.dark, before.dark);
  assert.ok(fs.existsSync(e.state.light));
  // fixing it recovers
  events.length = 0;
  fs.writeFileSync(boardFile('conversas'), '<div class="p-4 text-xl">de volta</div>');
  const ok = await waitBoard((x) => x.name === 'conversas');
  assert.ok(!ok.state.error && ok.state.light, JSON.stringify(ok.state));
});

test('a changed component re-renders only the boards that use it', { skip }, async () => {
  fs.writeFileSync(path.join(canvasDir, 'components', 'NavItem.html'), '<a class="block p-2">{{label}}</a>');
  addBoard('uses', '<x-nav-item label="um"></x-nav-item>');
  addBoard('plain', '<div class="p-4">sem componente</div>');
  await waitBoard((x) => x.name === 'uses' && x.state && x.state.light);
  await waitBoard((x) => x.name === 'plain' && x.state && x.state.light);
  await sleep(300);
  events.length = 0;
  fs.writeFileSync(path.join(canvasDir, 'components', 'NavItem.html'), '<a class="block p-6 bg-red-500">{{label}}</a>');
  await waitBoard((x) => x.name === 'uses');
  await sleep(500);
  assert.deepStrictEqual([...new Set(events.map((x) => x.name))], ['uses']);
});

test('render() forces boards now and returns their states', { skip }, async () => {
  const m = await eng.render(['plain']);
  assert.ok(m.get('plain').light);
  assert.ok(fs.existsSync(m.get('plain').dark));
});

test('component name errors surface on the canvas', { skip }, async () => {
  const seen = new Promise((resolve) => eng.on('canvas', (c) => { if (c.warnings.some((w) => /nav_item/.test(w))) resolve(c); }));
  fs.writeFileSync(path.join(canvasDir, 'components', 'nav_item.html'), 'x');
  const c = await Promise.race([seen, sleep(3000).then(() => null)]);
  assert.ok(c, 'canvas event with component warning');
  fs.rmSync(path.join(canvasDir, 'components', 'nav_item.html'));
});

test('deleting a board emits null and nothing after', { skip }, async () => {
  events.length = 0;
  const png = eng.states.get('plain').light;
  fs.rmSync(boardFile('plain'));
  const e = await waitBoard((x) => x.name === 'plain');
  assert.strictEqual(e.state, null);
  await sleep(600);
  assert.strictEqual(events.filter((x) => x.name === 'plain').length, 1);
  assert.ok(!fs.existsSync(png));
});

test('a render in flight for a deleted board is dropped', { skip }, async () => {
  addBoard('racy', '<div class="p-4">racy</div>');
  await waitBoard((x) => x.name === 'racy' && x.state && x.state.light);
  events.length = 0;
  const p = eng.render(['racy']); // queued now
  fs.rmSync(boardFile('racy'));
  await p;
  await sleep(600);
  const mine = events.filter((x) => x.name === 'racy');
  assert.ok(mine.every((x, i) => i === mine.length - 1 ? x.state === null : true), JSON.stringify(mine.map((x) => !!x.state)));
  assert.strictEqual(mine[mine.length - 1].state, null);
});

test('close() leaves no chrome or tailwind process', { skip }, async () => {
  const pids = [eng.chrome.proc.pid, eng.tw.pid];
  assert.ok(pids.every(Number.isInteger));
  await eng.close();
  await sleep(100);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), `pid ${pid} still alive`);
  assert.ok(!fs.existsSync(path.join(canvasDir, 'png')), 'nothing written into the canvas folder');
});
