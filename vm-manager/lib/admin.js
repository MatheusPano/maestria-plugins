'use strict';

// View-models de Usuários e Auditoria (UsersTable.tsx / AuditLog.tsx da web).

const { relative, datetime } = require('./format');
const { ROLE_LABEL } = require('./nav');

const ROLE_TONE = { admin: 'accent', viewer: 'dim', pending: 'yellow' };
const LOCKED_TITLE = 'Você não pode alterar o próprio papel';

const ACTION_LABEL = {
  'auth.login': 'Login',
  'vm.create': 'Criar VM',
  'vm.start': 'Ligar VM',
  'vm.stop': 'Desligar VM',
  'vm.destroy': 'Destruir VM',
  'vm.backup.enable': 'Incluir no backup',
  'vm.ha.enable': 'Incluir no HA',
  'bucket.create': 'Criar bucket',
  'route.create': 'Pedir rota nova',
  'route.apply': 'Criar rota no firewall',
  'route.delete': 'Pedir remoção de rota',
  'route.delete.apply': 'Remover rota no firewall',
  's3.secret.reveal': 'Revelar secret key',
  'user.role.update': 'Mudar papel',
};

const OUTCOME_LABEL = { success: 'Sucesso', failure: 'Falha' };
const OUTCOME_TONE = { success: 'green', failure: 'red' };

function pendingBanner(users) {
  const n = (users || []).filter((u) => u.role === 'pending').length;
  if (n === 0) return '';
  return n === 1 ? '1 pessoa aguardando aprovação' : `${n} pessoas aguardando aprovação`;
}

function usersView(users, { meId, saving, now }) {
  const busy = saving || new Set();
  return (users || []).map((u) => {
    const isMe = u.id === meId;
    return {
      id: u.id,
      name: u.name || u.email || '',
      email: u.email || '',
      role: u.role,
      roleLabel: ROLE_LABEL[u.role] || u.role || '',
      roleTone: ROLE_TONE[u.role] || 'dim',
      lastSeen: relative(u.lastSeenAt, now),
      canChange: !isMe && !busy.has(u.id),
      lockedTitle: isMe ? LOCKED_TITLE : '',
      approve: u.role === 'pending',
    };
  });
}

function auditQuery({ page, action, outcome, userId } = {}) {
  const q = new URLSearchParams({ page: String(page || 1) });
  if (action) q.set('action', action);
  if (outcome) q.set('outcome', outcome);
  if (userId) q.set('userId', String(userId));
  return q.toString();
}

function withFilter(filters, key, value) {
  return { ...filters, [key]: value, page: 1, expanded: '' };
}

function targetLabel(target, byId) {
  if (!target) return '—';
  const m = /^user:(\d+)$/.exec(target);
  const u = m && byId.get(Number(m[1]));
  return (u && u.email) || target;
}

function emptyText(res) {
  if (!res) return 'Carregando…';
  if (res.error) return 'Não deu para carregar a auditoria.';
  if (!res.data || res.data.length === 0) return 'Nenhum evento com esses filtros.';
  return '';
}

// res: null (carregando), { error } (falhou) ou { data, pagination }.
function auditView(res, { users, expanded }) {
  const byId = new Map((users || []).map((u) => [u.id, u]));
  const ok = res && !res.error && res.data;
  const p = (ok && res.pagination) || null;
  const rows = ok
    ? res.data.map((e) => {
        const name = (e.userId && byId.get(e.userId) && byId.get(e.userId).name) || '';
        return {
          id: e.id,
          when: datetime(e.createdAt),
          who: name || e.userEmail || 'sem sessão',
          whoSub: name ? e.userEmail || '' : '',
          actionLabel: ACTION_LABEL[e.action] || e.action,
          action: e.action,
          target: targetLabel(e.target, byId),
          outcome: OUTCOME_LABEL[e.outcome] || e.outcome || '',
          outcomeTone: OUTCOME_TONE[e.outcome] || 'dim',
          expanded: expanded === e.id,
          detail: {
            error: e.error || '',
            json: e.detail ? JSON.stringify(e.detail, null, 2) : '',
            ip: e.ip || '—',
          },
        };
      })
    : [];
  const total = p ? p.totalItems : 0;
  const first = p ? (p.currentPage - 1) * p.perPage + 1 : 0;
  const last = p ? Math.min(p.currentPage * p.perPage, p.totalItems) : 0;
  return {
    count: p ? (total === 1 ? '1 evento' : `${total} eventos`) : '',
    rows,
    range: p && total > 0 ? `${first}–${last} de ${total}` : '',
    page: p && total > 0 ? `${p.currentPage} / ${p.lastPage}` : '',
    showPager: !!(p && total > 0),
    prevDisabled: !p || p.currentPage <= 1,
    nextDisabled: !p || p.currentPage >= p.lastPage,
    empty: emptyText(res),
  };
}

// Descarta respostas atrasadas: cada pedido pega next(); só o último isCurrent.
function createLatest() {
  let n = 0;
  return { next: () => ++n, isCurrent: (i) => i === n };
}

module.exports = {
  ACTION_LABEL, OUTCOME_LABEL, pendingBanner, usersView, auditQuery, withFilter, auditView, createLatest,
};
