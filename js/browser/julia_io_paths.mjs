// The file modes and symbolic links of WasmCodegen's `julia_io` imports (`path_mode`, `path_chmod`,
// `path_symlink`; its js/julia_io.mjs `makeJuliaIOPaths` is Node's) on the in-memory filesystem of
// @bjorn3/browser_wasi_shim, for a module built with `host_extensions = [:julia_io]` (as one with Julia tasks is)
// that runs in a browser. The shim has no permission bits and no symbolic links: a file is 0o100644, a directory
// 0o040755. chmod and symlink return ENOSYS: julia_io's errno of a host without modes (WasmCodegen's
// `FS.NO_MODES`), positive as every status return of julia_io is (only `path_mode`'s is negated). The module then
// does what it does without them: an explicit chmod fails with ENOTSUP, the mode asked of a mkdir or open is the
// host's (not an error), and symlink falls back to WASI's `path_symlink`. (Another errno would be the operation's
// error: a `mkdir(dir; mode = 0o700)`, as `mktempdir` makes, would fail.) The module's other `julia_io` imports
// are WasmCodegen's events (`makeJuliaIOEvents`, which run in browsers).
//
//   const paths = makeShimJuliaIOPaths(wasi);
//   ... { julia_io: { ...paths.imports, ...events.imports } } ...
//   paths.bindMemory(inst.exports.memory);
import { makeShimFs } from './fs.mjs';

const ENOENT = 44, EINVAL = 28, ENOSYS = 52, EIO = 29;

export function makeShimJuliaIOPaths(wasi) {
  const fs = makeShimFs(wasi);
  let memory = null;
  let lastError = '';
  const readPath = (off, len) => new TextDecoder().decode(new Uint8Array((memory ?? wasi.inst?.exports.memory).buffer, off >>> 0, len >>> 0));
  // the st_mode of the absolute path, or -errno
  function path_mode(off, len) {
    try {
      const p = readPath(off, len);
      if (!p.startsWith('/') || p.includes('\0')) { lastError = `path_mode: not an absolute path: ${p}`; return -EINVAL; }
      const k = fs.kind(p);
      if (k === undefined) { lastError = `path_mode: no such file or directory: ${p}`; return -ENOENT; }
      return k === 'dir' ? 0o040755 : 0o100644;
    } catch (err) {
      lastError = String(err?.message ?? err);
      return err?.code === 'EACCES' ? -76 : -EIO;   // (outside the preopens: ENOTCAPABLE)
    }
  }
  // (a status: a positive errno)
  const unsupported = (what) => () => { lastError = `${what}: the browser's filesystem has none`; return ENOSYS; };
  return {
    imports: { path_mode, path_chmod: unsupported('path_chmod'), path_symlink: unsupported('path_symlink') },
    bindMemory(m) { memory = m; },
    lastError: () => lastError,
  };
}
