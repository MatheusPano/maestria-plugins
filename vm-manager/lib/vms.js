'use strict';

// View-models da lista de VMs. Porta lib/backup.ts e a lógica de VmDashboard,
// VmDetailDrawer e OverviewBar; `now` é explícito onde a web usa Date.now().

const { uptime, gib, meterTone, meterWidth, tagTone } = require('./format');

const STALE_AFTER_MS = 36 * 3600 * 1000;

function backupState(vm, now) {
  if (!vm.backupKnown) return 'unknown';
  if (!vm.lastBackupAt) return vm.backupSlot ? 'waiting' : 'none';
  const age = now - new Date(vm.lastBackupAt).getTime();
  return vm.backupSlot && age < STALE_AFTER_MS ? 'ok' : 'stale';
}

function needsBackupAttention(vm, now) {
  const state = backupState(vm, now);
  return state !== 'ok' && state !== 'unknown';
}

function backupAge(iso, now) {
  const hours = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 3600000));
  if (hours < 1) return 'há menos de 1h';
  return hours < 48 ? `há ${hours}h` : `há ${Math.floor(hours / 24)} dias`;
}

const BACKUP_TONE = { ok: 'green', stale: 'yellow', waiting: 'yellow', none: 'red', unknown: 'dim' };

function backupCell(vm, now) {
  const state = backupState(vm, now);
  const slot = vm.backupSlot || '';
  const age = vm.lastBackupAt ? backupAge(vm.lastBackupAt, now) : '';
  const text = {
    ok: age,
    stale: slot ? `${age} · atrasado` : `${age} · fora do job`,
    waiting: 'nenhum ainda',
    none: 'sem backup',
    unknown: 'PBS indisponível',
  }[state];
  const tooltip = {
    ok: `Job diário das ${slot}`,
    stale: slot ? `Job diário das ${slot}, mas o último backup passou de 36h` : 'Tem backup no PBS, mas não está em nenhum job diário',
    waiting: `No job das ${slot}, mas o PBS ainda não tem backup dela`,
    none: 'Fora dos jobs de backup',
    unknown: slot ? `Job diário das ${slot}; o PBS não respondeu` : 'O PBS não respondeu',
  }[state];
  return { text, tooltip, tone: BACKUP_TONE[state] };
}

function filterVms(vms, { query = '', filter = 'all' } = {}, now) {
  const q = String(query || '').trim().toLowerCase();
  return (vms || []).filter((vm) => {
    if (filter === 'running' && vm.status !== 'running') return false;
    if (filter === 'stopped' && vm.status === 'running') return false;
    if (filter === 'backup' && !needsBackupAttention(vm, now)) return false;
    if (!q) return true;
    return (
      String(vm.name).toLowerCase().includes(q) ||
      String(vm.node).toLowerCase().includes(q) ||
      String(vm.vmid).includes(q) ||
      (vm.ipConfigured ?? vm.ipDetected ?? '').includes(q) ||
      (vm.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  });
}

function counts(vms, now) {
  const list = vms || [];
  return {
    all: list.length,
    running: list.filter((v) => v.status === 'running').length,
    stopped: list.filter((v) => v.status !== 'running').length,
    backup: list.filter((v) => needsBackupAttention(v, now)).length,
  };
}

function haCell(state) {
  if (!state) return { text: '–', tone: 'dim' };
  const text = state === 'started' ? 'HA' : `HA ${state}`;
  if (state === 'started') return { text, tone: 'green' };
  if (state === 'error' || state === 'fence') return { text, tone: 'red' };
  return { text, tone: 'dim' };
}

const FILTERS = [
  { value: 'all', label: 'Todas' },
  { value: 'running', label: 'Ligadas' },
  { value: 'stopped', label: 'Desligadas' },
  { value: 'backup', label: 'Backup a revisar' },
];

// A barrinha no RFW é um Row com dois Expanded: `fill` e `rest` são os flex
// (inteiros, 0–1000; o rest fica >= 1 pra nunca ser um flex 0).
function flex(width) {
  const fill = Math.round(width * 10);
  return { fill, rest: Math.max(1, 1000 - fill) };
}

function usage(pct, text) {
  const width = meterWidth(pct);
  return { text, pct, tone: meterTone(pct), width, ...flex(width), show: true, tooltip: '' };
}

const NO_USAGE = { text: '', pct: 0, tone: 'dim', width: 0, fill: 0, rest: 1000, show: false, tooltip: '' };

function rowOf(vm, { admin, now, busyAction }) {
  const on = vm.status === 'running';
  const memPct = vm.memUsedMiB && vm.memoryMiB ? (vm.memUsedMiB / vm.memoryMiB) * 100 : 0;
  const sub = [
    vm.cores != null && `${vm.cores} vCPU`,
    gib(vm.memoryMiB),
    vm.diskGiB != null && `${vm.diskGiB} GB`,
  ].filter(Boolean).join(', ');

  let cpu = NO_USAGE;
  if (on && vm.cpuUsagePct != null) cpu = usage(vm.cpuUsagePct, `${Math.round(vm.cpuUsagePct)}%`);
  let ram = NO_USAGE;
  if (on) {
    ram = vm.memFromGuest
      ? usage(memPct, gib(vm.memUsedMiB) ?? '')
      : { ...NO_USAGE, text: 'sem dado do guest', tooltip: 'VM sem balloon/agent: o Proxmox reporta a alocação, não o uso real' };
  }

  const row = {
    vmid: vm.vmid,
    vmidText: String(vm.vmid),
    name: vm.name,
    node: vm.node || '',
    tags: (vm.tags || []).map((text) => ({ text, tone: tagTone(text) })),
    sub,
    ip: vm.ipConfigured ?? vm.ipDetected ?? '',
    cpu,
    ram,
    uptime: on ? uptime(vm.uptimeSeconds) ?? '' : 'parada',
    backup: backupCell(vm, now),
    ha: haCell(vm.haState),
    running: on,
    busy: !!busyAction,
    busyAction: busyAction || '',
    open: `vm:open:${vm.vmid}`,
  };

  if (admin) {
    // As ações vão no texto da ação ("vm:<ação>:<vmid>"): o onMenu do Pressable só manda a `action`.
    const item = (id, label, tone) => ({ id, label, tone, action: `vm:${id === 'details' ? 'open' : id}:${vm.vmid}`, red: tone === 'red' });
    const menu = [item('details', 'Detalhes', 'accent')];
    if (!vm.backupSlot) menu.push(item('backup', 'Incluir no backup', 'accent'));
    if (!vm.haState) menu.push(item('ha', 'Ativar HA', 'accent'));
    menu.push(item('destroy', 'Destruir', 'red'));
    const primary = on ? { id: 'stop', label: 'Desligar', tone: 'red' } : { id: 'start', label: 'Ligar', tone: 'green' };
    // Como na web: só o botão da ação em curso diz "Aguarde…", e o menu some enquanto a VM está ocupada.
    const waiting = busyAction === primary.id;
    row.actions = {
      primary: { ...primary, a: `vm:${primary.id}:${vm.vmid}`, busy: waiting, text: waiting ? 'Aguarde…' : primary.label },
      menu: busyAction ? [] : menu,
      hasMenu: !busyAction,
    };
  }
  return row;
}

function vmsView(state, { admin, now } = {}) {
  const s = state || {};
  const isAdmin = admin === true;
  const all = s.vms || [];
  const busy = s.busy || {};
  const filter = s.filter || 'all';
  const c = counts(all, now);
  const rows = filterVms(all, { query: s.query, filter }, now).map((vm) =>
    rowOf(vm, { admin: isAdmin, now, busyAction: busy[vm.vmid] }));
  let empty = '';
  if (rows.length === 0) empty = s.loading && all.length === 0 ? 'Carregando VMs…' : 'Nenhuma VM encontrada.';
  return {
    header: { title: 'Máquinas virtuais', readOnly: !isAdmin, badge: isAdmin ? '' : 'Somente leitura', newVm: isAdmin },
    filters: FILTERS.map((f) => ({
      value: f.value,
      label: f.value === 'backup' ? `${f.label} · ${c.backup}` : f.label,
      count: c[f.value],
      active: f.value === filter,
      a: `vm:filter:${f.value}`,
    })),
    rows,
    empty,
    error: s.error || '',
  };
}

function formatTb(g) {
  return (Math.round((g / 1024) * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1 });
}

function overviewView(ov) {
  if (!ov) {
    return {
      loaded: false,
      cluster: { title: 'Cluster', aside: '', lines: [] },
      vms: { running: 0, stopped: 0, runningText: '0', stoppedText: '0' },
      ceph: [],
      ipam: { available: false, prefix: '', text: '', pct: 0, width: 0, fill: 0, rest: 1000, detail: '' },
    };
  }
  const n = ov.nodes;
  const memPct = Math.round((n.memUsedGiB / Math.max(n.memTotalGiB, 1)) * 100);
  const line = (label, pct, value, tone) => ({ label, pct, value, tone: tone || meterTone(pct), width: meterWidth(pct), ...flex(meterWidth(pct)) });
  const ipam = ov.ipam
    ? {
        available: true,
        prefix: ov.ipam.prefix,
        text: `${ov.ipam.free} IPs livres`,
        pct: ov.ipam.usedPct,
        width: meterWidth(ov.ipam.usedPct),
        ...flex(meterWidth(ov.ipam.usedPct)),
        detail: `${ov.ipam.used} de ${ov.ipam.size} em uso`,
      }
    : { available: false, prefix: '', text: 'NetBox indisponível', pct: 0, width: 0, fill: 0, rest: 1000, detail: '' };
  return {
    loaded: true,
    cluster: {
      title: 'Cluster',
      aside: `${n.online} de ${n.total} nodes`,
      lines: [line('CPU', n.cpuUsagePct, `${n.cpuUsagePct}%`), line('RAM', memPct, `${n.memUsedGiB}/${n.memTotalGiB} GB`)],
    },
    vms: { running: ov.vms.running, stopped: ov.vms.stopped, runningText: String(ov.vms.running), stoppedText: String(ov.vms.stopped) },
    ceph: (ov.storages || [])
      .filter((x) => x.storage.startsWith('ceph'))
      .map((x) => line(x.storage, x.usedPct, `${formatTb(x.usedGiB)}/${formatTb(x.totalGiB)} TB`, x.usedPct >= 90 ? 'red' : x.usedPct >= 75 ? 'yellow' : 'accent')),
    ipam,
  };
}

const NO_DATA = 'sem dado';
const gb = (mib) => (mib ? String(Math.round((mib / 1024) * 10) / 10) : '?');
const row = (k, v, mono) => ({ k, v: v || NO_DATA, mono: !!mono });

function detailBlocks(detail) {
  const vm = detail.vm;
  const p = detail.proxmox;
  const nb = detail.netbox;
  const prov = [
    row('vCPU', `${p.vcpus} (${p.cores} cores × ${p.sockets} socket${p.sockets > 1 ? 's' : ''})`),
    row('Tipo de CPU', p.cpuType),
    row('RAM provisionada', `${gb(p.memoryProvisionedMiB)} GB`),
  ];
  if (p.balloonMinMiB != null && p.balloonMinMiB > 0) prov.push(row('Balloon mín.', `${gb(p.balloonMinMiB)} GB`));
  for (const d of p.disks || []) prov.push(row(`Disco ${d.slot}`, `${d.sizeGiB ?? '?'} GB em ${d.storage}`));
  prov.push(row('Sistema', p.osType), row('Máquina', p.machine), row('Boot', p.boot, true), row('QEMU agent', p.agentEnabled ? 'habilitado' : 'desligado'));

  const sourceBadge = p.memSource === 'guest' ? 'guest' : p.memSource === 'host' ? 'host-side ≈' : '';
  const ramRow = p.memUsedMiB != null
    ? { k: 'RAM', v: `${gb(p.memUsedMiB)} / ${gb(p.memoryProvisionedMiB)} GB`, mono: false, badge: sourceBadge, badgeTone: p.memSource === 'guest' ? 'green' : 'yellow' }
    : { k: 'RAM', v: NO_DATA, mono: false };
  const live = [
    row('CPU', vm.status === 'running' ? `${vm.cpuUsagePct ?? 0}% de ${p.vcpus} vCPU` : 'VM desligada'),
    ramRow,
    row('Disco (usado)', vm.diskUsedGiB ? `${vm.diskUsedGiB} GB` : 'sem dado do guest'),
    row('HA', vm.haState),
  ];

  const net = [row('IP configurado', vm.ipConfigured, true), row('IP detectado (agent)', vm.ipDetected, true)];
  for (const n of p.networks || []) {
    net.push(row(n.name, [n.model, n.bridge, n.vlan && `vlan ${n.vlan}`, n.firewall && 'fw', n.macAddress].filter(Boolean).join(', '), true));
  }
  net.push(row('Tags', (vm.tags || []).join(', ')));

  const netbox = nb
    ? {
        title: 'NetBox',
        rows: [
          row('Status', nb.status), row('Role', nb.role), row('Tenant', nb.tenant), row('Plataforma', nb.platform),
          row('Descrição', nb.description), row('IPs', (nb.ips || []).join(', '), true),
          ...(nb.interfaces || []).map((i) => row(`iface ${i.name}`, i.mac ?? 'sem MAC', true)),
        ],
        note: '',
        link: { text: 'Abrir no NetBox ↗', url: nb.url },
      }
    : { title: 'NetBox', rows: [], note: 'Não registrada no NetBox.', link: { text: '', url: '' } };

  return [
    { title: 'Provisionamento', rows: prov, note: '' },
    { title: 'Uso ao vivo', rows: live, note: '' },
    { title: 'Rede', rows: net, note: '' },
    netbox,
  ];
}

// Trava por VM: uma ação por vez; a flag sai no finally, com sucesso ou erro.
// `opts.name` prefixa o erro ("{name}: {message}"), como o banner da web.
function createBusy() {
  const busy = new Map();
  return {
    get: (vmid) => busy.get(vmid),
    /** `{ vmid: ação }` das VMs ocupadas, o `busy` do `vmsView`. */
    snapshot: () => Object.fromEntries(busy),
    async run(vmid, action, fn, opts = {}) {
      if (busy.has(vmid)) return { ran: false };
      busy.set(vmid, action);
      try {
        await fn();
        return { ran: true };
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        return { ran: true, error: opts.name ? `${opts.name}: ${msg}` : msg };
      } finally {
        busy.delete(vmid);
      }
    },
  };
}

// --- as janelas de blocos ---------------------------------------------------------

/** A confirmação do destruir (DestroyVmDialog.tsx): digitar o nome da VM. */
function destroyBlocks({ vmid, name, error, typed = '' }) {
  const blocks = [
    { type: 'heading', text: `Destruir ${name}?` },
    { type: 'text', text: `A VM ${vmid} e os discos dela são apagados no Proxmox e o registro sai do NetBox. Não dá para desfazer.` },
    { type: 'input', id: 'confirm', label: `Digite ${name} para confirmar`, value: String(typed), submit: `vm:confirm:${vmid}` },
  ];
  if (error) blocks.push({ type: 'text', style: 'error', text: error });
  blocks.push({
    type: 'row',
    align: 'end',
    children: [
      { type: 'button', action: `vm:cancel:${vmid}`, label: 'Cancelar' },
      { type: 'button', action: `vm:confirm:${vmid}`, label: 'Destruir VM', style: 'danger' },
    ],
  });
  return blocks;
}

const STATUS_LABEL = { running: 'ligada', stopped: 'desligada', paused: 'pausada', unknown: 'desconhecido' };
const STATUS_TONE = { running: 'green', paused: 'yellow' };

/** A gaveta de detalhes (VmDetailDrawer.tsx) em blocos: "Carregando…", o erro em vermelho ou as seções. */
function detailWindowBlocks({ loading, error, detail } = {}) {
  if (error) return [{ type: 'text', style: 'error', text: String(error) }];
  if (loading || !detail) return [{ type: 'text', style: 'dim', text: 'Carregando…' }];
  const vm = detail.vm;
  const tone = STATUS_TONE[vm.status] || 'faint';
  const blocks = [
    {
      type: 'header',
      avatar: { icon: 'device', color: tone },
      status: tone,
      title: String(vm.name),
      subtitle: `VM ${vm.vmid} em ${vm.node} · ${STATUS_LABEL[vm.status] || STATUS_LABEL.unknown}`,
    },
  ];
  for (const sec of detailBlocks(detail)) {
    blocks.push({ type: 'section', text: sec.title });
    if (sec.rows.length) {
      blocks.push({
        type: 'kv',
        items: sec.rows.map((r) => {
          const item = { key: r.k, value: r.badge ? `${r.v} · ${r.badge}` : r.v };
          if (r.badge) item.tone = r.badgeTone;
          return item;
        }),
      });
    }
    if (sec.note) blocks.push({ type: 'text', style: 'dim', text: sec.note });
    if (sec.link && sec.link.url) blocks.push({ type: 'markdown', text: `[${sec.link.text}](${sec.link.url})` });
  }
  return blocks;
}

module.exports = {
  destroyBlocks, detailWindowBlocks,
  backupState, needsBackupAttention, backupAge, backupCell, filterVms, counts, haCell,
  overviewView, vmsView, detailBlocks, createBusy,
};
