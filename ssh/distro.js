// O ícone de cada host, como no Termius: o desenho do sistema num quadrado da
// cor dele. O sistema vem do /etc/os-release do servidor (lido junto com o
// histórico) ou da escolha no formulário.

'use strict';

const fs = require('fs');
const path = require('path');

// id → [rótulo, cor 0xAARRGGBB]. O desenho é icons/os/<id>.svg.
const OS = {
  ubuntu: ['Ubuntu', 0xffe95420],
  debian: ['Debian', 0xffa80030],
  rocky: ['Rocky', 0xff10b981],
  centos: ['CentOS', 0xff932279],
  redhat: ['Red Hat', 0xffcc0000],
  fedora: ['Fedora', 0xff3c6eb4],
  alpine: ['Alpine', 0xff0d597f],
  arch: ['Arch', 0xff1793d1],
  freebsd: ['FreeBSD', 0xffab2b28],
  firewall: ['Firewall', 0xffd94f00],
  proxmox: ['Proxmox', 0xffe57000],
  windows: ['Windows', 0xff0078d4],
  linux: ['Linux', 0xff4b5563],
};

// Os ids do os-release que não têm desenho próprio, pelo parente.
const ALIASES = {
  almalinux: 'rocky',
  rhel: 'redhat',
  ol: 'redhat',
  amzn: 'redhat',
  linuxmint: 'ubuntu',
  pop: 'ubuntu',
  raspbian: 'debian',
  kali: 'debian',
  opnsense: 'firewall',
  pfsense: 'firewall',
  manjaro: 'arch',
  endeavouros: 'arch',
};

/**
 * O id do desenho a partir da linha `ID|ID_LIKE|NAME` do os-release (ou do
 * `uname -s`, onde não há os-release). '' quando não dá pra saber.
 */
function detect(line) {
  const text = String(line || '').toLowerCase();
  if (!text) return '';
  if (/proxmox|pve/.test(text)) return 'proxmox';
  if (/opnsense|pfsense/.test(text)) return 'firewall';
  const [id = '', like = ''] = text.split('|');
  for (const candidate of [id.trim(), ...like.trim().split(/\s+/)]) {
    if (OS[candidate]) return candidate;
    if (ALIASES[candidate]) return ALIASES[candidate];
  }
  if (/freebsd/.test(text)) return 'freebsd';
  if (/linux/.test(text)) return 'linux';
  if (/mingw|msys|cygwin|windows/.test(text)) return 'windows';
  return '';
}

// O quadrado de um host sem sistema conhecido: o servidor num cinza.
const UNKNOWN = 0xff6b7280;
const badges = new Map();

/**
 * O ícone inteiro, como o do Termius: o quadrado arredondado na cor do sistema
 * com o desenho em branco, num svg só -- a janela o desenha com as cores dele.
 */
function badge(id) {
  if (badges.has(id)) return badges.get(id);
  const file = path.join(__dirname, 'icons', 'os', `${OS[id] ? id : 'server'}.svg`);
  const inner = fs
    .readFileSync(file, 'utf8')
    .trim()
    .replace(/^<svg[^>]*>|<\/svg>$/g, '')
    .replace(/#000/g, '#fff');
  const color = `#${((OS[id] ? OS[id][1] : UNKNOWN) & 0xffffff).toString(16).padStart(6, '0')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="9" fill="${color}"/><g transform="translate(7 7) scale(0.9167)" fill="#fff">${inner}</g></svg>`;
  badges.set(id, svg);
  return svg;
}

/** O desenho e a cor de um host: a escolha do formulário, senão a detectada. */
function look(meta) {
  const id = (meta && (meta.icon || meta.os)) || '';
  if (!OS[id]) return { icon: 'server', color: 0, label: '', svg: badge('') };
  return { icon: `icons/os/${id}.svg`, color: OS[id][1], label: OS[id][0], svg: badge(id) };
}

/** As opções do seletor de ícone no formulário. */
function options(detected) {
  return [
    { value: '', label: detected && OS[detected] ? `automático (${OS[detected][0]})` : 'automático' },
    ...Object.entries(OS).map(([value, [label]]) => ({ value, label })),
    { value: 'server', label: 'servidor (genérico)' },
  ];
}

module.exports = { detect, look, badge, options, OS };
