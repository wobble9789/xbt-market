// Try the app without real money:
//   npm run demo               on this computer only (http://localhost:5173)
//   npm run demo -- --phone    also from phones on the same Wi-Fi
//
// Starts a local Nostr relay, three pretend Lightning wallets (NWC), a photo
// server and the app, all pointed at each other. If Bitcoin Knots (bitcoind)
// is on the PATH, or KNOTS_DIR points at its bin folder, it also starts a
// regtest node so escrow and on-chain payments work too.
//
// A helper page (port 3009) shows a QR code to open the app, the wallet
// connection strings to copy, and buttons to send pretend XBT to an address
// and to mine a block. Open it on the phone as well.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { getPublicKey } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import qrcode from 'qrcode-generator';

const PHONE = process.argv.includes('--phone');
const lanIp = () => Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const HOST = PHONE ? (process.env.DEMO_HOST || lanIp()) : '127.0.0.1';
if (!HOST) { console.error('No network address found. Set DEMO_HOST=<this computer\'s IP>.'); process.exit(1); }
const BIND = PHONE ? '0.0.0.0' : '127.0.0.1';
const APP = `http://${PHONE ? HOST : 'localhost'}:5173/`;
const HELPER = `http://${PHONE ? HOST : 'localhost'}:3009/`;
const RELAY = `ws://${HOST}:7777`;

const procs = [];
function run(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map((l) => `[${name}] ${l}\n`).join('')));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  return p;
}
const stop = () => { for (const p of procs) p.kill(); if (cli) try { cli('stop'); } catch { /* already down */ } process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- optional regtest node --------------------------------------------------------
const knotsBin = (name) => {
  if (process.env.KNOTS_DIR && existsSync(join(process.env.KNOTS_DIR, name))) return join(process.env.KNOTS_DIR, name);
  try { execFileSync('which', [name], { stdio: 'ignore' }); return name; } catch { return null; }
};
let cli = null;
const bitcoind = knotsBin('bitcoind');
if (bitcoind) {
  const datadir = mkdtempSync(join(tmpdir(), 'xbt-demo-'));
  // Own ports, so a regtest node you already run is left alone.
  const ports = ['-port=18544', '-rpcport=18543'];
  execFileSync(bitcoind, ['-regtest', `-datadir=${datadir}`, ...ports, '-testactivationheight=blake2b@1', '-rpcuser=u', '-rpcpassword=p', '-fallbackfee=0.0001', '-txindex=1', '-daemon']);
  const rpc = (...a) => execFileSync(knotsBin('bitcoin-cli'), ['-regtest', `-datadir=${datadir}`, '-rpcport=18543', '-rpcuser=u', '-rpcpassword=p', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (let i = 0; i < 30; i++) { try { rpc('getblockcount'); break; } catch { await sleep(1000); } }
  rpc('createwallet', 'demo');
  cli = (...a) => (a[0] === 'stop' || a[0] === 'getblockcount' ? rpc(...a) : rpc('-rpcwallet=demo', ...a));
  cli('generatetoaddress', '101', cli('getnewaddress'));
  run('node', process.execPath, ['dev/esplora-shim.mjs', '--port', '3006', '--rpc', 'http://u:p@127.0.0.1:18543', '--host', BIND]);
}

// ---- relay, wallets, photos, app ----------------------------------------------------
run('relay', process.execPath, ['dev/relay.mjs', '7777']);
await sleep(800);
run('wallets', process.execPath, ['dev/nwc-mock.mjs', RELAY, 'bcrt']);
run('photos', process.execPath, ['dev/blossom-mock.mjs', '3008', BIND]);
run('app', process.execPath, ['scripts/build-bookmarklet.mjs']).on('exit', () => {
  run('app', process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5173', '--strictPort', '--host', BIND], {
    CSP_CONNECT_EXTRA: PHONE ? `http://${HOST}:* ws://${HOST}:*` : '',
    VITE_RELAYS: RELAY, VITE_NETWORK: 'regtest', VITE_BLOSSOM: `http://${HOST}:3008`, VITE_REGTEST_ESPLORA: `http://${HOST}:3006/api`,
  });
});

// ---- helper page --------------------------------------------------------------------
const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => sha256(new TextEncoder().encode(`xbt-mock-wallet/${n}`));
const walletUri = (n) => `nostr+walletconnect://${getPublicKey(key(n))}?relay=${encodeURIComponent(RELAY)}&secret=${hex(key(`${n}/client`))}`;
const qrSvg = (text) => { const q = qrcode(0, 'L'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(msg = '') {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XBT demo helper</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1b1c1e}main{max-width:640px;margin:0 auto;padding:16px}
.card{background:#fff;border:1px solid #e3e3df;border-radius:12px;padding:14px;margin:0 0 14px}h1{font-size:22px}h2{font-size:17px;margin:0 0 8px}
textarea,input{width:100%;box-sizing:border-box;font:13px monospace;padding:8px;border:1px solid #ccc;border-radius:8px}button{font:inherit;padding:10px 14px;border:0;border-radius:8px;background:#c9a227;color:#1b1500;margin-top:8px}
.qr{max-width:220px}.ok{background:#e6f5ec;padding:8px;border-radius:8px}.muted{color:#6b6f76;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#111214;color:#ececec}.card{background:#1b1c1f;border-color:#2c2e33}textarea,input{background:#111214;color:#ececec;border-color:#2c2e33}.ok{background:#12301f}}</style></head><body><main>
<h1>XBT Market demo (nepgeld)</h1>${msg ? `<p class="ok">${esc(msg)}</p>` : ''}
<div class="card"><h2>1. Open de app</h2><div class="qr">${qrSvg(APP)}</div><p><a href="${APP}">${APP}</a></p>
<p class="muted">Maak in de app een account. Gebruik een tweede apparaat of een privévenster voor de andere partij.</p></div>
<div class="card"><h2>2. Koppel een nep-Lightning-wallet</h2><p class="muted">Account → Lightning-wallet → plak de code. Elke wallet heeft 10.000.000 sats nepgeld.</p>
${['seller', 'buyer', 'arbiter'].map((w) => `<p><b>${{ seller: 'Verkoper', buyer: 'Koper', arbiter: 'Derde wallet' }[w]}</b></p><textarea rows="3" readonly onclick="this.select()">${esc(walletUri(w))}</textarea>`).join('')}</div>
${cli ? `<div class="card"><h2>3. Nep-XBT sturen (escrow en on-chain)</h2><p class="muted">Plak het escrow- of betaaladres uit de app en het bedrag. Daarna een paar blokken minen voor bevestigingen.</p>
<form method="post" action="/send"><input name="address" placeholder="bcrt1q…" required><input name="amount" placeholder="0.0002" required><button>Stuur nep-XBT</button></form>
<form method="post" action="/mine"><button>Mine 3 blokken</button></form>
<p class="muted">Escrow heeft een arbiter nodig: laat een derde account zich onder Arbiter aanmelden en voeg diens npub bij koper én verkoper toe onder Account → Vertrouwde arbiters. Zet Account → Minimaal aantal bevestigingen op 1 om sneller te testen.</p></div>` : `<div class="card"><h2>3. Escrow en on-chain</h2><p class="muted">Niet beschikbaar: start de demo met Bitcoin Knots (bitcoind) op het PATH of KNOTS_DIR=… om ook escrow te proberen.</p></div>`}
</main></body></html>`;
}

http.createServer((req, res) => {
  const reply = (msg) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(msg)); };
  if (req.method !== 'POST') return reply();
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const f = new URLSearchParams(body);
    try {
      if (!cli) return reply('Geen regtest-node actief.');
      if (req.url === '/send') {
        const amount = Number(String(f.get('amount')).replace(',', '.'));
        if (!(amount > 0 && amount < 10)) return reply('Ongeldig bedrag.');
        const txid = cli('sendtoaddress', String(f.get('address')).trim(), amount.toFixed(8));
        return reply(`Verstuurd: ${amount} XBT, txid ${txid.slice(0, 16)}… Mine nu een paar blokken.`);
      }
      if (req.url === '/mine') { cli('generatetoaddress', '3', cli('getnewaddress')); return reply(`3 blokken gemined (hoogte ${cli('getblockcount')}).`); }
      reply();
    } catch (e) { reply('Fout: ' + e.message.split('\n')[0]); }
  });
}).listen(3009, BIND);

await sleep(4000);
const q = qrcode(0, 'L');
q.addData(HELPER);
q.make();
console.log(`
==========================================================================
 XBT Market demo, no real money.  Ctrl+C stops everything.

 App:          ${APP}
 Helper page:  ${HELPER}   (wallet codes${cli ? ', send pretend XBT, mine blocks' : ''})
 ${PHONE ? 'Scan this with your phone (same Wi-Fi) to open the helper page:' : 'Add --phone to use it from a phone on the same Wi-Fi.'}
${PHONE ? q.createASCII(1, 2) : ''}
 Escrow and on-chain: ${cli ? 'ON (regtest node running)' : 'off (put Bitcoin Knots on the PATH or set KNOTS_DIR)'}
==========================================================================
`);
