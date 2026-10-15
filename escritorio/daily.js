// A reunião da daily: o que cada conversa do Claude Code fez desde a daily
// anterior, o que ficou pendente e algo interessante do caminho (a causa de um
// bug, uma decisão de implementação), resumido por um `claude -p` sem
// ferramentas e sem gravar sessão.
//
// O período vai da daily anterior até agora. Com o horário configurado (a
// opção "horário da daily", ex.: 14:00), a daily "da vez" é a próxima -- ou a
// que acabou de acontecer, até duas horas depois --, e a anterior é a do dia
// útil antes dela: numa daily às 14h, a de terça conta de segunda 14h até
// agora, e a de segunda, desde sexta 14h. Sem horário, o período é o dia de
// hoje (o "fim do expediente").
//
// As conversas saem dos arquivos que o Claude Code grava
// (`~/.claude/projects/<pasta>/<sessão>.jsonl`): os pedidos, a última fala de
// cada turno, os arquivos mexidos e os comandos que contam (commit, testes,
// push). Cada uma vira um resumo curto em texto, e o modelo escreve o resto.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { cleanPrompt } = require('./chat');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const HOUR = 3600 * 1000;
const MAX_CONVERSATIONS = 14;
const DIGEST_CHARS = 5000;

/** "14:00" -> { h: 14, m: 0 }, ou null. */
function parseTime(text) {
  const m = /^\s*(\d{1,2})(?::|h)?(\d{2})?\s*$/.exec(String(text || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  return h < 24 && min < 60 ? { h, m: min } : null;
}

function workday(date, weekends) {
  const d = date.getDay();
  return weekends || (d !== 0 && d !== 6);
}

/** O horário [t] no dia de [date]. */
function at(date, t) {
  const d = new Date(date);
  d.setHours(t.h, t.m, 0, 0);
  return d;
}

/** A daily útil antes de [slot]. */
function previousSlot(slot, t, weekends) {
  const d = new Date(slot);
  for (let i = 0; i < 8; i++) {
    d.setDate(d.getDate() - 1);
    if (workday(d, weekends)) return at(d, t);
  }
  return at(new Date(slot.getTime() - 24 * HOUR), t);
}

/**
 * O período do resumo: `{ from, to, slot, label }`. [slot] é a daily da vez
 * (null sem horário configurado).
 */
function periodOf(now, { time = '', weekends = false } = {}) {
  const t = parseTime(time);
  const nowD = new Date(now);
  if (!t) {
    const from = new Date(nowD);
    from.setHours(0, 0, 0, 0);
    return { from: from.getTime(), to: now, slot: null, label: 'hoje' };
  }
  // A daily da vez: a de hoje, se ainda não passou (ou passou faz menos de
  // duas horas); senão a do próximo dia útil.
  let slot = at(nowD, t);
  if (!workday(nowD, weekends) || now - slot.getTime() > 2 * HOUR) {
    const d = new Date(nowD);
    for (let i = 0; i < 8; i++) {
      d.setDate(d.getDate() + 1);
      if (workday(d, weekends)) break;
    }
    slot = at(d, t);
  }
  const from = previousSlot(slot, t, weekends);
  return { from: from.getTime(), to: now, slot: slot.getTime(), label: `desde ${when(from)}` };
}

const DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/**
 * "segunda 14:00", ou "hoje 09:30" (e "ontem", "amanhã"); com [full], a data a
 * mais ("segunda 13/10 14:00"); sem [time], só o dia ("hoje", "segunda 13/10").
 */
function when(date, now = Date.now(), { full = false, time = true } = {}) {
  const d = new Date(date);
  const hm = time ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  const near = (days) => {
    const x = new Date(now);
    x.setDate(x.getDate() + days);
    return x.toDateString() === d.toDateString();
  };
  if (near(0)) return `hoje${hm}`;
  if (near(-1)) return `ontem${hm}`;
  if (near(1)) return `amanhã${hm}`;
  const dm = full ? ` ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}` : '';
  return `${DAYS[d.getDay()]}${dm}${hm}`;
}

// --- as conversas -------------------------------------------------------------------

/**
 * As conversas com atividade no período, cada uma resumida em texto:
 * `[{ sessionId, cwd, branch, title, prompts, digest, last }]`, das mais
 * movimentadas pras menos. [skip] são pastas de projeto a ignorar (a da
 * própria daily); [outside], as pastas cujas conversas (as delas e as de
 * dentro delas) ficam fora da daily.
 */
async function conversations({ from, to }, { root = ROOT, skip = [], outside = [] } = {}) {
  const out = [];
  let projects = [];
  try {
    projects = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory() || skip.includes(p.name)) continue;
    const dir = path.join(root, p.name);
    let files = [];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      let st;
      try {
        st = await fs.promises.stat(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < from) continue;
      const c = await digestOf(file, { from, to });
      if (c && !within(c.cwd, outside)) out.push({ sessionId: f.slice(0, -'.jsonl'.length), ...c });
    }
  }
  out.sort((a, b) => b.weight - a.weight);
  return out.slice(0, MAX_CONVERSATIONS);
}

const cwds = new Map();

/**
 * A pasta da conversa [sessionId], lida do arquivo dela (o começo basta). Os
 * resumos guardados antes de terem a pasta de cada trabalho usam isso.
 */
function cwdOf(sessionId, { root = ROOT } = {}) {
  if (!sessionId) return '';
  if (cwds.has(sessionId)) return cwds.get(sessionId);
  let cwd = '';
  try {
    for (const p of fs.readdirSync(root)) {
      const file = path.join(root, p, `${sessionId}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
      if (m) cwd = JSON.parse(`"${m[1]}"`);
      break;
    }
  } catch {
    // Sem a pasta: o trabalho fica na daily.
  }
  cwds.set(sessionId, cwd);
  return cwd;
}

/** [cwd] é uma das [folders], ou fica dentro de uma delas? */
function within(cwd, folders) {
  if (!cwd) return false;
  return folders.some((f) => f && (cwd === f || cwd.startsWith(f.endsWith(path.sep) ? f : f + path.sep)));
}

/** O que uma conversa fez no período, em texto curto; null se ela não fez nada nele. */
async function digestOf(file, { from, to }) {
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let cwd = '';
  let branch = '';
  const prompts = [];
  const replies = []; // a última fala de cada turno
  let lastText = '';
  const files = new Set();
  const commands = [];
  let weight = 0;
  let last = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(e && e.timestamp);
    if (!Number.isFinite(ts) || ts < from || ts > to) continue;
    if (e.isSidechain || e.isMeta || !e.message) continue;
    if (e.cwd) cwd = e.cwd;
    if (e.gitBranch) branch = e.gitBranch;
    const content = e.message.content;
    if (e.type === 'user') {
      const raw = typeof content === 'string' ? content : Array.isArray(content) && !content.some((c) => c && c.type === 'tool_result') ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : null;
      const p = raw !== null && cleanPrompt(raw);
      if (p && p.text) {
        if (lastText) replies.push(lastText);
        lastText = '';
        prompts.push(clip(p.text, 300));
        weight += 3;
        last = ts;
      }
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      last = ts;
      for (const c of content) {
        if (c.type === 'text' && c.text && c.text.trim()) lastText = c.text.trim();
        else if (c.type === 'tool_use') {
          weight++;
          const input = c.input || {};
          if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name)) files.add(path.basename(String(input.file_path || input.notebook_path || '')));
          if (c.name === 'Bash') {
            const cmd = String(input.command || '');
            if (/\bgit\s+(commit|push|merge|rebase)\b|\b(test|pytest|jest|vitest)\b|gh\s+pr\b/.test(cmd)) commands.push(clip(cmd, 160));
          }
        }
      }
    }
  }
  if (lastText) replies.push(lastText);
  if (!prompts.length && !replies.length) return null;
  const parts = [
    `pedidos:\n${prompts.slice(-12).map((p) => `- ${p}`).join('\n')}`,
    files.size ? `arquivos mexidos: ${[...files].filter(Boolean).slice(0, 20).join(', ')}` : '',
    commands.length ? `comandos:\n${commands.slice(-10).map((c) => `- ${c}`).join('\n')}` : '',
    replies.length ? `o que ele respondeu no fim dos turnos:\n${replies.slice(-6).map((r) => `- ${clip(r, 700)}`).join('\n')}` : '',
  ].filter(Boolean);
  return {
    cwd,
    branch,
    title: clip(prompts[0] || path.basename(cwd), 80),
    weight,
    last,
    digest: clip(parts.join('\n\n'), DIGEST_CHARS),
  };
}

function clip(text, n) {
  const t = String(text || '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// --- o resumo -------------------------------------------------------------------------

/** O pedido pro modelo: as conversas, o pendente da daily anterior e o formato da resposta. */
function promptOf({ period, convs, previous, style }) {
  const pend = previous && Array.isArray(previous.items) ? previous.items.filter((i) => i.pendente).map((i) => `- [${i.nome}] ${i.pendente}`) : [];
  return [
    'Você prepara o resumo de uma pessoa desenvolvedora pra reunião diária (daily) do time, a partir das conversas dela com o Claude Code.',
    `Período: ${period.label} até agora.`,
    'Para CADA conversa abaixo, escreva em português, curto (no máximo duas frases curtas por campo, sem enrolação):',
    '- "fiz": o que foi feito, do ponto de vista do produto/tarefa (não liste arquivos);',
    '- "pendente": o que ficou por fazer ou bloqueado ("" se nada);',
    '- "curioso": uma coisa interessante pra contar — a causa de um bug, uma decisão de implementação, uma pegadinha descoberta ("" se não houver nada que valha).',
    'Junte conversas da mesma tarefa num item só quando for claramente o mesmo trabalho. Ignore conversas triviais (perguntas soltas sem trabalho).',
    pend.length ? `Pendências da daily anterior (diga quais foram resolvidas no período):\n${pend.join('\n')}` : '',
    style ? `Preferências da pessoa pro texto: ${style}` : '',
    'Responda SÓ com um JSON, sem cercas de código, neste formato:',
    '{"items":[{"sessao":"<id da conversa>","nome":"<nome curto do trabalho, com o TASK#/BUG# se houver>","fiz":"...","pendente":"...","curioso":"..."}],"resolvido":["<pendência anterior resolvida>"],"daily":"<o texto pra falar na daily, em primeira pessoa, 3 a 8 linhas, em markdown com tópicos>"}',
    '',
    ...convs.map((c) => `### conversa ${c.sessionId}\npasta: ${c.cwd}${c.branch ? ` · branch: ${c.branch}` : ''}\n${c.digest}`),
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** Roda o `claude -p` com [prompt] e devolve o texto da resposta. */
function ask(prompt, { model = 'sonnet', cwd, timeout = 180000, bin = 'claude' } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(cwd, { recursive: true });
    const p = spawn(bin, ['-p', '--model', model, '--no-session-persistence', '--tools', '', '--output-format', 'json'], {
      cwd,
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('o resumo demorou demais'));
    }, timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'não achei o `claude` no PATH' : e.message));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) return reject(new Error(clip(err || `o claude saiu com ${code}`, 300)));
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(clip(j.result || 'o claude deu erro', 300)));
        resolve(String(j.result || ''));
      } catch {
        resolve(out);
      }
    });
    p.stdin.end(prompt);
  });
}

/** O JSON da resposta (mesmo com cercas de código ou texto em volta). */
function parseSummary(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('o resumo não veio no formato esperado');
  const j = JSON.parse(t.slice(start, end + 1));
  const items = (Array.isArray(j.items) ? j.items : []).map((i) => ({
    sessao: String(i.sessao || i.session || ''),
    nome: clip(i.nome || i.name || '', 90),
    fiz: clip(i.fiz || '', 400),
    pendente: clip(i.pendente || '', 300),
    curioso: clip(i.curioso || '', 300),
  }));
  return {
    items: items.filter((i) => i.fiz || i.pendente || i.curioso),
    resolvido: (Array.isArray(j.resolvido) ? j.resolvido : []).map((x) => clip(x, 200)).filter(Boolean),
    daily: String(j.daily || '').trim(),
  };
}

// --- o que fica guardado ------------------------------------------------------------

function folderOf(dataDir) {
  return path.join(dataDir, 'dailies');
}

function save(dataDir, summary) {
  const dir = folderOf(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date(summary.at).toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  // Os de mais de um mês saem.
  const old = Date.now() - 31 * 24 * HOUR;
  for (const f of fs.readdirSync(dir)) {
    try {
      if (fs.statSync(path.join(dir, f)).mtimeMs < old) fs.rmSync(path.join(dir, f));
    } catch {
      // Fica pra próxima.
    }
  }
  return file;
}

/** Os resumos guardados, dos mais novos pros mais velhos. */
function list(dataDir) {
  const dir = folderOf(dataDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s && Number.isFinite(s.at)) out.push(s);
    } catch {
      // Um arquivo estragado não para a daily.
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** O último resumo guardado antes de [before]. */
function latest(dataDir, before = Infinity) {
  return list(dataDir).find((s) => s.at < before) || null;
}

/**
 * A daily de que [s] é -- um resumo guardado ou um período (`periodOf`): o
 * horário dela, ou o começo do dia sem horário configurado. Os resumos
 * refeitos pra mesma daily têm a mesma.
 */
function keyOf(s) {
  const p = s && s.period ? s.period : s;
  return (p && (p.slot || p.from)) || (s && s.at) || 0;
}

/** Os resumos guardados, um por daily (o mais novo de cada), das mais novas pras mais velhas. */
function dailies(dataDir) {
  const seen = new Set();
  return list(dataDir)
    .filter((s) => !seen.has(keyOf(s)) && seen.add(keyOf(s)))
    .sort((a, b) => keyOf(b) - keyOf(a));
}

/** A pasta de projeto (no `~/.claude/projects`) de [cwd]: a daily não lê a própria. */
function projectName(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

module.exports = { parseTime, periodOf, when, conversations, digestOf, promptOf, ask, parseSummary, save, list, latest, keyOf, dailies, within, cwdOf, projectName };
