// Local test server for the end-to-end check. Prints "listening <port>" when ready.
import http from 'node:http';
import crypto from 'node:crypto';
// deterministic 3 MiB binary body
const blob = Buffer.alloc(3 * 1024 * 1024 + 123);
{ let h = crypto.createHash('sha256').update('seed').digest(); let o = 0;
  while (o < blob.length) { h = crypto.createHash('sha256').update(h).digest(); h.copy(blob, o); o += h.length; } }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // (CORS, for the browser e2e's page, served from another origin: a preflight for X-Probe, the response's
  // x-served-by exposed. Native and Node runs never send OPTIONS, and print none of these headers.)
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-expose-headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' }); return res.end();
  }
  if (u.pathname === '/hello.txt') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Hello from fetch, κόσμε!\n'); }
  else if (u.pathname === '/blob.bin') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': blob.length }); res.end(req.method === 'HEAD' ? undefined : blob); }
  else if (u.pathname === '/redirect') { res.writeHead(302, { location: '/echo' }); res.end(); }
  else if (u.pathname === '/echo') { res.writeHead(200, { 'content-type': 'text/plain', 'x-served-by': 'proto' });
    res.end(`method=${req.method} x-probe=${req.headers['x-probe'] ?? ''} ua=${req.headers['user-agent'] ?? ''}\n`); }
  else if (u.pathname === '/echo-body') { const cs = []; req.on('data', (c) => cs.push(c));
    req.on('end', () => { const b = Buffer.concat(cs); res.writeHead(201, { 'content-type': 'text/plain' }); res.end(`${req.method} ${b.length} ${b.toString()}\n`); }); }
  else if (u.pathname === '/slow') { setTimeout(() => { res.writeHead(200); res.end('late\n'); }, 3000); }
  else { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not here\n'); }
});
server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => console.log('listening ' + server.address().port));
