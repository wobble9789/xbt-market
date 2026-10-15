// A local Blossom photo server for tests and the demo (BUD-01/02 upload and
// fetch, kept in memory). Accepts any signed upload; no real storage.
//   node dev/blossom-mock.mjs [port] [host]   (default 3008 on 127.0.0.1)
import http from 'node:http';
import { createHash } from 'node:crypto';

const port = Number(process.argv[2] || 3008);
const blobs = new Map(); // sha256 -> { type, body }
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, PUT, HEAD, OPTIONS' };

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'PUT' && req.url === '/upload') {
    if (!/^Nostr /.test(req.headers.authorization || '')) { res.writeHead(401, { ...cors, 'x-reason': 'missing auth' }); return res.end(); }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const sha = createHash('sha256').update(body).digest('hex');
      const type = req.headers['content-type'] || 'application/octet-stream';
      blobs.set(sha, { type, body });
      const ext = type.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: `http://${req.headers.host}/${sha}.${ext}`, sha256: sha, size: body.length, type, uploaded: Math.floor(Date.now() / 1000) }));
    });
    return;
  }
  const hit = blobs.get((req.url.match(/^\/([0-9a-f]{64})/) || [])[1]);
  if ((req.method === 'GET' || req.method === 'HEAD') && hit) {
    res.writeHead(200, { ...cors, 'content-type': hit.type, 'content-length': hit.body.length });
    return res.end(req.method === 'GET' ? hit.body : undefined);
  }
  res.writeHead(404, cors);
  res.end();
}).listen(port, process.argv[3] || '127.0.0.1', () => console.log(`Blossom mock on http://${process.argv[3] || '127.0.0.1'}:${port}`));
