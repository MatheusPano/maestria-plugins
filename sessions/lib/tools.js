'use strict';
// main.js liga `tool.call` a handle(). ctx: { request, home, cwd, tabId, isDir, links, save, showPanel, log } (os testes passam um falso).

const path = require('path');
const { tinted, colorOf } = require('./links');
const { STATES, MAX_BULLETS, RESTING, PROMPT } = require('./cards');
const relay = require('./relay');
const { proofOf, audioOf, ProofError } = require('./proof');

const KINDS = ['command', 'question', 'approve'];
const LINK = 'maestria://maestria.sessions';
const cardLink = (tabId) => `${LINK}/card/${tabId}`;
const panelLink = (tabId) => `${LINK}/panel/${tabId}`;
const MAX_OPTIONS = 6;

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

async function liveTab(ctx, tabId) {
  const s = (await sessionsOf(ctx)).find((x) => x.id === tabId && !x.exited);
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

async function open({ cwd, name, prompt }, ctx) {
  const dir = resolveCwd(cwd, ctx);
  const label = String(name || '').trim();
  if (!label) throw new ToolError('name é obrigatório.');
  const parent = await parentOf(ctx);
  const color = parent ? ctx.links.nodes[parent].color : null;
  const params = { cwd: dir, label: color ? tinted(label, color) : label, background: true };
  const text = String(prompt || '').trim();
  if (text) params.prompt = text;
  const { tabId } = (await ctx.request('session.openClaude', params)) || {};
  if (!tabId) throw new ToolError('A Maestria não devolveu a aba da sessão nova.');
  if (parent) ctx.links.add({ tabId, parent, name: label });
  ctx.save();
  return ok({ tabId, name: params.label, cwd: dir, prompted: Boolean(text), color: color ? colorOf(color).id : null });
}

function summary(s, links) {
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
    color: n ? colorOf(n.color).id : null,
    parentTabId: parent ? parent.tabId : null,
    manager: Boolean(n && n.manager),
    lastPrompt: act.lastPrompt ?? null,
    lastMessage: act.lastMessage ?? null,
    ...(n && n.card
      ? { card: cardLink(s.id), cardState: n.card.state, cardHeadline: n.card.headline || null, doneBecause: n.card.doneBecause || null }
      : {}),
  };
}

async function list({ mine }, ctx) {
  const all = (await sessionsOf(ctx)).filter((s) => !s.exited && !s.embedded);
  if (ctx.links.reconcile(all)) ctx.save();
  let out = all.map((s) => summary(s, ctx.links));
  if (mine) {
    const me = ctx.links.byTab(ctx.tabId);
    out = out.filter((s) => me && s.parentTabId === ctx.tabId);
  }
  return ok({ sessions: out, ...takeAnswers(ctx, all) });
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

async function send({ tabId, text }, ctx) {
  const body = String(text || '').trim();
  if (!body) throw new ToolError('text é obrigatório.');
  if (tabId === ctx.tabId) throw new ToolError('Não dá pra mandar mensagem pra própria sessão.');
  const s = await liveTab(ctx, tabId);
  if (s.kind !== 'claude') throw new ToolError(`A aba ${tabId} não é uma sessão do claude.`);
  if (s.hibernated) throw new ToolError(`A sessão ${tabId} está hibernada; peça pro usuário acordá-la.`);
  if (s.status === 'waitingPermission' || s.status === 'waitingAnswer') {
    throw new ToolError(`A sessão ${tabId} está esperando o usuário (${s.statusLabel || s.status}); a mensagem cairia no meio da pergunta.`);
  }
  await ctx.request('terminal.sendText', { tabId, text: body, submit: true });
  return ok({ tabId, sent: true, wasBusy: s.status === 'working' || s.status === 'tool' });
}

async function rename({ tabId, name }, ctx) {
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
  return ok({ tabId, title: (r && r.title) || title });
}

async function close({ tabId }, ctx) {
  const { links } = ctx;
  if (!tabId) throw new ToolError('tabId é obrigatório.');
  if (tabId === ctx.tabId) throw new ToolError('Não dá pra fechar a própria sessão.');
  const me = links.byTab(ctx.tabId);
  const key = links.byTab(tabId);
  if (!me || !key || !links.subtree(me).includes(key)) throw new ToolError(`A aba ${tabId} não está na sua árvore; só fecha quem você abriu ou ligou.`);
  const s = await liveTab(ctx, tabId);
  if (s.kind !== 'claude') throw new ToolError(`A aba ${tabId} não é uma sessão do claude.`);
  if (!s.hibernated && !RESTING.has(s.status)) {
    throw new ToolError(`A sessão ${tabId} está ${s.statusLabel || s.status}; só fecha quando ela termina o turno e não está esperando o usuário.`);
  }
  await ctx.request('session.close', { tabId });
  return ok({ tabId, closed: true });
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

async function card({ tabId, state, headline, bullets, action, proof, doneBecause }, ctx) {
  if (!STATES.includes(state)) throw new ToolError(`state precisa ser um de: ${STATES.join(', ')}.`);
  const because = String(doneBecause || '').trim();
  if (state === 'done' && !because) {
    throw new ToolError('done precisa de doneBecause: o que fez a tarefa acabar (ex.: "PR #12 mergeado", "deploy feito", "só investigação, sem código"). Se ainda falta algo, é needs_you ou working.');
  }
  const list = (Array.isArray(bullets) ? bullets : []).map((b) => String(b).trim()).filter(Boolean);
  if (list.length > MAX_BULLETS) throw new ToolError(`No máximo ${MAX_BULLETS} bullets por cartão.`);
  const act = actionOf(action);
  if (tabId === ctx.tabId) throw new ToolError('O cartão é de uma sessão que você abriu, não de você: passe o tabId dela.');
  const mine = ctx.links.byTab(ctx.tabId);
  const theirs = ctx.links.byTab(tabId);
  if (theirs && !(mine && ctx.links.subtree(mine).includes(theirs))) {
    throw new ToolError(`A aba ${tabId} está na árvore de outro gerente; só escreve cartão de quem você abriu ou ligou.`);
  }
  const s = await liveTab(ctx, tabId);
  if (act && act.tabId) await liveTab(ctx, act.tabId);
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
  };
  ctx.save();
  if (ctx.showPanel) await ctx.showPanel(links.rootOf(key));
  return ok({ tabId, state, cards: links.subtree(links.rootOf(key)).length - 1, link: cardLink(tabId), panel: panelLink(ctx.tabId), ...(warnings.length ? { warnings } : {}), ...takeAnswers(ctx, await sessionsOf(ctx)) });
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
