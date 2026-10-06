// Os hosts: os que você salvou (um json na pasta de dados do plugin), os que o
// ~/.ssh/config já conhece, e a linha de comando que conecta a cada um.
//
// Nada aqui fala com a janela, pra dar pra testar sem a Maestria.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

/** O arquivo onde os hosts salvos moram. */
function storeFile(dataDir) {
  return path.join(dataDir, 'hosts.json');
}

/** O dos grupos: só os nomes, pra um grupo existir antes de ter host. */
function groupsFile(dataDir) {
  return path.join(dataDir, 'groups.json');
}

/** Os hosts salvos. Um arquivo que não existe ou estragou é uma lista vazia. */
function load(dataDir) {
  try {
    const list = JSON.parse(fs.readFileSync(storeFile(dataDir), 'utf8'));
    return Array.isArray(list) ? list.filter((h) => h && h.id && h.host) : [];
  } catch {
    return [];
  }
}

/** Grava por cima num arquivo ao lado e troca: um app fechado no meio não deixa meio json. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function save(dataDir, hosts) {
  writeJson(storeFile(dataDir), hosts);
}

/**
 * Os grupos: os do groups.json mais os que algum host já usa (os de antes do
 * arquivo existir, quando o grupo era só um campo do host), sem repetir e em
 * ordem alfabética.
 */
function loadGroups(dataDir, hosts = []) {
  let stored = [];
  try {
    const list = JSON.parse(fs.readFileSync(groupsFile(dataDir), 'utf8'));
    if (Array.isArray(list)) stored = list;
  } catch {
    // sem arquivo: só os dos hosts
  }
  return sortGroups([...stored, ...hosts.map((h) => h.group)]);
}

function saveGroups(dataDir, groups) {
  writeJson(groupsFile(dataDir), sortGroups(groups));
}

/** As seções fechadas da lista (as chaves que o main.js dá a cada uma). */
function loadCollapsed(dataDir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dataDir, 'collapsed.json'), 'utf8'));
    return new Set(Array.isArray(list) ? list.filter((k) => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(dataDir, keys) {
  writeJson(path.join(dataDir, 'collapsed.json'), [...keys].sort());
}

function sortGroups(names) {
  const clean = names.filter((g) => typeof g === 'string').map((g) => g.trim()).filter(Boolean);
  return [...new Set(clean)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function newId() {
  return `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Confere e arruma o que veio do formulário. Devolve `{ host }` ou `{ error }`
 * com a frase que a janela mostra.
 */
function normalize(input) {
  const host = String(input.host || '').trim();
  if (!host) return { error: 'falta o host (o endereço ou o IP)' };
  if (/\s/.test(host)) return { error: 'o host não pode ter espaço' };
  const portText = String(input.port || '').trim();
  let port = null;
  if (portText) {
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: 'a porta é um número de 1 a 65535' };
    }
  }
  const user = String(input.user || '').trim();
  if (/\s/.test(user)) return { error: 'o usuário não pode ter espaço' };
  return {
    host: {
      id: input.id || newId(),
      name: String(input.name || '').trim() || (user ? `${user}@${host}` : host),
      host,
      user,
      port: port && port !== 22 ? port : null,
      key: String(input.key || '').trim(),
      options: String(input.options || '').trim(),
      group: String(input.group || '').trim(),
      lastUsed: input.lastUsed || null,
    },
  };
}

/** Entre aspas simples, pra shell nenhum mexer. */
function quote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** `~/x` vira o caminho de verdade: entre aspas o shell não expandiria. */
function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

/**
 * A linha que conecta. O programa e as opções entram como você escreveu (são
 * seus, e é assim que `-o Chave=valor "com aspas"` funciona); o endereço, o
 * usuário e a chave vão entre aspas.
 */
function commandFor(host, settings = {}) {
  const parts = [String(settings.binary || 'ssh').trim() || 'ssh'];
  const extra = String(settings.extra || '').trim();
  if (extra) parts.push(extra);
  // Um host fora do alcance deixaria o terminal mudo por mais de um minuto:
  // com o limite, o ssh desiste e diz por quê. Quem já pôs o seu não é contrariado.
  const timeout = settings.timeout == null ? 10 : Number(settings.timeout);
  const own = /ConnectTimeout/i.test(`${extra} ${host.options || ''}`);
  if (timeout > 0 && !own) parts.push('-o', `ConnectTimeout=${Math.round(timeout)}`);
  if (host.alias) {
    // Um host do ~/.ssh/config: o config já diz tudo.
    parts.push(quote(host.alias));
    return parts.join(' ');
  }
  if (host.options) parts.push(host.options);
  if (host.port) parts.push('-p', String(host.port));
  if (host.key) parts.push('-i', quote(expandHome(host.key)));
  parts.push(quote(host.user ? `${host.user}@${host.host}` : host.host));
  return parts.join(' ');
}

/** `usuário@host:porta`, a linha de baixo de cada host. */
function address(host) {
  const who = host.user ? `${host.user}@` : '';
  const where = host.hostname || host.host || host.alias;
  const port = host.port && Number(host.port) !== 22 ? `:${host.port}` : '';
  return `${who}${where}${port}`;
}

// --- ~/.ssh/config -----------------------------------------------------------

const SSH_DIR = path.join(HOME, '.ssh');

/** Os arquivos de um `Include`: relativo ao ~/.ssh, com `*` e `?` no nome. */
function expandInclude(pattern) {
  let p = expandHome(pattern);
  if (!path.isAbsolute(p)) p = path.join(SSH_DIR, p);
  const dir = path.dirname(p);
  const base = path.basename(p);
  if (!/[*?]/.test(base)) return [p];
  const re = new RegExp(
    '^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  );
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => re.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Os `Host` com nome de verdade (sem `*`, `?` nem `!`) do config e dos
 * `Include` dele, na ordem em que aparecem, com o HostName, User e Port que
 * cada um declara — só pra mostrar; quem conecta é o `ssh <alias>`.
 */
function configHosts(file = path.join(SSH_DIR, 'config'), seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+?)\s*(?:=\s*|\s+)(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = value
        .split(/\s+/)
        .filter((a) => a && !/[*?!]/.test(a))
        .map((alias) => ({ alias, source: file }));
      out.push(...current);
    } else if (key === 'match') {
      current = [];
    } else if (key === 'include') {
      for (const pattern of value.split(/\s+/)) {
        for (const f of expandInclude(pattern)) out.push(...configHosts(f, seen));
      }
    } else if (key === 'hostname') {
      for (const h of current) h.hostname = value;
    } else if (key === 'user') {
      for (const h of current) h.user = value;
    } else if (key === 'port') {
      for (const h of current) h.port = value;
    }
  }
  // O mesmo alias em dois blocos: vale o primeiro, como no ssh.
  const byAlias = new Map();
  for (const h of out) if (!byAlias.has(h.alias)) byAlias.set(h.alias, h);
  return [...byAlias.values()];
}

module.exports = { load, save, loadGroups, saveGroups, loadCollapsed, saveCollapsed, normalize, commandFor, address, configHosts, quote, HOME };
