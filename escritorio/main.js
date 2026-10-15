// O escritório: os claudes da Maestria como bonequinhos de pixel art, cada um
// na sala do repositório em que trabalha -- como o Pixel Agents, numa tela da
// Maestria.
//
// O que cada boneco faz vem das sessões (`onSession`: abriu, mudou de status,
// fechou) e dos hooks do Claude Code (a permissão `hooks`: a ferramenta da vez,
// o pedido, o subagente que nasce e o que ele faz). A lógica toda está em
// `world.js`; aqui só se liga o mundo à janela:
//
// - a tela própria (`contributes.screen`) é a planta inteira, numa janela de
//   widgets (`ui/escritorio.rfwtxt`): o fundo num svg, as telas dos monitores e
//   os bonecos por cima;
// - quem anda, anda pela janela: o plugin manda "vá pra lá em tantos ms" e o
//   `Positioned` do rfw faz o caminho; os quadros da caminhada, da digitação e
//   do aceno são do `Sprite` da Maestria (`sprites: 1`), que anima sozinho. Numa
//   Maestria sem ele, o boneco é um bloquinho da cor da camisa;
// - a aba da lateral é a lista de quem está em cada sala;
// - clicar num boneco (ou numa linha da lateral) abre a janelinha de chat dele,
//   em modal por cima da planta: a conversa lida da transcrição do Claude Code
//   (`chat.js`) e um campo que manda a mensagem pro terminal dele
//   (`terminal.sendText`), sem sair do escritório. "Chamar um claude" (o botão
//   do topo, ou uma mesa vazia) abre uma sessão nova em segundo plano, e ela
//   entra pela porta.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const mx = require('./maestria');
const sprites = require('./sprites');
const { World, d, clip } = require('./world');
const office = require('./office');
const { Usage } = require('./usage');
const daily = require('./daily');
const wiboor = require('./wiboor');
const chat = require('./chat');
const { commandsFor } = require('./commands');

const VIEW = 'escritorio';
const SIDEBAR = 'sidebar';
const CHAT = 'chat';
const NOVO = 'novo';
const VOCE = 'voce';
const GRUPO = 'grupo';
const RECADOS = 'recados';
const DAILY = 'daily';
const FAST_MS = 60; // o relógio enquanto alguém anda
const SLOW_MS = 1000; // o relógio parado: os balões, o café, o papo
// Os níveis do zoom: quantos pixels da tela cada pixel da pixel art ocupa. Antes
// do primeiro vem o "caber" (0), em que a planta estica até caber na janela.
const ZOOMS = [1, 1.5, 2, 3, 4, 6];
const ZOOM_IN_FROM_FIT = 2; // o + a partir do "caber": quase sempre já aproxima
const ZOOM_MAX = 6; // no `ZoomView`, até quantas vezes o "caber"

const UI = fs.readFileSync(path.join(__dirname, 'ui', 'escritorio.rfwtxt'), 'utf8');
const SIDEBAR_UI = fs.readFileSync(path.join(__dirname, 'ui', 'sidebar.rfwtxt'), 'utf8');
const CHAT_UI = fs.readFileSync(path.join(__dirname, 'ui', 'chat.rfwtxt'), 'utf8');

const state = {
  rfw: false,
  sprites: false,
  settings: {},
  viewOpen: false,
  sidebarShown: false,
  sentScene: -1,
  look: {}, // o seu visual (o "personalizar você"), do prefs.json
  lookSent: 0, // esvazia o campo do nome depois de salvar
  lastView: {}, // o json de cada chave mandada à janela (ver `changedOnly`)
  lastSidebar: {}, // e à aba da lateral
  sidebarLibrary: false, // o texto da interface da aba já foi
  fast: null,
  slow: null,
  flushing: false,
  again: false,
  modal: false, // a Maestria abre janela em modal (`modal: 1`)
  background: false, // e abre um claude sem tirar você da tela (`openInBackground: 1`)
  dataDir: null,
  zoom: 0, // um dos ZOOMS, ou 0: caber na janela
  // A Maestria tem o `ZoomView` (`zoom: 1`): o zoom mora na janela (a bolinha,
  // o arrasto) e os botões daqui viram comandos pra ele. `scale` é o que ela
  // contou por último, em vezes o "caber".
  zoomView: false,
  zoomCmd: { command: '', rev: 0, scale: 1 },
  // A janelinha de chat aberta: de quem, o que foi mandado e ainda não apareceu
  // na transcrição, e o número que esvazia o campo depois de mandar.
  // `images`: quantos prints já foram pro prompt dele e ainda não seguiram.
  // `ask`: a pergunta aberta que dá pra responder daqui; `picks`, as opções já
  // clicadas dela (numa de várias, a lista das marcadas); `done`, as de várias
  // já confirmadas; `cursor`, a opção em destaque das setas (na primeira
  // pergunta sem escolha); `answered`, a última respondida (até a transcrição
  // contar).
  // `perm`: a permissão aberta que dá pra responder daqui; `answeredPerm`, a
  // última respondida (até o status mudar).
  chat: { open: false, tabId: null, sent: 0, pending: [], problem: '', timer: null, images: 0, naming: false, ask: null, picks: {}, done: {}, cursor: 0, answered: '', perm: null, answeredPerm: '' },
  markdown: false, // a Maestria tem o `Markdown` (`markdown: 1`)
  keys: false, // e o `terminal.sendKeys` (`keys: 1`), que responde as perguntas
  arrows: false, // e o `onArrow` do `TextInput` (`arrows: 1`): as setas andam pelas opções
  wake: false, // e acorda uma sessão pelo plugin (`wake: 1`)
  closeSessions: false, // e deixa o plugin fechar uma sessão do claude (`closeSessions: 1`)
  anchors: false, // e abre o modal a partir de um `Anchor` (`modalFrom: 1`)
  selectable: false, // e tem a área de seleção única (`selectable: 1`)
  rename: false, // e renomeia uma sessão pelo plugin (`rename: 1`)
  // O que foi pedido a um claude dormindo, por painel: espera ele acordar.
  queue: new Map(),
  // Os que estão acordando: do `session.wake` até o prompt voltar. Enquanto
  // isso, tudo que se pede a eles também espera na fila.
  waking: new Set(),
  pasteImage: false, // e o colar print (`pasteImage: 1`)
  themePref: null, // o tema escolhido na própria tela (vale mais que o das configurações)
  // Selecionando bonecos pra mandar a mesma mensagem a vários (o "selecionar"
  // do topo): quem está marcado, e o número que esvazia o campo da janelinha.
  selecting: false,
  selected: new Set(),
  groupSent: 0,
  groupProblem: '',
  portrait: false, // a Maestria põe o retrato do boneco na notificação (`portrait: 1`)
  // A daily: o resumo da vez (ou o que está sendo feito), a janelinha aberta,
  // a última daily que se reuniu sozinha e o último "bom dia".
  // [meet]: o resumo que está sendo escrito vai pra reunião; [saved]: os guardados.
  daily: { open: false, running: false, meet: false, mode: 'daily', period: null, summary: null, convs: [], previous: null, problem: '', note: '', saved: [] },
  dailyAuto: 0,
  morning: '',
  // `tabId`: o claude que a mesa já chamou (ver `prestart`), enquanto você escreve.
  novo: { open: false, folders: [], chosen: null, room: null, sent: 0, problem: '', images: 0, tabId: null, starting: null },
};

const world = new World({ settings: state.settings });

// --- a janela ---------------------------------------------------------------------

function head() {
  const c = world.counts();
  const total = c.working + c.waiting + c.resting;
  const chips = [];
  if (c.working) chips.push({ text: `${c.working} trabalhando`, color: 0xffd97757 });
  if (c.waiting) chips.push({ text: `${c.waiting} esperando você`, color: 0xffe5534b });
  if (c.resting) chips.push({ text: `${c.resting} à toa`, color: 0xff6cc483 });
  if (c.helpers) chips.push({ text: `${c.helpers} ${c.helpers === 1 ? 'ajudante' : 'ajudantes'}`, color: 0xff9b8fb5 });
  return {
    title: 'Escritório',
    sub: total
      ? `${total} ${total === 1 ? 'claude' : 'claudes'} · clique num boneco pra conversar, numa mesa vazia pra chamar outro`
      : 'nenhum claude aberto — chame um (o + aqui em cima) e ele entra pela porta',
    chips,
    // O menu do bicho, com a escolha da vez marcada.
    petMenu: [
      ...[
        ['gato', 'gato'],
        ['cachorro', 'cachorro'],
      ].map(([v, label]) => ({ label, action: `bicho:${v}`, icon: world.petChoice() === v ? 'check' : '' })),
      { divider: true },
      { label: 'nenhum bicho', action: 'bicho:nenhum', icon: world.petChoice() === 'nenhum' ? 'check' : '' },
    ],
    // O menu da paleta: o tema, e arrumar os móveis.
    themeMenu: [
      ...office.THEME_IDS.map((id) => ({ label: office.THEMES[id].label, action: `tema:${id}`, icon: world.theme === id ? 'check' : '' })),
      { divider: true },
      world.decorating
        ? { label: 'parar de arrumar os móveis', action: 'moveis', icon: 'check' }
        : { label: 'arrumar os móveis…', action: 'moveis', icon: 'edit' },
      { label: 'móveis no lugar de sempre', action: 'moveis:padrao', icon: 'undo' },
    ],
    decorating: world.decorating,
  };
}

/** Os dados da janela: a planta só quando mudou, o resto sempre. */
function viewData({ full = false } = {}) {
  const all = {
    head: head(),
    agents: world.agentsData({
      names: state.settings.names !== false,
      tools: state.settings.tools !== false,
      selecting: state.selecting,
      selected: state.selected,
    }),
    inbox: world.inboxData(),
    punch: world.punchData(),
    notes: world.notesData(),
    selection: selectionData(),
    door: world.doorData(),
    screens: world.screens(),
    boards: world.boards(),
    desks: world.desksData(),
    effects: world.effectsData(),
    light: world.lightData(),
    zoom: zoomData(),
    decor: decorData(),
  };
  if (full || state.sentScene !== world.sceneRevision) {
    all.scene = world.scene();
    all.labels = world.labels();
    all.windows = world.windows();
    all.sprites = state.sprites;
    all.anchors = state.anchors;
    state.sentScene = world.sceneRevision;
  }
  return changedOnly(state.lastView, all, full);
}

/**
 * Só as chaves que mudaram desde o último envio (todas, com [full]). A janela
 * guarda as que não vieram, e cada chave que chega é reaplicada e redesenhada
 * do lado de lá: mandar os quadros, as mesas e a luz de novo a cada passo de
 * um boneco era trabalho à toa dos dois lados. [last] guarda o json de cada uma.
 */
function changedOnly(last, all, full) {
  if (full) for (const k of Object.keys(last)) delete last[k];
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    const json = JSON.stringify(v);
    if (!full && last[k] === json) continue;
    last[k] = json;
    out[k] = v;
  }
  return out;
}

/** A barra da seleção, embaixo do topo: quantos estão marcados e o que dá pra fazer. */
function selectionData() {
  const n = state.selected.size;
  return {
    on: state.selecting,
    text: n ? `${n} ${n === 1 ? 'selecionado' : 'selecionados'}` : 'clique nos bonecos pra marcar quem recebe',
    canSend: n > 0,
  };
}

/** Os móveis arrastáveis: só mudam com a planta (o svg de cada um é caro de refazer a cada passo). */
let decorMemo = { key: '', data: null };
function decorData() {
  const key = `${world.decorating}|${world.sceneRevision}`;
  if (decorMemo.key !== key) decorMemo = { key, data: world.decorData() };
  return decorMemo.data;
}

/** O zoom da planta: caber, ou o tamanho dela no nível escolhido. */
function zoomData() {
  if (state.zoomView) {
    const { command, rev, scale } = state.zoomCmd;
    return {
      view: true,
      command,
      rev,
      maxScale: d(ZOOM_MAX),
      label: scale > 1.01 ? `${Math.round(scale * 100)}%` : 'caber',
      minimum: scale <= 1.01,
      maximum: scale >= ZOOM_MAX - 0.01,
    };
  }
  const z = state.zoom;
  return {
    view: false,
    fit: !z,
    scale: d(z || 1),
    w: d(world.plan.width * (z || 1)),
    h: d(world.plan.height * (z || 1)),
    label: z ? `${Math.round(z * 100)}%` : 'caber',
    minimum: !z,
    maximum: z === ZOOMS[ZOOMS.length - 1],
  };
}

/** O próximo nível do zoom pra [dir] ('+' ou '-'); 'caber' volta a caber. */
function nextZoom(dir) {
  const z = state.zoom;
  if (dir === 'caber') return 0;
  if (dir === '+') return z ? ZOOMS.find((v) => v > z) || z : ZOOM_IN_FROM_FIT;
  if (!z) return 0;
  const below = ZOOMS.filter((v) => v < z);
  return below.length ? below[below.length - 1] : 0;
}

async function open() {
  await sync({ snap: true });
  world.watching = state.rfw;
  world.snapAll();
  if (!state.rfw) {
    await mx.request('view.open', {
      viewId: VIEW,
      title: 'Escritório',
      blocks: [
        { type: 'text', text: 'O escritório precisa da Maestria com a interface em widgets (rfw). Atualize o app.' },
      ],
    });
    return;
  }
  state.sentScene = -1;
  state.zoomCmd.scale = 1; // a janela nova abre cabendo
  await mx.request('view.open', {
    viewId: VIEW,
    title: 'Escritório',
    rfw: { library: UI, root: 'root' },
    data: viewData({ full: true }),
  });
  state.viewOpen = true;
  world.sent();
  clock();
  goodMorning().catch((e) => mx.log('bom dia:', e.message));
}

/** Manda o que mudou pra janela e pra aba. Um envio por vez; o que chega no meio vai no próximo. */
async function flush() {
  if (state.flushing) {
    state.again = true;
    return;
  }
  state.flushing = true;
  try {
    do {
      state.again = false;
      if (state.viewOpen) {
        const data = viewData();
        // Nada mudou: nem incomoda a janela.
        const { open: still } = Object.keys(data).length
          ? await mx.request('view.update', { viewId: VIEW, data })
          : { open: true };
        if (!still) {
          state.viewOpen = false;
          world.watching = false;
          state.sentScene = -1;
        } else {
          world.sent();
        }
      }
      if (state.sidebarShown) await pushSidebarSoon();
    } while (state.again);
  } catch (e) {
    mx.log('flush:', String((e && e.stack) || e));
  } finally {
    state.flushing = false;
  }
  clock();
}

/**
 * A aba da lateral no máximo duas vezes por segundo: a linha de cada claude
 * diz a ferramenta da vez, que troca várias vezes por segundo, e ninguém lê a
 * lateral nesse ritmo. O que chega no meio vai no envio seguinte.
 */
const SIDEBAR_MS = 500;
let sidebarAt = 0;
let sidebarLater = null;
async function pushSidebarSoon() {
  const wait = sidebarAt + SIDEBAR_MS - Date.now();
  if (wait <= 0) {
    sidebarAt = Date.now();
    return pushSidebar();
  }
  if (!sidebarLater) {
    sidebarLater = setTimeout(() => {
      sidebarLater = null;
      if (state.sidebarShown) pushSidebarSoon().catch((e) => mx.log('sidebar:', e.message));
    }, wait);
  }
}

async function pushSidebar() {
  if (!state.rfw) {
    const blocks = [{ type: 'button', label: 'abrir o escritório', action: 'abrir' }];
    for (const r of world.roster()) {
      blocks.push({ type: 'section', title: r.name });
      blocks.push({
        type: 'list',
        flat: true,
        items: r.agents.map((a) => ({ title: a.name, subtitle: a.sub, action: a.action })),
      });
    }
    const { shown } = await mx.request('sidebar.update', { blocks, badge: badge() });
    state.sidebarShown = shown;
    return;
  }
  const b = badge();
  const data = changedOnly(
    state.lastSidebar,
    { rooms: world.roster(), counts: head().chips, empty: !world.roster().length, anchors: state.anchors },
    !state.sidebarLibrary,
  );
  // Nada mudou na aba nem no selo: não manda nada.
  if (state.sidebarLibrary && !Object.keys(data).length && b === lastBadge) return;
  const params = { data, badge: b };
  // O texto da interface vai uma vez; depois, só os dados.
  if (!state.sidebarLibrary) params.rfw = { library: SIDEBAR_UI, root: 'root' };
  const { shown } = await mx.request('sidebar.update', params);
  state.sidebarLibrary = true;
  lastBadge = b;
  state.sidebarShown = shown;
}

/** O selo do ícone: quantos estão esperando você. */
function badge() {
  const { waiting } = world.counts();
  return waiting ? String(waiting) : '';
}

let lastBadge = '';
async function updateBadge() {
  const b = badge();
  if (b === lastBadge || state.sidebarShown) return;
  lastBadge = b;
  try {
    await mx.request('sidebar.update', { badge: b });
  } catch (e) {
    mx.log('badge:', e.message);
  }
}

// --- o chat -----------------------------------------------------------------------

/** O claude dono da conversa de [tabId] (um ajudante leva à conversa de quem o chamou). */
function ownerOf(tabId) {
  return world.agents.get(tabId) || null;
}

function chatData() {
  const c = state.chat;
  const a = ownerOf(c.tabId);
  if (!a) {
    return {
      name: 'a sessão fechou',
      sub: '',
      status: 'saiu',
      dot: 0xff8b8799,
      sheet: '',
      rows: sprites.ROWS,
      row: 0,
      items: [],
      live: { text: 'ele saiu pela porta', bg: 0xffd9d5e4, fg: 0xff4a4458 },
      locked: true,
      hint: 'a sessão fechou',
      placeholder: '',
      problem: { on: false, text: '' },
      attached: { on: false, text: '' },
      allowEmpty: false,
      sent: c.sent,
      inputId: 'chat',
      canRename: false,
      naming: { on: false, id: 'nome' },
    };
  }
  const card = world.chatCard(a);
  let items = [];
  const file = chat.transcriptOf(a);
  if (file) {
    try {
      items = chat.conversation(file);
    } catch (e) {
      mx.log('chat:', e.message);
    }
  }
  // O que você mandou e a transcrição ainda não tem fica apagadinho no fim.
  const now = Date.now();
  // Um comando (o `/compact`) volta como `cmd`, não como pedido.
  const said = new Set(items.filter((m) => m.who === 'you' || m.who === 'cmd').map((m) => m.text.trim()));
  c.pending = c.pending.filter((p) => !said.has(p.text.trim()) && now - p.at < 60000);
  items = items.concat(c.pending.map((p) => ({ who: 'pending', text: p.text })));
  if (!items.length) items = [{ who: 'cmd', text: file ? 'nada por aqui ainda' : 'a conversa aparece aqui depois do primeiro pedido' }];
  const ask = openAsk(a, items);
  const perm = permissionItem(a);
  if (perm) items = items.concat([perm]);
  // A pergunta e a permissão abertas mandam no campo: vêm por último, por
  // cima da dica e do enter vazio de sempre.
  const input = ask ? askInput(ask, card) : perm && perm.tap ? permissionInput(card) : {};
  return {
    ...card,
    items,
    placeholder: card.sleeping
      ? `${a.name} está dormindo — mande uma mensagem e ele acorda`
      : card.asleep
        ? 'a sessão saiu'
        : `fale com ${a.name}…${state.pasteImage ? ' (⌘V cola um print)' : ''}`,
    problem: { on: !!c.problem, text: c.problem || '' },
    attached: {
      on: c.images > 0,
      text: `${c.images === 1 ? 'um print colado' : `${c.images} prints colados`} — vai junto com a próxima mensagem (ou dê enter pra mandar só ${c.images === 1 ? 'ele' : 'eles'})`,
    },
    allowEmpty: c.images > 0,
    canWake: card.sleeping && state.wake,
    // A lista que abre no campo quando você digita `/`.
    commands: commandsFor(a.cwd),
    sent: c.sent,
    inputId: `chat:${a.tabId}`,
    // O nome renomeia no clique, ali mesmo (numa Maestria que renomeia pelo plugin).
    canRename: a.kind === 'claude' && state.rename,
    naming: { on: c.naming && a.kind === 'claude' && state.rename, id: `nome:${a.tabId}` },
    nav: inboxNav(a),
    ...input,
  };
}

// --- responder uma pergunta -------------------------------------------------------

/**
 * A pergunta que dá pra responder daqui: a última da conversa, ainda aberta,
 * com ele esperando você e a Maestria sabendo mandar teclas (`keys: 1`). Ela
 * volta marcada (`answerable`, as opções clicáveis e as já escolhidas) e fica
 * em `state.chat.ask` pro clique. Numa de múltipla escolha (`multiSelect`) o
 * clique marca e desmarca, e o "confirmar" fecha a pergunta.
 */
function openAsk(a, items) {
  const c = state.chat;
  const ask = [...items].reverse().find((m) => m.who === 'ask');
  const ok =
    ask &&
    ask.open &&
    state.keys &&
    a.status === 'waitingAnswer' &&
    ask.id !== c.answered &&
    ask.questions.length &&
    ask.questions.every((q) => q.options.length);
  if (!ok) {
    c.ask = null;
    return null;
  }
  if (!c.ask || c.ask.id !== ask.id) {
    c.picks = {};
    c.done = {};
    c.cursor = 0;
  }
  c.ask = { id: ask.id, questions: ask.questions.map((q) => ({ options: q.options.length, multi: q.multi })) };
  ask.answerable = true;
  const current = currentQuestion();
  const settled = ask.questions.filter((_, i) => isSettled(i)).length;
  const multi = ask.questions.some((q) => q.multi);
  ask.state =
    ask.questions.length > 1
      ? `${multi ? 'responda cada pergunta — nas de várias, marque e confirme' : 'clique numa opção de cada pergunta pra responder'} (${settled}/${ask.questions.length})`
      : multi
        ? 'marque as opções e confirme'
        : 'clique numa opção pra responder';
  ask.questions.forEach((q, qi) => {
    const picked = c.picks[qi];
    for (const o of q.options) {
      o.tap = true;
      o.chosen = q.multi ? (picked || []).includes(o.o) : picked === o.o;
      o.focus = state.arrows && !q.multi && qi === current && o.o === c.cursor;
    }
    const n = q.multi ? (picked || []).length : 0;
    q.confirm = { on: n > 0 && !c.done[qi], q: qi, text: `confirmar ${n === 1 ? 'a escolha' : `as ${n} escolhas`}` };
  });
  return ask;
}

/** O campo embaixo, com uma pergunta aberta: numa só, ele escreve a resposta do "Other". */
function askInput(ask, card) {
  const single = ask.questions.length === 1 && !ask.questions[0].multi;
  const multi = ask.questions.some((q) => q.multi);
  return {
    live: { ...card.live, text: 'fez uma pergunta — responda aí em cima' },
    locked: !single,
    hint: single ? '' : multi ? 'marque as opções aí em cima e confirme (ou responda no terminal)' : 'clique nas opções aí em cima (ou responda no terminal)',
    placeholder: state.arrows
      ? `↑↓ escolhe e enter responde${single ? ' — ou escreva outra resposta aqui' : ''}…`
      : 'clique numa opção, ou escreva outra resposta aqui…',
    // O enter com o campo vazio responde a opção em destaque.
    allowEmpty: state.arrows,
    quick: [],
  };
}

/**
 * Clicou na opção [oi] da pergunta [qi]: numa de escolha única, ela é a
 * resposta; numa de várias, marca ou desmarca (e a pergunta volta a pedir o
 * "confirmar"). Com todas respondidas, vai pro terminal.
 */
async function pick(qi, oi) {
  const c = state.chat;
  const a = ownerOf(c.tabId);
  const q = c.ask && c.ask.questions[qi];
  if (!a || !q || !(oi >= 0 && oi < q.options)) return;
  if (q.multi) {
    const marked = new Set(c.picks[qi] || []);
    if (marked.has(oi)) marked.delete(oi);
    else marked.add(oi);
    c.picks[qi] = [...marked].sort((x, y) => x - y);
    c.done[qi] = false;
    return refreshChat();
  }
  c.picks[qi] = oi;
  c.cursor = 0;
  return submit(a);
}

/** O "confirmar" da pergunta de várias [qi], com ao menos uma marcada. */
async function confirm(qi) {
  const c = state.chat;
  const a = ownerOf(c.tabId);
  const q = c.ask && c.ask.questions[qi];
  if (!a || !q || !q.multi || !(c.picks[qi] || []).length) return;
  c.done[qi] = true;
  return submit(a);
}

/**
 * Com todas as perguntas respondidas, as teclas pro terminal. A seta começa na
 * primeira opção de cada pergunta: numa de escolha única, desce até a
 * escolhida e dá enter (e passa pra próxima); numa de várias, o enter marca a
 * opção sem sair do lugar, e depois das opções vêm o "Type something" e o
 * "Submit", que passa pra próxima. Com mais de uma pergunta, ou alguma de
 * várias, no fim vem a revisão, cujo primeiro botão é o de mandar as respostas.
 */
async function submit(a) {
  const c = state.chat;
  if (c.ask.questions.some((_, i) => !isSettled(i))) return refreshChat();
  const keys = [];
  c.ask.questions.forEach((q, i) => {
    if (!q.multi) {
      for (let k = 0; k < c.picks[i]; k++) keys.push('down');
      keys.push('enter');
      return;
    }
    let at = 0;
    for (const o of c.picks[i]) {
      for (; at < o; at++) keys.push('down');
      keys.push('enter');
    }
    for (; at < q.options + 1; at++) keys.push('down');
    keys.push('enter');
  });
  if (c.ask.questions.length > 1 || c.ask.questions.some((q) => q.multi)) keys.push('enter');
  await press(a, keys);
}

/** A pergunta [i] da aberta já tem resposta: a escolha, ou as marcadas e confirmadas. */
function isSettled(i) {
  const c = state.chat;
  return c.ask.questions[i].multi ? !!c.done[i] : c.picks[i] !== undefined;
}

/** A seta do campo vazio: o destaque sobe ou desce nas opções da pergunta da vez. */
async function arrow(key) {
  const c = state.chat;
  const q = c.ask && c.ask.questions[currentQuestion()];
  if (!q) return;
  c.cursor = (c.cursor + (key === 'up' ? -1 : 1) + q.options) % q.options;
  await refreshChat();
}

/** A primeira pergunta da aberta que ainda não tem resposta. */
function currentQuestion() {
  const c = state.chat;
  return c.ask ? c.ask.questions.findIndex((_, i) => !isSettled(i)) : -1;
}

/**
 * O enter do campo com uma pergunta aberta: vazio, responde a opção em
 * destaque; um número, a opção dele; o resto, numa pergunta só, é o "Other".
 */
async function answerTyped(a, text) {
  const c = state.chat;
  const qi = currentQuestion();
  if (qi < 0) return;
  const n = /^\d{1,2}$/.test(text) ? Number(text) : 0;
  if (!text) return pick(qi, c.cursor);
  if (n >= 1 && n <= c.ask.questions[qi].options) {
    c.sent++;
    return pick(qi, n - 1);
  }
  return answerOther(a, text);
}

/** A resposta escrita, numa pergunta só: a opção depois das dele é o "Other". */
async function answerOther(a, text) {
  const c = state.chat;
  if (!c.ask || c.ask.questions.length !== 1) return;
  const keys = [];
  for (let k = 0; k < c.ask.questions[0].options; k++) keys.push('down');
  keys.push({ text }, 'enter');
  await press(a, keys);
  c.sent++;
}

async function press(a, keys) {
  const c = state.chat;
  try {
    await mx.request('terminal.sendKeys', { tabId: a.tabId, keys });
    c.answered = c.ask.id;
    c.ask = null;
    c.picks = {};
    c.done = {};
    c.problem = '';
  } catch (e) {
    c.problem = `não deu pra responder: ${e.message}`;
  }
  await refreshChat();
}

// --- a caixa de entrada ------------------------------------------------------------
//
// A bandeja na sua mesa junta quem espera você (a permissão, a pergunta, o
// "pronto" não visto). O clique abre a conversa do que espera há mais tempo;
// lá em cima, o "próximo" leva ao seguinte, sem procurar boneco pela planta.

async function openInbox() {
  const first = world.inboxList()[0];
  if (first) await openChat(first.a.tabId, 'caixa', { inbox: true });
}

/** O "próximo" do topo do chat aberto pela caixa: o primeiro da fila que não é este. */
function inboxNav(a) {
  if (!state.chat.inbox) return { on: false, label: '', action: '' };
  const rest = world.inboxList().filter((it) => it.a.tabId !== a.tabId);
  if (!rest.length) return { on: true, label: 'caixa vazia ✓', action: '', done: true };
  return { on: true, label: `próximo: ${rest[0].a.name}${rest.length > 1 ? ` (+${rest.length - 1})` : ''}`, action: 'proximo', done: false };
}

async function nextInbox() {
  const c = state.chat;
  const next = world.inboxList().find((it) => it.a.tabId !== c.tabId);
  if (!next) return refreshChat();
  // A conversa troca de dono no lugar: sem fechar e abrir de novo.
  await openChat(next.a.tabId, 'caixa', { inbox: true });
}

// --- os recados dos ajudantes -------------------------------------------------------
//
// O ajudante que termina deixa um papel na mesa de quem o chamou: o que ele
// respondeu. O clique no papel abre os recados (e eles somem da mesa).

async function openNotes(tabId) {
  const a = world.agents.get(tabId);
  if (!a || !state.rfw) return;
  const notes = [...(a.notes || [])].reverse();
  for (const n of notes) {
    if (!n.text && n.transcript) {
      try {
        n.text = chat.lastReply(n.transcript) || '';
      } catch (e) {
        mx.log('recado:', e.message);
      }
    }
  }
  const data = {
    name: a.name,
    sub: notes.length ? `${notes.length} ${notes.length === 1 ? 'recado' : 'recados'} de ajudante` : 'nenhum recado',
    notes: notes.map((n) => ({
      what: n.what,
      type: n.type,
      hasType: !!n.type && n.type !== 'general-purpose',
      when: new Date(n.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      text: n.text ? clipNote(n.text) : 'ele não deixou nada escrito',
      fresh: !n.read,
    })),
  };
  for (const n of a.notes || []) n.read = true;
  await mx.request('view.open', {
    viewId: RECADOS,
    title: `recados · ${a.name}`,
    modal: true,
    from: `agente:${tabId}`,
    width: 720,
    height: 640,
    rfw: { library: CHAT_UI, root: 'recados' },
    data: { recados: data, markdown: state.markdown, selectable: state.selectable },
  });
  await changed();
}

function clipNote(text) {
  const t = String(text).trim();
  return t.length > 20000 ? `${t.slice(0, 19999)}…` : t;
}

// --- mandar pra vários --------------------------------------------------------------
//
// O "selecionar" do topo: o clique num boneco marca e desmarca, e a barra
// embaixo do topo abre a janelinha da mensagem, que vai pra todos os marcados.

async function toggleSelecting(on = !state.selecting) {
  state.selecting = on;
  if (!on) state.selected.clear();
  await flush();
}

async function toggleSelected(tabId) {
  const a = world.agents.get(tabId);
  if (!a || a.kind !== 'claude') return;
  if (state.selected.has(tabId)) state.selected.delete(tabId);
  else state.selected.add(tabId);
  await flush();
}

const PRESETS = ['/compact', 'rode os testes e me diga como ficou', 'como está indo? me dá um resumo curto', 'pode continuar'];

function groupData() {
  const who = [...state.selected].map((id) => world.agents.get(id)).filter(Boolean);
  return {
    names: who.map((a) => ({ name: a.name, tabId: a.tabId, sheet: sprites.sheetOf(a.skin.id), waiting: String(a.status).startsWith('waiting') })),
    title: `mandar pra ${who.length} ${who.length === 1 ? 'claude' : 'claudes'}`,
    presets: PRESETS.map((t) => ({ text: t })),
    problem: { on: !!state.groupProblem, text: state.groupProblem },
    sent: state.groupSent,
  };
}

async function openGroup() {
  if (!state.selected.size) return;
  state.groupProblem = '';
  await mx.request('view.open', {
    viewId: GRUPO,
    title: 'mandar pra vários',
    modal: true,
    from: 'selecao',
    width: 560,
    height: 470,
    rfw: { library: CHAT_UI, root: 'grupo' },
    data: { grupo: groupData(), sprites: state.sprites },
  });
}

/**
 * Manda [text] pra cada marcado, do jeito que o chat mandaria: quem dorme
 * acorda e lê, quem está chegando lê quando sentar, e quem espera uma
 * permissão ou uma resposta sua fica de fora (o enter cairia nela).
 */
async function sendGroup(text) {
  const t = String(text || '').trim();
  if (!t) return;
  const sent = [];
  const skipped = [];
  for (const id of state.selected) {
    const a = world.agents.get(id);
    if (!a || a.kind !== 'claude' || a.leaving) continue;
    if (a.status === 'waitingPermission' || a.status === 'waitingAnswer') {
      skipped.push(`${a.name} (esperando você)`);
      continue;
    }
    try {
      if (a.hibernated || state.waking.has(a.tabId) || a.status === 'starting') {
        enqueue(a, { kind: 'send', text: t });
        if (a.hibernated) await wakeUp(a);
      } else {
        await mx.request('terminal.sendText', { tabId: a.tabId, text: t, submit: true });
      }
      sent.push(a.name);
      world.say(a, `“${clip(t, 30)}”`, 'quote', 4000);
    } catch (e) {
      skipped.push(`${a.name} (${e.message})`);
    }
  }
  state.groupSent++;
  if (skipped.length) {
    state.groupProblem = `${sent.length ? `foi pra ${sent.length}; ` : ''}não foi pra: ${skipped.join(', ')}`;
    await mx.request('view.update', { viewId: GRUPO, data: { grupo: groupData() } }).catch(() => {});
    await changed();
    return;
  }
  await mx.request('view.close', { viewId: GRUPO }).catch(() => {});
  await toggleSelecting(false);
  await mx.request('window.showBanner', { text: `mandei pra ${sent.length} ${sent.length === 1 ? 'claude' : 'claudes'}` }).catch(() => {});
}

// --- a daily ------------------------------------------------------------------------
//
// O "daily" do topo (ou a porta da rua, no fim do expediente) junta quem
// trabalhou no período na sala de reunião e prepara o resumo (`daily.js`):
// o que cada conversa fez, o que ficou pendente e algo interessante do
// caminho. Com o horário da daily configurado, a reunião se junta sozinha uns
// minutos antes. E, no primeiro abrir do dia, o "bom dia" mostra o que ficou
// pendente na última.

const DAILY_SIZE = { width: 860, height: 760 };

function dailyCwd() {
  return path.join(state.dataDir || __dirname, 'daily-cwd');
}

function dailySettings() {
  return { time: state.settings.dailyTime || '', weekends: state.settings.dailyWeekends === true };
}

/**
 * As pastas fora da daily (a opção "pastas fora da daily"), com as worktrees
 * delas: o que se faz nelas não entra no resumo nem vai pra reunião.
 */
function outsideDaily() {
  const picked = Array.isArray(state.settings.dailySkip) ? state.settings.dailySkip : [];
  return picked.flatMap((id) => {
    const f = world.folders.find((x) => x.id === id);
    return f ? f.paths : [id];
  });
}

/** A daily guardada [s] sem os trabalhos das pastas fora da daily. */
function withoutOutside(s) {
  if (!s || !Array.isArray(s.items)) return s;
  const out = outsideDaily();
  if (!out.length) return s;
  return { ...s, items: s.items.filter((it) => !daily.within(it.cwd || daily.cwdOf(it.sessao), out)) };
}

/** O nome que a conversa [sessionId] tem na Maestria, se ela está aberta. */
function agentOfSession(sessionId) {
  return world.people().find((a) => a.kind === 'claude' && a.sessionId === sessionId) || null;
}

/** A daily da vez (`daily.periodOf`): a próxima, ou a que acabou de acontecer. */
function nowPeriod() {
  return daily.periodOf(Date.now(), dailySettings());
}

/** Os resumos guardados, um por daily (o "ver outra daily"). */
function loadSaved() {
  state.daily.saved = state.dataDir ? daily.dailies(state.dataDir) : [];
}

/** A última daily guardada antes da daily [key]: o pendente dela é o "da anterior". */
function dailyBefore(key) {
  return (state.daily.saved || []).find((x) => daily.keyOf(x) < key) || null;
}

/**
 * Mostra o resumo guardado [s], com o pendente da daily de antes dele. Sem [s],
 * a daily da vez, que ainda não tem resumo: o pendente é o da última.
 */
function showSummary(s) {
  const dl = state.daily;
  Object.assign(dl, { summary: s, convs: [], problem: '', note: '', allPending: false });
  dl.previous = withoutOutside(dailyBefore(daily.keyOf(s || nowPeriod())));
}

/** A daily da vez: o resumo dela, se já tem; senão, nenhum. */
function showNext() {
  const last = (state.daily.saved || [])[0] || null;
  showSummary(isCurrent(last) ? last : null);
}

/** [s] é da daily da vez? Um resumo refeito depois da daily ainda é da que passou. */
function isCurrent(s) {
  return !!s && daily.keyOf(s) === daily.keyOf(nowPeriod());
}

/** "hoje 14:00", "quarta 14/10 14:00"; sem horário configurado, o dia ("hoje"). */
function dailyWhen(p) {
  if (p && p.slot) return daily.when(p.slot, Date.now(), { full: true });
  return daily.when((p && p.from) || Date.now(), Date.now(), { full: true, time: false });
}

/** O período de um resumo guardado (os sem período: o dia em que foi feito). */
function periodOfSummary(s) {
  return s.period || { from: s.at };
}

/**
 * O "fazer a daily" conta [s] (da daily da vez e de no máximo duas horas, como
 * o que se junta sozinho antes dela); senão, escreve um novo -- o "fim do
 * expediente" de ontem não tem o que foi feito hoje de manhã.
 */
function reusable(s) {
  return isCurrent(s) && Date.now() - s.at < 2 * 3600 * 1000;
}

/**
 * O "daily" do topo: abre a janela na daily da vez, sem ler nem juntar nada --
 * o resumo dela, se já tem; senão, o que ficou pendente na última.
 */
async function viewDaily(from = 'daily') {
  const dl = state.daily;
  if (!dl.running) {
    loadSaved();
    dl.mode = 'daily';
    dl.title = 'daily';
    showNext();
  }
  return openDaily(from);
}

/**
 * Escreve um resumo novo, do período da daily da vez (`daily.js`). Com [meet],
 * a reunião se junta enquanto ele é escrito e, com ele pronto, cada um conta a
 * sua parte; sem, só a janela mostra. [title] diz de onde veio ("daily", "fim
 * do expediente").
 */
async function summarize({ title = 'daily', from = 'daily', auto = false, meet = false } = {}) {
  const dl = state.daily;
  if (dl.running) return meet ? null : openDaily(from);
  const period = daily.periodOf(Date.now(), dailySettings());
  Object.assign(dl, { running: true, meet, mode: 'daily', title, period, summary: null, convs: [], problem: '', note: 'lendo as conversas…', allPending: false });
  loadSaved();
  dl.previous = withoutOutside(dailyBefore(daily.keyOf(period)));
  // Pra reunião, a janela fica fechada: o que se vê são eles na sala.
  if (!meet) await openDaily(from);
  try {
    dl.convs = await daily.conversations(period, { skip: [daily.projectName(dailyCwd())], outside: outsideDaily() });
    if (!dl.convs.length) {
      dl.note = '';
      dl.problem = `nenhuma conversa com o Claude Code ${period.label === 'hoje' ? 'hoje' : period.label}`;
      if (dl.meet) await mx.request('window.showBanner', { text: `sem daily: ${dl.problem}` }).catch(() => {});
      return;
    }
    // A reunião se junta enquanto o resumo é escrito.
    if (dl.meet) await gather(dl.convs.map((c) => c.sessionId));
    dl.note = `resumindo ${dl.convs.length} ${dl.convs.length === 1 ? 'conversa' : 'conversas'}… (uns 30 s)`;
    await refreshDaily();
    const prompt = daily.promptOf({ period, convs: dl.convs, previous: dl.previous, style: state.settings.dailyStyle || '' });
    const text = await daily.ask(prompt, { model: state.settings.dailyModel || 'sonnet', cwd: dailyCwd() });
    const parsed = daily.parseSummary(text);
    // A pasta e a branch de cada um vão juntas: o resumo é relido depois, sem as conversas.
    parsed.items = parsed.items.map((it) => {
      const c = dl.convs.find((x) => x.sessionId === it.sessao) || {};
      return { ...it, cwd: c.cwd || '', branch: c.branch || '' };
    });
    dl.summary = { at: Date.now(), title, period, ...parsed };
    if (state.dataDir) daily.save(state.dataDir, dl.summary);
    loadSaved();
    dl.note = '';
    if (dl.meet && world.inDaily()) await tell(dl.summary);
    if (auto && !dl.open) await mx.request('window.showBanner', { text: 'o resumo da daily está pronto — o "daily" do escritório abre' }).catch(() => {});
  } catch (e) {
    dl.note = '';
    dl.problem = `não deu pra fazer o resumo: ${e.message}`;
    if (dl.meet) {
      if (world.endDaily()) await changed();
      await mx.request('window.showBanner', { text: dl.problem }).catch(() => {});
    }
  } finally {
    dl.running = false;
    dl.meet = false;
    await refreshDaily();
  }
}

/** Junta na sala de reunião você e quem está nas conversas [sessionIds]. */
async function gather(sessionIds) {
  if (!state.viewOpen) return false;
  const tabs = sessionIds.map(agentOfSession).filter(Boolean).map((a) => a.tabId);
  if (!world.startDaily(tabs)) return false;
  await changed();
  return true;
}

/**
 * O resumo [s] na boca de cada um: o que fez, o curioso e o que falta. A parte
 * de quem não está no escritório (a conversa já fechou), você conta.
 */
async function tell(s) {
  const byTab = {};
  const yours = [];
  for (const it of s.items) {
    const a = agentOfSession(it.sessao);
    if (a && a.meeting && a.meeting.kind === 'daily') {
      (byTab[a.tabId] = byTab[a.tabId] || []).push(firstSentence(it.fiz), it.curioso && `💡 ${firstSentence(it.curioso)}`, it.pendente && `falta: ${firstSentence(it.pendente)}`);
    } else if (it.fiz) {
      yours.push(`${clip(it.nome, 32)}: ${firstSentence(it.fiz)}`);
    }
  }
  world.dailyLines(byTab, yours);
  await changed();
}

/**
 * O "fazer a daily": a janela fecha e todo mundo vai pra sala de reunião. Com o
 * resumo da daily da vez na tela, eles contam esse; senão, um novo é escrito
 * enquanto eles se juntam ("deixa eu lembrar…").
 */
async function doDaily() {
  const dl = state.daily;
  await mx.request('view.close', { viewId: DAILY }).catch(() => {});
  dl.open = false;
  if (dl.running) {
    // Já está sendo escrito (o "novo resumo"): a reunião pega carona nele.
    dl.meet = true;
    if (dl.convs.length && !world.inDaily()) await gather(dl.convs.map((c) => c.sessionId));
    return;
  }
  const s = dl.summary;
  if (!reusable(s)) return summarize({ title: 'daily', meet: true });
  if (!s.items.some((it) => agentOfSession(it.sessao)) && state.settings.office === false) {
    return mx.request('window.showBanner', { text: 'ninguém dessa daily está no escritório' }).catch(() => {});
  }
  if (!(await gather(s.items.map((it) => it.sessao)))) {
    return mx.request('window.showBanner', { text: 'não deu pra juntar a reunião: abra o escritório' }).catch(() => {});
  }
  await tell(s);
}

function firstSentence(text) {
  const t = String(text || '').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return clip(m ? m[1] : t, 80);
}

function dailyData() {
  const dl = state.daily;
  const s = dl.summary;
  const now = Date.now();
  const convOf = (id) => dl.convs.find((c) => c.sessionId === id);
  const items = s
    ? s.items.map((it, i) => {
        const c = convOf(it.sessao) || { cwd: it.cwd, branch: it.branch };
        const a = agentOfSession(it.sessao);
        const ref = wiboor.refOf(it.nome) || wiboor.refOf(c.branch);
        return {
          i,
          nome: it.nome || (a ? a.name : c.title) || 'conversa',
          where: [c.cwd ? path.basename(c.cwd) : '', c.branch].filter(Boolean).join(' · '),
          fiz: it.fiz,
          pendente: it.pendente,
          hasPendente: !!it.pendente,
          curioso: it.curioso,
          hasCurioso: !!it.curioso,
          sheet: a ? sprites.sheetOf(a.skin.id) : '',
          hasSheet: !!a && state.sprites,
          wiboor: ref && wiboor.hasKey() ? { on: true, label: `comentar na ${ref.kind}#${ref.number}` } : { on: false, label: '' },
        };
      })
    : [];
  // A da vez (a próxima, ou a que acabou de acontecer) e a da tela, que pode
  // ser uma que já passou (o "ver outra daily").
  const period = dl.running ? dl.period : nowPeriod();
  const next = dailyWhen(period);
  const past = !dl.running && !!s && !isCurrent(s);
  const shown = s ? periodOfSummary(s) : period;
  const since = (p) => (p.slot ? `desde ${daily.when(p.from, now, { full: true })}` : 'do dia');
  let title = `daily de ${dailyWhen(shown)}`;
  if (dl.mode === 'manha') title = 'bom dia! ☕';
  else if (dl.title === 'fim do expediente' && !past) title = 'fim do expediente';
  let sub;
  if (dl.running) sub = `escrevendo o resumo · o que foi feito ${since(period)}`;
  else if (past) sub = `já foi · resumo de ${daily.when(s.at, now, { full: true })}`;
  else if (s) sub = `resumo de ${daily.when(s.at, now, { full: true })} · o que foi feito ${since(shown)}`;
  else sub = `ainda sem resumo · conta o que foi feito ${since(period)}`;
  if (dl.title === 'fim do expediente' && !past && period.slot) sub += ` · a daily é ${next}`;
  const none = { on: false, text: '', go: { on: false, label: '', action: '' } };
  // O que ficou pendente na daily anterior (a de antes da da tela): os
  // resolvidos riscados, no fim, e só os primeiros até pedir o resto.
  const prev = dl.previous;
  const resolved = s ? s.resolvido || [] : [];
  const pend = (prev && Array.isArray(prev.items) ? prev.items.filter((i) => i.pendente) : [])
    .map((p) => ({
      nome: p.nome || 'conversa',
      text: p.pendente,
      done: resolved.some((r) => r && (p.pendente.includes(r) || r.includes(p.nome))),
    }))
    .sort((a, b) => a.done - b.done);
  const FEW = 5;
  const done = pend.filter((p) => p.done).length;
  const pending = pend.length
    ? {
        on: true,
        title: `ficou pendente na daily de ${dailyWhen(periodOfSummary(prev))}${done ? ` · ${done} ${done === 1 ? 'resolvido' : 'resolvidos'}` : ''}`,
        items: dl.allPending ? pend : pend.slice(0, FEW),
        more: { on: pend.length > FEW, label: dl.allPending ? 'mostrar menos' : `mais ${pend.length - FEW}` },
        open: `daily-ver:${prev.at}`,
      }
    : { on: false, title: '', items: [], more: { on: false, label: '' }, open: '' };
  // Sem resumo, o pendente da última é o que tem pra ver: vai no topo. Com
  // resumo, ele é contexto: vai no fim.
  const top = !s && !dl.problem;
  // As dailies guardadas, uma por daily: a da vez em cima, as que já foram
  // embaixo, a da tela marcada.
  const saved = dl.saved || [];
  const count = (x) => {
    const n = Array.isArray(x.items) ? x.items.length : 0;
    return `${n} ${n === 1 ? 'trabalho' : 'trabalhos'}`;
  };
  const cur = saved.find(isCurrent);
  const older = saved.filter((x) => !isCurrent(x)).slice(0, 12);
  dl.meetingShown = world.inDaily();
  return {
    title,
    sub,
    loading: dl.running,
    note: dl.note,
    problem: { on: !!dl.problem, text: dl.problem },
    // Nada na tela: o que cada botão faz.
    empty: {
      ...none,
      on: !s && !dl.running && !dl.problem,
      text: `ainda não tem resumo desta daily. O "fazer a daily" junta todo mundo na sala de reunião e escreve um enquanto eles chegam (uns 30 s); o ↻ só escreve o resumo, sem reunião.`,
    },
    // Um resumo que o "fazer a daily" não vai contar: ele escreve o da vez.
    old: past
      ? {
          on: true,
          text: `essa daily já foi. O "fazer a daily" é o da próxima (${next}), com o que foi feito depois dela.`,
          go: { on: true, label: 'ver a próxima', action: 'daily-proxima' },
        }
      : {
          ...none,
          on: !!s && !dl.running && !reusable(s),
          text: 'esse resumo tem mais de duas horas: o "fazer a daily" escreve um novo, com o que veio depois dele.',
        },
    pendingTop: top ? pending : { ...pending, on: false },
    pendingBottom: top ? { ...pending, on: false } : pending,
    items,
    hasItems: items.length > 0,
    text: s ? s.daily : '',
    hasText: !!(s && s.daily),
    configured: !!daily.parseTime(state.settings.dailyTime),
    meeting: dl.meetingShown,
    history: [
      {
        label: `${next} · ${cur ? count(cur) : 'sem resumo ainda'}`,
        action: 'daily-proxima',
        icon: !past ? 'check' : '',
      },
      { divider: true },
      ...older.map((x) => ({
        label: `${dailyWhen(periodOfSummary(x))} · ${count(x)}`,
        action: `daily-ver:${x.at}`,
        icon: past && s.at === x.at ? 'check' : '',
      })),
    ],
    hasHistory: !dl.running && older.length > 0,
  };
}

async function openDaily(from = 'daily') {
  if (!state.rfw) return;
  state.daily.open = true;
  await mx.request('view.open', {
    viewId: DAILY,
    title: state.daily.mode === 'manha' ? 'bom dia' : 'daily',
    modal: true,
    from,
    ...DAILY_SIZE,
    rfw: { library: CHAT_UI, root: 'daily' },
    data: { daily: dailyData(), markdown: state.markdown, selectable: state.selectable, sprites: state.sprites },
  });
}

async function refreshDaily() {
  if (!state.daily.open) return;
  const { open: still } = await mx.request('view.update', { viewId: DAILY, data: { daily: dailyData() } }).catch(() => ({ open: false }));
  if (!still) closedDaily();
}

/** A janela fechou. A reunião, se tem, segue: acaba sozinha quando todo mundo falou. */
function closedDaily() {
  state.daily.open = false;
}

/** A daily se junta sozinha uns minutos antes do horário configurado. */
function dailySoon() {
  const t = daily.parseTime(state.settings.dailyTime);
  const before = Number(state.settings.dailyRemind);
  const remind = Number.isFinite(before) ? before : 10;
  if (!t || remind <= 0 || state.daily.running) return;
  const period = daily.periodOf(Date.now(), dailySettings());
  if (!period.slot || state.dailyAuto === period.slot) return;
  const now = Date.now();
  if (now < period.slot - remind * 60000 || now > period.slot) return;
  state.dailyAuto = period.slot;
  savePrefs();
  summarize({ title: 'daily', auto: true, meet: true }).catch((e) => mx.log('daily:', e.message));
}

/** O primeiro abrir do dia (depois das 5h): o "bom dia" com o que ficou pendente na última daily. */
async function goodMorning() {
  const now = new Date();
  const today = now.toDateString();
  if (now.getHours() < 5 || state.morning === today || !state.dataDir || state.daily.open || state.daily.running) return;
  state.morning = today;
  savePrefs();
  loadSaved();
  const last = state.daily.saved[0];
  // Só se a última é de antes de hoje (e não muito velha).
  if (!last || new Date(last.at).toDateString() === today || Date.now() - last.at > 4 * 24 * 3600 * 1000) return;
  Object.assign(state.daily, { mode: 'manha', title: 'daily' });
  showNext();
  await openDaily('daily');
}

async function dailyAction(a, values) {
  const dl = state.daily;
  if (a === 'daily-fechar') {
    await mx.request('view.close', { viewId: DAILY }).catch(() => {});
    return closedDaily();
  }
  if (a === 'daily-copiar') {
    const text = dl.summary ? dl.summary.daily : '';
    if (!text) return;
    await mx.request('clipboard.write', { text });
    return mx.request('window.showBanner', { text: 'o texto da daily foi copiado' }).catch(() => {});
  }
  if (a === 'daily-fazer') return doDaily();
  if (a === 'daily-encerrar') {
    if (world.endDaily()) await changed();
    return refreshDaily();
  }
  if (a === 'daily-refazer') {
    return summarize({ title: dl.title === 'fim do expediente' ? 'fim do expediente' : 'daily' });
  }
  if (a.startsWith('daily-ver:')) {
    if (dl.running) return;
    const at = Number(a.slice('daily-ver:'.length));
    const s = (dl.saved || []).find((x) => x.at === at);
    if (!s) return;
    dl.mode = 'daily';
    dl.title = s.title || 'daily';
    showSummary(s);
    return refreshDaily();
  }
  if (a === 'daily-proxima') {
    if (dl.running) return;
    dl.mode = 'daily';
    dl.title = 'daily';
    showNext();
    return refreshDaily();
  }
  if (a === 'daily-pendentes') {
    dl.allPending = !dl.allPending;
    return refreshDaily();
  }
  if (a === 'daily-wiboor') {
    const it = dl.summary && dl.summary.items[Number(values.i)];
    if (!it) return;
    const c = dl.convs.find((x) => x.sessionId === it.sessao) || { branch: it.branch };
    const ref = wiboor.refOf(it.nome) || wiboor.refOf(c.branch);
    if (!ref) return;
    // É um comentário de verdade, no tracker do time: pergunta antes.
    const ok = await mx.request('window.pick', {
      title: `comentar na ${ref.kind}#${ref.number}?`,
      placeholder: 'vai o que foi feito, o que ficou pendente e o curioso',
      items: [
        { value: 'sim', label: 'sim, comentar no Wiboor' },
        { value: 'nao', label: 'não' },
      ],
    });
    if (ok !== 'sim') return;
    try {
      const t = await wiboor.comment(ref, [
        ['Feito', it.fiz],
        ['Pendente', it.pendente],
        ['Curioso', it.curioso],
      ]);
      await mx.request('window.showBanner', { text: `comentei na ${ref.kind}#${ref.number}${t.title ? ` (${clip(t.title, 40)})` : ''}` });
    } catch (e) {
      await mx.request('window.showBanner', { text: `não deu pra comentar: ${e.message}` });
    }
  }
}

// --- o dia e os retratos --------------------------------------------------------------
//
// O relógio de ponto lê as conversas do dia de minuto em minuto (`usage.js`).
// E cada claude manda o retrato dele pra Maestria (`session.portrait`), que o
// põe na notificação quando ele precisa de você.

const usage = new Usage();
const USAGE_MS = 60 * 1000;
let usageAt = 0;

async function refreshUsage({ force = false } = {}) {
  if (!force && Date.now() - usageAt < USAGE_MS) return;
  usageAt = Date.now();
  try {
    if (world.setUsage(await usage.refresh())) await changed();
  } catch (e) {
    mx.log('uso do dia:', e.message);
  }
}

const portraitsSent = new Set();
async function sendPortraits() {
  if (!state.portrait) return;
  for (const a of world.people()) {
    if (a.kind !== 'claude' || portraitsSent.has(a.tabId)) continue;
    portraitsSent.add(a.tabId);
    try {
      const image = sprites.portrait(state.dataDir || __dirname, a.skin);
      await mx.request('session.portrait', { tabId: a.tabId, image });
    } catch (e) {
      mx.log('retrato:', e.message);
    }
  }
}

// --- dar permissão -------------------------------------------------------------------
//
// Esperando permissão, o terminal dele mostra o "Do you want to proceed?" com o
// "Yes" já em destaque: o enter permite, e o esc nega (é o "No, and tell
// Claude what to do differently", que para o turno e volta pro prompt). O
// cartão no fim da conversa diz o que ele quer fazer -- o comando inteiro, o
// trecho que vai mudar --, e os botões só valem pra aquela ferramenta: se a
// permissão da vez já for outra quando o clique chegar, nada vai pro terminal.

/** O cartão da permissão que [a] está pedindo, ou `null`. */
function permissionItem(a) {
  const c = state.chat;
  const t = world.permissionOf(a);
  if (!t || t.id === c.answeredPerm) {
    c.perm = null;
    return null;
  }
  // O plano (`ExitPlanMode`) tem opções que mudam de versão pra versão do
  // Claude Code: aprovar daqui seria apertar um botão sem saber qual. Ele
  // aparece, mas a resposta é no terminal.
  const plan = t.name === 'ExitPlanMode';
  const tap = state.keys && !plan;
  c.perm = tap ? t.id : null;
  const what = describePermission(t, a.cwd);
  return {
    who: 'perm',
    id: t.id,
    title: what.title,
    sub: what.sub || '',
    hasSub: !!what.sub,
    code: what.code || '',
    hasCode: !!what.code,
    plan: plan ? String((t.input && t.input.plan) || '') : '',
    isPlan: plan,
    by: t.by ? `pedido do ajudante “${t.by}”` : '',
    hasBy: !!t.by,
    tap,
    note: tap ? '' : 'responda no terminal dele (o ícone do terminal, aí em cima)',
  };
}

/** O que a ferramenta [t] vai fazer, em português e com o detalhe que importa pra decidir. */
function describePermission(t, cwd) {
  const input = t.input || {};
  const rel = (p) => {
    const f = String(p || '');
    return cwd && f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f;
  };
  const lines = (text, prefix, max) => {
    const all = String(text || '').split('\n');
    const shown = all.slice(0, max).map((l) => `${prefix}${l}`);
    if (all.length > max) shown.push(`${prefix}… (+${all.length - max} linhas)`);
    return shown;
  };
  switch (t.name) {
    case 'Bash':
      return { title: 'quer rodar um comando', sub: input.description, code: `$ ${String(input.command || '').trim()}` };
    case 'Edit':
      return {
        title: `quer editar ${rel(input.file_path)}`,
        sub: input.replace_all ? 'todas as ocorrências' : '',
        code: [...lines(input.old_string, '- ', 14), ...lines(input.new_string, '+ ', 14)].join('\n'),
      };
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const code = edits
        .slice(0, 4)
        .map((e) => [...lines(e.old_string, '- ', 6), ...lines(e.new_string, '+ ', 6)].join('\n'))
        .join('\n⋯\n');
      return { title: `quer editar ${rel(input.file_path)}`, sub: `${edits.length} ${edits.length === 1 ? 'trecho' : 'trechos'}`, code };
    }
    case 'Write':
      return { title: `quer escrever ${rel(input.file_path)}`, code: lines(input.content, '', 24).join('\n') };
    case 'NotebookEdit':
      return { title: `quer editar ${rel(input.notebook_path)}`, code: lines(input.new_source, '+ ', 20).join('\n') };
    case 'WebFetch':
      return { title: 'quer abrir uma página', sub: input.prompt, code: String(input.url || '') };
    case 'WebSearch':
      return { title: 'quer pesquisar na web', code: String(input.query || '') };
    case 'ExitPlanMode':
      return { title: 'terminou o plano e quer seu ok pra começar' };
    default: {
      const name = String(t.name || '');
      const label = name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name;
      let code = '';
      try {
        code = JSON.stringify(input, null, 2);
      } catch {
        code = '';
      }
      return { title: `quer usar ${label}`, code: code && code !== '{}' ? lines(code, '', 24).join('\n') : '' };
    }
  }
}

/** O campo embaixo, com a permissão aberta: o que for escrito nega e vai como instrução. */
function permissionInput(card) {
  return {
    live: { ...card.live, text: 'quer a sua permissão — permita ou negue aí em cima' },
    locked: false,
    hint: '',
    placeholder: 'ou escreva o que ele deve fazer em vez disso (nega e manda)…',
    allowEmpty: false,
  };
}

/**
 * O clique em "permitir" ou "negar" da permissão [id]. Só vai pro terminal se
 * ela ainda é a da vez; [instead] (o que foi escrito no campo) nega e segue
 * como o próximo pedido.
 */
async function answerPermission(id, allow, instead = '') {
  const c = state.chat;
  const a = ownerOf(c.tabId);
  const t = a && world.permissionOf(a);
  if (!t || t.id !== id || !state.keys) {
    c.problem = 'essa permissão já não está mais aberta — confira de novo';
    return refreshChat();
  }
  try {
    await mx.request('terminal.sendKeys', { tabId: a.tabId, keys: [allow ? 'enter' : 'escape'] });
    c.answeredPerm = id;
    c.problem = '';
    if (!allow) world.say(a, instead ? 'ok, vou por outro caminho' : 'ok, não faço', 'white', 3000);
    if (instead) {
      // O esc volta pro prompt num instante; a instrução vai depois dele.
      await new Promise((r) => setTimeout(r, 700));
      await mx.request('terminal.sendText', { tabId: a.tabId, text: instead, submit: true });
      c.sent++;
      c.pending.push({ text: instead, at: Date.now() });
    }
  } catch (e) {
    c.problem = `não deu pra responder: ${e.message}`;
  }
  await changed();
  await refreshChat();
}

// --- pôr pra dormir ---------------------------------------------------------------

/**
 * Hiberna [tabId] (`session.hibernate`): o processo desliga, a conversa fica,
 * e ele vai cochilar no sofá até alguém mandar uma mensagem (ou acordá-lo).
 */
async function nap(tabId) {
  const a = world.agents.get(tabId);
  if (!a || !world.canNap(a)) return;
  try {
    await mx.request('session.hibernate', { tabId });
  } catch (e) {
    await mx.request('window.showBanner', { text: `não deu pra pôr pra dormir: ${e.message}` });
    return;
  }
  // O session.status vem logo atrás; aqui ele já boceja e vai pro sofá.
  world.status(tabId, 'idle', { hibernated: true });
  world.say(a, 'boa noite 😴', 'white', 3000);
  await changed();
  if (state.chat.open && state.chat.tabId === tabId) await closeChat();
}

// O tamanho das janelinhas: um chat, e não a tela inteira.
const CHAT_SIZE = { width: 820, height: 780 };
const NOVO_SIZE = { width: 520, height: 600 };
// Vindo de uma mesa vazia, a sala já está escolhida: só o pedido (e onde, se o repositório tem worktrees).
const MESA_SIZE = { width: 480, height: 248 };
const MESA_CHIPS = 46;

/**
 * Abre a conversa com [tabId], crescendo a partir de [from] (a âncora: o
 * boneco, ou a linha dele na lateral). Abrir é ver: o "pronto" sai da cabeça.
 */
async function openChat(tabId, from = `agente:${tabId}`, { inbox = false } = {}) {
  const a = ownerOf(tabId);
  if (!a) return;
  const c = state.chat;
  // Aberta pela caixa de entrada: o topo ganha o "próximo".
  c.inbox = inbox;
  if (world.seen(tabId)) changed();
  if (c.tabId !== tabId) {
    c.pending = [];
    c.problem = '';
    c.images = 0;
  }
  c.naming = false;
  c.tabId = tabId;
  if (!state.rfw) {
    await mx.request('session.focus', { tabId });
    return;
  }
  await mx.request('view.open', {
    viewId: CHAT,
    title: `conversa · ${a.name}`,
    modal: true,
    from,
    ...CHAT_SIZE,
    rfw: { library: CHAT_UI, root: 'chat' },
    data: { chat: chatData(), sprites: state.sprites, markdown: state.markdown, selectable: state.selectable },
  });
  c.open = true;
}

/** Fecha a conversa: ela encolhe de volta pro boneco (o `from` com que abriu). */
async function closeChat() {
  const c = state.chat;
  if (!c.open) return;
  c.open = false;
  await mx.request('view.close', { viewId: CHAT }).catch(() => {});
}

/** Relê a conversa pouco depois de algo acontecer na sessão (os hooks vêm em rajada). */
function refreshChatSoon(tabId) {
  const c = state.chat;
  if (!c.open || (tabId && tabId !== c.tabId)) return;
  if (c.timer) return;
  c.timer = setTimeout(async () => {
    c.timer = null;
    await refreshChat();
  }, 250);
}

async function refreshChat() {
  const c = state.chat;
  if (!c.open) return;
  try {
    const { open: still } = await mx.request('view.update', { viewId: CHAT, data: { chat: chatData() } });
    if (!still) c.open = false;
  } catch (e) {
    mx.log('chat:', e.message);
  }
}

/** Manda [text] pro terminal do claude da conversa, como se você tivesse digitado lá. */
async function send(text) {
  const c = state.chat;
  const a = ownerOf(c.tabId);
  const t = String(text || '').trim();
  // Vazio só vai com um print esperando no prompt: o enter manda ele sozinho.
  if (a && a.status === 'waitingAnswer' && c.ask) return answerTyped(a, t);
  // Com a permissão aberta, escrever é negar e dizer o que fazer em vez disso.
  if (a && a.status === 'waitingPermission' && c.perm) return t ? answerPermission(c.perm, false, t) : undefined;
  if (!a || (!t && !c.images)) return;
  if (a.status === 'waitingPermission' || a.status === 'waitingAnswer') return;
  if (a.hibernated || state.waking.has(a.tabId)) {
    // Dormindo (ou acordando): a mensagem espera ele voltar, e já aparece na conversa.
    enqueue(a, { kind: 'send', text: t });
    c.sent++;
    c.problem = '';
    const shots = c.images ? `${'[imagem] '.repeat(c.images)}` : '';
    c.pending.push({ text: `${shots}${t}`.trim(), at: Date.now() });
    await wakeUp(a);
    // Mandou: a conversa fecha e volta pro boneco, que vai acordar e ler.
    return closeChat();
  }
  if (a.status === 'starting') {
    // Chegando: o prompt dele ainda não subiu, e o que estiver na tela leva o
    // enter -- o "confia nesta pasta?" do Claude Code vem com o "No, exit"
    // marcado, e a mensagem fechava a sessão. Ela espera ele sentar (o
    // `ready`), como a de quem está acordando.
    enqueue(a, { kind: 'send', text: t });
    c.sent++;
    c.problem = '';
    const shots = c.images ? `${'[imagem] '.repeat(c.images)}` : '';
    c.pending.push({ text: `${shots}${t}`.trim(), at: Date.now() });
    world.say(a, 'já leio, tô chegando', 'white', 3000);
    await changed();
    return closeChat();
  }
  const shots = c.images ? `${'[imagem] '.repeat(c.images)}` : '';
  if (state.settings.holdPrompt && t) {
    // Esperar a entrega: o pedido só vai pro terminal quando você chega na mesa.
    let gone = false;
    const go = () => {
      if (gone) return;
      gone = true;
      sendHeld(a.tabId, t);
    };
    // Se a entrega empacar (ele saiu, a janela fechou de vez), vai assim mesmo.
    const late = setTimeout(go, HOLD_MAX_MS);
    const carried = world.deliver(a, clip(t, 34), () => {
      clearTimeout(late);
      go();
    });
    if (carried) {
      c.sent++;
      c.problem = '';
      c.images = 0;
      c.pending.push({ text: `${shots}${t}`.trim(), at: Date.now() });
      await changed();
      return closeChat();
    }
    // Sem ninguém pra levar (a janela fechada, o "levar o pedido" desligado): vai direto.
    clearTimeout(late);
  }
  try {
    await mx.request('terminal.sendText', { tabId: a.tabId, text: t, submit: true });
    c.sent++;
    c.problem = '';
    c.images = 0;
    c.pending.push({ text: `${shots}${t}`.trim(), at: Date.now() });
  } catch (e) {
    c.problem = a.hibernated
      ? 'a sessão está hibernada: clique no terminal aqui em cima pra acordá-la'
      : `não deu pra mandar: ${e.message}`;
    // Não foi: a conversa fica aberta, com o aviso, pra tentar de novo.
    return refreshChat();
  }
  // Mandou: a conversa fecha e volta pro boneco, e você vê o pedido chegar
  // até a mesa dele.
  await closeChat();
}

// Quanto o pedido espera a entrega, no máximo, antes de ir assim mesmo.
const HOLD_MAX_MS = 30000;

/** O pedido que esperou a entrega: chegou na mesa, vai pro terminal. */
async function sendHeld(tabId, text) {
  // O hook do pedido vem logo atrás: você já o levou, não leva de novo.
  world.expectPrompt(tabId);
  try {
    await mx.request('terminal.sendText', { tabId, text, submit: true });
  } catch (e) {
    world.expectPrompt(tabId, false);
    await mx.request('window.showBanner', { text: `não deu pra mandar o pedido: ${e.message}` }).catch(() => {});
  }
}

/**
 * Um print colado no campo: vai pro prompt do claude pelo mesmo ^V do terminal
 * (ele lê a imagem da área de transferência), e segue com a próxima mensagem.
 */
async function pasteImage() {
  const c = state.chat;
  const a = ownerOf(c.tabId);
  if (!a) return;
  if (a.status === 'waitingPermission' || a.status === 'waitingAnswer') return;
  if (a.status === 'starting') {
    // Chegando: o print espera o prompt dele subir (ver `send`).
    enqueue(a, { kind: 'paste' });
    c.images++;
    return refreshChat();
  }
  if (a.hibernated || state.waking.has(a.tabId)) {
    // O print também espera: assim que ele acordar, vai pro prompt dele.
    enqueue(a, { kind: 'paste' });
    c.images++;
    await wakeUp(a);
    return refreshChat();
  }
  try {
    await mx.request('terminal.pasteClipboard', { tabId: a.tabId });
    c.images++;
    c.problem = '';
  } catch (e) {
    c.problem = a.hibernated
      ? 'a sessão está hibernada: clique no terminal aqui em cima pra acordá-la'
      : `não deu pra colar o print: ${e.message}`;
  }
  await refreshChat();
}

// --- acordar ------------------------------------------------------------------------
//
// Uma sessão hibernada não tem processo: nada que se mande chega. O plugin a
// acorda (`session.wake`), e o que foi pedido enquanto ela dormia fica numa
// fila até ela voltar ao prompt -- o `session.status` com `ready` (ou parada) --,
// mais um respiro pro prompt do Claude Code subir de verdade.

const WOKE_GRACE_MS = 1500;

function enqueue(a, action) {
  if (!state.queue.has(a.tabId)) state.queue.set(a.tabId, []);
  state.queue.get(a.tabId).push(action);
}

async function wakeUp(a) {
  const c = state.chat;
  if (state.waking.has(a.tabId)) return;
  if (!state.wake) {
    c.problem = 'esta Maestria não acorda pelo plugin: clique no terminal aqui em cima pra acordá-lo';
    return;
  }
  try {
    await mx.request('session.wake', { tabId: a.tabId });
    state.waking.add(a.tabId);
    // Se o "pronto" não vier (o claude não subiu), a fila tenta assim mesmo
    // depois de um tempo, em vez de segurar a mensagem pra sempre.
    setTimeout(() => {
      if (state.waking.has(a.tabId)) drain(a.tabId);
    }, 30000);
    // O evento vem logo atrás; aqui ele já levanta do sofá.
    world.status(a.tabId, 'starting', { hibernated: false });
    await changed();
  } catch (e) {
    c.problem = `não deu pra acordar: ${e.message}`;
  }
}

/** Ele voltou ao prompt: faz, na ordem, o que foi pedido enquanto dormia. */
async function drain(tabId) {
  if (!state.waking.has(tabId) && !state.queue.has(tabId)) return;
  // O respiro antes de escrever no prompt que acabou de subir. Quem pedir
  // alguma coisa nesse meio-tempo ainda entra na fila.
  await new Promise((r) => setTimeout(r, WOKE_GRACE_MS));
  const actions = state.queue.get(tabId) || [];
  state.queue.delete(tabId);
  state.waking.delete(tabId);
  for (const act of actions) {
    try {
      if (act.kind === 'paste') {
        await mx.request('terminal.pasteClipboard', { tabId });
        await new Promise((r) => setTimeout(r, 300));
      } else {
        await mx.request('terminal.sendText', { tabId, text: act.text, submit: true });
        if (state.chat.tabId === tabId) state.chat.images = 0;
      }
    } catch (e) {
      if (state.chat.tabId === tabId) state.chat.problem = `não deu pra mandar depois de acordar: ${e.message}`;
    }
  }
  await refreshChat();
}

// --- renomear ----------------------------------------------------------------------

/**
 * O nome da conversa de [tabId], como o "renomear" da lateral: pergunta o nome
 * novo (já com o de agora selecionado) e o põe na sessão -- vale pra Maestria
 * inteira. O boneco, a lateral e o chat mudam junto.
 */
async function rename(tabId) {
  const a = world.agents.get(tabId);
  if (!a || a.kind !== 'claude') return;
  if (!state.rename) {
    await mx.request('window.showBanner', { text: 'esta Maestria não renomeia pelo plugin — renomeie pela lateral' });
    return;
  }
  const title = await mx.request('window.input', {
    title: 'renomear a conversa',
    value: a.name,
    placeholder: 'o nome da conversa',
    prompt: 'vale pra Maestria inteira: a lateral, o cabeçalho e o histórico',
  });
  if (title === null || title === undefined) return;
  await setName(tabId, title);
}

/** Põe [title] na sessão de [tabId]: o boneco, a lateral e o chat mudam junto. */
async function setName(tabId, title) {
  try {
    const r = await mx.request('session.rename', { tabId, title });
    world.renamed(tabId, (r && r.title) || title);
  } catch (e) {
    await mx.request('window.showBanner', { text: `não deu pra renomear: ${e.message}` });
    return refreshChat();
  }
  await changed();
  if (state.chat.open && state.chat.tabId === tabId) {
    const who = world.agents.get(tabId);
    await mx.request('view.update', { viewId: CHAT, title: `conversa · ${who.name}`, data: { chat: chatData() } }).catch(() => {});
  }
}

// --- mandar pra casa ----------------------------------------------------------------

/**
 * Fecha a sessão de [tabId] -- o boneco se despede e sai pela porta. Pergunta
 * antes: é a sua sessão, e um claude no meio do trabalho para onde estiver. A
 * conversa fica no histórico da Maestria, como quando você fecha o painel.
 */
async function sendHome(tabId) {
  const a = world.agents.get(tabId);
  if (!a || a.kind !== 'claude') return;
  if (!state.closeSessions) {
    await mx.request('window.showBanner', { text: 'esta Maestria não deixa o plugin fechar sessões — feche pelo terminal dele' });
    return;
  }
  const busy = ['working', 'tool', 'starting'].includes(a.status);
  const choice = await mx.request('window.pick', {
    title: `mandar ${a.name} pra casa?`,
    placeholder: busy ? 'ele está trabalhando: o que estiver fazendo para aqui' : 'a sessão fecha; a conversa fica no histórico',
    items: [
      { value: 'sim', label: 'sim, mandar pra casa', detail: 'fecha a sessão' },
      { value: 'nao', label: 'não, deixa ele aí' },
    ],
  });
  if (choice !== 'sim') return;
  if (state.chat.open && state.chat.tabId === tabId) {
    await mx.request('view.close', { viewId: CHAT }).catch(() => {});
    state.chat.open = false;
  }
  try {
    await mx.request('session.close', { tabId });
  } catch (e) {
    await mx.request('window.showBanner', { text: `não deu pra fechar: ${e.message}` });
    return;
  }
  state.queue.delete(tabId);
  // O session.closed vem logo atrás; aqui ele já se despede e vai embora.
  world.closed(tabId);
  world.say(a, 'tchau! 👋', 'white', 4000);
  await changed();
}

// --- chamar um claude ---------------------------------------------------------------

function novoData() {
  const n = state.novo;
  const name = (value) => {
    const f = n.folders.find((x) => x.value === value);
    return f ? f.label : path.basename(value || '');
  };
  // Da mesa: as pastas daquela sala (a principal e as worktrees), em chips.
  const places = n.room ? n.folders.filter((f) => f.repo === n.room) : [];
  return {
    compact: !!n.room,
    room: n.room ? name(n.room) : '',
    places: places.length > 1
      ? places.map((f) => ({
          value: f.value,
          label: f.chip,
          tip: f.worktree ? `worktree ${f.sub.replace(/^worktree · /, '')}` : f.sub,
          color: f.value === n.chosen ? 0x33d97757 : 0,
          fg: f.value === n.chosen ? 0xffd97757 : 0xff8b8799,
          icon: f.worktree ? 'branch' : 'folder',
        }))
      : [],
    hasPlaces: places.length > 1,
    folders: n.folders.map((f) => ({
      ...f,
      color: f.value === n.chosen ? 0x33d97757 : 0, // a escolhida, num laranja claro
      tint: f.value === n.chosen ? 0xffd97757 : 0xff8b8799,
      icon: f.value === n.chosen ? 'check' : f.worktree ? 'branch' : 'folder',
    })),
    placeholder: n.chosen ? `o que ele deve fazer em ${n.room ? name(n.chosen) : path.basename(n.chosen)}?` : 'escolha uma pasta aí em cima',
    problem: { on: !!n.problem, text: n.problem || '' },
    // Da mesa, o print já está no prompt dele; senão, espera ele sentar.
    attached: {
      on: n.images > 0,
      text: n.tabId
        ? `${n.images === 1 ? 'um print colado' : `${n.images} prints colados`} — vai junto com o pedido`
        : 'um print colado — vai pro prompt dele junto com o pedido, assim que ele sentar',
    },
    allowEmpty: n.images > 0,
    sent: n.sent,
  };
}

/**
 * Abre o "chamar um claude", já na pasta de [room] quando veio de uma mesa
 * vazia, crescendo a partir de [from] (a mesa, ou o botão de onde veio).
 */
async function openNovo(room, from = 'chamar', desk = null) {
  const n = state.novo;
  // O da mesa de antes, se ficou sem pedido: vai embora antes do próximo.
  await dismiss();
  let folders = [];
  try {
    folders = await mx.request('folders.list');
  } catch (e) {
    mx.log('folders.list:', e.message);
  }
  n.folders = [];
  for (const f of folders || []) {
    const name = f.name || path.basename(f.root);
    n.folders.push({ value: f.root, repo: f.root, label: name, chip: f.branch || name, sub: f.branch ? `branch ${f.branch}` : f.root, worktree: false });
    for (const w of f.worktrees || []) {
      if (w.isMain || w.prunable) continue;
      n.folders.push({
        value: w.path,
        repo: f.root,
        label: `${name} · ${w.label || w.branch || path.basename(w.path)}`,
        chip: w.label || w.branch || path.basename(w.path),
        sub: `worktree${w.branch ? ` · ${w.branch}` : ''}`,
        worktree: true,
      });
    }
  }
  n.chosen = (room && n.folders.find((f) => f.value === room) && room) || n.chosen || (n.folders[0] && n.folders[0].value) || null;
  if (n.chosen && !n.folders.some((f) => f.value === n.chosen)) n.chosen = n.folders[0] ? n.folders[0].value : null;
  n.problem = n.folders.length ? '' : 'nenhuma pasta na lateral da Maestria';
  n.images = 0;
  // Da mesa de uma sala que está na lateral: a janelinha pequena, só com o pedido.
  n.room = room && n.folders.some((f) => f.value === room) ? room : null;
  const places = n.room ? n.folders.filter((f) => f.repo === n.room).length : 0;
  const size = n.room ? { ...MESA_SIZE, height: MESA_SIZE.height + (places > 1 ? MESA_CHIPS : 0) } : NOVO_SIZE;
  await mx.request('view.open', {
    viewId: NOVO,
    title: 'chamar um claude',
    modal: true,
    from,
    ...size,
    rfw: { library: CHAT_UI, root: 'novo' },
    data: { novo: novoData(), sprites: state.sprites },
  });
  n.open = true;
  if (n.room) n.starting = prestart(desk);
}

/**
 * Da mesa: o claude já sobe e vem andando até ela enquanto você escreve, e os
 * prints vão direto pro prompt dele. Sem pedido (a janelinha fechou), ele vai
 * embora -- por isso só com o `session.close`, e em segundo plano (senão a
 * sessão tomaria a tela).
 */
async function prestart(desk) {
  const n = state.novo;
  if (!state.background || !state.closeSessions || !n.chosen) return;
  try {
    const { tabId } = await mx.request('session.openClaude', { cwd: n.chosen, background: true });
    if (!tabId) return;
    n.tabId = tabId;
    await sync();
    // Na mesa que você clicou, se ela ainda estiver livre.
    const a = ownerOf(tabId);
    const free = desk && !world.people().some((x) => x !== a && x.desk === desk && !x.leaving);
    if (a && free && a.room === n.room) a.desk = desk;
    await changed();
  } catch (e) {
    // Não subiu: o pedido abre a sessão do jeito de sempre.
    mx.log('chamar da mesa:', e.message);
  }
}

/** O claude da mesa sem pedido nenhum: fecha a sessão, e ele se despede e sai. */
async function dismiss() {
  const n = state.novo;
  if (n.starting) await n.starting;
  const tabId = n.tabId;
  n.tabId = null;
  n.starting = null;
  n.images = 0;
  if (!tabId) return;
  state.queue.delete(tabId);
  try {
    await mx.request('session.close', { tabId });
  } catch (e) {
    mx.log('session.close:', e.message);
    return;
  }
  const a = ownerOf(tabId);
  world.closed(tabId);
  if (a) world.say(a, 'tchau! 👋', 'white', 4000);
  await changed();
}

/** Ainda subindo (ou com a fila andando), o que for pro prompt dele espera a vez. */
function later(tabId) {
  const a = ownerOf(tabId);
  return !a || a.status === 'starting' || state.queue.has(tabId);
}

/** Um print colado no claude da mesa: vai pro prompt dele, como no chat. */
async function pasteNovo() {
  const n = state.novo;
  const tabId = n.tabId;
  try {
    if (later(tabId)) enqueue({ tabId }, { kind: 'paste' });
    else await mx.request('terminal.pasteClipboard', { tabId });
    n.images++;
    n.problem = '';
  } catch (e) {
    n.problem = `não deu pra colar o print: ${e.message}`;
  }
  await refreshNovo();
}

async function refreshNovo() {
  const { open: still } = await mx.request('view.update', { viewId: NOVO, data: { novo: novoData() } });
  state.novo.open = still;
}

/** Abre a sessão (em segundo plano, quando dá) e já abre a conversa com ela. */
async function callClaude(prompt) {
  const n = state.novo;
  if (n.starting) await n.starting;
  if (n.tabId) return callMesa(prompt);
  if (!n.chosen) return;
  const text = String(prompt || '').trim();
  try {
    const params = { cwd: n.chosen };
    // Com um print, o pedido não vai na abertura: os dois esperam o prompt dele
    // subir (ver `drain`), o print primeiro, pra seguirem na mesma mensagem.
    if (text && !n.images) params.prompt = text;
    if (state.background) params.background = true;
    const { tabId } = await mx.request('session.openClaude', params);
    if (n.images && tabId) {
      enqueue({ tabId }, { kind: 'paste' });
      enqueue({ tabId }, { kind: 'send', text });
    }
    n.sent++;
    n.problem = '';
    n.images = 0;
    await mx.request('view.close', { viewId: NOVO }).catch(() => {});
    n.open = false;
    await sync();
    await changed();
    if (state.background && tabId) await openChat(tabId);
  } catch (e) {
    n.problem = `não abriu: ${e.message}`;
    await refreshNovo();
  }
}

/** O pedido pro claude que a mesa já chamou: ele fica, e a conversa abre. */
async function callMesa(prompt) {
  const n = state.novo;
  const tabId = n.tabId;
  const text = String(prompt || '').trim();
  try {
    if (text || n.images) {
      if (later(tabId)) enqueue({ tabId }, { kind: 'send', text });
      else await mx.request('terminal.sendText', { tabId, text, submit: true });
    }
  } catch (e) {
    n.problem = `não deu pra mandar: ${e.message}`;
    return refreshNovo();
  }
  n.tabId = null;
  n.starting = null;
  n.sent++;
  n.problem = '';
  n.images = 0;
  await mx.request('view.close', { viewId: NOVO }).catch(() => {});
  n.open = false;
  await changed();
  await openChat(tabId);
}

// --- o bicho e o zoom, que ficam de uma vez pra outra -------------------------------

function prefsFile() {
  return state.dataDir ? path.join(state.dataDir, 'prefs.json') : null;
}

function loadPrefs() {
  const file = prefsFile();
  if (!file) {
    applyLook();
    return;
  }
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (p && typeof p.pet === 'string') world.petPref = p.pet;
    if (p && ZOOMS.includes(p.zoom)) state.zoom = p.zoom;
    if (p && p.voce && typeof p.voce === 'object') state.look = { ...state.look, ...p.voce };
    if (p && typeof p.theme === 'string' && office.THEMES[p.theme]) state.themePref = p.theme;
    if (p && p.decor && typeof p.decor === 'object') world.decor = p.decor;
    if (p && p.dailyAuto) state.dailyAuto = p.dailyAuto;
    if (p && p.morning) state.morning = p.morning;
  } catch {
    // Sem arquivo ainda: vale o das configurações.
  }
  applyTheme();
  applyLook();
}

/** O tema valendo: o escolhido na tela, senão o das configurações. */
function applyTheme() {
  return world.setTheme(state.themePref || state.settings.theme || 'classico');
}

function savePrefs() {
  const file = prefsFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          pet: world.petPref || null,
          zoom: state.zoom,
          voce: state.look,
          theme: state.themePref,
          decor: world.decor,
          dailyAuto: state.dailyAuto || 0,
          morning: state.morning || '',
        },
        null,
        2,
      ),
    );
  } catch (e) {
    mx.log('prefs:', e.message);
  }
}

// --- você ---------------------------------------------------------------------------
//
// O seu boneco mora na sua sala. O "personalizar" (o clique nele) escolhe o
// nome e as cores, e o acessório; cada escolha gera a folha sob medida
// (`sprites.buildLook`) e fica guardada no prefs.json.

const LOOK_DEFAULT = { name: 'você', hair: '#2b1d17', skin: '#e9bc98', shirt: '#33384a', pants: '#24324a', shoes: '#e7e2d6', accessory: '' };

// As opções de cada parte, numa paleta que combina com a pixel art.
const LOOK_PARTS = [
  { part: 'hair', label: 'cabelo', colors: ['#1f1b1d', '#2b1d17', '#5b3b2a', '#7b4a2a', '#a8452c', '#e2b356', '#cfcfd6', '#d96a9c', '#4e8ad1', '#57a773'] },
  { part: 'skin', label: 'pele', colors: ['#f6d2b8', '#f1c7a4', '#e9bc98', '#c48b63', '#a8714f', '#7a4e36'] },
  { part: 'shirt', label: 'camisa', colors: ['#33384a', '#d97757', '#4e8ad1', '#57a773', '#8b6cc9', '#e0b443', '#cf5c7c', '#3fb5b0', '#e8e8ee', '#1f1b1d'] },
  { part: 'pants', label: 'calça', colors: ['#24324a', '#3c4a6b', '#33363f', '#463c35', '#2f3d55', '#6b6b78', '#5b3b2a'] },
  { part: 'shoes', label: 'tênis', colors: ['#e7e2d6', '#2b2b33', '#4a2e22', '#c94f3d', '#4e8ad1'] },
];
const ACCESSORIES = [
  { value: '', label: 'nada' },
  { value: 'oculos', label: 'óculos' },
  { value: 'fone', label: 'fone' },
];

/** O seu visual valendo: gera a folha (se precisar) e veste o boneco. */
function applyLook() {
  const look = { ...LOOK_DEFAULT, ...state.look };
  try {
    const id = sprites.buildLook(__dirname, look);
    world.youSkin = { ...sprites.VOCE, ...look, id };
  } catch (e) {
    mx.log('voce:', e.message);
  }
  world.youName = String(look.name || '').trim() || 'você';
  // O nome está na plaquinha da sala: a planta muda junto.
  if (world.plan) world.relayout();
}

const argbOf = (hex) => (0xff000000 | parseInt(String(hex).slice(1), 16)) >>> 0;

function voceData() {
  const look = { ...LOOK_DEFAULT, ...state.look };
  return {
    name: world.youName,
    room: world.officeName(),
    sheet: sprites.sheetOf(world.youSkin.id),
    rows: sprites.ROWS,
    row: sprites.ROW.down,
    parts: LOOK_PARTS.map((g) => ({
      label: g.label,
      options: g.colors.map((c) => ({ color: argbOf(c), on: look[g.part] === c, action: `voce-cor:${g.part}:${c}` })),
    })),
    accessories: ACCESSORIES.map((x) => ({ label: x.label, on: (look.accessory || '') === x.value, action: `voce-acessorio:${x.value}` })),
    sent: state.lookSent,
    office: world.officeOn(),
  };
}

async function openVoce() {
  if (!state.rfw) return;
  await mx.request('view.open', {
    viewId: VOCE,
    title: 'personalizar você',
    modal: true,
    from: 'voce',
    width: 520,
    height: 640,
    rfw: { library: CHAT_UI, root: 'voce' },
    data: { voce: voceData(), sprites: state.sprites },
  });
}

/** Uma escolha no "personalizar": guarda, veste, e atualiza a janelinha e o escritório. */
async function setLook(change) {
  state.look = { ...LOOK_DEFAULT, ...state.look, ...change };
  savePrefs();
  applyLook();
  await mx.request('view.update', { viewId: VOCE, data: { voce: voceData() } }).catch(() => {});
  state.sentScene = -1;
  await flush();
}

// --- os vasos ----------------------------------------------------------------------
//
// O vaso de cada sala cresce com os commits da última semana do repositório
// dela (`git rev-list --count --since`). Conta quando o escritório sobe, a cada
// dez minutos, e uns segundos depois de um commit ou push de algum claude.

const GROWTH_MS = 10 * 60 * 1000;
let growthAt = 0;
let growthTimer = null;
let growthCommit = 0;

function commitsOf(root) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, 'rev-list', '--count', '--since=7.days', 'HEAD'], { timeout: 5000 }, (err, out) => {
      resolve(err ? null : Number(String(out).trim()) || 0);
    });
  });
}

async function refreshGrowth({ force = false } = {}) {
  if (!force && Date.now() - growthAt < GROWTH_MS) return;
  growthAt = Date.now();
  const rooms = (world.plan ? world.plan.rooms : []).filter((r) => r.kind === 'room' && path.isAbsolute(r.id));
  const counts = {};
  for (const r of rooms) {
    const n = await commitsOf(r.id);
    if (n !== null) counts[r.id] = n;
  }
  if (world.setGrowth(counts)) await flush();
}

/** Um commit (ou push) acabou de acontecer: reconta daqui a pouco. */
function growthSoon() {
  if (world.commitsAt === growthCommit) return;
  growthCommit = world.commitsAt;
  clearTimeout(growthTimer);
  growthTimer = setTimeout(() => refreshGrowth({ force: true }).catch((e) => mx.log('vasos:', e.message)), 4000);
}

// --- o relógio --------------------------------------------------------------------

/**
 * Dois relógios: o rápido só roda com alguém andando (e a janela aberta), pra
 * puxar o próximo trecho do caminho na hora; o lento, uma vez por segundo, cuida
 * dos balões, da ida pro café e do papo da sala do descanso.
 */
function clock() {
  const fast = state.viewOpen && world.busy();
  if (fast && !state.fast) {
    state.fast = setInterval(() => {
      if (state.viewOpen && world.tick()) flush();
      if (!state.viewOpen || (!world.busy() && !state.flushing)) {
        clearInterval(state.fast);
        state.fast = null;
      }
    }, FAST_MS);
  }
  if (!state.slow) {
    state.slow = setInterval(() => {
      refreshUsage().catch(() => {});
      dailySoon();
      let changed = world.housekeeping();
      if (state.viewOpen) changed = world.tick() || changed;
      if (changed) flush();
      else clock();
      // A reunião acabou sozinha com a janela da daily aberta: o botão volta.
      if (state.daily.open && state.daily.meetingShown !== world.inDaily()) refreshDaily();
    }, SLOW_MS);
  }
}

// --- as sessões -------------------------------------------------------------------

async function sync({ snap = false } = {}) {
  try {
    const [list, folders] = await Promise.all([mx.request('sessions.list'), mx.request('folders.list').catch(() => [])]);
    world.setFolders(folders);
    const rooms = world.plan ? world.plan.rooms.length : 0;
    world.syncSessions(list, { snap: snap || !state.viewOpen });
    // Uma sala nova: conta os commits dela (as outras, no tempo de sempre).
    if (world.plan && world.plan.rooms.length > rooms && growthAt) refreshGrowth({ force: true }).catch(() => {});
    else refreshGrowth().catch(() => {});
    sendPortraits().catch(() => {});
  } catch (e) {
    mx.log('sessions.list:', e.message);
  }
}

/**
 * Algo mudou numa sessão. Os hooks chegam em rajada (o fim de uma ferramenta,
 * o status, o começo da próxima), e cada um mandaria a janela se atualizar:
 * as mudanças de um instante vão juntas, num envio só.
 */
const COALESCE_MS = 30;
let coalescing = null;
async function changed() {
  await updateBadge();
  if (!(state.viewOpen || state.sidebarShown) || coalescing) return;
  coalescing = setTimeout(() => {
    coalescing = null;
    flush();
  }, COALESCE_MS);
}

mx.onNotification('event', async (e) => {
  switch (e.type) {
    case 'session.opened':
    case 'session.exited':
      await sync();
      return changed();
    case 'session.closed':
      if (world.closed(e.tabId)) await changed();
      refreshChatSoon(e.tabId);
      return;
    case 'session.status':
      if (!world.status(e.tabId, e.status, { hibernated: e.hibernated })) await sync();
      // Acordou e voltou ao prompt: o que esperava na fila vai agora.
      if (['ready', 'idle', 'waitingInput'].includes(e.status) && e.hibernated !== true) drain(e.tabId);
      refreshChatSoon(e.tabId);
      return changed();
    case 'session.renamed':
      // Renomeada (pela lateral, ou por aqui): o boneco, a lateral e o chat.
      if (world.renamed(e.tabId, e.title)) await changed();
      refreshChatSoon(e.tabId);
      return;
    case 'session.context':
      if (world.context(e.tabId, e.context)) await changed();
      refreshChatSoon(e.tabId);
      return;
    case 'hook':
      if (world.hook(e.tabId, e.name, e.payload || {})) await changed();
      growthSoon();
      refreshChatSoon(e.tabId);
      return;
    case 'sidebar.shown':
      state.sidebarShown = true;
      await sync();
      return pushSidebar();
    case 'sidebar.hidden':
      state.sidebarShown = false;
      return;
    case 'view.closed':
      // A janelinha fechou: a do chat esquece que estava aberta.
      if (e.viewId === DAILY) closedDaily();
      else if (e.viewId === CHAT) state.chat.open = false;
      else if (e.viewId === NOVO) {
        // Fechou sem pedido: o claude que a mesa chamou vai embora.
        state.novo.open = false;
        await dismiss();
      }
      return;
    default:
  }
});

mx.onNotification('view.action', async ({ viewId, action, values = {} }) => {
  const a = action === 'act' ? values.a || values.action : action;
  if (!a) return;
  if (a === 'abrir') return open();
  if (a === 'voce') return openVoce();
  if (viewId === VOCE) {
    if (a.startsWith('voce-cor:')) {
      const [, part, color] = a.split(':');
      if (LOOK_PARTS.some((g) => g.part === part)) return setLook({ [part]: color });
      return;
    }
    if (a.startsWith('voce-acessorio:')) return setLook({ accessory: a.slice('voce-acessorio:'.length) });
    if (a === 'voce-nome') {
      state.lookSent++;
      return setLook({ name: String(values.text || '').trim().slice(0, 24) || 'você' });
    }
    if (a === 'voce-padrao') return setLook({ ...LOOK_DEFAULT });
    if (a === 'voce-pronto') return mx.request('view.close', { viewId: VOCE }).catch(() => {});
    return;
  }
  if (a === 'bicho') {
    if (world.petPet()) await flush();
    return;
  }
  if (a.startsWith('bicho:')) {
    world.petPref = a.slice('bicho:'.length);
    savePrefs();
    world.ensurePet();
    world.ensureYou();
    return flush();
  }
  if (a === 'daily') return viewDaily('daily');
  if (a === 'expediente') return summarize({ title: 'fim do expediente', from: 'porta' });
  if (viewId === DAILY) return dailyAction(a, values);
  if (a === 'caixa') return openInbox();
  if (a.startsWith('recados:')) return openNotes(a.slice('recados:'.length));
  if (a === 'selecionar') return toggleSelecting();
  if (a.startsWith('sel:')) {
    const what = a.slice('sel:'.length);
    if (what === 'mandar') return openGroup();
    if (what === 'todos') {
      for (const p of world.people()) if (p.kind === 'claude' && !p.leaving) state.selected.add(p.tabId);
      return flush();
    }
    if (!state.selecting) state.selecting = true; // do botão direito: já entra selecionando
    return toggleSelected(what);
  }
  if (viewId === GRUPO) {
    if (a === 'grupo-enviar' || a === 'grupo-preset') return sendGroup(values.text);
    if (a === 'grupo-tirar') {
      state.selected.delete(String(values.tab || ''));
      if (!state.selected.size) await mx.request('view.close', { viewId: GRUPO }).catch(() => {});
      else await mx.request('view.update', { viewId: GRUPO, data: { grupo: groupData() } }).catch(() => {});
      return flush();
    }
    return;
  }
  if (a.startsWith('tema:')) {
    state.themePref = a.slice('tema:'.length);
    savePrefs();
    if (applyTheme()) {
      state.sentScene = -1;
      await flush();
    }
    return;
  }
  if (a === 'moveis') {
    world.decorating = !world.decorating;
    return flush();
  }
  if (a === 'moveis:padrao') {
    if (world.resetDecor()) {
      savePrefs();
      await flush();
    }
    return;
  }
  if (a === 'movel') {
    // Soltou um móvel numa vaga: `payload` é "sala|móvel"; `to`, "vaga|sala|dx,dy".
    const [room, key] = String(values.payload || '').split('|');
    const [, toRoom, spot] = String(values.to || '').split('|');
    const [dx, dy] = String(spot || '').split(',').map(Number);
    if (!room || room !== toRoom || !Number.isInteger(dx) || !Number.isInteger(dy)) return;
    if (world.moveDecor(room, key, dx, dy)) {
      savePrefs();
      await flush();
    } else {
      await mx.request('window.showBanner', { text: 'aí não dá: o móvel fecharia a passagem de alguém' }).catch(() => {});
    }
    return;
  }
  if (a === 'zoom:escala') {
    state.zoomCmd.scale = Number(values.scale) || 1;
    return flush();
  }
  if (a.startsWith('zoom:') && state.zoomView) {
    const z = state.zoomCmd;
    z.command = { '+': 'in', '-': 'out', caber: 'fit' }[a.slice('zoom:'.length)] || '';
    z.rev++;
    return flush();
  }
  if (a.startsWith('zoom:')) {
    state.zoom = nextZoom(a.slice('zoom:'.length));
    savePrefs();
    return flush();
  }
  if (a.startsWith('chat:')) {
    const tabId = a.slice('chat:'.length);
    return openChat(tabId, viewId === SIDEBAR ? `linha:${tabId}` : `agente:${tabId}`);
  }
  if (a.startsWith('casa:')) return sendHome(a.slice('casa:'.length));
  if (a.startsWith('renomear:')) return rename(a.slice('renomear:'.length));
  if (a.startsWith('descanso:')) {
    if (world.rest(a.slice('descanso:'.length))) await changed();
    return;
  }
  if (a.startsWith('voltar:')) {
    if (world.backToDesk(a.slice('voltar:'.length))) await changed();
    return;
  }
  if (a.startsWith('ir:')) {
    return mx.request('session.focus', { tabId: a.slice('ir:'.length) }).catch((e) => mx.log('session.focus:', e.message));
  }
  if (a.startsWith('dormir:')) return nap(a.slice('dormir:'.length));
  if (a.startsWith('acordar:')) {
    const who = world.agents.get(a.slice('acordar:'.length));
    if (who && who.hibernated) await wakeUp(who);
    return;
  }
  if (a === 'chamar') return openNovo(null, viewId === SIDEBAR ? 'chamar-lateral' : 'chamar');
  if (a.startsWith('mesa:')) {
    // A mesa vazia: o "chamar" sai dela, já na sala dela.
    const id = a.slice('mesa:'.length);
    const desk = world.plan && world.plan.desks.find((d) => d.id === id);
    return openNovo(desk ? desk.room : null, `mesa:${id}`, id);
  }
  if (viewId === CHAT) {
    if (a === 'enviar') return send(values.text);
    if (a === 'responder') return pick(Number(values.q), Number(values.o));
    if (a === 'confirmar') return confirm(Number(values.q));
    if (a === 'permitir' || a === 'negar') return answerPermission(String(values.id || ''), a === 'permitir');
    if (a === 'proximo') return nextInbox();
    if (a === 'dormir') return nap(state.chat.tabId);
    if (a === 'seta') return arrow(values.key);
    if (a === 'imagem') return pasteImage();
    if (a === 'casa') return sendHome(state.chat.tabId);
    // O nome no topo vira campo: o enter renomeia, o ✕ deixa como estava.
    if (a === 'renomear') {
      if (!state.rename) return rename(state.chat.tabId);
      state.chat.naming = true;
      return refreshChat();
    }
    if (a === 'nome' || a === 'nome-cancelar') {
      state.chat.naming = false;
      const who = ownerOf(state.chat.tabId);
      const title = String(values.text || '').trim();
      if (a === 'nome' && who && title && title !== who.name) return setName(who.tabId, title);
      return refreshChat();
    }
    if (a === 'descanso' || a === 'voltar') {
      const ok = a === 'descanso' ? world.rest(state.chat.tabId) : world.backToDesk(state.chat.tabId);
      if (!ok) return;
      await changed();
      // O chat fecha e volta pro boneco: você vê ele indo (ou voltando).
      return closeChat();
    }
    if (a === 'acordar') {
      const who = ownerOf(state.chat.tabId);
      if (who && who.hibernated) await wakeUp(who);
      return refreshChat();
    }
    if (a === 'ir') {
      await mx.request('view.close', { viewId: CHAT }).catch(() => {});
      state.chat.open = false;
      return mx.request('session.focus', { tabId: state.chat.tabId }).catch((e) => mx.log('session.focus:', e.message));
    }
    return;
  }
  if (viewId === NOVO) {
    if (a === 'novo-pasta') {
      const n = state.novo;
      if (values.v === n.chosen) return;
      // Outra worktree: quem já vinha volta, e vem um claude da pasta nova.
      const again = n.room && (n.starting || n.tabId);
      if (again) await dismiss();
      n.chosen = values.v;
      if (again) n.starting = prestart(null);
      return refreshNovo();
    }
    if (a === 'novo-ir') return callClaude(values.text);
    // A área de transferência só é lida quando ele sentar: um print só por vez.
    if (a === 'novo-imagem') {
      const n = state.novo;
      if (n.starting) await n.starting;
      if (n.tabId) return pasteNovo();
      n.images = 1;
      return refreshNovo();
    }
    if (a === 'novo-vazio') return callClaude('');
    return;
  }
  if (a === 'atualizar') {
    await sync();
    world.snapAll();
    state.sentScene = -1;
    return flush();
  }
  if (a.startsWith('focus:')) {
    try {
      await mx.request('session.focus', { tabId: a.slice('focus:'.length) });
    } catch (e) {
      mx.log('session.focus:', e.message);
    }
  }
  if (viewId === SIDEBAR) return;
});

mx.onRequest('initialize', (params) => {
  state.rfw = Number(params.rfw) >= 1;
  state.sprites = Number(params.sprites) >= 1;
  state.modal = Number(params.modal) >= 1;
  state.background = Number(params.openInBackground) >= 1;
  state.markdown = Number(params.markdown) >= 1;
  state.pasteImage = Number(params.pasteImage) >= 1;
  state.keys = Number(params.keys) >= 1;
  state.arrows = Number(params.arrows) >= 1;
  state.zoomView = Number(params.zoom) >= 1;
  state.wake = Number(params.wake) >= 1;
  world.hibernateOn = Number(params.hibernate) >= 1 && state.wake;
  state.closeSessions = Number(params.closeSessions) >= 1;
  state.anchors = Number(params.modalFrom) >= 1;
  state.selectable = Number(params.selectable) >= 1;
  state.rename = Number(params.rename) >= 1;
  state.portrait = Number(params.portrait) >= 1;
  state.dataDir = params.dataDir || null;
  Object.assign(state.settings, params.settings || {});
  loadPrefs();
  // As folhas de sprites ficam na pasta do plugin; as que faltam se fazem aqui.
  try {
    const n = sprites.build(__dirname);
    if (n) mx.log(`gerei ${n} folhas de sprites`);
  } catch (e) {
    mx.log('sprites:', e.message);
  }
  // Os que já estão abertos entram sentados, sem esperar um evento.
  setTimeout(() => sync({ snap: true }).then(updateBadge).then(() => refreshGrowth({ force: true })), 0);
  clock();
  return {};
});

mx.onNotification('settings.changed', async ({ settings }) => {
  const before = state.settings.pet;
  const themeBefore = state.settings.theme;
  for (const k of Object.keys(state.settings)) delete state.settings[k];
  Object.assign(state.settings, settings || {});
  // Escolheu o bicho nas configurações: vale mais que a escolha antiga da tela.
  if ((settings || {}).pet !== before) {
    world.petPref = null;
    savePrefs();
  }
  // O tema também.
  if ((settings || {}).theme !== themeBefore) {
    state.themePref = null;
    savePrefs();
  }
  applyTheme();
  world.relayout();
  world.ensurePet();
  world.ensureYou();
  state.sentScene = -1;
  await flush();
});

mx.onRequest('command.invoke', async ({ command }) => {
  if (command === 'escritorio') await open();
  // Sem await: o modal espera você, e o command.invoke tem 30s pra voltar.
  else if (command === 'chamar') openNovo(null).catch((e) => mx.log('chamar:', String(e.stack || e)));
  else throw new Error(`comando desconhecido: ${command}`);
  return null;
});

mx.start();
