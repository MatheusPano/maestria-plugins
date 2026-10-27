'use strict';

// Loops de polling por chave. `schedule(fn, ms) → cancel` é injetado (setTimeout em produção).
function createPoller({ schedule }) {
  const loops = new Map();

  function loop(key, ms, tick) {
    if (loops.has(key)) return;
    const state = { cancel: null };
    loops.set(key, state);
    const run = async () => {
      state.cancel = null;
      let again = false;
      try {
        again = (await tick()) !== false;
      } catch {
        again = true;
      }
      if (loops.get(key) !== state) return; // parado durante o tick
      if (!again) {
        loops.delete(key);
        return;
      }
      state.cancel = schedule(run, ms);
    };
    run();
  }

  function stop(key) {
    const state = loops.get(key);
    if (!state) return;
    loops.delete(key);
    if (state.cancel) state.cancel();
  }

  function stopAll() {
    for (const key of [...loops.keys()]) stop(key);
  }

  return { loop, stop, stopAll, running: (key) => loops.has(key) };
}

module.exports = { createPoller };
