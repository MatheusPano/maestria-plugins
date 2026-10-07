'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mx = require('./maestria');
const argo = require('./argo');
const layout = require('./layout');
const yaml = require('./yaml');
const keyring = require('./keyring');

const UI = path.join(__dirname, 'ui', 'argo.rfwtxt');
const LOG_FLUSH_MS = 150;
const HOME = 'home';
const SYNC_VIEW = 'kubesync';

const state = {
  settings: {},
  errors: new Map(),
  apps: new Map(),
  trees: new Map(),
  views: new Map(),
  syncTabs: new Map(),
  timer: null,
  gen: 0,
  rfw: false,
};

const rancher = () => Boolean(setting('rancherUrl', ''));
const setting = (id, fallback) => (state.settings[id] === undefined || state.settings[id] === '' ? fallback : state.settings[id]);

const HEALTH_ICON = { Healthy: 'check', Progressing: 'clock', Degraded: 'error', Suspended: 'pause', Missing: 'warning', Unknown: 'dot' };
const BLOCK_TONE = { green: 'green', yellow: 'yellow', red: 'red', purple: 'purple', faint: 'faint', accent: 'accent' };

const health = (app) => (app.status && app.status.health && app.status.health.status) || 'Unknown';
const sync = (app) => (app.status && app.status.sync && app.status.sync.status) || 'Unknown';
const operation = (app) => (app.status && app.status.operationState) || null;
const appNamespace = (app) => app.metadata.namespace || setting('namespace', 'argocd');
const appPath = (app) => `/applications/${appNamespace(app)}/${app.metadata.name}`;
const appKey = (cluster, app) => `${cluster}|${appNamespace(app)}|${app.metadata.name}`;
const treeKey = (cluster, ns, name) => `${cluster}|${ns}|${name}`;
const source = (app) => app.spec.source || (app.spec.sources && app.spec.sources[0]) || {};

function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `${Math.floor(s / 60)} min atrás`;
  if (s < 86400) return `${Math.floor(s / 3600)} h atrás`;
  return `${Math.floor(s / 86400)} d atrás`;
}

function short(rev) {
  return rev ? String(rev).slice(0, 8) : '—';
}

function repoName(url) {
  return (url || '').replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

function applyConfig() {
  argo.configure({
    namespace: setting('namespace', 'argocd'),
    username: setting('username', 'admin'),
    kubectl: setting('kubectl', 'kubectl'),
    kubeDir: setting('kubeDir', '~/.kube/clusters'),
    tlsDir: setting('tlsDir', ''),
  });
}

function rfw(root) {
  return { library: fs.readFileSync(UI, 'utf8'), root };
}

const OUTDATED = [
  { type: 'heading', text: 'Este MaestrIA não desenha a tela do ArgoCD' },
  { type: 'text', text: 'As telas do plugin precisam do MaestrIA 2.4 ou mais novo. Se ele já foi atualizado, feche e abra o app de novo.' },
];

async function openRfwView(viewId, title, root, data) {
  if (!state.rfw) return mx.request('view.open', { viewId, title, blocks: OUTDATED });
  return mx.request('view.open', { viewId, title, rfw: rfw(root), data });
}

function onDrop(cluster, why) {
  state.errors.set(cluster, why ? `conexão caiu: ${why}` : 'conexão caiu');
  renderSidebar();
  for (const [viewId, v] of state.views) if (v.cluster === cluster) render(viewId);
}

async function connect(cluster) {
  if (argo.isOpen(cluster)) return argo.open(cluster, onDrop);
  state.errors.delete(cluster);
  renderSidebar();
  try {
    const conn = await argo.open(cluster, onDrop);
    renderSidebar();
    return conn;
  } catch (e) {
    state.errors.set(cluster, e.message);
    renderSidebar();
    if ((e.code === 'expired' || e.code === 'nokube') && rancher()) offerSync(cluster, e.message);
    else await mx.request('window.showBanner', { text: `argocd de ${cluster}: ${e.message}` });
    return null;
  }
}

async function offerSync(cluster, message) {
  const choice = await mx.request('window.pick', {
    title: message,
    items: [
      { value: 'sync', label: 'rodar rancher-kubeconfig-sync agora', detail: `baixa um kubeconfig novo de ${cluster}` },
      { value: 'no', label: 'agora não' },
    ],
  });
  if (choice === 'sync') runKubeconfigSync(cluster);
}

const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function syncFinished(cluster) {
  if (cluster) state.errors.delete(cluster);
  else state.errors.clear();
  renderSidebar();
  const home = state.views.get(HOME);
  if (home) render(HOME);
}

function syncInBackground(cluster, env, user) {
  if (state.syncing) return mx.request('window.showBanner', { text: 'já tem uma sincronização rodando' });
  state.syncing = true;
  mx.request('window.showBanner', { text: `baixando ${cluster ? `o kubeconfig de ${cluster}` : 'os kubeconfigs'} do Rancher…` });
  const proc = spawn('bash', [path.join(__dirname, 'bin', 'rancher-kubeconfig-sync'), ...(cluster ? [cluster] : [])], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  const lastLine = (text) => text.trim().split('\n').filter(Boolean).pop() || '';
  const done = async (code, why) => {
    state.syncing = false;
    if (code !== 0 && /HTTP 401/.test(err)) {
      await keyring.forget(rancherAccount(user));
      await mx.request('window.showBanner', { text: 'o Rancher recusou a senha guardada — digite de novo' });
      return runKubeconfigSync(cluster);
    }
    if (code === 0) mx.request('window.showBanner', { text: lastLine(out) || 'kubeconfigs atualizados' });
    else mx.request('window.showBanner', { text: `sincronização falhou: ${why || lastLine(err) || lastLine(out) || `código ${code}`}`, sticky: true });
    syncFinished(cluster);
  };
  proc.on('error', (e) => done(1, e.message));
  proc.on('exit', (code) => done(code));
}

function rancherUser() {
  const saved = setting('rancherUser', '');
  if (saved) return saved;
  try {
    const dir = process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config');
    return fs.readFileSync(path.join(dir, 'rancher', 'username'), 'utf8').trim();
  } catch {
    return '';
  }
}

const rancherAccount = (user) => `${user}@${setting('rancherUrl', '')}`;

async function runKubeconfigSync(cluster) {
  const url = setting('rancherUrl', '');
  if (!url) {
    await mx.request('window.showBanner', { text: 'configure a URL do Rancher nas configurações do plugin pra baixar os kubeconfigs' });
    return;
  }
  const remember = setting('rancherRemember', false);
  const user = rancherUser();
  const env = { RANCHER_URL: url, RANCHER_INSECURE: setting('rancherInsecure', false) ? '1' : '0', KUBECONFIG_DIR: argo.kubeDir() };
  if (setting('rancherUser', '')) env.RANCHER_USER = user;
  if (remember && user) {
    const password = await keyring.lookup(rancherAccount(user));
    if (password) return syncInBackground(cluster, { ...env, RANCHER_USER: user, RANCHER_PASSWORD: password }, user);
  }
  if (remember) env.RANCHER_REMEMBER = '1';
  const assign = Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`);
  const script = quote(path.join(__dirname, 'bin', 'rancher-kubeconfig-sync'));
  const { tabId } = await mx.request('session.openShell', {
    command: `env ${assign.join(' ')} bash ${script}${cluster ? ` ${quote(cluster)}` : ''}`,
    label: cluster ? `kubeconfig · ${cluster}` : 'kubeconfig · todos',
    embedded: true,
  });
  state.syncTabs.set(tabId, cluster || null);
  await mx.request('view.open', {
    viewId: SYNC_VIEW,
    title: cluster ? `sincronizar ${cluster}` : 'sincronizar kubeconfigs',
    modal: true,
    blocks: [
      { type: 'text', style: 'dim', text: `Rancher ${url} → ${argo.kubeDir()}` },
      { type: 'terminal', tabId, expand: true, autofocus: true, empty: 'terminal encerrado' },
    ],
  });
}

async function openInBrowser(cluster, app) {
  const conn = await connect(cluster);
  if (!conn) return;
  try {
    const url = await argo.browserUrl(conn, app ? appPath(app) : '/applications');
    await mx.request('window.openUrl', { url });
    if (argo.tlsWarning()) await mx.request('window.showBanner', { text: argo.tlsWarning(), sticky: true });
  } catch (e) {
    await mx.request('window.showBanner', { text: `não abri o navegador: ${e.message}` });
  }
}

async function loadApps(cluster) {
  const conn = await connect(cluster);
  if (!conn) return null;
  try {
    const res = await argo.api(conn, 'GET', '/api/v1/applications');
    const items = ((res && res.items) || []).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
    state.apps.set(cluster, items);
    state.errors.delete(cluster);
    return items;
  } catch (e) {
    state.errors.set(cluster, e.message);
    return null;
  }
}

async function loadTree(cluster, ns, name) {
  const conn = await connect(cluster);
  if (!conn) return null;
  const key = treeKey(cluster, ns, name);
  const entry = state.trees.get(key) || {};
  const q = `?appNamespace=${encodeURIComponent(ns)}`;
  const base = `/api/v1/applications/${encodeURIComponent(name)}`;
  try {
    const [app, tree] = await Promise.all([argo.api(conn, 'GET', base + q), argo.api(conn, 'GET', `${base}/resource-tree${q}`)]);
    Object.assign(entry, { app, tree, idx: layout.index(app, tree), error: null });
  } catch (e) {
    entry.error = e.message;
  }
  state.trees.set(key, entry);
  return entry;
}

function findApp(cluster, ns, name) {
  const fromList = (state.apps.get(cluster) || []).find((a) => a.metadata.name === name && appNamespace(a) === ns);
  if (fromList) return fromList;
  const entry = state.trees.get(treeKey(cluster, ns, name));
  return (entry && entry.app) || { metadata: { name, namespace: ns }, spec: {} };
}

// cluster

function tileData(cluster, app) {
  const op = operation(app);
  const src = source(app);
  const key = appKey(cluster, app);
  const running = op && op.phase === 'Running';
  const failed = op && (op.phase === 'Failed' || op.phase === 'Error');
  return {
    name: app.metadata.name,
    a: `app:${key}`,
    icon: HEALTH_ICON[health(app)] || 'dot',
    health: layout.healthTone(health(app)),
    healthText: health(app),
    sync: layout.syncTone(sync(app)),
    syncText: sync(app),
    op: running ? 'sincronizando' : failed ? 'sync falhou' : '',
    opTone: running ? 'accent' : 'red',
    rows: [
      { k: 'projeto', v: app.spec.project || '—' },
      { k: 'namespace', v: (app.spec.destination && app.spec.destination.namespace) || '—' },
      { k: 'repo', v: repoName(src.repoURL) || '—' },
      { k: 'alvo', v: `${src.chart || src.path || '.'} @ ${src.targetRevision || 'HEAD'}` },
      { k: 'último sync', v: ago(op && (op.finishedAt || op.startedAt)) },
    ],
    sync_a: `sync:${key}`,
    refresh_a: `refresh:${key}`,
    browser_a: `browser:${key}`,
  };
}

function clusterTile(c) {
  const on = argo.isOpen(c);
  const busy = argo.isConnecting(c);
  const error = state.errors.get(c) || '';
  const apps = state.apps.get(c);
  const bad = apps ? apps.filter((a) => sync(a) !== 'Synced' || health(a) !== 'Healthy').length : 0;
  return {
    name: c,
    a: `pick:${c}`,
    status: on ? 'green' : busy ? 'yellow' : error ? 'red' : 'none',
    sub: busy ? 'conectando…' : error && !on ? error : on && apps ? `${apps.length} apps${bad ? ` · ${bad} com atenção` : ''}` : on ? 'conectado' : '',
    subTone: error && !on ? 'red' : bad ? 'yellow' : '',
    buttons: [
      { icon: 'globe', tip: 'abrir no navegador', a: `browserCluster:${c}` },
      ...(rancher() ? [{ icon: 'sync', tip: 'sincronizar o kubeconfig (rancher)', a: `kubesync:${c}` }] : []),
      ...(on ? [{ icon: 'stop', tip: 'desconectar', a: `disconnect:${c}` }] : []),
    ],
  };
}

function homeData(v) {
  const list = argo.clusters();
  const connected = list.filter(argo.isOpen).length;
  return {
    head: {
      title: 'ArgoCD',
      sub: `${list.length} clusters${connected ? ` · ${connected} conectado${connected > 1 ? 's' : ''}` : ''}`,
      buttons: [
        { icon: 'search', tip: 'abrir um cluster pelo nome', a: 'pickCluster', tone: '' },
        ...(rancher() ? [{ icon: 'sync', tip: 'sincronizar todos os kubeconfigs (rancher)', a: 'kubesync:', tone: '' }] : []),
      ],
    },
    crumb: { cluster: '' },
    stats: [],
    notice: { text: list.length ? '' : `nenhum kubeconfig em ${argo.kubeDir()} — configure a pasta nas configurações ou sincronize pelo Rancher`, tone: 'yellow' },
    clusters: list.map(clusterTile),
    apps: [],
  };
}

function clusterData(v) {
  const cluster = v.cluster;
  if (!cluster) return homeData(v);
  const apps = state.apps.get(cluster) || [];
  const error = state.errors.get(cluster) || '';
  const outOfSync = apps.filter((a) => sync(a) !== 'Synced').length;
  const unhealthy = apps.filter((a) => health(a) !== 'Healthy').length;
  const filter = (v.filter || '').toLowerCase();
  const shown = apps.filter(
    (a) =>
      (!filter || a.metadata.name.toLowerCase().includes(filter)) &&
      (v.only !== 'outofsync' || sync(a) !== 'Synced') &&
      (v.only !== 'unhealthy' || health(a) !== 'Healthy'),
  );
  const stats = [
    { text: `${apps.length} apps`, tone: v.only ? 'faint' : 'accent', a: 'only:' },
    { text: `${outOfSync} fora de sync`, tone: v.only === 'outofsync' ? 'accent' : outOfSync ? 'yellow' : 'green', a: 'only:outofsync' },
    { text: `${unhealthy} com problema`, tone: v.only === 'unhealthy' ? 'accent' : unhealthy ? 'red' : 'green', a: 'only:unhealthy' },
  ];
  if (v.filter) stats.push({ text: `"${v.filter}" ✕`, tone: 'faint', a: 'clearfilter' });
  return {
    head: {
      title: cluster,
      sub: argo.isOpen(cluster) ? `argocd · ${shown.length} de ${apps.length} apps` : 'conectando…',
      buttons: [
        { icon: 'search', tip: 'filtrar por nome', a: 'search', tone: v.filter ? 'accent' : '' },
        { icon: 'refresh', tip: 'recarregar', a: `reload:${cluster}`, tone: '' },
        { icon: 'globe', tip: 'abrir no navegador', a: `browserCluster:${cluster}`, tone: '' },
      ],
    },
    crumb: { cluster },
    stats,
    notice: { text: error, tone: 'red' },
    clusters: [],
    apps: shown.map((a) => tileData(cluster, a)),
  };
}

async function openHome(cluster) {
  const v = state.views.get(HOME) || { type: 'cluster', cluster: '', filter: '', only: '' };
  if (cluster !== undefined && cluster !== v.cluster) Object.assign(v, { cluster, filter: '', only: '' });
  state.views.set(HOME, v);
  await openRfwView(HOME, 'ArgoCD', 'home', clusterData(v));
  if (v.cluster) {
    await loadApps(v.cluster);
    await render(HOME);
  }
  ensureTimer();
}

async function openCluster(cluster, where) {
  if ((where || setting('open', 'maestria')) === 'browser') return openInBrowser(cluster);
  return openHome(cluster);
}

// app

function appData(v) {
  const entry = state.trees.get(treeKey(v.cluster, v.ns, v.app)) || {};
  const app = entry.app;
  if (!app) {
    return {
      head: { title: v.app, sub: `${v.cluster} · carregando…`, buttons: [] },
      stats: [],
      notice: { text: entry.error || '', tone: 'red' },
      graph: { nodes: [], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', w: 1.5, h: 1.5 },
    };
  }
  const key = appKey(v.cluster, app);
  const src = source(app);
  const op = operation(app);
  const g = layout.graph(app, entry.tree, { showOld: v.showOld, selected: v.selected });
  const notices = [];
  if (entry.error) notices.push(entry.error);
  if (op && op.phase !== 'Succeeded' && op.message) notices.push(`${op.phase}: ${op.message}`);
  for (const c of (app.status && app.status.conditions) || []) notices.push(`${c.type}: ${c.message}`);
  const stats = [
    { text: health(app), tone: layout.healthTone(health(app)), a: 'res:app' },
    { text: sync(app), tone: layout.syncTone(sync(app)), a: 'res:app' },
    { text: `${((app.status && app.status.resources) || []).length} recursos`, tone: 'faint', a: '' },
    { text: `auto-sync ${app.spec.syncPolicy && app.spec.syncPolicy.automated ? 'ligado' : 'desligado'}`, tone: 'faint', a: '' },
  ];
  if (op) stats.push({ text: `último sync ${ago(op.finishedAt || op.startedAt)}`, tone: op.phase === 'Running' ? 'accent' : 'faint', a: '' });
  return {
    head: {
      title: app.metadata.name,
      sub: `${v.cluster} · ${repoName(src.repoURL)} · ${src.chart || src.path || '.'} @ ${src.targetRevision || 'HEAD'} (${short(app.status && app.status.sync && app.status.sync.revision)})`,
      buttons: [
        { icon: 'stack', tip: v.showOld ? 'esconder replicasets antigos' : 'mostrar replicasets antigos', a: 'toggleOld', tone: v.showOld ? 'accent' : '' },
        { icon: 'sync', tip: 'sincronizar', a: `sync:${key}`, tone: '' },
        { icon: 'refresh', tip: 'refresh', a: `refresh:${key}`, tone: '' },
        { icon: 'globe', tip: 'abrir no navegador', a: `browser:${key}`, tone: '' },
      ],
    },
    stats,
    notice: { text: notices.join('\n'), tone: notices.length && (entry.error || (op && op.phase !== 'Running')) ? 'red' : 'yellow' },
    graph: { nodes: g.nodes, svg: g.svg, w: g.w, h: g.h },
  };
}

async function openApp(cluster, name, ns) {
  const viewId = `a:${cluster}:${ns}:${name}`;
  const v = state.views.get(viewId) || { type: 'app', cluster, app: name, ns, showOld: false, selected: null };
  state.views.set(viewId, v);
  await openRfwView(viewId, `${name} · ${v.cluster}`, 'tree', appData(v));
  await loadTree(cluster, ns, name);
  await render(viewId);
  ensureTimer();
}

// recurso

function resNode(v) {
  const entry = state.trees.get(treeKey(v.cluster, v.ns, v.app)) || {};
  if (v.uid === 'app') return { entry, node: null };
  return { entry, node: (entry.idx && entry.idx.nodes.get(v.uid)) || v.node };
}

function podsOf(v) {
  const { entry } = resNode(v);
  if (!entry.idx) return [];
  if (v.uid === 'app') return [...entry.idx.nodes.values()].filter((n) => n.kind === 'Pod');
  return layout.descendants(entry.idx, v.uid, 'Pod');
}

function resTitle(v) {
  const { node } = resNode(v);
  return node ? `${node.kind}/${node.name}` : v.app;
}

function summaryBlocks(v) {
  const { entry, node } = resNode(v);
  if (!node) {
    const app = entry.app;
    if (!app) return [{ type: 'text', style: 'dim', text: 'carregando…' }];
    const src = source(app);
    const op = operation(app);
    return [
      {
        type: 'kv',
        items: [
          { key: 'projeto', value: app.spec.project || '—' },
          { key: 'repo', value: src.repoURL || '—' },
          { key: src.chart ? 'chart' : 'path', value: src.chart || src.path || '—' },
          { key: 'revisão alvo', value: src.targetRevision || 'HEAD' },
          { key: 'sincronizado em', value: short(app.status && app.status.sync && app.status.sync.revision) },
          { key: 'destino', value: [app.spec.destination.server || app.spec.destination.name, app.spec.destination.namespace].filter(Boolean).join(' · ') },
          { key: 'auto-sync', value: app.spec.syncPolicy && app.spec.syncPolicy.automated ? 'ligado' : 'desligado' },
          { key: 'última operação', value: op ? `${op.phase} · ${ago(op.finishedAt || op.startedAt)}` : '—' },
        ],
      },
      ...(op && op.message ? [{ type: 'text', style: op.phase === 'Succeeded' ? 'dim' : 'warning', text: op.message }] : []),
    ];
  }
  const syncState = entry.idx && entry.idx.syncOf.get(layout.resKey(node));
  const h = (node.health && node.health.status) || '—';
  const items = [
    { key: 'kind', value: node.group ? `${node.group}/${node.kind}` : node.kind },
    { key: 'nome', value: node.name },
    { key: 'namespace', value: node.namespace || '—' },
    { key: 'saúde', value: h, tone: BLOCK_TONE[layout.healthTone(h)] },
    { key: 'sync', value: (syncState && syncState.status) || '—', tone: syncState ? BLOCK_TONE[layout.syncTone(syncState.status)] : undefined },
  ];
  for (const i of node.info || []) items.push({ key: i.name.toLowerCase(), value: String(i.value) });
  if (node.images && node.images.length) items.push({ key: 'imagens', value: node.images.join('\n') });
  if (node.createdAt) items.push({ key: 'criado', value: `${new Date(node.createdAt).toLocaleString('pt-BR')} (${ago(node.createdAt)})` });
  const blocks = [{ type: 'kv', items }];
  if (node.health && node.health.message) blocks.push({ type: 'text', style: 'warning', text: node.health.message });
  const pods = podsOf(v);
  if (pods.length && node.kind !== 'Pod') {
    blocks.push({ type: 'section', text: 'pods', count: pods.length });
    blocks.push({
      type: 'list',
      items: pods.map((p) => {
        const ph = (p.health && p.health.status) || 'Unknown';
        return {
          title: p.name,
          subtitle: layout.info(p, 'Status Reason') || ph,
          icon: HEALTH_ICON[ph] || 'dot',
          tone: BLOCK_TONE[layout.healthTone(ph)],
          action: `podlogs:${p.uid}`,
          actions: [{ action: `podlogs:${p.uid}`, icon: 'terminal', tooltip: 'logs' }],
        };
      }),
    });
  }
  return blocks;
}

function eventBlocks(v) {
  if (v.events === undefined) return [{ type: 'progress', label: 'carregando eventos…' }];
  if (v.eventsError) return [{ type: 'text', style: 'error', text: v.eventsError }];
  return [
    {
      type: 'list',
      empty: 'nenhum evento (o kubernetes guarda só a última hora)',
      items: v.events.map((e) => {
        const when = e.lastTimestamp || e.eventTime || (e.metadata && e.metadata.creationTimestamp);
        const warn = e.type === 'Warning';
        return {
          title: e.reason || e.type,
          subtitle: `${e.involvedObject ? `${e.involvedObject.kind}/${e.involvedObject.name} · ` : ''}${e.message || ''}`,
          icon: warn ? 'warning' : 'info',
          tone: warn ? 'yellow' : 'faint',
          meta: `${e.count > 1 ? `${e.count}× · ` : ''}${ago(when)}`,
        };
      }),
    },
  ];
}

function manifestBlocks(v) {
  if (v.manifest === undefined) return [{ type: 'progress', label: 'carregando manifesto…' }];
  if (v.manifestError) return [{ type: 'text', style: 'error', text: v.manifestError }];
  return [{ type: 'code', text: v.manifest }];
}

function logBlocks(v) {
  const pods = podsOf(v);
  if (!pods.length) return [{ type: 'text', style: 'dim', text: 'nenhum pod debaixo deste recurso' }];
  const controls = [];
  if (pods.length > 1) {
    controls.push({ type: 'select', id: 'pod', label: 'pod', value: v.pod, options: pods.map((p) => p.name), action: 'logpod' });
  }
  if ((v.containers || []).length > 1) {
    controls.push({ type: 'select', id: 'container', label: 'container', value: v.container, options: v.containers, action: 'logcontainer' });
  }
  const blocks = [];
  if (controls.length) blocks.push({ type: 'columns', children: controls });
  blocks.push({
    type: 'row',
    children: [
      { type: 'text', style: 'faint', text: v.pod ? `${v.pod}${v.container ? ` · ${v.container}` : ''} — kubectl logs -f --tail=${setting('tail', 500)}` : '' },
      { type: 'button', action: 'logrestart', icon: 'restart', tooltip: 'recomeçar', style: 'icon' },
    ],
    align: 'between',
  });
  blocks.push({ type: 'console', id: v.logId || 'log', expand: true, max: Number(setting('maxLines', 5000)), empty: 'esperando o log…' });
  return blocks;
}

function resBlocks(v) {
  const { entry, node } = resNode(v);
  const app = entry.app;
  const h = node ? (node.health && node.health.status) || '' : app ? health(app) : '';
  const syncState = node && entry.idx && entry.idx.syncOf.get(layout.resKey(node));
  const pods = podsOf(v);
  const tabs = [
    { label: 'resumo', action: 'tab:resumo', active: v.tab === 'resumo' },
    ...(pods.length ? [{ label: 'logs', action: 'tab:logs', active: v.tab === 'logs', icon: 'terminal' }] : []),
    { label: 'eventos', action: 'tab:eventos', active: v.tab === 'eventos', count: v.events ? v.events.length : undefined },
    { label: 'manifesto', action: 'tab:manifesto', active: v.tab === 'manifesto' },
  ];
  const tone = BLOCK_TONE[layout.healthTone(h)];
  const blocks = [
    {
      type: 'header',
      title: node ? node.name : v.app,
      subtitle: [node ? node.kind : 'Application', node && node.namespace, h, syncState && syncState.status].filter(Boolean).join(' · '),
      tone,
      avatar: { text: layout.abbr(node ? node.kind : 'Application'), color: tone },
      actions: [{ action: 'resreload', icon: 'refresh', tooltip: 'recarregar' }],
    },
    { type: 'tabs', items: tabs },
  ];
  if (v.tab === 'logs') blocks.push(...logBlocks(v));
  else if (v.tab === 'eventos') blocks.push(...eventBlocks(v));
  else if (v.tab === 'manifesto') blocks.push(...manifestBlocks(v));
  else blocks.push(...summaryBlocks(v));
  return blocks;
}

async function loadEvents(v) {
  const conn = await connect(v.cluster);
  if (!conn) return;
  const { node } = resNode(v);
  const params = new URLSearchParams({ appNamespace: v.ns });
  if (node) {
    params.set('resourceName', node.name);
    if (node.namespace) params.set('resourceNamespace', node.namespace);
    if (!String(node.uid).startsWith('missing:')) params.set('resourceUID', node.uid);
  }
  try {
    const res = await argo.api(conn, 'GET', `/api/v1/applications/${encodeURIComponent(v.app)}/events?${params}`);
    const items = (res && res.items) || [];
    const when = (e) => new Date(e.lastTimestamp || e.eventTime || (e.metadata && e.metadata.creationTimestamp) || 0).getTime();
    v.events = items.sort((a, b) => when(b) - when(a));
    v.eventsError = null;
  } catch (e) {
    v.events = v.events || [];
    v.eventsError = e.message;
  }
}

function maskSecret(obj) {
  for (const field of ['data', 'stringData']) {
    if (obj[field]) for (const k of Object.keys(obj[field])) obj[field][k] = '••••••';
  }
  if (obj.metadata && obj.metadata.annotations) delete obj.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
  return obj;
}

async function fetchLive(v, node) {
  const conn = await connect(v.cluster);
  if (!conn) throw new Error('sem conexão');
  const params = new URLSearchParams({
    appNamespace: v.ns,
    namespace: node.namespace || '',
    resourceName: node.name,
    version: node.version || 'v1',
    group: node.group || '',
    kind: node.kind,
  });
  const res = await argo.api(conn, 'GET', `/api/v1/applications/${encodeURIComponent(v.app)}/resource?${params}`);
  return JSON.parse((res && res.manifest) || '{}');
}

async function loadManifest(v) {
  const { entry, node } = resNode(v);
  try {
    let obj;
    if (!node) {
      obj = JSON.parse(JSON.stringify(entry.app || {}));
      delete obj.status;
    } else {
      obj = await fetchLive(v, node);
    }
    if (obj.metadata) delete obj.metadata.managedFields;
    if (obj.kind === 'Secret') maskSecret(obj);
    v.manifest = yaml.dump(obj);
    v.manifestError = null;
  } catch (e) {
    v.manifest = '';
    v.manifestError = String(node && node.uid && String(node.uid).startsWith('missing:') ? 'o recurso não existe no cluster (Missing)' : e.message);
  }
}

function stopLogs(v) {
  if (v.logProc) {
    v.logProc.kill();
    v.logProc = null;
  }
  if (v.logTimer) {
    clearInterval(v.logTimer);
    v.logTimer = null;
  }
  v.logBuffer = [];
}

async function chooseContainers(v) {
  const pod = podsOf(v).find((p) => p.name === v.pod);
  v.containers = [];
  if (!pod) return;
  let main = [];
  try {
    const spec = (await fetchLive(v, pod)).spec || {};
    main = (spec.containers || []).map((c) => c.name);
    v.containers = [...main, ...(spec.initContainers || []).map((c) => c.name)];
  } catch (e) {
    mx.log('containers:', e.message);
  }
  if (!v.containers.includes(v.container)) v.container = main.find((c) => !/istio|linkerd|envoy/.test(c)) || main[0] || '';
}

async function startLogs(viewId) {
  const v = state.views.get(viewId);
  if (!v) return;
  stopLogs(v);
  const pods = podsOf(v);
  if (!pods.length) return render(viewId);
  if (!pods.find((p) => p.name === v.pod)) {
    const running = pods.find((p) => (p.health && p.health.status) === 'Healthy') || pods[0];
    v.pod = running.name;
  }
  await chooseContainers(v);
  const pod = pods.find((p) => p.name === v.pod);
  v.logId = `log:${++state.gen}`;
  await render(viewId);
  const config = argo.kubeconfig(v.cluster);
  const args = [`--kubeconfig=${config}`, 'logs', '-f', `--tail=${Number(setting('tail', 500))}`, '-n', pod.namespace, pod.name];
  if (v.container) args.push('-c', v.container);
  const proc = spawn(setting('kubectl', 'kubectl'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  v.logProc = proc;
  v.logBuffer = [];
  const logId = v.logId;
  const take = (tone) => {
    let rest = '';
    return (chunk) => {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop();
      for (const p of parts) v.logBuffer.push(tone ? { text: p, tone } : p);
    };
  };
  proc.stdout.on('data', take(null));
  proc.stderr.on('data', take('red'));
  proc.on('exit', (code) => {
    if (v.logProc === proc) v.logProc = null;
    v.logBuffer.push({ text: `— log encerrado${code ? ` (código ${code})` : ''} —`, tone: 'faint' });
  });
  v.logTimer = setInterval(async () => {
    if (!v.logBuffer.length) {
      if (!v.logProc) stopLogs(v);
      return;
    }
    const lines = v.logBuffer.splice(0);
    try {
      const { open } = await mx.request('view.appendLines', { viewId, id: logId, lines });
      if (!open) {
        stopLogs(v);
        state.views.delete(viewId);
      }
    } catch (e) {
      mx.log('appendLines:', e.message);
    }
  }, LOG_FLUSH_MS);
}

async function enterTab(viewId, tab) {
  const v = state.views.get(viewId);
  if (!v) return;
  if (v.tab === 'logs' && tab !== 'logs') stopLogs(v);
  v.tab = tab;
  if (tab === 'logs') return startLogs(viewId);
  await render(viewId);
  if (tab === 'eventos') await loadEvents(v);
  if (tab === 'manifesto') await loadManifest(v);
  await render(viewId);
}

async function openResource(appViewId, uid, tab) {
  const av = state.views.get(appViewId);
  if (!av) return;
  const entry = state.trees.get(treeKey(av.cluster, av.ns, av.app)) || {};
  const node = uid === 'app' ? null : entry.idx && entry.idx.nodes.get(uid);
  if (uid !== 'app' && !node) return;
  av.selected = uid;
  render(appViewId);
  const viewId = `r:${av.cluster}:${av.ns}:${av.app}:${uid}`;
  const existing = state.views.get(viewId);
  const v = existing || { type: 'res', cluster: av.cluster, ns: av.ns, app: av.app, uid, node, tab: 'resumo' };
  state.views.set(viewId, v);
  await mx.request('view.open', { viewId, title: `${resTitle(v)} · ${av.cluster}`, blocks: resBlocks(v) });
  ensureTimer();
  if (tab) await enterTab(viewId, tab);
}

// render

async function render(viewId) {
  const v = state.views.get(viewId);
  if (!v) return;
  const params = { viewId };
  if (v.type !== 'res' && !state.rfw) return;
  if (v.type === 'cluster') params.data = clusterData(v);
  else if (v.type === 'app') params.data = appData(v);
  else params.blocks = resBlocks(v);
  try {
    const { open } = await mx.request('view.update', params);
    if (!open) {
      if (v.type === 'res') stopLogs(v);
      state.views.delete(viewId);
    }
  } catch (e) {
    mx.log('view.update:', e.message);
  }
}

function sidebarBlocks() {
  const list = argo.clusters();
  const items = list.map((c) => {
    const error = state.errors.get(c);
    const on = argo.isOpen(c);
    const busy = argo.isConnecting(c);
    return {
      title: c,
      subtitle: busy ? 'conectando…' : on ? 'conectado' : error || '',
      subtitleTone: error && !on ? 'red' : undefined,
      icon: 'server',
      tone: on ? 'green' : error ? 'red' : 'faint',
      avatar: { icon: 'server', color: on ? 'green' : 'faint' },
      status: on ? 'green' : busy ? 'yellow' : error ? 'red' : undefined,
      action: `open:${c}`,
      actions: [
        { action: `browserCluster:${c}`, icon: 'globe', tooltip: 'abrir no navegador' },
        ...(on ? [{ action: `disconnect:${c}`, icon: 'stop', tooltip: 'desconectar' }] : []),
      ],
      menu: [
        { action: `here:${c}`, label: 'abrir no maestria', icon: 'open' },
        { action: `browserCluster:${c}`, label: 'abrir no navegador', icon: 'globe' },
        { type: 'divider' },
        ...(rancher() ? [{ action: `kubesync:${c}`, label: 'sincronizar kubeconfig', icon: 'sync' }] : []),
        { action: `disconnect:${c}`, label: 'desconectar', icon: 'stop', disabled: !on },
      ],
    };
  });
  return [
    { type: 'section', text: 'clusters', count: list.length },
    { type: 'list', flat: true, items, empty: `nenhum kubeconfig em ${argo.kubeDir()}` },
  ];
}

async function renderSidebar() {
  const home = state.views.get(HOME);
  if (home && !home.cluster) render(HOME);
  const connected = argo.clusters().filter(argo.isOpen).length;
  try {
    await mx.request('sidebar.update', { blocks: sidebarBlocks(), badge: connected ? String(connected) : null });
  } catch (e) {
    mx.log('sidebar.update:', e.message);
  }
}

function ensureTimer() {
  if (state.timer) return;
  const every = Math.max(2, Number(setting('refresh', 5))) * 1000;
  state.timer = setInterval(tick, every);
}

let ticking = false;

async function tick() {
  if (!state.views.size) {
    clearInterval(state.timer);
    state.timer = null;
    return;
  }
  if (ticking) return;
  ticking = true;
  try {
    const clusters = new Set();
    const trees = new Map();
    for (const v of state.views.values()) {
      if (v.type === 'cluster' && !v.cluster) continue;
      if (!argo.isOpen(v.cluster)) continue;
      if (v.type === 'cluster') clusters.add(v.cluster);
      else trees.set(treeKey(v.cluster, v.ns, v.app), v);
    }
    for (const c of clusters) await loadApps(c);
    for (const v of trees.values()) await loadTree(v.cluster, v.ns, v.app);
    for (const [viewId, v] of [...state.views]) {
      if (v.cluster && !argo.isOpen(v.cluster)) continue;
      if (v.type === 'res') {
        if (v.tab === 'logs' || v.tab === 'manifesto') continue;
        if (v.tab === 'eventos') await loadEvents(v);
      }
      await render(viewId);
    }
  } finally {
    ticking = false;
  }
}

async function rerenderCluster(cluster) {
  await loadApps(cluster);
  for (const [viewId, v] of [...state.views]) {
    if (v.cluster !== cluster) continue;
    if (v.type !== 'cluster') await loadTree(v.cluster, v.ns, v.app);
    if (v.type === 'res' && v.tab === 'logs') continue;
    await render(viewId);
  }
}

async function syncApp(cluster, ns, name) {
  const answer = await mx.request('window.pick', {
    title: `sincronizar ${name} (${cluster})?`,
    items: [
      { value: 'sync', label: 'sincronizar', detail: 'sem prune: nada é apagado do cluster' },
      { value: 'cancel', label: 'cancelar' },
    ],
  });
  if (answer !== 'sync') return;
  const conn = await connect(cluster);
  if (!conn) return;
  try {
    await argo.api(conn, 'POST', `/api/v1/applications/${encodeURIComponent(name)}/sync`, { appNamespace: ns, prune: false });
    await mx.request('window.showBanner', { text: `sync de ${name} iniciado` });
  } catch (e) {
    await mx.request('window.showBanner', { text: `sync de ${name} falhou: ${e.message}`, sticky: true });
  }
  await rerenderCluster(cluster);
}

async function refreshAppNow(cluster, ns, name) {
  const conn = await connect(cluster);
  if (!conn) return;
  try {
    await argo.api(conn, 'GET', `/api/v1/applications/${encodeURIComponent(name)}?refresh=normal&appNamespace=${encodeURIComponent(ns)}`);
  } catch (e) {
    await mx.request('window.showBanner', { text: `refresh de ${name} falhou: ${e.message}` });
  }
  await rerenderCluster(cluster);
}

async function pickCluster(title) {
  const list = argo.clusters();
  if (!list.length) {
    await mx.request('window.showBanner', { text: `nenhum kubeconfig em ${argo.kubeDir()} — configure a pasta nas configurações ou sincronize pelo Rancher` });
    return null;
  }
  return mx.request('window.pick', {
    title,
    placeholder: 'cluster',
    items: list.map((c) => ({ value: c, detail: argo.isOpen(c) ? 'conectado' : undefined })),
  });
}

async function viewAction(viewId, action, values) {
  const v = state.views.get(viewId);
  if (!v) return false;
  const i = action.indexOf(':');
  const verb = i < 0 ? action : action.slice(0, i);
  const arg = i < 0 ? '' : action.slice(i + 1);
  switch (verb) {
    case 'search': {
      const text = await mx.request('window.input', { title: 'filtrar apps', placeholder: 'parte do nome', value: v.filter || '' });
      v.filter = text || '';
      await render(viewId);
      return true;
    }
    case 'pick':
      await openHome(arg);
      return true;
    case 'home':
      await openHome('');
      return true;
    case 'pickCluster':
      pickCluster('abrir o argocd de qual cluster?').then((c) => c && openHome(c));
      return true;
    case 'clearfilter':
      v.filter = '';
      await render(viewId);
      return true;
    case 'only':
      v.only = v.only === arg ? '' : arg;
      await render(viewId);
      return true;
    case 'toggleOld':
      v.showOld = !v.showOld;
      await render(viewId);
      return true;
    case 'res':
      await openResource(viewId, arg);
      return true;
    case 'tab':
      await enterTab(viewId, arg);
      return true;
    case 'resreload':
      await loadTree(v.cluster, v.ns, v.app);
      if (v.tab === 'logs') await startLogs(viewId);
      else await enterTab(viewId, v.tab);
      return true;
    case 'logpod':
      v.pod = values.pod;
      await startLogs(viewId);
      return true;
    case 'logcontainer':
      v.container = values.container;
      await startLogs(viewId);
      return true;
    case 'logrestart':
      await startLogs(viewId);
      return true;
    case 'podlogs': {
      const pod = podsOf(v).find((p) => p.uid === arg);
      if (pod) v.pod = pod.name;
      await enterTab(viewId, 'logs');
      return true;
    }
  }
  return false;
}

async function onAction(viewId, action, values) {
  if (!action) return;
  if (await viewAction(viewId, action, values || {})) return;
  const i = action.indexOf(':');
  const verb = i < 0 ? action : action.slice(0, i);
  const arg = i < 0 ? '' : action.slice(i + 1);
  const [cluster, ns, name] = arg.split('|');
  switch (verb) {
    case 'open':
      return openCluster(cluster);
    case 'here':
      return openCluster(cluster, 'maestria');
    case 'browserCluster':
      return openInBrowser(cluster);
    case 'disconnect':
      argo.close(cluster);
      state.errors.delete(cluster);
      return renderSidebar();
    case 'kubesync':
      return runKubeconfigSync(cluster);
    case 'reload':
      state.errors.delete(cluster);
      return rerenderCluster(cluster);
    case 'app':
      return openApp(cluster, name, ns);
    case 'browser':
      return openInBrowser(cluster, findApp(cluster, ns, name));
    case 'sync':
      return syncApp(cluster, ns, name);
    case 'refresh':
      return refreshAppNow(cluster, ns, name);
  }
}

mx.onRequest('initialize', ({ settings, rfw: widgets }) => {
  state.settings = settings || {};
  state.rfw = Number(widgets) >= 1;
  applyConfig();
  return {};
});

mx.onNotification('settings.changed', ({ settings }) => {
  const before = { remember: setting('rancherRemember', false), account: rancherAccount(rancherUser()) };
  state.settings = settings || {};
  if (before.remember && !setting('rancherRemember', false)) keyring.forget(before.account);
  applyConfig();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
    ensureTimer();
  }
  renderSidebar();
  for (const viewId of state.views.keys()) render(viewId);
});

mx.onRequest('command.invoke', async ({ command }) => {
  if (command === 'clusters') {
    openHome();
  } else if (command === 'argo') {
    pickCluster('abrir o argocd de qual cluster?').then((c) => c && openCluster(c));
  } else if (command === 'navegador') {
    pickCluster('abrir no navegador o argocd de qual cluster?').then((c) => c && openInBrowser(c));
  } else if (command === 'kubeconfig') {
    runKubeconfigSync(null);
  }
  return null;
});

mx.onNotification('view.action', ({ viewId, action, values }) => {
  if (action === 'act') return onAction(viewId, values && (values.a || values.action), values);
  return onAction(viewId, action, values);
});

mx.onNotification('event', async (e) => {
  switch (e.type) {
    case 'sidebar.shown':
      return renderSidebar();
    case 'session.exited':
    case 'session.closed': {
      if (!state.syncTabs.has(e.tabId)) return;
      const cluster = state.syncTabs.get(e.tabId);
      state.syncTabs.delete(e.tabId);
      if (e.type === 'session.exited' && e.code === 0) setTimeout(() => mx.request('view.close', { viewId: SYNC_VIEW }).catch(() => {}), 1500);
      return syncFinished(cluster);
    }
  }
});

function shutdown() {
  for (const v of state.views.values()) if (v.type === 'res') stopLogs(v);
  argo.closeAll();
}

mx.onNotification('shutdown', () => {
  shutdown();
  process.exit(0);
});

process.on('exit', shutdown);

mx.start();
