'use strict';

// Navegação lateral e gating por papel (Sidebar.tsx / AdminOnly.tsx da web).

const NAV = [
  { group: 'Compute', items: [{ id: 'vms', label: 'Máquinas virtuais' }, { id: 'create', label: 'Nova VM', adminOnly: true }] },
  { group: 'Storage', items: [{ id: 'ceph', label: 'Ceph' }, { id: 'buckets', label: 'Buckets' }] },
  { group: 'Rede', items: [{ id: 'routes', label: 'Rotas' }] },
  { group: 'Admin', items: [{ id: 'users', label: 'Usuários', adminOnly: true }, { id: 'audit', label: 'Auditoria', adminOnly: true }] },
];

const ADMIN_SCREENS = new Set(['create', 'users', 'audit']);
const FORBIDDEN_TEXT = 'Só admins podem fazer isso.';
const ROLE_LABEL = { admin: 'Admin', viewer: 'Viewer', pending: 'Pendente' };

function navFor(role) {
  const admin = role === 'admin';
  return NAV.map((g) => ({
    group: g.group,
    items: g.items.filter((i) => admin || !i.adminOnly).map((i) => ({ id: i.id, label: i.label, active: false })),
  })).filter((g) => g.items.length > 0);
}

function gate(user, screen) {
  if (!user) return 'login';
  if (user.role === 'pending') return 'pending';
  if (ADMIN_SCREENS.has(screen) && user.role !== 'admin') return 'forbidden';
  return screen;
}

function initials(nameOrEmail) {
  return String(nameOrEmail || '')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

module.exports = { NAV, navFor, gate, initials, ROLE_LABEL, FORBIDDEN_TEXT };
