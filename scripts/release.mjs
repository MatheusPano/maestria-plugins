// Publica cada plugin numa release própria e monta o catálogo da Maestria.
//
// Cada pasta com um maestria-plugin.json é um plugin. Quando a versão do
// manifesto ainda não tem tag (`<pasta>-v<versão>`), a pasta vira um .zip numa
// release nova com essa tag. Depois o catalog.json é refeito com a última
// versão de cada um, mais os plugins de fora listados no external.json, e sobe
// pra release `catalog`, no lugar do anterior. A Maestria lê o catálogo de
//
//   https://github.com/<repo>/releases/download/catalog/catalog.json
//
// Uso: node scripts/release.mjs [--dry-run]
// Com --dry-run nada é publicado: os .zip e o catalog.json ficam em dist/.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MANIFEST = 'maestria-plugin.json';
const CATALOG_TAG = 'catalog';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dist = join(root, 'dist');
const dryRun = process.argv.includes('--dry-run');
const repo = process.env.GITHUB_REPOSITORY || 'MatheusPano/maestria-plugins';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

const tryRun = (cmd, args, opts) => {
  try {
    return run(cmd, args, opts);
  } catch {
    return null;
  }
};

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const readManifest = (dir) => JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));

// O que o catálogo mostra antes de instalar, igual pra plugins daqui e de fora.
const summary = (m) => ({
  id: m.id,
  name: m.name,
  version: m.version,
  description: m.description ?? '',
  author: m.author ?? '',
  maestria: m.maestria ?? 1,
  permissions: m.permissions ?? [],
});

// As pastas da raiz que são plugins, em ordem.
const pluginDirs = () =>
  readdirSync(root)
    .filter((name) => !name.startsWith('.') && name !== 'dist' && name !== 'scripts')
    .filter((name) => statSync(join(root, name)).isDirectory() && existsSync(join(root, name, MANIFEST)))
    .sort();

// O catálogo publicado da última vez, pra não baixar de novo um .zip só pra
// saber o sha256 dele.
const previousCatalog = () => {
  if (dryRun) return new Map();
  const out = mkdtempSync(join(tmpdir(), 'catalog-'));
  const ok = tryRun('gh', ['release', 'download', CATALOG_TAG, '-p', 'catalog.json', '-D', out]);
  const entries = ok === null ? [] : JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8')).plugins;
  rmSync(out, { recursive: true, force: true });
  return new Map(entries.map((e) => [`${e.id}@${e.version}`, e]));
};

// Os commits que mexeram na pasta desde a release anterior dela.
const notesFor = (dir) => {
  const previous = tryRun('git', ['tag', '-l', `${dir}-v*`, '--sort=-v:refname'])?.split('\n')[0];
  const range = previous ? [`${previous}..HEAD`] : [];
  const log = tryRun('git', ['log', '--format=- %s', ...range, '--', dir]) ?? '';
  return log || '- primeira versão';
};

const zipPlugin = (dir, file) => {
  rmSync(file, { force: true });
  run('zip', ['-qr', '-X', file, dir, '-x', '*.DS_Store', '*/node_modules/*']);
};

const localEntry = (dir, previous) => {
  const manifest = readManifest(join(root, dir));
  const tag = `${dir}-v${manifest.version}`;
  const asset = `${dir}-${manifest.version}.zip`;
  const entry = {
    ...summary(manifest),
    icon: manifest.icon ? `https://raw.githubusercontent.com/${repo}/${tag}/${dir}/${manifest.icon}` : null,
    url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${asset}`,
  };
  const file = join(dist, asset);

  if (dryRun) {
    zipPlugin(dir, file);
    console.log(`${tag}: ${asset} (dry-run)`);
    return { ...entry, sha256: sha256(file) };
  }

  const released = tryRun('gh', ['release', 'view', tag, '--json', 'tagName']) !== null;
  if (!released) {
    zipPlugin(dir, file);
    run('gh', [
      'release', 'create', tag, file,
      '--title', `${manifest.name} ${manifest.version}`,
      '--notes', notesFor(dir),
      '--latest=false',
    ]);
    console.log(`${tag}: publicada`);
    return { ...entry, sha256: sha256(file) };
  }

  const known = previous.get(`${manifest.id}@${manifest.version}`);
  if (known?.sha256) return { ...entry, sha256: known.sha256 };

  run('gh', ['release', 'download', tag, '-p', asset, '-D', dist, '--clobber']);
  return { ...entry, sha256: sha256(file) };
};

// O manifesto na raiz, ou na única pasta dentro dela, como a Maestria procura.
const manifestDir = (dir) => {
  if (existsSync(join(dir, MANIFEST))) return dir;
  const children = readdirSync(dir).filter((n) => !n.startsWith('.') && statSync(join(dir, n)).isDirectory());
  return children.length === 1 && existsSync(join(dir, children[0], MANIFEST)) ? join(dir, children[0]) : null;
};

// Um plugin que mora no repositório de outra pessoa: o catálogo só aponta pra
// ele, com o que o manifesto de lá diz hoje.
const externalEntry = ({ git, ref }) => {
  const tmp = mkdtempSync(join(tmpdir(), 'external-'));
  try {
    run('git', ['clone', '-q', '--depth', '1', ...(ref ? ['--branch', ref] : []), git, tmp]);
    const dir = manifestDir(tmp);
    if (!dir) throw new Error(`${git}: não achei um ${MANIFEST}`);
    const manifest = readManifest(dir);
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: tmp });
    console.log(`${manifest.id}: ${manifest.version} de ${git}`);
    return { ...summary(manifest), icon: null, git, ref: ref ?? null, commit };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

const publishCatalog = (catalog) => {
  const file = join(dist, 'catalog.json');
  writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
  if (dryRun) return console.log(`catalog.json: ${catalog.plugins.length} plugins (dry-run)`);

  if (tryRun('gh', ['release', 'view', CATALOG_TAG, '--json', 'tagName']) === null) {
    run('gh', [
      'release', 'create', CATALOG_TAG,
      '--title', 'Catálogo',
      '--notes', 'O catálogo de plugins que a Maestria lê. Refeito a cada versão nova.',
      '--latest=false',
    ]);
  }
  run('gh', ['release', 'upload', CATALOG_TAG, file, '--clobber']);
  console.log(`catalog.json: ${catalog.plugins.length} plugins publicados`);
};

mkdirSync(dist, { recursive: true });
const previous = previousCatalog();
const local = pluginDirs().map((dir) => localEntry(dir, previous));

const externalFile = join(root, 'external.json');
const external = existsSync(externalFile) ? JSON.parse(readFileSync(externalFile, 'utf8')).plugins : [];
const outside = external.map(externalEntry);

const plugins = [...local, ...outside];
const ids = plugins.map((p) => p.id);
const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
if (repeated.length) throw new Error(`id repetido no catálogo: ${[...new Set(repeated)].join(', ')}`);

publishCatalog({ schema: 1, generatedAt: new Date().toISOString(), plugins });
