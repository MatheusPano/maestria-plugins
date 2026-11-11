'use strict';
// O diagnóstico: a árvore salva contra as abas abertas, e o que dá pra arrumar com um clique.

const fs = require('fs');
const path = require('path');
const { bare } = require('./links');
const { liveOf } = require('./cards');

const DAY = 24 * 3600 * 1000;
const STALE_MS = 2 * DAY;
const NAMES = 4;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const listed = (names) => names.slice(0, NAMES).map((n) => `"${n}"`).join(', ') + (names.length > NAMES ? ` e mais ${names.length - NAMES}` : '');

function filesIn(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function sizeOf(files) {
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(f).size;
    } catch {}
  }
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** As imagens de prova que nenhum cartão usa mais. */
function strayProofs(links, dataDir) {
  if (!dataDir) return [];
  const used = new Set();
  for (const n of Object.values(links.nodes)) for (const im of (n.card && n.card.proof && n.card.proof.images) || []) used.add(im.rel);
  return filesIn(path.join(dataDir, 'proof')).filter((f) => !used.has(`proof/${f}`)).map((f) => path.join(dataDir, 'proof', f));
}

const brokenCopies = (dataDir) => (dataDir ? filesIn(dataDir).filter((f) => f.startsWith('links.json.estragado-')).map((f) => path.join(dataDir, f)) : []);

/** O que está errado ou velho; [auto] diz o que "arrumar tudo" pode fazer sem perguntar. */
function diagnose(links, sessions, { dataDir = null, now = Date.now() } = {}) {
  const live = liveOf(sessions);
  const name = (k) => bare(links.nodes[k].name) || k;
  const out = [];
  for (const k of Object.keys(links.nodes)) {
    const n = links.nodes[k];
    const open = live.has(n.tabId);
    const kids = links.children(k);
    const openKids = kids.filter((c) => live.has(links.nodes[c].tabId)).length;
    if (!open && openKids) {
      out.push({
        tone: 'red',
        title: `O gerente "${name(k)}" está fechado e tem ${plural(openKids, 'sessão aberta', 'sessões abertas')}`,
        detail: n.sessionId
          ? 'Sem ele, ninguém junta os resultados nem posta cartões. Retomar reabre a conversa dele.'
          : 'Ele nunca reportou o sessionId, então não dá pra retomar: torne uma filha gerente ou ligue as filhas a outro gerente.',
        fix: n.sessionId ? `resume:${k}` : '',
        fixLabel: 'retomar',
      });
    }
    if (!open && !kids.length && !n.card && n.parent) {
      out.push({ tone: 'faint', title: `"${name(k)}" fechou sem deixar cartão`, detail: 'Só ocupa a árvore; sai sozinha em 3 dias.', fix: `forget:${k}`, fixLabel: 'esquecer', auto: true });
    }
    const card = n.card;
    if (card && card.state !== 'done' && now - (card.at || 0) > STALE_MS) {
      const days = Math.floor((now - (card.at || 0)) / DAY);
      out.push({
        tone: 'yellow',
        title: `O cartão de "${name(k)}" não muda há ${plural(days, 'dia', 'dias')}`,
        detail: `${card.state === 'needs_you' ? 'Precisa de você' : 'Trabalhando'}: ${card.headline || (card.action && card.action.text) || 'sem título'}. Se já não vale, dispense.`,
        fix: `dismiss:${k}`,
        fixLabel: 'dispensar',
      });
    }
  }
  const silent = sessions.filter((s) => s.kind === 'claude' && !s.exited && !s.sessionId && s.status !== 'starting');
  if (silent.length) {
    out.push({
      tone: 'yellow',
      title: `${plural(silent.length, 'conversa do Claude não manda', 'conversas do Claude não mandam')} notícias pelos hooks`,
      detail: `${listed(silent.map((s) => bare(s.title) || s.id))}. Sem os hooks, o painel não sabe o estado nem a resposta delas, e uma aba fechada não volta com "retomar". Reabrir a aba costuma resolver; se não, veja se os hooks da Maestria estão instalados no Claude Code.`,
      fix: '',
    });
  }
  const strays = strayProofs(links, dataDir);
  if (strays.length) {
    out.push({ tone: 'faint', title: `${plural(strays.length, 'imagem de prova', 'imagens de prova')} sem cartão (${sizeOf(strays)})`, detail: 'Ficaram de cartões trocados ou esquecidos.', fix: 'sweep:proof', fixLabel: 'apagar', auto: true });
  }
  const broken = brokenCopies(dataDir);
  if (broken.length) {
    out.push({
      tone: 'faint',
      title: `${plural(broken.length, 'cópia estragada', 'cópias estragadas')} do links.json`,
      detail: 'O arquivo estava ilegível ao abrir e a árvore voltou da cópia de segurança; o estragado ficou guardado ao lado.',
      fix: 'sweep:broken',
      fixLabel: 'apagar',
      auto: true,
    });
  }
  return out;
}

/** Apaga as imagens de prova soltas ('proof') ou as cópias estragadas ('broken'). */
function sweep(what, links, dataDir) {
  const files = what === 'proof' ? strayProofs(links, dataDir) : what === 'broken' ? brokenCopies(dataDir) : [];
  for (const f of files) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
  return files.length;
}

/** Os dados da janela do diagnóstico. */
function report(findings, links, sessions) {
  const auto = findings.filter((f) => f.auto);
  const open = liveOf(sessions);
  const nodes = Object.values(links.nodes);
  return {
    summary: findings.length ? plural(findings.length, 'coisa para olhar', 'coisas para olhar') : 'Tudo certo.',
    counts: `${plural(nodes.length, 'sessão', 'sessões')} na árvore, ${nodes.filter((n) => open.has(n.tabId)).length} abertas`,
    findings: findings.map((f) => ({ ...f, hasFix: Boolean(f.fix), act: f.fix || '' })),
    isEmpty: findings.length === 0,
    canFixAll: auto.length > 1,
    fixAllLabel: `arrumar ${auto.length} automáticas`,
  };
}

module.exports = { diagnose, sweep, report };
