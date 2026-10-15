// O mundo do escritório: os bonecos, onde cada um quer estar e o caminho até
// lá. Não fala com a Maestria: o `main.js` conta o que aconteceu (as sessões,
// os status, os hooks, o contexto) e pede o que desenhar (`scene()`,
// `agentsData()`…).
//
// Cada claude aberto é um boneco com mesa na sala do repositório dele. O que a
// sessão faz decide o que ele faz:
//
// - trabalhando: sentado na mesa, digitando (Edit, Write, Bash…) ou lendo
//   (Read, Grep, a web…), com a tela acesa e a ferramenta num balão;
// - esperando você (permissão, pergunta, um recado): de pé, acenando, com o
//   balão vermelho ou amarelo;
// - à toa há um tempo: vai pra sala do descanso tomar café e bater papo; uma
//   sessão hibernada cochila no sofá;
// - fechou: sai pela porta.
//
// E o que acontece de verdade vira festa ou drama: o `git push` faz pular de
// braço pra cima, o commit solta uma folhinha, o teste que passou acende a tela
// de verde e o que quebrou faz pôr a mão na cabeça com a tela piscando
// vermelho. O contexto quase cheio dá suor; o `/compact`, uma espreguiçada. A
// lista do `TodoWrite` vai pro quadro branco da sala.
//
// Um subagente (o `Task`/`Agent`) é um ajudante de crachá: entra pela porta,
// senta numa mesa da mesma sala, trabalha com as ferramentas dele, e no fim vai
// até a mesa de quem o chamou contar como foi, e sai. O pedido que você manda é
// levado por você mesmo, da porta até a mesa. E o bicho do escritório -- o gato
// ou o cachorro, quem escolhe é você -- anda por
// aí: cochila no teclado de uma mesa vazia ou no sofá, e vai miar do lado de
// quem está esperando você há tempo demais.

'use strict';

const path = require('path');
const office = require('./office');
const sprites = require('./sprites');

const { T } = office;
const STEP_MS = 230; // quanto um boneco leva pra andar um tile
const SIT_MS = 160;
const PET_ID = '@bicho';
const YOU_ID = '@voce';
// Quanto o claude da sala do descanso espera você chegar com o pedido, e quanto
// você espera o claude chegar até a mesa antes de entregar assim mesmo.
const AWAIT_MS = 25000;
const YOU_WAIT_MS = 15000;
// A reunião de quem trabalha na mesma tarefa: quanto dura, e quanto tempo até
// os mesmos se reunirem de novo.
const MEETING_MS = 40000;
const MEET_AGAIN_MS = 10 * 60 * 1000;
// Quanto tempo sem mexer em nada da outra sala até a visita acabar.
const TRIP_MS = 30000;
// E quanto tempo o recado espera quem vai levá-lo chegar até o destino.
const ERRAND_MS = 60000;

// As animações, nas linhas da folha (ver `sprites.js`).
const ANIM = {
  down: { row: sprites.ROW.down, frames: 4, fps: 8 },
  up: { row: sprites.ROW.up, frames: 4, fps: 8 },
  right: { row: sprites.ROW.side, frames: 4, fps: 8 },
  left: { row: sprites.ROW.side, frames: 4, fps: 8, flip: true },
  type: { row: sprites.ROW.type, frames: 4, fps: 7 },
  read: { row: sprites.ROW.read, frames: 4, fps: 2 },
  idle: { row: sprites.ROW.idle, frames: 4, fps: 2.5 },
  wave: { row: sprites.ROW.wave, frames: 4, fps: 4 },
  sit: { row: sprites.ROW.sit, frames: 1, fps: 0 },
  cheer: { row: sprites.ROW.cheer, frames: 4, fps: 6 },
  facepalm: { row: sprites.ROW.facepalm, frames: 4, fps: 3 },
  sleep: { row: sprites.ROW.sleep, frames: 4, fps: 1.2 },
  tired: { row: sprites.ROW.tired, frames: 4, fps: 3 },
  stretch: { row: sprites.ROW.stretch, frames: 4, fps: 3 },
};

// O bicho: o gato e o cachorro têm a mesma grade.
const PET_ANIM = {
  down: { row: sprites.CAT_ROW.down, frames: 4, fps: 7 },
  up: { row: sprites.CAT_ROW.up, frames: 4, fps: 7 },
  right: { row: sprites.CAT_ROW.side, frames: 4, fps: 8 },
  left: { row: sprites.CAT_ROW.side, frames: 4, fps: 8, flip: true },
  sit: { row: sprites.CAT_ROW.sit, frames: 4, fps: 2 },
  sleep: { row: sprites.CAT_ROW.sleep, frames: 4, fps: 1.5 },
  meow: { row: sprites.CAT_ROW.meow, frames: 4, fps: 3 },
};

// O que muda de um bicho pro outro: o desenho, a fala e onde ele cochila (o
// gato sobe no teclado; o cachorro deita no chão, do lado da cadeira).
const SPECIES = {
  gato: {
    skin: sprites.CAT,
    name: 'gato',
    pet: 'miau',
    visit: 'miau?',
    tip: 'o gato do escritório — clique pra fazer carinho',
    climbs: true,
  },
  cachorro: {
    skin: sprites.DOG,
    name: 'cachorro',
    pet: 'au au!',
    visit: 'au?',
    tip: 'o cachorro do escritório — clique pra fazer carinho',
    climbs: false,
  },
};

// As cores dos balões e da bolinha do nome, em 0xAARRGGBB (como o rfw lê).
const TONE = {
  white: { bg: 0xfff6f2ea, fg: 0xff2a1f2d },
  quote: { bg: 0xffe9f0ff, fg: 0xff22324f },
  dim: { bg: 0xffd9d5e4, fg: 0xff4a4458 },
  red: { bg: 0xffe5534b, fg: 0xffffffff },
  yellow: { bg: 0xffeec05a, fg: 0xff2a1f2d },
  green: { bg: 0xff6cc483, fg: 0xff15301d },
};

// O "compactando" sem o `PostCompact` (um Esc no meio) some depois disso.
const COMPACT_MAX_MS = 5 * 60 * 1000;

const DOT = {
  working: 0xffd97757,
  tool: 0xffd97757,
  starting: 0xff9b7fd8,
  waitingPermission: 0xffe5534b,
  waitingAnswer: 0xffeec05a,
  waitingInput: 0xffeec05a,
  idle: 0xff6cc483,
  ready: 0xff6cc483,
  ended: 0xff8b8799,
  unknown: 0xff8b8799,
};

const STATUS_LABEL = {
  starting: 'chegando',
  ready: 'pronto',
  working: 'pensando',
  tool: 'trabalhando',
  waitingPermission: 'quer permissão',
  waitingAnswer: 'fez uma pergunta',
  waitingInput: 'esperando você',
  idle: 'à toa',
  ended: 'saiu',
  unknown: '—',
};

const SCREEN = {
  off: 0xff2c3140,
  type: 0xff4fb3e8,
  read: 0xff8fd19e,
  sit: 0xff6f86b8,
  wave: 0xffeec05a,
  pass: 0xff6cc483,
  fail: 0xffe5534b,
};

// O papo da sala do descanso.
const CHATTER = [
  '☕',
  'mais um café?',
  'rodou os testes?',
  'quem quebrou o build?',
  'já deu push?',
  'esse merge foi tenso',
  'tá compilando…',
  'o lint reclamou de novo',
  'viu aquele diff?',
  'bora pro próximo',
  'deploy na sexta não',
  'funciona na minha máquina',
  'refatora depois',
  'alguém deu comida pro bicho?',
  '…',
];

const BOX_W = 112;
const BOX_TOP = 22; // o espaço do balão em cima da cabeça
const FX_SLOTS = 12;
const BAR_W = 50; // a barra de progresso do quadro branco

// Os comandos que contam como rodar os testes.
const TEST_RE =
  /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|npx\s+(jest|vitest|playwright)\b|jest\b|vitest\b|pytest\b|flutter\s+test\b|dart\s+test\b|go\s+test\b|cargo\s+test\b|mix\s+test\b|rspec\b|phpunit\b|node\s+--test\b|deno\s+test\b|gradle\w*\s+test\b|mvn\s+test\b)/;
// E o que, na saída, diz que algum falhou mesmo com o comando saindo com zero.
const FAILED_RE = /\b[1-9]\d* (failed|failing|failures?)\b|Some tests failed|\bFAILED\b|Tests:\s+[1-9]\d* failed|✖ [1-9]/;

/** Um número que o rfw lê como double: o json não diz `16.0`, diz `16`. */
function d(n) {
  return Number.isInteger(n) ? n + 0.001 : n;
}

function clip(text, n) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** O que uma ferramenta vira: a animação e o texto do balão. */
function describe(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return { anim: 'type', label: `editando ${base(input.file_path)}` };
    case 'Write':
      return { anim: 'type', label: `escrevendo ${base(input.file_path)}` };
    case 'NotebookEdit':
      return { anim: 'type', label: `editando ${base(input.notebook_path)}` };
    case 'Read':
      return { anim: 'read', label: `lendo ${base(input.file_path)}` };
    case 'Grep':
      return { anim: 'read', label: `procurando ${clip(input.pattern, 18)}` };
    case 'Glob':
      return { anim: 'read', label: `procurando ${clip(input.pattern, 18)}` };
    case 'Bash':
      return { anim: 'type', label: `$ ${clip(input.command, 26)}` };
    case 'WebFetch':
    case 'WebSearch':
      return { anim: 'read', label: 'na web' };
    case 'Task':
    case 'Agent':
      return { anim: 'sit', label: 'chamou ajuda' };
    case 'TodoWrite':
      return { anim: 'type', label: 'anotando' };
    case 'AskUserQuestion':
      return { anim: 'wave', label: 'pergunta' };
    case 'ExitPlanMode':
      return { anim: 'sit', label: 'plano pronto' };
    default:
      if (String(name).startsWith('mcp__')) {
        const parts = String(name).split('__');
        return { anim: 'type', label: clip(parts.slice(1).join(' '), 26) };
      }
      return { anim: 'type', label: clip(name, 26) };
  }
}

/**
 * O que um `Bash` que terminou merece: `push`, `commit`, `pass` (os testes
 * passaram), `fail` (quebraram) ou `null`. [ok] é se ele terminou bem (o
 * `PostToolUse`, e não o `PostToolUseFailure`).
 */
function bashOutcome(command, ok, response) {
  const cmd = String(command || '');
  const out =
    typeof response === 'string'
      ? response
      : response && typeof response === 'object'
        ? [response.stdout, response.stderr, response.output].filter((x) => typeof x === 'string').join('\n')
        : '';
  if (TEST_RE.test(cmd)) return ok && !FAILED_RE.test(out) ? 'pass' : 'fail';
  if (!ok) return null;
  if (/\bgit\s+push\b/.test(cmd)) return 'push';
  if (/\bgit\s+commit\b/.test(cmd)) return 'commit';
  return null;
}

/** A luz da hora: a camada por cima do chão, o vidro das janelas e se é noite. */
function lightAt(date) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h < 5.5 || h >= 20) return { phase: 'noite', overlay: 0x5a0b1030, glass: 0xff1d2547, night: true };
  if (h < 7.5) return { phase: 'amanhecer', overlay: 0x22ff9a5a, glass: 0xfff2b07a, night: false };
  if (h < 17.5) return { phase: 'dia', overlay: 0x00000000, glass: 0xff8fc7e8, night: false };
  return { phase: 'fim de tarde', overlay: 0x30ff7a40, glass: 0xffe9925a, night: false };
}

class World {
  constructor({ settings = {}, now = () => Date.now(), random = Math.random } = {}) {
    this.settings = settings;
    this.now = now;
    this.random = random;
    this.agents = new Map(); // id -> boneco (os claudes, os ajudantes, você e o bicho)
    this.slots = []; // o lugar de cada boneco na lista da janela (fixo enquanto ele vive)
    this.fx = Array.from({ length: FX_SLOTS }, () => null); // os efeitos que sobem e somem
    this.roomOrder = []; // as salas na ordem em que apareceram
    this.folders = []; // as pastas da lateral, pras salas fixas
    this.plan = null;
    this.planKey = '';
    // Você: a roupa (a folha sob medida) e o nome que você escolheu no
    // "personalizar"; o `main.js` é quem gera a folha e põe aqui.
    this.youSkin = sprites.VOCE;
    this.youName = 'você';
    this.sceneRevision = 0;
    this.helperSeq = 0;
    this.watching = false; // a janela está aberta: vale a pena andar
    this.lightPhase = null;
    this.hibernateOn = false; // a Maestria hiberna pelo plugin (`hibernate: 1`)
    // A decoração: o tema, onde cada móvel arrastado ficou (sala -> móvel ->
    // vaga) e o tamanho dos vasos de cada sala (os commits da semana).
    this.theme = 'classico';
    this.decor = {};
    this.growth = {}; // sala -> estágio do vaso (0 a 4)
    this.decorating = false; // o "arrumar os móveis" ligado
    this.commitsAt = 0; // o último commit ou push visto (pra recontar os vasos)
  }

  /** Os claudes e os ajudantes: quem trabalha (sem você e sem o bicho). */
  people() {
    return [...this.agents.values()].filter((a) => a.kind === 'claude' || a.kind === 'helper');
  }

  // --- o que acontece -------------------------------------------------------------

  /** As sessões como o `sessions.list` as dá: cria quem chegou, tira quem sumiu. */
  syncSessions(list, { snap = false } = {}) {
    const live = new Set();
    for (const s of list || []) {
      if (s.kind !== 'claude') continue;
      live.add(s.id);
      const a = this.agents.get(s.id);
      if (a) {
        const room = a.room;
        this.refreshInfo(a, s);
        this.setStatus(a, statusOf(s));
        if ('context' in s) this.setContext(a, s.context);
        if (a.room !== room) {
          this.relayout();
          this.think(a);
        }
      } else {
        const b = this.spawn(s, { snap });
        if ('context' in s) this.setContext(b, s.context, { quiet: true });
      }
    }
    for (const a of this.people()) {
      if (!live.has(a.tabId) && !a.leaving) this.leave(a);
    }
    this.relayout();
    this.ensurePet();
    this.ensureYou();
  }

  /** Todo mundo direto onde devia estar: a janela acabou de abrir. */
  snapAll() {
    for (const a of [...this.agents.values()]) {
      if (a.kind === 'you' && a.resident) {
        // O morador volta pra mesa dele: a entrega que estava no ar fica pra lá.
        this.release(a);
        a.targetId = null;
        a.handed = false;
        a.waitSince = null;
        a.leaveAt = null;
        if (a.tile) this.snap(a);
      } else if (a.leaving || a.kind === 'you' || a.kind === 'courier') this.remove(a, { relayout: false });
      else if (a.tile) this.snap(a);
    }
    this.fx = this.fx.map(() => null);
    this.relayout();
    this.ensurePet();
    this.ensureYou();
  }

  setFolders(folders) {
    this.folders = (folders || []).map((f) => ({
      id: f.root,
      name: f.name || path.basename(f.root),
      // A pasta e as worktrees dela: ler qualquer uma é estar na sala dela.
      paths: [f.root, ...(Array.isArray(f.worktrees) ? f.worktrees.map((w) => w && w.path).filter(Boolean) : [])],
    }));
    this.relayout();
  }

  /**
   * O `session.status`. [hibernated] vem quando a mudança foi a sessão dormir
   * ou acordar: ela vai pro sofá, ou levanta e volta pra mesa.
   */
  status(tabId, status, { hibernated } = {}) {
    const a = this.agents.get(tabId);
    if (!a) return false;
    const slept = typeof hibernated === 'boolean' && hibernated !== a.hibernated;
    if (slept) a.hibernated = hibernated;
    // Hibernar põe a sessão em `ended`, mas ela não foi embora: dorme no sofá.
    this.setStatus(a, a.hibernated && status === 'ended' ? 'idle' : status);
    if (slept) {
      if (!hibernated) this.say(a, 'bom dia! ☕', 'white', 3000);
      this.think(a);
    }
    return true;
  }

  /** O `session.renamed`: o nome novo, no boneco, na lateral e no chat. */
  renamed(tabId, title) {
    const a = this.agents.get(tabId);
    if (!a || typeof title !== 'string') return false;
    a.name = clip(title || 'claude', 22);
    return true;
  }

  /** O `session.context`: quanto da janela de contexto a sessão ocupa. */
  context(tabId, ctx) {
    const a = this.agents.get(tabId);
    if (!a) return false;
    this.setContext(a, ctx);
    return true;
  }

  closed(tabId) {
    const a = this.agents.get(tabId);
    if (!a) return false;
    this.leave(a);
    for (const h of this.helpersOf(a)) this.leave(h);
    return true;
  }

  /** Um hook cru, como o Claude Code mandou. */
  hook(tabId, name, p = {}) {
    const parent = this.agents.get(tabId);
    if (!parent) return false;
    const fork = typeof p.agent_id === 'string' && p.agent_id ? p.agent_id : null;
    // Qualquer sinal da sessão (dela ou de um ajudante dela) é atividade: o
    // relógio do café recomeça.
    if (parent.idleSince) parent.idleSince = this.now();
    if (fork) return this.helperHook(parent, fork, name, p);
    // O arquivo da conversa, pra janelinha de chat.
    if (typeof p.transcript_path === 'string' && p.transcript_path) parent.transcript = p.transcript_path;
    if (name === 'SubagentStop') {
      // Um fim de ajudante sem carimbo: o mais antigo que ainda trabalha.
      const h = this.helpersOf(parent).find((x) => !x.reporting && !x.leaving);
      if (h) this.finishHelper(h, stopNote(p));
      return !!h;
    }
    switch (name) {
      case 'UserPromptSubmit': {
        const raw = String(p.prompt || p.user_input || '');
        const text = clip(raw, 34);
        // De onde veio: de outra sessão (quem leva é ela, ou o mensageiro), um
        // aviso do próprio Claude Code (ninguém leva nada), ou de você.
        const origin = originOf(raw);
        // O pedido que você já levou até a mesa (o "esperar a entrega"): não leva de novo.
        if (parent.expectPromptUntil && this.now() < parent.expectPromptUntil) parent.expectPromptUntil = null;
        else if (origin && origin.notice) this.say(parent, '📬 chegou um aviso', 'dim', 3000);
        else if (origin) this.errand(parent, origin);
        else if (text) this.deliver(parent, text);
        parent.tool = null;
        parent.idleSince = null;
        parent.done = false;
        parent.resting = false; // trabalho novo: volta pra mesa
        parent.pendingTools = [];
        this.unstick(parent); // você falou com ele: a conversa recomeça
        break;
      }
      case 'PreToolUse': {
        const input = p.tool_input || {};
        parent.done = false;
        parent.tool = describe(p.tool_name, input);
        this.notePending(parent, p, null);
        this.noteTool(parent, p.tool_name, input);
        this.noteTrip(parent, p.tool_name, input);
        if (p.tool_name === 'Task' || p.tool_name === 'Agent') {
          this.spawnHelper(parent, {
            toolUseId: p.tool_use_id || null,
            what: clip(input.description || input.subagent_type || 'ajudante', 30),
            type: input.subagent_type || 'general-purpose',
            background: input.run_in_background === true,
          });
        }
        if (p.tool_name === 'TodoWrite') this.setTodos(parent, input.todos);
        // A pergunta: é o que ele vai fazer na sua sala, no balão.
        if (p.tool_name === 'AskUserQuestion') {
          const q = Array.isArray(input.questions) && input.questions[0];
          parent.question = clip((q && (q.question || q.header)) || input.question || '', 60) || null;
        }
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        if (p.tool_name === 'Task' || p.tool_name === 'Agent') {
          const h = this.helpersOf(parent).find((x) => x.toolUseId && x.toolUseId === p.tool_use_id);
          // O que ele respondeu vira o recado na mesa (o de segundo plano só
          // diz que saiu: o recado dele vem no `SubagentStop`).
          if (h && !h.background) this.finishHelper(h, { text: resultText(name === 'PostToolUse' ? p.tool_response : p.error) });
        }
        this.afterTool(parent, name, p);
        this.clearPending(parent, p.tool_use_id);
        this.noteFailure(parent, name === 'PostToolUseFailure' && p.is_interrupt !== true);
        parent.tool = null;
        break;
      }
      case 'Stop': {
        // Terminou: um pulinho, o ✓ subindo, e o "pronto" em cima da cabeça até
        // você abrir a conversa dele (ou ele voltar a trabalhar).
        parent.tool = null;
        if (parent.trip) this.endTrip(parent);
        parent.pendingTools = [];
        this.unstick(parent);
        parent.lastSaid = clip(p.last_assistant_message, 120) || parent.lastSaid;
        this.finished(parent);
        break;
      }
      case 'StopFailure':
        parent.tool = null;
        parent.pendingTools = [];
        parent.compacting = null;
        this.say(parent, 'deu erro na api', 'red', 5000);
        break;
      // O `/compact` (ou a compactação automática, no meio de um turno): o
      // status da sessão não muda, então a linha do chat diz por conta própria.
      case 'PreCompact':
        parent.compacting = this.now();
        this.say(parent, 'compactando…', 'dim', 4000);
        break;
      case 'PostCompact':
        parent.compacting = null;
        break;
      default:
    }
    this.think(parent);
    return true;
  }

  helperHook(parent, fork, name, p) {
    let h = this.people().find((x) => x.kind === 'helper' && x.forkId === fork);
    if (!h) {
      // O primeiro sinal de um ajudante: ele é o mais antigo que ainda não tem
      // carimbo nem já terminou, ou um que entrou sem a gente ver o `Task`.
      h = this.helpersOf(parent).find((x) => !x.forkId && !x.leaving && !x.reporting);
      if (!h && name === 'SubagentStop') return false;
      if (!h) h = this.spawnHelper(parent, { what: clip(p.agent_type || 'ajudante', 30), type: p.agent_type || 'general-purpose' });
      h.forkId = fork;
    }
    if (name === 'SubagentStop') {
      this.finishHelper(h, stopNote(p));
      return true;
    }
    if (name === 'PreToolUse') {
      h.tool = describe(p.tool_name, p.tool_input || {});
      this.noteTrip(h, p.tool_name, p.tool_input || {});
      // A permissão de um ajudante é pedida no terminal de quem o chamou.
      this.notePending(parent, p, h);
      // A lista de um ajudante é trabalho de quem o chamou: vai pro mesmo quadro.
      if (p.tool_name === 'TodoWrite') this.setTodos(parent, (p.tool_input || {}).todos);
    } else if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
      this.afterTool(h, name, p);
      this.clearPending(parent, p.tool_use_id);
      h.tool = null;
    }
    this.think(h);
    return true;
  }

  /**
   * Uma ferramenta que começou (o `PreToolUse`) e ainda não terminou: se a
   * sessão passar a esperar permissão, é ela que está pedindo -- o terminal
   * pergunta antes de rodar. [by] é o ajudante, quando foi dele.
   */
  notePending(a, p, by) {
    const list = (a.pendingTools = (a.pendingTools || []).slice(-7));
    list.push({ id: p.tool_use_id || '', name: String(p.tool_name || ''), input: p.tool_input || {}, by: by ? by.what : null });
  }

  clearPending(a, id) {
    if (!a.pendingTools || !id) return;
    a.pendingTools = a.pendingTools.filter((t) => t.id !== id);
  }

  /**
   * O que [a] está pedindo pra fazer, esperando a sua permissão: a última
   * ferramenta que começou e não terminou. O `Task` de um ajudante que ainda
   * trabalha e a pergunta não contam (não são permissão).
   */
  permissionOf(a) {
    if (!a || a.status !== 'waitingPermission') return null;
    const list = (a.pendingTools || []).filter((t) => !['Task', 'Agent', 'AskUserQuestion'].includes(t.name));
    return list.length ? list[list.length - 1] : null;
  }

  // --- quem está travado ---------------------------------------------------------------
  //
  // Batendo cabeça: o mesmo comando três vezes nas últimas seis ferramentas,
  // os testes quebrando três vezes seguidas, ou três ferramentas falhando em
  // fila. Ele fica com a nuvem de chuva em cima da cabeça até mudar de rumo
  // (os testes passam, você fala com ele, o turno acaba).

  /** A assinatura de uma ferramenta: o nome e o que importa da entrada. */
  noteTool(a, name, input) {
    if (['TodoWrite', 'Task', 'Agent', 'AskUserQuestion'].includes(name)) return;
    const key = `${name}:${clip(input.command || input.file_path || input.pattern || input.url || input.query || '', 80)}`;
    a.recentTools = [...(a.recentTools || []), key].slice(-6);
    // Ler e editar o mesmo arquivo várias vezes é trabalho normal; repetir o
    // mesmo comando é que é sinal.
    if (name !== 'Bash') return;
    const same = a.recentTools.filter((k) => k === key).length;
    if (same >= 3) this.stick(a, `rodou \`${clip(input.command, 40)}\` ${same} vezes seguidas`);
  }

  noteFailure(a, failed) {
    a.failStreak = failed ? (a.failStreak || 0) + 1 : 0;
    // O motivo mais específico (os testes) fica.
    if (a.failStreak >= 3 && !a.stuck) this.stick(a, `${a.failStreak} ferramentas falharam em seguida`);
  }

  stick(a, reason) {
    if (a.kind !== 'claude') return;
    const fresh = !a.stuck;
    a.stuck = { reason, since: (a.stuck && a.stuck.since) || this.now() };
    if (fresh) this.say(a, 'hmm… não tá indo', 'yellow', 3500);
  }

  unstick(a) {
    a.stuck = null;
    a.recentTools = [];
    a.failStreak = 0;
    a.testFails = 0;
  }

  /** O fim de uma ferramenta: o `Bash` que fez push, commit ou rodou os testes vira reação. */
  afterTool(a, name, p) {
    if (p.tool_name !== 'Bash') return;
    if (name === 'PostToolUseFailure' && p.is_interrupt === true) return;
    const ok = name === 'PostToolUse';
    const outcome = bashOutcome((p.tool_input || {}).command, ok, ok ? p.tool_response : p.error);
    if (outcome) this.react(a, outcome);
    // Os testes: quebrando em fila é travado; passando, destrava.
    const who = a.kind === 'helper' ? this.agents.get(a.parentId) : a;
    if (!who) return;
    if (outcome === 'fail') {
      who.testFails = (who.testFails || 0) + 1;
      if (who.testFails >= 3) this.stick(who, `os testes quebraram ${who.testFails} vezes seguidas`);
    } else if (outcome === 'pass') {
      this.unstick(who);
    }
  }

  /** Ele terminou o turno: comemora e fica com o "pronto" em cima da cabeça. */
  finished(a) {
    a.done = true;
    a.doneAt = this.now();
    a.bubble = null;
    a.emote = { anim: 'cheer', until: this.now() + 1500 };
    this.effectOver(a, '✓', { color: 0xff3fa864, size: 9, rise: 20 });
    this.maybeMeet(a);
  }

  // --- a sala de reunião -------------------------------------------------------------
  //
  // Duas ocasiões levam gente pra mesa de reunião: os claudes da mesma tarefa
  // (o TASK#123 ou BUG#45 da branch ou do nome) que ficam parados juntos -- um
  // terminou e o outro já estava à toa -- se reúnem pra contar o que cada um
  // fez; e o ajudante que terminou chama quem o chamou pra lá pra contar como
  // foi, em vez de ir até a mesa dele.

  /** A sala de reunião está ligada (a opção "reuniões", ligada por padrão)? */
  meetingOn() {
    return this.settings.meetings !== false;
  }

  canMeet() {
    return this.watching && this.meetingOn() && !!this.plan;
  }

  /** A tarefa de [a]: o `TASK#123`/`BUG#45` da branch, ou do nome da sessão. */
  taskOf(a) {
    for (const text of [a.branch, a.name]) {
      const m = String(text || '').match(/\b(TASK|BUG)\s*#?\s*(\d+)/i);
      if (m) return `${m[1].toUpperCase()}#${m[2]}`;
    }
    return null;
  }

  /** [a] terminou: se outro da mesma tarefa está à toa, os dois (ou mais) vão se reunir. */
  maybeMeet(a) {
    const task = a.kind === 'claude' && this.canMeet() ? this.taskOf(a) : null;
    if (!task) return false;
    const now = this.now();
    const free = (x) =>
      x.kind === 'claude' &&
      !x.leaving &&
      !x.hibernated &&
      !x.meeting &&
      (x.status === 'idle' || x.status === 'ready') &&
      now - (x.metAt || 0) > MEET_AGAIN_MS;
    // Ele acabou de terminar (o status de parado vem logo atrás do `Stop`).
    if (a.leaving || a.hibernated || a.meeting || now - (a.metAt || 0) <= MEET_AGAIN_MS) return false;
    const mates = this.people().filter((x) => x !== a && free(x) && this.taskOf(x) === task);
    if (!mates.length) return false;
    const group = [a, ...mates].slice(0, this.plan.meeting.seats.length);
    const id = `tarefa:${task}:${now}`;
    group.forEach((p, i) => {
      // Na sala de quem terminou: os outros vão até a mesa dele.
      p.meeting = { id, kind: 'task', topic: task, until: now + MEETING_MS, host: a.id };
      p.metAt = now;
      p.spoke = 0;
      p.meetLines = this.meetLinesOf(p, task, i);
      this.think(p);
    });
    return true;
  }

  /** O que [p] fala na reunião da tarefa: o começo do que ele respondeu por último, e um papo. */
  meetLinesOf(p, task, i) {
    const first = String(p.lastSaid || '')
      .replace(/[*_`#>]/g, '')
      .split(/(?<=[.!?:])\s/)[0];
    const opener = first ? clip(first, 38) : i ? 'minha parte tá pronta' : `bora alinhar a ${task}?`;
    const more = i
      ? ['bate com o que eu fiz', 'e do seu lado?', 'fechado, sigo daqui']
      : ['e aí, como ficou aí?', 'bora integrar', 'beleza, depois eu testo'];
    return [i ? opener : `${task}: ${opener}`, ...more];
  }

  /** O lugar de [a] na mesa de reunião: o mesmo enquanto a reunião durar. */
  meetingSeatOf(a) {
    const seats = this.plan.meeting.seats;
    if (a.meetSeat !== null && a.meetSeat !== undefined && seats[a.meetSeat]) return seats[a.meetSeat];
    const taken = new Set(
      [...this.agents.values()].filter((x) => x !== a && x.meeting && x.meetSeat !== null && x.meetSeat !== undefined).map((x) => x.meetSeat),
    );
    const free = seats.findIndex((_, i) => !taken.has(i));
    if (free < 0) return null;
    a.meetSeat = free;
    return seats[free];
  }

  endMeeting(a) {
    a.meeting = null;
    a.meetSeat = null;
    a.meetLines = null;
    this.think(a);
  }

  // --- a daily -------------------------------------------------------------------------
  //
  // A reunião da daily: você e os claudes que trabalharam no período vão pra
  // mesa de reunião (a sala aparece pra ela, mesmo com um claude só) -- "deixa
  // eu lembrar…" enquanto o resumo é escrito -- e, com ele pronto, cada um conta
  // a sua parte, na vez dele; a de quem não está no escritório, você conta.
  // Acaba sozinha uns segundos depois da última fala (ou quando você encerra).

  /** Começa a daily com [tabIds] (os que trabalharam no período). */
  startDaily(tabIds) {
    if (this.daily) for (const a of this.agents.values()) if (a.meeting && a.meeting.kind === 'daily') this.endMeeting(a);
    const now = this.now();
    const id = `daily:${now}`;
    this.daily = { id, at: now, told: false, quiet: 0 };
    this.relayout();
    if (!this.plan || !this.plan.meeting) {
      this.daily = null;
      return false;
    }
    const seats = this.plan.meeting.seats.length;
    const who = tabIds
      .map((t) => this.agents.get(t))
      .filter((a) => a && a.kind === 'claude' && !a.leaving && !a.hibernated)
      .slice(0, seats - 1);
    const you = this.agents.get(YOU_ID);
    for (const a of [...who, ...(you && you.resident ? [you] : [])]) {
      a.meeting = { id, kind: 'daily', topic: 'daily', until: now + 15 * 60 * 1000 };
      a.meetSeat = null;
      a.spoke = 0;
      a.meetLines = a.kind === 'you' ? [] : ['deixa eu lembrar…'];
      this.think(a);
    }
    return true;
  }

  /**
   * O resumo chegou: o que cada um fala (`{ tabId: [falas] }`). Você abre, conta
   * [yours] (a parte de quem não veio) e, quando todo mundo falou, agradece.
   */
  dailyLines(byTab, yours = []) {
    if (!this.daily) return;
    this.daily.told = true;
    for (const [tabId, lines] of Object.entries(byTab || {})) {
      const a = this.agents.get(tabId);
      if (a && a.meeting && a.meeting.kind === 'daily') a.meetLines = lines.filter(Boolean);
    }
    const you = this.agents.get(YOU_ID);
    if (you && you.meeting && you.meeting.kind === 'daily') {
      you.meetLines = ['bom, vamos lá: o que cada um fez?', ...yours.filter(Boolean)];
      you.spoke = -1; // você abre
    }
  }

  /** Se a reunião da daily está acontecendo (o "encerrar" da janela). */
  inDaily() {
    return !!this.daily;
  }

  endDaily() {
    if (!this.daily) return false;
    this.daily = null;
    for (const a of this.agents.values()) if (a.meeting && a.meeting.kind === 'daily') this.endMeeting(a);
    this.relayout();
    return true;
  }

  /** Você viu (abriu a conversa dele): o "pronto" sai da cabeça. */
  seen(tabId) {
    const a = this.agents.get(tabId);
    if (!a || !a.done) return false;
    a.done = false;
    return true;
  }

  /** A festa ou o drama. */
  react(a, outcome) {
    const now = this.now();
    switch (outcome) {
      case 'push':
        a.emote = { anim: 'cheer', until: now + 2600 };
        this.say(a, '🚀 push!', 'green', 3000);
        this.effectOver(a, '🚀', { rise: 30, ms: 1600, size: 9 });
        break;
      case 'commit':
        this.commitsAt = now; // os vasos da sala recontam
        a.emote = { anim: 'cheer', until: now + 1400 };
        this.say(a, 'commit!', 'white', 2200);
        this.effectOver(a, '📄', { rise: 22, ms: 1400 });
        break;
      case 'pass':
        a.flash = { color: SCREEN.pass, until: now + 3500 };
        this.say(a, 'testes passaram ✓', 'green', 3000);
        this.effectOver(a, '✓', { color: 0xff3fa864, size: 9 });
        break;
      case 'fail':
        a.emote = { anim: 'facepalm', until: now + 2800 };
        a.flash = { color: SCREEN.fail, until: now + 4500, blink: true };
        this.say(a, 'testes quebraram', 'red', 3500);
        this.effectOver(a, '✗', { color: 0xffe5534b, size: 9 });
        break;
      default:
    }
  }

  /** A lista do `TodoWrite`, pro quadro branco da sala. */
  setTodos(a, todos) {
    if (!Array.isArray(todos)) return;
    a.todos = todos
      .filter((t) => t && typeof t.content === 'string')
      .map((t) => ({ content: t.content, status: t.status || 'pending', active: t.activeForm || t.content }));
    a.todosAt = this.now();
  }

  /** O contexto mudou: cansaço quando enche, uma espreguiçada quando esvazia (o `/compact`). */
  setContext(a, ctx, { quiet = false } = {}) {
    const pct = ctx && typeof ctx.percent === 'number' ? ctx.percent : null;
    const before = a.ctx;
    a.ctx = pct;
    if (quiet) return;
    if (before != null && before >= 50 && (pct === null || pct < before - 25)) {
      a.emote = { anim: 'stretch', until: this.now() + 3000 };
      this.say(a, 'ahh, bem melhor', 'white', 3000);
      this.effectOver(a, '✨', { rise: 16 });
    } else if (pct !== null && pct >= 90 && (before === null || before === undefined || before < 90)) {
      this.say(a, 'tô no limite…', 'yellow', 3500);
    }
  }

  // --- os bonecos -----------------------------------------------------------------

  spawn(s, { snap = false } = {}) {
    const a = {
      id: s.id,
      tabId: s.id,
      kind: 'claude',
      skin: sprites.SKINS[office.hash(s.id) % sprites.SKINS.length],
      status: statusOf(s),
      tool: null,
      bubble: null,
      idleSince: null,
      leaving: false,
      ctx: null,
      createdAt: this.now(),
    };
    this.refreshInfo(a, s);
    if (a.status === 'idle' || a.status === 'ready') a.idleSince = this.now();
    this.place(a, snap);
    return a;
  }

  spawnHelper(parent, { toolUseId = null, what = 'ajudante', type = 'general-purpose', background = false } = {}) {
    const n = this.helperSeq++;
    const h = {
      id: `${parent.tabId}:ajudante:${n}`,
      tabId: parent.tabId,
      kind: 'helper',
      type: String(type || 'general-purpose'),
      parentId: parent.id,
      // A roupa diz o tipo: o explorador, o planejador, o revisor; os outros, de crachá.
      skin: sprites.helperSkin(type, n),
      toolUseId,
      forkId: null,
      background,
      what,
      name: what,
      room: parent.room,
      roomName: parent.roomName,
      status: 'working',
      tool: null,
      bubble: null,
      leaving: false,
      reporting: false,
      createdAt: this.now(),
    };
    this.place(h, false);
    this.say(h, what, 'dim', 4000);
    return h;
  }

  /**
   * Você leva o pedido: entra pela porta, vai até onde o claude está e entrega.
   * Quem está na sala do descanso (ou no sofá) espera você lá antes de voltar
   * pra mesa; quem está andando pra mesa é esperado nela. Com a janela fechada
   * (ou o "levar o pedido" desligado), o pedido só aparece num balão em cima do claude.
   *
   * [onHand], quando vem, é chamado na hora em que você entrega (ou quando a
   * entrega não acontece mais): é o pedido que só segue pro claude quando chega
   * na mesa. Volta `true` se você está mesmo indo levar.
   */
  deliver(parent, text, onHand = null) {
    const desk = this.plan && parent.kind === 'claude' && this.deskOf(parent);
    if (!this.watching || this.settings.visits === false || !desk) {
      this.say(parent, `“${text}”`, 'quote', 5000);
      return false;
    }
    if (parent.arrived && !parent.walking && parent.goal && (parent.goal.kind === 'lounge' || parent.goal.kind === 'sofa')) {
      parent.awaitUntil = this.now() + AWAIT_MS;
    }
    const y = this.agents.get(YOU_ID);
    if (!y) {
      this.place(
        {
          id: YOU_ID,
          kind: 'you',
          skin: sprites.VOCE,
          name: 'você',
          status: 'idle',
          step: 150,
          bubble: null,
          leaving: false,
          targetId: parent.id,
          tabId: parent.tabId,
          quote: text,
          onHand,
        },
        false,
      );
      return true;
    }
    // Já estava a caminho (ou voltando): muda o destino.
    const before = y.targetId !== parent.id && this.agents.get(y.targetId);
    if (before && before.awaitUntil) {
      before.awaitUntil = null;
      this.think(before);
    }
    y.leaving = false;
    y.leaveAt = null;
    y.handed = false;
    y.waitSince = null;
    y.targetId = parent.id;
    y.tabId = parent.tabId;
    y.quote = text;
    y.arrived = false;
    // O pedido que você levava antes deste segue agora: um de cada vez na mão.
    this.release(y);
    y.onHand = onHand;
    this.think(y);
    return true;
  }

  /** O pedido que você levou (e que acabou de seguir pro [tabId]) ainda vai voltar no hook: não leva duas vezes. */
  expectPrompt(tabId, on = true) {
    const a = this.agents.get(tabId);
    if (a) a.expectPromptUntil = on ? this.now() + 15000 : null;
  }

  /** O pedido que estava na sua mão segue pro claude (entregue, ou largado no caminho). */
  release(you) {
    const fn = you && you.onHand;
    if (!fn) return;
    you.onHand = null;
    fn();
  }

  /**
   * O bicho que está valendo: a escolha feita na própria tela (`petPref`), ou a
   * das configurações, ou o gato. `nenhum` é sem bicho.
   */
  petChoice() {
    const want = this.petPref || this.settings.pet || (this.settings.cat === false ? 'nenhum' : 'gato');
    return SPECIES[want] ? want : want === 'nenhum' ? 'nenhum' : 'gato';
  }

  /** O bicho: nasce com a planta, e troca (ou vai embora) quando a escolha muda. */
  ensurePet() {
    if (!this.plan) return;
    const choice = this.petChoice();
    const pet = this.agents.get(PET_ID);
    if (pet && pet.species === choice) return;
    if (pet) this.remove(pet, { relayout: false });
    if (choice === 'nenhum') return;
    const kind = SPECIES[choice];
    const c = {
      id: PET_ID,
      kind: 'pet',
      species: choice,
      skin: kind.skin,
      name: kind.name,
      status: 'idle',
      step: 200,
      bubble: null,
      leaving: false,
      mode: 'sit',
      modeUntil: this.now() + 3000,
      target: null,
    };
    // Aparece já dentro, num canto da sala do descanso.
    const spots = this.plan.spots;
    c.target = { tile: spots.length ? spots[Math.floor(this.random() * spots.length)] : this.plan.entrance };
    this.place(c, true);
    if (pet) this.say(c, kind.pet, 'white', 2500);
  }

  /** A sua sala está ligada (a opção "sua sala", ligada por padrão)? */
  officeOn() {
    return this.settings.office !== false;
  }

  /** O nome da sua sala, na plaquinha: "sala de Fulano", ou "sua sala". */
  officeName() {
    const name = String(this.youName || '').trim();
    return name && name !== 'você' ? `sala de ${name}` : 'sua sala';
  }

  /**
   * Você mora no escritório: sentado na sua mesa, na sua sala, de onde sai pra
   * levar os pedidos e pra onde volta. Com a opção desligada, some (e volta ao
   * jeito antigo: entra pela porta pra entregar e vai embora).
   */
  ensureYou() {
    if (!this.plan) return;
    const you = this.agents.get(YOU_ID);
    if (!this.officeOn() || !this.plan.home) {
      if (you && you.resident) this.remove(you, { relayout: false });
      return;
    }
    if (you) {
      you.resident = true;
      if (!you.targetId && !you.walking) this.think(you);
      return;
    }
    this.place(
      {
        id: YOU_ID,
        kind: 'you',
        resident: true,
        skin: this.youSkin,
        name: this.youName,
        status: 'idle',
        step: 150,
        bubble: null,
        leaving: false,
        targetId: null,
      },
      true,
    );
  }

  /** Um carinho no bicho (o clique nele). */
  petPet() {
    const c = this.agents.get(PET_ID);
    if (!c) return false;
    c.mode = 'meow';
    c.modeUntil = this.now() + 2200;
    this.say(c, SPECIES[c.species].pet, 'white', 2000);
    this.effectOver(c, '♥', { color: 0xffe5536b, rise: 14 });
    return true;
  }

  /** Põe o boneco no mundo: um lugar na lista da janela e a porta (ou o destino, com [snap]). */
  place(a, snap) {
    let slot = this.slots.indexOf(null);
    if (slot < 0) {
      slot = this.slots.length;
      this.slots.push(null);
    }
    this.slots[slot] = a.id;
    a.slot = slot;
    a.segs = [];
    a.segEnd = 0;
    a.walking = false;
    a.ms = 0;
    a.jump = true;
    a.hold = !snap;
    this.agents.set(a.id, a);
    this.relayout();
    if (snap) {
      this.snap(a);
    } else {
      a.tile = { ...this.plan.entrance };
      a.px = tilePx(a.tile);
      a.anim = 'right';
      this.think(a);
    }
  }

  refreshInfo(a, s) {
    a.name = clip(s.title || path.basename(s.cwd || '') || 'claude', 22);
    a.title = s.title || a.name;
    a.branch = s.branch || '';
    a.cwd = s.cwd || '';
    const folder = s.folder || s.cwd || '';
    const room = folder || '@outros';
    if (a.room && a.room !== room) a.desk = null;
    a.room = room;
    a.roomName = folder ? path.basename(folder) : 'outros';
    a.hibernated = s.hibernated === true;
    a.exited = s.exited === true;
    if (s.sessionId) a.sessionId = s.sessionId;
  }

  setStatus(a, status) {
    if (!status || status === a.status) return;
    const before = a.status;
    a.status = status;
    if (status === 'starting') a.startingSince = this.now();
    if (status === 'idle' || status === 'ready') {
      if (before !== 'idle' && before !== 'ready') a.idleSince = this.now();
    } else {
      a.idleSince = null;
    }
    if (['working', 'tool', 'starting'].includes(status)) {
      a.done = false;
      a.resting = false; // trabalho chegou: volta pra mesa
      // A reunião de tarefa acaba com trabalho; a de ajudante, não (é ele
      // ouvindo o resultado enquanto o turno segue).
      if (a.meeting && a.meeting.kind === 'task') a.meeting = null;
    }
    // Respondida (ou abandonada): a pergunta sai do balão, e ele volta pra mesa.
    if (status !== 'waitingAnswer') a.question = null;
    a.waitingSince = status.startsWith('waiting') ? (before && before.startsWith('waiting') ? a.waitingSince : this.now()) : null;
    // A ferramenta fica enquanto ela espera a sua permissão: o balão diz pra quê.
    if (status === 'waitingAnswer') a.tool = describe('AskUserQuestion');
    else if (status !== 'tool' && status !== 'waitingPermission') a.tool = null;
    if (status === 'ended') {
      this.leave(a);
      return;
    }
    this.think(a);
  }

  leave(a) {
    if (a.kind === 'you' && a.resident) {
      // Entregou: volta pra sua sala, em vez de ir embora.
      a.targetId = null;
      a.handed = false;
      a.waitSince = null;
      this.think(a);
      return;
    }
    if (a.leaving) return;
    a.leaving = true;
    a.reporting = false;
    a.tool = null;
    this.think(a);
  }

  finishHelper(h, { text = '', transcript = '' } = {}) {
    const parent = this.agents.get(h.parentId);
    // O recado: o que ele respondeu, deixado na mesa de quem o chamou. Um
    // segundo aviso do mesmo fim (o `PostToolUse` depois do `SubagentStop`)
    // completa o recado em vez de deixar outro.
    if (parent && (text || transcript)) this.leaveNote(parent, h, { text, transcript });
    if (h.reporting || h.leaving) return;
    if (!parent || parent.leaving) {
      this.leave(h);
      return;
    }
    h.reporting = true;
    h.tool = null;
    // Voltando de outra sala, ele conta onde foi procurar.
    if (h.trip) this.endTrip(h, { quiet: true });
    this.think(h);
  }

  helpersOf(a) {
    return this.people().filter((x) => x.kind === 'helper' && x.parentId === a.id);
  }

  /** O papel que o ajudante [h] deixa na mesa de [parent]: o que ele respondeu. */
  leaveNote(parent, h, { text, transcript }) {
    parent.notes = parent.notes || [];
    let note = parent.notes.find((n) => n.id === h.id);
    if (!note) {
      note = { id: h.id, type: h.type || 'general-purpose', what: h.what, text: '', transcript: '', at: this.now(), read: false };
      parent.notes.push(note);
      parent.notes = parent.notes.slice(-8);
    }
    if (text && text.length > note.text.length) note.text = text;
    if (transcript) note.transcript = transcript;
  }

  /** Os recados não lidos de [a]. */
  unreadNotes(a) {
    return (a.notes || []).filter((n) => !n.read);
  }

  /** Os papéis nas mesas: um por claude sentado com recado não lido. */
  notesData() {
    const out = [];
    for (const a of this.people()) {
      if (a.kind !== 'claude' || a.leaving) continue;
      const n = this.unreadNotes(a).length;
      const desk = n && this.deskOf(a);
      if (!desk) continue;
      out.push({
        x: d(desk.x * T + 1),
        y: d(desk.y * T + 2),
        count: n > 1 ? String(n) : '',
        action: `recados:${a.tabId}`,
        tip: `${n === 1 ? 'um recado' : `${n} recados`} de ajudante pra ${a.name} — clique pra ler`,
      });
    }
    return out;
  }

  say(a, text, tone = 'white', ms = 4000, max = 40) {
    a.bubble = { text: clip(text, max), tone, until: this.now() + ms };
  }

  isTired(a) {
    return a.kind === 'claude' && typeof a.ctx === 'number' && a.ctx >= 80;
  }

  // --- os efeitos ------------------------------------------------------------------
  //
  // Um texto que aparece em cima de alguém e sobe sumindo: o foguete do push, o
  // ✓ dos testes, o "z" de quem dorme. Cada um num lugar fixo da lista (como os
  // bonecos), em duas fases: aparece no lugar (sem animação), e no envio
  // seguinte vai pra cima com a opacidade indo a zero.

  effectOver(a, text, opts = {}) {
    if (!a.px) return;
    this.effect(a.px.x + 8, a.px.y + (opts.dy === undefined ? 2 : opts.dy), text, opts);
  }

  effect(x, y, text, { color = 0xfff6f2ea, size = 7, rise = 18, ms = 1300 } = {}) {
    if (!this.watching) return;
    let slot = this.fx.indexOf(null);
    if (slot < 0) slot = this.fx.reduce((old, f, i) => (f.born < this.fx[old].born ? i : old), 0);
    this.fx[slot] = { x, y, text, color, size, rise, ms, phase: 0, born: this.now(), until: 0 };
  }

  // --- onde cada um quer estar -------------------------------------------------------

  /** Quanto tempo parado de verdade até ir sozinho pro café: 15 min, se não mudaram. */
  coffeeMs() {
    const s = Number(this.settings.coffee);
    return Number.isFinite(s) ? s * 1000 : 15 * 60 * 1000;
  }

  /**
   * Mandar pro descanso (o botão do chat): vai pra sala do descanso agora e
   * fica lá até chegar trabalho -- um pedido, uma ferramenta -- ou você chamar
   * de volta. Uma pergunta ou uma permissão passam na frente.
   */
  rest(tabId) {
    const a = this.agents.get(tabId);
    if (!a || a.kind !== 'claude') return false;
    a.resting = true;
    this.think(a);
    return true;
  }

  /** Chamar de volta pra mesa: e o relógio do café recomeça do zero. */
  backToDesk(tabId) {
    const a = this.agents.get(tabId);
    if (!a || a.kind !== 'claude') return false;
    a.resting = false;
    if (a.idleSince) a.idleSince = this.now();
    this.think(a);
    return true;
  }

  /** Está na sala do descanso (mandado, ou sozinho depois de muito tempo parado)? */
  lounging(a) {
    return !!(a.goal && a.goal.kind === 'lounge');
  }

  /** Pra onde o boneco vai agora: `{ kind, tile, px }`. */
  goalOf(a) {
    const plan = this.plan;
    if (a.leaving) return { kind: 'exit', tile: plan.entrance };
    if (a.kind === 'pet') return this.petGoal(a);
    if (a.kind === 'you') {
      // Já entregou: fica ali até sair (ou voltar pra sua sala).
      if (a.handed) return { kind: 'deliver', tile: (a.goal && a.goal.tile) || a.tile };
      const parent = a.targetId && this.agents.get(a.targetId);
      const tile = parent && !parent.leaving && this.meetTile(a, parent);
      if (tile) return { kind: 'deliver', tile };
      // Na daily, você senta na mesa de reunião com eles.
      if (a.meeting && plan.meeting) {
        const seat = this.meetingSeatOf(a);
        if (seat) return { kind: 'meeting', tile: seat.tile, px: seat.px, face: seat.face };
      }
      // Quem mora aqui volta pra mesa dele; o visitante vai embora pela porta.
      if (a.resident && plan.home) return { kind: 'home', tile: plan.home.seat, px: plan.home.px };
      return { kind: 'exit', tile: plan.entrance };
    }
    // Esperando você trazer o pedido: fica onde está até receber.
    if (a.kind === 'claude' && a.awaitUntil && this.now() < a.awaitUntil && a.goal && (a.goal.kind === 'lounge' || a.goal.kind === 'sofa')) {
      return a.goal;
    }
    if (a.kind === 'courier') {
      const target = a.errand && this.agents.get(a.errand.to);
      const tile = target && !target.leaving && this.meetTile(a, target);
      return tile ? { kind: 'errand', tile } : { kind: 'exit', tile: plan.entrance };
    }
    const waits = String(a.status).startsWith('waiting');
    // Levando o recado pra outra sessão: até a mesa dela, e volta.
    if (a.kind === 'claude' && a.errand && !waits && !a.hibernated) {
      const target = this.agents.get(a.errand.to);
      const tile = target && !target.leaving && this.now() < a.errand.until && this.meetTile(a, target);
      if (tile) return { kind: 'errand', tile };
      a.errand = null;
    }
    // Trabalhando junto na mesma tarefa: em volta da mesa de quem terminou, na sala dele.
    if (a.meeting && a.meeting.host && a.kind === 'claude' && !waits && !a.hibernated) {
      const host = this.agents.get(a.meeting.host);
      if (host && host !== a && !host.leaving) {
        const tile = this.huddleTileOf(a, host);
        if (tile) return { kind: 'huddle', tile };
      }
    }
    // Lendo outro repositório: na sala dele, numa mesa livre.
    if (a.trip && (a.kind === 'helper' ? !a.reporting : !waits) && !a.hibernated) {
      const spot = this.tripSpotOf(a);
      if (spot) return { kind: 'trip', tile: spot.tile, px: spot.px };
    }
    // Na reunião: o lugar dele na mesa (uma pergunta ou uma permissão tiram de lá).
    if (a.meeting && !a.meeting.host && this.plan.meeting && (a.kind === 'helper' || !waits) && !a.hibernated) {
      const seat = this.meetingSeatOf(a);
      if (seat) return { kind: 'meeting', tile: seat.tile, px: seat.px, face: seat.face };
    } else {
      a.meetSeat = null;
    }
    if (a.kind === 'helper' && a.reporting) {
      const parent = this.agents.get(a.parentId);
      const desk = parent && this.deskOf(parent);
      if (desk) return { kind: 'report', tile: desk.talk };
    }
    // Uma pergunta pra você: ele vai até a sua sala fazê-la, e fica do lado
    // da sua mesa até você responder.
    if (a.kind === 'claude' && a.status === 'waitingAnswer' && this.asksInPerson()) {
      const spot = this.visitOf(a);
      if (spot) return { kind: 'ask', tile: spot };
    } else {
      a.visit = null;
    }
    if (a.kind === 'claude' && a.hibernated) {
      const seat = this.sofaOf(a);
      if (seat) return { kind: 'sofa', tile: seat.stand, px: seat.px };
    } else {
      a.sofa = null;
    }
    const atRest = a.status === 'idle' || a.status === 'ready';
    const coffee = this.coffeeMs();
    // Sozinho, só depois de muito tempo parado de verdade: sem nenhum sinal da
    // sessão e sem ajudante trabalhando (um subagente em segundo plano deixa a
    // sessão "parada" com trabalho rolando). Mandado (o botão do chat), na hora.
    const busy = this.helpersOf(a).some((h) => !h.leaving);
    const sent = a.resting && !String(a.status).startsWith('waiting');
    const bored = atRest && !busy && coffee > 0 && a.idleSince && this.now() - a.idleSince >= coffee;
    if (a.kind === 'claude' && (a.hibernated || sent || bored)) {
      const spot = this.spotOf(a);
      if (spot) return { kind: 'lounge', tile: spot };
    }
    a.spot = null;
    const desk = this.deskOf(a);
    if (desk) return { kind: 'desk', tile: desk.seat, px: { x: desk.seat.x * T + 8, y: desk.seat.y * T - 8 } };
    return { kind: 'lounge', tile: this.spotOf(a) || plan.entrance };
  }

  deskOf(a) {
    const plan = this.plan;
    const room = plan.rooms.find((r) => r.id === a.room);
    if (!room || !room.desks.length) return null;
    if (a.desk) {
      const d = room.desks.find((x) => x.id === a.desk);
      if (d) return d;
    }
    const taken = new Set(
      this.people()
        .filter((x) => x !== a && x.room === a.room && x.desk && !x.leaving)
        .map((x) => x.desk),
    );
    // As mesas que um visitante está usando também.
    for (const x of this.people()) if (x.trip && x.trip.desk) taken.add(x.trip.desk);
    const free = room.desks.find((x) => !taken.has(x.id));
    a.desk = free ? free.id : null;
    return free || null;
  }

  /** O lugar de [a] em volta da mesa de [host]: no corredor da frente dela. */
  huddleTileOf(a, host) {
    const desk = this.deskOf(host);
    if (!desk) return null;
    const seats = new Set(this.plan.desks.map((dk) => `${dk.seat.x},${dk.seat.y}`));
    const tiles = [[1, 2], [0, 2], [2, 2], [-1, 2], [3, 2], [-2, 2], [1, 3], [0, 3]]
      .map(([dx, dy]) => ({ x: desk.x + dx, y: desk.y + dy }))
      .filter((t) => office.walkable(this.plan, t.x, t.y) && !seats.has(`${t.x},${t.y}`));
    if (a.huddleAt !== undefined && a.huddleAt !== null && tiles[a.huddleAt] && a.huddleHost === host.id) return tiles[a.huddleAt];
    const taken = new Set(
      this.people()
        .filter((x) => x !== a && x.huddleHost === host.id && x.meeting && x.huddleAt !== null && x.huddleAt !== undefined)
        .map((x) => x.huddleAt),
    );
    const free = tiles.findIndex((_, i) => !taken.has(i));
    if (free < 0) return null;
    a.huddleAt = free;
    a.huddleHost = host.id;
    return tiles[free];
  }

  // --- visitar outro repositório -----------------------------------------------------
  //
  // Quem lê arquivos de outro repositório da lateral (um Read, um Grep, um
  // `cd` no Bash) vai até a sala dele -- que aparece, se ainda não existe --,
  // senta numa mesa livre e lê ali. Sem mexer em nada de lá por um tempo (ou
  // quando volta a escrever no dele, ou o turno acaba), volta pra mesa e diz
  // de onde veio; o ajudante conta pra quem o chamou.

  /** A sala de [path], quando é a de outro repositório que [a] não é o dele. */
  roomForPath(a, file) {
    const f = String(file || '');
    if (!f.startsWith('/')) return null;
    const own = a.kind === 'helper' ? this.agents.get(a.parentId) : a;
    const cwd = own && own.cwd;
    if (cwd && (f === cwd || f.startsWith(`${cwd}/`))) return null;
    let best = null;
    for (const folder of this.folders) {
      for (const root of folder.paths || [folder.id]) {
        if ((f === root || f.startsWith(`${root}/`)) && (!best || root.length > best.len)) best = { id: folder.id, name: folder.name, len: root.length };
      }
    }
    if (!best || best.id === a.room) return null;
    return best;
  }

  noteTrip(a, name, input) {
    const now = this.now();
    for (const file of pathsOf(name, input)) {
      const room = this.roomForPath(a, file);
      if (!room) continue;
      if (a.trip && a.trip.room === room.id) {
        a.trip.until = now + TRIP_MS;
        return;
      }
      if (a.trip) this.endTrip(a, { quiet: true });
      a.trip = { room: room.id, name: room.name, until: now + TRIP_MS, desk: null };
      this.say(a, `vou dar uma olhada no ${room.name}`, 'dim', 3000);
      this.relayout();
      this.think(a);
      return;
    }
    // Voltou a escrever fora da sala visitada: a visita acabou.
    if (a.trip && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) this.endTrip(a);
  }

  endTrip(a, { quiet = false } = {}) {
    if (!a.trip) return;
    const name = a.trip.name;
    a.trip = null;
    a.visited = name;
    if (!quiet) this.say(a, `voltei do ${name}`, 'white', 3000);
    this.relayout();
    this.think(a);
  }

  /** Onde [a] lê na sala visitada: uma mesa livre, ou em pé no fundo dela. */
  tripSpotOf(a) {
    const room = this.plan.rooms.find((r) => r.id === a.trip.room);
    if (!room) return null;
    const busy = new Set(
      this.people()
        .filter((x) => x !== a && !x.leaving && ((x.room === room.id && x.desk) || (x.trip && x.trip.desk)))
        .map((x) => (x.trip && x.trip.desk) || x.desk),
    );
    let desk = a.trip.desk && room.desks.find((dk) => dk.id === a.trip.desk);
    if (!desk || busy.has(desk.id)) desk = room.desks.find((dk) => !busy.has(dk.id));
    if (desk) {
      a.trip.desk = desk.id;
      return { tile: desk.seat, px: { x: desk.seat.x * T + 8, y: desk.seat.y * T - 8 } };
    }
    a.trip.desk = null;
    const y = room.iy + room.ih - 2;
    for (let x = room.ix + 1; x < room.ix + room.iw - 1; x++) if (office.walkable(this.plan, x, y)) return { tile: { x, y } };
    return null;
  }

  // --- os recados entre sessões ---------------------------------------------------------

  /**
   * Um pedido que veio de outra sessão (`origin.name`): quem leva até a mesa é
   * o claude que mandou, se ele está no escritório; senão, o mensageiro entra
   * pela porta. Você só leva o que você manda.
   */
  errand(parent, origin) {
    const text = clip(origin.text || 'recado', 34);
    const sender = this.senderOf(origin.name, parent);
    if (!this.watching || !this.plan || this.settings.visits === false) {
      this.say(parent, `“${text}”${sender ? ` — ${sender.name}` : ''}`, 'quote', 5000);
      return;
    }
    const now = this.now();
    if (sender) {
      sender.errand = { to: parent.id, text, until: now + ERRAND_MS };
      sender.errandDone = null;
      this.think(sender);
      return;
    }
    this.place(
      {
        id: `@mensageiro:${this.helperSeq++}`,
        kind: 'courier',
        tabId: parent.tabId,
        skin: sprites.MESSENGER,
        name: origin.name ? `recado de ${clip(origin.name, 16)}` : 'mensageiro',
        from: origin.name || '',
        status: 'idle',
        step: 170,
        bubble: null,
        leaving: false,
        errand: { to: parent.id, text, until: now + ERRAND_MS },
      },
      false,
    );
  }

  /** O claude que se chama [name] (o nome da sessão, como o `from-name` traz). */
  senderOf(name, not) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return null;
    return (
      this.people().find(
        (x) =>
          x.kind === 'claude' &&
          x !== not &&
          !x.leaving &&
          !x.hibernated &&
          [x.title, x.name].some((n) => {
            const have = String(n || '').trim().toLowerCase();
            return have && (have === want || have.startsWith(want) || want.startsWith(have.replace(/…$/, '')));
          }),
      ) || null
    );
  }

  /**
   * Onde você para pra entregar o pedido a [parent]: do lado dele, se ele está
   * (ou vai ficar) na sala do descanso ou no sofá; senão, ao pé da mesa dele.
   */
  meetTile(you, parent) {
    const g = parent.goal;
    if (g && (g.kind === 'lounge' || g.kind === 'sofa')) {
      const busy = new Set(
        [...this.agents.values()]
          .filter((x) => x !== you && x !== parent && x.goal && x.goal.tile)
          .map((x) => `${x.goal.tile.x},${x.goal.tile.y}`),
      );
      const at = g.tile;
      for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
        const t = { x: at.x + dx, y: at.y + dy };
        if (office.walkable(this.plan, t.x, t.y) && !busy.has(`${t.x},${t.y}`)) return t;
      }
      return office.nearestFree(this.plan, at);
    }
    const desk = this.deskOf(parent);
    return desk ? desk.talk : null;
  }

  /** O claude já está onde você foi encontrá-lo, parado? */
  meets(you, parent) {
    if (!parent || parent.walking || !parent.arrived || !parent.tile || !you.tile) return false;
    const g = parent.goal;
    if (g && g.kind === 'desk') {
      const desk = this.deskOf(parent);
      return !!desk && you.tile.x === desk.talk.x && you.tile.y === desk.talk.y;
    }
    return Math.abs(parent.tile.x - you.tile.x) + Math.abs(parent.tile.y - you.tile.y) <= 1;
  }

  /** Você entrega o pedido: o balão, o "deixa comigo" e, depois, cada um pro seu lado. */
  handOver(you, now) {
    const parent = this.agents.get(you.targetId);
    you.handed = true;
    you.waitSince = null;
    you.anim = this.restAnim(you);
    this.say(you, `“${you.quote}”`, 'quote', 3500);
    this.release(you);
    if (parent) {
      parent.bubble = { text: 'deixa comigo', tone: 'white', until: now + 5500, after: now + 2500 };
      // Quem esperava você na sala do descanso volta pra mesa depois de ouvir.
      if (parent.awaitUntil) parent.awaitUntil = now + 1500;
    }
    you.leaveAt = now + 3200;
  }

  spotOf(a) {
    const plan = this.plan;
    if (a.spot && plan.spots.some((s) => s.x === a.spot.x && s.y === a.spot.y)) return a.spot;
    const taken = new Set(
      [...this.agents.values()].filter((x) => x !== a && x.spot).map((x) => `${x.spot.x},${x.spot.y}`),
    );
    const free = plan.spots.filter((s) => !taken.has(`${s.x},${s.y}`));
    if (!free.length) return null;
    a.spot = free[Math.floor(this.random() * free.length)];
    return a.spot;
  }

  /** Quem tem uma pergunta vai até a sua sala (com a sua sala e a opção ligadas). */
  asksInPerson() {
    return this.officeOn() && this.settings.askVisits !== false && !!(this.plan && this.plan.home && this.plan.home.visit.length);
  }

  /** O lugar dele do lado da sua mesa: o mesmo enquanto a pergunta durar. */
  visitOf(a) {
    const spots = this.plan.home.visit;
    if (a.visit !== null && a.visit !== undefined && spots[a.visit]) return spots[a.visit];
    const taken = new Set(
      this.people()
        .filter((x) => x !== a && x.visit !== null && x.visit !== undefined)
        .map((x) => x.visit),
    );
    const free = spots.findIndex((_, i) => !taken.has(i));
    if (free < 0) return null;
    a.visit = free;
    return spots[free];
  }

  sofaOf(a) {
    const seats = this.plan.sofa;
    if (a.sofa !== null && a.sofa !== undefined && seats[a.sofa]) return seats[a.sofa];
    const taken = new Set([...this.agents.values()].filter((x) => x !== a && x.sofa !== null && x.sofa !== undefined).map((x) => x.sofa));
    const free = seats.findIndex((_, i) => !taken.has(i));
    if (free < 0) return null;
    a.sofa = free;
    return seats[free];
  }

  /** Recalcula o destino e, se mudou, o caminho até ele. */
  think(a) {
    if (!this.plan || !a.tile) return;
    const goal = this.goalOf(a);
    a.goal = goal;
    const end = a.segs.length ? a.segs[a.segs.length - 1].to : a.tile;
    if (end.x === goal.tile.x && end.y === goal.tile.y && (a.segs.length || a.walking || a.arrived)) return;
    const from = a.tile;
    const tiles = office.path(this.plan, from, goal.tile);
    a.arrived = false;
    if (tiles === null) {
      // Sem caminho (a planta mudou embaixo dele): aparece lá.
      this.snap(a);
      return;
    }
    a.segs = office.segments(from, tiles);
    a.walking = true;
  }

  /** Aparece direto no destino, já na pose de lá (a janela abrindo, a planta mudando). */
  snap(a) {
    const goal = this.goalOf(a);
    a.goal = goal;
    if (goal.kind === 'exit') {
      this.remove(a, { relayout: false });
      return;
    }
    a.tile = { ...goal.tile };
    a.px = goal.px || tilePx(goal.tile);
    a.segs = [];
    a.walking = false;
    a.arrived = true;
    a.jump = true;
    a.hold = false;
    a.anim = this.restAnim(a);
  }

  remove(a, { relayout = true } = {}) {
    this.release(a);
    this.agents.delete(a.id);
    if (this.slots[a.slot] === a.id) this.slots[a.slot] = null;
    if (relayout) this.relayout();
  }

  /** A pose de quem chegou: na mesa trabalhando, acenando, ou de pé na sala do descanso. */
  restAnim(a) {
    const goal = a.goal || {};
    const now = this.now();
    if (a.kind === 'pet') return a.mode === 'nap' ? 'sleep' : a.mode === 'meow' ? 'meow' : 'sit';
    if (a.emote && now < a.emote.until) return a.emote.anim;
    if (goal.kind === 'deliver' || goal.kind === 'report' || goal.kind === 'errand' || goal.kind === 'huddle') return 'up';
    // Na mesa da outra sala: lendo (ou o que a ferramenta da vez pedir).
    if (goal.kind === 'trip') return goal.px ? (a.tool ? a.tool.anim : 'read') : 'idle';
    // Na sua mesa: digitando enquanto algum claude trabalha, senão só sentado.
    if (goal.kind === 'home') {
      return this.people().some((p) => p.kind === 'claude' && ['working', 'tool'].includes(p.status)) ? 'type' : 'sit';
    }
    if (goal.kind === 'ask') return 'wave';
    // Na mesa de reunião: de costas, sentado, quem fica embaixo; de pé, de frente, os outros.
    if (goal.kind === 'meeting') return goal.face === 'up' ? 'sit' : this.isTired(a) ? 'tired' : 'idle';
    if (goal.kind === 'sofa') return 'sleep';
    if (goal.kind === 'lounge' || goal.kind === 'exit') return this.isTired(a) ? 'tired' : 'idle';
    if (a.status === 'waitingPermission' || a.status === 'waitingAnswer' || a.status === 'waitingInput') return 'wave';
    if (a.tool) return a.tool.anim;
    if (a.status === 'working' || a.status === 'starting') return a.kind === 'helper' ? 'type' : 'sit';
    return 'sit';
  }

  // --- o bicho -----------------------------------------------------------------------

  petGoal(c) {
    if (c.target && c.target.tile && office.walkable(this.plan, c.target.tile.x, c.target.tile.y)) {
      return { kind: 'pet', tile: c.target.tile, px: c.target.px };
    }
    c.target = { tile: office.nearestFree(this.plan, c.tile || this.plan.entrance) };
    return { kind: 'pet', tile: c.target.tile };
  }

  /** O que o bicho resolve fazer agora: visitar quem espera, cochilar ou dar uma volta. */
  petBrain(c, now) {
    if (c.walking || c.hold) return false;
    // Alguém esperando você há mais de 40 s: ele vai lá miar do lado.
    const waiting = this.people().find(
      (a) =>
        a.kind === 'claude' &&
        ((a.waitingSince && now - a.waitingSince > 40000) || (a.stuck && now - a.stuck.since > 5000)) &&
        a.arrived &&
        a.goal &&
        a.goal.kind === 'desk' &&
        c.visiting !== a.id,
    );
    if (waiting) {
      const desk = this.deskOf(waiting);
      if (desk) {
        c.visiting = waiting.id;
        c.mode = 'visit';
        c.modeUntil = now + 30000;
        c.target = { tile: desk.talk };
        this.think(c);
        return true;
      }
    }
    if (c.mode === 'visit') {
      const v = this.agents.get(c.visiting);
      if (v && (v.waitingSince || v.stuck) && now < c.modeUntil) return false;
      c.visiting = null;
    }
    if (now < c.modeUntil) return false;
    const r = this.random();
    const sitting = new Set(
      this.people()
        .filter((a) => a.desk && a.goal && a.goal.kind === 'desk')
        .map((a) => a.desk),
    );
    const emptyDesks = this.plan.desks.filter((dk) => !sitting.has(dk.id));
    if (r < 0.3 && emptyDesks.length) {
      // Cochilo numa mesa vazia: o gato em cima do teclado, o cachorro no chão,
      // do lado da cadeira.
      const dk = emptyDesks[Math.floor(this.random() * emptyDesks.length)];
      c.mode = 'nap';
      c.modeUntil = now + 25000 + this.random() * 20000;
      c.target = SPECIES[c.species].climbs
        ? { tile: dk.seat, px: { x: dk.x * T + 8, y: dk.y * T - 14 } }
        : { tile: dk.seat, px: { x: dk.x * T + 14, y: dk.seat.y * T - 6 } };
    } else if (r < 0.45) {
      const seat = this.plan.sofa.findIndex((_, i) => !this.people().some((a) => a.sofa === i));
      if (seat >= 0) {
        const s = this.plan.sofa[seat];
        c.mode = 'nap';
        c.modeUntil = now + 20000 + this.random() * 20000;
        c.target = { tile: s.stand, px: { x: s.px.x, y: s.px.y + 4 } };
      } else {
        c.mode = 'sit';
        c.modeUntil = now + 4000;
      }
    } else {
      // Uma volta por aí: um tile qualquer onde dá pra pisar.
      const tile = this.randomFloor();
      c.mode = 'sit';
      c.modeUntil = now + 4000 + this.random() * 7000;
      c.target = { tile };
    }
    this.think(c);
    return true;
  }

  randomFloor() {
    const plan = this.plan;
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(this.random() * plan.cols);
      const y = Math.floor(this.random() * plan.rows);
      if (office.walkable(plan, x, y)) return { x, y };
    }
    return plan.spots[0] || plan.entrance;
  }

  // --- o tempo -----------------------------------------------------------------------

  /** Um passo do relógio: quem anda pega o próximo trecho, quem chegou senta, os efeitos sobem. */
  tick() {
    const now = this.now();
    let changed = false;
    for (const a of [...this.agents.values()]) {
      if (a.hold) continue;
      if (a.segs.length && now >= a.segEnd) {
        const seg = a.segs.shift();
        a.tile = { ...seg.to };
        a.px = tilePx(seg.to);
        a.ms = seg.tiles * (a.step || STEP_MS);
        a.segEnd = now + a.ms;
        a.anim = seg.dir;
        changed = true;
      } else if (a.walking && !a.segs.length && now >= a.segEnd) {
        a.walking = false;
        changed = true;
        this.arrive(a, now);
      } else if (a.arrived && !a.walking) {
        const want = this.restAnim(a);
        if (want !== a.anim) {
          a.anim = want;
          changed = true;
        }
      }
    }
    this.fx.forEach((f, i) => {
      if (!f) return;
      if (f.phase === 0 && f.shown) {
        f.phase = 1;
        f.until = now + f.ms + 100;
        changed = true;
      } else if (f.phase === 1 && now >= f.until) {
        this.fx[i] = null;
        changed = true;
      }
    });
    return changed;
  }

  arrive(a, now) {
    const goal = a.goal || this.goalOf(a);
    a.arrived = true;
    if (goal.kind === 'exit') {
      this.remove(a);
      return;
    }
    if (goal.px) {
      a.px = goal.px;
      a.ms = SIT_MS;
      a.segEnd = now + SIT_MS;
    }
    a.anim = this.restAnim(a);
    const you = this.agents.get(YOU_ID);
    if (a.kind === 'claude' && you && you.targetId === a.id && you.waitSince && this.meets(you, a)) this.handOver(you, now);
    if (goal.kind === 'report') {
      const parent = this.agents.get(a.parentId);
      this.say(a, a.visited ? `pronto (olhei no ${a.visited})` : `pronto: ${a.what}`, 'green', 3500);
      if (parent) this.say(parent, 'valeu!', 'white', 3000);
      a.leaveAt = now + 3500;
    } else if (goal.kind === 'errand') {
      // Chegou com o recado de outra sessão: entrega, e volta (ou vai embora).
      const target = this.agents.get(a.errand && a.errand.to);
      this.say(a, `“${(a.errand && a.errand.text) || 'recado pra você'}”`, 'quote', 3500);
      if (target) target.bubble = { text: 'deixa comigo', tone: 'white', until: now + 5500, after: now + 2200 };
      if (a.kind === 'courier') a.leaveAt = now + 3400;
      else a.errandDone = now + 3400;
    } else if (goal.kind === 'trip') {
      // Chegou na sala do outro repositório: quem trabalha lá dá as boas-vindas.
      const host = this.people().find((x) => x.kind === 'claude' && x.room === a.trip.room && x.arrived && x.goal && x.goal.kind === 'desk' && !x.leaving);
      if (host) {
        this.say(a, 'posso dar uma olhada aqui?', 'white', 2500);
        host.bubble = { text: 'fica à vontade', tone: 'white', until: now + 4500, after: now + 1800 };
      }
    } else if (goal.kind === 'ask') {
      // Chegou na sua sala com a pergunta: você levanta a cabeça.
      const you = this.agents.get(YOU_ID);
      if (you && you.goal && you.goal.kind === 'home') this.say(you, 'diz aí', 'white', 2500);
    } else if (goal.kind === 'deliver') {
      // Só entrega com o claude ali; senão, espera ele chegar (ou vai atrás).
      if (this.meets(a, this.agents.get(a.targetId))) this.handOver(a, now);
      else a.waitSince = now;
    } else if (a.kind === 'pet' && a.mode === 'visit') {
      a.mode = 'meow';
      a.modeUntil = now + 2500;
      this.say(a, SPECIES[a.species].visit, 'white', 2500);
      // Depois do miado, fica ali sentado enquanto a pessoa não responde.
      a.afterMeow = 'visit';
    }
  }

  /**
   * Uma vez por segundo: os balões que venceram, a ida pro café, o papo da sala
   * do descanso, o bicho, o suor, o "z" de quem dorme e a luz da hora.
   */
  housekeeping() {
    const now = this.now();
    let changed = false;
    for (const a of [...this.agents.values()]) {
      if (a.bubble && a.bubble.until <= now) {
        a.bubble = null;
        changed = true;
      }
      if (a.emote && a.emote.until <= now) {
        a.emote = null;
        changed = true;
      }
      if (a.flash) {
        if (a.flash.until <= now) a.flash = null;
        changed = true; // pisca: a cada segundo a tela troca
      }
      if (a.leaveAt && now >= a.leaveAt) {
        a.leaveAt = null;
        this.leave(a);
        changed = true;
      }
      // Entregou o recado: volta pro lugar dele.
      if (a.errandDone && now >= a.errandDone) {
        a.errandDone = null;
        a.errand = null;
        this.think(a);
        changed = true;
      }
      // Ninguém leu mais nada da outra sala faz um tempo: volta.
      if (a.trip && now >= a.trip.until) {
        this.endTrip(a);
        changed = true;
      }
      // Quem esperava o pedido (ou já ouviu) volta à vida normal.
      if (a.awaitUntil && now >= a.awaitUntil) {
        a.awaitUntil = null;
        this.think(a);
        changed = true;
      }
      // Você esperando o claude: se ele mudou de lugar, vai atrás; se demorou
      // demais, entrega assim mesmo.
      if (a.kind === 'you' && a.waitSince && !a.handed && !a.walking) {
        const parent = this.agents.get(a.targetId);
        if (this.meets(a, parent) || now - a.waitSince > YOU_WAIT_MS) {
          this.handOver(a, now);
        } else {
          const g = this.goalOf(a);
          if (g.tile.x !== a.tile.x || g.tile.y !== a.tile.y) {
            a.waitSince = null;
            this.think(a);
          }
        }
        changed = true;
      }
      // Quem ficou à toa o bastante levanta pro café: o destino muda sozinho.
      if (a.kind === 'claude' && a.arrived && !a.walking && a.goal && a.goal.kind === 'desk') {
        const g = this.goalOf(a);
        if (g.kind !== 'desk') {
          this.think(a);
          changed = true;
        }
      }
      if (!this.watching || !a.arrived || a.walking) continue;
      // Quem dorme solta um "z" de vez em quando; quem está cansado, uma gota.
      const sleeping = (a.goal && a.goal.kind === 'sofa') || (a.kind === 'pet' && a.mode === 'nap');
      if (sleeping && now - (a.lastZ || 0) > 2600) {
        a.lastZ = now;
        this.effectOver(a, 'z', { color: 0xffd9e2ff, size: 6, rise: 14, ms: 1800, dy: a.kind === 'pet' ? 10 : 0 });
        changed = true;
      } else if (a.stuck && now - (a.lastRain || 0) > 3200) {
        // Travado: a nuvem de chuva em cima da cabeça.
        a.lastRain = now;
        this.effectOver(a, '🌧️', { size: 8, rise: 6, ms: 2600, dy: -6 });
        changed = true;
      } else if (this.isTired(a) && now - (a.lastSweat || 0) > 5000) {
        a.lastSweat = now;
        this.effectOver(a, '💧', { size: 6, rise: 10, ms: 1200 });
        changed = true;
      }
    }
    // O bicho.
    const pet = this.agents.get(PET_ID);
    if (pet) {
      if (pet.mode === 'meow' && now >= pet.modeUntil) {
        pet.mode = pet.afterMeow || 'sit';
        pet.afterMeow = null;
        pet.modeUntil = pet.mode === 'visit' ? now + 25000 : now + 3000;
        changed = true;
      }
      if (this.watching && this.petBrain(pet, now)) changed = true;
    }
    // As reuniões: acabam no tempo; a de ajudante, também quando não sobra
    // ajudante pra contar nada (com um respiro pro "valeu!").
    for (const a of this.people()) {
      if (!a.meeting) continue;
      if (now >= a.meeting.until) {
        if (a.kind === 'helper') a.meeting = null;
        else this.endMeeting(a);
        changed = true;
      }
    }
    // O papo da reunião: cada um conta o seu, na vez dele.
    const meeting = [...this.agents.values()].filter(
      (a) =>
        a.meeting &&
        (a.meeting.kind === 'task' || a.meeting.kind === 'daily') &&
        a.arrived &&
        !a.walking &&
        a.goal &&
        (a.goal.kind === 'meeting' || a.goal.kind === 'huddle' || (a.meeting.host === a.id && a.goal.kind === 'desk')) &&
        a.meetLines &&
        a.meetLines.length,
    );
    const daily = meeting.some((a) => a.meeting.kind === 'daily');
    if ((meeting.length > 1 || daily) && !meeting.some((a) => a.bubble && a.bubble.until > now) && this.random() < (daily ? 0.8 : 0.6)) {
      const a = meeting.reduce((x, y) => ((x.spoke || 0) <= (y.spoke || 0) ? x : y));
      a.spoke = (a.spoke || 0) + 1;
      // Na daily, as falas são maiores (o balão quebra em duas linhas).
      if (a.meeting.kind === 'daily') this.say(a, a.meetLines.shift(), 'white', 5500, 80);
      else this.say(a, a.meetLines.shift(), 'white', 3200);
      changed = true;
    }
    // A daily acaba sozinha: todo mundo falou, você agradece e, quando o último
    // balão some, cada um volta pro seu lugar.
    if (this.daily && this.daily.told) {
      const left = [...this.agents.values()].filter((a) => a.meeting && a.meeting.kind === 'daily');
      const talking = left.some((a) => (a.meetLines && a.meetLines.length) || (a.bubble && a.bubble.until > now));
      const you = left.find((a) => a.kind === 'you' && a.arrived && !a.walking);
      if (talking) this.daily.quiet = 0;
      else if (you && !this.daily.thanked) {
        this.daily.thanked = true;
        this.say(you, 'valeu, pessoal!', 'white', 3000);
        changed = true;
      } else if (!this.daily.quiet) this.daily.quiet = now;
      else if (now - this.daily.quiet > 3000) changed = this.endDaily() || changed;
    }
    // O papo da sala do descanso.
    // Quem terminou e está com o "pronto" na cabeça não puxa papo por cima dele.
    const lounging = this.people().filter((a) => a.arrived && a.goal && a.goal.kind === 'lounge' && !a.bubble && !a.done);
    if (lounging.length && this.random() < (lounging.length > 1 ? 0.18 : 0.05)) {
      const a = lounging[Math.floor(this.random() * lounging.length)];
      this.say(a, CHATTER[Math.floor(this.random() * CHATTER.length)], 'white', 3200);
      changed = true;
    }
    // A luz muda poucas vezes por dia.
    const phase = this.light().phase;
    if (phase !== this.lightPhase) {
      this.lightPhase = phase;
      changed = true;
    }
    return changed;
  }

  /** Alguém está andando (ou acabou de entrar), ou um efeito está no ar? Então o relógio roda rápido. */
  busy() {
    for (const a of this.agents.values()) if (a.hold || a.walking || a.segs.length) return true;
    return this.fx.some(Boolean);
  }

  /** Depois de mandar os dados: quem entrou já apareceu na porta e pode andar. */
  sent() {
    // Só quem foi no último `agentsData()`: quem entrou enquanto o envio
    // estava no ar ainda não apareceu na porta.
    const went = this.inFlight;
    this.inFlight = null;
    for (const a of this.agents.values()) {
      if (went && !went.has(a.id)) continue;
      a.jump = false;
      a.hold = false;
    }
    const fxWent = this.fxInFlight;
    this.fxInFlight = null;
    for (const f of this.fx) if (f && (!fxWent || fxWent.has(f))) f.shown = true;
  }

  // --- a planta ----------------------------------------------------------------------

  /**
   * As salas que ficam de pé mesmo vazias: as pastas marcadas em "as salas do
   * escritório" que ainda estão na lateral. Uma marcada que saiu da lateral
   * não tem sala (e volta quando a pasta voltar).
   */
  fixedRooms() {
    const picked = new Set(Array.isArray(this.settings.rooms) ? this.settings.rooms : []);
    return this.folders.filter((f) => picked.has(f.id));
  }

  /** Refaz a planta se mudaram as salas ou uma sala precisa de mais mesas. */
  relayout() {
    const count = new Map();
    const people = this.people();
    for (const a of people) {
      if (a.leaving && !a.tile) continue;
      if (!this.roomOrder.includes(a.room)) this.roomOrder.push(a.room);
      count.set(a.room, (count.get(a.room) || 0) + 1);
    }
    const names = new Map(people.map((a) => [a.room, a.roomName]));
    const rooms = [];
    const fixed = this.fixedRooms();
    for (const f of fixed) {
      if (!this.roomOrder.includes(f.id)) this.roomOrder.push(f.id);
      names.set(f.id, names.get(f.id) || f.name);
    }
    const wanted = new Set([...count.keys(), ...fixed.map((f) => f.id)]);
    // As salas que alguém está visitando também ficam de pé.
    for (const a of people) {
      if (!a.trip || a.leaving) continue;
      wanted.add(a.trip.room);
      if (!this.roomOrder.includes(a.trip.room)) this.roomOrder.push(a.trip.room);
      names.set(a.trip.room, names.get(a.trip.room) || a.trip.name);
    }
    for (const id of this.roomOrder) {
      if (!wanted.has(id)) continue;
      rooms.push({ id, name: names.get(id) || path.basename(id), agents: count.get(id) || 0 });
    }
    // As salas que ficaram vazias saem da ordem, pra não voltar no meio.
    this.roomOrder = this.roomOrder.filter((id) => wanted.has(id));
    // A sua sala (e o nome na plaquinha dela) também é planta.
    // E o tema, a sala de reunião (com dois claudes ou mais: reunião de um
    // só não dá; na daily, sempre) e onde ficou cada móvel arrastado.
    const meeting = !!this.daily || (this.meetingOn() && people.filter((a) => a.kind === 'claude' && !a.leaving).length >= 2);
    const key =
      (this.officeOn() ? `@voce:${this.officeName()}|` : '') +
      rooms.map((r) => `${r.id}:${Math.ceil(Math.max(1, r.agents) / 4)}`).join('|') +
      `|tema:${this.theme}|reuniao:${meeting}|moveis:${JSON.stringify(this.decor)}`;
    if (this.plan && key === this.planKey) return false;
    const old = this.plan;
    this.planKey = key;
    this.plan = office.layout(rooms, {
      office: this.officeOn() ? { name: this.officeName() } : null,
      theme: this.theme,
      meeting,
      decor: this.decor,
    });
    // Sem a sala de reunião, ninguém fica em reunião.
    if (!this.plan.meeting) for (const a of this.agents.values()) if (a.meeting) a.meeting = null;
    this.sceneRevision++;
    // A planta mudou embaixo de todo mundo. Quem estava parado continua no seu
    // lugar (a sala andou com ele); quem andava sai do ponto correspondente na
    // planta nova e segue o caminho de lá.
    for (const a of [...this.agents.values()]) {
      if (!a.tile) continue;
      if (a.spot && !this.plan.spots.some((s) => s.x === a.spot.x && s.y === a.spot.y)) a.spot = null;
      if (a.kind === 'pet') {
        if (old) a.tile = translate(old, this.plan, a.tile);
        a.target = null;
        a.mode = 'sit';
        a.modeUntil = this.now() + 2000;
      }
      const moving = a.walking || a.segs.length || a.hold;
      if (!moving && !a.leaving) {
        this.snap(a);
        continue;
      }
      a.tile = old ? translate(old, this.plan, a.tile) : office.nearestFree(this.plan, a.tile);
      a.px = tilePx(a.tile);
      a.segs = [];
      a.walking = false;
      a.arrived = false;
      a.jump = true;
      this.think(a);
    }
    return true;
  }

  // --- o que a janela desenha --------------------------------------------------------

  light() {
    if (this.settings.daylight === false) return lightAt(new Date(2000, 0, 1, 12));
    return lightAt(new Date(this.now()));
  }

  scene() {
    const plan = this.plan;
    return { w: d(plan.width), h: d(plan.height), svg: office.svg(plan, { growth: this.growth }), rev: this.sceneRevision };
  }

  // --- a decoração -------------------------------------------------------------------

  /** Troca o tema: a planta é a mesma, com outras cores. */
  setTheme(id) {
    const theme = office.THEMES[id] ? id : 'classico';
    if (theme === this.theme) return false;
    this.theme = theme;
    this.relayout();
    return true;
  }

  /**
   * Os commits da semana de cada sala (`{ sala: n }`): o tamanho dos vasos. A
   * sua sala cresce com a soma de todas. Um vaso que cresceu solta um brotinho.
   */
  setGrowth(commits) {
    const next = {};
    let total = 0;
    for (const [room, n] of Object.entries(commits || {})) {
      next[room] = office.growthStage(n);
      total += Number(n) || 0;
    }
    if (this.plan && this.plan.home) next['@voce'] = office.growthStage(total);
    const same = JSON.stringify(next) === JSON.stringify(this.growth);
    if (same) return false;
    const before = this.growth;
    this.growth = next;
    this.sceneRevision++;
    if (this.plan) {
      for (const f of this.plan.furniture) {
        if (f.kind === 'plant' && before[f.room] !== undefined && next[f.room] > before[f.room]) {
          this.effect(f.x * T + 8, f.y * T - 4, '🌱', { rise: 14, ms: 1600 });
        }
      }
    }
    return true;
  }

  /**
   * O "arrumar os móveis": os vasos e as luminárias viram arrastáveis, e as
   * vagas da sala de cada um acendem quando ele está no ar.
   */
  decorData() {
    const plan = this.plan;
    if (!this.decorating || !plan) return { on: false, items: [], slots: [] };
    const ids = new Map();
    const slots = plan.slots.map((v) => {
      const id = `vaga|${v.room}|${v.dx},${v.dy}`;
      if (!ids.has(v.room)) ids.set(v.room, []);
      ids.get(v.room).push(id);
      return { id, x: d(v.x * T), y: d(v.y * T) };
    });
    const items = plan.decor.map((m) => {
      const stage = m.kind === 'plant' && this.growth[m.room] !== undefined ? this.growth[m.room] : 2;
      return {
        x: d(m.x * T),
        y: d(m.y * T - 16),
        payload: `${m.room}|${m.key}`,
        targets: ids.get(m.room) || [],
        svg: office.itemSvg(m.kind, { theme: this.theme, stage }),
        tip: m.kind === 'plant' ? 'arraste o vaso pra outra vaga da sala' : 'arraste a luminária pra outra vaga da sala',
      };
    });
    return { on: true, items, slots };
  }

  /**
   * Põe o móvel [key] da sala [room] na vaga [dx],[dy]; o que estava lá vai
   * pro lugar dele. Se a planta fechar algum caminho, volta como estava e
   * devolve `false`.
   */
  moveDecor(room, key, dx, dy) {
    const plan = this.plan;
    const item = plan && plan.decor.find((m) => m.room === room && m.key === key);
    const r = plan && plan.rooms.find((x) => x.id === room);
    if (!item || !r) return false;
    const from = { dx: item.x - r.ix, dy: item.y - r.iy };
    if (from.dx === dx && from.dy === dy) return false;
    const other = plan.decor.find((m) => m.room === room && m.key !== key && m.x === r.ix + dx && m.y === r.iy + dy);
    const before = this.decor;
    const mine = { ...(before[room] || {}), [key]: { dx, dy } };
    if (other) mine[other.key] = from;
    this.decor = { ...before, [room]: mine };
    this.relayout();
    const now = this.plan.decor.find((m) => m.room === room && m.key === key);
    const r2 = this.plan.rooms.find((x) => x.id === room);
    if (!now || !r2 || now.x !== r2.ix + dx || now.y !== r2.iy + dy) {
      this.decor = before;
      this.relayout();
      return false;
    }
    return true;
  }

  /** Todos os móveis de volta pro lugar de sempre. */
  resetDecor() {
    if (!Object.keys(this.decor).length) return false;
    this.decor = {};
    this.relayout();
    return true;
  }

  labels() {
    return this.plan.rooms.map((r) => ({
      x: d(r.ix * T + 2),
      y: d(r.y * T + 1),
      text: r.name,
    }));
  }

  windows() {
    return this.plan.windows.map((w) => ({ x: d(w.x), y: d(w.y) }));
  }

  lightData() {
    const l = this.light();
    return { overlay: l.overlay, glass: l.glass, phase: l.phase };
  }

  screens() {
    const now = this.now();
    const night = this.light().night;
    const sitting = new Map();
    for (const a of this.people()) {
      if (a.desk && a.arrived && !a.walking && a.goal && a.goal.kind === 'desk') sitting.set(a.desk, a);
      if (a.trip && a.trip.desk && a.arrived && !a.walking && a.goal && a.goal.kind === 'trip') sitting.set(a.trip.desk, a);
    }
    // A sua mesa entra na lista: a tela acende com você sentado nela.
    const home = this.plan.home;
    const you = this.agents.get(YOU_ID);
    if (home && you && you.arrived && !you.walking && you.goal && you.goal.kind === 'home') {
      sitting.set(home.desk.id, { anim: you.anim === 'type' ? 'type' : 'sit' });
    }
    const desks = home ? [...this.plan.desks, home.desk] : this.plan.desks;
    return desks.map((desk) => {
      const a = sitting.get(desk.id);
      let lit = a ? SCREEN[a.anim] || SCREEN.sit : SCREEN.off;
      if (a && a.flash && now < a.flash.until) {
        // Pisca no ritmo do relógio lento, que manda os dados uma vez por segundo.
        lit = a.flash.blink && Math.floor(now / 1000) % 2 ? SCREEN.off : a.flash.color;
      }
      return {
        x: d(desk.x * T + 9),
        y: d(desk.y * T - 6),
        color: lit,
        // De noite, a luminária de quem está na mesa acende.
        glow: a && night ? 0x38ffcf7a : 0x00ffcf7a,
        gx: d(desk.x * T - 4),
        gy: d(desk.y * T - 14),
      };
    });
  }

  /** O quadro branco de cada sala: a lista do `TodoWrite` mais recente de quem trabalha lá. */
  boards() {
    return this.plan.boards.map((b) => {
      const owner = this.people()
        .filter((a) => a.kind === 'claude' && a.room === b.room && a.todos && a.todos.length && !a.leaving)
        .sort((x, y) => (y.todosAt || 0) - (x.todosAt || 0))[0];
      const base = { x: d(b.x), y: d(b.y) };
      if (!owner) return { ...base, on: false, title: '', count: '', bar: 0.001, current: '', tip: '', action: '' };
      const done = owner.todos.filter((t) => t.status === 'completed').length;
      const total = owner.todos.length;
      const doing = owner.todos.find((t) => t.status === 'in_progress');
      const mark = (t) => (t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·');
      return {
        ...base,
        on: true,
        title: clip(owner.name, 14),
        count: `${done}/${total}`,
        bar: d(Math.max(0.001, (BAR_W * done) / Math.max(1, total))),
        current: doing ? clip(doing.active, 22) : done === total ? 'tudo feito!' : clip(owner.todos.find((t) => t.status !== 'completed').content, 22),
        tip: [`${owner.name}: ${done} de ${total}`, ...owner.todos.map((t) => `${mark(t)} ${t.content}`)].join('\n'),
        action: `focus:${owner.tabId}`,
      };
    });
  }

  effectsData() {
    this.fxInFlight = new Set(this.fx.filter(Boolean));
    return this.fx.map((f) => {
      if (!f) return EMPTY_FX;
      const up = f.phase === 1;
      return {
        on: true,
        x: d(f.x - 20),
        y: d(up ? f.y - f.rise - 10 : f.y - 10),
        ms: up ? f.ms : 0,
        opacity: up ? 0.001 : 0.999,
        text: f.text,
        color: f.color,
        size: d(f.size),
      };
    });
  }

  agentsData({ names = true, tools = true, selecting = false, selected = new Set() } = {}) {
    this.inFlight = new Set(this.slots.filter(Boolean));
    const now = this.now();
    return this.slots.map((id) => {
      const a = id && this.agents.get(id);
      if (!a || !a.px) return EMPTY;
      const pet = a.kind === 'pet';
      const anim = (pet ? PET_ANIM : ANIM)[a.anim] || (pet ? PET_ANIM.sit : ANIM.idle);
      // Um pedido seu passa na frente de qualquer recado; o resto (a
      // ferramenta, o "…") só aparece quando não há recado no ar.
      const status = this.statusBubble(a, tools);
      let bubble = a.bubble && (!a.bubble.after || now >= a.bubble.after) ? a.bubble : null;
      if (status && (status.urgent || !bubble || bubble.tone === 'dim')) bubble = status;
      const tone = TONE[(bubble && bubble.tone) || 'white'];
      return {
        on: true,
        x: d(a.px.x + 8 - BOX_W / 2),
        y: d(a.px.y - BOX_TOP),
        ms: a.jump ? 0 : Math.round(a.ms || 0),
        // Você veste o que escolheu no "personalizar" (a folha sob medida).
        sheet: sprites.sheetOf((a.kind === 'you' ? this.youSkin : a.skin).id),
        rows: pet ? sprites.CAT_ROWS : sprites.ROWS,
        shirt: argb(a.skin.shirt || a.skin.fur),
        row: anim.row,
        frames: anim.frames,
        fps: anim.fps,
        flip: anim.flip === true,
        paused: anim.fps === 0,
        bubble: bubble ? { on: true, text: bubble.text, bg: tone.bg, fg: tone.fg } : NO_BUBBLE,
        showName: names && !pet,
        name: a.kind === 'helper' ? `↳ ${helperBadge(a)}${a.name}` : a.kind === 'you' ? this.youName : a.name,
        tone: a.kind === 'you' ? 0xff9b8fb5 : DOT[a.status] || DOT.unknown,
        tip: this.tipOf(a),
        // O clique: carinho no bicho, o "personalizar" em você, a conversa num
        // claude -- ou, selecionando, marcar e desmarcar quem recebe a mensagem.
        action: pet ? 'bicho' : a.kind === 'you' ? 'voce' : selecting && a.kind === 'claude' ? `sel:${a.tabId}` : `chat:${a.tabId}`,
        selected: a.kind === 'claude' && selected.has(a.tabId),
        // A bateria: quanto da janela de contexto ainda sobra.
        battery: a.kind === 'claude' ? batteryOf(a.ctx) : NO_BATTERY,
        menu: this.menuOf(a),
        // De onde o chat dele sai (e pra onde volta): o próprio boneco.
        anchor: a.kind === 'claude' ? `agente:${a.tabId}` : a.kind === 'you' ? 'voce' : `boneco:${a.slot}`,
      };
    });
  }

  /**
   * O botão direito num boneco (ou na linha dele na lateral): conversar, ir pra
   * sessão, acordar quem dorme e mandar pra casa. Só os claudes: o ajudante é
   * trabalho de outro, você é você e o bicho só quer carinho.
   */
  menuOf(a) {
    if (a.kind === 'you') return [{ label: 'personalizar', icon: 'edit', action: 'voce' }];
    if (a.kind !== 'claude') return [];
    return [
      { label: 'conversar', icon: 'chat', action: `chat:${a.tabId}` },
      { label: 'renomear', icon: 'edit', action: `renomear:${a.tabId}` },
      this.lounging(a) && !a.hibernated
        ? { label: 'voltar pra mesa', icon: 'play', action: `voltar:${a.tabId}` }
        : { label: 'mandar pro descanso', icon: 'pause', action: `descanso:${a.tabId}` },
      { label: 'ir pra sessão', icon: 'terminal', action: `ir:${a.tabId}` },
      ...(this.unreadNotes(a).length ? [{ label: 'ler os recados dos ajudantes', icon: 'file', action: `recados:${a.tabId}` }] : []),
      { label: 'marcar pra mandar a vários', icon: 'check', action: `sel:${a.tabId}` },
      ...(a.hibernated ? [{ label: 'acordar', icon: 'play', action: `acordar:${a.tabId}` }] : []),
      ...(this.canNap(a) ? [{ label: 'pôr pra dormir', icon: 'moon', action: `dormir:${a.tabId}` }] : []),
      { divider: true },
      { label: 'mandar pra casa', icon: 'home', action: `casa:${a.tabId}`, red: true },
    ];
  }

  /**
   * Dá pra pôr [a] pra dormir (hibernar: o processo desliga, a conversa fica,
   * e ele cochila no sofá): numa Maestria que deixa (`hibernateOn`), parado no
   * prompt e sem ajudante trabalhando.
   */
  canNap(a) {
    return (
      !!this.hibernateOn &&
      a.kind === 'claude' &&
      !a.hibernated &&
      !a.exited &&
      !a.leaving &&
      ['idle', 'ready', 'waitingInput'].includes(a.status) &&
      !this.helpersOf(a).some((h) => !h.leaving)
    );
  }

  /** O balão que o estado pede, quando não há um recado no ar. */
  statusBubble(a, tools) {
    if (a.kind === 'pet' || a.kind === 'you') return null;
    if (a.leaving) return null;
    // O "pronto" vai com ele aonde for (até a sala do descanso), até você ver.
    if (a.done && !a.status.startsWith('waiting')) return { text: '✓ pronto', tone: 'green' };
    if (!a.arrived) return null;
    if (a.goal && a.goal.kind !== 'desk' && a.goal.kind !== 'ask') return null;
    switch (a.status) {
      case 'waitingPermission':
        return { text: a.tool && a.tool.label ? `! ${a.tool.label}` : '! permissão', tone: 'red', urgent: true };
      case 'waitingAnswer':
        return { text: a.question ? `? ${a.question}` : '? pergunta', tone: 'yellow', urgent: true };
      case 'waitingInput':
        return { text: '… esperando você', tone: 'yellow', urgent: true };
      case 'working':
        return a.kind === 'claude' ? { text: '…', tone: 'dim' } : null;
      default:
    }
    if (tools && a.tool && a.tool.label) return { text: a.tool.label, tone: 'dim' };
    return null;
  }

  tipOf(a) {
    if (a.kind === 'pet') return SPECIES[a.species].tip;
    if (a.kind === 'you') {
      const busy = a.targetId ? ', levando o pedido' : '';
      return `${this.youName}${busy}\nclique pra personalizar`;
    }
    if (a.kind === 'courier') {
      const to = a.errand && this.agents.get(a.errand.to);
      return `mensageiro: um recado${a.from ? ` de ${a.from}` : ''}${to ? ` pra ${to.name}` : ''}`;
    }
    if (a.kind === 'helper') {
      const p = this.agents.get(a.parentId);
      const type = a.type && a.type !== 'general-purpose' ? ` (${a.type})` : '';
      return `ajudante${type} de ${p ? p.name : 'um claude'}: ${a.what}`;
    }
    const where = a.branch ? `${a.roomName} · ${a.branch}` : a.roomName;
    const ctx = typeof a.ctx === 'number' ? ` · contexto ${a.ctx}%` : '';
    const state = a.hibernated ? 'dormindo no sofá' : STATUS_LABEL[a.status] || a.status;
    const hint = a.hibernated ? 'clique pra conversar (e acordar)' : 'clique pra conversar';
    const stuck = a.stuck ? `\n🌧️ parece travado: ${a.stuck.reason}` : '';
    const day = this.usageOf(a);
    const today = day ? `\nhoje: ${fmtDuration(day.workMs)} trabalhando · ${fmtTokens(day.tokens)} tokens` : '';
    return `${a.name} — ${state} · ${where}${ctx}${stuck}${today}\n${hint}`;
  }

  /** As mesas vazias, clicáveis: chamar um claude pra aquela sala. */
  /**
   * O clique em cada mesa. Com um claude sentado nela, abre a conversa dele;
   * sem ninguém -- vaga, ou guardada pra quem foi pro café ou dorme no sofá --,
   * chama um claude novo pra sala (que senta numa mesa livre).
   */
  desksData() {
    const sitting = new Map();
    for (const a of this.people()) {
      if (a.kind === 'claude' && a.desk && !a.leaving && a.arrived && !a.walking && a.goal && a.goal.kind === 'desk') {
        sitting.set(a.desk, a);
      }
    }
    return this.plan.desks.map((dk) => {
      const room = this.plan.rooms.find((r) => r.id === dk.room);
      const who = sitting.get(dk.id);
      return {
        x: d(dk.x * T),
        y: d(dk.y * T - 8),
        on: !String(dk.room).startsWith('@'),
        action: who ? `chat:${who.tabId}` : `mesa:${dk.id}`,
        anchor: `mesa:${dk.id}`,
        tip: who ? `conversar com ${who.name}` : `chamar um claude pra ${room ? room.name : 'esta sala'}`,
      };
    });
  }

  /**
   * O topo da janelinha de chat de [a]: onde ele está, o que está fazendo agora
   * (a linha ao vivo embaixo da conversa) e se dá pra mandar mensagem -- não dá
   * enquanto ele espera uma permissão ou a resposta de uma pergunta, que são
   * respondidas no terminal.
   */
  chatCard(a) {
    const where = a.branch ? `${a.roomName} · ${a.branch}` : a.roomName;
    const helpers = this.helpersOf(a).filter((h) => !h.leaving);
    let live;
    if (a.hibernated) live = { text: 'dormindo no sofá — mande uma mensagem (ou clique em acordar) e ele volta', tone: 'dim' };
    else if (a.exited || a.status === 'ended') live = { text: 'a sessão saiu', tone: 'dim' };
    // Sem o `PostCompact` (um Esc no meio), o aviso não fica pra sempre.
    else if (a.compacting && this.now() - a.compacting < COMPACT_MAX_MS) live = { text: 'compactando a conversa…', tone: 'dim' };
    else if (a.status === 'waitingPermission')
      live = { text: `quer permissão${a.tool && a.tool.label ? `: ${a.tool.label}` : ''} — responda no terminal`, tone: 'red' };
    else if (a.status === 'waitingAnswer') live = { text: 'fez uma pergunta (aí em cima) — responda no terminal', tone: 'yellow' };
    else if (a.status === 'waitingInput') live = { text: 'esperando você', tone: 'yellow' };
    else if (a.status === 'tool' && a.tool) live = { text: `${a.tool.label}…`, tone: 'dim' };
    else if (a.status === 'starting') {
      // Chegando há muito tempo: o Claude Code deve estar perguntando alguma
      // coisa no terminal (se confia na pasta, o login) -- e lá é o lugar de responder.
      const slow = this.now() - (a.startingSince || a.createdAt || 0) > 15000;
      live = slow
        ? { text: 'ainda chegando — veja o terminal dele: o Claude Code pode estar perguntando se você confia na pasta', tone: 'yellow' }
        : { text: 'chegando… o que você mandar espera ele sentar', tone: 'dim' };
    } else if (a.status === 'working') live = { text: 'pensando…', tone: 'dim' };
    else live = null; // parado no prompt: nada a dizer embaixo da conversa
    const crew = helpers.length ? `${helpers.length} ${helpers.length === 1 ? 'ajudante' : 'ajudantes'}: ${helpers.map((h) => h.what).join(', ')}` : '';
    if (crew) live = live ? { ...live, text: `${live.text} · ${crew}` } : { text: crew, tone: 'dim' };
    // Batendo cabeça: o motivo, e o convite pra dar uma dica.
    if (a.stuck && !a.hibernated && !String(a.status).startsWith('waiting')) {
      live = { text: `🌧️ parece travado: ${a.stuck.reason} — quer ajudar? mande uma dica aqui embaixo`, tone: 'yellow' };
    }
    const tone = TONE[(live && live.tone) || 'dim'];
    const locked = a.status === 'waitingPermission' || a.status === 'waitingAnswer';
    return {
      name: a.name,
      sub: where,
      // O contexto, na barrinha colorida do topo do chat.
      ctx: contextBar(a.ctx),
      // O botão do descanso: mandar pra sala do descanso, ou chamar de volta.
      rest: a.hibernated
        ? { on: false, label: '', action: '' }
        : this.lounging(a)
          ? { on: true, label: 'voltar pra mesa', icon: 'play', action: 'voltar' }
          : { on: true, label: 'descansar', icon: 'pause', action: 'descanso' },
      // Pôr pra dormir de verdade: hiberna, e ele vai cochilar no sofá.
      nap: this.canNap(a) ? { on: true, label: 'dormir', icon: 'moon', action: 'dormir' } : { on: false, label: '', icon: '', action: '' },
      status: STATUS_LABEL[a.status] || a.status,
      dot: DOT[a.status] || DOT.unknown,
      sheet: sprites.sheetOf(a.skin.id),
      rows: sprites.ROWS,
      row: ANIM.idle.row,
      live: live ? { on: true, text: live.text, bg: tone.bg, fg: tone.fg } : { on: false, text: '', bg: 0, fg: 0 },
      locked,
      hint: locked ? 'ele está esperando você no terminal — use "ir pra sessão"' : '',
      asleep: !!(a.hibernated || a.exited),
      // Dormindo dá pra acordar; a que saiu (o processo morreu) não.
      sleeping: !!a.hibernated,
    };
  }

  // --- o dia: o relógio de ponto e os crachás --------------------------------------
  //
  // O `main.js` lê as conversas do dia (`usage.js`) e conta aqui: o tempo de
  // trabalho e os tokens de cada sessão (pelo id da conversa) e o total.

  setUsage(usage) {
    const json = JSON.stringify(usage || null);
    if (json === this.usageJson) return false;
    this.usageJson = json;
    this.usage = usage || null;
    return true;
  }

  usageOf(a) {
    const u = this.usage && a.sessionId && this.usage.bySession[a.sessionId];
    return u && (u.tokens || u.workMs) ? u : null;
  }

  /** A porta da rua, clicável: o fim do expediente. */
  doorData() {
    const e = this.plan && this.plan.porch[this.plan.porch.length - 1];
    if (!e) return { on: false, x: 0.001, y: 0.001 };
    return { on: true, x: d(e[0] * T), y: d(e[1] * T), tip: 'fim do expediente: junta todo mundo e faz o resumo do dia' };
  }

  /** O relógio de ponto, na parede da sua sala: o tempo e os tokens do dia, de todos. */
  punchData() {
    const room = this.plan && this.plan.rooms.find((r) => r.kind === 'office');
    if (!room) return { on: false, x: 0.001, y: 0.001, time: '', tokens: '', tip: '' };
    const total = (this.usage && this.usage.total) || { tokens: 0, workMs: 0, sessions: 0 };
    const rows = this.people()
      .filter((a) => a.kind === 'claude' && !a.leaving && this.usageOf(a))
      .map((a) => ({ a, u: this.usageOf(a) }))
      .sort((x, y) => y.u.tokens - x.u.tokens)
      .map(({ a, u }) => `· ${a.name}: ${fmtDuration(u.workMs)} · ${fmtTokens(u.tokens)} tokens`);
    return {
      on: true,
      x: d((room.ix + 5) * T + 4),
      y: d(room.y * T + 8),
      time: fmtDuration(total.workMs),
      tokens: `${fmtTokens(total.tokens)} tok`,
      tip: [
        `o ponto de hoje: ${fmtDuration(total.workMs)} de claude trabalhando, ${fmtTokens(total.tokens)} tokens` +
          (total.sessions ? ` em ${total.sessions} ${total.sessions === 1 ? 'conversa' : 'conversas'}` : ''),
        ...rows,
        'conta todas as conversas do Claude Code de hoje, abertas ou não (tokens sem a leitura de cache)',
      ].join('\n'),
    };
  }

  /**
   * A caixa de entrada, na sua mesa: cada claude que espera você vira um papel
   * -- a permissão (vermelho), a pergunta ou o recado (amarelo) e o "pronto"
   * ainda não visto (verde) --, do que espera há mais tempo pro mais novo.
   */
  inboxList() {
    const why = (a) =>
      a.status === 'waitingPermission'
        ? 'perm'
        : a.status === 'waitingAnswer' || a.status === 'waitingInput'
          ? 'ask'
          : a.done
            ? 'done'
            : null;
    return this.people()
      .filter((a) => a.kind === 'claude' && !a.leaving && why(a))
      .map((a) => ({ a, why: why(a), at: a.waitingSince || a.doneAt || 0 }))
      .sort((x, y) => x.at - y.at);
  }

  inboxData() {
    const home = this.plan && this.plan.home;
    if (!home) return { on: false, x: 0.001, y: 0.001, count: '', papers: [], tip: '', action: '' };
    const list = this.inboxList();
    const COLOR = { perm: 0xffe5534b, ask: 0xffeec05a, done: 0xff6cc483 };
    const LABEL = { perm: 'quer permissão', ask: 'esperando você', done: 'pronto' };
    return {
      on: true,
      x: d(home.desk.x * T - 1),
      y: d(home.desk.y * T + 1),
      count: list.length ? String(list.length) : '',
      papers: list.slice(0, 4).map((it, i) => ({ y: d(5 - i * 1.5), color: COLOR[it.why] })),
      tip: list.length
        ? [`a caixa de entrada: ${list.length} ${list.length === 1 ? 'claude espera' : 'claudes esperam'} você — clique pra ver um por um`, ...list.map((it) => `· ${it.a.name}: ${LABEL[it.why]}`)].join('\n')
        : 'a caixa de entrada: ninguém esperando você',
      action: list.length ? 'caixa' : '',
    };
  }

  counts() {
    let working = 0;
    let waiting = 0;
    let resting = 0;
    let helpers = 0;
    for (const a of this.people()) {
      if (a.leaving) continue;
      if (a.kind === 'helper') {
        helpers++;
        continue;
      }
      if (a.status === 'working' || a.status === 'tool' || a.status === 'starting') working++;
      else if (a.status.startsWith('waiting')) waiting++;
      else resting++;
    }
    return { working, waiting, resting, helpers };
  }

  /** As salas e quem está em cada uma, pra aba da lateral. */
  roster() {
    const rooms = new Map();
    for (const a of this.people()) {
      if (a.kind !== 'claude' || a.leaving) continue;
      if (!rooms.has(a.room)) rooms.set(a.room, { name: a.roomName, agents: [] });
      const helpers = this.helpersOf(a).filter((h) => !h.leaving).length;
      const where = a.goal && a.goal.kind === 'ask'
        ? `na ${this.officeName()}, com uma pergunta`
        : a.goal && a.goal.kind === 'meeting'
        ? `na sala de reunião${a.meeting && a.meeting.topic ? ` (${a.meeting.topic})` : ''}`
        : a.goal && a.goal.kind === 'huddle'
        ? `conversando com ${(this.agents.get(a.meeting && a.meeting.host) || {}).name || 'outro claude'}${a.meeting && a.meeting.topic ? ` (${a.meeting.topic})` : ''}`
        : a.goal && a.goal.kind === 'trip'
        ? `lendo o ${a.trip.name}`
        : a.goal && a.goal.kind === 'errand'
        ? 'levando um recado'
        : a.done
        ? '✓ pronto — abra a conversa pra ver'
        : a.goal && a.goal.kind === 'sofa'
          ? 'cochilando no sofá'
          : a.goal && a.goal.kind === 'lounge'
            ? 'na sala do descanso'
            : a.tool
              ? a.tool.label
              : STATUS_LABEL[a.status];
      const parts = [a.stuck ? '🌧️ parece travado' : where];
      if (helpers) parts.push(`${helpers} ${helpers === 1 ? 'ajudante' : 'ajudantes'}`);
      if (this.isTired(a)) parts.push(`contexto ${a.ctx}%`);
      rooms.get(a.room).agents.push({
        name: a.name,
        sub: parts.join(' · '),
        tone: a.done ? 0xff6cc483 : DOT[a.status] || DOT.unknown,
        action: `chat:${a.tabId}`,
        menu: this.menuOf(a),
        anchor: `linha:${a.tabId}`,
      });
    }
    return this.roomOrder.filter((id) => rooms.has(id)).map((id) => rooms.get(id));
  }
}

const EMPTY = {
  on: false,
  x: 0.001,
  y: 0.001,
  ms: 0,
};
const EMPTY_FX = { on: false, x: 0.001, y: 0.001, ms: 0, opacity: 0.001, text: '', color: 0, size: 7.001 };
const NO_BUBBLE = { on: false, text: '', bg: 0, fg: 0 };
const NO_BATTERY = { on: false, w: 0.001, color: 0 };

/** A bateria em cima do boneco: o que sobra do contexto, de 6 pixels. */
function batteryOf(pct) {
  if (typeof pct !== 'number') return NO_BATTERY;
  const left = Math.max(0, Math.min(100, 100 - pct));
  return { on: true, w: d(Math.max(0.6, (6 * left) / 100)), color: left <= 20 ? 0xffe5534b : left <= 50 ? 0xffeec05a : 0xff6cc483 };
}

/** O tipo de um ajudante no crachá, quando não é o de sempre: "Explore: ". */
function helperBadge(h) {
  return h.type && h.type !== 'general-purpose' ? `${h.type}: ` : '';
}

/** "3h12", "42 min", "menos de 1 min". */
function fmtDuration(ms) {
  const min = Math.floor((Number(ms) || 0) / 60000);
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}

/** "1,2 mi", "180 mil", "950". */
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace('.', ',')} mi`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} mil`;
  return String(v);
}

function tilePx(tile) {
  return { x: tile.x * T, y: tile.y * T - 8 };
}

/** O mesmo ponto na planta nova: dentro de uma sala, o mesmo lugar dela; fora, o chão livre mais perto. */
function translate(old, plan, tile) {
  const room = old.rooms.find((r) => tile.x >= r.x && tile.x < r.x + r.w && tile.y >= r.y && tile.y < r.y + r.h);
  const now = room && plan.rooms.find((r) => r.id === room.id);
  const at = now ? { x: now.x + (tile.x - room.x), y: now.y + (tile.y - room.y) } : tile;
  return office.nearestFree(plan, {
    x: Math.min(Math.max(0, at.x), plan.cols - 1),
    y: Math.min(Math.max(0, at.y), plan.rows - 1),
  });
}

/**
 * O texto da resposta de um ajudante, como o `PostToolUse` do `Task`/`Agent`
 * a traz: um texto, uma lista de blocos (`{ type: 'text', text }`), ou um
 * objeto com eles em `content`.
 */
/**
 * De onde veio um pedido: `{ name, text }` quando é de outra sessão (o
 * `SendMessage` entre sessões chega como `<cross-session-message from-name=…>`),
 * `{ notice: true }` quando é um aviso do próprio Claude Code (uma tarefa em
 * segundo plano que terminou), ou `null` (foi você).
 */
function originOf(raw) {
  const t = String(raw || '');
  const m = /<cross-session-message\b([^>]*)>([\s\S]*?)(<\/cross-session-message>|$)/.exec(t);
  if (m) {
    const name = (/from-name="([^"]*)"/.exec(m[1]) || [])[1] || '';
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { name, text };
  }
  if (/^\s*<(task-notification|system-reminder)\b/.test(t)) return { notice: true };
  return null;
}

/** Os caminhos que uma ferramenta toca: o arquivo, a pasta da busca, os caminhos de um comando. */
function pathsOf(name, input = {}) {
  const out = [];
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof input[k] === 'string') out.push(input[k]);
  if (name === 'Bash' && typeof input.command === 'string') {
    for (const m of input.command.matchAll(/(?:^|[\s'"=(])(\/[^\s'";|&<>()]+)/g)) out.push(m[1]);
  }
  return out;
}

function resultText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r.trim();
  if (Array.isArray(r)) return r.map((b) => (b && typeof b.text === 'string' ? b.text : typeof b === 'string' ? b : '')).join('\n').trim();
  if (typeof r === 'object') {
    if (r.content) return resultText(r.content);
    if (typeof r.result === 'string') return r.result.trim();
    if (typeof r.text === 'string') return r.text.trim();
  }
  return '';
}

/** O recado do `SubagentStop`: a última fala dele, ou o arquivo da conversa dele pra ler depois. */
function stopNote(p) {
  return {
    text: typeof p.last_assistant_message === 'string' ? p.last_assistant_message.trim() : '',
    transcript: typeof p.agent_transcript_path === 'string' ? p.agent_transcript_path : '',
  };
}

function argb(hex) {
  return (0xff000000 | parseInt(hex.slice(1), 16)) >>> 0;
}

const CTX_BAR_W = 120; // a largura da barrinha de contexto, no topo do chat

/**
 * A barrinha do contexto: quanto já foi (`bar`, em pixels de [CTX_BAR_W]) e a
 * cor -- verde até a metade, amarela até 80%, vermelha daí pra cima (é quando
 * o boneco começa a suar, e quando vale o `/compact`). Sem número (antes da
 * primeira resposta, logo depois de um `/compact`), não aparece.
 */
function contextBar(pct) {
  if (typeof pct !== 'number') return { on: false, bar: 0.001, color: 0, label: '' };
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const color = p >= 80 ? 0xffe5534b : p >= 50 ? 0xffeec05a : 0xff6cc483;
  return {
    on: true,
    bar: d(Math.max(2, (CTX_BAR_W * p) / 100)),
    color,
    label: p >= 80 ? `contexto ${p}% — vale um /compact` : `contexto ${p}%`,
  };
}

/** O status de uma sessão do `sessions.list`, com o hibernado e o encerrado. */
function statusOf(s) {
  // A hibernada está em `ended` pra janela, mas pro escritório ela só dorme.
  if (s.hibernated) return 'idle';
  if (s.exited) return 'ended';
  return s.status || 'unknown';
}

module.exports = { originOf, pathsOf, fmtDuration, fmtTokens, resultText, contextBar, World, describe, bashOutcome, lightAt, clip, d, ANIM, STEP_MS, PET_ID, YOU_ID, SPECIES };
