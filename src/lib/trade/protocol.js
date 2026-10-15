// Trade protocol. A trade is the ordered log of NIP-17 rumors exchanged between
// buyer, seller and arbiter; its state is a pure function of that log, so any
// participant can rebuild it from relays (or a backup) at any time.
//
// Rumor: kind 1714 (protocol) or 14 (chat), tags ["xbt-trade", id] and
// ["xbt-type", type], content = JSON body (or chat text). The seal around each
// rumor is signed by its sender, and the rumor pubkey must match it, so `from`
// is authenticated.
//
// Flow (Bisq-like, with every party able to walk away safely):
//   offer (buyer) -> accept | reject (seller) -> both fund the escrow address
//   -> shipped (seller) -> proposal "release" + sign -> broadcast
//   At any point after accept: dispute (buyer/seller); the arbiter then
//   proposes a ruling and either party co-signs it. Any 2 of 3 signatures pay out.
//
// Direct trades (offer.payment = "direct") have no escrow and no arbiter: the
// buyer pays the seller straight away, on chain or over Lightning.
//   offer -> accept | reject -> request (seller: invoice or address)
//   -> paid (buyer: preimage or txid) / confirm_paid (seller) -> shipped -> received

import { escrowInfo, arbiterTradePubkey, isValidPubkey, verifyEscrowSigs, txSpendsExactly, describeOutputs, finalizeEscrow } from '../btc/escrow.js';
import { parseTx } from '../btc/tx.js';
import { isValidAddress } from '../btc/address.js';
import { decodeInvoice, preimageMatches } from '../ln/bolt11.js';

export const TRADE_KIND = 1714;
export const CHAT_KIND = 14;
export const PROTOCOL_VERSION = 1;

const HEX64 = /^[0-9a-f]{64}$/;
const isInt = (n) => Number.isSafeInteger(n) && n >= 0;
const tagOf = (r, n) => r.tags?.find((t) => t[0] === n)?.[1];

export function rumorInfo(r) {
  const tradeId = tagOf(r, 'xbt-trade');
  if (!tradeId) return null;
  let type = tagOf(r, 'xbt-type') || (r.kind === CHAT_KIND ? 'chat' : null);
  let body;
  if (r.kind === CHAT_KIND) {
    type = 'chat';
    body = { text: String(r.content ?? '') };
  } else if (r.kind === TRADE_KIND) {
    try { body = JSON.parse(r.content); } catch { return null; }
    if (!body || typeof body !== 'object') return null;
  } else {
    return null;
  }
  return { id: r.id, tradeId, type, body, from: r.pubkey, at: r.created_at };
}

const byTime = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const paymentOf = (offer) => (offer?.payment === 'direct' ? 'direct' : 'escrow');
export const DIRECT_METHODS = ['onchain', 'lightning'];

function validateOffer(m) {
  const b = m.body;
  const net = b.network;
  if (b.tradeId !== m.tradeId) return 'trade id mismatch';
  if (!['mainnet', 'testnet4', 'regtest'].includes(net)) return 'unknown network';
  if (!HEX64.test(b.listing?.sellerPubkey || '')) return 'bad seller';
  if (b.payment != null && !['escrow', 'direct'].includes(b.payment)) return 'unknown payment type';
  if (b.payment === 'direct') {
    if (!DIRECT_METHODS.includes(b.method)) return 'unknown payment method';
    if (b.arbiter) return 'a direct trade has no arbiter';
    if (!isInt(b.priceSats) || b.priceSats <= 0) return 'bad price';
    if (b.buyerDepositSats || b.sellerDepositSats) return 'a direct trade has no deposits';
    if (m.from === b.listing.sellerPubkey) return 'buyer and seller must be different people';
    return null;
  }
  if (!HEX64.test(b.arbiter?.pubkey || '')) return 'bad arbiter';
  if (!isValidPubkey(b.arbiter?.escrowBase || '')) return 'bad arbiter escrow key';
  if (!isValidPubkey(b.buyer?.escrowPubkey || '')) return 'bad buyer escrow key';
  if (!isValidAddress(b.buyer?.payoutAddress || '', net)) return 'bad buyer payout address';
  if (!isInt(b.priceSats) || b.priceSats <= 0) return 'bad price';
  if (!isInt(b.buyerDepositSats) || !isInt(b.sellerDepositSats)) return 'bad deposits';
  const ids = new Set([m.from, b.listing.sellerPubkey, b.arbiter.pubkey]);
  if (ids.size !== 3) return 'buyer, seller and arbiter must be three different people';
  return null;
}

function decisionError(m, offer) {
  if (m.type === 'reject' || paymentOf(offer) === 'direct') return null;
  const seller = m.body.seller;
  if (!isValidPubkey(seller?.escrowPubkey || '')) return 'bad seller escrow key';
  if (!isValidAddress(seller?.payoutAddress || '', offer.network)) return 'bad seller payout address';
  const keys = [offer.buyer.escrowPubkey, seller.escrowPubkey, arbiterTradePubkey(offer.arbiter.escrowBase, offer.tradeId)];
  if (new Set(keys).size !== 3) return 'duplicate escrow key';
  return null;
}

function emptyState(tradeId) {
  return {
    tradeId, status: 'unknown', offer: null, offerAt: 0, participants: null, accept: null, acceptedAt: 0,
    escrow: null, escrowKeys: null, rejected: null, cancelled: null, shipped: null, received: null,
    disputes: [], proposals: {}, proposalOrder: [], broadcasts: [], fundingHints: [], chat: [], log: [], errors: [],
    checks: {}, payment: 'escrow', requests: [], request: null, paid: null, paymentConfirmed: null,
  };
}

export function roleOf(state, pubkey) {
  const p = state.participants;
  if (!p) return null;
  return p.buyer === pubkey ? 'buyer' : p.seller === pubkey ? 'seller' : p.arbiter === pubkey ? 'arbiter' : null;
}

function labelOutputs(state, outputs) {
  const buyerAddr = state.offer.buyer.payoutAddress;
  const sellerAddr = state.accept?.seller.payoutAddress;
  return outputs.map((o) => ({
    ...o,
    role: o.address === sellerAddr ? 'seller' : o.address === buyerAddr ? 'buyer' : 'other',
  }));
}

function applyProposal(state, m, role) {
  const b = m.body;
  if (!state.escrow) return 'no escrow yet';
  if (typeof b.id !== 'string' || !b.id || state.proposals[b.id]) return 'bad or duplicate proposal id';
  if (!Array.isArray(b.utxos) || !b.utxos.length) return 'no inputs';
  for (const u of b.utxos) if (!HEX64.test(u.txid || '') || !isInt(u.vout) || !isInt(u.value)) return 'bad input';
  let tx;
  try { tx = parseTx(b.txHex); } catch { return 'unparseable transaction'; }
  if (!txSpendsExactly(tx, b.utxos)) return 'transaction inputs do not match';
  const outputs = describeOutputs(tx, state.offer.network);
  const total = b.utxos.reduce((s, u) => s + u.value, 0);
  const fee = total - outputs.reduce((s, o) => s + o.sats, 0);
  if (fee < 0) return 'outputs exceed inputs';
  const proposal = {
    id: b.id, from: m.from, role, purpose: b.purpose || 'custom', note: String(b.note || '').slice(0, 2000),
    utxos: b.utxos.map(({ txid, vout, value }) => ({ txid, vout, value })), tx, txHex: b.txHex,
    outputs: labelOutputs(state, outputs), total, fee, sigs: {}, signedBy: [], at: m.at,
  };
  const key = state.escrowKeys[role];
  if (!verifyEscrowSigs(tx, proposal.utxos, state.escrow.witnessScript, key, b.sigs)) return 'proposer signatures invalid';
  proposal.sigs[key] = b.sigs;
  proposal.signedBy.push(role);
  state.proposals[b.id] = proposal;
  state.proposalOrder.push(b.id);
  return null;
}

// A seller's payment request in a direct trade: a Lightning invoice or an
// on-chain address, always for exactly the agreed amount.
function applyRequest(state, m, ctx) {
  const o = state.offer;
  const b = m.body;
  if (!state.accept) return 'not accepted yet';
  if (state.paid || state.paymentConfirmed) return 'already paid';
  let req;
  if (o.method === 'lightning') {
    let inv;
    try { inv = decodeInvoice(b.invoice); } catch (e) { return 'bad invoice: ' + e.message; }
    if (inv.amountMsat == null || inv.amountMsat !== BigInt(o.priceSats) * 1000n) return 'invoice amount differs from the agreed price';
    if (ctx.lightningNetwork && inv.network !== ctx.lightningNetwork) return `invoice is for network "${inv.network}"`;
    req = { method: 'lightning', invoice: inv.invoice, paymentHash: inv.paymentHash, network: inv.network, expiresAt: inv.expiresAt };
  } else {
    if (!isValidAddress(b.address || '', o.network)) return 'bad address';
    if (b.amountSats !== o.priceSats) return 'amount differs from the agreed price';
    req = { method: 'onchain', address: b.address, amountSats: b.amountSats };
  }
  req.id = m.id;
  req.at = m.at;
  req.note = String(b.note || '').slice(0, 500);
  state.requests.push(req);
  state.request = req;
  return null;
}

function applyPaid(state, m) {
  const b = m.body;
  const req = state.requests.find((r) => r.id === b.requestId) || state.request;
  if (!req) return 'no payment request yet';
  if (state.paid?.verified) return null;
  if (req.method === 'lightning') {
    if (b.preimage != null && !preimageMatches(b.preimage, req.paymentHash)) return 'preimage does not match the invoice';
    state.paid = { requestId: req.id, method: 'lightning', preimage: b.preimage || null, verified: b.preimage != null, at: m.at };
  } else {
    if (!HEX64.test(b.txid || '')) return 'bad txid';
    state.paid = { requestId: req.id, method: 'onchain', txid: b.txid, verified: false, at: m.at };
  }
  return null;
}

function applySign(state, m, role) {
  const p = state.proposals[m.body.proposalId];
  if (!p) return 'unknown proposal';
  if (p.signedBy.includes(role)) return null;
  const key = state.escrowKeys[role];
  if (!verifyEscrowSigs(p.tx, p.utxos, state.escrow.witnessScript, key, m.body.sigs)) return 'signatures invalid';
  p.sigs[key] = m.body.sigs;
  p.signedBy.push(role);
  return null;
}

// ctx.arbiters: Map(pubkey -> { escrowBase, ... }) of arbiters this user trusts.
// ctx.me: this user's pubkey.
export function reduceTrade(tradeId, rumors, ctx = {}) {
  const state = emptyState(tradeId);
  const msgs = rumors.map((r) => (r.type ? r : rumorInfo(r))).filter((m) => m && m.tradeId === tradeId).sort(byTime);
  const seen = new Set();

  const offerMsg = msgs.find((m) => m.type === 'offer' && !validateOffer(m));
  if (!offerMsg) {
    state.errors.push('no valid offer');
    return state;
  }
  const o = offerMsg.body;
  const direct = paymentOf(o) === 'direct';
  state.offer = o;
  state.offerAt = offerMsg.at;
  state.payment = paymentOf(o);
  state.participants = { buyer: offerMsg.from, seller: o.listing.sellerPubkey, arbiter: direct ? null : o.arbiter.pubkey };
  state.status = 'offered';
  if (!direct) {
    state.escrowKeys = { buyer: o.buyer.escrowPubkey, seller: null, arbiter: arbiterTradePubkey(o.arbiter.escrowBase, tradeId) };
    const trusted = ctx.arbiters?.get?.(o.arbiter.pubkey);
    state.checks.arbiterTrusted = !!trusted && trusted.escrowBase === o.arbiter.escrowBase;
  }
  state.role = ctx.me ? roleOf(state, ctx.me) : null;

  // Timestamps are chosen by senders, so the seller's decision is settled
  // first and an accept, once sent, always wins: neither a backdated buyer
  // cancel nor a backdated seller reject can hide an escrow that may hold coins.
  const fromSeller = (t) => msgs.find((m) => m.from === state.participants.seller && m.type === t && !decisionError(m, o));
  const decision = fromSeller('accept') || fromSeller('reject');
  if (decision?.type === 'accept') {
    if (!direct) {
      state.escrowKeys.seller = decision.body.seller.escrowPubkey;
      state.escrow = escrowInfo(state.escrowKeys, o.network);
    }
    state.accept = decision.body;
    state.acceptedAt = decision.at;
  } else if (decision?.type === 'reject') {
    state.rejected = { reason: String(decision.body.reason || ''), at: decision.at };
  }

  for (const m of msgs) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const role = roleOf(state, m.from);
    if (!role) continue; // not a participant: ignore entirely
    let err = null;
    const b = m.body;
    const afterAccept = !!state.accept;
    const escrowOnly = ['funded', 'dispute', 'proposal', 'sign', 'broadcast'];
    const directOnly = ['request', 'paid', 'confirm_paid'];
    if (direct ? escrowOnly.includes(m.type) : directOnly.includes(m.type)) {
      const err = direct ? 'not used in a direct trade' : 'only used in a direct trade';
      state.log.push({ id: m.id, type: m.type, role, at: m.at, error: err });
      state.errors.push(`${m.type} from ${role}: ${err}`);
      continue;
    }
    switch (m.type) {
      case 'offer':
        if (m.id !== offerMsg.id) err = 'only one offer per trade';
        break;
      case 'accept':
      case 'reject':
        if (role !== 'seller') err = `only the seller can ${m.type}`;
        else if (m.id !== decision?.id) err = decisionError(m, o) || 'the seller already decided';
        break;
      case 'cancel':
        if (role === 'arbiter') err = 'arbiter cannot cancel';
        else if (state.rejected || state.cancelled) err = 'already closed';
        else if (direct && (state.paid || state.paymentConfirmed)) err = 'already paid; agree a refund in the chat';
        else state.cancelled = { by: role, reason: String(b.reason || ''), at: m.at };
        break;
      case 'funded':
        if (HEX64.test(b.txid || '')) state.fundingHints.push({ by: role, txid: b.txid, at: m.at });
        break;
      case 'shipped':
        if (role !== 'seller') err = 'only the seller ships';
        else if (!afterAccept) err = 'not accepted yet';
        else state.shipped = { carrier: String(b.carrier || ''), tracking: String(b.tracking || ''), note: String(b.note || ''), at: m.at };
        break;
      case 'received':
        if (role !== 'buyer') err = 'only the buyer confirms receipt';
        else state.received = { at: m.at, note: String(b.note || '') };
        break;
      case 'dispute':
        if (role === 'arbiter') err = 'arbiter does not open disputes';
        else if (!afterAccept) err = 'not accepted yet';
        else state.disputes.push({ by: role, reason: String(b.reason || ''), at: m.at });
        break;
      case 'proposal':
        err = applyProposal(state, m, role);
        break;
      case 'sign':
        err = applySign(state, m, role);
        break;
      case 'broadcast':
        if (HEX64.test(b.txid || '')) state.broadcasts.push({ by: role, txid: b.txid, proposalId: b.proposalId, at: m.at });
        break;
      case 'request':
        err = role !== 'seller' ? 'only the seller requests payment' : applyRequest(state, m, ctx);
        break;
      case 'paid':
        err = role !== 'buyer' ? 'only the buyer reports a payment' : applyPaid(state, m);
        break;
      case 'confirm_paid':
        if (role !== 'seller') err = 'only the seller confirms a payment';
        else if (!state.request) err = 'no payment request yet';
        else if (!state.paymentConfirmed) state.paymentConfirmed = { at: m.at };
        break;
      case 'chat':
        state.chat.push({ id: m.id, from: m.from, role, text: b.text, at: m.at });
        break;
      default:
        err = 'unknown message type';
    }
    state.log.push({ id: m.id, type: m.type, role, at: m.at, error: err });
    if (err) state.errors.push(`${m.type} from ${role}: ${err}`);
  }

  if (direct) {
    state.status = state.rejected ? 'rejected'
      : state.cancelled ? 'cancelled'
      : state.received ? 'completed'
      : state.shipped ? 'shipped'
      : state.paid || state.paymentConfirmed ? 'paid'
      : state.accept ? 'accepted'
      : 'offered';
    return state;
  }
  state.status = state.rejected ? 'rejected'
    : state.broadcasts.length ? 'closed'
    : state.cancelled && !state.accept ? 'cancelled'
    : state.cancelled ? 'cancelling'
    : state.disputes.length ? 'disputed'
    : state.shipped ? 'shipped'
    : state.accept ? 'accepted'
    : 'offered';
  return state;
}

// ---- helpers used by the UI ------------------------------------------------

export const expectedTotal = (s) => s.offer.priceSats + (s.offer.buyerDepositSats || 0) + (s.offer.sellerDepositSats || 0);

// The value both parties name in their reviews: the payout txid for escrow,
// the payment txid or Lightning payment hash for a direct trade.
export function paymentProof(s) {
  if (s.payment === 'escrow') return s.broadcasts[s.broadcasts.length - 1]?.txid || null;
  const req = s.requests.find((r) => r.id === s.paid?.requestId) || s.request;
  if (!req) return null;
  return req.method === 'lightning' ? req.paymentHash : s.paid?.txid || null;
}

export function signersReady(p) {
  return p.signedBy.length >= 2;
}

export function finalizeProposal(state, proposal) {
  return finalizeEscrow(proposal.tx, proposal.utxos, state.escrow.witnessScript, proposal.sigs);
}

// The standard splits. `balance` is the escrow's actual balance in sats.
export function presetAllocations(state, purpose, balance) {
  const o = state.offer;
  const buyer = o.buyer.payoutAddress;
  const seller = state.accept.seller.payoutAddress;
  const sellerShare = o.priceSats + o.sellerDepositSats;
  let s;
  if (purpose === 'release') s = Math.min(balance, sellerShare); // buyer gets deposit + any overpayment
  else if (purpose === 'refund') s = Math.max(0, balance - (o.priceSats + o.buyerDepositSats));
  else s = Math.floor(balance / 2);
  return [
    { role: 'seller', address: seller, sats: s },
    { role: 'buyer', address: buyer, sats: balance - s },
  ].filter((a) => a.sats > 0);
}

export function deadlines(state) {
  const day = 86400;
  const base = state.acceptedAt || state.offerAt;
  return {
    shipBy: base + (state.offer.shipDays || 7) * day,
    confirmBy: (state.shipped?.at || base) + (state.offer.confirmDays || 21) * day,
  };
}

export const newTradeId = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 't' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};
