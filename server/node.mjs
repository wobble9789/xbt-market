// The XBT Market service in Node, for development and the tests:
//   node server/node.mjs [port]   (env vars as in service.js)
// Data is kept in memory, or in a JSON file with STORE_FILE=path.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { handle } from './service.js';

const port = Number(process.argv[2] || process.env.PORT || 8787);
const file = process.env.STORE_FILE;
const data = new Map(file && existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : []);
const save = () => { if (file) writeFileSync(file, JSON.stringify(Object.fromEntries(data))); };
export const store = {
  get: async (k) => data.get(k),
  put: async (k, v) => { data.set(k, v); save(); },
  delete: async (k) => { data.delete(k); save(); },
  list: async ({ prefix = '', limit = 1000 } = {}) => new Map([...data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit)),
};

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const host = req.headers.host || `127.0.0.1:${port}`;
  const request = new Request(`http://${host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const out = await handle(request, process.env, store);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`XBT Market service on http://${process.env.HOST || '127.0.0.1'}:${port}`));
