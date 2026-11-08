// The module's filesystem as the browser adapter sees it: the preopens of a WASI instance of
// @bjorn3/browser_wasi_shim (`new WASI(args, env, fds)`), files in memory. The adapter reads a
// request's files and writes the response's through the shim's own directory operations
// (`path_open`, `path_create_directory`, `path_unlink_file`), so it needs no import of the shim:
// tested with the shim 0.4.2.

const OFLAGS_CREAT = 1, OFLAGS_TRUNC = 8;
const ERRNO_EXIST = 20;

export const posix = {
  normalize(p) {
    const out = [];
    for (const s of String(p).split('/')) {
      if (s === '' || s === '.') continue;
      if (s === '..') out.pop(); else out.push(s);
    }
    return '/' + out.join('/');
  },
  join: (a, b) => posix.normalize(b.startsWith('/') ? b : a + '/' + b),
  dirname(p) { p = posix.normalize(p); return p.slice(0, p.lastIndexOf('/')) || '/'; },
};

// An error with the code of a Node one (ENOENT, EACCES), which the adapter maps to errnos
function fsError(code, message) { return Object.assign(new Error(message), { code }); }

const nameOf = (fd) => typeof fd.prestat_name === 'string' ? fd.prestat_name : new TextDecoder().decode(fd.prestat_name);

export function makeShimFs(wasi) {
  if (!Array.isArray(wasi?.fds)) throw new Error('wasmhost: not a WASI instance of @bjorn3/browser_wasi_shim (no fds)');
  // the preopens, by guest path: [[guest, PreopenDirectory]], read at each call (fds change)
  const preopens = () => wasi.fds.flatMap((fd) => fd?.prestat_name !== undefined ? [[posix.normalize(nameOf(fd)), fd]] : []);

  // a guest path -> [the preopen containing it (the longest), the path relative to it]
  function locate(guest) {
    const g = posix.normalize(guest);
    let best = null;
    for (const [gp, fd] of preopens())
      if ((g === gp || g.startsWith(gp === '/' ? gp : gp + '/')) && (!best || gp.length > best[0].length)) best = [gp, fd];
    if (!best) throw fsError('EACCES', `wasmhost: ${guest} is outside the preopens`);
    return [best[1], g.slice(best[0].length).replace(/^\//, '')];
  }
  // the shim's inode of a guest path (a File has `data`, a Directory `contents`), or undefined
  function inode(guest) {
    const [pre, rel] = locate(guest);
    let n = pre.dir;
    for (const s of rel.split('/').filter(Boolean)) { n = n?.contents?.get(s); if (n === undefined) return undefined; }
    return n;
  }

  return {
    // the guest path of a preopen's fd, or undefined
    preopenOf(fd) { const o = wasi.fds[fd]; return o?.prestat_name !== undefined ? posix.normalize(nameOf(o)) : undefined; },
    exists: (guest) => inode(guest) !== undefined,
    // 'file', 'dir' or undefined (no such path)
    kind(guest) {
      const n = inode(guest);
      return n === undefined ? undefined : n.contents instanceof Map ? 'dir' : 'file';
    },
    // a file's bytes (the shim's own array: copy before keeping them)
    read(guest) {
      const n = inode(guest);
      if (n === undefined) throw fsError('ENOENT', `wasmhost: no file ${guest}`);
      if (!(n.data instanceof Uint8Array)) throw fsError('EISDIR', `wasmhost: ${guest} is not a file`);
      return n.data;
    },
    // create or replace the content of a file (the same inode if it exists)
    write(guest, bytes) {
      const [pre, rel] = locate(guest);
      const { ret, fd_obj } = pre.path_open(0, rel, OFLAGS_CREAT | OFLAGS_TRUNC, 0n, 0n, 0);
      if (ret !== 0 || !fd_obj?.file) throw fsError(ret === 44 ? 'ENOENT' : 'EIO', `wasmhost: can't create ${guest} (errno ${ret})`);
      fd_obj.file.data = bytes;
    },
    remove(guest) { const [pre, rel] = locate(guest); pre.path_unlink_file(rel); },
    mkdirp(guest) {
      const [pre, rel] = locate(guest);
      let p = '';
      for (const s of rel.split('/').filter(Boolean)) {
        p = p ? p + '/' + s : s;
        const ret = pre.path_create_directory(p);
        if (ret !== 0 && ret !== ERRNO_EXIST) throw fsError('EIO', `wasmhost: can't create the directory ${guest} (errno ${ret})`);
      }
    },
    // the names in a directory
    list(guest) { const n = inode(guest); return n?.contents ? [...n.contents.keys()] : []; },
  };
}
