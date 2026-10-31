'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const project = require('./project');

const BUILD_TIMEOUT_MS = 5000; // incremental builds
const FIRST_BUILD_TIMEOUT_MS = 15000; // the first one also loads the config and scans the content; loaded machines pass 5 s
const POLL_MS = 10;
const STDERR_KEEP = 2000;

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function matchBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return s.length;
}

function onlyCustomProps(body) {
  const decls = body.split(';').map((d) => d.trim()).filter(Boolean);
  return decls.length > 0 && decls.every((d) => d.startsWith('--'));
}

function collect(text, out) {
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf('{', pos);
    if (open < 0) break;
    const close = matchBrace(text, open);
    const head = text.slice(pos, open);
    const selector = head.slice(Math.max(head.lastIndexOf(';'), head.lastIndexOf('}')) + 1).trim();
    const body = text.slice(open + 1, close);
    if (selector.startsWith('@')) collect(body, out); // @layer etc.: look inside
    else if (!body.includes('{') && onlyCustomProps(body)) out.push(`${selector} {${body.trim().replace(/\s+/g, ' ')}}`);
    pos = close + 1;
  }
}

// Without a sass binary, a .scss file only contributes its plain
// custom-property blocks (`:root{--x: 1}`), which is what the color tokens are.
function extractCustomProps(scss) {
  const out = [];
  collect(stripComments(scss), out);
  return out.join('\n');
}

function compileExtra(file, repoDir, sass) {
  const text = fs.readFileSync(file, 'utf8');
  if (!file.endsWith('.scss')) return text;
  if (!sass) return extractCustomProps(text);
  return execFileSync(sass, ['--no-source-map', `--load-path=${path.join(repoDir, 'app/javascript')}`, file],
    { encoding: 'utf8', cwd: repoDir });
}

class Tailwind {
  constructor(opts, detected) {
    this.opts = opts;
    this.detected = detected;
    this.log = opts.log || (() => {});
    this.child = null;
    this.stopping = false;
    this.restarts = 0;
    this.stderr = '';
    this.failed = null;
    this.doneAt = 0;
  }

  get pid() { return this.child && this.child.pid; }

  _writeInputs() {
    const { repoDir, config, extraCss = [], contentGlob, outCss } = this.opts;
    const dir = path.dirname(outCss);
    fs.mkdirSync(dir, { recursive: true });
    const extras = extraCss.map((f) => compileExtra(path.resolve(repoDir, f), repoDir, this.detected.sass)).join('\n');
    const input = path.join(dir, 'input.css');
    if (this.detected.tailwind.version >= 4) {
      const base = `@import "tailwindcss" source(none);\n@source "${contentGlob}";\n`;
      fs.writeFileSync(input, `${base}${extras}\n`);
      this.args = ['-i', input, '-o', outCss, '--watch=always'];
    } else {
      const cfg = path.join(dir, 'tailwind.config.cjs');
      const cfgSrc = `module.exports = { presets: [require(${JSON.stringify(config)})], content: [${JSON.stringify(contentGlob)}] };\n`;
      fs.writeFileSync(cfg, cfgSrc);
      fs.writeFileSync(input, `${extras}\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`);
      this.args = ['-c', cfg, '-i', input, '-o', outCss, '--watch=always'];
    }
  }

  _spawn() {
    this.stderr = '';
    const child = spawn(this.detected.tailwind.bin, this.args, {
      cwd: this.opts.repoDir, stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    child.stderr.on('data', (d) => {
      // the CLI prints "Done in Nms." after every rebuild, even when the output css is unchanged
      if (/Done in \d+\s*ms/.test(d.toString())) this.doneAt = Date.now();
      this.stderr = (this.stderr + d.toString()).slice(-STDERR_KEEP);
    });
    child.on('error', (e) => { this.stderr += `\n${e.message}`; });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      this.log(`tailwind exited (${signal || code}); ${this.restarts ? 'giving up' : 'restarting'}`);
      if (this.restarts < 1) {
        const last = this.stderr;
        this.restarts++;
        this._spawn();
        this.stderr = last; // keep why the first one died until the new one builds
      } else {
        this.failed = new Error(`o tailwind do projeto não subiu: ${this.lastErrors()}`);
      }
    });
  }

  async init() {
    this._writeInputs();
    const since = Date.now();
    this._spawn();
    await this.whenBuilt(since, FIRST_BUILD_TIMEOUT_MS);
    return this;
  }

  lastErrors() {
    return this.stderr.trim().split('\n').slice(-8).join('\n');
  }

  // Resolves when outCss was written after sinceMs and is whole: non-empty and
  // unchanged (size + mtime) across two consecutive polls. Rejects at once if the
  // CLI is gone for good, or after `timeoutMs` (default 5 s) with the CLI's last stderr lines.
  // Also resolves on the CLI's "Done in" line printed after sinceMs (an unchanged css is not rewritten).
  // The returned promise has cancel() to stop polling once the caller gave up.
  whenBuilt(sinceMs, timeoutMs = BUILD_TIMEOUT_MS) {
    const { outCss } = this.opts;
    const t0 = Date.now();
    let prev = null;
    let cancelled = false;
    const p = new Promise((resolve, reject) => {
      const tick = () => {
        if (cancelled) return resolve();
        if (this.failed) return reject(this.failed);
        let st = null;
        try { st = fs.statSync(outCss); } catch { /* not built yet */ }
        if (st && st.size > 0 && this.doneAt > sinceMs) { this.stderr = ''; return resolve(); }
        if (st && st.mtimeMs > sinceMs && st.size > 0) {
          if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
            this.stderr = '';
            return resolve();
          }
          prev = { size: st.size, mtimeMs: st.mtimeMs };
        } else {
          prev = null;
        }
        if (Date.now() - t0 > timeoutMs) {
          return reject(new Error(`o tailwind do projeto não subiu: sem css em ${timeoutMs / 1000} s\n${this.lastErrors()}`));
        }
        setTimeout(tick, POLL_MS);
      };
      tick();
    });
    p.cancel = () => { cancelled = true; };
    return p;
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
    return new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    });
  }
}

async function start(opts) {
  const detected = project.detect(opts.repoDir);
  const tw = new Tailwind(opts, detected);
  try {
    return await tw.init();
  } catch (e) {
    await tw.stop();
    throw e;
  }
}

module.exports = { start, extractCustomProps, Tailwind, BUILD_TIMEOUT_MS, FIRST_BUILD_TIMEOUT_MS };
