'use strict';
// Engine scheduling with fake Chrome/Tailwind/render: no processes started.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const chromeMod = require('../lib/chrome');
const renderMod = require('../lib/render');
const canvasMod = require('../lib/canvas');
const { Engine } = require('../lib/engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-engine-unit-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realLaunch = chromeMod.launch;
const realRender = renderMod.renderPage;

test.after(() => {
  chromeMod.launch = realLaunch;
  renderMod.renderPage = realRender;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function makeEngine() {
  const dir = path.join(tmp, `c${++n}`);
  const dataDir = path.join(tmp, `d${n}`);
  fs.mkdirSync(path.join(dir, 'boards'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'design.json'), JSON.stringify({ repo: tmp, darkMode: { class: 'dark' }, css: [], brand: null, head: '' }));
  const { canvas } = canvasMod.upsertBoard({ v: 1, title: 't', boards: {}, order: [] }, { name: 'a', w: 100 });
  canvasMod.write(dir, canvas);
  fs.writeFileSync(path.join(dir, 'boards', 'a.html'), '<div class="p-1">a</div>');
  const eng = new Engine(dir, { dataDir, log: () => {} });
  eng.loadDesign();
  eng.loadCanvas(false);
  fs.writeFileSync(eng.outCss, 'old');
  return eng;
}

// _render stand-in: records the css each render saw.
function fakeRender(eng, during) {
  const calls = [];
  eng._render = async (name, rev, forClaude) => {
    calls.push({ name, rev, forClaude, css: fs.readFileSync(eng.outCss, 'utf8'), at: Date.now() });
    if (during) await during(calls.length);
    fs.mkdirSync(path.join(eng.dataDir, 'png'), { recursive: true });
    const themes = forClaude ? ['light', 'dark', 'light.claude', 'dark.claude'] : ['light', 'dark'];
    const temps = themes.map((t) => path.join(eng.dataDir, 'png', `${name}.${t}.${rev}.tmp.png`));
    for (const t of temps) fs.writeFileSync(t, 'png');
    return { temps, width: 100, height: 10, cut: false };
  };
  return calls;
}

// A Tailwind whose rebuild lands after `ms` (the css is rewritten when `write`).
function slowTw(eng, ms, { write = true } = {}) {
  return {
    failed: null,
    whenBuilt() {
      let timer;
      const p = new Promise((resolve) => {
        timer = setTimeout(() => { if (write) fs.writeFileSync(eng.outCss, 'built'); resolve(); }, ms);
      });
      p.cancel = () => clearTimeout(timer);
      return p;
    },
    stop: async () => {},
  };
}

test('a rebuild slower than the grace period re-renders the board once with the new css', async () => {
  const eng = makeEngine();
  eng.tw = slowTw(eng, 500);
  const calls = fakeRender(eng);
  const states = [];
  eng.on('board', (name, s) => states.push(s));
  await eng.schedule(['a']);
  assert.strictEqual(calls.length, 1, 'rendered at the grace limit');
  assert.strictEqual(calls[0].css, 'old');
  await sleep(800);
  await eng.idle();
  assert.strictEqual(calls.length, 2, 're-rendered once the build landed');
  assert.strictEqual(calls[1].css, 'built');
  assert.ok(!states[states.length - 1].error);
  await sleep(300);
  assert.strictEqual(calls.length, 2, 'no further renders');
  await eng.close();
});

test('a slow rebuild that leaves the css unchanged does not re-render', async () => {
  const eng = makeEngine();
  eng.tw = slowTw(eng, 400, { write: false });
  const calls = fakeRender(eng);
  await eng.schedule(['a']);
  await sleep(700);
  await eng.idle();
  assert.strictEqual(calls.length, 1);
  await eng.close();
});

test('a board re-saved before the slow build lands is not re-rendered by it', async () => {
  const eng = makeEngine();
  eng.tw = slowTw(eng, 400);
  const calls = fakeRender(eng);
  await eng.schedule(['a']);
  eng.touch('a'); // a newer save is on its way and renders by itself
  await sleep(700);
  await eng.idle();
  assert.strictEqual(calls.length, 1);
  await eng.close();
});

test('render(forClaude) superseded by a save (the file watcher) still returns a fresh small capture', async () => {
  const eng = makeEngine();
  const calls = fakeRender(eng, (i) => { if (i === 1) eng.schedule(['a']); });
  const m = await eng.render(['a'], { forClaude: true });
  const s = m.get('a');
  assert.ok(s && s.claude && fs.existsSync(s.claude.light), JSON.stringify(s));
  assert.strictEqual(s.rev, eng.revs.get('a'));
  assert.ok(calls.length <= 3, `${calls.length} renders`);
  await eng.close();
});

function fakeChrome() {
  const c = new EventEmitter();
  c.exited = false;
  c.proc = { pid: 0 };
  c.abort = () => { if (c.exited) return; c.exited = true; c.emit('exit'); };
  c.close = async () => c.abort();
  return c;
}

test('chrome deaths reset after a good render: only consecutive deaths are final', async () => {
  const eng = makeEngine();
  let launches = 0;
  let launchFails = false;
  chromeMod.launch = async () => {
    launches++;
    if (launchFails) throw new Error('sem chrome');
    const c = fakeChrome();
    return c;
  };
  renderMod.renderPage = async (chrome, { width, out, small }) => {
    if (chrome.exited) throw new Error('chrome exited');
    fs.writeFileSync(out, 'png');
    if (small) fs.writeFileSync(small.out, 'png');
    return { width, height: 10, cut: false, ms: 1 };
  };
  eng.chrome = await eng._chrome();
  for (let i = 0; i < 3; i++) {
    eng.chrome.abort();
    const m = await eng.render(['a']);
    assert.ok(!m.get('a').error, `death ${i + 1}: ${JSON.stringify(m.get('a'))}`);
  }
  assert.strictEqual(launches, 4);
  // two deaths in a row (the process dies, then the relaunch fails) are final
  eng.chrome.abort();
  launchFails = true;
  let m = await eng.render(['a']);
  assert.match(m.get('a').error, /o chrome não subiu/);
  const tried = launches;
  m = await eng.render(['a']);
  assert.match(m.get('a').error, /o chrome não subiu/);
  assert.strictEqual(launches, tried, 'no further launch');
  assert.ok(eng.chromeError);
  await eng.close();
  chromeMod.launch = realLaunch;
  renderMod.renderPage = realRender;
});
