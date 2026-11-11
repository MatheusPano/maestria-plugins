// Os hosts: cada um é um `Host` do ~/.ssh/config (ou de um Include dele), e o
// que o config não tem lugar pra guardar -- o nome de exibição, o grupo, o
// ícone, quando você conectou -- mora no meta.json da pasta de dados do
// plugin, pelo alias. A linha que conecta é `ssh <alias>`: o config diz o resto,
// e o mesmo host funciona fora da Maestria.
//
// Nada aqui fala com a janela, pra dar pra testar sem a Maestria.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sshconfig = require('./sshconfig');

const HOME = os.homedir();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Grava por cima num arquivo ao lado e troca: um app fechado no meio não deixa meio json. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// --- o meta de cada host ---------------------------------------------------------

/** alias → { label?, group?, icon?, os?, lastUsed?, cli? }. */
function loadMeta(dataDir) {
  const data = readJson(path.join(dataDir, 'meta.json'), {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function saveMeta(dataDir, meta) {
  // Um meta vazio não precisa ficar no arquivo.
  const clean = {};
  for (const [alias, m] of Object.entries(meta)) {
    const kept = Object.fromEntries(Object.entries(m || {}).filter(([, v]) => v != null && v !== ''));
    if (Object.keys(kept).length) clean[alias] = kept;
  }
  writeJson(path.join(dataDir, 'meta.json'), clean);
}

// --- grupos e seções -------------------------------------------------------------

function sortGroups(names) {
  const clean = names.filter((g) => typeof g === 'string').map((g) => g.trim()).filter(Boolean);
  return [...new Set(clean)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/** Os grupos: os do groups.json mais os que algum host usa, sem repetir, em ordem alfabética. */
function loadGroups(dataDir, meta = {}) {
  const stored = readJson(path.join(dataDir, 'groups.json'), []);
  return sortGroups([...(Array.isArray(stored) ? stored : []), ...Object.values(meta).map((m) => m && m.group)]);
}

function saveGroups(dataDir, groups) {
  writeJson(path.join(dataDir, 'groups.json'), sortGroups(groups));
}

/** As seções fechadas da lista (as chaves que o main.js dá a cada uma). */
function loadCollapsed(dataDir) {
  const list = readJson(path.join(dataDir, 'collapsed.json'), []);
  return new Set(Array.isArray(list) ? list.filter((k) => typeof k === 'string') : []);
}

function saveCollapsed(dataDir, keys) {
  writeJson(path.join(dataDir, 'collapsed.json'), [...keys].sort());
}

// --- os hosts --------------------------------------------------------------------

/** Os hosts do config com o meta de cada um, pelo nome de exibição. */
function list(dataDir, meta = loadMeta(dataDir), configFile = sshconfig.MAIN) {
  return sshconfig
    .list(configFile)
    .map((h) => ({ ...h, ...(meta[h.alias] || {}), name: (meta[h.alias] && meta[h.alias].label) || h.alias }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/**
 * Confere e arruma o que veio do formulário. Devolve `{ host, meta }` (o bloco
 * do config e o meta) ou `{ error }` com a frase que a janela mostra.
 */
function normalize(input) {
  const label = String(input.label || '').trim();
  const alias = String(input.alias || '').trim() || sshconfig.slug(label);
  if (!alias) return { error: 'falta o alias (o nome do host no ~/.ssh/config)' };
  if (!sshconfig.concrete(alias) || /\s/.test(alias)) return { error: 'o alias não pode ter espaço, *, ? nem !' };
  const hostname = String(input.hostname || '').trim();
  if (/\s/.test(hostname)) return { error: 'o endereço não pode ter espaço' };
  const portText = String(input.port || '').trim();
  let port = '';
  if (portText) {
    const n = Number(portText);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: 'a porta é um número de 1 a 65535' };
    port = String(n);
  }
  const user = String(input.user || '').trim();
  if (/\s/.test(user)) return { error: 'o usuário não pode ter espaço' };
  const { extra, error } = sshconfig.parseExtra(input.extra);
  if (error) return { error };
  return {
    host: { alias, hostname, user, port, identityFile: String(input.identityFile || '').trim(), extra },
    meta: {
      label: label && label !== alias ? label : '',
      group: String(input.group || '').trim(),
      icon: String(input.icon || '').trim(),
      cli: String(input.cli || '').trim(),
    },
  };
}

/** Entre aspas simples, pra shell nenhum mexer. */
function quote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * A linha que conecta: `ssh <alias>`, com as opções pra todos os hosts e o
 * limite de espera das configurações. O programa e as opções entram como você
 * escreveu (são seus, e é assim que `-o Chave=valor "com aspas"` funciona).
 */
function commandFor(host, settings = {}) {
  const parts = [String(settings.binary || 'ssh').trim() || 'ssh'];
  const extra = String(settings.extra || '').trim();
  if (extra) parts.push(extra);
  const cli = String(host.cli || '').trim();
  // Um host fora do alcance deixaria o terminal mudo por mais de um minuto:
  // com o limite, o ssh desiste e diz por quê. Quem já pôs o seu não é contrariado.
  const timeout = settings.timeout == null ? 10 : Number(settings.timeout);
  const own = /ConnectTimeout/i.test(`${extra} ${cli} ${(host.extra || []).join(' ')}`);
  if (timeout > 0 && !own) parts.push('-o', `ConnectTimeout=${Math.round(timeout)}`);
  if (cli) parts.push(cli);
  parts.push(quote(host.alias));
  return parts.join(' ');
}

/**
 * O ssh que lê o histórico, com as mesmas opções da conexão do terminal. O
 * mosh não roda um comando avulso: aí vai o ssh mesmo.
 */
function probe(host, settings = {}) {
  const binary = String(settings.binary || 'ssh').trim() || 'ssh';
  return {
    binary: /(^|\/)mosh(\s|$)/.test(binary) ? 'ssh' : binary,
    options: [String(settings.extra || '').trim(), String(host.cli || '').trim()].filter(Boolean).join(' '),
    quoted: quote(host.alias),
  };
}

/** `usuário@host:porta`, a linha de baixo de cada host. */
function address(host) {
  const who = host.user ? `${host.user}@` : '';
  const where = host.hostname || host.alias;
  const port = host.port && Number(host.port) !== 22 ? `:${host.port}` : '';
  return `${who}${where}${port}`;
}

// --- os hosts salvos antes do config ----------------------------------------------

/**
 * Os hosts que versões anteriores guardavam no hosts.json viram blocos do
 * ~/.ssh/config, uma vez: o alias é o nome sem espaço nem acento; um host que o
 * config já tem igual (mesmo endereço, usuário e porta) só junta o meta; um
 * alias já usado por outro endereço ganha -2, -3. O hosts.json fica como
 * hosts.json.migrado. Devolve o mapa id antigo → alias, que resolve os terminais
 * abertos com a chave de antes.
 */
function migrate(dataDir, configFile = sshconfig.MAIN) {
  const file = path.join(dataDir, 'hosts.json');
  const mapFile = path.join(dataDir, 'migrado.json');
  const old = readJson(file, null);
  if (!Array.isArray(old)) return readJson(mapFile, {});
  const meta = loadMeta(dataDir);
  const existing = new Map(sshconfig.list(configFile).map((h) => [h.alias, h]));
  const map = {};
  for (const h of old) {
    if (!h || !h.id || !h.host) continue;
    const want = { hostname: h.host, user: h.user || '', port: h.port && Number(h.port) !== 22 ? String(h.port) : '' };
    const portOf = (x) => String(x || '22');
    const same = (c) => (c.hostname || c.alias) === want.hostname && (c.user || '') === want.user && portOf(c.port) === portOf(want.port);
    const base = sshconfig.slug(h.name) || sshconfig.slug(h.host) || 'host';
    // O mesmo host já no config, com qualquer alias, só ganha o meta.
    const twin = [...existing.values()].find(same);
    let alias = twin ? twin.alias : base;
    for (let n = 2; existing.has(alias) && !same(existing.get(alias)); n++) alias = `${base}-${n}`;
    if (!existing.has(alias)) {
      const block = { alias, ...want, identityFile: h.key || '', extra: [] };
      sshconfig.upsert(null, block, configFile);
      existing.set(alias, block);
    }
    const prev = meta[alias] || {};
    meta[alias] = {
      ...prev,
      label: h.name && h.name !== alias ? h.name : prev.label,
      group: h.group || prev.group,
      lastUsed: h.lastUsed || prev.lastUsed,
      cli: h.options || prev.cli,
    };
    map[h.id] = alias;
  }
  saveMeta(dataDir, meta);
  writeJson(mapFile, map);
  fs.renameSync(file, `${file}.migrado`);
  return map;
}

module.exports = {
  list,
  loadMeta,
  saveMeta,
  loadGroups,
  saveGroups,
  loadCollapsed,
  saveCollapsed,
  normalize,
  commandFor,
  probe,
  address,
  migrate,
  quote,
  HOME,
};
