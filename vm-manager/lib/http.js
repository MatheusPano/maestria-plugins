// Cliente HTTP da API do CCS Console, só com o fetch do node.
//
// A mensagem de erro sai do corpo `{ statusCode, message }` do Nest (igual ao
// `extractMessage` do web). O token nunca entra em mensagem de erro.

'use strict';

class ApiError extends Error {
  constructor(message, status, { nest = false, kind = 'http' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.nest = nest;
    this.kind = kind;
  }
}

function extractMessage(body) {
  if (!body || typeof body !== 'object') return null;
  const msg = body.message;
  if (Array.isArray(msg)) return msg.join(' · ');
  if (typeof msg === 'string') return msg;
  return null;
}

function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function createHttp({ baseUrl, fetch: fetchFn = globalThis.fetch, getAuth, onUnauthorized, timeoutMs = 20000 }) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(method, path, { body, query, timeoutMs: t, raw = false, auth = true, headers } = {}) {
    const h = { 'Content-Type': 'application/json' };
    let usedToken = null;
    if (auth && getAuth) {
      usedToken = await getAuth();
      if (usedToken) h.Authorization = `Bearer ${usedToken}`;
    }
    Object.assign(h, headers || {});

    const init = { method, headers: h, signal: AbortSignal.timeout(t || timeoutMs) };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res;
    let text;
    try {
      res = await fetchFn(`${base}/api${path}${buildQuery(query)}`, init);
      text = res.status === 204 ? '' : await res.text();
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new ApiError('A API não respondeu a tempo.', 0, { kind: 'timeout' });
      }
      throw new ApiError(`Sem conexão com a API: ${e && e.message ? e.message : e}`, 0, { kind: 'network' });
    }

    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      if (res.status === 401 && auth && onUnauthorized) onUnauthorized(usedToken);
      const nest = !!parsed && typeof parsed === 'object' && parsed.statusCode !== undefined && parsed.message !== undefined;
      throw new ApiError(extractMessage(parsed) || `HTTP ${res.status}`, res.status, { nest, kind: 'http' });
    }

    if (raw) return parsed;
    if (parsed && typeof parsed === 'object' && parsed.data !== undefined && parsed.data !== null) return parsed.data;
    return parsed;
  }

  return { request };
}

module.exports = { ApiError, createHttp, extractMessage };
