'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../lib/format');

test('uptime', () => {
  assert.equal(f.uptime(90061), '1d 1h');
  assert.equal(f.uptime(3720), '1h 2m');
  assert.equal(f.uptime(0), null);
  assert.equal(f.uptime(null), null);
});

test('gib', () => {
  assert.equal(f.gib(4096), '4 GB');
  assert.equal(f.gib(1536), '1,5 GB');
  assert.equal(f.gib(null), null);
});

test('bytes', () => {
  assert.equal(f.bytes(1536), '1,5 KB');
  assert.equal(f.bytes(150 * 1024 ** 3), '150 GB');
  assert.equal(f.bytes(10), '10 B');
  assert.equal(f.bytes(null), '');
});

test('date e datetime', () => {
  assert.equal(f.date(null), '');
  assert.equal(f.date('2026-10-26T12:00:00'), '26/10/2026');
  assert.equal(f.datetime('2026-10-26T17:14:27'), '26/10/2026 17:14:27');
});

test('relative', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.equal(f.relative(null, now), 'nunca');
  assert.equal(f.relative(now - 60000, now), 'agora');
  assert.equal(f.relative(new Date(now - 30 * 60000).toISOString(), now), 'há 30 minutos');
  assert.equal(f.relative(new Date(now - 3 * 3600000).toISOString(), now), 'há 3 horas');
  assert.equal(f.relative(new Date(now - 2 * 86400000).toISOString(), now), 'anteontem');
});

test('meterTone e meterWidth', () => {
  assert.equal(f.meterTone(90), 'red');
  assert.equal(f.meterTone(75), 'yellow');
  assert.equal(f.meterTone(10), 'green');
  assert.equal(f.meterWidth(0), 2);
  assert.equal(f.meterWidth(130), 100);
  assert.equal(f.meterWidth(50), 50);
});

test('tagTone segue o hash da web', () => {
  const tones = ['accent', 'green', 'yellow', 'red', 'dim'];
  const web = (tag) => {
    let hash = 0;
    for (const ch of tag) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return tones[hash % tones.length];
  };
  for (const tag of ['prod', 'dev', 'database', 'a', 'sistema-legado-longo']) assert.equal(f.tagTone(tag), web(tag));
});
