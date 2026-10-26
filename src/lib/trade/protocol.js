// Trade protocol. A trade is the ordered log of NIP-17 rumors exchanged between
// buyer, seller and arbiter; its state is a pure function of that log, so any
// participant can rebuild it from relays (or a backup) at any time.
//
// Rumor: kind 1714 (protocol) or 14 (chat), tags ["xbt-trade", id] and
// ["xbt-type", type], content = JSON body (or chat text). The seal around each
// rumor is signed by its sender, and the rumor pubkey must match it, so `from`
// is authenticated.
//
// A trade starts as a conversation, like on Marktplaats or Vinted:
//   open (buyer: which listing) -> chat … -> offer (buyer) -> accept | reject (seller)
// The offer only names the price, the payment method and the delivery. What is
// needed after that comes once the seller has accepted:
//   details (buyer: delivery address; with escrow also the arbiter and a refund
//   address; seller: payout address)
// Either side can ask to switch the payment method before anything is paid:
//   change (one side) -> change_ok | change_no (the other side)
//
// Escrow (Bisq-like, every party able to walk away safely):
//   both fund the 2-of-3 address -> shipped (seller) -> proposal "release" + sign
//   -> broadcast. After accept: dispute (buyer/seller); the arbiter then proposes
//   a ruling and either party co-signs it. Any 2 of 3 signatures pay out.
// Direct (payment = "direct", no escrow, no arbiter): the buyer pays the seller
// straight away, on chain or over Lightning:
//   request (seller: invoice or address) -> paid (buyer: preimage or txid) /
//   confirm_paid (seller) -> label / shipped -> received
//
// Deadlines (see deadlines()), like on Vinted: the seller ships within 5 days
// of the payment (7 abroad); the buyer confirms or complains within 2 days of
// delivery (seller: delivered) or 14 days of shipping. After that the other
// side may ask the arbiter, who also sees who left a dispute unanswered for
// 3 days. In a direct trade the buyer may cancel once the seller is late.
//
// Version 1 offers (arbiter and addresses inside the offer, no "open") are still
// understood, so older trades keep working.

import { escrowInfo, arbiterTradePubkey, isValidPubkey, verifyEscrowSigs, txSpendsExactly, describeOutputs, finalizeEscrow } from '../btc/escrow.js';
import { parseTx } from '../btc/tx.js';
import { isValidAddress } from '../btc/address.js';
import { decodeInvoice, preimageMatches } from '../ln/bolt11.js';

export const TRADE_KIND = 1714;
export const CHAT_KIND = 14;
export const PROTOCOL_VERSION = 2;

const HEX64 = /^[0-9a-f]{64}$/;
const NETWORKS = ['mainnet', 'testnet4', 'regtest'];
const isInt = (n) => Number.isSafeInteger(n) && n >= 0;
const tagOf = (r, n) => r.tags?.find((t) => t[0] === n)?.[1];
const str = (v, max = 2000) => String(v ?? '').slice(0, max);

export function rumorInfo(r) {
  const tradeId = tagOf(r, 'xbt-trade');
  if (!tradeId) return null;
  let type = tagOf(r, 'xbt-type') || (r.kind === CHAT_KIND ? 'chat' : null);
  let body;
  if (r.kind === CHAT_KIND) {
    type = 'chat';
    // Photos: the imeta (NIP-92) links, taken out of the text.
    const photos = r.tags.filter((t) => t[0] === 'imeta').map((t) => t.slice(1).find((x) => x.startsWith('url '))?.slice(4)).filter(Boolean);
    let text = String(r.content ?? '');
    for (const u of photos) text = text.split(u).join('');
    body = { text: photos.length ? text.trim() : text, ...(photos.length ? { photos } : {}) };
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
export const METHODS = ['lightning', 'onchain', 'escrow'];
// The method the UI shows: lightning, onchain or escrow.
export const methodOf = (state) => (state.payment === 'escrow' ? 'escrow' : state.method);

function validateListing(l, from) {
  if (!HEX64.test(l?.sellerPubkey || '')) return 'bad seller';
  if (from === l.sellerPubkey) return 'buyer and seller must be different people';
  return null;
}

function validateOpen(m) {
  const b = m.body;
  if (!NETWORKS.includes(b.network)) return 'unknown network';
  return validateListing(b.listing, m.from);
}

function validateOffer(m) {
  const b = m.body;
  const net = b.network;
  if (b.tradeId !== m.tradeId) return 'trade id mismatch';
  if (!NETWORKS.includes(net)) return 'unknown network';
  const le = validateListing(b.listing, m.from);
  if (le) return le;
  if (b.payment != null && !['escrow', 'direct'].includes(b.payment)) return 'unknown payment type';
  if (!isInt(b.priceSats) || b.priceSats <= 0) return 'bad price';
  if (b.buyer?.escrowPubkey != null && !isValidPubkey(b.buyer.escrowPubkey)) return 'bad buyer escrow key';
  if (b.payment === 'direct') {
    if (!DIRECT_METHODS.includes(b.method)) return 'unknown payment method';
    if (b.arbiter) return 'a direct trade has no arbiter';
    if (b.buyerDepositSats || b.sellerDepositSats) return 'a direct trade has no deposits';
    return null;
  }
  if (!isInt(b.buyerDepositSats) || !isInt(b.sellerDepositSats)) return 'bad deposits';
  if (!isValidPubkey(b.buyer?.escrowPubkey || '')) return 'bad buyer escrow key';
  // The arbiter in the offer: always in version 1 (with the refund address),
  // optional in version 2, where the buyer picks one of the listing's arbiters.
  if (b.arbiter) {
    if (!HEX64.test(b.arbiter.pubkey || '')) return 'bad arbiter';
    if (!isValidPubkey(b.arbiter.escrowBase || '')) return 'bad arbiter escrow key';
    if (b.v !== 2 && !isValidAddress(b.buyer?.payoutAddress || '', net)) return 'bad buyer payout address';
    if (new Set([m.from, b.listing.sellerPubkey, b.arbiter.pubkey]).size !== 3) return 'buyer, seller and arbiter must be three different people';
  }
  if (b.buyer?.payoutAddress && !isValidAddress(b.buyer.payoutAddress, net)) return 'bad buyer payout address';
  return null;
}

function decisionError(m, offer) {
  if (m.type === 'reject') return null;
  const seller = m.body.seller;
  if (seller?.escrowPubkey != null && !isValidPubkey(seller.escrowPubkey)) return 'bad seller escrow key';
  if (seller?.payoutAddress && !isValidAddress(seller.payoutAddress, offer.network)) return 'bad seller payout address';
  if (paymentOf(offer) === 'direct') return null;
  if (!seller?.escrowPubkey) return 'bad seller escrow key';
  if (seller.escrowPubkey === offer.buyer.escrowPubkey) return 'duplicate escrow key';
  if (offer.arbiter) {
    if (offer.v !== 2 && !isValidAddress(seller.payoutAddress || '', offer.network)) return 'bad seller payout address'; // version 1
    const keys = [offer.buyer.escrowPubkey, seller.escrowPubkey, arbiterTradePubkey(offer.arbiter.escrowBase, offer.tradeId)];
    if (new Set(keys).size !== 3) return 'duplicate escrow key';
  }
  return null;
}

function emptyState(tradeId) {
  return {
    tradeId, status: 'unknown', open: null, offer: null, offerAt: 0, participants: null, accept: null, acceptedAt: 0,
    escrow: null, escrowKeys: null, arbiter: null, rejected: null, cancelled: null, shipped: null, delivered: null, received: null,
    disputes: [], proposals: {}, proposalOrder: [], broadcasts: [], fundingHints: [], chat: [], log: [], errors: [],
    checks: {}, payment: 'escrow', method: null, terms: null, payout: { buyer: '', seller: '' }, shipTo: '', servicePointId: null,
    changes: [], labels: [], requests: [], request: null, paid: null, paymentConfirmed: null, listing: null, version: 2,
  };
}

export function roleOf(state, pubkey) {
  const p = state.participants;
  if (!p || !pubkey) return null;
  return p.buyer === pubkey ? 'buyer' : p.seller === pubkey ? 'seller' : p.arbiter === pubkey ? 'arbiter' : null;
}

function labelOutputs(state, outputs) {
  return outputs.map((o) => ({
    ...o,
    role: o.address === state.payout.seller ? 'seller' : o.address === state.payout.buyer ? 'buyer' : 'other',
  }));
}

// Photos as proof (in a dispute or the chat): web addresses only, at most six.
const photosOf = (b) => (Array.isArray(b.photos) ? b.photos.filter((u) => typeof u === 'string' && u.length < 500 && /^https?:\/\/[^\s"'<>]+$/.test(u)).slice(0, 6) : []);

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
    id: b.id, from: m.from, role, purpose: b.purpose || 'custom', note: str(b.note),
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
  if (state.method === 'lightning') {
    let inv;
    try { inv = decodeInvoice(b.invoice); } catch (e) { return 'bad invoice: ' + e.message; }
    if (inv.amountMsat == null || inv.amountMsat !== BigInt(state.terms.priceSats) * 1000n) return 'invoice amount differs from the agreed price';
    if (ctx.lightningNetwork && inv.network !== ctx.lightningNetwork) return `invoice is for network "${inv.network}"`;
    req = { method: 'lightning', invoice: inv.invoice, paymentHash: inv.paymentHash, network: inv.network, blake2b: inv.blake2b, expiresAt: inv.expiresAt };
  } else {
    if (!isValidAddress(b.address || '', o.network)) return 'bad address';
    if (b.amountSats !== state.terms.priceSats) return 'amount differs from the agreed price';
    req = { method: 'onchain', address: b.address, amountSats: b.amountSats };
  }
  req.id = m.id;
  req.at = m.at;
  req.note = str(b.note, 500);
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

const paidYet = (state) => !!(state.paid || state.paymentConfirmed || state.escrow);

function setupEscrow(state, ctx) {
  const k = state.escrowKeys;
  if (state.payment !== 'escrow' || !k?.buyer || !k?.seller || !k?.arbiter || state.escrow) return null;
  if (new Set([k.buyer, k.seller, k.arbiter]).size !== 3) return 'duplicate escrow key';
  state.escrow = escrowInfo(k, state.offer.network);
  const trusted = ctx.arbiters?.get?.(state.arbiter.pubkey);
  state.checks.arbiterTrusted = !!trusted && trusted.escrowBase === state.arbiter.escrowBase;
  return null;
}

function applyDetails(state, m, role, ctx) {
  const b = m.body;
  if (!state.accept) return 'not accepted yet';
  const net = state.offer.network;
  const frozen = state.proposalOrder.length > 0; // payout addresses are fixed once a payout is proposed
  if (b.payoutAddress != null && b.payoutAddress !== '') {
    if (!isValidAddress(b.payoutAddress, net)) return 'bad payout address';
    if (role === 'arbiter') return 'the arbiter has no payout address';
    if (frozen) return 'a payout was already proposed';
    state.payout[role] = b.payoutAddress;
  }
  if (role !== 'buyer') return b.arbiter || b.shipTo ? 'only the buyer sends these details' : null;
  if (b.shipTo != null) state.shipTo = typeof b.shipTo === 'object' ? b.shipTo : str(b.shipTo);
  if (b.servicePointId != null) state.servicePointId = str(b.servicePointId, 40);
  if (b.arbiter) {
    if (state.payment !== 'escrow') return 'a direct trade has no arbiter';
    if (state.arbiter) return 'the arbiter was already chosen';
    const a = b.arbiter;
    if (!HEX64.test(a.pubkey || '') || !isValidPubkey(a.escrowBase || '')) return 'bad arbiter';
    if (a.pubkey === state.participants.buyer || a.pubkey === state.participants.seller) return 'buyer, seller and arbiter must be three different people';
    state.arbiter = { pubkey: a.pubkey, escrowBase: a.escrowBase };
    state.participants.arbiter = a.pubkey;
    state.escrowKeys.arbiter = arbiterTradePubkey(a.escrowBase, state.tradeId);
    const err = setupEscrow(state, ctx);
    if (err) { state.arbiter = null; state.participants.arbiter = null; state.escrowKeys.arbiter = null; return err; }
  }
  return null;
}

// A request to switch the payment method, valid until anything is paid.
function changeError(state, b) {
  if (!state.offer) return 'no offer yet';
  if (state.rejected || state.cancelled) return 'already closed';
  if (paidYet(state)) return 'already paid or in escrow';
  if (!METHODS.includes(b.method)) return 'unknown payment method';
  if (b.method === methodOf(state)) return 'that is already the payment method';
  const allowed = state.offer.listing.payments;
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(b.method)) return 'the listing does not accept this payment method';
  if (b.method === 'escrow') {
    if (!isInt(b.buyerDepositSats) || !isInt(b.sellerDepositSats)) return 'bad deposits';
    if (!state.escrowKeys?.buyer || (state.accept && !state.accept.seller?.escrowPubkey)) return 'this offer cannot switch to escrow';
  }
  return null;
}

function applyChangeOk(state, m, role) {
  const c = state.changes.find((x) => x.id === m.body.changeId);
  if (!c) return 'unknown change';
  if (c.role === role) return 'the other side has to agree';
  if (c.status !== 'open') return 'this change was already answered';
  const err = changeError(state, c);
  if (err) { c.status = 'void'; return err; }
  c.status = 'accepted';
  c.answeredAt = m.at;
  if (c.method === 'escrow') {
    state.payment = 'escrow';
    state.method = null;
    state.terms = { ...state.terms, buyerDepositSats: c.buyerDepositSats, sellerDepositSats: c.sellerDepositSats };
    state.escrowKeys = { buyer: state.offer.buyer.escrowPubkey, seller: state.accept?.seller?.escrowPubkey || null, arbiter: null };
  } else {
    state.payment = 'direct';
    state.method = c.method;
    state.terms = { ...state.terms, buyerDepositSats: 0, sellerDepositSats: 0 };
  }
  // A payment request for the old method no longer counts.
  state.request = null;
  for (const x of state.changes) if (x.status === 'open') x.status = 'void';
  return null;
}

// ctx.arbiters: Map(pubkey -> { escrowBase, ... }) of arbiters this user trusts.
// ctx.me: this user's pubkey.
export function reduceTrade(tradeId, rumors, ctx = {}) {
  const state = emptyState(tradeId);
  const msgs = rumors.map((r) => (r.type ? r : rumorInfo(r))).filter((m) => m && m.tradeId === tradeId).sort(byTime);
  const seen = new Set();

  const openMsg = msgs.find((m) => m.type === 'open' && !validateOpen(m));
  const offerMsg = msgs.find((m) => m.type === 'offer' && !validateOffer(m) && (!openMsg || (m.from === openMsg.from && m.body.listing.sellerPubkey === openMsg.body.listing.sellerPubkey)));
  if (!offerMsg && !openMsg) {
    state.errors.push('no valid offer');
    return state;
  }
  if (openMsg) {
    state.open = { ...openMsg.body, at: openMsg.at };
    state.listing = openMsg.body.listing;
    state.participants = { buyer: openMsg.from, seller: openMsg.body.listing.sellerPubkey, arbiter: null };
    state.status = 'chat';
  }
  const o = offerMsg?.body;
  if (o) {
    const direct = paymentOf(o) === 'direct';
    state.offer = o;
    state.listing = o.listing;
    state.offerAt = offerMsg.at;
    state.version = o.v === 2 ? 2 : o.arbiter || !openMsg ? 1 : 2;
    state.payment = paymentOf(o);
    state.method = direct ? o.method : null;
    state.terms = { priceSats: o.priceSats, buyerDepositSats: o.buyerDepositSats || 0, sellerDepositSats: o.sellerDepositSats || 0 };
    state.participants = { buyer: offerMsg.from, seller: o.listing.sellerPubkey, arbiter: null };
    state.payout.buyer = o.buyer?.payoutAddress || '';
    state.shipTo = o.shipTo || '';
    state.escrowKeys = { buyer: o.buyer?.escrowPubkey || null, seller: null, arbiter: null };
    if (o.arbiter) {
      state.arbiter = { pubkey: o.arbiter.pubkey, escrowBase: o.arbiter.escrowBase };
      state.participants.arbiter = o.arbiter.pubkey;
      state.escrowKeys.arbiter = arbiterTradePubkey(o.arbiter.escrowBase, tradeId);
      const trusted = ctx.arbiters?.get?.(o.arbiter.pubkey);
      state.checks.arbiterTrusted = !!trusted && trusted.escrowBase === o.arbiter.escrowBase;
    }
    state.status = 'offered';
  }
  state.role = ctx.me ? roleOf(state, ctx.me) : null;

  // Timestamps are chosen by senders, so the seller's decision is settled
  // first and an accept, once sent, always wins: neither a backdated buyer
  // cancel nor a backdated seller reject can hide an escrow that may hold coins.
  let decision = null;
  if (o) {
    const fromSeller = (t) => msgs.find((m) => m.from === state.participants.seller && m.type === t && !decisionError(m, o));
    decision = fromSeller('accept') || fromSeller('reject');
    if (decision?.type === 'accept') {
      state.accept = decision.body;
      state.acceptedAt = decision.at;
      state.escrowKeys.seller = decision.body.seller?.escrowPubkey || null;
      if (decision.body.seller?.payoutAddress) state.payout.seller = decision.body.seller.payoutAddress;
      if (state.payment === 'escrow') setupEscrow(state, ctx);
    } else if (decision?.type === 'reject') {
      state.rejected = { reason: str(decision.body.reason), at: decision.at };
    }
  }

  const deliveries = [];
  for (const m of msgs) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const role = roleOf(state, m.from);
    if (!role) continue; // not a participant: ignore entirely
    let err = null;
    const b = m.body;
    const afterAccept = !!state.accept;
    const direct = state.payment === 'direct';
    const escrowOnly = ['funded', 'dispute', 'proposal', 'sign', 'broadcast'];
    const directOnly = ['request', 'paid', 'confirm_paid'];
    const needsOffer = !['open', 'chat', 'offer'].includes(m.type);
    if (needsOffer && !state.offer) {
      err = 'no offer yet';
    } else if (direct ? escrowOnly.includes(m.type) : directOnly.includes(m.type)) {
      err = direct ? 'not used in a direct trade' : 'only used in a direct trade';
    } else {
      switch (m.type) {
        case 'open':
          if (m.id !== openMsg?.id) err = 'only one start per trade';
          break;
        case 'offer':
          if (m.id !== offerMsg?.id) err = 'only one offer per trade';
          break;
        case 'accept':
        case 'reject':
          if (role !== 'seller') err = `only the seller can ${m.type}`;
          else if (m.id !== decision?.id) err = decisionError(m, o) || 'the seller already decided';
          break;
        case 'details':
          err = applyDetails(state, m, role, ctx);
          break;
        case 'change':
          if (role === 'arbiter') err = 'the arbiter does not change payments';
          else if (!(err = changeError(state, b))) {
            for (const x of state.changes) if (x.status === 'open' && x.role === role) x.status = 'void';
            state.changes.push({ id: m.id, role, from: m.from, method: b.method, buyerDepositSats: b.buyerDepositSats, sellerDepositSats: b.sellerDepositSats, note: str(b.note, 500), status: 'open', at: m.at });
          }
          break;
        case 'change_ok':
          err = applyChangeOk(state, m, role);
          break;
        case 'change_no': {
          const c = state.changes.find((x) => x.id === b.changeId);
          if (!c || c.role === role || c.status !== 'open') err = 'nothing to decline';
          else { c.status = 'declined'; c.reason = str(b.reason, 500); c.answeredAt = m.at; }
          break;
        }
        case 'cancel':
          if (role === 'arbiter') err = 'arbiter cannot cancel';
          else if (state.rejected || state.cancelled) err = 'already closed';
          else if (direct && (state.paid || state.paymentConfirmed) && !(role === 'buyer' && !state.shipped && m.at > deadlines(state).shipBy)) err = 'already paid; agree a refund in the chat';
          else state.cancelled = { by: role, reason: str(b.reason), at: m.at, late: direct && !!(state.paid || state.paymentConfirmed) };
          break;
        case 'funded':
          if (HEX64.test(b.txid || '')) state.fundingHints.push({ by: role, txid: b.txid, at: m.at });
          break;
        case 'label':
          if (role !== 'seller') err = 'only the seller makes a label';
          else if (!afterAccept) err = 'not accepted yet';
          else state.labels.push({ id: m.id, carrier: str(b.carrier, 40), service: str(b.service, 100), tracking: str(b.tracking, 60), trackingUrl: /^https:\/\//.test(b.trackingUrl || '') ? str(b.trackingUrl, 500) : '', labelUrl: /^https?:\/\//.test(b.labelUrl || '') ? str(b.labelUrl, 500) : '', qrUrl: /^https?:\/\//.test(b.qrUrl || '') ? str(b.qrUrl, 500) : '', at: m.at });
          break;
        case 'shipped':
          if (role !== 'seller') err = 'only the seller ships';
          else if (!afterAccept) err = 'not accepted yet';
          else state.shipped = { carrier: str(b.carrier, 40), tracking: str(b.tracking, 60), note: str(b.note), at: m.at };
          break;
        case 'delivered':
          // Checked against the shipment after the loop: both may carry the same second.
          if (role !== 'seller') err = 'only the seller reports the delivery';
          else deliveries.push({ at: m.at, note: str(b.note, 500) });
          break;
        case 'received':
          if (role !== 'buyer') err = 'only the buyer confirms receipt';
          else state.received = { at: m.at, note: str(b.note) };
          break;
        case 'dispute':
          if (role === 'arbiter') err = 'arbiter does not open disputes';
          else if (!afterAccept) err = 'not accepted yet';
          else if (!state.escrow) err = 'no escrow yet';
          else state.disputes.push({ by: role, reason: str(b.reason), photos: photosOf(b), at: m.at });
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
          state.chat.push({ id: m.id, from: m.from, role, text: typeof b.text === 'string' ? b.text : '', photos: photosOf(b), at: m.at });
          break;
        default:
          err = 'unknown message type';
      }
    }
    state.log.push({ id: m.id, type: m.type, role, at: m.at, error: err, body: m.type === 'chat' ? undefined : b });
    if (err) state.errors.push(`${m.type} from ${role}: ${err}`);
  }
  // The role may only be known now (an arbiter chosen after the offer).
  state.role = ctx.me ? roleOf(state, ctx.me) : null;
  state.delivered = (state.shipped && deliveries.find((d) => d.at >= state.shipped.at)) || null;
  if (deliveries.length && !state.delivered) state.errors.push('delivered from seller: not shipped yet');

  if (!state.offer) return state;
  if (state.payment === 'direct') {
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
    : state.cancelled && !state.escrow ? 'cancelled'
    : state.cancelled ? 'cancelling'
    : state.disputes.length ? 'disputed'
    : state.shipped ? 'shipped'
    : state.accept ? 'accepted'
    : 'offered';
  return state;
}

// ---- helpers used by the UI ------------------------------------------------

export const expectedTotal = (s) => s.terms.priceSats + (s.terms.buyerDepositSats || 0) + (s.terms.sellerDepositSats || 0);

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
  const o = state.terms;
  const buyer = state.payout.buyer;
  const seller = state.payout.seller;
  const sellerShare = o.priceSats + o.sellerDepositSats;
  let s;
  if (purpose === 'release') s = Math.min(balance, sellerShare); // buyer gets deposit + any overpayment
  else if (purpose === 'refund') s = Math.max(0, balance - (o.priceSats + o.buyerDepositSats));
  else if (purpose === 'buyer-fault') s = balance; // the seller also gets the buyer's deposit
  else if (purpose === 'seller-fault') s = 0; // the buyer also gets the seller's deposit
  else s = Math.floor(balance / 2);
  return [
    { role: 'seller', address: seller, sats: s },
    { role: 'buyer', address: buyer, sats: balance - s },
  ].filter((a) => a.sats > 0);
}

// The seller's release, signed in advance when shipping, that the buyer can
// complete with one signature: it must spend exactly the escrow's confirmed
// coins, pay nobody else, give the buyer their part of the normal release (at
// most the network fee less) and keep that fee reasonable.
export function presignedRelease(state, confirmedUtxos = []) {
  const live = new Set(confirmedUtxos.map((u) => `${u.txid}:${u.vout}`));
  for (const id of [...state.proposalOrder].reverse()) {
    const p = state.proposals[id];
    if (p.purpose !== 'release' || p.role !== 'seller' || p.signedBy.length !== 1) continue;
    if (p.utxos.length !== live.size || !p.utxos.every((u) => live.has(`${u.txid}:${u.vout}`))) continue;
    if (p.outputs.some((o) => o.role === 'other') || p.fee > Math.max(10_000, p.total * 0.05)) continue;
    const owed = presetAllocations(state, 'release', p.total).find((a) => a.role === 'buyer')?.sats || 0;
    const gets = p.outputs.filter((o) => o.role === 'buyer').reduce((sum, o) => sum + o.sats, 0);
    if (gets >= owed - p.fee) return p;
  }
  return null;
}

export const DAY = 86400;
export const SHIP_DAYS = 5;
export const SHIP_DAYS_ABROAD = 7;
// After shipping: up to ARRIVE_DAYS for the parcel to arrive, then
// COMPLAIN_DAYS for the buyer to confirm or open a dispute. A delivery the
// seller reports (or a hand-over) starts the COMPLAIN_DAYS at once.
export const ARRIVE_DAYS = 10;
export const COMPLAIN_DAYS = 4;
export const CONFIRM_DAYS = ARRIVE_DAYS + COMPLAIN_DAYS;
export const CONFIRM_AFTER_DELIVERY_DAYS = COMPLAIN_DAYS;
export const RESPOND_DAYS = 3;
export const REMIND_DAYS = 2; // the seller is reminded this long before the shipping deadline

// Shipping time the order promises: longer when it crosses a border.
export function shipDaysFor(listingCountry, shipping) {
  const to = shipping?.country;
  return to && listingCountry && to !== listingCountry ? SHIP_DAYS_ABROAD : SHIP_DAYS;
}

// When the buyer paid (unix seconds), or null. For escrow the UI passes the
// block time at which the escrow was fully funded; the buyer's "I paid" hint
// is the fallback.
export function paidAt(state, fundedAt) {
  if (state.payment === 'direct') return state.paid?.at || state.paymentConfirmed?.at || null;
  return fundedAt || state.fundingHints.find((h) => h.by === 'buyer')?.at || null;
}

// The trade's deadlines (unix seconds). shipBy runs from the payment (from the
// accept while unpaid). After shipping, arriveBy is the end of the delivery
// time and confirmBy the end of the buyer's time to confirm or open a dispute;
// a reported delivery, a hand-over or a finished job starts that time at once.
export function deadlines(state, { fundedAt } = {}) {
  const o = state.offer;
  const paid = paidAt(state, fundedAt);
  const start = paid || state.acceptedAt || state.offerAt;
  const shipBy = start + (o.shipDays || SHIP_DAYS) * DAY;
  const shippedAt = state.shipped?.at || 0;
  const handedOver = ['pickup', 'service'].includes(state.shipped?.carrier) ? shippedAt : 0;
  const deliveredAt = state.delivered?.at || handedOver || 0;
  let confirmBy = (shippedAt || start) + (o.confirmDays || CONFIRM_DAYS) * DAY;
  let arriveBy = confirmBy - COMPLAIN_DAYS * DAY;
  if (deliveredAt) {
    confirmBy = Math.min(confirmBy, deliveredAt + COMPLAIN_DAYS * DAY);
    arriveBy = Math.min(arriveBy, deliveredAt);
  }
  return { paidAt: paid, shipBy, remindAt: shipBy - REMIND_DAYS * DAY, shippedAt: shippedAt || null, arriveBy, confirmBy, deliveredAt: deliveredAt || null };
}

// Each dispute with the other side's answer deadline: answered once they
// write anything after it was opened. `late`: a buyer's complaint after the
// confirmation deadline.
export function disputeClocks(state, opts) {
  const dl = deadlines(state, opts);
  return state.disputes.map((d) => {
    const other = d.by === 'buyer' ? 'seller' : 'buyer';
    const answered = state.log.some((e) => e.role === other && !e.error && e.at > d.at);
    return { ...d, other, respondBy: d.at + RESPOND_DAYS * DAY, answered, late: d.by === 'buyer' && !!state.shipped && d.at > dl.confirmBy };
  });
}

export const newTradeId = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 't' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};
