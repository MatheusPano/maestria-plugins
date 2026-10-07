'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

const HOME = os.homedir();
const KUBECONFIG_EXT = /\.(ya?ml|kubeconfig)$/;
const RECENT_FILE =
  process.env.ARGO_RECENT_FILE || path.join(process.env.MAESTRIA_PLUGIN_DATA || path.join(HOME, '.local', 'state', 'argo'), 'recent');

const expand = (p) => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);

const options = {
  namespace: 'argocd',
  username: 'admin',
  kubectl: 'kubectl',
  kubeDir: path.join(HOME, '.kube', 'clusters'),
  tlsDir: '',
};
const conns = new Map();
const connecting = new Map();

function configure(next) {
  const tlsBefore = options.tlsDir;
  Object.assign(options, next);
  options.kubeDir = expand(options.kubeDir);
  options.tlsDir = options.tlsDir ? expand(options.tlsDir) : '';
  if (options.tlsDir !== tlsBefore) for (const conn of conns.values()) closeProxy(conn);
}

const kubeDir = () => options.kubeDir;

function kubeconfigs() {
  const map = new Map();
  try {
    for (const f of fs.readdirSync(options.kubeDir).sort()) {
      if (!KUBECONFIG_EXT.test(f)) continue;
      const name = f.replace(KUBECONFIG_EXT, '');
      if (!map.has(name)) map.set(name, path.join(options.kubeDir, f));
    }
  } catch {}
  return map;
}

function kubeconfig(cluster) {
  return kubeconfigs().get(cluster) || path.join(options.kubeDir, `${cluster}.yaml`);
}

function readRecent() {
  try {
    return fs.readFileSync(RECENT_FILE, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function clusters() {
  const all = [...kubeconfigs().keys()];
  const recent = readRecent().filter((c, i, a) => a.indexOf(c) === i && all.includes(c));
  return [...recent, ...all.filter((c) => !recent.includes(c))];
}

function markUsed(cluster) {
  const next = [cluster, ...readRecent().filter((c) => c !== cluster)].slice(0, 50);
  try {
    fs.mkdirSync(path.dirname(RECENT_FILE), { recursive: true });
    fs.writeFileSync(RECENT_FILE, next.join('\n') + '\n');
  } catch {}
}

function kubectl(config, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(options.kubectl, [`--kubeconfig=${config}`, ...args], { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function call(port, method, urlPath, { token, body, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (payload) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = https.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers, rejectUnauthorized: false, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}
          if (res.statusCode >= 400) {
            const err = new Error((json && (json.message || json.error)) || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            reject(err);
          } else resolve(json);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('tempo esgotado falando com o argocd')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(port, alive) {
  for (let i = 0; i < 60; i++) {
    if (!alive()) return false;
    try {
      await new Promise((resolve, reject) => {
        https
          .get({ host: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false, timeout: 2000 }, (res) => {
            res.resume();
            resolve();
          })
          .on('error', reject)
          .on('timeout', function () {
            this.destroy(new Error('timeout'));
          });
      });
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

function envPassword(cluster) {
  const key = `ARGOCD_PASSWORD_${cluster.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[key] || process.env.ARGOCD_PASSWORD || '';
}

async function password(cluster, config) {
  const fromEnv = envPassword(cluster);
  if (fromEnv) return fromEnv;
  const b64 = await kubectl(config, [
    '--request-timeout=10s',
    '-n',
    options.namespace,
    'get',
    'secret',
    'argocd-initial-admin-secret',
    '-o',
    'jsonpath={.data.password}',
  ]).catch(() => '');
  return b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
}

async function login(conn) {
  const pass = await password(conn.cluster, conn.config);
  if (!pass) return null;
  const res = await call(conn.backend, 'POST', '/api/v1/session', { body: { username: options.username, password: pass } }).catch(() => null);
  return (res && res.token) || null;
}

class ClusterError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function open(cluster, onDrop) {
  if (conns.has(cluster)) return conns.get(cluster);
  if (connecting.has(cluster)) return connecting.get(cluster);
  const job = doOpen(cluster, onDrop).finally(() => connecting.delete(cluster));
  connecting.set(cluster, job);
  return job;
}

async function doOpen(cluster, onDrop) {
  const config = kubeconfig(cluster);
  if (!fs.existsSync(config)) throw new ClusterError('nokube', `sem kubeconfig para '${cluster}'`);
  try {
    await kubectl(config, ['--request-timeout=10s', 'get', '--raw', '/version'], 15000);
  } catch {
    throw new ClusterError('expired', `token de '${cluster}' expirado ou cluster inacessível`);
  }
  const backend = await freePort();
  const pf = spawn(options.kubectl, [`--kubeconfig=${config}`, 'port-forward', 'svc/argocd-server', '-n', options.namespace, `${backend}:443`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  let exited = false;
  pf.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  pf.on('exit', () => {
    exited = true;
  });
  pf.on('error', (e) => {
    exited = true;
    stderr += e.message;
  });
  if (!(await waitHealthy(backend, () => !exited))) {
    pf.kill();
    throw new ClusterError('forward', `port-forward morreu — o argocd está instalado nesse cluster? ${stderr.trim()}`.trim());
  }
  const conn = { cluster, config, backend, pf, token: null, proxy: null };
  conn.token = await login(conn);
  pf.on('exit', () => {
    if (conns.get(cluster) !== conn) return;
    closeProxy(conn);
    conns.delete(cluster);
    if (onDrop) onDrop(cluster, stderr.trim());
  });
  conns.set(cluster, conn);
  markUsed(cluster);
  return conn;
}

const SYNC_PATH = /^\/api\/v1\/applications\/[^/?]+\/sync$/;

function allowed(method, urlPath, body) {
  if (method === 'GET') return true;
  return method === 'POST' && SYNC_PATH.test(urlPath) && !(body && body.prune);
}

async function api(conn, method, urlPath, body) {
  if (!allowed(method, urlPath, body)) throw new Error(`bloqueado: o plugin só lê, sincroniza e dá refresh (${method} ${urlPath})`);
  try {
    return await call(conn.backend, method, urlPath, { token: conn.token, body });
  } catch (e) {
    if (e.status !== 401) throw e;
    conn.token = await login(conn);
    if (!conn.token) throw new Error('login no argocd falhou — defina ARGOCD_PASSWORD ou confira o secret argocd-initial-admin-secret');
    return call(conn.backend, method, urlPath, { token: conn.token, body });
  }
}

function listen(server, port, host) {
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, host, () => resolve(true));
  });
}

const LEAF_DAYS = 397;
const RENEW_BEFORE_MS = 30 * 86400000;
const PAIRS = [
  ['localhost.crt', 'localhost.key'],
  ['tls.crt', 'tls.key'],
];
const CA_PAIRS = [
  ['ca.pem', 'ca.key'],
  ['ca.crt', 'ca.key'],
  ['rootCA.pem', 'rootCA-key.pem'],
];

function readPair(dir, [crt, key]) {
  try {
    return { cert: fs.readFileSync(path.join(dir, crt)), key: fs.readFileSync(path.join(dir, key)) };
  } catch {
    return null;
  }
}

function leafFromCa(ca) {
  const dir = path.join(process.env.MAESTRIA_PLUGIN_DATA || path.join(HOME, '.local', 'state', 'argo'), 'tls');
  const crtPath = path.join(dir, 'argo-localhost.crt');
  const keyPath = path.join(dir, 'argo-localhost.key');
  const caId = crypto.createHash('sha256').update(ca.cert).digest('hex');
  const idPath = path.join(dir, 'ca.sha256');
  try {
    const cert = fs.readFileSync(crtPath);
    const valid = new crypto.X509Certificate(cert).validTo;
    if (fs.readFileSync(idPath, 'utf8') === caId && Date.parse(valid) - Date.now() > RENEW_BEFORE_MS) {
      return { cert, key: fs.readFileSync(keyPath) };
    }
  } catch {}
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caCrt = path.join(dir, 'ca.crt.tmp');
  const caKey = path.join(dir, 'ca.key.tmp');
  const csr = path.join(dir, 'leaf.csr.tmp');
  const ext = path.join(dir, 'leaf.ext.tmp');
  try {
    fs.writeFileSync(caCrt, ca.cert);
    fs.writeFileSync(caKey, ca.key, { mode: 0o600 });
    fs.writeFileSync(
      ext,
      'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' +
        'subjectAltName=DNS:argo.localhost,DNS:*.argo.localhost,DNS:localhost,IP:127.0.0.1,IP:::1\n',
    );
    const openssl = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000 });
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-subj', '/CN=argo.localhost', '-out', csr]);
    fs.chmodSync(keyPath, 0o600);
    openssl(['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-set_serial', `0x${crypto.randomBytes(12).toString('hex')}`,
      '-days', String(LEAF_DAYS), '-sha256', '-extfile', ext, '-out', crtPath]);
    fs.writeFileSync(idPath, caId);
    return { cert: fs.readFileSync(crtPath), key: fs.readFileSync(keyPath) };
  } finally {
    for (const f of [caCrt, caKey, csr, ext]) fs.rmSync(f, { force: true });
  }
}

let tlsProblem = '';

function tlsCreds() {
  tlsProblem = '';
  if (!options.tlsDir) return null;
  for (const pair of PAIRS) {
    const found = readPair(options.tlsDir, pair);
    if (found) return found;
  }
  for (const pair of CA_PAIRS) {
    const ca = readPair(options.tlsDir, pair);
    if (!ca) continue;
    try {
      return leafFromCa(ca);
    } catch (e) {
      tlsProblem = `não consegui gerar o certificado com a CA de ${options.tlsDir}: ${String((e.stderr || e.message || e)).trim().split('\n').pop()}`;
      return null;
    }
  }
  tlsProblem = `${options.tlsDir} não tem localhost.crt/localhost.key nem uma CA (ca.pem + ca.key)`;
  return null;
}

async function startProxy(conn) {
  const creds = tlsCreds();
  if (!creds) return { host: 'localhost', port: conn.backend, servers: [] };
  const handle = (sock) => {
    const up = tls.connect({ host: '127.0.0.1', port: conn.backend, rejectUnauthorized: false });
    sock.pipe(up).pipe(sock);
    sock.on('error', () => up.destroy());
    up.on('error', () => sock.destroy());
  };
  const port = await freePort();
  const v4 = tls.createServer(creds, handle);
  const v6 = tls.createServer(creds, handle);
  const servers = [];
  if (await listen(v4, port, '127.0.0.1')) servers.push(v4);
  if (await listen(v6, port, '::1')) servers.push(v6);
  if (!servers.length) return { host: 'localhost', port: conn.backend, servers: [] };
  return { host: `${conn.cluster}.argo.localhost`, port, servers };
}

function closeProxy(conn) {
  if (!conn.proxy) return;
  for (const s of conn.proxy.servers) s.close();
  conn.proxy = null;
}

async function loginLink(host, target, token) {
  const page = Buffer.from(
    `<!doctype html><meta charset="utf-8"><title>argocd</title><meta http-equiv="refresh" content="0;url=${target}">` +
      `<body style="font:14px system-ui;padding:2rem">entrando no argocd…<p><a href="${target}">continuar</a></p>`,
  );
  const handler = (req, res) => {
    if (req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': page.length,
      'Set-Cookie': `argocd.token=${token}; Path=/; SameSite=Lax; Max-Age=86400`,
    });
    res.end(page);
    setTimeout(stop, 2000);
  };
  const port = await freePort();
  const servers = [http.createServer(handler), http.createServer(handler)];
  const up = [];
  if (await listen(servers[0], port, '127.0.0.1')) up.push(servers[0]);
  if (await listen(servers[1], port, '::1')) up.push(servers[1]);
  function stop() {
    for (const s of up) s.close();
  }
  if (!up.length) return null;
  setTimeout(stop, 30000);
  return `http://${host}:${port}/`;
}

async function browserUrl(conn, appPath = '/applications') {
  if (!conn.proxy) conn.proxy = await startProxy(conn);
  const { host, port } = conn.proxy;
  const target = `https://${host}:${port}${appPath}`;
  if (!conn.token) conn.token = await login(conn);
  if (!conn.token) return target;
  return (await loginLink(host, target, conn.token)) || target;
}

function close(cluster) {
  const conn = conns.get(cluster);
  if (!conn) return;
  conns.delete(cluster);
  closeProxy(conn);
  conn.pf.kill();
}

function closeAll() {
  for (const c of [...conns.keys()]) close(c);
}

const isOpen = (cluster) => conns.has(cluster);
const isConnecting = (cluster) => connecting.has(cluster);

module.exports = { tlsWarning: () => tlsProblem, configure, clusters, open, api, browserUrl, close, closeAll, isOpen, isConnecting, ClusterError, kubeDir, kubeconfig, expand };
