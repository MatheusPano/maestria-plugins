'use strict';
// main.js liga `tool.call` a handle(). ctx: { request, home, cwd, tabId, isDir, links, save, showPanel, log } (os testes passam um falso).

const path = require('path');
const { tinted, colorOf, isOpen, bare } = require('./links');
const history = require('./history');
const closer = require('./closer');
const { typeInto } = require('./wake');
const { STATES, MAX_BULLETS, RESTING, PROMPT, agentsOf, running, stateOf, flagOf } = require('./cards');
const relay = require('./relay');
const modelOf = require('./model');
const { proofOf, audioOf, ProofError } = require('./proof');

const KINDS = ['command', 'question', 'approve'];
const LINK = 'maestria://maestria.sessions';
const cardLink = (tabId) => `${LINK}/card/${tabId}`;
const panelLink = (tabId) => `${LINK}/panel/${tabId}`;
const MAX_OPTIONS = 6;
const CONFIRM_STEPS = 20;
const CONFIRM_STEP_MS = 250;

const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

class ToolError extends Error {}

function resolveCwd(cwd, { home, cwd: base, isDir }) {
  const raw = String(cwd || '').trim();
  if (!raw) throw new ToolError('cwd é obrigatório.');
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded) && !base) throw new ToolError(`cwd precisa ser absoluto ou começar com ~/: ${raw}`);
  const dir = path.resolve(base || '/', expanded);
  if (!isDir(dir)) throw new ToolError(`Pasta não existe: ${dir}`);
  return dir;
}

const sessionsOf = async (ctx) => (await ctx.request('sessions.list')) || [];

/** [tabId] as the caller gave it, or the tab that replaced it after a Maestria restart (tab ids change; the conversation does not). */
async function currentTab(ctx, tabId) {
  if (!tabId) return tabId;
  const live = await sessionsOf(ctx);
  if (live.some((s) => s.id === tabId)) return tabId;
  if (ctx.links.reconcile(live)) ctx.save();
  return ctx.links.current(tabId) || tabId;
}

const moved = (asked, tabId) => (asked && asked !== tabId ? { tabIdChanged: { from: asked, to: tabId, note: 'the Maestria restarted and this session got a new tabId; use the new one' } } : {});

async function liveTab(ctx, tabId) {
  const s = (await sessionsOf(ctx)).find((x) => x.id === tabId && isOpen(x));
  if (!s) throw new ToolError(`Nenhuma sessão aberta com tabId ${tabId}; veja sessions_list.`);
  return s;
}

/** Quem chama vira (ou já é) o nó pai; uma sessão solta ganha a cor nova no nome da aba. */
async function parentOf(ctx) {
  const { links } = ctx;
  if (!ctx.tabId) return null;
  const existing = links.byTab(ctx.tabId);
  if (existing) {
    links.nodes[existing].manager = true;
    return existing;
  }
  const me = (await sessionsOf(ctx)).find((s) => s.id === ctx.tabId);
  const { key } = links.ensure(ctx.tabId, me ? me.title : 'gerente');
  const title = tinted(links.nodes[key].name, links.nodes[key].color, true);
  await ctx.request('session.rename', { tabId: ctx.tabId, title }).catch((e) => ctx.log && ctx.log('rename do gerente:', e.message));
  return key;
}

async function open({ cwd, name, prompt, model }, ctx) {
  const dir = resolveCwd(cwd, ctx);
  const label = String(name || '').trim();
  if (!label) throw new ToolError('name é obrigatório.');
  const parent = await parentOf(ctx);
  const color = parent ? ctx.links.nodes[parent].color : null;
  const params = { cwd: dir, label: color ? tinted(label, color) : label, background: true };
  const text = String(prompt || '').trim();
  if (text) params.prompt = text;
  const asked = String(model || '').trim();
  if (asked && !modelOf.valid(asked)) throw new ToolError(`model inválido: ${asked}`);
  const { tabId, model: set } = (await modelOf.openClaude(ctx.request, params, asked, { sleep: ctx.sleep })) || {};
  if (!tabId) throw new ToolError('A Maestria não devolveu a aba da sessão nova.');
  if (parent) ctx.links.add({ tabId, parent, name: label });
  ctx.save();
  return ok({ tabId, name: params.label, cwd: dir, prompted: Boolean(text), ...(asked ? { model: set } : {}), color: color ? colorOf(color).id : null });
}

function summary(s, links, sent, replyOf) {
  const key = links.byTab(s.id);
  const n = links.node(key);
  const parent = n && links.node(n.parent);
  const act = s.activity || {};
  return {
    tabId: s.id,
    kind: s.kind,
    title: s.title,
    cwd: s.cwd,
    branch: s.branch ?? null,
    status: s.status ?? null,
    statusLabel: s.statusLabel ?? null,
    needsYou: Boolean(s.needsYou),
    hibernated: Boolean(s.hibernated),
    backgroundAgents: agentsOf(s),
    color: n ? colorOf(n.color).id : null,
    parentTabId: parent ? parent.tabId : null,
    manager: Boolean(n && n.manager),
    lastPrompt: act.lastPrompt ?? null,
    lastMessage: act.lastMessage ?? null,
    ...(n && n.card ? cardSummary(n.card, withReply(s, replyOf)) : {}),
    ...queuedOf(sent, s.id),
  };
}

/** The last reply joined to a stopped session, as the panel sees it (the card's state depends on it). */
const withReply = (s, replyOf) => (replyOf && !s.reply && s.sessionId && !s.needsYou && (RESTING.has(s.status) || s.hibernated) ? { ...s, reply: replyOf(s) } : s);

/** The card as the manager wrote it, and what the panel shows now when the tab says otherwise (it ended mid-turn, stalled, waits on the user). */
function cardSummary(card, s) {
  const shows = stateOf(card, s);
  const flag = flagOf(card, s);
  return {
    card: cardLink(s.id),
    cardState: card.state,
    cardHeadline: card.headline || null,
    doneBecause: card.doneBecause || null,
    ...(card.auto ? { cardAuto: true } : {}),
    ...(shows !== card.state || flag ? { cardShows: shows, ...(flag ? { cardFlag: flag === 'interrupted' ? 'interrupted: the tab ended or hibernated mid-turn' : 'stalled: stopped while the card says working' } : {}) } : {}),
  };
}

/** The messages sent with sessions_send that the session has not taken as a prompt yet (no prompt hook seen for them). */
function queuedOf(sent, tabId) {
  const q = sent ? sent.status(tabId).queued : [];
  return q.length ? { unconfirmedSends: q.map((m) => ({ text: m.text.length > 200 ? `${m.text.slice(0, 200)}…` : m.text, at: new Date(m.at).toISOString() })) } : {};
}

const LEAN_MESSAGE = 200;

/** The few fields a manager needs to act on a session; `all: true` returns the full summary instead. */
function lean(s, links, sent, replyOf) {
  const full = summary(s, links, sent, replyOf);
  const message = full.lastMessage && full.lastMessage.length > LEAN_MESSAGE ? `${full.lastMessage.slice(0, LEAN_MESSAGE)}…` : full.lastMessage;
  return {
    tabId: full.tabId,
    title: full.title,
    status: full.status,
    ...(full.needsYou ? { needsYou: true } : {}),
    ...(full.backgroundAgents ? { backgroundAgents: full.backgroundAgents } : {}),
    branch: full.branch,
    ...(message ? { lastMessage: message } : {}),
    ...(full.card ? { cardState: full.cardState, cardHeadline: full.cardHeadline } : {}),
    ...(full.cardShows ? { cardShows: full.cardShows } : {}),
    ...(full.cardFlag ? { cardFlag: full.cardFlag } : {}),
    ...(full.cardAuto ? { cardAuto: true } : {}),
    ...(full.unconfirmedSends ? { unconfirmedSends: full.unconfirmedSends } : {}),
  };
}

/** Default: the live claude sessions under the caller. `all: true`: every open tab (shells, plugin tabs, hibernated ones, other managers' trees) with the full summary. */
async function list({ all: everything, mine }, ctx) {
  const open = (await sessionsOf(ctx)).filter((s) => isOpen(s) && !s.embedded);
  if (ctx.links.reconcile(open)) ctx.save();
  if (everything) {
    let out = open.map((s) => summary(s, ctx.links, ctx.sent, ctx.replyOf));
    if (mine) out = out.filter((s) => s.parentTabId === ctx.tabId);
    return ok({ sessions: out, ...takeAnswers(ctx, open) });
  }
  const me = ctx.links.byTab(ctx.tabId);
  const tree = new Set(me ? ctx.links.subtree(me).slice(1).map((k) => ctx.links.nodes[k].tabId) : []);
  const claude = open.filter((s) => s.kind === 'claude' && tree.has(s.id));
  const awake = claude.filter((s) => !s.hibernated);
  const sleeping = claude.length - awake.length;
  return ok({
    sessions: awake.map((s) => lean(s, ctx.links, ctx.sent, ctx.replyOf)),
    ...(sleeping ? { hibernated: sleeping, note: 'hibernated sessions are left out; sessions_send wakes one by tabId, `all: true` lists them' } : {}),
    ...takeAnswers(ctx, open),
  });
}

/** O que chegou pra este gerente desde a última leitura (e esvazia): as respostas nos cartões e as novidades das sessões. */
function takeAnswers(ctx, sessions = []) {
  const n = ctx.links.node(ctx.links.byTab(ctx.tabId));
  if (!n) return {};
  const out = {};
  if (n.inbox && n.inbox.length) {
    out.answers = n.inbox;
    n.inbox = [];
  }
  if (n.events && n.events.length) {
    out.events = relay.lines(ctx.links, n.events, sessions);
    n.events = [];
  }
  if (Object.keys(out).length) ctx.save();
  return out;
}

async function send({ tabId: asked, text }, ctx) {
  const body = String(text || '').trim();
  if (!body) throw new ToolError('text é obrigatório.');
  const tabId = await currentTab(ctx, asked);
  if (tabId === ctx.tabId) throw new ToolError('Não dá pra mandar mensagem pra própria sessão.');
  const s = await liveTab(ctx, tabId);
  if (s.kind !== 'claude') throw new ToolError(`A aba ${tabId} não é uma sessão do claude.`);
  const before = ctx.sent ? ctx.sent.status(tabId).queued : [];
  const sentAt = Date.now();
  let ready;
  try {
    ready = await typeInto({ request: ctx.request, list: () => sessionsOf(ctx) }, s, body);
  } catch (e) {
    throw new ToolError(e.message);
  }
  const key = ctx.links.byTab(tabId);
  if (key && closer.armed(ctx.links.nodes[key].card)) {
    closer.disarm(ctx.links, key);
    ctx.save();
  }
  const busy = running(ready);
  const delivered = await confirmed(ctx, tabId, body, sentAt);
  return ok({
    tabId,
    ...moved(asked, tabId),
    sent: true,
    delivered,
    ...(delivered && busy ? { intoRunningTurn: 'the session was mid-turn: Claude Code took the message at once and shows it to the model at its next step, after any earlier message' } : {}),
    ...(delivered === false ? { notConfirmed: 'typed, but the session has not taken it as a prompt yet (it may still sit in its input box); sessions_list lists it under unconfirmedSends until it does' } : {}),
    woke: Boolean(s.hibernated),
    wasBusy: busy,
    ...(before.length ? { earlierUnconfirmed: before.map((m) => m.text) } : {}),
  });
}

/** Waits for the prompt hook that shows the session took [text], which fires at once even mid-turn (Claude Code 2.1.33, 2026-11-27, docs/technical/mensagem-com-sessao-ocupada.md); null without a sent log. */
async function confirmed(ctx, tabId, text, since) {
  if (!ctx.sent) return null;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < CONFIRM_STEPS; i++) {
    if (ctx.sent.wasDelivered(tabId, text, since)) return true;
    await sleep(CONFIRM_STEP_MS);
  }
  return ctx.sent.wasDelivered(tabId, text, since);
}

async function rename({ tabId: asked, name }, ctx) {
  const tabId = await currentTab(ctx, asked);
  const label = String(name || '').trim();
  if (!label) throw new ToolError('name é obrigatório.');
  await liveTab(ctx, tabId);
  const n = ctx.links.node(ctx.links.byTab(tabId));
  const title = n ? tinted(label, n.color, n.manager) : label;
  const r = await ctx.request('session.rename', { tabId, title });
  if (n) {
    n.name = label;
    ctx.save();
  }
  return ok({ tabId, ...moved(asked, tabId), title: (r && r.title) || title });
}

async function close({ tabId: asked }, ctx) {
  const { links } = ctx;
  const tabId = await currentTab(ctx, asked);
  if (!tabId) throw new ToolError('tabId é obrigatório.');
  if (tabId === ctx.tabId) throw new ToolError('Não dá pra fechar a própria sessão.');
  const me = links.byTab(ctx.tabId);
  const key = links.byTab(tabId);
  if (!me || !key || !links.subtree(me).includes(key)) throw new ToolError(`A aba ${tabId} não está na sua árvore; só fecha quem você abriu ou ligou.`);
  const s = await liveTab(ctx, tabId);
  if (s.kind !== 'claude') throw new ToolError(`A aba ${tabId} não é uma sessão do claude.`);
  if (!s.hibernated && !RESTING.has(s.status) && s.status !== 'ended') {
    throw new ToolError(`A sessão ${tabId} está ${s.statusLabel || s.status}; só fecha quando ela termina o turno e não está esperando o usuário.`);
  }
  if (agentsOf(s)) throw new ToolError(`A sessão ${tabId} ainda tem ${agentsOf(s)} agente(s) rodando em segundo plano; espere eles terminarem.`);
  const reply = s.reply || (ctx.replyOf ? ctx.replyOf(s) : null);
  const entry = history.record(links, { key, session: { ...s, reply }, by: `gerente ${bare(links.nodes[me].name)}` });
  try {
    await ctx.request('session.close', { tabId });
  } catch (e) {
    history.forget(links, entry.id);
    throw e;
  }
  relay.forget(links, key);
  ctx.save();
  const body = `${entry.name}: ${history.whatOf(entry)}`;
  await ctx.request('window.notify', { title: 'Sessão fechada pelo gerente', body }).catch(() => ctx.request('window.showBanner', { text: `fechada: ${body}` }).catch(() => {}));
  return ok({ tabId, ...moved(asked, tabId), closed: true });
}

function optionsOf(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ToolError('action.options precisa ser uma lista.');
  if (raw.length > MAX_OPTIONS) throw new ToolError(`No máximo ${MAX_OPTIONS} opções.`);
  return raw.map((o, i) => {
    const label = String((o && o.label) || '').trim();
    if (!label) throw new ToolError('cada opção precisa de label.');
    return {
      key: String((o && o.key) || String.fromCharCode(65 + i)).trim().slice(0, 3),
      label,
      recommended: Boolean(o && o.recommended),
      audio: o && o.audio ? audioOf(o.audio).path : null,
    };
  });
}

function actionOf(action) {
  if (!action) return null;
  if (!action.text || !KINDS.includes(action.kind)) throw new ToolError(`action precisa de text e de kind ${KINDS.map((k) => `"${k}"`).join(', ')}.`);
  const options = optionsOf(action.options);
  if (options.length && action.kind !== 'question') throw new ToolError('options só vale numa action "question".');
  return {
    kind: action.kind,
    text: String(action.text),
    where: action.where ? String(action.where) : null,
    tabId: action.tabId || null,
    options,
  };
}

const TRUNK = new Set(['main', 'master', 'develop', 'dev']);
const PULL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

/** O que impede um "done" ([blockers]) e o que só merece aviso ([warnings]): sessão rodando ou esperando, PR aberto, commit sem push, pasta suja. */
async function doneChecks(s, prs, ctx) {
  const blockers = [];
  const warnings = [];
  if (s.needsYou || PROMPT.has(s.status)) blockers.push(`a sessão está esperando o usuário na aba (${s.statusLabel || s.status})`);
  else if (s.status && !s.hibernated && !RESTING.has(s.status) && !['ended', 'unknown'].includes(s.status)) blockers.push(`a sessão ainda está trabalhando (${s.statusLabel || s.status})`);
  else if (agentsOf(s)) blockers.push(`a sessão ainda tem ${agentsOf(s)} agente(s) rodando em segundo plano`);
  if (!ctx.exec) return { blockers, warnings };
  for (const url of [...new Set(prs.filter((u) => PULL.test(u)).map((u) => u.match(PULL)[0]))]) {
    const r = await ctx.exec('gh', ['pr', 'view', url, '--json', 'state', '-q', '.state']);
    if (r.code !== 0) warnings.push(`não deu pra conferir ${url} com o gh`);
    else if (r.stdout.trim() === 'OPEN') blockers.push(`o PR ${url} ainda está aberto`);
  }
  if (!s.cwd) return { blockers, warnings };
  const git = (...args) => ctx.exec('git', ['-C', s.cwd, ...args]);
  const head = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (head.code !== 0) return { blockers, warnings };
  const branch = head.stdout.trim();
  const ahead = await git('rev-list', '--count', '@{u}..HEAD');
  if (ahead.code === 0 && Number(ahead.stdout) > 0) blockers.push(`${Number(ahead.stdout)} commit(s) sem push em ${branch}`);
  if (ahead.code !== 0 && !TRUNK.has(branch)) {
    const local = await git('rev-list', '--count', 'HEAD', '--not', '--remotes');
    if (local.code === 0 && Number(local.stdout) > 0) blockers.push(`a branch ${branch} nunca foi enviada (${Number(local.stdout)} commit(s) só aqui)`);
  }
  const dirty = await git('status', '--porcelain');
  if (dirty.code === 0 && dirty.stdout.trim()) warnings.push(`${dirty.stdout.trim().split('\n').length} arquivo(s) alterados sem commit em ${s.cwd}`);
  return { blockers, warnings };
}

async function card({ tabId: asked, state, headline, bullets, action, proof, doneBecause, keepOpen }, ctx) {
  if (!STATES.includes(state)) throw new ToolError(`state precisa ser um de: ${STATES.join(', ')}.`);
  const because = String(doneBecause || '').trim();
  if (state === 'done' && !because) {
    throw new ToolError('done precisa de doneBecause: o que fez a tarefa acabar (ex.: "PR #12 mergeado", "deploy feito", "só investigação, sem código"). Se ainda falta algo, é needs_you ou working.');
  }
  const list = (Array.isArray(bullets) ? bullets : []).map((b) => String(b).trim()).filter(Boolean);
  if (list.length > MAX_BULLETS) throw new ToolError(`No máximo ${MAX_BULLETS} bullets por cartão.`);
  const act = actionOf(action);
  const tabId = await currentTab(ctx, asked);
  if (tabId === ctx.tabId) throw new ToolError('O cartão é de uma sessão que você abriu, não de você: passe o tabId dela.');
  const mine = ctx.links.byTab(ctx.tabId);
  const theirs = ctx.links.byTab(tabId);
  if (theirs && !(mine && ctx.links.subtree(mine).includes(theirs))) {
    throw new ToolError(`A aba ${tabId} está na árvore de outro gerente; só escreve cartão de quem você abriu ou ligou.`);
  }
  const s = await liveTab(ctx, tabId);
  if (act && act.tabId) {
    act.tabId = await currentTab(ctx, act.tabId);
    await liveTab(ctx, act.tabId);
  }
  let staged;
  try {
    staged = proofOf(proof, ctx.dataDir);
  } catch (e) {
    if (e instanceof ProofError) throw new ToolError(e.message);
    throw e;
  }
  let warnings = [];
  if (state === 'done') {
    const found = ctx.prsOf ? ctx.prsOf(s) : [];
    const checked = await doneChecks(s, [...((staged && staged.prs) || []).map((p) => p.url), ...found], ctx);
    if (checked.blockers.length) {
      throw new ToolError(`Ainda não é done: ${checked.blockers.join('; ')}. Use needs_you (com o PR em proof) ou working, e diga ao usuário o que falta.`);
    }
    warnings = checked.warnings;
  }
  const parent = await parentOf(ctx);
  if (!parent) throw new ToolError('Só um gerente escreve cartões: chame de uma sessão da Maestria.');
  const { links } = ctx;
  let key = links.byTab(tabId);
  if (!key) {
    key = links.link(tabId, parent, s.title);
    await ctx.request('session.rename', { tabId, title: tinted(s.title, links.nodes[key].color, links.nodes[key].manager) }).catch(() => {});
  }
  const prev = links.nodes[key].card || {};
  delete links.nodes[key].pending;
  const now = Date.now();
  links.nodes[key].card = {
    state,
    headline: headline ? String(headline).trim() : null,
    bullets: list,
    action: act,
    proof: staged,
    at: now,
    since: prev.state === state && prev.since ? prev.since : now,
    doneAt: state === 'done' ? (prev.state === 'done' && prev.doneAt) || now : null,
    doneBecause: state === 'done' ? because : null,
    busy: Boolean(links.nodes[key].busy),
    onPrompt: PROMPT.has(s.status),
    keepOpen: state === 'done' && keepOpen === true,
    ...(state === 'done' ? { closeFor: keepOpen === true ? null : s.sessionId || null } : {}),
  };
  ctx.save();
  if (ctx.showPanel) await ctx.showPanel(links.rootOf(key));
  const closing = state === 'done' && keepOpen !== true ? { closes: 'a aba fecha sozinha quando a sessão parar e vai para o histórico; depois disso só você a retoma pelo painel (keepOpen: true mantém aberta)' } : {};
  return ok({ tabId, ...moved(asked, tabId), state, ...closing, cards: links.subtree(links.rootOf(key)).length - 1, link: cardLink(tabId), panel: panelLink(ctx.tabId), ...(warnings.length ? { warnings } : {}), ...takeAnswers(ctx, await sessionsOf(ctx)) });
}

const HANDLERS = { sessions_open: open, sessions_list: list, sessions_send: send, sessions_rename: rename, sessions_card: card, sessions_close: close };

async function handle(name, args, ctx) {
  const fn = HANDLERS[name];
  if (!fn) return fail(`ferramenta desconhecida: ${name}`);
  try {
    return await fn(args || {}, ctx);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (!(e instanceof ToolError) && ctx.log) ctx.log(`ferramenta ${name} falhou:`, msg);
    return fail(msg);
  }
}

module.exports = { handle, resolveCwd, ToolError, LINK };
