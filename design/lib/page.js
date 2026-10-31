'use strict';
// Page assembly shared by the engine and the bench: what a board looks like to
// Tailwind (expanded page) and to Chrome (render copy), and how the project's
// Tailwind is started for a canvas.
const path = require('node:path');
const project = require('./project');
const tailwind = require('./tailwind');

// <!doctype html> + built css link + brand css + design.head + expanded board.
// `version` (css mtime) is appended to the css url in render copies so Chrome
// never serves a stale stylesheet; the expanded page (scanned by Tailwind) has none.
function buildPage({ outCss, brandCss = '', head = '', body, version }) {
  const href = `file://${outCss}${version != null ? `?v=${version}` : ''}`;
  const brand = brandCss ? `<style>${brandCss}</style>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${href}">`
    + `${brand}${head || ''}</head><body style="margin:0">${body}</body></html>`;
}

function startTailwind({ canvasDir, design, dataDir, outCss, log }) {
  const repoDir = path.resolve(canvasDir, design.repo);
  const detected = project.detect(repoDir);
  return tailwind.start({
    repoDir, config: detected.tailwind.config, input: detected.tailwind.input,
    extraCss: design.css || [], contentGlob: path.join(dataDir, 'expanded', '**/*.html'),
    outCss, log,
  });
}

// Chrome would render a half-written tag as text, so report it instead: a tag
// whose `>` (or closing quote) never arrives before the end of the markup.
function checkMarkup(html) {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return null;
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      if (e < 0) return 'comentário não fechado';
      i = e + 3;
      continue;
    }
    if (!/[A-Za-z/!]/.test(html[lt + 1] || '')) { i = lt + 1; continue; }
    let j = lt + 1;
    let quote = null;
    for (; j < html.length; j++) {
      const c = html[j];
      if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= html.length) return `tag não fechada perto de "${html.slice(lt, lt + 24).replace(/\s+/g, ' ')}…"`;
    const name = /^<([A-Za-z][A-Za-z0-9]*)/.exec(html.slice(lt, j + 1));
    i = j + 1;
    if (name && /^(script|style|textarea)$/i.test(name[1]) && !html.slice(lt, j).endsWith('/')) {
      const e = html.toLowerCase().indexOf(`</${name[1].toLowerCase()}`, i);
      if (e < 0) return `<${name[1]}> não fechado`;
      i = e;
    }
  }
  return null;
}

module.exports = { buildPage, startTailwind, checkMarkup };
