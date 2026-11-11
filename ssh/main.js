// SSH: os hosts numa tela, como no Termius. Clicou num host, abre um terminal
// da Maestria já rodando o ssh pra ele, e ao lado o painel de comandos daquele
// host: o histórico do servidor, os que você mandou e os que fixou -- um clique
// e o comando vai pro terminal.
//
// Os hosts são os `Host` do ~/.ssh/config: criar, editar e apagar um host mexe
// no bloco dele no config, e o que o config não guarda (nome de exibição,
// grupo, ícone) mora no meta.json do plugin.
//
// A aba do plugin na lateral é a mesma lista, enxuta: clicou, conectou. Numa
// Maestria que desenha widgets (`rfw`), a janela é o cofre do Termius: os
// grupos e os hosts em cartões, com o ícone do sistema de cada um.

'use strict';

const fs = require('fs');
const path = require('path');
const mx = require('./maestria');
const hosts = require('./hosts');
const sshconfig = require('./sshconfig');
const history = require('./history');
const distro = require('./distro');

const VIEW = 'hosts';
const EDITOR = 'editor';
const COMMANDS = 'comandos';
const SIDEBAR = 'sidebar';
const RFW_LIBRARY = fs.readFileSync(path.join(__dirname, 'ui', 'hosts.rfwtxt'), 'utf8');
const HINT = 'os hosts são os do ~/.ssh/config: o que você cria ou edita aqui vai pra lá, e `ssh <alias>` funciona fora da Maestria também. A senha, quando o servidor pede, você digita no terminal.';
// As cores dos quadrados dos grupos e dos hosts sem ícone. Sem o verde e o
// vermelho, que são de conectado e de caído.
const TONES = ['blue', 'cyan', 'purple', 'magenta', 'yellow', 'accent'];
const PLUGIN_ID = process.env.MAESTRIA_PLUGIN_ID || 'maestria.ssh';
// Com mais hosts que isso a aba ganha um campo pra filtrar.
const FILTER_FROM = 8;
// O valor do "novo grupo…" no seletor do formulário.
const NEW_GROUP = '::novo';
// Quantos comandos o painel mostra de uma vez.
const SHOW = 150;
// De quanto em quanto tempo o painel de comandos olha qual terminal está em foco.
const FOLLOW_MS = 1500;

const state = {
  dataDir: process.env.MAESTRIA_PLUGIN_DATA || '',
  settings: {},
  list: [], // os hosts do config, com o meta
  meta: {},
  groups: [],
  migrated: {}, // id de antes do config → alias
  // As seções fechadas da aba: `grupo:<nome>` e `salvos` (os sem grupo).
  collapsed: new Set(),
  viewOpen: false,
  rfw: false,
  input: false,
  modal: false,
  group: '', // o grupo aberto na grade ('' é a raiz)
  // O formulário sem modal, numa janela ao lado (Maestria sem `window.form`):
  // { alias?, values, gen, error? }.
  form: null,
  editorOpen: false,
  editorRaise: false,
  gen: 0,
  // Os terminais do plugin: tabId → `c:<alias>` (o `tag` do openShell).
  opened: new Map(),
  live: new Map(),
  dead: new Map(),
  filter: '',
  // O painel de comandos: de qual host, em que ordem, o filtro, e o que está
  // na tela (as ações levam o alias e o índice: um clique depois de o painel
  // trocar de host não roda a linha de outro).
  cmd: { open: false, alias: '', order: 'recentes', filter: '', timer: null, ticks: 0 },
  // As conexões em painel (Maestria com `split`): `con:<tabId>` → { tabId,
  // alias, order, filter, side }. O id da janela é a própria chave.
  cons: new Map(),
  shown: new Map(), // de quem → as linhas na tela
  split: false,
  onSessions: false,
  // Os terminais de um host renomeado: o tag deles ainda é o nome velho (tabId → `c:<alias>`).
  retag: new Map(),
  fetching: new Set(),
};

const setting = (id, fallback) => (id in state.settings ? state.settings[id] : fallback);

// As leituras que voltam juntas (a varredura) gravam o meta e redesenham uma vez só.
let metaDirty = false;
let flushTimer = null;

/** Relê os hosts, o meta e os grupos do disco (antes, grava o sistema que uma leitura achou). */
function reload() {
  if (metaDirty) {
    metaDirty = false;
    hosts.saveMeta(state.dataDir, state.meta);
  }
  state.meta = hosts.loadMeta(state.dataDir);
  state.list = hosts.list(state.dataDir, state.meta);
  state.groups = hosts.loadGroups(state.dataDir, state.meta);
  state.collapsed = hosts.loadCollapsed(state.dataDir);
}

function persistMeta() {
  hosts.saveMeta(state.dataDir, state.meta);
  hosts.saveGroups(state.dataDir, [...state.groups, ...Object.values(state.meta).map((m) => m.group)]);
  reload();
}

const metaOf = (alias) => (state.meta[alias] = state.meta[alias] || {});
const byAlias = (alias) => state.list.find((h) => h.alias === alias);

/** A chave de uma seção em `collapsed`: '' é a dos hosts sem grupo. */
const sectionKey = (group) => (group ? `grupo:${group}` : 'salvos');

function setCollapsed(key, on) {
  if (on) state.collapsed.add(key);
  else state.collapsed.delete(key);
  hosts.saveCollapsed(state.dataDir, state.collapsed);
}

/** Redesenha a janela de hosts (se aberta), os painéis de comandos e a aba. */
async function repaint() {
  if (state.viewOpen) await refresh();
  if (state.cmd.open) await paintScope(PANEL);
  for (const scope of [...state.cons.keys()]) await paintScope(scope);
  await pushSidebar();
}

async function redraw() {
  await syncEditor();
  await repaint();
}

const keyOf = (host) => `c:${host.alias}`;

/** "agora", "há 5 min", "há 3 h", "há 2 d": quando você conectou por último. */
function ago(iso) {
  if (!iso) return undefined;
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

async function connect(host) {
  if (state.split) return connectInPane(host);
  const command = hosts.commandFor(host, state.settings);
  try {
    // Na home e não na pasta do painel em foco: uma sessão remota não é de
    // repositório nenhum. E `owned`: o terminal é do plugin e mora nesta tela.
    const { tabId } =
      (await mx.request('session.openShell', { cwd: hosts.HOME, command, label: host.name || host.alias, owned: true, tag: keyOf(host) })) || {};
    if (tabId) {
      state.opened.set(tabId, keyOf(host));
      state.live.set(tabId, { id: tabId, kind: 'shell', title: host.name });
    }
  } catch (e) {
    await mx.request('window.showBanner', { text: `não abri o ssh: ${e.message}`, sticky: true });
    return;
  }
  await afterConnect(host);
  if (setting('commandsPanel', true)) await openCommands(host.alias);
}

/**
 * A conexão num painel só, como no Termius: o terminal (embutido) e os
 * comandos do host numa coluna à direita dele. O painel abre na tela das
 * sessões, ao lado da que está em foco -- a não ser que você prefira a tela do SSH.
 */
async function connectInPane(host) {
  const label = host.name || host.alias;
  let tabId;
  try {
    ({ tabId } =
      (await mx.request('session.openShell', {
        cwd: hosts.HOME,
        command: hosts.commandFor(host, state.settings),
        label,
        embedded: true,
        tag: keyOf(host),
      })) || {});
  } catch (e) {
    await mx.request('window.showBanner', { text: `não abri o ssh: ${e.message}`, sticky: true });
    return;
  }
  if (!tabId) return;
  state.opened.set(tabId, keyOf(host));
  state.live.set(tabId, { id: tabId, kind: 'shell', title: label, embedded: true });
  const scope = conScope(tabId);
  state.cons.set(scope, newCon(tabId, host.alias));
  await showCon(scope);
  await afterConnect(host);
}

async function afterConnect(host) {
  metaOf(host.alias).lastUsed = new Date().toISOString();
  persistMeta();
  fetchHistory(host.alias);
  await repaint();
}

const conScope = (tabId) => `con:${tabId}`;
const newCon = (tabId, alias) => ({ tabId, alias, order: 'recentes', filter: '', side: setting('commandsPanel', true) });

/** Abre (ou traz pra frente) o painel de uma conexão. */
async function showCon(scope) {
  const c = state.cons.get(scope);
  if (!c) return;
  const host = byAlias(c.alias) || { alias: c.alias, name: c.alias };
  await mx.request('view.open', {
    viewId: scope,
    title: host.name,
    blocks: conBlocks(scope),
    sessions: state.onSessions && setting('openOnSessions', true),
  });
}

/** O painel da conexão: o terminal e, à direita, os comandos (ou o botão que os mostra). */
function conBlocks(scope) {
  const c = state.cons.get(scope);
  const term = { type: 'terminal', tabId: c.tabId, expand: true, autofocus: true, empty: 'a conexão fechou — reconecte pelo host na lista' };
  if (!c.side) {
    return [
      { type: 'row', align: 'end', children: [{ type: 'button', action: `cmd-lado:${enc(scope)}`, icon: 'terminal', label: 'comandos', tooltip: 'mostrar os comandos deste host' }] },
      term,
    ];
  }
  return [{ type: 'split', width: SIDE_WIDTH, children: [term, ...commandBlocks(scope)] }];
}

// --- o histórico de cada host ----------------------------------------------------

/**
 * Lê o histórico e o sistema do host num ssh à parte, sem esperar: o painel e
 * o ícone se atualizam quando ele volta.
 */
function fetchHistory(alias, { force = false } = {}) {
  if (!setting('history', true) && !force) return;
  fetchHistoryNow(alias);
}

/** A leitura de verdade; a promessa resolve quando ela acaba (e nunca rejeita). */
function fetchHistoryNow(alias) {
  if (state.fetching.has(alias)) return Promise.resolve();
  state.fetching.add(alias);
  repaintAlias(alias).catch(() => {});
  const { binary, options, quoted } = hosts.probe(byAlias(alias) || { alias }, state.settings);
  return history
    .fetchRemote(quoted, { timeout: 25, binary, options })
    .then((result) => {
      if (result.error) mx.log(`histórico de ${alias}:`, result.error);
      // Renomeado ou apagado enquanto o ssh lia: o resultado não tem mais dono.
      if (!byAlias(alias)) return;
      history.save(state.dataDir, alias, history.applyRemote(history.load(state.dataDir, alias), result));
      const os = distro.detect(result.os);
      if (os && os !== metaOf(alias).os) {
        metaOf(alias).os = os;
        metaDirty = true;
      }
    })
    .catch((e) => mx.log(`histórico de ${alias}:`, String(e.stack || e)))
    .finally(() => {
      state.fetching.delete(alias);
      scheduleFlush();
    });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (metaDirty) {
      metaDirty = false;
      persistMeta();
    }
    repaint().catch(() => {});
  }, 300);
}

// Quantos hosts a varredura de sistema lê ao mesmo tempo.
const SCAN_AT_ONCE = 4;
let scanning = false;

/**
 * O ícone de cada host sem precisar conectar antes: lê, em segundo plano e
 * poucos por vez, o sistema (e o histórico) dos hosts que ainda não têm
 * sistema conhecido. Um host que não respondeu não é tentado de novo por um dia.
 */
async function scanSystems() {
  if (scanning || !setting('history', true) || !setting('detectAll', false)) return;
  scanning = true;
  const now = Date.now();
  const queue = state.list.filter((h) => {
    if (h.os || h.icon) return false;
    const tried = history.load(state.dataDir, h.alias).fetchedAt;
    return !tried || now - new Date(tried).getTime() > 24 * 3600 * 1000;
  });
  const worker = async () => {
    for (let h = queue.shift(); h; h = queue.shift()) await fetchHistoryNow(h.alias);
  };
  try {
    await Promise.all(Array.from({ length: SCAN_AT_ONCE }, worker));
  } finally {
    scanning = false;
  }
}

/** O terminal pra onde vai um comando: o do host em foco, senão o último aberto dele. */
async function targetTab(alias) {
  await syncSessions();
  const live = byHost().get(`c:${alias}`)?.live || [];
  if (!live.length) return null;
  return live.find((id) => state.live.get(id)?.focused) || live[live.length - 1];
}

async function sendCommand(scope, cmd, submit) {
  const ctx = ctxOf(scope);
  const con = state.cons.get(scope);
  const tabId = con ? (state.dead.has(con.tabId) ? null : con.tabId) : await targetTab(ctx.alias);
  if (!tabId) {
    await mx.request('clipboard.write', { text: cmd });
    await mx.request('window.showBanner', { text: `nenhuma conexão aberta com ${ctx.alias}: copiei o comando` });
    return;
  }
  try {
    await mx.request('terminal.sendText', { tabId, text: cmd, submit });
    // O terminal embutido mora no painel da conexão: quem vai pra frente é ele.
    if (!con) await mx.request('session.focus', { tabId });
  } catch (e) {
    await mx.request('window.showBanner', { text: `não mandei o comando: ${e.message}` });
    return;
  }
  history.save(state.dataDir, ctx.alias, history.recordSent(history.load(state.dataDir, ctx.alias), cmd));
  await paintScope(scope);
}

// --- os comandos (na coluna da conexão, ou no painel avulso) -------------------------

// O painel avulso: numa Maestria sem o bloco `split`, ou pra ver os comandos de
// um host sem conexão aberta.
const PANEL = 'painel';
const SIDE_WIDTH = 300;
const enc = encodeURIComponent;

/** O estado de quem mostra os comandos: o painel avulso ou a coluna de uma conexão. */
const ctxOf = (scope) => (scope === PANEL ? state.cmd : state.cons.get(scope));

function commandBlocks(scope) {
  const ctx = ctxOf(scope);
  const alias = ctx.alias;
  const inPane = scope !== PANEL;
  const host = byAlias(alias) || { alias, name: alias };
  const data = history.load(state.dataDir, alias);
  const all = history.entries(data, { order: ctx.order, filter: ctx.filter });
  const shown = all.slice(0, SHOW);
  state.shown.set(scope, shown);
  const ref = (n) => `${enc(scope)}|${n}`;
  let status;
  if (state.fetching.has(alias)) status = 'lendo o histórico do servidor…';
  else if (data.error) status = `o histórico do servidor não veio: ${data.error}`;
  else if (data.fetchedAt) status = `histórico lido ${ago(data.fetchedAt)}`;
  else status = 'o histórico do servidor é lido quando você conecta';
  const live = inPane ? !state.dead.has(ctx.tabId) : byHost().get(`c:${alias}`)?.live.length;
  return [
    {
      type: 'header',
      title: inPane ? 'Comandos' : host.name,
      subtitle: inPane ? host.name : `${hosts.address(host)}${live ? ' · conectado' : ''}`,
      avatar: inPane ? undefined : { svg: distro.look(host).svg },
      status: !inPane && live ? 'green' : undefined,
      actions: [
        { action: `cmd-novo:${enc(scope)}`, icon: 'add', tooltip: 'fixar um comando novo' },
        { action: `cmd-ler:${enc(scope)}`, icon: 'refresh', tooltip: 'reler o histórico do servidor' },
        inPane
          ? { action: `cmd-lado:${enc(scope)}`, icon: 'close', tooltip: 'esconder os comandos' }
          : { action: `cmd-host:${enc(scope)}`, icon: 'server', tooltip: 'trocar de host' },
      ],
    },
    { type: 'input', id: 'cmd-busca', icon: 'search', placeholder: 'buscar (enter)', value: ctx.filter, submit: `cmd-buscar:${enc(scope)}` },
    {
      type: 'tabs',
      items: [
        { label: 'recentes', action: `cmd-ordem:${ref('recentes')}`, active: ctx.order === 'recentes' },
        { label: 'frequentes', action: `cmd-ordem:${ref('frequentes')}`, active: ctx.order === 'frequentes' },
      ],
    },
    {
      type: 'list',
      flat: true,
      empty: ctx.filter ? 'nada com essa busca' : 'nenhum comando ainda — os do servidor aparecem depois de conectar, e o + fixa um seu',
      items: shown.map((e, n) => ({
        title: e.cmd,
        icon: e.pinned ? 'star' : 'terminal',
        tone: e.pinned ? 'yellow' : 'faint',
        meta: e.count > 1 ? `${e.count}×` : undefined,
        action: `cmd-enviar:${ref(n)}`,
        actions: [
          { action: `cmd-rodar:${ref(n)}`, icon: 'play', tooltip: 'mandar e rodar (enter)' },
          { action: `cmd-fixar:${ref(n)}`, icon: 'star', tooltip: e.pinned ? 'desafixar' : 'fixar no topo' },
        ],
        menu: [
          { action: `cmd-enviar:${ref(n)}`, label: 'mandar pro terminal', icon: 'terminal' },
          { action: `cmd-rodar:${ref(n)}`, label: 'mandar e rodar', icon: 'play' },
          { action: `cmd-copiar:${ref(n)}`, label: 'copiar', icon: 'copy' },
          { action: `cmd-fixar:${ref(n)}`, label: e.pinned ? 'desafixar' : 'fixar no topo', icon: 'star' },
          { type: 'divider' },
          { action: `cmd-tirar:${ref(n)}`, label: 'tirar da lista', icon: 'remove', tone: 'red' },
        ],
      })),
    },
    all.length > SHOW ? { type: 'text', style: 'faint', text: `mostrando ${SHOW} de ${all.length} — a busca acha o resto` } : null,
    { type: 'text', style: data.error ? 'warning' : 'faint', text: status },
  ].filter(Boolean);
}

/**
 * Os comandos de um host: na coluna da conexão aberta com ele, se há uma (e
 * ela volta a aparecer se estava escondida); senão, no painel avulso.
 */
async function openCommands(alias) {
  const con = [...state.cons.entries()].reverse().find(([scope, c]) => c.alias === alias && !state.dead.has(c.tabId));
  if (con) {
    con[1].side = true;
    return showCon(con[0]);
  }
  state.cmd.alias = alias;
  state.cmd.filter = '';
  await mx.request('view.open', { viewId: COMMANDS, title: `comandos · ${alias}`, blocks: commandBlocks(PANEL) });
  state.cmd.open = true;
  if (!state.split) follow();
}

async function paintScope(scope) {
  if (scope === PANEL) {
    if (!state.cmd.open) return;
    const { open } = await mx.request('view.update', { viewId: COMMANDS, title: `comandos · ${state.cmd.alias}`, blocks: commandBlocks(PANEL) });
    if (!open) closeCommands();
    return;
  }
  if (!state.cons.has(scope)) return;
  const { open } = await mx.request('view.update', { viewId: scope, blocks: conBlocks(scope) });
  if (!open) dropCon(scope);
}

function dropCon(scope) {
  state.cons.delete(scope);
  state.shown.delete(scope);
}

function closeCommands() {
  state.cmd.open = false;
  clearInterval(state.cmd.timer);
  state.cmd.timer = null;
}

/**
 * Numa Maestria sem o painel de conexão, o painel avulso acompanha o terminal
 * em foco: focou a conexão de outro host, ele passa a ser dele.
 */
function follow() {
  if (state.cmd.timer) return;
  state.cmd.ticks = 0;
  state.cmd.timer = setInterval(async () => {
    try {
      // De tempos em tempos pergunta se o painel ainda está aberto: fechado no x,
      // a janela só conta no próximo view.update, e o relógio pararia de vez.
      state.cmd.ticks += 1;
      if (state.cmd.ticks % 20 === 0) {
        const { open } = await mx.request('view.update', { viewId: COMMANDS });
        if (!open) return closeCommands();
      }
      const s = await mx.request('sessions.focused');
      if (!s || !s.id) return;
      const tag = state.opened.get(s.id) || (s.owner === PLUGIN_ID && s.tag && (state.retag.get(s.id) || normalizeKey(s.tag)));
      const host = tag && hostByKey(tag);
      if (host && host.alias !== state.cmd.alias) {
        state.cmd.alias = host.alias;
        state.cmd.filter = '';
        await paintScope(PANEL);
      }
    } catch (e) {
      mx.log('painel de comandos:', e.message);
    }
  }, FOLLOW_MS);
}

/** As ações dos comandos: `<verbo>:<de quem>` ou `<verbo>:<de quem>|<linha ou valor>`. */
async function commandAction(verb, arg, values) {
  const bar = arg.indexOf('|');
  const scope = decodeURIComponent(bar >= 0 ? arg.slice(0, bar) : arg) || PANEL;
  const rest = bar >= 0 ? arg.slice(bar + 1) : '';
  const ctx = ctxOf(scope);
  if (!ctx) return;
  const alias = ctx.alias;
  const entry = () => (state.shown.get(scope) || [])[Number(rest)];
  if (values && typeof values['cmd-busca'] === 'string') ctx.filter = values['cmd-busca'];
  switch (verb) {
    case 'cmd-enviar':
    case 'cmd-rodar': {
      const e = entry();
      if (e) await sendCommand(scope, e.cmd, verb === 'cmd-rodar');
      return;
    }
    case 'cmd-copiar': {
      const e = entry();
      if (e) await mx.request('clipboard.write', { text: e.cmd });
      return;
    }
    case 'cmd-fixar':
    case 'cmd-tirar': {
      const e = entry();
      if (!e) return;
      const data = history.load(state.dataDir, alias);
      history.save(state.dataDir, alias, verb === 'cmd-fixar' ? history.togglePin(data, e.cmd) : history.forget(data, e.cmd));
      // Fixar e tirar valem pro host: todos os painéis dele mudam.
      return repaintAlias(alias);
    }
    case 'cmd-novo': {
      const cmd = await askText(`fixar um comando em ${alias}`, 'sudo systemctl status nginx');
      if (!cmd) return;
      const data = history.load(state.dataDir, alias);
      if (!data.pinned.includes(cmd)) history.save(state.dataDir, alias, history.togglePin(data, cmd));
      return repaintAlias(alias);
    }
    case 'cmd-ler':
      fetchHistory(alias, { force: true });
      return;
    case 'cmd-ordem':
      ctx.order = rest === 'frequentes' ? 'frequentes' : 'recentes';
      break;
    case 'cmd-lado':
      ctx.side = !ctx.side;
      break;
    case 'cmd-host': {
      const choice = await pickHost('comandos de qual host?');
      if (!choice) return;
      state.cmd.alias = choice.alias;
      state.cmd.filter = '';
      break;
    }
    case 'cmd-buscar':
      break;
    default:
      mx.log('ação desconhecida nos comandos:', verb);
      return;
  }
  await paintScope(scope);
}

async function repaintAlias(alias) {
  if (state.cmd.open && state.cmd.alias === alias) await paintScope(PANEL);
  for (const [scope, c] of state.cons) if (c.alias === alias) await paintScope(scope);
}

// --- a grade (rfw) e a janela em blocos ---------------------------------------------

/** A cor do quadrado de um cartão sem ícone de sistema: a mesma pra um nome, sempre. */
function toneOf(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return TONES[h % TONES.length];
}

/** Um menu no formato dos blocos, no formato do `Pressable`. */
function rfwMenu(menu) {
  return menu.map((m) =>
    m.type === 'divider' ? { divider: true } : { label: m.label, icon: m.icon || '', action: m.action, red: m.tone === 'red' },
  );
}

/** O menu de um host, igual no cartão e na aba. */
function hostMenu(h) {
  return [
    { action: `comandos:${h.alias}`, label: 'comandos…', icon: 'terminal' },
    { action: `editar:${h.alias}`, label: h.editable ? 'editar…' : 'abrir no config…', icon: 'edit' },
    { action: `mover:${h.alias}`, label: 'mover pro grupo…', icon: 'folder' },
    h.editable ? { action: `duplicar-host:${h.alias}`, label: 'duplicar', icon: 'copy' } : null,
    { action: `copiar:${h.alias}`, label: 'copiar o comando', icon: 'copy' },
    h.editable ? { type: 'divider' } : null,
    h.editable ? { action: `apagar:${h.alias}`, label: 'apagar', icon: 'remove', tone: 'red' } : null,
  ].filter(Boolean);
}

/** A segunda linha do cartão: o endereço e o sistema, como o "ssh, ubuntu" do Termius. */
function subOf(h) {
  const { label } = distro.look(h);
  return label ? `${hosts.address(h)} · ${label}` : hosts.address(h);
}

function hostTile(h, terms) {
  const item = sidebarItem(h, terms);
  const status = item.tone === 'green' || item.tone === 'red' ? item.tone : '';
  const sub = subOf(h);
  const when = !status && item.badge ? ` · ${item.badge}` : '';
  const look = distro.look(h);
  return {
    title: h.name,
    sub: status ? `${item.badge} · ${sub}` : `${sub}${when}`,
    icon: look.icon,
    svg: look.svg,
    tone: toneOf(h.name),
    status,
    action: item.action,
    menu: rfwMenu(item.menu),
    edit: `editar:${h.alias}`,
  };
}

/** O menu de um grupo: no cartão (com o abrir) e no "…" da trilha. */
function groupMenu(g, withOpen) {
  return rfwMenu(
    [
      withOpen ? { action: `grupo:${g}`, label: 'abrir', icon: 'open' } : null,
      { action: `novo-no-grupo:${g}`, label: 'novo host neste grupo', icon: 'add' },
      { action: `renomear:${g}`, label: 'renomear…', icon: 'edit' },
      { type: 'divider' },
      { action: `apagar-grupo:${g}`, label: 'apagar o grupo', icon: 'remove', tone: 'red' },
    ].filter(Boolean),
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const connected = (n) => (n ? ` · ${n} conectado${n > 1 ? 's' : ''}` : '');

/** Os dados da grade: o topo, a trilha e as seções de cartões. */
function gridData() {
  const terms = byHost();
  const live = (list) => list.filter((h) => terms.get(keyOf(h))?.live.length).length;
  if (state.group && !state.groups.includes(state.group)) state.group = '';
  const g = state.group;
  const sections = [];
  if (g) {
    const list = state.list.filter((h) => h.group === g);
    sections.push({
      title: 'Hosts',
      count: String(list.length),
      empty: list.length ? '' : 'vazio — “novo host” cria um aqui, ou mova um host pra cá pelo botão direito nele',
      items: list.map((h) => hostTile(h, terms)),
    });
  } else {
    if (state.groups.length) {
      sections.push({
        title: 'Grupos',
        count: String(state.groups.length),
        empty: '',
        items: state.groups.map((name) => {
          const list = state.list.filter((h) => h.group === name);
          const on = live(list);
          return {
            title: name,
            sub: list.length ? plural(list.length, 'host', 'hosts') + connected(on) : 'vazio',
            icon: 'folder',
            tone: toneOf(name),
            svg: '',
            status: on ? 'green' : '',
            action: `grupo:${name}`,
            menu: groupMenu(name, true),
            edit: '',
          };
        }),
      });
    }
    const loose = state.list.filter((h) => !h.group);
    if (loose.length || !state.list.length) {
      sections.push({
        title: 'Hosts',
        count: String(loose.length),
        empty: loose.length ? '' : 'nenhum host no ~/.ssh/config ainda — comece por “novo host”',
        items: loose.map((h) => hostTile(h, terms)),
      });
    }
  }
  const inGroup = g ? state.list.filter((h) => h.group === g) : state.list;
  return {
    head: {
      title: g || 'Hosts',
      sub: plural(inGroup.length, 'host', 'hosts') + connected(g ? live(inGroup) : state.live.size),
      newHost: g ? `novo-no-grupo:${g}` : 'novo',
    },
    crumb: { group: g, menu: g ? groupMenu(g, false) : [] },
    sections,
    hint: HINT,
  };
}

/** A janela em blocos, pra uma Maestria sem widgets: a mesma lista da aba. */
function blocks() {
  return [
    {
      type: 'row',
      children: [
        { type: 'button', action: 'novo', label: 'novo host', style: 'primary', icon: 'add' },
        { type: 'button', action: 'novo-grupo', label: 'novo grupo', icon: 'folder' },
      ],
    },
    ...hostListBlocks(false),
    { type: 'text', style: 'faint', text: HINT },
  ];
}

async function open() {
  reload();
  await syncSessions();
  scanSystems().catch((err) => mx.log('varredura:', String(err.stack || err)));
  const params = { viewId: VIEW, title: 'SSH' };
  if (state.rfw) {
    params.rfw = { library: RFW_LIBRARY, root: 'root' };
    params.data = gridData();
  } else params.blocks = blocks();
  await mx.request('view.open', params);
  state.viewOpen = true;
}

async function refresh() {
  const params = { viewId: VIEW };
  if (state.rfw) params.data = gridData();
  else params.blocks = blocks();
  const { open } = await mx.request('view.update', params);
  state.viewOpen = open;
}

// --- o formulário de um host -------------------------------------------------------

/** O que o formulário mostra: o host de `alias` (ou o modelo de um novo). */
function formValues(alias, group = '', copyOf = '') {
  const h = byAlias(alias || copyOf);
  if (!h) return { label: '', alias: '', hostname: '', user: '', port: '', identityFile: '', extra: '', group, icon: '', cli: '', newGroup: '' };
  return {
    label: copyOf ? `${h.name} (cópia)` : h.label || '',
    alias: copyOf ? `${h.alias}-copia` : h.alias,
    hostname: h.hostname,
    user: h.user,
    port: h.port,
    identityFile: h.identityFile,
    extra: h.extra.join('; '),
    group: h.group || '',
    icon: h.icon || '',
    cli: h.cli || '',
    newGroup: '',
  };
}

function hostFields(v, alias) {
  const h = alias && byAlias(alias);
  return [
    { id: 'label', label: 'nome', placeholder: 'Ceph S1, produção, raspberry…', value: v.label, half: true },
    { id: 'alias', label: 'alias no ~/.ssh/config', placeholder: 'vazio: o nome sem espaço', value: v.alias, half: true },
    { id: 'hostname', label: 'endereço (HostName)', placeholder: 'exemplo.com ou 10.0.0.12', value: v.hostname },
    { id: 'user', label: 'usuário', placeholder: 'ubuntu', value: v.user, half: true },
    { id: 'port', label: 'porta', placeholder: '22', value: v.port, half: true },
    { id: 'identityFile', label: 'chave privada (IdentityFile)', placeholder: '~/.ssh/id_ed25519 (vazio: a do ssh-agent)', value: v.identityFile },
    { id: 'extra', label: 'outras diretivas', placeholder: 'ProxyJump bastion; ForwardAgent yes', value: v.extra },
    v.cli ? { id: 'cli', label: 'opções na linha de comando (de antes do config)', value: v.cli } : null,
    {
      id: 'group',
      type: 'select',
      label: 'grupo',
      value: v.group,
      half: true,
      options: [
        { value: '', label: 'sem grupo' },
        ...state.groups.map((g) => ({ value: g, label: g })),
        { value: NEW_GROUP, label: 'novo grupo…' },
      ],
    },
    { id: 'icon', type: 'select', label: 'ícone', value: v.icon, half: true, options: distro.options(h && h.os) },
    {
      id: 'newGroup',
      label: 'nome do novo grupo',
      placeholder: 'CEPH, DB, monitoramento…',
      value: v.newGroup,
      required: true,
      showIf: { field: 'group', value: NEW_GROUP },
    },
  ].filter(Boolean);
}

/**
 * Grava o que veio do formulário: o bloco no config e o meta. Devolve o host
 * salvo ou `{ error }`.
 */
function saveHost(alias, values) {
  const prev = alias ? byAlias(alias) : null;
  const typed = { ...values };
  if (typed.group === NEW_GROUP) {
    typed.group = String(typed.newGroup || '').trim();
    if (!typed.group) return { error: 'falta o nome do novo grupo' };
  }
  const result = hosts.normalize(typed);
  if (result.error) return result;
  const { host, meta } = result;
  // As diretivas como estavam, se o campo não mudou: um `;` dentro de um
  // ProxyCommand não vira duas.
  if (prev && String(typed.extra || '').trim() === prev.extra.join('; ')) host.extra = prev.extra;
  if (host.alias !== alias && byAlias(host.alias)) return { error: `já existe um host ${host.alias} no config` };
  try {
    sshconfig.upsert(prev ? prev.alias : null, host, prev ? prev.source : sshconfig.MAIN);
  } catch (e) {
    return { error: `não gravei o ~/.ssh/config: ${e.message}` };
  }
  const old = prev ? state.meta[prev.alias] || {} : {};
  if (prev && prev.alias !== host.alias) {
    delete state.meta[prev.alias];
    history.rename(state.dataDir, prev.alias, host.alias);
    for (const [tabId, key] of state.opened) {
      if (key !== keyOf(prev)) continue;
      state.retag.set(tabId, keyOf(host));
      state.opened.set(tabId, keyOf(host));
    }
    saveRetag();
    for (const c of state.cons.values()) if (c.alias === prev.alias) c.alias = host.alias;
    if (state.cmd.alias === prev.alias) state.cmd.alias = host.alias;
  }
  state.meta[host.alias] = { ...old, ...meta };
  if (meta.group) state.groups = state.groups.concat(meta.group);
  persistMeta();
  return { host: byAlias(host.alias) };
}

function openForm(alias, group = '', copyOf = '') {
  const h = alias && byAlias(alias);
  if (h && !h.editable) return openInConfig(h);
  if (state.modal) {
    hostModal(alias, formValues(alias, group, copyOf)).catch((e) => mx.log('formulário:', String(e.stack || e)));
    return;
  }
  state.gen += 1;
  state.editorRaise = true;
  state.form = { alias: alias || null, values: formValues(alias, group, copyOf), gen: state.gen };
}

/**
 * O formulário num modal (`window.form`). Um erro (porta fora da faixa, alias
 * repetido) reabre o modal com o que foi digitado e o erro embaixo.
 */
async function hostModal(alias, values) {
  const prev = alias ? byAlias(alias) : null;
  let error = '';
  for (;;) {
    const answer = await mx.request('window.form', {
      title: prev ? `editar ${prev.name}` : 'novo host',
      fields: hostFields(values, alias),
      buttons: [
        prev ? { action: 'apagar', label: 'apagar', style: 'danger' } : null,
        prev ? { action: 'duplicar', label: 'duplicar' } : null,
        { action: 'conectar', label: 'salvar e conectar' },
        { action: 'salvar', label: 'salvar', style: 'primary' },
      ].filter(Boolean),
      error,
    });
    if (!answer) return;
    if (answer.action === 'apagar') return windowAction(`apagar:${prev.alias}`, {});
    if (answer.action === 'duplicar') return windowAction(`duplicar-host:${prev.alias}`, {});
    values = { ...values, ...(answer.values || {}) };
    const saved = saveHost(alias, values);
    if (saved.error) {
      error = saved.error;
      continue;
    }
    await repaint();
    if (answer.action === 'conectar' && saved.host) await connect(saved.host);
    return;
  }
}

/** Um bloco com mais de um nome (`Host a b`) se edita no próprio arquivo. */
async function openInConfig(h) {
  try {
    await mx.request('editor.open', { path: h.source, line: h.line });
  } catch {
    await mx.request('window.showBanner', { text: `${h.alias} divide o bloco com outros nomes: edite em ${h.source}, linha ${h.line}` });
  }
}

/** O formulário numa janela ao lado, pra uma Maestria sem `window.form`. */
function editorView() {
  if (!state.form) return null;
  const f = state.form;
  const fields = hostFields(f.values, f.alias).filter((x) => !x.showIf || f.values[x.showIf.field] === x.showIf.value);
  return {
    title: f.alias ? `editar ${f.alias}` : 'novo host',
    blocks: [
      ...fields.map((x) =>
        x.type === 'select'
          ? { type: 'select', id: `f${f.gen}.${x.id}`, label: x.label, value: x.value, options: x.options, action: 'form-mudou' }
          : { type: 'input', id: `f${f.gen}.${x.id}`, label: x.label, placeholder: x.placeholder, value: x.value || '', submit: 'salvar' },
      ),
      f.error ? { type: 'text', style: 'error', text: f.error } : null,
      {
        type: 'row',
        children: [
          { type: 'button', action: 'salvar', label: 'salvar', style: 'primary', icon: 'check' },
          { type: 'button', action: 'salvar-conectar', label: 'salvar e conectar', icon: 'terminal' },
          { type: 'button', action: 'cancelar', label: 'cancelar' },
          f.alias ? { type: 'button', action: `apagar:${f.alias}`, label: 'apagar', style: 'danger' } : null,
        ].filter(Boolean),
      },
    ].filter(Boolean),
  };
}

/** O que foi digitado na janela do formulário, sem o prefixo do `gen`. */
function typedValues(values) {
  const prefix = `f${state.gen}.`;
  const out = {};
  for (const [k, v] of Object.entries(values || {})) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

async function syncEditor() {
  const want = editorView();
  try {
    if (!want) {
      if (state.editorOpen) await mx.request('view.close', { viewId: EDITOR });
      state.editorOpen = false;
      return;
    }
    if (state.editorRaise || !state.editorOpen) {
      if (!state.viewOpen && state.rfw) await open();
      await mx.request('view.open', { viewId: EDITOR, ...want });
      state.editorOpen = true;
      state.editorRaise = false;
      return;
    }
    const { open: still } = await mx.request('view.update', { viewId: EDITOR, ...want });
    if (!still) {
      state.editorOpen = false;
      state.form = null;
    }
  } catch (e) {
    mx.log('formulário:', e.message);
  }
}

// --- grupos --------------------------------------------------------------------

/** Um texto curto: o campo rápido, senão o modal, senão avisa que esta Maestria não pergunta. */
async function askText(title, placeholder, value = '') {
  if (state.input) return mx.request('window.input', { title, placeholder, value });
  if (state.modal) {
    const answer = await mx.request('window.form', { title, fields: [{ id: 'text', label: title, placeholder, value, required: true }] });
    return answer && answer.values && String(answer.values.text || '').trim();
  }
  await mx.request('window.showBanner', { text: 'esta Maestria não tem campo de texto: atualize o app pra isso' });
  return null;
}

const askName = (title, value = '') => askText(title, 'CEPH, DB, monitoramento…', value);

async function newGroup(alias) {
  const name = String((await askName('novo grupo')) || '').trim();
  if (!name) return;
  state.groups = state.groups.concat(name);
  if (alias) metaOf(alias).group = name;
  persistMeta();
}

async function renameGroup(g) {
  const name = String((await askName(`renomear o grupo ${g}`, g)) || '').trim();
  if (!name || name === g) return;
  // Um nome que já existe junta os dois grupos.
  for (const m of Object.values(state.meta)) if (m.group === g) m.group = name;
  if (state.group === g) state.group = name;
  state.groups = state.groups.filter((x) => x !== g).concat(name);
  if (state.collapsed.has(sectionKey(g))) {
    state.collapsed.delete(sectionKey(g));
    setCollapsed(sectionKey(name), true);
  }
  hosts.saveGroups(state.dataDir, state.groups);
  persistMeta();
}

/** "mover pro grupo…": os outros grupos, sem grupo e um novo. */
async function moveHost(h) {
  const items = [
    ...state.groups.filter((g) => g !== h.group).map((g) => ({ value: `g:${g}`, label: g })),
    h.group ? { value: 'g:', label: 'sem grupo' } : null,
    { value: 'novo', label: 'novo grupo…', detail: 'cria o grupo e põe o host nele' },
  ].filter(Boolean);
  const choice = await mx.request('window.pick', { title: `mover ${h.name} pro grupo`, placeholder: 'grupo', items });
  if (!choice) return;
  if (choice === 'novo') return newGroup(h.alias);
  metaOf(h.alias).group = choice.slice(2);
  persistMeta();
}

async function deleteGroup(g) {
  const n = state.list.filter((h) => h.group === g).length;
  if (n) {
    const sure = await mx.request('window.pick', {
      title: `apagar o grupo ${g}?`,
      items: [
        { value: 'nao', label: 'não, deixa' },
        { value: 'sim', label: `sim, apagar ${g}`, detail: `${n === 1 ? 'o host fica' : `os ${n} hosts ficam`} sem grupo — nenhum é apagado` },
      ],
    });
    if (sure !== 'sim') return;
  }
  for (const m of Object.values(state.meta)) if (m.group === g) m.group = '';
  state.groups = state.groups.filter((x) => x !== g);
  hosts.saveGroups(state.dataDir, state.groups);
  setCollapsed(sectionKey(g), false);
  persistMeta();
}

// --- as ações ---------------------------------------------------------------------

/**
 * As ações iguais na janela, nos cartões e na aba. Devolve true quando a ação
 * era uma delas (e já redesenhou o que precisava).
 */
async function sharedAction(verb, arg) {
  const h = byAlias(arg);
  switch (verb) {
    case 'novo-grupo':
      await newGroup();
      break;
    case 'renomear':
      if (state.groups.includes(arg)) await renameGroup(arg);
      break;
    case 'recolher':
      setCollapsed(arg, !state.collapsed.has(arg));
      break;
    case 'apagar-grupo':
      await deleteGroup(arg);
      break;
    case 'mover':
      if (h) await moveHost(h);
      break;
    case 'novo-no-grupo':
      openForm(null, arg);
      if (!state.modal && !state.viewOpen) await open();
      break;
    case 'novo':
      openForm(null);
      if (!state.modal && !state.viewOpen) await open();
      break;
    case 'editar':
      if (h) openForm(arg);
      break;
    case 'duplicar-host':
      if (h) openForm(null, h.group || '', arg);
      break;
    case 'comandos':
      if (h) await openCommands(arg);
      return true;
    case 'apagar': {
      if (!h || !h.editable) break;
      const sure = await mx.request('window.pick', {
        title: `apagar ${h.name}?`,
        items: [
          { value: 'nao', label: 'não, deixa' },
          { value: 'sim', label: `sim, apagar ${h.name}`, detail: `tira o bloco Host ${h.alias} de ${h.source.replace(hosts.HOME, '~')}` },
        ],
      });
      if (sure !== 'sim') break;
      try {
        sshconfig.remove(h.alias, h.source);
      } catch (e) {
        await mx.request('window.showBanner', { text: `não gravei o config: ${e.message}`, sticky: true });
        break;
      }
      delete state.meta[h.alias];
      history.drop(state.dataDir, h.alias);
      state.form = null;
      persistMeta();
      break;
    }
    default:
      return sessionAction(verb, arg);
  }
  await redraw();
  return true;
}

async function windowAction(action, values) {
  const [verb, arg] = [action.split(':')[0], action.slice(action.indexOf(':') + 1)];
  if (verb.startsWith('cmd-')) return commandAction(verb, arg, values);
  if (await sharedAction(verb, arg)) return;
  switch (verb) {
    case 'grupo':
      state.group = arg;
      break;
    case 'raiz':
      state.group = '';
      break;
    case 'buscar':
      return pickAndConnect();
    case 'atualizar':
      reload();
      await syncSessions();
      break;
    case 'form-mudou':
      if (state.form) state.form.values = { ...state.form.values, ...typedValues(values) };
      break;
    case 'cancelar':
      state.form = null;
      break;
    case 'salvar':
    case 'salvar-conectar': {
      if (!state.form) break;
      state.form.values = { ...state.form.values, ...typedValues(values) };
      const saved = saveHost(state.form.alias, state.form.values);
      if (saved.error) {
        state.form.error = saved.error;
        break;
      }
      state.form = null;
      if (verb === 'salvar-conectar' && saved.host) {
        await redraw();
        return connect(saved.host);
      }
      break;
    }
    default:
      mx.log('ação desconhecida:', action);
  }
  await redraw();
}

// --- a aba da lateral ----------------------------------------------------------

/**
 * Relê as sessões e fica com os terminais do plugin: os de pé em `live`, os
 * que o ssh já deixou em `dead`. Um terminal é nosso pelo `owner`, e o host
 * dele pelo `tag`.
 */
async function syncSessions() {
  let list;
  try {
    list = await mx.request('sessions.list');
  } catch (e) {
    mx.log('sessions.list:', e.message);
    return;
  }
  state.opened = new Map();
  state.live = new Map();
  state.dead = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    if (s.owner !== PLUGIN_ID || !s.tag) continue;
    const key = state.retag.get(s.id) || normalizeKey(s.tag);
    state.opened.set(s.id, key);
    (s.exited ? state.dead : state.live).set(s.id, s);
    // Um plugin reiniciado reencontra os painéis de conexão pelo terminal embutido.
    const host = s.embedded && hostByKey(key);
    if (host && !state.cons.has(conScope(s.id))) state.cons.set(conScope(s.id), newCon(s.id, host.alias));
  }
  for (const [scope, c] of state.cons) if (!state.opened.has(c.tabId)) dropCon(scope);
  // Os terminais que já fecharam não precisam mais do nome novo.
  const before = state.retag.size;
  for (const tabId of [...state.retag.keys()]) if (!state.opened.has(tabId)) state.retag.delete(tabId);
  if (state.retag.size !== before) saveRetag();
}

// O retag vai pro disco: um plugin reiniciado ainda acha o host renomeado pelo terminal dele.
const retagFile = () => path.join(state.dataDir, 'retag.json');

function saveRetag() {
  try {
    fs.mkdirSync(state.dataDir, { recursive: true });
    fs.writeFileSync(retagFile(), JSON.stringify(Object.fromEntries(state.retag)) + '\n');
  } catch (e) {
    mx.log('retag:', e.message);
  }
}

function loadRetag() {
  try {
    state.retag = new Map(Object.entries(JSON.parse(fs.readFileSync(retagFile(), 'utf8'))));
  } catch {
    state.retag = new Map();
  }
}

/** Vai pro terminal: o painel da conexão, quando ele mora num, ou o próprio painel. */
async function focusTab(tabId) {
  if (state.cons.has(conScope(tabId))) return showCon(conScope(tabId));
  await mx.request('session.focus', { tabId });
}

/** Fecha o terminal: o painel da conexão leva o terminal junto. */
async function closeTab(tabId) {
  const scope = conScope(tabId);
  if (!state.cons.has(scope)) return closeTerm(tabId);
  dropCon(scope);
  try {
    await mx.request('view.close', { viewId: scope });
  } catch (e) {
    mx.log('view.close:', e.message);
  }
}

/** Um `s:<id>` de antes do config vira o `c:<alias>` do host migrado. */
function normalizeKey(tag) {
  if (tag.startsWith('s:') && state.migrated[tag.slice(2)]) return `c:${state.migrated[tag.slice(2)]}`;
  return tag;
}

/** chave do host → os tabIds dos terminais dele, de pé e caídos. */
function byHost() {
  const out = new Map();
  for (const [tabId, key] of state.opened) {
    if (!out.has(key)) out.set(key, { live: [], dead: [] });
    if (state.live.has(tabId)) out.get(key).live.push(tabId);
    else if (state.dead.has(tabId)) out.get(key).dead.push(tabId);
  }
  return out;
}

function matches(filter, ...texts) {
  if (!filter) return true;
  return texts.some((t) => t && String(t).toLowerCase().includes(filter));
}

/**
 * Uma linha da aba (e o comportamento de um cartão): sem terminal, clicar
 * conecta. Com terminal de pé, verde, e clicar vai pra ele (e pro próximo, a
 * cada clique). Com o ssh caído, vermelha: clicar mostra o terminal com o motivo.
 */
function sidebarItem(h, terms) {
  const key = keyOf(h);
  const { live = [], dead = [] } = terms.get(key) || {};
  const menu = hostMenu(h);
  const look = distro.look(h);
  const base = { title: h.name, subtitle: hosts.address(h), avatar: { svg: look.svg } };
  if (live.length) {
    const last = live[live.length - 1];
    return {
      ...base,
      tone: 'green',
      status: 'green',
      badge: live.length > 1 ? `${live.length} abertos` : 'conectado',
      action: `ir:${key}`,
      actions: [
        { action: `comandos:${h.alias}`, icon: 'terminal', tooltip: 'comandos deste host' },
        { action: `fechar:${last}`, icon: 'stop', tooltip: 'fechar a conexão', tone: 'red' },
      ],
      menu: [
        { action: `ir:${key}`, label: 'ir pro terminal', icon: 'open' },
        { action: `duplicar:${key}`, label: 'abrir outra conexão', icon: 'add' },
        { action: `fechar:${last}`, label: live.length > 1 ? 'fechar a última conexão' : 'fechar a conexão', icon: 'stop' },
        { type: 'divider' },
        ...menu,
      ],
    };
  }
  if (dead.length) {
    const last = dead[dead.length - 1];
    return {
      ...base,
      tone: 'red',
      status: 'red',
      badge: 'caiu',
      action: `focar:${last}`,
      actions: [
        { action: `reconectar:${last}`, icon: 'restart', tooltip: 'reconectar' },
        { action: `fechar:${last}`, icon: 'stop', tooltip: 'fechar o terminal', tone: 'red' },
      ],
      menu: [
        { action: `reconectar:${last}`, label: 'reconectar', icon: 'restart' },
        { action: `focar:${last}`, label: 'ver o terminal', icon: 'open' },
        { action: `fechar:${last}`, label: 'fechar o terminal', icon: 'stop' },
        { type: 'divider' },
        ...menu,
      ],
    };
  }
  return {
    ...base,
    tone: look.color ? 'accent' : 'faint',
    badge: ago(h.lastUsed),
    action: `conectar:${h.alias}`,
    menu: [{ action: `conectar:${h.alias}`, label: 'conectar', icon: 'play' }, { type: 'divider' }, ...menu],
  };
}

/**
 * Os hosts por grupo, na ordem da tela: os sem grupo primeiro (só quando há
 * algum), e os grupos em ordem alfabética. Com `withEmpty` os grupos sem host
 * entram também, vazios.
 */
function groupHosts(list, withEmpty) {
  const out = new Map();
  if (list.some((h) => !h.group)) out.set('', []);
  for (const g of state.groups) if (withEmpty || list.some((h) => h.group === g)) out.set(g, []);
  for (const h of list) {
    const g = h.group || '';
    if (!out.has(g)) out.set(g, []);
    out.get(g).push(h);
  }
  return out;
}

/** As seções de hosts da aba (e da janela em blocos), um grupo por seção. */
function hostListBlocks(flat) {
  const terms = byHost();
  const filter = state.filter.trim().toLowerCase();
  const list = state.list.filter((h) => matches(filter, h.name, h.alias, h.hostname, h.user, h.group));
  const groups = groupHosts(list, !filter);
  if (!groups.size) groups.set('', []);
  const out = [];
  for (const [g, items] of groups) {
    // Filtrando, tudo aberto: um grupo fechado esconderia o achado.
    const closed = !filter && state.collapsed.has(sectionKey(g));
    out.push(sectionBlock(g || 'hosts', sectionKey(g), items, terms, filter));
    if (closed) continue;
    out.push({
      type: 'list',
      flat,
      empty: filter ? 'nada com esse filtro' : g ? 'vazio — botão direito num host, “mover pro grupo…”' : 'nenhum host — o + cria um',
      items: items.map((h) => sidebarItem(h, terms)),
    });
  }
  return out;
}

function sidebarBlocks() {
  const out = [
    {
      type: 'row',
      children: [
        { type: 'button', action: 'novo', icon: 'add', style: 'icon', tooltip: 'novo host' },
        { type: 'button', action: 'grupos', icon: 'folder', style: 'icon', tooltip: 'grupos: criar, renomear, apagar' },
        { type: 'button', action: 'atualizar', icon: 'refresh', style: 'icon', tooltip: 'reler o ~/.ssh/config' },
        { type: 'button', action: 'janela', icon: 'open', style: 'icon', tooltip: 'abrir a janela de hosts' },
      ],
    },
  ];
  if (state.list.length > FILTER_FROM || state.filter) {
    out.push({ type: 'input', id: 'filtro', icon: 'search', placeholder: 'filtrar (enter)', value: state.filter, submit: 'filtrar' });
  }
  return [...out, ...hostListBlocks(true)];
}

/**
 * A régua de uma seção, com a seta de abrir e fechar. Fechada com um host
 * conectado lá dentro, ela diz quantos -- senão a conexão some da vista.
 */
function sectionBlock(text, key, list, terms, filter) {
  if (filter) return { type: 'section', text, count: list.length };
  const closed = state.collapsed.has(key);
  const live = list.filter((h) => terms.get(keyOf(h))?.live.length).length;
  const count = closed && live ? `${list.length}${connected(live)}` : list.length;
  return { type: 'section', text, count, collapsed: closed, action: `recolher:${key}` };
}

async function pushSidebar() {
  try {
    await mx.request('sidebar.update', { blocks: sidebarBlocks(), badge: '' });
  } catch (e) {
    mx.log('sidebar.update:', e.message);
  }
}

async function sidebarAction(action, values) {
  const [verb, arg] = [action.split(':')[0], action.slice(action.indexOf(':') + 1)];
  if (values && typeof values.filtro === 'string') state.filter = values.filtro;
  switch (verb) {
    case 'janela':
      return open();
    case 'grupos':
      return pickGroup();
    case 'atualizar':
      reload();
      await syncSessions();
      return repaint();
    case 'filtrar':
      return pushSidebar();
    default:
      if (!(await sharedAction(verb, arg))) mx.log('ação desconhecida na aba:', action);
  }
}

/**
 * O que um host faz, igual na aba e nos cartões: conectar, ir pro terminal,
 * abrir outra conexão, reconectar, fechar e copiar o comando.
 */
async function sessionAction(verb, arg) {
  switch (verb) {
    case 'conectar': {
      const h = byAlias(arg) || { alias: arg, name: arg };
      await connect(h);
      return true;
    }
    case 'focar':
      await focusTab(arg);
      return true;
    case 'ir': {
      await syncSessions();
      const live = byHost().get(arg)?.live || [];
      if (!live.length) {
        await repaint();
        return true;
      }
      const at = live.findIndex((id) => state.live.get(id)?.focused);
      await focusTab(live[(at + 1) % live.length]);
      return true;
    }
    case 'duplicar':
    case 'reconectar': {
      const key = verb === 'duplicar' ? arg : state.opened.get(arg);
      const host = key && hostByKey(key);
      if (!host) return true;
      if (verb === 'reconectar') await closeTab(arg);
      await connect(host);
      return true;
    }
    case 'fechar':
      await closeTab(arg);
      await syncSessions();
      await repaint();
      return true;
    case 'copiar': {
      const h = byAlias(arg) || { alias: arg };
      await mx.request('clipboard.write', { text: hosts.commandFor(h, state.settings) });
      await mx.request('window.showBanner', { text: `copiei o comando de ${h.name || h.alias}` });
      return true;
    }
    default:
      return false;
  }
}

/** O botão de pasta da aba: escolhe o grupo, depois o que fazer com ele. */
async function pickGroup() {
  reload();
  const g = await mx.request('window.pick', {
    title: 'grupos',
    placeholder: 'grupo',
    items: [
      { value: 'novo', label: 'novo grupo…' },
      ...state.groups.map((x) => {
        const n = state.list.filter((h) => h.group === x).length;
        return { value: `g:${x}`, label: x, detail: n ? plural(n, 'host', 'hosts') : 'vazio' };
      }),
    ],
  });
  if (!g) return;
  if (g === 'novo') return sharedAction('novo-grupo', '');
  const name = g.slice(2);
  const what = await mx.request('window.pick', {
    title: name,
    items: [
      { value: 'novo-no-grupo', label: 'novo host neste grupo' },
      { value: 'renomear', label: 'renomear…' },
      { value: 'apagar-grupo', label: 'apagar o grupo', detail: 'os hosts dele ficam sem grupo' },
    ],
  });
  if (what) await sharedAction(what, name);
}

/** O host de uma chave do mapa (`c:<alias>`). */
function hostByKey(key) {
  const k = normalizeKey(key);
  if (!k.startsWith('c:')) return undefined;
  const alias = k.slice(2);
  return byAlias(alias) || { alias, name: alias };
}

async function closeTerm(tabId) {
  try {
    await mx.request('session.close', { tabId });
  } catch (e) {
    mx.log('session.close:', e.message);
  }
}

/** O seletor de host: os mais recentes primeiro. */
async function pickHost(title) {
  reload();
  if (!state.list.length) return null;
  const recent = [...state.list].sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
  const choice = await mx.request('window.pick', {
    title,
    placeholder: 'nome, alias ou endereço',
    items: recent.map((h) => ({ value: h.alias, label: h.group ? `${h.name} · ${h.group}` : h.name, detail: hosts.address(h) })),
  });
  return choice ? byAlias(choice) : null;
}

/** O seletor rápido: digita um pedaço do nome ou do endereço, enter, conectado. */
async function pickAndConnect() {
  const h = await pickHost('conectar por ssh');
  if (h) await connect(h);
  else if (!state.list.length) {
    await open();
    await mx.request('window.showBanner', { text: 'nenhum host ainda — crie um aqui' });
  }
}

mx.onNotification('view.action', async ({ viewId, action, values = {} }) => {
  // Na grade em widgets, o clique manda a ação em `a`, e o menu em `action`.
  if (viewId === VIEW && action === 'act') return windowAction(values.a || values.action, values);
  // Um plugin reiniciado só conhece os painéis de conexão depois de reler as sessões.
  if (viewId.startsWith('con:') && !state.cons.has(viewId)) await syncSessions();
  if (viewId === VIEW || viewId === EDITOR || viewId === COMMANDS || state.cons.has(viewId)) return windowAction(action, values);
  if (viewId === SIDEBAR) return sidebarAction(action, values);
});

/** O ssh de um host saiu: o shell de lá acabou de gravar o histórico. */
function afterExit(tabId) {
  const host = state.opened.has(tabId) && hostByKey(state.opened.get(tabId));
  if (host) setTimeout(() => fetchHistory(host.alias), 1000);
}

mx.onNotification('event', async (e) => {
  switch (e.type) {
    case 'view.closed':
      if (e.viewId === COMMANDS) closeCommands();
      if (state.cons.has(e.viewId)) dropCon(e.viewId);
      return;
    case 'sidebar.shown':
      reload();
      await syncSessions();
      scanSystems().catch((err) => mx.log('varredura:', String(err.stack || err)));
      return pushSidebar();
    case 'session.closed':
      if (!state.opened.has(e.tabId)) return;
      if (!state.dead.has(e.tabId)) afterExit(e.tabId);
      state.opened.delete(e.tabId);
      state.live.delete(e.tabId);
      state.dead.delete(e.tabId);
      return repaint();
    case 'session.exited':
      if (!state.opened.has(e.tabId)) return;
      afterExit(e.tabId);
      await syncSessions();
      return repaint();
    case 'session.status':
      if (!state.opened.has(e.tabId)) return;
      await syncSessions();
      return repaint();
    default:
  }
});

mx.onRequest('initialize', (params) => {
  state.dataDir = params.dataDir || state.dataDir;
  state.settings = params.settings || {};
  state.rfw = Number(params.rfw) >= 1;
  state.input = Number(params.input) >= 1;
  state.modal = Number(params.form) >= 1;
  state.split = Number(params.split) >= 1;
  state.onSessions = Number(params.viewOnSessions) >= 1;
  sshconfig.setBackupDir(path.join(state.dataDir, 'config-backups'));
  loadRetag();
  try {
    state.migrated = hosts.migrate(state.dataDir);
  } catch (e) {
    mx.log('não passei os hosts salvos pro ~/.ssh/config:', String(e.stack || e));
  }
  reload();
  return {};
});

mx.onNotification('settings.changed', async ({ settings }) => {
  state.settings = settings || {};
  await repaint();
});

mx.onRequest('command.invoke', async ({ command }) => {
  if (command === 'hosts') await open();
  // Sem await: o seletor espera você, e o command.invoke tem 30s pra voltar.
  else if (command === 'conectar') pickAndConnect().catch((e) => mx.log('conectar:', String(e.stack || e)));
  else if (command === 'comandos') {
    pickHost('comandos de qual host?')
      .then((h) => h && openCommands(h.alias))
      .catch((e) => mx.log('comandos:', String(e.stack || e)));
  } else throw new Error(`comando desconhecido: ${command}`);
  return null;
});

mx.start();
