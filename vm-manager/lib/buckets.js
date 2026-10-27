'use strict';

// Lógica da tela Buckets. Porta BucketsView.tsx, CreateBucketDialog.tsx e S3CredentialsDialog.tsx.

const { bytes, date, meterTone, meterWidth } = require('./format');

const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const NEW_OWNER = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const MASK = '•'.repeat(40);
const SECRET_PLACEHOLDER = '<secret key>';

const MSG = {
  name: 'Minúsculas, números e hífen; de 3 a 63 caracteres.',
  taken: 'Esse usuário já existe; escolha em Usuário existente.',
  newOwner: 'Usuário novo: minúsculas, números, _ e hífen; de 3 a 64 caracteres.',
  pick: 'Escolha o usuário do RGW',
};

const pt = (n) => n.toLocaleString('pt-BR');
const collator = new Intl.Collator('pt-BR', { numeric: true });

const DEFAULT_DIR = { bucket: 'asc', owner: 'asc', objects: 'desc', used: 'desc', quota: 'desc', created: 'desc' };
const COLUMNS = [
  { key: 'bucket', label: 'Bucket' },
  { key: 'owner', label: 'Dono' },
  { key: 'objects', label: 'Objetos' },
  { key: 'used', label: 'Usado' },
  { key: 'quota', label: 'Cota' },
  { key: 'created', label: 'Criado' },
];

const compareNames = (a, b) => collator.compare(a.tenant || '', b.tenant || '') || collator.compare(a.name, b.name);

function createdAt(b) {
  const time = b.createdAt ? Date.parse(b.createdAt) : NaN;
  return Number.isNaN(time) ? null : time;
}

const quotaRatio = (b) => (b.quotaBytes ? b.usedBytes / b.quotaBytes : null);

const number = (get) => (a, b, sign) => {
  const x = get(a);
  const y = get(b);
  // sem cota / sem data ficam no fim nos dois sentidos
  if (x == null || y == null) return (x == null ? 1 : 0) - (y == null ? 1 : 0);
  return (x - y) * sign;
};

const COMPARE = {
  bucket: (a, b, sign) => compareNames(a, b) * sign,
  owner: (a, b, sign) => collator.compare(a.owner, b.owner) * sign,
  objects: number((b) => b.objects),
  used: number((b) => b.usedBytes),
  quota: number(quotaRatio),
  created: number(createdAt),
};

function sortBuckets(list, key, dir) {
  const compare = COMPARE[key === 'name' ? 'bucket' : key] || COMPARE.bucket;
  const sign = dir === 'desc' ? -1 : 1;
  return [...(list || [])].sort((a, b) => compare(a, b, sign) || compareNames(a, b));
}

function nextSort(cur, key) {
  if (cur && cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: DEFAULT_DIR[key] || 'asc' };
}

function stats(list) {
  const l = list || [];
  return {
    buckets: l.length,
    used: l.reduce((s, b) => s + b.usedBytes, 0),
    objects: l.reduce((s, b) => s + b.objects, 0),
    owners: new Set(l.map((b) => b.owner)).size,
  };
}

function bucketRow(b) {
  const pct = b.quotaBytes ? Math.round((b.usedBytes / b.quotaBytes) * 100) : null;
  return {
    key: `${b.tenant || ''}/${b.name}`,
    tenant: b.tenant || '',
    name: b.name,
    owner: b.owner,
    objects: pt(b.objects),
    used: bytes(b.usedBytes),
    hasQuota: pct != null,
    quota: pct != null ? `${pct}% de ${bytes(b.quotaBytes)}` : 'sem cota',
    pct: pct == null ? 0 : pct,
    width: pct == null ? 0 : meterWidth(pct),
    tone: pct != null && pct >= 75 ? meterTone(pct) : 'accent',
    created: date(b.createdAt),
    actions: ['credentials'],
  };
}

// state: {buckets|null, error, query, sort:{key,dir}}
function bucketsView(state, { admin } = {}) {
  const s = state || {};
  const loaded = Array.isArray(s.buckets);
  const list = loaded ? s.buckets : [];
  const q = String(s.query || '').trim().toLowerCase();
  const sort = s.sort || { key: 'bucket', dir: 'asc' };
  const filtered = list.filter((b) => !q || b.name.toLowerCase().includes(q) || b.owner.toLowerCase().includes(q));
  const rows = sortBuckets(filtered, sort.key, sort.dir).map(bucketRow);
  const t = stats(list);
  const stat = (value) => (loaded ? value : s.error ? '–' : '…');
  const header = { title: 'Buckets', readOnly: admin !== true, badge: admin === true ? '' : 'Somente leitura' };
  if (admin === true) header.newBucket = true;
  return {
    header,
    stats: [
      { label: 'Buckets', value: stat(String(t.buckets)) },
      { label: 'Usado', value: stat(bytes(t.used)) },
      { label: 'Objetos', value: stat(pt(t.objects)) },
      { label: 'Donos', value: stat(String(t.owners)) },
    ],
    columns: COLUMNS.map((c) => ({ ...c, dir: sort.key === c.key ? sort.dir : '' })),
    error: s.error || '',
    rows,
    empty: !loaded
      ? s.error
        ? 'Não foi possível carregar os buckets.'
        : 'Carregando buckets…'
      : rows.length === 0
        ? 'Nenhum bucket encontrado.'
        : '',
  };
}

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

// form: {name, mode:'existing'|'new', owner, newOwner}; devolve as mensagens (vazio = válido).
function validateBucket(form, owners) {
  const f = form || {};
  const errors = [];
  const name = norm(f.name);
  if (!BUCKET_NAME.test(name)) errors.push(MSG.name);
  if (f.mode === 'new') {
    const uid = norm(f.newOwner) || name;
    if ((owners || []).includes(uid)) errors.push(MSG.taken);
    else if (!NEW_OWNER.test(uid)) errors.push(MSG.newOwner);
  } else if (!f.owner) {
    errors.push(MSG.pick);
  }
  return errors;
}

function bucketBody(form) {
  const f = form || {};
  const name = norm(f.name);
  const isNew = f.mode === 'new';
  return { name, owner: isNew ? norm(f.newOwner) || name : String(f.owner == null ? '' : f.owner).trim(), newOwner: isNew };
}

function profileName(owner) {
  return String(owner).replace(/[^a-z0-9_-]/gi, '-');
}

// secret: string = valor real; null = placeholder. opts.withSecret=false (viewer) tira a linha da secret.
function snippet(kind, c, secret, { withSecret = true } = {}) {
  const profile = profileName(c.owner);
  const value = typeof secret === 'string' && secret ? secret : SECRET_PLACEHOLDER;
  switch (kind) {
    case 'env':
      return [
        `S3_ENDPOINT=${c.endpoint}`,
        `S3_REGION=${c.region}`,
        `S3_BUCKET=${c.bucket}`,
        `S3_ACCESS_KEY=${c.accessKey}`,
        ...(withSecret ? [`S3_SECRET_KEY=${value}`] : []),
      ].join('\n');
    case 'aws':
      return [
        `aws configure set aws_access_key_id ${c.accessKey} --profile ${profile}`,
        ...(withSecret ? [`aws configure set aws_secret_access_key ${value} --profile ${profile}`] : []),
        `aws configure set region ${c.region} --profile ${profile}`,
        `aws --profile ${profile} --endpoint-url ${c.endpoint} s3 ls s3://${c.bucket}`,
      ].join('\n');
    case 'rclone':
      return [
        `[${profile}]`,
        'type = s3',
        'provider = Ceph',
        `endpoint = ${c.endpoint}`,
        `region = ${c.region}`,
        `access_key_id = ${c.accessKey}`,
        ...(withSecret ? [`secret_access_key = ${value}`] : []),
      ].join('\n');
    default:
      return '';
  }
}

module.exports = {
  BUCKET_NAME,
  NEW_OWNER,
  MASK,
  DEFAULT_DIR,
  sortBuckets,
  nextSort,
  stats,
  bucketsView,
  validateBucket,
  bucketBody,
  profileName,
  snippet,
};
