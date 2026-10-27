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

// Os dados da API de mentira (as formas do CCS Console).
const VM_JIBRI = {
  vmid: 177, name: 'jibri-1', node: 'pve1', status: 'running', isTemplate: false,
  cores: 2, memoryMiB: 4096, diskGiB: 40, uptimeSeconds: 90000,
  ipConfigured: '192.168.100.80', ipDetected: null, tags: ['prod'],
  cpuUsagePct: 12.4, memUsedMiB: 2048, diskUsedGiB: 10, haState: null, pool: null,
  backupSlot: null, lastBackupAt: null, backupKnown: true, memFromGuest: true,
};
const VM_DB = { ...VM_JIBRI, vmid: 178, name: 'db', status: 'stopped', cpuUsagePct: null, memUsedMiB: null, uptimeSeconds: 0, ipConfigured: null, tags: [], haState: 'started', backupSlot: '02:00', lastBackupAt: new Date().toISOString() };
const OVERVIEW = {
  nodes: { online: 3, total: 3, cpuUsagePct: 20, memUsedGiB: 50, memTotalGiB: 100 },
  vms: { total: 2, running: 1, stopped: 1 },
  storages: [{ storage: 'ceph-vm', type: 'rbd', usedGiB: 1024, totalGiB: 4096, usedPct: 25 }],
  ipam: null,
};
const DETAIL = {
  vm: VM_JIBRI,
  proxmox: {
    vcpus: 2, cores: 2, sockets: 1, cpuType: 'host', memoryProvisionedMiB: 4096, balloonMinMiB: null,
    memUsedMiB: 2048, memSource: 'guest', osType: 'l26', machine: 'q35', boot: 'order=scsi0', agentEnabled: true,
    disks: [{ slot: 'scsi0', storage: 'ceph', sizeGiB: 40 }], networks: [],
  },
  netbox: { id: 7, url: 'https://netbox.example/vm/7', role: null, tenant: null, platform: null, status: 'active', description: null, ips: [], interfaces: [] },
};
const CATALOG = {
  '/api/catalog/defaults': { gateway: '192.168.100.1', cores: 2, memory: 4096, diskGiB: 40, node: 'pve1', template: 'ubuntu', storage: 'ceph', networkBridge: 'vmbr0' },
  '/api/catalog/nodes': [{ name: 'pve1', status: 'online' }, { name: 'pve9', status: 'offline' }],
  '/api/catalog/storages': [{ name: 'ceph', type: 'rbd', supportsImages: true }, { name: 'local', type: 'dir', supportsImages: true }],
  '/api/catalog/templates': [{ vmid: 9000, name: 'ubuntu', node: 'pve1' }],
  '/api/ipam/next-free': ['192.168.100.81/24'],
};

/**
 * Uma API de mentira: /api/auth/me pelos tokens de `users`; `failMe` respostas 503 antes;
 * `extra` outras rotas GET (por caminho, sem a query; /api/vms e /api/overview já vêm);
 * `routes` respostas por "MÉTODO /caminho": `(req, body) => ({ status?, json?, delayMs? })`.
 */
function fakeApi(users, { failMe = 0, extra = {}, routes = {}, publicRoutes = {} } = {}) {
  const seen = [];
  let fails = failMe;
  const gets = {
    '/api/vms': [VM_JIBRI, VM_DB],
    '/api/overview': OVERVIEW,
    // Ceph e buckets vazios por padrão (uma rota que falta vira 401 e derruba a sessão).
    '/api/health': { status: 'ok', ceph: { enabled: true } },
    '/api/storage/pools': [],
    '/api/storage/trash': [],
    '/api/buckets': [],
    ...extra,
  };
  const reply = (res, status, json) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(json === undefined ? '' : JSON.stringify(json));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const pathname = req.url.split('?')[0];
      seen.push({ method: req.method, url: req.url, path: pathname, auth: req.headers.authorization || '', body });
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const open = publicRoutes[`${req.method} ${pathname}`]; // sem token (a troca do code do login)
      const route = routes[`${req.method} ${pathname}`] || open;
      if (route && (users[token] || open)) {
        const r = route(req, body) || {};
        const send = () => reply(res, r.status || 200, r.json === undefined ? undefined : r.raw ? r.json : { data: r.json });
        if (r.delayMs) setTimeout(send, r.delayMs);
        else send();
        return;
      }
      if (req.method === 'GET' && gets[pathname] !== undefined && users[token]) return reply(res, 200, { data: gets[pathname] });
      if (req.method === 'GET' && pathname === '/api/auth/me' && fails > 0) {
        fails--;
        return reply(res, 503, { statusCode: 503, message: 'Service Unavailable' });
      }
      if (req.method === 'GET' && pathname === '/api/auth/me' && users[token]) return reply(res, 200, { data: users[token] });
      return reply(res, 401, { statusCode: 401, message: 'Unauthorized' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** Fecha a API de mentira de vez, até as conexões keep-alive (senão o processo do teste não sai). */
function closeApi(api) {
  api.server.close();
  if (api.server.closeAllConnections) api.server.closeAllConnections();
}

/** Sobe o plugin e fala com ele como a janela. */
// `script`: código rodado depois do require do main.js (com `m` = o módulo), pra ligar telas de mentira.
// `openReply()`: o `open` que a janela responde a cada view.update.
// `env`: variáveis a mais (os ganchos de teste do main.js, como VMM_CREATE_TIMEOUT_MS).
// `failMethods`: pedidos do plugin que a janela responde com erro (um clipboard.write que falha).
// `windowReply(viewId)`: o `open` que a janela responde a um view.update de uma janela de blocos.
function startPlugin({ dataDir, url, script = '', openReply = () => true, windowReply = () => true, env = {}, failMethods = [] }) {
  const argv = script ? ['-e', `const m = require(${JSON.stringify(MAIN)});\n${script}`] : [MAIN];
  const child = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
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
        if (msg.method === 'view.update') result = { open: msg.params.viewId === 'vmm' ? openReply() : windowReply(msg.params.viewId) };
        const reply = failMethods.includes(msg.method)
          ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'falhou' } }
          : { jsonrpc: '2.0', id: msg.id, result };
        child.stdin.write(JSON.stringify(reply) + '\n');
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
      // Confere a cada linha do plugin e também de 20 em 20 ms (o que vem da API de mentira não passa pelo stdout).
      const check = () => {
        const v = pred();
        if (v) {
          if (waiters.includes(check)) waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          clearInterval(tick);
          resolve(v);
        }
      };
      const tick = setInterval(check, 20);
      const timer = setTimeout(() => {
        clearInterval(tick);
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
      textInput: 1,
      ...extra,
    });
  }

  /** Os blocos que a janela `viewId` mostra agora (o último view.open/view.update com blocos). */
  function windowBlocks(viewId) {
    let blocks = null;
    for (const r of requests) {
      if ((r.method === 'view.open' || r.method === 'view.update') && r.params.viewId === viewId && r.params.blocks) blocks = r.params.blocks;
    }
    return blocks;
  }

  /** Um clique na janela: manda o view.action. */
  function act(viewId, action, values = {}) {
    send('view.action', { viewId, action, values }, { notify: true });
  }

  return { child, lines, bad, requests, call, send, act, waitFor, mainData, windowBlocks, stop, init, stderr: () => stderr };
}

// Os dataDir de cada teste somem no fim dele (sem deixar /tmp/vmm-smoke-* pra trás).
const made = [];
test.afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-smoke-'));
  made.push(dir);
  return dir;
}

function seed(dataDir, url, token, user, { obtainedAt = Date.now(), expiresAt = obtainedAt + 24 * 3600 * 1000 } = {}) {
  fs.writeFileSync(
    path.join(dataDir, 'auth.json'),
    JSON.stringify({ url, token, obtainedAt, expiresAt, user }),
    { mode: 0o600 },
  );
}

test('sem token: abrir mostra o login, sem null e só json no stdout', { timeout: 15000 }, async () => {
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
    closeApi(api);
  }
  assert.deepEqual(p.bad, [], 'nada fora do protocolo no stdout');
});

test('sem rfw: abrir mostra o aviso em blocos', { timeout: 15000 }, async () => {
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

test('token guardado de admin: abrir chama /auth/me e cai em vms com a nav de admin', { timeout: 15000 }, async () => {
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
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
  assert.ok(!p.lines.join('\n').includes('tok-admin-123'), 'o token não aparece no stdout');
  assert.ok(!p.stderr().includes('tok-admin-123'), 'o token não aparece no stderr');
});

test('usuário pendente: abrir cai em pending', { timeout: 15000 }, async () => {
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
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('token recusado (401): volta pro login com o aviso de sessão expirada', { timeout: 15000 }, async () => {
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
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('API fora do ar: tela fatal com a mensagem, sem o token', { timeout: 15000 }, async () => {
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

test('tentar de novo: a API volta e a tela sai do fatal', { timeout: 15000 }, async () => {
  const user = { id: 'u1', email: 'a@b.c', name: 'A', role: 'admin' };
  const api = await fakeApi({ 'tok-r': user }, { failMe: 1 });
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-r', user);
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'fatal', 'screen fatal');
    assert.equal(p.mainData().fatal.message, 'Service Unavailable');
    p.send('view.action', { viewId: 'vmm', action: 'retry', values: {} }, { notify: true });
    await p.waitFor(() => p.mainData().screen === 'vms', 'vms depois do tentar de novo');
    assert.equal(api.seen.filter((r) => r.url === '/api/auth/me').length, 2);
    assertNoNull(p.mainData());
  } finally {
    await p.stop();
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('sair apaga o auth.json e volta pro login', { timeout: 15000 }, async () => {
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
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('viewer que navega pra tela de admin vê o forbidden', { timeout: 15000 }, async () => {
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
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('mudar o url nas configurações volta pro login', { timeout: 15000 }, async () => {
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
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('shell.rfwtxt: tamanhos em double, chaves e parênteses balanceados', { timeout: 15000 }, () => {
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
  assert.ok(!/args\.children\b/.test(code), 'lista de widgets por args (use um child só)');
  assert.match(src, /^import core\.widgets;\nimport maestria;/m);
});

// Uma tela de mentira que faz polling de /api/vms a cada 40 ms enquanto está na vista.
const POLL_SCREEN = `
  m.registerScreen('vms', {
    onEnter: (ctx) => ctx.poller.loop('vms', 40, async () => { await ctx.api.vms(); await ctx.render(); }),
    onLeave: (ctx) => ctx.poller.stop('vms'),
    view: () => ({ ticks: 1 }),
  });
  m.registerScreen('ceph', {
    onEnter: (ctx) => ctx.poller.loop('ceph', 40, async () => { await ctx.api.vms(); await ctx.render(); }),
    onLeave: (ctx) => ctx.poller.stop('ceph'),
  });
`;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera `get()` ficar `quietMs` sem mudar (conferindo de 20 em 20 ms); desiste em `ms`. */
async function waitStable(get, quietMs, what, ms = 5000) {
  const end = Date.now() + ms;
  let last = get();
  let since = Date.now();
  while (Date.now() < end) {
    await pause(20);
    const v = get();
    if (v !== last) {
      last = v;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return v;
  }
  throw new Error(`não assentou: ${what}`);
}

test('janela fechada (open:false) para o polling e não liga outro até reabrir', { timeout: 15000 }, async () => {
  const user = { id: 'u1', email: 'a@b.c', name: 'A', role: 'admin' };
  const api = await fakeApi({ 'tok-p': user }, { extra: { '/api/vms': [] } });
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-p', user);
  let open = true;
  const p = startPlugin({ dataDir, url: api.url, script: POLL_SCREEN, openReply: () => open });
  const polls = () => api.seen.filter((r) => r.url === '/api/vms').length;
  const updates = () => p.requests.filter((r) => r.method === 'view.update').length;
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => polls() >= 3, 'polling de /api/vms');
    open = false; // a pessoa fechou a janela
    // O tick que estava no ar ainda termina; espera a contagem parar de vez (10
    // intervalos de 40 ms sem mudar) em vez de uma pausa fixa, que falhava com a máquina carregada.
    const pollsAfter = await waitStable(() => polls() * 1000 + updates(), 400, 'polling parado com a janela fechada').then(() => polls());
    const updatesAfter = updates();
    await pause(300);
    assert.equal(polls(), pollsAfter, 'sem polling com a janela fechada');
    assert.equal(updates(), updatesAfter, 'sem view.update com a janela fechada');

    // navegar com a janela fechada não liga o poller da outra tela
    p.send('view.action', { viewId: 'vmm', action: 'nav', values: { to: 'ceph' } }, { notify: true });
    await p.waitFor(() => api.seen.filter((r) => r.url === '/api/auth/me').length >= 2, '/auth/me do nav');
    await waitStable(() => api.seen.length, 400, 'nav com a janela fechada assentou');
    assert.equal(polls(), pollsAfter, 'onEnter não roda com a janela fechada');

    // reabrir liga de novo
    open = true;
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => polls() >= pollsAfter + 2, 'polling de volta depois de reabrir');
  } finally {
    await p.stop();
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('nova vm… de um viewer com a janela fechada dá o recado', { timeout: 15000 }, async () => {
  const user = { id: 'u1', email: 'a@b.c', name: 'A', role: 'viewer' };
  const api = await fakeApi({ 'tok-n': user });
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-n', user);
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'nova', context: {} });
    const b = await p.waitFor(() => p.requests.find((r) => r.method === 'window.showBanner'), 'banner');
    assert.equal(b.params.text, 'Só admins podem fazer isso.');
    assert.equal(p.requests.some((r) => r.method === 'view.open'), false);
  } finally {
    await p.stop();
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('nova vm… de um pendente com a janela fechada dá o recado', { timeout: 15000 }, async () => {
  const user = { id: 'u1', email: 'a@b.c', name: 'A', role: 'pending' };
  const api = await fakeApi({ 'tok-q': user });
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-q', user);
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'nova', context: {} });
    const b = await p.waitFor(() => p.requests.find((r) => r.method === 'window.showBanner'), 'banner');
    assert.equal(b.params.text, 'Acesso pendente de aprovação.');
  } finally {
    await p.stop();
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('router: numa janela de blocos, values.action não sequestra a ação', { timeout: 15000 }, async () => {
  const dataDir = tmpDir();
  const script = `
    m.on('pick', (arg) => m.banner('pick:' + arg));
    m.on('evil', () => m.banner('evil'));
  `;
  const p = startPlugin({ dataDir, url: 'http://127.0.0.1:9', script });
  try {
    await p.init();
    p.send('view.action', { viewId: 'form', action: 'pick:1', values: { action: 'evil', a: 'evil' } }, { notify: true });
    p.send('view.action', { viewId: 'vmm', action: 'act', values: { a: 'pick:2' } }, { notify: true });
    await p.waitFor(() => p.requests.filter((r) => r.method === 'window.showBanner').length >= 2, 'banners');
    assert.deepEqual(p.requests.filter((r) => r.method === 'window.showBanner').map((r) => r.params.text), ['pick:1', 'pick:2']);
  } finally {
    await p.stop();
  }
  assert.deepEqual(p.bad, []);
});

// --- Task 8: Máquinas virtuais e Nova VM ---------------------------------------------

const ADMIN = { id: 'u1', email: 'a@b.c', name: 'Ana Admin', role: 'admin' };
const VIEWER = { id: 'u2', email: 'v@b.c', name: 'Vera Viewer', role: 'viewer' };

/** Um plugin já logado (admin por padrão) com a tela de VMs aberta. */
// `open: false` só sobe e inicializa (a janela principal fica fechada).
async function openVms({ user = ADMIN, routes = {}, extra = {}, env = {}, open = true, failMethods = [], windowReply } = {}) {
  const token = `tok-${user.role}-${Math.random().toString(36).slice(2)}`;
  const api = await fakeApi({ [token]: user }, { routes, extra: { ...CATALOG, '/api/vms/177': DETAIL, ...extra } });
  const dataDir = tmpDir();
  seed(dataDir, api.url, token, user);
  const p = startPlugin({ dataDir, url: api.url, env, failMethods, windowReply });
  const close = async () => {
    await p.stop();
    closeApi(api);
  };
  try {
    await p.init();
    if (open) {
      await p.call('command.invoke', { command: 'abrir', context: {} });
      await p.waitFor(() => {
        const d = p.mainData();
        return d.screen === 'vms' && d.vms && d.vms.rows && d.vms.rows.length === 2 && d.vms.overview && d.vms.overview.loaded;
      }, 'tela vms com as linhas e o overview');
    }
  } catch (e) {
    // Sem isso, um passo que falha aqui deixa o servidor e o main.js de pé e o node --test pendurado.
    await close();
    throw e;
  }
  const count = (method, path) => api.seen.filter((r) => r.method === method && r.path === path).length;
  return { p, api, count, close, token, dataDir };
}

const blockTexts = (blocks) => {
  const out = [];
  const walk = (bs) => (bs || []).forEach((b) => {
    if (b.text) out.push(b.text);
    if (b.label) out.push(b.label);
    if (b.title) out.push(b.title);
    if (b.children) walk(b.children);
  });
  walk(blocks);
  return out;
};
const findBlock = (blocks, pred) => {
  let hit = null;
  const walk = (bs) => (bs || []).forEach((b) => {
    if (!hit && pred(b)) hit = b;
    if (b.children) walk(b.children);
  });
  walk(blocks);
  return hit;
};

test('vms (admin): linhas, overview e ações na tela, sem null', { timeout: 15000 }, async () => {
  const { p, close } = await openVms();
  try {
    const v = p.mainData().vms;
    assertNoNull(p.mainData());
    assert.equal(v.header.title, 'Máquinas virtuais');
    assert.equal(v.header.newVm, true);
    assert.deepEqual(v.rows.map((r) => r.vmid), [177, 178]);
    assert.equal(v.rows[0].actions.primary.a, 'vm:stop:177');
    assert.equal(v.rows[1].actions.primary.a, 'vm:start:178');
    assert.equal(v.rows[0].actions.hasMenu, true);
    assert.equal(v.overview.cluster.aside, '3 de 3 nodes');
    assert.equal(v.overview.ipam.text, 'NetBox indisponível');
    assert.deepEqual(v.filters.map((f) => f.label), ['Todas', 'Ligadas', 'Desligadas', 'Backup a revisar · 1']);
    // filtro e busca (no enter)
    p.act('vmm', 'act', { a: 'vm:filter:stopped' });
    await p.waitFor(() => p.mainData().vms.rows.length === 1 && p.mainData().vms.rows[0].vmid === 178, 'filtro desligadas');
    p.act('vmm', 'act', { a: 'vm:filter:all' });
    p.act('vmm', 'act', { a: 'vm:search', text: 'JIBRI' });
    await p.waitFor(() => p.mainData().vms.rows.length === 1 && p.mainData().vms.rows[0].vmid === 177, 'busca jibri');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('vms (viewer): sem ações, "Somente leitura", e uma ação forjada não chama a API', { timeout: 15000 }, async () => {
  const { p, close, api } = await openVms({ user: VIEWER, routes: { 'POST /api/vms/177/stop': () => ({ json: {} }) } });
  try {
    const v = p.mainData().vms;
    assertNoNull(p.mainData());
    assert.equal(v.header.badge, 'Somente leitura');
    assert.equal(v.header.newVm, false);
    assert.ok(v.rows.every((r) => !('actions' in r)), 'viewer sem ações');
    p.act('vmm', 'act', { a: 'vm:stop:177' });
    p.act('vmm', 'act', { action: 'vm:destroy:177' });
    // o detalhe abre pra viewer
    p.act('vmm', 'act', { a: 'vm:open:177' });
    await p.waitFor(() => blockTexts(p.windowBlocks('vm:177')).includes('Provisionamento'), 'detalhe do viewer');
    assert.equal(api.seen.filter((r) => r.method !== 'GET').length, 0, 'nenhuma escrita');
    assert.equal(p.windowBlocks('vm:destroy'), null, 'sem confirmação de destruir');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('ação de linha: passa pelo busy ("Aguarde…") e o clique duplo manda UM POST', { timeout: 15000 }, async () => {
  const { p, close, count } = await openVms({
    routes: { 'POST /api/vms/177/stop': () => ({ json: { ok: true }, delayMs: 300 }) },
  });
  try {
    const before = count('GET', '/api/vms');
    p.act('vmm', 'act', { a: 'vm:stop:177' });
    p.act('vmm', 'act', { a: 'vm:stop:177' });
    p.act('vmm', 'act', { action: 'vm:ha:177' });
    await p.waitFor(() => p.mainData().vms.rows[0].busyAction === 'stop', 'linha ocupada');
    const row = p.mainData().vms.rows[0];
    assert.equal(row.actions.primary.text, 'Aguarde…');
    assert.equal(row.actions.hasMenu, false);
    await p.waitFor(() => p.mainData().vms.rows[0].busyAction === '', 'linha livre de novo', 3000);
    assert.equal(count('POST', '/api/vms/177/stop'), 1, 'um POST só');
    assert.equal(count('POST', '/api/vms/177/ha'), 0, 'a outra ação foi ignorada enquanto ocupada');
    assert.ok(count('GET', '/api/vms') > before, 'recarrega a lista depois da ação');
    assertNoNull(p.mainData());
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('ação de linha com erro: o banner vermelho na tela traz "<nome>: <mensagem>"', { timeout: 15000 }, async () => {
  const { p, close } = await openVms({
    routes: { 'POST /api/vms/178/start': () => ({ status: 409, json: { statusCode: 409, message: 'Node sem memória' }, raw: true }) },
  });
  try {
    p.act('vmm', 'act', { a: 'vm:start:178' });
    await p.waitFor(() => p.mainData().vms.error === 'db: Node sem memória', 'erro na tela');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('destruir: nome errado não manda DELETE; o nome certo manda um', { timeout: 15000 }, async () => {
  const { p, close, count } = await openVms({ routes: { 'DELETE /api/vms/177': () => ({ json: { ok: true } }) } });
  try {
    p.act('vmm', 'act', { action: 'vm:destroy:177' });
    await p.waitFor(() => p.windowBlocks('vm:destroy'), 'janela de confirmação');
    const open = p.requests.find((r) => r.method === 'view.open' && r.params.viewId === 'vm:destroy');
    assert.equal(open.params.modal, true);
    const b = p.windowBlocks('vm:destroy');
    assertNoNull(b);
    assert.equal(b[0].text, 'Destruir jibri-1?');
    p.act('vm:destroy', 'vm:confirm:177', { confirm: 'jibri' });
    await p.waitFor(() => blockTexts(p.windowBlocks('vm:destroy')).includes('Digite jibri-1 para confirmar.'), 'erro do nome');
    await pause(150);
    assert.equal(count('DELETE', '/api/vms/177'), 0, 'nome errado não chama a API');
    p.act('vm:destroy', 'vm:confirm:177', { confirm: '  jibri-1 ' });
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.close' && r.params.viewId === 'vm:destroy'), 'fecha a confirmação');
    await p.waitFor(() => count('DELETE', '/api/vms/177') === 1, 'um DELETE');
    p.act('vm:destroy', 'vm:confirm:177', { confirm: 'jibri-1' }); // um enter atrasado depois de fechar
    await pause(200);
    assert.equal(count('DELETE', '/api/vms/177'), 1, 'continua um DELETE');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('detalhes: abre com "Carregando…" e mostra as seções e o link do NetBox', { timeout: 15000 }, async () => {
  const { p, close, count } = await openVms({ routes: { 'GET /api/vms/177': () => ({ json: DETAIL, delayMs: 200 }) } });
  try {
    p.act('vmm', 'act', { a: 'vm:open:177' });
    const open = await p.waitFor(() => p.requests.find((r) => r.method === 'view.open' && r.params.viewId === 'vm:177'), 'abre o detalhe');
    assert.deepEqual(open.params.blocks, [{ type: 'text', style: 'dim', text: 'Carregando…' }]);
    await p.waitFor(() => blockTexts(p.windowBlocks('vm:177')).includes('NetBox'), 'seções');
    const b = p.windowBlocks('vm:177');
    assertNoNull(b);
    assert.ok(findBlock(b, (x) => x.type === 'markdown' && x.text.includes('https://netbox.example/vm/7')));
    assert.equal(count('GET', '/api/vms/177'), 1);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

/** Abre a "Nova VM" (pelo botão do topo) e espera o formulário com o catálogo. */
async function openCreate(p) {
  p.act('vmm', 'nav', { to: 'create' });
  await p.waitFor(() => findBlock(p.windowBlocks('create'), (b) => b.action === 'create:submit'), 'formulário da Nova VM');
  await p.waitFor(() => blockTexts(p.windowBlocks('create')).includes('192.168.100.81/24'), 'IP automático');
  return p.windowBlocks('create');
}

const FORM_VALUES = {
  name: 'nova-1', ipAuto: true, ipCidr: '', gateway: '192.168.100.1', cores: '2', memory: '4096', diskGiB: '40',
  node: 'pve1', storage: 'ceph', template: 'ubuntu', sshKeys: '', startAfterCreate: true, backup: true, ha: true,
};
const RESULT = { vm: { ...VM_JIBRI, vmid: 300, name: 'nova-1', ipConfigured: '192.168.100.81/24' }, netbox: { id: 9, url: 'https://netbox.example/vm/9' }, backupSlot: '03:00', ha: true, warnings: [] };

test('Nova VM: abre com o catálogo, os padrões e o IP automático', { timeout: 15000 }, async () => {
  const { p, close, count } = await openVms();
  try {
    const b = await openCreate(p);
    assertNoNull(b);
    const open = p.requests.find((r) => r.method === 'view.open' && r.params.viewId === 'create');
    assert.equal(open.params.title, 'Nova VM');
    assert.equal(open.params.modal, true);
    const node = findBlock(b, (x) => x.id === 'node');
    assert.deepEqual(node.options, [{ value: 'pve1', label: 'pve1' }]);
    assert.equal(node.value, 'pve1');
    assert.deepEqual(findBlock(b, (x) => x.id === 'storage').options, [{ value: 'ceph', label: 'ceph' }]);
    assert.equal(findBlock(b, (x) => x.id === 'gateway').value, '192.168.100.1');
    assert.ok(blockTexts(b).includes('Bridge vmbr0'));
    for (const path of ['/api/catalog/defaults', '/api/catalog/nodes', '/api/catalog/templates', '/api/catalog/storages']) assert.equal(count('GET', path), 1, path);
    // o modo manual: verificar e sugerir mantêm o que foi digitado
    p.act('create', 'create:ipmode', { ...FORM_VALUES, name: 'digitado', ipAuto: false });
    await p.waitFor(() => findBlock(p.windowBlocks('create'), (x) => x.id === 'ipCidr'), 'campo do IP manual');
    assert.equal(findBlock(p.windowBlocks('create'), (x) => x.id === 'name').value, 'digitado');
    p.act('create', 'create:suggest', { ...FORM_VALUES, name: 'digitado', ipAuto: false });
    await p.waitFor(() => findBlock(p.windowBlocks('create'), (x) => x.id === 'ipCidr').value === '192.168.100.81/24', 'IP sugerido');
    // validação no submit: nome vazio e gateway inválido, sem POST
    p.act('create', 'create:submit', { ...FORM_VALUES, name: ' ', gateway: '1.2.3' });
    await p.waitFor(() => blockTexts(p.windowBlocks('create')).some((t) => t.includes('Informe o nome.') && t.includes(' · Gateway deve ser um IPv4')), 'erros de validação');
    assert.equal(count('POST', '/api/vms'), 0);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('dois create:submit seguidos mandam UM POST /vms', { timeout: 15000 }, async () => {
  const { p, close, count, api } = await openVms({ routes: { 'POST /api/vms': () => ({ json: RESULT, delayMs: 300 }) } });
  try {
    await openCreate(p);
    p.act('create', 'create:submit', FORM_VALUES);
    p.act('create', 'create:submit', FORM_VALUES);
    await p.waitFor(() => blockTexts(p.windowBlocks('create')).includes('Provisionando…'), 'provisionando');
    p.act('create', 'create:submit', FORM_VALUES); // o enter no meio do POST
    await p.waitFor(() => blockTexts(p.windowBlocks('create')).includes('VM criada 🎉'), 'sucesso');
    await pause(150);
    assert.equal(count('POST', '/api/vms'), 1, 'um POST só');
    const post = api.seen.find((r) => r.method === 'POST' && r.path === '/api/vms');
    assert.equal(post.body.name, 'nova-1');
    assert.equal('ipCidr' in post.body, false, 'automático: a API aloca o IP');
    assertNoNull(p.windowBlocks('create'));
    // "Ver todas as VMs" fecha a janela e volta pra lista
    p.act('create', 'create:done', {});
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.close' && r.params.viewId === 'create'), 'fecha a Nova VM');
    assert.equal(p.mainData().screen, 'vms');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('POST que estoura o timeout: acompanha, "nova vm…" no meio não reenvia, e mostra o resultado real', { timeout: 15000 }, async () => {
  let done = false;
  const { p, close, count } = await openVms({
    env: { VMM_CREATE_TIMEOUT_MS: '200', VMM_CREATE_POLL_MS: '60' },
    routes: {
      'POST /api/vms': () => ({ json: RESULT, delayMs: 1500 }), // o proxy segura além do timeout do cliente
      'GET /api/vms/creations/nova-1': () => ({
        json: done
          ? { status: 'succeeded', startedAt: '', finishedAt: '', result: RESULT, error: null }
          : { status: 'running', startedAt: '', finishedAt: null, result: null, error: null },
      }),
    },
  });
  try {
    await openCreate(p);
    p.act('create', 'create:submit', FORM_VALUES);
    await p.waitFor(() => blockTexts(p.windowBlocks('create')).includes('criando… (acompanhando)'), 'acompanhando', 3000);
    await p.waitFor(() => count('GET', '/api/vms/creations/nova-1') >= 1, 'consulta a criação');
    // nova vm… durante a criação: mostra o acompanhamento, sem formulário e sem POST
    const opens = p.requests.filter((r) => r.method === 'view.open' && r.params.viewId === 'create').length;
    await p.call('command.invoke', { command: 'nova', context: {} });
    await p.waitFor(() => p.requests.filter((r) => r.method === 'view.open' && r.params.viewId === 'create').length > opens, 'reabre a Nova VM');
    const again = p.requests.filter((r) => r.method === 'view.open' && r.params.viewId === 'create').pop();
    assert.ok(blockTexts(again.params.blocks).includes('criando… (acompanhando)'));
    assert.equal(findBlock(again.params.blocks, (b) => b.action === 'create:submit'), null, 'sem o botão de criar');
    p.act('create', 'create:submit', FORM_VALUES);
    done = true;
    await p.waitFor(() => blockTexts(p.windowBlocks('create')).includes('VM criada 🎉'), 'o resultado real', 3000);
    assert.ok(JSON.stringify(p.windowBlocks('create')).includes('registrado (#9)'));
    await pause(1500); // a resposta atrasada do proxy chega e não muda nada
    assert.equal(count('POST', '/api/vms'), 1, 'um POST só');
    assert.ok(blockTexts(p.windowBlocks('create')).includes('VM criada 🎉'));
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('janela da Nova VM fechada: o fim da criação vira banner', { timeout: 15000 }, async () => {
  const { p, close } = await openVms({ routes: { 'POST /api/vms': () => ({ status: 400, json: { statusCode: 400, message: 'Sem espaço no storage' }, raw: true, delayMs: 200 }) } });
  try {
    await openCreate(p);
    p.act('create', 'create:submit', FORM_VALUES);
    p.send('event', { type: 'view.closed', viewId: 'create' }, { notify: true });
    const b = await p.waitFor(() => p.requests.find((r) => r.method === 'window.showBanner'), 'banner');
    assert.equal(b.params.text, 'Falhou ao criar nova-1: Sem espaço no storage');
    // reabrir mostra o formulário com o erro e deixa criar de novo
    await p.call('command.invoke', { command: 'nova', context: {} });
    await p.waitFor(() => {
      const o = p.requests.filter((r) => r.method === 'view.open' && r.params.viewId === 'create').pop();
      return o && blockTexts(o.params.blocks).includes('Sem espaço no storage') && findBlock(o.params.blocks, (x) => x.action === 'create:submit');
    }, 'formulário com o erro');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('vms.rfwtxt: sem import, tamanhos em double e só construções da casca', { timeout: 15000 }, () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'vms.rfwtxt'), 'utf8');
  assert.ok(!/^import /m.test(src), 'tela sem import');
  const code = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/0x[0-9a-fA-F]+/g, '0')
    .replace(/\b(maxLines|flex):\s*\d+/g, '');
  const ints = code.match(/(?<![\w.])\d+(?![\w.])/g) || [];
  assert.deepEqual(ints.filter((n) => n !== '0'), [], 'números inteiros no .rfwtxt (use 13.0)');
  for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) assert.equal(code.split(o).length, code.split(c).length, `${o}${c} desbalanceados`);
  assert.ok(!/\bnull\b/.test(code));
  assert.ok(!/args\.children\b/.test(code));
  assert.match(src, /widget VmsScreen =/);
  assert.match(fs.readFileSync(SHELL, 'utf8'), /"vms": VmsScreen\(\)/);
});

test('a view de vms aguenta ctx.user null (um render logo depois do sair)', { timeout: 15000 }, async () => {
  const dataDir = tmpDir();
  const script = `
    const out = m.screens.get('vms').view({ user: null, now: Date.now });
    process.stderr.write('VIEW=' + JSON.stringify(out) + '\\n');
  `;
  const p = startPlugin({ dataDir, url: 'http://127.0.0.1:9', script });
  try {
    await p.waitFor(() => /VIEW=.*\n/.test(p.stderr()), 'a view no stderr');
    const v = JSON.parse(p.stderr().match(/VIEW=(.*)\n/)[1]);
    assertNoNull(v);
    assert.equal(v.header.readOnly, true);
    assert.equal(v.header.newVm, false);
  } finally {
    await p.stop();
  }
  assert.deepEqual(p.bad, []);
});

// --- Task 8, fix 1 ---------------------------------------------------------------------

test('"Ver todas as VMs" com a janela principal fechada abre ela na lista', { timeout: 15000 }, async () => {
  const { p, close } = await openVms({ open: false, routes: { 'POST /api/vms': () => ({ json: RESULT }) } });
  try {
    await p.call('command.invoke', { command: 'nova', context: {} });
    await p.waitFor(() => findBlock(p.windowBlocks('create'), (b) => b.action === 'create:submit'), 'Nova VM pelo comando');
    assert.equal(p.requests.some((r) => r.method === 'view.open' && r.params.viewId === 'vmm'), false, 'a principal estava fechada');
    p.act('create', 'create:submit', FORM_VALUES);
    await p.waitFor(() => blockTexts(p.windowBlocks('create')).includes('VM criada 🎉'), 'sucesso');
    p.act('create', 'create:done', {});
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.open' && r.params.viewId === 'vmm'), 'abre a janela principal');
    await p.waitFor(() => p.mainData().screen === 'vms' && p.mainData().vms && p.mainData().vms.rows.length === 2, 'na lista');
    assert.ok(p.requests.some((r) => r.method === 'view.close' && r.params.viewId === 'create'));
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('destruir confirmado com a VM ocupada: o erro aparece na janela e não sai DELETE', { timeout: 15000 }, async () => {
  const { p, close, count } = await openVms({
    routes: {
      'POST /api/vms/177/stop': () => ({ json: { ok: true }, delayMs: 800 }),
      'DELETE /api/vms/177': () => ({ json: { ok: true } }),
    },
  });
  try {
    p.act('vmm', 'act', { action: 'vm:destroy:177' });
    await p.waitFor(() => p.windowBlocks('vm:destroy'), 'confirmação');
    p.act('vmm', 'act', { a: 'vm:stop:177' });
    await p.waitFor(() => p.mainData().vms.rows[0].busyAction === 'stop', 'ocupada');
    p.act('vm:destroy', 'vm:confirm:177', { confirm: 'jibri-1' });
    await p.waitFor(() => blockTexts(p.windowBlocks('vm:destroy')).includes('essa VM ainda está no meio de outra ação; espere terminar e confirme de novo.'), 'erro de ocupada');
    assert.equal(findBlock(p.windowBlocks('vm:destroy'), (b) => b.id === 'confirm').value, 'jibri-1', 'o texto digitado fica');
    assert.equal(p.requests.some((r) => r.method === 'view.close' && r.params.viewId === 'vm:destroy'), false, 'a janela fica');
    await p.waitFor(() => p.mainData().vms.rows[0].busyAction === '', 'livre', 3000);
    assert.equal(count('DELETE', '/api/vms/177'), 0);
    p.act('vm:destroy', 'vm:confirm:177', { confirm: 'jibri-1' });
    await p.waitFor(() => count('DELETE', '/api/vms/177') === 1, 'agora sim, um DELETE');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('sair larga a criação (sem banner, sem mais consultas) e o próximo formulário vem limpo', { timeout: 15000 }, async () => {
  const { p, close, count, api, dataDir, token } = await openVms({
    env: { VMM_CREATE_TIMEOUT_MS: '150', VMM_CREATE_POLL_MS: '50' },
    routes: {
      'POST /api/vms': () => ({ json: RESULT, delayMs: 1000 }),
      'GET /api/vms/creations/digitado': () => ({ json: { status: 'running', startedAt: '', finishedAt: null, result: null, error: null } }),
    },
  });
  try {
    await openCreate(p);
    p.act('create', 'create:submit', { ...FORM_VALUES, name: 'digitado' });
    await p.waitFor(() => count('GET', '/api/vms/creations/digitado') >= 2, 'acompanhando');
    p.act('vmm', 'logout', {});
    await p.waitFor(() => p.mainData().screen === 'login', 'login');
    const n = await waitStable(() => count('GET', '/api/vms/creations/digitado'), 300, 'consultas pararam');
    await pause(300);
    assert.equal(count('GET', '/api/vms/creations/digitado'), n, 'sem consultas depois de sair');
    assert.equal(p.requests.some((r) => r.method === 'window.showBanner'), false, 'sem banner pra quem saiu');
    // outra pessoa entra (o auth.json de novo) e abre a Nova VM: formulário limpo
    seed(dataDir, api.url, token, ADMIN);
    await p.call('command.invoke', { command: 'nova', context: {} });
    await p.waitFor(() => {
      const o = p.requests.filter((r) => r.method === 'view.open' && r.params.viewId === 'create').pop();
      const b = o && p.windowBlocks('create');
      return b && findBlock(b, (x) => x.id === 'name') && findBlock(b, (x) => x.action === 'create:submit');
    }, 'formulário novo');
    assert.equal(findBlock(p.windowBlocks('create'), (x) => x.id === 'name').value, '', 'sem o que a outra pessoa digitou');
    assert.equal(count('POST', '/api/vms'), 1);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

// --- Task 10: Ceph, Buckets, "Novo bucket" e "Credenciais S3" ----------------------------

const GB = 1024 ** 3;
const POOLS = [
  { name: 'ceph-small', applications: ['rbd'], storedBytes: 2 * GB, availBytes: 98 * GB, usedPct: 2, objects: 10, proxmoxStorages: [] },
  { name: 'ceph-vm', applications: ['rbd'], storedBytes: 500 * GB, availBytes: 500 * GB, usedPct: 50, objects: 12345, proxmoxStorages: ['ceph'] },
  { name: '.mgr', applications: ['mgr'], storedBytes: 1, availBytes: 1, usedPct: 0, objects: 1, proxmoxStorages: [] },
  { name: 'default.rgw.buckets.data', applications: ['rgw'], storedBytes: 80 * GB, availBytes: 20 * GB, usedPct: 80, objects: 99, proxmoxStorages: [] },
];
const IMAGES_VM = [
  { name: 'vm-177-disk-0', vmName: 'jibri-1', vmid: 177, removing: false, sizeBytes: 40 * GB, usedBytes: 10 * GB, snapshots: 2 },
  { name: 'vm-999-disk-0', vmName: null, vmid: 999, removing: false, sizeBytes: 10 * GB, usedBytes: null, snapshots: 0 },
  { name: 'vm-5-disk-1', vmName: null, vmid: null, removing: true, sizeBytes: 5 * GB, usedBytes: null, snapshots: null },
];
const IMAGES_SMALL = [{ name: 'small-img', vmName: null, vmid: null, removing: false, sizeBytes: GB, usedBytes: GB / 2, snapshots: 0 }];
const TRASH = [{ id: 'a1', name: 'old-disk', pool: 'ceph-vm', source: 'REMOVING', deletedAt: '2026-10-01T12:00:00Z' }];
const CEPH_GETS = {
  '/api/health': { status: 'ok', proxmox: { ok: true }, netbox: { enabled: true }, ceph: { enabled: true, status: 'HEALTH_WARN' } },
  '/api/storage/pools': POOLS,
  '/api/storage/trash': TRASH,
  '/api/storage/pools/ceph-vm/images': IMAGES_VM,
  '/api/storage/pools/ceph-small/images': IMAGES_SMALL,
};

const BUCKETS = [
  { name: 'media', tenant: null, owner: 'uplii', objects: 1500, usedBytes: 3 * GB, quotaBytes: 10 * GB, createdAt: '2026-01-10T00:00:00Z' },
  { name: 'backups', tenant: null, owner: 'ops', objects: 20, usedBytes: 50 * GB, quotaBytes: null, createdAt: '2025-06-01T00:00:00Z' },
  { name: 'logs', tenant: 'acme', owner: 'uplii', objects: 5, usedBytes: GB, quotaBytes: null, createdAt: null },
];
const SECRET = 'S3CR3T-very-secret-key-0123456789abcdef';
const CREDS = { owner: 'uplii', endpoint: 'https://s3.example', region: 'br-1', accessKey: 'AKIAUPLII' };

/** Logado (admin por padrão), na tela `screen` com os dados prontos. */
async function openArea(screen, ready, opts = {}) {
  const ctx = await openVms({ ...opts, extra: { ...CEPH_GETS, '/api/buckets': BUCKETS, ...(opts.extra || {}) } });
  try {
    ctx.p.act('vmm', 'nav', { to: screen });
    await ctx.p.waitFor(() => {
      const d = ctx.p.mainData();
      return d.screen === screen && d[screen] && ready(d[screen]);
    }, `tela ${screen} pronta`);
  } catch (e) {
    await ctx.close();
    throw e;
  }
  return ctx;
}

/** Todos os textos de uma lista de blocos (com os itens de kv e de tabs e os filhos). */
function allTexts(blocks) {
  const out = [];
  const walk = (bs) => (bs || []).forEach((b) => {
    for (const k of ['text', 'label', 'title', 'placeholder', 'value']) if (typeof b[k] === 'string') out.push(b[k]);
    (b.items || []).forEach((i) => {
      for (const k of ['key', 'value', 'label']) if (typeof i[k] === 'string') out.push(i[k]);
    });
    walk(b.children);
  });
  walk(blocks);
  return out;
}
const blockWith = (blocks, pred) => {
  let hit = null;
  const walk = (bs) => (bs || []).forEach((b) => {
    if (!hit && pred(b)) hit = b;
    walk(b.children);
  });
  walk(blocks);
  return hit;
};
const button = (blocks, action) => blockWith(blocks, (b) => b.type === 'button' && b.action === action);

test('ceph: health, pools de dados, imagens do maior rbd e a lixeira, sem null', { timeout: 15000 }, async () => {
  const { p, close, count } = await openArea('ceph', (c) => c.images.rows.length === 3);
  try {
    const c = p.mainData().ceph;
    assertNoNull(p.mainData());
    assert.deepEqual(c.header, { title: 'Ceph', health: 'HEALTH_WARN', tone: 'yellow' });
    assert.deepEqual(c.pools.map((x) => x.name), ['ceph-small', 'ceph-vm', 'default.rgw.buckets.data'], '.mgr fica de fora');
    const vm = c.pools.find((x) => x.name === 'ceph-vm');
    assert.equal(vm.selected, true, 'o maior rbd vem escolhido');
    assert.equal(vm.a, 'ceph:pool:ceph-vm');
    assert.deepEqual(vm.apps, [{ text: 'rbd' }]);
    assert.equal(vm.sub, 'Proxmox: ceph');
    assert.equal(vm.objects, '12.345 obj');
    assert.equal(vm.fill + vm.rest, 1000);
    const rgw = c.pools.find((x) => x.name === 'default.rgw.buckets.data');
    assert.equal(rgw.selectable, false);
    assert.equal(rgw.tone, 'yellow');
    assert.equal(c.images.title, 'Imagens em ceph-vm');
    assert.equal(c.images.countText, '3');
    assert.equal(c.images.searchId, 'ceph.search.ceph-vm');
    assert.deepEqual(c.images.rows.map((r) => r.vm), ['jibri-1', 'sem VM', 'remoção interrompida']);
    assert.equal(c.images.rows[0].vmid, '177');
    assert.equal(c.images.rows[1].used, 'sem dado');
    assert.equal(c.images.rows[2].rowTone, 'red');
    assert.equal(c.trash.visible, true);
    assert.equal(c.trash.countText, '1');
    assert.equal(c.trash.rows[0].tone, 'red');
    assert.equal(c.error, '');
    assert.equal(c.poolsLoading, false);
    for (const path of ['/api/health', '/api/storage/pools', '/api/storage/trash', '/api/storage/pools/ceph-vm/images']) {
      assert.equal(count('GET', path), 1, `${path} uma vez`);
    }
    assert.equal(count('GET', '/api/storage/pools/ceph-small/images'), 0);
    // busca nas imagens (no enter)
    p.act('vmm', 'act', { a: 'ceph:search', text: 'JIBRI' });
    await p.waitFor(() => p.mainData().ceph.images.rows.length === 1, 'busca jibri');
    // sem polling: nada mais da API depois de um tempo
    const before = count('GET', '/api/storage/pools');
    await pause(300);
    assert.equal(count('GET', '/api/storage/pools'), before);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('ceph: trocar de pool recarrega as imagens; pool sem rbd e o mesmo pool não', { timeout: 15000 }, async () => {
  const { p, close, count } = await openArea('ceph', (c) => c.images.rows.length === 3, {
    routes: { 'GET /api/storage/pools/ceph-small/images': () => ({ json: IMAGES_SMALL, delayMs: 200 }) },
  });
  try {
    p.act('vmm', 'act', { a: 'ceph:search', text: 'jibri' });
    await p.waitFor(() => p.mainData().ceph.images.rows.length === 1, 'busca');
    p.act('vmm', 'act', { a: 'ceph:pool:ceph-small' });
    await p.waitFor(() => p.mainData().ceph.images.empty === 'Lendo as imagens do pool, pode levar alguns segundos…', 'lendo');
    await p.waitFor(() => {
      const c = p.mainData().ceph;
      return c.images.title === 'Imagens em ceph-small' && c.images.rows.length === 1 && c.images.rows[0].name === 'small-img';
    }, 'imagens do ceph-small');
    const c = p.mainData().ceph;
    assert.equal(c.pools.find((x) => x.name === 'ceph-small').selected, true);
    assert.equal(c.pools.find((x) => x.name === 'ceph-vm').selected, false);
    assert.equal(c.images.searchId, 'ceph.search.ceph-small', 'a busca recomeça no pool novo');
    assertNoNull(p.mainData());
    assert.equal(count('GET', '/api/storage/pools/ceph-small/images'), 1);
    p.act('vmm', 'act', { a: 'ceph:pool:ceph-small' });
    p.act('vmm', 'act', { a: 'ceph:pool:default.rgw.buckets.data' });
    p.act('vmm', 'act', { a: 'ceph:pool:nao-existe' });
    await pause(250);
    assert.equal(count('GET', '/api/storage/pools/ceph-small/images'), 1, 'o mesmo pool não recarrega');
    assert.equal(count('GET', '/api/storage/pools/default.rgw.buckets.data/images'), 0, 'rgw não tem imagens');
    assert.equal(p.mainData().ceph.images.title, 'Imagens em ceph-small');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('ceph: erro nos pools aparece na tela, erro do health some quieto, erro da lixeira vira "Lixeira: …"', { timeout: 15000 }, async () => {
  const fail = (message) => () => ({ status: 500, json: { statusCode: 500, message }, raw: true });
  const { p, close } = await openArea('ceph', (c) => c.error !== '' && c.trash.error !== '', {
    routes: {
      'GET /api/health': fail('health caiu'),
      'GET /api/storage/pools': fail('Ceph fora do ar'),
      'GET /api/storage/trash': fail('rbd trash falhou'),
    },
  });
  try {
    const c = p.mainData().ceph;
    assertNoNull(p.mainData());
    assert.equal(c.error, 'Ceph fora do ar');
    assert.equal(c.poolsLoading, false);
    assert.equal(c.header.health, '');
    assert.equal(c.trash.error, 'Lixeira: rbd trash falhou');
    assert.equal(c.trash.visible, false);
    assert.equal(c.images.visible, false);
    assert.equal(p.mainData().screen, 'ceph', 'não vira a tela fatal');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('buckets: stats, ordenação que alterna, busca, e o admin vê o "Novo bucket"', { timeout: 15000 }, async () => {
  const { p, close, count } = await openArea('buckets', (b) => b.rows.length === 3);
  try {
    const b = p.mainData().buckets;
    assertNoNull(p.mainData());
    assert.equal(b.header.newBucket, true);
    assert.equal(b.header.readOnly, false);
    assert.deepEqual(b.stats.map((s) => s.label), ['Buckets', 'Usado', 'Objetos', 'Donos']);
    assert.deepEqual(b.stats.map((s) => s.value), ['3', '54 GB', '1.525', '2']);
    assert.deepEqual(b.rows.map((r) => r.name), ['backups', 'media', 'logs'], 'sem tenant primeiro, por nome');
    assert.equal(b.rows[2].tenantText, 'acme/');
    assert.equal(b.rows[1].quota, '30% de 10 GB');
    assert.equal(b.rows[1].a, 'bucket:creds:/media');
    assert.deepEqual(b.columns.map((c) => c.flex), [28, 14, 10, 10, 20, 10]);
    assert.equal(b.columns[0].arrow, '↑');
    // Usado: a primeira vez desc, a segunda asc
    p.act('vmm', 'act', { a: 'bucket:sort:used' });
    await p.waitFor(() => p.mainData().buckets.rows[0].name === 'backups' && p.mainData().buckets.columns[3].dir === 'desc', 'usado desc');
    assert.deepEqual(p.mainData().buckets.rows.map((r) => r.name), ['backups', 'media', 'logs']);
    p.act('vmm', 'act', { a: 'bucket:sort:used' });
    await p.waitFor(() => p.mainData().buckets.columns[3].dir === 'asc', 'usado asc');
    assert.deepEqual(p.mainData().buckets.rows.map((r) => r.name), ['logs', 'media', 'backups']);
    assert.equal(p.mainData().buckets.columns[3].arrow, '↑');
    assert.equal(p.mainData().buckets.columns[0].arrow, '');
    // Cota: sem cota fica no fim
    p.act('vmm', 'act', { a: 'bucket:sort:quota' });
    await p.waitFor(() => p.mainData().buckets.columns[4].dir === 'desc', 'cota desc');
    assert.equal(p.mainData().buckets.rows[0].name, 'media');
    p.act('vmm', 'act', { a: 'bucket:sort:bogus' });
    // busca por dono
    p.act('vmm', 'act', { a: 'bucket:search', text: 'OPS' });
    await p.waitFor(() => p.mainData().buckets.rows.length === 1, 'busca ops');
    assert.equal(p.mainData().buckets.rows[0].name, 'backups');
    assert.equal(p.mainData().buckets.stats[0].value, '3', 'os stats são da lista toda');
    p.act('vmm', 'act', { a: 'bucket:search', text: 'zzz' });
    await p.waitFor(() => p.mainData().buckets.empty === 'Nenhum bucket encontrado.', 'vazio');
    assert.equal(count('GET', '/api/buckets'), 1, 'sem polling');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('buckets (viewer): sem "Novo bucket", credenciais sem secret, e um forjado não chama a API', { timeout: 15000 }, async () => {
  const { p, close, count } = await openArea('buckets', (b) => b.rows.length === 3, {
    user: VIEWER,
    extra: { '/api/buckets/owners/uplii/credentials': CREDS, '/api/buckets/owners/uplii/credentials/secret': { secretKey: SECRET }, '/api/buckets/owners': ['uplii'] },
    routes: { 'POST /api/buckets': () => ({ json: {} }) },
  });
  try {
    const b = p.mainData().buckets;
    assert.equal(b.header.newBucket, false);
    assert.equal(b.header.badge, 'Somente leitura');
    p.act('vmm', 'act', { a: 'bucket:new' });
    p.act('bucket:new', 'bucket:submit', { name: 'x-bucket', owner: 'uplii' });
    p.act('vmm', 'act', { a: 'bucket:creds:/media' });
    const id = 'bucket:creds:uplii';
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('AKIAUPLII'), 'credenciais');
    const blocks = p.windowBlocks(id);
    assertNoNull(blocks);
    const texts = allTexts(blocks);
    assert.ok(texts.includes('Só admins veem a secret key'));
    assert.ok(!button(blocks, 'bucket:reveal'), 'sem Revelar');
    assert.ok(!button(blocks, 'bucket:copy:secret'), 'sem copiar a secret');
    const code = blockWith(blocks, (x) => x.type === 'code');
    assert.ok(!/SECRET_KEY/.test(code.text), 'o snippet do viewer não tem a linha da secret');
    assert.ok(texts.includes('As chaves são do usuário uplii e dão acesso a todos os buckets dele (2).'), 'rodapé sem o conselho de admin');
    // forjados: revelar e copiar a secret
    p.act(id, 'bucket:reveal', {});
    p.act(id, 'bucket:copy:secret', {});
    p.act(id, 'bucket:copy:snippet', {});
    await p.waitFor(() => p.requests.some((r) => r.method === 'clipboard.write'), 'copiou o snippet');
    const clip = p.requests.find((r) => r.method === 'clipboard.write').params.text;
    assert.ok(!/SECRET/.test(clip), 'o snippet copiado pelo viewer não tem a secret');
    await pause(200);
    assert.equal(count('GET', '/api/buckets/owners/uplii/credentials/secret'), 0, 'o viewer nunca busca a secret');
    assert.equal(count('POST', '/api/buckets'), 0);
    assert.equal(count('GET', '/api/buckets/owners'), 0);
    assert.ok(!p.requests.some((r) => r.method === 'view.open' && r.params.viewId === 'bucket:new'), 'sem janela do Novo bucket');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
  assert.ok(!p.lines.join('\n').includes(SECRET));
});

test('credenciais (admin): Revelar busca a secret uma vez, ela só aparece na janela e nunca no stderr', { timeout: 15000 }, async () => {
  const { p, close, count, api } = await openArea('buckets', (b) => b.rows.length === 3, {
    extra: { '/api/buckets/owners/uplii/credentials': CREDS, '/api/buckets/owners/uplii/credentials/secret': { secretKey: SECRET } },
  });
  const id = 'bucket:creds:uplii';
  try {
    p.act('vmm', 'act', { a: 'bucket:creds:/media' });
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('AKIAUPLII'), 'credenciais');
    let blocks = p.windowBlocks(id);
    assertNoNull(blocks);
    const open = p.requests.find((r) => r.method === 'view.open' && r.params.viewId === id);
    assert.equal(open.params.title, 'Credenciais S3');
    assert.equal(open.params.modal, true);
    assert.ok(allTexts(blocks).includes('Bucket media · usuário uplii do RGW'));
    assert.ok(allTexts(blocks).includes('•'.repeat(40)), 'a secret mascarada');
    assert.equal(button(blocks, 'bucket:reveal').label, 'Revelar');
    assert.ok(allTexts(blocks).includes('As chaves são do usuário uplii e dão acesso a todos os buckets dele (2). Para isolar uma aplicação, crie o bucket com um usuário novo.'));
    assert.match(blockWith(blocks, (x) => x.type === 'code').text, /S3_SECRET_KEY=<secret key>/);
    assert.deepEqual(blockWith(blocks, (x) => x.type === 'tabs').items.map((t) => t.label), ['.env', 'AWS CLI', 'rclone']);
    assert.equal(count('GET', '/api/buckets/owners/uplii/credentials/secret'), 0, 'abrir não busca a secret');
    assert.ok(!p.lines.join('\n').includes(SECRET));
    // Revelar
    p.act(id, 'bucket:reveal', {});
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes(SECRET), 'secret revelada');
    blocks = p.windowBlocks(id);
    assert.equal(button(blocks, 'bucket:reveal').label, 'Esconder');
    assert.match(blockWith(blocks, (x) => x.type === 'code').text, new RegExp(`S3_SECRET_KEY=${SECRET}`));
    // A secret no stdout só no view.update da janela das credenciais.
    const leaks = p.lines.filter((l) => l.includes(SECRET)).map((l) => JSON.parse(l));
    assert.ok(leaks.length > 0);
    for (const m of leaks) {
      assert.equal(m.method, 'view.update');
      assert.equal(m.params.viewId, id);
      assert.equal(m.params.data, undefined, 'nunca no data da janela principal');
    }
    // Esconder, Revelar de novo, aba aws: do cache
    p.act(id, 'bucket:reveal', {});
    await p.waitFor(() => button(p.windowBlocks(id), 'bucket:reveal').label === 'Revelar', 'escondida');
    assert.ok(!allTexts(p.windowBlocks(id)).includes(SECRET));
    p.act(id, 'bucket:reveal', {});
    p.act(id, 'bucket:tab:aws', {});
    await p.waitFor(() => /aws_secret_access_key S3CR3T/.test((blockWith(p.windowBlocks(id), (x) => x.type === 'code') || {}).text || ''), 'aba aws com a secret');
    // copiar a secret: do cache, e o "Copiado"
    p.act(id, 'bucket:copy:secret', {});
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('Copiado'), 'copiado');
    assert.equal(p.requests.filter((r) => r.method === 'clipboard.write').pop().params.text, SECRET);
    assert.equal(count('GET', '/api/buckets/owners/uplii/credentials/secret'), 1, 'uma busca só (cache da janela)');
    assert.ok(!api.seen.some((r) => r.method !== 'GET'), 'nada de auditoria local: só GETs');
    // Fechar apaga o cache: reabrir não mostra a secret e um Revelar busca de novo
    p.act(id, 'bucket:close', {});
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.close' && r.params.viewId === id), 'fechou');
    p.act('vmm', 'act', { a: 'bucket:creds:acme/logs' });
    await p.waitFor(() => p.requests.filter((r) => r.method === 'view.open' && r.params.viewId === id).length === 2, 'reabriu');
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('AKIAUPLII'), 'credenciais de novo');
    assert.ok(!allTexts(p.windowBlocks(id)).includes(SECRET));
    assert.ok(allTexts(p.windowBlocks(id)).includes('Bucket logs · usuário uplii do RGW'));
    p.act(id, 'bucket:reveal', {});
    await p.waitFor(() => count('GET', '/api/buckets/owners/uplii/credentials/secret') === 2, 'buscou de novo');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
  assert.ok(!p.stderr().includes(SECRET), 'a secret nunca no stderr');
});

test('credenciais: sem access key some a secret e os snippets; clipboard que falha avisa', { timeout: 15000 }, async () => {
  const { p, close, count } = await openArea('buckets', (b) => b.rows.length === 3, {
    extra: { '/api/buckets/owners/ops/credentials': { owner: 'ops', endpoint: 'https://s3.example', region: 'br-1', accessKey: null } },
    failMethods: ['clipboard.write'],
  });
  const id = 'bucket:creds:ops';
  try {
    p.act('vmm', 'act', { a: 'bucket:creds:/backups' });
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('Este usuário não tem chave S3.'), 'sem chave');
    const blocks = p.windowBlocks(id);
    assertNoNull(blocks);
    assert.ok(!blockWith(blocks, (x) => x.type === 'code'), 'sem snippet');
    assert.ok(!blockWith(blocks, (x) => x.type === 'tabs'), 'sem abas');
    assert.ok(!button(blocks, 'bucket:reveal'));
    assert.ok(!allTexts(blocks).includes('Secret key'));
    p.act(id, 'bucket:reveal', {});
    p.act(id, 'bucket:copy:secret', {});
    p.act(id, 'bucket:copy:snippet', {});
    await pause(150);
    assert.equal(count('GET', '/api/buckets/owners/ops/credentials/secret'), 0, 'sem access key, nem busca a secret');
    // copiar o endpoint com o clipboard falhando: o aviso, e some depois de 1,5 s
    p.act(id, 'bucket:copy:endpoint', {});
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('Não deu para copiar; selecione o texto'), 'aviso de falha');
    assert.equal(p.requests.find((r) => r.method === 'clipboard.write').params.text, 'https://s3.example');
    await p.waitFor(() => !allTexts(p.windowBlocks(id)).includes('Não deu para copiar; selecione o texto'), 'o aviso some', 3000);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('Novo bucket: validação, dois submits mandam UM POST, e o dono novo abre as credenciais', { timeout: 15000 }, async () => {
  let created = false;
  const { p, close, count, api } = await openArea('buckets', (b) => b.rows.length === 3, {
    extra: {
      '/api/buckets/owners': ['uplii', 'ops'],
      '/api/buckets/owners/novo-app/credentials': { owner: 'novo-app', endpoint: 'https://s3.example', region: 'br-1', accessKey: 'AKIANEW' },
    },
    routes: {
      'POST /api/buckets': (req, body) => {
        created = true;
        return { json: { name: body.name, tenant: null, owner: body.owner, objects: 0, usedBytes: 0, quotaBytes: null, createdAt: null }, delayMs: 300 };
      },
      'GET /api/buckets': () => ({ json: created ? [...BUCKETS, { name: 'novo-app', tenant: null, owner: 'novo-app', objects: 0, usedBytes: 0, quotaBytes: null, createdAt: null }] : BUCKETS }),
    },
  });
  const NB = 'bucket:new';
  try {
    p.act('vmm', 'act', { a: 'bucket:new' });
    const open = await p.waitFor(() => p.requests.find((r) => r.method === 'view.open' && r.params.viewId === NB), 'abre o Novo bucket');
    assert.equal(open.params.title, 'Novo bucket');
    assert.equal(open.params.modal, true);
    assert.equal(blockWith(open.params.blocks, (b) => b.type === 'select').placeholder, 'Carregando…');
    await p.waitFor(() => (blockWith(p.windowBlocks(NB), (b) => b.type === 'select') || {}).placeholder === 'Escolha o usuário do RGW', 'donos');
    let blocks = p.windowBlocks(NB);
    assertNoNull(blocks);
    assert.deepEqual(blockWith(blocks, (b) => b.type === 'select').options, ['uplii', 'ops']);
    assert.deepEqual(blockWith(blocks, (b) => b.type === 'tabs').items.map((t) => [t.label, t.active]), [['Usuário existente', true], ['Novo usuário', false]]);
    assert.equal(button(blocks, 'bucket:submit').label, 'Criar bucket');
    assert.ok(button(blocks, 'bucket:cancel'));
    // inválido: o erro volta na janela, sem POST
    p.act(NB, 'bucket:submit', { name: 'X', owner: '' });
    await p.waitFor(() => allTexts(p.windowBlocks(NB)).some((t) => t.includes('Escolha o usuário do RGW · ') || t.startsWith('Minúsculas, números e hífen; de 3 a 63 caracteres. · ')), 'erros');
    // Novo usuário: a dica, e um dono que já existe é recusado
    p.act(NB, 'bucket:mode:new', { name: 'novo-app', owner: '' });
    await p.waitFor(() => allTexts(p.windowBlocks(NB)).includes('Cria o usuário no RGW com uma chave S3 só dele. As credenciais aparecem logo depois de criar.'), 'dica');
    blocks = p.windowBlocks(NB);
    assert.equal(blockWith(blocks, (b) => b.id === 'newOwner').placeholder, 'Ex: uplii');
    assert.equal(blockWith(blocks, (b) => b.id === 'name').value, 'novo-app', 'o nome digitado fica');
    p.act(NB, 'bucket:submit', { name: 'novo-app', newOwner: 'uplii' });
    await p.waitFor(() => allTexts(p.windowBlocks(NB)).includes('Esse usuário já existe; escolha em Usuário existente.'), 'dono já existe');
    assert.equal(count('POST', '/api/buckets'), 0);
    // dois submits seguidos (vazio = o nome do bucket)
    p.act(NB, 'bucket:submit', { name: 'Novo-App ', newOwner: '' });
    p.act(NB, 'bucket:submit', { name: 'Novo-App ', newOwner: '' });
    await p.waitFor(() => (button(p.windowBlocks(NB), 'bucket:submit') || {}).label === 'Criando…', 'criando');
    assert.equal(button(p.windowBlocks(NB), 'bucket:submit').disabled, true);
    p.act(NB, 'bucket:submit', { name: 'novo-app', newOwner: '' }); // o enter no meio
    p.act(NB, 'bucket:cancel', {}); // cancelar no meio não fecha
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.close' && r.params.viewId === NB), 'fecha depois de criar');
    await p.waitFor(() => p.mainData().buckets.rows.length === 4, 'recarregou a lista');
    await p.waitFor(() => allTexts(p.windowBlocks('bucket:creds:novo-app')).includes('AKIANEW'), 'credenciais do dono novo, sozinhas');
    assert.ok(allTexts(p.windowBlocks('bucket:creds:novo-app')).includes('Bucket novo-app · usuário novo-app do RGW'));
    await pause(150);
    assert.equal(count('POST', '/api/buckets'), 1, 'um POST só');
    assert.deepEqual(api.seen.find((r) => r.method === 'POST' && r.path === '/api/buckets').body, { name: 'novo-app', owner: 'novo-app', newOwner: true });
    assert.equal(p.requests.filter((r) => r.method === 'view.close' && r.params.viewId === NB).length, 1);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('Novo bucket com dono existente: cria, recarrega e não abre as credenciais; erro da API volta na janela', { timeout: 15000 }, async () => {
  let fail = true;
  const { p, close, count } = await openArea('buckets', (b) => b.rows.length === 3, {
    extra: { '/api/buckets/owners': ['uplii'] },
    routes: {
      'POST /api/buckets': (req, body) => (fail
        ? { status: 409, json: { statusCode: 409, message: 'Esse bucket já existe.' }, raw: true }
        : { json: { name: body.name, tenant: null, owner: body.owner, objects: 0, usedBytes: 0, quotaBytes: null, createdAt: null } }),
    },
  });
  const NB = 'bucket:new';
  try {
    p.act('vmm', 'act', { a: 'bucket:new' });
    await p.waitFor(() => (blockWith(p.windowBlocks(NB), (b) => b.type === 'select') || {}).placeholder === 'Escolha o usuário do RGW', 'donos');
    p.act(NB, 'bucket:submit', { name: 'media', owner: 'uplii' });
    await p.waitFor(() => allTexts(p.windowBlocks(NB)).includes('Esse bucket já existe.'), 'erro da API');
    assert.equal(button(p.windowBlocks(NB), 'bucket:submit').label, 'Criar bucket', 'saving volta');
    fail = false;
    p.act(NB, 'bucket:submit', { name: 'media2', owner: 'uplii' });
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.close' && r.params.viewId === NB), 'fechou');
    await p.waitFor(() => count('GET', '/api/buckets') === 2, 'recarregou');
    await pause(200);
    assert.ok(!p.requests.some((r) => r.method === 'view.open' && String(r.params.viewId).startsWith('bucket:creds:')), 'sem credenciais');
    assert.equal(count('POST', '/api/buckets'), 2);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('Novo bucket sem donos: "Nenhum usuário do RGW"; erro nos donos aparece', { timeout: 15000 }, async () => {
  const { p, close } = await openArea('buckets', (b) => b.rows.length === 3, {
    routes: { 'GET /api/buckets/owners': () => ({ status: 502, json: { statusCode: 502, message: 'RGW fora' }, raw: true }) },
  });
  try {
    p.act('vmm', 'act', { a: 'bucket:new' });
    await p.waitFor(() => allTexts(p.windowBlocks('bucket:new')).includes('RGW fora'), 'erro');
    assert.equal(blockWith(p.windowBlocks('bucket:new'), (b) => b.type === 'select').placeholder, 'Nenhum usuário do RGW');
    assertNoNull(p.windowBlocks('bucket:new'));
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('sair com a secret revelada fecha as credenciais e esquece a secret', { timeout: 15000 }, async () => {
  const { p, close, count, dataDir, token, api } = await openArea('buckets', (b) => b.rows.length === 3, {
    extra: { '/api/buckets/owners/uplii/credentials': CREDS, '/api/buckets/owners/uplii/credentials/secret': { secretKey: SECRET } },
  });
  const id = 'bucket:creds:uplii';
  try {
    p.act('vmm', 'act', { a: 'bucket:creds:/media' });
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('AKIAUPLII'), 'credenciais');
    p.act(id, 'bucket:reveal', {});
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes(SECRET), 'revelada');
    p.act('vmm', 'logout', {});
    await p.waitFor(() => p.mainData().screen === 'login', 'login');
    assert.ok(p.requests.some((r) => r.method === 'view.close' && r.params.viewId === id), 'fechou as credenciais');
    // entra de novo: as credenciais vêm sem a secret, e um Revelar busca de novo
    seed(dataDir, api.url, token, ADMIN);
    p.act('vmm', 'nav', { to: 'buckets' });
    await p.waitFor(() => p.mainData().screen === 'buckets' && p.mainData().buckets.rows.length === 3, 'buckets de novo');
    p.act('vmm', 'act', { a: 'bucket:creds:/media' });
    await p.waitFor(() => p.requests.filter((r) => r.method === 'view.open' && r.params.viewId === id).length === 2, 'reabriu');
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('AKIAUPLII'), 'credenciais');
    assert.ok(!allTexts(p.windowBlocks(id)).includes(SECRET));
    p.act(id, 'bucket:reveal', {});
    await p.waitFor(() => count('GET', '/api/buckets/owners/uplii/credentials/secret') === 2, 'buscou de novo');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
  assert.ok(!p.stderr().includes(SECRET));
});

test('as views de ceph e buckets aguentam ctx.user null', { timeout: 15000 }, async () => {
  const dataDir = tmpDir();
  const script = `
    const ceph = m.screens.get('ceph').view({ user: null, now: Date.now });
    const buckets = m.screens.get('buckets').view({ user: null, now: Date.now });
    process.stderr.write('VIEW=' + JSON.stringify({ ceph, buckets }) + '\\n');
  `;
  const p = startPlugin({ dataDir, url: 'http://127.0.0.1:9', script });
  try {
    await p.waitFor(() => /VIEW=.*\n/.test(p.stderr()), 'as views no stderr');
    const v = JSON.parse(p.stderr().match(/VIEW=(.*)\n/)[1]);
    assertNoNull(v);
    assert.equal(v.buckets.header.newBucket, false);
    assert.equal(v.buckets.header.readOnly, true);
    assert.equal(v.buckets.empty, 'Carregando buckets…');
    assert.equal(v.ceph.poolsLoading, true);
    assert.equal(v.ceph.images.visible, false);
  } finally {
    await p.stop();
  }
  assert.deepEqual(p.bad, []);
});

test('storage.rfwtxt: sem import, doubles, sem null/args.children, e a casca liga as telas', { timeout: 15000 }, () => {
  const ui = path.join(__dirname, '..', 'ui');
  const src = fs.readFileSync(path.join(ui, 'storage.rfwtxt'), 'utf8');
  assert.ok(!/^import /m.test(src), 'tela sem import');
  const code = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/0x[0-9a-fA-F]+/g, '0')
    .replace(/\b(maxLines|flex):\s*\d+/g, '');
  const ints = code.match(/(?<![\w.])\d+(?![\w.])/g) || [];
  assert.deepEqual(ints.filter((n) => n !== '0'), [], 'números inteiros no .rfwtxt (use 13.0)');
  for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) assert.equal(code.split(o).length, code.split(c).length, `${o}${c} desbalanceados`);
  assert.ok(!/\bnull\b/.test(code));
  assert.ok(!/args\.children\b/.test(code));
  assert.match(src, /widget CephScreen =/);
  assert.match(src, /widget BucketsScreen =/);
  const shell = fs.readFileSync(SHELL, 'utf8');
  assert.match(shell, /"ceph": CephScreen\(\)/);
  assert.match(shell, /"buckets": BucketsScreen\(\)/);
  // Os arquivos viram uma biblioteca só: um nome de widget repetido quebraria.
  const names = fs.readdirSync(ui).filter((f) => f.endsWith('.rfwtxt'))
    .flatMap((f) => [...fs.readFileSync(path.join(ui, f), 'utf8').matchAll(/^widget (\w+) =/gm)].map((x) => x[1]));
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], 'widget repetido entre os .rfwtxt');
});

// --- Task 10, fix 1 --------------------------------------------------------------------

test('secret: Revelar duas vezes + copiar com o GET lento fazem UM GET (um s3.secret.reveal)', { timeout: 15000 }, async () => {
  const { p, close, count } = await openArea('buckets', (b) => b.rows.length === 3, {
    extra: { '/api/buckets/owners/uplii/credentials': CREDS },
    routes: { 'GET /api/buckets/owners/uplii/credentials/secret': () => ({ json: { secretKey: SECRET }, delayMs: 300 }) },
  });
  const id = 'bucket:creds:uplii';
  try {
    p.act('vmm', 'act', { a: 'bucket:creds:/media' });
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('AKIAUPLII'), 'credenciais');
    p.act(id, 'bucket:reveal', {});
    p.act(id, 'bucket:reveal', {});
    p.act(id, 'bucket:copy:secret', {});
    await p.waitFor(() => (button(p.windowBlocks(id), 'bucket:reveal') || {}).label === 'Revelando…', 'revelando');
    assert.equal(button(p.windowBlocks(id), 'bucket:reveal').disabled, true);
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes(SECRET) && allTexts(p.windowBlocks(id)).includes('Copiado'), 'revelada e copiada');
    assert.equal(button(p.windowBlocks(id), 'bucket:reveal').label, 'Esconder');
    assert.equal(p.requests.filter((r) => r.method === 'clipboard.write').pop().params.text, SECRET);
    await pause(400);
    assert.equal(count('GET', '/api/buckets/owners/uplii/credentials/secret'), 1, 'um GET só');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
  assert.ok(!p.stderr().includes(SECRET));
});

test('secret: o erro de um Revelar some quando o próximo começa', { timeout: 15000 }, async () => {
  let fails = 1;
  const { p, close, count } = await openArea('buckets', (b) => b.rows.length === 3, {
    extra: { '/api/buckets/owners/uplii/credentials': CREDS },
    routes: {
      'GET /api/buckets/owners/uplii/credentials/secret': () => (fails-- > 0
        ? { status: 500, json: { statusCode: 500, message: 'RGW não respondeu' }, raw: true }
        : { json: { secretKey: SECRET }, delayMs: 200 }),
    },
  });
  const id = 'bucket:creds:uplii';
  try {
    p.act('vmm', 'act', { a: 'bucket:creds:/media' });
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('AKIAUPLII'), 'credenciais');
    p.act(id, 'bucket:reveal', {});
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('RGW não respondeu'), 'erro');
    assert.equal(button(p.windowBlocks(id), 'bucket:reveal').label, 'Revelar');
    p.act(id, 'bucket:reveal', {});
    await p.waitFor(() => (button(p.windowBlocks(id), 'bucket:reveal') || {}).label === 'Revelando…', 'revelando');
    assert.ok(!allTexts(p.windowBlocks(id)).includes('RGW não respondeu'), 'o erro velho sai no começo');
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes(SECRET), 'revelada');
    assert.ok(!allTexts(p.windowBlocks(id)).includes('RGW não respondeu'));
    assert.equal(count('GET', '/api/buckets/owners/uplii/credentials/secret'), 2);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('secret: fechar a janela (view.closed) apaga a secret; reabrir mostra a máscara e busca de novo', { timeout: 15000 }, async () => {
  const { p, close, count } = await openArea('buckets', (b) => b.rows.length === 3, {
    extra: { '/api/buckets/owners/uplii/credentials': CREDS, '/api/buckets/owners/uplii/credentials/secret': { secretKey: SECRET } },
  });
  const id = 'bucket:creds:uplii';
  const opens = () => p.requests.filter((r) => r.method === 'view.open' && r.params.viewId === id).length;
  try {
    p.act('vmm', 'act', { a: 'bucket:creds:/media' });
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('AKIAUPLII'), 'credenciais');
    p.act(id, 'bucket:reveal', {});
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes(SECRET), 'revelada');
    // reabrir com a janela ainda aberta só traz pra frente (a secret continua lá)
    p.act('vmm', 'act', { a: 'bucket:creds:acme/logs' });
    await p.waitFor(() => opens() === 2, 'trouxe pra frente');
    assert.ok(allTexts(p.windowBlocks(id)).includes(SECRET));
    assert.ok(allTexts(p.windowBlocks(id)).includes('Bucket logs · usuário uplii do RGW'));
    // o usuário fecha no X: a Maestria só avisa
    p.send('event', { type: 'view.closed', viewId: id }, { notify: true });
    await pause(100);
    p.act('vmm', 'act', { a: 'bucket:creds:/media' });
    await p.waitFor(() => opens() === 3, 'reabriu');
    await p.waitFor(() => allTexts(p.windowBlocks(id)).includes('AKIAUPLII'), 'credenciais de novo');
    const blocks = p.windowBlocks(id);
    assert.ok(!allTexts(blocks).includes(SECRET), 'sem a secret');
    assert.ok(allTexts(blocks).includes('•'.repeat(40)), 'a máscara');
    assert.equal(button(blocks, 'bucket:reveal').label, 'Revelar');
    p.act(id, 'bucket:copy:secret', {});
    await p.waitFor(() => count('GET', '/api/buckets/owners/uplii/credentials/secret') === 2, 'nada em cache: busca de novo');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

// --- Task 12: Rotas ---------------------------------------------------------------------

const R_CERT = { name: 'app', source: 'acme', validation: 'http01', issuedAt: '2026-09-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', attached: true, issued: true, autoRenewal: true, wildcard: false };
const R_OK = {
  hostname: 'app.cefis.cloud', tlsMode: 'firewall', access: ['internal'], backendName: 'app_pool',
  backend: { enabled: true, healthCheck: 'tcp-check', servers: [{ name: 's1', address: '10.0.0.5', port: 3000, health: 'up' }] },
  dnsAddress: '10.0.0.1', conflictingBackends: [], problems: [], certificate: R_CERT,
};
const R_BAD = {
  hostname: 'old.cefis.cloud', tlsMode: 'passthrough', access: [], backendName: 'old_pool',
  backend: null, dnsAddress: null, conflictingBackends: [], problems: ['backend_missing', 'dns_missing'], certificate: null,
};
const ROUTE_GETS = { '/api/routes': [R_OK, R_BAD], '/api/routes/healthchecks': ['http-check', 'tcp-check'] };
const PLAN = {
  hostname: 'novo.cefis.cloud',
  tlsMode: 'firewall',
  changes: [
    { action: 'create', kind: 'certificate', target: 'novo.cefis.cloud', detail: 'http-01' },
    { action: 'create', kind: 'backend', target: 'novo_pool', detail: '' },
  ],
};
const REMOVAL = {
  hostname: 'app.cefis.cloud',
  fingerprint: 'fp-123',
  changes: [
    { action: 'remove', kind: 'mapfile_line', target: 'LOCAL_SUBDOMAINS_mapfile', detail: 'app.cefis.cloud app_pool' },
    { action: 'remove', kind: 'backend', target: 'app_pool', detail: '' },
    { action: 'keep', kind: 'certificate', target: '*.cefis.cloud', detail: 'outras rotas usam' },
  ],
};
const jobOf = (kind, status, steps) => ({
  id: `job-${kind}`, kind, hostname: kind === 'create' ? 'novo.cefis.cloud' : 'app.cefis.cloud', status,
  steps, error: null, startedAt: '2026-10-26T12:00:00Z', finishedAt: null,
});
const RJ = 'VMM_ROUTE_JOB_MS';

/** Logado na tela de rotas com as duas rotas lidas. */
function openRoutes(opts = {}) {
  return openArea('routes', (r) => r.rows.length === 2, { ...opts, extra: { ...ROUTE_GETS, ...(opts.extra || {}) } });
}
const NEW_VALUES = { hostname: ' Novo.Cefis.Cloud ', addr0: '10.0.0.9', port0: '80a80', healthCheck: 'tcp-check', createDns: false };

test('rotas (admin): cartões, filtros, linhas, busca no enter, "Ler agora" com trava, sem null e sem polling', { timeout: 15000 }, async () => {
  let slow = false;
  const { p, close, count } = await openRoutes({
    routes: { 'GET /api/routes': () => ({ json: [R_OK, R_BAD], delayMs: slow ? 300 : 0 }) },
  });
  try {
    const v = p.mainData().routes;
    assertNoNull(v);
    assert.equal(p.mainData().screen, 'routes');
    assert.equal(v.header.title, 'Rotas');
    assert.equal(v.header.newRoute, true);
    assert.equal(v.header.loading, false);
    assert.equal(v.header.refresh, 'Lido agora');
    assert.deepEqual(v.stats.map((s) => [s.label, s.value]), [['Hostnames', '2'], ['Backends', '1'], ['Certificados', '1'], ['Com problema', '1']]);
    assert.equal(v.stats[0].sub, '1 em passthrough');
    assert.deepEqual(v.filters.map((f) => [f.label, f.countText, f.active]), [['Todas', '2', true], ['Com problema', '1', false], ['TLS no firewall', '1', false], ['Passthrough', '1', false]]);
    const [ok, bad] = v.rows;
    assert.equal(ok.hostname, 'app.cefis.cloud');
    assert.deepEqual(ok.destino, { text: '10.0.0.5:3000', tone: 'green' });
    assert.equal(ok.open, 'route:open:app.cefis.cloud');
    assert.deepEqual(bad.backend, { text: 'old_pool (não existe)', tone: 'red' });
    assert.deepEqual(bad.dns, { text: 'sem override', tone: 'red' });
    assert.deepEqual(bad.cert, { text: 'no servidor', tone: 'dim' });
    assert.equal(v.footer, '2 de 2 hostnames');
    // filtro e busca
    p.act('vmm', 'act', { a: 'route:filter:problems' });
    await p.waitFor(() => p.mainData().routes.rows.length === 1 && p.mainData().routes.rows[0].hostname === 'old.cefis.cloud', 'filtro com problema');
    p.act('vmm', 'act', { a: 'route:filter:all' });
    p.act('vmm', 'act', { a: 'route:search', text: '10.0.0.5' });
    await p.waitFor(() => p.mainData().routes.rows.length === 1 && p.mainData().routes.rows[0].hostname === 'app.cefis.cloud' && p.mainData().routes.footer === '1 de 2 hostnames', 'busca');
    // sem polling
    const before = count('GET', '/api/routes');
    assert.equal(before, 1, 'leu uma vez ao entrar');
    await pause(300);
    assert.equal(count('GET', '/api/routes'), 1, 'sem polling');
    // "Ler agora" duas vezes com a leitura lenta: uma leitura só, e o "lendo" no topo
    slow = true;
    p.act('vmm', 'act', { a: 'route:reload' });
    await p.waitFor(() => p.mainData().routes.header.loading === true, 'lendo');
    p.act('vmm', 'act', { a: 'route:reload' });
    await p.waitFor(() => p.mainData().routes.header.loading === false, 'leu');
    await pause(100);
    assert.equal(count('GET', '/api/routes'), 2, 'um GET por clique, não dois');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('rotas: a gaveta mostra o caminho; o admin vê "Remover rota"', { timeout: 15000 }, async () => {
  const { p, close } = await openRoutes();
  try {
    p.act('vmm', 'act', { a: 'route:open:app.cefis.cloud' });
    const open = await p.waitFor(() => p.requests.find((r) => r.method === 'view.open' && r.params.viewId === 'route:app.cefis.cloud'), 'gaveta');
    assertNoNull(open.params.blocks);
    const texts = allTexts(open.params.blocks);
    assert.ok(texts.includes('CAMINHO'));
    assert.ok(texts.includes('CERTIFICADO'));
    assert.ok(button(open.params.blocks, 'route:remove:app.cefis.cloud'));
    p.act('vmm', 'act', { a: 'route:open:nao.existe' });
    p.act('route:app.cefis.cloud', 'route:close', {});
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.close' && r.params.viewId === 'route:app.cefis.cloud'), 'fecha a gaveta');
    assert.ok(!p.requests.some((r) => r.method === 'view.open' && r.params.viewId === 'route:nao.existe'));
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('rotas (viewer): sem "Nova rota" nem "Remover rota"; ações forjadas não chamam a API', { timeout: 15000 }, async () => {
  const hits = [];
  const record = (name) => () => {
    hits.push(name);
    return { json: {} };
  };
  const { p, close } = await openRoutes({
    user: VIEWER,
    routes: {
      'POST /api/routes/plan': record('plan'),
      'POST /api/routes': record('create'),
      'POST /api/routes/app.cefis.cloud/removal-plan': record('removal-plan'),
      'DELETE /api/routes/app.cefis.cloud': record('delete'),
    },
  });
  try {
    assert.equal(p.mainData().routes.header.newRoute, false);
    p.act('vmm', 'act', { a: 'route:open:app.cefis.cloud' });
    const open = await p.waitFor(() => p.requests.find((r) => r.method === 'view.open' && r.params.viewId === 'route:app.cefis.cloud'), 'gaveta');
    assert.equal(button(open.params.blocks, 'route:remove:app.cefis.cloud'), null, 'viewer sem Remover rota');
    assert.ok(!allTexts(open.params.blocks).includes('Remover rota'));
    // forjadas
    p.act('vmm', 'act', { a: 'route:new' });
    p.act('route:app.cefis.cloud', 'route:remove:app.cefis.cloud', {});
    p.act('route:new', 'route:review', NEW_VALUES);
    p.act('route:new', 'route:apply', { confirm: 'novo.cefis.cloud' });
    p.act('route:remove', 'route:delete', { confirm: 'app.cefis.cloud' });
    await pause(300);
    assert.deepEqual(hits, [], 'nenhuma escrita');
    assert.ok(!p.requests.some((r) => r.method === 'view.open' && (r.params.viewId === 'route:new' || r.params.viewId === 'route:remove')), 'nenhuma janela de escrita');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('Nova rota: formulário, validação, um POST de plano por clique, confirmação errada não aplica, dois "Aplicar" mandam UM POST, e o job até "Rota criada"', { timeout: 15000 }, async () => {
  let polls = 0;
  const RUNNING = jobOf('create', 'running', [
    { step: 'certificate', status: 'running', detail: null },
    { step: 'servers', status: 'pending', detail: null },
    { step: 'dns_override', status: 'skipped', detail: null },
  ]);
  const DONE = jobOf('create', 'done', [
    { step: 'certificate', status: 'done', detail: 'R11' },
    { step: 'servers', status: 'done', detail: null },
    { step: 'dns_override', status: 'skipped', detail: null },
  ]);
  const { p, close, count, api } = await openRoutes({
    env: { [RJ]: '100' },
    routes: {
      'POST /api/routes/plan': () => ({ json: PLAN, delayMs: 300 }),
      'POST /api/routes': () => ({ json: RUNNING, delayMs: 300 }),
      'GET /api/routes/jobs/job-create': () => {
        polls++;
        return { json: polls < 3 ? RUNNING : DONE };
      },
    },
  });
  const W = 'route:new';
  try {
    p.act('vmm', 'act', { a: 'route:new' });
    const open = await p.waitFor(() => p.requests.find((r) => r.method === 'view.open' && r.params.viewId === W), 'abre a Nova rota');
    assert.equal(open.params.title, 'Nova rota');
    assert.equal(open.params.modal, true);
    await p.waitFor(() => (blockWith(p.windowBlocks(W), (b) => b.type === 'select') || {}).options.length === 2, 'health checks');
    let blocks = p.windowBlocks(W);
    assertNoNull(blocks);
    const texts = allTexts(blocks);
    for (const t of ['1 de 2 · Dados', 'Domínio completo; o console confere se está livre ao revisar.', 'Criar override no DNS interno', 'hostname → HAProxy do firewall']) assert.ok(texts.includes(t), t);
    assert.equal(blockWith(blocks, (b) => b.id === 'hostname').placeholder, 'Ex: status.cefis.cloud');
    assert.deepEqual(blockWith(blocks, (b) => b.type === 'tabs').items.map((t) => [t.label, t.active]), [['No firewall', true], ['Passthrough', false]]);
    assert.ok(texts.includes('Só interno') && texts.includes('Público') && texts.includes('Os dois'));
    const hc = blockWith(blocks, (b) => b.type === 'select');
    assert.deepEqual([hc.id, hc.options, hc.value], ['healthCheck', ['http-check', 'tcp-check'], 'tcp-check']);
    assert.equal(blockWith(blocks, (b) => b.type === 'checkbox').value, true);
    assert.ok(blockWith(blocks, (b) => b.id === 'addr0') && blockWith(blocks, (b) => b.id === 'port0'));
    assert.equal(button(blocks, 'route:rmserver:0'), null, 'um servidor só: sem x');
    assert.equal(button(blocks, 'route:review').label, 'Revisar mudanças');
    assert.ok(button(blocks, 'route:addserver') && button(blocks, 'route:cancel'));
    // passthrough esconde o "Quem acessa"; o que foi digitado fica
    p.act(W, 'route:tls:passthrough', { hostname: 'x.cefis.cloud', addr0: '10.0.0.9' });
    await p.waitFor(() => !allTexts(p.windowBlocks(W)).includes('Só interno'), 'passthrough');
    assert.equal(blockWith(p.windowBlocks(W), (b) => b.id === 'hostname').value, 'x.cefis.cloud');
    p.act(W, 'route:tls:firewall', {});
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('Só interno'), 'firewall de novo');
    // balanceamento: o segundo servidor herda a porta; o x aparece e tira
    p.act(W, 'route:addserver', { addr0: '10.0.0.9', port0: '8080' });
    await p.waitFor(() => blockWith(p.windowBlocks(W), (b) => b.id === 'port1'), 'segundo servidor');
    assert.equal(blockWith(p.windowBlocks(W), (b) => b.id === 'port1').value, '8080');
    assert.ok(button(p.windowBlocks(W), 'route:rmserver:1'));
    p.act(W, 'route:rmserver:0', { addr0: '10.0.0.9', port0: '8080', addr1: '10.0.0.10', port1: '8080' });
    await p.waitFor(() => !blockWith(p.windowBlocks(W), (b) => b.id === 'port1'), 'tirou um');
    assert.equal(blockWith(p.windowBlocks(W), (b) => b.id === 'addr0').value, '10.0.0.10');
    // inválido: os erros voltam, sem plano
    p.act(W, 'route:review', { hostname: 'nada', addr0: '999.1.1.1', port0: '' });
    await p.waitFor(() => allTexts(p.windowBlocks(W)).some((t) => t.startsWith('Hostname inválido') && t.includes('Servidor 1: IP inválido.')), 'erros');
    assert.equal(count('POST', '/api/routes/plan'), 0);
    // dois "Revisar" (clique + enter): UM plano
    p.act(W, 'route:review', NEW_VALUES);
    p.act(W, 'route:review', NEW_VALUES);
    await p.waitFor(() => (button(p.windowBlocks(W), 'route:review') || {}).label === 'Conferindo…', 'conferindo');
    assert.equal(button(p.windowBlocks(W), 'route:review').disabled, true);
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('2 de 2 · Revisão'), 'revisão');
    assert.equal(count('POST', '/api/routes/plan'), 1, 'um POST de plano só');
    assert.deepEqual(api.seen.find((r) => r.path === '/api/routes/plan').body, {
      hostname: 'novo.cefis.cloud', tlsMode: 'firewall', access: ['internal'], servers: [{ address: '10.0.0.9', port: 8080 }], healthCheck: 'tcp-check', createDnsOverride: false,
    });
    blocks = p.windowBlocks(W);
    assertNoNull(blocks);
    const list = blockWith(blocks, (b) => b.type === 'list');
    assert.deepEqual(list.items.map((i) => [i.title, i.badge, i.meta]), [['1. Certificado', 'ACME', 'criar'], ['2. Backend Pool', 'HAProxy', 'criar']]);
    assert.equal(list.items[0].subtitle, 'novo.cefis.cloud · http-01');
    const rtexts = allTexts(blocks);
    assert.ok(rtexts.includes('Aplicar recarrega o HAProxy'));
    assert.ok(rtexts.includes('Antes de recarregar, o console roda o configtest; se algo falhar até o reload, desfaz o que criou. No reload, conexões abertas dos outros sites podem cair por cerca de 1 s.'));
    assert.equal(blockWith(blocks, (b) => b.id === 'confirm').label, 'Digite o hostname para confirmar');
    assert.ok(button(blocks, 'route:back') && button(blocks, 'route:cancel'));
    assert.equal(button(blocks, 'route:apply').label, 'Aplicar no firewall');
    // confirmação errada: nada sai
    p.act(W, 'route:apply', { confirm: 'novo.cefis.clou' });
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('Digite novo.cefis.cloud para confirmar.'), 'confirmação errada');
    await pause(100);
    assert.equal(count('POST', '/api/routes'), 0, 'hostname errado não aplica');
    // Voltar e revisar de novo mantém o formulário
    p.act(W, 'route:back', {});
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('1 de 2 · Dados'), 'voltou');
    assert.equal(blockWith(p.windowBlocks(W), (b) => b.id === 'hostname').value, 'novo.cefis.cloud');
    p.act(W, 'route:review', NEW_VALUES);
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('2 de 2 · Revisão'), 'revisão de novo');
    // dois "Aplicar" (com maiúsculas e espaço) + um enter no meio: UM POST
    p.act(W, 'route:apply', { confirm: ' Novo.cefis.cloud ' });
    p.act(W, 'route:apply', { confirm: ' Novo.cefis.cloud ' });
    p.act(W, 'route:apply', { confirm: 'novo.cefis.cloud' });
    p.act(W, 'route:cancel', {}); // cancelar no meio não fecha
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('Aplicando novo.cefis.cloud'), 'job aplicando');
    assert.equal(count('POST', '/api/routes'), 1, 'um POST /routes só');
    assert.deepEqual(api.seen.find((r) => r.method === 'POST' && r.path === '/api/routes').body.hostname, 'novo.cefis.cloud');
    assert.ok(!p.requests.some((r) => r.method === 'view.close' && r.params.viewId === W));
    blocks = p.windowBlocks(W);
    assertNoNull(blocks);
    assert.equal(button(blocks, 'route:close').label, 'Fechar e continuar em segundo plano');
    assert.ok(allTexts(blocks).includes('Pode fechar: a criação continua na API e fica registrada na Auditoria. A emissão do certificado leva de 1 a 2 minutos.'));
    const steps = blockWith(blocks, (b) => b.type === 'list').items;
    assert.deepEqual(steps.map((s) => [s.title, s.icon]), [["Emitir certificado (Let's Encrypt)", 'clock'], ['Criar Real Server(s)', 'dot']]);
    const routesBefore = count('GET', '/api/routes');
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('Rota criada novo.cefis.cloud'), 'rota criada');
    blocks = p.windowBlocks(W);
    assert.equal(button(blocks, 'route:close').label, 'Fechar');
    assert.ok(!allTexts(blocks).some((t) => t.startsWith('Pode fechar')));
    assert.deepEqual(blockWith(blocks, (b) => b.type === 'list').items.map((s) => [s.icon, s.subtitle]), [['check', 'R11'], ['check', '']]);
    await p.waitFor(() => count('GET', '/api/routes') === routesBefore + 1, 'a lista relê no fim do job');
    const n = polls;
    await pause(400);
    assert.equal(polls, n, 'para de consultar no fim');
    assert.equal(n, 3);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

/** A Nova rota já no job, aplicando. */
async function startCreateJob(opts, jobRoute) {
  const RUNNING = jobOf('create', 'running', [{ step: 'certificate', status: 'running', detail: null }]);
  const ctx = await openRoutes({
    ...opts,
    env: { [RJ]: '80' },
    routes: { 'POST /api/routes/plan': () => ({ json: PLAN }), 'POST /api/routes': () => ({ json: RUNNING }), 'GET /api/routes/jobs/job-create': jobRoute || (() => ({ json: RUNNING })) },
  });
  const { p } = ctx;
  try {
    p.act('vmm', 'act', { a: 'route:new' });
    await p.waitFor(() => p.windowBlocks('route:new'), 'abre');
    p.act('route:new', 'route:review', NEW_VALUES);
    await p.waitFor(() => allTexts(p.windowBlocks('route:new')).includes('2 de 2 · Revisão'), 'revisão');
    p.act('route:new', 'route:apply', { confirm: 'novo.cefis.cloud' });
    await p.waitFor(() => allTexts(p.windowBlocks('route:new')).includes('Aplicando novo.cefis.cloud'), 'aplicando');
  } catch (e) {
    await ctx.close();
    throw e;
  }
  return ctx;
}
const jobPolls = (count) => count('GET', '/api/routes/jobs/job-create');

test('job: fechar a janela (view.closed) para a consulta e relê a lista', { timeout: 15000 }, async () => {
  const { p, close, count } = await startCreateJob();
  try {
    await p.waitFor(() => jobPolls(count) >= 2, 'consultando');
    const routesBefore = count('GET', '/api/routes');
    p.send('event', { type: 'view.closed', viewId: 'route:new' }, { notify: true });
    await p.waitFor(() => count('GET', '/api/routes') === routesBefore + 1, 'relê a lista ao fechar');
    const n = await waitStable(() => jobPolls(count), 300, 'consultas do job');
    await pause(300);
    assert.equal(jobPolls(count), n, 'parou');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('job: o update que volta open:false para a consulta', { timeout: 15000 }, async () => {
  let gone = false;
  const { p, close, count } = await startCreateJob({ windowReply: (id) => !(gone && id === 'route:new') });
  try {
    await p.waitFor(() => jobPolls(count) >= 1, 'consultando');
    gone = true;
    const n = await waitStable(() => jobPolls(count), 300, 'consultas do job');
    await pause(300);
    assert.equal(jobPolls(count), n, 'parou');
    assert.ok(n <= 3);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('job: 404 vira "Perdi o acompanhamento" e para; erro de rede só tenta de novo', { timeout: 15000 }, async () => {
  let n = 0;
  const { p, close, count } = await startCreateJob({}, () => {
    n++;
    if (n === 1) return { status: 502, json: { statusCode: 502, message: 'Bad Gateway' }, raw: true };
    return { status: 404, json: { statusCode: 404, message: 'Job não encontrado.' }, raw: true };
  });
  try {
    const W = 'route:new';
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('Perdi o acompanhamento: Job não encontrado. Confira o resultado na Auditoria e na lista de rotas.'), 'perdeu');
    assert.equal(button(p.windowBlocks(W), 'route:close').label, 'Fechar');
    await pause(300);
    assert.equal(jobPolls(count), 2, 'o 502 tentou de novo, o 404 parou');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('job: sair no meio para a consulta e fecha a janela', { timeout: 15000 }, async () => {
  const { p, close, count } = await startCreateJob();
  try {
    await p.waitFor(() => jobPolls(count) >= 1, 'consultando');
    p.act('vmm', 'logout', {});
    await p.waitFor(() => p.mainData().screen === 'login', 'login');
    assert.ok(p.requests.some((r) => r.method === 'view.close' && r.params.viewId === 'route:new'));
    const n = await waitStable(() => jobPolls(count), 300, 'consultas do job');
    await pause(300);
    assert.equal(jobPolls(count), n, 'parou');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('remover: um plano por clique, as duas listas, hostname errado não apaga, dois "Remover" mandam UM DELETE, e o job até "Rota removida"', { timeout: 15000 }, async () => {
  let polls = 0;
  const RUNNING = jobOf('remove', 'running', [{ step: 'remove_mapfiles', status: 'running', detail: null }, { step: 'delete_backend', status: 'pending', detail: null }]);
  const DONE = jobOf('remove', 'done', [{ step: 'remove_mapfiles', status: 'done', detail: null }, { step: 'delete_backend', status: 'done', detail: null }]);
  const { p, close, count, api } = await openRoutes({
    env: { [RJ]: '100' },
    routes: {
      'POST /api/routes/app.cefis.cloud/removal-plan': () => ({ json: REMOVAL, delayMs: 300 }),
      'DELETE /api/routes/app.cefis.cloud': () => ({ json: RUNNING, delayMs: 300 }),
      'GET /api/routes/jobs/job-remove': () => {
        polls++;
        return { json: polls < 2 ? RUNNING : DONE };
      },
    },
  });
  const W = 'route:remove';
  try {
    p.act('vmm', 'act', { a: 'route:open:app.cefis.cloud' });
    await p.waitFor(() => p.windowBlocks('route:app.cefis.cloud'), 'gaveta');
    p.act('route:app.cefis.cloud', 'route:remove:app.cefis.cloud', {});
    p.act('route:app.cefis.cloud', 'route:remove:app.cefis.cloud', {});
    const open = await p.waitFor(() => p.requests.find((r) => r.method === 'view.open' && r.params.viewId === W), 'abre a remoção');
    assert.equal(open.params.title, 'Remover rota app.cefis.cloud');
    assert.equal(open.params.modal, true);
    assert.ok(allTexts(open.params.blocks).includes('Conferindo o que a rota usa no OPNsense…'));
    assert.equal(button(open.params.blocks, 'route:delete').disabled, true, 'sem plano não remove');
    assert.ok(p.requests.some((r) => r.method === 'view.close' && r.params.viewId === 'route:app.cefis.cloud'), 'a gaveta sai');
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('SERÁ APAGADO'), 'plano');
    assert.equal(count('POST', '/api/routes/app.cefis.cloud/removal-plan'), 1, 'um plano só');
    let blocks = p.windowBlocks(W);
    assertNoNull(blocks);
    const texts = allTexts(blocks);
    assert.ok(texts.includes('FICA, PORQUE OUTRA COISA AINDA USA'));
    assert.ok(texts.includes('Remover recarrega o HAProxy'));
    assert.ok(texts.includes('O hostname para de responder na hora. No reload, conexões abertas dos outros sites podem cair por cerca de 1 s.'));
    assert.ok(texts.includes('Primeiro a rota sai do ar (com rollback se algo falhar); depois o console apaga o que ficou sem uso.'));
    const lists = [];
    blockWith(blocks, (b) => {
      if (b.type === 'list') lists.push(b);
      return false;
    });
    assert.deepEqual(lists.map((l) => l.items.map((i) => [i.title, i.meta])), [
      [['Linha na mapfile', 'apagar'], ['Backend Pool', 'apagar']],
      [['Certificado', 'fica']],
    ]);
    assert.equal(blockWith(blocks, (b) => b.id === 'confirm').placeholder, 'app.cefis.cloud');
    assert.equal(button(blocks, 'route:delete').label, 'Remover do firewall');
    assert.equal(button(blocks, 'route:delete').style, 'danger');
    // hostname errado: nada sai
    p.act(W, 'route:delete', { confirm: 'old.cefis.cloud' });
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('Digite app.cefis.cloud para confirmar.'), 'confirmação errada');
    await pause(100);
    assert.equal(count('DELETE', '/api/routes/app.cefis.cloud'), 0, 'hostname errado não remove');
    // dois "Remover" + um enter: UM DELETE, com o fingerprint
    p.act(W, 'route:delete', { confirm: 'app.cefis.cloud' });
    p.act(W, 'route:delete', { confirm: 'app.cefis.cloud' });
    p.act(W, 'route:delete', { confirm: 'app.cefis.cloud' });
    p.act(W, 'route:cancel', {});
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('Removendo app.cefis.cloud'), 'removendo');
    assert.equal(count('DELETE', '/api/routes/app.cefis.cloud'), 1, 'um DELETE só');
    assert.deepEqual(api.seen.find((r) => r.method === 'DELETE').body, { fingerprint: 'fp-123' });
    assert.ok(allTexts(p.windowBlocks(W)).includes('Pode fechar: a remoção continua na API e fica registrada na Auditoria.'));
    const routesBefore = count('GET', '/api/routes');
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('Rota removida app.cefis.cloud'), 'removida');
    await p.waitFor(() => count('GET', '/api/routes') === routesBefore + 1, 'relê no fim');
    blocks = p.windowBlocks(W);
    assert.equal(button(blocks, 'route:close').label, 'Fechar');
    p.act(W, 'route:close', {});
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.close' && r.params.viewId === W), 'fecha');
    await p.waitFor(() => count('GET', '/api/routes') === routesBefore + 2, 'relê ao fechar');
    assert.equal(polls, 2);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('remover: sem nada que fica, a lista "FICA" some; erro no plano aparece e trava o botão', { timeout: 15000 }, async () => {
  const { p, close, count } = await openRoutes({
    routes: {
      'POST /api/routes/app.cefis.cloud/removal-plan': () => ({ json: { ...REMOVAL, changes: REMOVAL.changes.filter((c) => c.action === 'remove') } }),
      'POST /api/routes/old.cefis.cloud/removal-plan': () => ({ status: 409, json: { statusCode: 409, message: 'A rota mudou no OPNsense.' }, raw: true }),
      'DELETE /api/routes/old.cefis.cloud': () => ({ json: {} }),
    },
  });
  const W = 'route:remove';
  try {
    p.act('route:app.cefis.cloud', 'route:remove:app.cefis.cloud', {});
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('SERÁ APAGADO'), 'plano');
    assert.ok(!allTexts(p.windowBlocks(W)).includes('FICA, PORQUE OUTRA COISA AINDA USA'));
    p.act(W, 'route:cancel', {});
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.close' && r.params.viewId === W), 'fecha');
    p.act('route:old.cefis.cloud', 'route:remove:old.cefis.cloud', {});
    await p.waitFor(() => allTexts(p.windowBlocks(W)).includes('A rota mudou no OPNsense.'), 'erro do plano');
    assert.equal(button(p.windowBlocks(W), 'route:delete').disabled, true);
    p.act(W, 'route:delete', { confirm: 'old.cefis.cloud' });
    await pause(200);
    assert.equal(count('DELETE', '/api/routes/old.cefis.cloud'), 0, 'sem plano não remove');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('a view de rotas aguenta ctx.user null', { timeout: 15000 }, async () => {
  const dataDir = tmpDir();
  const script = `
    const out = m.screens.get('routes').view({ user: null, now: Date.now });
    process.stderr.write('VIEW=' + JSON.stringify(out) + '\\n');
  `;
  const p = startPlugin({ dataDir, url: 'http://127.0.0.1:9', script });
  try {
    await p.waitFor(() => /VIEW=.*\n/.test(p.stderr()), 'a view no stderr');
    const v = JSON.parse(p.stderr().match(/VIEW=(.*)\n/)[1]);
    assertNoNull(v);
    assert.equal(v.header.newRoute, false);
    assert.equal(v.empty, 'Lendo o OPNsense…');
    assert.deepEqual(v.filters.map((f) => f.countText), ['', '', '', '']);
  } finally {
    await p.stop();
  }
  assert.deepEqual(p.bad, []);
});

test('routes.rfwtxt: sem import, doubles, sem null/args.children, e a casca liga a tela', { timeout: 15000 }, () => {
  const ui = path.join(__dirname, '..', 'ui');
  const src = fs.readFileSync(path.join(ui, 'routes.rfwtxt'), 'utf8');
  assert.ok(!/^import /m.test(src), 'tela sem import');
  const code = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/0x[0-9a-fA-F]+/g, '0')
    .replace(/\b(maxLines|flex):\s*\d+/g, '');
  const ints = code.match(/(?<![\w.])\d+(?![\w.])/g) || [];
  assert.deepEqual(ints.filter((n) => n !== '0'), [], 'números inteiros no .rfwtxt (use 13.0)');
  for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) assert.equal(code.split(o).length, code.split(c).length, `${o}${c} desbalanceados`);
  assert.ok(!/\bnull\b/.test(code));
  assert.ok(!/args\.children\b/.test(code));
  assert.match(src, /widget RoutesScreen =/);
  assert.match(fs.readFileSync(SHELL, 'utf8'), /"routes": RoutesScreen\(\)/);
  const names = fs.readdirSync(ui).filter((f) => f.endsWith('.rfwtxt'))
    .flatMap((f) => [...fs.readFileSync(path.join(ui, f), 'utf8').matchAll(/^widget (\w+) =/gm)].map((x) => x[1]));
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], 'widget repetido entre os .rfwtxt');
});

// --- Task 14: Usuários e Auditoria --------------------------------------------------------

const ME = { id: 1, email: 'ana@x.com', name: 'Ana Admin', role: 'admin' };
const PEOPLE = [
  { id: 1, email: 'ana@x.com', name: 'Ana Admin', role: 'admin', lastSeenAt: new Date().toISOString() },
  { id: 2, email: 'bia@x.com', name: null, role: 'pending', lastSeenAt: null },
  { id: 3, email: 'caio@x.com', name: 'Caio', role: 'viewer', lastSeenAt: null },
];
const patches = (api) => api.seen.filter((s) => s.method === 'PATCH');
const banners = (p) => p.requests.filter((r) => r.method === 'window.showBanner').map((r) => r.params.text);

/** Logado como `user` (a Ana, admin, por padrão) na tela de usuários com a lista lida. */
function openUsers(opts = {}) {
  return openArea('users', (u) => u.rows.length === 3, { user: { ...ME }, ...opts, extra: { '/api/users': PEOPLE, ...(opts.extra || {}) } });
}

test('usuários: lista, banner de pendentes, a própria linha travada, Aprovar manda UM PATCH {role:viewer} e troca a linha', { timeout: 15000 }, async () => {
  const { p, close, api } = await openUsers({
    routes: {
      'PATCH /api/users/2/role': (req, body) => ({ json: { ...PEOPLE[1], role: body.role }, delayMs: 300 }),
      'PATCH /api/users/3/role': (req, body) => ({ json: { ...PEOPLE[2], role: body.role } }),
    },
  });
  try {
    const v = p.mainData().users;
    assertNoNull(v);
    assert.equal(v.pending, '1 pessoa aguardando aprovação');
    assert.equal(v.error, '');
    assert.equal(v.empty, '');
    const [me, bia, caio] = v.rows;
    assert.deepEqual([me.name, me.email, me.roleLabel, me.roleTone], ['Ana Admin', 'ana@x.com', 'Admin', 'accent']);
    assert.equal(me.canChange, false);
    assert.equal(me.lockedTitle, 'Você não pode alterar o próprio papel');
    assert.deepEqual(me.menu, [], 'a própria linha não tem menu');
    assert.equal(bia.name, 'bia@x.com', 'sem nome, o e-mail');
    assert.equal(bia.approve, true);
    assert.equal(bia.approveA, 'user:approve:2');
    assert.equal(bia.lastSeen, 'nunca');
    assert.deepEqual(caio.menu.map((i) => i.action), ['user:role:3:admin', 'user:role:3:viewer', 'user:role:3:pending']);
    assert.equal(caio.approve, false);
    // o próprio papel, forjado: recusa sem PATCH; o mesmo papel também não manda nada
    p.act('vmm', 'act', { action: 'user:role:1:viewer' });
    p.act('vmm', 'act', { action: 'user:role:3:viewer' });
    await pause(200);
    assert.equal(patches(api).length, 0);
    // Aprovar duas vezes e uma troca pelo menu com o PATCH lento: UM PATCH, e a linha trava
    p.act('vmm', 'act', { a: 'user:approve:2' });
    await p.waitFor(() => p.mainData().users.rows[1].saving === true, 'linha salvando');
    assert.equal(p.mainData().users.rows[1].canChange, false);
    assert.deepEqual(p.mainData().users.rows[1].menu, []);
    p.act('vmm', 'act', { a: 'user:approve:2' });
    p.act('vmm', 'act', { action: 'user:role:2:admin' });
    await p.waitFor(() => p.mainData().users.rows[1].saving === false, 'salvou');
    await pause(100);
    assert.equal(patches(api).length, 1, 'um PATCH por clique');
    assert.deepEqual(patches(api)[0].body, { role: 'viewer' });
    assert.equal(patches(api)[0].path, '/api/users/2/role');
    const after = p.mainData().users;
    assert.equal(after.rows[1].roleLabel, 'Viewer');
    assert.equal(after.rows[1].approve, false);
    assert.equal(after.pending, '');
    // trocar o papel do Caio pelo menu (onMenu manda a escolha em `action`)
    p.act('vmm', 'act', { action: 'user:role:3:admin' });
    await p.waitFor(() => p.mainData().users.rows[2].roleLabel === 'Admin', 'Caio admin');
    assert.deepEqual(patches(api)[1].body, { role: 'admin' });
    assert.equal(p.mainData().screen, 'users', 'promover outro não muda nada pra mim');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('usuários: dois papéis diferentes na mesma linha durante o PATCH mandam UM PATCH; o erro aparece em vermelho', { timeout: 15000 }, async () => {
  let fail = false;
  const { p, close, api } = await openUsers({
    routes: {
      'PATCH /api/users/3/role': (req, body) =>
        fail ? { status: 500, json: { statusCode: 500, message: 'Papel inválido.' }, raw: true } : { json: { ...PEOPLE[2], role: body.role }, delayMs: 300 },
    },
  });
  try {
    p.act('vmm', 'act', { action: 'user:role:3:admin' });
    p.act('vmm', 'act', { action: 'user:role:3:pending' });
    await p.waitFor(() => p.mainData().users.rows[2].roleLabel === 'Admin' && !p.mainData().users.rows[2].saving, 'salvou');
    await pause(100);
    assert.equal(patches(api).length, 1);
    fail = true;
    p.act('vmm', 'act', { action: 'user:role:3:viewer' });
    await p.waitFor(() => p.mainData().users.error === 'Papel inválido.', 'erro em vermelho');
    assert.equal(p.mainData().users.rows[2].roleLabel, 'Admin', 'a linha fica como estava');
    assert.equal(p.mainData().users.rows[2].canChange, true, 'a linha destrava');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('usuários: reentrar na tela durante um PATCH lento não deixa a linha travada, e a linha fica com o papel novo', { timeout: 15000 }, async () => {
  const { p, close, api, count } = await openUsers({
    extra: { '/api/audit': { data: [], pagination: null } },
    routes: { 'PATCH /api/users/2/role': (req, body) => ({ json: { ...PEOPLE[1], role: body.role }, delayMs: 600 }) },
  });
  try {
    p.act('vmm', 'act', { a: 'user:approve:2' });
    await p.waitFor(() => p.mainData().users.rows[1].saving === true, 'salvando');
    const lists = count('GET', '/api/users');
    p.act('vmm', 'nav', { to: 'audit' });
    await p.waitFor(() => p.mainData().screen === 'audit', 'auditoria');
    p.act('vmm', 'nav', { to: 'users' });
    await p.waitFor(() => p.mainData().screen === 'users' && count('GET', '/api/users') >= lists + 2, 'releu a lista');
    await p.waitFor(() => patches(api).length === 1 && p.mainData().users.rows[1].saving === false, 'destravou', 3000);
    const row = p.mainData().users.rows[1];
    assert.equal(row.roleLabel, 'Viewer');
    assert.equal(row.canChange, true);
    assert.equal(p.mainData().users.pending, '');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('usuários: ações de usuário fora da tela de usuários não chamam a API', { timeout: 15000 }, async () => {
  const { p, close, api } = await openUsers({ routes: { 'PATCH /api/users/2/role': () => ({ json: PEOPLE[1] }) } });
  try {
    p.act('vmm', 'nav', { to: 'vms' });
    await p.waitFor(() => p.mainData().screen === 'vms', 'vms');
    p.act('vmm', 'act', { a: 'user:approve:2' });
    await pause(250);
    assert.equal(patches(api).length, 0);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('usuários: um 403 (rebaixado noutro lugar) relê o /auth/me e cai no "só admins"', { timeout: 15000 }, async () => {
  const me = { ...ME };
  const { p, close, api } = await openUsers({
    user: me,
    routes: {
      'PATCH /api/users/3/role': () => {
        me.role = 'viewer'; // o /auth/me passa a dizer viewer
        return { status: 403, json: { statusCode: 403, message: 'Forbidden' }, raw: true };
      },
    },
  });
  try {
    const mesBefore = api.seen.filter((s) => s.path === '/api/auth/me').length;
    p.act('vmm', 'act', { action: 'user:role:3:admin' });
    await p.waitFor(() => p.mainData().screen === 'forbidden', 'forbidden');
    assert.ok(api.seen.filter((s) => s.path === '/api/auth/me').length > mesBefore, 'releu o /auth/me');
    const ids = p.mainData().nav.flatMap((g) => g.items.map((i) => i.id));
    assert.ok(!ids.includes('users') && !ids.includes('audit'), 'a nav de viewer');
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('usuários e auditoria (viewer): "Só admins podem fazer isso." e ações forjadas não chamam a API', { timeout: 15000 }, async () => {
  const { p, close, api } = await openVms({ user: VIEWER, extra: { '/api/users': PEOPLE } });
  try {
    p.act('vmm', 'nav', { to: 'users' });
    await p.waitFor(() => p.mainData().screen === 'forbidden', 'forbidden em users');
    p.act('vmm', 'nav', { to: 'audit' });
    await pause(200);
    assert.equal(p.mainData().screen, 'forbidden');
    p.act('vmm', 'act', { a: 'user:approve:2' });
    p.act('vmm', 'act', { action: 'user:role:3:admin' });
    p.act('vmm', 'act', { action: 'audit:action:vm.start' });
    p.act('vmm', 'act', { a: 'audit:page:next' });
    await pause(300);
    assert.equal(patches(api).length, 0);
    assert.equal(api.seen.filter((s) => s.path === '/api/users' || s.path === '/api/audit').length, 0);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

const EV = (id, extra = {}) => ({
  id, createdAt: '2026-10-26T12:00:00Z', userId: 1, userEmail: 'ana@x.com', action: 'vm.start', target: 'vm:177',
  outcome: 'success', error: null, detail: null, ip: '10.1.1.1', ...extra,
});

/** A auditoria de mentira: 3 páginas de 2 (5 eventos); cada página/filtro com ids próprios. */
function auditRoute(opts = {}) {
  return (req) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const page = Number(q.get('page'));
    const delayMs = opts.delay ? opts.delay(q) : 0;
    const base = (q.get('action') === 'vm.stop' ? 100 : 0) + page * 10;
    const data = page === 3 ? [EV(base + 1)] : [EV(base + 1, { detail: { vmid: 177 }, outcome: 'failure', error: 'boom' }), EV(base + 2, { userId: 3, userEmail: 'caio@x.com' })];
    return { raw: true, delayMs, json: { data, pagination: { currentPage: page, perPage: 2, totalItems: 5, lastPage: 3 } } };
  };
}
const audits = (api) => api.seen.filter((s) => s.path === '/api/audit').map((s) => s.url.split('?')[1]);

test('auditoria: filtros mudam a query e voltam pra página 1, paginação nas pontas, a página anterior fica até a próxima chegar, e o detalhe abre', { timeout: 15000 }, async () => {
  let slow = false;
  const { p, close, api } = await openArea('audit', (a) => a.rows.length === 2, {
    user: { ...ME },
    extra: { '/api/users': PEOPLE },
    routes: { 'GET /api/audit': auditRoute({ delay: () => (slow ? 300 : 0) }) },
  });
  try {
    let v = p.mainData().audit;
    assertNoNull(v);
    assert.deepEqual(audits(api), ['page=1']);
    assert.equal(v.count, '5 eventos');
    assert.equal(v.range, '1–2 de 5');
    assert.equal(v.page, '1 / 3');
    assert.equal(v.prevDisabled, true);
    assert.equal(v.nextDisabled, false);
    assert.deepEqual(v.filters.map((f) => [f.label, f.value]), [['Ação', 'Todas'], ['Resultado', 'Todos'], ['Pessoa', 'Todas']]);
    assert.deepEqual(v.filters[2].menu.map((i) => i.label), ['Todas', 'Ana Admin', 'bia@x.com', 'Caio']);
    assert.equal(v.rows[0].who, 'Ana Admin');
    assert.equal(v.rows[0].whoSub, 'ana@x.com');
    assert.equal(v.rows[0].outcome, 'Falha');
    assert.equal(v.rows[0].toggleTitle, 'Ver detalhe');
    // anterior na página 1: nada
    p.act('vmm', 'act', { a: 'audit:page:prev' });
    await pause(150);
    assert.equal(audits(api).length, 1);
    // abrir o detalhe: erro, JSON e IP; a segunda linha sem detail mostra "—"
    p.act('vmm', 'act', { a: v.rows[0].toggle });
    await p.waitFor(() => p.mainData().audit.rows[0].expanded === true, 'abriu');
    v = p.mainData().audit;
    assert.equal(v.rows[0].toggleTitle, 'Esconder detalhe');
    assert.deepEqual(v.rows[0].detail, { error: 'boom', json: JSON.stringify({ vmid: 177 }, null, 2), ip: '10.1.1.1' });
    p.act('vmm', 'act', { a: v.rows[1].toggle });
    await p.waitFor(() => p.mainData().audit.rows[1].expanded === true && p.mainData().audit.rows[0].expanded === false, 'trocou');
    assert.equal(p.mainData().audit.rows[1].detail.json, '—');
    p.act('vmm', 'act', { a: p.mainData().audit.rows[1].toggle });
    await p.waitFor(() => p.mainData().audit.rows.every((r) => !r.expanded), 'fechou');
    // próxima (lenta): a página 1 fica na tela até a 2 chegar
    slow = true;
    p.act('vmm', 'act', { a: 'audit:page:next' });
    await p.waitFor(() => audits(api).length === 2, 'pediu a 2');
    await pause(100);
    assert.equal(p.mainData().audit.rows[0].id, 11, 'a página 1 ainda na tela');
    await p.waitFor(() => p.mainData().audit.rows[0].id === 21, 'página 2');
    slow = false;
    assert.equal(audits(api)[1], 'page=2');
    p.act('vmm', 'act', { a: 'audit:page:next' });
    await p.waitFor(() => p.mainData().audit.page === '3 / 3', 'página 3');
    assert.equal(p.mainData().audit.nextDisabled, true);
    assert.equal(p.mainData().audit.range, '5–5 de 5');
    p.act('vmm', 'act', { a: 'audit:page:next' });
    await pause(150);
    assert.equal(audits(api).length, 3, 'próxima na última: nada');
    // filtros: cada um muda a query e volta pra página 1
    p.act('vmm', 'act', { action: 'audit:action:vm.stop' });
    await p.waitFor(() => audits(api).length === 4, 'filtro ação');
    assert.equal(audits(api)[3], 'page=1&action=vm.stop');
    await p.waitFor(() => p.mainData().audit.page === '1 / 3' && p.mainData().audit.rows[0].id === 111, 'página 1 da ação');
    assert.equal(p.mainData().audit.filters[0].value, 'Desligar VM');
    p.act('vmm', 'act', { action: 'audit:outcome:failure' });
    await p.waitFor(() => audits(api).length === 5, 'filtro resultado');
    p.act('vmm', 'act', { action: 'audit:user:3' });
    await p.waitFor(() => audits(api).length === 6, 'filtro pessoa');
    assert.equal(audits(api)[5], 'page=1&action=vm.stop&outcome=failure&userId=3');
    await p.waitFor(() => p.mainData().audit.filters[2].value === 'Caio', 'Pessoa Caio');
    p.act('vmm', 'act', { action: 'audit:user:99' }); // ninguém
    p.act('vmm', 'act', { action: 'audit:action:nao.existe' });
    p.act('vmm', 'act', { action: 'audit:user:3' }); // o mesmo
    await pause(150);
    assert.equal(audits(api).length, 6, 'filtro inválido ou igual não busca');
    p.act('vmm', 'act', { action: 'audit:action:' });
    await p.waitFor(() => audits(api).length === 7, 'Todas');
    assert.equal(audits(api)[6], 'page=1&outcome=failure&userId=3');
    assertNoNull(p.mainData().audit);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('auditoria: uma resposta atrasada é largada (vale a do último filtro); o erro mostra "Não deu para carregar a auditoria."', { timeout: 15000 }, async () => {
  let fail = false;
  const route = auditRoute({ delay: (q) => (q.get('action') === 'vm.stop' ? 400 : 0) });
  const { p, close, api } = await openArea('audit', (a) => a.rows.length === 2, {
    user: { ...ME },
    extra: { '/api/users': PEOPLE },
    routes: { 'GET /api/audit': (req) => (fail ? { status: 500, json: { statusCode: 500, message: 'Banco fora.' }, raw: true } : route(req)) },
  });
  try {
    p.act('vmm', 'act', { action: 'audit:action:vm.stop' }); // lenta
    await p.waitFor(() => audits(api).length === 2, 'pediu a lenta');
    p.act('vmm', 'act', { action: 'audit:action:vm.start' }); // rápida
    await p.waitFor(() => p.mainData().audit.filters[0].value === 'Ligar VM' && audits(api).length === 3, 'pediu a rápida');
    await pause(600); // a lenta chega depois
    assert.equal(p.mainData().audit.rows[0].id, 11, 'vale a do último filtro');
    assert.equal(p.mainData().audit.filters[0].value, 'Ligar VM');
    fail = true;
    p.act('vmm', 'act', { action: 'audit:outcome:success' });
    await p.waitFor(() => p.mainData().audit.error === 'Banco fora.', 'erro');
    const v = p.mainData().audit;
    assert.equal(v.empty, 'Não deu para carregar a auditoria.');
    assert.deepEqual(v.rows, []);
    assert.equal(v.showPager, false);
    assertNoNull(v);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('as views de usuários e auditoria aguentam ctx.user null', { timeout: 15000 }, async () => {
  const dataDir = tmpDir();
  const script = `
    const u = m.screens.get('users').view({ user: null, now: Date.now });
    const a = m.screens.get('audit').view({ user: null, now: Date.now });
    process.stderr.write('VIEW=' + JSON.stringify({ u, a }) + '\\n');
  `;
  const p = startPlugin({ dataDir, url: 'http://127.0.0.1:9', script });
  try {
    await p.waitFor(() => /VIEW=.*\n/.test(p.stderr()), 'a view no stderr');
    const { u, a } = JSON.parse(p.stderr().match(/VIEW=(.*)\n/)[1]);
    assertNoNull(u);
    assertNoNull(a);
    assert.equal(u.empty, 'Carregando…');
    assert.equal(a.empty, 'Carregando…');
    assert.equal(a.count, '');
    assert.equal(a.filters.length, 3);
  } finally {
    await p.stop();
  }
  assert.deepEqual(p.bad, []);
});

test('admin.rfwtxt: sem import, doubles, sem null/args.children, e a casca liga as telas', { timeout: 15000 }, () => {
  const ui = path.join(__dirname, '..', 'ui');
  const src = fs.readFileSync(path.join(ui, 'admin.rfwtxt'), 'utf8');
  assert.ok(!/^import /m.test(src), 'tela sem import');
  const code = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/0x[0-9a-fA-F]+/g, '0')
    .replace(/\b(maxLines|flex):\s*\d+/g, '');
  const ints = code.match(/(?<![\w.])\d+(?![\w.])/g) || [];
  assert.deepEqual(ints.filter((n) => n !== '0'), [], 'números inteiros no .rfwtxt (use 13.0)');
  for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) assert.equal(code.split(o).length, code.split(c).length, `${o}${c} desbalanceados`);
  assert.ok(!/\bnull\b/.test(code));
  assert.ok(!/args\.children\b/.test(code));
  assert.match(src, /widget UsersScreen =/);
  assert.match(src, /widget AuditScreen =/);
  const shell = fs.readFileSync(SHELL, 'utf8');
  assert.match(shell, /"users": UsersScreen\(\)/);
  assert.match(shell, /"audit": AuditScreen\(\)/);
  const names = fs.readdirSync(ui).filter((f) => f.endsWith('.rfwtxt'))
    .flatMap((f) => [...fs.readFileSync(path.join(ui, f), 'utf8').matchAll(/^widget (\w+) =/gm)].map((x) => x[1]));
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], 'widget repetido entre os .rfwtxt');
});

// --- Task 12 (revisão): janela de rota fechada com o pedido andando -------------------------

test('rotas: fechar a "Nova rota" com o POST andando avisa que a criação continua em segundo plano', { timeout: 15000 }, async () => {
  const RUNNING = jobOf('create', 'running', [{ step: 'certificate', status: 'running', detail: null }]);
  const { p, close } = await openRoutes({
    routes: { 'POST /api/routes/plan': () => ({ json: PLAN }), 'POST /api/routes': () => ({ json: RUNNING, delayMs: 400 }) },
  });
  try {
    p.act('vmm', 'act', { a: 'route:new' });
    await p.waitFor(() => p.windowBlocks('route:new'), 'abre');
    p.act('route:new', 'route:review', NEW_VALUES);
    await p.waitFor(() => allTexts(p.windowBlocks('route:new')).includes('2 de 2 · Revisão'), 'revisão');
    p.act('route:new', 'route:apply', { confirm: 'novo.cefis.cloud' });
    await p.waitFor(() => button(p.windowBlocks('route:new'), 'route:apply').disabled === true, 'aplicando');
    p.send('event', { type: 'view.closed', viewId: 'route:new' }, { notify: true });
    await p.waitFor(() => banners(p).length > 0, 'banner');
    assert.deepEqual(banners(p), ['A criação de novo.cefis.cloud continua em segundo plano; confira na Auditoria e use Ler agora.']);
    await pause(600);
    assert.equal(banners(p).length, 1);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('rotas: fechar a remoção com o DELETE andando avisa; fechar sem pedido andando não', { timeout: 15000 }, async () => {
  const RUNNING = jobOf('remove', 'running', [{ step: 'remove_mapfiles', status: 'running', detail: null }]);
  const { p, close } = await openRoutes({
    routes: {
      'POST /api/routes/app.cefis.cloud/removal-plan': () => ({ json: REMOVAL }),
      'DELETE /api/routes/app.cefis.cloud': () => ({ json: RUNNING, delayMs: 400 }),
    },
  });
  const W = 'route:remove';
  const opens = (id) => p.requests.filter((r) => r.method === 'view.open' && r.params.viewId === id).length;
  const openIt = async () => {
    const [drawers, windows] = [opens('route:app.cefis.cloud'), opens(W)];
    p.act('vmm', 'act', { a: 'route:open:app.cefis.cloud' });
    await p.waitFor(() => opens('route:app.cefis.cloud') > drawers, 'gaveta');
    p.act('route:app.cefis.cloud', 'route:remove:app.cefis.cloud', {});
    await p.waitFor(() => opens(W) > windows, 'abre a remoção');
    await p.waitFor(() => { const b = button(p.windowBlocks(W), 'route:delete'); return b && b.disabled === false; }, 'plano');
  };
  try {
    await openIt();
    p.send('event', { type: 'view.closed', viewId: W }, { notify: true }); // nada andando
    await pause(200);
    assert.deepEqual(banners(p), []);
    await openIt();
    p.act(W, 'route:delete', { confirm: 'app.cefis.cloud' });
    await p.waitFor(() => button(p.windowBlocks(W), 'route:delete').disabled === true && allTexts(p.windowBlocks(W)).includes('SERÁ APAGADO'), 'removendo');
    p.send('event', { type: 'view.closed', viewId: W }, { notify: true });
    await p.waitFor(() => banners(p).length > 0, 'banner');
    assert.deepEqual(banners(p), ['A remoção de app.cefis.cloud continua em segundo plano; confira na Auditoria e use Ler agora.']);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

test('rotas: a sessão que expira com o POST andando volta pro login sem o banner de "segundo plano"', { timeout: 15000 }, async () => {
  const { p, close } = await openRoutes({
    routes: {
      'POST /api/routes/plan': () => ({ json: PLAN }),
      'POST /api/routes': () => ({ status: 401, json: { statusCode: 401, message: 'Unauthorized' }, raw: true, delayMs: 300 }),
    },
  });
  try {
    p.act('vmm', 'act', { a: 'route:new' });
    await p.waitFor(() => p.windowBlocks('route:new'), 'abre');
    p.act('route:new', 'route:review', NEW_VALUES);
    await p.waitFor(() => allTexts(p.windowBlocks('route:new')).includes('2 de 2 · Revisão'), 'revisão');
    p.act('route:new', 'route:apply', { confirm: 'novo.cefis.cloud' });
    await p.waitFor(() => p.mainData().screen === 'login' && p.mainData().login.message === 'Sua sessão expirou. Entre de novo.', 'login expirado');
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.close' && r.params.viewId === 'route:new'), 'fechou a janela');
    await pause(200);
    assert.deepEqual(banners(p).filter((t) => /segundo plano/.test(t)), []);
  } finally {
    await close();
  }
  assert.deepEqual(p.bad, []);
});

// --- revisão final da branch ------------------------------------------------------------

const EXPIRED_TEXT = 'Sua sessão expirou. Entre de novo.';

test('token guardado já vencido: abrir mostra o login com "Sua sessão expirou" e apaga o auth.json', { timeout: 15000 }, async () => {
  const api = await fakeApi({ 'tok-old': ADMIN });
  const dataDir = tmpDir();
  seed(dataDir, api.url, 'tok-old', ADMIN, { obtainedAt: Date.now() - 7200000, expiresAt: Date.now() - 1000 });
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'login' && p.mainData().login.message === EXPIRED_TEXT, 'login com o aviso');
    assert.equal(fs.existsSync(path.join(dataDir, 'auth.json')), false);
    assert.ok(api.seen.every((r) => !r.auth.includes('tok-old')), 'o token vencido não vai pra API');
  } finally {
    await p.stop();
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('o token vence com a janela aberta: a próxima chamada volta pro login com o aviso', { timeout: 15000 }, async () => {
  const token = 'tok-short';
  const api = await fakeApi({ [token]: ADMIN }, {
    extra: { '/api/vms/177': DETAIL },
    routes: { 'POST /api/auth/plugin/refresh': () => ({ status: 503, json: { statusCode: 503, message: 'x' }, raw: true }) },
  });
  const dataDir = tmpDir();
  const now = Date.now();
  seed(dataDir, api.url, token, ADMIN, { obtainedAt: now, expiresAt: now + 1500 });
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'vms' && p.mainData().vms && p.mainData().vms.rows.length === 2, 'tela vms');
    await pause(Math.max(0, now + 1600 - Date.now()));
    p.act('vmm', 'act', { a: 'vm:open:177' });
    await p.waitFor(() => p.mainData().screen === 'login' && p.mainData().login.message === EXPIRED_TEXT, 'login com o aviso');
    assert.equal(fs.existsSync(path.join(dataDir, 'auth.json')), false);
  } finally {
    await p.stop();
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('scrub: NaN e Infinity viram 0 (o JSON os mandaria como null)', { timeout: 15000 }, async () => {
  const dataDir = tmpDir();
  const script = `
    const out = m.scrub({ a: NaN, b: Infinity, c: [-Infinity, 1.5], d: { pct: 0 / 0 }, e: 'x', f: null });
    process.stderr.write('OUT=' + JSON.stringify(out) + '\\n');
  `;
  const p = startPlugin({ dataDir, url: 'http://127.0.0.1:9', script });
  try {
    await p.waitFor(() => /OUT=.*\n/.test(p.stderr()), 'a saída no stderr');
    const out = JSON.parse(p.stderr().match(/OUT=(.*)\n/)[1]);
    assert.deepEqual(out, { a: 0, b: 0, c: [0, 1.5], d: { pct: 0 }, e: 'x', f: '' });
    assertNoNull(out);
  } finally {
    await p.stop();
  }
  assert.deepEqual(p.bad, []);
});

test('shell.rfwtxt: a raiz é um widget simples e o switch mora no Screen', { timeout: 15000 }, () => {
  const src = fs.readFileSync(SHELL, 'utf8');
  assert.match(src, /^widget root = Screen\(\);$/m);
  assert.match(src, /^widget Screen = switch data\.screen \{$/m);
});

test('sem o textInput na Maestria, as buscas somem (data.textInput e o switch em toda busca)', { timeout: 15000 }, async () => {
  const ui = path.join(__dirname, '..', 'ui');
  let inputs = 0;
  let guarded = 0;
  for (const f of fs.readdirSync(ui).filter((x) => x.endsWith('.rfwtxt'))) {
    const src = fs.readFileSync(path.join(ui, f), 'utf8').replace(/\/\/[^\n]*/g, '');
    inputs += (src.match(/\bTextInput\(/g) || []).length;
    guarded += (src.match(/switch data\.textInput \{\s*true: SizedBox\(\s*width: [\d.]+,\s*child: TextInput\(/g) || []).length;
  }
  assert.ok(inputs > 0);
  assert.equal(guarded, inputs, 'todo TextInput atrás do switch data.textInput');
  for (const [extra, want] of [[{ textInput: undefined }, false], [{ textInput: 1 }, true]]) {
    const dataDir = tmpDir();
    const p = startPlugin({ dataDir, url: 'http://127.0.0.1:9' });
    try {
      await p.init(extra);
      await p.call('command.invoke', { command: 'abrir', context: {} });
      const open = await p.waitFor(() => p.requests.find((r) => r.method === 'view.open' && r.params.viewId === 'vmm'), 'view.open');
      assert.equal(open.params.data.textInput, want);
    } finally {
      await p.stop();
    }
    assert.deepEqual(p.bad, []);
  }
});

/** O login pelo navegador: o endereço que o plugin pediu pra abrir. */
const openUrls = (p) => p.requests.filter((r) => r.method === 'window.openUrl').map((r) => r.params.url);
const callback = (u, query) => {
  const url = new URL(u);
  return fetch(`http://127.0.0.1:${url.searchParams.get('port')}/callback?state=${url.searchParams.get('state')}&${query}`);
};

test('login esperando o navegador: "abrir de novo" reabre o mesmo endereço, "cancelar" libera e o retorno fecha', { timeout: 15000 }, async () => {
  const api = await fakeApi({ 'tok-new': ADMIN }, {
    publicRoutes: { 'POST /api/auth/plugin/token': () => ({ json: { token: 'tok-new', expiresAt: new Date(Date.now() + 3600000).toISOString(), user: ADMIN } }) },
  });
  const dataDir = tmpDir();
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'login', 'login');
    await pause(100); // a resposta do view.open chegar (antes disso não há o que redesenhar)
    p.act('vmm', 'login', {});
    await p.waitFor(() => openUrls(p).length === 1 && p.mainData().login.busy === true, 'abriu o navegador');
    p.act('vmm', 'act', { a: 'login:reopen' });
    await p.waitFor(() => openUrls(p).length === 2, 'abriu de novo');
    assert.equal(openUrls(p)[1], openUrls(p)[0], 'o mesmo endereço');
    p.act('vmm', 'act', { a: 'login:cancel' });
    await p.waitFor(() => p.mainData().login.busy === false, 'liberou');
    assert.equal(p.mainData().login.message, 'Login cancelado.');
    await assert.rejects(callback(openUrls(p)[0], 'code=c1'), 'o retorno do login cancelado fechou');
    // e o login de novo entra
    p.act('vmm', 'login', {});
    await p.waitFor(() => openUrls(p).length === 3, 'abriu o navegador de novo');
    const res = await callback(openUrls(p)[2], 'code=c2');
    assert.equal(res.status, 200);
    await p.waitFor(() => p.mainData().screen === 'vms', 'entrou');
  } finally {
    await p.stop();
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});

test('sair com o login esperando o navegador fecha o retorno: o login não termina entrando', { timeout: 15000 }, async () => {
  const api = await fakeApi({ 'tok-new': ADMIN }, {
    publicRoutes: { 'POST /api/auth/plugin/token': () => ({ json: { token: 'tok-new', expiresAt: new Date(Date.now() + 3600000).toISOString(), user: ADMIN } }) },
  });
  const dataDir = tmpDir();
  const p = startPlugin({ dataDir, url: api.url });
  try {
    await p.init();
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => p.mainData().screen === 'login', 'login');
    await pause(100);
    p.act('vmm', 'login', {});
    await p.waitFor(() => openUrls(p).length === 1 && p.mainData().login.busy === true, 'abriu o navegador');
    p.act('vmm', 'logout', {});
    await p.waitFor(() => p.mainData().login.busy === false, 'saiu');
    await assert.rejects(callback(openUrls(p)[0], 'code=c1'), 'o retorno fechou');
    await pause(200);
    assert.equal(fs.existsSync(path.join(dataDir, 'auth.json')), false);
    assert.equal(p.mainData().screen, 'login');
    assert.equal(p.mainData().login.message, '');
    assert.equal(api.seen.some((r) => r.path === '/api/auth/plugin/token'), false);
  } finally {
    await p.stop();
    closeApi(api);
  }
  assert.deepEqual(p.bad, []);
});
