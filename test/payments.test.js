// Direct trades (no escrow), Lightning invoices, NWC messages and shipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { getPublicKey, generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { reduceTrade, paymentProof, TRADE_KIND, CHAT_KIND } from '../src/lib/trade/protocol.js';
import { decodeInvoice, preimageMatches } from '../src/lib/ln/bolt11.js';
import { invoiceFromAddress, lnurlpUrl, isLightningAddress } from '../src/lib/ln/lnurl.js';
import { parseNwcUri, buildRequest, readResponse, pickEncryption, clientPubkey, NWC_RESPONSE } from '../src/lib/ln/nwc.js';
import { trackingUrl, parseShippingOptions, optionsFor } from '../src/lib/shipping.js';
import { listingTemplate, parseListing } from '../src/lib/nostr/listings.js';
import { DEFAULT_DEPOSIT_PCT, MIN_DEPOSIT_PCT, MAX_DEPOSIT_PCT, depositSats } from '../src/config.js';
import { bytesToHex } from '../src/lib/btc/bytes.js';
import { fakeInvoice } from '../dev/fake-invoice.mjs';

const makeInvoice = (o) => fakeInvoice({ timestamp: 1_700_000_000, ...o });

test('BOLT11: the spec example decodes', () => {
  const inv = decodeInvoice('lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp');
  assert.equal(inv.network, 'bc');
  assert.equal(inv.amountSats, 250_000);
  assert.equal(inv.paymentHash, '0001020304050607080900010203040506070809000102030405060708090102');
  assert.equal(inv.description, '1 cup coffee');
  assert.equal(inv.expiry, 60);
});

test('BOLT11: amounts, prefixes and preimages', () => {
  const { invoice, paymentHash, preimage } = makeInvoice({ sats: 12_345, network: 'xbt' });
  const inv = decodeInvoice('lightning:' + invoice.toUpperCase());
  assert.equal(inv.network, 'xbt');
  assert.equal(inv.amountSats, 12_345);
  assert.equal(inv.paymentHash, paymentHash);
  assert.ok(preimageMatches(preimage, paymentHash));
  assert.ok(!preimageMatches('00'.repeat(32), paymentHash));
  assert.equal(decodeInvoice(makeInvoice({ sats: null }).invoice).amountMsat, null);
  assert.throws(() => decodeInvoice('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'));
});

// ---- direct trades -------------------------------------------------------------

const sk = () => secp256k1.utils.randomSecretKey();
const people = { buyer: sk(), seller: sk(), mallory: sk() };
const pk = Object.fromEntries(Object.entries(people).map(([k, v]) => [k, getPublicKey(v)]));
const TID = 'tdirect0123456789abcdef0';
const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
let n = 0;
const msg = (who, type, body, at) => ({
  id: String(++n).padStart(64, 'd'), pubkey: pk[who], created_at: at ?? 1000 + n,
  kind: type === 'chat' ? CHAT_KIND : TRADE_KIND, tags: [['xbt-trade', TID], ['xbt-type', type]],
  content: type === 'chat' ? body : JSON.stringify(body),
});
const offer = (over = {}) => msg('buyer', 'offer', {
  v: 1, tradeId: TID, network: 'mainnet', payment: 'direct', method: 'lightning',
  listing: { coord: `30402:${pk.seller}:x`, sellerPubkey: pk.seller, title: 'Lamp', price: 20, currency: 'EUR' },
  priceSats: 50_000, shipping: { id: 'postnl', price: 5, currency: 'EUR' }, ...over,
});
const accept = () => msg('seller', 'accept', {});

test('direct Lightning trade: request, pay with preimage, ship, receive', () => {
  const inv = makeInvoice({ sats: 50_000 });
  const log = [offer(), accept(), msg('seller', 'request', { method: 'lightning', invoice: inv.invoice })];
  let s = reduceTrade(TID, log, { me: pk.seller });
  assert.equal(s.payment, 'direct');
  assert.equal(s.participants.arbiter, null);
  assert.equal(s.escrow, null);
  assert.equal(s.status, 'accepted');
  assert.equal(s.request.paymentHash, inv.paymentHash);
  assert.equal(s.role, 'seller');

  log.push(msg('buyer', 'paid', { requestId: s.request.id, preimage: inv.preimage }));
  s = reduceTrade(TID, log);
  assert.equal(s.status, 'paid');
  assert.ok(s.paid.verified);
  assert.equal(paymentProof(s), inv.paymentHash);

  log.push(msg('seller', 'shipped', { carrier: 'postnl', tracking: '3SABCD1234' }), msg('buyer', 'received', {}));
  s = reduceTrade(TID, log);
  assert.equal(s.status, 'completed');
  assert.deepEqual(s.errors, []);
});

test('direct trade: wrong amounts, wrong preimages and wrong roles are refused', () => {
  const good = makeInvoice({ sats: 50_000 });
  const s = reduceTrade(TID, [
    offer(), accept(),
    msg('seller', 'request', { method: 'lightning', invoice: makeInvoice({ sats: 60_000 }).invoice }), // overcharge
    msg('seller', 'request', { method: 'lightning', invoice: makeInvoice({ sats: null }).invoice }), // open amount
    msg('buyer', 'request', { method: 'lightning', invoice: good.invoice }), // buyer cannot request
    msg('mallory', 'request', { method: 'lightning', invoice: good.invoice }), // outsider ignored
    msg('seller', 'request', { method: 'lightning', invoice: good.invoice }),
    msg('buyer', 'paid', { preimage: '11'.repeat(32) }), // wrong preimage
    msg('seller', 'paid', { preimage: good.preimage }),
    msg('buyer', 'proposal', { id: 'p' }), // no escrow here
  ]);
  assert.equal(s.requests.length, 1);
  assert.equal(s.paid, null);
  assert.equal(s.status, 'accepted');
  assert.equal(s.errors.length, 6);
});

test('direct trade: the expected Lightning network can be pinned', () => {
  const s = reduceTrade(TID, [offer(), accept(), msg('seller', 'request', { method: 'lightning', invoice: makeInvoice({ sats: 50_000, network: 'bc' }).invoice })], { lightningNetwork: 'xbt' });
  assert.equal(s.request, null);
});

test('direct on-chain trade: address request, txid, seller confirmation', () => {
  const o = offer({ method: 'onchain' });
  const s = reduceTrade(TID, [
    o, accept(),
    msg('seller', 'request', { method: 'onchain', address: ADDR, amountSats: 49_000 }),
    msg('seller', 'request', { method: 'onchain', address: ADDR, amountSats: 50_000 }),
    msg('buyer', 'paid', { txid: 'ab'.repeat(32) }),
    msg('seller', 'confirm_paid', {}),
    msg('buyer', 'cancel', {}),
  ]);
  assert.equal(s.requests.length, 1);
  assert.equal(s.paid.txid, 'ab'.repeat(32));
  assert.ok(s.paymentConfirmed);
  assert.equal(s.cancelled, null);
  assert.equal(s.status, 'paid');
  assert.equal(paymentProof(s), 'ab'.repeat(32));
});

test('direct offers must not carry an arbiter or deposits', () => {
  assert.equal(reduceTrade(TID, [offer({ buyerDepositSats: 10 })]).offer, null);
  assert.equal(reduceTrade(TID, [offer({ method: 'paypal' })]).offer, null);
  assert.equal(reduceTrade(TID, [offer({ arbiter: { pubkey: pk.mallory, escrowBase: '02' + '11'.repeat(32) } })]).offer, null);
  assert.equal(reduceTrade(TID, [offer(), msg('buyer', 'cancel', {})]).status, 'cancelled');
});

// ---- Lightning address ----------------------------------------------------------

test('Lightning address: resolves to an invoice for the exact amount', async () => {
  assert.ok(isLightningAddress('Alice@example.com'));
  assert.ok(!isLightningAddress('npub1xyz'));
  assert.equal(lnurlpUrl('alice@example.com'), 'https://example.com/.well-known/lnurlp/alice');
  const inv = makeInvoice({ sats: 1_000 });
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    const body = url.includes('.well-known')
      ? { tag: 'payRequest', callback: 'https://example.com/cb', minSendable: 10_000, maxSendable: 1e9, commentAllowed: 20 }
      : { pr: url.includes('amount=1000000') ? inv.invoice : makeInvoice({ sats: 5 }).invoice };
    return { ok: true, json: async () => body };
  };
  const res = await invoiceFromAddress('alice@example.com', 1_000, 'XBT Market order', fake);
  assert.equal(res.decoded.paymentHash, inv.paymentHash);
  assert.match(calls[1], /comment=XBT\+Market\+order/);
  await assert.rejects(invoiceFromAddress('alice@example.com', 2, '', fake), /outside/);
});

// ---- Nostr Wallet Connect -------------------------------------------------------

test('NWC: parse a connection string and round-trip an encrypted request', () => {
  const walletSk = generateSecretKey();
  const walletPk = getPublicKey(walletSk);
  const secret = bytesToHex(generateSecretKey());
  const conn = parseNwcUri(`nostr+walletconnect://${walletPk}?relay=wss%3A%2F%2Frelay.example&secret=${secret}&lud16=me%40wallet.example`);
  assert.deepEqual(conn.relays, ['wss://relay.example']);
  assert.equal(conn.lud16, 'me@wallet.example');
  assert.throws(() => parseNwcUri('nostr+walletconnect://abc?relay=wss://x'));

  const enc = pickEncryption({ tags: [['encryption', 'nip44_v2 nip04']] });
  assert.equal(enc, 'nip44_v2');
  assert.equal(pickEncryption(null), 'nip04');
  const req = buildRequest(conn, enc, 'pay_invoice', { invoice: 'lnbc1' });
  assert.equal(req.kind, 23194);
  // The wallet's side: decrypt the request, answer it.
  const ck = nip44.getConversationKey(walletSk, clientPubkey(conn));
  assert.deepEqual(JSON.parse(nip44.decrypt(req.content, ck)), { method: 'pay_invoice', params: { invoice: 'lnbc1' } });
  const answer = (body) => finalizeEvent({ kind: NWC_RESPONSE, created_at: 1, tags: [['e', req.id]], content: nip44.encrypt(JSON.stringify(body), ck) }, walletSk);
  assert.deepEqual(readResponse(conn, enc, answer({ result_type: 'pay_invoice', result: { preimage: 'aa' } })), { preimage: 'aa' });
  assert.throws(() => readResponse(conn, enc, answer({ result_type: 'pay_invoice', error: { code: 'INSUFFICIENT_BALANCE', message: 'no funds' } })), /no funds/);
});

// ---- shipping and listings --------------------------------------------------------

test('shipping: options round-trip through a listing, tracking links are safe', () => {
  const l = parseListing({
    id: 'x', pubkey: pk.seller, created_at: 1,
    ...listingTemplate({ d: 'l1', title: 'Lamp', content: '', price: 20, currency: 'EUR', shippingOptions: [{ id: 'postnl', price: 6.95 }, { id: 'pickup', price: 0 }], payments: ['escrow', 'lightning', 'paypal'] }),
  });
  assert.deepEqual(l.shippingOptions, [{ id: 'postnl', price: 6.95, currency: 'EUR' }, { id: 'pickup', price: 0, currency: 'EUR' }]);
  // Always in the app's order: Lightning, on-chain, escrow.
  assert.deepEqual(l.payments, ['lightning', 'escrow']);
  assert.deepEqual(optionsFor({ shippingOptions: [], shippingCost: 4, currency: 'EUR' }), [{ id: 'other', price: 4, currency: 'EUR' }]);
  assert.deepEqual(parseShippingOptions([['shipping_option', 'dhl', 'x']]), []);
  assert.match(trackingUrl('postnl', '3SABCD123'), /^https:\/\/postnl\.nl\//);
  assert.match(trackingUrl('Mondial Relay', 'AB12345'), /^https:\/\/www\.mondialrelay\.com\//);
  assert.match(trackingUrl('Unknown carrier', 'AB12345'), /^https:\/\/parcelsapp\.com\//);
  assert.equal(trackingUrl('dhl', '"><script>'), null);
  // New listings: carriers without a price (the buyer pays the carrier's rate),
  // a parcel size, a country and where the seller ships to.
  const n = parseListing({ id: 'z', pubkey: pk.seller, created_at: 1, ...listingTemplate({ d: 'l3', title: 'Jas', content: '', price: 20, currency: 'EUR', country: 'NL', city: 'Utrecht', shipsTo: ['EU', 'GB'], packageSize: 'S', category: 'kleding-dames', subcategory: 'jassen-winter', shippingOptions: [{ id: 'pickup', price: 0 }, { id: 'mondialrelay' }, { id: 'postnl' }] }) });
  assert.deepEqual(n.shippingOptions.map((o) => [o.id, o.price]), [['pickup', 0], ['mondialrelay', null], ['postnl', null]]);
  assert.deepEqual([n.country, n.city, n.location, n.packageSize, n.subcategory], ['NL', 'Utrecht', 'Utrecht, NL', 'S', 'jassen-winter']);
  assert.deepEqual(n.shipsTo, ['EU', 'GB']);
  // Old listings without payment tags accept escrow only.
  assert.deepEqual(parseListing({ id: 'y', pubkey: pk.seller, created_at: 1, ...listingTemplate({ d: 'l2', title: 'x', content: '', price: 1, currency: 'EUR' }) }).payments, ['escrow']);
});

test('escrow deposit: the seller sets one share on the listing, the same for both sides, never zero', () => {
  const arb = 'a'.repeat(64);
  const parse = (extra) => parseListing({ id: 'd', pubkey: pk.seller, created_at: 1, ...listingTemplate({ d: 'l4', title: 'Fiets', content: '', price: 100, currency: 'EUR', payments: ['escrow'], arbiters: [arb], ...extra }) });
  assert.equal(parse({ depositPct: 20 }).depositPct, 20);
  assert.equal(parse({}).depositPct, DEFAULT_DEPOSIT_PCT);
  // Out of range is clamped: nobody trades escrow without risk.
  assert.equal(parse({ depositPct: 0 }).depositPct, MIN_DEPOSIT_PCT);
  assert.equal(parse({ depositPct: 99 }).depositPct, MAX_DEPOSIT_PCT);
  // Old listings with only a seller deposit fall back to the default for both.
  const old = parseListing({ id: 'o', pubkey: pk.seller, created_at: 1, kind: 30402, content: '', tags: [['d', 'l5'], ['title', 'x'], ['price', '10', 'EUR'], ['t', 'xbt-market'], ['payment', 'escrow'], ['seller_deposit_pct', '0']] });
  assert.equal(old.depositPct, DEFAULT_DEPOSIT_PCT);
  assert.equal(depositSats(100_000, 20), 20_000);
});
