// Requests the module started without waiting (`wasm_host.http_start`, or opening a spool
// `<id>.hnd`), for a module with Julia tasks: each is a handle of WasmCodegen's `julia_io`
// events (`events.external()`, js/julia_io.mjs of WasmCodegen), which the module's task waits
// for while its other tasks run, and which the adapter makes ready when the request is done.
// No Node or browser API is used here.

// `events` if it can make handles for the adapter (null: none given); throws for events without
// external handles (an older WasmCodegen)
export function checkEvents(events) {
  if (events == null) return null;
  if (typeof events.external !== 'function' || typeof events.ready !== 'function')
    throw new Error('wasmhost: these julia_io events have no external handles (needs a WasmCodegen whose julia_io.mjs has events.external)');
  return events;
}

// The started jobs of an adapter. `start(run, settle)` calls `run(signal)` (an async function
// that never rejects: it returns the job's outcome) and returns the job's handle at once; when
// `run` settles, `settle(outcome)` keeps what the module will read (unless the module closed the
// handle first: the outcome is dropped), then the handle becomes ready. Closing the handle
// aborts `signal`. `stats.inFlight` and `stats.maxInFlight`: the jobs running, now and at most.
export function makeJobs(events, stats) {
  const kept = new Map(); // handle -> what settle kept
  stats.inFlight ??= 0;
  stats.maxInFlight ??= 0;
  return {
    start(run, settle = (v) => v) {
      const controller = new AbortController();
      let closed = false;
      const h = events.external({ onClose: () => { closed = true; kept.delete(h); controller.abort(); } });
      stats.inFlight++;
      if (stats.inFlight > stats.maxInFlight) stats.maxInFlight = stats.inFlight;
      Promise.resolve().then(() => run(controller.signal)).then((v) => {
        stats.inFlight--;
        if (closed) return;
        kept.set(h, settle(v));
        events.ready(h);
      }, (err) => {
        // (a bug of the adapter: the handle becomes ready with nothing kept, which the module
        // reads as no response)
        stats.inFlight--;
        if (!closed) events.ready(h, String(err?.message ?? err));
      });
      return h;
    },
    // what settle kept for a ready handle, or undefined
    result: (h) => kept.get(h),
  };
}

// `signal` and fetch's timeout (seconds; Infinity: none) as one AbortSignal, or undefined
export function requestSignal(timeout, signal) {
  const t = Number.isFinite(timeout) ? AbortSignal.timeout(Math.max(1, timeout * 1000)) : undefined;
  if (t && signal) return AbortSignal.any([t, signal]);
  return t ?? signal;
}
