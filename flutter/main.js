// Central de debug do Flutter: a barrinha do VS Code (continuar/pausar, step
// over/into/out, hot reload, hot restart, parar, DevTools), o seletor de
// configurações do launch.json, o seletor de aparelho e o debug console.
//
// Uma central por projeto (ver `session.js`), e quantas você quiser abertas.
// Este arquivo decide qual delas cada comando quer dizer, e desenha a aba da
// lateral: o "Run and Debug" do VS Code, compacto.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mx = require('./maestria');
const sdk = require('./sdk');
const { Session } = require('./session');
const { DevTools } = require('./devtools');
const settings = require('./settings');

/** As centrais abertas, pela pasta do projeto. */
const sessions = new Map();

/** A última que você usou: é pra ela que vai uma tecla sem outro endereço. */
let active = null;

/** A versão da lista que a Maestria desenha: com `blocks: 2`, a seta que abre e fecha. */
let ui = 1;

/**
 * De onde veio cada projeto de um worktree: o mesmo app na pasta principal
 * (`parent`, quando ele também é um projeto) e o nome do worktree (`label`, a
 * branch). Os da pasta principal e os soltos não estão aqui.
 */
let placement = new Map();

/** O nome do projeto em todo lugar: o worktree leva o do app junto, "maestria_v2 · BUG#65031". */
function fullName(root) {
  const p = placement.get(root);
  if (!p) return path.basename(root);
  return `${path.basename(p.parent || root)} · ${p.label}`;
}

/** A central de um projeto, criada se preciso, sem virar a ativa. */
function ensureSession(root) {
  let s = sessions.get(root);
  if (!s) {
    s = new Session(root);
    sessions.set(root, s);
  }
  s.label = fullName(root);
  return s;
}

function sessionFor(root) {
  return (active = ensureSession(root));
}

const tilde = (p) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

/**
 * Os projetos que dá pra abrir: os das pastas e worktrees da lateral, o do
 * painel em foco e os que já têm central. Na ordem em que se procura: o do
 * painel em foco primeiro, depois os que estão rodando, depois o resto.
 */
async function candidates(context) {
  const here = sdk.findProjectRoot((context && context.cwd) || '');
  const folders = await mx.request('folders.list').catch(() => []);
  const roots = new Set([...(here ? [here] : []), ...sessions.keys()]);
  const placed = new Map();
  for (const f of folders) {
    const mains = sdk.projectsIn(f.root);
    for (const r of mains) roots.add(r);
    for (const w of f.worktrees || []) {
      if (w.prunable || w.isMain) continue;
      const label = w.label || w.branch || path.basename(w.path);
      for (const r of sdk.projectsIn(w.path)) {
        roots.add(r);
        // O app fica no mesmo lugar dentro do worktree e da pasta principal
        // (a raiz, ou o `app/` do monorepo).
        const twin = path.join(f.root, path.relative(w.path, r));
        placed.set(r, { parent: mains.includes(twin) ? twin : null, label });
      }
    }
  }
  placement = placed;
  for (const [r, s] of sessions) s.label = fullName(r);
  const rank = (r) => (r === here ? 0 : sessions.get(r)?.running ? 1 : sessions.has(r) ? 2 : 3);
  return [...roots].sort((a, b) => rank(a) - rank(b) || fullName(a).localeCompare(fullName(b)));
}

/** Pergunta em qual projeto — ou não pergunta, quando só há um. */
async function pickProject(context) {
  const roots = await candidates(context);
  if (!roots.length) {
    await mx.request('window.showBanner', {
      text: 'nenhum projeto flutter nas pastas da lateral nem no painel em foco',
    });
    return null;
  }
  if (roots.length === 1) return roots[0];
  const here = sdk.findProjectRoot((context && context.cwd) || '');
  return mx.request('window.pick', {
    title: 'abrir a central de debug em qual projeto?',
    placeholder: 'nome ou caminho do projeto',
    items: roots.map((r) => {
      const s = sessions.get(r);
      const tags = [r === here && 'painel em foco', s?.running && `rodando (${s.phase})`, s && !s.running && 'aberta']
        .filter(Boolean)
        .join(' · ');
      return { value: r, label: tags ? `${fullName(r)} — ${tags}` : fullName(r), detail: tilde(r) };
    }),
  });
}

/**
 * A central de uma tecla: a janela em foco quando é uma central, senão a do
 * projeto do painel em foco, senão a última usada.
 */
function target(context) {
  if (context && context.tabId) {
    for (const s of sessions.values()) if (s.tabId === context.tabId) return (active = s);
  }
  const root = sdk.findProjectRoot((context && context.cwd) || '');
  if (root && sessions.has(root)) return (active = sessions.get(root));
  return active;
}

async function withTarget(context, fn) {
  const s = target(context);
  if (!s) {
    await mx.request('window.showBanner', { text: 'nenhuma central de debug aberta — ⇧⌘D abre uma' });
    return;
  }
  await fn(s);
}

// --- a aba da lateral ------------------------------------------------------
//
// Uma lista dos projetos com o estado de cada um e, embaixo, o projeto ativo
// com o seletor de aparelho e a barra em ícones. O selo no ícone da faixa diz
// que há app rodando, com a aba na tela ou não.

let sidebarShown = false;
/** Os projetos da última vez que a aba olhou as pastas: o `folders.list` vai no `sidebar.shown`, não a cada evento. */
let sidebarRoots = [];
/** A pasta de cada chave de ação (`abrir:<chave>`), do último desenho. */
const rootsByKey = new Map();
let sidebarTimer = null;
let lastBadge = null;

const keyOf = (root) => crypto.createHash('sha1').update(root).digest('hex').slice(0, 10);

// Os projetos com os worktrees recolhidos, pela pasta: uma escolha sua, que
// fica de uma abertura da Maestria pra outra. Sem escolha, abertos.
const collapsedFile = path.join(process.env.MAESTRIA_PLUGIN_DATA || __dirname, 'lateral.json');
const collapsed = new Set();
try {
  for (const r of JSON.parse(fs.readFileSync(collapsedFile, 'utf8')).collapsed || []) collapsed.add(r);
} catch {}

function toggleCollapsed(root) {
  if (!collapsed.delete(root)) collapsed.add(root);
  try {
    fs.mkdirSync(path.dirname(collapsedFile), { recursive: true });
    fs.writeFileSync(collapsedFile, JSON.stringify({ collapsed: [...collapsed] }, null, 2));
  } catch {}
}

/** O projeto da parte de baixo da aba: o último usado, senão o que roda, senão o primeiro. */
function sidebarFocus() {
  if (active) return active.root;
  for (const s of sessions.values()) if (s.running) return s.root;
  return sidebarRoots[0] || null;
}

/** "▶" com um app rodando, o número com mais de um, "⏸" com algum pausado. */
function badge() {
  const on = [...sessions.values()].filter((s) => s.running);
  if (!on.length) return null;
  if (on.some((s) => s.pause)) return '⏸';
  return on.length === 1 ? '▶' : String(on.length);
}

function sidebarBlocks() {
  const roots = [...new Set([...sidebarRoots, ...sessions.keys()])];
  if (!roots.length) {
    return [
      { type: 'section', text: 'projetos', count: 0 },
      { type: 'text', style: 'faint', text: 'nenhum projeto flutter nas pastas da lateral nem no painel em foco' },
    ];
  }
  const focus = sidebarFocus();
  // Os worktrees vão embaixo do app da pasta principal, quando ele está na
  // lista; a família fica onde o primeiro dela estaria (o do painel em foco,
  // o que roda…). Uma Maestria sem a seta (`blocks` < 2) desenha tudo solto.
  const tree = ui >= 2;
  const inList = new Set(roots);
  const parentOf = (r) => {
    const p = placement.get(r)?.parent;
    return tree && p && inList.has(p) ? p : null;
  };
  const tops = [];
  const kids = new Map();
  for (const r of roots) {
    const p = parentOf(r);
    if (!p) {
      if (!kids.has(r)) {
        tops.push(r);
        kids.set(r, []);
      }
      continue;
    }
    if (!kids.has(p)) {
      tops.push(p);
      kids.set(p, []);
    }
    kids.get(p).push(r);
  }
  const seen = {};
  for (const r of tops) seen[fullName(r)] = (seen[fullName(r)] || 0) + 1;
  rootsByKey.clear();
  const item = (r, { title, indent, children }) => {
    const k = keyOf(r);
    rootsByKey.set(k, r);
    const s = sessions.get(r);
    const st = s ? s.shortState() : { text: 'parado', icon: 'dot', tone: 'faint' };
    const out = {
      title,
      subtitle: st.text,
      icon: st.icon,
      tone: st.tone,
      indent: indent || undefined,
      badge: r === focus && roots.length > 1 ? 'ativo' : undefined,
      action: `abrir:${k}`,
      actions: s && s.running
        ? [{ action: `parar:${k}`, icon: 'stop', tooltip: 'parar', tone: 'red' }]
        : [{ action: `iniciar:${k}`, icon: 'play', tooltip: 'iniciar', tone: 'green' }],
    };
    if (children && children.length) {
      out.expanded = !collapsed.has(r);
      out.toggle = `recolher:${k}`;
      // Recolhido, a linha do app ainda diz o que roda e quem é o ativo lá dentro.
      if (!out.expanded) {
        const on = children.filter((c) => sessions.get(c)?.running).length;
        if (on) out.subtitle += ` · ${on === 1 ? '1 worktree rodando' : `${on} worktrees rodando`}`;
        if (children.includes(focus) && roots.length > 1) out.badge = 'ativo';
      }
    }
    return out;
  };
  const items = [];
  for (const r of tops) {
    const name = fullName(r);
    const children = kids.get(r);
    // Dois checkouts soltos do mesmo app têm o mesmo nome: a pasta de cima desempata.
    items.push(item(r, { title: seen[name] > 1 ? `${name} · ${path.basename(path.dirname(r))}` : name, children }));
    if (collapsed.has(r)) continue;
    for (const c of children) items.push(item(c, { title: placement.get(c).label, indent: 1 }));
  }
  const out = [
    { type: 'section', text: 'projetos', count: roots.length },
    { type: 'list', flat: true, items },
  ];
  const s = focus && sessions.get(focus);
  if (s) out.push({ type: 'section', text: s.name }, ...s.sidebarBlocks());
  return out;
}

/** Vários eventos seguidos (o progresso do build) viram um desenho só. */
function scheduleSidebar() {
  if (!sidebarTimer) sidebarTimer = setTimeout(pushSidebar, 60);
}

async function pushSidebar() {
  clearTimeout(sidebarTimer);
  sidebarTimer = null;
  const b = badge();
  if (!sidebarShown) {
    // Escondida, só o selo — e só quando ele muda.
    if (b === lastBadge) return;
    lastBadge = b;
    await mx.request('sidebar.update', { badge: b }).catch(() => {});
    return;
  }
  // O projeto de baixo precisa da central dele pro aparelho e o estado. Só
  // com a aba na tela: criar uma central pergunta os aparelhos ao flutter.
  const focus = sidebarFocus();
  if (focus && !sessions.has(focus)) ensureSession(focus);
  lastBadge = b;
  const r = await mx.request('sidebar.update', { blocks: sidebarBlocks(), badge: b }).catch(() => null);
  if (r && r.shown === false) sidebarShown = false;
}

Session.onChange = scheduleSidebar;

mx.onNotification('event', async (e) => {
  if (e.type === 'sidebar.shown') {
    sidebarShown = true;
    // Cada clique no ícone relê as pastas; o painel em foco vem primeiro.
    const focused = await mx.request('sessions.focused').catch(() => null);
    sidebarRoots = await candidates(focused ? { cwd: focused.cwd } : null).catch(() => sidebarRoots);
    await pushSidebar();
  } else if (e.type === 'sidebar.hidden') {
    sidebarShown = false;
  }
});

/** Um clique na aba: nas linhas dos projetos, ou no projeto de baixo. */
async function sidebarAct(action, values) {
  const [verb, key] = action.split(':');
  const root = key && rootsByKey.get(key);
  if (root && verb === 'recolher') {
    toggleCollapsed(root);
    await pushSidebar();
    return;
  }
  if (root) {
    const s = sessionFor(root);
    if (verb === 'abrir') await s.openView();
    else if (verb === 'iniciar') {
      if (!s.viewOpen) await s.openView();
      await s.start();
    } else if (verb === 'parar') await s.stop();
    scheduleSidebar();
    return;
  }
  const focus = sidebarFocus();
  if (!focus) return;
  const s = sessionFor(focus);
  if (action === 'central') await s.openView();
  else {
    // Iniciar pela aba abre a central, como o F5: o console é lá.
    if (action === 'iniciar' && !s.viewOpen) await s.openView();
    await s.act(action, values);
  }
  scheduleSidebar();
}

mx.onRequest('initialize', (params) => {
  settings.set(params.settings);
  DevTools.rfw = !!params.rfw;
  ui = Number(params.blocks) || 1;
  return {};
});

// Uma cor trocada nas configurações recolore todos os consoles abertos.
mx.onNotification('settings.changed', (params) => {
  settings.set(params.settings);
  for (const s of sessions.values()) s.render({ withLines: true });
});

mx.onRequest('command.invoke', async ({ command, context }) => {
  switch (command) {
    case 'central': {
      const root = await pickProject(context);
      if (root) await sessionFor(root).openView();
      break;
    }
    case 'iniciar': {
      let s = target(context);
      if (s && s.pause) {
        await s.debugStep('continue');
        break;
      }
      if (!s) {
        const root = await pickProject(context);
        if (!root) break;
        s = sessionFor(root);
      }
      if (!s.viewOpen) await s.openView();
      await s.start();
      break;
    }
    case 'parar':
      await withTarget(context, (s) => s.stop());
      break;
    case 'reload':
      await withTarget(context, (s) => s.hotReload());
      break;
    case 'restart':
      await withTarget(context, (s) => s.hotRestart());
      break;
    case 'pausar':
      await withTarget(context, (s) => s.debugStep('pause'));
      break;
    case 'over':
      await withTarget(context, (s) => s.debugStep('Over'));
      break;
    case 'into':
      await withTarget(context, (s) => s.debugStep('Into'));
      break;
    case 'out':
      await withTarget(context, (s) => s.debugStep('Out'));
      break;
    case 'devtools':
      await withTarget(context, (s) => s.openDevtools());
      break;
    case 'devtools-navegador':
      await withTarget(context, (s) => s.openDevtoolsBrowser());
      break;
    default:
      throw new Error(`comando desconhecido: ${command}`);
  }
  // O comando pode ter trocado a central ativa, que é a de baixo na aba.
  scheduleSidebar();
  return null;
});

mx.onNotification('view.action', async ({ viewId, action, values }) => {
  if (viewId === 'sidebar') return sidebarAct(action, values || {});
  for (const s of sessions.values()) {
    if (s.panel.viewId === viewId) {
      active = s;
      await s.panel.act(action, values || {});
      return;
    }
    if (s.viewId !== viewId) continue;
    active = s;
    await s.act(action, values || {});
    scheduleSidebar();
    return;
  }
});

// Fechar a Maestria fecha os apps, como fechar o VS Code encerra as sessões
// de debug — um `flutter run` órfão segura o aparelho e a porta.
function killAll() {
  for (const s of sessions.values()) s.kill();
}
mx.onNotification('shutdown', () => {
  killAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  killAll();
  process.exit(0);
});
process.on('exit', killAll);

mx.start();
