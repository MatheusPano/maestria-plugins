'use strict';
// Speed gate: node design/bench/bench.js <canvasDir> [runs]
// Measures the real Chrome + project Tailwind loop; prints a markdown table.
const fs = require('node:fs');
const path = require('node:path');
const chromeMod = require('../lib/chrome');
const { renderPage } = require('../lib/render');
const { buildPage, startTailwind } = require('../lib/page');

const RUNS = Number(process.argv[3]) || 10;
const GATE = { adjustP90: 1000, cold: 3000 };
const outDir = path.join(__dirname, 'out');

function read(p) { return fs.readFileSync(p, 'utf8'); }

function percentile(sorted, p) { // nearest rank
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: percentile(s, 0.5), p90: percentile(s, 0.9), min: s[0], max: s[s.length - 1] };
}

class Session {
  constructor(canvas, design, boardName) {
    this.design = design;
    this.canvas = canvas;
    this.board = boardName;
    this.boardSrc = path.join(canvas, 'boards', `${boardName}.html`);
    this.data = path.join(outDir, 'data');
    this.expanded = path.join(this.data, 'expanded', `${boardName}.html`);
    this.rendered = path.join(this.data, 'render', `${boardName}.html`);
    this.outCss = path.join(this.data, 'tailwind.css');
    this.w = Number(JSON.parse(read(path.join(canvas, 'canvas.json'))).boards[boardName].w);
    this.brand = design.brand ? read(path.join(canvas, design.brand)) : '';
    this.chrome = null;
    this.tw = null;
  }

  // Board fragment -> plain HTML the Tailwind CLI scans.
  expand() {
    fs.mkdirSync(path.dirname(this.expanded), { recursive: true });
    fs.writeFileSync(this.expanded, buildPage({
      outCss: this.outCss, brandCss: this.brand, head: this.design.head, body: read(this.boardSrc),
    }));
  }

  // Render copy: same page, css url versioned by the built css mtime (never cached by Chrome).
  inlineCss() {
    fs.mkdirSync(path.dirname(this.rendered), { recursive: true });
    fs.writeFileSync(this.rendered, buildPage({
      outCss: this.outCss, brandCss: this.brand, head: this.design.head, body: read(this.boardSrc),
      version: fs.statSync(this.outCss).mtimeMs,
    }));
  }

  async renderBoth() {
    this.inlineCss();
    const dark = this.design.darkMode;
    const base = { htmlPath: this.rendered, width: this.w };
    // one shared Chrome target: renders are serialized
    const light = await renderPage(this.chrome, { ...base, dark: null, out: path.join(outDir, 'conversas.light.png') });
    const darkR = await renderPage(this.chrome, { ...base, dark, out: path.join(outDir, 'conversas.dark.png') });
    return { light, dark: darkR };
  }

  startTailwind() {
    return startTailwind({
      canvasDir: this.canvas, design: this.design, dataDir: this.data, outCss: this.outCss,
      log: (m) => console.error('[tailwind]', m),
    });
  }

  async stop() {
    if (this.tw) await this.tw.stop();
    if (this.chrome) await this.chrome.close();
    this.tw = null;
    this.chrome = null;
  }
}

async function coldRun(mk) {
  fs.rmSync(path.join(outDir, 'data'), { recursive: true, force: true });
  const s = mk();
  const t0 = Date.now();
  s.expand();
  const [chrome, tw] = await Promise.all([
    chromeMod.launch({ log: (m) => console.error('[chrome]', m) }),
    s.startTailwind(),
  ]);
  s.chrome = chrome;
  s.tw = tw;
  const t1 = Date.now();
  const r = await s.renderBoth();
  const total = Date.now() - t0;
  const heights = `${r.light.height}px`;
  await s.stop();
  return { total, startup: t1 - t0, render: total - (t1 - t0), heights };
}

async function adjustRuns(mk, canvasCopy) {
  fs.rmSync(path.join(outDir, 'data'), { recursive: true, force: true });
  const s = mk();
  s.expand();
  s.chrome = await chromeMod.launch({ log: (m) => console.error('[chrome]', m) });
  s.tw = await s.startTailwind();
  await s.renderBoth();
  const times = [];
  const parts = [];
  for (let i = 1; i <= RUNS; i++) {
    const src = read(s.boardSrc);
    const t0 = Date.now();
    // append a never-seen utility class so the CLI has real work to do
    fs.writeFileSync(s.boardSrc, src.replace('class="', `class="[--bench-${i}:1] `));
    s.expand();
    await s.tw.whenBuilt(t0);
    const tBuilt = Date.now();
    await s.renderBoth();
    const t = Date.now() - t0;
    times.push(t);
    parts.push({ build: tBuilt - t0, render: Date.now() - tBuilt });
  }
  await s.stop();
  void canvasCopy;
  return { times, parts };
}

async function main() {
  const canvasArg = process.argv[2];
  if (!canvasArg) throw new Error('uso: bench.js <canvasDir> [runs]');
  const canvas = path.resolve(canvasArg);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  // work on a copy: the bench edits the board
  const work = path.join(outDir, 'canvas');
  fs.cpSync(canvas, work, { recursive: true });
  const design = JSON.parse(read(path.join(work, 'design.json')));
  const boardName = Object.keys(JSON.parse(read(path.join(work, 'canvas.json'))).boards)[0];
  const mk = () => new Session(work, design, boardName);

  const cold = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = await coldRun(mk);
    cold.push(r);
    console.log(`cold ${i}: ${r.total} ms (startup ${r.startup} + render ${r.render}) height ${r.heights}`);
  }
  const adj = await adjustRuns(mk, work);
  adj.times.forEach((t, i) => console.log(`adjust ${i + 1}: ${t} ms (build ${adj.parts[i].build} + render ${adj.parts[i].render})`));

  const c = stats(cold.map((x) => x.total));
  const a = stats(adj.times);
  const passA = a.p90 < GATE.adjustP90;
  const passC = c.p90 < GATE.cold; // cold start gate judged on p90 as well as p50 below
  const table = [
    `| medida | runs | p50 | p90 | min | max | gate | ok |`,
    `|---|---|---|---|---|---|---|---|`,
    `| primeira abertura (chrome + tailwind + render claro+escuro) | ${RUNS} | ${c.p50} ms | ${c.p90} ms | ${c.min} ms | ${c.max} ms | < ${GATE.cold} ms | ${c.p50 < GATE.cold ? 'sim (p50)' : 'não (p50)'}; p90 ${passC ? 'sim' : 'não'} |`,
    `| ajuste (salvar -> build -> render claro+escuro) | ${RUNS} | ${a.p50} ms | ${a.p90} ms | ${a.min} ms | ${a.max} ms | p90 < ${GATE.adjustP90} ms | ${passA ? 'sim' : 'não'} |`,
  ].join('\n');
  console.log('\n' + table);
  console.log(`\nGATE: ${passA && c.p50 < GATE.cold && passC ? 'PASS' : 'FAIL'}`);
  fs.writeFileSync(path.join(outDir, 'table.md'), table + '\n');
  fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify({ cold, adj }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
