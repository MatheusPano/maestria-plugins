// Docker: os containers como no OrbStack. A aba da lateral é a lista, cada
// projeto do compose numa seção que abre e fecha, os avulsos numa própria; a
// bolinha diz quem está no ar, o hover para, sobe e abre um terminal dentro, e
// o clique abre a janela do container: o estado, as portas, os volumes, CPU e
// memória ao vivo e o log seguindo. A janela grande tem ainda as imagens, os
// volumes e o que cada coisa ocupa no disco.
//
// Quem avisa das mudanças é o `docker events`, não uma conferida de tempos em
// tempos: parou, subiu ou sumiu um container, a lista se refaz sozinha.

'use strict';

const fs = require('fs');
const path = require('path');
const mx = require('./maestria');
const docker = require('./docker');
const logs = require('./logs');
const icons = require('./icons');

const VIEW = 'docker';
const SIDEBAR = 'sidebar';
const DETAIL = 'ct.'; // + o id curto: uma janela por container
const PLUGIN_ID = process.env.MAESTRIA_PLUGIN_ID || 'maestria.docker';
// Com mais containers que isso a aba ganha um campo pra filtrar.
const FILTER_FROM = 8;
// Quantas portas viram "abrir no navegador" no menu de um container.
const MENU_PORTS = 4;
// A linha de CPU e memória não redesenha a janela mais que isso.
const STATS_EVERY = 3000;

const state = {
  dataDir: process.env.MAESTRIA_PLUGIN_DATA || '',
  settings: {},
  // O contexto escolhido na janela; '' é o que o docker usa agora.
  context: '',
  contexts: [],
  engine: null, // { down, error?, version? }
  list: [], // os containers, do docker ps
  signature: '', // a lista como texto, pra não redesenhar à toa
  error: null,
  task: null, // o que está rodando pra todos (limpar, puxar, ligar o motor)
  busy: new Map(), // id do container ou `p:<projeto>` → "parando…"
  // As seções que você abriu ou fechou: chave → true (aberta) / false. Sem
  // escolha, uma seção abre quando tem container no ar.
  expanded: {},
  // As cores que você escolheu: `p:<projeto>` e `n:<nome do container>` → tom.
  // O container vai pelo nome, que sobrevive a um compose up que o recria.
  colors: {},
  showStopped: null, // o "mostrar os parados" do "…"; null segue a configuração
  filter: '',
  viewOpen: false,
  sidebarShown: false,
  badge: null,
  tab: 'containers', // a da janela: containers, imagens, volumes
  images: null,
  volumes: null,
  df: null,
  dfLoading: false,
  // `gen` entra no id dos campos: a janela guarda o que foi digitado por id.
  gen: 0,
  // Os terminais do plugin (exec, logs do compose, rodar imagem): tabId → sessão.
  terms: new Map(),
  // As janelas de container abertas: viewId → detalhe (abaixo).
  details: new Map(),
  // As janelas de projeto do compose abertas: viewId → projeto (abaixo).
  projects: new Map(),
  // A linha acesa na lista: a da última janela aberta (`c:<id>` ou `p:<projeto>`).
  selected: null,
  // A busca aberta pela lupa do cabeçalho.
  searching: false,
  // Até onde vão os blocos que a Maestria desenha (o `blocks` do initialize).
  // 1 é uma Maestria de antes da lista do OrbStack.
  ui: 1,
  events: null, // o processo do docker events
  retry: null,
};

const setting = (id, fallback) => (id in state.settings ? state.settings[id] : fallback);

/** Os parados na lista: o que você escolheu no "…", ou a configuração. */
const showStopped = () => (typeof state.showStopped === 'boolean' ? state.showStopped : setting('stopped', true));

// --- disco -------------------------------------------------------------------

function statePath() {
  return state.dataDir ? path.join(state.dataDir, 'state.json') : '';
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    state.context = typeof s.context === 'string' ? s.context : '';
    state.expanded = s.expanded && typeof s.expanded === 'object' ? s.expanded : {};
    state.colors = s.colors && typeof s.colors === 'object' ? s.colors : {};
    state.showStopped = typeof s.showStopped === 'boolean' ? s.showStopped : null;
  } catch {
    // primeira vez
  }
  docker.configure({ binary: setting('binary', 'docker'), context: state.context });
}

function saveState() {
  if (!statePath()) return;
  try {
    fs.mkdirSync(state.dataDir, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ context: state.context, expanded: state.expanded, showStopped: state.showStopped, colors: state.colors }, null, 2));
  } catch (e) {
    mx.log('não salvei o estado:', e.message);
  }
}

// --- leitura -----------------------------------------------------------------

async function loadEngine() {
  state.engine = await docker.engine();
  try {
    state.contexts = await docker.contexts();
  } catch {
    state.contexts = [];
  }
}

async function reload() {
  try {
    state.list = await docker.containers();
    if (!state.engine || state.engine.down) await loadEngine();
    state.error = null;
  } catch (e) {
    state.list = [];
    if (docker.isDown(e.message)) state.engine = { down: true, error: e.message };
    else state.error = e.message;
  }
}

/** As imagens, os volumes e o disco: só quando a janela mostra a aba deles. */
async function loadExtras() {
  if (state.engine && state.engine.down) return;
  try {
    if (state.tab === 'imagens') state.images = await docker.images();
    if (state.tab === 'volumes') state.volumes = await docker.volumes();
  } catch (e) {
    state.error = e.message;
  }
  if (state.tab !== 'containers' && !state.df && !state.dfLoading) {
    // O df pode levar uns segundos: a janela aparece antes, com "medindo…".
    state.dfLoading = true;
    docker
      .diskUsage()
      .then((df) => (state.df = df))
      .catch((e) => mx.log('df:', e.message))
      .finally(() => {
        state.dfLoading = false;
        if (state.viewOpen) refreshWindow();
      });
  }
}

// Uma releitura por vez; o que chega no meio pede outra no fim.
let loading = null;
let again = false;
let soon = null;

/** Relê os containers e redesenha — tudo com `force`, senão só se a lista mudou. */
async function refreshNow(force = false) {
  if (loading) {
    again = true;
    await loading;
    if (force) await redraw();
    return;
  }
  loading = (async () => {
    do {
      again = false;
      await reload();
      if (state.viewOpen) await loadExtras();
    } while (again);
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
  const signature = JSON.stringify(state.list.map((c) => [c.id, c.state, c.status, c.health, c.name]));
  const changed = signature !== state.signature;
  state.signature = signature;
  await redraw({ force: force || changed });
  if (force || changed) for (const p of state.projects.values()) await refreshProject(p);
}

/** Depois de um evento: junta os que vêm em rajada (um compose up manda dezenas). */
let soonForce = false;
function refreshSoon(delay = 350, force = false) {
  clearTimeout(soon);
  soonForce = soonForce || force;
  soon = setTimeout(() => {
    const f = soonForce;
    soonForce = false;
    refreshNow(f).catch((e) => mx.log('reler:', String(e.stack || e)));
  }, delay);
}

// --- como mostrar --------------------------------------------------------------

/** "2 hours" → "2 h", do jeito que o docker escreve as durações. */
function duration(text) {
  const t = String(text).trim();
  if (/^less than a second$/i.test(t)) return 'agora';
  if (/^about a minute$/i.test(t)) return '1 min';
  if (/^about an hour$/i.test(t)) return '1 h';
  const m = t.match(/^(\d+) (second|minute|hour|day|week|month|year)s?$/i);
  if (!m) return t;
  const unit = { second: 's', minute: 'min', hour: 'h', day: 'd', week: 'sem', month: m[1] === '1' ? 'mês' : 'meses', year: m[1] === '1' ? 'ano' : 'anos' };
  return `${m[1]} ${unit[m[2].toLowerCase()]}`;
}

/** O Status do docker em português: "Exited (0) 2 days ago" → "saiu (0) há 2 d". */
function statusText(c) {
  const s = String(c.status || '');
  const up = s.match(/^Up (.+?)(?: \(.*\))?$/);
  if (c.state === 'paused') return 'pausado';
  if (c.state === 'restarting') return 'reiniciando';
  if (c.state === 'created') return 'criado, nunca rodou';
  if (c.state === 'removing') return 'removendo';
  if (c.state === 'dead') return 'morto';
  if (up) {
    const d = duration(up[1]);
    return d === 'agora' ? 'subiu agora' : `no ar há ${d}`;
  }
  const exited = s.match(/^Exited \((-?\d+)\) (.+) ago$/);
  if (exited) {
    const d = duration(exited[2]);
    return `saiu (${exited[1]}) ${d === 'agora' ? 'agora' : `há ${d}`}`;
  }
  return s.toLowerCase();
}

/** "agora", "há 5 min", "há 3 h", "há 2 d". */
function ago(date) {
  if (!date) return '';
  const min = Math.round((Date.now() - new Date(date).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

const isUp = (c) => c.state === 'running' || c.state === 'paused' || c.state === 'restarting';

function toneOf(c) {
  if (state.busy.has(c.id)) return 'yellow';
  if (c.state === 'running') {
    if (c.health === 'unhealthy') return 'red';
    if (c.health === 'starting') return 'yellow';
    return 'green';
  }
  if (c.state === 'paused' || c.state === 'restarting') return 'yellow';
  if (c.state === 'dead') return 'red';
  return 'faint';
}

/** A imagem sem o registro na frente: ghcr.io/org/app:1.2 → org/app:1.2. */
function shortImage(image) {
  const s = String(image || '');
  if (/^sha256:/.test(s)) return s.slice(7, 19);
  const parts = s.split('/');
  if (parts.length > 1 && /[.:]/.test(parts[0])) parts.shift();
  return parts.join('/');
}

/** O nome do container na lista: o serviço, num projeto do compose. */
function titleOf(c) {
  return c.service && !c.oneoff ? c.service : c.name;
}

function portsText(ports) {
  return ports.map((p) => `:${p.host}${p.host === p.container ? '' : ` → ${p.container}`}${p.proto === 'tcp' ? '' : `/${p.proto}`}`).join('  ');
}

function currentContext() {
  if (state.context) return state.contexts.find((c) => c.name === state.context) || { name: state.context };
  return state.contexts.find((c) => c.current) || null;
}

const onOrbStack = () => String((currentContext() || {}).endpoint || '').includes('/.orbstack/');

/** O domínio que o OrbStack dá pro container: serviço.projeto.orb.local ou nome.orb.local. */
function orbDomain(c) {
  return c.project && c.service ? `${c.service}.${c.project}.orb.local` : `${c.name}.orb.local`;
}

const urlFor = (port) => `${port === 443 || port === 8443 ? 'https' : 'http'}://localhost:${port}`;

// --- grupos ------------------------------------------------------------------

function matches(filter, c) {
  if (!filter) return true;
  return [c.name, c.service, c.project, c.image, ...c.ports.map((p) => String(p.host))].some((t) =>
    String(t || '').toLowerCase().includes(filter),
  );
}

/**
 * Os containers por projeto do compose: os avulsos primeiro, depois os
 * projetos com algo no ar e o resto em ordem alfabética. Dentro de cada um,
 * quem está no ar vem antes.
 */
function groups() {
  const filter = state.filter.trim().toLowerCase();
  const stopped = showStopped();
  const byKey = new Map();
  for (const c of state.list) {
    if (!matches(filter, c)) continue;
    if (!stopped && !isUp(c) && !state.busy.has(c.id)) continue;
    const key = c.project ? `p:${c.project}` : 'avulsos';
    if (!byKey.has(key)) {
      byKey.set(key, { key, project: c.project, workdir: c.workdir, configFiles: c.configFiles, items: [] });
    }
    const g = byKey.get(key);
    if (!g.workdir && c.workdir) g.workdir = c.workdir;
    if (!g.configFiles && c.configFiles) g.configFiles = c.configFiles;
    g.items.push(c);
  }
  const rank = (c) => (c.state === 'running' ? 0 : isUp(c) ? 1 : 2);
  const out = [...byKey.values()];
  for (const g of out) {
    g.items.sort((a, b) => rank(a) - rank(b) || titleOf(a).localeCompare(titleOf(b), 'pt-BR'));
    g.running = g.items.filter((c) => c.state === 'running').length;
  }
  out.sort((a, b) => {
    if (!a.project !== !b.project) return a.project ? 1 : -1;
    if (!!a.running !== !!b.running) return a.running ? -1 : 1;
    return a.project.localeCompare(b.project, 'pt-BR');
  });
  return out;
}

/** Aberta: a sua escolha, ou (sem escolha) quando há algo no ar. Buscando, tudo aberto. */
function isOpen(g) {
  if (state.filter.trim()) return true;
  if (g.key in state.expanded) return !!state.expanded[g.key];
  return g.running > 0 || !g.project;
}

// --- as cores ------------------------------------------------------------------
//
// Cada imagem tem a cor dela no avatar, como os ícones de app do OrbStack: as
// conhecidas pela cor do logo, as outras por um hash do nome — a mesma imagem
// tem sempre a mesma cor, e um projeto também.

const HUES = ['blue', 'cyan', 'purple', 'magenta', 'accent', 'yellow'];
const KNOWN = {
  postgres: 'blue',
  postgis: 'blue',
  redis: 'red',
  valkey: 'red',
  mysql: 'cyan',
  mariadb: 'cyan',
  percona: 'yellow',
  mongo: 'green',
  nginx: 'green',
  node: 'green',
  caddy: 'green',
  nats: 'cyan',
  traefik: 'cyan',
  rabbitmq: 'yellow',
  elasticsearch: 'yellow',
  kibana: 'magenta',
  minio: 'red',
  alpine: 'blue',
  ubuntu: 'yellow',
  debian: 'magenta',
  python: 'yellow',
  golang: 'cyan',
  php: 'purple',
  grafana: 'yellow',
  prometheus: 'red',
  localstack: 'purple',
  mailhog: 'purple',
  mailpit: 'purple',
};

function hue(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

/** A cor de uma imagem: pelo nome sem registro, sem dono e sem tag. */
function imageHue(image) {
  const base = shortImage(image).split(':')[0].split('/').pop();
  return KNOWN[base] || hue(base);
}

/** A cor do container: a que você escolheu, ou a da imagem. */
const containerColor = (c) => state.colors[`n:${c.name}`] || imageHue(c.image);

/** A cor do projeto: a que você escolheu, ou uma do nome. */
const projectColor = (project) => state.colors[`p:${project}`] || hue(project);

/**
 * O submenu "Cor" de um container (`n:<nome>`) ou projeto (`p:<nome>`): a
 * automática e as da paleta, cada uma com a bolinha dela.
 */
function colorMenu(key) {
  const now = state.colors[key];
  return {
    label: 'Cor',
    icon: 'dot',
    children: [
      { action: `cor:${key}:`, label: now ? 'Automática' : 'Automática ✓', tone: '' },
      ...icons.PALETTE.map(([tone, label]) => ({ action: `cor:${key}:${tone}`, label: now === tone ? `${label} ✓` : label, tone: icons.HEX[tone] })),
    ],
  };
}

/** A bolinha no canto do avatar: só pra quem está no ar (ou mexendo). */
function statusOf(c) {
  if (state.busy.has(c.id)) return 'yellow';
  if (!isUp(c)) return undefined;
  return toneOf(c);
}

// --- as linhas -----------------------------------------------------------------

function containerMenu(c) {
  const up = c.state === 'running';
  const busy = state.busy.has(c.id);
  const menu = [{ action: `abrir:${c.id}`, label: 'detalhes e logs', icon: 'report' }];
  if (up) {
    for (const p of c.ports.filter((x) => x.proto === 'tcp').slice(0, MENU_PORTS)) {
      menu.push({ action: `url:${urlFor(p.host)}`, label: `abrir localhost:${p.host}`, icon: 'globe' });
    }
    if (onOrbStack()) menu.push({ action: `url:http://${orbDomain(c)}`, label: `abrir ${orbDomain(c)}`, icon: 'globe' });
    menu.push({ action: `terminal:${c.id}`, label: 'terminal no container', icon: 'terminal' });
    menu.push({ action: `terminal-painel:${c.id}`, label: 'terminal num painel separado', icon: 'open' });
  }
  menu.push({ type: 'divider' });
  if (c.state === 'paused') {
    menu.push({ action: `retomar:${c.id}`, label: 'retomar', icon: 'continue', disabled: busy });
    menu.push({ action: `parar:${c.id}`, label: 'parar', icon: 'stop', disabled: busy });
  } else if (isUp(c)) {
    menu.push({ action: `parar:${c.id}`, label: 'parar', icon: 'stop', disabled: busy });
    menu.push({ action: `reiniciar:${c.id}`, label: 'reiniciar', icon: 'restart', disabled: busy });
    if (up) menu.push({ action: `pausar:${c.id}`, label: 'pausar', icon: 'pause', disabled: busy });
  } else {
    menu.push({ action: `iniciar:${c.id}`, label: 'iniciar', icon: 'play', disabled: busy });
  }
  menu.push({ type: 'divider' });
  menu.push(colorMenu(`n:${c.name}`));
  menu.push({ type: 'divider' });
  menu.push({ action: `copiar:${c.name}`, label: 'copiar o nome', icon: 'copy' });
  menu.push({ action: `copiar:${c.short}`, label: 'copiar o id', icon: 'copy' });
  menu.push({ type: 'divider' });
  menu.push({ action: `remover:${c.id}`, label: isUp(c) ? 'parar e remover…' : 'remover…', icon: 'trash', tone: 'red', disabled: busy });
  return menu;
}

/** O que fica à direita da linha: a porta publicada (e quantas mais). */
function metaOf(c) {
  if (c.state !== 'running') return undefined;
  const tcp = c.ports.filter((p) => p.proto === 'tcp');
  if (!tcp.length) return undefined;
  return tcp.length > 1 ? `:${tcp[0].host} +${tcp.length - 1}` : `:${tcp[0].host}`;
}

/** O selo, pro que pede atenção: mexendo, ou falhando no healthcheck. */
function pillOf(c) {
  if (state.busy.has(c.id)) return state.busy.get(c.id);
  if (c.state !== 'running') return c.state === 'paused' ? 'pausado' : c.state === 'restarting' ? 'reiniciando' : undefined;
  if (c.health === 'unhealthy') return 'falhando';
  if (c.health === 'starting') return 'subindo';
  return undefined;
}

/** A bolinha do canto do avatar, como no OrbStack: verde no ar, vermelha parado. */
function dotOf(c) {
  if (state.busy.has(c.id)) return 'yellow';
  if (!isUp(c)) return c.state === 'created' ? 'faint' : 'red';
  return toneOf(c);
}

/**
 * Uma linha de container, como no OrbStack: o cubo na cor da imagem, o nome e
 * a imagem embaixo (ou há quanto tempo parou), e os botões sempre à vista —
 * o link das portas, parar ou iniciar, a lixeira. O resto no botão direito.
 */
function containerItem(c, indent = 0) {
  const busy = state.busy.has(c.id);
  const up = c.state === 'running';
  const actions = [];
  if (!busy) {
    if (up && c.ports.some((p) => p.proto === 'tcp')) {
      const tcp = c.ports.filter((p) => p.proto === 'tcp');
      actions.push({ action: `portas:${c.id}`, icon: 'link', tooltip: tcp.map((p) => `localhost:${p.host}`).join(', ') });
    }
    if (c.state === 'paused') actions.push({ action: `retomar:${c.id}`, icon: 'play', tooltip: 'retomar' });
    else if (isUp(c)) actions.push({ action: `parar:${c.id}`, icon: 'stop', tooltip: 'parar' });
    else actions.push({ action: `iniciar:${c.id}`, icon: 'play', tooltip: 'iniciar' });
    actions.push({ action: `remover:${c.id}`, icon: 'trash', tooltip: isUp(c) ? 'parar e remover' : 'remover' });
  }
  return {
    title: titleOf(c),
    subtitle: isUp(c) ? shortImage(c.image) : statusText(c),
    // `icon` e `tone` pra uma Maestria que ainda não desenha avatar.
    icon: 'dot',
    tone: toneOf(c),
    avatar: { svg: icons.container(containerColor(c)) },
    status: dotOf(c),
    dim: !isUp(c) && !busy,
    selected: state.selected === `c:${c.id}`,
    indent,
    badge: pillOf(c),
    action: `abrir:${c.id}`,
    actions,
    menu: containerMenu(c),
  };
}

/** Um projeto do compose: a linha com a seta (abre e fecha) e a pilha colorida. */
function projectItem(g) {
  const key = `p:${g.project}`;
  const busy = state.busy.get(key);
  const n = g.items.length;
  const actions = busy
    ? []
    : [
        g.running
          ? { action: `p-parar:${g.project}`, icon: 'stop', tooltip: 'parar o projeto' }
          : { action: `p-subir:${g.project}`, icon: 'play', tooltip: 'subir o projeto (compose up -d)' },
        { action: `p-derrubar:${g.project}`, icon: 'trash', tooltip: 'derrubar o projeto (compose down)' },
      ];
  return {
    title: g.project,
    subtitle: busy ? undefined : g.running ? `${g.running} de ${n} no ar` : undefined,
    icon: 'server',
    tone: g.running ? 'green' : 'faint',
    avatar: { svg: icons.stack(projectColor(g.project)) },
    dim: !g.running && !busy,
    strong: !!g.running,
    selected: state.selected === key,
    expanded: isOpen(g),
    // A seta abre e fecha; a linha abre a janela do projeto, com o log de todos.
    toggle: `recolher:${key}`,
    action: `projeto-abrir:${g.project}`,
    badge: busy || undefined,
    actions,
    menu: projectMenu(g),
  };
}

function projectMenu(g) {
  const p = g.project;
  const busy = state.busy.has(`p:${p}`);
  return [
    { action: `projeto-abrir:${p}`, label: 'logs de todos os containers', icon: 'report' },
    { type: 'divider' },
    { action: `p-subir:${p}`, label: 'subir (up -d)', icon: 'play', disabled: busy },
    { action: `p-parar:${p}`, label: 'parar', icon: 'stop', disabled: busy || !g.running },
    { action: `p-reiniciar:${p}`, label: 'reiniciar', icon: 'restart', disabled: busy || !g.running },
    { type: 'divider' },
    { action: `p-logs:${p}`, label: 'logs do projeto num terminal', icon: 'terminal' },
    { action: `p-pasta:${p}`, label: 'terminal na pasta', icon: 'folder', disabled: !g.workdir },
    { action: `p-editor:${p}`, label: 'abrir o compose no editor', icon: 'edit', disabled: !g.configFiles },
    { type: 'divider' },
    colorMenu(`p:${p}`),
    { type: 'divider' },
    { action: `p-derrubar:${p}`, label: 'derrubar (down)…', icon: 'trash', tone: 'red', disabled: busy },
  ];
}

/**
 * A lista como a do OrbStack: em cima quem tem algo no ar (os projetos com a
 * seta, e os avulsos soltos), e embaixo, depois do rótulo "Parados", o resto.
 */
function containerSets() {
  const running = [];
  const stopped = [];
  const list = groups();
  const loose = list.find((g) => !g.project);
  const projects = list.filter((g) => g.project);
  const pushProject = (into, g) => {
    into.push(projectItem(g));
    if (isOpen(g)) for (const c of g.items) into.push(containerItem(c, 1));
  };
  projects.filter((g) => g.running).forEach((g) => pushProject(running, g));
  if (loose) loose.items.filter(isUp).forEach((c) => running.push(containerItem(c)));
  projects.filter((g) => !g.running).forEach((g) => pushProject(stopped, g));
  if (loose) loose.items.filter((c) => !isUp(c)).forEach((c) => stopped.push(containerItem(c)));
  return { running, stopped };
}

function emptyText() {
  if (state.filter.trim()) return 'nada com essa busca';
  if (state.list.length) return 'nenhum container no ar — os parados estão escondidos nas configurações';
  return 'nenhum container ainda — um docker run ou compose up aparece aqui na hora';
}

/** Os containers: numa lista solta na aba, dentro de um cartão na janela. */
function containerBlocks({ flat }) {
  if (state.ui < 2) return legacyBlocks();
  const { running, stopped } = containerSets();
  const list = (items, empty) => ({ type: 'list', flat: true, alwaysActions: true, items, empty });
  const out = [];
  if (running.length || !stopped.length) out.push(list(running, stopped.length ? undefined : emptyText()));
  if (stopped.length) {
    out.push({ type: 'section', style: 'label', text: 'Parados' });
    out.push(list(stopped));
  }
  return flat ? out : [{ type: 'card', padding: 6, children: out }];
}

/**
 * Pra uma Maestria de antes da lista do OrbStack (sem `blocks: 2` no
 * initialize): as réguas de seção que abrem e fecham, que ela sabe desenhar,
 * com um aviso pra reabrir o app.
 */
function legacyBlocks() {
  const out = [
    { type: 'text', style: 'warning', text: 'esta Maestria é de antes do plugin: feche (⌘Q) e abra de novo pra ver a lista nova, com a janela de logs e o terminal dentro do container.' },
  ];
  for (const g of groups()) {
    const open = isOpen(g);
    const count = g.running ? `${g.running}/${g.items.length}` : g.items.length;
    out.push({ type: 'section', text: g.project || 'avulsos', count, collapsed: !open, action: `recolher:${g.key}` });
    if (!open) continue;
    out.push({
      type: 'list',
      flat: true,
      items: g.items.map((c) => ({
        title: titleOf(c),
        subtitle: isUp(c) ? shortImage(c.image) : statusText(c),
        icon: 'dot',
        tone: toneOf(c),
        badge: pillOf(c) || metaOf(c),
        action: `abrir:${c.id}`,
        actions: c.state === 'running' ? [{ action: `parar:${c.id}`, icon: 'stop', tooltip: 'parar' }] : [{ action: `iniciar:${c.id}`, icon: 'play', tooltip: 'iniciar' }],
        menu: containerMenu(c),
      })),
    });
  }
  return out;
}

// --- os terminais do plugin ------------------------------------------------------

/**
 * Relê as sessões e fica com os terminais do plugin. O `tag` diz de quê cada
 * um é (`x:<id>` um exec, `l:<projeto>` os logs do compose, `r:<imagem>`…), e
 * volta no sessions.list mesmo depois de um "reiniciar".
 */
async function syncSessions() {
  let list;
  try {
    list = await mx.request('sessions.list');
  } catch (e) {
    mx.log('sessions.list:', e.message);
    return;
  }
  state.terms = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    if (s.owner === PLUGIN_ID && !s.embedded) state.terms.set(s.id, s);
  }
}

function termBlocks() {
  if (!state.terms.size) return [];
  return [
    { type: 'section', text: 'terminais', count: state.terms.size },
    {
      type: 'list',
      flat: true,
      items: [...state.terms.values()].map((s) => ({
        title: s.title,
        subtitle: s.exited ? 'saiu — clique pra ver o porquê' : termKind(s.tag),
        icon: 'terminal',
        tone: s.exited ? 'red' : 'green',
        avatar: { icon: 'terminal', color: s.exited ? 'red' : 'green' },
        action: `focar:${s.id}`,
        actions: [{ action: `fechar:${s.id}`, icon: 'clear', tooltip: 'fechar o terminal' }],
      })),
    },
    { type: 'section', text: 'containers' },
  ];
}

function termKind(tag) {
  const t = String(tag || '');
  if (t.startsWith('x:')) return 'dentro do container';
  if (t.startsWith('l:')) return 'logs do compose';
  if (t.startsWith('r:')) return 'imagem rodando';
  if (t.startsWith('v:')) return 'volume';
  if (t.startsWith('g:')) return 'logs do container';
  return undefined;
}

async function openTerm(command, label, tag) {
  try {
    const { tabId } = (await mx.request('session.openShell', { cwd: docker.HOME, command, label, owned: true, tag })) || {};
    if (tabId) state.terms.set(tabId, { id: tabId, title: label, tag });
  } catch (e) {
    await mx.request('window.showBanner', { text: `não abri o terminal: ${e.message}`, sticky: true });
    return;
  }
  await pushSidebar(true);
}

/** O shell de dentro: o das configurações, ou bash quando tem e sh quando não. */
function execCommand(c) {
  const shell = String(setting('shell', '') || '').trim();
  const inner = shell ? shell.split(/\s+/) : ['sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'];
  return docker.commandLine(['exec', '-it', c.name, ...inner]);
}

async function terminalIn(c) {
  if (c.state !== 'running') {
    await mx.request('window.showBanner', { text: `${c.name} não está no ar — inicie antes` });
    return;
  }
  // Um terminal de pé nesse container: vai pra ele em vez de abrir outro.
  const open = [...state.terms.values()].find((s) => s.tag === `x:${c.id}` && !s.exited);
  if (open) {
    await mx.request('session.focus', { tabId: open.id });
    return;
  }
  await openTerm(execCommand(c), c.name, `x:${c.id}`);
}

async function closeTerm(tabId) {
  try {
    await mx.request('session.close', { tabId });
  } catch (e) {
    mx.log('session.close:', e.message);
  }
  state.terms.delete(tabId);
}

// --- a aba da lateral ----------------------------------------------------------

function engineBlocks() {
  const e = state.engine;
  if (!e || !e.down) return [];
  const ctx = currentContext();
  const starter = docker.starterFor(ctx);
  return [
    {
      type: 'card',
      children: [
        {
          type: 'header',
          avatar: { icon: 'warning', color: 'yellow' },
          title: 'o docker está parado',
          subtitle: ctx ? `contexto ${ctx.name}` : 'nenhum contexto respondeu',
        },
        { type: 'text', style: 'faint', text: e.error },
        {
          type: 'row',
          children: [
            starter
              ? { type: 'button', action: 'ligar', label: starter.label, style: 'primary', icon: 'play', disabled: !!state.task }
              : null,
            { type: 'button', action: 'atualizar', label: 'tentar de novo', icon: 'refresh', disabled: !!state.task },
          ].filter(Boolean),
        },
      ],
    },
  ];
}

function statusBlocks() {
  const out = [];
  if (state.task) out.push({ type: 'progress', label: state.task });
  if (state.error) out.push({ type: 'text', style: 'error', text: state.error });
  return out;
}

/** "3 no ar · 49 containers", ou o que o motor tem. */
function summary() {
  if (!state.engine) return 'lendo…';
  if (state.engine.down) return 'parado';
  const running = state.list.filter((c) => c.state === 'running').length;
  const ctx = currentContext();
  const total = state.list.length;
  return `${running ? `${running} no ar` : 'nada no ar'} · ${total} container${total === 1 ? '' : 's'}${ctx ? ` · ${ctx.name}` : ''}`;
}

/** O "…" do cabeçalho: o que não merece um botão próprio. */
function moreMenu({ window = false } = {}) {
  const menu = [
    { action: 'projetos', label: 'projetos do compose…', icon: 'stack' },
    { action: 'terminal-pick', label: 'terminal num container…', icon: 'terminal' },
    { type: 'divider' },
    { action: 'parados', label: showStopped() ? 'esconder os parados' : 'mostrar os parados', icon: 'dot' },
    { action: 'limpar-parados', label: 'remover os parados…', icon: 'trash', disabled: !!state.task || !state.list.some((c) => !isUp(c)) },
  ];
  if (!window) menu.push({ type: 'divider' }, { action: 'janela', label: 'imagens, volumes e disco…', icon: 'open' });
  if (state.contexts.length > 1) {
    menu.push({ type: 'divider' });
    const cur = currentContext();
    for (const c of state.contexts) {
      menu.push({
        action: `contexto:${c.name}`,
        label: c.description && c.description !== c.name ? `${c.name} · ${c.description}` : c.name,
        icon: cur && cur.name === c.name ? 'check' : 'server',
      });
    }
  }
  return menu;
}

function sidebarBlocks() {
  if (state.ui < 2) return legacySidebar();
  const running = state.list.filter((c) => c.state === 'running').length;
  const out = [
    {
      type: 'header',
      title: 'Containers',
      subtitle: state.engine && state.engine.down ? 'parado' : state.engine ? (running ? `${running} no ar` : 'nada no ar') : 'lendo…',
      tone: state.engine && state.engine.down ? 'yellow' : undefined,
      actions: [
        { action: 'buscar', icon: 'search', tooltip: 'buscar', tone: state.searching || state.filter ? 'accent' : undefined },
        { action: 'janela', icon: 'open', tooltip: 'imagens, volumes e disco' },
        { icon: 'more', tooltip: 'mais', menu: [{ action: 'atualizar', label: 'atualizar', icon: 'refresh' }, { type: 'divider' }, ...moreMenu()] },
      ],
    },
  ];
  out.push(...engineBlocks(), ...statusBlocks());
  if (state.engine && state.engine.down) return out;
  if (state.searching || state.filter) {
    out.push({ type: 'input', id: 'filtro', icon: 'search', placeholder: 'buscar por nome, imagem, porta (enter)', value: state.filter, submit: 'filtrar' });
  }
  out.push(...termBlocks());
  out.push(...containerBlocks({ flat: true }));
  return out;
}

/** A aba numa Maestria de antes: só blocos que ela conhece. */
function legacySidebar() {
  const icon = (action, iconName, tooltip) => ({ type: 'button', style: 'icon', action, icon: iconName, tooltip });
  const out = [{ type: 'row', children: [icon('atualizar', 'refresh', 'atualizar'), icon('projetos', 'folder', 'projetos do compose…'), icon('janela', 'open', 'abrir a janela')] }];
  if (state.engine && state.engine.down) {
    out.push({ type: 'text', style: 'warning', text: `o docker está parado: ${state.engine.error}` });
    return out;
  }
  out.push(...statusBlocks());
  out.push(...containerBlocks({ flat: true }));
  return out;
}

function badgeText() {
  const n = state.list.filter((c) => c.state === 'running').length;
  return n ? String(n) : '';
}

/**
 * A aba, se está na tela, e o selo com quantos estão no ar. Escondida, só o
 * selo — e só quando mudou; os blocos vão inteiros no próximo sidebar.shown.
 */
// --- a aba em widgets (rfw) ---------------------------------------------------------
//
// Numa Maestria que desenha widgets que o plugin manda (o `rfw` do
// initialize), a aba é montada pelo plugin: `ui/sidebar.rfwtxt` diz como cada
// linha é, e aqui saem só os dados. Os cliques voltam como `act`.

const RFW_LIBRARY = fs.readFileSync(path.join(__dirname, 'ui', 'sidebar.rfwtxt'), 'utf8');
let rfwLibrarySent = false;

/** Um menu de blocos (`{ action, label, icon, tone }` | divisor) no formato da aba em widgets. */
function rfwMenu(menu) {
  return (menu || [])
    .filter(Boolean)
    .map((m) => {
      if (m.type === 'divider') return { divider: true };
      const item = { label: m.label, icon: m.icon || '', action: m.action || '', red: m.tone === 'red', disabled: !!m.disabled };
      // Um submenu (a paleta de cores): cada linha com a bolinha na cor dela.
      if (m.children) {
        item.children = m.children.map((c) => ({ label: c.label, action: c.action, color: c.tone ? 0xff000000 + parseInt(c.tone.slice(1), 16) : 0 }));
      }
      return item;
    });
}

/** Uma linha de blocos (a da lista do OrbStack) como dado da aba em widgets. */
function rfwRow(item) {
  return {
    kind: item.expanded === undefined ? 'container' : 'project',
    title: String(item.title || ''),
    sub: String(item.subtitle || ''),
    svg: (item.avatar && item.avatar.svg) || '',
    dot: item.status || 'none',
    dim: !!item.dim,
    selected: !!item.selected,
    strong: !!item.strong,
    indent: item.indent || 0,
    open: !!item.expanded,
    toggle: item.toggle || '',
    action: item.action || '',
    pill: item.badge || '',
    actions: (item.actions || []).map((a) => ({ icon: a.icon, tooltip: a.tooltip || '', action: a.action })),
    menu: rfwMenu(item.menu),
  };
}

function rfwData() {
  const rows = [];
  if (!(state.engine && state.engine.down)) {
    if (state.terms.size) {
      rows.push({ kind: 'label', title: 'Terminais' });
      for (const t of state.terms.values()) {
        rows.push({ kind: 'term', title: t.title, sub: t.exited ? 'saiu' : termKind(t.tag) || 'num painel', dot: t.exited ? 'red' : 'green', action: `focar:${t.id}`, actions: [{ icon: 'clear', tooltip: 'fechar o terminal', action: `fechar:${t.id}` }] });
      }
      rows.push({ kind: 'label', title: 'Containers' });
    }
    const { running, stopped } = containerSets();
    rows.push(...running.map(rfwRow));
    if (stopped.length) {
      rows.push({ kind: 'label', title: 'Parados' });
      rows.push(...stopped.map(rfwRow));
    }
  }
  const up = state.list.filter((c) => c.state === 'running').length;
  let sub = up ? `${up} no ar` : 'nada no ar';
  if (!state.engine) sub = 'lendo…';
  else if (state.engine.down) sub = `parado — ${state.engine.error}`;
  if (state.task) sub = state.task;
  return {
    head: {
      title: 'Containers',
      sub,
      menu: rfwMenu([
        ...(state.engine && state.engine.down && docker.starterFor(currentContext()) ? [{ action: 'ligar', label: docker.starterFor(currentContext()).label, icon: 'play' }, { type: 'divider' }] : []),
        ...moreMenu(),
      ]),
    },
    rows,
  };
}

async function pushSidebar(force = true) {
  const badge = badgeText();
  if (state.rfw && state.sidebarShown && force) {
    try {
      const params = { data: rfwData(), badge };
      if (!rfwLibrarySent) params.rfw = { library: RFW_LIBRARY, root: 'root' };
      const { shown } = await mx.request('sidebar.update', params);
      rfwLibrarySent = true;
      state.sidebarShown = shown;
      state.badge = badge;
    } catch (e) {
      mx.log('sidebar.update:', e.message);
    }
    return;
  }
  try {
    if (state.sidebarShown && force) {
      const { shown } = await mx.request('sidebar.update', { blocks: sidebarBlocks(), badge });
      state.sidebarShown = shown;
      state.badge = badge;
    } else if (badge !== state.badge) {
      await mx.request('sidebar.update', { badge });
      state.badge = badge;
    }
  } catch (e) {
    mx.log('sidebar.update:', e.message);
  }
}

// --- a janela ------------------------------------------------------------------

function tabsBlock() {
  const n = state.list.length;
  const tab = (id, label, icon, count) => ({ label, icon, count, action: `aba:${id}`, active: state.tab === id });
  return {
    type: 'tabs',
    items: [
      tab('containers', 'Containers', 'box', n || undefined),
      tab('imagens', 'Imagens', 'image', state.images ? state.images.length : undefined),
      tab('volumes', 'Volumes', 'drive', state.volumes ? state.volumes.length : undefined),
    ],
  };
}

/** Um cartão de número: quanto ocupa e quanto dá pra liberar. */
function diskCard(label, icon, color, d) {
  let title = state.dfLoading ? 'medindo…' : '—';
  let subtitle = label;
  if (d) {
    title = d.size;
    const free = String(d.reclaimable || '').replace(/^0B.*/, '');
    subtitle = `${label} · ${d.total}${free ? ` · ${free} liberável` : ''}`;
  }
  return { type: 'card', children: [{ type: 'header', avatar: { icon, color }, title, subtitle }] };
}

function windowBlocks() {
  if (state.ui < 2) {
    return [{ type: 'text', style: 'warning', text: 'esta Maestria é de antes do plugin: feche (⌘Q) e abra de novo pra ver containers, imagens e volumes aqui.' }];
  }
  const e = state.engine;
  const ctx = currentContext();
  const out = [
    {
      type: 'header',
      avatar: { icon: 'icons/docker.svg', color: 'blue' },
      status: e ? (e.down ? 'red' : 'green') : undefined,
      title: 'Docker',
      subtitle: e && !e.down ? `docker ${e.version} · ${e.ncpu} núcleos · ${summary()}` : summary(),
      actions: [
        { action: 'atualizar', icon: 'refresh', tooltip: 'atualizar' },
        { icon: 'more', tooltip: 'mais', menu: moreMenu({ window: true }) },
      ],
    },
  ];
  out.push(...engineBlocks());
  if (e && e.down) return out;
  out.push(tabsBlock());
  out.push(...statusBlocks());
  if (state.tab === 'imagens') out.push(...imageBlocks());
  else if (state.tab === 'volumes') out.push(...volumeBlocks());
  else {
    out.push({ type: 'input', id: 'filtro', icon: 'search', placeholder: 'buscar por nome, imagem ou porta (enter)', value: state.filter, submit: 'filtrar' });
    out.push(...containerBlocks({ flat: false }));
  }
  return out;
}

function imageBlocks() {
  const out = [];
  const df = state.df || {};
  out.push({
    type: 'columns',
    children: [diskCard('imagens', 'image', 'purple', df.Images), diskCard('cache de build', 'stack', 'cyan', df['Build Cache'])],
  });
  out.push({
    type: 'row',
    children: [
      { type: 'input', id: `pull.${state.gen}`, icon: 'pull', placeholder: 'baixar uma imagem: postgres:17 (enter)', submit: 'puxar', width: 340 },
      { type: 'button', action: 'puxar', label: 'baixar', icon: 'pull', disabled: !!state.task },
      {
        type: 'button',
        icon: 'trash',
        label: 'limpar',
        disabled: !!state.task,
        menu: [
          { action: 'limpar-imagens', label: 'remover as sem nome (<none>)', icon: 'trash' },
          { action: 'limpar-imagens-todas', label: 'remover as que nenhum container usa', icon: 'trash' },
          { type: 'divider' },
          { action: 'limpar-build', label: 'limpar o cache de build', icon: 'clear' },
        ],
      },
    ],
  });
  if (!state.images) {
    out.push({ type: 'progress', label: 'lendo as imagens…' });
    return out;
  }
  const used = new Map();
  for (const c of state.list) used.set(c.image, (used.get(c.image) || 0) + 1);
  const filter = state.filter.trim().toLowerCase();
  out.push({ type: 'input', id: 'filtro', icon: 'search', placeholder: 'buscar (enter)', value: state.filter, submit: 'filtrar' });
  const list = [...state.images]
    .filter((i) => !filter || i.ref.toLowerCase().includes(filter))
    .sort((a, b) => (b.created ? b.created.getTime() : 0) - (a.created ? a.created.getTime() : 0));
  const items = list.map((i) => {
    const n = Math.max(i.containers, used.get(i.ref) || 0, used.get(i.id) || 0);
    const ref = i.repo ? i.ref : i.id;
    return {
      title: i.repo ? i.ref : 'sem nome',
      subtitle: `${i.id} · ${ago(i.created)}${n ? ` · ${n} container${n > 1 ? 's' : ''}` : ''}`,
      icon: 'file',
      tone: n ? 'accent' : 'faint',
      avatar: { icon: 'image', color: i.repo ? imageHue(i.ref) : 'faint' },
      status: n ? 'accent' : undefined,
      dim: !i.repo,
      meta: i.size,
      actions: [
        { action: `rodar:${ref}`, icon: 'terminal', tooltip: 'rodar num terminal (sh)' },
        { action: `rmi:${i.id}`, icon: 'trash', tooltip: 'remover a imagem' },
      ],
      menu: [
        { action: `rodar:${ref}`, label: 'rodar num terminal (sh)', icon: 'terminal' },
        { action: `copiar:${ref}`, label: 'copiar o nome', icon: 'copy' },
        { type: 'divider' },
        { action: `rmi:${i.id}`, label: 'remover…', icon: 'trash', tone: 'red' },
      ],
    };
  });
  out.push({ type: 'card', padding: 6, children: [{ type: 'list', flat: true, items, empty: filter ? 'nada com essa busca' : 'nenhuma imagem' }] });
  return out;
}

function volumeBlocks() {
  const out = [];
  const df = state.df || {};
  out.push({
    type: 'columns',
    children: [
      diskCard('volumes', 'drive', 'yellow', df['Local Volumes']),
      diskCard('containers', 'box', 'blue', df.Containers),
    ],
  });
  out.push({
    type: 'row',
    children: [
      { type: 'input', id: 'filtro', icon: 'search', placeholder: 'buscar (enter)', value: state.filter, submit: 'filtrar', width: 340 },
      {
        type: 'button',
        icon: 'trash',
        label: 'limpar',
        disabled: !!state.task,
        menu: [
          { action: 'limpar-volumes', label: 'remover os anônimos sem uso', icon: 'trash' },
          { action: 'limpar-volumes-todos', label: 'remover todos sem uso (inclusive nomeados)…', icon: 'trash', tone: 'red' },
        ],
      },
    ],
  });
  if (!state.volumes) {
    out.push({ type: 'progress', label: 'lendo os volumes…' });
    return out;
  }
  // Quem usa cada volume: o Mounts do docker ps traz o nome deles.
  const users = new Map();
  for (const c of state.list) {
    for (const m of c.mounts) {
      if (!users.has(m)) users.set(m, []);
      users.get(m).push(c);
    }
  }
  const filter = state.filter.trim().toLowerCase();
  // Os em uso por quem está no ar primeiro, depois os de parados, os sem uso e,
  // por último, os anônimos — que são quase sempre lixo de um build antigo.
  const rank = (v) => {
    const by = users.get(v.name) || [];
    return (by.some(isUp) ? 0 : by.length ? 1 : 2) + (v.anonymous ? 3 : 0);
  };
  const list = [...state.volumes]
    .filter((v) => !filter || v.name.toLowerCase().includes(filter) || v.project.toLowerCase().includes(filter))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'pt-BR'));
  const items = list.map((v) => {
    const by = users.get(v.name) || [];
    const bits = [v.anonymous ? 'anônimo' : v.project ? v.project : v.driver];
    if (by.length) bits.push(`${by.map((c) => c.name).slice(0, 2).join(', ')}${by.length > 2 ? ` +${by.length - 2}` : ''}`);
    const live = by.some(isUp);
    return {
      title: v.anonymous ? v.name.slice(0, 12) : v.name,
      subtitle: bits.join(' · '),
      icon: 'folder',
      tone: live ? 'green' : 'faint',
      avatar: { icon: 'drive', color: v.project ? hue(v.project) : 'faint' },
      status: live ? 'green' : undefined,
      dim: !by.length,
      meta: by.length ? (live ? 'em uso' : 'parado') : 'sem uso',
      actions: [
        { action: `vol-terminal:${v.name}`, icon: 'terminal', tooltip: 'ver os arquivos num terminal' },
        { action: `rmv:${v.name}`, icon: 'trash', tooltip: 'remover o volume' },
      ],
      menu: [
        { action: `vol-terminal:${v.name}`, label: 'ver os arquivos num terminal', icon: 'terminal' },
        { action: `copiar:${v.name}`, label: 'copiar o nome', icon: 'copy' },
        { type: 'divider' },
        { action: `rmv:${v.name}`, label: 'remover…', icon: 'trash', tone: 'red' },
      ],
    };
  });
  out.push({ type: 'card', padding: 6, children: [{ type: 'list', flat: true, items, empty: filter ? 'nada com essa busca' : 'nenhum volume' }] });
  return out;
}

async function openWindow() {
  if (!state.engine) await loadEngine();
  await reload();
  await loadExtras();
  await mx.request('view.open', { viewId: VIEW, title: 'Docker', blocks: windowBlocks() });
  state.viewOpen = true;
  ensureEvents();
}

async function refreshWindow() {
  if (!state.viewOpen) return;
  const { open } = await mx.request('view.update', { viewId: VIEW, title: 'Docker', blocks: windowBlocks() });
  state.viewOpen = open;
}

/** Redesenha a janela e a aba. Sem `force`, a aba só acompanha o selo. */
async function redraw({ force = true } = {}) {
  if (force) await refreshWindow();
  await pushSidebar(force);
}

// --- ações ---------------------------------------------------------------------

async function confirm(title, yes, detail) {
  const r = await mx.request('window.pick', {
    title,
    items: [
      { value: 'nao', label: 'não, deixa' },
      { value: 'sim', label: yes, detail },
    ],
  });
  return r === 'sim';
}

/** Roda algo pra todos com a faixa de progresso; o erro vira o texto vermelho. */
async function task(label, fn) {
  if (state.task) return;
  state.task = label;
  state.error = null;
  await redraw();
  try {
    await fn();
  } catch (e) {
    state.error = e.message;
  } finally {
    state.task = null;
    state.images = null;
    state.volumes = null;
    state.df = null;
    await refreshNow(true);
  }
}

/** Uma ação num container ou projeto: a linha fica amarela com o que está fazendo. */
async function busyWith(key, label, fn) {
  if (state.busy.has(key)) return;
  state.busy.set(key, label);
  await redraw();
  for (const d of state.details.values()) if (d.id === key) await refreshDetail(d);
  for (const p of state.projects.values()) if (`p:${p.project}` === key) await refreshProject(p);
  try {
    await fn();
  } catch (e) {
    await mx.request('window.showBanner', { text: e.message, sticky: true });
  } finally {
    state.busy.delete(key);
    await refreshNow(true);
    for (const d of state.details.values()) if (d.id === key) await reinspect(d);
  }
}

const OPS = {
  iniciar: { args: ['start'], label: 'iniciando…' },
  parar: { args: ['stop'], label: 'parando…' },
  reiniciar: { args: ['restart'], label: 'reiniciando…' },
  pausar: { args: ['pause'], label: 'pausando…' },
  retomar: { args: ['unpause'], label: 'retomando…' },
};

async function containerOp(verb, c) {
  const op = OPS[verb];
  await busyWith(c.id, op.label, () => docker.must([...op.args, c.id], { timeout: 3 * 60 * 1000 }));
}

async function removeContainer(c) {
  const up = isUp(c);
  const r = await mx.request('window.pick', {
    title: `remover ${c.name}?`,
    items: [
      { value: 'nao', label: 'não, deixa' },
      { value: 'sim', label: up ? `sim, parar e remover ${c.name}` : `sim, remover ${c.name}`, detail: 'os volumes nomeados ficam' },
      { value: 'v', label: 'remover e apagar os volumes anônimos dele', detail: 'os nomeados ficam' },
    ],
  });
  if (r !== 'sim' && r !== 'v') return;
  const args = ['rm', ...(up ? ['-f'] : []), ...(r === 'v' ? ['-v'] : []), c.id];
  await busyWith(c.id, 'removendo…', () => docker.must(args, { timeout: 3 * 60 * 1000 }));
}

/** Os argumentos do compose pra um projeto: com os arquivos só quando eles ainda existem. */
function composeOf(project) {
  const g = groupOf(project);
  const files = String((g && g.configFiles) || '')
    .split(',')
    .filter(Boolean);
  const exists = files.length > 0 && files.every((f) => fs.existsSync(f));
  return {
    g,
    exists,
    args: exists ? docker.composeArgs(project, { workdir: g.workdir, configFiles: g.configFiles }) : ['compose', '-p', project],
  };
}

function groupOf(project) {
  const items = state.list.filter((c) => c.project === project);
  if (!items.length) return null;
  const withDir = items.find((c) => c.workdir) || items[0];
  return {
    project,
    items,
    workdir: withDir.workdir,
    configFiles: withDir.configFiles,
    running: items.filter((c) => c.state === 'running').length,
  };
}

async function projectOp(verb, project) {
  const { g, exists, args } = composeOf(project);
  if (!g) return;
  const key = `p:${project}`;
  const long = { timeout: 30 * 60 * 1000 };
  // Parar um projeto aberto não fecha a seção na sua frente: sem escolha
  // sua, ela abre só quando tem algo no ar, e isso ia mudar agora.
  if (!(key in state.expanded) && (verb === 'p-parar' || verb === 'p-subir')) {
    state.expanded[key] = isOpen({ key, project, running: g.running });
    saveState();
  }
  switch (verb) {
    case 'p-subir':
      // Sem os arquivos (o repositório mudou de lugar), sobe o que já existe.
      if (!exists) {
        return busyWith(key, 'iniciando…', () => docker.must(['start', ...g.items.map((c) => c.id)], long));
      }
      return busyWith(key, 'subindo…', () => docker.must([...args, 'up', '-d'], long));
    case 'p-parar':
      return busyWith(key, 'parando…', () => docker.must([...args, 'stop'], long));
    case 'p-reiniciar':
      return busyWith(key, 'reiniciando…', () => docker.must([...args, 'restart'], long));
    case 'p-derrubar': {
      const n = g.items.length;
      const sure = await confirm(
        `derrubar ${project}?`,
        `sim, derrubar ${project}`,
        `compose down: ${n === 1 ? 'o container sai' : `os ${n} containers saem`}, e as redes do projeto. Os volumes ficam.`,
      );
      if (!sure) return;
      return busyWith(key, 'derrubando…', () => docker.must([...args, 'down'], long));
    }
    case 'p-logs':
      return openTerm(docker.commandLine([...args, 'logs', '-f', '--tail', String(tailSetting())]), `logs · ${project}`, `l:${project}`);
    case 'p-pasta':
      if (!g.workdir) return;
      return mx.request('session.openShell', { cwd: g.workdir, label: project });
    case 'p-editor': {
      const file = String(g.configFiles || '').split(',')[0];
      if (file) return mx.request('editor.open', { path: file });
      return;
    }
    default:
  }
}

/** O botão de pasta: escolhe o projeto, depois o que fazer com ele. */
async function pickProject() {
  const list = groups().filter((g) => g.project);
  if (!list.length) {
    await mx.request('window.showBanner', { text: 'nenhum projeto do compose por aqui' });
    return;
  }
  const project = await mx.request('window.pick', {
    title: 'projetos do compose',
    placeholder: 'projeto',
    items: list.map((g) => ({
      value: g.project,
      label: g.project,
      detail: `${g.running ? `${g.running} de ${g.items.length} no ar` : `${g.items.length} parado${g.items.length > 1 ? 's' : ''}`} · ${docker.tilde(g.workdir) || ''}`,
    })),
  });
  if (project) await projectActions(project);
}

async function projectActions(project) {
  const g = groupOf(project);
  if (!g) return;
  const items = projectMenu(g)
    .filter((m) => m.action && !m.disabled)
    .map((m) => ({ value: m.action.split(':')[0], label: m.label }));
  const verb = await mx.request('window.pick', { title: project, items });
  if (verb) await projectOp(verb, project);
}

async function pickContainer(title, filter) {
  const list = state.list.filter(filter);
  if (!list.length) {
    await mx.request('window.showBanner', { text: state.list.length ? 'nenhum container no ar' : 'nenhum container ainda' });
    return null;
  }
  const rank = (c) => (c.state === 'running' ? 0 : 1);
  list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'pt-BR'));
  const id = await mx.request('window.pick', {
    title,
    placeholder: 'nome, projeto ou imagem',
    items: list.map((c) => ({
      value: c.id,
      label: c.project ? `${c.name} · ${c.project}` : c.name,
      detail: `${statusText(c)} · ${shortImage(c.image)}`,
    })),
  });
  return id ? state.list.find((c) => c.id === id) || null : null;
}

async function switchContext(name) {
  if (name === state.context) return;
  state.context = name;
  saveState();
  docker.configure({ context: name });
  stopEvents();
  for (const d of [...state.details.values()]) await closeDetail(d, { view: true });
  for (const p of [...state.projects.values()]) await closeProject(p, { view: true });
  state.images = null;
  state.volumes = null;
  state.df = null;
  state.list = [];
  state.engine = null;
  await loadEngine();
  ensureEvents();
  await refreshNow(true);
}

async function startEngine() {
  const starter = docker.starterFor(currentContext());
  if (!starter) return;
  await task(`${starter.label}…`, async () => {
    await docker.startEngine(starter);
    // O comando volta antes do motor responder (o open -a do Desktop volta na hora).
    for (let i = 0; i < 60; i++) {
      state.engine = await docker.engine();
      if (!state.engine.down) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (state.engine.down) throw new Error('liguei, mas o docker ainda não responde — tente de novo daqui a pouco');
  });
  ensureEvents();
}

async function pull(values) {
  const ref = String(values[`pull.${state.gen}`] || '').trim();
  if (!ref) {
    state.error = 'escreva o nome da imagem: postgres:16, redis, ghcr.io/org/app:1.0';
    return refreshWindow();
  }
  state.gen += 1;
  await task(`puxando ${ref}…`, async () => {
    await docker.must(['pull', ref], { timeout: 60 * 60 * 1000 });
    await mx.request('window.showBanner', { text: `${ref} baixada` });
  });
}

async function prune(kind) {
  const what = {
    'limpar-parados': {
      title: 'remover os containers parados?',
      yes: 'sim, remover todos os parados',
      detail: `${state.list.filter((c) => !isUp(c)).length} containers — os volumes ficam`,
      args: ['container', 'prune', '-f'],
    },
    'limpar-imagens': {
      title: 'remover as imagens sem nome?',
      yes: 'sim, remover as <none>',
      detail: 'as camadas penduradas que um build novo deixou pra trás',
      args: ['image', 'prune', '-f'],
    },
    'limpar-imagens-todas': {
      title: 'remover as imagens que nenhum container usa?',
      yes: 'sim, remover as sem container',
      detail: 'inclusive as com nome: o próximo up baixa ou builda de novo',
      args: ['image', 'prune', '-a', '-f'],
    },
    'limpar-build': {
      title: 'limpar o cache de build?',
      yes: 'sim, limpar o cache',
      detail: 'o próximo build começa do zero',
      args: ['builder', 'prune', '-f'],
    },
    'limpar-volumes': {
      title: 'remover os volumes anônimos sem uso?',
      yes: 'sim, remover os anônimos',
      detail: 'os nomeados (os dados de um banco do compose, por exemplo) ficam',
      args: ['volume', 'prune', '-f'],
    },
    'limpar-volumes-todos': {
      title: 'remover TODOS os volumes sem container?',
      yes: 'sim, apagar os dados deles',
      detail: 'inclusive os nomeados — o banco de um projeto parado vai junto. Não dá pra desfazer.',
      args: ['volume', 'prune', '-a', '-f'],
    },
  }[kind];
  if (!what) return;
  if (!(await confirm(what.title, what.yes, what.detail))) return;
  await task('limpando…', async () => {
    const out = await docker.must(what.args, { timeout: 30 * 60 * 1000 });
    const freed = out.match(/Total reclaimed space:\s*(.+)/);
    await mx.request('window.showBanner', { text: freed ? `liberei ${freed[1].trim()}` : 'pronto' });
  });
}

async function removeImage(id) {
  const img = (state.images || []).find((i) => i.id === id);
  const name = img && img.repo ? img.ref : id;
  const r = await mx.request('window.pick', {
    title: `remover ${name}?`,
    items: [
      { value: 'nao', label: 'não, deixa' },
      { value: 'sim', label: `sim, remover ${name}` },
      { value: 'f', label: 'remover à força', detail: 'mesmo com container parado usando, ou com várias tags' },
    ],
  });
  if (r !== 'sim' && r !== 'f') return;
  await task(`removendo ${name}…`, () => docker.must(['rmi', ...(r === 'f' ? ['-f'] : []), img && img.repo ? img.ref : id]));
}

async function removeVolume(name) {
  const sure = await confirm(`remover o volume ${name.slice(0, 40)}?`, 'sim, apagar o volume e os dados dele', 'não dá pra desfazer');
  if (!sure) return;
  await task('removendo o volume…', () => docker.must(['volume', 'rm', name]));
}

async function copy(text) {
  await mx.request('clipboard.write', { text });
  await mx.request('window.showBanner', { text: `copiei ${text}` });
}

/** As ações que valem igual na aba, na janela e na janela do container. */
async function commonAction(verb, arg, values) {
  const byId = (id) => state.list.find((c) => c.id === id);
  switch (verb) {
    case 'atualizar':
      state.error = null;
      state.images = null;
      state.volumes = null;
      state.df = null;
      await loadEngine();
      await syncSessions();
      ensureEvents();
      await refreshNow(true);
      return true;
    case 'cor': {
      // cor:<p|n>:<nome>:<tom> — o tom vazio volta pra automática.
      const at = arg.lastIndexOf(':');
      const key = arg.slice(0, at);
      const tone = arg.slice(at + 1);
      if (tone) state.colors[key] = tone;
      else delete state.colors[key];
      saveState();
      await redraw();
      for (const d of state.details.values()) await refreshDetail(d);
      for (const p of state.projects.values()) await refreshProject(p);
      return true;
    }
    case 'filtrar':
      if (values && typeof values.filtro === 'string') state.filter = values.filtro;
      await redraw();
      return true;
    case 'recolher': {
      const g = groups().find((x) => x.key === arg);
      if (g) state.expanded[arg] = !isOpen(g);
      saveState();
      await redraw();
      return true;
    }
    case 'abrir': {
      const c = byId(arg);
      if (c) await openDetail(c);
      return true;
    }
    case 'terminal': {
      // A aba Terminal da janela do container, como no OrbStack.
      const c = byId(arg);
      if (c) await openDetail(c, { tab: 'terminal' });
      return true;
    }
    case 'terminal-painel': {
      const c = byId(arg);
      if (c) await terminalIn(c);
      return true;
    }
    case 'terminal-pick': {
      const c = await pickContainer('terminal em qual container?', (x) => x.state === 'running');
      if (c) await openDetail(c, { tab: 'terminal' });
      return true;
    }
    case 'projeto-abrir':
      await openProject(arg);
      return true;
    case 'buscar':
      state.searching = !state.searching;
      if (!state.searching) state.filter = '';
      await redraw();
      return true;
    case 'portas': {
      // O link da linha: uma porta abre direto; mais de uma, pergunta qual.
      const c = byId(arg);
      if (!c) return true;
      const tcp = c.ports.filter((p) => p.proto === 'tcp');
      const urls = tcp.map((p) => urlFor(p.host));
      if (onOrbStack()) urls.push(`http://${orbDomain(c)}`);
      if (urls.length === 1) {
        await mx.request('window.openUrl', { url: urls[0] });
        return true;
      }
      const url = await mx.request('window.pick', {
        title: `abrir ${c.name}`,
        items: urls.map((u, i) => ({ value: u, label: u.replace(/^https?:\/\//, ''), detail: tcp[i] ? `porta ${tcp[i].container} do container` : 'domínio do OrbStack' })),
      });
      if (url) await mx.request('window.openUrl', { url });
      return true;
    }
    case 'iniciar':
    case 'parar':
    case 'reiniciar':
    case 'pausar':
    case 'retomar': {
      const c = byId(arg);
      if (c) await containerOp(verb, c);
      return true;
    }
    case 'remover': {
      const c = byId(arg);
      if (c) await removeContainer(c);
      return true;
    }
    case 'url':
      await mx.request('window.openUrl', { url: arg });
      return true;
    case 'copiar':
      await copy(arg);
      return true;
    case 'projeto':
      await projectActions(arg);
      return true;
    case 'projetos':
      await pickProject();
      return true;
    case 'p-subir':
    case 'p-parar':
    case 'p-reiniciar':
    case 'p-derrubar':
    case 'p-logs':
    case 'p-pasta':
    case 'p-editor':
      await projectOp(verb, arg);
      return true;
    case 'focar':
      await mx.request('session.focus', { tabId: arg });
      return true;
    case 'fechar':
      await closeTerm(arg);
      await syncSessions();
      await pushSidebar();
      return true;
    case 'ligar':
      await startEngine();
      return true;
    case 'parados':
      state.showStopped = !showStopped();
      saveState();
      await redraw();
      return true;
    case 'contexto':
      // O docker de agora é o '' — escolher ele pelo nome dá no mesmo.
      await switchContext(state.contexts.some((c) => c.name === arg && c.current) ? '' : arg);
      return true;
    case 'limpar-parados':
      await prune(verb);
      return true;
    case 'janela':
      await openWindow();
      return true;
    default:
      return false;
  }
}

async function windowAction(verb, arg, values) {
  if (values && typeof values.filtro === 'string') state.filter = values.filtro;
  if (await commonAction(verb, arg, values)) return;
  switch (verb) {
    case 'aba':
      state.tab = arg;
      state.error = null;
      await loadExtras();
      return refreshWindow();
    case 'puxar':
      return pull(values);
    case 'limpar-imagens':
    case 'limpar-imagens-todas':
    case 'limpar-build':
    case 'limpar-volumes':
    case 'limpar-volumes-todos':
      return prune(verb);
    case 'rmi':
      return removeImage(arg);
    case 'rmv':
      return removeVolume(arg);
    case 'rodar':
      return openTerm(docker.commandLine(['run', '--rm', '-it', '--entrypoint', 'sh', arg]), arg, `r:${arg}`);
    case 'vol-terminal':
      // Um alpine descartável com o volume montado em /volume.
      return openTerm(
        docker.commandLine(['run', '--rm', '-it', '-v', `${arg}:/volume`, '-w', '/volume', 'alpine', 'sh']),
        `volume ${arg.slice(0, 24)}`,
        `v:${arg}`,
      );
    default:
      mx.log('ação desconhecida:', verb, arg);
  }
}

async function sidebarAction(verb, arg, values) {
  if (values && typeof values.filtro === 'string') state.filter = values.filtro;
  if (await commonAction(verb, arg, values)) return;
  mx.log('ação desconhecida na aba:', verb, arg);
}

// --- a janela do container -------------------------------------------------------
//
// Como a do OrbStack: o cabeçalho com o estado e os botões, e três abas — os
// logs coloridos seguindo, um terminal de verdade dentro do container e as
// informações (CPU, memória, portas, volumes).
//
// Um detalhe é { viewId, id, name, info, tab, logs, stats, usage, buf,
// history, gen, term, termExited }: `info` o inspect lido por último, `logs` e
// `stats` os processos seguindo, `buf` as linhas esperando o próximo lote,
// `history` as últimas (pra voltar à aba de logs com elas), `term` o tabId do
// terminal embutido.

function tailSetting() {
  return Math.max(0, Number(setting('tail', 500)) || 0);
}

const maxLines = () => Math.max(500, Number(setting('max', 5000)) || 5000);

/**
 * Junta linhas a uma janela que segue logs (a de um container ou a de um
 * projeto): no histórico sempre, e no console quando a aba de logs está na
 * tela, num lote a cada 120ms.
 */
function pushLines(w, lines) {
  w.history.push(...lines);
  const over = w.history.length - maxLines();
  if (over > 0) w.history.splice(0, over);
  if (w.tab && w.tab !== 'logs') return;
  w.buf.push(...lines);
  if (w.flush) return;
  w.flush = setTimeout(() => flushLines(w), 120);
}

async function flushLines(w) {
  w.flush = null;
  if (!w.buf.length || !w.alive) return;
  const lines = w.buf.splice(0, w.buf.length);
  try {
    const { open } = await mx.request('view.appendLines', { viewId: w.viewId, id: `log.${w.gen}`, lines });
    if (!open) await w.close();
  } catch (e) {
    mx.log('appendLines:', e.message);
  }
}

function marker(text, tone = 'faint') {
  const at = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return { text: `── ${text} · ${at} ──`, tone };
}

/** Uma linha do `docker logs --timestamps`, pronta pro console. */
function logLine(raw, extra = {}) {
  const { at, rest } = logs.splitStamp(raw);
  return logs.line(rest, { ...extra, time: setting('timestamps', false) && at ? logs.clock(at) : undefined });
}

function startLogs(d, { since } = {}) {
  const args = ['logs', '-f', '--timestamps'];
  if (since) args.push('--since', String(since));
  else args.push('--tail', String(tailSetting()));
  args.push(d.id);
  const child = docker.stream(
    args,
    (line) => pushLines(d, [logLine(line)]),
    (code, err) => {
      if (d.logs !== child) return;
      d.logs = null;
      if (code && err && !/No such container/.test(err)) pushLines(d, [{ text: err, tone: 'red' }]);
    },
  );
  d.logs = child;
}

/** "12.5%" → 12.5 */
const pct = (s) => Number(String(s || '').replace('%', '')) || 0;

/** CPU e memória ao vivo, só com a aba de informações na tela. */
function startStats(d) {
  if (d.stats || !setting('stats', true) || d.tab !== 'stats') return;
  const child = docker.stream(
    ['stats', '--format', '{{json .}}', d.id],
    (line) => {
      if (d.stats !== child) return;
      const clean = docker.stripAnsi(line).trim();
      if (!clean.startsWith('{')) return;
      let s;
      try {
        s = JSON.parse(clean);
      } catch {
        return;
      }
      // O container parou: o stats segue mandando "--" até sair.
      if (!s.CPUPerc || s.CPUPerc === '--') {
        d.usage = null;
        return;
      }
      const first = !d.usage;
      d.usage = { cpu: s.CPUPerc, mem: s.MemUsage, memPerc: s.MemPerc, net: s.NetIO, block: s.BlockIO, pids: s.PIDs };
      const now = Date.now();
      if (first || now - (d.usageAt || 0) >= STATS_EVERY) {
        d.usageAt = now;
        refreshDetail(d).catch(() => {});
      }
    },
    () => {
      if (d.stats === child) d.stats = null;
    },
  );
  d.stats = child;
}

function stopStats(d) {
  docker.kill(d.stats);
  d.stats = null;
  d.usage = null;
}

async function reinspect(d) {
  try {
    d.info = docker.describe(await docker.inspect(d.id));
    d.name = d.info.name;
    d.gone = false;
  } catch (e) {
    if (/No such (container|object)/i.test(e.message)) d.gone = true;
    else mx.log('inspect:', e.message);
  }
  if (d.info && d.info.status === 'running' && !d.gone) startStats(d);
  else stopStats(d);
  await refreshDetail(d);
}

function detailState(d) {
  const i = d.info;
  if (d.gone) return { text: 'removido', tone: 'red' };
  if (!i) return { text: '…', tone: 'faint' };
  const busy = state.busy.get(d.id);
  if (busy) return { text: busy, tone: 'yellow' };
  switch (i.status) {
    case 'running': {
      const health =
        i.health && i.health !== 'healthy'
          ? ` · ${i.health === 'unhealthy' ? 'falhando no healthcheck' : 'healthcheck subindo'}`
          : i.health
            ? ' · saudável'
            : '';
      return {
        text: `no ar${i.startedAt ? ` ${ago(i.startedAt)}` : ''}${health}`,
        tone: i.health === 'unhealthy' ? 'red' : i.health === 'starting' ? 'yellow' : 'green',
      };
    }
    case 'paused':
      return { text: 'pausado', tone: 'yellow' };
    case 'restarting':
      return { text: `reiniciando (saiu com ${i.exitCode})`, tone: 'yellow' };
    case 'created':
      return { text: 'criado, nunca rodou', tone: 'faint' };
    case 'exited':
      return {
        text: `saiu com ${i.exitCode}${i.finishedAt ? ` ${ago(i.finishedAt)}` : ''}${i.oom ? ' · sem memória (OOM)' : ''}`,
        tone: i.exitCode && i.exitCode !== 143 && i.exitCode !== 137 ? 'red' : 'faint',
      };
    default:
      return { text: i.status, tone: 'faint' };
  }
}

/** Os medidores do container no ar: CPU (sobre todos os núcleos), memória, rede e disco. */
function usageBlocks(d) {
  const u = d.usage;
  if (!u) return [];
  const ncpu = (state.engine && state.engine.ncpu) || 1;
  const cpu = pct(u.cpu);
  const mem = pct(u.memPerc);
  const tone = (v) => (v > 85 ? 'red' : v > 60 ? 'yellow' : 'green');
  const [rx, tx] = String(u.net || '').split(' / ');
  const [rd, wr] = String(u.block || '').split(' / ');
  const [used, limit] = String(u.mem || '').split(' / ');
  return [
    {
      type: 'columns',
      children: [
        {
          type: 'card',
          children: [
            { type: 'progress', label: 'CPU', detail: `${u.cpu}${ncpu > 1 ? ` de ${ncpu * 100}%` : ''}`, value: cpu / (ncpu * 100), tone: tone(cpu / ncpu) },
          ],
        },
        {
          type: 'card',
          children: [{ type: 'progress', label: 'memória', detail: `${used} de ${limit}`, value: mem / 100, tone: tone(mem) }],
        },
        {
          type: 'card',
          children: [
            {
              type: 'kv',
              items: [
                { key: 'rede', value: `↓ ${rx || '—'}  ↑ ${tx || '—'}` },
                { key: 'disco', value: `lê ${rd || '—'} · grava ${wr || '—'}` },
              ],
            },
          ],
        },
      ],
    },
  ];
}


/** Acende a linha da janela aberta na lista (ou apaga, com null). */
function select(key) {
  if (state.selected === key) return;
  state.selected = key;
  redraw().catch((e) => mx.log('redesenhar:', e.message));
}

/** Abre (ou reabre) o shell de dentro do container, embutido na janela. */
async function openEmbedded(d) {
  const c = state.list.find((x) => x.id === d.id) || { name: d.name };
  try {
    const { tabId } =
      (await mx.request('session.openShell', {
        cwd: docker.HOME,
        command: execCommand(c),
        label: d.name,
        embedded: true,
        tag: `e:${d.id}`,
      })) || {};
    d.term = tabId || null;
    d.termExited = false;
  } catch (e) {
    d.term = null;
    d.termError = /embedded|desconhecid/i.test(e.message) ? 'esta Maestria ainda não embute terminais — atualize o app' : e.message;
  }
}

async function closeEmbedded(d) {
  if (!d.term) return;
  const tabId = d.term;
  d.term = null;
  await mx.request('session.close', { tabId }).catch(() => {});
}

const DETAIL_TABS = ['info', 'stats', 'logs', 'terminal'];

function detailTabs(d) {
  const tab = (id, label) => ({ label, action: `aba:${id}`, active: d.tab === id });
  return {
    type: 'tabs',
    align: 'center',
    items: [tab('info', 'Info'), tab('stats', 'Stats'), tab('logs', 'Logs'), tab('terminal', 'Terminal')],
  };
}

/** CPU, memória, rede e disco ao vivo: a aba Stats. */
function statsBlocks(d) {
  const s = d.info && !d.gone ? d.info.status : null;
  if (s !== 'running') {
    return [{ type: 'card', children: [{ type: 'header', avatar: { icon: 'cpu', color: 'faint' }, title: 'o container não está no ar', subtitle: 'os números aparecem quando ele sobe' }] }];
  }
  if (!setting('stats', true)) return [{ type: 'text', style: 'faint', text: 'desligado nas configurações do plugin' }];
  if (!d.usage) return [{ type: 'progress', label: 'medindo CPU e memória…' }];
  return usageBlocks(d);
}

function terminalBlocks(d) {
  const s = d.info && !d.gone ? d.info.status : null;
  if (s !== 'running') {
    return [
      {
        type: 'card',
        children: [
          {
            type: 'header',
            avatar: { icon: 'terminal', color: 'faint' },
            title: d.gone ? 'o container foi removido' : 'o container não está no ar',
            subtitle: d.gone ? '' : 'o terminal roda dentro dele: inicie antes',
          },
          d.gone ? null : { type: 'row', children: [{ type: 'button', action: 'iniciar', label: 'iniciar', icon: 'play', style: 'primary' }] },
        ].filter(Boolean),
      },
    ];
  }
  if (d.termError) return [{ type: 'text', style: 'error', text: d.termError }];
  const out = [];
  if (d.termExited) {
    out.push({
      type: 'row',
      children: [
        { type: 'text', style: 'faint', text: 'o shell saiu', width: 120 },
        { type: 'button', action: 'reabrir-terminal', label: 'abrir outro', icon: 'restart', style: 'primary' },
      ],
    });
  }
  out.push({ type: 'terminal', tabId: d.term, expand: true, autofocus: !d.termExited, empty: 'abrindo o shell…' });
  return out;
}

function infoBlocks(d) {
  const i = d.info;
  const s = i && !d.gone ? i.status : null;
  const project = i && i.labels['com.docker.compose.project'];
  const out = [];
  if (!i) return out;
  const items = [];
  items.push({ key: 'imagem', value: i.image });
  if (i.ports.length) items.push({ key: 'portas', value: portsText(i.ports), tone: 'accent' });
  if (project) items.push({ key: 'compose', value: `${project} · ${i.labels['com.docker.compose.service'] || ''}` });
  if (i.networks.length) items.push({ key: 'rede', value: i.networks.map((n) => (n.ip ? `${n.name} ${n.ip}` : n.name)).join(' · ') });
  if (onOrbStack() && s === 'running') {
    const c = state.list.find((x) => x.id === d.id);
    if (c) items.push({ key: 'domínio', value: orbDomain(c), tone: 'accent' });
  }
  for (const m of i.mounts.slice(0, 8)) {
    const from =
      m.type === 'volume' ? (/^[0-9a-f]{64}$/.test(m.name) ? `${m.name.slice(0, 12)} (anônimo)` : m.name) : docker.tilde(m.source);
    items.push({ key: m.type === 'bind' ? 'pasta' : m.type, value: `${from} → ${m.destination}${m.rw ? '' : ' (só leitura)'}` });
  }
  if (i.mounts.length > 8) items.push({ key: '', value: `e mais ${i.mounts.length - 8}`, tone: 'faint' });
  if (i.command) items.push({ key: 'comando', value: i.command, tone: 'faint' });
  items.push({ key: 'reinício', value: i.restart === 'no' ? 'nunca' : i.restart, tone: 'faint' });
  items.push({ key: 'criado', value: i.created ? ago(i.created) : '—', tone: 'faint' });
  items.push({ key: 'id', value: d.id.slice(0, 12), tone: 'faint' });
  out.push({ type: 'card', children: [{ type: 'kv', items }] });
  const env = i.env.filter((e) => !/^(PATH|HOSTNAME|HOME)=/.test(e));
  if (env.length) {
    out.push({ type: 'section', text: 'ambiente', count: env.length });
    out.push({ type: 'card', children: [{ type: 'code', text: env.join('\n') }] });
  }
  return out;
}

function detailBlocks(d, { withLines = false } = {}) {
  if (state.ui < 2) return legacyWindow(d, withLines);
  const i = d.info;
  const busy = state.busy.has(d.id);
  const s = i && !d.gone ? i.status : null;
  const st = detailState(d);
  const project = i && i.labels['com.docker.compose.project'];
  const first = i && i.ports.find((p) => p.proto === 'tcp');
  const off = busy || d.gone;
  const actions = [];
  if (s === 'running') {
    actions.push({ action: 'parar', icon: 'stop', tooltip: 'parar', disabled: off });
    actions.push({ action: 'reiniciar', icon: 'restart', tooltip: 'reiniciar', disabled: off });
    if (first) actions.push({ action: 'navegador', icon: 'globe', tooltip: `abrir localhost:${first.host}`, disabled: off });
  } else if (s === 'paused') {
    actions.push({ action: 'retomar', icon: 'play', tooltip: 'retomar', disabled: off });
    actions.push({ action: 'parar', icon: 'stop', tooltip: 'parar', disabled: off });
  } else if (s) {
    actions.push({ action: 'iniciar', icon: 'play', tooltip: 'iniciar', tone: 'green', disabled: off });
  }
  if (!d.gone) {
    actions.push({ action: 'remover', icon: 'trash', tooltip: 'remover o container', disabled: busy });
    actions.push({
      icon: 'more',
      tooltip: 'mais',
      menu: [
        s === 'running' ? { action: 'pausar', label: 'pausar', icon: 'pause', disabled: off } : null,
        s === 'running' ? { action: 'terminal-painel', label: 'terminal num painel separado', icon: 'terminal' } : null,
        { action: 'logs-terminal', label: 'seguir o log num painel separado', icon: 'terminal' },
        { action: 'limpar', label: 'limpar a tela do log', icon: 'clear' },
        { type: 'divider' },
        project ? { action: `projeto-abrir:${project}`, label: `logs do projeto ${project}`, icon: 'stack' } : null,
        { action: 'inspecionar', label: 'docker inspect, no leitor', icon: 'search', disabled: !i },
        { action: 'copiar-id', label: 'copiar o id', icon: 'copy' },
        { action: `copiar:${d.name}`, label: 'copiar o nome', icon: 'copy' },
      ].filter(Boolean),
    });
  }

  const out = [
    {
      type: 'header',
      avatar: { svg: icons.container(i ? containerColor({ name: d.name, image: i.image }) : 'gray') },
      status: s === 'running' || s === 'paused' || s === 'restarting' || busy ? st.tone : undefined,
      dim: !s || (s !== 'running' && s !== 'paused' && s !== 'restarting'),
      title: d.name,
      subtitle: [st.text, i && shortImage(i.image), project].filter(Boolean).join(' · '),
      tone: st.tone === 'red' ? 'red' : undefined,
      actions,
    },
  ];
  if (i && i.error) out.push({ type: 'text', style: 'error', text: i.error });
  out.push(detailTabs(d));
  if (d.tab === 'terminal') out.push(...terminalBlocks(d));
  else if (d.tab === 'info') out.push(...infoBlocks(d));
  else if (d.tab === 'stats') out.push(...statsBlocks(d));
  else {
    const consoleBlock = {
      type: 'console',
      id: `log.${d.gen}`,
      max: maxLines(),
      expand: true,
      empty: d.gone ? 'o container foi removido' : 'sem log ainda',
    };
    // Só quando o console nasce (a janela abriu, ou voltou pra esta aba): depois
    // as linhas chegam pelo appendLines, e um update sem `lines` mantém as dele.
    if (withLines) consoleBlock.lines = d.history.slice();
    out.push(consoleBlock);
  }
  return out;
}

async function refreshDetail(d, opts) {
  if (!d.alive) return;
  const { open } = await mx.request('view.update', { viewId: d.viewId, title: d.name, blocks: detailBlocks(d, opts) });
  if (!open) await closeDetail(d);
}

/** Troca de aba: o terminal nasce na primeira vez, o log volta com o que já tinha. */
async function switchTab(d, tab) {
  if (!DETAIL_TABS.includes(tab)) return;
  const was = d.tab;
  d.tab = tab;
  if (tab === 'stats') startStats(d);
  else stopStats(d);
  if (tab === 'terminal' && !d.term && !d.termError && d.info && d.info.status === 'running') await openEmbedded(d);
  if (tab === 'logs' && was !== 'logs') {
    // O console da aba saiu dos blocos e foi embora: um novo, com o histórico.
    d.gen += 1;
    d.buf = [];
    return refreshDetail(d, { withLines: true });
  }
  return refreshDetail(d);
}

async function openDetail(c, { tab } = {}) {
  const viewId = `${DETAIL}${c.short}`;
  let d = state.details.get(viewId);
  if (d) {
    // Aberta: traz pra frente (e troca de aba, se pediram). Fechada sem a
    // gente saber: recomeça.
    const { open } = await mx.request('view.update', { viewId, title: d.name, blocks: detailBlocks(d) });
    if (open) {
      await mx.request('view.open', { viewId, title: d.name, blocks: detailBlocks(d) });
      select(`c:${c.id}`);
      if (tab && tab !== d.tab) await switchTab(d, tab);
      return;
    }
    await closeDetail(d);
  }
  d = {
    viewId,
    id: c.id,
    name: c.name,
    info: null,
    tab: tab || 'logs',
    logs: null,
    stats: null,
    usage: null,
    buf: [],
    history: [],
    gen: 1,
    gone: false,
    term: null,
    termExited: false,
    alive: true,
  };
  d.close = () => closeDetail(d);
  state.details.set(viewId, d);
  select(`c:${c.id}`);
  try {
    d.info = docker.describe(await docker.inspect(c.id));
  } catch (e) {
    if (/No such (container|object)/i.test(e.message)) d.gone = true;
  }
  if (d.tab === 'terminal' && d.info && d.info.status === 'running') await openEmbedded(d);
  await mx.request('view.open', { viewId, title: d.name, blocks: detailBlocks(d, { withLines: true }) });
  if (!d.gone) startLogs(d);
  if (d.info && d.info.status === 'running') startStats(d);
  ensureEvents();
}

/** Para de seguir: a janela fechou, o contexto trocou. Com `view`, fecha a janela também. */
async function closeDetail(d, { view = false } = {}) {
  if (!d.alive) return;
  d.alive = false;
  state.details.delete(d.viewId);
  if (state.selected === `c:${d.id}`) select(null);
  docker.kill(d.logs);
  d.logs = null;
  stopStats(d);
  clearTimeout(d.flush);
  await closeEmbedded(d);
  if (view) await mx.request('view.close', { viewId: d.viewId }).catch(() => {});
}

async function detailAction(d, verb, arg) {
  const c = state.list.find((x) => x.id === d.id) || { id: d.id, name: d.name, short: d.id.slice(0, 12), state: d.info && d.info.status, ports: [] };
  switch (verb) {
    case 'aba':
      return switchTab(d, arg);
    case 'iniciar':
    case 'parar':
    case 'reiniciar':
    case 'pausar':
    case 'retomar':
      return containerOp(verb, c);
    case 'remover':
      await removeContainer(c);
      return;
    case 'terminal':
      return switchTab(d, 'terminal');
    case 'terminal-painel':
      return terminalIn({ ...c, state: d.info && d.info.status });
    case 'reabrir-terminal':
      await closeEmbedded(d);
      await openEmbedded(d);
      return refreshDetail(d);
    case 'navegador': {
      const p = d.info && d.info.ports.find((x) => x.proto === 'tcp');
      if (p) await mx.request('window.openUrl', { url: urlFor(p.host) });
      return;
    }
    case 'inspecionar': {
      const raw = await docker.must(['inspect', d.id]).catch((e) => e.message);
      await mx.request('pane.openMarkdown', { title: `inspect · ${d.name}`, markdown: '```json\n' + raw.trim() + '\n```\n' });
      return;
    }
    case 'copiar-id':
      return copy(d.id.slice(0, 12));
    case 'limpar':
      d.history = [];
      return mx.request('view.clearLines', { viewId: d.viewId, id: `log.${d.gen}` });
    case 'logs-terminal':
      return openTerm(docker.commandLine(['logs', '-f', '--tail', String(tailSetting()), d.id]), `logs · ${d.name}`, `g:${d.id}`);
    default:
      if (await commonAction(verb, arg, {})) return;
      mx.log('ação desconhecida no container:', verb, arg);
  }
}

// --- a janela do projeto ---------------------------------------------------------
//
// Clicar num projeto do compose abre a janela dele: os containers em cima e,
// embaixo, o log de todos juntos, cada linha com o nome do serviço na cor
// dele — o `docker compose logs -f`, mas em ordem de hora e colorido.
//
// Um projeto é { viewId, project, streams, pending, settle, buf, history, gen }:
// `streams` o logs -f de cada container, `pending` as linhas do começo, que
// esperam todas chegarem pra entrar em ordem de hora.

const PROJECT = 'pj.';

function projectContainers(project) {
  return state.list.filter((c) => c.project === project);
}

/** O nome que vai na frente da linha: o serviço, com o número quando há réplicas. */
function tagOf(c, items) {
  const same = items.filter((x) => x.service === c.service).length;
  if (c.service && same > 1) {
    const n = c.name.match(/-(\d+)$/);
    return n ? `${c.service}-${n[1]}` : c.name;
  }
  return c.service || c.name;
}

function projectLine(p, c, raw) {
  const items = projectContainers(p.project);
  const width = Math.max(...items.map((x) => tagOf(x, items).length), 4);
  const chosen = state.colors[`n:${c.name}`];
  return logLine(raw, { prefix: tagOf(c, items).padEnd(width), prefixTone: chosen ? icons.HEX[chosen] : hue(c.service || c.name) });
}

function followContainer(p, c, { since } = {}) {
  const old = p.streams.get(c.id);
  if (old && old.exitCode === null) return;
  const args = ['logs', '-f', '--timestamps'];
  if (since) args.push('--since', String(since));
  else args.push('--tail', String(Math.max(50, Math.floor(tailSetting() / Math.max(1, projectContainers(p.project).length)) * 2)));
  args.push(c.id);
  const child = docker.stream(
    args,
    (line) => {
      if (p.pending) {
        // O começo chega de cada container de uma vez: segura até todos
        // pararem de mandar, e entra tudo em ordem de hora.
        p.pending.push({ at: logs.splitStamp(line).at, c, line });
        clearTimeout(p.settle);
        p.settle = setTimeout(() => settleProject(p), 350);
      } else {
        pushLines(p, [projectLine(p, c, line)]);
      }
    },
    () => {
      if (p.streams.get(c.id) === child) p.streams.delete(c.id);
    },
  );
  p.streams.set(c.id, child);
}

function settleProject(p) {
  if (!p.pending) return;
  const all = p.pending.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  p.pending = null;
  clearTimeout(p.settle);
  clearTimeout(p.settleMax);
  if (all.length) pushLines(p, all.map((x) => projectLine(p, x.c, x.line)));
}

/** Uma janela de log numa Maestria de antes: o aviso e o console, que ela conhece. */
function legacyWindow(w, withLines) {
  const consoleBlock = { type: 'console', id: `log.${w.gen}`, max: maxLines(), expand: true, empty: 'sem log ainda' };
  if (withLines) consoleBlock.lines = w.history.slice();
  return [{ type: 'text', style: 'warning', text: 'esta Maestria é de antes do plugin: feche (⌘Q) e abra de novo pra ver as abas, as cores e o terminal.' }, consoleBlock];
}

function projectBlocks(p, { withLines = false } = {}) {
  if (state.ui < 2) return legacyWindow(p, withLines);
  const g = groupOf(p.project);
  const items = g ? g.items : [];
  const running = items.filter((c) => c.state === 'running').length;
  const busy = state.busy.get(`p:${p.project}`);
  const actions = [];
  if (g) {
    if (running) {
      actions.push({ action: `p-parar:${p.project}`, icon: 'stop', tooltip: 'parar o projeto', disabled: !!busy });
      actions.push({ action: `p-reiniciar:${p.project}`, icon: 'restart', tooltip: 'reiniciar o projeto', disabled: !!busy });
    } else {
      actions.push({ action: `p-subir:${p.project}`, icon: 'play', tooltip: 'subir (compose up -d)', tone: 'green', disabled: !!busy });
    }
    actions.push({ action: `p-derrubar:${p.project}`, icon: 'trash', tooltip: 'derrubar (down)', disabled: !!busy });
    actions.push({ icon: 'more', tooltip: 'mais', menu: [...projectMenu(g), { type: 'divider' }, { action: 'limpar', label: 'limpar a tela do log', icon: 'clear' }] });
  }
  const out = [
    {
      type: 'header',
      avatar: { svg: icons.stack(projectColor(p.project)) },
      status: busy ? 'yellow' : running ? (running === items.length ? 'green' : 'yellow') : undefined,
      dim: !running && !busy,
      title: p.project,
      subtitle: [
        busy || (g ? (running ? `${running} de ${items.length} no ar` : `${items.length} parado${items.length > 1 ? 's' : ''}`) : 'o projeto sumiu'),
        g && g.workdir ? docker.tilde(g.workdir) : null,
      ]
        .filter(Boolean)
        .join(' · '),
      actions,
    },
  ];
  out.push({
    type: 'tabs',
    align: 'center',
    items: [
      { label: 'Info', action: 'aba:info', active: p.tab === 'info' },
      { label: 'Logs', action: 'aba:logs', active: p.tab === 'logs' },
    ],
  });
  if (p.tab === 'info') {
    out.push({ type: 'section', style: 'label', text: 'Containers' });
    out.push({
      type: 'card',
      padding: 4,
      children: [
        {
          type: 'list',
          flat: true,
          alwaysActions: true,
          empty: 'nenhum container',
          items: items
            .slice()
            .sort((a, b) => (isUp(a) === isUp(b) ? titleOf(a).localeCompare(titleOf(b)) : isUp(a) ? -1 : 1))
            .map((c) => containerItem(c)),
        },
      ],
    });
    if (g && g.workdir) {
      out.push({
        type: 'card',
        padding: 4,
        children: [
          {
            type: 'list',
            flat: true,
            items: [
              { title: 'mostrar no Finder', subtitle: docker.tilde(g.workdir), icon: 'folder', avatar: { icon: 'folder', color: 'faint' }, action: 'finder' },
              { title: 'abrir o compose no editor', subtitle: docker.tilde(String(g.configFiles || '').split(',')[0]), icon: 'edit', avatar: { icon: 'edit', color: 'faint' }, action: `p-editor:${p.project}` },
              { title: 'terminal na pasta', icon: 'terminal', avatar: { icon: 'terminal', color: 'faint' }, action: `p-pasta:${p.project}` },
            ],
          },
        ],
      });
    }
    return out;
  }
  const consoleBlock = { type: 'console', id: `log.${p.gen}`, max: maxLines(), expand: true, empty: 'sem log ainda' };
  if (withLines) consoleBlock.lines = p.history.slice();
  out.push(consoleBlock);
  return out;
}

async function refreshProject(p) {
  if (!p.alive) return;
  const { open } = await mx.request('view.update', { viewId: p.viewId, title: p.project, blocks: projectBlocks(p) });
  if (!open) await closeProject(p);
}

async function openProject(project) {
  const viewId = `${PROJECT}${project}`;
  let p = state.projects.get(viewId);
  if (p) {
    const { open } = await mx.request('view.update', { viewId, title: project, blocks: projectBlocks(p) });
    if (open) {
      await mx.request('view.open', { viewId, title: project, blocks: projectBlocks(p) });
      select(`p:${project}`);
      return;
    }
    await closeProject(p);
  }
  p = { viewId, project, tab: 'logs', streams: new Map(), pending: [], settle: null, buf: [], history: [], gen: 1, alive: true };
  p.close = () => closeProject(p);
  state.projects.set(viewId, p);
  select(`p:${project}`);
  await mx.request('view.open', { viewId, title: project, blocks: projectBlocks(p, { withLines: true }) });
  for (const c of projectContainers(project)) followContainer(p, c);
  // Um projeto sem log nenhum não pode ficar esperando pra sempre.
  p.settleMax = setTimeout(() => settleProject(p), 2500);
  if (!p.streams.size) settleProject(p);
  ensureEvents();
}

async function closeProject(p, { view = false } = {}) {
  if (!p.alive) return;
  p.alive = false;
  state.projects.delete(p.viewId);
  if (state.selected === `p:${p.project}`) select(null);
  for (const child of p.streams.values()) docker.kill(child);
  p.streams.clear();
  clearTimeout(p.flush);
  clearTimeout(p.settle);
  clearTimeout(p.settleMax);
  if (view) await mx.request('view.close', { viewId: p.viewId }).catch(() => {});
}

async function projectWindowAction(p, verb, arg, values) {
  if (verb === 'aba' && (arg === 'logs' || arg === 'info')) {
    const was = p.tab;
    p.tab = arg;
    if (arg === 'logs' && was !== 'logs') {
      p.gen += 1;
      p.buf = [];
      const { open } = await mx.request('view.update', { viewId: p.viewId, title: p.project, blocks: projectBlocks(p, { withLines: true }) });
      if (!open) await closeProject(p);
      return;
    }
    return refreshProject(p);
  }
  if (verb === 'finder') {
    const g = groupOf(p.project);
    if (g && g.workdir) require('child_process').execFile('open', [g.workdir], () => {});
    return;
  }
  if (verb === 'limpar') {
    p.history = [];
    return mx.request('view.clearLines', { viewId: p.viewId, id: `log.${p.gen}` });
  }
  if (await commonAction(verb, arg, values)) return;
  mx.log('ação desconhecida no projeto:', verb, arg);
}

// --- o docker events -----------------------------------------------------------

/** Quem está olhando: a janela, a aba ou uma janela de container. */
function watching() {
  return state.viewOpen || state.sidebarShown || state.details.size > 0 || state.projects.size > 0;
}

/**
 * Sobe o `docker events`, se não está de pé. Ele fica enquanto o motor
 * responde (é um processo parado esperando, e é o que mantém o selo certo com
 * a aba fechada). Caiu — o motor parou, o contexto trocou —, tenta de novo de
 * tempos em tempos enquanto alguém olha.
 */
function ensureEvents() {
  if (state.events) return;
  clearTimeout(state.retry);
  state.retry = null;
  const child = docker.stream(
    ['events', '--format', '{{json .}}', '--filter', 'type=container', '--filter', 'type=image', '--filter', 'type=volume'],
    (line) => {
      if (!line.startsWith('{')) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      onDockerEvent(ev);
    },
    (code, err) => {
      if (state.events !== child) return;
      state.events = null;
      // Com o motor parado isso se repete a cada tentativa: o log diz uma vez.
      if (err && err !== state.eventsError) mx.log('docker events saiu:', err);
      state.eventsError = err;
      refreshSoon(0);
      state.retry = setTimeout(() => {
        state.retry = null;
        if (watching()) ensureEvents();
      }, 10000);
    },
  );
  state.events = child;
}

function stopEvents() {
  const child = state.events;
  state.events = null;
  docker.kill(child);
  clearTimeout(state.retry);
  state.retry = null;
}

const RELOAD_ON = new Set(['create', 'start', 'restart', 'stop', 'die', 'destroy', 'pause', 'unpause', 'rename', 'update', 'oom', 'kill']);

function onDockerEvent(ev) {
  const type = ev.Type;
  const action = String(ev.Action || ev.status || '');
  if (type === 'image' || type === 'volume') {
    if (type === 'image') state.images = null;
    else state.volumes = null;
    state.df = null;
    if (state.viewOpen && state.tab !== 'containers' && !state.task) refreshSoon(800, true);
    return;
  }
  // exec_* é o healthcheck e os terminais: acontece o tempo todo e não muda nada.
  if (action.startsWith('exec_')) return;
  const health = action.startsWith('health_status');
  if (!RELOAD_ON.has(action) && !health) return;
  refreshSoon();
  for (const d of state.details.values()) {
    if (d.id !== ev.id) continue;
    if (action === 'start') {
      pushLines(d, [marker('subiu', 'green')]);
      // O logs -f anterior saiu quando o container parou; este pega daqui.
      startLogs(d, { since: ev.time || Math.floor(Date.now() / 1000) });
    } else if (action === 'die') {
      const code = ev.Actor && ev.Actor.Attributes && ev.Actor.Attributes.exitCode;
      pushLines(d, [marker(code !== undefined ? `parou, saiu com ${code}` : 'parou', code && code !== '0' ? 'red' : 'faint')]);
    } else if (action === 'oom') {
      pushLines(d, [marker('sem memória (OOM)', 'red')]);
    } else if (action === 'destroy') {
      pushLines(d, [marker('removido', 'red')]);
    }
    if (action !== 'kill') reinspect(d).catch((e) => mx.log('reinspect:', e.message));
  }
  const attrs = (ev.Actor && ev.Actor.Attributes) || {};
  const project = attrs['com.docker.compose.project'];
  const p = project && state.projects.get(`${PROJECT}${project}`);
  if (!p) return;
  const c = state.list.find((x) => x.id === ev.id) || { id: ev.id, name: attrs.name || ev.id.slice(0, 12), service: attrs['com.docker.compose.service'] || '', project };
  const tag = c.service || c.name;
  if (action === 'start') {
    pushLines(p, [marker(`${tag} subiu`, 'green')]);
    followContainer(p, c, { since: ev.time || Math.floor(Date.now() / 1000) });
  } else if (action === 'die') {
    const code = attrs.exitCode;
    pushLines(p, [marker(`${tag} parou${code !== undefined ? `, saiu com ${code}` : ''}`, code && code !== '0' ? 'red' : 'faint')]);
  } else if (action === 'destroy') {
    pushLines(p, [marker(`${tag} removido`, 'faint')]);
  }
}

// --- o protocolo -----------------------------------------------------------------

mx.onNotification('view.action', async ({ viewId, action, values }) => {
  values = values || {};
  // Da aba em widgets: a ação vem nos argumentos do evento.
  if (action === 'act') action = String(values.a || values.action || '');
  const at = action.indexOf(':');
  const verb = at < 0 ? action : action.slice(0, at);
  const arg = at < 0 ? '' : action.slice(at + 1);
  try {
    if (viewId === VIEW) return await windowAction(verb, arg, values);
    if (viewId === SIDEBAR) return await sidebarAction(verb, arg, values);
    const d = state.details.get(viewId);
    if (d) return await detailAction(d, verb, arg);
    const p = state.projects.get(viewId);
    if (p) return await projectWindowAction(p, verb, arg, values);
  } catch (e) {
    mx.log(`ação ${action}:`, String(e.stack || e));
    await mx.request('window.showBanner', { text: e.message, sticky: true }).catch(() => {});
  }
});

mx.onNotification('event', async (e) => {
  switch (e.type) {
    case 'sidebar.shown':
      // A cada clique no ícone: relê os containers e os terminais.
      state.sidebarShown = true;
      await syncSessions();
      ensureEvents();
      return refreshNow(true);
    case 'sidebar.hidden':
      state.sidebarShown = false;
      return;
    case 'session.closed':
      for (const d of state.details.values()) if (d.term === e.tabId) d.term = null;
      if (!state.terms.has(e.tabId)) return;
      state.terms.delete(e.tabId);
      return pushSidebar();
    case 'session.exited':
    case 'session.status': {
      // O shell do terminal embutido saiu (exit, ou o container parou).
      const d = [...state.details.values()].find((x) => x.term === e.tabId);
      if (d && e.type === 'session.exited') {
        d.termExited = true;
        return refreshDetail(d);
      }
      if (!state.terms.has(e.tabId)) return;
      await syncSessions();
      return pushSidebar();
    }
    default:
  }
});

mx.onRequest('initialize', (params) => {
  state.dataDir = params.dataDir || state.dataDir;
  state.settings = params.settings || {};
  state.ui = Number(params.blocks) || 1;
  state.rfw = Number(params.rfw) >= 1;
  loadState();
  // O selo já na subida, sem esperar alguém abrir a aba.
  setImmediate(() => {
    ensureEvents();
    refreshNow().catch((e) => mx.log('primeira leitura:', String(e.stack || e)));
  });
  return {};
});

mx.onNotification('settings.changed', async ({ settings }) => {
  const before = setting('binary', 'docker');
  state.settings = settings || {};
  docker.configure({ binary: setting('binary', 'docker') });
  if (setting('binary', 'docker') !== before) {
    stopEvents();
    state.engine = null;
    await loadEngine();
    ensureEvents();
  }
  for (const d of state.details.values()) {
    if (!setting('stats', true)) stopStats(d);
    else if (d.info && d.info.status === 'running') startStats(d);
  }
  for (const p of state.projects.values()) await refreshProject(p);
  await refreshNow();
  for (const d of state.details.values()) await refreshDetail(d);
});

mx.onRequest('command.invoke', async ({ command }) => {
  // Sem await: o seletor espera você, e o command.invoke tem 30s pra voltar.
  const go = (fn) => fn().catch((e) => mx.log(command, String(e.stack || e)));
  if (command === 'containers') go(openWindow);
  else if (command === 'terminal') {
    go(async () => {
      await refreshNow();
      const c = await pickContainer('terminal em qual container?', (x) => x.state === 'running');
      if (c) await openDetail(c, { tab: 'terminal' });
    });
  } else if (command === 'logs') {
    go(async () => {
      await refreshNow();
      const c = await pickContainer('logs de qual container?', () => true);
      if (c) await openDetail(c);
    });
  } else if (command === 'compose') {
    go(async () => {
      await refreshNow();
      await pickProject();
    });
  } else throw new Error(`comando desconhecido: ${command}`);
  return null;
});

// O events e os logs -f ficam parados esperando: saindo sem matar, eles
// sobrevivem ao plugin.
process.on('exit', () => {
  docker.kill(state.events);
  for (const d of state.details.values()) {
    docker.kill(d.logs);
    docker.kill(d.stats);
  }
  for (const p of state.projects.values()) for (const child of p.streams.values()) docker.kill(child);
});
process.on('SIGTERM', () => process.exit(0));

mx.start();
