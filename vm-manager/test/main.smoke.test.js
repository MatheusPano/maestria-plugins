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
function fakeApi(users, { failMe = 0, extra = {}, routes = {} } = {}) {
  const seen = [];
  let fails = failMe;
  const gets = { '/api/vms': [VM_JIBRI, VM_DB], '/api/overview': OVERVIEW, ...extra };
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
      const route = routes[`${req.method} ${pathname}`];
      if (route && users[token]) {
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

/** Sobe o plugin e fala com ele como a janela. */
// `script`: código rodado depois do require do main.js (com `m` = o módulo), pra ligar telas de mentira.
// `openReply()`: o `open` que a janela responde a cada view.update.
// `env`: variáveis a mais (os ganchos de teste do main.js, como VMM_CREATE_TIMEOUT_MS).
function startPlugin({ dataDir, url, script = '', openReply = () => true, env = {} }) {
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
        if (msg.method === 'view.update') result = { open: msg.params.viewId === 'vmm' ? openReply() : true };
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

test('API fora do ar: tela fatal com a mensagem, sem o token', async () => {
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

test('tentar de novo: a API volta e a tela sai do fatal', async () => {
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
    api.server.close();
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

test('janela fechada (open:false) para o polling e não liga outro até reabrir', async () => {
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
    await p.waitFor(() => p.requests.some((r) => r.method === 'view.update' && r.params.data && r.params.data.vms && polls() > 3), 'um update depois de fechar');
    await pause(150);
    const [pollsAfter, updatesAfter] = [polls(), updates()];
    await pause(300);
    assert.equal(polls(), pollsAfter, 'sem polling com a janela fechada');
    assert.equal(updates(), updatesAfter, 'sem view.update com a janela fechada');

    // navegar com a janela fechada não liga o poller da outra tela
    p.send('view.action', { viewId: 'vmm', action: 'nav', values: { to: 'ceph' } }, { notify: true });
    await p.waitFor(() => api.seen.filter((r) => r.url === '/api/auth/me').length >= 2, '/auth/me do nav');
    await pause(300);
    assert.equal(polls(), pollsAfter, 'onEnter não roda com a janela fechada');

    // reabrir liga de novo
    open = true;
    await p.call('command.invoke', { command: 'abrir', context: {} });
    await p.waitFor(() => polls() >= pollsAfter + 2, 'polling de volta depois de reabrir');
  } finally {
    await p.stop();
    api.server.close();
  }
  assert.deepEqual(p.bad, []);
});

test('nova vm… de um viewer com a janela fechada dá o recado', async () => {
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
    api.server.close();
  }
  assert.deepEqual(p.bad, []);
});

test('nova vm… de um pendente com a janela fechada dá o recado', async () => {
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
    api.server.close();
  }
  assert.deepEqual(p.bad, []);
});

test('router: numa janela de blocos, values.action não sequestra a ação', async () => {
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
async function openVms({ user = ADMIN, routes = {}, extra = {}, env = {} } = {}) {
  const token = `tok-${user.role}-${Math.random().toString(36).slice(2)}`;
  const api = await fakeApi({ [token]: user }, { routes, extra: { ...CATALOG, '/api/vms/177': DETAIL, ...extra } });
  const dataDir = tmpDir();
  seed(dataDir, api.url, token, user);
  const p = startPlugin({ dataDir, url: api.url, env });
  await p.init();
  await p.call('command.invoke', { command: 'abrir', context: {} });
  await p.waitFor(() => {
    const d = p.mainData();
    return d.screen === 'vms' && d.vms && d.vms.rows && d.vms.rows.length === 2 && d.vms.overview && d.vms.overview.loaded;
  }, 'tela vms com as linhas e o overview');
  const count = (method, path) => api.seen.filter((r) => r.method === method && r.path === path).length;
  const close = async () => {
    await p.stop();
    api.server.close();
  };
  return { p, api, count, close, token };
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

test('vms (admin): linhas, overview e ações na tela, sem null', async () => {
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

test('vms (viewer): sem ações, "Somente leitura", e uma ação forjada não chama a API', async () => {
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

test('ação de linha: passa pelo busy ("Aguarde…") e o clique duplo manda UM POST', async () => {
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

test('ação de linha com erro: o banner vermelho na tela traz "<nome>: <mensagem>"', async () => {
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

test('destruir: nome errado não manda DELETE; o nome certo manda um', async () => {
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

test('detalhes: abre com "Carregando…" e mostra as seções e o link do NetBox', async () => {
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

test('Nova VM: abre com o catálogo, os padrões e o IP automático', async () => {
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

test('dois create:submit seguidos mandam UM POST /vms', async () => {
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

test('POST que estoura o timeout: acompanha, "nova vm…" no meio não reenvia, e mostra o resultado real', async () => {
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

test('janela da Nova VM fechada: o fim da criação vira banner', async () => {
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

test('vms.rfwtxt: sem import, tamanhos em double e só construções da casca', () => {
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

test('a view de vms aguenta ctx.user null (um render logo depois do sair)', async () => {
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
