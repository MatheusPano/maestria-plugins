'use strict';
// Quem abriu quem: cada gerente tem uma cor (a lã do Minecraft) e as sessões que ele abre herdam a cor.
// O tabId muda quando a Maestria reabre; o sessionId do claude não, e é por ele que um nó se reencontra.

const path = require('path');

/** Aberta é viva ou hibernada: a hibernada tem o processo parado (exited), mas a aba e a conversa continuam. */
const isOpen = (s) => Boolean(s) && (!s.exited || Boolean(s.hibernated));

// A fonte da Maestria não tem emoji colorido: no nome da aba vai a forma, e a cor fica na aba do plugin.
const COLORS = [
  { id: 'red', mark: '●', hex: '#E5534B' },
  { id: 'blue', mark: '▲', hex: '#4FA3F7' },
  { id: 'green', mark: '◆', hex: '#6CC483' },
  { id: 'yellow', mark: '■', hex: '#EEC05A' },
  { id: 'purple', mark: '★', hex: '#A371F7' },
  { id: 'orange', mark: '✚', hex: '#F0883E' },
  { id: 'brown', mark: '◉', hex: '#A0714F' },
  { id: 'white', mark: '▼', hex: '#D0D7DE' },
  { id: 'black', mark: '◈', hex: '#8B949E' },
];
const BY_ID = new Map(COLORS.map((c) => [c.id, c]));
const LEGACY = ['🟥', '🟦', '🟩', '🟨', '🟪', '🟧', '🟫', '⬜', '⬛'];
const PREFIX = new RegExp(`^(?:(?:${[...COLORS.map((c) => c.mark), ...LEGACY].join('|')})\\s*)+`, 'u');
const FORGET_MS = 3 * 24 * 3600 * 1000;
const SEEN_MS = 3600 * 1000;

const colorOf = (id) => BY_ID.get(id) || COLORS[0];
const bare = (name) => String(name || '').replace(PREFIX, '').trim();
const tinted = (name, colorId, manager = false) => `${colorOf(colorId).mark.repeat(manager ? 2 : 1)} ${bare(name)}`;

class Links {
  constructor(data = {}, now = Date.now) {
    this.now = now;
    this.nodes = { ...(data.nodes || {}) };
    this.seq = Number(data.seq) || 0;
  }

  toJSON() {
    return { nodes: this.nodes, seq: this.seq };
  }

  byTab(tabId) {
    return Object.keys(this.nodes).find((k) => this.nodes[k].tabId === tabId) || null;
  }

  node(key) {
    return key ? this.nodes[key] || null : null;
  }

  rootOf(key) {
    let k = key;
    const seen = new Set();
    while (this.nodes[k] && this.nodes[k].parent && !seen.has(k)) {
      seen.add(k);
      k = this.nodes[k].parent;
    }
    return k;
  }

  nextColor(except = null) {
    const used = new Map();
    for (const [k, n] of Object.entries(this.nodes)) {
      if (!n.parent && k !== except) used.set(n.color, (used.get(n.color) || 0) + 1);
    }
    let best = COLORS[0];
    for (const c of COLORS) if ((used.get(c.id) || 0) < (used.get(best.id) || 0)) best = c;
    return best.id;
  }

  add({ tabId, parent = null, name, manager = false }) {
    const key = `n${++this.seq}`;
    const color = parent ? this.nodes[parent].color : this.nextColor();
    this.nodes[key] = { tabId, sessionId: null, parent, color, name: bare(name), manager, seenAt: this.now() };
    return key;
  }

  /** O nó de quem chama; uma sessão solta que abre outra vira gerente de uma cor nova. */
  ensure(tabId, name) {
    const key = this.byTab(tabId);
    if (key) {
      this.nodes[key].manager = true;
      return { key, created: false };
    }
    return { key: this.add({ tabId, name, manager: true }), created: true };
  }

  /** Acerta os nós com a lista viva: tabId trocado, sessionId novo (o /clear troca na mesma aba), e esquece o que sumiu há dias. */
  reconcile(sessions) {
    const byTab = new Map(sessions.map((s) => [s.id, s]));
    const bySession = new Map(sessions.filter((s) => s.sessionId).map((s) => [s.sessionId, s]));
    const owned = new Set(Object.values(this.nodes).map((n) => n.sessionId).filter(Boolean));
    let changed = false;
    for (const [key, n] of Object.entries(this.nodes)) {
      let s = byTab.get(n.tabId);
      if (s && n.sessionId && s.sessionId && s.sessionId !== n.sessionId) {
        if (bySession.has(n.sessionId) || owned.has(s.sessionId)) s = null;
        else {
          n.sessionId = s.sessionId;
          owned.add(s.sessionId);
          changed = true;
        }
      }
      if (!s && n.sessionId) s = bySession.get(n.sessionId);
      if (s) {
        const now = this.now();
        if (n.tabId !== s.id || (!n.sessionId && s.sessionId) || (s.cwd && n.cwd !== s.cwd) || now - (n.seenAt || 0) > SEEN_MS) changed = true;
        n.tabId = s.id;
        if (!n.sessionId && s.sessionId) n.sessionId = s.sessionId;
        if (s.cwd) n.cwd = s.cwd;
        n.seenAt = now;
      } else if (this.now() - (n.seenAt || 0) > FORGET_MS) {
        delete this.nodes[key];
        for (const m of Object.values(this.nodes)) if (m.parent === key) m.parent = n.parent;
        changed = true;
      }
    }
    return changed;
  }

  /** As abas vivas cujo título perdeu a marca da cor (ou a dupla, de gerente); um título que é só a pasta volta ao nome do nó. */
  retitles(sessions) {
    const live = new Map(sessions.filter(isOpen).map((x) => [x.id, x]));
    const out = [];
    for (const n of Object.values(this.nodes)) {
      const s = live.get(n.tabId);
      if (!s || !s.title) continue;
      const shown = bare(s.title);
      const generic = shown === '~' || (s.cwd && shown === path.basename(s.cwd));
      const title = tinted(generic && n.name ? n.name : s.title, n.color, n.manager);
      if (title !== s.title) out.push({ tabId: s.id, title });
    }
    return out;
  }

  /** Pendura a sessão de [tabId] em [parent] (ou a move pra lá); a subárvore dela passa pra cor do pai. */
  link(tabId, parent, name) {
    let key = this.byTab(tabId);
    if (key === parent) return key;
    for (let k = parent; k; k = this.nodes[k] && this.nodes[k].parent) if (k === key) throw new Error('isso faria um ciclo');
    if (!key) key = this.add({ tabId, parent, name });
    this.nodes[key].parent = parent;
    this.paint(key, this.nodes[parent].color);
    return key;
  }

  /** Solta o nó da árvore como gerente de uma cor nova (os filhos vão junto). */
  promote(key) {
    const n = this.nodes[key];
    n.parent = null;
    n.manager = true;
    this.paint(key, this.nextColor(key));
    return key;
  }

  /** Tira o nó; os filhos sobem pro pai dele. */
  remove(key) {
    const n = this.nodes[key];
    if (!n) return;
    delete this.nodes[key];
    for (const m of Object.values(this.nodes)) if (m.parent === key) m.parent = n.parent;
  }

  paint(key, color) {
    this.nodes[key].color = color;
    for (const k of this.children(key)) this.paint(k, color);
  }

  /** O nó e todos os de baixo, em ordem. */
  subtree(key) {
    return [key, ...this.children(key).flatMap((k) => this.subtree(k))];
  }

  children(key) {
    return Object.keys(this.nodes).filter((k) => this.nodes[k].parent === key);
  }

  roots() {
    return Object.keys(this.nodes).filter((k) => !this.nodes[k].parent || !this.nodes[this.nodes[k].parent]);
  }
}

module.exports = { Links, COLORS, colorOf, bare, tinted, isOpen };
