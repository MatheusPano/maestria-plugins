'use strict';
// The MCP tools Claude gets in a Maestria session (`design_*`). main.js wires
// `tool.call` to handle(); `ctx.host` is what the tools need from main.js
// (openCanvas, viewOf, focusBoard, lastFor), so tests can fake it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const canvasMod = require('./canvas');
const components = require('./components');
const project = require('./project');

const GUIDE = path.join(__dirname, 'guide.md');
const MAX_BOARDS = 4; // boards with images per design_render call
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // one image
const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // all images of one result
const MAX_SIZE = 4000;
const MAX_POS = 100000;
const NEED_CWD = 'a sessão não informou a pasta de trabalho: passe `canvas` com o caminho completo';
const NEED_WHERE = 'diga onde criar o canvas (ex.: ~/Desktop/Work/Ninepay/design/<nome>)';
const NEED_NAME = 'diga o nome do canvas (name) ou a pasta (canvas)';
const NO_CANVAS = 'nenhum canvas aberto: chame design_open antes';

const CANVAS = { type: 'string', description: 'Canvas folder (absolute, ~/ or relative to the session cwd). Omit to use the canvas last opened in this session.' };
const NAME = { type: 'string', description: 'Board name: lowercase letters, digits, - and _ (becomes boards/<name>.html).' };

const SCHEMAS = [
  {
    name: 'design_open',
    description: 'Open (or create) a design canvas beside this session and get the folder layout, board list and the writing guide. Call it first, once per session. Pass `canvas` for an existing/explicit folder, or `name` to create <company>/design/<name> next to the repo.',
    inputSchema: {
      type: 'object',
      properties: { canvas: CANVAS, name: { type: 'string', description: 'New canvas name when no folder is given: lowercase letters, digits, - and _.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'design_board',
    description: 'Create or update a board entry (size and position) and get its .html path. Then write the HTML with Write/Edit (this tool never writes content) and call design_render. Same name again updates the entry.',
    inputSchema: {
      type: 'object',
      properties: {
        name: NAME,
        w: { type: 'number', description: 'Width in CSS px (desktop 1440, mobile 390).' },
        h: { type: 'number', description: 'Height in CSS px. Omit to follow the content.' },
        x: { type: 'number', description: 'Canvas x. Omit for a free spot.' },
        y: { type: 'number', description: 'Canvas y. Omit for a free spot.' },
        title: { type: 'string', description: 'Label shown on the canvas.' },
        canvas: CANVAS,
      },
      required: ['name', 'w'],
      additionalProperties: false,
    },
  },
  {
    name: 'design_render',
    description: 'Render boards now and return their light/dark PNGs plus errors. Call it after every round of Write/Edit and look at both themes before telling the user a board is done. Max 4 boards (8 images) per call; omit `boards` for all.',
    inputSchema: {
      type: 'object',
      properties: {
        boards: { type: 'array', items: { type: 'string' }, description: 'Board names. Omit for every board.' },
        theme: { type: 'string', enum: ['light', 'dark', 'both'], description: 'Which images to return. Default both.' },
        canvas: CANVAS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'design_focus',
    description: 'Scroll and zoom the user\'s canvas to a board.',
    inputSchema: { type: 'object', properties: { board: NAME, canvas: CANVAS }, required: ['board'], additionalProperties: false },
  },
  {
    name: 'design_list',
    description: 'List boards (path, size, components used) and components (path, boards that use them) of a canvas.',
    inputSchema: { type: 'object', properties: { canvas: CANVAS }, additionalProperties: false },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });
const errText = (e) => String((e && e.message) || e);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function resolveFrom(args, ctx) {
  const { cwd, home } = ctx;
  if (args.canvas && !cwd && !/^(\/|~\/)/.test(String(args.canvas).trim())) throw new Error(NEED_CWD);
  if (args.canvas) return canvasMod.resolveDir(args.canvas, { cwd, home });
  const known = ctx.host.lastFor({ tabId: ctx.tabId, cwd });
  if (!known) throw new Error(NO_CANVAS);
  return known;
}

// The open view of `dir` (opening it beside the session when needed).
async function viewFor(dir, ctx) {
  const V = ctx.host.viewOf(dir) || await ctx.host.openCanvas(dir, { tabId: ctx.tabId, cwd: ctx.cwd });
  if (!V) throw new Error('o canvas não abriu (este maestria não tem o canvas do design)');
  return V;
}

function boardList(canvas, dir) {
  return canvas.order.map((n) => {
    const b = canvas.boards[n];
    return `- ${n}: ${b.w}${b.h ? `×${b.h}` : ' (altura pelo conteúdo)'} px, ${path.join(dir, 'boards', `${n}.html`)}`;
  });
}

function usesOf(dir, canvas, comps) {
  const uses = new Map();
  for (const n of canvas.order) {
    let src = '';
    try { src = fs.readFileSync(path.join(dir, 'boards', `${n}.html`), 'utf8'); } catch { /* not written yet */ }
    uses.set(n, components.expand(src, comps).uses);
  }
  return uses;
}

async function open(args, ctx) {
  const home = ctx.home || os.homedir();
  let dir;
  let repo = null;
  try {
    if (args.canvas && !ctx.cwd && !/^(\/|~\/)/.test(String(args.canvas).trim())) return fail(NEED_CWD);
    if (!args.canvas && !ctx.cwd && !ctx.host.lastFor({ tabId: ctx.tabId, cwd: ctx.cwd })) return fail(NEED_CWD);
    if (args.canvas) dir = canvasMod.resolveDir(args.canvas, { cwd: ctx.cwd, home });
    else {
      const known = !args.name && ctx.host.lastFor({ tabId: ctx.tabId, cwd: ctx.cwd });
      if (known) dir = known;
      else {
        if (!canvasMod.defaultDir({ cwd: ctx.cwd, name: args.name || 'x', home })) return fail(NEED_WHERE);
        if (!args.name) return fail(NEED_NAME);
        dir = canvasMod.defaultDir({ cwd: ctx.cwd, name: args.name, home });
      }
    }
    if (!ctx.cwd && !fs.existsSync(path.join(dir, 'design.json'))) return fail(NEED_CWD);
    repo = ctx.cwd ? canvasMod.gitRoot(ctx.cwd) : null;
    canvasMod.init(dir, { repo });
  } catch (e) { return fail(errText(e)); }
  let V;
  try { V = await ctx.host.openCanvas(dir, { tabId: ctx.tabId, cwd: ctx.cwd }); } catch (e) { return fail(errText(e)); }
  let canvas;
  try { canvas = canvasMod.read(dir); } catch (e) { return fail(errText(e)); }
  let designRepo = repo;
  try { designRepo = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8')).repo || repo; } catch { /* keep */ }
  const families = project.colorFamilies(path.resolve(dir, designRepo));
  const lines = [
    `canvas: ${dir}`,
    `repo: ${designRepo}`,
    `boards (${canvas.order.length}):`,
    ...(canvas.order.length ? boardList(canvas, dir) : ['- nenhuma ainda: crie com design_board']),
    `cores do tailwind do projeto: ${families.length ? families.join(', ') : '(não consegui listar; leia o tailwind.config do repo)'}`,
  ];
  if (V && V.failed) lines.push(`aviso: o motor não abriu (${V.ui && V.ui.message}); design_render vai falhar até corrigir`);
  for (const w of canvas.warnings || []) lines.push(`aviso: ${w}`);
  lines.push('', fs.readFileSync(GUIDE, 'utf8'));
  return text(lines.join('\n'));
}

async function board(args, ctx) {
  const dir = resolveFrom(args, ctx);
  if (!canvasMod.validName(args.name)) return fail(`nome de board inválido: "${args.name}"`);
  const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!num(args.w, 1, MAX_SIZE)) return fail(`w precisa ser um número entre 1 e ${MAX_SIZE}`);
  if (args.h != null && !num(args.h, 1, MAX_SIZE)) return fail(`h precisa ser um número entre 1 e ${MAX_SIZE}`);
  for (const k of ['x', 'y']) if (args[k] != null && !num(args[k], -MAX_POS, MAX_POS)) return fail(`${k} precisa ser um número entre -${MAX_POS} e ${MAX_POS}`);
  if (args.title != null && (typeof args.title !== 'string' || args.title.length > 120)) return fail('title precisa ser texto de até 120 caracteres');
  const { canvas: next } = canvasMod.upsertBoard(canvasMod.read(dir), {
    name: args.name, w: args.w, h: args.h, x: args.x, y: args.y, title: args.title,
  });
  canvasMod.write(dir, next);
  const file = path.join(dir, 'boards', `${args.name}.html`);
  return text(`${file}\nescreva o HTML com Write/Edit; depois chame design_render`);
}

async function render(args, ctx) {
  const dir = resolveFrom(args, ctx);
  const canvas = canvasMod.read(dir);
  const names = Array.isArray(args.boards) && args.boards.length ? args.boards : canvas.order;
  for (const n of names) if (!has(canvas.boards, n)) return fail(`prancheta não existe: ${n}`);
  const theme = args.theme == null ? 'both' : args.theme;
  if (!['light', 'dark', 'both'].includes(theme)) return fail('theme deve ser light, dark ou both');
  const V = await viewFor(dir, ctx);
  if (!V.engine) return fail(`o canvas não abriu: ${(V.ui && V.ui.message) || 'motor parado'}`);
  if (V.engine.loadCanvas) V.engine.loadCanvas(true); // a board registered moments ago is not in the engine yet
  const shown = names.slice(0, MAX_BOARDS);
  const rest = names.slice(MAX_BOARDS);
  // the canvas keeps 2x pngs; Claude gets captures with the longest side ≤ 1568 px
  const results = await V.engine.render(shown, { forClaude: true });
  const content = [];
  const lines = [];
  let budget = MAX_TOTAL_BYTES;
  for (const n of shown) {
    const s = results.get(n);
    if (!s) { lines.push(`${n}: sem arquivo — escreva ${path.join(dir, 'boards', `${n}.html`)} e chame de novo`); continue; }
    const size = s.width && s.height ? `${s.width}×${s.height} px, ` : '';
    lines.push(`${n}: ${size}${s.ms} ms${s.cut ? ', cortada (a página passa do limite de altura da imagem)' : ''}${s.error ? `, ERRO: ${s.error}` : ''}`);
    if (s.error) continue;
    for (const t of theme === 'both' ? ['light', 'dark'] : [theme]) {
      if (!s[t]) continue;
      const label = `${n} (${t === 'light' ? 'claro' : 'escuro'})`;
      const file = s.claude && s.claude[t];
      if (!file) { lines.push(`${label}: imagem omitida (a prancheta mudou durante o render); chame design_render de novo`); continue; }
      const buf = fs.readFileSync(file);
      if (buf.length > MAX_IMAGE_BYTES || buf.length > budget) {
        lines.push(`${label}: imagem omitida (${(buf.length / 1048576).toFixed(1)} MB, grande demais pra devolver); reduza a prancheta ou veja no canvas`);
        continue;
      }
      budget -= buf.length;
      content.push({ type: 'text', text: label });
      content.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });
    }
  }
  if (rest.length) lines.push(`não renderizadas (máx. ${MAX_BOARDS} por chamada): ${rest.join(', ')}`);
  return { content: [{ type: 'text', text: lines.join('\n') }, ...content] };
}

async function focus(args, ctx) {
  const dir = resolveFrom(args, ctx);
  const canvas = canvasMod.read(dir);
  if (!has(canvas.boards, args.board)) return fail(`prancheta não existe: ${args.board}`);
  const V = await viewFor(dir, ctx);
  if (V.engine && V.engine.loadCanvas) V.engine.loadCanvas(true); // sync 'canvas' event refreshes the view's board list
  await ctx.host.focusBoard(dir, args.board);
  return text(`focado: ${args.board}`);
}

async function list(args, ctx) {
  const dir = resolveFrom(args, ctx);
  const canvas = canvasMod.read(dir);
  const comps = components.load(dir);
  const uses = usesOf(dir, canvas, comps);
  const lines = [`canvas: ${dir}`, `boards (${canvas.order.length}):`];
  for (const n of canvas.order) {
    const b = canvas.boards[n];
    const used = [...uses.get(n)];
    lines.push(`- ${n}: ${b.w}${b.h ? `×${b.h}` : ''} px, ${path.join(dir, 'boards', `${n}.html`)}${used.length ? `, usa: ${used.join(', ')}` : ''}`);
  }
  lines.push(`components (${comps.size}):`);
  for (const name of comps.keys()) {
    const deps = [...components.dependents(uses, name)];
    lines.push(`- ${name}: ${path.join(dir, 'components', `${name}.html`)}${deps.length ? `, usado em: ${deps.join(', ')}` : ', sem uso'}`);
  }
  for (const e of comps.errors) lines.push(`aviso: ${e}`);
  return text(lines.join('\n'));
}

const HANDLERS = { design_open: open, design_board: board, design_render: render, design_focus: focus, design_list: list };

async function handle(name, args, ctx) {
  const fn = HANDLERS[name];
  if (!fn) return fail(`ferramenta desconhecida: ${name}`);
  try { return await fn(args || {}, ctx); } catch (e) { return fail(errText(e)); }
}

module.exports = { SCHEMAS, handle };
