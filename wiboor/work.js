// Trabalhar numa tarefa: a worktree dela e o comentário do que foi feito.
//
// A worktree segue o jeito da Maestria (o "nova tarefa" da lateral): a pasta
// em `<repo>/.claude/worktrees/TASK-123` e a branch `feature/TASK#123` (ou
// `hotfix/BUG#123`), a partir da branch padrão do remoto. O `#` sai do nome da
// pasta e fica na branch. O git roda sem shell, com os argumentos em lista.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const CLAUDE_TIMEOUT_MS = 3 * 60 * 1000;
const DIFF_LIMIT = 60000;

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !allowFail) reject(new Error(String(stderr || err.message).trim()));
      else resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() });
    });
  });
}

/** A branch padrão do remoto (origin/HEAD, senão origin/master ou origin/main). */
async function baseRef(root) {
  const head = await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (head.ok && head.out) return head.out.replace('refs/remotes/', '');
  for (const ref of ['origin/master', 'origin/main']) {
    const v = await git(root, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true });
    if (v.ok) return ref;
  }
  return null;
}

/** Onde a worktree da tarefa fica (ou ficaria) num repositório. */
function worktreePath(root, dirName) {
  return path.join(root, '.claude', 'worktrees', dirName);
}

/**
 * A worktree da branch, criando se preciso. Uma que já existe é reaproveitada;
 * uma branch que já existe sem worktree ganha uma, sem `-b`.
 */
async function ensureWorktree(root, dirName, branch) {
  const dir = worktreePath(root, dirName);
  const list = await git(root, ['worktree', 'list', '--porcelain']);
  let current = null;
  for (const line of list.out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice(9);
    else if (line === `branch refs/heads/${branch}` && current) return { path: current, created: false };
  }
  if (fs.existsSync(dir)) throw new Error(`já existe uma pasta em ${dir}, e ela não é a worktree de ${branch}`);
  await git(root, ['fetch', 'origin', '--quiet'], { allowFail: true });
  const local = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
  if (local.ok) {
    await git(root, ['worktree', 'add', dir, branch]);
    return { path: dir, created: true, base: null };
  }
  const base = await baseRef(root);
  if (!base) throw new Error(`não achei a branch padrão do remoto em ${root} (origin/master ou origin/main)`);
  await git(root, ['worktree', 'add', dir, '-b', branch, base]);
  return { path: dir, created: true, base };
}

/**
 * Dá à branch a descrição do `git branch --edit-description` (o título da
 * tarefa), que o plugin das worktrees mostra. Fica no `.git/config` do
 * repositório principal, então vale em todas as worktrees e não sobe no push.
 * Uma descrição que já existe não é trocada: pode ser uma que você escreveu.
 */
async function describe(cwd, branch, text) {
  const key = `branch.${branch}.description`;
  const had = await git(cwd, ['config', '--get', key], { allowFail: true });
  if (had.ok && had.out) return false;
  await git(cwd, ['config', key, text]);
  return true;
}

/** O que mudou na pasta desde a branch padrão: os commits, o diff e o que ainda não foi commitado. */
async function changes(cwd) {
  const base = await baseRef(cwd);
  const since = base ? (await git(cwd, ['merge-base', 'HEAD', base], { allowFail: true })).out : '';
  const log = since ? (await git(cwd, ['log', '--format=%s', `${since}..HEAD`], { allowFail: true })).out : '';
  const committed = since ? (await git(cwd, ['diff', `${since}..HEAD`], { allowFail: true })).out : '';
  const pending = (await git(cwd, ['diff', 'HEAD'], { allowFail: true })).out;
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'], { allowFail: true })).out;
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).out;
  return { base, branch, log, committed, pending, untracked };
}

/**
 * Pede ao `claude -p` um comentário pra tarefa com o que foi feito na pasta.
 * O prompt vai por arquivo, nunca pela linha de comando: ele carrega diff e o
 * texto da tarefa, e nada disso é pra um shell reler.
 */
async function draftComment(cwd, task) {
  const c = await changes(cwd);
  if (!c.log && !c.committed && !c.pending && !c.untracked) throw new Error(`nada mudou em ${cwd} desde ${c.base || 'a branch padrão'}`);
  let diff = [c.committed, c.pending].filter(Boolean).join('\n\n');
  if (diff.length > DIFF_LIMIT) diff = `${diff.slice(0, DIFF_LIMIT)}\n\n[diff cortado]`;
  const prompt = [
    `Escreva um comentário para a tarefa ${task.tag} do Wiboor contando o que foi feito, a partir das mudanças abaixo.`,
    '',
    'Em português, direto, para quem pediu a tarefa ler: o que mudou e por quê, o que ficou de fora e o que',
    'ainda falta (se faltar). Sem título, sem saudação, sem inventar o que o diff não mostra. Use markdown',
    'simples: parágrafos curtos e listas com "- ". Responda só com o comentário.',
    '',
    `Tarefa: ${task.title}`,
    task.description ? `\nDescrição da tarefa:\n${task.description.slice(0, 6000)}` : '',
    '',
    `Branch: ${c.branch}${c.base ? ` (a partir de ${c.base})` : ''}`,
    c.log ? `\nCommits:\n${c.log.split('\n').map((s) => `- ${s}`).join('\n')}` : '',
    c.untracked ? `\nArquivos novos ainda sem commit:\n${c.untracked}` : '',
    '',
    'Diff:',
    '',
    diff,
  ].join('\n');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestria-wiboor-'));
  const file = path.join(temp, 'prompt.md');
  fs.writeFileSync(file, prompt);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('/bin/zsh', ['-lc', `claude -p --output-format text < '${file.replace(/'/g, `'\\''`)}'`], { cwd, env: process.env });
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
        const text = stdout.trim();
        if (code !== 0 || !text) reject(new Error(stderr.trim() || `o claude saiu com ${code} sem escrever nada`));
        else resolve(text);
      });
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { ensureWorktree, worktreePath, baseRef, describe, draftComment };
