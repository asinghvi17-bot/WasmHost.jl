// node bridge_unit.mjs: js/common/bridge.mjs (and the parts of js/common/page.mjs it uses: wait, source, guard) on
// their own, with stand-in julia_io events and a stand-in module that calls the `wasm_host_page` imports as
// WasmHostPageExt does (runtests.jl runs it). Prints "ok WHAT" or "FAIL WHAT" per check.
import { makeBridge, encodeFrame, decodeFrame, BridgeClosedError, BridgeFullError } from '../js/common/bridge.mjs';
import { makePage } from '../js/common/page.mjs';

const handles = new Map();
let next = 1;
const events = {
  external({ onClose, onCancel } = {}) { const h = next++; handles.set(h, { ready: false, onClose, onCancel }); return h; },
  ready(h) { const x = handles.get(h); if (!x) return false; x.ready = true; return true; },
};
const check = (what, ok) => console.log(`${ok ? 'ok' : 'FAIL'} ${what}`);
const errName = (f) => { try { f(); return null; } catch (e) { return e instanceof BridgeClosedError ? 'BridgeClosedError' : e instanceof BridgeFullError ? 'BridgeFullError' : e?.name; } };
const tick = () => new Promise((r) => setTimeout(r, 0));

// the module's side: what WasmHostPageExt does with the imports of `b` (a bridge or a page)
function M(b) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  b.bindMemory(memory);
  const p = b.imports.wasm_host_page;
  return {
    send(frame) { new Uint8Array(memory.buffer).set(frame, 0); p.send(0, frame.length); },
    receive() {
      const n = p.pending();
      if (n < 0) return null;
      p.read(65536, 0, n);
      const r = new Uint8Array(memory.buffer, 65536, n).slice();
      p.pop();
      return r;
    },
    wait: () => p.wait(),
    // every record there is: [kind, value]
    records() { const out = []; for (let r; (r = this.receive()) !== null;) out.push([r[0], decodeFrame(r.subarray(1))]); return out; },
    values() { return this.records().map(([, v]) => v); },
  };
}

// Page on its own: wait, notify, source, guard
{
  const p = makePage({ events });
  const m = M(p);
  const h = m.wait();
  check('page wait: nothing pending, a handle', h > 0 && p.waiting() && !handles.get(h).ready);
  check('page wait: a second wait meanwhile is -2', m.wait() === -2);
  p.post('x');
  check('page wait: a post makes it ready', handles.get(h).ready && !p.waiting());
  check('page wait: a message pending, 0', m.wait() === 0);
  m.receive();
  check('page wait: without events, -1', M(makePage()).wait() === -1);
  const h2 = m.wait();
  handles.get(h2).onCancel(h2);
  check('page wait: a cancelled handle (the module\'s wake) does not wait', !p.waiting());
  const h3 = m.wait();
  handles.get(h3).onClose(h3);
  check('page wait: a closed handle does not wait', !p.waiting());
  const src = [new Uint8Array([1]), new Uint8Array([2])];
  const s = makePage({ events, source: () => src.shift() ?? null });
  const ms = M(s);
  s.post(new Uint8Array([0]));
  const got = [];
  for (let r; (r = ms.receive()) !== null;) got.push(r[0]);
  check('page source: posted first, then the source\'s, one at a time', got.join() === '0,1,2');
  const hs = ms.wait();
  src.push(new Uint8Array([3]));
  s.notify();
  check('page source: notify wakes a wait when the source has one', handles.get(hs).ready && ms.receive()[0] === 3);
  let calls = 0, refuse = false;
  const g = makePage({ events, guard: () => { calls++; if (refuse) throw new Error('reentry'); } });
  const mg = M(g);
  mg.send(new Uint8Array([1])); mg.wait(); mg.receive();
  check('page guard: called by each import', calls >= 3);
  refuse = true;
  check('page guard: what it throws is the import\'s', errName(() => mg.send(new Uint8Array([1]))) === 'Error' && errName(() => mg.wait()) === 'Error');
}

// a parked receive of the bridge: a post wakes it, the record is there
{
  const b = makeBridge({ events });
  const m = M(b);
  const h = m.wait();
  check('a waiting recv gets a handle', h > 0 && b.parked());
  b.post({ a: 1 });
  check('a post wakes it', handles.get(h).ready && !b.parked());
  check('the record: a message', JSON.stringify(m.records()) === '[[0,{"a":1}]]' && b.pending() === 0 && b.stats.delivered === 1);
}

// capacity and overflow
{
  const b = makeBridge({ events, capacity: 3 });
  for (let i = 0; i < 3; i++) b.post({ i });
  check('reject: a full queue refuses (BridgeFullError), queues nothing', errName(() => b.post({ i: 3 })) === 'BridgeFullError' && b.pending() === 3 && b.stats.refused === 1);
  check('room() of a full queue', b.room().frames === 0);
  M(b).records();
  check('room() once the module took them', b.room().frames === 3 && b.pendingBytes() === 0);
  const d = makeBridge({ events, capacity: 3, overflow: 'drop-oldest' });
  for (let i = 0; i < 5; i++) d.post({ i });
  check('drop-oldest: the newest stay, in order', JSON.stringify(M(d).values()) === '[{"i":2},{"i":3},{"i":4}]' && d.stats.dropped === 2);
  const m = makeBridge({ events, maxBytes: 64 });
  check('a frame larger than the queue: BridgeFullError', errName(() => m.post({ s: 'x'.repeat(100) })) === 'BridgeFullError' && m.pending() === 0);
  m.post({ s: 'x'.repeat(30) });
  check('maxBytes: bytes count', errName(() => m.post({ s: 'x'.repeat(30) })) === 'BridgeFullError');
  check('an unknown overflow policy is an error', errName(() => makeBridge({ overflow: 'block' })) === 'Error');
}

// closing from the page: the queue is dropped, a parked receive wakes, the close is the next record
{
  const closes = [], msgs = [];
  const b = makeBridge({ events, onMessage: (v) => msgs.push(v), onClose: (r, by) => closes.push([r, by]) });
  const m = M(b);
  b.post({ dropped: 1 });
  m.receive();
  b.post({ dropped: 2 });
  b.post({ dropped: 3 });
  const b2 = makeBridge({ events });
  const m2 = M(b2);
  const hw = m2.wait();
  b2.close('page gone');
  check('close: the parked receive is woken', handles.get(hw).ready && !b2.parked());
  check('close: the next record is the close, with the reason', JSON.stringify(m2.records()) === '[[2,"page gone"]]');
  b.close('page gone');
  b.close('again');
  check('close: onClose once, by the page', JSON.stringify(closes) === '[["page gone","page"]]' && b.closed() === 'page gone');
  check('close: the queue dropped, only the close left', JSON.stringify(m.records()) === '[[2,"page gone"]]' && b.stats.dropped === 2);
  check('close: a post throws BridgeClosedError', errName(() => b.post({})) === 'BridgeClosedError');
  m.send(encodeFrame({ x: 1 }));
  check('close: a send of the module after it is dropped (it learns at its next receive)', msgs.length === 0);
}

// closing from the module (Bridge.close sends {"bridge_close": reason})
{
  const closes = [], msgs = [];
  const b = makeBridge({ events, onMessage: (v) => msgs.push(v), onClose: (r, by) => closes.push([r, by]) });
  M(b).send(encodeFrame({ bridge_close: 'closed by main' }));
  check('the module\'s close: onClose by the module, not a message', JSON.stringify(closes) === '[["closed by main","module"]]' && msgs.length === 0);
  check('the module\'s close: posts refused, no close record', errName(() => b.post({})) === 'BridgeClosedError' && M(b).receive() === null);
}

// asks: onAsk's value, rejection or throw is the reply; answers after a close are dropped
{
  const b = makeBridge({ events, onAsk: (v) => (v.op === 'add' ? Promise.resolve(v.a + v.b) : v.op === 'throw' ? (() => { throw new Error('bad op'); })() : Promise.reject(new Error('no such op'))) });
  const m = M(b);
  m.send(encodeFrame({ bridge_ask: 1, op: 'add', a: 2, b: 3 }));
  m.send(encodeFrame({ bridge_ask: 2, op: 'fail' }));
  m.send(encodeFrame({ bridge_ask: 3, op: 'throw' }));
  await tick(); await tick();
  const got = m.records();
  const by = (id) => got.find(([k, v]) => k === 1 && v.bridge_reply === id)?.[1];
  check('ask: a value', by(1)?.value === 5);
  check('ask: a rejection is an error answer', by(2)?.error === 'no such op' && !('value' in by(2)));
  check('ask: a throw is an error answer', by(3)?.error === 'bad op');
  const c = makeBridge({ events, capacity: 1 });
  const mc = M(c);
  c.post({ fill: 1 });
  mc.send(encodeFrame({ bridge_ask: 7 }));   // (no onAsk: the page answers from onMessage)
  c.reply(7, 42);
  await tick();
  check('ask: a reply goes even when the queue is full', c.pending() === 2);
  mc.send(encodeFrame({ bridge_ask: 8 }));
  c.close('x');
  c.reply(8, 1);
  await tick();
  check('ask: a reply after a close is dropped', c.pending() === 0);
}

// onMessage's errors stay on the page (Page's rule: nothing thrown into the module); an ask it threw for is answered
// with the error, so the module's ask ends
{
  const errors = [];
  const b = makeBridge({ events, onMessage: () => { throw new Error('page bug'); }, onError: (e) => errors.push(e.message) });
  const m = M(b);
  m.send(encodeFrame({ x: 1 }));
  check('onMessage throws: onError, stats.errors, the send returns', errors.join() === 'page bug' && b.stats.errors === 1);
  m.send(encodeFrame({ bridge_ask: 4 }));
  await tick(); await tick();
  check('onMessage throws for an ask: the ask\'s error answer', JSON.stringify(m.records()) === '[[1,{"bridge_reply":4,"error":"page bug"}]]');
  check('onMessage throws for an ask: a later reply refused', b.reply(4, 1) === false);
  const quiet = makeBridge({ events, onError: (e) => errors.push(e.message) });
  M(quiet).send(new Uint8Array([200, 0, 0, 0, 1]));
  check('a frame that does not decode: onError', errors.length === 3 && quiet.stats.errors === 1);
}

// replies are never dropped (drop-oldest) nor too large to queue; posts of non-JSON throw
{
  const d = makeBridge({ events, capacity: 2, overflow: 'drop-oldest' });
  const md = M(d);
  md.send(encodeFrame({ bridge_ask: 1 }));
  d.reply(1, 'picked');
  await tick();
  for (let i = 0; i < 5; i++) d.post({ i });
  check('drop-oldest: a queued reply is not dropped, and does not count', JSON.stringify(md.records()) === '[[1,{"bridge_reply":1,"value":"picked"}],[0,{"i":3}],[0,{"i":4}]]');
  const m = makeBridge({ events, maxBytes: 64 });
  const mm = M(m);
  const unhandled = [];
  const onRej = (e) => unhandled.push(e);
  process.on('unhandledRejection', onRej);
  mm.send(encodeFrame({ bridge_ask: 2 }));
  m.reply(2, 'x'.repeat(200));
  await tick(); await tick();
  process.off('unhandledRejection', onRej);
  const ans = mm.values();
  check('a reply larger than the queue: an error answer, no unhandled rejection', unhandled.length === 0 && ans?.[0]?.bridge_reply === 2 && /larger than the queue/.test(ans[0].error));
  const b = makeBridge({ events });
  check('post(undefined), post(a function): throw, nothing queued', errName(() => b.post(undefined)) === 'Error' && errName(() => b.post(() => 1)) === 'Error' && b.pending() === 0);
}

// replies only to outstanding asks, once
{
  const b = makeBridge({ events, capacity: 1, maxBytes: 128 });
  const m = M(b);
  m.send(encodeFrame({ bridge_ask: 5, op: 'pick' }));
  const results = [];
  for (let i = 0; i < 1000; i++) results.push(b.reply(5, i));
  await tick(); await tick();
  check('reply: the first to an outstanding ask is taken, the others refused (false)', results[0] === true && results.slice(1).every((r) => r === false));
  check('reply: one frame queued, the first answer', b.pending() === 1 && b.stats.strayReplies === 999);
  check('reply: to an id never asked: false, nothing queued', b.reply(6, 1) === false && b.pending() === 1);
  check('reply: room() of the page\'s own posts unchanged', b.room().frames === 1 && b.room().bytes === 128);
  check('reply: the module gets the first answer only', JSON.stringify(m.values()) === '[{"bridge_reply":5,"value":0}]');
  check('reply: after the answer was taken, still refused', b.reply(5, 1) === false && b.pending() === 0);
  const a = makeBridge({ events, onAsk: () => 'auto' });
  M(a).send(encodeFrame({ bridge_ask: 9 }));
  check('reply: with onAsk, a second reply by hand is refused', a.reply(9, 'manual') === false);
}

// raw replies through post: a posted message is never an answer, however it serializes: only `reply` makes the
// answers' record kind. Five sequential asks with capacity 1, each 'answered' first by a raw post (a plain object,
// then a toJSON one), then by reply, then by a stale reply
{
  const b = makeBridge({ events, capacity: 1 });
  const m = M(b);
  let late = 0;
  const got = [];
  for (let id = 1; id <= 5; id++) {
    m.send(encodeFrame({ bridge_ask: id }));
    const raw = id % 2 ? { bridge_reply: id, value: -id } : { toJSON() { return { bridge_reply: id, value: -id }; } };
    const posted = errName(() => b.post(raw)) === null;
    b.reply(id, id);
    await tick();
    got.push(...m.records());
    if (b.reply(id, 100 + id)) late++;
    if (!posted) got.push(['post threw']);
  }
  const kinds = got.map(([k, v]) => `${k}:${v?.value}`).join(' ');
  check('raw posts (plain, toJSON) are messages (kind 0), answers are kind 1', kinds === '0:-1 1:1 0:-2 1:2 0:-3 1:3 0:-4 1:4 0:-5 1:5');
  check('no stale reply taken, nothing left queued (capacity 1)', late === 0 && b.pending() === 0 && b.stats.strayReplies === 5);
  check('the raw posts were counted (ordinary posts)', b.stats.posted === 10);
  check('the page\'s bridge has no module side (send, receive): only the imports', !('send' in b) && !('startRecv' in b) && 'imports' in b);
}

// empty typed arrays (a frame whose only blob is empty has no blob region)
{
  const kinds = [Float32Array, Float64Array, Uint8Array, Int8Array, Int16Array, Uint16Array, Int32Array, Uint32Array];
  check('empty typed arrays of each kind round-trip', kinds.every((C) => { const v = decodeFrame(encodeFrame({ a: new C(0) })).a; return v instanceof C && v.length === 0; }));
  const mixed = decodeFrame(encodeFrame({ e: new Float32Array(0), f: new Float64Array([1.5, -2]), g: new Int8Array(0), h: new Uint16Array([7]) }));
  check('empty and non-empty typed arrays together', mixed.e.length === 0 && mixed.g.length === 0 && Array.from(mixed.f).join() === '1.5,-2' && mixed.h[0] === 7);
  const header = new TextEncoder().encode('{"$b":[0,0,"f32"]}');
  const frame = new Uint8Array(4 + header.length);
  new DataView(frame.buffer).setUint32(0, header.length, true);
  frame.set(header, 4);
  const v = decodeFrame(frame);
  check('an empty blob at the end of a frame without a blob region', v instanceof Float32Array && v.length === 0);
  check('a non-empty blob out of range still throws', errName(() => { const h = new TextEncoder().encode('{"$b":[0,4,"f32"]}'); const f = new Uint8Array(4 + h.length); new DataView(f.buffer).setUint32(0, h.length, true); f.set(h, 4); decodeFrame(f); }) === 'Error');
}
