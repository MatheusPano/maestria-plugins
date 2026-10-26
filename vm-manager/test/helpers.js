'use strict';

// fetch de mentira: `routes` é uma lista de { method, path, status, json, text,
// throws, delayMs } casada em ordem (path com ou sem query string).
function fakeFetch(routes) {
  const calls = [];
  async function fetch(url, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    let body = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // fica como texto
      }
    }
    calls.push({ method, url: String(url), headers: { ...(init.headers || {}) }, body });
    const route = routes.find(
      (r) => (!r.method || r.method.toUpperCase() === method) && (!r.path || r.path === u.pathname || r.path === u.pathname + u.search),
    );
    if (!route) throw new Error(`fakeFetch: sem rota para ${method} ${u.pathname}${u.search}`);
    if (route.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, route.delayMs);
        if (init.signal) {
          const abort = () => {
            clearTimeout(t);
            reject(init.signal.reason);
          };
          if (init.signal.aborted) abort();
          else init.signal.addEventListener('abort', abort, { once: true });
        }
      });
    }
    if (route.throws) throw route.throws;
    const status = route.status || 200;
    const payload = route.text !== undefined ? route.text : route.json !== undefined ? JSON.stringify(route.json) : '';
    return new Response(status === 204 ? null : payload, { status });
  }
  fetch.calls = calls;
  return fetch;
}

// Falha apontando o caminho do primeiro null/undefined (o RFW não aceita null no data).
function assertNoNull(value, path = '') {
  if (value === null || value === undefined) {
    throw new Error(`assertNoNull: ${value === null ? 'null' : 'undefined'} em ${path || '(raiz)'}`);
  }
  if (Array.isArray(value)) value.forEach((v, i) => assertNoNull(v, `${path}[${i}]`));
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) assertNoNull(v, path ? `${path}.${k}` : k);
}

// Relógio falso: `schedule(fn, ms)` devolve `cancel`; `now()` é o tempo virtual.
// `advance(ms)` é ASSÍNCRONO: dispara os timers vencidos em ordem e, depois de cada
// um, deixa as promises pendentes (ticks async) assentarem via setImmediate real.
// Nos testes: `await clock.advance(1000)`.
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => t,
    schedule(fn, ms) {
      const id = seq++;
      timers.set(id, { at: t + ms, fn });
      return () => timers.delete(id);
    },
    async advance(ms) {
      const end = t + ms;
      await settle();
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= end && (!next || tm.at < next.tm.at)) next = { id, tm };
        if (!next) break;
        timers.delete(next.id);
        t = Math.max(t, next.tm.at);
        next.tm.fn();
        await settle();
      }
      t = end;
    },
  };
}

module.exports = { fakeFetch, assertNoNull, fakeClock };
