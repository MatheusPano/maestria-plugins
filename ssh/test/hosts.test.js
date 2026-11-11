'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hosts = require('../hosts');
const sshconfig = require('../sshconfig');

function setup(config, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshhosts-'));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, config);
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  if (saved) fs.writeFileSync(path.join(data, 'hosts.json'), JSON.stringify(saved));
  return { file, data };
}

test('migra os hosts salvos pro config, juntando o que já existe igual', () => {
  const { file, data } = setup('Host zabbix\n    HostName 192.168.100.10\n    User zabbix\n', [
    { id: 'h1', name: 'zabbix', host: '192.168.100.10', user: 'zabbix', key: '~/.ssh/id_ed25519', group: 'Monitoramento', lastUsed: '2026-10-27T19:43:12.180Z' },
    { id: 'h2', name: 'cfc login', host: '192.168.100.68', user: 'ubuntu', key: '~/.ssh/id25519', options: '-A', group: '' },
  ]);
  const map = hosts.migrate(data, file);
  assert.deepStrictEqual(map, { h1: 'zabbix', h2: 'cfc-login' });
  const list = sshconfig.list(file);
  assert.deepStrictEqual(list.map((h) => h.alias), ['zabbix', 'cfc-login']);
  assert.strictEqual(list[1].identityFile, '~/.ssh/id25519');
  const meta = hosts.loadMeta(data);
  assert.strictEqual(meta.zabbix.group, 'Monitoramento');
  assert.strictEqual(meta['cfc-login'].label, 'cfc login');
  assert.strictEqual(meta['cfc-login'].cli, '-A');
  assert.ok(fs.existsSync(path.join(data, 'hosts.json.migrado')));
  // Na segunda vez não faz nada e devolve o mesmo mapa.
  assert.deepStrictEqual(hosts.migrate(data, file), map);
  assert.strictEqual(sshconfig.list(file).length, 2);
});

test('Port 22 no config e porta vazia no hosts.json são o mesmo host', () => {
  const { file, data } = setup('Host web\n  HostName 1.1.1.1\n  Port 22\n', [{ id: 'h', name: 'web', host: '1.1.1.1' }]);
  assert.deepStrictEqual(hosts.migrate(data, file), { h: 'web' });
  assert.strictEqual(sshconfig.list(file).length, 1);
});

test('probe usa as opções da conexão, e o ssh no lugar do mosh', () => {
  assert.deepStrictEqual(hosts.probe({ alias: 'x', cli: '-J bastion' }, { extra: '-F ~/w', binary: 'mosh' }), { binary: 'ssh', options: '-F ~/w -J bastion', quoted: "'x'" });
  assert.strictEqual(hosts.probe({ alias: 'x' }, { binary: 'autossh -M 0' }).binary, 'autossh -M 0');
});

test('um alias já usado por outro endereço ganha -2', () => {
  const { file, data } = setup('Host web\n  HostName 1.1.1.1\n', [{ id: 'h', name: 'web', host: '2.2.2.2' }]);
  assert.deepStrictEqual(hosts.migrate(data, file), { h: 'web-2' });
});

test('normalize: o alias sai do nome, a porta digitada fica (até a 22), a porta inválida é erro', () => {
  const { host, meta } = hosts.normalize({ label: 'Ceph S1', hostname: '10.0.0.1', port: '22', extra: 'ForwardAgent yes' });
  assert.strictEqual(host.alias, 'ceph-s1');
  assert.strictEqual(host.port, '22');
  assert.deepStrictEqual(host.extra, ['ForwardAgent yes']);
  assert.strictEqual(meta.label, 'Ceph S1');
  assert.ok(hosts.normalize({ alias: 'x', port: '70000' }).error);
  assert.ok(hosts.normalize({ alias: 'a*' }).error);
  assert.ok(hosts.normalize({}).error);
});

test('commandFor conecta pelo alias, com o limite de espera e as opções', () => {
  assert.strictEqual(hosts.commandFor({ alias: 'ceph-s1' }), "ssh -o ConnectTimeout=10 'ceph-s1'");
  assert.strictEqual(hosts.commandFor({ alias: 'x', cli: '-A' }, { extra: '-v', timeout: 0 }), "ssh -v -A 'x'");
  assert.strictEqual(hosts.commandFor({ alias: 'x', extra: ['ConnectTimeout 3'] }), "ssh 'x'");
});

test('list junta o meta e ordena pelo nome de exibição', () => {
  const { file, data } = setup('Host b\n  HostName 1\nHost a\n  HostName 2\n');
  const list = hosts.list(data, { b: { label: 'Alfa', group: 'G' } }, file);
  assert.deepStrictEqual(list.map((h) => [h.alias, h.name, h.group]), [['a', 'a', undefined], ['b', 'Alfa', 'G']]);
});

test('um Host sem HostName é o mesmo host salvo com o alias como endereço', () => {
  const { file, data } = setup('Host myserver\n    User root\n', [{ id: 'h1', name: 'myserver', host: 'myserver', user: 'root' }]);
  assert.deepStrictEqual(hosts.migrate(data, file), { h1: 'myserver' });
  assert.deepStrictEqual(sshconfig.list(file).map((h) => h.alias), ['myserver']);
});

test('o mesmo endereço já no config com outro alias só ganha o meta', () => {
  const { file, data } = setup('Host zbx\n    HostName 192.168.100.10\n    User zabbix\n', [{ id: 'h1', name: 'zabbix', host: '192.168.100.10', user: 'zabbix', group: 'Mon' }]);
  assert.deepStrictEqual(hosts.migrate(data, file), { h1: 'zbx' });
  assert.deepStrictEqual(sshconfig.list(file).map((h) => h.alias), ['zbx']);
  assert.strictEqual(hosts.loadMeta(data).zbx.group, 'Mon');
});
