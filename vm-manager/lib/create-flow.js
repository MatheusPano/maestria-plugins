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
  // A geração da criação: `abandon()` a troca, e o que estava no ar (a resposta do
  // POST, os ticks do acompanhamento) passa a ser ignorado.
  let gen = 0;
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
    const g = gen;
    const put = (patch) => {
      if (g === gen) set(patch);
    };
    const name = st.name;
    let sawRunning = false;

    const finishFound = (vm) =>
      put({
        phase: 'succeeded',
        result: { vm, netbox: null, backupSlot: null, ha: false, warnings: [FALLBACK_WARNING] },
        error: '',
      });

    const tick = async () => {
      if (g !== gen) return; // abandonada
      let creation = null;
      let err = null;
      try {
        creation = await api.vmCreation(name);
      } catch (e) {
        err = e;
      }
      if (creation && creation.status === 'succeeded') {
        put({ phase: 'succeeded', result: creation.result || null, error: '' });
        return;
      }
      if (creation && creation.status === 'failed') {
        const msg = creation.error || '';
        if (ALREADY_EXISTS.test(msg)) {
          const vm = await findVm(name);
          if (vm) return finishFound(vm);
        }
        put({ phase: 'failed', error: msg });
        return;
      }
      if (creation && creation.status === 'running') sawRunning = true;
      else if (err && err.status === 404 && sawRunning) {
        // registro perdido (API reiniciou): confere na lista
        const vm = await findVm(name);
        if (vm) return finishFound(vm);
      }
      if (g !== gen) return;
      if (now() - st.startedAt >= maxMs) {
        put({ phase: 'unconfirmed', error: UNCONFIRMED });
        return;
      }
      schedule(tick, pollMs);
    };

    schedule(tick, pollMs);
  }

  function submit(body) {
    if (st.phase !== 'idle') return Promise.resolve({ ...st });
    set({ phase: 'submitting', name: String((body && body.name) || ''), result: null, error: '', startedAt: now() });
    const g = gen;
    return (async () => {
      let outcome;
      try {
        outcome = { ok: true, data: await api.createVm(body) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      if (g !== gen) return { ...st }; // abandonada no meio do POST
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

  // Larga a criação em curso (a sessão acabou: sair ou trocar o url) sem esperar o
  // fim: para de acompanhar e volta pra idle. A VM pode sair mesmo assim; quem
  // entra depois a vê na lista.
  function abandon() {
    gen++;
    if (st.phase === 'idle') return;
    set({ phase: 'idle', name: '', result: null, error: '', startedAt: 0 });
  }

  return {
    state: () => ({ ...st }),
    submit,
    reset,
    abandon,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

module.exports = { IN_PROGRESS, classify, createCreateFlow };
