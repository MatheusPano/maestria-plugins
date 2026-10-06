// O git em si: rodar, ler o status e os commits. Nada de janela aqui — o
// main.js desenha, este arquivo só sabe falar com o repositório.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const ENV = {
  ...process.env,
  // Sem isto um fetch/push que precisa de senha fica esperando um terminal
  // que não existe, e a janela gira pra sempre.
  GIT_TERMINAL_PROMPT: '0',
  // O status de meio em meio segundo não pode disputar o index.lock com o
  // git que o claude está rodando no terminal ao lado.
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

/**
 * Roda `git args` em `cwd`. Resolve com { code, stdout, stderr } — nunca
 * rejeita por código de saída, porque vários comandos (diff --no-index) saem
 * com 1 quando deu certo.
 */
function run(cwd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: ENV, maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const why = err && typeof err.code !== 'number' ? String(err.message) : '';
      resolve({ code, stdout: String(stdout), stderr: String(stderr || why) });
    });
  });
}

/** Como `run`, mas rejeita com a última linha útil do stderr quando falha. */
async function must(cwd, args, opts) {
  const r = await run(cwd, args, opts);
  if (r.code !== 0) throw new Error(explain(r.stderr || r.stdout) || `git ${args[0]} saiu com ${r.code}`);
  return r.stdout;
}

/** A mensagem do git sem as linhas de dica, que numa faixa só atrapalham. */
function explain(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'));
  const fatal = lines.find((l) => /^(fatal|error):/.test(l));
  return (fatal || lines.slice(-2).join(' ')).replace(/^(fatal|error):\s*/, '');
}

/** A raiz do repositório que contém `dir`, ou null. */
async function toplevel(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const r = await run(dir, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.stdout.trim() : null;
}

// --- status ------------------------------------------------------------------

/** Separa os `n` primeiros campos por espaço; o resto (o caminho) vai inteiro. */
function fields(line, n) {
  const out = [];
  let rest = line;
  for (let i = 0; i < n; i++) {
    const at = rest.indexOf(' ');
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  out.push(rest);
  return out;
}

/**
 * Lê `git status --porcelain=v2 --branch -z`. Devolve a branch e três listas:
 * `staged` (o index difere do HEAD), `changes` (a árvore difere do index, e os
 * arquivos novos) e `conflicts`. Um arquivo modificado, preparado e mexido de
 * novo aparece nas duas primeiras, como no VS Code.
 */
function parseStatus(raw) {
  const st = { head: null, oid: null, upstream: null, ahead: 0, behind: 0, staged: [], changes: [], conflicts: [] };
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key, ...v] = line.split(' ');
      const value = v.join(' ');
      if (key === 'branch.head') st.head = value === '(detached)' ? null : value;
      else if (key === 'branch.oid') st.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.upstream') st.upstream = value;
      else if (key === 'branch.ab') {
        const m = value.match(/\+(\d+) -(\d+)/);
        if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
      }
      continue;
    }
    const kind = line[0];
    if (kind === '?') {
      st.changes.push({ path: line.slice(2), code: 'U', untracked: true });
    } else if (kind === '1' || kind === '2') {
      const f = fields(line, kind === '1' ? 8 : 9);
      const xy = f[1];
      const file = f[f.length - 1];
      // No tipo 2 (renomeado/copiado) o caminho antigo vem no campo seguinte.
      const from = kind === '2' ? parts[++i] : null;
      if (xy[0] !== '.') st.staged.push({ path: file, from, code: xy[0] });
      if (xy[1] !== '.') st.changes.push({ path: file, code: xy[1] });
    } else if (kind === 'u') {
      const f = fields(line, 10);
      st.conflicts.push({ path: f[f.length - 1], code: '!', xy: f[1] });
    }
  }
  return st;
}

async function status(root) {
  const r = await run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { timeout: 20000 });
  if (r.code !== 0) throw new Error(explain(r.stderr) || 'git status falhou');
  return { ...parseStatus(r.stdout), raw: r.stdout };
}

/** O que o status não diz: um rebase, merge ou cherry-pick parado no meio. */
async function operation(root) {
  const gitDir = (await run(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  if (!gitDir) return null;
  const has = (p) => fs.existsSync(path.join(gitDir, p));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return null;
}

// --- commits e branches ------------------------------------------------------

const SEP = '\x1f';

async function log(root, n) {
  const r = await run(root, ['log', `-${n}`, `--format=%h${SEP}%s${SEP}%an${SEP}%cr${SEP}%D`]);
  if (r.code !== 0) return []; // repositório sem commit nenhum
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, when, refs] = l.split(SEP);
      return { hash, subject, author, when, refs: refs || '' };
    });
}

/** As branches locais e as remotas que ainda não têm uma local com o mesmo nome. */
async function branches(root) {
  const out = await must(root, [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=%(refname)${SEP}%(refname:short)${SEP}%(committerdate:relative)${SEP}%(subject)`,
    'refs/heads',
    'refs/remotes',
  ]);
  const local = [];
  const remote = [];
  for (const l of out.split('\n').filter(Boolean)) {
    const [ref, name, when, subject] = l.split(SEP);
    if (ref.startsWith('refs/heads/')) local.push({ name, when, subject });
    else if (!ref.endsWith('/HEAD')) remote.push({ name, when, subject });
  }
  const names = new Set(local.map((b) => b.name));
  return {
    local,
    remote: remote.filter((b) => !names.has(b.name.slice(b.name.indexOf('/') + 1))),
  };
}

// --- diff --------------------------------------------------------------------

async function diff(root, file, { staged, untracked }) {
  if (untracked) {
    // Sai com 1 quando há diferença — que é sempre, contra /dev/null.
    const r = await run(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
    return r.stdout;
  }
  const args = ['diff', '--no-color', '-M'];
  if (staged) args.push('--cached');
  return must(root, [...args, '--', file]);
}

/** O que vai no commit: o preparado, ou tudo quando nada está preparado. */
async function diffForMessage(root, stagedOnly) {
  const args = stagedOnly ? ['diff', '--cached'] : ['diff', 'HEAD'];
  let text = (await run(root, [...args, '--no-color', '-M', '--stat', '--patch'])).stdout;
  if (!stagedOnly) {
    const untracked = (await run(root, ['ls-files', '--others', '--exclude-standard'])).stdout.trim();
    if (untracked) text += `\n\narquivos novos:\n${untracked}`;
  }
  return text;
}

// --- mensagem pelo claude ----------------------------------------------------

const CLAUDE_TIMEOUT_MS = 3 * 60 * 1000;
const DIFF_LIMIT = 60000;

/**
 * Pede ao `claude -p` uma mensagem de commit no estilo dos commits recentes
 * do repositório. O prompt vai por arquivo, nunca pela linha de comando: ele
 * carrega diff e assuntos de commit, e nada disso é pra um shell reler.
 */
async function suggestMessage(root, diffText, recent) {
  const cut = diffText.length > DIFF_LIMIT ? diffText.slice(0, DIFF_LIMIT) + '\n\n[diff cortado]' : diffText;
  const prompt = [
    'Escreva a mensagem de commit para o diff abaixo.',
    '',
    'Siga exatamente o estilo dos commits recentes deste repositório (idioma, prefixo de tarefa,',
    'maiúsculas, tamanho). Uma linha só, sem corpo, sem aspas, sem markdown, sem explicação:',
    'responda apenas com a mensagem.',
    '',
    'Commits recentes:',
    ...recent.map((c) => `- ${c.subject}`),
    '',
    'Diff:',
    '',
    cut,
  ].join('\n');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestria-git-'));
  const file = path.join(temp, 'prompt.md');
  fs.writeFileSync(file, prompt);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('/bin/zsh', ['-lc', `claude -p --output-format text < '${file.replace(/'/g, `'\\''`)}'`], {
        cwd: root,
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('o claude passou de 3 minutos e foi encerrado'));
      }, CLAUDE_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = stdout
          .trim()
          .split('\n')
          .map((l) => l.trim().replace(/^[`"']+|[`"']+$/g, ''))
          .find(Boolean);
        if (code !== 0 || !line) reject(new Error(stderr.trim() || `o claude saiu com ${code} sem escrever nada`));
        else resolve(line);
      });
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = {
  run,
  must,
  explain,
  toplevel,
  parseStatus,
  status,
  operation,
  log,
  branches,
  diff,
  diffForMessage,
  suggestMessage,
};
