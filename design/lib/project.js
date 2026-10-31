'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_NAMES = ['js', 'cjs', 'mjs', 'ts'].map((e) => `tailwind.config.${e}`);
const V4_INPUTS = ['src/index.css', 'src/app.css', 'src/styles.css', 'src/globals.css',
  'app/globals.css', 'app/app.css', 'styles/globals.css', 'src/styles/globals.css'];

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function majorOf(range) {
  const m = /(\d+)/.exec(String(range || ''));
  return m ? Number(m[1]) : null;
}

// What the project has: Tailwind (version, bin, config, v4 entry css) and sass.
function detect(repoDir) {
  const bins = path.join(repoDir, 'node_modules', '.bin');
  const bin = path.join(bins, 'tailwindcss');
  if (!fs.existsSync(bin)) throw new Error('o projeto não tem tailwind em node_modules');

  const installed = readJson(path.join(repoDir, 'node_modules', 'tailwindcss', 'package.json'));
  const pkg = readJson(path.join(repoDir, 'package.json')) || {};
  const declared = (pkg.devDependencies && pkg.devDependencies.tailwindcss)
    || (pkg.dependencies && pkg.dependencies.tailwindcss);
  const version = majorOf(installed && installed.version) || majorOf(declared) || 3;

  const configName = CONFIG_NAMES.find((n) => isFile(path.join(repoDir, n)));
  const config = configName ? path.join(repoDir, configName) : null;

  let input = null;
  if (version >= 4) {
    const found = V4_INPUTS.find((rel) => {
      const p = path.join(repoDir, rel);
      return isFile(p) && /@import\s+["']tailwindcss/.test(fs.readFileSync(p, 'utf8'));
    });
    if (found) input = path.join(repoDir, found);
  }

  const sassBin = path.join(bins, 'sass');
  return {
    tailwind: { version: version >= 4 ? 4 : 3, bin, config, input },
    sass: fs.existsSync(sassBin) ? sassBin : null,
  };
}

// Index of the `}` matching the `{` at `open` (strings and comments skipped), or -1.
function matchBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2);
      if (i < 0) return -1;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// The keys at depth 1 of an object body, and the `...spread` names.
function topLevel(body) {
  const keys = [];
  const spreads = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < body.length && body[i] !== c; i++) if (body[i] === '\\') i++;
    } else if (c === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i++;
    } else if (c === '/' && body[i + 1] === '*') {
      i = body.indexOf('*/', i + 2);
      if (i < 0) break;
    } else if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if ((c === ',' || i === body.length) && depth === 0) {
      const item = body.slice(at, i).replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '').trim();
      at = i + 1;
      const sp = /^\.\.\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(item);
      if (sp) { spreads.push(sp[1]); continue; }
      const k = /^(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$-]*))\s*:\s*\{/.exec(item);
      if (k) keys.push(k[1] || k[2]);
    }
  }
  return { keys, spreads };
}

function readObject(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  const open = text.indexOf('{', m.index + m[0].length - 1);
  const close = open < 0 ? -1 : matchBrace(text, open);
  return close < 0 ? null : text.slice(open + 1, close);
}

function resolveRelative(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  const tries = [base, ...['.js', '.cjs', '.mjs', '.ts'].map((e) => base + e), ...['js', 'ts'].map((e) => path.join(base, `index.${e}`))];
  return tries.find(isFile) || null;
}

// Best effort: the color families (woot, slate, n…) the project's tailwind config
// declares, following `...spread` of a relative import one file deep. [] when unknown.
function colorFamilies(repoDir) {
  try {
    const configName = CONFIG_NAMES.find((n) => isFile(path.join(repoDir, n)));
    if (!configName) return [];
    const text = fs.readFileSync(path.join(repoDir, configName), 'utf8');
    const out = new Set();
    const re = /\bcolors\s*:\s*\{/g;
    let m;
    while ((m = re.exec(text))) {
      const body = readObject(text.slice(m.index), /\bcolors\s*:\s*\{/);
      if (!body) continue;
      const { keys, spreads } = topLevel(body);
      keys.forEach((k) => out.add(k));
      for (const name of spreads) {
        const imp = new RegExp(`(?:import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from|\\b${name}\\b[^=]*=\\s*require\\()\\s*['"](\\.[^'"]*)['"]`).exec(text);
        const file = imp && resolveRelative(repoDir, imp[1]);
        if (!file) continue;
        const src = fs.readFileSync(file, 'utf8');
        const obj = readObject(src, new RegExp(`\\b${name}\\b\\s*=\\s*\\{`));
        if (obj) topLevel(obj).keys.forEach((k) => out.add(k));
      }
    }
    return [...out];
  } catch { return []; }
}

module.exports = { detect, colorFamilies };
