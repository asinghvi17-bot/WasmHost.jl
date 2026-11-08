// JavaScript Promise Integration, which the browser adapter waits with: Chrome and Edge 137+
// (on by default); not in Firefox or Safari at the time of writing.
//
// While a module waits for the host, it is suspended in the middle of an export, and the page's
// event loop runs on. Julia's runtime isn't re-entrant: nothing may call into the module again
// until that export's promise settles. `promisingExports` is how a page calls a module's exports
// so that this holds; the adapter's host guard (`oneAtATime`, `notSuspended`) catches the page
// that doesn't.
//
// A module with Julia tasks (`Config(tasks = :jspi)`) runs on WasmCodegen's julia_task: its
// exports are called through julia_task's `call` (the root task), which `promisingExports` does
// when given it (`tasks`). Such a module has several requests in flight at once (one per task
// that waits), started without suspending: a start is a re-entry only while the module is
// suspended, in a host job of the adapter or in julia_io's `poll` (when the adapter has the
// `events`).

/** Why this browser can't run a module whose imports suspend (JSPI), or null if it can. */
export function jspiGap() {
  if (typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function') return null;
  const ua = globalThis.navigator?.userAgent ?? 'this engine';
  return `JSPI (WebAssembly.Suspending/promising; Chrome 137+): not in ${ua}`;
}

/** The error of a call into a module while another one is in flight. */
export class ReentryError extends Error {
  constructor(message) { super(message); this.name = 'ReentryError'; }
}

// per instance: the export in flight (or queued) and the tail of the queue
const calls = new WeakMap();

/**
 * The function exports of `instance`, each through `WebAssembly.promising` (so each returns a
 * promise; with `tasks`, a `makeJuliaTask` of WasmCodegen's js/julia_task.mjs, through its
 * `call`), and one call at a time per instance: every call through them, on any export, waits
 * for the one before it to settle (`whenBusy: 'queue'`, the default), or is rejected with a
 * `ReentryError` while one is in flight (`whenBusy: 'reject'`). Calls made through different
 * results of `promisingExports(instance)` share the instance's queue. Call the module through
 * these only: calling `instance.exports` directly bypasses the queue.
 */
export function promisingExports(instance, { whenBusy = 'queue', tasks } = {}) {
  if (whenBusy !== 'queue' && whenBusy !== 'reject') throw new Error(`wasmhost: whenBusy ${whenBusy}: 'queue' or 'reject'`);
  if (!calls.has(instance)) calls.set(instance, { pending: 0, current: null, tail: Promise.resolve() });
  const state = calls.get(instance);
  const out = {};
  for (const [name, f] of Object.entries(instance.exports)) {
    if (typeof f !== 'function') continue;
    // (with tasks: a root call of julia_task; its entry of new stacks is not the page's)
    if (tasks && name === 'jl_task_entry') continue;
    const p = tasks ? (...args) => tasks.call(f, ...args) : WebAssembly.promising(f);
    out[name] = (...args) => {
      if (whenBusy === 'reject' && state.pending > 0)
        return Promise.reject(new ReentryError(`wasmhost: ${name} called while ${state.current ?? 'another export'} is in flight (one call at a time per module)`));
      if (state.pending++ === 0) state.current = name;
      const run = state.tail.then(() => { state.current = name; return p(...args); })
        .finally(() => { state.pending--; state.current = null; });
      state.tail = run.catch(() => {});
      return run;
    };
  }
  return out;
}

// One suspending host job at a time per WASI instance (both transports): `run(job)` runs
// `job()`, or rejects with a ReentryError when another job of the instance is still suspended,
// or the module is suspended in julia_io's poll (`events`), i.e. when the page called into the
// module again (not through promisingExports) while it waited. The adapter lets that error
// propagate into the module, so the re-entrant call fails instead of carrying on (WasmCodegen's
// handlers catch only Julia's own exceptions).
const busy = new WeakMap();
const REENTRY = 'wasmhost: the module was called again while it waits (call it through promisingExports)';
export function oneAtATime(wasi, events) {
  const check = notSuspended(wasi, events);
  return async function run(job) {
    check();
    busy.set(wasi, true);
    try { return await job(); } finally { busy.delete(wasi); }
  };
}

// The check of a host call that doesn't suspend (a request a task starts): `check()` throws a
// ReentryError while the module is suspended, in a job of `oneAtATime(wasi)` or in julia_io's
// poll (`events`); requests started by the tasks of the running call overlap freely.
export function notSuspended(wasi, events) {
  return function check() {
    if (busy.get(wasi) || events?.polling?.()) throw new ReentryError(REENTRY);
  };
}
