'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cdp = require('../lib/cdp');

test('encode ends with NUL', () => {
  const b = cdp.encode({ id: 1 });
  assert.ok(Buffer.isBuffer(b));
  assert.strictEqual(b[b.length - 1], 0);
  assert.deepStrictEqual(JSON.parse(b.subarray(0, -1).toString()), { id: 1 });
});

test('Decoder reassembles split messages in order', () => {
  const d = new cdp.Decoder();
  const got = [];
  d.on('message', (m) => got.push(m));
  d.push(Buffer.from('{"id":1}\0{"id'));
  d.push(Buffer.from('":2}\0'));
  assert.deepStrictEqual(got, [{ id: 1 }, { id: 2 }]);
});

test('Decoder handles a 3 MB message in 64 KB chunks', () => {
  const d = new cdp.Decoder();
  const got = [];
  d.on('message', (m) => got.push(m));
  const payload = 'x'.repeat(3 * 1024 * 1024);
  const buf = cdp.encode({ id: 7, data: payload });
  const t0 = Date.now();
  for (let o = 0; o < buf.length; o += 65536) d.push(buf.subarray(o, o + 65536));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].data.length, payload.length);
  assert.ok(Date.now() - t0 < 1000);
});
