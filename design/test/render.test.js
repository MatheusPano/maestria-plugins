'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chromeMod = require('../lib/chrome');
const { renderPage } = require('../lib/render');
const { readPng, firstRowPixel } = require('./png');

const exe = chromeMod.findExecutable();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-render-'));
let chrome = null;

function page(name, html) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, html);
  return p;
}

test.after(async () => {
  if (chrome) await chrome.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('renders a fixed-size box at 2x', { skip: !exe && 'no chrome' }, async () => {
  chrome = await chromeMod.launch({ log: () => {} });
  const html = page('a.html', '<body style="margin:0"><div style="width:300px;height:120px;background:#123"></div></body>');
  const out = path.join(tmp, 'a.png');
  const r = await renderPage(chrome, { htmlPath: html, width: 300, dark: null, out });
  assert.strictEqual(r.width, 300);
  assert.strictEqual(r.height, 120);
  assert.strictEqual(r.cut, false);
  const png = readPng(fs.readFileSync(out));
  assert.strictEqual(png.width, 600);
  assert.strictEqual(png.height, 240);
  assert.ok(!fs.existsSync(out + '.tmp'));
});

test('cuts tall pages at 4000', { skip: !exe && 'no chrome' }, async () => {
  const html = page('b.html', '<body style="margin:0"><div style="height:9000px"></div></body>');
  const r = await renderPage(chrome, { htmlPath: html, width: 300, dark: null, out: path.join(tmp, 'b.png') });
  assert.strictEqual(r.height, 4000);
  assert.strictEqual(r.cut, true);
});

test('applies dark class', { skip: !exe && 'no chrome' }, async () => {
  const html = page('c.html', '<style>.dark body{background:#000}body{margin:0;background:#fff}</style><body><div style="height:50px"></div></body>');
  const out = path.join(tmp, 'c.png');
  await renderPage(chrome, { htmlPath: html, width: 300, dark: { class: 'dark' }, out });
  const [r, g, b] = firstRowPixel(readPng(fs.readFileSync(out)), 1);
  assert.deepStrictEqual([r, g, b], [0, 0, 0]);
  const out2 = path.join(tmp, 'c2.png');
  await renderPage(chrome, { htmlPath: html, width: 300, dark: null, out: out2 });
  assert.deepStrictEqual(firstRowPixel(readPng(fs.readFileSync(out2)), 1).slice(0, 3), [255, 255, 255]);
});

test('ensure relaunches after chrome is killed', { skip: !exe && 'no chrome' }, async () => {
  const exited = new Promise((res) => chrome.on('exit', res));
  chrome.proc.kill('SIGKILL');
  await exited;
  chrome = await chromeMod.ensure(chrome, { log: () => {} });
  const html = page('d.html', '<body style="margin:0"><div style="width:300px;height:120px;background:#123"></div></body>');
  const r = await renderPage(chrome, { htmlPath: html, width: 300, dark: null, out: path.join(tmp, 'd.png') });
  assert.strictEqual(r.height, 120);
});

test('stuck page times out and ensure() recovers', { skip: !exe && 'no chrome', timeout: 30000 }, async () => {
  const bad = page('e.html', '<body><script>while(true){}</script></body>');
  const t0 = Date.now();
  await assert.rejects(
    renderPage(chrome, { htmlPath: bad, width: 300, dark: null, out: path.join(tmp, 'e.png') }),
    /timeout/,
  );
  assert.ok(Date.now() - t0 < 11000, 'rejected within ~11 s');
  assert.ok(chrome.exited);
  chrome = await chromeMod.ensure(chrome, { log: () => {} });
  const ok = page('f.html', '<body style="margin:0"><div style="height:120px"></div></body>');
  const r = await renderPage(chrome, { htmlPath: ok, width: 300, dark: null, out: path.join(tmp, 'f.png') });
  assert.strictEqual(r.height, 120);
});
