// The page's side of mprog.jl, shared by Node (mrun.mjs) and the browser (browser/mpage.mjs, browser/mrun.mjs): what
// WGLMakie.js sends is `comm.notify({...})`, which Bonito turns into an UpdateObservable message for the observable
// `comm`; the page posts that through the bridge. The module's evaljs-style messages run in the page (`evalMessage`),
// and `checkMakie` checks the log they leave against `expectedMakie`: each check is [what, ok].

// (a stand-in for WGLMakie.js's pick: the plot's uuid and the index under the cursor)
const WGL = { pick_closest: (scene, xy, range) => ['1234567890', 2 + xy[0] % 2] };

// a message of the module: Bonito's EvalJavascript ('2') runs its source; an ask's result (or error) is the answer
export function evalMessage(v, bridge, log) {
  if (v.msg_type !== '2') { log.push('R ' + JSON.stringify(v)); return; }
  const run = () => new Function('console', 'Bonito', 'WGL', 'scene', v.payload.source)({ log: (...a) => log.push('JS ' + a.join(' ')) }, {}, WGL, {});
  if (v.bridge_ask !== undefined) bridge.reply(v.bridge_ask, new Promise((resolve) => resolve(run())));
  else run();
}

// Node's events: posted as WGLMakie.js would (the browser's come from Playwright's mouse and keyboard)
export async function drive({ bridge, commId, until }) {
  const upd = (payload) => bridge.post({ msg_type: '0', id: commId, payload });
  await until(() => bridge.parked());
  upd({ mouseposition: [12.5, 30] });
  upd({ mousedown: 1 });            // left button down: on(events(scene).mousebutton) runs in the module
  upd({ mouseup: 0 });
  upd({ scroll: [0, -120] });       // a wheel event: the sign is taken by WGLMakie's handler
  upd({ mousedown: 4 });            // middle button
  upd({ mouseup: 0 });
  upd({ keydown: ['KeyA', 'a'] });
  upd({ keyup: 'KeyA' });
  upd({ window_open: true });
  await until(() => bridge.stats.sent >= 7 && bridge.pending() === 0 && bridge.parked());
  bridge.post({ msg_type: 'pick', x: 60, y: 40 });   // Julia asks the page what is under the cursor (below)
  await until(() => bridge.stats.sent >= 9 && bridge.pending() === 0 && bridge.parked());
  bridge.post({ msg_type: 'stop' });
}

// what the page's log must hold, in order (after the hello), for a cursor at `pos` and a wheel of sign `scroll`
export function expectedMakie({ pos, scroll }) {
  return [
    'JS julia ready: scene 200x150',
    `JS julia saw left press at ${pos} left-down=true clicks=1`,
    `JS julia saw left release at ${pos} left-down=false clicks=2`,
    `JS julia saw scroll ${scroll} n=1`,
    `JS julia saw middle press at ${pos} left-down=false clicks=3`,
    `JS julia saw middle release at ${pos} left-down=false clicks=4`,
    'R {"msg_type":"picked","answer":["1234567890",2]}',
  ];
}

// log: the page's log; out: the module's stdout lines; rc: what main returned
export function checkMakie({ log, out, rc, pos, scroll }) {
  const hello = log[0] === undefined ? null : /^R \{"msg_type":"hello","comm":"([^"]+)"\}$/.exec(log[0]);
  const rest = log.slice(1);
  const want = expectedMakie({ pos, scroll });
  return [
    ['hello first, with the id of comm', hello !== null],
    ['the events reached events(scene), in order (the handlers\' evaljs)', JSON.stringify(rest) === JSON.stringify(want)],
    ['the pick answered', rest.includes('R {"msg_type":"picked","answer":["1234567890",2]}')],
    ['the scene\'s final state', out.includes(`R clicks=4 scrolls=1 moves=1 keys=2 pos=${pos} scroll=${scroll} pressed=0 window=200x150`)],
    ['main returned 0', rc === 0],
    ['no deadlock', !out.includes('DEADLOCK') && !log.includes('DEADLOCK')],
  ];
}
