// Esplora-shaped HTTP API over a Bitcoin Knots node's RPC, for regtest
// development. Serves exactly what the app uses.
//   node dev/esplora-shim.mjs --port 3006 --rpc http://u:p@127.0.0.1:18443
import http from 'node:http';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port', 3006));
const rpcUrl = new URL(arg('rpc', 'http://u:p@127.0.0.1:18443'));
const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(rpcUrl.username)}:${decodeURIComponent(rpcUrl.password)}`).toString('base64');
rpcUrl.username = ''; rpcUrl.password = '';

async function rpc(method, params = []) {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
  return j.result;
}

const sats = (btc) => Math.round(btc * 1e8);

async function utxos(address) {
  const tip = await rpc('getblockcount');
  const scan = await rpc('scantxoutset', ['start', [`addr(${address})`]]);
  const confirmed = scan.unspents.map((u) => ({ txid: u.txid, vout: u.vout, value: sats(u.amount), status: { confirmed: true, block_height: u.height } }));
  // add mempool outputs to this address that are not spent in the mempool
  const mem = await rpc('getrawmempool');
  const unconfirmed = [];
  for (const txid of mem) {
    const tx = await rpc('getrawtransaction', [txid, true]);
    tx.vout.forEach((o) => { if (o.scriptPubKey.address === address) unconfirmed.push({ txid, vout: o.n, value: sats(o.value), status: { confirmed: false } }); });
  }
  const spentInMempool = new Set();
  for (const txid of mem) (await rpc('getrawtransaction', [txid, true])).vin.forEach((i) => spentInMempool.add(i.txid + ':' + i.vout));
  void tip;
  return [...confirmed, ...unconfirmed].filter((u) => !spentInMempool.has(u.txid + ':' + u.vout));
}

const routes = [
  ['GET', /^\/api\/blocks\/tip\/height$/, async () => String(await rpc('getblockcount'))],
  ['GET', /^\/api\/address\/([^/]+)\/utxo$/, (m) => utxos(m[1])],
  ['GET', /^\/api\/tx\/([0-9a-f]{64})$/, async (m) => {
    const t = await rpc('getrawtransaction', [m[1], true]);
    const height = t.blockhash ? (await rpc('getblockheader', [t.blockhash])).height : undefined;
    return {
      txid: t.txid,
      vout: t.vout.map((o) => ({ scriptpubkey_address: o.scriptPubKey.address, value: sats(o.value) })),
      status: { confirmed: !!t.blockhash, ...(height != null ? { block_height: height, block_hash: t.blockhash } : {}) },
    };
  }],
  ['GET', /^\/api\/tx\/([0-9a-f]{64})\/status$/, async (m) => { const t = await rpc('getrawtransaction', [m[1], true]); return { confirmed: !!t.blockhash }; }],
  ['GET', /^\/api\/v1\/fees\/recommended$/, async () => ({ fastestFee: 2, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 })],
  ['POST', /^\/api\/tx$/, async (m, body) => rpc('sendrawtransaction', [body.trim()])],
];

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', '*'); res.end(); return; }
  let body = '';
  for await (const c of req) body += c;
  const path = new URL(req.url, 'http://x').pathname;
  for (const [method, re, fn] of routes) {
    const m = req.method === method && path.match(re);
    if (!m) continue;
    try {
      const out = await fn(m, body);
      res.setHeader('Content-Type', typeof out === 'string' ? 'text/plain' : 'application/json');
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    } catch (e) {
      res.statusCode = e.code === -5 ? 404 : 400;
      res.end(e.message);
    }
    return;
  }
  res.statusCode = 404;
  res.end('not found');
}).listen(port, '127.0.0.1', () => console.log(`esplora shim on http://127.0.0.1:${port}/api -> ${rpcUrl.href}`));
