// Relatório do dia: escolhe o dia — ou um período, no calendário —, reúne o
// material pela API da Maestria e pede a prosa ao Claude. O resultado abre no
// painel de leitura. A aba da lateral é a mesma tela da janela do ⇧⌘R.

'use strict';

const mx = require('./maestria');
const report = require('./report');

const VIEW = 'relatorio';
const SIDEBAR = 'sidebar'; // o viewId dos cliques da aba da lateral

/** Hoje, à meia-noite: é o dia que o calendário marca e o último que aceita. */
function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** A segunda-feira da semana de [d] — a semana de trabalho, não a do calendário. */
const monday = (d) => addDays(d, -((d.getDay() + 6) % 7));

const state = {
  from: report.ymd(today()),
  to: report.ymd(today()),
  busy: null, // { phase, since } enquanto escreve
  last: null, // { title, text, material, at, ok }
};

function parseDay(value) {
  const [y, m, d] = String(value).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Os períodos que respondem quase toda vez, um clique cada. "Esta semana" vai
 * da segunda até hoje; "semana passada", de segunda a sexta — o que se conta
 * numa daily de segunda ou num status semanal.
 */
function presets() {
  const t = today();
  const lastMonday = addDays(monday(t), -7);
  return [
    { id: 'hoje', label: 'hoje', from: t, to: t },
    { id: 'ontem', label: 'ontem', from: addDays(t, -1), to: addDays(t, -1) },
    { id: 'semana', label: 'esta semana', from: monday(t), to: t },
    { id: 'passada', label: 'semana passada', from: lastMonday, to: addDays(lastMonday, 4) },
    { id: 'sete', label: 'últimos 7 dias', from: addDays(t, -6), to: t },
  ];
}

/** O que a API sabe do período, achatado no que o material lê. */
async function gather(from, to) {
  const now = new Date();
  const endsToday = report.sameDay(to, now);
  const [folders, projects, sessions] = await Promise.all([
    mx.request('folders.list'),
    mx.request('projects.list'),
    mx.request('sessions.list'),
  ]);
  const nameOf = (root) => (folders.find((f) => f.root === root) || {}).name || 'avulsos';
  const inside = (d) => d >= from && d < addDays(to, 1);
  const panels = sessions
    // Um leitor, uma configuração ou uma janela de plugin não rodaram nada.
    .filter((s) => s.kind === 'claude' || s.kind === 'shell')
    // Terminando hoje, todo painel aberto conta; num período que já passou,
    // só os que abriram dentro dele.
    .filter((s) => endsToday || inside(new Date(s.startedAt)))
    .map((s) => ({ ...s, folderName: nameOf(s.folder) }));
  // As conversas arquivadas de cada dia — menos hoje, que os painéis já contam.
  const days = report.eachDay(from, to).filter((d) => !report.sameDay(d, now));
  const chats = (await Promise.all(days.map((d) => mx.request('chats.list', { day: report.ymd(d) }))))
    .flat()
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return report.material({ folders, projects, sessions: panels, chats, from, to, now });
}

async function write(fromValue, toValue = fromValue) {
  if (state.busy) {
    await mx.request('window.showBanner', { text: 'já estou escrevendo um relatório — esse leva alguns minutos' });
    return;
  }
  const from = parseDay(fromValue);
  const to = parseDay(toValue);
  const named = report.label(from, to);
  state.busy = { phase: 'reunindo o material…', since: Date.now() };
  await mx.request('window.showBanner', { text: `relatório ${named}: reunindo o material e pedindo a prosa ao claude…` });
  await refresh();
  try {
    const material = await gather(from, to);
    state.busy.phase = 'pedindo a prosa ao claude…';
    await refresh();
    const outcome = await report.ask(material, { from, to });
    state.last = {
      ok: outcome.ok,
      title: `relatório ${named}`,
      text: outcome.ok ? outcome.text : `# o relatório não saiu\n\n${outcome.text}\n\n---\n\n${material}`,
      material,
      at: new Date(),
    };
    await mx.request('window.showBanner', {
      text: outcome.ok ? `relatório ${named} pronto` : 'não deu pra escrever o relatório — abri o material bruto',
      sticky: !outcome.ok,
    });
    await mx.request('pane.openMarkdown', { title: state.last.title, markdown: state.last.text });
  } catch (e) {
    await mx.request('window.showBanner', { text: `relatório: ${e.message}`, sticky: true });
  } finally {
    state.busy = null;
    await refresh();
  }
}

async function showMaterial(fromValue, toValue) {
  const from = parseDay(fromValue);
  const to = parseDay(toValue);
  const material = await gather(from, to);
  await mx.request('pane.openMarkdown', { title: `material ${report.label(from, to)}`, markdown: material });
}

/** O período no botão: "do dia", "de ontem", "de 15/09 a 19/09". */
function chosen() {
  return report.label(parseDay(state.from), parseDay(state.to));
}

function blocks() {
  const out = [
    {
      type: 'text',
      style: 'dim',
      align: 'center',
      text: 'Clique num dia, ou em dois pra um período.',
    },
    {
      type: 'calendar',
      id: 'periodo',
      mode: 'range',
      value: { from: state.from, to: state.to },
      max: 'today',
      action: 'periodo',
      presets: presets().map((p) => ({ label: p.label, from: report.ymd(p.from), to: report.ymd(p.to) })),
    },
  ];
  if (state.busy) {
    const secs = Math.round((Date.now() - state.busy.since) / 1000);
    out.push({ type: 'progress', label: `${state.busy.phase} ${secs}s` });
  } else {
    out.push({
      type: 'row',
      align: 'center',
      children: [
        { type: 'button', action: 'escrever', label: 'escrever o relatório', icon: 'report', style: 'primary' },
        { type: 'button', action: 'material', label: 'só o material', icon: 'file' },
      ],
    });
  }
  if (state.last) {
    out.push({ type: 'divider' });
    out.push({
      type: 'list',
      items: [
        {
          title: state.last.title,
          subtitle: `${state.last.ok ? 'escrito' : 'não saiu'} às ${state.last.at.toLocaleTimeString('pt-BR').slice(0, 5)} · clique pra abrir de novo`,
          icon: state.last.ok ? 'check' : 'warning',
          tone: state.last.ok ? 'green' : 'yellow',
          action: 'abrir',
        },
      ],
    });
  }
  return out;
}

let open = false;
let sidebarShown = false;
let ticker = null;

async function openView() {
  await mx.request('view.open', { viewId: VIEW, title: 'relatório do dia', blocks: blocks() });
  open = true;
}

/**
 * Redesenha a janela e a aba, as que estiverem na tela. O selo do ícone diz que
 * está escrevendo mesmo com a aba escondida.
 */
async function refresh() {
  if (open) {
    const r = await mx.request('view.update', { viewId: VIEW, blocks: blocks() });
    open = r.open;
  }
  try {
    if (sidebarShown) {
      const r = await mx.request('sidebar.update', { blocks: blocks(), badge: state.busy ? '…' : null });
      sidebarShown = r.shown;
    } else {
      await mx.request('sidebar.update', { badge: state.busy ? '…' : null });
    }
  } catch (e) {
    mx.log('sidebar.update:', e.message);
  }
  // Os segundos da espera andam sozinhos: ninguém manda evento avisando.
  const watching = open || sidebarShown;
  if (state.busy && watching && !ticker) {
    ticker = setInterval(() => refresh().catch(() => {}), 1000);
  } else if ((!state.busy || !watching) && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

mx.onRequest('command.invoke', async ({ command }) => {
  if (command === 'relatorio') {
    await openView();
  } else if (command === 'hoje') {
    // Sem esperar: o comando volta logo, e o relatório chega pelo recado.
    const t = report.ymd(today());
    write(t, t);
  } else {
    throw new Error(`comando desconhecido: ${command}`);
  }
  return null;
});

mx.onNotification('event', async ({ type }) => {
  if (type === 'sidebar.shown') {
    // De novo a cada clique no ícone: os atalhos do calendário andam com o dia.
    sidebarShown = true;
    await refresh();
  } else if (type === 'sidebar.hidden') {
    sidebarShown = false;
    await refresh();
  }
});

mx.onNotification('view.action', async ({ viewId, action, values }) => {
  if (viewId !== VIEW && viewId !== SIDEBAR) return;
  const p = values.periodo;
  if (p && p.from && p.to) {
    state.from = p.from;
    state.to = p.to;
  }
  if (action === 'periodo') {
    await refresh();
  } else if (action === 'escrever') {
    write(state.from, state.to);
  } else if (action === 'material') {
    await showMaterial(state.from, state.to);
  } else if (action === 'abrir' && state.last) {
    await mx.request('pane.openMarkdown', { title: state.last.title, markdown: state.last.text });
  }
});

mx.start();
