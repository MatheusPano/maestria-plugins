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

// --- a janela "Nova VM" em blocos ------------------------------------------------

const HINT_STYLE = { green: 'success', red: 'error', yellow: 'warning', dim: 'dim' };
const SUBMITTING_TEXT = 'Clonando, configurando e ligando. Leva cerca de 1 minuto.';
const TRACKING_TEXT = 'criando… (acompanhando)';
const NO_FREE_IP = 'Nenhum IP livre encontrado no prefixo (ou NetBox desligado).';

function ipBlocks(form, ip) {
  if (form.ipAuto) {
    const auto = ip.auto || {};
    let text = { type: 'text', style: 'warning', text: 'sem IP livre / NetBox off' };
    if (auto.loading) text = { type: 'text', style: 'faint', text: 'buscando…' };
    else if (auto.cidr) text = { type: 'text', style: 'success', text: String(auto.cidr) };
    return [
      text,
      { type: 'text', style: 'faint', text: 'próximo IP livre' },
      { type: 'row', children: [{ type: 'button', action: 'create:nextfree', label: 'atualizar', icon: 'refresh' }] },
    ];
  }
  const blocks = [
    { type: 'input', id: 'ipCidr', label: 'IP / CIDR', placeholder: '192.168.100.80/24', value: String(form.ipCidr) },
    {
      type: 'row',
      children: [
        { type: 'button', action: 'create:check', label: 'verificar IP', icon: 'search' },
        { type: 'button', action: 'create:suggest', label: 'sugerir IP livre' },
      ],
    },
  ];
  if (ip.checking) blocks.push({ type: 'text', style: 'faint', text: 'Verificando no NetBox…' });
  const hint = ipHint(ip.check);
  if (hint.text) blocks.push({ type: 'text', style: HINT_STYLE[hint.tone] || 'dim', text: hint.text });
  if (ip.suggestEmpty) blocks.push({ type: 'text', style: 'warning', text: NO_FREE_IP });
  if (ip.suggestError) blocks.push({ type: 'text', style: 'error', text: String(ip.suggestError) });
  return blocks;
}

function formBlocks(v) {
  const f = v.form;
  const o = v.options || {};
  const submitting = v.phase === 'submitting';
  const blocks = [];
  if (v.flowError) blocks.push({ type: 'text', style: 'error', text: String(v.flowError) });
  blocks.push(
    { type: 'input', id: 'name', label: 'Nome (minúsculas, dígitos e hífen)', placeholder: 'ex: jibri-1', value: String(f.name) },
    { type: 'section', text: 'Endereço IP' },
    { type: 'checkbox', id: 'ipAuto', label: 'automático (NetBox)', value: !!f.ipAuto, action: 'create:ipmode' },
    ...ipBlocks(f, v.ip || {}),
    { type: 'input', id: 'gateway', label: 'Gateway', placeholder: '192.168.100.1', value: String(f.gateway) },
    {
      type: 'columns',
      children: [
        { type: 'input', id: 'cores', label: 'vCPU', value: String(f.cores) },
        { type: 'input', id: 'memory', label: 'Memória (MiB)', value: String(f.memory) },
        { type: 'input', id: 'diskGiB', label: 'Disco (GiB)', value: String(f.diskGiB) },
      ],
    },
    {
      type: 'columns',
      children: [
        { type: 'select', id: 'node', label: 'Node', value: String(f.node), options: o.nodes || [] },
        { type: 'select', id: 'storage', label: 'Storage do disco', value: String(f.storage), options: o.storages || [] },
        { type: 'select', id: 'template', label: 'Template', value: String(f.template), options: o.templates || [] },
      ],
    },
    { type: 'input', id: 'sshKeys', label: 'Chaves SSH públicas (uma por linha, opcional)', placeholder: 'ssh-ed25519 AAAA... user@host', multiline: true, value: String(f.sshKeys || '') },
    { type: 'checkbox', id: 'startAfterCreate', label: 'Ligar a VM após criar', value: !!f.startAfterCreate },
    { type: 'checkbox', id: 'backup', label: 'Backup diário no PBS (entra no horário com menos VMs)', value: !!f.backup },
    { type: 'checkbox', id: 'ha', label: 'Alta disponibilidade (HA do cluster)', value: !!f.ha },
  );
  if (v.errors && v.errors.length) blocks.push({ type: 'text', style: 'error', text: v.errors.join(' · ') });
  blocks.push({
    type: 'row',
    children: [
      { type: 'button', action: 'create:submit', label: submitting ? 'Provisionando…' : 'Criar VM', style: 'primary', disabled: submitting },
    ],
  });
  if (submitting) blocks.push({ type: 'text', style: 'dim', text: SUBMITTING_TEXT });
  else if (v.bridge) blocks.push({ type: 'text', style: 'faint', text: `Bridge ${v.bridge}` });
  return blocks;
}

function successWindowBlocks(result) {
  const [s] = successBlocks(result);
  const blocks = [
    { type: 'heading', text: s.title },
    { type: 'kv', items: s.rows.map((r) => ({ key: r.k, value: r.v, ...(r.k === 'NetBox' && r.url ? { tone: 'accent' } : {}) })) },
  ];
  const nb = s.rows.find((r) => r.k === 'NetBox' && r.url);
  if (nb) blocks.push({ type: 'markdown', text: `[Abrir no NetBox ↗](${nb.url})` });
  for (const w of s.warnings) blocks.push({ type: 'text', style: 'warning', text: w });
  blocks.push({ type: 'row', children: [{ type: 'button', action: 'create:done', label: 'Ver todas as VMs', style: 'primary' }] });
  return blocks;
}

/**
 * Os blocos da janela "Nova VM" para a fase do fluxo de criação:
 * `phase` (idle|submitting|tracking|succeeded|unconfirmed; rejected/failed chegam
 * aqui como idle com `flowError`), `form`, `options`, `bridge`, `loading`,
 * `loadError`, `ip { auto { cidr, loading }, check, checking, suggestEmpty,
 * suggestError }`, `errors`, `flowError`, `result`, `name` e `message`.
 */
function createBlocks(v) {
  if (v.phase === 'tracking') {
    return [
      { type: 'text', text: TRACKING_TEXT },
      { type: 'text', style: 'dim', text: v.name ? `VM ${v.name}` : '' },
    ];
  }
  if (v.phase === 'succeeded') return successWindowBlocks(v.result);
  if (v.phase === 'unconfirmed') {
    return [
      { type: 'text', style: 'warning', text: String(v.message || '') },
      { type: 'row', children: [{ type: 'button', action: 'create:back', label: 'voltar ao formulário' }] },
    ];
  }
  if (v.loadError) return [{ type: 'text', style: 'error', text: String(v.loadError) }];
  if (v.loading || !v.form) return [{ type: 'text', style: 'dim', text: 'Carregando…' }];
  return formBlocks(v);
}

module.exports = { createBlocks, SUBMITTING_TEXT, TRACKING_TEXT, NO_FREE_IP, IPV4, IPV4_CIDR, initialForm, applyDefaults, optionsFrom, mergeValues, validate, buildBody, ipHint, successBlocks };
