// As linhas de log como a janela desenha: em pedaços coloridos (`spans`). As
// cores que o programa mandou em ANSI viram as do tema; numa linha sem cor
// nenhuma, a hora do começo fica apagada e o nível (ERROR, WARN, INFO) ganha
// a cor dele — o que o OrbStack faz com um log comum.

'use strict';

// Os 8 de base e os 8 claros, nos tons que a janela conhece.
const BASE = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/** Uma cor dos 256 do xterm, como hex (as 16 primeiras pelo nome). */
function color256(n) {
  if (n < 16) return BASE[n % 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return hex(v, v, v);
  }
  const i = n - 16;
  const step = (x) => (x === 0 ? 0 : 55 + x * 40);
  return hex(step(Math.floor(i / 36)), step(Math.floor(i / 6) % 6), step(i % 6));
}

function hex(r, g, b) {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
}

/**
 * Os pedaços de uma linha com códigos SGR (`\x1b[31m`), ou null quando ela
 * não tem nenhum. Os outros códigos (cursor, limpar a tela) somem.
 */
function ansiSpans(text) {
  // eslint-disable-next-line no-control-regex
  if (!/\x1b\[[0-9;]*m/.test(text)) return null;
  const spans = [];
  let tone;
  let bold = false;
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)([A-Za-z])|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]/g;
  let last = 0;
  let m;
  const push = (s) => {
    if (!s) return;
    const prev = spans[spans.length - 1];
    if (prev && prev.tone === tone && !!prev.bold === bold) prev.text += s;
    else spans.push(bold ? { text: s, tone, bold } : { text: s, tone });
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== 'm') continue;
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        tone = undefined;
        bold = false;
      } else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) tone = undefined;
      else if (c >= 30 && c <= 37) tone = BASE[c - 30];
      else if (c >= 90 && c <= 97) tone = BASE[c - 90];
      else if (c === 38 && codes[i + 1] === 5) {
        tone = color256(codes[i + 2] || 0);
        i += 2;
      } else if (c === 38 && codes[i + 1] === 2) {
        tone = hex(codes[i + 2] || 0, codes[i + 3] || 0, codes[i + 4] || 0);
        i += 4;
      }
      // fundo (40–47, 100–107, 48;…) fica de fora: numa linha de log ele só atrapalha.
      else if (c === 48 && (codes[i + 1] === 5 || codes[i + 1] === 2)) i += codes[i + 1] === 5 ? 2 : 4;
    }
  }
  push(text.slice(last));
  // Preto no fundo escuro some: vira apagado.
  for (const s of spans) if (s.tone === 'black') s.tone = 'faint';
  return spans;
}

const LEVELS = [
  [/\b(FATAL|PANIC|CRIT(?:ICAL)?|EMERG(?:ENCY)?|ALERT)\b/, 'red', true],
  [/\b(ERROR|ERR|EXCEPTION|FAIL(?:ED|URE)?)\b/i, 'red', true],
  [/\b(WARN(?:ING)?|DEPRECATED)\b/i, 'yellow', true],
  [/\b(INFO|NOTICE|LOG)\b/, 'blue', false],
  [/\b(DEBUG|TRACE|VERBOSE)\b/, 'faint', false],
];

// Uma hora no começo da linha: 2026-09-28T12:13:16.5Z, 2026-09-28 12:13:16,
// [12:13:16], 12:13:16.123.
const STAMP = /^(\[?\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?\]?|\[?\d\d:\d\d:\d\d(?:[.,]\d+)?\]?)\s/;

/**
 * Os pedaços de uma linha sem cor: a hora apagada, o primeiro nível com a cor
 * dele. Uma linha de ERROR fica vermelha inteira — o erro é o que se procura.
 */
function plainSpans(text) {
  const spans = [];
  let rest = text;
  const stamp = rest.match(STAMP);
  if (stamp) {
    spans.push({ text: stamp[0], tone: 'faint' });
    rest = rest.slice(stamp[0].length);
  }
  for (const [re, tone, whole] of LEVELS) {
    const m = rest.match(re);
    if (!m) continue;
    const before = rest.slice(0, m.index);
    const after = rest.slice(m.index + m[0].length);
    if (before) spans.push({ text: before, tone: whole ? tone : undefined });
    spans.push({ text: m[0], tone, bold: true });
    if (after) spans.push({ text: after, tone: whole ? tone : undefined });
    return spans;
  }
  spans.push({ text: rest });
  return spans;
}

/** Os pedaços de uma linha qualquer: as cores dela, ou as que a gente dá. */
function spansOf(text) {
  return ansiSpans(text) || plainSpans(text);
}

/** "2026-09-28T12:13:16.500893001Z resto" (o --timestamps do docker) → { at, rest }. */
function splitStamp(line) {
  const m = String(line).match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/s);
  if (!m) return { at: '', rest: line };
  return { at: m[1], rest: m[2] };
}

/** A hora local curta de um --timestamps: "12:13:16". */
function clock(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Uma linha de log pronta pro console: `{ text, spans }`. */
function line(text, { prefix, prefixTone, time } = {}) {
  const spans = [];
  if (time) spans.push({ text: `${time} `, tone: 'faint' });
  if (prefix !== undefined) {
    spans.push({ text: prefix, tone: prefixTone, bold: true });
    spans.push({ text: ' │ ', tone: 'faint' });
  }
  spans.push(...spansOf(text));
  return { text: spans.map((s) => s.text).join(''), spans };
}

module.exports = { ansiSpans, plainSpans, spansOf, splitStamp, clock, line };
