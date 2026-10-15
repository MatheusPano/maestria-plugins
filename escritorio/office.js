// A planta do escritório: uma sala por repositório, com as mesas dos claudes que
// trabalham nele, a sala do descanso pra quem está à toa e o corredor que liga tudo.
//
// Tudo aqui é em tiles de 16px. A planta sai de `layout()` com:
//
// - a grade (`walk`): onde dá pra pisar, pro caminho de um boneco (`path()`);
// - as mesas de cada sala e os lugares da sala do descanso, os destinos;
// - o desenho do fundo (`svg()`): o chão, as paredes e os móveis, num svg só,
//   que a janela desenha uma vez -- quem se mexe por cima são os bonecos.
//
// A planta só muda quando muda o conjunto de salas ou uma sala precisa de mais
// mesas; as mesas vêm de quatro em quatro pra isso acontecer pouco.

'use strict';

const T = 16;
const DESKS_PER_ROW = 4;
const ASPECT = 2.1; // a proporção que a planta procura (largura / altura)
const CORRIDOR = 3;
// Em volta do prédio: a parede de fora (um tile) e o jardim (dois).
const MARGIN = 3;
// Dentro de cada sala: as mesas de quatro em quatro tiles (a mesa tem dois),
// dois tiles livres dos lados, um embaixo da parede e dois no fim, pra circular.
const DESK_STEP = 4;
const ROOM_IW = 2 + DESKS_PER_ROW * DESK_STEP - 2 + 2;
const LOUNGE_IW = 14;

/** Um número que o hash de um texto escolhe, sempre o mesmo pro mesmo texto. */
function hash(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h;
}

// Os temas: as cores de cada parte do escritório. Cada sala de repositório
// pega um dos pisos (`floors`, com o tapete dela) pelo hash do caminho; `planks`
// é tábua (madeira) ou ladrilho; `outside`, o que tem em volta do prédio -- o
// jardim, ou o espaço (com estrelas e planetas no lugar das árvores).
const THEMES = {
  classico: {
    label: 'clássico',
    floors: [
      { floor: ['#b7875a', '#a67a50'], rug: ['#5a6f9a', '#4c5f87', '#7f93bd'] },
      { floor: ['#c49a6c', '#b28a5e'], rug: ['#8a4f5c', '#764350', '#b07583'] },
      { floor: ['#9e7454', '#8f694b'], rug: ['#4f7f6c', '#43705e', '#76a591'] },
      { floor: ['#c7a27a', '#b8946d'], rug: ['#7a5d8f', '#6a4f7d', '#9f85b3'] },
      { floor: ['#a98b6d', '#9a7e62'], rug: ['#9a6a3e', '#875c34', '#c09062'] },
    ],
    planks: true,
    wall: { top: '#2f2940', face: '#6b6390', faceDark: '#5a5379', base: '#4a4366', side: '#3d3550', edge: '#524a6b' },
    corridor: ['#a3a1b2', '#9a98aa'],
    runner: ['#6e4a5c', '#5e3f4f', '#c9a36b'],
    lounge: ['#7a9a92', '#71918a'],
    loungeRug: ['#c98b5b', '#b47a4d', '#e2ad7c'],
    // A sua sala: o carpete escuro e o tapete grande embaixo da mesa.
    office: ['#5b6b8a', '#54637f'],
    officeRug: ['#8a5a8c', '#7a4e7c', '#d7a6d4'],
    meeting: ['#8c8aa6', '#83819c'],
    grass: ['#4f7d4a', '#4a7646', '#5a8a52'],
    porch: ['#8f8a7e', '#a9a395'],
    outside: 'garden',
    desk: ['#7a5235', '#94673f', '#5c3d27', '#4a3020'],
    chair: ['#334058', '#3f4a63', '#56637f', '#2b3245'],
    sofa: ['#4f6fa8', '#5f80bb', '#7393cc', '#44609a'],
  },
  aconchegante: {
    label: 'aconchegante',
    floors: [
      { floor: ['#8a5a3a', '#7c5033'], rug: ['#a8452c', '#8f3a25', '#e2b356'] },
      { floor: ['#9c6a45', '#8d5f3d'], rug: ['#5b7a4a', '#4c693e', '#c9d39a'] },
      { floor: ['#7e5236', '#704830'], rug: ['#7b4a6a', '#6a3f5b', '#d9a6c4'] },
      { floor: ['#a37550', '#946a48'], rug: ['#3f5f7a', '#344f66', '#a9c3d9'] },
    ],
    planks: true,
    wall: { top: '#3a2418', face: '#a0583c', faceDark: '#8a4a31', base: '#6b3a26', side: '#4a2c1e', edge: '#7a4630' },
    corridor: ['#b88a6a', '#ad8061'],
    runner: ['#7a3b2e', '#66302a', '#e2b356'],
    lounge: ['#a0785a', '#946e52'],
    loungeRug: ['#5b7a4a', '#4c693e', '#c9d39a'],
    office: ['#6b4a3a', '#614335'],
    officeRug: ['#c9763c', '#ad6430', '#f2d39a'],
    meeting: ['#94704f', '#886647'],
    grass: ['#5d7d3c', '#567436', '#6f9046'],
    porch: ['#9a7d62', '#b4977a'],
    outside: 'garden',
    desk: ['#5c3a24', '#74492d', '#45291a', '#331e13'],
    chair: ['#7a3b2e', '#8f4a3a', '#a85d4a', '#5e2c22'],
    sofa: ['#9a4a3a', '#b05a46', '#c87560', '#843f31'],
  },
  moderno: {
    label: 'moderno',
    floors: [
      { floor: ['#d9d9de', '#cfd0d6'], rug: ['#3fb5b0', '#329591', '#bfeeee'] },
      { floor: ['#e3e1dc', '#d8d6d0'], rug: ['#33384a', '#262a38', '#8a90a8'] },
      { floor: ['#cfd3d8', '#c4c8ce'], rug: ['#e0b443', '#c39a33', '#f6e3a6'] },
      { floor: ['#dcd8d2', '#d0ccc6'], rug: ['#cf5c7c', '#b04a68', '#f2b8c8'] },
    ],
    planks: false,
    wall: { top: '#8e94a2', face: '#eef0f3', faceDark: '#d9dce2', base: '#b8bdc7', side: '#9ea4b0', edge: '#c9ced6' },
    corridor: ['#bfc3ca', '#b6bac2'],
    runner: ['#33384a', '#2a2e3d', '#3fb5b0'],
    lounge: ['#c7e3df', '#bddad6'],
    loungeRug: ['#3fb5b0', '#329591', '#bfeeee'],
    office: ['#3a3f4f', '#353a49'],
    officeRug: ['#3fb5b0', '#329591', '#bfeeee'],
    meeting: ['#c9cdd4', '#bfc3cb'],
    grass: ['#6fa05a', '#679853', '#7fb06a'],
    porch: ['#b6bac2', '#d0d3d9'],
    outside: 'garden',
    desk: ['#e8e8ec', '#f6f6f8', '#c9cbd2', '#9a9ca6'],
    chair: ['#33384a', '#3f4559', '#5a6178', '#262a38'],
    sofa: ['#33384a', '#454b60', '#5a6178', '#2a2e3d'],
  },
  espacial: {
    label: 'espacial',
    floors: [
      { floor: ['#3a4058', '#343a50'], rug: ['#5b4fd1', '#4a40b0', '#9f97f0'] },
      { floor: ['#2f3a4f', '#2a3447'], rug: ['#d14f8a', '#b03f73', '#f09fc4'] },
      { floor: ['#383552', '#322f4a'], rug: ['#3fb5b0', '#329591', '#9feeee'] },
    ],
    planks: false,
    wall: { top: '#0f1222', face: '#2b3150', faceDark: '#232842', base: '#1c2138', side: '#161a2e', edge: '#4a5590' },
    corridor: ['#4a506a', '#434860'],
    runner: ['#1c2138', '#161a2e', '#5bd6ff'],
    lounge: ['#2f4a52', '#2a434a'],
    loungeRug: ['#5b4fd1', '#4a40b0', '#9f97f0'],
    office: ['#26223f', '#221e38'],
    officeRug: ['#5b4fd1', '#4a40b0', '#9f97f0'],
    meeting: ['#323a56', '#2c334d'],
    grass: ['#0b0d1c', '#0d1022', '#f4f1e8'],
    porch: ['#4a506a', '#5f6684'],
    outside: 'space',
    desk: ['#3a4058', '#4d5574', '#2b3046', '#1c2138'],
    chair: ['#5b4fd1', '#6d62e0', '#8a80f0', '#4a40b0'],
    sofa: ['#5b4fd1', '#6d62e0', '#8a80f0', '#4a40b0'],
  },
};
const THEME_IDS = Object.keys(THEMES);

/** O tema [id], ou o clássico. */
function themeOf(id) {
  return THEMES[id] || THEMES.classico;
}

// O tema do desenho da vez: o `svg()` põe o da planta aqui antes de desenhar.
let P = THEMES.classico;

const OFFICE_IW = 8;
const MEETING_IW = 10;

/**
 * Monta a planta pras salas pedidas.
 *
 * `rooms`: `[{ id, name, agents }]`, na ordem em que devem aparecer. `agents` é
 * quantos bonecos a sala precisa acomodar (as mesas vêm de quatro em quatro).
 * `office` (`{ name }`) põe a sua sala, a primeira da planta, perto da porta: a
 * mesa onde o "você" fica (`plan.home`).
 */
function layout(rooms, { office = null, theme = 'classico', meeting = false, decor = {} } = {}) {
  const pal = themeOf(theme);
  const specs = rooms.map((r) => {
    const desks = Math.max(DESKS_PER_ROW, Math.ceil(Math.max(1, r.agents) / DESKS_PER_ROW) * DESKS_PER_ROW);
    const cols = DESKS_PER_ROW;
    const rows = desks / DESKS_PER_ROW;
    const look = pal.floors[hash(r.id) % pal.floors.length];
    return {
      id: r.id,
      name: r.name,
      kind: 'room',
      cols,
      rows,
      iw: ROOM_IW,
      ih: 1 + rows * 3 + 2,
      floor: look.floor,
      rug: look.rug,
    };
  });
  specs.push({ id: '@descanso', name: 'sala do descanso', kind: 'lounge', iw: LOUNGE_IW, ih: 6, floor: pal.lounge });
  if (meeting) specs.push({ id: '@reuniao', name: 'sala de reunião', kind: 'meeting', iw: MEETING_IW, ih: 6, floor: pal.meeting });
  if (office) specs.unshift({ id: '@voce', name: office.name, kind: 'office', iw: OFFICE_IW, ih: 4, floor: pal.office });

  // As salas em faixas, da esquerda pra direita; cada faixa com o corredor
  // embaixo, e um corredor em pé à esquerda ligando as faixas. A largura das
  // faixas é a que deixa a planta mais perto da proporção de uma janela larga,
  // com menos buraco sobrando no fim das faixas curtas. Em volta de tudo, o
  // jardim, com o caminho de pedra da rua até a porta.
  const bands = bestBands(specs);

  const left = MARGIN + CORRIDOR; // o corredor em pé, depois do jardim
  const inner = Math.max(...bands.map((b) => b.reduce((n, s) => n + s.iw + 2, 0)));
  const cols = left + inner + MARGIN;
  let y = MARGIN;
  const placed = [];
  for (const b of bands) {
    const ih = Math.max(...b.map((s) => s.ih));
    let x = left;
    for (const s of b) {
      s.ih = ih; // a faixa inteira com a mesma altura: as portas dão no mesmo corredor
      s.x = x; // a parede da esquerda
      s.y = y; // o topo da parede de cima (que tem duas de altura: o topo e a face)
      s.ix = x + 1;
      s.iy = y + 2;
      s.w = s.iw + 2;
      s.h = s.ih + 3;
      s.door = { x: s.ix + Math.floor((s.iw - 2) / 2), y: s.iy + s.ih, w: 2 };
      placed.push(s);
      x += s.w;
    }
    y += ih + 3;
    for (const s of b) s.corridorY = y;
    y += CORRIDOR;
  }
  const rows = y + MARGIN;

  // A grade: 0 fora, 1 chão, 2 parede, 3 móvel.
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const set = (x, yy, v) => {
    if (yy >= 0 && yy < rows && x >= 0 && x < cols) grid[yy][x] = v;
  };
  // Os corredores.
  for (let yy = MARGIN; yy < y; yy++) for (let x = MARGIN; x < left; x++) set(x, yy, 1);
  const corridors = [...new Set(placed.map((s) => s.corridorY))];
  for (const cy of corridors) for (let x = MARGIN; x < left + inner; x++) for (let k = 0; k < CORRIDOR; k++) set(x, cy + k, 1);

  const desks = [];
  const spots = [];
  const furniture = [];
  const rugs = [];
  const sofa = []; // os lugares do sofá: onde para em pé e onde o boneco senta
  const windows = []; // o vidro de cada janela, que muda de cor com a hora
  const boards = []; // o quadro branco de cada sala, com a lista do claude
  let home = null; // a sua mesa, na sua sala
  let meetingPlan = null; // a mesa de reunião e os lugares em volta
  const decorItems = []; // os móveis que dá pra arrastar (os vasos e as luminárias)
  const slots = []; // e as vagas onde eles podem ficar
  let room = null; // a sala que está sendo mobiliada
  const put = (kind, x, yy, w = 1) => {
    for (let k = 0; k < w; k++) set(x + k, yy, 3);
    furniture.push({ kind, x, y: yy, w, room });
  };
  // Um móvel que dá pra arrastar: na vaga escolhida (`decor`), se ela ainda
  // existe e está livre; senão no lugar de sempre, ou na primeira vaga livre.
  const movable = (s, key, kind, dx, dy) => {
    const free = (v) => v && s.slots.some((o) => o.dx === v.dx && o.dy === v.dy) && !s.used.has(`${v.dx},${v.dy}`);
    const want = decor[s.id] && decor[s.id][key];
    const at = free(want) ? want : !s.used.has(`${dx},${dy}`) ? { dx, dy } : s.slots.find(free);
    if (!at) return;
    s.used.add(`${at.dx},${at.dy}`);
    put(kind, s.ix + at.dx, s.iy + at.dy);
    decorItems.push({ room: s.id, key, kind, x: s.ix + at.dx, y: s.iy + at.dy });
  };
  for (const s of placed) {
    room = s.id;
    for (let yy = s.y; yy < s.y + s.h; yy++) for (let x = s.x; x < s.x + s.w; x++) set(x, yy, 2);
    for (let yy = s.iy; yy < s.iy + s.ih; yy++) for (let x = s.ix; x < s.ix + s.iw; x++) set(x, yy, 1);
    for (let k = 0; k < s.door.w; k++) set(s.door.x + k, s.door.y, 1);
    s.desks = [];
    if (s.kind === 'room') {
      // O tapete embaixo das mesas, de uma fileira de cadeiras à outra.
      rugs.push({ x: (s.ix + 1) * T + 4, y: (s.iy + 1) * T + 10, w: (s.iw - 2) * T - 8, h: (s.rows * 3 - 1) * T - 4, colors: s.rug });
      for (let r = 0; r < s.rows; r++) {
        for (let c = 0; c < s.cols; c++) {
          const dx = s.ix + 2 + c * DESK_STEP;
          const dy = s.iy + 1 + r * 3;
          set(dx, dy, 3);
          set(dx + 1, dy, 3);
          const desk = {
            id: `${s.id}#${r * s.cols + c}`,
            room: s.id,
            x: dx,
            y: dy,
            // O lugar de quem senta: o tile embaixo da mesa (o da esquerda), e
            // o boneco meio tile pra direita, no meio da mesa.
            seat: { x: dx, y: dy + 1 },
            // Onde um ajudante para pra conversar: o corredor de baixo.
            talk: { x: dx + 1, y: dy + 2 },
          };
          desks.push(desk);
          s.desks.push(desk);
        }
      }
      // As janelas, um quadro de avisos e o quadro branco na parede de cima.
      for (const wx of [72, 104, 136]) windows.push({ x: s.ix * T + wx, y: s.y * T + 10, frame: true });
      boards.push({ room: s.id, x: (s.ix + s.iw) * T - 74, y: s.y * T + 6, w: 58, h: 24 });
      // A estante e o vaso nos cantos de cima, mais um vaso e a luminária nos
      // de baixo. A estante é fixa; o resto dá pra arrastar.
      put('shelf', s.ix, s.iy);
      decorSlots(s, slots);
      movable(s, 'vaso1', 'plant', s.iw - 1, 0);
      movable(s, 'vaso2', 'plant', 0, s.ih - 1);
      movable(s, 'luz', 'lamp', s.iw - 1, s.ih - 1);
    } else if (s.kind === 'office') {
      // A sua sala: a mesa no meio, de frente pra parede, num tapete grande; a
      // estante e um vaso nos cantos de cima, a luminária e outro vaso embaixo.
      const dx = s.ix + Math.floor((s.iw - 2) / 2);
      const dy = s.iy + 1;
      set(dx, dy, 3);
      set(dx + 1, dy, 3);
      const seat = { x: dx, y: dy + 1 };
      home = {
        desk: { id: '@voce#0', room: s.id, x: dx, y: dy, seat, talk: { x: dx + 1, y: dy + 2 } },
        seat,
        px: { x: seat.x * T + 8, y: seat.y * T - 8 },
        // Onde fica quem vem fazer uma pergunta: dos lados da sua mesa
        // primeiro, depois na frente dela (os que caem num móvel saem abaixo).
        visit: [
          { x: dx - 1, y: dy + 1 },
          { x: dx + 2, y: dy + 1 },
          { x: dx - 1, y: dy },
          { x: dx + 2, y: dy },
          { x: dx + 2, y: dy + 2 },
          { x: dx - 1, y: dy + 2 },
        ],
      };
      rugs.push({ x: (s.ix + 1) * T + 2, y: s.iy * T + 12, w: (s.iw - 2) * T - 4, h: 3 * T - 8, colors: pal.officeRug });
      put('shelf', s.ix, s.iy);
      decorSlots(s, slots);
      movable(s, 'vaso1', 'plant', s.iw - 1, 0);
      movable(s, 'luz', 'lamp', s.iw - 1, s.ih - 1);
      movable(s, 'vaso2', 'plant', 0, s.ih - 1);
      windows.push({ x: (s.ix + 1) * T + 4, y: s.y * T + 10, frame: true });
    } else if (s.kind === 'meeting') {
      // A sala de reunião: a mesa comprida no meio; quatro lugares de cada
      // lado (os de baixo, de cadeira, sentam de costas pra você; os de cima
      // ficam de frente) e um em cada ponta. Na parede, a tela.
      const tx = s.ix + Math.floor((s.iw - 4) / 2);
      const ty = s.iy + 2;
      for (let k = 0; k < 4; k++) {
        set(tx + k, ty, 3);
        set(tx + k, ty + 1, 3);
      }
      furniture.push({ kind: 'meeting', x: tx, y: ty, w: 4, room });
      const seats = [];
      for (let k = 0; k < 4; k++) {
        seats.push({ tile: { x: tx + k, y: ty + 2 }, face: 'up' });
        seats.push({ tile: { x: tx + 3 - k, y: ty - 1 }, face: 'down' });
      }
      seats.push({ tile: { x: tx - 1, y: ty }, face: 'right' });
      seats.push({ tile: { x: tx + 4, y: ty }, face: 'left' });
      for (const st of seats) st.px = { x: st.tile.x * T, y: st.tile.y * T - (st.face === 'up' ? 6 : 8) };
      meetingPlan = { room: s.id, seats, table: { x: tx, y: ty } };
      put('plant', s.ix, s.iy);
      put('plant', s.ix + s.iw - 1, s.iy);
      put('plant', s.ix, s.iy + s.ih - 1);
      put('lamp', s.ix + s.iw - 1, s.iy + s.ih - 1);
      windows.push({ x: (s.ix + 1) * T + 4, y: s.y * T + 10, frame: true });
    } else {
      // A sala do descanso: o balcão com a cafeteira e o bebedouro na parede de
      // cima; embaixo, à esquerda, o sofá num tapete com a mesinha de centro; à
      // direita, a mesa redonda com os banquinhos; os lugares de ficar em pé em volta.
      const bottom = s.iy + s.ih - 1;
      put('counter', s.ix + 1, s.iy, 4);
      put('cooler', s.ix + 6, s.iy);
      put('plant', s.ix + s.iw - 1, s.iy);
      put('arcade', s.ix + s.iw - 3, s.iy);
      rugs.push({ x: s.ix * T + 6, y: (bottom - 2) * T + 2, w: 5 * T - 4, h: 3 * T - 6, colors: pal.loungeRug });
      put('sofa', s.ix + 1, bottom - 1, 3);
      for (let k = 0; k < 3; k++) {
        sofa.push({
          stand: { x: s.ix + 1 + k, y: bottom - 2 },
          px: { x: (s.ix + 1 + k) * T, y: (bottom - 1) * T - 11 },
        });
      }
      put('coffee', s.ix + 4, bottom - 1);
      put('table', s.ix + 9, s.iy + 2, 2);
      put('plant', s.ix, bottom);
      put('plant', s.ix + s.iw - 1, bottom);
      windows.push({ x: (s.ix + 3) * T + 2, y: s.y * T + 10, frame: true });
      for (const [x, yy] of [
        [s.ix + 2, s.iy + 1],
        [s.ix + 4, s.iy + 1],
        [s.ix + 6, s.iy + 1],
        [s.ix + 8, s.iy + 2],
        [s.ix + 11, s.iy + 2],
        [s.ix + 9, s.iy + 3],
        [s.ix + 10, s.iy + 1],
        [s.ix + 6, s.iy + 3],
        [s.ix + 11, bottom - 1],
        [s.ix + 12, s.iy + 1],
      ]) {
        const onSofa = sofa.some((p) => p.stand.x === x && p.stand.y === yy);
        if (grid[yy] && grid[yy][x] === 1 && !onSofa) spots.push({ x, y: yy });
      }
    }
  }

  // A entrada: o caminho de pedra do jardim até o corredor em pé, na altura do
  // primeiro corredor deitado; o meio dele é a porta da rua.
  const entranceY = placed[0].corridorY + Math.floor(CORRIDOR / 2);
  const porch = new Set();
  for (let x = 0; x < MARGIN; x++) {
    set(x, entranceY, 1);
    porch.add(`${x},${entranceY}`);
  }
  // A parede de fora: todo tile do jardim colado (de lado ou na diagonal) num corredor.
  const hall = (x, yy) => yy >= 0 && yy < rows && x >= 0 && x < cols && grid[yy][x] === 1 && !porch.has(`${x},${yy}`);
  const outer = [];
  for (let yy = 0; yy < rows; yy++) {
    for (let x = 0; x < cols; x++) {
      if (grid[yy][x] !== 0) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) near = hall(x + dx, yy + dy) && !insideRoom(placed, x + dx, yy + dy);
      if (near) outer.push({ x, y: yy });
    }
  }
  for (const o of outer) set(o.x, o.y, 2);

  // As árvores e moitas do jardim, sempre nos mesmos lugares pra mesma planta.
  const garden = [];
  const free = (x, yy) => yy >= 0 && yy < rows && x >= 0 && x < cols && grid[yy][x] === 0;
  const taken = new Set();
  for (let yy = 0; yy < rows; yy++) {
    for (let x = 0; x < cols; x++) {
      if (!free(x, yy) || taken.has(`${x},${yy}`)) continue;
      const h = hash(`${x}:${yy}:${cols}`);
      if (h % 9 === 0 && free(x + 1, yy) && free(x, yy + 1) && free(x + 1, yy + 1) && !taken.has(`${x + 1},${yy}`)) {
        garden.push({ kind: 'tree', x, y: yy });
        for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) taken.add(`${x + dx},${yy + dy}`);
      } else if (h % 7 === 0) {
        garden.push({ kind: h % 2 ? 'bush' : 'flowers', x, y: yy });
        taken.add(`${x},${yy}`);
      }
    }
  }

  // Os lugares de visita que caíram num móvel (a estante, um vaso) não valem.
  if (home) home.visit = home.visit.filter((t) => grid[t.y] && grid[t.y][t.x] === 1);

  const entrance = { x: 0, y: entranceY };

  // Um móvel arrastado não pode fechar caminho nenhum: se alguma mesa, lugar
  // ou porta ficou sem caminho da rua, a planta sai com tudo no lugar de sempre.
  if (Object.keys(decor).length) {
    const must = [
      ...desks.flatMap((dk) => [dk.seat, dk.talk]),
      ...spots,
      ...sofa.map((p) => p.stand),
      ...(home ? [home.seat] : []),
      ...(meetingPlan ? meetingPlan.seats.map((st) => st.tile) : []),
      ...placed.map((r) => ({ x: r.door.x, y: r.door.y })),
    ];
    if (!reachesAll({ cols, rows, grid }, entrance, must)) return layout(rooms, { office, theme, meeting, decor: {} });
  }

  // As vagas de cada sala: as livres e as que têm um móvel que dá pra arrastar
  // (soltar um em cima do outro troca os dois de lugar).
  const movableAt = new Set(decorItems.map((m) => `${m.x},${m.y}`));
  const freeSlots = slots.filter((v) => grid[v.y][v.x] === 1 || movableAt.has(`${v.x},${v.y}`));

  return {
    theme: THEMES[theme] ? theme : 'classico',
    meeting: meetingPlan,
    decor: decorItems,
    slots: freeSlots,
    cols,
    rows,
    grid,
    rooms: placed,
    desks,
    spots,
    sofa,
    windows,
    boards,
    home,
    furniture,
    rugs,
    garden,
    porch: [...porch].map((k) => k.split(',').map(Number)),
    entrance,
    corridor: { x: MARGIN, y: MARGIN, w: CORRIDOR, bottom: y, right: left + inner, rows: corridors },
    width: cols * T,
    height: rows * T,
  };
}

/**
 * As vagas de decoração de uma sala de repositório (ou da sua): as colunas das
 * pontas e a fileira de baixo, longe da porta -- os corredores de dentro da
 * sala continuam livres com qualquer coisa nelas. `dx`/`dy` são do canto de
 * dentro da sala, pra valer mesmo quando a planta muda.
 */
function decorSlots(s, out) {
  s.slots = [];
  s.used = new Set(['0,0']); // a estante
  const doorL = s.door.x - s.ix;
  const doorR = doorL + s.door.w - 1;
  const add = (dx, dy) => {
    if (s.slots.some((v) => v.dx === dx && v.dy === dy) || (dx === 0 && dy === 0)) return;
    s.slots.push({ dx, dy });
  };
  for (let dy = 0; dy < s.ih; dy++) {
    add(0, dy);
    add(s.iw - 1, dy);
  }
  for (let dx = 1; dx < s.iw - 1; dx++) if (dx < doorL - 1 || dx > doorR + 1) add(dx, s.ih - 1);
  for (const v of s.slots) out.push({ room: s.id, dx: v.dx, dy: v.dy, x: s.ix + v.dx, y: s.iy + v.dy });
}

/** Todos os tiles de [must] têm caminho a partir de [from]? */
function reachesAll(plan, from, must) {
  const seen = new Set([`${from.x},${from.y}`]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: p.x + dx, y: p.y + dy };
      const k = `${n.x},${n.y}`;
      if (seen.has(k) || !walkable(plan, n.x, n.y)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return must.every((t) => seen.has(`${t.x},${t.y}`));
}

/** O tile está dentro de uma sala (paredes inclusive)? */
function insideRoom(rooms, x, y) {
  return rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

/** As salas em faixas de no máximo [max] tiles, na ordem. */
function bandsOf(specs, max) {
  const bands = [];
  let band = [];
  let width = 0;
  for (const s of specs) {
    const w = s.iw + 2;
    if (band.length && width + w > max) {
      bands.push(band);
      band = [];
      width = 0;
    }
    band.push(s);
    width += w;
  }
  if (band.length) bands.push(band);
  return bands;
}

/** A divisão em faixas que fica mais perto de [ASPECT] e desperdiça menos. */
function bestBands(specs) {
  const widths = specs.map((s) => s.iw + 2);
  const total = widths.reduce((a, b) => a + b, 0);
  let best = null;
  for (let max = Math.max(...widths); max <= total; max++) {
    const bands = bandsOf(specs, max);
    const bandW = bands.map((b) => b.reduce((n, s) => n + s.iw + 2, 0));
    const inner = Math.max(...bandW);
    const cols = 2 * MARGIN + CORRIDOR + inner;
    const rows = 2 * MARGIN + bands.reduce((n, b) => n + Math.max(...b.map((s) => s.ih)) + 3 + CORRIDOR, 0);
    const holes = bands.reduce((n, b, i) => n + (inner - bandW[i]) * (Math.max(...b.map((s) => s.ih)) + 3), 0);
    const score = Math.abs(Math.log(cols / rows / ASPECT)) + holes / (cols * rows);
    if (!best || score < best.score - 1e-9) best = { score, bands };
  }
  return best.bands;
}

/** Dá pra pisar no tile? */
function walkable(plan, x, y) {
  return y >= 0 && y < plan.rows && x >= 0 && x < plan.cols && plan.grid[y][x] === 1;
}

/**
 * O caminho mais curto de [from] até [to] (busca em largura, sem diagonal):
 * a lista de tiles depois de [from], até [to] inclusive. Vazia se já está lá;
 * `null` se não há como chegar.
 */
function path(plan, from, to) {
  if (from.x === to.x && from.y === to.y) return [];
  const key = (x, y) => y * plan.cols + x;
  const prev = new Map([[key(from.x, from.y), -1]]);
  const queue = [[from.x, from.y]];
  // O destino pode ser um tile que não é chão (a cadeira é, mas por via das
  // dúvidas): chegar ao lado dele vale.
  const goal = key(to.x, to.y);
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      const k = key(nx, ny);
      if (prev.has(k)) continue;
      if (k !== goal && !walkable(plan, nx, ny)) continue;
      if (nx < 0 || ny < 0 || nx >= plan.cols || ny >= plan.rows) continue;
      prev.set(k, key(x, y));
      if (k === goal) {
        const out = [];
        for (let at = k; at !== key(from.x, from.y); at = prev.get(at)) {
          out.push({ x: at % plan.cols, y: Math.floor(at / plan.cols) });
        }
        return out.reverse();
      }
      queue.push([nx, ny]);
    }
  }
  return null;
}

/**
 * O caminho em trechos retos: cada um com o tile de chegada, a direção e
 * quantos tiles anda. É o que vira uma animação só na janela.
 */
function segments(from, tiles) {
  const out = [];
  let at = from;
  for (const t of tiles) {
    const dir = t.x > at.x ? 'right' : t.x < at.x ? 'left' : t.y > at.y ? 'down' : 'up';
    const last = out[out.length - 1];
    if (last && last.dir === dir) {
      last.to = t;
      last.tiles++;
    } else {
      out.push({ to: t, dir, tiles: 1 });
    }
    at = t;
  }
  return out;
}

/** O tile livre mais perto de [at] (pra quem ficou num lugar que deixou de ser chão). */
function nearestFree(plan, at) {
  if (walkable(plan, at.x, at.y)) return at;
  const seen = new Set();
  const queue = [at];
  for (let i = 0; i < queue.length && i < 4000; i++) {
    const p = queue[i];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = { x: p.x + dx, y: p.y + dy };
      const k = `${n.x},${n.y}`;
      if (seen.has(k) || n.x < 0 || n.y < 0 || n.x >= plan.cols || n.y >= plan.rows) continue;
      seen.add(k);
      if (walkable(plan, n.x, n.y)) return n;
      queue.push(n);
    }
  }
  return plan.entrance;
}

// --- o desenho ---------------------------------------------------------------------

function rect(x, y, w, h, fill, opacity) {
  const o = opacity === undefined ? '' : ` fill-opacity="${opacity}"`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${o}/>`;
}

function floor(out, x, y, w, h, [a, b], planks = true) {
  out.push(rect(x * T, y * T, w * T, h * T, a));
  if (!planks) {
    // Ladrilho: um xadrez discreto.
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) if ((xx + yy) % 2) out.push(rect((x + xx) * T, (y + yy) * T, T, T, b));
    }
    return;
  }
  // Tábuas: uma linha a cada 4px, e as emendas desencontradas.
  for (let py = y * T + 3; py < (y + h) * T; py += 4) {
    out.push(rect(x * T, py, w * T, 1, b));
    const row = Math.floor((py - y * T) / 4);
    for (let px = x * T + ((row * 11) % 24); px < (x + w) * T; px += 24) out.push(rect(px, py - 3, 1, 3, b));
  }
}

/** Um tapete: o fundo, a barra de dentro e a franja das pontas. */
function rug(out, r) {
  const [base, dark, line] = r.colors;
  out.push(rect(r.x, r.y, r.w, r.h, dark));
  out.push(rect(r.x + 2, r.y + 2, r.w - 4, r.h - 4, base));
  out.push(rect(r.x + 5, r.y + 5, r.w - 10, 1, line));
  out.push(rect(r.x + 5, r.y + r.h - 6, r.w - 10, 1, line));
  out.push(rect(r.x + 5, r.y + 5, 1, r.h - 10, line));
  out.push(rect(r.x + r.w - 6, r.y + 5, 1, r.h - 10, line));
  for (let fx = r.x + 2; fx < r.x + r.w - 2; fx += 3) {
    out.push(rect(fx, r.y - 2, 1, 2, line, 0.7));
    out.push(rect(fx, r.y + r.h, 1, 2, line, 0.7));
  }
}

function desk(out, d) {
  const x = d.x * T;
  const y = d.y * T;
  // A sombra, o tampo, a frente e os pés.
  out.push(rect(x + 2, y + 14, 30, 3, '#000000', 0.18));
  out.push(rect(x + 1, y + 2, 30, 9, P.desk[0]));
  out.push(rect(x + 1, y + 2, 30, 2, P.desk[1]));
  out.push(rect(x + 1, y + 11, 30, 3, P.desk[2]));
  out.push(rect(x + 2, y + 14, 2, 2, P.desk[3]));
  out.push(rect(x + 28, y + 14, 2, 2, P.desk[3]));
  // O monitor, de frente pra cadeira: a moldura e o pé (a tela acende por cima,
  // nos dados, quando o claude está trabalhando).
  out.push(rect(x + 8, y - 7, 16, 11, '#232330'));
  out.push(rect(x + 9, y - 6, 14, 8, '#2c3140'));
  out.push(rect(x + 14, y + 4, 4, 2, '#232330'));
  // O teclado e uma caneca.
  out.push(rect(x + 10, y + 7, 12, 3, '#d8d8e0'));
  out.push(rect(x + 10, y + 9, 12, 1, '#a9a9b6'));
  out.push(rect(x + 25, y + 5, 3, 4, '#e8e8ee'));
  // A cadeira, embaixo: o encosto e o assento aparecem entre as pernas de quem sentar.
  out.push(rect(x + 10, y + T + 3, 12, 6, P.chair[0]));
  out.push(rect(x + 9, y + T + 9, 14, 4, P.chair[1]));
  out.push(rect(x + 9, y + T + 9, 14, 1, P.chair[2]));
  out.push(rect(x + 15, y + T + 13, 2, 2, P.chair[3]));
  out.push(rect(x + 11, y + T + 15, 10, 1, P.chair[3]));
}

/**
 * Um vaso. [stage] é o quanto a planta cresceu (0 a 4) -- nas salas dos
 * repositórios, com os commits da última semana: um broto, uma muda, a planta
 * de sempre, uma moita alta e, com muito commit, florida.
 */
function plant(out, x, y, stage = 2) {
  const px = x * T;
  const py = y * T;
  out.push(rect(px + 3, py + 14, 10, 2, '#000000', 0.2));
  out.push(rect(px + 4, py + 10, 8, 6, '#a0553a'));
  out.push(rect(px + 4, py + 10, 8, 1, '#7d412c'));
  if (stage <= 0) {
    out.push(rect(px + 5, py + 9, 6, 1, '#5b3b2a'));
    out.push(rect(px + 7, py + 5, 2, 4, '#4fa65f'));
    out.push(rect(px + 5, py + 5, 2, 2, '#6cc27a'));
    out.push(rect(px + 9, py + 4, 2, 2, '#6cc27a'));
    return;
  }
  if (stage === 1) {
    out.push(rect(px + 5, py + 4, 6, 6, '#3f8f4f'));
    out.push(rect(px + 4, py + 6, 2, 3, '#357a43'));
    out.push(rect(px + 10, py + 5, 2, 3, '#357a43'));
    out.push(rect(px + 7, py + 2, 2, 3, '#4fa65f'));
    out.push(rect(px + 7, py + 3, 1, 1, '#6cc27a'));
    return;
  }
  out.push(rect(px + 3, py + 2, 10, 8, '#3f8f4f'));
  out.push(rect(px + 5, py - 2, 6, 5, '#4fa65f'));
  out.push(rect(px + 2, py + 5, 3, 3, '#357a43'));
  out.push(rect(px + 11, py + 4, 3, 3, '#357a43'));
  out.push(rect(px + 6, py - 1, 2, 2, '#6cc27a'));
  if (stage >= 3) {
    // A moita passa da altura do vaso e abre pros lados.
    out.push(rect(px + 4, py - 7, 8, 6, '#3f8f4f'));
    out.push(rect(px + 6, py - 10, 4, 4, '#4fa65f'));
    out.push(rect(px + 1, py, 3, 5, '#357a43'));
    out.push(rect(px + 12, py - 2, 3, 5, '#357a43'));
    out.push(rect(px + 9, py - 6, 2, 2, '#6cc27a'));
  }
  if (stage >= 4) {
    for (const [fx, fy, c] of [[5, -8, '#e88aa8'], [10, -4, '#f2d15c'], [3, 2, '#e88aa8'], [12, 1, '#f4f1e8'], [8, -11, '#f2d15c']]) {
      out.push(rect(px + fx, py + fy, 2, 2, c));
    }
  }
}

function furniture(out, f) {
  const x = f.x * T;
  const y = f.y * T;
  if (f.kind === 'counter') {
    out.push(rect(x, y - 2, f.w * T, 14, '#cfc6b8'));
    out.push(rect(x, y - 2, f.w * T, 2, '#e2dacd'));
    out.push(rect(x, y + 12, f.w * T, 4, '#9c9386'));
    for (let k = 1; k < f.w; k++) out.push(rect(x + k * T, y + 12, 1, 4, '#8a8276'));
    // A cafeteira, as canecas e o micro-ondas.
    out.push(rect(x + 4, y - 10, 12, 16, '#3a3a44'));
    out.push(rect(x + 6, y - 8, 8, 5, '#c94f3d'));
    out.push(rect(x + 8, y + 2, 4, 3, '#f1f1f4'));
    out.push(rect(x + 22, y + 2, 4, 5, '#e9c46a'));
    out.push(rect(x + 28, y + 2, 4, 5, '#6aa5e9'));
    out.push(rect(x + 42, y - 8, 18, 13, '#f0f0f3'));
    out.push(rect(x + 44, y - 6, 11, 8, '#2c3140'));
    out.push(rect(x + 56, y - 5, 2, 2, '#7dd3a0'));
  } else if (f.kind === 'cooler') {
    out.push(rect(x + 3, y + 14, 10, 2, '#000000', 0.2));
    out.push(rect(x + 4, y - 12, 8, 10, '#a9d8f2'));
    out.push(rect(x + 5, y - 11, 2, 7, '#d6eefa'));
    out.push(rect(x + 3, y - 2, 10, 18, '#e9e9ef'));
    out.push(rect(x + 5, y + 4, 2, 2, '#3b82c4'));
    out.push(rect(x + 9, y + 4, 2, 2, '#d24b4b'));
  } else if (f.kind === 'arcade') {
    // O fliperama, encostado na parede.
    out.push(rect(x + 1, y + 14, 14, 2, '#000000', 0.2));
    out.push(rect(x + 1, y - 14, 14, 30, '#3a2f5c'));
    out.push(rect(x + 1, y - 14, 14, 4, '#e05b8b'));
    out.push(rect(x + 3, y - 8, 10, 8, '#1d2436'));
    out.push(rect(x + 4, y - 7, 8, 6, '#3fb6c9', 0.8));
    out.push(rect(x + 2, y + 2, 12, 4, '#4b3f73'));
    out.push(rect(x + 4, y + 3, 2, 2, '#f2d15c'));
    out.push(rect(x + 9, y + 3, 2, 2, '#e05b5b'));
    out.push(rect(x + 11, y + 3, 2, 2, '#5bb0e0'));
  } else if (f.kind === 'sofa') {
    const w = f.w * T;
    out.push(rect(x - 1, y + 13, w + 2, 3, '#000000', 0.2));
    out.push(rect(x, y - 4, w, 8, P.sofa[0]));
    out.push(rect(x, y + 4, w, 9, P.sofa[1]));
    out.push(rect(x, y + 4, w, 1, P.sofa[2]));
    out.push(rect(x - 2, y - 2, 4, 15, P.sofa[3]));
    out.push(rect(x + w - 2, y - 2, 4, 15, P.sofa[3]));
    for (let k = 1; k < f.w; k++) out.push(rect(x + k * T, y + 4, 1, 8, P.sofa[0]));
    // Uma almofada.
    out.push(rect(x + 3, y - 1, 7, 6, '#e9c46a'));
  } else if (f.kind === 'coffee') {
    // A mesinha de centro, do lado do sofá, com um livro e uma xícara.
    out.push(rect(x + 2, y + 13, 12, 2, '#000000', 0.2));
    out.push(rect(x + 2, y + 3, 12, 9, '#8a5a3b'));
    out.push(rect(x + 2, y + 3, 12, 2, '#a36d48'));
    out.push(rect(x + 3, y + 12, 2, 3, '#6b4429'));
    out.push(rect(x + 11, y + 12, 2, 3, '#6b4429'));
    out.push(rect(x + 4, y + 5, 5, 4, '#c94f3d'));
    out.push(rect(x + 10, y + 5, 2, 3, '#f1f1f4'));
  } else if (f.kind === 'table') {
    // A mesa redonda, com os dois banquinhos.
    const w = f.w * T;
    out.push(rect(x + 3, y + 13, w - 6, 3, '#000000', 0.2));
    out.push(rect(x + 4, y + 2, w - 8, 11, '#8a5a3b'));
    out.push(rect(x + 2, y + 4, w - 4, 7, '#8a5a3b'));
    out.push(rect(x + 4, y + 2, w - 8, 2, '#a36d48'));
    out.push(rect(x + 14, y + 13, 4, 3, '#6b4429'));
    out.push(rect(x + 9, y + 5, 3, 3, '#f1f1f4'));
    out.push(rect(x + 18, y + 6, 6, 3, '#e3b45b'));
    out.push(rect(x - 10, y + 6, 8, 6, '#c94f3d'));
    out.push(rect(x - 9, y + 12, 2, 4, '#6b4429'));
    out.push(rect(x + w + 2, y + 6, 8, 6, '#c94f3d'));
    out.push(rect(x + w + 7, y + 12, 2, 4, '#6b4429'));
  } else if (f.kind === 'shelf') {
    // A estante de livros, encostada na parede.
    out.push(rect(x + 1, y + 14, 14, 2, '#000000', 0.2));
    out.push(rect(x + 1, y - 14, 14, 30, '#6b4429'));
    out.push(rect(x + 2, y - 13, 12, 28, '#4a2f1d'));
    const books = ['#c94f3d', '#e9c46a', '#5b8fd1', '#6aa36f', '#9f85b3', '#e8e8ee'];
    for (let r = 0; r < 3; r++) {
      const sy = y - 12 + r * 9;
      out.push(rect(x + 2, sy + 7, 12, 2, '#6b4429'));
      for (let k = 0; k < 4; k++) {
        const c = books[(f.x * 3 + f.y + r * 2 + k) % books.length];
        out.push(rect(x + 3 + k * 3, sy + 1 + ((k + r) % 2), 2, 6 - ((k + r) % 2), c));
      }
    }
  } else if (f.kind === 'lamp') {
    // O abajur de pé.
    out.push(rect(x + 4, y + 14, 8, 2, '#000000', 0.2));
    out.push(rect(x + 7, y - 2, 2, 16, '#3a3a44'));
    out.push(rect(x + 5, y + 13, 6, 2, '#3a3a44'));
    out.push(rect(x + 3, y - 8, 10, 7, '#f3dfa6'));
    out.push(rect(x + 3, y - 2, 10, 1, '#d7bf82'));
  } else if (f.kind === 'plant') {
    plant(out, f.x, f.y, f.stage === undefined ? 2 : f.stage);
  } else if (f.kind === 'meeting') {
    // A mesa de reunião: o tampo comprido, os papéis, o notebook e as
    // cadeiras -- as de baixo de costas, as de cima atrás de quem senta.
    const w = f.w * T;
    for (let k = 0; k < f.w; k++) {
      chair(out, x + k * T, y + 2 * T + 2, 'back');
      chair(out, x + k * T, y - T + 1, 'front');
    }
    out.push(rect(x + 1, y + 2 * T - 2, w - 2, 3, '#000000', 0.18));
    out.push(rect(x, y + 2, w, 2 * T - 6, P.desk[0]));
    out.push(rect(x, y + 2, w, 2, P.desk[1]));
    out.push(rect(x, y + 2 * T - 6, w, 3, P.desk[2]));
    out.push(rect(x + 6, y + 8, 8, 6, '#f4f1e8'));
    out.push(rect(x + 7, y + 10, 6, 1, '#8b8799'));
    out.push(rect(x + 22, y + 7, 12, 8, '#2c3140'));
    out.push(rect(x + 23, y + 8, 10, 5, '#4fb3e8', 0.8));
    out.push(rect(x + 42, y + 12, 9, 6, '#f4f1e8'));
    out.push(rect(x + 43, y + 14, 6, 1, '#8b8799'));
    out.push(rect(x + 56, y + 9, 3, 4, '#e8e8ee'));
  }
}

/** Uma cadeira de reunião vista de cima: de costas (o encosto embaixo) ou de frente. */
function chair(out, x, y, side) {
  if (side === 'back') {
    out.push(rect(x + 3, y + 3, 10, 5, P.chair[1]));
    out.push(rect(x + 3, y + 8, 10, 4, P.chair[0]));
    out.push(rect(x + 3, y + 8, 10, 1, P.chair[2]));
  } else {
    out.push(rect(x + 3, y + 2, 10, 4, P.chair[0]));
    out.push(rect(x + 3, y + 2, 10, 1, P.chair[2]));
    out.push(rect(x + 3, y + 6, 10, 5, P.chair[1]));
  }
}

/** O lado de fora: o jardim (grama, árvores, moitas e flores) ou o espaço. */
function gardenItem(out, g) {
  const x = g.x * T;
  const y = g.y * T;
  if (P.outside === 'space') {
    if (g.kind === 'tree' && (g.x + g.y) % 3) {
      // Uma pedra grande, flutuando.
      out.push(rect(x + 8, y + 8, 12, 9, '#5d5d6b'));
      out.push(rect(x + 10, y + 6, 8, 13, '#5d5d6b'));
      out.push(rect(x + 11, y + 9, 3, 3, '#45454f'));
      out.push(rect(x + 16, y + 13, 2, 2, '#45454f'));
      out.push(rect(x + 10, y + 7, 4, 1, '#7a7a88'));
    } else if (g.kind === 'tree') {
      // Um planeta com anel.
      const hue = ['#c97b5b', '#6aa5e9', '#9f85b3', '#e0b443'][(g.x + g.y) % 4];
      out.push(rect(x + 8, y + 4, 16, 16, hue));
      out.push(rect(x + 6, y + 7, 20, 10, hue));
      out.push(rect(x + 10, y + 6, 6, 3, '#ffffff', 0.35));
      out.push(rect(x + 1, y + 12, 30, 2, '#e9e3d2', 0.8));
      out.push(rect(x + 8, y + 17, 16, 3, '#000000', 0.25));
    } else if (g.kind === 'bush') {
      // Um asteroide.
      out.push(rect(x + 4, y + 5, 8, 6, '#6b6b78'));
      out.push(rect(x + 5, y + 4, 5, 8, '#6b6b78'));
      out.push(rect(x + 6, y + 6, 2, 2, '#4a4a55'));
      out.push(rect(x + 9, y + 8, 2, 1, '#4a4a55'));
    } else {
      // Uma estrela brilhando.
      const sx = x + 4 + ((g.x * 5) % 8);
      const sy = y + 4 + ((g.y * 3) % 8);
      out.push(rect(sx, sy - 2, 1, 5, '#f6e7a1'));
      out.push(rect(sx - 2, sy, 5, 1, '#f6e7a1'));
      out.push(rect(sx, sy, 1, 1, '#ffffff'));
    }
    return;
  }
  if (g.kind === 'tree') {
    out.push(rect(x + 4, y + 24, 24, 6, '#000000', 0.18));
    out.push(rect(x + 13, y + 16, 6, 12, '#6b4429'));
    out.push(rect(x + 4, y + 2, 24, 16, '#3d6e3f'));
    out.push(rect(x + 7, y - 3, 18, 6, '#3d6e3f'));
    out.push(rect(x + 2, y + 6, 4, 9, '#3d6e3f'));
    out.push(rect(x + 26, y + 6, 4, 9, '#3d6e3f'));
    out.push(rect(x + 9, y, 9, 6, '#5a9358'));
    out.push(rect(x + 6, y + 5, 6, 4, '#5a9358'));
    out.push(rect(x + 18, y + 14, 8, 3, '#335e36'));
  } else if (g.kind === 'bush') {
    out.push(rect(x + 2, y + 12, 12, 3, '#000000', 0.15));
    out.push(rect(x + 2, y + 5, 12, 9, '#3f7442'));
    out.push(rect(x + 4, y + 3, 8, 3, '#3f7442'));
    out.push(rect(x + 5, y + 4, 4, 3, '#5a9358'));
  } else {
    const colors = ['#f2d15c', '#e88aa8', '#f4f1e8'];
    for (let k = 0; k < 3; k++) {
      const fx = x + 3 + ((k * 5 + g.x) % 10);
      const fy = y + 3 + ((k * 7 + g.y) % 10);
      out.push(rect(fx, fy + 2, 1, 2, '#3f7442'));
      out.push(rect(fx - 1, fy, 3, 2, colors[(g.x + g.y + k) % colors.length]));
    }
  }
}

/** A moldura de uma janela; o vidro (20×12, um pixel pra dentro) é pintado por cima, com a cor da hora. */
function windowFrame(out, w) {
  out.push(rect(w.x - 2, w.y - 2, 24, 16, '#2f2a40'));
  out.push(rect(w.x, w.y, 20, 12, '#8fc7e8'));
  out.push(rect(w.x - 3, w.y + 13, 26, 2, '#e2dacd'));
}

/** O quadro branco: a moldura e o branco; o que está escrito vem por cima. */
function board(out, b) {
  out.push(rect(b.x - 1, b.y - 1, b.w + 2, b.h + 2, '#8b8fa3'));
  out.push(rect(b.x, b.y, b.w, b.h, '#f4f5f8'));
  out.push(rect(b.x + 4, b.y + b.h + 1, b.w - 8, 2, '#8b8fa3'));
  out.push(rect(b.x + b.w - 14, b.y + b.h, 4, 1, '#d24b4b'));
  out.push(rect(b.x + b.w - 9, b.y + b.h, 4, 1, '#3b82c4'));
}

function wallDecor(out, s) {
  const y = s.y * T;
  if (s.kind === 'room') {
    // Entre as janelas e o quadro branco, um mural de cortiça com bilhetes.
    const cx = s.ix * T + 168;
    out.push(rect(cx, y + 9, 30, 18, '#7d5a3c'));
    out.push(rect(cx + 1, y + 10, 28, 16, '#c79a68'));
    out.push(rect(cx + 4, y + 12, 7, 6, '#f2d15c'));
    out.push(rect(cx + 13, y + 13, 7, 7, '#e88aa8'));
    out.push(rect(cx + 21, y + 12, 6, 6, '#9fd3f0'));
    out.push(rect(cx + 6, y + 19, 8, 5, '#f4f1e8'));
    out.push(rect(cx + 18, y + 21, 7, 4, '#b5e3a1'));
  } else if (s.kind === 'meeting') {
    // A tela da sala de reunião, no meio da parede.
    const tx = (s.ix + Math.floor((s.iw - 4) / 2)) * T + 8;
    out.push(rect(tx, y + 7, 48, 22, '#1d2030'));
    out.push(rect(tx + 2, y + 9, 44, 17, '#2c3a5a'));
    out.push(rect(tx + 5, y + 12, 18, 2, '#9fd3f0'));
    out.push(rect(tx + 5, y + 16, 26, 1, '#8b9bc0'));
    out.push(rect(tx + 5, y + 19, 22, 1, '#8b9bc0'));
    out.push(rect(tx + 34, y + 14, 3, 9, '#6cc483'));
    out.push(rect(tx + 38, y + 11, 3, 12, '#eec05a'));
    out.push(rect(tx + 22, y + 29, 4, 2, '#1d2030'));
  } else if (s.kind === 'office') {
    // Na sua sala, um quadro (a montanha) e um diploma, à direita da janela.
    const px = (s.ix + 3) * T + 6;
    out.push(rect(px, y + 9, 24, 16, '#4a3a5c'));
    out.push(rect(px + 1, y + 10, 22, 14, '#9fd3f0'));
    out.push(rect(px + 4, y + 16, 8, 8, '#6aa36f'));
    out.push(rect(px + 9, y + 13, 10, 11, '#4f7d4a'));
    out.push(rect(px + 12, y + 13, 3, 3, '#f4f1e8'));
    const dx = (s.ix + 5) * T + 10;
    out.push(rect(dx, y + 11, 16, 13, '#c9a36b'));
    out.push(rect(dx + 1, y + 12, 14, 11, '#f4f1e8'));
    out.push(rect(dx + 3, y + 14, 10, 1, '#8b8799'));
    out.push(rect(dx + 3, y + 17, 8, 1, '#8b8799'));
    out.push(rect(dx + 10, y + 19, 3, 3, '#d24b4b'));
  } else {
    // Na sala do descanso, um relógio e um quadro.
    const cx = (s.ix + 7) * T + 6;
    out.push(rect(cx, y + 11, 12, 12, '#2f2a40'));
    out.push(rect(cx + 1, y + 12, 10, 10, '#f4f1e8'));
    out.push(rect(cx + 5, y + 13, 1, 5, '#2f2a40'));
    out.push(rect(cx + 5, y + 17, 4, 1, '#2f2a40'));
    const px = (s.ix + 9) * T + 2;
    out.push(rect(px, y + 9, 26, 16, '#5c4a3a'));
    out.push(rect(px + 1, y + 10, 24, 14, '#e7b96a'));
    out.push(rect(px + 1, y + 17, 24, 7, '#6aa36f'));
    out.push(rect(px + 15, y + 11, 6, 6, '#f6e7a1'));
  }
}

/** Uma parede vista de cima: o bloco escuro com a borda clara de dentro. */
function wallBlock(out, x, y, w, h) {
  out.push(rect(x * T, y * T, w * T, h * T, P.wall.side));
}

/** O fundo inteiro num svg: o jardim, o chão, as paredes, as mesas e os móveis. */
function svg(plan, { growth = {} } = {}) {
  P = themeOf(plan.theme);
  const out = [];
  // O jardim: a grama inteira, com tufos aqui e ali.
  out.push(rect(0, 0, plan.width, plan.height, P.grass[0]));
  for (let yy = 0; yy < plan.rows; yy++) {
    for (let xx = 0; xx < plan.cols; xx++) {
      const h = hash(`${xx}/${yy}`);
      if ((xx + yy) % 2) out.push(rect(xx * T, yy * T, T, T, P.grass[1]));
      if (h % 3 === 0) out.push(rect(xx * T + (h % 11) + 2, yy * T + ((h >> 4) % 11) + 2, 1, P.outside === 'space' ? 1 : 2, P.grass[2]));
    }
  }
  // O caminho de pedra até a porta da rua.
  for (const [px, py] of plan.porch) {
    out.push(rect(px * T, py * T, T, T, P.porch[0]));
    out.push(rect(px * T + 1, py * T + 1, 6, 6, P.porch[1]));
    out.push(rect(px * T + 9, py * T + 2, 6, 5, P.porch[1]));
    out.push(rect(px * T + 2, py * T + 9, 5, 6, P.porch[1]));
    out.push(rect(px * T + 9, py * T + 9, 6, 6, P.porch[1]));
  }
  for (const g of plan.garden) gardenItem(out, g);
  // A parede de fora, em volta dos corredores.
  for (let yy = 0; yy < plan.rows; yy++) {
    for (let xx = 0; xx < plan.cols; xx++) {
      if (plan.grid[yy][xx] === 2 && !plan.rooms.some((r) => xx >= r.x && xx < r.x + r.w && yy >= r.y && yy < r.y + r.h)) wallBlock(out, xx, yy, 1, 1);
    }
  }
  // Os corredores: o ladrilho, e uma passadeira no meio.
  const c = plan.corridor;
  floor(out, c.x, c.y, c.w, c.bottom - c.y, P.corridor, false);
  for (const cy of c.rows) floor(out, c.x, cy, c.right - c.x, CORRIDOR, P.corridor, false);
  const mid = Math.floor(CORRIDOR / 2);
  const runner = (x, y, w, h) => {
    out.push(rect(x, y, w, h, P.runner[1]));
    out.push(rect(x + 2, y + 2, w - 4, h - 4, P.runner[0]));
  };
  runner((c.x + mid) * T + 2, c.y * T + 6, T - 4, (c.rows[c.rows.length - 1] + mid - c.y) * T - 2);
  for (const cy of c.rows) runner((c.x + mid) * T + 2, (cy + mid) * T + 2, (c.right - c.x - mid - 1) * T + T - 6, T - 4);
  for (const s of plan.rooms) {
    const x = s.x * T;
    const y = s.y * T;
    // A parede: o topo, a face (duas de altura) e o rodapé; as laterais e a
    // de baixo vistas de cima, finas.
    out.push(rect(x, y, s.w * T, s.h * T, P.wall.side));
    out.push(rect(x + T, y + 4, s.iw * T, T * 2 - 4, P.wall.face));
    for (let sx = x + T + 6; sx < x + T + s.iw * T; sx += 12) out.push(rect(sx, y + 8, 1, T * 2 - 12, P.wall.faceDark, 0.55));
    out.push(rect(x + T, y + T * 2 - 5, s.iw * T, 5, P.wall.base));
    out.push(rect(x + T, y + T * 2 - 5, s.iw * T, 1, P.wall.edge));
    out.push(rect(x + T, y + 4, s.iw * T, 2, P.wall.faceDark));
    floor(out, s.ix, s.iy, s.iw, s.ih, s.floor, s.kind === 'room' && P.planks);
    // A sombra da parede no chão.
    out.push(rect(s.ix * T, s.iy * T, s.iw * T, 3, '#000000', 0.22));
    out.push(rect(s.ix * T, s.iy * T, 2, s.ih * T, '#000000', 0.12));
    // A porta: o vão na parede de baixo, com a soleira e o batente.
    floor(out, s.door.x, s.door.y, s.door.w, 1, P.corridor, false);
    out.push(rect(s.door.x * T, s.door.y * T, s.door.w * T, 2, '#5d5470'));
    out.push(rect(s.door.x * T - 2, s.door.y * T, 2, T, P.wall.edge));
    out.push(rect((s.door.x + s.door.w) * T, s.door.y * T, 2, T, P.wall.edge));
    wallDecor(out, s);
  }
  // A porta da rua, no fim do caminho de pedra.
  const e = plan.porch[plan.porch.length - 1];
  out.push(rect(e[0] * T, e[1] * T, T, T, '#6b5a48'));
  out.push(rect(e[0] * T + 2, e[1] * T + 2, T - 4, T - 4, '#b5523d'));
  out.push(rect(e[0] * T + 4, e[1] * T + 4, T - 8, T - 8, '#c9694f'));
  out.push(rect(e[0] * T, e[1] * T - 3, T, 3, '#e0c070'));
  out.push(rect(e[0] * T, e[1] * T + T, T, 3, '#e0c070'));
  for (const r of plan.rugs) rug(out, r);
  for (const w of plan.windows) windowFrame(out, w);
  for (const b of plan.boards) board(out, b);
  for (const d of plan.desks) desk(out, d);
  if (plan.home) desk(out, plan.home.desk);
  // Os vasos das salas crescem com os commits; os de fora delas ficam como são.
  for (const f of plan.furniture) furniture(out, f.kind === 'plant' && growth[f.room] !== undefined ? { ...f, stage: growth[f.room] } : f);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.width}" height="${plan.height}" ` +
    `viewBox="0 0 ${plan.width} ${plan.height}" shape-rendering="crispEdges">` +
    out.join('') +
    '</svg>'
  );
}

/**
 * Um móvel sozinho num svg pequeno (o que voa com o cursor quando você o
 * arrasta): 16 de largura e 32 de altura, com o tile embaixo.
 */
function itemSvg(kind, { theme = 'classico', stage = 2 } = {}) {
  P = themeOf(theme);
  const out = [];
  furniture(out, { kind, x: 0, y: 1, w: 1, stage });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="32" viewBox="0 0 16 32" shape-rendering="crispEdges">${out.join('')}</svg>`;
}

/** Quantos commits da semana pra cada tamanho de vaso: 0, 1-2, 3-7, 8-19, 20+. */
function growthStage(commits) {
  const n = Number(commits) || 0;
  return n >= 20 ? 4 : n >= 8 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0;
}

module.exports = { T, layout, path, segments, walkable, nearestFree, svg, itemSvg, hash, growthStage, THEMES, THEME_IDS, themeOf };
