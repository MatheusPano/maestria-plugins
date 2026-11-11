'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const history = require('../history');
const distro = require('../distro');

test('parse tira o carimbo do zsh e as linhas de hora do bash', () => {
  const text = ': 1699999999:0;ceph -s\n#1700000000\nlsblk\n\n  sudo cephadm shell  \n';
  assert.deepStrictEqual(history.parse(text), ['ceph -s', 'lsblk', 'sudo cephadm shell']);
});

test('rank conta e põe o mais recente primeiro', () => {
  const r = history.rank(['ls', 'ceph -s', 'ls', 'df -h']);
  assert.deepStrictEqual(r.map((e) => [e.cmd, e.count]), [['df -h', 1], ['ls', 2], ['ceph -s', 1]]);
});

test('splitOutput separa os comandos da linha do sistema', () => {
  const out = 'ls\nceph -s\n@@maestria-os@@\nubuntu|debian|Ubuntu\n';
  assert.deepStrictEqual(history.splitOutput(out), { lines: ['ls', 'ceph -s'], os: 'ubuntu|debian|Ubuntu' });
});

test('entries: fixados primeiro, mandados pelo painel acima do servidor, e o filtro', () => {
  let data = history.applyRemote(history.load('/nao/existe', 'x'), { lines: ['ls', 'ceph -s', 'ls', 'df -h'] });
  data = history.recordSent(data, 'ceph -s');
  data = history.togglePin(data, 'uptime');
  const recent = history.entries(data).map((e) => e.cmd);
  assert.deepStrictEqual(recent, ['uptime', 'ceph -s', 'df -h', 'ls']);
  const frequent = history.entries(data, { order: 'frequentes' }).map((e) => e.cmd);
  assert.deepStrictEqual(frequent.slice(1, 3).sort(), ['ceph -s', 'ls']);
  assert.deepStrictEqual(history.entries(data, { filter: 'CEPH' }).map((e) => e.cmd), ['ceph -s']);
});

test('um comando tirado da lista não volta na próxima leitura', () => {
  let data = history.applyRemote(history.load('/nao/existe', 'x'), { lines: ['senha123', 'ls'] });
  data = history.forget(data, 'senha123');
  data = history.applyRemote(data, { lines: ['senha123', 'ls'] });
  assert.deepStrictEqual(history.entries(data).map((e) => e.cmd), ['ls']);
});

test('uma leitura que falhou guarda o erro e mantém o que havia', () => {
  let data = history.applyRemote(history.load('/nao/existe', 'x'), { lines: ['ls'] });
  data = history.applyRemote(data, { error: 'Permission denied (publickey,password).' });
  assert.strictEqual(data.error, 'Permission denied (publickey,password).');
  assert.deepStrictEqual(history.entries(data).map((e) => e.cmd), ['ls']);
});

test('save, load, rename e drop por alias', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshhist-'));
  history.save(dir, 'a/b', history.togglePin(history.load(dir, 'a/b'), 'ls'));
  assert.deepStrictEqual(history.load(dir, 'a/b').pinned, ['ls']);
  history.rename(dir, 'a/b', 'c');
  assert.deepStrictEqual(history.load(dir, 'c').pinned, ['ls']);
  history.drop(dir, 'c');
  assert.deepStrictEqual(history.load(dir, 'c').pinned, []);
});

test('fetchRemote lê pelo sh do outro lado (com um ssh de mentira)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshfake-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.bash_history'), 'ls\nceph -s\n');
  const fake = path.join(dir, 'ssh');
  // Ignora as opções e o alias e roda o `sh -s` com a home de mentira.
  fs.writeFileSync(fake, `#!/bin/sh\nHOME='${home}' exec sh -s\n`, { mode: 0o755 });
  const r = await history.fetchRemote('x', { binary: fake });
  assert.deepStrictEqual(r.lines, ['ls', 'ceph -s']);
  assert.ok(r.os);
});

test('detect acha o desenho pelo os-release', () => {
  assert.strictEqual(distro.detect('ubuntu|debian|Ubuntu'), 'ubuntu');
  assert.strictEqual(distro.detect('almalinux|rhel centos fedora|AlmaLinux'), 'rocky');
  assert.strictEqual(distro.detect('proxmox|debian|Proxmox'), 'proxmox');
  assert.strictEqual(distro.detect('FreeBSD'), 'freebsd');
  assert.strictEqual(distro.detect('opnsense||OPNsense'), 'firewall');
  assert.strictEqual(distro.detect('weird||Weird Linux'), 'linux');
  assert.strictEqual(distro.detect(''), '');
});

test('look: a escolha do formulário vale sobre a detectada, e cada desenho existe', () => {
  assert.strictEqual(distro.look({ os: 'ubuntu', icon: 'debian' }).icon, 'icons/os/debian.svg');
  assert.strictEqual(distro.look({ os: 'ubuntu', icon: 'server' }).icon, 'server');
  assert.strictEqual(distro.look({}).icon, 'server');
  for (const id of Object.keys(distro.OS)) assert.ok(fs.existsSync(path.join(__dirname, '..', 'icons', 'os', `${id}.svg`)), id);
});

test('badge é o quadrado na cor do sistema com o desenho em branco', () => {
  const svg = distro.badge('ubuntu');
  assert.match(svg, /^<svg [^>]*viewBox="0 0 36 36"><rect [^>]*fill="#e95420"\/>/);
  assert.ok(!svg.includes('#000'));
  assert.match(distro.badge(''), /fill="#6b7280"/);
  assert.strictEqual(distro.look({ os: 'debian' }).svg, distro.badge('debian'));
});

test('o mandado pelo painel fica acima do servidor mesmo com histórico longo e repetido', () => {
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`cmd${i % 50}`);
  const data = history.recordSent({ remote: history.rank(lines), sent: [], pinned: [] }, 'mine');
  assert.strictEqual(history.entries(data)[0].cmd, 'mine');
});

test('fetchRemote põe por último o histórico escrito por último', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshfake-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.zsh_history'), ': 1699999999:0;velho\n');
  fs.writeFileSync(path.join(home, '.bash_history'), 'novo\n');
  const past = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(home, '.zsh_history'), past, past);
  const fake = path.join(dir, 'ssh');
  fs.writeFileSync(fake, `#!/bin/sh\nHOME='${home}' exec sh -s\n`, { mode: 0o755 });
  const r = await history.fetchRemote('x', { binary: fake });
  assert.deepStrictEqual(r.lines, ['velho', 'novo']);
});

test('fetchRemote desiste no tempo mesmo com um neto segurando a saída', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshfake-'));
  const fake = path.join(dir, 'ssh');
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 30 &\nwait\n', { mode: 0o755 });
  const t = Date.now();
  const r = await history.fetchRemote('x', { binary: fake, timeout: 1 });
  assert.ok(r.error);
  assert.ok(Date.now() - t < 5000);
});
