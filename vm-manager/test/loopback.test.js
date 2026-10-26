'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startLoopback } = require('../lib/loopback');

const base = (lb) => `http://127.0.0.1:${lb.port}`;

test('code with matching state resolves and answers html', async () => {
  const lb = await startLoopback({ state: 's' });
  const res = await fetch(`${base(lb)}/callback?code=c1&state=s`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('Conectado — pode voltar ao Maestria'));
  assert.deepEqual(await lb.result, { code: 'c1' });
  await assert.rejects(fetch(`${base(lb)}/callback?code=c1&state=s`));
});

test('error with matching state resolves error', async () => {
  const lb = await startLoopback({ state: 's' });
  const res = await fetch(`${base(lb)}/callback?error=expired&state=s`);
  assert.ok((await res.text()).includes('volte ao Maestria'));
  assert.deepEqual(await lb.result, { error: 'expired' });
});

test('wrong state is rejected and keeps waiting', async () => {
  const lb = await startLoopback({ state: 's' });
  const bad = await fetch(`${base(lb)}/callback?code=x&state=zzz`);
  assert.equal(bad.status, 400);
  await fetch(`${base(lb)}/callback?code=ok&state=s`);
  assert.deepEqual(await lb.result, { code: 'ok' });
});

test('other paths 404', async () => {
  const lb = await startLoopback({ state: 's' });
  const res = await fetch(`${base(lb)}/other`);
  assert.equal(res.status, 404);
  lb.close();
  await lb.result;
});

test('times out after timeoutMs', async () => {
  const lb = await startLoopback({ state: 's', timeoutMs: 30 });
  assert.deepEqual(await lb.result, { error: 'timeout' });
});

test('close cancels a pending result', async () => {
  const lb = await startLoopback({ state: 's' });
  lb.close();
  assert.deepEqual(await lb.result, { error: 'cancelled' });
});

test('binds to 127.0.0.1 only', async () => {
  const lb = await startLoopback({ state: 's' });
  assert.equal(lb._server.address().address, '127.0.0.1');
  lb.close();
  await lb.result;
});

test('malformed request url answers 400 and keeps waiting', async () => {
  const net = require('node:net');
  const lb = await startLoopback({ state: 's' });
  const raw = await new Promise((resolve, reject) => {
    const sock = net.connect(lb.port, '127.0.0.1', () => {
      sock.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    sock.on('data', (d) => (data += d));
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
  await fetch(`${base(lb)}/callback?code=ok&state=s`);
  assert.deepEqual(await lb.result, { code: 'ok' });
});

test('correct state without code or error is 400 and keeps waiting', async () => {
  const lb = await startLoopback({ state: 's' });
  const res = await fetch(`${base(lb)}/callback?state=s`);
  assert.equal(res.status, 400);
  await fetch(`${base(lb)}/callback?code=ok&state=s`);
  assert.deepEqual(await lb.result, { code: 'ok' });
});
