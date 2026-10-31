'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const project = require('../lib/project');
const tailwind = require('../lib/tailwind');

// A node_modules with tailwindcss 3 (the SAC bench checkout has none of its own).
const NM = process.env.DESIGN_TEST_NODE_MODULES
  || path.join(os.homedir(), 'Desktop/Work/Ninepay/customer-service/node_modules');
const have = fs.existsSync(path.join(NM, '.bin', 'tailwindcss'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-tw-'));
const started = [];

test.after(async () => {
  for (const t of started) await t.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let fx = null;
function fixture() {
  if (fx) return fx;
  const repo = path.join(tmp, 'repo');
  const data = path.join(tmp, 'data');
  const content = path.join(tmp, 'content');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(content, { recursive: true });
  fs.symlinkSync(NM, path.join(repo, 'node_modules'));
  fs.writeFileSync(path.join(repo, 'tailwind.config.js'),
    "module.exports = { darkMode: 'class', theme: { extend: { colors: { n: { slate: { 12: 'rgb(var(--slate-12) / <alpha-value>)' } } } } } };\n");
  fs.writeFileSync(path.join(repo, 'vars.scss'), '// c\n@layer base {\n  :root {\n    --slate-12: 28 32 36;\n  }\n  .a .b { color: red; }\n}\n');
  fx = { repo, data, content };
  return fx;
}

test('detect throws without tailwind in node_modules', () => {
  const empty = fs.mkdtempSync(path.join(tmp, 'empty-'));
  assert.throws(() => project.detect(empty), /o projeto não tem tailwind em node_modules/);
});

test('detect finds bin, version, config and no sass', { skip: !have && 'no node_modules' }, () => {
  const { repo } = fixture();
  const d = project.detect(repo);
  assert.strictEqual(d.tailwind.version, 3);
  assert.ok(d.tailwind.bin.endsWith(path.join('.bin', 'tailwindcss')));
  assert.strictEqual(d.tailwind.config, path.join(repo, 'tailwind.config.js'));
  assert.strictEqual(d.sass, null);
});

test('extractCustomProps keeps only variable blocks, through at-rules', () => {
  const css = tailwind.extractCustomProps('// x\n@layer base {\n :root { --a: 1 2 3; }\n .d { --b: 4; }\n .x { color: red; }\n .y { .z { --c: 1; } }\n}\n');
  assert.match(css, /:root\s*\{\s*--a: 1 2 3;\s*\}/);
  assert.match(css, /\.d\s*\{\s*--b: 4;\s*\}/);
  assert.doesNotMatch(css, /color|--c/);
});

let tw;
test('start builds and whenBuilt resolves within 2s of a content change', { skip: !have && 'no node_modules' }, async () => {
  const { repo, data, content } = fixture();
  const d = project.detect(repo);
  const outCss = path.join(data, 'out.css');
  tw = await tailwind.start({
    repoDir: repo, config: d.tailwind.config, input: null,
    extraCss: ['vars.scss'], contentGlob: path.join(content, '**/*.html'), outCss, log: () => {},
  });
  started.push(tw);
  const since = Date.now();
  fs.writeFileSync(path.join(content, 'a.html'), '<div class="text-n-slate-12"></div>');
  await Promise.race([
    tw.whenBuilt(since),
    new Promise((_, rej) => setTimeout(() => rej(new Error('slower than 2s')), 2000)),
  ]);
  const css = fs.readFileSync(outCss, 'utf8');
  assert.match(css, /--slate-12/);
  assert.match(css, /\.text-n-slate-12/);
});

test('restarts once when the CLI is killed', { skip: !have && 'no node_modules' }, async () => {
  const content = path.join(tmp, 'content');
  process.kill(tw.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  const since = Date.now();
  fs.writeFileSync(path.join(content, 'b.html'), '<div class="underline"></div>');
  await tw.whenBuilt(since);
  assert.match(fs.readFileSync(path.join(tmp, 'data', 'out.css'), 'utf8'), /\.underline/);
});

test('rejects fast with a clear error once the restart also dies', { skip: !have && 'no node_modules' }, async () => {
  process.kill(tw.pid, 'SIGKILL'); // second kill: the single restart is spent
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  await assert.rejects(tw.whenBuilt(Date.now()), /^Error: o tailwind do projeto não subiu: /);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});
