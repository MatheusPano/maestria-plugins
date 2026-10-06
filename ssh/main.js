// SSH: os hosts salvos numa janela, como no Termius. Clicou num host, abre um
// terminal da Maestria já rodando o ssh pra ele. Os do ~/.ssh/config aparecem
// embaixo, só pra conectar — quem os edita é o próprio arquivo.
//
// A aba do plugin na lateral é a mesma lista, enxuta: clicou, conectou. Ela
// marca os hosts com terminal aberto, e o número deles vira o selo do ícone.
//
// Numa Maestria que desenha widgets (`rfw`), a janela é o cofre do Termius: os
// grupos e os hosts em cartões, numa grade (`ui/hosts.rfwtxt`). O formulário de
// um host e a pergunta do nome de um grupo moram numa janela à parte, ao lado
// -- a gaveta de edição do Termius --, porque os widgets não têm campo de texto.

'use strict';

const fs = require('fs');
const path = require('path');
const mx = require('./maestria');
const hosts = require('./hosts');

const VIEW = 'hosts';
const EDITOR = 'editor';
const RFW_LIBRARY = fs.readFileSync(path.join(__dirname, 'ui', 'hosts.rfwtxt'), 'utf8');
const HINT = 'a senha, quando o servidor pede, você digita no terminal — o plugin não guarda senha. Pra não digitar, use uma chave.';
// As cores dos quadrados dos cartões. Sem o verde e o vermelho, que são de
// conectado e de caído.
const TONES = ['blue', 'cyan', 'purple', 'magenta', 'yellow', 'accent'];
const PLUGIN_ID = process.env.MAESTRIA_PLUGIN_ID || 'maestria.ssh';
const SIDEBAR = 'sidebar';
// Com mais hosts que isso a aba ganha um campo pra filtrar.
const FILTER_FROM = 8;
// O valor do "novo grupo…" no seletor do formulário.
const NEW_GROUP = '::novo';

const state = {
  dataDir: process.env.MAESTRIA_PLUGIN_DATA || '',
  settings: {},
  saved: [],
  groups: [], // os nomes dos grupos, com ou sem host, em ordem alfabética
  // As seções fechadas: `grupo:<nome>`, `salvos` (os sem grupo) e `config`.
  // Valem pra aba e pra janela, e ficam no disco.
  collapsed: new Set(),
  viewOpen: false,
  // Se a janela é a grade em widgets (o `rfw` do initialize).
  rfw: false,
  // Se a Maestria tem o campo de texto rápido (`window.input`): com ele, o nome
  // de um grupo se pergunta ali, sem abrir janela nem campo na aba.
  input: false,
  // Se a Maestria tem o formulário em modal (`window.form`): com ele, o host
  // novo e o editar abrem num modal do tamanho dos campos, e não numa janela.
  modal: false,
  // O grupo aberto na grade ('' é a raiz: os grupos e os hosts sem grupo).
  group: '',
  // A janela do formulário e da pergunta (`EDITOR`): se está aberta, e se a
  // próxima pintura deve trazê-la pra frente (um formulário ou uma pergunta
  // acabou de ser pedido) em vez de só atualizar.
  editorOpen: false,
  editorRaise: false,
  editing: false, // o lápis ligado: clicar num host abre o formulário em vez de conectar
  // O formulário aberto: { id?, gen, error? }. `gen` entra no id dos campos —
  // a janela guarda o que foi digitado por id, então um formulário novo
  // precisa de ids novos pra nascer vazio.
  form: null,
  gen: 0,
  // A pergunta aberta, um campo de texto só: { kind: 'novo-grupo' | 'renomear',
  // group?, hostId?, where: 'window' | 'sidebar', gen, error? }. Mora onde foi
  // feita -- a aba ou a janela.
  ask: null,
  // Os terminais do plugin: tabId → a chave do host (`s:<id>` pra um salvo,
  // `c:<alias>` pra um do config). A chave vai como `tag` no openShell, então
  // o mapa se refaz pelo sessions.list mesmo depois de um "reiniciar".
  opened: new Map(),
  // O que o sessions.list disse por último: tabId → sessão, só as de pé.
  live: new Map(),
  // Os terminais cujo ssh saiu (caiu, recusou, você deu exit): tabId → sessão.
  // Ficam na aba em vermelho até você reconectar ou fechar -- o motivo está
  // escrito lá dentro.
  dead: new Map(),
  filter: '',
};

const setting = (id, fallback) => (id in state.settings ? state.settings[id] : fallback);

function persist() {
  hosts.save(state.dataDir, state.saved);
  // Um grupo digitado no formulário de um host passa a existir também sozinho.
  hosts.saveGroups(state.dataDir, [...state.groups, ...state.saved.map((h) => h.group)]);
  state.groups = hosts.loadGroups(state.dataDir, state.saved);
}

/** Relê os hosts e os grupos do disco. */
function reload() {
  state.saved = hosts.load(state.dataDir);
  state.groups = hosts.loadGroups(state.dataDir, state.saved);
  state.collapsed = hosts.loadCollapsed(state.dataDir);
}

/** A chave de uma seção em `collapsed`: '' é a dos hosts sem grupo. */
const sectionKey = (group) => (group ? `grupo:${group}` : 'salvos');

function setCollapsed(key, on) {
  if (on) state.collapsed.add(key);
  else state.collapsed.delete(key);
  hosts.saveCollapsed(state.dataDir, state.collapsed);
}

/** Redesenha a janela de hosts (se aberta) e a aba. */
async function repaint() {
  if (state.viewOpen) await refresh();
  await pushSidebar();
}

/** Redesenha tudo: o formulário (abre, atualiza ou fecha), a janela e a aba. */
async function redraw() {
  await syncEditor();
  await repaint();
}

function configHosts() {
  if (!setting('sshConfig', true)) return [];
  const saved = new Set(state.saved.map((h) => h.host));
  return hosts.configHosts().filter((h) => !saved.has(h.alias));
}

/** A chave de um host no mapa dos terminais abertos. */
const keyOf = (host) => (host.id ? `s:${host.id}` : `c:${host.alias}`);

/** O nome que o terminal leva na lateral. */
const labelOf = (host) => host.name || host.alias;

/** "agora", "há 5 min", "há 3 h", "há 2 dias": quando você conectou por último. */
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
  const command = hosts.commandFor(host, state.settings);
  const label = labelOf(host);
  try {
    // Na home e não na pasta do painel em foco: uma sessão remota não é de
    // repositório nenhum. E `owned`: o terminal é do plugin -- mora nesta aba,
    // na linha do host, e não entre os avulsos.
    const { tabId } =
      (await mx.request('session.openShell', {
        cwd: hosts.HOME,
        command,
        label,
        owned: true,
        tag: keyOf(host),
      })) || {};
    if (tabId) {
      state.opened.set(tabId, keyOf(host));
      state.live.set(tabId, { id: tabId, kind: 'shell', title: label });
    }
  } catch (e) {
    await mx.request('window.showBanner', { text: `não abri o ssh: ${e.message}`, sticky: true });
    return;
  }
  if (host.id) {
    const saved = state.saved.find((h) => h.id === host.id);
    if (saved) {
      saved.lastUsed = new Date().toISOString();
      persist();
    }
  }
  await repaint();
}

// --- janela ------------------------------------------------------------------

function field(id, label, value, placeholder) {
  return {
    type: 'input',
    id: `f${state.gen}.${id}`,
    label,
    placeholder,
    value: value == null ? '' : String(value),
    submit: 'salvar',
  };
}

function formBlocks() {
  const f = state.form;
  const h = (f.id && state.saved.find((x) => x.id === f.id)) || {};
  return [
    { type: 'heading', text: f.id ? `Editar ${h.name}` : 'Novo host' },
    field('name', 'nome', h.name, 'produção, raspberry, vps…'),
    field('host', 'host', h.host, 'exemplo.com ou 10.0.0.12'),
    {
      type: 'row',
      children: [field('user', 'usuário', h.user, 'root'), field('port', 'porta', h.port, '22')],
    },
    field('key', 'chave privada', h.key, '~/.ssh/id_ed25519 (vazio: a do ssh-agent)'),
    field('options', 'opções do ssh', h.options, '-A, -L 5432:localhost:5432, -o …'),
    {
      type: 'select',
      id: `f${state.gen}.group`,
      label: 'grupo',
      value: f.group,
      options: [
        { value: '', label: 'sem grupo' },
        ...state.groups.map((g) => ({ value: g, label: g })),
        { value: NEW_GROUP, label: 'novo grupo…' },
      ],
      action: 'form-grupo',
    },
    f.group === NEW_GROUP ? field('newGroup', 'nome do novo grupo', '', 'trabalho, pessoal, clientes…') : null,
    f.error ? { type: 'text', style: 'error', text: f.error } : null,
    {
      type: 'row',
      children: [
        { type: 'button', action: 'salvar', label: 'salvar', style: 'primary', icon: 'check' },
        f.id ? { type: 'button', action: 'salvar-conectar', label: 'salvar e conectar', icon: 'terminal' } : null,
        { type: 'button', action: 'cancelar', label: 'cancelar' },
        f.id ? { type: 'button', action: `duplicar-host:${f.id}`, label: 'duplicar', icon: 'copy' } : null,
        f.id ? { type: 'button', action: `apagar:${f.id}`, label: 'apagar', style: 'danger' } : null,
      ].filter(Boolean),
    },
    { type: 'divider' },
  ].filter(Boolean);
}

function savedBlocks() {
  if (!state.saved.length) {
    return [{ type: 'list', items: [], empty: 'nenhum host salvo ainda — comece por “novo host”' }];
  }
  const byGroup = groupHosts(state.saved, true);
  const out = [];
  for (const [g, list] of byGroup) {
    const closed = state.collapsed.has(sectionKey(g));
    if (g) {
      out.push({ type: 'section', text: g, count: list.length, collapsed: closed, action: `recolher:${sectionKey(g)}` });
      if (closed) continue;
    }
    out.push({
      type: 'list',
      empty: 'vazio — mova um host pra cá pelo ícone de pasta dele',
      items: list.map((h) => ({
        title: h.name,
        subtitle: hosts.address(h),
        icon: state.editing ? 'settings' : 'terminal',
        tone: state.editing ? 'yellow' : 'accent',
        badge: state.editing ? 'editar' : ago(h.lastUsed),
        action: state.editing ? `editar:${h.id}` : `conectar:${h.id}`,
        actions: [{ action: `mover:${h.id}`, icon: 'folder', tooltip: 'mover pro grupo…' }],
      })),
    });
  }
  return out;
}

/**
 * Os hosts por grupo, na ordem da tela: os sem grupo primeiro (só quando há
 * algum), e os grupos em ordem alfabética. Com `withEmpty` os grupos sem host
 * entram também, vazios.
 */
function groupHosts(list, withEmpty) {
  const byGroup = new Map();
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  if (sorted.some((h) => !h.group)) byGroup.set('', []);
  for (const g of state.groups) if (withEmpty || sorted.some((h) => h.group === g)) byGroup.set(g, []);
  for (const h of sorted) {
    const g = h.group || '';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(h);
  }
  return byGroup;
}

/** O campo da pergunta aberta, se ela é desta superfície. */
function askBlocks(where) {
  const a = state.ask;
  if (!a || a.where !== where) return [];
  const label = a.kind === 'renomear' ? `novo nome de ${a.group}` : 'nome do grupo';
  return [
    {
      type: 'input',
      id: `ask${a.gen}`,
      label,
      value: a.kind === 'renomear' ? a.group : '',
      placeholder: 'trabalho, pessoal, clientes… (enter)',
      submit: 'ask-ok',
    },
    a.error ? { type: 'text', style: 'error', text: a.error } : null,
    {
      type: 'row',
      children: [
        { type: 'button', action: 'ask-ok', label: a.kind === 'renomear' ? 'renomear' : 'criar', style: 'primary', icon: 'check' },
        { type: 'button', action: 'ask-cancelar', label: 'cancelar' },
      ],
    },
  ].filter(Boolean);
}

/** Os grupos na janela: um por linha, com renomear e apagar no hover. */
function groupBlocks() {
  if (!state.groups.length) return [];
  return [
    { type: 'divider' },
    { type: 'heading', text: 'Grupos' },
    {
      type: 'list',
      items: state.groups.map((g) => {
        const n = state.saved.filter((h) => h.group === g).length;
        return {
          title: g,
          subtitle: n ? `${n} ${n === 1 ? 'host' : 'hosts'}` : 'vazio',
          icon: 'folder',
          tone: 'accent',
          action: `novo-no-grupo:${g}`,
          actions: [
            { action: `novo-no-grupo:${g}`, icon: 'add', tooltip: 'novo host neste grupo' },
            { action: `renomear:${g}`, icon: 'edit', tooltip: 'renomear' },
            { action: `apagar-grupo:${g}`, icon: 'remove', tooltip: 'apagar o grupo', tone: 'red' },
          ],
        };
      }),
    },
  ];
}

function blocks() {
  const fromConfig = configHosts();
  return [
    {
      type: 'row',
      children: [
        { type: 'button', action: 'novo', label: 'novo host', style: 'primary', icon: 'star' },
        { type: 'button', action: 'novo-grupo', label: 'novo grupo', icon: 'folder' },
        {
          type: 'button',
          action: 'lapis',
          label: state.editing ? 'pronto' : 'editar',
          icon: state.editing ? 'check' : 'settings',
          disabled: !state.saved.length && !state.editing,
        },
      ],
    },
    { type: 'heading', text: 'Salvos' },
    ...savedBlocks(),
    ...groupBlocks(),
    ...(fromConfig.length
      ? [
          { type: 'divider' },
          { type: 'heading', text: 'Do ~/.ssh/config' },
          {
            type: 'list',
            items: fromConfig.map((h) => ({
              title: h.alias,
              subtitle: hosts.address(h),
              icon: 'file',
              tone: 'faint',
              connect: `config:${h.alias}`,
            })),
          },
        ]
      : []),
    {
      type: 'text',
      style: 'faint',
      text: 'a senha, quando o servidor pede, você digita no terminal — o plugin não guarda senha. Pra não digitar, use uma chave.',
    },
  ];
}

async function open() {
  reload();
  await syncSessions();
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

// --- a grade (rfw) -------------------------------------------------------------

/** A cor do quadrado de um cartão: a mesma pra um nome, sempre. */
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

/**
 * O cartão de um host. O que clicar faz, o menu e o estado vêm da linha da aba
 * ([sidebarItem]): conectar, ir pro terminal aberto, ver o que caiu.
 */
function hostTile(host, terms, { title, sub, connect, menu, faint, edit }) {
  const item = sidebarItem(host, terms, { title, subtitle: sub, connect, menu, idle: faint ? 'faint' : 'accent' });
  const status = item.tone === 'green' || item.tone === 'red' ? item.tone : '';
  const when = !status && item.badge ? ` · ${item.badge}` : '';
  return {
    title,
    sub: status ? `${item.badge} · ${sub}` : `${sub}${when}`,
    icon: faint ? 'file' : 'server',
    tone: faint ? 'faint' : toneOf(title),
    status,
    action: item.action,
    menu: rfwMenu(item.menu),
    edit: edit || '',
  };
}

function savedTile(h, terms) {
  return hostTile(h, terms, {
    title: h.name,
    sub: hosts.address(h),
    connect: `conectar:${h.id}`,
    edit: `editar:${h.id}`,
    menu: [
      { action: `editar:${h.id}`, label: 'editar…', icon: 'edit' },
      { action: `mover:${h.id}`, label: 'mover pro grupo…', icon: 'folder' },
      { action: `duplicar-host:${h.id}`, label: 'duplicar', icon: 'copy' },
      { action: `copiar:${h.id}`, label: 'copiar o comando', icon: 'copy' },
      { type: 'divider' },
      { action: `apagar:${h.id}`, label: 'apagar', icon: 'remove', tone: 'red' },
    ],
  });
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

/** Os dados da grade: o topo, a trilha e as seções de cartões. */
function gridData() {
  const terms = byHost();
  const live = (list) => list.filter((h) => terms.get(keyOf(h))?.live.length).length;
  if (state.group && !state.groups.includes(state.group)) state.group = '';
  const g = state.group;
  const sorted = [...state.saved].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const sections = [];

  if (g) {
    const list = sorted.filter((h) => h.group === g);
    sections.push({
      title: 'Hosts',
      count: String(list.length),
      empty: list.length ? '' : 'vazio — “novo host” cria um aqui, ou mova um host pra cá pelo botão direito nele',
      items: list.map((h) => savedTile(h, terms)),
    });
  } else {
    if (state.groups.length) {
      sections.push({
        title: 'Grupos',
        count: String(state.groups.length),
        empty: '',
        items: state.groups.map((name) => {
          const list = sorted.filter((h) => h.group === name);
          const on = live(list);
          return {
            title: name,
            sub: list.length ? plural(list.length, 'host', 'hosts') + (on ? ` · ${on} conectado${on > 1 ? 's' : ''}` : '') : 'vazio',
            icon: 'folder',
            tone: toneOf(name),
            status: on ? 'green' : '',
            action: `grupo:${name}`,
            menu: groupMenu(name, true),
            edit: '',
          };
        }),
      });
    }
    const loose = sorted.filter((h) => !h.group);
    // Com todos os hosts em grupos, a seção sai: os grupos já são o caminho.
    if (loose.length || !state.saved.length) {
      sections.push({
        title: 'Hosts',
        count: String(loose.length),
        empty: loose.length ? '' : 'nenhum host salvo ainda — comece por “novo host”',
        items: loose.map((h) => savedTile(h, terms)),
      });
    }
    const fromConfig = configHosts();
    if (fromConfig.length) {
      sections.push({
        title: 'Do ~/.ssh/config',
        count: String(fromConfig.length),
        empty: '',
        items: fromConfig.map((h) =>
          hostTile(h, terms, {
            title: h.alias,
            sub: hosts.address(h),
            connect: `config:${h.alias}`,
            faint: true,
            menu: [{ action: `copiar-config:${h.alias}`, label: 'copiar o comando', icon: 'copy' }],
          }),
        ),
      });
    }
  }

  // Dentro de um grupo, os números são os dele.
  const inGroup = g ? sorted.filter((h) => h.group === g) : null;
  const total = inGroup ? inGroup.length : state.saved.length + configHosts().length;
  const on = inGroup ? live(inGroup) : state.live.size;
  return {
    head: {
      title: g || 'Hosts',
      sub: plural(total, 'host', 'hosts') + (on ? ` · ${on} conectado${on > 1 ? 's' : ''}` : ''),
      newHost: g ? `novo-no-grupo:${g}` : 'novo',
    },
    crumb: { group: g, menu: g ? groupMenu(g, false) : [] },
    sections,
    hint: HINT,
  };
}

// --- o formulário (a janela ao lado) ---------------------------------------------

/** O que a janela do formulário mostra agora, ou null quando não há nada pra ela. */
function editorView() {
  if (state.form) {
    const h = state.form.id && state.saved.find((x) => x.id === state.form.id);
    return { title: h ? h.name : 'novo host', blocks: formBlocks() };
  }
  if (state.ask && state.ask.where === 'window') {
    return { title: state.ask.kind === 'renomear' ? 'renomear o grupo' : 'novo grupo', blocks: askBlocks('window') };
  }
  return null;
}

/**
 * Abre, atualiza ou fecha a janela do formulário. Fechada no x, ela leva junto
 * o formulário: o x é o cancelar.
 */
async function syncEditor() {
  const want = editorView();
  try {
    if (!want) {
      if (state.editorOpen) await mx.request('view.close', { viewId: EDITOR });
      state.editorOpen = false;
      return;
    }
    if (state.editorRaise || !state.editorOpen) {
      // Ao lado da grade: a janela abre ao lado da que está em foco.
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
      if (state.ask && state.ask.where === 'window') state.ask = null;
    }
  } catch (e) {
    mx.log('formulário:', e.message);
  }
}

function openForm(id, group = '') {
  if (state.modal) {
    // Sem await: o modal espera você, e quem chamou segue redesenhando.
    hostModal(id, group).catch((e) => mx.log('formulário:', String(e.stack || e)));
    return;
  }
  state.gen += 1;
  state.editorRaise = true;
  const h = id && state.saved.find((x) => x.id === id);
  state.form = { id: id || null, gen: state.gen, group: h ? h.group || '' : group };
}

/** O que foi digitado no formulário aberto, sem o prefixo do `gen`. */
function formValues(values) {
  const prefix = `f${state.gen}.`;
  const out = {};
  for (const [k, v] of Object.entries(values || {})) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

/** Salva o formulário. Devolve o host salvo, ou null quando voltou com erro. */
function submit(values) {
  const previous = state.form.id ? state.saved.find((h) => h.id === state.form.id) : null;
  const typed = formValues(values);
  if (typed.group === NEW_GROUP) {
    typed.group = String(typed.newGroup || '').trim();
    if (!typed.group) {
      state.form.error = 'falta o nome do novo grupo';
      return null;
    }
  }
  const { host, error } = hosts.normalize({
    ...typed,
    id: previous && previous.id,
    lastUsed: previous && previous.lastUsed,
  });
  if (error) {
    state.form.error = error;
    return null;
  }
  const i = state.saved.findIndex((h) => h.id === host.id);
  if (i >= 0) state.saved[i] = host;
  else state.saved.push(host);
  persist();
  state.form = null;
  return host;
}

/** Os campos do host no modal, com o que já estava (ou o que voltou com erro). */
function hostFields(v) {
  return [
    { id: 'name', label: 'nome', placeholder: 'produção, raspberry, vps…', value: v.name },
    { id: 'host', label: 'host', placeholder: 'exemplo.com ou 10.0.0.12', value: v.host, required: true },
    { id: 'user', label: 'usuário', placeholder: 'root', value: v.user, half: true },
    { id: 'port', label: 'porta', placeholder: '22', value: v.port, half: true },
    { id: 'key', label: 'chave privada', placeholder: '~/.ssh/id_ed25519 (vazio: a do ssh-agent)', value: v.key },
    { id: 'options', label: 'opções do ssh', placeholder: '-A, -L 5432:localhost:5432, -o …', value: v.options },
    {
      id: 'group',
      type: 'select',
      label: 'grupo',
      value: v.group,
      options: [
        { value: '', label: 'sem grupo' },
        ...state.groups.map((g) => ({ value: g, label: g })),
        { value: NEW_GROUP, label: 'novo grupo…' },
      ],
    },
    {
      id: 'newGroup',
      label: 'nome do novo grupo',
      placeholder: 'trabalho, pessoal, clientes…',
      value: v.newGroup,
      required: true,
      showIf: { field: 'group', value: NEW_GROUP },
    },
  ];
}

/**
 * O formulário de um host num modal (`window.form`): o novo, ou o de [id]. Uma
 * porta fora da faixa reabre o modal com o que foi digitado e o erro embaixo.
 */
async function hostModal(id, group = '') {
  reload();
  const prev = id ? state.saved.find((h) => h.id === id) : null;
  if (id && !prev) return;
  let values = {
    name: prev ? prev.name : '',
    host: prev ? prev.host : '',
    user: prev ? prev.user : '',
    port: prev && prev.port ? String(prev.port) : '',
    key: prev ? prev.key : '',
    options: prev ? prev.options : '',
    group: prev ? prev.group || '' : group,
    newGroup: '',
  };
  let error = '';
  for (;;) {
    const answer = await mx.request('window.form', {
      title: prev ? `editar ${prev.name}` : 'novo host',
      fields: hostFields(values),
      buttons: [
        prev ? { action: 'apagar', label: 'apagar', style: 'danger' } : null,
        prev ? { action: 'duplicar', label: 'duplicar' } : null,
        { action: 'conectar', label: 'salvar e conectar' },
        { action: 'salvar', label: 'salvar', style: 'primary' },
      ].filter(Boolean),
      error,
    });
    if (!answer) return;
    if (answer.action === 'apagar') return windowAction(`apagar:${prev.id}`, {});
    if (answer.action === 'duplicar') return windowAction(`duplicar-host:${prev.id}`, {});
    values = answer.values || {};
    const typed = { ...values };
    if (typed.group === NEW_GROUP) typed.group = String(typed.newGroup || '').trim();
    const result = hosts.normalize({ ...typed, id: prev && prev.id, lastUsed: prev && prev.lastUsed });
    if (result.error) {
      error = result.error;
      continue;
    }
    const i = state.saved.findIndex((h) => h.id === result.host.id);
    if (i >= 0) state.saved[i] = result.host;
    else state.saved.push(result.host);
    persist();
    await repaint();
    if (answer.action === 'conectar') await connect(result.host);
    return;
  }
}

// --- grupos --------------------------------------------------------------------

async function askGroup(kind, where, extra = {}) {
  if (state.input) {
    const name = await mx.request('window.input', {
      title: kind === 'renomear' ? `renomear o grupo ${extra.group}` : 'novo grupo',
      placeholder: 'trabalho, pessoal, clientes…',
      value: kind === 'renomear' ? extra.group : '',
    });
    if (name) applyGroupName({ kind, ...extra }, String(name).trim());
    return;
  }
  state.gen += 1;
  if (where === 'window') state.editorRaise = true;
  state.ask = { kind, where, gen: state.gen, ...extra };
}

/** Responde a pergunta aberta com o que foi digitado. */
function answerAsk(values) {
  const a = state.ask;
  const name = String((values || {})[`ask${a.gen}`] || '').trim();
  if (!name) {
    a.error = 'falta o nome';
    return;
  }
  applyGroupName(a, name);
  state.ask = null;
}

/** Cria o grupo (e põe nele o host que pediu), ou renomeia o de `a.group`. */
function applyGroupName(a, name) {
  if (a.kind === 'renomear') {
    if (name !== a.group) {
      // Um nome que já existe junta os dois grupos.
      for (const h of state.saved) if (h.group === a.group) h.group = name;
      // A grade aberta no grupo segue o nome novo, em vez de voltar pra raiz.
      if (state.group === a.group) state.group = name;
      state.groups = state.groups.filter((g) => g !== a.group).concat(name);
      if (state.collapsed.has(sectionKey(a.group))) {
        state.collapsed.delete(sectionKey(a.group));
        setCollapsed(sectionKey(name), true);
      }
    }
  } else {
    state.groups = state.groups.concat(name);
    const h = a.hostId && state.saved.find((x) => x.id === a.hostId);
    if (h) h.group = name;
  }
  persist();
}

/** "mover pro grupo…": os outros grupos, sem grupo e um novo. */
async function moveHost(h, where) {
  const items = [
    ...state.groups.filter((g) => g !== h.group).map((g) => ({ value: `g:${g}`, label: g })),
    h.group ? { value: 'g:', label: 'sem grupo' } : null,
    { value: 'novo', label: 'novo grupo…', detail: 'cria o grupo e põe o host nele' },
  ].filter(Boolean);
  const choice = await mx.request('window.pick', { title: `mover ${h.name} pro grupo`, placeholder: 'grupo', items });
  if (!choice) return;
  if (choice === 'novo') return askGroup('novo-grupo', where, { hostId: h.id });
  h.group = choice.slice(2);
  persist();
}

async function deleteGroup(g) {
  const n = state.saved.filter((h) => h.group === g).length;
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
  for (const h of state.saved) if (h.group === g) h.group = '';
  state.groups = state.groups.filter((x) => x !== g);
  setCollapsed(sectionKey(g), false);
  persist();
}

/**
 * As ações de grupo, iguais na janela e na aba. Devolve true quando a ação era
 * de grupo (e já redesenhou tudo).
 */
async function groupAction(verb, arg, values, where) {
  const byId = (id) => state.saved.find((h) => h.id === id);
  switch (verb) {
    case 'novo-grupo':
      await askGroup('novo-grupo', where);
      break;
    case 'renomear':
      if (state.groups.includes(arg)) await askGroup('renomear', where, { group: arg });
      break;
    case 'ask-ok':
      if (state.ask) answerAsk(values);
      break;
    case 'ask-cancelar':
      state.ask = null;
      break;
    case 'recolher':
      setCollapsed(arg, !state.collapsed.has(arg));
      break;
    case 'apagar-grupo':
      await deleteGroup(arg);
      break;
    case 'mover': {
      const h = byId(arg);
      if (h) await moveHost(h, where);
      break;
    }
    case 'novo-no-grupo':
      openForm(null, arg);
      // O formulário abre ao lado da janela de hosts; da aba, ela vem junto.
      if (!state.viewOpen) await open();
      break;
    default:
      return false;
  }
  await redraw();
  return true;
}

async function windowAction(action, values) {
  const [verb, arg] = [action.split(':')[0], action.slice(action.indexOf(':') + 1)];
  if (await groupAction(verb, arg, values, 'window')) return;
  if (await sessionAction(verb, arg)) return;
  const byId = (id) => state.saved.find((h) => h.id === id);
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
    case 'novo':
      openForm(null);
      break;
    case 'form-grupo':
      // Trocou o grupo no formulário: o "novo grupo…" mostra o campo do nome.
      if (state.form) state.form.group = formValues(values).group || '';
      break;
    case 'editar':
      if (byId(arg)) openForm(arg);
      break;
    case 'lapis':
      state.editing = !state.editing;
      if (!state.editing) state.form = null;
      break;
    case 'cancelar':
      state.form = null;
      break;
    case 'salvar':
      submit(values);
      break;
    case 'salvar-conectar': {
      const h = submit(values);
      if (h) {
        state.editing = false;
        // Fecha o formulário antes: o terminal abre no lugar que ele deixa.
        await redraw();
        return connect(h);
      }
      break;
    }
    case 'duplicar-host': {
      const h = byId(arg);
      if (!h) break;
      const copy = { ...h, id: undefined, name: `${h.name} (cópia)`, lastUsed: null };
      const { host } = hosts.normalize(copy);
      state.saved.push(host);
      persist();
      openForm(host.id);
      break;
    }
    case 'apagar': {
      const h = byId(arg);
      if (!h) break;
      const sure = await mx.request('window.pick', {
        title: `apagar ${h.name}?`,
        items: [
          { value: 'nao', label: 'não, deixa' },
          { value: 'sim', label: `sim, apagar ${h.name}`, detail: hosts.address(h) },
        ],
      });
      if (sure !== 'sim') break;
      state.saved = state.saved.filter((x) => x.id !== h.id);
      persist();
      state.form = null;
      if (!state.saved.length) state.editing = false;
      break;
    }
    default:
      mx.log('ação desconhecida:', action);
  }
  // Salvar, apagar e duplicar mudam a lista da aba também.
  await redraw();
}

// --- a aba da lateral ----------------------------------------------------------

/**
 * Relê as sessões e fica com os terminais do plugin: os de pé em `live`, os
 * que o ssh já deixou em `dead`. Um terminal é nosso pelo `owner`, e o host
 * dele pelo `tag` -- os dois voltam no sessions.list.
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
    state.opened.set(s.id, s.tag);
    (s.exited ? state.dead : state.live).set(s.id, s);
  }
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
 * Uma linha da aba: o host. Sem terminal, clicar conecta. Com terminal de pé,
 * a linha *é* a conexão: verde, e clicar vai pra ela (e pra próxima, a cada
 * clique, quando há mais de uma). Com o ssh caído, vermelha: clicar mostra o
 * terminal com o motivo.
 *
 * No hover, no máximo duas coisas -- a que mais se faz naquele estado e o
 * fechar. O resto vai pro botão direito: com cinco ícones a linha ficava sem
 * lugar onde clicar.
 */
function sidebarItem(host, terms, { title, subtitle, connect, menu, idle }) {
  const key = keyOf(host);
  const { live = [], dead = [] } = terms.get(key) || {};
  const base = { title, subtitle, icon: 'server' };
  if (live.length) {
    const last = live[live.length - 1];
    return {
      ...base,
      tone: 'green',
      badge: live.length > 1 ? `${live.length} abertos` : 'conectado',
      action: `ir:${key}`,
      actions: [
        { action: `duplicar:${key}`, icon: 'add', tooltip: 'abrir outra conexão' },
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
    tone: idle,
    badge: ago(host.lastUsed),
    action: connect,
    menu: [{ action: connect, label: 'conectar', icon: 'play' }, { type: 'divider' }, ...menu],
  };
}

function sidebarBlocks() {
  const terms = byHost();
  const fromConfig = configHosts();
  const total = state.saved.length + fromConfig.length;
  const filter = state.filter.trim().toLowerCase();
  const out = [];

  out.push({
    type: 'row',
    children: [
      { type: 'button', action: 'novo', icon: 'add', style: 'icon', tooltip: 'novo host' },
      { type: 'button', action: 'grupos', icon: 'folder', style: 'icon', tooltip: 'grupos: criar, renomear, apagar' },
      { type: 'button', action: 'atualizar', icon: 'refresh', style: 'icon', tooltip: 'reler os hosts' },
      { type: 'button', action: 'janela', icon: 'open', style: 'icon', tooltip: 'abrir a janela de hosts' },
    ],
  });
  out.push(...askBlocks('sidebar'));
  if (total > FILTER_FROM || filter) {
    out.push({ type: 'input', id: 'filtro', placeholder: 'filtrar (enter)', submit: 'filtrar' });
  }

  const saved = [...state.saved]
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    .filter((h) => matches(filter, h.name, h.host, h.user, h.group));
  // Os sem grupo em "salvos", e cada grupo numa seção própria, em ordem
  // alfabética. Filtrando, os grupos sem resultado somem.
  const byGroup = groupHosts(saved, !filter);
  if (!byGroup.size) byGroup.set('', []);
  for (const [g, list] of byGroup) {
    // Filtrando, tudo aberto: o filtro é pra achar, e um grupo fechado esconderia o achado.
    const closed = !filter && state.collapsed.has(sectionKey(g));
    out.push(sectionBlock(g || 'salvos', sectionKey(g), list, terms, filter));
    if (closed) continue;
    out.push({
      type: 'list',
      flat: true,
      empty: filter
        ? 'nada com esse filtro'
        : g
          ? 'vazio — botão direito num host, “mover pro grupo…”'
          : 'nenhum host salvo — o + cria um',
      items: list.map((h) =>
        sidebarItem(h, terms, {
          title: h.name,
          subtitle: hosts.address(h),
          connect: `conectar:${h.id}`,
          idle: 'accent',
          menu: [
            { action: `editar:${h.id}`, label: 'editar…', icon: 'edit' },
            { action: `mover:${h.id}`, label: 'mover pro grupo…', icon: 'folder' },
            { action: `copiar:${h.id}`, label: 'copiar o comando', icon: 'copy' },
            { type: 'divider' },
            { action: `apagar:${h.id}`, label: 'apagar', icon: 'remove', tone: 'red' },
          ],
        }),
      ),
    });
  }

  const config = fromConfig.filter((h) => matches(filter, h.alias, h.hostname, h.user));
  if (config.length) {
    out.push(sectionBlock('~/.ssh/config', 'config', config, terms, filter));
  }
  if (config.length && (filter || !state.collapsed.has('config'))) {
    out.push({
      type: 'list',
      flat: true,
      items: config.map((h) =>
        sidebarItem(h, terms, {
          title: h.alias,
          subtitle: hosts.address(h) === h.alias ? undefined : hosts.address(h),
          connect: `config:${h.alias}`,
          idle: 'faint',
          menu: [{ action: `copiar-config:${h.alias}`, label: 'copiar o comando', icon: 'copy' }],
        }),
      ),
    });
  }
  return out;
}

/**
 * A régua de uma seção da aba, com a seta de abrir e fechar. Fechada com um
 * host conectado lá dentro, ela diz quantos -- senão a conexão some da vista.
 */
function sectionBlock(text, key, list, terms, filter) {
  if (filter) return { type: 'section', text, count: list.length };
  const closed = state.collapsed.has(key);
  const live = list.filter((h) => terms.get(keyOf(h))?.live.length).length;
  const count = closed && live ? `${list.length} · ${live} conectado${live > 1 ? 's' : ''}` : list.length;
  return { type: 'section', text, count, collapsed: closed, action: `recolher:${key}` };
}

/** Manda a aba e o selo. Com a aba escondida também: ela aparece pronta. */
async function pushSidebar() {
  const count = state.live.size;
  try {
    await mx.request('sidebar.update', { blocks: sidebarBlocks(), badge: count ? String(count) : null });
  } catch (e) {
    // Uma Maestria sem a aba da lateral: a janela continua servindo.
    mx.log('sidebar.update:', e.message);
  }
}

async function sidebarAction(action, values) {
  const [verb, arg] = [action.split(':')[0], action.slice(action.indexOf(':') + 1)];
  if (values && typeof values.filtro === 'string') state.filter = values.filtro;
  if (await groupAction(verb, arg, values, 'sidebar')) return;
  if (await sessionAction(verb, arg)) return;
  const byId = (id) => state.saved.find((h) => h.id === id);
  switch (verb) {
    case 'novo':
    case 'editar':
      // O formulário mora numa janela, ao lado da de hosts: a aba abre as duas.
      reload();
      if (verb === 'editar' && !byId(arg)) break;
      openForm(verb === 'editar' ? arg : null);
      if (!state.viewOpen) await open();
      return redraw();
    case 'janela':
      await open();
      return;
    case 'grupos':
      // A régua de uma seção não tem menu: os grupos se mexem por aqui.
      return pickGroup();
    case 'apagar':
      // A mesma confirmação da janela, que já redesenha as duas.
      return windowAction(action, values);
    case 'atualizar':
      reload();
      await syncSessions();
      break;
    case 'filtrar':
      break;
    default:
      mx.log('ação desconhecida na aba:', action);
  }
  await pushSidebar();
}

/**
 * O que um host faz, igual na aba e nos cartões da janela: conectar, ir pro
 * terminal, abrir outra conexão, reconectar, fechar e copiar o comando. Devolve
 * true quando a ação era dessas (e já redesenhou o que precisava).
 */
async function sessionAction(verb, arg) {
  const byId = (id) => state.saved.find((h) => h.id === id);
  switch (verb) {
    case 'conectar': {
      const h = byId(arg);
      if (h) await connect(h);
      return true;
    }
    case 'config':
      await connect({ alias: arg });
      return true;
    case 'focar':
      await mx.request('session.focus', { tabId: arg });
      return true;
    case 'ir': {
      // A próxima conexão do host depois da que está em foco: com duas, cada
      // clique alterna entre elas.
      await syncSessions();
      const live = byHost().get(arg)?.live || [];
      if (!live.length) {
        await repaint();
        return true;
      }
      const at = live.findIndex((id) => state.live.get(id)?.focused);
      await mx.request('session.focus', { tabId: live[(at + 1) % live.length] });
      return true;
    }
    case 'duplicar':
    case 'reconectar': {
      const key = verb === 'duplicar' ? arg : state.opened.get(arg);
      const host = key && hostByKey(key);
      if (!host) return true;
      // Reconectar troca o terminal caído por um novo, no lugar dele na lista.
      if (verb === 'reconectar') await closeTerm(arg);
      await connect(host);
      return true;
    }
    case 'fechar':
      await closeTerm(arg);
      await syncSessions();
      await repaint();
      return true;
    case 'copiar':
    case 'copiar-config': {
      const h = verb === 'copiar' ? byId(arg) : { alias: arg };
      if (!h) return true;
      await mx.request('clipboard.write', { text: hosts.commandFor(h, state.settings) });
      await mx.request('window.showBanner', { text: `copiei o comando de ${labelOf(h)}` });
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
        const n = state.saved.filter((h) => h.group === x).length;
        return { value: `g:${x}`, label: x, detail: n ? `${n} ${n === 1 ? 'host' : 'hosts'}` : 'vazio' };
      }),
    ],
  });
  if (!g) return;
  if (g === 'novo') return groupAction('novo-grupo', '', {}, 'sidebar');
  const name = g.slice(2);
  const what = await mx.request('window.pick', {
    title: name,
    items: [
      { value: 'novo-no-grupo', label: 'novo host neste grupo' },
      { value: 'renomear', label: 'renomear…' },
      { value: 'apagar-grupo', label: 'apagar o grupo', detail: 'os hosts dele ficam sem grupo' },
    ],
  });
  if (what) await groupAction(what, name, {}, 'sidebar');
}

/** O host de uma chave do mapa (`s:<id>` ou `c:<alias>`). */
function hostByKey(key) {
  if (key.startsWith('s:')) return state.saved.find((h) => h.id === key.slice(2));
  if (key.startsWith('c:')) return { alias: key.slice(2) };
  return undefined;
}

async function closeTerm(tabId) {
  try {
    await mx.request('session.close', { tabId });
  } catch (e) {
    mx.log('session.close:', e.message);
  }
}

mx.onNotification('view.action', async ({ viewId, action, values = {} }) => {
  // Na grade em widgets, o clique manda a ação em `a`, e o menu em `action`.
  if (viewId === VIEW && action === 'act') return windowAction(values.a || values.action, values);
  if (viewId === VIEW || viewId === EDITOR) return windowAction(action, values);
  if (viewId === SIDEBAR) return sidebarAction(action, values);
});

mx.onNotification('event', async (e) => {
  switch (e.type) {
    case 'sidebar.shown':
      // A cada clique no ícone: relê os hosts e os terminais.
      reload();
      await syncSessions();
      return pushSidebar();
    case 'session.closed':
      if (!state.opened.has(e.tabId)) return;
      state.opened.delete(e.tabId);
      state.live.delete(e.tabId);
      state.dead.delete(e.tabId);
      return repaint();
    case 'session.exited':
      // O ssh saiu: a linha do host fica vermelha, com o terminal esperando.
      if (!state.opened.has(e.tabId)) return;
      await syncSessions();
      return repaint();
    case 'session.status':
      // O ssh saiu e o painel ficou: o sessions.list diz se ele ainda está de pé.
      if (!state.opened.has(e.tabId)) return;
      await syncSessions();
      return repaint();
    default:
  }
});

/** O seletor rápido: digita um pedaço do nome ou do endereço, enter, conectado. */
async function pickAndConnect() {
  reload();
  const recent = [...state.saved].sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
  const items = [
    ...recent.map((h) => ({
      value: `s:${h.id}`,
      label: h.group ? `${h.name} · ${h.group}` : h.name,
      detail: hosts.address(h),
    })),
    ...configHosts().map((h) => ({ value: `c:${h.alias}`, label: h.alias, detail: `~/.ssh/config · ${hosts.address(h)}` })),
  ];
  if (!items.length) {
    await open();
    await mx.request('window.showBanner', { text: 'nenhum host ainda — salve um aqui' });
    return;
  }
  const choice = await mx.request('window.pick', {
    title: 'conectar por ssh',
    placeholder: 'nome ou endereço',
    items,
  });
  if (!choice) return;
  if (choice.startsWith('c:')) return connect({ alias: choice.slice(2) });
  const h = state.saved.find((x) => x.id === choice.slice(2));
  if (h) await connect(h);
}

mx.onRequest('initialize', (params) => {
  state.dataDir = params.dataDir || state.dataDir;
  state.settings = params.settings || {};
  state.rfw = Number(params.rfw) >= 1;
  state.input = Number(params.input) >= 1;
  state.modal = Number(params.form) >= 1;
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
  else throw new Error(`comando desconhecido: ${command}`);
  return null;
});

mx.start();
