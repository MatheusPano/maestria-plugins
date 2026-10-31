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

const STYLE_DIRS = ['app', 'src', 'styles', 'assets', 'resources', 'css'];
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'public', 'tmp', 'log', 'coverage']);
const MAX_STYLE_FILES = 3000;
const MAX_STYLE_BYTES = 512 * 1024;
const MAX_VAR_FILES = 3;

// The `--name`s the tailwind config reads with var(--name), in the config and
// the relative files it imports (one level deep).
function configVars(repoDir) {
  const configName = CONFIG_NAMES.find((n) => isFile(path.join(repoDir, n)));
  if (!configName) return new Set();
  const text = fs.readFileSync(path.join(repoDir, configName), 'utf8');
  const texts = [text];
  const imp = /(?:from\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = imp.exec(text))) {
    const file = resolveRelative(repoDir, m[1]);
    if (file) { try { texts.push(fs.readFileSync(file, 'utf8')); } catch { /* unreadable */ } }
  }
  const out = new Set();
  for (const t of texts) for (const v of t.matchAll(/var\(\s*(--[\w-]+)/g)) out.add(v[1]);
  return out;
}

function styleFiles(repoDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_STYLE_FILES) return;
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); } else if (/\.(s?css)$/.test(e.name)) out.push(p);
    }
  };
  for (const d of STYLE_DIRS) walk(path.join(repoDir, d));
  return out;
}

// Best effort: the stylesheets (relative to the repo) that define the css
// variables the tailwind config reads, fewest files first. [] when none.
function cssVarFiles(repoDir) {
  try {
    const wanted = configVars(repoDir);
    if (!wanted.size) return [];
    const defs = [];
    for (const file of styleFiles(repoDir)) {
      let text;
      try {
        if (fs.statSync(file).size > MAX_STYLE_BYTES) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      const has = new Set();
      for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) if (wanted.has(m[1])) has.add(m[1]);
      if (has.size) defs.push({ file, has });
    }
    const covered = new Set();
    const picked = [];
    while (picked.length < MAX_VAR_FILES) {
      let best = null;
      let gain = 0;
      for (const d of defs) {
        let g = 0;
        for (const v of d.has) if (!covered.has(v)) g++;
        if (g > gain) { best = d; gain = g; }
      }
      if (!best) break;
      for (const v of best.has) covered.add(v);
      picked.push(path.relative(repoDir, best.file));
    }
    return picked;
  } catch { return []; }
}

module.exports = { detect, colorFamilies, cssVarFiles };
