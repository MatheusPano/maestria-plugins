'use strict';

// Lógica pura do formulário "Nova VM" (porta de CreateVmForm.tsx).

const IPV4_CIDR = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)\/(3[0-2]|[12]?\d)$/;
const IPV4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;

const NUMERIC = ['cores', 'memory', 'diskGiB'];
const BOOLEAN = ['startAfterCreate', 'backup', 'ha', 'ipAuto'];

function initialForm() {
  return {
    name: '', ipCidr: '', gateway: '', cores: 2, memory: 4096, diskGiB: 40, node: '', template: '', storage: '',
    sshKeys: '', startAfterCreate: true, backup: true, ha: true, ipAuto: true,
  };
}

function applyDefaults(form, d) {
  const out = { ...form };
  if (!d) return out;
  for (const k of ['gateway', 'cores', 'memory', 'diskGiB', 'node', 'template', 'storage']) {
    if (d[k] != null) out[k] = d[k];
  }
  return out;
}

function optionsFrom({ nodes, storages, templates } = {}) {
  const opt = (name) => ({ value: name, label: name });
  return {
    nodes: (nodes || []).filter((n) => n.status === 'online').map((n) => opt(n.name)),
    storages: (storages || []).filter((s) => s.type === 'rbd' && s.supportsImages).map((s) => opt(s.name)),
    templates: (templates || []).map((t) => opt(t.name)),
  };
}

// Valores da janela de blocos: texto vem como string, checkbox como boolean.
function mergeValues(form, values) {
  const out = { ...form };
  for (const [k, v] of Object.entries(values || {})) {
    if (!(k in form) || v === null || v === undefined) continue;
    if (BOOLEAN.includes(k)) out[k] = v === true || v === 'true';
    else out[k] = NUMERIC.includes(k) ? v : String(v);
  }
  return out;
}

function validate(form, ip) {
  const errors = [];
  if (String(form.name).trim() === '') errors.push('Informe o nome.');
  if (!IPV4.test(String(form.gateway).trim())) errors.push('Gateway deve ser um IPv4, ex: 192.168.100.1.');
  if (form.ipAuto) {
    if (!(ip && ip.auto && ip.auto.cidr)) errors.push('Sem IP livre no NetBox: desligue o automático e informe o IP.');
  } else if (!IPV4_CIDR.test(String(form.ipCidr).trim())) {
    errors.push('IP / CIDR deve ser um IPv4 com CIDR, ex: 192.168.100.80/24.');
  } else if (ip && ip.manual && !ip.manual.skipped && !ip.manual.available) {
    errors.push(`IP indisponível: ${ip.manual.reason ?? ''}`);
  }
  const cores = Number(form.cores);
  if (!Number.isInteger(cores) || cores < 1 || cores > 64) errors.push('vCPU entre 1 e 64.');
  const mem = Number(form.memory);
  if (!Number.isInteger(mem) || mem < 512 || mem % 512 !== 0) errors.push('Memória: no mínimo 512 MiB, em passos de 512.');
  const disk = Number(form.diskGiB);
  if (!Number.isInteger(disk) || disk < 4) errors.push('Disco: no mínimo 4 GiB.');
  return errors;
}

function buildBody(form) {
  const body = { name: String(form.name).trim() };
  if (!form.ipAuto) body.ipCidr = String(form.ipCidr).trim();
  body.gateway = String(form.gateway).trim();
  body.cores = Number(form.cores);
  body.memory = Number(form.memory);
  body.diskGiB = Number(form.diskGiB);
  body.node = form.node;
  body.template = form.template;
  body.storage = form.storage;
  const keys = String(form.sshKeys || '').trim();
  if (keys) body.sshKeys = keys;
  body.startAfterCreate = !!form.startAfterCreate;
  body.backup = !!form.backup;
  body.ha = !!form.ha;
  return body;
}

function ipHint(check) {
  if (!check) return { text: '', tone: 'dim' };
  if (check.skipped) return { text: 'NetBox desligado, IP não verificado.', tone: 'yellow' };
  if (!check.available) return { text: `✕ Indisponível: ${check.reason ?? ''}`, tone: 'red' };
  let text = '✓ Disponível';
  if (check.managedPrefix) text += ` no prefixo ${check.managedPrefix}`;
  else if (check.reason) text += ` (${check.reason})`;
  return { text, tone: 'green' };
}

function successBlocks(result) {
  const r = result || {};
  const vm = r.vm || {};
  return [
    {
      title: 'VM criada 🎉',
      rows: [
        { k: 'Nome', v: String(vm.name ?? '') },
        { k: 'VMID', v: `#${vm.vmid}` },
        { k: 'Node', v: String(vm.node ?? '') },
        { k: 'IP', v: vm.ipConfigured ?? 'sem IP' },
        { k: 'NetBox', v: r.netbox ? `registrado (#${r.netbox.id})` : 'não registrado', url: r.netbox ? r.netbox.url : '' },
        { k: 'Backup', v: r.backupSlot ? `diário às ${r.backupSlot}` : 'fora do backup' },
        { k: 'HA', v: r.ha ? 'ativo' : 'fora do HA' },
      ],
      warnings: (r.warnings || []).map((w) => `⚠ ${w}`),
    },
  ];
}

module.exports = { IPV4, IPV4_CIDR, initialForm, applyDefaults, optionsFrom, mergeValues, validate, buildBody, ipHint, successBlocks };
