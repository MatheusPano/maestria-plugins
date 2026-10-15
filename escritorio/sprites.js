// Os bonecos do escritório: pixel art escrita aqui, em texto, e as folhas de
// sprites (`sprites/*.png`) geradas a partir dela. Uma folha por roupa, todas
// com a mesma grade, que é o que o `Sprite` da Maestria anima:
//
//   linha 0  andando pra baixo     4 quadros
//   linha 1  andando pra cima      4
//   linha 2  andando pro lado      4 (a esquerda é a direita espelhada)
//   linha 3  digitando, de costas  4 (os braços dobrados, uma mão batendo de cada vez)
//   linha 4  lendo, de costas      4
//   linha 5  parado, de frente     4 (pisca no último)
//   linha 6  acenando              4 (o "precisa de você")
//   linha 7  sentado, de costas    4 (pensando: parado)
//   linha 8  comemorando           4 (os braços pra cima, pulando: o push)
//   linha 9  mão na cabeça         4 (o teste que quebrou)
//   linha 10 dormindo sentado      4 (no sofá, hibernado)
//   linha 11 cansado               4 (o contexto quase cheio: a gota de suor)
//   linha 12 espreguiçando         4 (depois do /compact)
//
// O bicho do escritório -- o gato ou o cachorro -- tem a folha dele
// (`sprites/gato.png`, `sprites/cachorro.png`), na mesma grade de 16×24:
//
//   linha 0  andando pra baixo · 1 pra cima · 2 pro lado · 3 sentado (o rabo
//   mexe) · 4 dormindo · 5 miando (ou latindo)
//
// Cada quadro tem 16×24. `node sprites.js` regera as folhas; o plugin também as
// gera sozinho quando alguma falta.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 16;
const H = 24;
const COLUMNS = 4;
const ROWS = 13;
const CAT_ROWS = 6; // o gato e o cachorro

const ROW = {
  down: 0,
  up: 1,
  side: 2,
  type: 3,
  read: 4,
  idle: 5,
  wave: 6,
  sit: 7,
  cheer: 8,
  facepalm: 9,
  sleep: 10,
  tired: 11,
  stretch: 12,
};

const CAT_ROW = { down: 0, up: 1, side: 2, sit: 3, sleep: 4, meow: 5 };

// --- as partes -----------------------------------------------------------------
//
// k contorno · h cabelo · s pele · S pele na sombra · e olho · c camisa ·
// C dobra da camisa · p calça · b sapato · . transparente

const HEAD_FRONT = [
  '................',
  '....kkkkkkkk....',
  '...khhhhhhhhk...',
  '..khhhhhhhhhhk..',
  '..khhhhhhhhhhk..',
  '..khhsssssshhk..',
  '..khsssssssshk..',
  '..kssessssessk..',
  '..kssessssessk..',
  '..kssssssssssk..',
  '...kSssssssSk...',
  '....kkkSSkkk....',
];

const HEAD_BLINK = [...HEAD_FRONT];
HEAD_BLINK[7] = '..kssssssssssk..';
HEAD_BLINK[8] = '..kseeesseeesk..';

// A boca aberta: a comemoração, e o bocejo (com os olhos fechados).
const HEAD_CHEER = [...HEAD_FRONT];
HEAD_CHEER[9] = '..kssssmmssssk..';
const HEAD_YAWN = [...HEAD_BLINK];
HEAD_YAWN[9] = '..kssssmmssssk..';

// Cansado: a pálpebra caída em cima de cada olho.
const HEAD_TIRED = [...HEAD_FRONT];
HEAD_TIRED[7] = '..kskksssskksk..';

const HEAD_BACK = [
  '................',
  '....kkkkkkkk....',
  '...khhhhhhhhk...',
  '..khhhhhhhhhhk..',
  '..khhhhhhhhhhk..',
  '..khhhhhhhhhhk..',
  '..khhhhhhhhhhk..',
  '..khhhhhhhhhhk..',
  '..kShhhhhhhhSk..',
  '..kShhhhhhhhSk..',
  '...khhhhhhhhk...',
  '....kkkSSkkk....',
];

const HEAD_SIDE = [
  '................',
  '....kkkkkkk.....',
  '...khhhhhhhk....',
  '..khhhhhhhhhk...',
  '..khhhhhhhhhhk..',
  '..khhhhsssssk...',
  '..khhhssssssk...',
  '..khhhsssssesk..',
  '..khhhsssssesk..',
  '..khhSssssssk...',
  '...khSsssssk....',
  '....kkkSSkk.....',
];

const TORSO_FRONT = [
  '...kcccccccck...',
  '..kcccccccccck..',
  '..kcCccccccCck..',
  '..kcCccccccCck..',
  '..kcCccccccCck..',
  '..ksCppppppCsk..',
];

const TORSO_BACK = [
  '...kcccccccck...',
  '..kcccccccccck..',
  '..kcCccccccCck..',
  '..kcCccccccCck..',
  '..kcCccccccCck..',
  '..kcCppppppCck..',
];

const TORSO_SIDE = [
  '....kcccccck....',
  '...kccccccck....',
  '...kcccCccck....',
  '...kcccCccck....',
  '...kcccCccck....',
  '...kpppsppppk...',
];

const LEGS_STAND = [
  '...kppppppppk...',
  '....kpppkpppk...',
  '....kpppkpppk...',
  '....kpppkpppk...',
  '....kbbbkbbbk...',
  '....kkkkkkkkk...',
];

const LEGS_STEP_A = [
  '...kppppppppk...',
  '....kpppkpppk...',
  '....kpppkpppk...',
  '....kpppkbbbk...',
  '....kbbbkkkkk...',
  '....kkkkk.......',
];

const LEGS_STEP_B = [
  '...kppppppppk...',
  '....kpppkpppk...',
  '....kpppkpppk...',
  '....kbbbkpppk...',
  '....kkkkkbbbk...',
  '........kkkkk...',
];

const LEGS_SIDE = [
  '....kppppppk....',
  '....kpppppk.....',
  '....kpppppk.....',
  '....kpppppk.....',
  '....kbbbbbbk....',
  '....kkkkkkkk....',
];

const LEGS_SIDE_STEP = [
  '....kppppppk....',
  '...kppppppppk...',
  '..kppk...kppk...',
  '..kppk...kppk...',
  '.kbbbk...kbbbk..',
  '.kkkkk...kkkkk..',
];

// Sentado de frente (no sofá): as coxas viradas pra quem olha, os pés embaixo.
const LEGS_SEATED = [
  '...kppppppppk...',
  '...kppppppppk...',
  '....kppkkppk....',
  '....kbbkkbbk....',
  '....kkk..kkk....',
  '................',
];

// Sentado, de costas: as pernas somem embaixo da mesa, e no lugar delas fica o
// encosto da cadeira (r, o tom da cadeira).
const SEAT = [
  '..krrrrrrrrrrk..',
  '..krrrrrrrrrrk..',
  '..krrrrrrrrrrk..',
  '...kkkkkkkkkk...',
  '....kr....rk....',
  '....kk....kk....',
];

// --- a montagem ----------------------------------------------------------------

/** Junta as partes de cima pra baixo num quadro de 16×24. */
function stack(...parts) {
  const rows = parts.flat();
  if (rows.length !== H) throw new Error(`quadro com ${rows.length} linhas`);
  for (const r of rows) if (r.length !== W) throw new Error(`linha com ${r.length} colunas: ${r}`);
  return rows;
}

/** Desce o quadro [n] pixels (o corpo que pula ao andar, o sentar). */
function shift(frame, n) {
  if (n === 0) return frame;
  const blank = '.'.repeat(W);
  return n > 0
    ? [...Array(n).fill(blank), ...frame.slice(0, H - n)]
    : [...frame.slice(-n), ...Array(-n).fill(blank)];
}

/** Um braço levantado do lado direito, com a mão acima do ombro: o aceno. */
function wave(frame, high) {
  const out = frame.map((r) => r.split(''));
  const top = high ? 2 : 4;
  // A mão: dois de largura, com o contorno em cima.
  out[top][14] = 'k';
  out[top][15] = 'k';
  for (const y of [top + 1, top + 2]) {
    out[y][13] = 'k';
    out[y][14] = 's';
    out[y][15] = 'S';
  }
  // A manga até o ombro.
  for (let y = top + 3; y < 13; y++) {
    out[y][13] = 'k';
    out[y][14] = 'c';
    out[y][15] = 'C';
  }
  // O braço que subiu não está mais do lado do corpo.
  out[16][12] = 'C';
  out[17][12] = 'C';
  return out.map((r) => r.join(''));
}

/**
 * Digitando, de costas: os braços dobrados dos dois lados -- o cotovelo aberto
 * encostado no corpo, o antebraço subindo até o teclado (que fica à frente, pra
 * cima na tela) e a mão ao lado do pescoço. [left] e [right] dizem qual mão
 * está no ar, batendo numa tecla; a outra está apoiada.
 */
function typing(seated, { left = false, right = false } = {}) {
  const out = seated.map((r) => r.split(''));
  // Desenha o braço esquerdo; o direito é o mesmo, espelhado.
  const arm = (up, at) => {
    const hand = up ? 12 : 13;
    // O contorno de fora, da mão até o cotovelo.
    for (let y = hand - 1; y <= 19; y++) at(0, y, 'k');
    // A mão: dois de largura, com o contorno em cima e do lado do pescoço.
    at(1, hand - 1, 'k');
    at(2, hand - 1, 'k');
    at(1, hand, 's');
    at(2, hand, 'S');
    at(3, hand, 'k');
    // O antebraço e o cotovelo: a manga descendo até a linha da cintura.
    for (let y = hand + 1; y <= 18; y++) at(1, y, y >= 16 ? 'C' : 'c');
    for (let y = hand + 1; y <= 14; y++) at(2, y, 'c');
    at(1, 19, 'k');
  };
  arm(left, (x, y, c) => (out[y][x] = c));
  arm(right, (x, y, c) => (out[y][15 - x] = c));
  return out.map((r) => r.join(''));
}

/**
 * As cabeças de um visual: as de sempre, com o acessório por cima -- `oculos`
 * (a armação em volta dos olhos) ou `fone` (o arco no alto da cabeça e as
 * conchas nas orelhas). É o que se escolhe no "personalizar você".
 */
function heads({ accessory } = {}) {
  const put = (rows, edits) => {
    const out = rows.map((r) => r.split(''));
    for (const [x, y, c] of edits) out[y][x] = c;
    return out.map((r) => r.join(''));
  };
  const base = {
    FRONT: HEAD_FRONT,
    BLINK: HEAD_BLINK,
    CHEER: HEAD_CHEER,
    YAWN: HEAD_YAWN,
    TIRED: HEAD_TIRED,
    BACK: HEAD_BACK,
    SIDE: HEAD_SIDE,
  };
  if (accessory === 'oculos') {
    // A armação: as duas lentes em volta dos olhos e a ponte no meio.
    // Cada lente é a moldura em volta do olho (que fica à mostra no meio).
    const lenses = [
      [4, 6], [5, 6], [6, 6], [9, 6], [10, 6], [11, 6],
      [4, 7], [6, 7], [7, 7], [8, 7], [9, 7], [11, 7],
      [4, 8], [6, 8], [9, 8], [11, 8],
      [4, 9], [5, 9], [6, 9], [9, 9], [10, 9], [11, 9],
    ].map(([x, y]) => [x, y, 'g']);
    const side = [[10, 6], [11, 6], [12, 6], [10, 7], [12, 7], [10, 8], [12, 8], [10, 9], [11, 9], [12, 9], [9, 7], [8, 7], [7, 7]].map(([x, y]) => [x, y, 'g']);
    // De costas, só a haste passando por cima da orelha.
    const back = [[2, 7, 'g'], [13, 7, 'g']];
    return {
      ...base,
      FRONT: put(HEAD_FRONT, lenses),
      BLINK: put(HEAD_BLINK, lenses),
      CHEER: put(HEAD_CHEER, lenses),
      YAWN: put(HEAD_YAWN, lenses),
      TIRED: put(HEAD_TIRED, lenses),
      SIDE: put(HEAD_SIDE, side),
      BACK: put(HEAD_BACK, back),
    };
  }
  if (accessory === 'fone') {
    // O arco por cima da cabeça e as duas conchas, saindo um pouco pra fora.
    const band = [4, 5, 6, 7, 8, 9, 10, 11].map((x) => [x, 2, 'q']);
    const cups = [6, 7, 8].flatMap((y) => [[1, y, 'k'], [2, y, 'q'], [13, y, 'q'], [14, y, 'k']]);
    const front = [...band, ...cups];
    const side = [...[4, 5, 6, 7, 8, 9, 10].map((x) => [x, 2, 'q']), [4, 5, 'q'], [5, 5, 'q'], [4, 6, 'q'], [5, 6, 'q'], [4, 7, 'q'], [5, 7, 'q']];
    return {
      FRONT: put(HEAD_FRONT, front),
      BLINK: put(HEAD_BLINK, front),
      CHEER: put(HEAD_CHEER, front),
      YAWN: put(HEAD_YAWN, front),
      TIRED: put(HEAD_TIRED, front),
      BACK: put(HEAD_BACK, front),
      SIDE: put(HEAD_SIDE, side),
    };
  }
  return base;
}

/** O quadro espelhado: a mão esquerda é a direita ao contrário. */
function mirror(frame) {
  return frame.map((r) => r.split('').reverse().join(''));
}

/** Os dois braços pra cima: a comemoração e o espreguiçar. */
function armsUp(frame, high) {
  return mirror(wave(mirror(wave(frame, high)), high));
}

/** A mão na testa, cobrindo o olho direito: o teste que quebrou. */
function facepalm(frame, low) {
  const out = frame.map((r) => r.split(''));
  const y0 = low ? 6 : 5;
  for (let x = 8; x <= 12; x++) {
    out[y0 - 1][x] = 'k';
    out[y0][x] = 's';
    out[y0 + 1][x] = 'S';
  }
  out[y0][13] = 'k';
  out[y0 + 1][13] = 'k';
  // O antebraço descendo até o ombro.
  for (let y = y0 + 2; y < 13; y++) {
    out[y][12] = 'k';
    out[y][13] = 'c';
    out[y][14] = 'k';
  }
  out[16][12] = 'C';
  out[17][12] = 'C';
  return out.map((r) => r.join(''));
}

/** A gota de suor do lado da cabeça, descendo um pouco a cada quadro. */
function sweat(frame, step) {
  const out = frame.map((r) => r.split(''));
  const y = 3 + step * 2;
  out[y][14] = 'd';
  out[y + 1][14] = 'd';
  out[y + 1][15] = 'd';
  return out.map((r) => r.join(''));
}

function frames(look = {}) {
  const HD = heads(look);
  const front = stack(HD.FRONT, TORSO_FRONT, LEGS_STAND);
  const back = stack(HD.BACK, TORSO_BACK, LEGS_STAND);
  const seated = shift(stack(HD.BACK, TORSO_BACK, SEAT), 2);
  // Uma mão bate, as duas apoiam, a outra bate, as duas apoiam.
  const typing4 = [
    typing(seated, { left: true }),
    typing(seated, {}),
    typing(seated, { right: true }),
    typing(seated, {}),
  ];
  const blink = stack(HD.BLINK, TORSO_FRONT, LEGS_STAND);
  return [
    [front, shift(stack(HD.FRONT, TORSO_FRONT, LEGS_STEP_A), 0), front, stack(HD.FRONT, TORSO_FRONT, LEGS_STEP_B)],
    [back, stack(HD.BACK, TORSO_BACK, LEGS_STEP_A), back, stack(HD.BACK, TORSO_BACK, LEGS_STEP_B)],
    [
      stack(HD.SIDE, TORSO_SIDE, LEGS_SIDE),
      shift(stack(HD.SIDE, TORSO_SIDE, LEGS_SIDE_STEP), 0),
      stack(HD.SIDE, TORSO_SIDE, LEGS_SIDE),
      shift(stack(HD.SIDE, TORSO_SIDE, LEGS_SIDE_STEP), 0),
    ],
    typing4,
    [seated, seated, shift(seated, 1), shift(seated, 1)],
    [front, front, front, blink],
    [wave(front, true), wave(front, false), wave(front, true), wave(front, false)],
    [seated, seated, seated, seated],
    [
      armsUp(stack(HD.CHEER, TORSO_FRONT, LEGS_STAND), true),
      shift(armsUp(stack(HD.CHEER, TORSO_FRONT, LEGS_STAND), true), -1),
      armsUp(stack(HD.CHEER, TORSO_FRONT, LEGS_STAND), false),
      shift(armsUp(stack(HD.CHEER, TORSO_FRONT, LEGS_STAND), false), -1),
    ],
    [facepalm(front, false), facepalm(front, true), facepalm(front, false), facepalm(front, true)],
    (() => {
      const dozing = stack(HD.BLINK, TORSO_FRONT, LEGS_SEATED);
      return [dozing, dozing, shift(dozing, 1), shift(dozing, 1)];
    })(),
    (() => {
      const tired = shift(stack(HD.TIRED, TORSO_FRONT, LEGS_STAND), 1);
      return [0, 1, 2, 3].map((n) => sweat(tired, n));
    })(),
    (() => {
      const yawn = stack(HD.YAWN, TORSO_FRONT, LEGS_STAND);
      return [armsUp(yawn, false), armsUp(yawn, true), shift(armsUp(yawn, true), -1), armsUp(yawn, true)];
    })(),
  ];
}

// --- o gato --------------------------------------------------------------------
//
// Desenhado por preenchimento, e o contorno sai sozinho: todo pixel vazio
// encostado no gato vira contorno. Uma tela de 16×11, colada no pé do quadro.

const CAT_H = 11;

function canvas() {
  return Array.from({ length: CAT_H }, () => new Array(W).fill('.'));
}

function fill(c, x0, y0, x1, y1, ch) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) c[y][x] = ch;
}

function dot(c, pts, ch) {
  for (const [x, y] of pts) c[y][x] = ch;
}

/** O contorno em volta do que foi pintado, e o quadro inteiro de 16×24. */
function catFrame(c) {
  const out = c.map((r) => [...r]);
  for (let y = 0; y < CAT_H; y++) {
    for (let x = 0; x < W; x++) {
      if (c[y][x] !== '.') continue;
      const near = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ].some(([nx, ny]) => ny >= 0 && ny < CAT_H && nx >= 0 && nx < W && c[ny][nx] !== '.');
      if (near) out[y][x] = 'k';
    }
  }
  return [...Array(H - CAT_H).fill('.'.repeat(W)), ...out.map((r) => r.join(''))];
}

/** De lado, olhando pra direita; [step] mexe as pernas e o rabo. */
function catSide(step) {
  const c = canvas();
  fill(c, 3, 5, 11, 8, 'o');
  fill(c, 5, 8, 10, 8, 'w');
  dot(c, [[5, 5], [5, 6], [8, 5], [8, 6]], 'O');
  fill(c, 10, 2, 14, 6, 'o');
  dot(c, [[10, 1], [13, 1]], 'o');
  dot(c, [[13, 3]], 'e');
  dot(c, [[13, 5], [12, 5]], 'w');
  dot(c, [[14, 5]], 'n');
  dot(c, step % 2 ? [[2, 5], [1, 4], [1, 3], [2, 2]] : [[2, 5], [1, 4], [1, 3], [1, 2]], 'O');
  const legs = [
    [[4, 9], [10, 9]],
    [[3, 9], [9, 9], [11, 9]],
    [[4, 9], [10, 9]],
    [[5, 9], [8, 9], [11, 9]],
  ][step];
  dot(c, legs, 'o');
  return catFrame(c);
}

/** De frente, sentado; [tail] mexe o rabo, [eyes] fecha ('closed') ou abre a boca ('meow'). */
function catFront({ tail = 0, eyes = 'open', lift = 0, back = false } = {}) {
  const c = canvas();
  const t = lift;
  fill(c, 4, 6, 11, 9, 'o');
  if (!back) fill(c, 6, 6, 9, 8, 'w');
  fill(c, 5, 2 - t, 10, 5 - t, 'o');
  dot(c, [[5, 1 - t], [10, 1 - t]], 'o');
  if (!back) {
    if (eyes === 'closed') {
      dot(c, [[6, 3 - t], [9, 3 - t]], 'O');
    } else {
      dot(c, [[6, 3 - t], [9, 3 - t]], 'e');
    }
    dot(c, [[7, 4 - t], [8, 4 - t]], 'n');
    if (eyes === 'meow') dot(c, [[7, 5 - t], [8, 5 - t]], 'm');
  } else {
    dot(c, [[6, 4 - t], [9, 4 - t]], 'O');
  }
  dot(c, [[5, 9], [10, 9]], back ? 'o' : 'w');
  const tails = [
    [[12, 9], [13, 8], [13, 7], [13, 6]],
    [[12, 9], [13, 9], [14, 8], [14, 7]],
    [[12, 9], [13, 8], [14, 7], [14, 6]],
    [[12, 9], [13, 9], [14, 9], [14, 8]],
  ];
  dot(c, tails[tail], 'O');
  return catFrame(c);
}

/** Andando de frente (ou de costas): o corpo balança e as patas trocam. */
function catWalk(step, back) {
  const f = catFront({ tail: step % 2, back });
  const rows = f.map((r) => r.split(''));
  const y = H - 2; // a linha das patas
  const paws = step % 2 ? [6, 9] : [5, 10];
  for (const x of [5, 6, 9, 10]) if (rows[y][x] !== 'k') rows[y][x] = 'o';
  for (const x of paws) rows[y][x] = back ? 'o' : 'w';
  rows[y + 1] = '.'.repeat(W).split('');
  for (const x of paws) {
    rows[y + 1][x] = 'k';
  }
  return shift(
    rows.map((r) => r.join('')),
    step % 2 ? 0 : 0,
  );
}

/** Dormindo enroladinho: o corpo inteiro no chão, a cabeça apoiada, o rabo em volta. */
function catSleep(breath) {
  const c = canvas();
  fill(c, 3, 6 - breath, 12, 9, 'o');
  dot(c, [[6, 6 - breath], [9, 6 - breath], [11, 7]], 'O');
  fill(c, 2, 5, 6, 9, 'o');
  dot(c, [[2, 4], [5, 4]], 'o');
  dot(c, [[3, 7], [5, 7]], 'O');
  dot(c, [[4, 8]], 'n');
  fill(c, 7, 9, 13, 9, 'O');
  return catFrame(c);
}

function catFrames() {
  return [
    [0, 1, 2, 3].map((n) => catWalk(n, false)),
    [0, 1, 2, 3].map((n) => catWalk(n, true)),
    [0, 1, 2, 3].map((n) => catSide(n)),
    [0, 1, 2, 3].map((n) => catFront({ tail: n })),
    [catSleep(0), catSleep(0), catSleep(1), catSleep(1)],
    [catFront({ eyes: 'meow', lift: 1 }), catFront({ eyes: 'meow', lift: 1 }), catFront({}), catFront({ eyes: 'closed' })],
  ];
}

const CAT = { id: 'gato', pet: true, fur: '#e3974a', stripes: '#b86f2a', belly: '#f6e7cf' };

// --- o cachorro -----------------------------------------------------------------
//
// Do mesmo jeito que o gato: preenchido, com o contorno saindo sozinho. Orelha
// caída (O, o tom mais escuro), focinho comprido de lado, rabo que abana.

/** De lado, olhando pra direita. */
function dogSide(step) {
  const c = canvas();
  fill(c, 3, 5, 11, 8, 'o');
  fill(c, 5, 8, 10, 8, 'w');
  fill(c, 10, 2, 13, 6, 'o');
  fill(c, 14, 4, 15, 6, 'o');
  dot(c, [[15, 4]], 'e');
  dot(c, [[12, 3]], 'e');
  dot(c, [[10, 2], [10, 3], [10, 4], [11, 4]], 'O');
  dot(c, [[14, 6], [15, 6]], 'w');
  dot(c, step % 2 ? [[2, 5], [1, 4], [1, 3]] : [[2, 5], [2, 4], [2, 3]], 'o');
  const legs = [
    [[4, 9], [10, 9]],
    [[3, 9], [9, 9], [11, 9]],
    [[4, 9], [10, 9]],
    [[5, 9], [8, 9], [11, 9]],
  ][step];
  dot(c, legs, 'o');
  return catFrame(c);
}

/** De frente, sentado; [tail] abana, [face] 'closed' fecha os olhos e 'bark' abre a boca. */
function dogFront({ tail = 0, face = 'open', lift = 0, back = false } = {}) {
  const c = canvas();
  const t = lift;
  fill(c, 4, 6, 11, 9, 'o');
  if (!back) fill(c, 6, 6, 9, 8, 'w');
  fill(c, 5, 1 - t, 10, 5 - t, 'o');
  // As orelhas caídas dos dois lados da cabeça.
  dot(c, [[4, 2 - t], [4, 3 - t], [4, 4 - t], [11, 2 - t], [11, 3 - t], [11, 4 - t]], 'O');
  if (!back) {
    dot(c, [[6, 3 - t], [9, 3 - t]], face === 'closed' ? 'O' : 'e');
    fill(c, 6, 4 - t, 9, 5 - t, 'w');
    dot(c, [[7, 4 - t], [8, 4 - t]], 'e');
    if (face === 'bark') dot(c, [[7, 5 - t], [8, 5 - t]], 'm');
    else if (face === 'open') dot(c, [[8, 5 - t]], 'n');
  }
  dot(c, [[5, 9], [10, 9]], back ? 'o' : 'w');
  const tails = [
    [[12, 8], [13, 7], [14, 6]],
    [[12, 8], [13, 8], [14, 8]],
    [[12, 8], [13, 7], [14, 6]],
    [[12, 8], [13, 9], [14, 9]],
  ];
  dot(c, tails[tail], 'o');
  return catFrame(c);
}

function dogWalk(step, back) {
  const f = dogFront({ tail: step % 2 ? 1 : 0, back });
  const rows = f.map((r) => r.split(''));
  const y = H - 2;
  const paws = step % 2 ? [6, 9] : [5, 10];
  for (const x of [5, 6, 9, 10]) if (rows[y][x] !== 'k') rows[y][x] = 'o';
  for (const x of paws) rows[y][x] = back ? 'o' : 'w';
  rows[y + 1] = '.'.repeat(W).split('');
  for (const x of paws) rows[y + 1][x] = 'k';
  return rows.map((r) => r.join(''));
}

/** Deitado de lado, a cabeça no chão, respirando. */
function dogSleep(breath) {
  const c = canvas();
  fill(c, 2, 7 - breath, 11, 9, 'o');
  fill(c, 4, 9, 9, 9, 'w');
  fill(c, 10, 5, 13, 9, 'o');
  fill(c, 14, 7, 15, 9, 'o');
  dot(c, [[10, 5], [10, 6], [10, 7], [11, 7]], 'O');
  dot(c, [[11, 6], [12, 6]], 'O');
  dot(c, [[15, 7]], 'e');
  dot(c, [[1, 8], [0, 8]], 'o');
  return catFrame(c);
}

function dogFrames() {
  return [
    [0, 1, 2, 3].map((n) => dogWalk(n, false)),
    [0, 1, 2, 3].map((n) => dogWalk(n, true)),
    [0, 1, 2, 3].map((n) => dogSide(n)),
    [0, 1, 2, 3].map((n) => dogFront({ tail: n })),
    [dogSleep(0), dogSleep(0), dogSleep(1), dogSleep(1)],
    [dogFront({ face: 'bark', lift: 1, tail: 1 }), dogFront({ face: 'bark', tail: 3 }), dogFront({ face: 'bark', lift: 1, tail: 1 }), dogFront({ tail: 3 })],
  ];
}

const DOG = { id: 'cachorro', pet: true, fur: '#c98b52', stripes: '#8a5a32', belly: '#f2dcb8' };

// --- as roupas -----------------------------------------------------------------

const OUTLINE = '#2a1f2d';

/** Uma cor um tanto mais escura, pras dobras e sombras. */
function darker(hex, f = 0.78) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// As roupas dos claudes (as sessões) e as dos ajudantes (os subagentes, de
// crachá: camisa clara). O índice da roupa sai do id do painel, então o mesmo
// claude veste a mesma roupa enquanto vive.
const SKINS = [
  { id: 'claude-0', hair: '#3b2a24', skin: '#f1c7a4', shirt: '#d97757', pants: '#3c4a6b', shoes: '#2b2b33', chair: '#5a6b8c' },
  { id: 'claude-1', hair: '#e2b356', skin: '#f6d2b8', shirt: '#4e8ad1', pants: '#33363f', shoes: '#4a2e22', chair: '#5a6b8c' },
  { id: 'claude-2', hair: '#1f1b1d', skin: '#a8714f', shirt: '#57a773', pants: '#2f3d55', shoes: '#22222a', chair: '#5a6b8c' },
  { id: 'claude-3', hair: '#a8452c', skin: '#f3cdb0', shirt: '#8b6cc9', pants: '#463c35', shoes: '#2b2b33', chair: '#5a6b8c' },
  { id: 'claude-4', hair: '#5b3b2a', skin: '#c48b63', shirt: '#e0b443', pants: '#3a3f58', shoes: '#3b2a24', chair: '#5a6b8c' },
  { id: 'claude-5', hair: '#cfcfd6', skin: '#e8b996', shirt: '#cf5c7c', pants: '#2e3440', shoes: '#22222a', chair: '#5a6b8c' },
  { id: 'claude-6', hair: '#2d2433', skin: '#7a4e36', shirt: '#3fb5b0', pants: '#40394a', shoes: '#22222a', chair: '#5a6b8c' },
  { id: 'claude-7', hair: '#7b4a2a', skin: '#f2c9a8', shirt: '#e8875b', pants: '#2b3a4a', shoes: '#3b2a24', chair: '#5a6b8c' },
];

const HELPERS = [
  { id: 'helper-0', hair: '#4a3328', skin: '#f0c4a0', shirt: '#dfe3ea', pants: '#4b5568', shoes: '#2b2b33', chair: '#7a8399' },
  { id: 'helper-1', hair: '#d9a84f', skin: '#b98060', shirt: '#e9e0cf', pants: '#3e4a3d', shoes: '#2b2b33', chair: '#7a8399' },
  { id: 'helper-2', hair: '#262027', skin: '#f5d0b5', shirt: '#d6e5dc', pants: '#4a3f5c', shoes: '#2b2b33', chair: '#7a8399' },
  { id: 'helper-3', hair: '#8c3b2a', skin: '#8f5d42', shirt: '#e6dbe9', pants: '#384252', shoes: '#2b2b33', chair: '#7a8399' },
];

// Os ajudantes de tipo conhecido têm roupa própria: o explorador (o Explore,
// que procura no código) de óculos e verde, o planejador (o Plan) de fone e
// azul, e quem revisa de óculos e rosa. O resto veste as de crachá, em rodízio.
const HELPER_TYPES = [
  { match: /explor/i, skin: { id: 'helper-explore', hair: '#5b3b2a', skin: '#e9bc98', shirt: '#9fd39a', pants: '#3e4a3d', shoes: '#2b2b33', chair: '#7a8399', accessory: 'oculos' } },
  { match: /plan/i, skin: { id: 'helper-plan', hair: '#1f1b1d', skin: '#c48b63', shirt: '#9cc3ef', pants: '#2f3d55', shoes: '#2b2b33', chair: '#7a8399', accessory: 'fone', accent: '#e0b443' } },
  { match: /review|revis/i, skin: { id: 'helper-review', hair: '#e2b356', skin: '#f6d2b8', shirt: '#f0a8bf', pants: '#463c35', shoes: '#2b2b33', chair: '#7a8399', accessory: 'oculos' } },
];

/** A roupa de um ajudante do tipo [type] (o `subagent_type`); [n] escolhe a de crachá. */
function helperSkin(type, n = 0) {
  const known = HELPER_TYPES.find((t) => t.match.test(String(type || '')));
  return known ? known.skin : HELPERS[n % HELPERS.length];
}

// Você, quando vai levar um pedido até a mesa de um claude: o moletom escuro e
// o tênis claro.
// O mensageiro: quem traz o recado de uma sessão que não está no escritório
// (o colete amarelo, de fone).
const MESSENGER = { id: 'mensageiro', hair: '#5b3b2a', skin: '#c48b63', shirt: '#e0b443', pants: '#2f3d55', shoes: '#2b2b33', chair: '#7a8399', accessory: 'fone', accent: '#c94f3d' };

const VOCE = { id: 'voce', hair: '#2b1d17', skin: '#e9bc98', shirt: '#33384a', pants: '#24324a', shoes: '#e7e2d6', chair: '#5a6b8c' };

// A versão do desenho: muda quando muda a grade ou a pixel art, e vai no nome do
// arquivo -- a janela guarda as imagens pelo caminho, e um arquivo novo com o
// nome velho continuaria aparecendo o desenho antigo até reabrir o app.
const VERSION = 3;

function paletteOf(skin) {
  return {
    k: OUTLINE,
    h: skin.hair,
    s: skin.skin,
    S: darker(skin.skin, 0.82),
    e: '#241a20',
    c: skin.shirt,
    C: darker(skin.shirt),
    p: skin.pants,
    b: skin.shoes,
    r: skin.chair,
    d: '#8fd3ff',
    m: '#7a2e3a',
    g: '#9aa3bd', // a armação dos óculos: clara, pro olho aparecer através dela
    q: skin.accent || '#e5534b', // o fone
  };
}

function petPalette(pet) {
  return {
    k: OUTLINE,
    o: pet.fur,
    O: pet.stripes,
    w: pet.belly,
    e: '#241a20',
    n: '#e88a9a',
    m: '#9b3b4f',
  };
}

function rgba(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

/** A folha de uma roupa (ou do bicho, com `skin` = `CAT` ou `DOG`), em pixels RGBA. */
function sheetPixels(skin) {
  const pal = skin.pet ? petPalette(skin) : paletteOf(skin);
  const grid = skin === CAT ? catFrames() : skin === DOG ? dogFrames() : frames(skin);
  const width = W * COLUMNS;
  const height = H * grid.length;
  const px = Buffer.alloc(width * height * 4);
  grid.forEach((row, r) => {
    row.forEach((frame, c) => {
      frame.forEach((line, y) => {
        for (let x = 0; x < W; x++) {
          const ch = line[x];
          if (ch === '.') continue;
          const color = pal[ch];
          if (!color) throw new Error(`cor desconhecida: ${ch}`);
          const at = ((r * H + y) * width + c * W + x) * 4;
          rgba(color).forEach((v, i) => (px[at + i] = v));
        }
      });
    });
  });
  return { width, height, px };
}

// --- png -----------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Um png RGBA de 8 bits, sem dependência nenhuma. */
function png(width, height, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // sem filtro
    px.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * O retrato de uma roupa (a cabeça e os ombros de quem olha pra frente,
 * grandes, num quadrado com o fundo [bg]), pra notificação do sistema. Grava em
 * `<dir>/retratos/<id>.png` (se ainda não existe) e devolve o caminho.
 */
function portrait(dir, skin, { bg = '#2a2438', scale = 8 } = {}) {
  const folder = path.join(dir, 'retratos');
  const file = path.join(folder, `${skin.id}.v${VERSION}.png`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(folder, { recursive: true });
  const sheet = sheetPixels(skin);
  // O primeiro quadro de "de frente", do topo da cabeça até o peito, com uma
  // borda de 2 pixels de cada lado.
  const crop = { x: -2, y: -1, w: W + 4, h: 16 + 3 };
  const row = ROW.down;
  const size = crop.w * scale;
  const px = Buffer.alloc(size * size * 4);
  const [br, bgc, bb] = rgba(bg);
  const top = Math.floor((size - crop.h * scale) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      px[at] = br;
      px[at + 1] = bgc;
      px[at + 2] = bb;
      px[at + 3] = 255;
      const sx = crop.x + Math.floor(x / scale);
      const sy = crop.y + Math.floor((y - top) / scale);
      if (y < top || sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
      const from = ((row * H + sy) * sheet.width + sx) * 4;
      if (!sheet.px[from + 3]) continue;
      px[at] = sheet.px[from];
      px[at + 1] = sheet.px[from + 1];
      px[at + 2] = sheet.px[from + 2];
    }
  }
  fs.writeFileSync(file, png(size, size, px));
  return file;
}

/** O caminho da folha de uma roupa, relativo à pasta do plugin. */
function sheetOf(id) {
  return `sprites/${id}.v${VERSION}.png`;
}

const ALL = () => [...SKINS, ...HELPERS, ...HELPER_TYPES.map((t) => t.skin), MESSENGER, VOCE, CAT, DOG];

/**
 * Grava as folhas que faltam (ou todas, com [force]) em `<dir>/sprites`, e
 * apaga as de versões antigas.
 */
function build(dir, { force = false } = {}) {
  const folder = path.join(dir, 'sprites');
  fs.mkdirSync(folder, { recursive: true });
  const keep = new Set(ALL().map((k) => path.basename(sheetOf(k.id))));
  for (const name of fs.readdirSync(folder)) {
    // As folhas sob medida do "você" (`voce-*`) são do `buildLook`.
    if (name.endsWith('.png') && !keep.has(name) && !name.startsWith('voce-')) fs.rmSync(path.join(folder, name));
  }
  let wrote = 0;
  for (const skin of ALL()) {
    const file = path.join(dir, sheetOf(skin.id));
    if (!force && fs.existsSync(file)) continue;
    const { width, height, px } = sheetPixels(skin);
    fs.writeFileSync(file, png(width, height, px));
    wrote++;
  }
  return wrote;
}

/**
 * A folha sob medida do "você": as cores e o acessório que você escolheu. O nome
 * sai do próprio visual (`voce-<hash>`), então trocar de roupa é outra folha --
 * e a janela, que guarda as imagens pelo caminho, mostra a nova na hora. As
 * folhas de visuais antigos são apagadas. Devolve o `id` da folha.
 */
function buildLook(dir, look) {
  const id = `voce-${hashLook(look)}`;
  const folder = path.join(dir, 'sprites');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(dir, sheetOf(id));
  if (!fs.existsSync(file)) {
    const { width, height, px } = sheetPixels({ ...VOCE, ...look, id });
    fs.writeFileSync(file, png(width, height, px));
  }
  for (const name of fs.readdirSync(folder)) {
    if (name.startsWith('voce-') && name !== path.basename(sheetOf(id))) fs.rmSync(path.join(folder, name));
  }
  return id;
}

function hashLook(look) {
  const keys = ['hair', 'skin', 'shirt', 'pants', 'shoes', 'accessory', 'accent'];
  let h = 2166136261;
  for (const c of keys.map((k) => `${k}=${look[k] || ''}`).join(';')) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  return h.toString(36);
}

module.exports = {
  W,
  H,
  COLUMNS,
  ROWS,
  CAT_ROWS,
  ROW,
  CAT_ROW,
  SKINS,
  HELPERS,
  helperSkin,
  portrait,
  MESSENGER,
  VOCE,
  CAT,
  DOG,
  sheetOf,
  buildLook,
  build,
  sheetPixels,
  png,
};

if (require.main === module) {
  const n = build(__dirname, { force: true });
  process.stderr.write(`${n} folhas em ${path.join(__dirname, 'sprites')}\n`);
}
