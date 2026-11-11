'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Links } = require('../lib/links');
const { diagnose, sweep, report } = require('../lib/doctor');

const NOW = Date.parse('2026-11-11T12:00:00');
const DAY = 24 * 3600 * 1000;

test('o diagnóstico acha gerente fechado com filhas abertas, fechada sem cartão, cartão parado, conversa sem hooks e arquivos soltos', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-doctor-'));
  fs.mkdirSync(path.join(dataDir, 'proof'));
  fs.writeFileSync(path.join(dataDir, 'proof', 'usada.png'), 'x');
  fs.writeFileSync(path.join(dataDir, 'proof', 'solta.png'), 'x');
  fs.writeFileSync(path.join(dataDir, 'links.json.estragado-1'), '{');
  const l = new Links({}, () => NOW);
  const boss = l.add({ tabId: 'fechado', name: 'tarefas', manager: true });
  l.nodes[boss].sessionId = 's-boss';
  const kid = l.add({ tabId: 'k', parent: boss, name: 'filha' });
  l.nodes[kid].card = { state: 'needs_you', headline: 'merge o PR', at: NOW - 3 * DAY, proof: { images: [{ rel: 'proof/usada.png' }], prs: [], audio: [], log: '' } };
  const empty = l.add({ tabId: 'sumiu', parent: boss, name: 'vazia' });
  const sessions = [{ id: 'k', kind: 'claude', title: 'filha', status: 'idle', sessionId: 's-k' }, { id: 'solta', kind: 'claude', title: 'sem hooks', status: 'unknown' }];
  const found = diagnose(l, sessions, { dataDir, now: NOW });
  assert.deepEqual(found.map((f) => [f.fix, Boolean(f.auto)]), [
    [`resume:${boss}`, false],
    [`dismiss:${kid}`, false],
    [`forget:${empty}`, true],
    ['', false],
    ['sweep:proof', true],
    ['sweep:broken', true],
  ]);
  assert.match(found[0].title, /"tarefas" está fechado e tem 1 sessão aberta/);
  assert.match(found[3].detail, /"sem hooks"/);
  const r = report(found, l, sessions);
  assert.deepEqual([r.summary, r.counts, r.canFixAll, r.fixAllLabel], ['6 coisas para olhar', '3 sessões na árvore, 1 abertas', true, 'arrumar 3 automáticas']);
  assert.equal(sweep('proof', l, dataDir), 1);
  assert.equal(sweep('broken', l, dataDir), 1);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'proof')), ['usada.png']);
  assert.deepEqual(diagnose(l, sessions, { dataDir, now: NOW }).map((f) => f.fix), [`resume:${boss}`, `dismiss:${kid}`, `forget:${empty}`, '']);
});

test('gerente fechado sem sessionId não oferece retomar; árvore em dia diz "Tudo certo."', () => {
  const l = new Links({}, () => NOW);
  const boss = l.add({ tabId: 'fechado', name: 'g', manager: true });
  l.add({ tabId: 'k', parent: boss, name: 'k' });
  const found = diagnose(l, [{ id: 'k', kind: 'claude', title: 'k', status: 'idle', sessionId: 's' }], { now: NOW });
  assert.deepEqual(found.map((f) => f.fix), ['']);
  assert.match(found[0].detail, /não dá pra retomar/);
  const ok = new Links({}, () => NOW);
  ok.add({ tabId: 'g', name: 'g', manager: true });
  const sessions = [{ id: 'g', kind: 'claude', title: 'g', status: 'idle', sessionId: 's' }];
  assert.deepEqual([report(diagnose(ok, sessions, { now: NOW }), ok, sessions).summary], ['Tudo certo.']);
});
