// The page's side of mprog.jl, shared by Node (mrun.mjs) and the browser (browser/mpage.mjs): what WGLMakie.js sends
// is `comm.notify({...})`, which Bonito turns into an UpdateObservable message for the observable `comm`; the page posts
// that through the bridge. `log` collects what the module's evaljs-style messages run in the page.
export async function drive({ bridge, commId, wait, until }) {
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
