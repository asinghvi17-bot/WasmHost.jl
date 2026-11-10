// JavaScript Promise Integration, which the browser adapter waits with: Chrome and Edge 137+
// (on by default); not in Firefox or Safari at the time of writing.
//
// While a module waits for the host, it is suspended in the middle of an export, and the page's
// event loop runs on. Julia's runtime isn't re-entrant: nothing may call into the module again
// until that export's promise settles. `promisingExports` is how a page calls a module's exports
// so that this holds; the adapter's host guard (`oneAtATime`) catches the page that doesn't, and
// a guard hit poisons the instance for good (see `InstancePoisonedError`).

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
 * promise), and one call at a time per instance: every call through them, on any export, waits
 * for the one before it to settle (`whenBusy: 'queue'`, the default), or is rejected with a
 * `ReentryError` while one is in flight (`whenBusy: 'reject'`). Calls made through different
 * results of `promisingExports(instance)` share the instance's queue. Call the module through
 * these only: calling `instance.exports` directly bypasses the queue.
 *
 * Once the instance is poisoned (the adapter's host guard caught a call that bypassed the
 * queue), every call through them rejects with an `InstancePoisonedError`, the ones still
 * queued included, and so does the export in flight, whatever it would have returned.
 */
export function promisingExports(instance, { whenBusy = 'queue' } = {}) {
  if (whenBusy !== 'queue' && whenBusy !== 'reject') throw new Error(`wasmhost: whenBusy ${whenBusy}: 'queue' or 'reject'`);
  if (!calls.has(instance)) calls.set(instance, { pending: 0, current: null, tail: Promise.resolve(), waiting: new Set() });
  const state = calls.get(instance);
  const out = {};
  for (const [name, f] of Object.entries(instance.exports)) {
    if (typeof f !== 'function') continue;
    const p = WebAssembly.promising(f);
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

// One host job at a time per WASI instance (both transports): `run(job)` runs `job()`. When
// another job of the instance is still suspended, i.e. when the page called into the module
// again (not through promisingExports) while it waited, that is a ReentryError, and it poisons
// the instance (the WASI instance, and the module instance it was initialized with): `run`
// rejects with the ReentryError, which the adapter lets propagate into the re-entrant call,
// and the suspended job rejects with an InstancePoisonedError instead of resuming its caller,
// as does every later job. WasmCodegen's handlers catch only Julia's own exceptions, so the
// errors unwind the module's frames without running its `finally` blocks: harmless only
// because nothing of the instance is used again.
const busy = new WeakMap();
export function oneAtATime(wasi) {
  return async function run(job) {
    checkPoisoned(wasi, 'request refused');
    if (busy.get(wasi)) {
      const err = new ReentryError('wasmhost: the module was called again while a request of it is in flight (call it through promisingExports)');
      poison(wasi, err);
      throw err;
    }
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
