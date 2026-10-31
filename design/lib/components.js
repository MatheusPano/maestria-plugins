'use strict';
// Reusable components for boards: <canvas>/components/<Name>.html used as
// <x-kebab-name param="v">children</x-kebab-name> (or self-closing).
const fs = require('node:fs');
const path = require('node:path');

const NAME_RE = /^[A-Z][A-Za-z0-9]{0,63}$/;
const MAX_DEPTH = 10;
const SLOTS = ['<slot></slot>', '<slot/>', '<slot />'];

const kebab = (name) => name.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase());
const pascal = (tag) => tag.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// load(dir): dir is the canvas folder. Returns Map<Name, html>; files with an
// invalid name are skipped and listed in the `errors` property of the Map.
function load(dir) {
  const map = new Map();
  map.errors = [];
  let files;
  try { files = fs.readdirSync(path.join(dir, 'components')); } catch { return map; }
  for (const f of files.sort()) {
    if (!f.endsWith('.html')) continue;
    const name = f.slice(0, -5);
    if (!NAME_RE.test(name)) { map.errors.push(`nome de componente inválido: ${f}`); continue; }
    try { map.set(name, fs.readFileSync(path.join(dir, 'components', f), 'utf8')); }
    catch (e) { map.errors.push(`${f}: ${e.message}`); }
  }
  return map;
}

// Reads an opening tag starting at html[i] === '<' ("<x-name ...>"). Returns
// { tag, attrs, end, selfClosing } or null if malformed. Attribute values may
// be "double" or 'single' quoted, or unquoted. An attribute without a value
// (`<x-nav-item active>`) is given the string "true" so `{{active}}` is usable.
function readOpen(html, i) {
  let j = i + 1;
  while (j < html.length && /[A-Za-z0-9-]/.test(html[j])) j++;
  const tag = html.slice(i + 1, j);
  const attrs = {};
  for (;;) {
    while (j < html.length && /\s/.test(html[j])) j++;
    if (j >= html.length) return null;
    if (html[j] === '>') return { tag, attrs, end: j + 1, selfClosing: false };
    if (html[j] === '/' && html[j + 1] === '>') return { tag, attrs, end: j + 2, selfClosing: true };
    if (html[j] === '/') { j++; continue; }
    let k = j;
    while (k < html.length && !/[\s=>/]/.test(html[k])) k++;
    const key = html.slice(j, k);
    if (!key) return null;
    j = k;
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] !== '=') { attrs[key] = 'true'; continue; }
    j++;
    while (j < html.length && /\s/.test(html[j])) j++;
    const q = html[j];
    if (q === '"' || q === "'") {
      const e = html.indexOf(q, j + 1);
      if (e < 0) return null;
      attrs[key] = html.slice(j + 1, e);
      j = e + 1;
    } else {
      k = j;
      while (k < html.length && !/[\s>]/.test(html[k])) k++;
      attrs[key] = html.slice(j, k);
      j = k;
    }
  }
}

// Finds the matching </tag> for an open tag ending at `from`, counting nested
// same-name tags. Returns { start, end } of the close tag or null.
function findClose(html, tag, from) {
  const open = '<' + tag;
  const close = '</' + tag;
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const next = html.indexOf('<', i);
    if (next < 0) return null;
    if (html.startsWith(close, next) && /[\s>]/.test(html[next + close.length] || '')) {
      const gt = html.indexOf('>', next);
      if (gt < 0) return null;
      if (--depth === 0) return { start: next, end: gt + 1 };
      i = gt + 1;
    } else if (html.startsWith(open, next) && /[\s/>]/.test(html[next + open.length] || '')) {
      const o = readOpen(html, next);
      if (!o) return null;
      if (!o.selfClosing) depth++;
      i = o.end;
    } else i = next + 1;
  }
  return null;
}

function substitute(tpl, params) {
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    if (tpl.startsWith('{{{', i)) {
      const e = tpl.indexOf('}}}', i + 3);
      if (e >= 0) {
        const k = tpl.slice(i + 3, e).trim();
        out += Object.prototype.hasOwnProperty.call(params, k) ? params[k] : '';
        i = e + 3;
        continue;
      }
    } else if (tpl.startsWith('{{', i)) {
      const e = tpl.indexOf('}}', i + 2);
      if (e >= 0) {
        const k = tpl.slice(i + 2, e).trim();
        out += Object.prototype.hasOwnProperty.call(params, k) ? esc(params[k]) : '';
        i = e + 2;
        continue;
      }
    }
    out += tpl[i++];
  }
  return out;
}

function expand(html, comps) {
  const uses = new Set();
  const errors = [];
  const byTag = new Map();
  for (const name of comps.keys()) byTag.set('x-' + kebab(name), name);
  const err = (m) => { if (!errors.includes(m)) errors.push(m); };

  function run(src, stack) {
    let out = '';
    let i = 0;
    while (i < src.length) {
      const lt = src.indexOf('<x-', i);
      if (lt < 0) { out += src.slice(i); break; }
      out += src.slice(i, lt);
      const o = readOpen(src, lt);
      if (!o) { out += src.slice(lt, lt + 3); i = lt + 3; continue; }
      let children = '';
      let end = o.end;
      if (!o.selfClosing) {
        const c = findClose(src, o.tag, o.end);
        if (c) { children = src.slice(o.end, c.start); end = c.end; }
      }
      i = end;
      const name = byTag.get(o.tag);
      if (!name) {
        err(`componente não existe: ${pascal(o.tag.slice(2))}`);
        out += run(children, stack);
        continue;
      }
      uses.add(name);
      if (stack.includes(name) || stack.length >= MAX_DEPTH) {
        err(`componente em ciclo: ${[...stack, name].join(' → ')}`);
        continue;
      }
      const inner = run(children, stack);
      let body = substitute(comps.get(name), o.attrs);
      for (const s of SLOTS) body = body.split(s).join(inner);
      out += run(body, [...stack, name]);
    }
    return out;
  }

  return { html: run(html, []), uses, errors };
}

function dependents(boards, changed) {
  const out = new Set();
  for (const [board, used] of boards) if (used.has(changed)) out.add(board);
  return out;
}

module.exports = { load, expand, dependents, NAME_RE };
