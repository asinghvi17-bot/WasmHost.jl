// The page's side of brprog.jl's cases, shared by Node (brun.mjs) and the browser (browser/page.mjs: window.runBridge):
// it posts, answers the module's asks, closes, and checks what the module sent, printed and returned. Each check is
// [what, ok]; a case passes when all are true.
//
//   const s = bridgeScenario(makeBridge, events, which);   // s.bridge: give it to the adapter (wrapWasi)
//   const checks = await s.run({ main, stdout, raw });       // main: the promise of `main`; stdout(): its lines so far
//
// raw (reentry, a browser): { poke, poke_recv, isPoisoned, again } calls into the module that bypass promisingExports.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errName = (e) => e?.name ?? String(e);
// (deep equality, objects' keys in any order: a Julia Dict's order is its hash's)
const canon = (x) => (Array.isArray(x) ? x.map(canon) : x !== null && typeof x === 'object' && !ArrayBuffer.isView(x) ?
  Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const arr = (x) => (ArrayBuffer.isView(x) ? { [x.constructor.name]: Array.from(x) } : x);

export function bridgeScenario(makeBridge, events, which) {
  const got = [];      // what the module sent (onMessage), in order
  const asks = [];     // the module's asks: { value, resolve, reject }
  const closes = [];   // [reason, by] of onClose
  let throwNext = false;   // (write-fails) the next write of the frames throws
  const bridge = makeBridge({
    events, capacity: 64, chunkBytes: 256,
    onMessage: (v) => { got.push(v); },
    onAsk: (v) => new Promise((resolve, reject) => { asks.push({ value: v, resolve, reject }); }),
    onClose: (reason, by) => { closes.push([reason, by]); },
  });
  if (which === 'write-fails') {
    const startRecv = bridge.startRecv;
    bridge.startRecv = (w, write) => startRecv(w, (bytes) => {
      if (throwNext) { throwNext = false; throw new Error('injected write failure'); }
      return write(bytes);
    });
  }
  const until = async (f, what, ms = 20000) => {
    for (const t0 = Date.now(); !f(); await wait(2)) if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
  };
  const msg = (type, extra = () => true) => got.find((m) => m.type === type && extra(m));
  const postThrows = (v) => { try { bridge.post(v); return null; } catch (e) { return errName(e); } };

  async function run({ main, stdout, raw }) {
    const checks = [];
    const check = (what, ok) => { checks.push([what, !!ok]); };
    let rc, mainErr = null;
    const settled = main.then((v) => { rc = v; }, (e) => { mainErr = e; });
    try {
      await until(() => msg('hello') && bridge.parked(), 'hello and a parked recv');
      const h = msg('hello');
      check('hello: strings with escapes', h.msg === 'from julia é\n"q"' && h.case === which);
      check('hello: numbers, Bool, nothing', h.x === 1.5 && h.flag === true && h.none === null);
      check('hello: Dict("x" => 1)', same(h.dict, { x: 1 }));
      check('hello: [true, false]', same(h.bools, [true, false]));
      check('hello: (1, "x")', same(h.tuple, [1, 'x']));
      check('hello: a NamedTuple', same(h.named, { a: 1.5, b: 's', c: [1, 2] }));
      check('hello: a Float32 vector is a Float32Array', h.f32 instanceof Float32Array && same(Array.from(h.f32), [1, 2, 3.5]));
      check('hello: Symbol, Chars', h.sym === 'sym' && same(h.chars, ['a', 'é']));
      check('hello: Dict{String,Any} of Any values', same(h.nested, { v: [1, 's', { k: 2.5 }, [1, 2]], b: [true], n: null }));

      if (which === 'main' || which === 'reentry') {
        const pongs = () => got.filter((m) => m.type === 'pong');
        bridge.post({ type: 'ping', v: new Float32Array([1, 2, 3.5]), s: 'café' });
        await until(() => pongs().length === 1, 'the first pong');
        const p1 = pongs()[0];
        check('pong 1: contents', p1.n === 1 && p1.sum === 6.5 && p1.echo === 'café' && p1.arr instanceof Int32Array &&
                                  same(Array.from(p1.arr), [1, 2, 3]));
        // two posts at once: in order
        bridge.post({ type: 'ping', v: new Float32Array([10]) });
        bridge.post({ type: 'ping', v: new Float32Array([20]), s: 'second' });
        await until(() => pongs().length === 3, 'pongs 2 and 3');
        check('pongs 2 and 3: in order, contents', same(pongs().map((p) => [p.n, p.sum, p.echo]), [[1, 6.5, 'café'], [2, 16.5, null], [3, 36.5, 'second']]));
      }
      if (which === 'reentry') {
        // main is suspended (in julia_io's poll, its tasks waiting): a direct call into the module is a re-entry
        await until(() => bridge.parked(), 'a parked recv');
        const r1 = await raw.poke().then(() => 'returned', errName);
        check('a direct call that sends: ReentryError', r1 === 'ReentryError');
        check('the instance is poisoned', raw.isPoisoned());
        const r2 = await raw.poke_recv().then(() => 'returned', errName);
        check('a direct call that receives, after: InstancePoisonedError', r2 === 'InstancePoisonedError');
        check('the bridge was not used by them', !got.some((m) => m.type === 'poke'));
        bridge.post({ type: 'stop' });
        await Promise.race([settled, wait(20000)]);
        check('main, suspended meanwhile, rejects with an InstancePoisonedError', errName(mainErr) === 'InstancePoisonedError');
        const r3 = await raw.again().then(() => 'returned', errName);
        check('a later call through promisingExports: InstancePoisonedError', r3 === 'InstancePoisonedError');
        return checks;
      }
      if (which === 'main') {
        // a burst: in order; the queue (capacity 64) overflows, the refused posts throw; chunks of 256 bytes
        const delivered0 = bridge.stats.delivered, receives0 = bridge.stats.receives;
        let accepted = 0, refused = 0, other = 0;
        for (let i = 1; i <= 70; i++) {
          const e = postThrows({ type: 'seq', n: accepted + 1 });
          if (e === null) accepted++; else if (e === 'BridgeFullError') refused++; else other++;
        }
        check('burst: the queue refuses what does not fit (BridgeFullError)', refused > 0 && other === 0 && accepted + refused === 70 && accepted <= 65);
        check('burst: room() is empty when full', bridge.room().frames === 0);
        await until(() => bridge.pending() === 0 && bridge.parked(), 'the burst taken');
        check('burst: taken in bounded chunks (several receives)', bridge.stats.delivered - delivered0 === accepted && bridge.stats.receives - receives0 >= 5);
        bridge.post({ type: 'seq-end' });
        await until(() => msg('seq-done'), 'seq-done');
        const sd = msg('seq-done');
        check('burst: all accepted ones arrived, in order', sd.count === accepted && sd.inorder === true);

        // two asks at once, answered out of order
        bridge.post({ type: 'ask2' });
        await until(() => asks.length === 2, 'two asks');
        const ids = asks.map((a) => a.value.bridge_ask);
        check('two asks: distinct ids', Number.isInteger(ids[0]) && Number.isInteger(ids[1]) && ids[0] !== ids[1]);
        const byA = (a) => asks.find((x) => x.value.a === a);
        byA(10).resolve(byA(10).value.a + byA(10).value.b);   // the second first
        await wait(20);
        byA(1).resolve(byA(1).value.a + byA(1).value.b);
        await until(() => got.filter((m) => m.type === 'answer').length === 2, 'two answers');
        check('two asks: each its own answer', msg('answer', (m) => m.tag === 'first').value === 3 && msg('answer', (m) => m.tag === 'second').value === 30);
        // an ask the page fails: AskError in the module
        bridge.post({ type: 'askfail' });
        await until(() => asks.length === 3, 'the failing ask');
        asks[2].reject(new Error('no such op: fail'));
        await until(() => msg('ask-failed'), 'ask-failed');
        const af = msg('ask-failed');
        check('a rejected ask: AskError with the page\'s message', af.tag === 'fail' && af.error === 'AskError' && af.msg === 'no such op: fail');
        // stop: serve returns, which closes the bridge
        bridge.post({ type: 'stop' });
        await settled;
        check('stop: bye', msg('bye')?.pings === 3);
        check('stop: main returned 0', rc === 0 && mainErr === null);
        check('serve\'s end closed the bridge (onClose by the module)', same(closes, [['Bridge.serve returned', 'module']]) && bridge.closed() === 'Bridge.serve returned');
        check('the module\'s send after close: BridgeClosedError', stdout().includes('R send after close: BridgeClosedError: the bridge is closed (Bridge.serve returned)'));
        check('a post after close: BridgeClosedError', postThrows({ type: 'late' }) === 'BridgeClosedError');
      } else if (which === 'page-close') {
        await until(() => asks.length === 1 && bridge.parked(), 'the held ask, a parked recv');
        bridge.close('page gone');
        await settled;
        check('main returned 0', rc === 0 && mainErr === null);
        check('the pending ask failed: BridgeClosedError', stdout().includes('R ask: BridgeClosedError: the bridge is closed (page gone)'));
        check('the parked serve returned', stdout().includes('R serve returned; open: false'));
        check('onClose by the page', same(closes, [['page gone', 'page']]));
        check('a post after close: BridgeClosedError', postThrows({ type: 'late' }) === 'BridgeClosedError');
        asks[0].resolve(1);   // (an answer after the close: dropped)
        await wait(10);
        check('an answer after close is dropped', bridge.pending() === 0);
      } else if (which === 'serve-fails') {
        await until(() => asks.length === 1 && bridge.parked(), 'the held ask, a parked recv');
        bridge.post({ type: 'boom' });
        await settled;
        check('main returned 0', rc === 0 && mainErr === null);
        check('serve failed with the handler\'s error', stdout().includes('R serve failed: boom; open: false'));
        check('the pending ask failed: BridgeClosedError', stdout().includes('R ask: BridgeClosedError: the bridge is closed (Bridge.serve failed: boom)'));
        check('onClose by the module', same(closes, [['Bridge.serve failed: boom', 'module']]));
        check('a post after close: BridgeClosedError', postThrows({ type: 'late' }) === 'BridgeClosedError');
      } else if (which === 'module-close') {
        bridge.post({ type: 'close-now' });
        await settled;
        check('main returned 0', rc === 0 && mainErr === null);
        check('the parked serve returned', stdout().includes('R serve returned; open: false'));
        check('an ask after close: BridgeClosedError', stdout().includes('R ask after close: BridgeClosedError: the bridge is closed (closed by main)'));
        check('onClose by the module', same(closes, [['closed by main', 'module']]));
        check('no recv left parked', !bridge.parked());
        check('a post after close: BridgeClosedError', postThrows({ type: 'late' }) === 'BridgeClosedError');
      } else if (which === 'write-fails') {
        throwNext = true;
        bridge.post({ type: 'kept' });
        await settled;
        check('main returned 0', rc === 0 && mainErr === null);
        check('the first recv failed with the write\'s error', stdout().some((l) => l.startsWith('R first recv: BridgeError: the host could not deliver the page\'s messages (they stay queued): wasm-bridge: the frames could not be written: injected write failure')));
        check('the frame stayed queued: the second recv got it', same(msg('got'), { type: 'got', n: 1, first: 'kept' }));
        check('one write error, nothing left', bridge.stats.writeErrors === 1 && bridge.pending() === 0);
      } else {
        check(`a known case (${which})`, false);
      }
    } catch (e) {
      check(`no failure (${e?.message ?? e})`, false);
    }
    await Promise.race([settled, wait(1000)]);
    return checks;
  }
  return { bridge, got: () => got.map((m) => JSON.parse(JSON.stringify(m, (k, x) => arr(x)))), run };
}
