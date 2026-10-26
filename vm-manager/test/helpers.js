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

module.exports = { fakeFetch };
