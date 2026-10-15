// A conversa de um claude, pra janelinha de chat do escritório: lida do arquivo
// que o próprio Claude Code grava (`~/.claude/projects/<pasta>/<sessão>.jsonl`).
//
// O terminal não é exposto aos plugins, e não precisa: a transcrição tem os
// pedidos, as respostas e as ferramentas, na ordem. O caminho vem no
// `transcript_path` de qualquer hook; antes do primeiro hook (o plugin subiu
// com a sessão já aberta), sai do `sessionId` e da pasta da sessão.
//
// Só o fim do arquivo é lido -- uma conversa longa passa de alguns MB, e a
// janela mostra as últimas mensagens.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, clip } = require('./world');

const TAIL_BYTES = 768 * 1024;

/** A pasta do projeto do jeito que o Claude Code a nomeia: tudo que não é letra ou número vira `-`. */
function projectDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

/** O arquivo da conversa de [agent], ou `null` enquanto não dá pra saber qual é. */
function transcriptOf(agent) {
  if (agent.transcript && fs.existsSync(agent.transcript)) return agent.transcript;
  if (agent.sessionId && agent.cwd) {
    const file = path.join(projectDir(agent.cwd), `${agent.sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** As linhas do fim do arquivo (sem a primeira, que pode ter vindo cortada). */
function tailLines(file, bytes = TAIL_BYTES) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } finally {
    fs.closeSync(fd);
  }
}

/** O texto de um pedido, sem o que o Claude Code e a Maestria põem em volta. */
function cleanPrompt(text) {
  let t = String(text || '');
  const command = t.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (command) {
    const args = (t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1];
    return { cmd: `${command[1]}${args && args.trim() ? ` ${args.trim()}` : ''}` };
  }
  if (/^\s*<(local-command-stdout|local-command-stderr|command-message|bash-stdout|bash-stderr)/.test(t)) return null;
  if (/^\s*Caveat: The messages below/.test(t)) return null;
  t = t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[texto colado]')
    .replace(/^\[Image: source: [^\]]*\]\s*$/gm, '')
    .trim();
  return t ? { text: t } : null;
}

/**
 * As mensagens da conversa, da mais antiga pra mais nova: `you` (o pedido),
 * `claude` (a resposta), `tool` (as ferramentas daquele trecho, numa linha só),
 * `cmd` (um comando, como o `/compact`) e `ask` (uma pergunta do
 * `AskUserQuestion`, com as opções e, depois de respondida, a escolha).
 */
function conversation(file, { limit = 40 } = {}) {
  const items = [];
  const push = (who, text) => {
    const last = items[items.length - 1];
    if (who === 'tool' && last && last.who === 'tool') {
      last.tools.push(text);
      return;
    }
    if (who === 'claude' && last && last.who === 'claude') {
      last.text = `${last.text}\n\n${text}`;
      return;
    }
    items.push(who === 'tool' ? { who, tools: [text] } : { who, text });
  };
  const asks = new Map(); // id do tool_use -> a pergunta, pra marcar a resposta
  for (const line of tailLines(file)) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || e.isSidechain || e.isMeta || !e.message) continue;
    const content = e.message.content;
    if (e.type === 'user') {
      if (typeof content === 'string') {
        const p = cleanPrompt(content);
        if (p && p.cmd) push('cmd', p.cmd);
        else if (p) push('you', p.text);
      } else if (Array.isArray(content)) {
        for (const c of content) {
          const ask = c.type === 'tool_result' && asks.get(c.tool_use_id);
          if (ask) answer(ask, c, e.toolUseResult);
        }
        if (content.some((c) => c.type === 'tool_result')) continue;
        const text = content
          .map((c) => (c.type === 'text' ? (cleanPrompt(c.text) || {}).text || '' : c.type === 'image' ? '[imagem]' : ''))
          .filter(Boolean)
          .join('\n');
        if (text) push('you', text);
      }
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text && c.text.trim()) push('claude', c.text.trim());
        else if (c.type === 'tool_use' && c.name === 'AskUserQuestion') {
          const ask = askOf(c.input || {}, c.id);
          items.push(ask);
          if (c.id) asks.set(c.id, ask);
        } else if (c.type === 'tool_use') push('tool', describe(c.name, c.input || {}).label);
      }
    }
  }
  return items.slice(-limit).map((m) => {
    if (m.who === 'tool') {
      const shown = m.tools.slice(-3);
      const more = m.tools.length - shown.length;
      return { who: 'tool', text: `› ${shown.join(' · ')}${more > 0 ? ` · +${more}` : ''}` };
    }
    if (m.who === 'ask') return askData(m);
    // A resposta vem inteira (o chat rola); o teto só segura uma saída
    // descomunal, que pesaria em cada envio pra janela.
    return { who: m.who, text: m.who === 'claude' ? clipLong(m.text, 30000) : clipLong(m.text, 8000) };
  });
}

/** A pergunta do `AskUserQuestion` como veio no tool_use, ainda sem resposta. */
function askOf(input, id) {
  const questions = (Array.isArray(input.questions) ? input.questions : []).map((q) => ({
    text: String((q && q.question) || ''),
    header: String((q && q.header) || ''),
    multi: !!(q && q.multiSelect),
    options: (Array.isArray(q && q.options) ? q.options : []).map((o) => ({
      label: String((o && o.label) || ''),
      description: String((o && o.description) || ''),
    })),
  }));
  return { who: 'ask', id: id || '', questions, state: 'open', answers: {} };
}

/**
 * Marca a resposta de [ask] pelo tool_result: as escolhas vêm no
 * `toolUseResult.answers` (pergunta -> o rótulo, ou os rótulos separados por
 * vírgula); um erro é a pergunta recusada.
 */
function answer(ask, result, extra) {
  if (result.is_error) {
    ask.state = 'declined';
    return;
  }
  ask.state = 'answered';
  ask.answers = (extra && typeof extra.answers === 'object' && extra.answers) || {};
}

/** A pergunta pra janela: cada opção numerada, com a escolhida marcada. */
function askData(m) {
  const state = { open: 'esperando a sua resposta', answered: 'respondida', declined: 'recusada' }[m.state];
  return {
    who: 'ask',
    id: m.id,
    open: m.state === 'open',
    // Dá pra responder daqui (quem decide é a janela, que sabe se ele espera).
    answerable: false,
    state,
    questions: m.questions.map((q, qi) => {
      const given = m.answers[q.text];
      const picked = typeof given === 'string' ? given.split(/,\s*/) : [];
      const options = q.options.map((o, i) => ({
        q: qi,
        o: i,
        tap: false,
        focus: false,
        n: `${i + 1}.`,
        label: o.label,
        description: clipLong(o.description, 240),
        hasDescription: !!o.description,
        chosen: picked.includes(o.label) || given === o.label,
      }));
      // Uma resposta que não é nenhuma das opções: o "Other", escrito à mão.
      const other = typeof given === 'string' && given && !options.some((o) => o.chosen) ? given : '';
      return {
        header: q.header,
        hasHeader: !!q.header,
        text: clipLong(q.text, 700),
        multi: q.multi,
        options,
        other: { on: !!other, text: clipLong(other, 400) },
        // O "confirmar" da de múltipla escolha (quem liga é a janela).
        confirm: { on: false, q: qi, text: '' },
      };
    }),
  };
}

/** Corta um texto longo sem juntar as linhas (o `clip` do balão junta). */
function clipLong(text, n) {
  const t = String(text || '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * A última resposta escrita de uma conversa: o recado de um ajudante, lido da
 * conversa dele (`agent_transcript_path`) quando o `SubagentStop` não o trouxe.
 */
function lastReply(file) {
  if (!file || !fs.existsSync(file)) return '';
  const lines = tailLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!e || e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    const text = e.message.content
      .filter((c) => c && c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n\n')
      .trim();
    if (text) return text;
  }
  return '';
}

module.exports = { transcriptOf, conversation, projectDir, cleanPrompt, clip, lastReply };
