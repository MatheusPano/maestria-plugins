// O dia de trabalho dos claudes, pro relógio de ponto da sua sala e o crachá
// de cada um: o tempo trabalhando e os tokens, lidos das conversas que o
// próprio Claude Code grava (`~/.claude/projects/<pasta>/<sessão>.jsonl`).
//
// Conta todas as conversas mexidas hoje, abertas ou não na Maestria. Cada
// arquivo é lido uma vez e, depois, só o que cresceu desde a última leitura.
//
// - os tokens são os de cada resposta (`message.usage`): a entrada, a escrita
//   de cache e a saída. A leitura de cache fica de fora: ela relê a conversa
//   inteira a cada passo e faria qualquer dia parecer de bilhões. Uma resposta
//   com vários blocos vem em várias linhas com o mesmo `message.id`, e conta
//   uma vez. As conversas dos ajudantes (`<sessão>/subagents/*.jsonl`) somam
//   pra sessão de quem os chamou;
// - o tempo trabalhando é, a cada pedido seu, do pedido até a última coisa que
//   ele escreveu antes do pedido seguinte. O dos ajudantes corre junto com o
//   de quem os chamou, e não soma.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const CHUNK = 4 * 1024 * 1024;

/** O dia de [ms], no fuso daqui: "2026-10-14". */
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class Usage {
  constructor({ root = ROOT, now = () => Date.now() } = {}) {
    this.root = root;
    this.now = now;
    this.files = new Map(); // caminho -> o que já foi lido dele
    this.day = dayOf(now());
  }

  /** Os arquivos de conversa mexidos hoje: os das sessões e os dos ajudantes. */
  async todayFiles() {
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    const out = [];
    let projects = [];
    try {
      projects = await fs.promises.readdir(this.root, { withFileTypes: true });
    } catch {
      return out;
    }
    const recent = async (file, sessionId, helper) => {
      try {
        const st = await fs.promises.stat(file);
        if (st.mtimeMs >= start.getTime()) out.push({ file, size: st.size, sessionId, helper });
      } catch {
        // Sumiu no meio: fica pra próxima.
      }
    };
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(this.root, p.name);
      let entries = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          await recent(path.join(dir, e.name), e.name.slice(0, -'.jsonl'.length), false);
        } else if (e.isDirectory()) {
          const sub = path.join(dir, e.name, 'subagents');
          let agents = [];
          try {
            agents = await fs.promises.readdir(sub);
          } catch {
            continue;
          }
          for (const a of agents) if (a.endsWith('.jsonl')) await recent(path.join(sub, a), e.name, true);
        }
      }
    }
    return out;
  }

  /** Lê o que é novo e devolve o dia: `{ total: { tokens, workMs, sessions }, bySession }`. */
  async refresh() {
    const today = dayOf(this.now());
    if (today !== this.day) {
      // Virou o dia: o que foi lido é de ontem. Fica onde parou e recomeça a conta.
      this.day = today;
      for (const st of this.files.values()) Object.assign(st, fresh());
    }
    for (const f of await this.todayFiles()) {
      let st = this.files.get(f.file);
      if (!st || f.size < st.offset) {
        st = { offset: 0, carry: '', sessionId: f.sessionId, helper: f.helper, ...fresh() };
        this.files.set(f.file, st);
      }
      if (f.size > st.offset) await this.readNew(f.file, st, f.size);
    }
    return this.summary();
  }

  async readNew(file, st, size) {
    let fd;
    try {
      fd = await fs.promises.open(file, 'r');
      while (st.offset < size) {
        const len = Math.min(CHUNK, size - st.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fd.read(buf, 0, len, st.offset);
        if (!bytesRead) break;
        st.offset += bytesRead;
        const text = st.carry + buf.toString('utf8', 0, bytesRead);
        const lines = text.split('\n');
        st.carry = lines.pop(); // a última pode ter vindo pela metade
        for (const line of lines) this.take(st, line);
      }
    } catch {
      // Ilegível agora: tenta de novo na próxima.
    } finally {
      if (fd) await fd.close().catch(() => {});
    }
  }

  /** Uma linha da conversa. */
  take(st, line) {
    if (!line || line.length < 20) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const ts = Date.parse(e && e.timestamp);
    if (!Number.isFinite(ts) || dayOf(ts) !== this.day) return;
    const m = e.message;
    if (e.type === 'assistant' && m && m.usage) {
      const id = m.id || e.uuid;
      if (id && !st.seen.has(id)) {
        st.seen.add(id);
        const u = m.usage;
        st.tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      }
    }
    if (st.helper) return;
    // Um pedido seu: fecha o turno anterior e abre outro.
    const prompt =
      e.type === 'user' &&
      !e.isMeta &&
      !e.isSidechain &&
      m &&
      (typeof m.content === 'string' || (Array.isArray(m.content) && !m.content.some((c) => c && c.type === 'tool_result')));
    if (prompt) {
      if (st.turnStart) st.workMs += Math.max(0, st.lastTs - st.turnStart);
      st.turnStart = ts;
      st.lastTs = ts;
    } else if (st.turnStart && (e.type === 'assistant' || e.type === 'user')) {
      st.lastTs = Math.max(st.lastTs, ts);
    }
  }

  summary() {
    const bySession = {};
    for (const st of this.files.values()) {
      const tokens = st.tokens;
      const workMs = st.workMs + (st.turnStart ? Math.max(0, st.lastTs - st.turnStart) : 0);
      if (!tokens && !workMs) continue;
      const s = (bySession[st.sessionId] = bySession[st.sessionId] || { tokens: 0, workMs: 0 });
      s.tokens += tokens;
      s.workMs += workMs;
    }
    const total = { tokens: 0, workMs: 0, sessions: 0 };
    for (const s of Object.values(bySession)) {
      total.tokens += s.tokens;
      total.workMs += s.workMs;
      total.sessions++;
    }
    return { total, bySession };
  }
}

/** A conta zerada de um arquivo (o que já foi lido dele continua lido). */
function fresh() {
  return { tokens: 0, workMs: 0, turnStart: 0, lastTs: 0, seen: new Set() };
}

module.exports = { Usage, dayOf };
