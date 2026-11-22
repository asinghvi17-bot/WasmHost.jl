// One call at a time per module instance, and poisoning (see README.md, "Calls").
//
// While a module waits for the host (JSPI), it is suspended in the middle of an export and the
// page's event loop runs on. Julia's runtime isn't re-entrant: nothing may call into the module
// again until that export's promise settles. `promisingExports` queues the page's calls so that
// this holds. `guarded` is the host side's check: a host request while another of the same
// instance is suspended means the page called the module behind the queue's back, and poisons
// the instance for good.

/** Why this browser can't run a module whose imports suspend (JSPI), or null if it can. */
export function jspiGap() {
  if (typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function') return null;
  return `JSPI (WebAssembly.Suspending/promising; Chrome 137+): not in ${globalThis.navigator?.userAgent ?? 'this engine'}`;
}

/** The error of every call of a poisoned instance. Recovery is a new instance (and a new WASI instance). */
export class InstancePoisonedError extends Error {
  constructor(message) { super(message); this.name = 'InstancePoisonedError'; }
}

// per instance: the tail of its queue, whether a host request is in flight, and the poisoning (`dead` rejects with it)
const states = new WeakMap();
function stateOf(instance) {
  let s = states.get(instance);
  if (s === undefined) {
    s = { tail: Promise.resolve(), busy: false, poisoned: null };
    s.dead = new Promise((_, reject) => { s.kill = reject; });
    s.dead.catch(() => {});
    states.set(instance, s);
  }
  return s;
}
function check(s) { if (s.poisoned) throw s.poisoned; }

/** Whether `instance` has been poisoned by a re-entrant call. */
export function isPoisoned(instance) { return Boolean(states.get(instance)?.poisoned); }

/**
 * The function exports of `instance`, each through `WebAssembly.promising`, queued: a call
 * starts when the one before it (on any export of the instance) has settled. Call the module
 * through these only. Once the instance is poisoned, every call rejects with an
 * InstancePoisonedError at once: the one in flight, the queued ones and every later one.
 */
export function promisingExports(instance) {
  const s = stateOf(instance);
  const out = {};
  for (const [name, f] of Object.entries(instance.exports)) {
    if (typeof f !== 'function') continue;
    const p = WebAssembly.promising(f);
    out[name] = (...args) => {
      const run = Promise.race([s.dead, s.tail.then(() => { check(s); return p(...args); })]);
      s.tail = run.catch(() => {});
      return run;
    };
  }
  return out;
}

// `job` (an async host import of the module of `wasi`, a WASI instance of the shim, initialized), one at a time: a
// second job while one is suspended poisons the instance and fails, which throws into the re-entrant call; the
// suspended job then fails too instead of resuming its caller, as does every later one.
export function guarded(wasi, job) {
  return async (...args) => {
    if (!wasi.inst) throw new Error('wasmhost: no instance (call wasi.initialize(instance) first)');
    const s = stateOf(wasi.inst);
    check(s);
    if (s.busy) {
      s.poisoned = new InstancePoisonedError('wasmhost: the module was called again while it waited for the host ' +
        '(call it through promisingExports only); it cannot be used again: make a new instance');
      s.kill(s.poisoned);
      throw s.poisoned;
    }
    s.busy = true;
    try {
      const result = await job(...args);
      check(s);
      return result;
    } finally { s.busy = false; }
  };
}
