'use strict';

const CARD_W = 236;
const CARD_H = 52;
const COL_GAP = 72;
const ROW_GAP = 14;

const HEALTH_TONE = { Healthy: 'green', Progressing: 'yellow', Degraded: 'red', Suspended: 'purple', Missing: 'yellow', Unknown: 'faint' };
const SYNC_TONE = { Synced: 'green', OutOfSync: 'yellow', Unknown: 'faint' };

const ABBR = {
  Application: 'app',
  Deployment: 'deploy',
  ReplicaSet: 'rs',
  Pod: 'pod',
  Service: 'svc',
  Ingress: 'ing',
  ConfigMap: 'cm',
  Secret: 'secret',
  SealedSecret: 'sealed',
  StatefulSet: 'sts',
  DaemonSet: 'ds',
  Job: 'job',
  CronJob: 'cj',
  PersistentVolumeClaim: 'pvc',
  PersistentVolume: 'pv',
  Endpoints: 'ep',
  EndpointSlice: 'eps',
  ServiceAccount: 'sa',
  HorizontalPodAutoscaler: 'hpa',
  ScaledObject: 'keda',
  Certificate: 'cert',
  CertificateRequest: 'certreq',
  Namespace: 'ns',
  Role: 'role',
  RoleBinding: 'rb',
  ClusterRole: 'crole',
  ClusterRoleBinding: 'crb',
  NetworkPolicy: 'netpol',
  PodDisruptionBudget: 'pdb',
};

const KIND_ORDER = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'CronJob',
  'Job',
  'Service',
  'Ingress',
  'Certificate',
  'HorizontalPodAutoscaler',
  'ScaledObject',
  'PersistentVolumeClaim',
  'ConfigMap',
  'Namespace',
  'ServiceAccount',
  'Role',
  'RoleBinding',
  'ClusterRole',
  'ClusterRoleBinding',
];
const KIND_LAST = ['SealedSecret', 'Secret'];

const abbr = (kind) => ABBR[kind] || kind.toLowerCase().slice(0, 6);
const resKey = (r) => `${r.group || ''}/${r.kind}/${r.namespace || ''}/${r.name}`;
const healthTone = (h) => HEALTH_TONE[h] || 'faint';
const syncTone = (s) => SYNC_TONE[s] || 'faint';
const half = (n) => Math.round(n) + 0.5;

function info(node, name) {
  const item = (node.info || []).find((i) => i.name === name);
  return item ? item.value : '';
}

function subtitle(node) {
  if (node.kind === 'Pod') {
    const parts = [info(node, 'Status Reason') || (node.health && node.health.status) || ''];
    const containers = info(node, 'Containers');
    if (containers) parts.push(containers);
    const restarts = Number(info(node, 'Restart Count'));
    if (restarts) parts.push(`${restarts} restarts`);
    return parts.filter(Boolean).join(' · ');
  }
  const rev = info(node, 'Revision');
  return [node.kind, (node.health && node.health.status) || '', rev].filter(Boolean).join(' · ');
}

function kindRank(kind) {
  const last = KIND_LAST.indexOf(kind);
  if (last >= 0) return KIND_ORDER.length + 1 + last;
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
}

function index(app, tree) {
  const nodes = new Map();
  for (const n of (tree && tree.nodes) || []) nodes.set(n.uid, n);
  const syncOf = new Map();
  for (const r of (app.status && app.status.resources) || []) syncOf.set(resKey(r), r);
  const present = new Set([...nodes.values()].map(resKey));
  for (const r of syncOf.values()) {
    if (present.has(resKey(r))) continue;
    const uid = `missing:${resKey(r)}`;
    nodes.set(uid, {
      uid,
      group: r.group,
      version: r.version,
      kind: r.kind,
      namespace: r.namespace,
      name: r.name,
      health: r.health || { status: 'Missing' },
    });
  }
  const children = new Map();
  const roots = [];
  for (const n of nodes.values()) {
    const parents = (n.parentRefs || []).map((p) => p.uid).filter((u) => nodes.has(u));
    if (!parents.length) roots.push(n);
    for (const p of parents) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(n);
    }
  }
  return { nodes, children, roots, syncOf };
}

function descendants(idx, uid, kind) {
  const out = [];
  const walk = (u) => {
    for (const c of idx.children.get(u) || []) {
      if (c.kind === kind) out.push(c);
      walk(c.uid);
    }
  };
  const self = idx.nodes.get(uid);
  if (self && self.kind === kind) out.push(self);
  walk(uid);
  return out;
}

function graph(app, tree, { showOld = false, selected = null } = {}) {
  const idx = index(app, tree);
  const sortNodes = (list) =>
    list
      .filter((n) => showOld || n.kind !== 'ReplicaSet' || (idx.children.get(n.uid) || []).length)
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  const placed = [];
  const edges = [];
  let row = 0;
  const place = (node, depth, kids) => {
    const x = depth * (CARD_W + COL_GAP);
    let y;
    if (!kids.length) {
      y = row * (CARD_H + ROW_GAP);
      row++;
    }
    const childPos = kids.map((k) => place(k, depth + 1, sortNodes(idx.children.get(k.uid) || [])));
    if (kids.length) y = (childPos[0].y + childPos[childPos.length - 1].y) / 2;
    for (const c of childPos) edges.push([x + CARD_W, y + CARD_H / 2, c.x, c.y + CARD_H / 2]);
    placed.push({ node, x, y });
    return { x, y };
  };

  const appHealth = (app.status && app.status.health && app.status.health.status) || 'Unknown';
  const appSync = (app.status && app.status.sync && app.status.sync.status) || 'Unknown';
  const appNode = { uid: 'app', kind: 'Application', name: app.metadata.name, health: { status: appHealth } };
  place(appNode, 0, sortNodes(idx.roots));

  const width = Math.max(...placed.map((p) => p.x)) + CARD_W + 2;
  const height = Math.max(CARD_H, row * (CARD_H + ROW_GAP) - ROW_GAP) + 2;
  const paths = edges
    .map(([x1, y1, x2, y2]) => {
      const mid = (x1 + x2) / 2;
      return `<path d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}"/>`;
    })
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g fill="none" stroke="#8a94a6" stroke-opacity="0.55" stroke-width="1.4">${paths}</g></svg>`;

  const nodes = placed.map(({ node, x, y }) => {
    const isApp = node.uid === 'app';
    const sync = isApp ? appSync : (idx.syncOf.get(resKey(node)) || {}).status || '';
    const health = (node.health && node.health.status) || '';
    return {
      x: half(x),
      y: half(y),
      title: node.name,
      abbr: abbr(node.kind),
      sub: isApp ? `${appHealth} · ${appSync}` : subtitle(node),
      health: health ? healthTone(health) : 'faint',
      sync: sync ? syncTone(sync) : 'none',
      sel: selected === node.uid,
      a: `res:${node.uid}`,
    };
  });

  return { nodes, svg, w: half(width), h: half(height), idx };
}

module.exports = { graph, index, descendants, resKey, abbr, healthTone, syncTone, info };
