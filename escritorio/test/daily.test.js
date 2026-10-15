// node --test escritorio/test/*.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const daily = require('../daily');

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('o período vai da daily anterior até agora, pulando o fim de semana', () => {
  const opts = { time: '14:00' };
  // Quarta 13:50: desde terça 14h.
  assert.strictEqual(daily.periodOf(at(2026, 10, 14, 13, 50), opts).from, at(2026, 10, 13, 14));
  // Quarta 15:00 (a daily acabou de passar): ainda é a de hoje, desde terça.
  assert.strictEqual(daily.periodOf(at(2026, 10, 14, 15), opts).from, at(2026, 10, 13, 14));
  // Quarta 18:00 (o fim do expediente): já é pra de quinta, desde hoje 14h.
  assert.strictEqual(daily.periodOf(at(2026, 10, 14, 18), opts).from, at(2026, 10, 14, 14));
  // Segunda 13:50: desde sexta.
  assert.strictEqual(daily.periodOf(at(2026, 10, 12, 13, 50), opts).from, at(2026, 10, 9, 14));
  // Com o fim de semana valendo: desde domingo.
  assert.strictEqual(daily.periodOf(at(2026, 10, 12, 13, 50), { ...opts, weekends: true }).from, at(2026, 10, 11, 14));
  // Sem horário: o dia de hoje.
  const p = daily.periodOf(at(2026, 10, 14, 18), {});
  assert.strictEqual(p.from, at(2026, 10, 14, 0));
  assert.strictEqual(p.label, 'hoje');
  assert.deepStrictEqual(daily.parseTime('9h30'), { h: 9, m: 30 });
  assert.strictEqual(daily.parseTime('25:00'), null);
});

test('a conversa vira um resumo curto: pedidos, arquivos, comandos e o fim de cada turno', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-'));
  const proj = path.join(dir, '-repo');
  fs.mkdirSync(proj);
  const ts = (h, m) => new Date(2026, 9, 14, h, m).toISOString();
  const lines = [
    { type: 'user', timestamp: ts(9, 0), cwd: '/repo', gitBranch: 'feature/TASK#7', message: { content: 'velho, de antes' } },
    { type: 'user', timestamp: ts(15, 0), cwd: '/repo', gitBranch: 'feature/TASK#7', message: { content: 'conserta o login' } },
    { type: 'assistant', timestamp: ts(15, 1), message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/lib/auth.dart' } }] } },
    { type: 'assistant', timestamp: ts(15, 2), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "fix login"' } }] } },
    { type: 'user', timestamp: ts(15, 2), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', timestamp: ts(15, 3), message: { content: [{ type: 'text', text: 'Pronto: o token expirava antes da hora.' }] } },
  ];
  fs.writeFileSync(path.join(proj, 'abc.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  // Mexido no fim do período (o filtro rápido é pela data do arquivo).
  const touched = new Date(2026, 9, 14, 15, 3);
  fs.utimesSync(path.join(proj, 'abc.jsonl'), touched, touched);
  const convs = await daily.conversations({ from: at(2026, 10, 14, 14), to: at(2026, 10, 14, 18) }, { root: dir });
  assert.strictEqual(convs.length, 1);
  const c = convs[0];
  assert.strictEqual(c.sessionId, 'abc');
  assert.strictEqual(c.branch, 'feature/TASK#7');
  assert.ok(!c.digest.includes('velho'), 'fora do período fica de fora');
  assert.match(c.digest, /conserta o login/);
  assert.match(c.digest, /auth\.dart/);
  assert.match(c.digest, /git commit/);
  assert.match(c.digest, /token expirava/);
  // A pasta da própria daily é pulada.
  assert.strictEqual((await daily.conversations({ from: 0, to: Infinity }, { root: dir, skip: ['-repo'] })).length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('o resumo é lido mesmo com cercas e texto em volta, e fica guardado', () => {
  const s = daily.parseSummary('aqui:\n```json\n{"items":[{"sessao":"abc","nome":"TASK#7 login","fiz":"consertei","pendente":"","curioso":"o token"}],"resolvido":[],"daily":"- consertei o login"}\n```');
  assert.strictEqual(s.items[0].nome, 'TASK#7 login');
  assert.strictEqual(s.daily, '- consertei o login');
  assert.throws(() => daily.parseSummary('não sei'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-'));
  daily.save(dir, { at: at(2026, 10, 13, 14), ...s });
  daily.save(dir, { at: at(2026, 10, 14, 14), ...s, daily: 'hoje' });
  assert.strictEqual(daily.latest(dir).daily, 'hoje');
  assert.strictEqual(daily.latest(dir, at(2026, 10, 14, 0)).at, at(2026, 10, 13, 14));
  assert.deepStrictEqual(daily.list(dir).map((x) => x.at), [at(2026, 10, 14, 14), at(2026, 10, 13, 14)], 'o "ver outra daily": as mais novas primeiro');
  assert.strictEqual(daily.when(at(2026, 10, 13, 14), at(2026, 10, 14, 15), { full: true }), 'terça 13/10 14:00');
  assert.strictEqual(daily.when(at(2026, 10, 14, 9, 5), at(2026, 10, 14, 15), { full: true }), 'hoje 09:05');
  fs.rmSync(dir, { recursive: true });
});

test('o pedido leva as conversas, o pendente da anterior e o jeito do texto', () => {
  const p = daily.promptOf({
    period: { label: 'desde terça 14:00' },
    convs: [{ sessionId: 'abc', cwd: '/repo', branch: 'x', digest: 'pedidos: ...' }],
    previous: { items: [{ nome: 'TASK#7', pendente: 'testar no iOS' }] },
    style: 'em inglês',
  });
  assert.match(p, /desde terça 14:00/);
  assert.match(p, /### conversa abc/);
  assert.match(p, /\[TASK#7\] testar no iOS/);
  assert.match(p, /em inglês/);
  assert.match(p, /"curioso"/);
});
