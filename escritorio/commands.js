// Os comandos de barra de um claude, pra lista que abre no campo do chat quando
// você digita `/` (o `commands` do `TextInput`).
//
// O Claude Code não conta pra ninguém quais comandos uma sessão tem, então a
// lista é montada daqui: os embutidos que fazem sentido mandar por um chat (os
// que abrem um menu no terminal ficam de fora -- daqui não dá pra escolher
// nada nele), e os do disco, como o Claude Code os acha: `commands/` e
// `skills/` do usuário, do projeto e dos plugins ligados.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILTIN = [
  ['compact', 'resume a conversa pra liberar contexto (aceita instruções)'],
  ['clear', 'começa uma conversa nova, com o contexto vazio'],
  ['context', 'mostra quanto do contexto já foi usado'],
  ['usage', 'o custo da sessão e o uso do plano'],
  ['model', 'troca o modelo: /model <nome>'],
  ['effort', 'troca o nível de esforço: /effort <low|medium|high|xhigh|max>'],
  ['plan', 'liga o modo de plano, ou mostra o plano da sessão'],
  ['btw', 'uma pergunta rápida de lado, sem interromper a conversa'],
  ['init', 'cria o CLAUDE.md com a documentação do projeto'],
  ['review', 'revisa um pull request'],
  ['security-review', 'revisão de segurança das mudanças da branch'],
  ['fork', 'abre um agente em segundo plano com a conversa inteira'],
  ['goal', 'define um objetivo que ele confere antes de parar'],
  ['recap', 'um resumo de uma linha da sessão'],
  ['copy', 'copia a última resposta dele'],
  ['export', 'exporta a conversa pra um arquivo ou pra área de transferência'],
];

const CACHE_MS = 30000;
const cache = new Map(); // cwd -> { at, list }

/** Os comandos de uma sessão em [cwd]: `[{ name, description }]`, sem a barra. */
function commandsFor(cwd) {
  const key = cwd || '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const seen = new Set();
  const list = [];
  const add = (name, description) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    list.push({ name, description: oneLine(description) });
  };
  for (const [name, description] of BUILTIN) add(name, description);
  const home = path.join(os.homedir(), '.claude');
  const roots = [];
  if (cwd) roots.push({ dir: path.join(cwd, '.claude'), prefix: '' });
  roots.push({ dir: home, prefix: '' });
  for (const p of enabledPlugins(home)) roots.push(p);
  for (const r of roots) {
    for (const c of commandsIn(path.join(r.dir, 'commands'))) add(r.prefix + c.name, c.description);
    for (const s of skillsIn(path.join(r.dir, 'skills'))) add(r.prefix + s.name, s.description);
  }
  cache.set(key, { at: Date.now(), list });
  return list;
}

/** Os `.md` de [dir], com as subpastas no nome (`git/push.md` é `git:push`). */
function commandsIn(dir, base = dir) {
  const out = [];
  for (const e of entries(dir)) {
    const full = path.join(dir, e.name);
    if (isDir(full, e)) out.push(...commandsIn(full, base));
    else if (e.name.endsWith('.md')) {
      const name = path.relative(base, full).slice(0, -3).split(path.sep).join(':');
      out.push({ name, description: describe(full) });
    }
  }
  return out;
}

/** As pastas de [dir] com um `SKILL.md`: o `name` dele, ou o da pasta. */
function skillsIn(dir) {
  const out = [];
  for (const e of entries(dir)) {
    const file = path.join(dir, e.name, 'SKILL.md');
    if (!isDir(path.join(dir, e.name), e) || !fs.existsSync(file)) continue;
    const meta = frontmatter(file);
    out.push({ name: meta.name || e.name, description: meta.description || '' });
  }
  return out;
}

/** Os plugins ligados do usuário: a pasta de cada um e o `plugin:` dos nomes. */
function enabledPlugins(home) {
  let installed;
  let enabled;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
    enabled = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).enabledPlugins || {};
  } catch {
    return [];
  }
  const out = [];
  for (const [id, installs] of Object.entries(installed)) {
    if (enabled[id] !== true || !Array.isArray(installs)) continue;
    const at = installs.find((i) => i && i.installPath && fs.existsSync(i.installPath));
    if (at) out.push({ dir: at.installPath, prefix: `${id.split('@')[0]}:` });
  }
  return out;
}

/** A descrição de um comando: a do frontmatter, ou a primeira linha de texto. */
function describe(file) {
  const meta = frontmatter(file);
  if (meta.description) return meta.description;
  const body = meta.body.split('\n').find((l) => l.trim() && !l.startsWith('#'));
  return body || '';
}

/** O `name` e o `description` do frontmatter de [file], e o resto do texto. */
function frontmatter(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8').slice(0, 8192);
  } catch {
    return { body: '' };
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: text };
  const lines = m[1].split(/\r?\n/);
  const field = (k) => {
    const i = lines.findIndex((l) => l.startsWith(`${k}:`));
    if (i < 0) return '';
    const value = lines[i].slice(k.length + 1).trim();
    // Um bloco (`>-`, `|`): as linhas recuadas logo abaixo.
    if (/^[>|][-+]?$/.test(value)) {
      const block = [];
      for (const l of lines.slice(i + 1)) {
        if (l.trim() && !/^\s/.test(l)) break;
        block.push(l.trim());
      }
      return block.join(' ').trim();
    }
    return value.replace(/^["']|["']$/g, '');
  };
  return { name: field('name'), description: field('description'), body: text.slice(m[0].length) };
}

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Pasta de verdade ou link pra uma (as skills costumam ser links). */
function isDir(full, e) {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function oneLine(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? `${t.slice(0, 139)}…` : t;
}

module.exports = { commandsFor };
