// node test/e2e/browser/decompress.mjs
// The browser adapter's decompression (js/browser/decompress.mjs, DecompressionStream) in headless Chromium, on the
// shim's filesystem: gzip, deflate (zlib) and zstd data made by node:zlib must decompress to the original bytes
// (zstd: or ENOSYS where the browser has no zstd), and the error cases must answer the errnos of
// WasmHost.Decompress, with no destination file. (The Julia side, dprog.jl, needs WasmCodegen's julia_regex, which
// this e2e doesn't have: this checks the adapter alone.) Prints DECOMPRESS PASS or DECOMPRESS FAIL.
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { serveStatic, openPage } from './harness.mjs';

// deterministic 1 MiB, half compressible
const data = Buffer.alloc(1 << 20);
for (let i = 0, h = crypto.createHash('sha256').update('wasmhost').digest(); i < data.length; i += 64) {
  h = crypto.createHash('sha256').update(h).digest(); h.copy(data, i); data.fill(i & 0xff, i + 32, i + 64);
}
const sha = crypto.createHash('sha256').update(data).digest('hex');
const gz = zlib.gzipSync(data);
const zstd = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync(data) : null;
const b64 = (b) => b === null ? null : Buffer.from(b).toString('base64');

// [name, input, format, the errno wanted (zstd: 0 or 52 by the browser), output = the original]
const cases = [
  ['gzip', gz, 'auto', 0, true],
  ['gzip-explicit', gz, 'gzip', 0, true],
  ['deflate', zlib.deflateSync(data), 'deflate', 0, true],
  ...(zstd ? [['zstd', zstd, 'auto', 'zstd', true]] : []),
  ['wrong-format', gz, 'zstd', 25, false],
  ['not-compressed', data, 'auto', 25, false],
  ['bzip2', Buffer.from('BZh91AY&SY'), 'auto', 52, false],
  ['corrupt', gz.subarray(0, gz.length >> 1), 'gzip', 29, false],
  ['missing', null, 'auto', 44, false],
];

const stat = await serveStatic();
let browser = null, ok = true;
try {
  let page;
  ({ browser, page } = await openPage(stat.origin));
  const r = await page.evaluate((cs) => window.checkDecompress(cs), cases.map(([name, input, format]) => ({ name, data: b64(input), format })));
  console.log(`zstd in this browser's DecompressionStream: ${r.zstd}${zstd ? '' : ' (this Node has no zstd: not checked)'}`);
  for (const [i, [name, , , want, same]] of cases.entries()) {
    const got = r.results[i];
    const errno = want === 'zstd' ? (r.zstd ? 0 : 52) : want;
    const good = got.errno === errno && (errno === 0 ? same && got.sha256 === sha : !got.dstExists);
    ok &&= good;
    console.log(`${good ? 'ok  ' : 'FAIL'} ${name}: errno ${got.errno} (want ${errno})${got.dstExists ? `, sha256 ${got.sha256 === sha ? 'equal to the original' : got.sha256}` : ', no dst'}${got.message ? ` [${got.message}]` : ''}`);
  }
} finally {
  await browser?.close();
  stat.server.close();
}
console.log(ok ? 'DECOMPRESS PASS' : 'DECOMPRESS FAIL');
process.exitCode = ok ? 0 : 1;
