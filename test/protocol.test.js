import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { getPublicKey } from 'nostr-tools/pure';
import { deriveTradeKey, arbiterBaseKey, arbiterTradeKey, pubkeyOf, planPayout, signEscrow } from '../src/lib/btc/escrow.js';
import { reduceTrade, presetAllocations, finalizeProposal, TRADE_KIND, CHAT_KIND } from '../src/lib/trade/protocol.js';

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
