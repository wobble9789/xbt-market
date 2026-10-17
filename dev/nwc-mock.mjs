// A pretend Lightning wallet for local testing, reachable over Nostr Wallet
// Connect (NIP-47) through the dev relay. It runs a few wallets that share one
// ledger, so an invoice made by "seller" can be paid by "buyer". No real money.
//   node dev/nwc-mock.mjs [relay] [network]   (default ws://127.0.0.1:7777, "bcrt")
// Prints a connection string per wallet; paste it under Account → Lightning wallet.

import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { fakeInvoice } from './fake-invoice.mjs';
import http from 'node:http';

const relay = process.argv[2] || 'ws://127.0.0.1:7777';
const network = process.argv[3] || 'bcrt';
// Reconnect and ping so a dropped socket never silently ends the wallets,
// and keep the process alive even while no socket is open.
const pool = new SimplePool({ enableReconnect: true, enablePing: true });
setInterval(() => {}, 60_000);
process.on('unhandledRejection', (e) => console.error('[wallets] unhandled', e?.message || e));
process.on('uncaughtException', (e) => console.error('[wallets] error', e?.message || e));
// Wait for the relay, which may still be starting (CI starts both at once).
for (let i = 0; ; i++) {
  try { await pool.ensureRelay(relay); break; } catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 500)); }
}
const hex = (b) => Buffer.from(b).toString('hex');
const keyFor = (name) => sha256(new TextEncoder().encode(`xbt-mock-wallet/${name}`));

const invoices = new Map(); // paymentHash -> { invoice, preimage, msat, owner, settledAt }
const wallets = ['buyer', 'seller', 'arbiter', 'platform'].map((name) => {
  const sk = keyFor(name);
  const clientSk = keyFor(`${name}/client`);
  return { name, sk, pk: getPublicKey(sk), clientPk: getPublicKey(clientSk), balance: 10_000_000_000, uri: `nostr+walletconnect://${getPublicKey(sk)}?relay=${encodeURIComponent(relay)}&secret=${hex(clientSk)}` };
});

const now = () => Math.floor(Date.now() / 1000);

function handle(w, { method, params = {} }) {
  switch (method) {
    case 'get_info': return { alias: `mock-${w.name}`, network, methods: ['get_info', 'get_balance', 'make_invoice', 'pay_invoice', 'lookup_invoice'] };
    case 'get_balance': return { balance: w.balance };
    case 'make_invoice': {
      const preimage = randomBytes(32);
      const inv = fakeInvoice({ sats: Math.round(params.amount / 1000), network, preimage, description: params.description || '', expiry: params.expiry || 3600 });
      invoices.set(inv.paymentHash, { ...inv, msat: params.amount, owner: w.name, createdAt: now() });
      return { type: 'incoming', invoice: inv.invoice, payment_hash: inv.paymentHash, amount: params.amount, created_at: now() };
    }
    case 'pay_invoice': {
      const hit = [...invoices.values()].find((i) => i.invoice === String(params.invoice).toLowerCase());
      if (!hit) throw Object.assign(new Error('Unknown invoice (the mock only pays invoices made by its own wallets)'), { code: 'NOT_FOUND' });
      if (hit.settledAt) throw Object.assign(new Error('Invoice already paid'), { code: 'OTHER' });
      if (w.balance < hit.msat) throw Object.assign(new Error('Not enough balance'), { code: 'INSUFFICIENT_BALANCE' });
      w.balance -= hit.msat;
      wallets.find((x) => x.name === hit.owner).balance += hit.msat;
      hit.settledAt = now();
      console.log(`  ${w.name} paid ${hit.msat / 1000} sats to ${hit.owner}`);
      return { preimage: hit.preimage, fees_paid: 0 };
    }
    case 'lookup_invoice': {
      const hit = invoices.get(params.payment_hash);
      if (!hit) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
      return { type: 'incoming', invoice: hit.invoice, payment_hash: hit.paymentHash, amount: hit.msat, settled_at: hit.settledAt || undefined, preimage: hit.settledAt ? hit.preimage : undefined };
    }
    default: throw Object.assign(new Error(`Method ${method} not supported`), { code: 'NOT_IMPLEMENTED' });
  }
}

for (const w of wallets) {
  await Promise.allSettled(pool.publish([relay], finalizeEvent({ kind: 13194, created_at: now(), tags: [['encryption', 'nip44_v2 nip04']], content: 'get_info get_balance make_invoice pay_invoice lookup_invoice' }, w.sk)));
  pool.subscribe([relay], { kinds: [23194], '#p': [w.pk], since: now() - 5 }, {
    async onevent(ev) {
      const nip44mode = ev.tags.some((t) => t[0] === 'encryption' && t[1] === 'nip44_v2');
      const ck = nip44.getConversationKey(w.sk, ev.pubkey);
      const dec = (c) => (nip44mode ? nip44.decrypt(c, ck) : nip04.decrypt(w.sk, ev.pubkey, c));
      const enc = (t) => (nip44mode ? nip44.encrypt(t, ck) : nip04.encrypt(w.sk, ev.pubkey, t));
      let req = {};
      let body;
      try {
        req = JSON.parse(dec(ev.content));
        body = { result_type: req.method, result: handle(w, req) };
      } catch (e) {
        body = { result_type: req.method, error: { code: e.code || 'OTHER', message: e.message } };
      }
      const tags = [['e', ev.id], ['p', ev.pubkey], ...(nip44mode ? [['encryption', 'nip44_v2']] : [])];
      await Promise.allSettled(pool.publish([relay], finalizeEvent({ kind: 23195, created_at: now(), tags, content: enc(JSON.stringify(body)) }, w.sk)));
    },
  });
}

// The platform's Lightning address (LUD-16) with LUD-21 "verify", which the
// XBT Market service uses to charge for shipping labels:
//   platform@127.0.0.1:3010
const lnPort = Number(process.env.LNURL_PORT || 3010);
http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const out = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };
  const base = `http://${req.headers.host}`;
  if (url.pathname === '/.well-known/lnurlp/platform') return out({ tag: 'payRequest', callback: `${base}/lnurl/platform`, minSendable: 1000, maxSendable: 1e14, metadata: '[["text/plain","XBT Market labels"]]' });
  if (url.pathname === '/lnurl/platform') {
    const r = handle(wallets.find((w) => w.name === 'platform'), { method: 'make_invoice', params: { amount: Number(url.searchParams.get('amount')), description: 'XBT Market shipping label' } });
    return out({ pr: r.invoice, routes: [], verify: `${base}/verify/${r.payment_hash}` });
  }
  const m = url.pathname.match(/^\/verify\/([0-9a-f]{64})$/);
  if (m) { const i = invoices.get(m[1]); return i ? out({ status: 'OK', settled: !!i.settledAt, preimage: i.settledAt ? i.preimage : null, pr: i.invoice }) : out({ status: 'ERROR', reason: 'Not found' }, 404); }
  out({ status: 'ERROR', reason: 'Not found' }, 404);
}).listen(lnPort, '127.0.0.1');

console.log(`Mock NWC wallets on ${relay} (Lightning network prefix "ln${network}"):`);
for (const w of wallets) console.log(`\n  ${w.name}:\n  ${w.uri}`);
console.log('\nEach wallet starts with 10,000,000 sats of pretend money.');
