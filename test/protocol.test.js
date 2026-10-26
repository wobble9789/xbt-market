import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { getPublicKey } from 'nostr-tools/pure';
import { deriveTradeKey, arbiterBaseKey, arbiterTradeKey, pubkeyOf, planPayout, signEscrow } from '../src/lib/btc/escrow.js';
import { reduceTrade, presetAllocations, finalizeProposal, deadlines, disputeClocks, shipDaysFor, DAY, TRADE_KIND, CHAT_KIND } from '../src/lib/trade/protocol.js';

const sk = () => secp256k1.utils.randomSecretKey();
const people = { buyer: sk(), seller: sk(), arbiter: sk(), mallory: sk() };
const pk = Object.fromEntries(Object.entries(people).map(([k, v]) => [k, getPublicKey(v)]));
const TID = 't0123456789abcdef01234567';
const BUYER_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const SELLER_ADDR = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
let n = 0;
const msg = (who, type, body, at) => ({
  id: String(++n).padStart(64, '0'), pubkey: pk[who], created_at: at ?? 1000 + n,
  kind: type === 'chat' ? CHAT_KIND : TRADE_KIND,
  tags: [['xbt-trade', TID], ['xbt-type', type]],
  content: type === 'chat' ? body : JSON.stringify(body),
});
const arbiterBase = pubkeyOf(arbiterBaseKey(people.arbiter));
const arbiters = new Map([[pk.arbiter, { escrowBase: arbiterBase }]]);
const key = (who) => (who === 'arbiter' ? arbiterTradeKey(people.arbiter, TID) : deriveTradeKey(people[who], TID));

const offer = (over = {}) => msg('buyer', 'offer', {
  v: 1, tradeId: TID, network: 'mainnet',
  listing: { coord: `30402:${pk.seller}:x`, sellerPubkey: pk.seller, title: 'Jacket', price: 50, currency: 'EUR' },
  priceSats: 100_000, buyerDepositSats: 15_000, sellerDepositSats: 15_000,
  arbiter: { pubkey: pk.arbiter, escrowBase: arbiterBase },
  buyer: { escrowPubkey: pubkeyOf(key('buyer')), payoutAddress: BUYER_ADDR },
  shipDays: 7, confirmDays: 21, ...over,
});
const accept = () => msg('seller', 'accept', { seller: { escrowPubkey: pubkeyOf(key('seller')), payoutAddress: SELLER_ADDR } });

function proposal(state, who, purpose, id = 'p1') {
  const utxos = [{ txid: 'cc'.repeat(32), vout: 1, value: 130_000 }];
  const plan = planPayout({ utxos, allocations: presetAllocations(state, purpose, 130_000), feeRate: 1, witnessScript: state.escrow.witnessScript, network: 'mainnet' });
  return { plan, utxos, m: msg(who, 'proposal', { id, purpose, utxos, txHex: plan.txHex, sigs: signEscrow(plan.tx, utxos, state.escrow.witnessScript, key(who)) }) };
}

test('happy path: offer, accept, ship, release, co-sign, finalize', () => {
  const log = [offer(), accept(), msg('seller', 'shipped', { carrier: 'PostNL', tracking: '3SABC' }), msg('buyer', 'chat', 'got it, thanks')];
  let s = reduceTrade(TID, log, { arbiters, me: pk.buyer });
  assert.equal(s.status, 'shipped');
  assert.equal(s.role, 'buyer');
  assert.ok(s.checks.arbiterTrusted);
  assert.match(s.escrow.address, /^bc1q/);
  assert.equal(s.chat.length, 1);

  const { m, plan } = proposal(s, 'buyer', 'release');
  log.push(m);
  s = reduceTrade(TID, log, { arbiters });
  const p = s.proposals.p1;
  assert.deepEqual(p.signedBy, ['buyer']);
  assert.equal(p.outputs.find((o) => o.role === 'seller').sats > 100_000, true);
  assert.equal(p.fee, plan.fee);
  assert.throws(() => finalizeProposal(s, p));

  log.push(msg('seller', 'sign', { proposalId: 'p1', sigs: signEscrow(p.tx, p.utxos, s.escrow.witnessScript, key('seller')) }));
  s = reduceTrade(TID, log, { arbiters });
  assert.deepEqual(s.proposals.p1.signedBy, ['buyer', 'seller']);
  const fin = finalizeProposal(s, s.proposals.p1);
  log.push(msg('seller', 'broadcast', { proposalId: 'p1', txid: fin.txid }));
  assert.equal(reduceTrade(TID, log, { arbiters }).status, 'closed');
});

test('messages from outsiders and wrong roles are ignored', () => {
  const log = [offer(), msg('mallory', 'accept', { seller: { escrowPubkey: pubkeyOf(key('mallory')), payoutAddress: SELLER_ADDR } }), msg('buyer', 'shipped', {})];
  const s = reduceTrade(TID, log, { arbiters });
  assert.equal(s.status, 'offered');
  assert.equal(s.accept, null);
  assert.ok(s.errors.some((e) => e.includes('only the seller ships')));
});

test('an offer with a forged arbiter escrow key is flagged untrusted', () => {
  // Buyer substitutes a key they control for the arbiter's: they would hold 2 of 3.
  const s = reduceTrade(TID, [offer({ arbiter: { pubkey: pk.arbiter, escrowBase: pubkeyOf(deriveTradeKey(people.buyer, 'evil')) } })], { arbiters });
  assert.equal(s.checks.arbiterTrusted, false);
  const s2 = reduceTrade(TID, [offer()], { arbiters: new Map() });
  assert.equal(s2.checks.arbiterTrusted, false);
});

test('proposal with signatures from the wrong key is refused', () => {
  const base = [offer(), accept()];
  const s = reduceTrade(TID, base, { arbiters });
  const { plan, utxos } = proposal(s, 'buyer', 'release');
  const forged = msg('buyer', 'proposal', { id: 'p2', purpose: 'release', utxos, txHex: plan.txHex, sigs: signEscrow(plan.tx, utxos, s.escrow.witnessScript, key('seller')) });
  const s2 = reduceTrade(TID, [...base, forged], { arbiters });
  assert.equal(s2.proposals.p2, undefined);
  assert.ok(s2.errors.some((e) => e.includes('proposer signatures invalid')), s2.errors.join('|'));
});

test('dispute: arbiter ruling plus one party pays out', () => {
  const log = [offer(), accept(), msg('buyer', 'dispute', { reason: 'item not as described' })];
  let s = reduceTrade(TID, log, { arbiters });
  assert.equal(s.status, 'disputed');
  const { m } = proposal(s, 'arbiter', 'refund', 'r1');
  log.push(m);
  s = reduceTrade(TID, log, { arbiters });
  const p = s.proposals.r1;
  assert.deepEqual(p.signedBy, ['arbiter']);
  log.push(msg('buyer', 'sign', { proposalId: 'r1', sigs: signEscrow(p.tx, p.utxos, s.escrow.witnessScript, key('buyer')) }));
  s = reduceTrade(TID, log, { arbiters });
  assert.ok(finalizeProposal(s, s.proposals.r1).txid);
  // refund: buyer gets price + own deposit back (minus share of fee), seller gets own deposit back
  const out = Object.fromEntries(s.proposals.r1.outputs.map((o) => [o.role, o.sats]));
  assert.ok(out.buyer > 110_000 && out.seller > 14_000);
});

test('a backdated buyer cancel cannot undo an accept', () => {
  const o = offer();
  const a = accept();
  const backdated = msg('buyer', 'cancel', { reason: 'gotcha' }, o.created_at); // same time as the offer, before the accept
  const s = reduceTrade(TID, [o, a, backdated], { arbiters });
  assert.ok(s.accept);
  assert.ok(s.escrow);
  assert.equal(s.status, 'cancelling'); // still needs a refund through the escrow
});

test('a backdated seller reject cannot undo an accept', () => {
  const o = offer();
  const s = reduceTrade(TID, [o, accept(), msg('seller', 'reject', {}, o.created_at)], { arbiters });
  assert.ok(s.escrow);
  assert.equal(s.rejected, null);
});

test('seller cannot reuse the buyer key to collapse the multisig', () => {
  const s = reduceTrade(TID, [offer(), msg('seller', 'accept', { seller: { escrowPubkey: pubkeyOf(key('buyer')), payoutAddress: SELLER_ADDR } })], { arbiters });
  assert.equal(s.accept, null);
  assert.ok(s.errors.some((e) => e.includes('duplicate escrow key')));
});

test('reject and cancel close the offer', () => {
  assert.equal(reduceTrade(TID, [offer(), msg('seller', 'reject', { reason: 'sold' })]).status, 'rejected');
  assert.equal(reduceTrade(TID, [offer(), msg('buyer', 'cancel', {})]).status, 'cancelled');
  // a seller who rejected and then accepts after all: the accept counts
  assert.ok(reduceTrade(TID, [offer(), msg('seller', 'reject', {}), accept()]).accept);
});

// ---- version 2: chat first, details after accept, payment changes -------------

const LISTING = { coord: `30402:${pk.seller}:x`, sellerPubkey: pk.seller, title: 'Jacket', price: 50, currency: 'EUR', payments: ['lightning', 'onchain', 'escrow'] };
const open2 = () => msg('buyer', 'open', { v: 2, network: 'mainnet', listing: LISTING });
const offer2 = (over = {}) => msg('buyer', 'offer', {
  v: 2, tradeId: TID, network: 'mainnet', listing: LISTING, payment: 'escrow',
  priceSats: 100_000, buyerDepositSats: 15_000, sellerDepositSats: 15_000,
  buyer: { escrowPubkey: pubkeyOf(key('buyer')) }, shipping: { carrier: 'postnl', country: 'DE', price: 6.95, currency: 'EUR' },
  shipDays: 7, confirmDays: 21, ...over,
});
const accept2 = (payoutAddress = SELLER_ADDR) => msg('seller', 'accept', { seller: { escrowPubkey: pubkeyOf(key('seller')), ...(payoutAddress ? { payoutAddress } : {}) } });
const details2 = (over = {}) => msg('buyer', 'details', { shipTo: { name: 'B', street: 'Weg', number: '1', postalCode: '10115', city: 'Berlin', country: 'DE' }, payoutAddress: BUYER_ADDR, arbiter: { pubkey: pk.arbiter, escrowBase: arbiterBase }, ...over });

test('v2: a conversation starts without an offer', () => {
  const s = reduceTrade(TID, [open2(), msg('buyer', 'chat', 'Is it still available?'), msg('seller', 'chat', 'Yes!')], { me: pk.seller });
  assert.equal(s.status, 'chat');
  assert.equal(s.role, 'seller');
  assert.equal(s.chat.length, 2);
  assert.equal(s.listing.title, 'Jacket');
  // Only the buyer who opened it can make the offer.
  const s2 = reduceTrade(TID, [open2(), msg('mallory', 'offer', JSON.parse(offer2().content))]);
  assert.equal(s2.offer, null);
});

test('v2 escrow: the arbiter and addresses come after the accept', () => {
  const log = [open2(), offer2(), accept2()];
  let s = reduceTrade(TID, log, { arbiters, me: pk.buyer });
  assert.equal(s.status, 'accepted');
  assert.equal(s.escrow, null, 'no escrow before the buyer picks an arbiter');
  assert.equal(s.participants.arbiter, null);
  log.push(details2());
  s = reduceTrade(TID, log, { arbiters, me: pk.arbiter });
  assert.match(s.escrow.address, /^bc1q/);
  assert.equal(s.role, 'arbiter');
  assert.ok(s.checks.arbiterTrusted);
  assert.equal(s.payout.buyer, BUYER_ADDR);
  assert.equal(s.shipTo.city, 'Berlin');
  // A second arbiter choice is ignored; the escrow address stays the same.
  const before = s.escrow.address;
  log.push(details2({ arbiter: { pubkey: pk.mallory, escrowBase: pubkeyOf(arbiterBaseKey(people.mallory)) } }));
  s = reduceTrade(TID, log, { arbiters });
  assert.equal(s.escrow.address, before);
  assert.ok(s.errors.some((e) => e.includes('already chosen')));
  // The usual payout works with the addresses from the details.
  const { m } = proposal(s, 'buyer', 'release');
  log.push(m);
  s = reduceTrade(TID, log, { arbiters });
  assert.deepEqual(s.proposals.p1.outputs.map((o) => o.role).sort(), ['buyer', 'seller']);
});

test('v2: details before the accept, or the buyer as arbiter, are refused', () => {
  const early = reduceTrade(TID, [open2(), offer2(), details2()], { arbiters });
  assert.equal(early.arbiter, null);
  const self = reduceTrade(TID, [open2(), offer2(), accept2(), details2({ arbiter: { pubkey: pk.buyer, escrowBase: arbiterBase } })], { arbiters });
  assert.equal(self.escrow, null);
  assert.ok(self.errors.some((e) => e.includes('three different people')));
});

test('v2: switch from Lightning to on-chain when both agree, not after paying', () => {
  const direct = offer2({ payment: 'direct', method: 'lightning', buyerDepositSats: undefined, sellerDepositSats: undefined });
  const log = [open2(), direct, accept2(null)];
  const change = msg('buyer', 'change', { method: 'onchain' });
  log.push(change);
  let s = reduceTrade(TID, log);
  assert.equal(s.changes[0].status, 'open');
  assert.equal(s.method, 'lightning');
  // The one who asked cannot agree to their own request.
  log.push(msg('buyer', 'change_ok', { changeId: change.id }));
  assert.equal(reduceTrade(TID, log).method, 'lightning');
  log.push(msg('seller', 'change_ok', { changeId: change.id }));
  s = reduceTrade(TID, log);
  assert.equal(s.method, 'onchain');
  assert.equal(s.changes[0].status, 'accepted');
  log.push(msg('seller', 'request', { method: 'onchain', address: SELLER_ADDR, amountSats: 100_000 }));
  log.push(msg('buyer', 'paid', { txid: 'ab'.repeat(32) }));
  log.push(msg('seller', 'change', { method: 'lightning' }));
  s = reduceTrade(TID, log);
  assert.equal(s.status, 'paid');
  assert.ok(s.errors.some((e) => e.includes('already paid')));
});

test('v2: switch from direct to escrow, then the escrow is set up', () => {
  const direct = offer2({ payment: 'direct', method: 'lightning', buyerDepositSats: undefined, sellerDepositSats: undefined });
  const change = msg('seller', 'change', { method: 'escrow', buyerDepositSats: 15_000, sellerDepositSats: 15_000 });
  const log = [open2(), direct, accept2(), change, msg('buyer', 'change_ok', { changeId: change.id }), details2()];
  const s = reduceTrade(TID, log, { arbiters });
  assert.equal(s.payment, 'escrow');
  assert.ok(s.escrow);
  assert.equal(s.terms.sellerDepositSats, 15_000);
  // A method the listing does not accept is refused.
  const only = { ...LISTING, payments: ['lightning'] };
  const s2 = reduceTrade(TID, [msg('buyer', 'open', { v: 2, network: 'mainnet', listing: only }), offer2({ listing: only, payment: 'direct', method: 'lightning', buyerDepositSats: undefined, sellerDepositSats: undefined }), msg('buyer', 'change', { method: 'onchain' })]);
  assert.equal(s2.changes.length, 0);
});

test('v2: shipping labels come from the seller only', () => {
  const s = reduceTrade(TID, [open2(), offer2(), accept2(),
    msg('buyer', 'label', { carrier: 'postnl', tracking: 'X' }),
    msg('seller', 'label', { carrier: 'postnl', tracking: '3SPOST1', trackingUrl: 'https://track/3SPOST1', qrUrl: 'javascript:alert(1)', labelUrl: 'https://svc/label.pdf' })]);
  assert.equal(s.labels.length, 1);
  assert.equal(s.labels[0].qrUrl, '');
  assert.equal(s.labels[0].labelUrl, 'https://svc/label.pdf');
});

// ---- deadlines ---------------------------------------------------------------


test('deadlines: ship within 5 days of paying (7 abroad); then 10 days to arrive and 4 to confirm or dispute, or 4 after a delivery', () => {
  assert.equal(shipDaysFor('NL', { country: 'NL' }), 5);
  assert.equal(shipDaysFor('NL', { country: 'DE' }), 7);
  assert.equal(shipDaysFor('NL', null), 5);
  const T0 = 1_000_000;
  const log = [open2(), offer2({ shipDays: 5, confirmDays: 14 }), msg('seller', 'accept', { seller: { escrowPubkey: pubkeyOf(key('seller')), payoutAddress: SELLER_ADDR } }, T0), details2()];
  let s = reduceTrade(TID, log, { arbiters });
  // Unpaid: counted from the accept. Paid: from the block that completed the escrow.
  assert.equal(deadlines(s).shipBy, T0 + 5 * DAY);
  assert.equal(deadlines(s, { fundedAt: T0 + DAY }).shipBy, T0 + 6 * DAY);
  assert.equal(deadlines(s, { fundedAt: T0 + DAY }).remindAt, T0 + 4 * DAY);
  log.push(msg('seller', 'shipped', { carrier: 'postnl', tracking: 'X' }, T0 + 2 * DAY));
  s = reduceTrade(TID, log, { arbiters });
  assert.equal(deadlines(s).arriveBy, T0 + 12 * DAY);
  assert.equal(deadlines(s).confirmBy, T0 + 16 * DAY);
  // Only the seller reports the delivery, and only once shipped; the buyer then has 4 days.
  log.push(msg('buyer', 'delivered', {}, T0 + 3 * DAY), msg('seller', 'delivered', {}, T0 + 4 * DAY));
  s = reduceTrade(TID, log, { arbiters });
  assert.equal(s.delivered.at, T0 + 4 * DAY);
  assert.equal(deadlines(s).arriveBy, T0 + 4 * DAY);
  assert.equal(deadlines(s).confirmBy, T0 + 8 * DAY);
  assert.ok(s.errors.some((e) => e.includes('only the seller reports the delivery')));
  // A hand-over at pick-up starts the 4 days at once.
  const pick = reduceTrade(TID, [open2(), offer2({ confirmDays: 14 }), accept2(), details2(), msg('seller', 'shipped', { carrier: 'pickup' }, T0)], { arbiters });
  assert.equal(deadlines(pick).confirmBy, T0 + 4 * DAY);
  // Shipped and delivered in the same second still count, whatever their ids.
  const same = reduceTrade(TID, [open2(), offer2(), accept2(), msg('seller', 'delivered', {}, T0), msg('seller', 'shipped', { carrier: 'postnl' }, T0)], { arbiters });
  assert.equal(same.delivered?.at, T0);
});

test('deadlines: a dispute after the confirmation deadline is flagged, and an unanswered one too', () => {
  const T0 = 2_000_000;
  const log = [open2(), offer2({ shipDays: 5, confirmDays: 14 }), accept2(), details2(), msg('seller', 'shipped', { carrier: 'postnl' }, T0)];
  log.push(msg('buyer', 'dispute', { reason: 'never arrived' }, T0 + 15 * DAY));
  let [d] = disputeClocks(reduceTrade(TID, log, { arbiters }));
  assert.equal(d.late, true);
  assert.equal(d.other, 'seller');
  assert.equal(d.answered, false);
  assert.equal(d.respondBy, T0 + 18 * DAY);
  log.push(msg('seller', 'chat', 'Here is the tracking: delivered on day 3', T0 + 16 * DAY));
  [d] = disputeClocks(reduceTrade(TID, log, { arbiters }));
  assert.equal(d.answered, true);
});

test('deadlines: in a direct trade the buyer may cancel after paying only once the seller is late', () => {
  const T0 = 3_000_000;
  const direct = offer2({ payment: 'direct', method: 'onchain', buyerDepositSats: undefined, sellerDepositSats: undefined, shipDays: 5 });
  const base = [open2(), direct, accept2(null), msg('seller', 'request', { method: 'onchain', address: SELLER_ADDR, amountSats: 100_000 }), msg('buyer', 'paid', { txid: 'ab'.repeat(32) }, T0)];
  const early = reduceTrade(TID, [...base, msg('buyer', 'cancel', { reason: 'changed my mind' }, T0 + 2 * DAY)]);
  assert.equal(early.cancelled, null);
  assert.ok(early.errors.some((e) => e.includes('already paid')));
  const late = reduceTrade(TID, [...base, msg('buyer', 'cancel', { reason: 'not shipped' }, T0 + 6 * DAY)]);
  assert.equal(late.status, 'cancelled');
  assert.equal(late.cancelled.late, true);
  // Once shipped, no late cancel.
  const shipped = reduceTrade(TID, [...base, msg('seller', 'shipped', { carrier: 'postnl' }, T0 + 6 * DAY), msg('buyer', 'cancel', {}, T0 + 7 * DAY)]);
  assert.equal(shipped.cancelled, null);
});

test('deadlines: the arbiter\'s at-fault splits give both deposits to the honest side', () => {
  const s = reduceTrade(TID, [open2(), offer2(), accept2(), details2()], { arbiters });
  const seller = (purpose) => presetAllocations(s, purpose, 130_000).find((a) => a.role === 'seller')?.sats || 0;
  assert.equal(seller('buyer-fault'), 130_000);
  assert.equal(seller('seller-fault'), 0);
  assert.equal(seller('refund'), 15_000);
  assert.equal(seller('release'), 115_000);
});

test('v2: the order itself names the arbiter, refund address and delivery address; the escrow exists at the accept', () => {
  const arb = { pubkey: pk.arbiter, escrowBase: arbiterBase };
  const shipTo = { name: 'B', street: 'Weg', number: '1', postalCode: '1234AB', city: 'Utrecht', country: 'NL' };
  const log = [open2(), offer2({ arbiter: arb, buyer: { escrowPubkey: pubkeyOf(key('buyer')), payoutAddress: BUYER_ADDR }, shipTo }), accept2()];
  const s = reduceTrade(TID, log, { arbiters, me: pk.arbiter });
  assert.equal(s.version, 2);
  assert.equal(s.errors.length, 0, s.errors.join());
  assert.match(s.escrow.address, /^bc1q/);
  assert.equal(s.role, 'arbiter');
  assert.ok(s.checks.arbiterTrusted);
  assert.equal(s.payout.buyer, BUYER_ADDR);
  assert.equal(s.shipTo.city, 'Utrecht');
  // A later arbiter choice changes nothing.
  const later = reduceTrade(TID, [...log, details2()], { arbiters });
  assert.equal(later.escrow.address, s.escrow.address);
  assert.ok(later.errors.some((e) => e.includes('already chosen')));
  // The seller's payout address may follow later; the buyer cannot be the arbiter.
  assert.ok(reduceTrade(TID, [open2(), offer2({ arbiter: arb }), accept2(null)], { arbiters }).escrow);
  assert.equal(reduceTrade(TID, [open2(), offer2({ arbiter: { pubkey: pk.buyer, escrowBase: arbiterBase } })], { arbiters }).offer, null);
  // An untrusted arbiter is flagged for the seller.
  assert.equal(reduceTrade(TID, log, { arbiters: new Map() }).checks.arbiterTrusted, false);
});
