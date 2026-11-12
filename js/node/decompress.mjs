// WasmHost's decompression on Node: one request of protocol "wasm-decompress 1" done with
// node:zlib. gzip and deflate (zlib format) on every supported Node; zstd where node:zlib has
// it.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { ERRNO, chooseFormat } from '../common/decompress.mjs';

export const hasZstd = typeof zlib.createZstdDecompress === 'function';

// the WASI errno of a Node error
export function errnoOf(err) {
  if (err?.code === 'ENOENT') return ERRNO.ENOENT;
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return ERRNO.EACCES;
  return ERRNO.EIO;
}

function stage(format) {
  if (format === 'gzip') return zlib.createGunzip();
  if (format === 'deflate') return zlib.createInflate();
  return zlib.createZstdDecompress();
}

// Decompress the host file `srcHost` into `dstHost`: [errno, message], [0, ''] when done. On
// failure `dstHost` doesn't exist.
export async function decompressFile(srcHost, dstHost, format = 'auto') {
  let head;
  try {
    const fd = fs.openSync(srcHost, 'r');
    try {
      head = Buffer.alloc(6);
      head = head.subarray(0, fs.readSync(fd, head, 0, 6, 0));
    } finally { fs.closeSync(fd); }
  } catch (err) {
    return [errnoOf(err), String(err?.message ?? err)];
  }
  const c = chooseFormat(format, head);
  if (c.errno !== undefined) return [c.errno, c.message];
  if (c.format === 'zstd' && !hasZstd) return [ERRNO.ENOSYS, `zstd: this Node (${process.version}) has no zlib.createZstdDecompress`];
  try {
    await pipeline(fs.createReadStream(srcHost), stage(c.format), fs.createWriteStream(dstHost));
    return [0, ''];
  } catch (err) {
    fs.rmSync(dstHost, { force: true });
    return [errnoOf(err), `${c.format}: ${String(err?.message ?? err)}`];
  }
}
