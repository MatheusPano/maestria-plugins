'use strict';
// O que acontece nas sessões de um gerente chega a ele: só o que pede ação o acorda; o resto espera o próximo sessions_list.

const { bare, isOpen } = require('./links');
const { PROMPT, RESTING, plain, agentsOf } = require('./cards');

const KEEP = 30;
const SENT_MS = 10 * 60 * 1000;
const limits = { quiet: 10 * 1000, gap: 5 * 60 * 1000, settle: 2 * 60 * 1000 };
const LINE = 160;
const REPLY = 600;
const REPLY_TAIL = 200;

const isPassive = (e) => e.kind === 'direct' || e.kind === 'waiting';
const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const unwrap = (text) => String(text || '').replace(/<\/?pasted_content(?: id="[^"]*")?>/g, ' ');
/** O texto como você o escreveu: sem as marcas das imagens coladas nem o envelope que o Claude Code põe no texto colado. */
const typed = (text) => norm(unwrap(text).replace(/\[Image #\d+\]\s*/g, ''));
const MACHINE = /^\s*<(?:task-notification|agent-message)\b/;
const quoted = (text) => clip(text).replace(/"/g, "'");
const clip = (text) => {
  const t = Array.from(norm(plain(text)));
  return t.length > LINE ? `${t.slice(0, LINE).join('')}…` : t.join('');
};

/** A resposta como o aviso a cita: inteira até REPLY caracteres; maior, o começo e o fim (onde costuma estar o pedido), marcada como cortada. */
const excerpt = (text) => {
  const t = Array.from(norm(plain(text)).replace(/"/g, "'"));
  if (t.length <= REPLY) return { text: t.join(''), cut: false };
  return { text: `${t.slice(0, REPLY - REPLY_TAIL).join('')} […] ${t.slice(-REPLY_TAIL).join('')}`, cut: true };
};
const QUESTION = /(?<=\S)\?(?=[\s"'”»)\]*_:…]|$)/;
const ITEM = /^\s*(?:[-*•]|\d+[.)]|[a-zA-Z][.)])\s/;
/** A última frase da resposta, pulando a lista de opções que costuma vir depois da pergunta. */
function lastAsk(text) {
  const rows = plain(text).split('\n').map((r) => r.trim()).filter(Boolean);
  let i = rows.length - 1;
  while (i > 0 && ITEM.test(rows[i])) i--;
  const row = rows[i] || '';
  const sentences = row.split(/(?<=[.!?])\s+/);
  return sentences[sentences.length - 1] || '';
}
/** De quem é a vez: pelo estado da aba, pelo erro, por uma pergunta no fim da resposta e por um PR novo. */
function turnOf(s, fresh, errored = false) {
  if (s.needsYou || PROMPT.has(s.status)) return 'do usuário: a aba espera uma permissão ou resposta';
  if (errored) return 'do gerente: a sessão parou com erro; mande retomar ou avise o usuário';
  if (s.reply && s.reply.text && QUESTION.test(lastAsk(s.reply.text))) return 'do usuário: a resposta termina com uma pergunta (veja se pede decisão, aprovação, commit ou teste)';
  if (fresh.length) return 'do usuário: PR novo esperando revisão ou merge';
  return 'ninguém pediu nada ao usuário: a sessão parou por conta própria';
}

/** As mensagens que o plugin pôs numa aba (do gerente ou do painel), pra não contar como digitadas por você. */
class Sent {
  constructor(now = Date.now) {
    this.now = now;
    this.byTab = new Map();
  }

  note(tabId, text) {
    const list = (this.byTab.get(tabId) || []).filter((m) => this.now() - m.at < SENT_MS);
    list.push({ text: norm(text), at: this.now() });
    this.byTab.set(tabId, list);
  }

  /** O primeiro prompt de uma aba que ainda vai abrir: o hook dela pode chegar antes de o tabId ser conhecido. */
  expect(text) {
    this.note('', text);
  }

  /** A aba abriu como [tabId]: o primeiro prompt esperado passa a ser só dela. */
  claim(tabId, text) {
    const said = norm(text);
    const list = this.byTab.get('') || [];
    const i = list.findIndex((m) => m.text === said);
    if (i < 0) return;
    list.splice(i, 1);
    this.note(tabId, text);
  }

  /** Se [text] foi o plugin que mandou pra [tabId] (ou pra uma aba que estava abrindo), consome e diz true. */
  take(tabId, text) {
    const said = typed(text);
    for (const id of [tabId, '']) {
      const list = (this.byTab.get(id) || []).filter((m) => this.now() - m.at < SENT_MS);
      const i = list.findIndex((m) => m.text === said);
      if (i >= 0) list.splice(i, 1);
      this.byTab.set(id, list);
      if (i >= 0) return true;
    }
    return false;
  }
}

/** O que você escreveu na aba [tabId], ou null quando o prompt não é seu: mandado pelo plugin (gerente, cartão) ou aviso de tarefa em segundo plano. */
function fromUser(sent, tabId, prompt) {
  if (!prompt || MACHINE.test(prompt) || sent.take(tabId, prompt)) return null;
  return norm(unwrap(prompt)) || null;
}

/** Põe o evento [event] da sessão [key] na fila do gerente dela; devolve true se enfileirou. */
function queue(links, key, event, now = Date.now()) {
  const node = links.nodes[key];
  const parent = node && links.node(node.parent);
  if (!parent) return false;
  const same = (e) => e.key === key && (event.kind === 'closed' || ((event.kind === 'turn' || event.kind === 'waiting') && e.kind === event.kind));
  const events = [...(parent.events || []).filter((e) => !same(e)), { ...event, key, at: now }];
  while (events.length > KEEP) {
    const i = events.findIndex(isPassive);
    events.splice(i >= 0 ? i : 0, 1);
  }
  parent.events = events;
  return true;
}

const BUSY = new Set(['working', 'tool']);
const working = (s) => !s.hibernated && BUSY.has(s.status);
const prsOf = (s) => ((s && s.reply && s.reply.links) || []).map((l) => l.url).filter((u) => /\/pull\/\d+/.test(u));

/** O evento [e] agora: 'wake' acorda o gerente, 'wait' ainda pode virar wake, 'passive' vai no sessions_list, 'drop' sai. */
function classify(links, e, sessions, now = Date.now()) {
  const node = links.nodes[e.key];
  if (!node) return 'drop';
  if (isPassive(e)) return 'passive';
  if (e.kind === 'error' || e.kind === 'closed') return 'wake';
  const s = sessions.find((x) => x.id === node.tabId && isOpen(x));
  if (!s) return 'wait';
  if (s.needsYou || PROMPT.has(s.status)) return 'passive';
  if (working(s) || agentsOf(s)) return 'drop';
  const seen = new Set(node.seenPrs || []);
  if (prsOf(s).some((u) => !seen.has(u))) return 'wake';
  return now - e.at >= limits.settle ? 'wake' : 'wait';
}

/** Uma linha por evento, com o nome da sessão e o que ela disse por último. */
function lines(links, events, sessions) {
  const live = new Map(sessions.filter(isOpen).map((s) => [s.id, s]));
  return events.map((e) => {
    const node = links.nodes[e.key];
    const s = node && live.get(node.tabId);
    const name = bare(s ? s.title : node ? node.name : e.key) || e.key;
    if (e.kind === 'direct') return `- O usuário escreveu direto para "${name}": "${clip(e.text)}"`;
    if (e.kind === 'waiting') return `- "${name}" está esperando o usuário na aba${e.text ? `: ${clip(e.text)}` : ''}`;
    if (e.kind === 'error') return `- "${name}" parou com erro${e.text ? `: ${clip(e.text)}` : '.'}`;
    if (e.kind === 'closed') return `- "${name}" foi fechada pelo usuário${e.text ? ` ${e.text}` : ''}.`;
    if (!s) return `- "${name}" fechou.`;
    if (s.needsYou || PROMPT.has(s.status)) return `- "${name}" terminou o turno e está esperando o usuário (${s.statusLabel || s.status}).`;
    const said = s.reply && s.reply.text ? `: "${clip(s.reply.text)}"` : '.';
    return `- "${name}" terminou o turno${said}`;
  });
}

/** O bloco de uma sessão que pede ação: o que aconteceu (um ou mais eventos), o tabId, o estado, o cartão, a resposta, de quem é a vez e os PRs novos. */
function block(links, key, events, sessions, now) {
  const node = links.nodes[key];
  const s = node && sessions.find((x) => x.id === node.tabId && isOpen(x));
  const name = bare(s ? s.title : node ? node.name : key) || key;
  const card = node && node.card;
  const seen = new Set((node && node.seenPrs) || []);
  const what = events.map((e) =>
    e.kind === 'error' ? `parou com erro${e.text ? `: ${clip(e.text)}` : ''}`
    : e.kind === 'closed' ? `foi fechada pelo usuário${e.text ? ` ${e.text}` : ''}`
    : !s ? 'fechou'
    : `parou há ${Math.max(1, Math.round((now - e.at) / 60000))} min (${s.hibernated ? 'hibernada' : s.statusLabel || s.status}, sem agentes)`);
  const tab = s ? ` [tabId ${s.id}]` : '';
  const out = [`- "${name}"${tab} ${[...new Set(what)].join('; ')}.`];
  if (!s) out.push(`  a aba está fechada: o cartão${card ? ` (${card.state})` : ''} fica como está; só o usuário a retoma pelo painel`);
  else if (card) out.push(`  cartão: ${card.state}${card.headline ? ` "${quoted(card.headline)}"` : ''}${card.state === 'working' ? ' → atualize' : ''}`);
  else out.push('  sem cartão → poste um com sessions_card');
  if (s && s.reply && s.reply.text) {
    const r = excerpt(s.reply.text);
    out.push(`  resposta${r.cut ? ' (cortada no meio)' : ''}: "${r.text}"`);
  }
  const fresh = prsOf(s).filter((u) => !seen.has(u));
  if (fresh.length) out.push(`  PR novo: ${fresh.join(' ')}`);
  if (s) out.push(`  vez: ${turnOf(s, fresh, events.some((e) => e.kind === 'error'))}`);
  return out;
}

const HEAD = (n) => `[sessions] ${n === 1 ? '1 sessão pede' : `${n} sessões pedem`} você (aviso automático do plugin, não é mensagem do usuário):`;
const TAIL = 'Este aviso basta para agir: atualize o cartão de cada sessão com sessions_card (o tabId vai acima; o done fecha a aba) e responda ao usuário uma linha por sessão, com estado real, o que falta e de quem é a vez. Não chame sessions_list nem leia o transcript, a não ser que uma entrada esteja ambígua ou cortada demais para decidir. Se nada mudou para o usuário, responda numa linha curta.';

/** O aviso ao gerente: uma entrada por sessão que pede ação, já com o resumo; as sessões que esperam na aba e o que o usuário escreveu direto vão no fim. */
function digest(links, events, sessions, now = Date.now(), { waiting = 0, asking = [], direct = [] } = {}) {
  const byKey = new Map();
  for (const e of events) byKey.set(e.key, [...(byKey.get(e.key) || []), e]);
  const body = [...byKey].flatMap(([key, list]) => block(links, key, list, sessions, now));
  const ask = asking.filter((k) => !byKey.has(k));
  const rest = [
    waiting ? `${waiting === 1 ? '1 sessão acabou' : `${waiting} sessões acabaram`} de parar: aviso se não voltarem a rodar.` : '',
    ask.length ? `Esperando o usuário na aba (permissão ou pergunta): ${ask.map((k) => `"${nameOf(links, k, sessions)}"`).join(', ')} → cartão needs_you, e o usuário responde na aba.` : '',
    ...lines(links, direct, sessions),
  ].filter(Boolean);
  return [HEAD(byKey.size), ...body, ...(rest.length ? rest : ['Sem outras novidades.']), TAIL].join('\n');
}

const ASK = 'AskUserQuestion';
const ENDS = new Set(['UserPromptSubmit', 'Stop', 'SessionEnd']);

/** As abas com uma pergunta (AskUserQuestion) aberta, pelos hooks: ela só fecha quando essa ferramenta acaba, não quando acaba outra que rodava junto. */
class Asking {
  constructor() {
    this.tabs = new Set();
  }

  hook(tabId, name, payload) {
    const tool = payload && payload.tool_name;
    if (name === 'PreToolUse' && tool === ASK) this.tabs.add(tabId);
    else if (((name === 'PostToolUse' || name === 'PostToolUseFailure') && tool === ASK) || ENDS.has(name)) this.tabs.delete(tabId);
  }

  has(tabId) {
    return this.tabs.has(tabId);
  }
}

/** O gerente [manager] pode receber agora: parado, sem pergunta (nem a que os hooks dizem que segue aberta, [asking]), sem foco (você pode estar digitando) e sem ter recebido nada nos últimos 5 min. */
function due(node, manager, now = Date.now(), asking = false) {
  const events = node.events || [];
  if (!events.length || !manager || manager.exited || manager.kind !== 'claude' || asking) return false;
  if (manager.hibernated || manager.needsYou || manager.focused || !RESTING.has(manager.status)) return false;
  if (now - events[events.length - 1].at < limits.quiet) return false;
  return now - (node.relayedAt || 0) >= limits.gap;
}

function nameOf(links, key, sessions) {
  const node = links.nodes[key];
  const s = node && sessions.find((x) => x.id === node.tabId && isOpen(x));
  return bare(s ? s.title : node ? node.name : key) || key;
}

/** Separa a fila do gerente: o que acorda agora, o que segue esperando (inclui as passivas), as sessões que ainda esperam na aba e o que o usuário escreveu direto. */
function sort(links, events, sessions, now = Date.now()) {
  const wake = [];
  const keep = [];
  const asking = [];
  const direct = [];
  let passive = 0;
  let waiting = 0;
  for (const e of events) {
    const c = classify(links, e, sessions, now);
    if (c === 'wake') wake.push(e);
    else if (c !== 'drop') keep.push(e);
    if (c === 'wait') waiting++;
    if (c !== 'passive') continue;
    passive++;
    if (e.kind === 'direct') direct.push(e);
    else if (!asking.includes(e.key) && asks(links, e.key, sessions)) asking.push(e.key);
  }
  return { wake, keep, passive, waiting, asking, direct };
}

/** A sessão [key] segue esperando o usuário na aba agora. */
function asks(links, key, sessions) {
  const node = links.nodes[key];
  const s = node && sessions.find((x) => x.id === node.tabId && isOpen(x));
  return Boolean(s && (s.needsYou || PROMPT.has(s.status)));
}

/** Tira da fila do gerente o que a sessão [key] tinha: ela foi fechada pelo gerente, pelo plugin ou pela limpeza. */
function forget(links, key) {
  const node = links.nodes[key];
  const parent = node && links.node(node.parent);
  if (parent && parent.events) parent.events = parent.events.filter((e) => e.key !== key);
}

/** Os PRs que o gerente já viu num aviso não acordam ele de novo. */
function markSeen(links, events, sessions) {
  for (const e of events) {
    const node = links.nodes[e.key];
    const s = node && sessions.find((x) => x.id === node.tabId);
    const prs = prsOf(s);
    if (node && prs.length) node.seenPrs = [...new Set([...(node.seenPrs || []), ...prs])].slice(-20);
  }
}

module.exports = { Asking, Sent, fromUser, queue, forget, lines, digest, excerpt, turnOf, due, classify, sort, markSeen, isPassive, limits };
