// Os avatares da lista: um contêiner de navio em isométrico pra cada
// container e uma pilha deles pra cada projeto do compose, na cor da imagem
// (ou do projeto) — ou na que você escolheu no botão direito. SVG inteiro,
// com as cores dele: a Maestria desenha sem pintar por cima.

'use strict';

// As cores que dá pra escolher, na ordem do submenu.
const PALETTE = [
  ['blue', 'Azul'],
  ['cyan', 'Ciano'],
  ['accent', 'Verde-água'],
  ['green', 'Verde'],
  ['yellow', 'Amarelo'],
  ['orange', 'Laranja'],
  ['red', 'Vermelho'],
  ['magenta', 'Rosa'],
  ['purple', 'Roxo'],
  ['gray', 'Cinza'],
];
const HEX = {
  blue: '#4C7DFF', cyan: '#22B5D3', accent: '#14B8A6', green: '#34C26B', yellow: '#F2B233',
  orange: '#F2762E', red: '#EF5A52', magenta: '#E0559B', purple: '#8B5CF6', gray: '#8A94A6', faint: '#8A94A6',
};
function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function shade(hex, t) {
  const [r, g, b] = rgb(hex); const to = t > 0 ? 255 : 0; const k = Math.abs(t);
  const mix = (c) => Math.round(c + (to - c) * k);
  return '#' + [mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('');
}
const f = (n) => Number(n.toFixed(2));

/**
 * Um contêiner de navio em isométrico, com o canto de cima-trás em (x, y):
 * `len` ao longo da face comprida (a das nervuras), `dep` na face curta (a
 * porta), `h` de altura.
 */
function box(x, y, len, dep, h, base) {
  const ux = 0.866, uy = -0.5; // a face comprida sobe pra direita
  const vx = 0.866, vy = 0.5; // a curta desce pra direita
  const A = [x, y]; // canto esquerdo do topo
  const B = [x + ux * len, y + uy * len];
  const C = [B[0] + vx * dep, B[1] + vy * dep];
  const D = [x + vx * dep, y + vy * dep];
  const p = (...pts) => pts.map(([a, b]) => `${f(a)},${f(b)}`).join(' ');
  const down = ([a, b]) => [a, b + h];
  const top = shade(base, 0.38), front = base, side = shade(base, -0.3), rib = shade(base, -0.22), dark = shade(base, -0.5);
  let out = '';
  // a face curta (a porta), à esquerda
  out += `<polygon points="${p(A, D, down(D), down(A))}" fill="${side}"/>`;
  // a comprida, à direita, com as nervuras
  out += `<polygon points="${p(D, C, down(C), down(D))}" fill="${front}"/>`;
  const ribs = Math.max(3, Math.round(len / 2.4));
  for (let i = 1; i < ribs; i++) {
    const t = i / ribs;
    const a = [D[0] + (C[0] - D[0]) * t, D[1] + (C[1] - D[1]) * t];
    out += `<line x1="${f(a[0])}" y1="${f(a[1] + 0.9)}" x2="${f(a[0])}" y2="${f(a[1] + h - 0.9)}" stroke="${rib}" stroke-width="0.85"/>`;
  }
  // as duas folhas da porta e as trancas
  for (const t of [0.34, 0.66]) {
    const a = [A[0] + (D[0] - A[0]) * t, A[1] + (D[1] - A[1]) * t];
    out += `<line x1="${f(a[0])}" y1="${f(a[1] + 0.9)}" x2="${f(a[0])}" y2="${f(a[1] + h - 0.9)}" stroke="${dark}" stroke-width="0.7" stroke-opacity="0.7"/>`;
  }
  out += `<polygon points="${p(A, B, C, D)}" fill="${top}"/>`;
  // o brilho da aresta de cima
  out += `<polyline points="${p(A, D, C)}" fill="none" stroke="${shade(base, 0.62)}" stroke-width="0.6" stroke-linejoin="round"/>`;
  return out;
}

/** O container: um contêiner só. */
function container(tone) {
  const base = HEX[tone] || HEX.blue;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' + box(2.6, 14.4, 19, 9.5, 9, base) + '</svg>';
}

/**
 * O projeto: uma pilha de contêineres -- dois no chão, um atrás do outro, e
 * um em cima do de trás. Desenhados de trás pra frente.
 */
function stack(tone) {
  const base = HEX[tone] || HEX.purple;
  const len = 13, dep = 6.5, h = 6.3, x = 4.2, y = 17.4;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    box(x, y, len, dep, h, shade(base, -0.14)) +
    box(x, y - h, len, dep, h, shade(base, 0.06)) +
    box(x + 0.866 * dep, y + 0.5 * dep, len, dep, h, base) +
    '</svg>';
}
module.exports = { HEX, PALETTE, container, stack, shade };
