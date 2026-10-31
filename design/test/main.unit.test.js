'use strict';
// main.js in-process, with the protocol and the engine faked (no processes).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-main-unit-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the protocol: requests answered by `answer`, never stdin/stdout
let answer = async () => ({ open: true });
const mxPath = require.resolve('../maestria');
require.cache[mxPath] = {
  id: mxPath, filename: mxPath, loaded: true,
  exports: {
    request: (m, p) => answer(m, p),
    notify: () => {}, log: () => {}, onRequest: () => {}, onNotification: () => {}, start: () => {},
  },
};

const engineMod = require('../lib/engine');
const engines = [];
engineMod.open = async (dir) => {
  await sleep(30);
  const e = new EventEmitter();
  Object.assign(e, {
    dir, closed: false, chromeError: null, chrome: null, tw: null,
    canvas: { title: 't', boards: {}, order: [], warnings: [] },
    renderable: () => [],
    close: async () => { e.closed = true; },
  });
  engines.push(e);
  return e;
};

const main = require('../main');

main.state.caps = { rfw: true, picture: 1, zoomFocus: 1 };
main.state.dataDir = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a view.open that fails leaves no view and closes its engine', async () => {
  const dir = path.join(tmp, 'a');
  answer = async (m) => { if (m === 'view.open') throw new Error('sem janela'); return { open: true }; };
  const before = engines.length;
  try {
    await assert.rejects(main.openCanvas(dir, {}), /sem janela/);
    assert.strictEqual(main.viewOf(dir), null);
    await sleep(100);
    assert.strictEqual(engines.length, before + 1);
    assert.strictEqual(engines[before].closed, true, 'engine closed');
  } finally {
    answer = async () => ({ open: true });
  }
});

test('reopening a canvas whose chrome gave up replaces its engine', async () => {
  const dir = path.join(tmp, 'b');
  const V = await main.openCanvas(dir, {});
  const first = V.engine;
  assert.ok(first);
  first.chromeError = 'o chrome não subiu: caiu duas vezes';
  const again = await main.openCanvas(dir, {});
  assert.strictEqual(again, V);
  assert.strictEqual(first.closed, true, 'old engine closed');
  assert.ok(V.engine && V.engine !== first, 'new engine');
  assert.strictEqual(V.engine.chromeError, null);
  // a healthy engine is reused
  const second = V.engine;
  await main.openCanvas(dir, {});
  assert.strictEqual(V.engine, second);
  await main.closeView(V.viewId);
});
