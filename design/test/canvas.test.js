'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const canvas = require('../lib/canvas');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-')); }

test('round-trip keeps unknown keys', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify({
    v: 1, title: 't', boards: { a: { x: 0, y: 0, w: 10, extra: 1 } }, order: ['a'], future: { k: 1 },
  }));
  const c = canvas.read(dir);
  assert.deepStrictEqual(c.warnings, []);
  canvas.write(dir, c);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'canvas.json'), 'utf8'));
  assert.deepStrictEqual(raw.future, { k: 1 });
  assert.strictEqual(raw.boards.a.extra, 1);
  assert.ok(!('warnings' in raw));
  assert.deepStrictEqual(fs.readdirSync(dir), ['canvas.json']);
});

test('read drops boards with bad names and warns', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify({
    v: 1, title: 't', boards: { ok: { x: 0, y: 0, w: 1 }, '../x': { x: 0, y: 0, w: 1 } }, order: ['ok', '../x'],
  }));
  const c = canvas.read(dir);
  assert.deepStrictEqual(Object.keys(c.boards), ['ok']);
  assert.deepStrictEqual(c.order, ['ok']);
  assert.strictEqual(c.warnings.length, 1);
});

test('upsertBoard places boards in a row and wraps wide ones', () => {
  let c = { v: 1, title: 't', boards: {}, order: [] };
  for (const n of ['a', 'b', 'c']) c = canvas.upsertBoard(c, { name: n, w: 400 }).canvas;
  assert.deepStrictEqual(['a', 'b', 'c'].map((n) => [c.boards[n].x, c.boards[n].y]), [[0, 0], [480, 0], [960, 0]]);
  const r = canvas.upsertBoard(c, { name: 'wide', w: 5000 });
  assert.strictEqual(r.board.x, 0);
  assert.ok(r.board.y > 0);
  assert.deepStrictEqual(r.canvas.order, ['a', 'b', 'c', 'wide']);
  const again = canvas.upsertBoard(r.canvas, { name: 'a', w: 300, x: 5, y: 6, title: 'T' });
  assert.deepStrictEqual(again.board, { x: 5, y: 6, w: 300, title: 'T' });
  assert.strictEqual(again.canvas.order.filter((n) => n === 'a').length, 1);
});

test('upsertBoard rejects bad names', () => {
  const c = { v: 1, title: 't', boards: {}, order: [] };
  for (const name of ['../x', 'A B', '/etc', '', '-a']) {
    assert.throws(() => canvas.upsertBoard(c, { name, w: 10 }), /nome/);
  }
});

test('resolveDir', () => {
  const home = tmp();
  assert.throws(() => canvas.resolveDir('/', { cwd: home, home }));
  assert.throws(() => canvas.resolveDir('~', { cwd: home, home }));
  assert.throws(() => canvas.resolveDir('/etc/x', { cwd: home, home }));
  assert.throws(() => canvas.resolveDir(home, { cwd: home, home }));
  assert.throws(() => canvas.resolveDir('../..', { cwd: path.join(home, 'a'), home }));
  assert.strictEqual(canvas.resolveDir('d/x', { cwd: home, home }), path.join(home, 'd', 'x'));
  assert.strictEqual(canvas.resolveDir(path.join(home, 'q'), { cwd: '/', home }), path.join(home, 'q'));
});

test('defaultDir', () => {
  const home = '/h/u';
  assert.strictEqual(canvas.defaultDir({ cwd: '/h/u/Desktop/Work/sac', name: 'n', home }), '/h/u/Desktop/Work/design/n');
  assert.strictEqual(canvas.defaultDir({ cwd: '/h/u/proj', name: 'n', home }), null);
});

function fakeRepo(config) {
  const repo = tmp();
  const bins = path.join(repo, 'node_modules', '.bin');
  fs.mkdirSync(bins, { recursive: true });
  fs.writeFileSync(path.join(bins, 'tailwindcss'), '');
  if (config != null) fs.writeFileSync(path.join(repo, 'tailwind.config.js'), config);
  return repo;
}

test('init creates the folder and design.json', () => {
  const repo = fakeRepo("module.exports = { darkMode: 'class' }");
  const dir = path.join(tmp(), 'my-canvas');
  assert.deepStrictEqual(canvas.init(dir, { repo }), { created: true });
  assert.ok(fs.statSync(path.join(dir, 'boards')).isDirectory());
  assert.ok(fs.statSync(path.join(dir, 'components')).isDirectory());
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'canvas.json'), 'utf8')).title, 'my-canvas');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8')),
    { repo, darkMode: { class: 'dark' }, css: [], brand: null, head: '' });
  assert.deepStrictEqual(canvas.init(dir, { repo }), { created: false });
});

test('init reads darkMode textually', () => {
  const cases = [
    ["export default { darkMode: ['class', '[data-theme=\"dark\"]'] }", { attr: 'data-theme', value: 'dark' }],
    ["module.exports = { darkMode: \"selector\" }", { class: 'dark' }],
    ["module.exports = { content: [] }", { class: 'dark' }],
    [null, { class: 'dark' }],
  ];
  for (const [cfg, want] of cases) {
    const dir = path.join(tmp(), 'c');
    canvas.init(dir, { repo: fakeRepo(cfg) });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8')).darkMode, want);
  }
});

test('init leaves no folder behind when the repo has no tailwind', () => {
  const repo = tmp(); // no node_modules/.bin/tailwindcss
  const dir = path.join(tmp(), 'half');
  assert.throws(() => canvas.init(dir, { repo }), /o projeto não tem tailwind/);
  assert.ok(!fs.existsSync(dir), 'nothing created');
});

test('init lists the stylesheets that define the css variables the config reads', () => {
  const repo = fakeRepo("const { colors } = require('./theme/colors');\nmodule.exports = { theme: { colors: { n: { 1: 'rgb(var(--slate-1) / <alpha-value>)' }, ...colors } } };");
  fs.mkdirSync(path.join(repo, 'theme'));
  fs.writeFileSync(path.join(repo, 'theme', 'colors.js'), "module.exports = { colors: { a: 'rgb(var(--a-1))' } };\n");
  const scss = path.join(repo, 'app', 'styles');
  fs.mkdirSync(scss, { recursive: true });
  fs.writeFileSync(path.join(scss, '_colors.scss'), ':root { --slate-1: 1 2 3; --a-1: 4 5 6; }\n.dark { --slate-1: 9 9 9; }\n');
  fs.writeFileSync(path.join(scss, 'other.scss'), '.x { color: red; --unrelated: 1; }\n');
  fs.mkdirSync(path.join(repo, 'app', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'app', 'node_modules', 'pkg', 'v.css'), ':root { --slate-1: 0; --a-1: 0; }\n');
  const dir = path.join(tmp(), 'vars');
  canvas.init(dir, { repo });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8')).css, ['app/styles/_colors.scss']);
});

const SAC = '/home/arthur/Desktop/Work/Ninepay/customer-service-design-bench';
test('init on the SAC finds _next-colors.scss', { skip: !fs.existsSync(path.join(SAC, 'node_modules', '.bin', 'tailwindcss')) && 'no SAC checkout' }, () => {
  const dir = path.join(tmp(), 'sac');
  canvas.init(dir, { repo: SAC });
  const { css } = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8'));
  assert.ok(css.includes('app/javascript/dashboard/assets/scss/_next-colors.scss'), JSON.stringify(css));
});

test('defaultDir rejects unsafe names', () => {
  for (const name of ['../x', '../../x', 'a/b', '/abs', '']) {
    assert.throws(() => canvas.defaultDir({ cwd: '/h/u/Desktop/Work/sac', name, home: '/h/u' }), /nome de canvas inválido/);
  }
});

test('read drops malformed boards and rejects bad files', () => {
  const dir = tmp();
  const f = path.join(dir, 'canvas.json');
  fs.writeFileSync(f, JSON.stringify({
    v: 1, title: 't', order: ['n', 'nan', 'ok'],
    boards: { n: null, nan: { x: 'a', y: 0, w: 1 }, s: 5, ok: { x: 0, y: 0, w: 1, h: 2 } },
  }));
  const c = canvas.read(dir);
  assert.deepStrictEqual(Object.keys(c.boards), ['ok']);
  assert.deepStrictEqual(c.order, ['ok']);
  assert.strictEqual(c.warnings.length, 3);
  assert.doesNotThrow(() => canvas.upsertBoard(c, { name: 'z', w: 10 }));
  for (const bad of ['{nope', '[]', 'null', '5']) {
    fs.writeFileSync(f, bad);
    assert.throws(() => canvas.read(dir), (e) => e.message.includes(f) && !(e instanceof SyntaxError));
  }
});

test('prototype names are not boards', () => {
  const c = { v: 1, title: 't', boards: { a: { x: 0, y: 0, w: 100 } }, order: ['a'] };
  const r = canvas.upsertBoard(c, { name: 'constructor', w: 50 });
  assert.deepStrictEqual([r.board.x, r.board.y], [180, 0]);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify({ ...c, order: ['a', 'toString'] }));
  assert.deepStrictEqual(canvas.read(dir).order, ['a']);
});
