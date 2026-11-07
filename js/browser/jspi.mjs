// JavaScript Promise Integration, which the browser adapter waits with: Chrome and Edge 137+
// (on by default); not in Firefox or Safari at the time of writing.

/** Why this browser can't run a module whose imports suspend (JSPI), or null if it can. */
export function jspiGap() {
  if (typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function') return null;
  const ua = globalThis.navigator?.userAgent ?? 'this engine';
  return `JSPI (WebAssembly.Suspending/promising; Chrome 137+): not in ${ua}`;
}

// One host job at a time per WASI instance (both transports): `run(job)` runs `job()`, or
// throws when another job of the instance is still suspended, i.e. when the page called into
// the module again while it waited.
const busy = new WeakMap();
export function oneAtATime(wasi) {
  return async function run(job) {
    if (busy.get(wasi)) throw new Error('wasmhost: another request of this module is in flight (one at a time)');
    busy.set(wasi, true);
    try { return await job(); } finally { busy.delete(wasi); }
  };
}
