// Sessão do plugin: login de um clique pelo navegador, refresh do Bearer e 401.
// Nada aqui loga token, código ou verifier.

'use strict';

const auth = require('./auth');
const { createHttp, ApiError } = require('./http');
const { createApi } = require('./api');
const loopbackLib = require('./loopback');

const LOGIN_MESSAGES = {
  sso: 'Não foi possível entrar. Tente de novo.',
  expired: 'O login demorou demais. Tente de novo.',
  timeout: 'O login expirou. Tente de novo.',
  cancelled: 'Login cancelado.',
};

function createSession({
  url,
  store,
  fetch,
  openUrl,
  now = Date.now,
  startLoopback = loopbackLib.startLoopback,
  randomBytes,
  apiOptions,
}) {
  const listeners = { expired: [], changed: [] };
  let loginPromise = null;
  let refreshPromise = null;

  function emit(event) {
    for (const fn of listeners[event]) {
      try {
        fn();
      } catch {
        // ouvinte não derruba a sessão
      }
    }
  }

  function on(event, fn) {
    if (!listeners[event]) throw new Error(`evento desconhecido: ${event}`);
    listeners[event].push(fn);
  }

  /** Registro do token só se for deste url. */
  function current() {
    const rec = store.load();
    return rec && rec.url === url ? rec : null;
  }

  /** Só derruba a sessão se o token que levou o 401 ainda é o guardado (ignora 401 velho). */
  function expire(usedToken) {
    const rec = store.load();
    if (!rec || !usedToken || rec.token !== usedToken) return;
    store.clear();
    emit('changed');
    emit('expired');
  }

  function validTokenResponse(d) {
    return !!d && typeof d.token === 'string' && d.token !== '' && Number.isFinite(Date.parse(d.expiresAt));
  }

  function user() {
    const rec = current();
    return rec ? rec.user || null : null;
  }

  function isLoggedIn() {
    const rec = current();
    return !!rec && !auth.isExpired(rec, now());
  }

  async function doRefresh(rec) {
    try {
      const data = await api.pluginRefresh(rec.token);
      if (!validTokenResponse(data)) return;
      // logout/expire/login durante o refresh: não ressuscita o token
      const live = store.load();
      if (!live || live.url !== url || live.token !== rec.token) return;
      const nextUser = data.user || rec.user;
      store.save({
        url,
        token: data.token,
        expiresAt: Date.parse(data.expiresAt),
        obtainedAt: now(),
        user: nextUser,
      });
      if (JSON.stringify(nextUser) !== JSON.stringify(rec.user)) emit('changed');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) expire(rec.token);
      // outras falhas: mantém o token antigo
    }
  }

  async function authHeader() {
    let rec = current();
    if (!rec) return null;
    const t = now();
    if (auth.isExpired(rec, t)) return null;
    if (auth.needsRefresh(rec, t)) {
      if (!refreshPromise) {
        refreshPromise = doRefresh(rec).finally(() => {
          refreshPromise = null;
        });
      }
      await refreshPromise;
      rec = current();
      if (!rec) return null;
    }
    return rec.token;
  }

  const http = createHttp({
    baseUrl: url,
    fetch,
    getAuth: authHeader,
    onUnauthorized: expire,
  });
  const api = createApi(http, apiOptions);

  async function runLogin() {
    const verifier = auth.makeVerifier(randomBytes);
    const state = auth.makeState(randomBytes);
    let lb;
    try {
      lb = await startLoopback({ state });
      openUrl(auth.buildLoginUrl(url, { port: lb.port, state, challenge: auth.challengeOf(verifier) }));
      const res = await lb.result;
      if (!res || res.error) {
        return { ok: false, message: LOGIN_MESSAGES[res && res.error] || LOGIN_MESSAGES.sso };
      }
      const data = await api.pluginToken({ code: res.code, verifier });
      if (!validTokenResponse(data)) return { ok: false, message: 'Não foi possível entrar: resposta inválida da API.' };
      const t = now();
      store.save({ url, token: data.token, expiresAt: Date.parse(data.expiresAt), obtainedAt: t, user: data.user });
      emit('changed');
      return { ok: true, user: data.user };
    } catch (e) {
      return { ok: false, message: `Não foi possível entrar: ${e && e.message ? e.message : e}` };
    } finally {
      if (lb) lb.close();
    }
  }

  function login() {
    if (!loginPromise) {
      loginPromise = runLogin().finally(() => {
        loginPromise = null;
      });
    }
    return loginPromise;
  }

  function logout() {
    store.clear();
    emit('changed');
  }

  async function refreshMe() {
    const me = await api.me();
    const rec = current();
    if (rec) {
      store.save({ ...rec, user: me });
      emit('changed');
    }
    return me;
  }

  return { api, user, isLoggedIn, login, logout, refreshMe, authHeader, on };
}

module.exports = { createSession };
