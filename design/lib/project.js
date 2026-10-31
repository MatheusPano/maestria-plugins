'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_NAMES = ['js', 'cjs', 'mjs', 'ts'].map((e) => `tailwind.config.${e}`);
const V4_INPUTS = ['src/index.css', 'src/app.css', 'src/styles.css', 'src/globals.css',
  'app/globals.css', 'app/app.css', 'styles/globals.css', 'src/styles/globals.css'];

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function majorOf(range) {
  const m = /(\d+)/.exec(String(range || ''));
  return m ? Number(m[1]) : null;
}

// What the project has: Tailwind (version, bin, config, v4 entry css) and sass.
function detect(repoDir) {
  const bins = path.join(repoDir, 'node_modules', '.bin');
  const bin = path.join(bins, 'tailwindcss');
  if (!fs.existsSync(bin)) throw new Error('o projeto não tem tailwind em node_modules');

  const installed = readJson(path.join(repoDir, 'node_modules', 'tailwindcss', 'package.json'));
  const pkg = readJson(path.join(repoDir, 'package.json')) || {};
  const declared = (pkg.devDependencies && pkg.devDependencies.tailwindcss)
    || (pkg.dependencies && pkg.dependencies.tailwindcss);
  const version = majorOf(installed && installed.version) || majorOf(declared) || 3;

  const configName = CONFIG_NAMES.find((n) => isFile(path.join(repoDir, n)));
  const config = configName ? path.join(repoDir, configName) : null;

  let input = null;
  if (version >= 4) {
    const found = V4_INPUTS.find((rel) => {
      const p = path.join(repoDir, rel);
      return isFile(p) && /@import\s+["']tailwindcss/.test(fs.readFileSync(p, 'utf8'));
    });
    if (found) input = path.join(repoDir, found);
  }

  const sassBin = path.join(bins, 'sass');
  return {
    tailwind: { version: version >= 4 ? 4 : 3, bin, config, input },
    sass: fs.existsSync(sassBin) ? sassBin : null,
  };
}

module.exports = { detect };
