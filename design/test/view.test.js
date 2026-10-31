'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const view = require('../lib/view');

const HASH = 'abc123def456';
const canvas = {
  title: 'toasts',
  boards: { a: { x: 0, y: 0, w: 1280 }, b: { x: 1360, y: 0, w: 400, title: 'Toast pequeno' } },
  order: ['a', 'b'],
  warnings: [],
};
const st = (name, w, h, extra = {}) => ({
  light: `/data/${HASH}/png/${name}.light.png`, dark: `/data/${HASH}/png/${name}.dark.png`, width: w, height: h, cut: false, rev: 3, ...extra,
});
const states = new Map([['a', st('a', 1280, 200)], ['b', st('b', 400, 100)]]);
const ui = (o = {}) => ({ theme: 'both', follow: true, highlight: null, command: null, rev: 0, ...o });
const CAPS = { picture: 1, zoomFocus: 1 };
const build = (o = {}) => view.build({ canvas, states, ui: ui(o.ui), caps: o.caps || CAPS, hash: HASH, ...o.extra });

function noNull(v, where = 'data') {
  assert.ok(v !== null && v !== undefined, `${where} is ${v}`);
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `${where} is ${v}`);
  if (Array.isArray(v)) v.forEach((x, i) => noNull(x, `${where}.${i}`));
  else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) noNull(x, `${where}.${k}`);
}

test('theme both: box = 2w + 24, laid out without overlap', () => {
  const d = build();
  const [a, b] = d.boards;
  assert.strictEqual(a.name, 'a');
  assert.strictEqual(a.width, 2584);
  assert.strictEqual(b.width, 824);
  assert.strictEqual(b.left, a.left + 2584 + 80);
  assert.strictEqual(a.left, 80);
  assert.strictEqual(a.top, 80);
  assert.strictEqual(a.height, 28 + 200);
  assert.deepStrictEqual(d.size, { w: 80 + 2584 + 80 + 824 + 80, h: 80 + 228 + 80 });
  assert.strictEqual(a.light, `${HASH}/png/a.light.png`);
  assert.strictEqual(a.dark, `${HASH}/png/a.dark.png`);
  assert.strictEqual(d.title, 'toasts');
  assert.strictEqual(d.theme, 'both');
  assert.strictEqual(d.picture, true);
  assert.deepStrictEqual(d.list, [{ name: 'a', title: 'a' }, { name: 'b', title: 'Toast pequeno' }]);
  noNull(d);
});

test('theme light / dark: box = w, only that image', () => {
  const l = build({ ui: { theme: 'light' } });
  assert.deepStrictEqual(l.boards.map((b) => b.width), [1280, 400]);
  assert.strictEqual(l.boards[1].left, l.boards[0].left + 1360);
  assert.strictEqual(l.boards[0].light, `${HASH}/png/a.light.png`);
  assert.strictEqual(l.boards[0].dark, '');
  const d = build({ ui: { theme: 'dark' } });
  assert.deepStrictEqual(d.boards.map((b) => b.width), [1280, 400]);
  assert.strictEqual(d.boards[0].light, '');
  assert.strictEqual(d.boards[0].dark, `${HASH}/png/a.dark.png`);
});

test('a board with an error keeps its last images and shows the error', () => {
  const s = new Map(states);
  s.set('b', st('b', 400, 100, { error: 'marcação inválida: <div> sem fechar' }));
  const d = view.build({ canvas, states: s, ui: ui(), caps: CAPS, hash: HASH });
  const b = d.boards[1];
  assert.strictEqual(b.error, 'marcação inválida: <div> sem fechar');
  assert.strictEqual(b.light, `${HASH}/png/b.light.png`);
  assert.strictEqual(b.dark, `${HASH}/png/b.dark.png`);
  assert.strictEqual(d.boards[0].error, '');
  noNull(d);
});

test('a board not rendered yet has no images and a placeholder height', () => {
  const d = view.build({ canvas, states: new Map(), ui: ui(), caps: CAPS, hash: HASH });
  assert.strictEqual(d.boards[0].light, '');
  assert.strictEqual(d.boards[0].dark, '');
  assert.ok(d.boards[0].imageHeight > 0);
  noNull(d);
});

test('states may be a plain object', () => {
  const d = view.build({ canvas, states: Object.fromEntries(states), ui: ui(), caps: CAPS, hash: HASH });
  assert.strictEqual(d.boards[0].imageHeight, 200);
});

test('focus command: rect as fractions of the canvas, within 0..1', () => {
  const d = build({ ui: { command: { kind: 'focus', board: 'b' }, rev: 4 } });
  assert.strictEqual(d.zoom.command, 'focus');
  assert.strictEqual(d.zoom.rev, 4);
  const f = d.zoom.focus;
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(f[k] >= 0 && f[k] <= 1, `${k}=${f[k]}`);
  const b = d.boards[1];
  assert.ok(Math.abs(f.x * d.size.w - b.left) < 1e-6);
  assert.ok(Math.abs(f.w * d.size.w - b.width) < 1e-6);
  assert.ok(Math.abs(f.y * d.size.h - b.top) < 1e-6);
  assert.ok(Math.abs(f.h * d.size.h - b.height) < 1e-6);
  noNull(d);
});

test('focus with an explicit rect (canvas coords) and in/out/fit pass through', () => {
  const d = build({ ui: { command: { kind: 'focus', rect: { x: 80, y: 80, w: 100, h: 50 } }, rev: 1 } });
  assert.ok(Math.abs(d.zoom.focus.x * d.size.w - 80) < 1e-6);
  for (const kind of ['in', 'out', 'fit']) {
    assert.strictEqual(build({ ui: { command: { kind }, rev: 2 } }).zoom.command, kind);
  }
  assert.strictEqual(build().zoom.command, '');
});

test('without zoomFocus the focus command falls back to fit', () => {
  const d = build({ caps: { picture: 1 }, ui: { command: { kind: 'focus', board: 'a' }, rev: 2 } });
  assert.strictEqual(d.zoom.command, 'fit');
  assert.strictEqual(d.zoom.rev, 2);
});

test('without picture: sprite sheets copied into the plugin cache, per rev', () => {
  const d = build({ caps: { zoomFocus: 1 } });
  assert.strictEqual(d.picture, false);
  assert.strictEqual(d.boards[0].light, `cache/${HASH}/a.light.3.png`);
  assert.strictEqual(d.boards[0].dark, `cache/${HASH}/a.dark.3.png`);
  noNull(d);
});

test('highlight flags only the named board; zoom label from the scale', () => {
  const d = build({ ui: { highlight: 'b', scale: 1.5 } });
  assert.deepStrictEqual(d.boards.map((b) => b.highlight), [false, true]);
  assert.strictEqual(d.zoomLabel, '150%');
  assert.strictEqual(build().zoomLabel, '100%');
});

test('board focus action and list menu use focus:<name>', () => {
  const d = build();
  assert.strictEqual(d.boards[0].focus, 'focus:a');
  assert.deepStrictEqual(d.listMenu.map((m) => m.action), ['focus:a', 'focus:b']);
});

test('empty canvas still has a size and no nulls', () => {
  const d = view.build({ canvas: { title: 'x', boards: {}, order: [], warnings: [] }, states: new Map(), ui: ui(), caps: CAPS, hash: HASH });
  assert.deepStrictEqual(d.boards, []);
  assert.ok(d.size.w > 0 && d.size.h > 0);
  noNull(d);
});

test('cacheSprites copies the current pngs and deletes older revs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-view-'));
  try {
    const pluginDir = path.join(tmp, 'plugin');
    const png = path.join(tmp, 'data', 'png');
    fs.mkdirSync(png, { recursive: true });
    fs.writeFileSync(path.join(png, 'a.light.png'), 'L');
    fs.writeFileSync(path.join(png, 'a.dark.png'), 'D');
    const s = new Map([['a', { light: path.join(png, 'a.light.png'), dark: path.join(png, 'a.dark.png'), width: 10, height: 10, rev: 2 }]]);
    const cache = path.join(pluginDir, 'cache', HASH);
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'a.light.1.png'), 'old');
    fs.writeFileSync(path.join(cache, 'gone.light.1.png'), 'old');
    view.cacheSprites({ pluginDir, hash: HASH, states: s });
    assert.deepStrictEqual(fs.readdirSync(cache).sort(), ['a.dark.2.png', 'a.light.2.png']);
    assert.strictEqual(fs.readFileSync(path.join(cache, 'a.light.2.png'), 'utf8'), 'L');
    view.clearSprites({ pluginDir, hash: HASH });
    assert.strictEqual(fs.existsSync(cache), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('manifest: id, main, activation events, commands', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'maestria-plugin.json'), 'utf8'));
  assert.strictEqual(m.id, 'maestria.design');
  assert.strictEqual(m.name, 'Design');
  assert.strictEqual(m.maestria, 1);
  assert.deepStrictEqual(m.main, ['node', 'main.js']);
  assert.deepStrictEqual(m.activationEvents, ['onCommand:abrir', 'onCommand:ajustar', 'onTool:design_open', 'onTool:design_board', 'onTool:design_render', 'onTool:design_focus', 'onTool:design_list']);
  assert.deepStrictEqual(m.contributes.commands, [{ id: 'abrir', title: 'design: abrir' }, { id: 'ajustar', title: 'design: ajustar' }]);
  assert.ok(fs.existsSync(path.join(__dirname, '..', m.icon)));
});

test('wire: whole numbers become doubles for rfw (json has no 16.0); text and flags untouched', () => {
  const w = view.wire({ a: 80, b: 0, c: 1, d: 2.5, e: 'x', f: true, g: [{ h: 1280 }], zoom: { rev: 3 } });
  for (const v of [w.a, w.b, w.c, w.g[0].h]) assert.ok(!Number.isInteger(v), `${v} is still an int`);
  assert.ok(Math.abs(w.a - 80) < 1e-6 && Math.abs(w.b) < 1e-6 && w.c <= 1 && Math.abs(w.c - 1) < 1e-6);
  assert.strictEqual(w.d, 2.5);
  assert.strictEqual(w.e, 'x');
  assert.strictEqual(w.f, true);
  assert.strictEqual(w.zoom.rev, 3); // commandRev reads ints
  const text = JSON.stringify(view.wire(build({ ui: { command: { kind: 'focus', board: 'a' }, rev: 1 } }))).replace(/"rev":\d+/g, '');
  assert.ok(!/[:[,]-?\d+[,}\]]/.test(text), `an int slipped through: ${text}`);
});
