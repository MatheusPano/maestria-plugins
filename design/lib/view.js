'use strict';
// Builds the `data` of the canvas view (ui/canvas.rfwtxt) from the canvas
// index, the engine's board states and the view's own ui state. Pure, except
// for the Sprite fallback helpers at the bottom, which copy PNGs into the
// plugin dir (old Maestria builds draw files only from there).
const fs = require('node:fs');
const path = require('node:path');

const STRIP = 28; // name strip above the images
const GAP = 24; // between the light and the dark image
const MARGIN = 80; // around the whole canvas
const DEFAULT_H = 800; // a board not rendered yet and without `h`
const ERROR_H = 40; // the error line under the images
const EMPTY = { w: 1200, h: 800 };
const THEMES = ['both', 'light', 'dark'];
const THEME_LABEL = { both: 'ambos', light: '☀', dark: '☾' };

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const num = (n) => typeof n === 'number' && Number.isFinite(n);

function getter(states) {
  if (!states) return () => null;
  if (states instanceof Map) return (n) => states.get(n) || null;
  return (n) => (has(states, n) ? states[n] : null);
}

function picturePath(hash, name, theme) { return `${hash}/png/${name}.${theme}.png`; }
function spritePath(hash, name, theme, rev) { return `cache/${hash}/${name}.${theme}.${rev}.png`; }

// Theme "both" makes every box wider than its `w` in canvas.json (and a
// measured height may differ from `h`). Push each board right by the extra
// width of the boards to its left in the same row band (and down by the extra
// height of the boards above it in the same column band), so nothing overlaps
// that did not overlap in canvas.json.
function shift(items, pos, size, extra, crossPos, crossSize) {
  return items.map((it) => {
    let d = 0;
    for (const o of items) {
      if (o === it) continue;
      const before = pos(o) + size(o) <= pos(it);
      const band = crossPos(o) < crossPos(it) + crossSize(it) && crossPos(it) < crossPos(o) + crossSize(o);
      if (before && band) d += Math.max(0, extra(o));
    }
    return pos(it) + d;
  });
}

function build({ canvas, states, ui = {}, caps = {}, hash = '' }) {
  const get = getter(states);
  const theme = THEMES.includes(ui.theme) ? ui.theme : 'both';
  const both = theme === 'both';
  const picture = Number(caps.picture) >= 1;
  const zoomFocus = Number(caps.zoomFocus) >= 1;
  const boards = (canvas && canvas.boards) || {};
  const names = ((canvas && canvas.order) || []).filter((n) => has(boards, n));

  const items = names.map((name) => {
    const b = boards[name];
    const s = get(name);
    const imgW = s && num(s.width) && s.width > 0 ? s.width : b.w;
    const imgH = s && num(s.height) && s.height > 0 ? s.height : (num(b.h) ? b.h : DEFAULT_H);
    const error = s && s.error ? String(s.error) : '';
    const boxW = both ? 2 * imgW + GAP : imgW;
    const boxH = STRIP + imgH + (error ? ERROR_H : 0);
    return { name, b, s, imgW, imgH, error, boxW, boxH, H: num(b.h) ? b.h : DEFAULT_H };
  });

  const xs = shift(items, (o) => o.b.x, (o) => o.b.w, (o) => o.boxW - o.b.w, (o) => o.b.y, (o) => o.H);
  const ys = shift(items, (o) => o.b.y, (o) => o.H, (o) => o.boxH - o.H, (o) => o.b.x, (o) => o.b.w);

  let size = { ...EMPTY };
  let minX = 0;
  let minY = 0;
  if (items.length) {
    minX = Math.min(...xs);
    minY = Math.min(...ys);
    const maxX = Math.max(...items.map((it, i) => xs[i] + it.boxW));
    const maxY = Math.max(...items.map((it, i) => ys[i] + it.boxH));
    size = { w: maxX - minX + 2 * MARGIN, h: maxY - minY + 2 * MARGIN };
  }

  const image = (it, t) => {
    if (!it.s || !it.s[t]) return '';
    return picture ? picturePath(hash, it.name, t) : spritePath(hash, it.name, t, it.s.rev || 0);
  };

  const out = items.map((it, i) => ({
    name: it.name,
    title: typeof it.b.title === 'string' && it.b.title ? it.b.title : it.name,
    left: xs[i] - minX + MARGIN,
    top: ys[i] - minY + MARGIN,
    width: it.boxW,
    height: it.boxH,
    imageWidth: it.imgW,
    imageHeight: it.imgH,
    light: theme === 'dark' ? '' : image(it, 'light'),
    dark: theme === 'light' ? '' : image(it, 'dark'),
    showLight: theme !== 'dark',
    showDark: theme !== 'light',
    gap: both,
    error: it.error,
    cut: !!(it.s && it.s.cut),
    highlight: ui.highlight != null && ui.highlight === it.name,
    rev: (it.s && it.s.rev) || 0,
    focus: `focus:${it.name}`,
  }));

  const zoom = { command: '', focus: { x: 0, y: 0, w: 1, h: 1 }, rev: num(ui.rev) ? ui.rev : 0 };
  const cmd = ui.command;
  if (cmd && ['in', 'out', 'fit'].includes(cmd.kind)) zoom.command = cmd.kind;
  else if (cmd && cmd.kind === 'focus') {
    let rect = null;
    if (cmd.rect) rect = cmd.rect;
    else {
      const b = out.find((x) => x.name === cmd.board);
      if (b) rect = { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    if (rect && zoomFocus) {
      const clamp = (v) => Math.min(1, Math.max(0, v));
      const x = clamp(rect.x / size.w);
      const y = clamp(rect.y / size.h);
      zoom.command = 'focus';
      zoom.focus = { x, y, w: Math.min(1 - x, clamp(rect.w / size.w)), h: Math.min(1 - y, clamp(rect.h / size.h)) };
    } else zoom.command = 'fit';
  }

  const scale = num(ui.scale) && ui.scale > 0 ? ui.scale : 1;
  return {
    title: (canvas && canvas.title) || '',
    zoomLabel: `${Math.round(scale * 100)}%`,
    theme,
    themeLabel: THEME_LABEL[theme],
    themeMenu: [
      { action: 'tema:light', label: '☀ claro' },
      { action: 'tema:dark', label: '☾ escuro' },
      { action: 'tema:both', label: 'ambos lado a lado' },
    ],
    follow: !!ui.follow,
    boards: out,
    list: out.map((b) => ({ name: b.name, title: b.title })),
    listMenu: out.map((b) => ({ action: b.focus, label: b.title })),
    hasBoards: out.length > 0,
    warnings: ((canvas && canvas.warnings) || []).map(String),
    hasWarnings: !!(canvas && canvas.warnings && canvas.warnings.length),
    message: ui.message ? String(ui.message) : '',
    zoom,
    size,
    picture,
  };
}

// rfw reads sizes and positions as doubles only, and JSON says `80`, not
// `80.0`: nudge every whole number off the integer (down, so a fraction of 1
// stays within 0..1). `rev` keys stay ints (commandRev takes either).
const NUDGE = 1e-9;
function wire(v, key) {
  if (typeof v === 'number') {
    if (key === 'rev' || !Number.isInteger(v)) return v;
    return v > 0 ? v - NUDGE : v + NUDGE;
  }
  if (Array.isArray(v)) return v.map((x) => wire(x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = wire(x, k);
    return out;
  }
  return v;
}

// ---- Sprite fallback: copies under <pluginDir>/cache/<hash>/ ---------------

function cacheSprites({ pluginDir, hash, states }) {
  const dir = path.join(pluginDir, 'cache', hash);
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set();
  const entries = states instanceof Map ? [...states.entries()] : Object.entries(states || {});
  for (const [name, s] of entries) {
    if (!s) continue;
    for (const t of ['light', 'dark']) {
      if (!s[t]) continue;
      const rel = spritePath(hash, name, t, s.rev || 0);
      const to = path.join(pluginDir, rel);
      keep.add(path.basename(to));
      if (fs.existsSync(to)) continue;
      try { fs.copyFileSync(s[t], to); } catch { /* the png went away: next render brings it */ }
    }
  }
  for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
}

function clearSprites({ pluginDir, hash }) {
  fs.rmSync(path.join(pluginDir, 'cache', hash), { recursive: true, force: true });
}

module.exports = { build, wire, cacheSprites, clearSprites, picturePath, STRIP, GAP, MARGIN };
