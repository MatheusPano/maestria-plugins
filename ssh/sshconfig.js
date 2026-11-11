// O ~/.ssh/config como a lista de hosts do plugin: ler os `Host` (e os dos
// `Include`), e escrever um bloco -- criar, editar, renomear, apagar -- sem
// mexer no resto do arquivo. Comentários, `Match`, curingas e a ordem ficam
// como estavam; só o bloco do host muda.
//
// Nada aqui fala com a janela, pra dar pra testar sem a Maestria.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const SSH_DIR = path.join(HOME, '.ssh');
const MAIN = path.join(SSH_DIR, 'config');

// As chaves que o formulário edita, na ordem em que vão pro bloco.
const KNOWN = [
  ['hostname', 'HostName'],
  ['user', 'User'],
  ['port', 'Port'],
  ['identityfile', 'IdentityFile'],
];
const KNOWN_KEYS = new Set(KNOWN.map(([k]) => k));

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

/** Uma linha de diretiva: `Chave valor` ou `Chave=valor`. null pra comentário e linha vazia. */
function directive(raw) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  const m = line.match(/^(\S+?)\s*(?:=\s*|\s+)(.*)$/);
  if (!m) return null;
  // `raw` é o valor como está no arquivo, com as aspas: `LocalForward 8080 x:80`
  // são dois argumentos, e pôr aspas em volta dos dois os juntaria num só.
  return { key: m[1].toLowerCase(), name: m[1], raw: m[2].trim(), value: m[2].trim().replace(/^"(.*)"$/, '$1') };
}

const isHeader = (d) => d && (d.key === 'host' || d.key === 'match');

/**
 * Os blocos de um texto: `{ start, end, aliases, header }`, `end` sendo a
 * última linha com diretiva -- as linhas em branco e os comentários que vêm
 * antes do próximo cabeçalho são dele, não deste.
 */
function blocks(lines) {
  const out = [];
  let cur = null;
  lines.forEach((raw, i) => {
    const d = directive(raw);
    if (isHeader(d)) {
      cur = {
        start: i,
        end: i,
        match: d.key === 'match',
        aliases: d.key === 'host' ? d.value.split(/\s+/).filter(Boolean) : [],
      };
      out.push(cur);
    } else if (d && cur) cur.end = i;
  });
  return out;
}

/** O alias que dá pra conectar: sem `*`, `?` nem `!`. */
const concrete = (a) => a && !/[*?!]/.test(a);

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
      // O `*` do glob do ssh não pega arquivo oculto, como o arquivo temporário da escrita.
      .filter((f) => re.test(f) && (!f.startsWith('.') || base.startsWith('.')))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Os hosts do config e dos `Include` dele, na ordem do arquivo: `{ alias,
 * hostname, user, port, identityFile, extra, source, editable }`. `extra` são
 * as outras diretivas do bloco (`ProxyJump x`, `ForwardAgent yes`). Um bloco
 * com mais de um nome (`Host a b`) não é `editable`: mexer nele mexeria nos
 * outros nomes.
 */
function list(file = MAIN, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const out = [];
  const included = (i) => {
    const d = directive(lines[i]);
    if (!d || d.key !== 'include') return [];
    return d.value.split(/\s+/).flatMap((p) => expandInclude(p).flatMap((f) => list(f, seen)));
  };
  const bs = blocks(lines);
  // Os Include antes do primeiro bloco.
  for (let i = 0; i < (bs.length ? bs[0].start : lines.length); i++) out.push(...included(i));
  for (const b of bs) {
    const names = b.aliases.filter(concrete);
    const info = { hostname: '', user: '', port: '', identityFile: '', extra: [] };
    for (let i = b.start + 1; i <= b.end; i++) {
      const d = directive(lines[i]);
      if (!d) continue;
      if (d.key === 'include') {
        out.push(...included(i));
        continue;
      }
      if (d.key === 'hostname' && !info.hostname) info.hostname = d.value;
      else if (d.key === 'user' && !info.user) info.user = d.value;
      else if (d.key === 'port' && !info.port) info.port = d.value;
      else if (d.key === 'identityfile' && !info.identityFile) info.identityFile = d.value;
      // Uma segunda IdentityFile vale (o ssh tenta as duas); as outras repetidas o ssh ignora.
      else if (!KNOWN_KEYS.has(d.key) || d.key === 'identityfile') info.extra.push(`${d.name} ${d.raw}`);
    }
    if (b.match) continue;
    const editable = b.aliases.length === 1 && names.length === 1;
    for (const alias of names) out.push({ alias, ...info, extra: [...info.extra], source: file, line: b.start + 1, editable });
  }
  // O mesmo alias em dois blocos: vale o primeiro, como no ssh.
  const byAlias = new Map();
  for (const h of out) if (!byAlias.has(h.alias)) byAlias.set(h.alias, h);
  return [...byAlias.values()];
}

/** Entre aspas quando tem espaço, senão como está. */
function value(v) {
  const s = String(v);
  return /\s/.test(s) ? `"${s}"` : s;
}

/** As linhas de diretiva do host, sem o cabeçalho. */
function bodyLines(host, indent) {
  const out = [];
  const fields = { hostname: host.hostname, user: host.user, port: host.port, identityfile: host.identityFile };
  for (const [key, name] of KNOWN) {
    const v = fields[key];
    if (v != null && String(v).trim() !== '') out.push(`${indent}${name} ${value(String(v).trim())}`);
  }
  for (const e of host.extra || []) out.push(`${indent}${e.trim()}`);
  return out;
}

/** O recuo que o arquivo já usa, pra o bloco novo parecer dos outros. */
function indentOf(lines) {
  for (const raw of lines) {
    const m = raw.match(/^(\s+)\S/);
    if (m && directive(raw)) return m[1];
  }
  return '    ';
}

/**
 * Onde entra um bloco novo: antes do primeiro `Host *`/`Match` (que valem pra
 * todos e, no ssh, a primeira ocorrência de uma chave ganha), junto dos
 * comentários colados nele. Sem nenhum, no fim.
 */
function insertAt(lines, bs) {
  const generic = bs.find((b) => b.match || !b.aliases.some(concrete) || b.aliases.some((a) => !concrete(a)));
  if (!generic) return lines.length;
  let i = generic.start;
  while (i > 0 && /^\s*#/.test(lines[i - 1])) i--;
  return i;
}

/**
 * O texto novo com o bloco de `alias` criado, trocado ou (com host null)
 * apagado. `host.alias` diferente de `alias` renomeia. Sem o bloco e sem host,
 * devolve o texto como veio.
 */
function upsertText(text, alias, host) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  // O split de um texto terminado em quebra deixa um '' no fim: guarda e repõe.
  const trailing = lines.length && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  const bs = blocks(lines);
  const indent = indentOf(lines);
  const b = alias ? bs.find((x) => !x.match && x.aliases.length === 1 && x.aliases[0] === alias) : null;
  if (b) {
    if (!host) {
      // Apaga o bloco e a linha em branco que o separava do próximo.
      // Um Include solto depois do último bloco conta como dele: fica no arquivo.
      let end = b.end;
      if (end + 1 < lines.length && lines[end + 1].trim() === '') end++;
      const kept = lines.slice(b.start + 1, b.end + 1).filter((l) => directive(l)?.key === 'include');
      lines.splice(b.start, end - b.start + 1, ...kept);
    } else {
      // Os comentários e os Include de dentro do bloco ficam, no topo dele.
      const comments = lines.slice(b.start + 1, b.end + 1).filter((l) => /^\s*#/.test(l) || directive(l)?.key === 'include');
      const header = lines[b.start].replace(/^(\s*Host\s*=?\s*)\S+/i, `$1${host.alias}`);
      lines.splice(b.start, b.end - b.start + 1, header, ...comments, ...bodyLines(host, indent));
    }
  } else if (host) {
    const at = insertAt(lines, bs);
    const block = [`Host ${host.alias}`, ...bodyLines(host, indent)];
    if (at > 0 && lines[at - 1].trim() !== '') block.unshift('');
    if (at < lines.length) block.push('');
    lines.splice(at, 0, ...block);
  }
  return lines.join(eol) + (trailing || !text.length ? eol : '');
}

// Onde ficam as cópias de antes de cada escrita: fora do ~/.ssh, pra um
// `Include config.d/*` não ler uma cópia velha como mais um config.
let backupDir = '';

function setBackupDir(dir) {
  backupDir = dir;
}

/**
 * Grava o texto novo no arquivo: a primeira escrita do dia guarda uma cópia na
 * pasta de cópias (`config.AAAA-MM-DD`), e a troca é atômica, pra um app
 * fechado no meio não deixar o config pela metade. Um config que é um link
 * (dotfiles) continua link: grava no arquivo pra onde ele aponta.
 */
function write(file, text) {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // ainda não existe
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    mode = fs.statSync(target).mode & 0o777;
    const dir = backupDir || path.join(path.dirname(target), '.maestria-backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const backup = path.join(dir, `${path.basename(target)}.${new Date().toISOString().slice(0, 10)}`);
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
  } catch {
    // sem arquivo ainda: nada pra guardar
  }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.maestria.tmp`);
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, target);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Cria ou troca o bloco de `alias` (null pra um host novo) no arquivo dele. */
function upsert(alias, host, file = MAIN) {
  const before = read(file);
  const after = upsertText(before, alias, host);
  if (after !== before) write(file, after);
}

function remove(alias, file = MAIN) {
  upsert(alias, null, file);
}

/** O alias que um nome vira: minúsculas, sem acento, sem espaço. */
function slug(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * As diretivas extras como vêm do formulário: separadas por `;` ou quebra de
 * linha, cada uma `Chave valor`. Devolve `{ extra }` ou `{ error }`.
 */
// As diretivas do ssh_config(5), mais as que o ssh de outros sistemas aceita: um
// `;` só separa diretivas quando o que vem depois é uma delas -- o de dentro de
// um `RemoteCommand cd /srv; exec bash` fica no valor.
const KEYWORDS = new Set(
  `AddKeysToAgent AddressFamily BatchMode BindAddress BindInterface CanonicalDomains CanonicalizeFallbackLocal
  CanonicalizeHostname CanonicalizeMaxDots CanonicalizePermittedCNAMEs CASignatureAlgorithms CertificateFile
  ChannelTimeout CheckHostIP Ciphers ClearAllForwardings Compression ConnectionAttempts ConnectTimeout ControlMaster
  ControlPath ControlPersist DynamicForward EnableEscapeCommandline EnableSSHKeysign EscapeChar ExitOnForwardFailure
  FingerprintHash ForkAfterAuthentication ForwardAgent ForwardX11 ForwardX11Timeout ForwardX11Trusted GatewayPorts
  GlobalKnownHostsFile GSSAPIAuthentication GSSAPIClientIdentity GSSAPIDelegateCredentials GSSAPIKexAlgorithms
  GSSAPIKeyExchange GSSAPIRenewalForcesRekey GSSAPIServerIdentity GSSAPITrustDns HashKnownHosts Host
  HostbasedAcceptedAlgorithms HostbasedAuthentication HostbasedKeyTypes HostKeyAlgorithms HostKeyAlias Hostname
  IdentitiesOnly IdentityAgent IdentityFile IgnoreUnknown Include IPQoS KbdInteractiveAuthentication
  KbdInteractiveDevices KexAlgorithms KnownHostsCommand LocalCommand LocalForward LogLevel LogVerbose MACs Match
  NoHostAuthenticationForLocalhost NumberOfPasswordPrompts ObscureKeystrokeTiming PasswordAuthentication
  PermitLocalCommand PermitRemoteOpen PKCS11Provider Port PreferredAuthentications ProxyCommand ProxyJump
  ProxyUseFdpass PubkeyAcceptedAlgorithms PubkeyAcceptedKeyTypes PubkeyAuthOptions PubkeyAuthentication RefuseConnection
  RekeyLimit RemoteCommand RemoteForward RequestTTY RequiredRSASize RevokedHostKeys SecurityKeyProvider SendEnv
  ServerAliveCountMax ServerAliveInterval SessionType SetEnv StdinNull StreamLocalBindMask StreamLocalBindUnlink
  StrictHostKeyChecking SyslogFacility Tag TCPKeepAlive Tunnel TunnelDevice UpdateHostKeys UseKeychain User
  UserKnownHostsFile VerifyHostKeyDNS VisualHostKey WarnWeakCrypto XAuthLocation`
    .split(/\s+/)
    .map((k) => k.toLowerCase()),
);

/** As partes do campo: uma por linha, e o `;` só antes de uma diretiva conhecida. */
function extraParts(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const bits = line.split(';');
    let cur = bits[0];
    for (const bit of bits.slice(1)) {
      const word = (bit.trim().match(/^[A-Za-z0-9]+/) || [''])[0].toLowerCase();
      if (KEYWORDS.has(word)) {
        out.push(cur);
        cur = bit;
      } else cur += `;${bit}`;
    }
    out.push(cur);
  }
  return out;
}

function parseExtra(text) {
  const out = [];
  for (const part of extraParts(text)) {
    const s = part.trim();
    if (!s) continue;
    const d = directive(s);
    if (!d || !/^[A-Za-z]+$/.test(d.name) || !d.value) return { error: `“${s}” não é uma diretiva do ssh (Chave valor)` };
    if (d.key === 'host' || d.key === 'match' || d.key === 'include') return { error: `${d.name} não vale dentro de um host` };
    if (KNOWN_KEYS.has(d.key) && d.key !== 'identityfile') return { error: `${d.name} tem campo próprio no formulário` };
    out.push(`${d.name} ${d.raw}`);
  }
  return { extra: out };
}

module.exports = { MAIN, list, upsert, upsertText, remove, slug, parseExtra, concrete, setBackupDir };
