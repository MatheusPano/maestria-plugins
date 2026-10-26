'use strict';

// Smoke test do main.js pelo stdio: o teste faz o papel da Maestria (manda
// initialize e command.invoke, responde view.open/view.update) e confere a tela.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { assertNoNull } = require('./helpers');

const MAIN = path.join(__dirname, '..', 'main.js');
const SHELL = path.join(__dirname, '..', 'ui', 'shell.rfwtxt');

/** Uma API de mentira que só sabe /api/auth/me. */
function fakeApi(users) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (req.method === 'GET' && req.url === '/api/auth/me' && users[token]) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: users[token] }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 401, message: 'Unauthorized' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** Sobe o plugin e fala com ele como a janela. */
function startPlugin({ dataDir, url }) {
  const child = spawn(process.execPath, [MAIN], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const bad = [];
  const requests = [];
  const waiters = [];
  const responses = new Map();
  let buf = '';
  let stderr = '';
  let nextId = 1;

  child.stdin.on('error', () => {});
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      lines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        bad.push(line);
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        requests.push(msg);
        let result = null;
        if (msg.method === 'view.open') result = { tabId: 'plugin1' };
        if (msg.method === 'view.update') result = { open: true };
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      } else if (msg.id !== undefined) {
        responses.set(msg.id, msg);
      }
      for (const w of [...waiters]) w();
    }
  });

  function send(method, params, { notify = false } = {}) {
    const msg = { jsonrpc: '2.0', method, params };
    const id = notify ? undefined : `t${nextId++}`;
    if (id) msg.id = id;
    child.stdin.write(JSON.stringify(msg) + '\n');
    return id;
  }

  function waitFor(pred, what, ms = 4000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = pred();
        if (v) {
          if (waiters.includes(check)) waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        if (waiters.includes(check)) waiters.splice(waiters.indexOf(check), 1);
        reject(new Error(`timeout esperando ${what}\nstdout:\n${lines.join('\n')}\nstderr:\n${stderr}`));
      }, ms);
      waiters.push(check);
      check();
    });
  }

  async function call(method, params) {
    const id = send(method, params);
    const res = await waitFor(() => responses.get(id), `resposta de ${method}`);
    assert.equal(res.error, undefined, `${method} falhou: ${JSON.stringify(res.error)}`);
    return res.result;
  }

  /** O `data` da janela principal como a Maestria o guarda (cada chave de cima troca). */
  function mainData() {
    const data = {};
    for (const r of requests) {
      if ((r.method === 'view.open' || r.method === 'view.update') && r.params.viewId === 'vmm' && r.params.data) {
        Object.assign(data, r.params.data);
      }
    }
    return data;
  }

  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.on('exit', resolve));
    send('shutdown', {}, { notify: true });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }

  async function init(extra = {}) {
    await call('initialize', {
      apiVersion: 1,
      blocks: 2,
      pluginId: 'maestria.vm-manager',
      pluginDir: path.dirname(MAIN),
      dataDir,
      permissions: [],
      settings: { url },
      rfw: 2,
      modal: 1,
      ...extra,
    });
  }

  return { child, lines, bad, requests, call, send, waitFor, mainData, stop, init, stderr: () => stderr };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-smoke-'));
}

function seed(dataDir, url, token, user) {
  const now = Date.now();
  fs.writeFileSync(
    path.join(dataDir, 'auth.json'),
    JSON.stringify({ url, token, obtainedAt: now, expiresAt: now + 24 * 3600 * 1000, user }),
    { mode: 0o600 },
  );
}

test('sem token: abrir mostra o login, sem null e só json no stdout', async () => {
  const api = await fakeApi({});
  const dataDir = tmpDir();
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    assert.equal(await p.call('command.invoke', { command: 'abrir', context: {} }), null);
    const open = await p.waitFor(() => p.requests.find((r) => r.method === 'view.open' && r.params.viewId === 'vmm'), 'view.open vmm');
    assert.equal(open.params.title, 'VM Manager');
    assert.equal(open.params.rfw.root, 'root');
    assert.match(open.params.rfw.library, /^import core\.widgets;\nimport maestria;$/m);
    assert.match(open.params.rfw.library, /widget root =/);
    assert.equal(open.params.data.screen, 'login');
    assertNoNull(open.params.data);
    assert.deepEqual(open.params.data.login, { message: '', busy: false });
    assert.deepEqual(open.params.data.nav, []);
    assert.equal(api.seen.length, 0, 'sem token não chama a API');
  } finally {
    await p.stop();
    api.server.close();
  }
  assert.deepEqual(p.bad, [], 'nada fora do protocolo no stdout');
});

test('sem rfw: abrir mostra o aviso em blocos', async () => {
  const dataDir = tmpDir();
  const p = startPlugin({ dataDir, url: 'http://127.0.0.1:9' });
  try {
    await p.init({ rfw: undefined });
    await p.call('command.invoke', { command: 'abrir', context: {} });
    const open = await p.waitFor(() => p.requests.find((r) => r.method === 'view.open'), 'view.open');
    assert.equal(open.params.rfw, undefined);
    assert.equal(open.params.blocks[0].type, 'heading');
    assert.equal(open.params.blocks[0].text, 'Este Maestria não desenha a tela do VM Manager');
  } finally {
    await p.stop();
  }
  assert.deepEqual(p.bad, []);
});

test('token guardado de admin: abrir chama /auth/me e cai em vms com a nav de admin', async () => {
  const user = { id: 'u1', email: 'arthur@marrow.com.br', name: 'Arthur Fonseca', role: 'admin' };
  const api = await fakeApi({ 'tok-admin-123': user });
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-admin-123', user);
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => api.seen.some((s) => s.url === '/api/auth/me'), '/auth/me');
    await p.waitFor(() => p.mainData().screen === 'vms' && api.seen.length > 0 && p.requests.some((r) => r.method === 'view.update'), 'screen vms');
    const data = p.mainData();
    assertNoNull(data);
    assert.equal(api.seen[0].auth, 'Bearer tok-admin-123');
    assert.deepEqual(data.me, { initials: 'AF', name: 'Arthur Fonseca', email: 'arthur@marrow.com.br', role: 'Admin' });
    const ids = data.nav.flatMap((g) => g.items.map((i) => i.id));
    assert.deepEqual(ids, ['vms', 'create', 'ceph', 'buckets', 'routes', 'users', 'audit']);
    const active = data.nav.flatMap((g) => g.items).filter((i) => i.active).map((i) => i.id);
    assert.deepEqual(active, ['vms']);
  } finally {
    await p.stop();
    api.server.close();
  }
  assert.deepEqual(p.bad, []);
  assert.ok(!p.lines.join('\n').includes('tok-admin-123'), 'o token não aparece no stdout');
  assert.ok(!p.stderr().includes('tok-admin-123'), 'o token não aparece no stderr');
});

test('usuário pendente: abrir cai em pending', async () => {
  const user = { id: 'u2', email: 'novo@marrow.com.br', name: null, role: 'pending' };
  const api = await fakeApi({ 'tok-pend': user });
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-pend', { ...user, role: 'viewer' });
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'pending', 'screen pending');
    const data = p.mainData();
    assertNoNull(data);
    assert.equal(data.me.name, 'novo@marrow.com.br');
    assert.equal(data.me.role, 'Pendente');
  } finally {
    await p.stop();
    api.server.close();
  }
  assert.deepEqual(p.bad, []);
});

test('token recusado (401): volta pro login com o aviso de sessão expirada', async () => {
  const api = await fakeApi({});
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-velho', { id: 'u1', email: 'a@b.c', name: 'A', role: 'admin' });
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'login' && p.mainData().login.message !== '', 'login com aviso');
    const data = p.mainData();
    assertNoNull(data);
    assert.equal(data.login.message, 'Sua sessão expirou. Entre de novo.');
    assert.equal(fs.existsSync(path.join(dataDir, 'auth.json')), false);
  } finally {
    await p.stop();
    api.server.close();
  }
  assert.deepEqual(p.bad, []);
});

test('API fora do ar: tela fatal e o tentar de novo', async () => {
  const dataDir = tmpDir();
  const url = 'http://127.0.0.1:9';
  seed(dataDir, url, 'tok-x', { id: 'u1', email: 'a@b.c', name: 'A', role: 'admin' });
  const p = startPlugin({ dataDir, url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'fatal', 'screen fatal');
    const data = p.mainData();
    assertNoNull(data);
    assert.match(data.fatal.message, /Sem conexão com a API/);
    assert.ok(!data.fatal.message.includes('tok-x'));
  } finally {
    await p.stop();
  }
  assert.deepEqual(p.bad, []);
});

test('sair apaga o auth.json e volta pro login', async () => {
  const user = { id: 'u1', email: 'a@b.c', name: 'Ana Bia', role: 'viewer' };
  const api = await fakeApi({ 'tok-v': user });
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-v', user);
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'vms', 'screen vms');
    const ids = p.mainData().nav.flatMap((g) => g.items.map((i) => i.id));
    assert.deepEqual(ids, ['vms', 'ceph', 'buckets', 'routes'], 'viewer não vê Nova VM, Usuários, Auditoria');
    p.send('view.action', { viewId: 'vmm', action: 'logout', values: {} }, { notify: true });
    await p.waitFor(() => p.mainData().screen === 'login', 'login depois de sair');
    assert.equal(fs.existsSync(path.join(dataDir, 'auth.json')), false);
    assertNoNull(p.mainData());
  } finally {
    await p.stop();
    api.server.close();
  }
  assert.deepEqual(p.bad, []);
});

test('viewer que navega pra tela de admin vê o forbidden', async () => {
  const user = { id: 'u1', email: 'a@b.c', name: 'Ana Bia', role: 'viewer' };
  const api = await fakeApi({ 'tok-v2': user });
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-v2', user);
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'vms', 'screen vms');
    p.send('view.action', { viewId: 'vmm', action: 'nav', values: { to: 'users' } }, { notify: true });
    await p.waitFor(() => p.mainData().screen === 'forbidden', 'forbidden');
    p.send('view.action', { viewId: 'vmm', action: 'nav', values: { to: 'ceph' } }, { notify: true });
    await p.waitFor(() => p.mainData().screen === 'ceph', 'ceph');
    assertNoNull(p.mainData());
  } finally {
    await p.stop();
    api.server.close();
  }
  assert.deepEqual(p.bad, []);
});

test('mudar o url nas configurações volta pro login', async () => {
  const user = { id: 'u1', email: 'a@b.c', name: 'Ana Bia', role: 'admin' };
  const api = await fakeApi({ 'tok-u': user });
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-u', user);
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'vms', 'screen vms');
    p.send('settings.changed', { settings: { url: 'http://127.0.0.1:9' } }, { notify: true });
    await p.waitFor(() => p.mainData().screen === 'login', 'login depois do url novo');
    assertNoNull(p.mainData());
  } finally {
    await p.stop();
    api.server.close();
  }
  assert.deepEqual(p.bad, []);
});

test('shell.rfwtxt: tamanhos em double, chaves e parênteses balanceados', () => {
  const src = fs.readFileSync(SHELL, 'utf8');
  // tira comentários, strings e cores 0x…
  const code = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/0x[0-9a-fA-F]+/g, '0')
    .replace(/\b(maxLines|flex):\s*\d+/g, ''); // os que o rfw lê como int
  const ints = code.match(/(?<![\w.])\d+(?![\w.])/g) || [];
  assert.deepEqual(ints.filter((n) => n !== '0'), [], 'números inteiros no .rfwtxt (use 13.0)');
  for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    assert.equal(code.split(o).length, code.split(c).length, `${o}${c} desbalanceados`);
  }
  assert.ok(!/\bnull\b/.test(code), 'null no .rfwtxt');
  assert.match(src, /^import core\.widgets;\nimport maestria;/m);
});
