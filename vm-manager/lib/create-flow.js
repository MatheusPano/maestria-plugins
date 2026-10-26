'use strict';

// Criar VM sem duplicar (design §2.4): o POST /vms sai UMA vez. Se a resposta não for
// definitiva (timeout, rede caída, 5xx não-JSON, 409 "já está sendo criada"), o fluxo
// acompanha GET /vms/creations/:name em vez de reenviar.

const IN_PROGRESS = /já está sendo criada/;
const ALREADY_EXISTS = /Já existe uma VM chamada/;
const UNCONFIRMED = 'não deu pra confirmar — confira a lista antes de tentar de novo';
const FALLBACK_WARNING = 'Criada; detalhes do NetBox/backup não disponíveis — confira na lista.';
const FINAL = new Set(['succeeded', 'rejected', 'failed', 'unconfirmed']);

// Um 2xx só é sucesso com o resultado em json; vazio ou não-JSON (um proxy no meio)
// não diz se a VM saiu: acompanha.
function classify(outcome) {
  if (outcome.ok) return outcome.data !== null && typeof outcome.data === 'object' ? 'succeeded' : 'track';
  const e = outcome.error;
  if (e && e.nest && !(e.status === 409 && IN_PROGRESS.test(e.message))) return 'rejected';
  return 'track';
}

function createCreateFlow({ api, now, schedule, pollMs = 5000, maxMs = 600000 }) {
  let st = { phase: 'idle', name: '', result: null, error: '', startedAt: 0 };
  const listeners = new Set();

  function set(patch) {
    st = { ...st, ...patch };
    for (const fn of listeners) {
      try {
        fn({ ...st });
      } catch {
        // listener com defeito não derruba o fluxo
      }
    }
  }

  // Procura a VM pelo nome exato; erro da API ou ausência → null (segue acompanhando).
  async function findVm(name) {
    try {
      const list = await api.vms();
      return (Array.isArray(list) ? list : []).find((v) => v && v.name === name) || null;
    } catch {
      return null;
    }
  }

  function track() {
    const name = st.name;
    let sawRunning = false;

    const finishFound = (vm) =>
      set({
        phase: 'succeeded',
        result: { vm, netbox: null, backupSlot: null, ha: false, warnings: [FALLBACK_WARNING] },
        error: '',
      });

    const tick = async () => {
      let creation = null;
      let err = null;
      try {
        creation = await api.vmCreation(name);
      } catch (e) {
        err = e;
      }
      if (creation && creation.status === 'succeeded') {
        set({ phase: 'succeeded', result: creation.result || null, error: '' });
        return;
      }
      if (creation && creation.status === 'failed') {
        const msg = creation.error || '';
        if (ALREADY_EXISTS.test(msg)) {
          const vm = await findVm(name);
          if (vm) return finishFound(vm);
        }
        set({ phase: 'failed', error: msg });
        return;
      }
      if (creation && creation.status === 'running') sawRunning = true;
      else if (err && err.status === 404 && sawRunning) {
        // registro perdido (API reiniciou): confere na lista
        const vm = await findVm(name);
        if (vm) return finishFound(vm);
      }
      if (now() - st.startedAt >= maxMs) {
        set({ phase: 'unconfirmed', error: UNCONFIRMED });
        return;
      }
      schedule(tick, pollMs);
    };

    schedule(tick, pollMs);
  }

  function submit(body) {
    if (st.phase !== 'idle') return Promise.resolve({ ...st });
    set({ phase: 'submitting', name: String((body && body.name) || ''), result: null, error: '', startedAt: now() });
    return (async () => {
      let outcome;
      try {
        outcome = { ok: true, data: await api.createVm(body) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      const kind = classify(outcome);
      if (kind === 'succeeded') set({ phase: 'succeeded', result: outcome.data, error: '' });
      else if (kind === 'rejected') set({ phase: 'rejected', error: outcome.error.message });
      else {
        set({ phase: 'tracking', error: '' });
        track();
      }
      return { ...st };
    })();
  }

  function reset() {
    if (!FINAL.has(st.phase)) return false;
    set({ phase: 'idle', name: '', result: null, error: '', startedAt: 0 });
    return true;
  }

  return {
    state: () => ({ ...st }),
    submit,
    reset,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

module.exports = { IN_PROGRESS, classify, createCreateFlow };
