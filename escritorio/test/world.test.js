// node --test escritorio/test/*.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const office = require('../office');
const { World, describe, bashOutcome, lightAt, PET_ID, YOU_ID } = require('../world');

/** Um mundo com relógio de mentira: `run(ms)` anda o tempo e o relógio do mundo. */
function world(settings = {}) {
  // Meio-dia, pra luz não mudar no meio do teste.
  let now = new Date(2026, 9, 13, 12, 0, 0).getTime();
  const w = new World({ settings, now: () => now, random: () => 0.5 });
  w.watching = true;
  w.run = (ms) => {
    const end = now + ms;
    while (now < end) {
      now += 50;
      w.tick();
      w.sent();
      if (now % 1000 < 50) w.housekeeping();
    }
  };
  return w;
}

const session = (id, folder, status = 'working', extra = {}) => ({
  id,
  kind: 'claude',
  title: id.toUpperCase(),
  cwd: folder,
  folder,
  status,
  ...extra,
});

test('a planta liga toda sala e a sala do descanso à porta da rua', () => {
  const plan = office.layout([
    { id: '/a', name: 'a', agents: 1 },
    { id: '/b', name: 'b', agents: 6 },
    { id: '/c', name: 'c', agents: 2 },
    { id: '/d', name: 'd', agents: 3 },
  ]);
  for (const d of plan.desks) assert.ok(office.path(plan, plan.entrance, d.seat), `sem caminho até ${d.id}`);
  for (const s of plan.spots) assert.ok(office.path(plan, plan.entrance, s), `sem caminho até ${s.x},${s.y}`);
  assert.strictEqual(plan.rooms.find((r) => r.id === '/b').desks.length, 8, 'as mesas vêm de quatro em quatro');
  assert.match(office.svg(plan), /^<svg /);
});

test('os trechos retos juntam os passos na mesma direção', () => {
  const segs = office.segments({ x: 0, y: 0 }, [
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 1 },
  ]);
  assert.deepStrictEqual(
    segs.map((s) => [s.dir, s.tiles]),
    [
      ['right', 2],
      ['down', 1],
    ],
  );
});

test('quem abre entra pela porta, anda até a mesa e senta', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')]);
  const a = w.agents.get('t1');
  assert.deepStrictEqual(a.tile, w.plan.entrance);
  assert.ok(a.walking);
  w.run(20000);
  assert.ok(a.arrived && !a.walking);
  assert.strictEqual(a.goal.kind, 'desk');
  assert.strictEqual(a.anim, 'sit');
});

test('a sessão aberta antes da janela já aparece sentada', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  const a = w.agents.get('t1');
  assert.strictEqual(a.goal.kind, 'desk');
  assert.ok(a.arrived);
});

test('a ferramenta decide a pose, e a permissão faz acenar com balão vermelho', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  const a = w.agents.get('t1');
  w.hook('t1', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/repo/api/lib/x.dart' } });
  w.status('t1', 'tool');
  w.run(100);
  assert.strictEqual(a.anim, 'type');
  let data = w.agentsData()[a.slot];
  assert.strictEqual(data.bubble.text, 'editando x.dart');

  w.hook('t1', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  w.status('t1', 'waitingPermission');
  w.run(100);
  assert.strictEqual(a.anim, 'wave');
  data = w.agentsData()[a.slot];
  assert.strictEqual(data.bubble.text, '! $ rm -rf build');
  assert.strictEqual(data.bubble.bg, 0xffe5534b);
});

test('à toa por um tempo, vai pra sala do descanso; com trabalho, volta pra mesa', () => {
  const w = world({ coffee: 10 });
  w.syncSessions([session('t1', '/repo/api', 'idle')], { snap: true });
  const a = w.agents.get('t1');
  assert.strictEqual(a.goal.kind, 'desk');
  w.run(12000);
  w.run(20000);
  assert.strictEqual(a.goal.kind, 'lounge');
  assert.ok(a.arrived);
  assert.strictEqual(a.anim, 'idle');
  w.hook('t1', 'UserPromptSubmit', { prompt: 'corrige o teste' });
  w.status('t1', 'working');
  // Espera você trazer o pedido ali mesmo, e só depois volta pra mesa.
  assert.strictEqual(a.goal.kind, 'lounge');
  w.run(30000);
  assert.ok(a.arrived);
  assert.strictEqual(a.goal.kind, 'desk');
});

test('o subagente entra, trabalha, conta pra quem chamou e sai', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  w.hook('t1', 'PreToolUse', {
    tool_name: 'Agent',
    tool_use_id: 'tu1',
    tool_input: { description: 'revisar o diff' },
  });
  const helper = [...w.agents.values()].find((x) => x.kind === 'helper');
  assert.ok(helper);
  assert.strictEqual(helper.room, '/repo/api');
  w.run(20000);
  assert.strictEqual(helper.goal.kind, 'desk');
  // As ferramentas dele chegam carimbadas com o agent_id.
  w.hook('t1', 'PreToolUse', { agent_id: 'ag1', tool_name: 'Read', tool_input: { file_path: '/x/y.js' } });
  assert.strictEqual(helper.forkId, 'ag1');
  w.run(100);
  assert.strictEqual(helper.anim, 'read');
  w.hook('t1', 'SubagentStop', { agent_id: 'ag1' });
  assert.ok(helper.reporting);
  w.run(20000);
  assert.ok(!w.agents.has(helper.id), 'saiu pela porta');
});

test('fechar a sessão: o boneco sai pela porta e a sala some', () => {
  const w = world({ office: false, meetings: false });
  w.syncSessions([session('t1', '/repo/api'), session('t2', '/repo/web')], { snap: true });
  assert.strictEqual(w.plan.rooms.length, 3);
  w.closed('t2');
  w.run(30000);
  assert.ok(!w.agents.has('t2'));
  assert.deepStrictEqual(
    w.plan.rooms.map((r) => r.name),
    ['api', 'sala do descanso'],
  );
  // O lugar dele na lista da janela fica vago e é reaproveitado.
  assert.strictEqual(w.agentsData()[1].on, false);
  w.syncSessions([session('t1', '/repo/api'), session('t3', '/repo/api')]);
  assert.strictEqual(w.agents.get('t3').slot, 1);
});

test('as pastas marcadas têm sala sempre; as outras, só com um claude', () => {
  const w = world({ office: false, rooms: ['/repo/web', '/repo/fora'] });
  w.setFolders([
    { root: '/repo/api', name: 'api' },
    { root: '/repo/web', name: 'web' },
    { root: '/repo/docs', name: 'docs' },
  ]);
  w.syncSessions([], { snap: true });
  assert.deepStrictEqual(
    w.plan.rooms.map((r) => r.name),
    ['web', 'sala do descanso'],
    'a marcada que saiu da lateral não tem sala',
  );
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  assert.deepStrictEqual(w.plan.rooms.map((r) => r.name).sort(), ['api', 'sala do descanso', 'web']);
  w.closed('t1');
  w.run(30000);
  assert.deepStrictEqual(w.plan.rooms.map((r) => r.name), ['web', 'sala do descanso']);

  w.settings.rooms = [];
  w.relayout();
  assert.deepStrictEqual(w.plan.rooms.map((r) => r.name), ['sala do descanso']);
});

test('as ferramentas viram pose e texto', () => {
  assert.deepStrictEqual(describe('Read', { file_path: '/a/b/c.ts' }), { anim: 'read', label: 'lendo c.ts' });
  assert.strictEqual(describe('mcp__wiboor__create_task').label, 'wiboor create_task');
  assert.strictEqual(describe('Grep', { pattern: 'x' }).anim, 'read');
});

test('os números que viram tamanho saem com casa decimal', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  const json = JSON.stringify(w.agentsData()[0]);
  const parsed = JSON.parse(json);
  assert.ok(!Number.isInteger(parsed.x) && !Number.isInteger(parsed.y));
  assert.ok(!Number.isInteger(w.scene().w));
});

test('o Bash que terminou vira festa ou drama', () => {
  assert.strictEqual(bashOutcome('git push origin main', true, { stdout: '' }), 'push');
  assert.strictEqual(bashOutcome('git add -A && git commit -m x', true, {}), 'commit');
  assert.strictEqual(bashOutcome('npm test', true, { stdout: 'Tests: 12 passed' }), 'pass');
  assert.strictEqual(bashOutcome('npm test', true, { stdout: 'Tests: 2 failed, 10 passed' }), 'fail');
  assert.strictEqual(bashOutcome('cd app && flutter test', false, 'Some tests failed.'), 'fail');
  assert.strictEqual(bashOutcome('git push', false, 'rejected'), null);
  assert.strictEqual(bashOutcome('ls -la', true, {}), null);
});

test('o push faz pular de braço pra cima; o teste quebrado, mão na cabeça e tela piscando', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  const a = w.agents.get('t1');
  w.hook('t1', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git push' }, tool_response: { stdout: 'ok' } });
  w.run(100);
  assert.strictEqual(a.anim, 'cheer');
  assert.ok(w.effectsData().some((f) => f.on && f.text === '🚀'));
  w.run(4000);
  assert.notStrictEqual(a.anim, 'cheer', 'a festa acaba');

  w.hook('t1', 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'exit 1' });
  w.run(100);
  assert.strictEqual(a.anim, 'facepalm');
  const screen = w.screens()[0];
  assert.ok([0xffe5534b, 0xff2c3140].includes(screen.color));
  // O Esc (interrompido) não conta como teste quebrado.
  w.run(6000);
  w.hook('t1', 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, is_interrupt: true });
  w.run(100);
  assert.notStrictEqual(a.anim, 'facepalm');
});

test('o efeito aparece no lugar e, no envio seguinte, sobe sumindo', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  w.react(w.agents.get('t1'), 'commit');
  let f = w.effectsData().find((x) => x.on);
  assert.strictEqual(f.ms, 0);
  assert.ok(f.opacity > 0.9);
  w.sent();
  w.tick();
  f = w.effectsData().find((x) => x.on);
  assert.ok(f.ms > 0 && f.opacity < 0.1);
  w.run(3000);
  assert.ok(!w.effectsData().some((x) => x.on), 'e some');
});

test('a lista do TodoWrite vai pro quadro branco da sala', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  w.hook('t1', 'PreToolUse', {
    tool_name: 'TodoWrite',
    tool_input: {
      todos: [
        { content: 'ler o código', status: 'completed', activeForm: 'lendo o código' },
        { content: 'corrigir o bug', status: 'in_progress', activeForm: 'corrigindo o bug' },
        { content: 'rodar os testes', status: 'pending', activeForm: 'rodando os testes' },
      ],
    },
  });
  const board = w.boards().find((b) => b.on);
  assert.strictEqual(board.count, '1/3');
  assert.strictEqual(board.current, 'corrigindo o bug');
  assert.match(board.tip, /✓ ler o código/);
  assert.strictEqual(board.action, 'focus:t1');
});

test('o contexto quase cheio cansa; o /compact faz espreguiçar', () => {
  const w = world({ coffee: 1 });
  w.syncSessions([session('t1', '/repo/api', 'idle', { context: { percent: 85 } })], { snap: true });
  const a = w.agents.get('t1');
  w.run(30000);
  assert.strictEqual(a.goal.kind, 'lounge');
  assert.strictEqual(a.anim, 'tired');
  w.context('t1', null);
  w.run(100);
  assert.strictEqual(a.anim, 'stretch');
  w.run(4000);
  assert.strictEqual(a.anim, 'idle');
});

test('a sessão hibernada cochila no sofá', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'idle', { hibernated: true })], { snap: true });
  const a = w.agents.get('t1');
  assert.strictEqual(a.goal.kind, 'sofa');
  assert.strictEqual(a.anim, 'sleep');
  assert.match(w.roster()[0].agents[0].sub, /sofá/);
});

test('você leva o pedido até a mesa e volta pela porta', () => {
  const w = world({ office: false });
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  w.hook('t1', 'UserPromptSubmit', { prompt: 'corrige o login' });
  const you = w.agents.get(YOU_ID);
  assert.ok(you);
  w.run(20000);
  assert.ok(!w.agents.has(YOU_ID), 'entregou e saiu');
  // Com a janela fechada, o pedido só aparece no balão do claude.
  w.watching = false;
  w.hook('t1', 'UserPromptSubmit', { prompt: 'outra coisa' });
  assert.ok(!w.agents.has(YOU_ID));
  assert.strictEqual(w.agents.get('t1').bubble.text, '“outra coisa”');
});

test('você vai até o claude na sala do descanso e entrega o pedido do lado dele', () => {
  const w = world({ office: false, coffee: 10 });
  w.syncSessions([session('t1', '/repo/api', 'idle')], { snap: true });
  const a = w.agents.get('t1');
  w.run(32000);
  assert.strictEqual(a.goal.kind, 'lounge');
  const lounge = { ...a.tile };
  w.hook('t1', 'UserPromptSubmit', { prompt: 'corrige o login' });
  w.status('t1', 'working');
  const you = w.agents.get(YOU_ID);
  let handed = null;
  for (let i = 0; i < 400 && !handed; i++) {
    w.run(50);
    if (you.handed) handed = { you: { ...you.tile }, claude: { ...a.tile } };
  }
  assert.ok(handed, 'entregou');
  assert.deepStrictEqual(handed.claude, lounge, 'o claude esperou na sala do descanso');
  assert.ok(Math.abs(handed.you.x - lounge.x) + Math.abs(handed.you.y - lounge.y) <= 1, 'você entregou do lado dele');
  w.run(30000);
  assert.ok(!w.agents.has(YOU_ID), 'e saiu');
  assert.strictEqual(a.goal.kind, 'desk');
  assert.ok(a.arrived, 'ele voltou pra mesa');
});

test('se o claude ainda está a caminho da mesa, você espera ele chegar pra entregar', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: false });
  const a = w.agents.get('t1');
  assert.ok(!a.arrived);
  w.hook('t1', 'UserPromptSubmit', { prompt: 'corrige o login' });
  const you = w.agents.get(YOU_ID);
  for (let i = 0; i < 600 && !you.handed; i++) {
    w.run(50);
    if (you.handed) assert.ok(a.arrived && !a.walking, 'só entrega com ele sentado');
  }
  assert.ok(you.handed);
});

test('o pedido que espera a entrega só segue quando você chega na mesa, e o hook não leva de novo', () => {
  const w = world({ office: false });
  w.syncSessions([session('t1', '/repo/api', 'idle')], { snap: true });
  const a = w.agents.get('t1');
  let sent = 0;
  assert.strictEqual(w.deliver(a, 'corrige o login', () => sent++), true);
  const you = w.agents.get(YOU_ID);
  w.run(200);
  assert.strictEqual(sent, 0, 'ainda andando');
  for (let i = 0; i < 600 && !you.handed; i++) w.run(50);
  assert.ok(you.handed);
  assert.strictEqual(sent, 1, 'seguiu na entrega');
  w.expectPrompt('t1');
  w.hook('t1', 'UserPromptSubmit', { prompt: 'corrige o login' });
  assert.ok(you.handed, 'não voltou pra entregar de novo');
  w.run(20000);
  assert.ok(!w.agents.has(YOU_ID));
  assert.strictEqual(sent, 1);
});

test('o pedido na mão segue quando outro toma o lugar, e sem ninguém pra levar não segura', () => {
  const w = world({ office: false });
  w.syncSessions([session('t1', '/repo/api', 'idle'), session('t2', '/repo/api', 'idle')], { snap: true });
  const sent = [];
  w.deliver(w.agents.get('t1'), 'um', () => sent.push('um'));
  w.run(200);
  w.deliver(w.agents.get('t2'), 'dois', () => sent.push('dois'));
  assert.deepStrictEqual(sent, ['um']);
  w.watching = false;
  assert.strictEqual(w.deliver(w.agents.get('t1'), 'três', () => sent.push('três')), false);
});

test('o bicho é o gato ou o cachorro, e a escolha da tela vale mais que a das configurações', () => {
  const w = world({ pet: 'cachorro' });
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  assert.strictEqual(w.agents.get(PET_ID).species, 'cachorro');
  assert.match(w.agentsData().find((a) => a.action === 'bicho').sheet, /cachorro/);
  w.petPet();
  assert.strictEqual(w.agents.get(PET_ID).bubble.text, 'au au!');
  w.petPref = 'gato';
  w.ensurePet();
  assert.strictEqual(w.agents.get(PET_ID).species, 'gato');
  w.petPref = 'nenhum';
  w.ensurePet();
  assert.ok(!w.agents.has(PET_ID));
});

test('o gato vive no escritório e vai miar do lado de quem espera você há tempo', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'waitingPermission')], { snap: true });
  const cat = w.agents.get(PET_ID);
  assert.ok(cat);
  assert.strictEqual(w.agentsData()[cat.slot].rows, 6);
  w.status('t1', 'waitingPermission');
  w.agents.get('t1').waitingSince = w.now() - 60000;
  w.run(25000);
  const desk = w.deskOf(w.agents.get('t1'));
  assert.deepStrictEqual(cat.tile, desk.talk);
  assert.ok(w.petPet());
  assert.strictEqual(cat.bubble.text, 'miau');
  // Sem o gato nas configurações, ele vai embora.
  w.settings.pet = 'nenhum';
  w.ensurePet();
  assert.ok(!w.agents.has(PET_ID));
});

test('a planta mudando não teletransporta quem está andando', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  w.syncSessions([session('t1', '/repo/api'), session('t2', '/repo/api')]);
  w.run(400);
  const t2 = w.agents.get('t2');
  assert.ok(t2.walking, 'ainda a caminho');
  // Abre um repositório novo: a planta muda no meio da caminhada.
  w.syncSessions([session('t1', '/repo/api'), session('t2', '/repo/api'), session('t3', '/repo/web')]);
  assert.ok(t2.walking || t2.segs.length, 'segue andando em vez de aparecer na mesa');
  w.run(30000);
  assert.strictEqual(t2.goal.kind, 'desk');
  assert.ok(t2.arrived);
});

test('a luz segue a hora', () => {
  assert.strictEqual(lightAt(new Date(2026, 0, 1, 13)).phase, 'dia');
  assert.strictEqual(lightAt(new Date(2026, 0, 1, 18)).phase, 'fim de tarde');
  assert.ok(lightAt(new Date(2026, 0, 1, 23)).night);
  assert.strictEqual(lightAt(new Date(2026, 0, 1, 6)).phase, 'amanhecer');
});

test('dorme no sofá e, acordando, levanta e volta pra mesa', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'idle')], { snap: true });
  const a = w.agents.get('t1');
  assert.strictEqual(a.goal.kind, 'desk');
  w.status('t1', 'ended', { hibernated: true });
  // Hibernar não é sair pela porta.
  assert.ok(!a.leaving);
  w.run(20000);
  assert.strictEqual(a.goal.kind, 'sofa');
  assert.strictEqual(a.anim, 'sleep');
  assert.match(w.tipOf(a), /acordar/);
  w.status('t1', 'starting', { hibernated: false });
  assert.strictEqual(a.goal.kind, 'desk');
  assert.strictEqual(a.bubble.text, 'bom dia! ☕');
  w.run(20000);
  assert.ok(a.arrived);
  assert.strictEqual(a.goal.kind, 'desk');
});

test('terminou: pulinho, ✓ subindo e o "pronto" na cabeça até você ver', () => {
  const w = world({ coffee: 2 });
  w.syncSessions([session('t1', '/repo/api', 'working')], { snap: true });
  const a = w.agents.get('t1');
  w.hook('t1', 'Stop', { last_assistant_message: 'Pronto, o login voltou.' });
  w.status('t1', 'idle');
  w.run(100);
  assert.strictEqual(a.anim, 'cheer');
  assert.ok(w.effectsData().some((f) => f.on && f.text === '✓'));
  const bubble = () => w.agentsData()[a.slot].bubble.text;
  assert.strictEqual(bubble(), '✓ pronto');
  assert.match(w.roster()[0].agents[0].sub, /pronto/);
  // Vai pro café com o "pronto" na cabeça.
  w.run(30000);
  assert.strictEqual(a.goal.kind, 'lounge');
  assert.strictEqual(bubble(), '✓ pronto');
  // Abrir a conversa dele é ver.
  assert.ok(w.seen('t1'));
  assert.notStrictEqual(w.agentsData()[a.slot].bubble.text, '✓ pronto');
  // E um pedido novo também tira.
  w.hook('t1', 'Stop', {});
  w.hook('t1', 'UserPromptSubmit', { prompt: 'mais uma' });
  assert.strictEqual(a.done, false);
});

test('parado no prompt, o chat não tem linha do que ele está fazendo', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'idle')], { snap: true });
  assert.strictEqual(w.chatCard(w.agents.get('t1')).live.on, false);
  w.hook('t1', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a/b.js' } });
  w.status('t1', 'tool');
  const live = w.chatCard(w.agents.get('t1')).live;
  assert.ok(live.on);
  assert.match(live.text, /lendo b\.js/);
});

test('cada boneco é a âncora do chat dele', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  assert.strictEqual(w.agentsData()[w.agents.get('t1').slot].anchor, 'agente:t1');
  assert.strictEqual(w.roster()[0].agents[0].anchor, 'linha:t1');
  assert.match(w.desksData().find((d) => d.on).anchor, /^mesa:/);
});

test('você mora na sua sala: sai pra levar o pedido e volta pra sua mesa', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  const sala = w.plan.rooms.find((r) => r.kind === 'office');
  assert.ok(sala, 'a sua sala está na planta');
  assert.strictEqual(sala.name, 'sua sala');
  const you = w.agents.get(YOU_ID);
  assert.ok(you && you.resident);
  assert.strictEqual(you.goal.kind, 'home');
  assert.deepStrictEqual(you.tile, w.plan.home.seat);
  assert.strictEqual(w.agentsData()[you.slot].action, 'voce');

  w.hook('t1', 'UserPromptSubmit', { prompt: 'corrige o login' });
  assert.strictEqual(you.goal.kind, 'deliver');
  w.run(30000);
  assert.ok(w.agents.has(YOU_ID), 'não foi embora pela porta');
  assert.strictEqual(you.goal.kind, 'home');
  assert.ok(you.arrived);
  assert.deepStrictEqual(you.tile, w.plan.home.seat);
});

test('o nome vai pra plaquinha da sala; sem a sala, você só aparece pra entregar', () => {
  const w = world();
  w.youName = 'Matheus';
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  assert.strictEqual(w.plan.rooms.find((r) => r.kind === 'office').name, 'sala de Matheus');
  assert.ok(w.labels().some((l) => l.text === 'sala de Matheus'));
  w.settings.office = false;
  w.relayout();
  w.ensureYou();
  assert.ok(!w.plan.rooms.some((r) => r.kind === 'office'));
  assert.ok(!w.agents.has(YOU_ID));
  w.hook('t1', 'UserPromptSubmit', { prompt: 'oi' });
  const visitor = w.agents.get(YOU_ID);
  assert.ok(visitor && !visitor.resident);
});

test('a mesa guardada de quem dorme no sofá ainda chama outro claude; a ocupada abre a conversa', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api'), session('t2', '/repo/api', 'idle')], { snap: true });
  const a1 = w.agents.get('t1');
  const a2 = w.agents.get('t2');
  w.status('t2', 'ended', { hibernated: true });
  w.run(20000);
  assert.strictEqual(a2.goal.kind, 'sofa');
  assert.ok(a2.desk, 'quem dorme guarda a mesa');
  const desks = w.desksData();
  const ids = w.plan.desks.map((dk) => dk.id);
  const at = (id) => desks[ids.indexOf(id)];
  assert.deepStrictEqual([at(a1.desk).on, at(a1.desk).action], [true, 'chat:t1']);
  assert.deepStrictEqual([at(a2.desk).on, at(a2.desk).action], [true, `mesa:${a2.desk}`]);
});

test('renomear: o nome novo no boneco, na lateral e no menu', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  assert.ok(w.menuOf(w.agents.get('t1')).some((i) => i.action === 'renomear:t1'));
  assert.ok(w.renamed('t1', 'login do google'));
  assert.strictEqual(w.agentsData()[w.agents.get('t1').slot].name, 'login do google');
  assert.strictEqual(w.roster()[0].agents[0].name, 'login do google');
  assert.ok(!w.renamed('nao-existe', 'x'));
});

test('quem tem uma pergunta vai até a sua sala, e volta pra mesa quando você responde', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'working')], { snap: true });
  const a = w.agents.get('t1');
  w.hook('t1', 'PreToolUse', {
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Uso Postgres ou SQLite?', options: [] }] },
  });
  w.status('t1', 'waitingAnswer');
  assert.strictEqual(a.goal.kind, 'ask');
  assert.ok(w.plan.home.visit.some((t) => t.x === a.goal.tile.x && t.y === a.goal.tile.y), 'do lado da sua mesa');
  // Até ele chegar na sua sala (o "diz aí" dura uns segundos).
  for (let i = 0; i < 120 && !a.arrived; i++) w.run(250);
  assert.ok(a.arrived);
  assert.strictEqual(a.anim, 'wave');
  assert.strictEqual(w.agentsData()[a.slot].bubble.text, '? Uso Postgres ou SQLite?');
  assert.strictEqual(w.agents.get(YOU_ID).bubble.text, 'diz aí');
  assert.match(w.roster()[0].agents[0].sub, /com uma pergunta/);

  // Respondeu: volta pra mesa dele, sem a pergunta.
  w.hook('t1', 'UserPromptSubmit', { prompt: 'Postgres' });
  w.status('t1', 'working');
  assert.strictEqual(a.goal.kind, 'desk');
  assert.strictEqual(a.question, null);
  w.run(30000);
  assert.ok(a.arrived);
  assert.strictEqual(a.goal.kind, 'desk');
});

test('sem a sua sala (ou com a opção desligada), a pergunta é feita da mesa', () => {
  const w = world({ askVisits: false });
  w.syncSessions([session('t1', '/repo/api', 'working')], { snap: true });
  w.status('t1', 'waitingAnswer');
  assert.strictEqual(w.agents.get('t1').goal.kind, 'desk');
});

test('a barrinha de contexto: verde, amarela e vermelha, e some sem número', () => {
  const { contextBar } = require('../world');
  assert.strictEqual(contextBar(null).on, false);
  assert.strictEqual(contextBar(30).color, 0xff6cc483);
  assert.strictEqual(contextBar(62).color, 0xffeec05a);
  const full = contextBar(81);
  assert.strictEqual(full.color, 0xffe5534b);
  assert.match(full.label, /81%.*compact/);
  assert.ok(Math.abs(full.bar - 97.2) < 0.01);
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'idle', { context: { percent: 62 } })], { snap: true });
  const card = w.chatCard(w.agents.get('t1'));
  assert.ok(card.ctx.on);
  assert.doesNotMatch(card.sub, /contexto/, 'o número saiu do subtítulo');
});

test('sozinho, só depois de muito tempo parado de verdade (15 min, se ninguém mudou)', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'idle')], { snap: true });
  const a = w.agents.get('t1');
  w.run(5 * 60 * 1000);
  assert.strictEqual(a.goal.kind, 'desk', 'cinco minutos parado ainda é na mesa');
  w.run(11 * 60 * 1000);
  assert.strictEqual(a.goal.kind, 'lounge');
});

test('qualquer sinal da sessão zera o relógio, e um ajudante trabalhando segura ele na mesa', () => {
  const w = world({ coffee: 10 });
  w.syncSessions([session('t1', '/repo/api', 'idle')], { snap: true });
  const a = w.agents.get('t1');
  // Um subagente em segundo plano: a sessão está "parada", mas tem trabalho.
  w.hook('t1', 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'u1', tool_input: { description: 'revisar', run_in_background: true } });
  w.status('t1', 'idle');
  for (let i = 0; i < 8; i++) {
    w.run(5000);
    w.hook('t1', 'PreToolUse', { agent_id: 'ag1', tool_name: 'Read', tool_input: { file_path: '/x.js' } });
  }
  assert.strictEqual(a.goal.kind, 'desk', 'com ajudante trabalhando, não vai pro café');
  w.hook('t1', 'SubagentStop', { agent_id: 'ag1' });
  w.run(40000);
  assert.strictEqual(a.goal.kind, 'lounge', 'acabou o trabalho e passou o tempo: agora sim');
});

test('mandar pro descanso: vai na hora, e volta com trabalho novo ou quando você chama', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'idle')], { snap: true });
  const a = w.agents.get('t1');
  assert.strictEqual(w.chatCard(a).rest.action, 'descanso');
  assert.ok(w.menuOf(a).some((i) => i.action === 'descanso:t1'));
  assert.ok(w.rest('t1'));
  assert.strictEqual(a.goal.kind, 'lounge');
  w.run(30000);
  assert.strictEqual(w.chatCard(a).rest.action, 'voltar');
  assert.ok(w.menuOf(a).some((i) => i.action === 'voltar:t1'));
  // Um pedido novo: espera você entregar ali mesmo e volta pra mesa.
  w.hook('t1', 'UserPromptSubmit', { prompt: 'mais uma' });
  w.status('t1', 'working');
  assert.strictEqual(a.resting, false);
  w.run(60000);
  assert.strictEqual(a.goal.kind, 'desk');
  // De novo pro descanso, e de volta pelo botão.
  w.status('t1', 'idle');
  w.rest('t1');
  assert.strictEqual(a.goal.kind, 'lounge');
  assert.ok(w.backToDesk('t1'));
  assert.strictEqual(a.goal.kind, 'desk');
});

test('a permissão pedida: a ferramenta que começou e não terminou, dele ou de um ajudante', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo', 'working')], { snap: true });
  const a = w.agents.get('t1');
  w.hook('t1', 'PreToolUse', { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: '/repo/a.js' } });
  w.hook('t1', 'PostToolUse', { tool_name: 'Read', tool_use_id: 'r1', tool_input: {} });
  w.hook('t1', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'rm -rf build' } });
  assert.strictEqual(w.permissionOf(a), null, 'trabalhando não é pedir permissão');
  w.status('t1', 'waitingPermission');
  assert.deepStrictEqual(
    (({ id, name, by }) => ({ id, name, by }))(w.permissionOf(a)),
    { id: 'b1', name: 'Bash', by: null },
  );
  // Permitido: a ferramenta roda e termina, e não há mais o que permitir.
  w.status('t1', 'tool');
  w.hook('t1', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {} });
  // Um ajudante pede a dele no terminal de quem o chamou.
  w.hook('t1', 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'ag', tool_input: { description: 'testes' } });
  w.hook('t1', 'PreToolUse', { agent_id: 'f1', tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: '/repo/b.js' } });
  w.status('t1', 'waitingPermission');
  const p = w.permissionOf(a);
  assert.strictEqual(p.id, 'e1');
  assert.strictEqual(p.by, 'testes');
  // O fim do turno limpa o que ficou pendurado.
  w.hook('t1', 'Stop', {});
  w.status('t1', 'waitingPermission');
  assert.strictEqual(w.permissionOf(a), null);
});

test('pôr pra dormir: só numa Maestria que hiberna, com ele parado e sem ajudante', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo', 'working')], { snap: true });
  const a = w.agents.get('t1');
  const napping = () => w.menuOf(a).some((m) => m.action === 'dormir:t1');
  w.status('t1', 'idle');
  assert.ok(!napping(), 'sem o `hibernate: 1`, não aparece');
  assert.strictEqual(w.chatCard(a).nap.on, false);
  w.hibernateOn = true;
  assert.ok(napping());
  assert.strictEqual(w.chatCard(a).nap.action, 'dormir');
  w.status('t1', 'working');
  assert.ok(!napping(), 'trabalhando, não');
  w.status('t1', 'idle');
  w.status('t1', 'ended', { hibernated: true });
  assert.ok(!napping(), 'já dormindo, não');
  assert.strictEqual(a.goal.kind, 'sofa');
});

test('a mesma tarefa: os outros vão até a mesa de quem terminou, na sala dele, e voltam', () => {
  const w = world();
  w.syncSessions(
    [
      session('t1', '/repo/api', 'working', { branch: 'feature/TASK#123' }),
      session('t2', '/repo/app', 'idle', { title: 'TASK#123 - tela nova' }),
      session('t3', '/repo/web', 'idle', { branch: 'feature/TASK#999' }),
    ],
    { snap: true },
  );
  const [a, b, c] = ['t1', 't2', 't3'].map((id) => w.agents.get(id));
  assert.strictEqual(w.taskOf(a), 'TASK#123');
  w.hook('t1', 'Stop', { last_assistant_message: 'Pronto: a rota nova responde. Falta o app.' });
  assert.ok(a.meeting && b.meeting && !c.meeting, 'só os da mesma tarefa');
  w.status('t1', 'idle');
  w.run(30000);
  assert.strictEqual(a.goal.kind, 'desk', 'quem terminou fica na mesa dele');
  assert.strictEqual(b.goal.kind, 'huddle', 'o outro vem até ele');
  const desk = w.deskOf(a);
  assert.strictEqual(b.tile.y, desk.y + 2, 'no corredor da frente da mesa');
  assert.ok(w.plan.rooms.find((r) => r.id === '/repo/api').ix <= b.tile.x);
  assert.ok(w.roster().some((r) => r.agents.some((x) => x.sub.includes('conversando com T1 (TASK#123)'))));
  // Trabalho novo tira da conversa.
  w.status('t2', 'working');
  assert.strictEqual(b.meeting, null);
  w.run(30000);
  assert.strictEqual(b.goal.kind, 'desk');
  w.status('t2', 'idle');
  w.hook('t1', 'Stop', {});
  assert.ok(!a.meeting, 'e não se reúnem de novo logo em seguida');
});

test('o ajudante que terminou conta como foi na mesa de quem o chamou', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api'), session('t2', '/repo/web', 'idle')], { snap: true });
  w.hook('t1', 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'tu1', tool_input: { description: 'revisar' } });
  w.run(20000);
  const h = [...w.agents.values()].find((x) => x.kind === 'helper');
  w.hook('t1', 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'tu1', tool_input: {} });
  assert.strictEqual(h.goal.kind, 'report');
  assert.ok(!h.meeting);
  w.run(30000);
  assert.ok(!w.agents.has(h.id) || h.leaving, 'contou e foi embora');
  assert.strictEqual(w.agents.get('t1').goal.kind, 'desk');
});

test('ler outro repositório: vai até a sala dele, senta numa mesa livre, e volta', () => {
  const w = world();
  w.setFolders([
    { root: '/repo/api', name: 'api' },
    { root: '/repo/web', name: 'web', worktrees: [{ path: '/wt/web-x' }] },
  ]);
  w.syncSessions([session('t1', '/repo/api', 'working')], { snap: true });
  const a = w.agents.get('t1');
  assert.ok(!w.plan.rooms.some((r) => r.id === '/repo/web'));
  // O próprio repositório não é visita.
  w.hook('t1', 'PreToolUse', { tool_name: 'Read', tool_use_id: 'r0', tool_input: { file_path: '/repo/api/a.js' } });
  assert.ok(!a.trip);
  w.hook('t1', 'PreToolUse', { tool_name: 'Grep', tool_use_id: 'r1', tool_input: { pattern: 'x', path: '/wt/web-x/lib' } });
  assert.strictEqual(a.trip.name, 'web', 'a worktree é da sala do repositório');
  assert.ok(w.plan.rooms.some((r) => r.id === '/repo/web'), 'a sala aparece');
  w.run(20000);
  assert.strictEqual(a.goal.kind, 'trip');
  const room = w.plan.rooms.find((r) => r.id === '/repo/web');
  assert.ok(a.tile.x >= room.ix && a.tile.x < room.ix + room.iw);
  assert.ok(w.screens().some((sc) => sc.color !== 0xff2c3140), 'a tela da mesa visitada acende');
  // Escrever no dele de novo encerra a visita.
  w.hook('t1', 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: '/repo/api/a.js' } });
  assert.ok(!a.trip);
  w.run(25000);
  assert.strictEqual(a.goal.kind, 'desk');
  assert.ok(!w.plan.rooms.some((r) => r.id === '/repo/web'), 'a sala some de novo');
  // O Bash com um caminho de lá também conta; e sem mexer em nada, ele volta sozinho.
  w.hook('t1', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'cd /repo/web && git log -3' } });
  assert.strictEqual(a.trip.name, 'web');
  w.run(35000);
  assert.ok(!a.trip);
});

test('o pedido de outra sessão é levado por quem mandou, ou pelo mensageiro', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'idle', { title: 'api' }), session('t2', '/repo/web', 'idle', { title: 'Pixel agents' })], { snap: true });
  const wrap = (name, text) => `<cross-session-message from="uds:/tmp/x.sock" from-name="${name}">${text}</cross-session-message>`;
  w.hook('t1', 'UserPromptSubmit', { prompt: wrap('Pixel agents', 'pode rodar os testes?') });
  const sender = w.agents.get('t2');
  assert.ok(sender.errand, 'quem mandou leva');
  assert.ok(!w.agents.get(YOU_ID).targetId, 'você não');
  w.run(30000);
  assert.ok(!sender.errand, 'entregou e voltou');
  assert.strictEqual(sender.goal.kind, 'desk');
  // De uma sessão que não está no escritório: o mensageiro.
  w.hook('t1', 'UserPromptSubmit', { prompt: wrap('maestria_v2', 'terminei a API') });
  const courier = [...w.agents.values()].find((x) => x.kind === 'courier');
  assert.ok(courier);
  assert.strictEqual(courier.name, 'recado de maestria_v2');
  w.run(40000);
  assert.ok(!w.agents.has(courier.id), 'entregou e saiu pela porta');
  // Um aviso do Claude Code não é levado por ninguém.
  w.hook('t1', 'UserPromptSubmit', { prompt: '<task-notification>terminou</task-notification>' });
  assert.ok(![...w.agents.values()].some((x) => x.kind === 'courier'));
  assert.ok(!w.agents.get(YOU_ID).targetId);
});

test('decoração: o tema, o vaso arrastado (que troca com o da vaga) e o que fecharia caminho', () => {
  const w = world({ office: false });
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  const svg = w.scene().svg;
  assert.ok(w.setTheme('espacial'));
  assert.notStrictEqual(w.scene().svg, svg);
  assert.ok(!w.setTheme('espacial'));
  const room = w.plan.rooms.find((r) => r.id === '/repo/api');
  const at = (key) => {
    const m = w.plan.decor.find((x) => x.room === '/repo/api' && x.key === key);
    return [m.x - room.ix, m.y - room.iy];
  };
  const lamp = at('luz');
  // O vaso vai pra vaga da luminária: os dois trocam.
  assert.ok(w.moveDecor('/repo/api', 'vaso1', lamp[0], lamp[1]));
  const r2 = w.plan.rooms.find((r) => r.id === '/repo/api');
  const m = w.plan.decor.find((x) => x.key === 'vaso1');
  assert.deepStrictEqual([m.x - r2.ix, m.y - r2.iy], lamp);
  assert.notDeepStrictEqual(at('luz'), lamp);
  // Uma vaga que não existe não vale.
  assert.ok(!w.moveDecor('/repo/api', 'vaso1', 5, 1));
  w.decorating = true;
  const data = w.decorData();
  assert.ok(data.items.length >= 3 && data.slots.length > 10);
  assert.ok(data.items[0].targets.every((id) => id.startsWith('vaga|/repo/api|')));
  assert.ok(w.resetDecor());
});

test('os vasos crescem com os commits da semana, e a sua sala com todos', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api')], { snap: true });
  const rev = w.sceneRevision;
  assert.ok(w.setGrowth({ '/repo/api': 9 }));
  assert.deepStrictEqual(w.growth, { '/repo/api': 3, '@voce': 3 });
  assert.ok(w.sceneRevision > rev);
  assert.ok(!w.setGrowth({ '/repo/api': 10 }), 'mesmo tamanho: nada muda');
  assert.ok(w.setGrowth({ '/repo/api': 25 }));
  assert.ok(w.fx.some((f) => f && f.text === '🌱'), 'cresceu: um brotinho');
});

test('travado: o mesmo comando três vezes, ou os testes quebrando em fila; destrava com o que muda', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo')], { snap: true });
  const a = w.agents.get('t1');
  const bash = (command, ok = true, out = '') => {
    w.hook('t1', 'PreToolUse', { tool_name: 'Bash', tool_use_id: command + Math.random(), tool_input: { command } });
    w.hook('t1', ok ? 'PostToolUse' : 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: out } });
  };
  bash('ls');
  bash('npm run build');
  bash('npm run build');
  assert.ok(!a.stuck);
  bash('npm run build');
  assert.match(a.stuck.reason, /3 vezes/);
  assert.match(w.chatCard(a).live.text, /parece travado/);
  assert.ok(w.roster()[0].agents[0].sub.includes('travado'));
  // Você falou com ele: a conta recomeça.
  w.hook('t1', 'UserPromptSubmit', { prompt: 'tenta outro jeito' });
  assert.ok(!a.stuck);
  // Os testes quebrando três vezes, mesmo com comandos diferentes.
  bash('npm test -- a', false);
  bash('npm test -- b', false);
  bash('npm test -- c', false);
  assert.match(a.stuck.reason, /testes quebraram 3/);
  bash('npm test', true, 'all passed');
  assert.ok(!a.stuck, 'passaram: destrava');
});

test('o ajudante tem o tipo no crachá e deixa o recado na mesa de quem o chamou', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo')], { snap: true });
  w.hook('t1', 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'x1', tool_input: { description: 'achar o bug', subagent_type: 'Explore' } });
  const h = [...w.agents.values()].find((x) => x.kind === 'helper');
  assert.strictEqual(h.skin.id, 'helper-explore');
  assert.ok(w.agentsData().some((d) => d.on && d.name === '↳ Explore: achar o bug'));
  w.run(20000);
  w.hook('t1', 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'x1', tool_response: { content: [{ type: 'text', text: 'O bug está no store.dart.' }] } });
  const a = w.agents.get('t1');
  assert.strictEqual(w.unreadNotes(a).length, 1);
  assert.strictEqual(a.notes[0].text, 'O bug está no store.dart.');
  assert.strictEqual(w.notesData()[0].action, 'recados:t1');
  assert.ok(w.menuOf(a).some((m) => m.action === 'recados:t1'));
  // O de segundo plano: o recado vem no SubagentStop.
  w.hook('t1', 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'x2', tool_input: { description: 'revisar', subagent_type: 'code-reviewer', run_in_background: true } });
  w.hook('t1', 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'x2', tool_response: 'launched' });
  w.hook('t1', 'SubagentStop', { agent_id: 'ag2', last_assistant_message: 'tudo certo' });
  assert.strictEqual(w.unreadNotes(a).length, 2);
});

test('a caixa de entrada junta quem espera você, do mais antigo pro mais novo', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo', 'working'), session('t2', '/repo', 'working'), session('t3', '/repo', 'working')], { snap: true });
  assert.strictEqual(w.inboxData().count, '');
  w.status('t2', 'waitingPermission');
  w.run(1000);
  w.hook('t3', 'Stop', {});
  const list = w.inboxList();
  assert.deepStrictEqual(list.map((x) => [x.a.tabId, x.why]), [['t2', 'perm'], ['t3', 'done']]);
  const inbox = w.inboxData();
  assert.strictEqual(inbox.count, '2');
  assert.strictEqual(inbox.action, 'caixa');
  assert.strictEqual(inbox.papers.length, 2);
  w.seen('t3');
  assert.strictEqual(w.inboxData().count, '1');
});

test('a bateria, o crachá e o relógio de ponto do dia', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo', 'working', { sessionId: 's1', context: { percent: 70 } })], { snap: true });
  const a = w.agentsData().find((x) => x.on && x.action === 'chat:t1');
  assert.ok(a.battery.on);
  assert.strictEqual(a.battery.color, 0xffeec05a, 'sobrando 30%: amarela');
  assert.ok(w.setUsage({ total: { tokens: 1234567, workMs: 3 * 3600000 + 12 * 60000, sessions: 2 }, bySession: { s1: { tokens: 180000, workMs: 42 * 60000 } } }));
  assert.ok(!w.setUsage({ total: { tokens: 1234567, workMs: 3 * 3600000 + 12 * 60000, sessions: 2 }, bySession: { s1: { tokens: 180000, workMs: 42 * 60000 } } }));
  const p = w.punchData();
  assert.strictEqual(p.time, '3h12');
  assert.strictEqual(p.tokens, '1,2 mi tok');
  assert.match(p.tip, /T1: 42 min · 180 mil tokens/);
  assert.match(w.tipOf(w.agents.get('t1')), /hoje: 42 min trabalhando · 180 mil tokens/);
});

test('selecionando, o clique marca em vez de abrir a conversa', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo')], { snap: true });
  const pick = (opts) => w.agentsData(opts).find((x) => x.on && x.anchor === 'agente:t1');
  assert.strictEqual(pick({}).action, 'chat:t1');
  assert.strictEqual(pick({ selecting: true, selected: new Set() }).action, 'sel:t1');
  assert.strictEqual(pick({ selecting: true, selected: new Set(['t1']) }).selected, true);
});

test('a daily: você e quem trabalhou vão pra sala de reunião, cada um fala, e voltam', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'idle'), session('t2', '/repo/web', 'idle'), session('t3', '/repo/web', 'idle')], { snap: true });
  assert.ok(w.startDaily(['t1', 't2']));
  w.run(30000);
  const you = w.agents.get(YOU_ID);
  assert.strictEqual(w.agents.get('t1').goal.kind, 'meeting');
  assert.strictEqual(you.goal.kind, 'meeting');
  assert.strictEqual(w.agents.get('t3').goal.kind, 'desk', 'quem não trabalhou no período fica');
  w.dailyLines({ t1: ['fiz a rota nova', '💡 o cache era o culpado'], t2: ['fiz a tela', 'falta: o modo escuro', 'e o ícone'] });
  const said = new Set();
  for (let i = 0; i < 60 && !said.has('💡 o cache era o culpado'); i++) {
    w.run(1000);
    for (const id of ['t1', 't2', YOU_ID]) {
      const b = w.agents.get(id).bubble;
      if (b) said.add(b.text);
    }
  }
  assert.ok(said.has('bom, vamos lá: o que cada um fez?'));
  assert.ok(said.has('fiz a rota nova'));
  assert.ok(said.has('💡 o cache era o culpado'));
  assert.ok(!said.has('valeu, pessoal!'), 'você só agradece no fim');
  assert.ok(w.endDaily(), 'o "encerrar a reunião" acaba antes de todo mundo falar');
  w.run(30000);
  assert.strictEqual(w.agents.get('t1').goal.kind, 'desk');
  assert.strictEqual(you.goal.kind, 'home');
});

test('a daily com um claude só: a sala aparece, você conta a parte de quem não veio, e ela acaba sozinha', () => {
  const w = world();
  w.syncSessions([session('t1', '/repo/api', 'idle')], { snap: true });
  assert.ok(!w.plan.meeting, 'reunião de um só não tem sala');
  assert.ok(w.startDaily(['t1']));
  assert.ok(w.plan.meeting, 'na daily, a sala aparece');
  w.run(30000);
  assert.strictEqual(w.agents.get('t1').goal.kind, 'meeting');
  w.dailyLines({ t1: ['fiz a rota nova'] }, ['TASK#9 relatório: fechei o PDF']);
  const said = new Set();
  for (let i = 0; i < 90 && w.inDaily(); i++) {
    w.run(1000);
    for (const id of ['t1', YOU_ID]) {
      const b = w.agents.get(id).bubble;
      if (b) said.add(b.text);
    }
  }
  assert.ok(said.has('fiz a rota nova'));
  assert.ok(said.has('TASK#9 relatório: fechei o PDF'), 'a conversa que já fechou, você conta');
  assert.ok(said.has('valeu, pessoal!'));
  assert.ok(!w.inDaily(), 'todo mundo falou: a reunião acaba');
  assert.ok(!w.plan.meeting, 'e a sala vai embora');
  w.run(30000);
  assert.strictEqual(w.agents.get('t1').goal.kind, 'desk');
});
