// O docker em si: rodar o cli, ler containers, imagens, volumes e o disco, e
// abrir os fluxos que não acabam (events, logs -f, stats). Nada de janela
// aqui — o main.js desenha, este arquivo só sabe falar com o docker.

'use strict';

const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const HOME = os.homedir();

const ENV = {
  ...process.env,
  // Sem as dicas de "What's next:" que o cli cola no fim de alguns comandos.
  DOCKER_CLI_HINTS: 'false',
  LC_ALL: 'C',
};

// O que muda por configuração: o programa e o contexto escolhido na janela.
const opts = { binary: 'docker', context: '' };

function configure({ binary, context }) {
  if (binary !== undefined) opts.binary = String(binary || '').trim() || 'docker';
  if (context !== undefined) opts.context = String(context || '');
}

/** Os argumentos com o `--context` na frente, quando há um escolhido. */
function withContext(args) {
  return opts.context ? ['--context', opts.context, ...args] : args;
}

/**
 * Roda `docker args`. Resolve com { code, stdout, stderr } — nunca rejeita
 * por código de saída.
 */
function run(args, { timeout = 60000, cwd = HOME } = {}) {
  return new Promise((resolve) => {
    execFile(opts.binary, withContext(args), { cwd, env: ENV, maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      let why = '';
      if (err && err.code === 'ENOENT') why = `não achei o "${opts.binary}" — instale o docker ou ajuste o programa nas configurações`;
      else if (err && typeof err.code !== 'number') why = String(err.message);
      resolve({ code, stdout: String(stdout || ''), stderr: why || String(stderr || '') });
    });
  });
}

/** Como `run`, mas rejeita com a linha útil do stderr quando falha. */
async function must(args, o) {
  const r = await run(args, o);
  if (r.code !== 0) throw new Error(explain(r.stderr || r.stdout) || `docker ${args[0]} saiu com ${r.code}`);
  return r.stdout;
}

/** A mensagem do docker sem o "Error response from daemon:" na frente. */
function explain(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const err = lines.find((l) => /^(Error|error)/.test(l)) || lines.slice(-2).join(' ');
  return err.replace(/^(Error response from daemon|Error|error):\s*/, '');
}

/** O motor não está de pé (ou não dá pra falar com ele). */
function isDown(text) {
  return /Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|connect: (connection refused|no such file)|dial unix .*: connect/i.test(
    String(text),
  );
}

/** Uma linha de json por linha de saída, sem as que não são json. */
function jsonLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // uma linha cortada: fica de fora
    }
  }
  return out;
}

// --- leitura -----------------------------------------------------------------

/** "a=1,b=2" → { a: '1', b: '2' }. Um valor com vírgula quebra, mas os do compose não têm. */
function labels(text) {
  const out = {};
  for (const part of String(text || '').split(',')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

/**
 * As portas publicadas de "0.0.0.0:3311->3306/tcp, [::]:3311->3306/tcp,
 * 33060/tcp": [{ host: 3311, container: 3306, proto: 'tcp' }]. A mesma porta
 * no v4 e no v6 conta uma vez, e as só expostas (sem ->) ficam de fora.
 */
function ports(text) {
  const seen = new Set();
  const out = [];
  for (const part of String(text || '').split(',')) {
    const m = part.trim().match(/:(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/(\w+)$/);
    if (!m) continue;
    const key = `${m[1]}/${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host: Number(m[1]), container: Number(m[3]), proto: m[4] });
  }
  return out;
}

/** "2026-09-24 14:43:43 -0300 -03" → Date. */
function parseCreated(text) {
  const m = String(text || '').match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A saúde que o Status carrega: "Up 2 hours (healthy)" → 'healthy'. */
function healthOf(status) {
  const m = String(status).match(/\((healthy|unhealthy|health: starting)\)/);
  return m ? (m[1] === 'health: starting' ? 'starting' : m[1]) : null;
}

/** O código de saída de "Exited (255) 2 days ago". */
function exitCodeOf(status) {
  const m = String(status).match(/^Exited \((-?\d+)\)/);
  return m ? Number(m[1]) : null;
}

async function containers() {
  const out = await must(['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
  return jsonLines(out).map((c) => {
    const l = labels(c.Labels);
    const project = l['com.docker.compose.project'] || '';
    return {
      id: c.ID,
      short: String(c.ID).slice(0, 12),
      name: String(c.Names || '').split(',')[0],
      image: c.Image,
      command: String(c.Command || '').replace(/^"|"$/g, ''),
      state: c.State, // running, exited, created, paused, restarting, removing, dead
      status: c.Status,
      health: healthOf(c.Status),
      exitCode: exitCodeOf(c.Status),
      ports: ports(c.Ports),
      mounts: String(c.Mounts || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      networks: String(c.Networks || '')
        .split(',')
        .filter(Boolean),
      project,
      service: l['com.docker.compose.service'] || '',
      workdir: l['com.docker.compose.project.working_dir'] || '',
      configFiles: l['com.docker.compose.project.config_files'] || '',
      oneoff: l['com.docker.compose.oneoff'] === 'True',
      created: parseCreated(c.CreatedAt),
    };
  });
}

async function images() {
  const out = await must(['images', '--format', '{{json .}}']);
  return jsonLines(out).map((i) => {
    const repo = i.Repository === '<none>' ? '' : i.Repository;
    const tag = i.Tag === '<none>' ? '' : i.Tag;
    return {
      id: i.ID,
      repo,
      tag,
      ref: repo ? (tag ? `${repo}:${tag}` : repo) : i.ID,
      size: i.Size,
      created: parseCreated(i.CreatedAt),
      containers: Number(i.Containers) || 0,
    };
  });
}

async function volumes() {
  const out = await must(['volume', 'ls', '--format', '{{json .}}']);
  return jsonLines(out).map((v) => {
    const l = labels(v.Labels);
    return {
      name: v.Name,
      driver: v.Driver,
      anonymous: 'com.docker.volume.anonymous' in l || /^[0-9a-f]{64}$/.test(v.Name),
      project: l['com.docker.compose.project'] || '',
    };
  });
}

/** O `docker system df`: { Images: { size, reclaimable, total, active }, … }. */
async function diskUsage() {
  const out = await must(['system', 'df', '--format', '{{json .}}'], { timeout: 120000 });
  const res = {};
  for (const d of jsonLines(out)) {
    res[d.Type] = { size: d.Size, reclaimable: d.Reclaimable, total: Number(d.TotalCount) || 0, active: Number(d.Active) || 0 };
  }
  return res;
}

/** Os contextos do cli, com o que está em uso agora. */
async function contexts() {
  // Sem o --context: a lista é a mesma de qualquer um, e um contexto que
  // sumiu não pode impedir de escolher outro.
  const r = await new Promise((resolve) => {
    execFile(opts.binary, ['context', 'ls', '--format', '{{json .}}'], { env: ENV, timeout: 15000 }, (err, stdout) =>
      resolve(err ? '' : String(stdout)),
    );
  });
  return jsonLines(r).map((c) => ({ name: c.Name, description: c.Description, endpoint: c.DockerEndpoint, current: !!c.Current }));
}

/** O motor: versão e sistema, ou { down, error } quando não responde. */
async function engine() {
  const r = await run(['version', '--format', '{{json .}}'], { timeout: 15000 });
  const [v] = jsonLines(r.stdout);
  if (r.code !== 0 || !v || !v.Server) {
    const error = explain(r.stderr || r.stdout) || 'o docker não respondeu';
    return { down: true, error };
  }
  // Os núcleos e a memória da máquina do motor: o teto dos medidores de um container.
  const info = await run(['info', '--format', '{{.NCPU}} {{.MemTotal}}'], { timeout: 15000 });
  const [ncpu, mem] = info.stdout.trim().split(/\s+/).map(Number);
  return { down: false, version: v.Server.Version, os: v.Server.Os, arch: v.Server.Arch, ncpu: ncpu || 1, mem: mem || 0 };
}

async function inspect(id) {
  const out = await must(['inspect', '--type', 'container', id]);
  const [c] = JSON.parse(out);
  return c;
}

/** O que o `docker inspect` diz, do jeito que a janela do container mostra. */
function describe(c) {
  const s = c.State || {};
  const nets = Object.entries((c.NetworkSettings && c.NetworkSettings.Networks) || {}).map(([name, n]) => ({
    name,
    ip: n.IPAddress || '',
  }));
  const bound = [];
  for (const [inside, list] of Object.entries((c.NetworkSettings && c.NetworkSettings.Ports) || {})) {
    const [port, proto] = inside.split('/');
    for (const b of list || []) {
      if (!bound.some((p) => p.host === Number(b.HostPort) && p.proto === proto)) {
        bound.push({ host: Number(b.HostPort), container: Number(port), proto });
      }
    }
  }
  const cmd = [...((c.Config && c.Config.Entrypoint) || []), ...((c.Config && c.Config.Cmd) || [])].join(' ');
  return {
    id: c.Id,
    name: String(c.Name || '').replace(/^\//, ''),
    image: c.Config && c.Config.Image,
    status: s.Status,
    exitCode: s.ExitCode,
    error: s.Error || '',
    oom: !!s.OOMKilled,
    health: s.Health ? s.Health.Status : null,
    startedAt: s.StartedAt && !s.StartedAt.startsWith('0001') ? new Date(s.StartedAt) : null,
    finishedAt: s.FinishedAt && !s.FinishedAt.startsWith('0001') ? new Date(s.FinishedAt) : null,
    created: c.Created ? new Date(c.Created) : null,
    restart: (c.HostConfig && c.HostConfig.RestartPolicy && c.HostConfig.RestartPolicy.Name) || 'no',
    command: cmd,
    ports: bound,
    networks: nets,
    mounts: (c.Mounts || []).map((m) => ({
      type: m.Type,
      name: m.Name || '',
      source: m.Source,
      destination: m.Destination,
      rw: m.RW !== false,
    })),
    labels: (c.Config && c.Config.Labels) || {},
    env: (c.Config && c.Config.Env) || [],
  };
}

// --- fluxos ------------------------------------------------------------------

/**
 * Roda `docker args` sem esperar o fim e entrega a saída linha a linha:
 * `onLine(texto, 'out' | 'err')`. Devolve o processo, pra matar quando
 * ninguém mais olha.
 */
function stream(args, onLine, onExit) {
  let child;
  try {
    child = spawn(opts.binary, withContext(args), { env: ENV, cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    setImmediate(() => onExit && onExit(1, String(e.message)));
    return null;
  }
  let lastErr = '';
  const split = (which) => {
    let buf = '';
    return (chunk) => {
      buf += chunk.toString('utf8');
      let at;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at).replace(/\r$/, '');
        buf = buf.slice(at + 1);
        if (which === 'err' && line.trim()) lastErr = line;
        onLine(line, which);
      }
    };
  };
  child.stdout.on('data', split('out'));
  child.stderr.on('data', split('err'));
  child.on('error', (e) => {
    lastErr = e.code === 'ENOENT' ? `não achei o "${opts.binary}"` : String(e.message);
  });
  child.on('close', (code) => onExit && onExit(code, lastErr));
  return child;
}

/**
 * Mata um fluxo. O `docker stats` ignora o SIGTERM (fica no laço dele): se o
 * processo não saiu em 1,5s, vai o SIGKILL. Com `hard`, direto — é o plugin
 * saindo, e não há depois pra esperar.
 */
function kill(child, { hard = false } = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    child.kill(hard ? 'SIGKILL' : 'SIGTERM');
  } catch {
    return;
  }
  if (hard) return;
  const t = setTimeout(() => {
    if (child.exitCode === null && !child.signalCode) {
      try {
        child.kill('SIGKILL');
      } catch {
        // saiu entre uma coisa e outra
      }
    }
  }, 1500);
  t.unref();
}

/** Tira as cores e os movimentos de cursor que um log de terminal traz. */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]/g, '');
}

// --- compose -----------------------------------------------------------------

/** Os argumentos do compose pra um projeto: pelos arquivos quando dá, senão pelo nome. */
function composeArgs(project, { workdir, configFiles } = {}) {
  const args = ['compose'];
  const files = String(configFiles || '')
    .split(',')
    .filter(Boolean);
  if (workdir) args.push('--project-directory', workdir);
  for (const f of files) args.push('-f', f);
  args.push('-p', project);
  return args;
}

// --- o motor -----------------------------------------------------------------

/**
 * Como ligar o motor de um contexto, pelo endpoint dele: o OrbStack, o colima
 * (com o perfil do caminho do socket) ou o Docker Desktop. null quando não sei.
 */
function starterFor(ctx) {
  const endpoint = String((ctx && ctx.endpoint) || '');
  if (endpoint.includes('/.orbstack/')) return { label: 'ligar o OrbStack', cmd: 'orb', args: ['start'] };
  const colima = endpoint.match(/\/\.colima\/([^/]+)\/docker\.sock/);
  if (colima) return { label: 'ligar o colima', cmd: 'colima', args: colima[1] === 'default' ? ['start'] : ['start', '-p', colima[1]] };
  if (endpoint.includes('/.docker/run/') || (ctx && /desktop/.test(ctx.name))) {
    return { label: 'abrir o Docker Desktop', cmd: 'open', args: ['-a', 'Docker'] };
  }
  return null;
}

function startEngine(starter) {
  return new Promise((resolve, reject) => {
    execFile(starter.cmd, starter.args, { env: ENV, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(explain(stderr || stdout) || String(err.message)));
      else resolve();
    });
  });
}

// --- pra janela --------------------------------------------------------------

/** Um caminho com a home trocada por ~. */
function tilde(p) {
  if (!p) return p;
  return p === HOME || p.startsWith(HOME + path.sep) ? `~${p.slice(HOME.length)}` : p;
}

/** Aspas simples pro shell. */
function quote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** A linha de comando completa, pra rodar num terminal. */
function commandLine(args) {
  return [opts.binary, ...withContext(args)].map(quote).join(' ');
}

module.exports = {
  HOME,
  configure,
  run,
  must,
  explain,
  isDown,
  containers,
  images,
  volumes,
  diskUsage,
  contexts,
  engine,
  inspect,
  describe,
  stream,
  kill,
  stripAnsi,
  composeArgs,
  starterFor,
  startEngine,
  tilde,
  quote,
  commandLine,
};
