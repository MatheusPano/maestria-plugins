// Os comandos de cada host, como o painel de histórico do Termius: os que o
// shell do servidor guardou (~/.bash_history, ~/.zsh_history), os que você
// mandou pelo painel e os que fixou. A Maestria não mostra o que passa no
// terminal pro plugin, então o histórico vem do próprio servidor, por um ssh
// à parte que só lê -- e que de quebra diz o sistema, pro ícone do host.
//
// Nada aqui fala com a janela, pra dar pra testar sem a Maestria.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MARK = '@@maestria-os@@';
// Quanto do fim de cada arquivo de histórico vem pra cá.
const TAIL = 3000;
// Quantos comandos únicos o painel guarda por host.
const KEEP = 400;

// Roda no `sh` do servidor, lido do stdin: assim vale com qualquer shell de
// login (o csh do FreeBSD não entenderia um `for` passado na linha).
const SCRIPT = [
  // O arquivo escrito por último vem depois: os comandos dele contam como os mais recentes.
  'b="$HOME/.bash_history"; z="$HOME/.zsh_history"',
  'if [ "$b" -nt "$z" ]; then set -- "$z" "$b"; else set -- "$b" "$z"; fi',
  'for f in "$@"; do',
  `  [ -r "$f" ] && tail -n ${TAIL} "$f"`,
  'done',
  `echo '${MARK}'`,
  // O Proxmox se diz Debian no os-release: a pasta dele é que conta.
  'if [ -d /etc/pve ]; then echo "proxmox|debian|Proxmox";',
  'elif [ -r /etc/os-release ]; then . /etc/os-release; echo "$ID|$ID_LIKE|$NAME";',
  'else uname -s; fi',
  '',
].join('\n');

/**
 * As linhas de um histórico de bash ou zsh, em ordem, já sem o carimbo do zsh
 * (`: 1699999999:0;cmd`) e sem as linhas de hora do bash (`#1699999999`).
 */
function parse(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^#\d{9,}$/.test(raw)) continue;
    const line = raw.replace(/^: \d+:\d+;/, '').trim();
    if (line) out.push(line);
  }
  return out;
}

/**
 * A lista do servidor: cada comando uma vez, com quantas vezes aparece e a
 * posição da última vez (maior = mais recente).
 */
function rank(lines) {
  const by = new Map();
  lines.forEach((cmd, i) => {
    const e = by.get(cmd) || { cmd, count: 0, at: 0 };
    e.count += 1;
    e.at = i + 1;
    by.set(cmd, e);
  });
  return [...by.values()].sort((a, b) => b.at - a.at).slice(0, KEEP);
}

/** O que o ssh de leitura devolveu: os comandos e o sistema. */
function splitOutput(stdout) {
  const i = stdout.lastIndexOf(MARK);
  if (i < 0) return { lines: parse(stdout), os: '' };
  return { lines: parse(stdout.slice(0, i)), os: stdout.slice(i + MARK.length).trim().split(/\r?\n/)[0] || '' };
}

/**
 * Lê o histórico e o sistema do host por um ssh sem pergunta nenhuma
 * (`BatchMode`): com chave ou agente funciona; um host de senha volta com o
 * erro, e o painel fica só com o que você mandou e fixou. `options` são as
 * opções que a conexão do terminal também usa (as de todos os hosts e as do
 * host), já como texto de shell; `quoted` é o alias entre aspas.
 */
function fetchRemote(quoted, { timeout = 20, binary = 'ssh', options = '' } = {}) {
  return new Promise((resolve) => {
    const line = [binary, options, '-T -o BatchMode=yes -o ConnectTimeout=8 -o LogLevel=ERROR', quoted, 'sh -s'].filter(Boolean).join(' ');
    let child;
    try {
      // Num grupo próprio: o tempo esgotado mata o ssh (ou o autossh) que o sh abriu, não só o sh.
      child = spawn('sh', ['-c', line], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ error: e.message });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish({ error: `sem resposta em ${timeout} s` });
    }, timeout * 1000);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => finish({ error: e.message }));
    child.on('close', (code) => {
      if (!out.includes(MARK)) {
        finish({ error: (err.trim().split(/\r?\n/).pop() || `o ssh saiu com ${code}`).slice(0, 200) });
        return;
      }
      finish(splitOutput(out));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(SCRIPT);
  });
}

// --- o arquivo de cada host ----------------------------------------------------

function fileOf(dataDir, alias) {
  return path.join(dataDir, 'history', `${encodeURIComponent(alias)}.json`);
}

function empty() {
  return { remote: [], sent: [], pinned: [], fetchedAt: null, error: '' };
}

// O que já foi lido do disco, por arquivo: a lista e a varredura releem a toda pintura.
const cache = new Map();

function load(dataDir, alias) {
  const file = fileOf(dataDir, alias);
  if (!cache.has(file)) {
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // sem histórico ainda
    }
    cache.set(file, JSON.stringify({ ...empty(), ...data }));
  }
  return JSON.parse(cache.get(file));
}

function save(dataDir, alias, data) {
  const file = fileOf(dataDir, alias);
  cache.set(file, JSON.stringify({ ...empty(), ...data }));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** O histórico vai junto quando o host muda de nome, e some com ele. */
function rename(dataDir, from, to) {
  cache.delete(fileOf(dataDir, from));
  cache.delete(fileOf(dataDir, to));
  try {
    fs.renameSync(fileOf(dataDir, from), fileOf(dataDir, to));
  } catch {
    // sem histórico ainda
  }
}

function drop(dataDir, alias) {
  cache.delete(fileOf(dataDir, alias));
  try {
    fs.unlinkSync(fileOf(dataDir, alias));
  } catch {
    // já não havia
  }
}

/** Um comando mandado pelo painel conta como usado agora. */
function recordSent(data, cmd) {
  const now = new Date().toISOString();
  const e = data.sent.find((x) => x.cmd === cmd);
  if (e) {
    e.count += 1;
    e.last = now;
  } else data.sent.push({ cmd, count: 1, last: now });
  data.sent = data.sent.sort((a, b) => b.last.localeCompare(a.last)).slice(0, KEEP);
  return data;
}

function togglePin(data, cmd) {
  data.pinned = data.pinned.includes(cmd) ? data.pinned.filter((c) => c !== cmd) : [...data.pinned, cmd];
  return data;
}

/** Tira o comando da lista de vez: as próximas leituras do servidor não o trazem de volta. */
function forget(data, cmd) {
  data.remote = data.remote.filter((e) => e.cmd !== cmd);
  data.sent = data.sent.filter((e) => e.cmd !== cmd);
  data.pinned = data.pinned.filter((c) => c !== cmd);
  data.hidden = [...new Set([...(data.hidden || []), cmd])].slice(-KEEP);
  return data;
}

/**
 * A lista do painel: os fixados primeiro, na ordem em que você os fixou; depois
 * os outros, pelos mais recentes ("recentes") ou pelos mais usados
 * ("frequentes"). O que você mandou pelo painel conta como o mais recente.
 */
function entries(data, { order = 'recentes', filter = '' } = {}) {
  const hidden = new Set(data.hidden || []);
  const by = new Map();
  // `at` é a linha no histórico: dividida pela maior, os do servidor ficam entre 0 e 1.
  const last = Math.max(1, ...data.remote.map((e) => e.at));
  for (const e of data.remote) by.set(e.cmd, { cmd: e.cmd, count: e.count, score: e.at / last });
  // Os mandados pelo painel ficam acima dos do servidor nos recentes.
  data.sent.forEach((e, i) => {
    const cur = by.get(e.cmd) || { cmd: e.cmd, count: 0, score: 0 };
    cur.count += e.count;
    cur.score = Math.max(cur.score, 2 - i / Math.max(data.sent.length, 1));
    by.set(e.cmd, cur);
  });
  const f = filter.trim().toLowerCase();
  const pinned = data.pinned.filter((c) => !f || c.toLowerCase().includes(f));
  const pinnedSet = new Set(data.pinned);
  const rest = [...by.values()].filter((e) => !pinnedSet.has(e.cmd) && !hidden.has(e.cmd) && (!f || e.cmd.toLowerCase().includes(f)));
  rest.sort(order === 'frequentes' ? (a, b) => b.count - a.count || b.score - a.score : (a, b) => b.score - a.score);
  return [
    ...pinned.map((cmd) => ({ cmd, count: by.get(cmd)?.count || 0, pinned: true })),
    ...rest.map((e) => ({ cmd: e.cmd, count: e.count, pinned: false })),
  ];
}

/** Guarda o que o servidor devolveu. Um comando que você tirou não volta. */
function applyRemote(data, result) {
  data.fetchedAt = new Date().toISOString();
  if (result.error) {
    data.error = result.error;
    return data;
  }
  data.error = '';
  data.remote = rank(result.lines);
  return data;
}

module.exports = { parse, rank, splitOutput, fetchRemote, load, save, rename, drop, recordSent, togglePin, forget, entries, applyRemote, SCRIPT };
