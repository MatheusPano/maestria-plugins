'use strict';

// View-models da tela Ceph. Porta apps/web/src/components/CephView.tsx.

const { bytes, date, meterTone, meterWidth } = require('./format');

const pt = (n) => n.toLocaleString('pt-BR');

function apps(pool) {
  return Array.isArray(pool.applications) ? pool.applications : [];
}

// Pools que guardam dados de cliente; os internos (.mgr, rgw.log, metadata do cephfs) ficam de fora.
function isDataPool(pool) {
  const a = apps(pool);
  if (a.includes('rbd')) return true;
  if (a.includes('rgw')) return String(pool.name).endsWith('buckets.data');
  if (a.includes('cephfs')) return !String(pool.name).includes('metadata');
  return false;
}

function visiblePools(pools) {
  return (pools || []).filter(isDataPool);
}

// O pool rbd com mais dados; '' quando não há.
function defaultPool(pools) {
  const rbd = (pools || []).filter((p) => apps(p).includes('rbd')).sort((a, b) => b.storedBytes - a.storedBytes);
  return rbd.length ? rbd[0].name : '';
}

function healthTone(status) {
  if (status === 'HEALTH_OK') return 'green';
  if (status === 'HEALTH_WARN') return 'yellow';
  return 'red';
}

function purpose(pool) {
  const list = pool.proxmoxStorages || [];
  if (list.length) return `Proxmox: ${list.join(', ')}`;
  const a = apps(pool);
  if (a.includes('rgw')) return 'Buckets (RGW)';
  if (a.includes('cephfs')) return 'CephFS';
  return '';
}

// Barra: accent abaixo de 75%, depois amarelo/vermelho.
const barTone = (pct) => (pct >= 75 ? meterTone(pct) : 'accent');

function poolRow(pool, selected) {
  const rbd = apps(pool).includes('rbd');
  const stored = pool.storedBytes || 0;
  const pct = pool.usedPct || 0;
  return {
    name: pool.name,
    apps: apps(pool).slice(),
    sub: purpose(pool),
    objects: `${pt(pool.objects || 0)} obj`,
    pct,
    width: meterWidth(pct),
    tone: barTone(pct),
    selectable: rbd,
    selected: pool.name === selected,
    usage: `${bytes(stored)} de ${bytes(stored + (pool.availBytes || 0))}`,
    pctLabel: `${pct}%`,
  };
}

function imageRow(image) {
  const hasUsed = image.usedBytes != null && image.sizeBytes > 0;
  const pct = hasUsed ? (image.usedBytes / image.sizeBytes) * 100 : 0;
  let vm = '';
  let vmTone = '';
  if (image.removing) {
    vm = 'remoção interrompida';
    vmTone = 'red';
  } else if (image.vmName) {
    vm = image.vmName;
  } else if (image.vmid != null) {
    vm = 'sem VM';
    vmTone = 'yellow';
  }
  return {
    name: image.name,
    vm,
    vmTone,
    vmid: image.vmName && !image.removing && image.vmid != null ? String(image.vmid) : '',
    rowTone: image.removing ? 'red' : '',
    size: bytes(image.sizeBytes),
    hasUsed,
    used: hasUsed ? bytes(image.usedBytes) : 'sem dado',
    usedPct: pct,
    usedWidth: meterWidth(pct),
    usedTone: barTone(pct),
    snapshots: String(image.snapshots == null ? 0 : image.snapshots),
  };
}

function imageMatches(image, q) {
  return (
    !q ||
    String(image.name).toLowerCase().includes(q) ||
    (image.vmName || '').toLowerCase().includes(q) ||
    String(image.vmid == null ? '' : image.vmid).includes(q)
  );
}

function cephView({ health, pools, selected, images, imagesQuery, trash, loadingImages, trashError } = {}) {
  const status = health || '';
  const q = String(imagesQuery || '').trim().toLowerCase();
  const list = Array.isArray(images) ? images : [];
  const rows = list.filter((i) => imageMatches(i, q)).map(imageRow);
  const loading = !!loadingImages && !Array.isArray(images);
  const entries = Array.isArray(trash) ? trash : [];
  return {
    header: { title: 'Ceph', health: status, tone: status ? healthTone(status) : 'dim' },
    pools: visiblePools(pools).map((p) => poolRow(p, selected || '')),
    images: {
      visible: !!selected,
      title: selected ? `Imagens em ${selected}` : '',
      count: list.length,
      rows: loading ? [] : rows,
      empty: loading ? 'Lendo as imagens do pool, pode levar alguns segundos…' : rows.length ? '' : 'Nenhuma imagem encontrada.',
    },
    trash: {
      visible: Array.isArray(trash),
      title: 'Lixeira',
      count: entries.length,
      error: trashError ? `Lixeira: ${trashError}` : '',
      rows: entries.map((e) => ({
        name: e.name,
        pool: e.pool,
        source: e.source,
        tone: e.source === 'REMOVING' ? 'red' : 'dim',
        rowTone: e.source === 'REMOVING' ? 'red' : '',
        deletedAt: date(e.deletedAt),
      })),
      empty: Array.isArray(trash) && entries.length === 0 ? 'Lixeira vazia.' : '',
    },
  };
}

module.exports = { visiblePools, defaultPool, healthTone, cephView };
