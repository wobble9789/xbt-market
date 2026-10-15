// The Lightning wallet link against the mock wallet: the seller's wallet makes
// an invoice, the buyer's wallet pays it, the preimage proves it.
// Needs `npm run relay` and `npm run wallets` running.
import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { parseNwcUri, nwc } from '../src/lib/ln/nwc.js';
import { decodeInvoice, preimageMatches } from '../src/lib/ln/bolt11.js';

const relay = process.env.RELAY || 'ws://127.0.0.1:7777';
const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => sha256(new TextEncoder().encode(`xbt-mock-wallet/${n}`));
const uri = (n) => `nostr+walletconnect://${getPublicKey(key(n))}?relay=${encodeURIComponent(relay)}&secret=${hex(key(`${n}/client`))}`;
const [buyer, seller] = ['buyer', 'seller'].map((n) => parseNwcUri(uri(n)));
const pool = new SimplePool();
const check = (ok, what) => { if (!ok) { console.error('FAIL', what); process.exit(1); } console.log('ok', what); };

const before = (await nwc.balance(pool, buyer)).balance;
const inv = await nwc.makeInvoice(pool, seller, 1234, 'test order');
const d = decodeInvoice(inv.invoice);
check(d.amountSats === 1234, 'seller wallet makes an invoice for the exact amount');
const paid = await nwc.payInvoice(pool, buyer, inv.invoice);
check(preimageMatches(paid.preimage, d.paymentHash), 'buyer wallet pays and returns a valid preimage');
check(!!(await nwc.lookupInvoice(pool, seller, d.paymentHash)).settled_at, 'seller wallet sees the invoice settled');
check((await nwc.balance(pool, buyer)).balance === before - 1_234_000, 'buyer balance went down');
await nwc.payInvoice(pool, buyer, inv.invoice).then(() => check(false, 'paying twice is refused'), () => check(true, 'paying twice is refused'));
process.exit(0);
