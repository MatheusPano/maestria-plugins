// Onde está o projeto, qual flutter ele usa e quais configurações ele tem.
//
// As três perguntas que o VS Code responde antes de mostrar o seletor de
// configurações: a pasta com o pubspec.yaml, o SDK (o do fvm quando o projeto
// fixa um) e o .vscode/launch.json — lido do mesmo jeito que o Dart-Code lê,
// porque é esse arquivo que o time já mantém.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** A pasta do app Flutter que contém [start], subindo até achar um pubspec com flutter. */
function findProjectRoot(start) {
  let dir = path.resolve(start || '.');
  for (;;) {
    const pubspec = path.join(dir, 'pubspec.yaml');
    if (fs.existsSync(pubspec)) {
      const text = fs.readFileSync(pubspec, 'utf8');
      if (/^\s*flutter\s*:/m.test(text) || /sdk:\s*flutter/.test(text)) return dir;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Se [dir] tem um pubspec.yaml de app ou pacote flutter. */
function isFlutterProject(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8');
    return /^\s*flutter\s*:/m.test(text) || /sdk:\s*flutter/.test(text);
  } catch {
    return false;
  }
}

/**
 * Os projetos flutter de uma pasta da lateral: ela mesma, ou as pastas logo
 * dentro dela — o monorepo com `app/` e `packages/` do lado.
 */
function projectsIn(dir) {
  if (isFlutterProject(dir)) return [dir];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || ['build', 'node_modules', 'ios', 'android'].includes(e.name)) continue;
    const child = path.join(dir, e.name);
    // Só app: um pacote sem `lib/main.dart` não tem o que rodar.
    if (isFlutterProject(child) && fs.existsSync(path.join(child, 'lib', 'main.dart'))) out.push(child);
  }
  return out;
}

function packageName(root) {
  try {
    const m = fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8').match(/^name:\s*([\w_]+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function executable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && executable(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/**
 * O binário do flutter do projeto, e o dart que vem com ele.
 *
 * 1. `.fvm/flutter_sdk` — o link que o fvm cria no projeto;
 * 2. a versão do `.fvmrc` no cache do fvm (`fvm api context` diz onde é);
 * 3. o `flutter` do PATH.
 *
 * `override` é o caminho que o usuário escolheu na janela, e ganha de tudo.
 */
function resolveSdk(root, override) {
  const fromBin = (bin, source) => ({
    flutter: bin,
    dart: path.join(path.dirname(bin), 'dart'),
    source,
  });
  if (override && executable(override)) return fromBin(override, 'escolhido à mão');

  const link = path.join(root, '.fvm', 'flutter_sdk', 'bin', 'flutter');
  if (executable(link)) return fromBin(link, 'fvm (.fvm/flutter_sdk)');

  const caches = [];
  const home = process.env.HOME || '';
  try {
    const fvm = which('fvm');
    if (fvm) {
      const ctx = JSON.parse(execFileSync(fvm, ['api', 'context'], { encoding: 'utf8', timeout: 8000 }));
      const cache = ctx.context && ctx.context.config && ctx.context.config.cachePath;
      if (cache) caches.push(path.join(cache, 'versions'), cache);
    }
  } catch {}
  caches.push(path.join(home, 'fvm', 'versions'), path.join(home, '.fvm', 'versions'));

  let version = null;
  for (const [file, key] of [['.fvmrc', 'flutter'], [path.join('.fvm', 'fvm_config.json'), 'flutterSdkVersion']]) {
    try {
      version = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))[key] || version;
    } catch {}
    if (version) break;
  }
  if (version) {
    for (const cache of caches) {
      const bin = path.join(cache, version, 'bin', 'flutter');
      if (executable(bin)) return fromBin(bin, `fvm ${version}`);
    }
  }

  const global = which('flutter');
  if (global) return fromBin(global, 'PATH');

  // O último recurso: a versão mais nova que o fvm tem baixada. Melhor que
  // nada num projeto que não fixa versão, e a janela diz de onde veio.
  for (const cache of caches) {
    let versions = [];
    try {
      versions = fs.readdirSync(cache).filter((v) => /^\d+\.\d+\.\d+/.test(v) && executable(path.join(cache, v, 'bin', 'flutter')));
    } catch {}
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length) return fromBin(path.join(cache, versions[0], 'bin', 'flutter'), `fvm ${versions[0]} (a mais nova no cache)`);
  }
  return null;
}

/** JSON com comentários e vírgula sobrando — o formato do launch.json. */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] || '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * As configurações do `.vscode/launch.json`, como o seletor do VS Code mostra.
 *
 * Do Dart-Code vale `args` e `toolArgs` indo pro `flutter run` (é onde o time
 * põe `--flavor` e `--dart-define`), `program` virando `-t`, `flutterMode`
 * virando `--profile`/`--release` e `deviceId` virando `-d`. As linhas que são
 * só um separador ("-----", sem program) ficam de fora.
 *
 * Sem launch.json, as três de sempre.
 */
function launchConfigs(root) {
  const file = path.join(root, '.vscode', 'launch.json');
  let list = [];
  let problem = null;
  if (fs.existsSync(file)) {
    try {
      const json = parseJsonc(fs.readFileSync(file, 'utf8'));
      list = (json.configurations || []).filter(
        (c) => c && c.type === 'dart' && (c.request || 'launch') === 'launch',
      );
    } catch (e) {
      problem = `.vscode/launch.json não leu: ${e.message}`;
    }
  }
  const configs = list
    .filter((c) => c.name && !/^[-\s_=]+$/.test(c.name) && c.program !== '')
    .map((c) => ({
      name: c.name,
      program: c.program || null,
      args: [...(c.toolArgs || []), ...(c.args || [])].map((a) =>
        String(a).replace(/\$\{workspaceFolder\}/g, root),
      ),
      mode: c.flutterMode || 'debug',
      deviceId: c.deviceId || null,
      cwd: c.cwd ? path.resolve(root, String(c.cwd).replace(/\$\{workspaceFolder\}/g, root)) : root,
    }));
  if (!configs.length) {
    for (const mode of ['debug', 'profile', 'release']) {
      configs.push({ name: `${mode[0].toUpperCase()}${mode.slice(1)}`, program: null, args: [], mode, deviceId: null, cwd: root });
    }
  }
  return { configs, problem, fromFile: list.length > 0 };
}

/** Os argumentos do `flutter run --machine` pra uma configuração e um aparelho. */
function runArgs(config, deviceId) {
  const args = ['run', '--machine'];
  const device = deviceId || config.deviceId;
  if (device) args.push('-d', device);
  if (config.mode === 'profile') args.push('--profile');
  if (config.mode === 'release') args.push('--release');
  if (config.program) args.push('-t', config.program);
  args.push(...config.args);
  return args;
}

module.exports = { findProjectRoot, isFlutterProject, projectsIn, packageName, resolveSdk, launchConfigs, runArgs, parseJsonc };
