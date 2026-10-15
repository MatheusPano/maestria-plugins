// O disco e o git do editor: listar uma pasta, ler e gravar um arquivo, a
// linguagem pela extensão, o estado de cada arquivo no git, a lista de todos os
// arquivos pro ⌘P e a busca no conteúdo pro ⇧⌘F. Nada aqui fala com a janela.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Maior que isso o editor não abre: um log de 200 MB não é código.
const MAX_BYTES = 8 * 1024 * 1024;

/** Roda um programa e devolve o stdout; rejeita com o stderr. */
function run(cmd, args, cwd, { maxBuffer = 64 * 1024 * 1024, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (err && !okCodes.includes(code)) {
        reject(new Error((stderr || err.message || '').trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

// --- a árvore ----------------------------------------------------------------------

/**
 * O que tem numa pasta: as pastas primeiro, depois os arquivos, cada grupo em
 * ordem alfabética sem ligar pra maiúscula (a do VS Code). `hide` são nomes que
 * não aparecem (`.git`, `.DS_Store`).
 */
function list(dir, hide) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (hide.has(e.name)) continue;
    let isDir = e.isDirectory();
    // Um link pra pasta é pasta; um link quebrado fica como arquivo, que abre e diz o erro.
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(dir, e.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    out.push({ name: e.name, dir: isDir });
  }
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
  out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name)));
  return out;
}

// --- ler e gravar -------------------------------------------------------------------

/**
 * O arquivo como texto, com o que o editor precisa saber dele: `{ text, mtime,
 * eol }`, ou `{ error }` quando não dá pra abrir (binário, grande demais, sumiu).
 * O CRLF vira LF pro editor, e volta CRLF ao gravar (`eol`).
 */
function read(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'o arquivo não existe mais' : e.message };
  }
  if (st.isDirectory()) return { error: 'é uma pasta' };
  if (st.size > MAX_BYTES) return { error: `grande demais pro editor (${mb(st.size)})` };
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { error: e.message };
  }
  if (binary(buf)) return { error: 'arquivo binário' };
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const eol = /\r\n/.test(text.slice(0, 64 * 1024)) ? 'crlf' : 'lf';
  if (eol === 'crlf') text = text.replace(/\r\n/g, '\n');
  return { text, mtime: st.mtimeMs, eol };
}

/** Grava o texto (com o fim de linha do arquivo) e devolve o mtime novo. */
function write(file, text, eol = 'lf') {
  const out = eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
  fs.writeFileSync(file, out, 'utf8');
  return fs.statSync(file).mtimeMs;
}

/** O mtime de agora, ou `null` quando o arquivo sumiu. */
function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// Um NUL nos primeiros 8 KB é o mesmo teste do git pra binário.
function binary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

// --- a linguagem --------------------------------------------------------------------

// A extensão (ou o nome inteiro) pro nome que o `CodeEditor` da Maestria colore.
// Um nome que a Maestria não conhece abre sem cor, então errar aqui não quebra nada.
const BY_EXT = {
  dart: 'dart',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', arb: 'json', lock: 'json',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', pyi: 'python',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  m: 'objectivec', mm: 'objectivec',
  php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', env: 'bash',
  ps1: 'powershell',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml', xib: 'xml', storyboard: 'xml', xaml: 'xml',
  vue: 'vue',
  sql: 'sql',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini', editorconfig: 'ini',
  properties: 'properties',
  graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf',
  gradle: 'gradle',
  groovy: 'groovy',
  lua: 'lua',
  ex: 'elixir', exs: 'elixir',
  scala: 'scala',
  hs: 'haskell',
  pl: 'perl', pm: 'perl',
  r: 'r',
  diff: 'diff', patch: 'diff',
  rfwtxt: 'dart',
};
const BY_NAME = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  '.zshrc': 'bash',
  '.bashrc': 'bash',
  '.profile': 'bash',
  '.gitignore': 'bash',
  '.dockerignore': 'bash',
  'nginx.conf': 'nginx',
};

// Os nomes como a barra de baixo diz.
const LABELS = {
  dart: 'Dart', javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', yaml: 'YAML',
  markdown: 'Markdown', python: 'Python', ruby: 'Ruby', go: 'Go', rust: 'Rust', java: 'Java',
  kotlin: 'Kotlin', swift: 'Swift', c: 'C', cpp: 'C++', csharp: 'C#', objectivec: 'Objective-C',
  php: 'PHP', bash: 'Shell', powershell: 'PowerShell', css: 'CSS', scss: 'SCSS', less: 'Less',
  xml: 'HTML/XML', vue: 'Vue', sql: 'SQL', dockerfile: 'Dockerfile', makefile: 'Makefile',
  ini: 'INI/TOML', properties: 'Properties', graphql: 'GraphQL', protobuf: 'Protobuf',
  gradle: 'Gradle', groovy: 'Groovy', lua: 'Lua', elixir: 'Elixir', scala: 'Scala',
  haskell: 'Haskell', perl: 'Perl', r: 'R', nginx: 'nginx', diff: 'Diff', plaintext: 'Texto',
};

function language(file) {
  const base = path.basename(file).toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  if (base.startsWith('dockerfile')) return 'dockerfile';
  if (base.startsWith('.env')) return 'bash';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return BY_EXT[ext] || 'plaintext';
}

const languageLabel = (lang) => LABELS[lang] || lang;

// --- o git --------------------------------------------------------------------------

/** A raiz do repositório de `dir`, ou `null` fora de um. */
async function gitRoot(dir) {
  try {
    return (await run('git', ['rev-parse', '--show-toplevel'], dir)).trim() || null;
  } catch {
    return null;
  }
}

async function branch(dir) {
  try {
    return (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
  } catch {
    return '';
  }
}

/**
 * O estado de cada arquivo, pelo caminho absoluto: `M` mudou, `A` novo
 * preparado, `U` não rastreado, `D` apagado, `C` conflito, `I` ignorado. As
 * pastas herdam o mais forte dos filhos, pra árvore fechada dizer que há algo
 * lá dentro. Uma pasta ignorada inteira vem como ela mesma (`node_modules/`).
 */
async function gitStatus(repo) {
  const out = new Map();
  if (!repo) return out;
  let raw;
  try {
    raw = await run('git', ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal'], repo);
  } catch {
    return out;
  }
  const parts = raw.split('\0');
  const RANK = { I: 0, D: 1, A: 2, U: 2, M: 3, C: 4 };
  const bump = (abs, code) => {
    const prev = out.get(abs);
    if (!prev || RANK[code] > RANK[prev]) out.set(abs, code);
  };
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    let rel = entry.slice(3);
    // Um renome traz o caminho de antes no pedaço seguinte.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    const dirEntry = rel.endsWith('/');
    if (dirEntry) rel = rel.slice(0, -1);
    const abs = path.join(repo, rel);
    let code;
    if (xy === '!!') code = 'I';
    else if (xy === '??') code = 'U';
    else if (xy.includes('U') || xy === 'AA' || xy === 'DD') code = 'C';
    else if (xy.includes('D')) code = 'D';
    else if (xy[0] === 'A') code = 'A';
    else code = 'M';
    out.set(abs, code);
    if (code === 'I') continue;
    // As pastas de cima, até a raiz do repositório.
    let up = path.dirname(abs);
    while (up.length > repo.length) {
      bump(up, code === 'D' ? 'M' : code);
      up = path.dirname(up);
    }
  }
  return out;
}

/** Se `file` (ou uma pasta acima dele) está ignorado, pelo mapa do gitStatus. */
function ignored(status, file, repo) {
  if (!repo) return false;
  let p = file;
  while (p.length >= repo.length) {
    if (status.get(p) === 'I') return true;
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
  return false;
}

// --- todos os arquivos (⌘P) ----------------------------------------------------------

/**
 * Os arquivos de `root`, relativos a ela: no git, os rastreados e os novos sem
 * os ignorados; fora dele, uma volta pela pasta, sem `hide` e sem as pastas
 * pesadas de sempre, até `limit`.
 */
async function allFiles(root, hide, limit = 50000) {
  const repo = await gitRoot(root);
  if (repo) {
    try {
      const raw = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], root);
      const files = raw.split('\0').filter(Boolean);
      // O ls-files dá os caminhos relativos à pasta em que roda.
      return files.slice(0, limit).filter((f) => fs.existsSync(path.join(root, f)));
    } catch {
      // cai na volta pela pasta
    }
  }
  const HEAVY = new Set(['node_modules', '.dart_tool', 'build', 'dist', '.next', 'Pods', '.gradle', 'target', 'vendor']);
  const out = [];
  const walk = (dir, rel) => {
    if (out.length >= limit) return;
    for (const e of list(dir, hide)) {
      if (out.length >= limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.dir) {
        if (!HEAVY.has(e.name)) walk(path.join(dir, e.name), r);
      } else out.push(r);
    }
  };
  walk(root, '');
  return out;
}

// --- buscar no conteúdo (⇧⌘F) --------------------------------------------------------

let rgPath; // undefined: ainda não procurado; null: não tem

async function findRg() {
  if (rgPath !== undefined) return rgPath;
  for (const p of ['rg', '/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg']) {
    try {
      await run(p, ['--version'], process.cwd());
      rgPath = p;
      return p;
    } catch {
      // o próximo
    }
  }
  rgPath = null;
  return null;
}

/**
 * As linhas que têm `query`: `{ results: [{ file, line, column, text }], total,
 * truncated, engine }`. Pelo ripgrep quando há (respeita o .gitignore e é rápido),
 * senão pelo `git grep` num repositório, senão por uma volta em node. Maiúsculas
 * só contam quando a busca tem alguma (o "smart case" do VS Code).
 */
async function search(root, query, { hide, regex = false, limit = 2000 } = {}) {
  const smartCase = query !== query.toLowerCase();
  const rg = await findRg();
  if (rg) {
    const args = ['--line-number', '--column', '--no-heading', '--color', 'never', '--max-columns', '400', '--max-count', '200'];
    if (!smartCase) args.push('--ignore-case');
    if (!regex) args.push('--fixed-strings');
    for (const h of hide) args.push('--glob', `!${h}`);
    args.push('--', query, '.');
    const raw = await run(rg, args, root, { okCodes: [0, 1] });
    return parse(raw, 'ripgrep');
  }
  if (await gitRoot(root)) {
    const args = ['grep', '--line-number', '--column', '-I', '--untracked', '--no-color'];
    if (!smartCase) args.push('-i');
    args.push(regex ? '-E' : '-F', '-e', query, '--', '.');
    const raw = await run('git', args, root, { okCodes: [0, 1] });
    return parse(raw, 'git grep');
  }
  const results = [];
  const needle = smartCase ? query : query.toLowerCase();
  let re = null;
  if (regex) {
    try {
      re = new RegExp(query, smartCase ? '' : 'i');
    } catch (e) {
      throw new Error(`expressão inválida: ${e.message}`);
    }
  }
  for (const rel of await allFiles(root, hide, 20000)) {
    if (results.length >= limit) break;
    const r = read(path.join(root, rel));
    if (r.error) continue;
    const lines = r.text.split('\n');
    for (let i = 0; i < lines.length && results.length < limit; i++) {
      const hay = smartCase ? lines[i] : lines[i].toLowerCase();
      const col = re ? lines[i].search(re) : hay.indexOf(needle);
      if (col >= 0) results.push({ file: rel, line: i + 1, column: col + 1, text: lines[i] });
    }
  }
  return { results, total: results.length, truncated: results.length >= limit, engine: 'node' };

  function parse(raw, engine) {
    const out = [];
    let total = 0;
    for (const lineText of raw.split('\n')) {
      const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(lineText);
      if (!m) continue;
      total++;
      if (out.length >= limit) continue;
      out.push({ file: m[1].replace(/^\.\//, ''), line: Number(m[2]), column: Number(m[3]), text: m[4] });
    }
    return { results: out, total, truncated: total > out.length, engine };
  }
}

// --- lixeira ------------------------------------------------------------------------

/**
 * Manda pra lixeira do sistema (o Finder no macOS, o `gio` no Linux). Devolve
 * `false` quando não há como, e quem chamou decide se apaga de vez.
 */
async function trash(file) {
  try {
    if (process.platform === 'darwin') {
      const posix = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await run('osascript', ['-e', `tell application "Finder" to delete POSIX file "${posix}"`], path.dirname(file));
      return true;
    }
    await run('gio', ['trash', '--', file], path.dirname(file));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MAX_BYTES,
  run,
  list,
  read,
  write,
  mtime,
  language,
  languageLabel,
  gitRoot,
  branch,
  gitStatus,
  ignored,
  allFiles,
  search,
  trash,
};
