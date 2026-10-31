'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('../lib/tools');
const canvasMod = require('../lib/canvas');
const project = require('../lib/project');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-tools-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// home/co/repo is a "project" with a (fake) tailwind; home/co/design is where canvases go.
const home = path.join(tmp, 'home');
const repo = path.join(home, 'co', 'repo');
fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true });
fs.writeFileSync(path.join(repo, 'node_modules', '.bin', 'tailwindcss'), '');
fs.writeFileSync(path.join(repo, 'tailwind.config.js'),
  "const { c } = require('./colors.js');\nmodule.exports = { theme: { colors: { white: '#fff', ...c, brand: { 500: '#00f' } } } };\n");
fs.writeFileSync(path.join(repo, 'colors.js'), "const c = {\n  woot: { 500: '#00f' },\n  slate: { 1: '#fff' },\n};\nmodule.exports = { c };\n");

const PNG = Buffer.from('iVBORw0KGgo=', 'base64');
const png = path.join(tmp, 'x.png');
fs.writeFileSync(png, PNG);

function fakeHost() {
  const calls = [];
  const last = {};
  const host = {
    calls,
    lastFor: ({ tabId }) => last[tabId] || null,
    viewOf: () => null,
    request: async (m, p) => { calls.push(['request', m, p]); },
    openCanvas: async (dir, opts) => {
      calls.push(['openCanvas', dir, opts, fs.existsSync(path.join(dir, 'canvas.json'))]);
      last[opts.tabId] = dir;
      return {
        failed: false,
        ui: {},
        engine: {
          known: new Set(),
          loadCanvas() { this.known = new Set(canvasMod.read(dir).order); },
          render: async function render(names) {
            for (const n of names) if (!this.known.has(n)) return new Map(names.map((x) => [x, null]));
            calls.push(['render', names]);
            return new Map(names.map((n) => [n, n === 'bad'
              ? { error: 'marcação inválida', width: 10, height: 10, ms: 5 }
              : { light: png, dark: png, width: 1440, height: 900, ms: 30, cut: false }]));
          },
        },
      };
    },
    focusBoard: async (dir, name) => { calls.push(['focus', dir, name]); },
  };
  return host;
}

const ctxOf = (host, extra = {}) => ({ tabId: 't1', cwd: repo, home, host, ...extra });
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('manifest-facing schemas: design_ names, object inputSchema', () => {
  assert.deepStrictEqual(tools.SCHEMAS.map((s) => s.name),
    ['design_open', 'design_board', 'design_render', 'design_focus', 'design_list']);
  for (const s of tools.SCHEMAS) {
    assert.strictEqual(s.inputSchema.type, 'object');
    assert.ok(s.description.length > 20 && s.description.length < 400);
  }
});

test('design_open without a name directly under home is an error with the exact message', async () => {
  const host = fakeHost();
  const r = await tools.handle('design_open', {}, ctxOf(host, { cwd: path.join(home, 'solto') }));
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r), 'diga onde criar o canvas (ex.: ~/Desktop/Work/Ninepay/design/<nome>)');
  assert.strictEqual(host.calls.length, 0);
});

test('design_open with a name creates the folder, then opens the view for the caller tab', async () => {
  const host = fakeHost();
  const r = await tools.handle('design_open', { name: 'sidebar' }, ctxOf(host));
  assert.ok(!r.isError, textOf(r));
  const dir = path.join(home, 'co', 'design', 'sidebar');
  assert.ok(fs.existsSync(path.join(dir, 'canvas.json')));
  assert.ok(fs.existsSync(path.join(dir, 'design.json')));
  const [kind, openedDir, opts, existedThen] = host.calls[0];
  assert.strictEqual(kind, 'openCanvas');
  assert.strictEqual(openedDir, dir);
  assert.strictEqual(opts.tabId, 't1');
  assert.strictEqual(existedThen, true, 'the folder exists before the view opens');
  const t = textOf(r);
  assert.match(t, new RegExp(`canvas: ${dir}`));
  assert.match(t, new RegExp(`repo: ${repo}`));
  assert.match(t, /cores do tailwind do projeto: brand, woot, slate/);
  assert.match(t, /# Design canvas guide/);
});

test('design_open reuses the last canvas of the tab when no name is given', async () => {
  const host = fakeHost();
  await tools.handle('design_open', { name: 'a' }, ctxOf(host));
  const r = await tools.handle('design_open', {}, ctxOf(host));
  assert.match(textOf(r), /design\/a\n/);
});

test('design_open rejects a canvas outside home', async () => {
  const r = await tools.handle('design_open', { canvas: '/etc/x' }, ctxOf(fakeHost()));
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /dentro da home/);
});

test('design_board twice with the same name updates instead of duplicating', async () => {
  const host = fakeHost();
  await tools.handle('design_open', { name: 'b' }, ctxOf(host));
  const dir = path.join(home, 'co', 'design', 'b');
  const r1 = await tools.handle('design_board', { name: 'login', w: 1440 }, ctxOf(host));
  assert.strictEqual(textOf(r1).split('\n')[0], path.join(dir, 'boards', 'login.html'));
  assert.match(textOf(r1), /Write\/Edit.*design_render/);
  const r2 = await tools.handle('design_board', { name: 'login', w: 390, title: 'Login' }, ctxOf(host));
  assert.ok(!r2.isError);
  const c = canvasMod.read(dir);
  assert.deepStrictEqual(c.order, ['login']);
  assert.strictEqual(c.boards.login.w, 390);
  assert.strictEqual(c.boards.login.title, 'Login');
});

test('design_board without an open canvas says so', async () => {
  const r = await tools.handle('design_board', { name: 'x', w: 100 }, ctxOf(fakeHost(), { tabId: 'other' }));
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /design_open/);
});

async function withBoards(names) {
  const host = fakeHost();
  await tools.handle('design_open', { name: `r${names.length}${Math.random().toString(36).slice(2, 6)}` }, ctxOf(host));
  for (const n of names) await tools.handle('design_board', { name: n, w: 390 }, ctxOf(host));
  return host;
}

test('design_render returns png image items, light then dark', async () => {
  const host = await withBoards(['a']);
  const r = await tools.handle('design_render', { boards: ['a'] }, ctxOf(host));
  assert.ok(!r.isError);
  const imgs = r.content.filter((c) => c.type === 'image');
  assert.strictEqual(imgs.length, 2);
  assert.deepStrictEqual(imgs[0], { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
  assert.match(textOf(r), /a: 1440×900 px, 30 ms/);
  const labels = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  assert.ok(labels.indexOf('a (claro)') < labels.indexOf('a (escuro)'));
});

test('design_render honors theme and reports errors without images', async () => {
  const host = await withBoards(['a', 'bad']);
  const r = await tools.handle('design_render', { theme: 'dark' }, ctxOf(host));
  assert.strictEqual(r.content.filter((c) => c.type === 'image').length, 1);
  assert.match(textOf(r), /bad: 10×10 px, 5 ms, ERRO: marcação inválida/);
});

test('design_render caps at 8 images and says what it left out', async () => {
  const host = await withBoards(['a', 'b', 'c', 'd', 'e', 'f']);
  const r = await tools.handle('design_render', {}, ctxOf(host));
  assert.strictEqual(r.content.filter((c) => c.type === 'image').length, 8);
  assert.match(textOf(r), /não renderizadas.*e, f/);
  assert.deepStrictEqual(host.calls.filter((c) => c[0] === 'render').pop()[1], ['a', 'b', 'c', 'd']);
});

test('design_render with an unknown board is an error', async () => {
  const host = await withBoards(['a']);
  const r = await tools.handle('design_render', { boards: ['x'] }, ctxOf(host));
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r), 'prancheta não existe: x');
});

test('design_focus focuses a known board and rejects an unknown one', async () => {
  const host = await withBoards(['a']);
  const ok = await tools.handle('design_focus', { board: 'a' }, ctxOf(host));
  assert.ok(!ok.isError);
  assert.strictEqual(host.calls.filter((c) => c[0] === 'focus').pop()[2], 'a');
  const bad = await tools.handle('design_focus', { board: 'x' }, ctxOf(host));
  assert.strictEqual(textOf(bad), 'prancheta não existe: x');
});

test('design_list shows boards with components used and components with dependents', async () => {
  const host = await withBoards(['a', 'b']);
  const dir = host.calls.find((c) => c[0] === 'openCanvas')[1];
  fs.writeFileSync(path.join(dir, 'components', 'Toast.html'), '<div>{{ text }}</div>');
  fs.writeFileSync(path.join(dir, 'components', 'Unused.html'), '<i></i>');
  fs.writeFileSync(path.join(dir, 'boards', 'a.html'), '<x-toast text="oi"></x-toast>');
  const r = await tools.handle('design_list', {}, ctxOf(host));
  const t = textOf(r);
  assert.match(t, /- a: 390 px, .*boards\/a\.html, usa: Toast/);
  assert.match(t, /- b: 390 px, .*boards\/b\.html\n/);
  assert.match(t, /- Toast: .*components\/Toast\.html, usado em: a/);
  assert.match(t, /- Unused: .*sem uso/);
});

test('unknown tool', async () => {
  const r = await tools.handle('design_nope', {}, ctxOf(fakeHost()));
  assert.strictEqual(r.isError, true);
});

test('colorFamilies follows a spread of a relative import', () => {
  assert.deepStrictEqual(project.colorFamilies(repo).sort(), ['brand', 'slate', 'woot']);
  assert.deepStrictEqual(project.colorFamilies(tmp), []);
});

test('manifest tools equal tools.SCHEMAS', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'maestria-plugin.json'), 'utf8'));
  assert.deepStrictEqual(m.contributes.tools, tools.SCHEMAS);
  for (const t of m.contributes.tools) assert.ok(t.name.startsWith('design_'));
  for (const t of m.contributes.tools) assert.ok(m.activationEvents.includes(`onTool:${t.name}`));
});

test('design_board validates sizes, positions and title', async () => {
  const host = await withBoards([]);
  const bad = [{ w: 0 }, { w: 5000 }, { w: '10' }, { w: 10, h: '800' }, { w: 10, h: 4001 }, { w: 10, x: 'a' }, { w: 10, y: 1e9 }, { w: 10, title: 'x'.repeat(121) }, { w: 10, title: 5 }];
  for (const b of bad) {
    const r = await tools.handle('design_board', { name: 'v', ...b }, ctxOf(host));
    assert.strictEqual(r.isError, true, JSON.stringify(b));
  }
  const ok = await tools.handle('design_board', { name: 'v', w: 4000, h: 1, x: -5, y: 100000, title: 'ok' }, ctxOf(host));
  assert.ok(!ok.isError, textOf(ok));
});

test('design_render rejects an invalid theme', async () => {
  const host = await withBoards(['a']);
  const r = await tools.handle('design_render', { theme: 'blue' }, ctxOf(host));
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r), 'theme deve ser light, dark ou both');
});

test('design_render skips images over 3.5 MB and over the 10 MB total', async () => {
  const host = await withBoards(['a', 'b', 'c']);
  const big = path.join(tmp, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024)); // 3 MB each: 3 fit in 10 MB, the 4th does not
  const huge = path.join(tmp, 'huge.png');
  fs.writeFileSync(huge, Buffer.alloc(4 * 1024 * 1024));
  const open = host.openCanvas;
  host.openCanvas = async (...a) => {
    const V = await open(...a);
    const r = V.engine.render;
    V.engine.render = async function render(names) {
      const m = await r.call(this, names);
      for (const [n, s] of m) if (s) { s.light = n === 'a' ? huge : big; s.dark = big; }
      return m;
    };
    return V;
  };
  const r = await tools.handle('design_render', {}, ctxOf(host));
  assert.strictEqual(r.content.filter((c) => c.type === 'image').length, 3);
  assert.match(textOf(r), /a \(claro\): imagem omitida/);
  assert.match(textOf(r), /imagem omitida/);
});

test('without cwd, design_open needs an explicit canvas', async () => {
  const host = fakeHost();
  const r = await tools.handle('design_open', { name: 'z' }, ctxOf(host, { cwd: undefined }));
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /passe `canvas`/);
  const rel = await tools.handle('design_open', { canvas: 'rel/dir' }, ctxOf(host, { cwd: undefined }));
  assert.match(textOf(rel), /passe `canvas`/);
  assert.strictEqual(host.calls.length, 0);
});

test('a board registered moments ago renders and focuses right away', async () => {
  const host = await withBoards([]);
  await tools.handle('design_board', { name: 'fresh', w: 390 }, ctxOf(host));
  const r = await tools.handle('design_render', { boards: ['fresh'] }, ctxOf(host));
  assert.strictEqual(r.content.filter((c) => c.type === 'image').length, 2);
  await tools.handle('design_board', { name: 'fresh2', w: 390 }, ctxOf(host));
  const f = await tools.handle('design_focus', { board: 'fresh2' }, ctxOf(host));
  assert.ok(!f.isError, textOf(f));
});
