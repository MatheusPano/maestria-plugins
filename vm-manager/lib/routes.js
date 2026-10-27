'use strict';

// Lógica da tela Rotas. Porta routeStatus.ts, RoutesView.tsx, RouteDrawer.tsx, NewRouteDialog.tsx,
// RemoveRouteDialog.tsx e RouteJobProgress.tsx; `now` é explícito onde a web usa Date.now().

const { date, relative } = require('./format');

const DAY_MS = 86_400_000;
const CERT_WARN_DAYS = 30;

const PROBLEM_LABEL = {
  mapfile_conflict: 'outra mapfile manda este hostname para outro backend',
  backend_missing: 'backend não existe',
  backend_down: 'backend desligado ou sem servidor no ar',
  server_down: 'parte dos servidores fora',
  dns_missing: 'sem override no DNS interno',
  cert_missing: 'sem certificado',
  cert_not_issued: 'a última emissão do certificado falhou',
  cert_not_attached: 'certificado fora do frontend',
  cert_expiring: `certificado vence em menos de ${CERT_WARN_DAYS} dias`,
};

// Deixam a rota fora do ar ou com certificado errado; o resto é aviso.
const BLOCKING = ['mapfile_conflict', 'backend_missing', 'backend_down', 'dns_missing', 'cert_missing', 'cert_not_attached'];

const SEVERITY_TONE = { ok: 'green', warn: 'yellow', danger: 'red' };

function severity(route) {
  const problems = route.problems || [];
  if (problems.some((p) => BLOCKING.includes(p))) return 'danger';
  return problems.length ? 'warn' : 'ok';
}

function daysLeft(cert, now) {
  return cert && cert.expiresAt ? Math.floor((Date.parse(cert.expiresAt) - now) / DAY_MS) : null;
}

const serversOf = (route) => (route.backend && route.backend.servers) || [];
const has = (route, problem) => (route.problems || []).includes(problem);
const cell = (text, tone = '') => ({ text, tone });

function destino(route) {
  const servers = serversOf(route);
  if (!servers.length) return cell('—', 'dim');
  const up = servers.filter((s) => s.health === 'up').length;
  const down = servers.filter((s) => s.health === 'down').length;
  const tone = down === 0 ? 'green' : down === servers.length ? 'red' : 'yellow';
  const text = servers.length === 1 ? `${servers[0].address}:${servers[0].port}` : `${up}/${servers.length} servidores no ar`;
  return cell(text, tone);
}

function dnsCell(route) {
  if (route.dnsAddress) return cell(`→ ${route.dnsAddress}`);
  if (has(route, 'dns_missing')) return cell('sem override', 'red');
  return cell('só público', 'dim');
}

function certCell(route, now) {
  const c = route.certificate;
  if (route.tlsMode === 'passthrough') return cell('no servidor', 'dim');
  if (!c) return cell('ausente', 'red');
  if (!c.attached) return cell('fora do frontend', 'red');
  const days = daysLeft(c, now);
  if (days === null) return cell('outra CA');
  if (days < CERT_WARN_DAYS) return cell(`vence em ${days} dias`, 'yellow');
  return cell(`${days} dias${c.wildcard ? ' · wildcard' : ''}`);
}

function cells(route, now) {
  return {
    destino: destino(route),
    dns: dnsCell(route),
    cert: certCell(route, now),
    backend: route.backend ? cell(route.backendName) : cell(`${route.backendName} (não existe)`, 'red'),
  };
}

const FILTERS = [
  { value: 'all', label: 'Todas', match: () => true },
  { value: 'problems', label: 'Com problema', match: (r) => (r.problems || []).length > 0 },
  { value: 'firewall', label: 'TLS no firewall', match: (r) => r.tlsMode === 'firewall' },
  { value: 'passthrough', label: 'Passthrough', match: (r) => r.tlsMode === 'passthrough' },
];

function matchesQuery(route, q) {
  if (!q) return true;
  return [route.hostname, route.backendName, route.dnsAddress || '', ...serversOf(route).map((s) => `${s.address}:${s.port}`)]
    .some((v) => String(v).toLowerCase().includes(q));
}

function filterRoutes(routes, { query, filter } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const active = FILTERS.find((f) => f.value === filter) || FILTERS[0];
  return (routes || []).filter((r) => active.match(r) && matchesQuery(r, q));
}

function routeCounts(routes) {
  const list = routes || [];
  return Object.fromEntries(FILTERS.map((f) => [f.value, list.filter(f.match).length]));
}

function routeStats(routes, now) {
  const list = routes || [];
  const certs = list.filter((r) => r.certificate);
  return {
    hostnames: list.length,
    passthrough: list.filter((r) => r.tlsMode === 'passthrough').length,
    backends: new Set(list.filter((r) => r.backend).map((r) => r.backendName)).size,
    certs: certs.length,
    expiring: certs.filter((r) => (daysLeft(r.certificate, now) ?? Infinity) < CERT_WARN_DAYS).length,
    problems: list.filter((r) => (r.problems || []).length).length,
  };
}

const modeText = (route) => (route.tlsMode === 'firewall' ? 'TLS no firewall' : 'Passthrough');

// state: {routes|null, error, query, filter, loadedAt, loading}
function routesView(state, { admin, now } = {}) {
  const s = state || {};
  const loaded = Array.isArray(s.routes);
  const list = loaded ? s.routes : [];
  const visible = filterRoutes(list, { query: s.query, filter: s.filter });
  const t = routeStats(list, now);
  const stat = (value) => (loaded ? String(value) : s.error ? '–' : '…');
  const filter = FILTERS.some((f) => f.value === s.filter) ? s.filter : 'all';
  const counts = routeCounts(list);
  const header = {
    title: 'Rotas',
    subtitle: 'HAProxy, DNS interno e certificados do OPNsense',
    refresh: s.loadedAt ? `Lido ${relative(s.loadedAt, now)}` : 'Ler agora',
    loading: !!s.loading,
  };
  if (admin === true) header.newRoute = true;
  let empty = '';
  if (!loaded) empty = s.error ? 'Não foi possível ler as rotas do OPNsense.' : 'Lendo o OPNsense…';
  else if (visible.length === 0) empty = 'Nenhuma rota encontrada.';
  return {
    header,
    stats: [
      { label: 'Hostnames', value: stat(t.hostnames), sub: loaded ? `${t.passthrough} em passthrough` : '', tone: '' },
      { label: 'Backends', value: stat(t.backends), sub: '', tone: '' },
      {
        label: 'Certificados',
        value: stat(t.certs),
        sub: loaded && t.expiring ? `${t.expiring} vencem em ${CERT_WARN_DAYS} dias` : '',
        tone: t.expiring ? 'yellow' : '',
      },
      { label: 'Com problema', value: stat(t.problems), sub: '', tone: t.problems ? 'red' : '' },
    ],
    query: String(s.query || ''),
    filters: FILTERS.map((f) => ({ value: f.value, label: f.label, count: loaded ? counts[f.value] : 0, active: f.value === filter, a: `route:filter:${f.value}` })),
    rows: visible.map((r) => {
      const sev = severity(r);
      const c = cells(r, now);
      return {
        key: r.hostname,
        hostname: r.hostname,
        severity: sev,
        tone: sev === 'ok' ? 'dim' : SEVERITY_TONE[sev],
        mode: modeText(r),
        passthrough: r.tlsMode === 'passthrough',
        backend: c.backend,
        destino: c.destino,
        dns: c.dns,
        cert: c.cert,
        open: `route:open:${r.hostname}`,
      };
    }),
    footer: loaded ? `${visible.length} de ${list.length} hostnames` : '',
    source: 'Fonte: OPNsense · haproxy, unbound, acmeclient',
    error: s.error || '',
    empty,
  };
}

// --- a gaveta de detalhes ----------------------------------------------------------

const MAPFILE_BY_ACCESS = { internal: 'LOCAL_SUBDOMAINS_mapfile', public: 'PUBLIC_SUBDOMAINS_mapfile' };
const HEALTH_LABEL = { up: 'UP', down: 'DOWN', maintenance: 'manutenção', unknown: 'sem health check' };
const HEALTH_TONE = { up: 'green', down: 'red', maintenance: 'yellow', unknown: 'dim' };

function pathItems(route) {
  const firewall = route.tlsMode === 'firewall';
  const conflicts = route.conflictingBackends || [];
  const mapfiles = firewall ? (route.access || []).map((a) => MAPFILE_BY_ACCESS[a]) : ['PASSTHROUGH_DOMAINS_mapfile'];
  const servers = serversOf(route);
  const join = (main, sub) => (sub ? `${main} · ${sub}` : main);
  const items = [
    {
      key: 'DNS interno',
      value: route.dnsAddress
        ? join(`${route.hostname} → ${route.dnsAddress}`, 'Unbound · host override')
        : join('sem override no Unbound', 'resolve só pelo DNS público'),
      tone: route.dnsAddress ? 'green' : has(route, 'dns_missing') ? 'red' : 'dim',
    },
    {
      key: 'Entrada',
      value: firewall
        ? join('0_SNI_frontend :443 → 1_HTTPS_frontend', 'o firewall termina o TLS')
        : join('0_SNI_frontend :443', 'repassa o TLS direto para o servidor'),
      tone: 'green',
    },
    {
      key: 'Mapfile',
      value: join(
        mapfiles.join(' · '),
        conflicts.length
          ? `${route.hostname} ${route.backendName} · outra mapfile: ${conflicts.join(', ')}`
          : `${route.hostname} ${route.backendName}`,
      ),
      tone: conflicts.length ? 'red' : 'green',
    },
    {
      key: 'Backend',
      value: join(
        route.backendName,
        !route.backend ? 'não existe no HAProxy' : route.backend.enabled ? `health check: ${route.backend.healthCheck || 'nenhum'}` : 'desligado no HAProxy',
      ),
      tone: route.backend && route.backend.enabled ? 'green' : 'red',
    },
  ];
  if (!servers.length) items.push({ key: 'Servidores', value: 'nenhum', tone: 'red' });
  else {
    servers.forEach((sv, i) =>
      items.push({
        key: i === 0 ? (servers.length > 1 ? `Servidores (${servers.length})` : 'Servidor') : '',
        value: join(sv.name, `${sv.address}:${sv.port} · ${HEALTH_LABEL[sv.health] || HEALTH_LABEL.unknown}`),
        tone: HEALTH_TONE[sv.health] || 'dim',
      }));
  }
  return items;
}

function certItems(cert, now) {
  const days = daysLeft(cert, now);
  const items = [
    { key: 'Nome', value: String(cert.name), tone: '' },
    { key: 'Origem', value: cert.source === 'acme' ? 'Let’s Encrypt (cliente ACME)' : 'outra CA (importado ou CA interna)', tone: '' },
  ];
  if (cert.validation) items.push({ key: 'Validação', value: String(cert.validation), tone: '' });
  if (cert.issuedAt) items.push({ key: 'Emitido', value: date(cert.issuedAt), tone: '' });
  if (cert.expiresAt) items.push({ key: 'Vence', value: `${date(cert.expiresAt)}${days !== null ? ` · ${days} dias` : ''}`, tone: '' });
  items.push({ key: 'No frontend', value: cert.attached ? 'sim' : 'não', tone: cert.attached ? '' : 'red' });
  if (cert.source === 'acme' && !cert.issued) items.push({ key: 'Emissão', value: 'falhou na última tentativa', tone: 'yellow' });
  if (cert.source === 'acme') items.push({ key: 'Renovação', value: cert.autoRenewal ? 'automática' : 'manual', tone: '' });
  return items;
}

function drawerBlocks(route, { admin, now } = {}) {
  const sev = severity(route);
  const problems = route.problems || [];
  const blocks = [
    {
      type: 'header',
      avatar: { icon: 'globe', color: sev === 'ok' ? 'faint' : SEVERITY_TONE[sev] },
      status: sev === 'ok' ? 'green' : SEVERITY_TONE[sev],
      title: route.hostname,
      subtitle: `${modeText(route)} · ${sev === 'ok' ? 'Tudo OK' : `${problems.length} problema${problems.length > 1 ? 's' : ''}`}`,
    },
  ];
  for (const p of problems) blocks.push({ type: 'text', style: sev === 'danger' ? 'error' : 'warn', text: PROBLEM_LABEL[p] || p });
  blocks.push({ type: 'section', text: 'CAMINHO' }, { type: 'kv', items: pathItems(route) });
  if (route.tlsMode === 'firewall') {
    blocks.push({ type: 'section', text: 'CERTIFICADO' });
    if (route.certificate) blocks.push({ type: 'kv', items: certItems(route.certificate, now) });
    else blocks.push({ type: 'text', style: 'error', text: 'Nenhum certificado cobre este hostname.' });
  }
  const footer = [{ type: 'text', style: 'dim', text: 'Editar rota: no OPNsense, por enquanto' }];
  if (admin === true) footer.push({ type: 'button', action: `route:remove:${route.hostname}`, label: 'Remover rota', style: 'danger' });
  blocks.push({ type: 'row', align: 'end', children: footer });
  return blocks;
}

// --- Nova rota ---------------------------------------------------------------------

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
const DEFAULT_HEALTHCHECK = 'tcp-check';
const ACCESS = { internal: ['internal'], public: ['public'], both: ['internal', 'public'] };

const MSG = { hostname: 'Hostname inválido: domínio completo, ex: app.cefis.cloud.' };

const normHost = (v) => String(v == null ? '' : v).trim().toLowerCase();
const portOf = (v) => Number(String(v == null ? '' : v));
const portOk = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

function pickHealthCheck(list, current = DEFAULT_HEALTHCHECK) {
  if (!Array.isArray(list) || !list.length) return current;
  return list.includes(current) ? current : list[0];
}

// form: {hostname, tlsMode, access:'internal'|'public'|'both', servers:[{address, port}], healthCheck, createDnsOverride}
function validateRoute(form) {
  const f = form || {};
  const errors = [];
  if (!HOSTNAME.test(normHost(f.hostname))) errors.push(MSG.hostname);
  (f.servers || []).forEach((s, i) => {
    if (!IPV4.test(String(s.address == null ? '' : s.address).trim())) errors.push(`Servidor ${i + 1}: IP inválido.`);
    if (!portOk(portOf(s.port))) errors.push(`Servidor ${i + 1}: porta de 1 a 65535.`);
  });
  return errors;
}

function routeBody(form) {
  const f = form || {};
  const passthrough = f.tlsMode === 'passthrough';
  return {
    hostname: normHost(f.hostname),
    tlsMode: f.tlsMode,
    access: passthrough ? [] : [...(ACCESS[f.access] || ACCESS.internal)],
    servers: (f.servers || []).map((s) => ({ address: String(s.address == null ? '' : s.address).trim(), port: portOf(s.port) })),
    healthCheck: f.healthCheck,
    createDnsOverride: f.createDnsOverride,
  };
}

function addServer(servers) {
  const list = servers || [];
  const last = list[list.length - 1];
  return [...list, { address: '', port: last ? last.port : '' }];
}

function removeServer(servers, i) {
  const list = servers || [];
  return list.length <= 1 ? [...list] : list.filter((_, j) => j !== i);
}

// --- plano e job -------------------------------------------------------------------

const CHANGE_LABEL = {
  certificate: ['Certificado', 'ACME'],
  server: ['Real Server', 'HAProxy'],
  backend: ['Backend Pool', 'HAProxy'],
  frontend_certificate: ['Certificado no frontend', 'HAProxy'],
  mapfile_line: ['Linha na mapfile', 'HAProxy'],
  dns_override: ['Host override', 'Unbound'],
  trust_certificate: ['Certificado no trust store', 'System'],
};

const STEP_LABEL = {
  certificate: "Emitir certificado (Let's Encrypt)",
  servers: 'Criar Real Server(s)',
  backend: 'Criar Backend Pool',
  frontend_certificate: 'Ligar certificado no 1_HTTPS_frontend',
  mapfiles: 'Acrescentar linha na mapfile',
  configtest: 'configtest do HAProxy',
  dns_override: 'Criar override no DNS interno',
  reload_unbound: 'Recarregar Unbound',
  reload_haproxy: 'Recarregar HAProxy',
  verify: 'Verificar HTTPS',
  remove_mapfiles: 'Tirar linha da mapfile',
  detach_certificate: 'Desligar certificado do 1_HTTPS_frontend',
  delete_backend: 'Apagar Backend Pool',
  delete_servers: 'Apagar Real Server(s)',
  reload_haproxy_cleanup: 'Recarregar HAProxy (limpeza)',
  delete_dns_override: 'Apagar override no DNS interno',
  delete_certificate: 'Apagar certificado do ACME',
  delete_trust_certificate: 'Apagar certificado do trust store',
};

const STEP_TONE = { pending: 'dim', running: 'accent', done: 'green', failed: 'red', skipped: 'dim', reverted: 'yellow', warning: 'yellow' };

const FAILED = 'Falhou, e o rollback ficou incompleto';
const JOB_TITLE = {
  create: { running: 'Aplicando', done: 'Rota criada', rolled_back: 'Falhou e foi desfeita', failed: FAILED },
  remove: { running: 'Removendo', done: 'Rota removida', rolled_back: 'Falhou e foi desfeita', failed: FAILED },
};

const RUNNING_HINT = {
  create: 'Pode fechar: a criação continua na API e fica registrada na Auditoria. A emissão do certificado leva de 1 a 2 minutos.',
  remove: 'Pode fechar: a remoção continua na API e fica registrada na Auditoria.',
};

const jobTitle = (job) => (JOB_TITLE[job.kind] && JOB_TITLE[job.kind][job.status]) || '';

function visibleSteps(job) {
  return (job.steps || [])
    .filter((s) => s.status !== 'skipped')
    .map((s) => ({ step: s.step, label: STEP_LABEL[s.step] || s.step, status: s.status, tone: STEP_TONE[s.status] || 'dim', detail: s.detail || '' }));
}

// Erro de rede não encerra (o reload do HAProxy derruba conexões por um instante); só 404 perde o job.
function jobNext(job, error) {
  if (error) return error.status === 404 ? 'lost' : 'poll';
  return job && job.status === 'running' ? 'poll' : 'done';
}

// --- remoção e confirmação ----------------------------------------------------------

/** O plano de remoção em duas listas: o que será apagado e o que fica (porque outra coisa usa). */
function removalGroups(plan) {
  const changes = (plan && Array.isArray(plan.changes) && plan.changes) || [];
  return { remove: changes.filter((c) => c.action === 'remove'), keep: changes.filter((c) => c.action === 'keep') };
}

/** O hostname digitado pra confirmar: a web apara e põe em minúsculas ao digitar e compara com o hostname em minúsculas. */
function confirmMatches(typed, hostname) {
  const want = String(hostname == null ? '' : hostname).toLowerCase();
  return want !== '' && String(typed == null ? '' : typed).trim().toLowerCase() === want;
}

const LOST_TEXT = (msg) => `Perdi o acompanhamento: ${msg} Confira o resultado na Auditoria e na lista de rotas.`;

module.exports = {
  CERT_WARN_DAYS, PROBLEM_LABEL, severity, daysLeft,
  cells, filterRoutes, routeCounts, routeStats, routesView, drawerBlocks,
  HOSTNAME, IPV4, ACCESS, DEFAULT_HEALTHCHECK, pickHealthCheck, validateRoute, routeBody, addServer, removeServer,
  CHANGE_LABEL, STEP_LABEL, RUNNING_HINT, jobTitle, visibleSteps, jobNext, LOST_TEXT,
  removalGroups, confirmMatches,
};
