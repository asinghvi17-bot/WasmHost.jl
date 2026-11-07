// WasmHost's decompression in a browser: one request of protocol "wasm-decompress 1" done with
// `DecompressionStream`, on files of the module's in-memory filesystem (`fs.mjs`). gzip and
// deflate (the zlib format) everywhere; zstd only where the browser's DecompressionStream has
// it, else ENOSYS.
import { ERRNO, chooseFormat } from '../common/decompress.mjs';

// whether this browser's DecompressionStream knows `format` ('gzip', 'deflate', 'zstd', ...)
export function hasFormat(format) {
  try { new DecompressionStream(format); return true; } catch { return false; }
}

// the WASI errno of an error of fs.mjs or of a stream
export function errnoOf(err) {
  if (err?.code === 'ENOENT') return ERRNO.ENOENT;
  if (err?.code === 'EACCES') return ERRNO.EACCES;
  return ERRNO.EIO;
}

// Decompress the guest file `src` into `dst`: [errno, message], [0, ''] when done. On failure
// `dst` doesn't exist.
export async function decompressFile(fs, src, dst, format = 'auto') {
  let data;
  try { data = fs.read(src); } catch (err) { return [errnoOf(err), String(err?.message ?? err)]; }
  const c = chooseFormat(format, data.subarray(0, 6));
  if (c.errno !== undefined) return [c.errno, c.message];
  if (!hasFormat(c.format)) return [ERRNO.ENOSYS, `${c.format}: this browser's DecompressionStream doesn't have it`];
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(c.format));
    fs.write(dst, new Uint8Array(await new Response(stream).arrayBuffer()));
    return [0, ''];
  } catch (err) {
    try { if (fs.exists(dst)) fs.remove(dst); } catch { /* (outside the preopens: never written) */ }
    return [errnoOf(err), `${c.format}: ${String(err?.message ?? err)}`];
  }
}
