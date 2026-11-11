'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sshconfig = require('../sshconfig');

const CONFIG = `Host firewall
    HostName 192.168.100.1
    User William

Host cdn
    HostName 192.168.100.130
    User ubuntu
    # o cdn de produção
    ForwardAgent yes

Host a b
    User shared

# ccs-ssh
Match host 192.168.100.* exec "ccs-ssh ensure"
    IdentityFile ~/.ssh/id_ed25519
`;

function tmp(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshcfg-'));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, text);
  return file;
}

test('lista os hosts concretos, com as diretivas extras e o que dá pra editar', () => {
  const list = sshconfig.list(tmp(CONFIG));
  assert.deepStrictEqual(list.map((h) => h.alias), ['firewall', 'cdn', 'a', 'b']);
  const cdn = list.find((h) => h.alias === 'cdn');
  assert.strictEqual(cdn.hostname, '192.168.100.130');
  assert.deepStrictEqual(cdn.extra, ['ForwardAgent yes']);
  assert.strictEqual(cdn.editable, true);
  assert.strictEqual(list.find((h) => h.alias === 'a').editable, false);
});

test('segue os Include relativos ao ~/.ssh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshcfg-'));
  fs.writeFileSync(path.join(dir, 'extra'), 'Host incluido\n  HostName 10.0.0.9\n');
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, `Include ${path.join(dir, 'extra')}\n\nHost principal\n  User x\n`);
  const list = sshconfig.list(file);
  assert.deepStrictEqual(list.map((h) => h.alias), ['incluido', 'principal']);
  assert.strictEqual(list[0].source, path.join(dir, 'extra'));
});

test('um host novo entra antes do Match, com o comentário dele junto', () => {
  const out = sshconfig.upsertText(CONFIG, null, { alias: 'novo', hostname: '10.0.0.5', user: 'ubuntu', port: '', identityFile: '', extra: [] });
  assert.match(out, /User shared\n\nHost novo\n    HostName 10\.0\.0\.5\n    User ubuntu\n\n# ccs-ssh\nMatch/);
});

test('editar troca só o bloco e mantém os comentários de dentro', () => {
  const out = sshconfig.upsertText(CONFIG, 'cdn', { alias: 'cdn', hostname: '192.168.100.131', user: 'root', port: '2222', identityFile: '~/.ssh/k', extra: ['ForwardAgent yes'] });
  assert.match(out, /Host cdn\n    # o cdn de produção\n    HostName 192\.168\.100\.131\n    User root\n    Port 2222\n    IdentityFile ~\/\.ssh\/k\n    ForwardAgent yes\n\nHost a b/);
  assert.ok(out.startsWith('Host firewall\n    HostName 192.168.100.1\n    User William\n\nHost cdn'));
});

test('renomear troca o nome do Host', () => {
  const out = sshconfig.upsertText(CONFIG, 'firewall', { alias: 'fw', hostname: '192.168.100.1', user: 'William', extra: [] });
  assert.match(out, /^Host fw\n/);
  assert.ok(!/Host firewall/.test(out));
});

test('apagar tira o bloco e a linha em branco, e o resto fica igual', () => {
  const out = sshconfig.upsertText(CONFIG, 'cdn', null);
  assert.strictEqual(out, CONFIG.replace(/Host cdn\n[\s\S]*?ForwardAgent yes\n\n/, ''));
});

test('upsert grava com a cópia fora da pasta do config e mantém a permissão', () => {
  const file = tmp(CONFIG);
  fs.chmodSync(file, 0o600);
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'sshbak-'));
  sshconfig.setBackupDir(backups);
  sshconfig.upsert(null, { alias: 'x', hostname: 'h', extra: [] }, file);
  sshconfig.setBackupDir('');
  const copies = fs.readdirSync(backups);
  assert.strictEqual(copies.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(backups, copies[0]), 'utf8'), CONFIG);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['config']);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(sshconfig.list(file).some((h) => h.alias === 'x'));
});

test('um config que é link continua link, e o arquivo de verdade muda', () => {
  const real = tmp(CONFIG);
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sshlink-')), 'config');
  fs.symlinkSync(real, link);
  sshconfig.upsert('cdn', null, link);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(!/Host cdn/.test(fs.readFileSync(real, 'utf8')));
});

test('valores com espaço e aspas voltam como estavam, e o Include de dentro do bloco fica', () => {
  const text = 'Host p\n  HostName 1.2.3.4\n  Include ~/.ssh/p-extra\n  LocalForward 8080 localhost:80\n  ProxyCommand ssh -W %h:%p bastion\n  SetEnv FOO="a b"\n';
  const [h] = sshconfig.list(tmp(text));
  assert.deepStrictEqual(h.extra, ['LocalForward 8080 localhost:80', 'ProxyCommand ssh -W %h:%p bastion', 'SetEnv FOO="a b"']);
  const out = sshconfig.upsertText(text, 'p', { ...h, user: 'root' });
  assert.strictEqual(out, 'Host p\n  Include ~/.ssh/p-extra\n  HostName 1.2.3.4\n  User root\n  LocalForward 8080 localhost:80\n  ProxyCommand ssh -W %h:%p bastion\n  SetEnv FOO="a b"\n');
});

test('o glob do Include não pega arquivo oculto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshcfg-'));
  fs.mkdirSync(path.join(dir, 'd'));
  fs.writeFileSync(path.join(dir, 'd', 'a'), 'Host a1\n');
  fs.writeFileSync(path.join(dir, 'd', '.a.maestria.tmp'), 'Host fantasma\n');
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, `Include ${path.join(dir, 'd')}/*\n`);
  assert.deepStrictEqual(sshconfig.list(file).map((h) => h.alias), ['a1']);
});

test('uma segunda IdentityFile sobrevive à edição', () => {
  const text = 'Host k\n  IdentityFile ~/.ssh/a\n  IdentityFile ~/.ssh/b\n';
  const [h] = sshconfig.list(tmp(text));
  assert.strictEqual(h.identityFile, '~/.ssh/a');
  assert.deepStrictEqual(h.extra, ['IdentityFile ~/.ssh/b']);
  const out = sshconfig.upsertText(text, 'k', h);
  assert.strictEqual(out, 'Host k\n  IdentityFile ~/.ssh/a\n  IdentityFile ~/.ssh/b\n');
});

test('parseExtra aceita Chave valor separadas por ; e recusa o que tem campo', () => {
  assert.deepStrictEqual(sshconfig.parseExtra('ProxyJump bastion; ForwardAgent=yes').extra, ['ProxyJump bastion', 'ForwardAgent yes']);
  assert.ok(sshconfig.parseExtra('HostName x').error);
  assert.ok(sshconfig.parseExtra('Host y').error);
  assert.ok(sshconfig.parseExtra('só-uma-palavra').error);
});

test('slug tira acento e espaço', () => {
  assert.strictEqual(sshconfig.slug('Ceph PVE 11 (produção)'), 'ceph-pve-11-producao');
});

test('parseExtra mantém as aspas de um valor com espaço', () => {
  assert.deepStrictEqual(sshconfig.parseExtra('IdentityFile "~/my keys/id"').extra, ['IdentityFile "~/my keys/id"']);
});

test('o ; de dentro de um valor não separa diretivas', () => {
  assert.deepStrictEqual(sshconfig.parseExtra('RemoteCommand cd /srv; exec bash -l; ForwardAgent yes').extra, ['RemoteCommand cd /srv; exec bash -l', 'ForwardAgent yes']);
});

test('apagar o último host não leva o Include que vem depois', () => {
  assert.strictEqual(sshconfig.upsertText('Host a\n  HostName 1\n\nInclude config.d/*\n', 'a', null), 'Include config.d/*\n');
});
