// JavaScript Promise Integration, which the browser adapter waits with: Chrome and Edge 137+
// (on by default); not in Firefox or Safari at the time of writing.
//
// While a module waits for the host, it is suspended in the middle of an export, and the page's
// event loop runs on. Julia's runtime isn't re-entrant: nothing may call into the module again
// until that export's promise settles. `promisingExports` is how a page calls a module's exports
// so that this holds; the adapter's host guard (`oneAtATime`, `notSuspended`) catches the page
// that doesn't, and a guard hit poisons the instance for good (see `InstancePoisonedError`).
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

/**
 * The error of every use of an instance that a re-entrant call has poisoned: the suspended
 * export when it would resume, every later call through `promisingExports` (queued ones
 * included) and every later host job. `cause` is the ReentryError that poisoned it. Recovery
 * is a new instance (and a new WASI instance and adapter): nothing can be repaired.
 */
export class InstancePoisonedError extends Error {
  constructor(message, options) { super(message, options); this.name = 'InstancePoisonedError'; }
}

// Instances (and WASI instances, which the host guard knows them by) a ReentryError poisoned: why.
// The re-entrant call ran Julia code inside the suspended one; the ReentryError thrown into it
// can't unwind it safely (the module's handlers catch only Julia's own exceptions, so `finally`
// blocks, and what they release or remove, don't run), and the suspended call would resume on
// top of whatever that left. So nothing of the instance is trusted again.
const poisoned = new WeakMap();

/** Whether `instance` has been poisoned by a re-entrant call (see `InstancePoisonedError`). */
export function isPoisoned(instance) { return poisoned.has(instance); }

function poison(wasi, cause) {
  if (poisoned.has(wasi)) return;
  poisoned.set(wasi, cause);
  if (!wasi.inst) return;
  poisoned.set(wasi.inst, cause);
  // the calls still queued behind the one in flight reject now, not when that one settles (it may be stalled for good)
  const state = calls.get(wasi.inst);
  for (const entry of state?.waiting ?? []) entry.args = null, entry.reject(poisonedError(wasi.inst, `${entry.name} not run`));
}

// throws an InstancePoisonedError (what: what it stops) if `key` (an instance or a WASI instance) is poisoned
function checkPoisoned(key, what) {
  if (poisoned.has(key)) throw poisonedError(key, what);
}

function poisonedError(key, what) {
  const cause = poisoned.get(key);
  return new InstancePoisonedError(
    `wasmhost: ${what}: the module instance is poisoned, as it was called again while a request of it was in flight, ` +
    `which cannot be unwound safely; make a new instance (${cause.message})`, { cause });
}

// per instance: the export in flight (or queued), the tail of the queue, and the queued calls that haven't started
// (`waiting`: { name, args, reject }, for poisoning to reject at once and drop their arguments: the step chained on
// `tail` can't be unlinked, and stays until the call in flight settles, which may be never)
const calls = new WeakMap();

/**
 * The function exports of `instance`, each through `WebAssembly.promising` (so each returns a
 * promise; with `tasks`, a `makeJuliaTask` of WasmCodegen's js/julia_task.mjs, through its
 * `call`), and one call at a time per instance: every call through them, on any export, waits
 * for the one before it to settle (`whenBusy: 'queue'`, the default), or is rejected with a
 * `ReentryError` while one is in flight (`whenBusy: 'reject'`). Calls made through different
 * results of `promisingExports(instance)` share the instance's queue. Call the module through
 * these only: calling `instance.exports` directly bypasses the queue.
 *
 * Once the instance is poisoned (the adapter's host guard caught a call that bypassed the
 * queue), every call through them rejects with an `InstancePoisonedError`, the ones still
 * queued included, and so does the export in flight, whatever it would have returned.
 */
export function promisingExports(instance, { whenBusy = 'queue', tasks } = {}) {
  if (whenBusy !== 'queue' && whenBusy !== 'reject') throw new Error(`wasmhost: whenBusy ${whenBusy}: 'queue' or 'reject'`);
  if (!calls.has(instance)) calls.set(instance, { pending: 0, current: null, tail: Promise.resolve(), waiting: new Set() });
  const state = calls.get(instance);
  const out = {};
  for (const [name, f] of Object.entries(instance.exports)) {
    if (typeof f !== 'function') continue;
    // (with tasks: a root call of julia_task; its entry of new stacks is not the page's)
    if (tasks && name === 'jl_task_entry') continue;
    const p = tasks ? (...args) => tasks.call(f, ...args) : WebAssembly.promising(f);
    out[name] = (...args) => {
      try { checkPoisoned(instance, `${name} not called`); } catch (err) { return Promise.reject(err); }
      if (whenBusy === 'reject' && state.pending > 0)
        return Promise.reject(new ReentryError(`wasmhost: ${name} called while ${state.current ?? 'another export'} is in flight (one call at a time per module)`));
      if (state.pending++ === 0) state.current = name;
      // (poisoned while it waited in the queue, or while it ran: whatever it returns is not to be trusted)
      const entry = { name, args, reject: null };
      const turn = new Promise((_, reject) => { entry.reject = reject; });
      state.waiting.add(entry);
      const run = Promise.race([turn, state.tail.then(() => {
          // (rejected by poisoning while it waited, so already settled: it never runs)
          if (!state.waiting.delete(entry)) return;
          const { args } = entry; entry.args = null;
          checkPoisoned(instance, `${name} not run`); state.current = name; return p(...args); })])
        .then((result) => { checkPoisoned(instance, `${name} abandoned`); return result; },
              (err) => { if (!(err instanceof InstancePoisonedError)) checkPoisoned(instance, `${name} abandoned`); throw err; })
        .finally(() => { state.waiting.delete(entry); state.pending--; state.current = null; });
      state.tail = run.catch(() => {});
      return run;
    };
  }
  return out;
}

// One suspending host job at a time per WASI instance (both transports): `run(job)` runs
// `job()`. When another job of the instance is still suspended, or the module is suspended in
// julia_io's poll (`events`), i.e. when the page called into the module again (not through
// promisingExports) while it waited, that is a ReentryError, and it poisons the instance (the
// WASI instance, and the module instance it was initialized with): `run` rejects with the
// ReentryError, which the adapter lets propagate into the re-entrant call, and the suspended
// job rejects with an InstancePoisonedError instead of resuming its caller, as does every later
// job. WasmCodegen's handlers catch only Julia's own exceptions, so the errors unwind the
// module's frames without running its `finally` blocks: harmless only because nothing of the
// instance is used again. (A module suspended in julia_io's poll, not in a job, resumes when a
// request it waits for is done; its next host call, e.g. `http_finish`, then throws the
// InstancePoisonedError, and its export's result is rejected by promisingExports.)
const busy = new WeakMap();
const REENTRY = 'wasmhost: the module was called again while it waits (call it through promisingExports)';
export function oneAtATime(wasi, events) {
  const check = notSuspended(wasi, events);
  return async function run(job) {
    check();
    busy.set(wasi, true);
    try {
      const result = await job();
      checkPoisoned(wasi, 'request abandoned');
      return result;
    } catch (err) {
      if (!(err instanceof InstancePoisonedError)) checkPoisoned(wasi, 'request abandoned');
      throw err;
    } finally { busy.delete(wasi); }
  };
}

// The check of a host call that doesn't suspend (a request a task starts): `check()` throws a
// ReentryError, and poisons the instance, while the module is suspended, in a job of
// `oneAtATime(wasi)` or in julia_io's poll (`events`); an InstancePoisonedError once it is
// poisoned. Requests started by the tasks of the running call overlap freely.
export function notSuspended(wasi, events) {
  return function check() {
    checkPoisoned(wasi, 'request refused');
    if (busy.get(wasi) || events?.polling?.()) {
      const err = new ReentryError(REENTRY);
      poison(wasi, err);
      throw err;
    }
  };
}
