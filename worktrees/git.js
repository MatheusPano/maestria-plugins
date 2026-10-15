// O git das worktrees: listar as de um repositório, ler e gravar a descrição
// de cada branch e contar o que cada uma tem. Nada de janela aqui.
//
// A descrição é a do `git branch --edit-description`: `branch.<nome>.description`
// no `.git/config` do repositório principal. Todas as worktrees enxergam a
// mesma, e ela não sobe no push.

'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  // O status de cada worktree a cada poucos segundos não pode disputar o
  // index.lock com o git que o claude roda no terminal ao lado.
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

/** Roda `git args` em `cwd`. Nunca rejeita: { code, stdout, stderr }. */
function run(cwd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: ENV, maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && typeof err.code !== 'number' ? err.message : '')) });
    });
  });
}

/** Como `run`, mas rejeita com a linha útil do stderr. */
async function must(cwd, args, opts) {
  const r = await run(cwd, args, opts);
  if (r.code !== 0) {
    const lines = (r.stderr || r.stdout).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('hint:'));
    const why = (lines.find((l) => /^(fatal|error):/.test(l)) || lines.slice(-2).join(' ')).replace(/^(fatal|error):\s*/, '');
    throw new Error(why || `git ${args[0]} saiu com ${r.code}`);
  }
  return r.stdout;
}

/**
 * As worktrees do repositório de `dir`, a principal primeiro (é a ordem do
 * git): `[{ path, head, branch, detached, bare, locked, prunable }]`.
 */
async function worktrees(dir) {
  const r = await run(dir, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return out;
}

/** Todas as descrições de branch do repositório: Map(branch → texto). */
async function descriptions(root) {
  const r = await run(root, ['config', '-z', '--get-regexp', '^branch\\..*\\.description$']);
  const map = new Map();
  if (r.code !== 0) return map; // 1: nenhuma
  for (const rec of r.stdout.split('\0')) {
    const nl = rec.indexOf('\n');
    if (nl < 0) continue;
    const key = rec.slice(0, nl);
    // A seção e a chave voltam em minúsculas; o nome da branch (o meio), não.
    const branch = key.slice('branch.'.length, -'.description'.length);
    const text = rec.slice(nl + 1).trim();
    if (branch && text) map.set(branch, text);
  }
  return map;
}

/** Grava (ou apaga, com texto vazio) a descrição da branch. */
async function setDescription(root, branch, text) {
  const key = `branch.${branch}.description`;
  text = String(text || '').trim();
  if (text) return must(root, ['config', key, text]);
  const r = await run(root, ['config', '--unset', key]);
  if (r.code !== 0 && r.code !== 5) throw new Error(r.stderr.trim() || 'não deu pra apagar a descrição');
}

/** A branch padrão do remoto (origin/HEAD, senão origin/main ou origin/master), ou null. */
async function baseRef(root) {
  const head = await run(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim().replace('refs/remotes/', '');
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await run(root, ['rev-parse', '--verify', '--quiet', ref])).code === 0) return ref;
  }
  return null;
}

/** O que a worktree tem: quanto à frente/atrás da base, o que não foi commitado e o último commit. */
async function stats(wt, base) {
  if (!fs.existsSync(wt)) return { missing: true };
  const [st, lr, last] = await Promise.all([
    run(wt, ['status', '--porcelain']),
    base ? run(wt, ['rev-list', '--left-right', '--count', `${base}...HEAD`]) : null,
    run(wt, ['log', '-1', '--format=%h%x1f%s%x1f%ct']),
  ]);
  const dirty = st.code === 0 ? st.stdout.split('\n').filter(Boolean).length : 0;
  let ahead = null;
  let behind = null;
  if (lr && lr.code === 0) [behind, ahead] = lr.stdout.trim().split(/\s+/).map(Number);
  const [hash, subject, ct] = last.code === 0 ? last.stdout.trim().split('\x1f') : [];
  return { dirty, ahead, behind, last: hash ? { hash, subject, at: Number(ct) * 1000 } : null };
}

/** Os commits que a worktree tem a mais que a base (ou os últimos, sem base). */
async function commits(wt, base, max) {
  const args = ['log', `-${max}`, '--format=%h%x1f%s%x1f%ct'];
  if (base) args.push(`${base}..HEAD`);
  const r = await run(wt, args);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, ct] = l.split('\x1f');
      return { hash, subject, at: Number(ct) * 1000 };
    });
}

/** Os arquivos não commitados: `[{ code, path }]` (o XY do porcelain). */
async function changes(wt) {
  const r = await run(wt, ['status', '--porcelain', '--untracked-files=all']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '') }));
}

/** Traz o origin, sem as branches que sumiram de lá. Offline não é erro: fica o que já tinha. */
async function fetch(root) {
  return (await run(root, ['fetch', '--prune', '--quiet', 'origin'], { timeout: 30000 })).code === 0;
}

/** Onde fica, no .git/config, em quais branches as worktrees do repositório entram. */
const MERGE_INTO = 'worktrees.mergeInto';

async function getConfig(root, key) {
  const r = await run(root, ['config', '--get', key]);
  return r.code === 0 ? r.stdout.trim() : null;
}

const setConfig = (root, key, value) => must(root, ['config', key, value]);

const exists = async (root, ref) => (await run(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;

/** Os nomes (main, develop) viram refs: a do origin, senão a local. `unknown` são os que não existem. */
async function resolveTargets(root, names) {
  const refs = [];
  const unknown = [];
  for (const n of names) {
    const bare = n.replace(/^origin\//, '');
    const ref = (await exists(root, `origin/${bare}`)) ? `origin/${bare}` : (await exists(root, n)) ? n : null;
    if (!ref) unknown.push(n);
    else if (!refs.includes(ref)) refs.push(ref);
  }
  return { refs, unknown };
}

/** O palpite pra primeira vez: a branch padrão do origin e, se existir, o develop. */
async function suggestTargets(root, base) {
  const out = base ? [base.replace(/^origin\//, '')] : [];
  if (!out.includes('develop') && (await exists(root, 'origin/develop'))) out.push('develop');
  return out;
}

/** Os commits da linha principal de `ref` (o --first-parent): um Set de hashes. */
async function firstParents(root, ref) {
  const r = await run(root, ['rev-list', '--first-parent', ref]);
  return new Set(r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []);
}

/** Se `head` está na história de `ref`. */
async function contains(root, ref, head) {
  return (await run(root, ['merge-base', '--is-ancestor', head, ref])).code === 0;
}

module.exports = { run, must, worktrees, descriptions, setDescription, baseRef, stats, commits, changes, fetch, firstParents, contains, MERGE_INTO, getConfig, setConfig, resolveTargets, suggestTargets };
