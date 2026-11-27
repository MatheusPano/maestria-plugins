'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reader, compact } = require('../lib/usage');

const line = (id, at, usage, extra = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, usage }, ...extra }) + '\n';

test('sums what the last hour processed, counts a message once and reads the context from the last one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const file = path.join(dir, 's.jsonl');
  const now = Date.parse('2026-11-27T12:00:00Z');
  const at = (min) => now - min * 60000;
  fs.writeFileSync(
    file,
    line('old', at(90), { input_tokens: 1, cache_read_input_tokens: 5000, output_tokens: 10 }) +
      line('a', at(30), { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 5 }) +
      line('a', at(30), { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 50 }) +
      line('side', at(20), { input_tokens: 9999 }, { isSidechain: true }) +
      line('b', at(5), { input_tokens: 3, cache_creation_input_tokens: 200, cache_read_input_tokens: 2000, output_tokens: 20 }),
  );
  const read = reader(() => file, () => now);
  assert.deepEqual(read('s', '/x'), { perHour: 1052 + 2223, context: 2203 });
  fs.appendFileSync(file, line('c', at(1), { input_tokens: 1, cache_read_input_tokens: 4000, output_tokens: 7 }) + '{"type":"assistant","mess');
  assert.deepEqual(read('s', '/x'), { perHour: 1052 + 2223 + 4008, context: 4001 });
  assert.equal(reader(() => null)('s', '/x'), null);
});

test('compact writes 1.2M, 340k and 900', () => {
  assert.deepEqual([compact(1234567), compact(340400), compact(900), compact(2000000)], ['1.2M', '340k', '900', '2M']);
});

test('the read offset follows bytes, also with multibyte text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const file = path.join(dir, 'm.jsonl');
  const now = Date.parse('2026-11-27T12:00:00Z');
  fs.writeFileSync(file, line('a', now - 60000, { input_tokens: 1, output_tokens: 1 }, { note: 'ação não é ✓' }));
  const read = reader(() => file, () => now);
  assert.equal(read('s', '/x').perHour, 2);
  fs.appendFileSync(file, line('b', now - 1000, { input_tokens: 5, output_tokens: 5 }));
  assert.equal(read('s', '/x').perHour, 12);
});
