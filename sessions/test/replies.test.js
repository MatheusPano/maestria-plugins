'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { replies, slug } = require('../lib/replies');

const line = (o) => JSON.stringify(o);
const said = (id, at, text, extra = {}) => line({ type: 'assistant', timestamp: at, message: { id, content: [{ type: 'text', text }] }, ...extra });

function home(dir, sessionId, lines) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'replies-'));
  fs.mkdirSync(path.join(h, '.claude', 'projects', dir), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'projects', dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
  return h;
}

test('a resposta é a última mensagem do assistente, inteira, fora de subagente', () => {
  const h = home(slug('/var/www/a.b'), 's1', [
    line({ type: 'user', timestamp: '2026-11-09T10:00:00Z', message: { content: 'oi' } }),
    said('m1', '2026-11-09T10:00:05Z', 'pensando'),
    line({ type: 'assistant', timestamp: '2026-11-09T10:00:06Z', message: { id: 'm1', content: [{ type: 'tool_use' }] } }),
    line({ type: 'user', timestamp: '2026-11-09T10:00:07Z', message: { content: [{ type: 'tool_result' }] } }),
    said('m2', '2026-11-09T10:00:09Z', 'Primeira parte.'),
    said('m2', '2026-11-09T10:00:10Z', 'Segunda parte, longa.'),
    said('x', '2026-11-09T10:00:11Z', 'do subagente', { isSidechain: true }),
    line({ type: 'system', timestamp: '2026-11-09T10:00:12Z' }),
  ]);
  const r = replies(h)('s1', '/var/www/a.b');
  assert.deepEqual(r, { text: 'Primeira parte.\nSegunda parte, longa.', at: Date.parse('2026-11-09T10:00:10Z') });
});

test('acha o transcript fora da pasta da aba e devolve null sem sessão ou sem texto', () => {
  const h = home('-outra-pasta', 's2', [said('m', '2026-11-09T10:00:00Z', 'ok')]);
  const read = replies(h);
  assert.equal(read('s2', '/mudou/de/pasta').text, 'ok');
  assert.equal(read(null, '/x'), null);
  assert.equal(read('nenhuma', '/x'), null);
});

test('mensagem sem id ainda junta as partes, e um transcript que aparece depois é achado', () => {
  const h = home('-p', 's3', [
    line({ type: 'user', timestamp: '2026-11-09T10:00:00Z', message: { content: 'oi' } }),
    line({ type: 'assistant', timestamp: '2026-11-09T10:00:01Z', message: { content: [{ type: 'text', text: 'a' }] } }),
    line({ type: 'assistant', timestamp: '2026-11-09T10:00:02Z', message: { content: [{ type: 'text', text: 'b' }] } }),
  ]);
  const read = replies(h);
  assert.equal(read('s3', '/x').text, 'a\nb');
  const now = Date.now;
  try {
    assert.equal(read('s4', '/x'), null);
    fs.writeFileSync(path.join(h, '.claude', 'projects', '-p', 's4.jsonl'), said('m', '2026-11-09T10:00:00Z', 'novo') + '\n');
    assert.equal(read('s4', '/x'), null);
    Date.now = () => now() + 31000;
    assert.equal(read('s4', '/x').text, 'novo');
  } finally {
    Date.now = now;
  }
});
