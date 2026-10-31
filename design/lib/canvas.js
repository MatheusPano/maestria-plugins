'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const project = require('./project');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GAP = 80;
const ROW_GAP = 120;
const ROW_WIDTH = 4000;
const DEFAULT_H = 800;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fin = (n) => typeof n === 'number' && Number.isFinite(n);

function validName(name) { return typeof name === 'string' && NAME_RE.test(name); }

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function read(dir) {
  const file = path.join(dir, 'canvas.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`${file} não é um json válido (${e.message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} precisa ser um objeto json`);
  if (raw.v !== 1) throw new Error(`${file}: versão não suportada`);
  if (raw.boards != null && (typeof raw.boards !== 'object' || Array.isArray(raw.boards))) {
    throw new Error(`${file}: "boards" precisa ser um objeto`);
  }
  const warnings = [];
  const boards = {};
  for (const [name, b] of Object.entries(raw.boards || {})) {
    if (!validName(name)) { warnings.push(`board "${name}" ignorado: nome inválido`); continue; }
    if (!b || typeof b !== 'object' || Array.isArray(b) || !fin(b.x) || !fin(b.y) || !fin(b.w)
      || (b.h != null && !fin(b.h))) {
      warnings.push(`board "${name}" ignorado: x, y e w precisam ser números`);
      continue;
    }
    boards[name] = b;
  }
  const order = (Array.isArray(raw.order) ? raw.order : []).filter((n) => typeof n === 'string' && has(boards, n));
  for (const n of Object.keys(boards)) if (!order.includes(n)) order.push(n);
  return { ...raw, title: typeof raw.title === 'string' ? raw.title : path.basename(dir), boards, order, warnings };
}

function write(dir, canvas) {
  const { warnings, ...rest } = canvas; // eslint-disable-line no-unused-vars
  writeAtomic(path.join(dir, 'canvas.json'), `${JSON.stringify(rest, null, 2)}\n`);
}

function freeSpot(canvas, w) {
  const lastName = canvas.order[canvas.order.length - 1];
  const last = lastName != null && has(canvas.boards, lastName) ? canvas.boards[lastName] : null;
  if (!last) return { x: 0, y: 0 };
  const x = last.x + last.w + GAP;
  if (x + w <= ROW_WIDTH) return { x, y: last.y };
  const bottom = Math.max(...canvas.order.map((n) => canvas.boards[n].y + (canvas.boards[n].h || DEFAULT_H)));
  return { x: 0, y: bottom + ROW_GAP };
}

function upsertBoard(canvas, { name, w, h, x, y, title }) {
  if (!validName(name)) throw new Error(`nome de board inválido: "${name}"`);
  const prev = has(canvas.boards, name) ? canvas.boards[name] : undefined;
  const spot = x == null && y == null && !prev ? freeSpot(canvas, w) : {};
  const board = { ...prev, x: x ?? prev?.x ?? spot.x ?? 0, y: y ?? prev?.y ?? spot.y ?? 0, w };
  if (h != null) board.h = h;
  if (title != null) board.title = title;
  const order = canvas.order.includes(name) ? canvas.order : [...canvas.order, name];
  return { canvas: { ...canvas, boards: { ...canvas.boards, [name]: board }, order }, board };
}

function underHome(p, home) {
  const rel = path.relative(home, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveDir(input, { cwd, home = os.homedir() } = {}) {
  const s = String(input || '').trim();
  if (!s || s === '~' || s === '/') throw new Error(`pasta inválida: "${s}"`);
  const expanded = s.startsWith('~/') ? path.join(home, s.slice(2)) : s;
  const abs = path.resolve(cwd || process.cwd(), expanded);
  if (!underHome(abs, home)) throw new Error('a pasta precisa ficar dentro da home');
  return abs;
}

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
  } catch { return cwd; }
}

function defaultDir({ cwd, name, home = os.homedir() }) {
  if (!validName(name)) {
    throw new Error(`nome de canvas inválido: "${name}" — use letras minúsculas, números, - e _`);
  }
  const parent = path.dirname(gitRoot(cwd));
  if (path.resolve(parent) === path.resolve(home) || !underHome(parent, home)) return null;
  return path.join(parent, 'design', name);
}

function readDarkMode(repo) {
  const fallback = { class: 'dark' };
  const names = ['js', 'cjs', 'mjs', 'ts'].map((e) => path.join(repo, `tailwind.config.${e}`));
  const file = names.find((f) => fs.existsSync(f));
  if (!file) return fallback;
  const src = fs.readFileSync(file, 'utf8');
  const arr = /darkMode:\s*\[\s*['"](?:class|selector)['"]\s*,\s*(['"`])(.+?)\1\s*\]/s.exec(src);
  if (arr) {
    const sel = arr[2];
    const attr = /^\[\s*([\w-]+)\s*=\s*["']?([^"'\]]+?)["']?\s*\]$/.exec(sel);
    if (attr) return { attr: attr[1], value: attr[2] };
    const cls = /^\.([\w-]+)$/.exec(sel);
    if (cls) return { class: cls[1] };
  }
  return fallback;
}

function init(dir, { repo }) {
  const file = path.join(dir, 'canvas.json');
  const created = !fs.existsSync(file);
  fs.mkdirSync(path.join(dir, 'boards'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'components'), { recursive: true });
  if (created) write(dir, { v: 1, title: path.basename(dir), boards: {}, order: [] });
  const designFile = path.join(dir, 'design.json');
  if (!fs.existsSync(designFile)) {
    project.detect(repo); // fails loudly when the repo has no tailwind
    writeAtomic(designFile, `${JSON.stringify({
      repo, darkMode: readDarkMode(repo), css: [], brand: null, head: '',
    }, null, 2)}\n`);
  }
  return { created };
}

module.exports = { read, write, upsertBoard, resolveDir, defaultDir, init, validName };
