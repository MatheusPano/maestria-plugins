'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiError } = require('../lib/http');
const { classify, createCreateFlow, IN_PROGRESS } = require('../lib/create-flow');
const { fakeClock } = require('./helpers');

const BODY = { name: 'a', template: 't' };
const UNCONFIRMED = 'não deu pra confirmar — confira a lista antes de tentar de novo';

function setup({ create, creations = [], vms } = {}) {
  const clock = fakeClock();
  const calls = { create: 0, creation: 0, vms: 0 };
  const queue = [...creations];
  const api = {
    async createVm() {
      calls.create++;
      return create();
    },
    async vmCreation() {
      calls.creation++;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
    async vms() {
      calls.vms++;
      return vms();
    },
  };
  const flow = createCreateFlow({ api, now: clock.now, schedule: clock.schedule });
  return { flow, clock, calls };
}

const nestErr = (msg, status = 400) => new ApiError(msg, status, { nest: true });
const running = { status: 'running', startedAt: 0, finishedAt: null, result: null, error: null };

test('classify', () => {
  assert.equal(classify({ ok: true, data: {} }), 'succeeded');
  assert.equal(classify({ ok: false, error: nestErr('x') }), 'rejected');
  assert.equal(classify({ ok: false, error: nestErr('A VM "a" já está sendo criada.', 409) }), 'track');
  assert.equal(classify({ ok: false, error: new ApiError('x', 502) }), 'track');
  assert.ok(IN_PROGRESS.test('já está sendo criada'));
});

test('success json → succeeded with result, one POST', async () => {
  const { flow, calls } = setup({ create: async () => ({ vm: { vmid: 1 } }) });
  const s = await flow.submit(BODY);
  assert.equal(s.phase, 'succeeded');
  assert.equal(s.result.vm.vmid, 1);
  assert.equal(calls.create, 1);
});

test('submit sets submitting synchronously', () => {
  const { flow } = setup({ create: () => new Promise(() => {}) });
  flow.submit(BODY);
  assert.equal(flow.state().phase, 'submitting');
});

test('concurrent submits send one POST', async () => {
  const { flow, calls } = setup({ create: async () => ({ vm: {} }) });
  await Promise.all([flow.submit(BODY), flow.submit(BODY)]);
  assert.equal(calls.create, 1);
});

test('nest 400 → rejected with message, reset allowed', async () => {
  const msg = 'name deve ser… · gateway deve ser…';
  const { flow } = setup({ create: async () => { throw nestErr(msg); } });
  await flow.submit(BODY);
  assert.equal(flow.state().phase, 'rejected');
  assert.equal(flow.state().error, msg);
  assert.equal(flow.reset(), true);
  assert.equal(flow.state().phase, 'idle');
});

test('nest 409 name exists → rejected', async () => {
  const { flow } = setup({ create: async () => { throw nestErr('Já existe uma VM chamada "a".', 409); } });
  await flow.submit(BODY);
  assert.equal(flow.state().phase, 'rejected');
});

test('in-progress 409 → tracking', async () => {
  const { flow, calls } = setup({
    create: async () => { throw nestErr('A VM "a" já está sendo criada.', 409); },
    creations: [running],
  });
  await flow.submit(BODY);
  assert.equal(flow.state().phase, 'tracking');
  assert.equal(flow.reset(), false);
  assert.equal(calls.create, 1);
});

for (const [label, err] of [
  ['timeout', new ApiError('t', 0, { kind: 'timeout' })],
  ['network', new ApiError('n', 0, { kind: 'network' })],
  ['html 502', new ApiError('Bad Gateway', 502)],
]) {
  test(`${label} → tracking`, async () => {
    const { flow, calls } = setup({ create: async () => { throw err; }, creations: [running] });
    await flow.submit(BODY);
    assert.equal(flow.state().phase, 'tracking');
    assert.equal(calls.create, 1);
  });
}

test('polls creations every 5000ms until succeeded', async () => {
  const { flow, clock, calls } = setup({
    create: async () => { throw new ApiError('t', 0, { kind: 'timeout' }); },
    creations: [running, running, { status: 'succeeded', result: { vm: { vmid: 177 } } }],
  });
  await flow.submit(BODY);
  assert.equal(calls.creation, 0);
  await clock.advance(5000);
  assert.equal(calls.creation, 1);
  await clock.advance(5000);
  assert.equal(calls.creation, 2);
  assert.equal(flow.state().phase, 'tracking');
  await clock.advance(5000);
  assert.equal(calls.creation, 3);
  assert.equal(flow.state().phase, 'succeeded');
  assert.equal(flow.state().result.vm.vmid, 177);
  assert.equal(calls.create, 1);
});

test('failed creation → failed with api error text', async () => {
  const { flow, clock } = setup({
    create: async () => { throw new ApiError('x', 502); },
    creations: [{ status: 'failed', error: 'Sem espaço no storage' }],
  });
  await flow.submit(BODY);
  await clock.advance(5000);
  assert.equal(flow.state().phase, 'failed');
  assert.equal(flow.state().error, 'Sem espaço no storage');
});

test('404 and network errors while tracking keep tracking', async () => {
  const { flow, clock } = setup({
    create: async () => { throw new ApiError('x', 502); },
    creations: [new ApiError('nf', 404, { nest: true }), new ApiError('n', 0, { kind: 'network' }), new ApiError('b', 500)],
  });
  await flow.submit(BODY);
  await clock.advance(15000);
  assert.equal(flow.state().phase, 'tracking');
});

test('gives up after 10 minutes → unconfirmed', async () => {
  const { flow, clock, calls } = setup({
    create: async () => { throw new ApiError('x', 502); },
    creations: [running],
  });
  await flow.submit(BODY);
  await clock.advance(600000);
  assert.equal(flow.state().phase, 'unconfirmed');
  assert.equal(flow.state().error, UNCONFIRMED);
  assert.equal(calls.create, 1);
  assert.equal(flow.reset(), true);
});

test('submit while tracking does not POST', async () => {
  const { flow, calls } = setup({ create: async () => { throw new ApiError('x', 502); }, creations: [running] });
  await flow.submit(BODY);
  const s = await flow.submit(BODY);
  assert.equal(s.phase, 'tracking');
  assert.equal(calls.create, 1);
});

test('onChange fires on every phase change', async () => {
  const { flow } = setup({ create: async () => ({ vm: {} }) });
  const phases = [];
  flow.onChange((s) => phases.push(s.phase));
  await flow.submit(BODY);
  flow.reset();
  assert.deepEqual(phases, ['submitting', 'succeeded', 'idle']);
});

// --- veredito do controller: registro sobrescrito / perdido ---

const FALLBACK = 'Criada; detalhes do NetBox/backup não disponíveis — confira na lista.';

test('failed "Já existe" but vm in list → succeeded', async () => {
  const vm = { name: 'a', vmid: 5 };
  const { flow, clock, calls } = setup({
    create: async () => { throw new ApiError('x', 502); },
    creations: [{ status: 'failed', error: 'Já existe uma VM chamada "a".' }],
    vms: async () => [{ name: 'ab', vmid: 4 }, vm],
  });
  await flow.submit(BODY);
  await clock.advance(5000);
  assert.equal(flow.state().phase, 'succeeded');
  assert.deepEqual(flow.state().result, { vm, netbox: null, backupSlot: null, ha: false, warnings: [FALLBACK] });
  assert.equal(calls.create, 1);
});

test('failed "Já existe" and vm not in list → failed', async () => {
  const { flow, clock } = setup({
    create: async () => { throw new ApiError('x', 502); },
    creations: [{ status: 'failed', error: 'Já existe uma VM chamada "a".' }],
    vms: async () => [],
  });
  await flow.submit(BODY);
  await clock.advance(5000);
  assert.equal(flow.state().phase, 'failed');
  assert.equal(flow.state().error, 'Já existe uma VM chamada "a".');
});

test('404 after running and vm in list → succeeded', async () => {
  const vm = { name: 'a', vmid: 5 };
  const { flow, clock, calls } = setup({
    create: async () => { throw new ApiError('x', 502); },
    creations: [running, new ApiError('nf', 404, { nest: true })],
    vms: async () => [vm],
  });
  await flow.submit(BODY);
  await clock.advance(5000);
  assert.equal(flow.state().phase, 'tracking');
  await clock.advance(5000);
  assert.equal(flow.state().phase, 'succeeded');
  assert.equal(flow.state().result.vm, vm);
  assert.equal(calls.create, 1);
});

test('404 after running, vm not in list or vms() errors → keeps tracking', async () => {
  let fail = false;
  const { flow, clock } = setup({
    create: async () => { throw new ApiError('x', 502); },
    creations: [running, new ApiError('nf', 404, { nest: true })],
    vms: async () => { if (fail) throw new ApiError('x', 500); return []; },
  });
  await flow.submit(BODY);
  await clock.advance(10000);
  assert.equal(flow.state().phase, 'tracking');
  fail = true;
  await clock.advance(5000);
  assert.equal(flow.state().phase, 'tracking');
});

test('404 before any running keeps tracking (no vms lookup)', async () => {
  const { flow, clock, calls } = setup({
    create: async () => { throw new ApiError('x', 502); },
    creations: [new ApiError('nf', 404, { nest: true })],
    vms: async () => [{ name: 'a', vmid: 5 }],
  });
  await flow.submit(BODY);
  await clock.advance(10000);
  assert.equal(flow.state().phase, 'tracking');
  assert.equal(calls.vms, 0);
});

// --- Task 8 (revisão da Task 6): 2xx vazio/não-JSON não é sucesso ---

test('classify: ok without a JSON object → track', () => {
  for (const data of [null, undefined, '', 'ok', 0, true]) {
    assert.equal(classify({ ok: true, data }), 'track', `data ${JSON.stringify(data)}`);
  }
  assert.equal(classify({ ok: true, data: { vm: {} } }), 'succeeded');
});

test('empty 2xx → tracking, then the real result from /vms/creations', async () => {
  const { flow, clock, calls } = setup({
    create: async () => null,
    creations: [{ status: 'succeeded', result: { vm: { vmid: 9 } } }],
  });
  const s = await flow.submit(BODY);
  assert.equal(s.phase, 'tracking');
  await clock.advance(5000);
  assert.equal(flow.state().phase, 'succeeded');
  assert.equal(flow.state().result.vm.vmid, 9);
  assert.equal(calls.create, 1);
});

test('after succeeded, the clock makes no more vmCreation calls', async () => {
  const { flow, clock, calls } = setup({
    create: async () => { throw new ApiError('t', 0, { kind: 'timeout' }); },
    creations: [{ status: 'succeeded', result: { vm: { vmid: 1 } } }],
  });
  await flow.submit(BODY);
  await clock.advance(5000);
  assert.equal(flow.state().phase, 'succeeded');
  const n = calls.creation;
  await clock.advance(60000);
  assert.equal(calls.creation, n);
});

test('after unconfirmed, the clock makes no more vmCreation calls', async () => {
  const { flow, clock, calls } = setup({
    create: async () => { throw new ApiError('x', 502); },
    creations: [running],
  });
  await flow.submit(BODY);
  await clock.advance(600000);
  assert.equal(flow.state().phase, 'unconfirmed');
  const n = calls.creation;
  await clock.advance(120000);
  assert.equal(calls.creation, n);
});

// --- Task 8, fix 1: a sessão acabou (sair / outro url) ---

test('abandon while tracking: back to idle, no more vmCreation calls', async () => {
  const { flow, clock, calls } = setup({ create: async () => { throw new ApiError('x', 502); }, creations: [running] });
  await flow.submit(BODY);
  await clock.advance(5000);
  const n = calls.creation;
  flow.abandon();
  assert.equal(flow.state().phase, 'idle');
  await clock.advance(60000);
  assert.equal(calls.creation, n);
});

test('abandon during the POST: the late answer is ignored and a new submit works', async () => {
  let answer;
  let creates = 0;
  const { flow } = setup({ create: () => { creates++; return creates === 1 ? new Promise((r) => { answer = r; }) : Promise.resolve({ vm: { vmid: 2 } }); } });
  const first = flow.submit(BODY);
  flow.abandon();
  answer({ vm: { vmid: 1 } });
  await first;
  assert.equal(flow.state().phase, 'idle');
  const s = await flow.submit(BODY);
  assert.equal(s.phase, 'succeeded');
  assert.equal(s.result.vm.vmid, 2);
});
