'use strict';
// An engine opened on a canvas with no boards yet: the first board designed
// afterwards must still get the project's css (Tailwind watches the expanded dir).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chromeMod = require('../lib/chrome');
const engineMod = require('../lib/engine');
const canvasMod = require('../lib/canvas');
const { readPng } = require('./png');

const SAC = '/home/arthur/Desktop/Work/Ninepay/customer-service-design-bench';
const skip = (!chromeMod.findExecutable() && 'no chrome')
  || (!fs.existsSync(path.join(SAC, 'node_modules', '.bin', 'tailwindcss')) && 'no SAC tailwind');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-engine-empty-'));
const canvasDir = path.join(tmp, 'canvas');
const dataDir = path.join(tmp, 'data');
let eng = null;

test.after(async () => {
  if (eng) await eng.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function nextBoard(name, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { eng.off('board', on); reject(new Error('timeout waiting for board event')); }, ms);
    const on = (n, s) => { if (n === name) { clearTimeout(t); eng.off('board', on); resolve(s); } };
    eng.on('board', on);
  });
}

test('a board designed after opening an empty canvas gets its css', { skip, timeout: 30000 }, async () => {
  fs.mkdirSync(canvasDir, { recursive: true });
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'sac-sidebar', 'design.json'), 'utf8'));
  d.repo = SAC;
  d.brand = null;
  fs.writeFileSync(path.join(canvasDir, 'design.json'), JSON.stringify(d));
  canvasMod.write(canvasDir, { v: 1, title: 'vazio', boards: {}, order: [] });
  eng = await engineMod.open(canvasDir, { dataDir, log: () => {} });
  const seen = nextBoard('novo');
  const { canvas } = canvasMod.upsertBoard(canvasMod.read(canvasDir), { name: 'novo', w: 400 });
  fs.mkdirSync(path.join(canvasDir, 'boards'), { recursive: true });
  fs.writeFileSync(path.join(canvasDir, 'boards', 'novo.html'), '<div class="p-7 bg-n-slate-3">novo</div>');
  canvasMod.write(canvasDir, canvas);
  const s = await seen;
  assert.ok(s && !s.error && s.light, JSON.stringify(s));
  await eng.idle();
  const css = fs.readFileSync(path.join(dataDir, 'tailwind.css'), 'utf8');
  assert.match(css, /\.p-7\b/);
  assert.match(css, /\.bg-n-slate-3\b/);
});

test('design_render captures stay within 1568 px while the canvas keeps 2x', { skip, timeout: 30000 }, async () => {
  const { canvas } = canvasMod.upsertBoard(canvasMod.read(canvasDir), { name: 'largo', w: 1440, h: 900 });
  fs.writeFileSync(path.join(canvasDir, 'boards', 'largo.html'), '<div class="p-7">largo</div>');
  canvasMod.write(canvasDir, canvas);
  eng.loadCanvas(true);
  const m = await eng.render(['largo'], { forClaude: true });
  const s = m.get('largo');
  assert.ok(s && !s.error && s.claude, JSON.stringify(s));
  for (const t of ['light', 'dark']) {
    const small = readPng(fs.readFileSync(s.claude[t]));
    assert.ok(small.width <= 1568 && small.height <= 1568, `${t} ${small.width}×${small.height}`);
    assert.ok(small.width >= 1500, `${t} not shrunk too far: ${small.width}`);
    assert.strictEqual(readPng(fs.readFileSync(s[t])).width, 2880);
  }
});
