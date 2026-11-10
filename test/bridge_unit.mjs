// node bridge_unit.mjs: js/common/bridge.mjs on its own, with stand-in julia_io events (runtests.jl runs it). Prints
// "ok WHAT" or "FAIL WHAT" per check.
import { makeBridge, encodeFrame, decodeFrame, serveBridgeFile, BridgeClosedError, BridgeFullError, CLOSED_PREFIX } from '../js/common/bridge.mjs';

const handles = new Map();
let next = 1;
const events = {
  external({ onClose, onCancel } = {}) { const h = next++; handles.set(h, { ready: false, msg: null, onClose, onCancel }); return h; },
  ready(h, msg) { const x = handles.get(h); if (!x) return false; if (!x.ready) { x.ready = true; x.msg = msg ?? null; } return true; },
};
const check = (what, ok) => console.log(`${ok ? 'ok' : 'FAIL'} ${what}`);
const errName = (f) => { try { f(); return null; } catch (e) { return e instanceof BridgeClosedError ? 'BridgeClosedError' : e instanceof BridgeFullError ? 'BridgeFullError' : e?.name; } };
// the frames of an inbox write (u32le length | frame, repeated), decoded
const frames = (bytes) => {
  const out = [], dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length;) { const n = dv.getUint32(i, true); out.push(decodeFrame(bytes.subarray(i + 4, i + 4 + n))); i += 4 + n; }
  return out;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// a parked receive whose write throws (the review's reproduction: the waiter and the frames were lost): the handle is
// made ready with the error as its message, the frame stays queued, the next receive gets it
{
  const b = makeBridge({ events });
  const h = b.startRecv(true, () => { throw new Error('disk full'); });
  check('a parked receive gets a handle', h > 0 && b.parked());
  b.post({ a: 1 });
  const x = handles.get(h);
  check('a throwing write: the handle is made ready (not stranded)', x.ready);
  check('a throwing write: its message says why', x.msg === 'wasm-bridge: the frames could not be written: disk full');
  check('a throwing write: the frame stays queued, no receive parked', b.pending() === 1 && !b.parked() && b.stats.writeErrors === 1);
  let got = null;
  check('the next receive: at once (0)', b.startRecv(true, (bytes) => { got = bytes; }) === 0);
  check('the next receive: gets the frame', got !== null && JSON.stringify(frames(got)) === '[{"a":1}]' && b.pending() === 0);
  b.post({ b: 2 });
  check('a throwing write at once: -EIO', b.startRecv(true, () => { throw new Error('x'); }) === -29);
  check('a throwing write at once: the frame stays queued', b.pending() === 1 && b.stats.writeErrors === 2);
  check('a second receive while one is parked: -EBUSY', (() => { const c = makeBridge({ events }); c.startRecv(true, () => {}); return c.startRecv(true, () => {}); })() === -10);
  // the module gave up (close of the handle): no receive parked any more
  const c = makeBridge({ events });
  const hc = c.startRecv(true, () => {});
  handles.get(hc).onClose(hc);
  check('a closed handle: not parked', !c.parked());
  const hd = c.startRecv(true, () => {});
  handles.get(hd).onCancel(hd);
  check('a cancelled handle: not parked', !c.parked());
}

// capacity and overflow
{
  const b = makeBridge({ events, capacity: 3 });
  for (let i = 0; i < 3; i++) b.post({ i });
  check('reject: a full queue refuses (BridgeFullError), queues nothing', errName(() => b.post({ i: 3 })) === 'BridgeFullError' && b.pending() === 3 && b.stats.refused === 1);
  check('room() of a full queue', b.room().frames === 0);
  const d = makeBridge({ events, capacity: 3, overflow: 'drop-oldest' });
  for (let i = 0; i < 5; i++) d.post({ i });
  let got = null;
  d.startRecv(true, (bytes) => { got = frames(bytes); });
  check('drop-oldest: the newest stay, in order', JSON.stringify(got) === '[{"i":2},{"i":3},{"i":4}]' && d.stats.dropped === 2);
  const m = makeBridge({ events, maxBytes: 64 });
  check('a frame larger than the queue: BridgeFullError', errName(() => m.post({ s: 'x'.repeat(100) })) === 'BridgeFullError' && m.pending() === 0);
  m.post({ s: 'x'.repeat(30) });
  check('maxBytes: bytes count', errName(() => m.post({ s: 'x'.repeat(30) })) === 'BridgeFullError');
  check('an unknown overflow policy is an error', errName(() => makeBridge({ overflow: 'block' })) === 'Error');
}

// bounded chunks: one receive takes at most chunkBytes (at least one frame), the rest is there for the next
{
  const b = makeBridge({ events, chunkBytes: 64 });
  for (let i = 0; i < 10; i++) b.post({ i, pad: 'yyyyyyyy' });
  const sizes = [], all = [];
  while (b.pending() > 0) b.startRecv(true, (bytes) => { sizes.push(bytes.length); all.push(...frames(bytes)); });
  check('chunks: several receives, each within chunkBytes', sizes.length > 1 && sizes.every((n) => n <= 64));
  check('chunks: every frame, in order', JSON.stringify(all.map((v) => v.i)) === JSON.stringify([...Array(10).keys()]));
  const c = makeBridge({ events, chunkBytes: 8 });
  c.post({ big: 'z'.repeat(50) });
  let one = null;
  c.startRecv(true, (bytes) => { one = frames(bytes); });
  check('chunks: a frame larger than a chunk still goes, alone', one?.length === 1 && c.pending() === 0);
}

// closing from the page: a parked receive ends, posts and receives and sends are refused, onClose once
{
  const closes = [];
  const b = makeBridge({ events, onClose: (r, by) => closes.push([r, by]) });
  b.post({ queued: 1 });
  let got = null;
  b.startRecv(true, (bytes) => { got = bytes; });
  const h = b.startRecv(true, () => {});
  b.close('page gone');
  b.close('again');
  check('close: the parked receive is made ready with the reason', handles.get(h).ready && handles.get(h).msg === CLOSED_PREFIX + 'page gone');
  check('close: onClose once, by the page', JSON.stringify(closes) === '[["page gone","page"]]' && b.closed() === 'page gone');
  check('close: a post throws BridgeClosedError', errName(() => b.post({})) === 'BridgeClosedError');
  check('close: a receive is -EPIPE', b.startRecv(true, () => {}) === -64);
  check('close: a send of the module throws BridgeClosedError', errName(() => b.send(encodeFrame({ x: 1 }))) === 'BridgeClosedError');
  check('close: nothing queued', b.pending() === 0 && got !== null);
}

// closing from the module (Bridge.close sends {"bridge_close": reason})
{
  const closes = [], msgs = [];
  const b = makeBridge({ events, onMessage: (v) => msgs.push(v), onClose: (r, by) => closes.push([r, by]) });
  b.send(encodeFrame({ bridge_close: 'closed by main' }));
  check('the module\'s close: onClose by the module, not a message', JSON.stringify(closes) === '[["closed by main","module"]]' && msgs.length === 0);
  check('the module\'s close: posts refused', errName(() => b.post({})) === 'BridgeClosedError');
}

// asks: onAsk's value, rejection or throw is the reply; answers after a close are dropped
{
  const b = makeBridge({ events, onAsk: (v) => (v.op === 'add' ? Promise.resolve(v.a + v.b) : v.op === 'throw' ? (() => { throw new Error('bad op'); })() : Promise.reject(new Error('no such op'))) });
  b.send(encodeFrame({ bridge_ask: 1, op: 'add', a: 2, b: 3 }));
  b.send(encodeFrame({ bridge_ask: 2, op: 'fail' }));
  b.send(encodeFrame({ bridge_ask: 3, op: 'throw' }));
  await tick(); await tick();
  let got = null;
  b.startRecv(true, (bytes) => { got = frames(bytes); });
  const by = (id) => got?.find((m) => m.bridge_reply === id);
  check('ask: a value', by(1)?.value === 5);
  check('ask: a rejection is an error answer', by(2)?.error === 'no such op' && !('value' in by(2)));
  check('ask: a throw is an error answer', by(3)?.error === 'bad op');
  const c = makeBridge({ events, capacity: 1 });
  c.post({ fill: 1 });
  c.reply(7, 42);
  await tick();
  check('ask: a reply goes even when the queue is full', c.pending() === 2);
  c.close('x');
  c.reply(8, 1);
  await tick();
  check('ask: a reply after a close is dropped', c.pending() === 0);
}

// the adapters' part (serveBridgeFile)
{
  const files = {};
  const io = (req) => ({ read: () => req, answer: (t) => { files.res = t; }, writeInbox: () => { files.inb = 'partial'; throw new Error('EIO'); }, removeInbox: () => { delete files.inb; } });
  const b = makeBridge({ events, onMessage: () => { throw new Error('page bug'); } });
  serveBridgeFile(b, 'bsend', io(encodeFrame({ x: 1 })));
  check('bsend: onMessage\'s error is the answer', files.res === 'error: page bug');
  b.post({ y: 1 });
  serveBridgeFile(b, 'brecv', io(new TextEncoder().encode('wait')));
  check('brecv: a failed write is -EIO, no partial inbox, the frame stays', files.res === '-29' && !('inb' in files) && b.pending() === 1);
  b.close('done');
  serveBridgeFile(b, 'bsend', io(encodeFrame({ x: 1 })));
  check('bsend on a closed bridge: closed: reason', files.res === 'closed: done');
}

// the review of the fixes: replies are never dropped (drop-oldest) nor too large to queue; posts of non-JSON throw;
// a closed bridge's receive answer carries the page's reason
{
  const d = makeBridge({ events, capacity: 2, overflow: 'drop-oldest' });
  d.reply(1, 'picked');
  await tick();
  for (let i = 0; i < 5; i++) d.post({ i });
  let got = null;
  d.startRecv(true, (bytes) => { got = frames(bytes); });
  check('drop-oldest: a queued reply is not dropped, and does not count', JSON.stringify(got) === '[{"bridge_reply":1,"value":"picked"},{"i":3},{"i":4}]');
  const m = makeBridge({ events, maxBytes: 64 });
  const unhandled = [];
  const onRej = (e) => unhandled.push(e);
  process.on('unhandledRejection', onRej);
  m.reply(2, 'x'.repeat(200));
  await tick(); await tick();
  process.off('unhandledRejection', onRej);
  let ans = null;
  m.startRecv(true, (bytes) => { ans = frames(bytes); });
  check('a reply larger than the queue: an error answer, no unhandled rejection', unhandled.length === 0 && ans?.[0]?.bridge_reply === 2 && /larger than the queue/.test(ans[0].error));
  const b = makeBridge({ events });
  check('post(undefined), post(a function): throw, nothing queued', errName(() => b.post(undefined)) === 'Error' && errName(() => b.post(() => 1)) === 'Error' && b.pending() === 0);
  b.close('page gone');
  const files = {};
  serveBridgeFile(b, 'brecv', { read: () => new TextEncoder().encode('wait'), answer: (t) => { files.res = t; }, writeInbox: () => {}, removeInbox: () => {} });
  check('brecv on a closed bridge: -EPIPE and the reason', files.res === '-64\npage gone');
}
