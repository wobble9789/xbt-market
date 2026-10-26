// Side-effecting trade operations used by the UI: they derive this user's
// escrow key, talk to the chain and send protocol messages.

import { account, secretKey } from '../nostr/account.js';
import { sendTradeMessage, forwardOwnRumors } from '../nostr/inbox.js';
import { deriveTradeKey, arbiterTradeKey, arbiterBaseKey, pubkeyOf, planPayout, signEscrow, finalizeEscrow } from '../btc/escrow.js';
import { escrowFunding, Esplora } from '../btc/esplora.js';
import { settings } from '../settings.js';
import { loadJSON, saveJSON } from '../store.js';
import { depositPctOf } from '../nostr/listings.js';
import { newTradeId, roleOf, shipDaysFor, CONFIRM_DAYS, presetAllocations } from './protocol.js';
import { decodeInvoice } from '../ln/bolt11.js';
import { isService } from '../categories.js';
import { invoiceFromAddress } from '../ln/lnurl.js';
import { makeInvoice, payInvoice, walletConnected } from '../ln/wallet.js';

export const PROPOSAL_PURPOSES = ['release', 'refund', 'ruling', 'custom'];

export function esploraFor(network) {
  const s = settings.get();
  return new Esplora(s.esploraOverride?.[network] || s.esplora[network]);
}

const participants = (state) => [state.participants.buyer, state.participants.seller, state.participants.arbiter].filter(Boolean);
const send = (state, type, body) => sendTradeMessage(state.tradeId, type, body, participants(state));

export function myRole(state) {
  return roleOf(state, account.get().pubkey);
}

// This user's escrow secret for the trade, checked against the key the trade uses.
export function myEscrowKey(state) {
  const role = myRole(state);
  if (!role) throw new Error('You are not part of this trade');
  const sk = secretKey();
  const key = role === 'arbiter' ? arbiterTradeKey(sk, state.tradeId) : deriveTradeKey(sk, state.tradeId);
  const expected = state.escrowKeys[role];
  if (expected && pubkeyOf(key) !== expected) throw new Error('This trade uses an escrow key from a different account');
  return key;
}

const listingInfoOf = (listing) => ({
  coord: listing.coord, sellerPubkey: listing.pubkey, title: listing.title, image: listing.images[0] || '',
  price: listing.price, currency: listing.currency, payments: listing.payments, country: listing.country || '',
  ...(listing.payments?.includes('escrow') ? { depositPct: depositPctOf(listing) } : {}),
  ...(isService(listing.category) ? { kind: 'service', priceUnit: listing.priceUnit || '' } : {}),
});

// Starts a conversation about a listing (like "send a message" on Marktplaats).
export async function openConversation({ listing, network, text, prev }) {
  const tradeId = newTradeId();
  const me = account.get().pubkey;
  if (listing.pubkey === me) throw new Error('You cannot buy your own listing');
  await sendTradeMessage(tradeId, 'open', { v: 2, network, listing: listingInfoOf(listing), ...(prev ? { prev } : {}) }, [listing.pubkey]);
  if (text) await sendTradeMessage(tradeId, 'chat', { text }, [listing.pubkey]);
  return tradeId;
}

// The order: price, payment method, delivery and (escrow) the arbiter. The
// buyer's delivery and refund addresses stay on this device until the seller
// accepts; then they go out by themselves (sendPendingDetails).
export async function createOffer({ tradeId, listing, priceSats, buyerDepositSats, sellerDepositSats, note, network, payment = 'escrow', method, shipping, arbiter, refundAddress, shipTo }) {
  const me = account.get().pubkey;
  if (listing.pubkey === me) throw new Error('You cannot buy your own listing');
  const body = {
    v: 2, tradeId, network, listing: listingInfoOf(listing), payment, priceSats,
    ...(payment === 'direct' ? { method } : { buyerDepositSats, sellerDepositSats }),
    buyer: { escrowPubkey: pubkeyOf(deriveTradeKey(secretKey(), tradeId)) },
    // Escrow: the arbiter (one of the listing's) comes with the order, so the
    // escrow exists as soon as the seller accepts.
    ...(payment !== 'direct' && arbiter ? { arbiter: { pubkey: arbiter.pubkey, escrowBase: arbiter.escrowBase } } : {}),
    shipping: shipping || null, note: note || '', shipDays: shipDaysFor(listing.country, shipping), confirmDays: CONFIRM_DAYS,
  };
  const pending = { ...(shipTo ? { shipTo } : {}), ...(payment !== 'direct' && refundAddress ? { payoutAddress: refundAddress.trim() } : {}) };
  if (Object.keys(pending).length) saveJSON(pendingKey(tradeId), pending);
  await sendTradeMessage(tradeId, 'offer', body, [listing.pubkey]);
  // The arbiter gets the conversation so far (and this order), signed by me.
  if (body.arbiter) await forwardOwnRumors(tradeId, body.arbiter.pubkey).catch(() => {});
  return tradeId;
}

// Seller: accept. The escrow key is always included, so the trade can still
// switch to escrow later.
export function acceptOffer(state, payoutAddress) {
  const key = deriveTradeKey(secretKey(), state.tradeId);
  return send(state, 'accept', { seller: { escrowPubkey: pubkeyOf(key), ...(payoutAddress ? { payoutAddress: payoutAddress.trim() } : {}) } });
}

// Buyer: delivery address, and with escrow the arbiter and a refund address.
// Seller: payout address. The arbiter, once chosen, receives the messages so far.
export async function sendDetails(state, { shipTo, payoutAddress, arbiter, servicePointId }) {
  const body = {
    ...(shipTo ? { shipTo } : {}), ...(payoutAddress ? { payoutAddress: payoutAddress.trim() } : {}), ...(servicePointId ? { servicePointId: String(servicePointId) } : {}),
    ...(arbiter ? { arbiter: { pubkey: arbiter.pubkey, escrowBase: arbiter.escrowBase } } : {}),
  };
  const to = [state.participants.buyer, state.participants.seller, arbiter?.pubkey || state.participants.arbiter].filter(Boolean);
  await sendTradeMessage(state.tradeId, 'details', body, to);
  if (arbiter) await forwardOwnRumors(state.tradeId, arbiter.pubkey).catch(() => {});
}

// The buyer's addresses for an order, kept here until the seller accepts.
const pendingKey = (tradeId) => `xbt:pending-details:${account.get().pubkey}:${tradeId}`;
export const pendingDetails = (tradeId) => loadJSON(pendingKey(tradeId), null);

// Buyer, in the background: once the seller accepted, send the addresses
// kept with the order (only what the trade does not have yet). They are
// forgotten once the trade shows them, so no form asks for them meanwhile.
export async function sendPendingDetails(state) {
  const p = pendingDetails(state.tradeId);
  if (!p || state.role !== 'buyer') return false;
  const forget = () => saveJSON(pendingKey(state.tradeId), null);
  if (state.rejected || state.cancelled) { forget(); return false; }
  if (!state.accept) return false;
  const body = {
    ...(p.shipTo && !state.shipTo ? { shipTo: p.shipTo } : {}),
    ...(p.payoutAddress && state.payment === 'escrow' && !state.payout.buyer ? { payoutAddress: p.payoutAddress } : {}),
  };
  if (!Object.keys(body).length) { forget(); return false; }
  if (p.sentAt && Date.now() - p.sentAt < 60_000) return false; // on its way; sent again if it never shows up
  saveJSON(pendingKey(state.tradeId), { ...p, sentAt: Date.now() });
  try { await sendDetails(state, body); } catch (e) { saveJSON(pendingKey(state.tradeId), p); throw e; }
  return true;
}

export const requestChange = (state, { method, buyerDepositSats, sellerDepositSats, note }) =>
  send(state, 'change', { method, ...(method === 'escrow' ? { buyerDepositSats, sellerDepositSats } : {}), ...(note ? { note } : {}) });
export const answerChange = (state, change, ok, reason = '') => send(state, ok ? 'change_ok' : 'change_no', { changeId: change.id, ...(reason ? { reason } : {}) });
export const sendLabel = (state, label) => send(state, 'label', label);

export const rejectOffer = (state, reason) => send(state, 'reject', { reason });
export const cancelTrade = (state, reason) => send(state, 'cancel', { reason });
export const markShipped = (state, info) => send(state, 'shipped', info);
export const markDelivered = (state, note) => send(state, 'delivered', { note });
export const markReceived = (state, note) => send(state, 'received', { note });
export const openDispute = (state, reason, photos = []) => send(state, 'dispute', { reason, ...(photos.length ? { photos } : {}) });
export const sendChat = (state, text, photos = []) => send(state, 'chat', { text, ...(photos.length ? { photos } : {}) });
export const sendFundedHint = (state, txid) => send(state, 'funded', { txid });

// ---- direct trades ----------------------------------------------------------

// Seller: ask for payment. Lightning invoices come from the connected wallet,
// a Lightning address, or are pasted; on-chain requests name an address.
export async function requestLightning(state, { invoice, lightningAddress }) {
  const sats = state.terms.priceSats;
  const memo = `XBT Market: ${state.offer.listing.title}`.slice(0, 100);
  let pr = (invoice || '').trim();
  if (!pr && lightningAddress) pr = (await invoiceFromAddress(lightningAddress, sats, memo)).invoice;
  if (!pr && walletConnected()) pr = (await makeInvoice(sats, memo)).invoice;
  if (!pr) throw new Error('Connect a wallet, enter a Lightning address or paste an invoice');
  const inv = decodeInvoice(pr);
  if (inv.amountMsat !== BigInt(sats) * 1000n) throw new Error('The invoice is not for the agreed amount');
  return send(state, 'request', { method: 'lightning', invoice: inv.invoice });
}

export const requestOnchain = (state, address) => send(state, 'request', { method: 'onchain', address: address.trim(), amountSats: state.terms.priceSats });

// Buyer: pay the current Lightning request with the connected wallet; the
// preimage the wallet returns proves the payment to everyone in the trade.
export async function payWithWallet(state) {
  const req = state.request;
  if (!req || req.method !== 'lightning') throw new Error('No Lightning payment request');
  const res = await payInvoice(req.invoice);
  return send(state, 'paid', { requestId: req.id, preimage: res.preimage });
}

export const reportPaid = (state, { preimage, txid }) => send(state, 'paid', { requestId: state.request?.id, ...(preimage ? { preimage: preimage.trim().toLowerCase() } : {}), ...(txid ? { txid: txid.trim().toLowerCase() } : {}) });
export const confirmPaid = (state) => send(state, 'confirm_paid', {});

// Does this on-chain tx pay at least the requested amount to the address?
export async function checkOnchainPayment(state) {
  const req = state.request;
  const txid = state.paid?.txid;
  if (!req || req.method !== 'onchain' || !txid) return null;
  const api = esploraFor(state.offer.network);
  const [tx, tip] = await Promise.all([api.tx(txid), api.tipHeight()]);
  const paid = tx.vout.filter((o) => o.scriptpubkey_address === req.address).reduce((s, o) => s + o.value, 0);
  const confirmations = tx.status?.confirmed ? tip - tx.status.block_height + 1 : 0;
  return { paid, enough: paid >= req.amountSats, confirmations };
}

export async function loadFunding(state) {
  const minConf = settings.get().minConfirmations;
  return escrowFunding(esploraFor(state.offer.network), state.escrow.address, minConf);
}

// Builds, signs and sends a payout proposal from the escrow's confirmed coins.
export async function proposePayout(state, { purpose, allocations, note, feeRate }) {
  const funding = await loadFunding(state);
  const utxos = funding.confirmedUtxos.map(({ txid, vout, value }) => ({ txid, vout, value }));
  if (!utxos.length) throw new Error('The escrow has no confirmed coins yet');
  const total = utxos.reduce((s, u) => s + u.value, 0);
  const allocated = allocations.reduce((s, a) => s + a.sats, 0);
  if (allocated !== total) throw new Error(`Split must add up to the escrow balance (${total} sats)`);
  const rate = feeRate || (await esploraFor(state.offer.network).feeRate());
  const plan = planPayout({ utxos, allocations, feeRate: rate, witnessScript: state.escrow.witnessScript, network: state.offer.network });
  const sigs = signEscrow(plan.tx, utxos, state.escrow.witnessScript, myEscrowKey(state));
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await send(state, 'proposal', { id, purpose, utxos, txHex: plan.txHex, sigs, note: note || '', feeRate: rate });
  return id;
}

// Seller, when shipping (or handing over): sign the normal release in advance
// (price and deposit to the seller, the buyer's deposit back), so the buyer's
// "Everything OK" pays out at once. It can only ever pay the seller what the
// release gives them. Skipped (the buyer then proposes it) when not possible.
export async function presignRelease(state) {
  if (state.payment !== 'escrow' || !state.escrow || !state.payout.buyer || !state.payout.seller) return null;
  const funding = await loadFunding(state);
  if (!funding.confirmedTotal) return null;
  return proposePayout(state, { purpose: 'release', allocations: presetAllocations(state, 'release', funding.confirmedTotal), note: '' });
}

// Before signing, check every input still exists on chain with the stated value.
export async function checkProposalInputs(state, proposal) {
  const funding = await loadFunding(state);
  const live = new Map(funding.utxos.map((u) => [u.txid + ':' + u.vout, u.value]));
  const missing = proposal.utxos.filter((u) => live.get(u.txid + ':' + u.vout) !== u.value);
  return { ok: missing.length === 0, missing, funding };
}

export async function signProposal(state, proposal) {
  const check = await checkProposalInputs(state, proposal);
  if (!check.ok) throw new Error('This proposal spends coins that are no longer in the escrow (already paid out?)');
  const sigs = signEscrow(proposal.tx, proposal.utxos, state.escrow.witnessScript, myEscrowKey(state));
  await send(state, 'sign', { proposalId: proposal.id, sigs });
  const role = myRole(state);
  if (proposal.signedBy.length + (proposal.signedBy.includes(role) ? 0 : 1) >= 2) {
    const withMine = { ...proposal, sigs: { ...proposal.sigs, [state.escrowKeys[role]]: sigs } };
    return broadcastProposal(state, withMine);
  }
  return null;
}

export async function broadcastProposal(state, proposal) {
  const fin = finalizeEscrow(proposal.tx, proposal.utxos, state.escrow.witnessScript, proposal.sigs);
  const api = esploraFor(state.offer.network);
  try {
    await api.broadcast(fin.hex);
  } catch (e) {
    // Fine if this exact transaction is already known (the other party was first).
    const known = await api.tx(fin.txid).then(() => true, () => false);
    if (!known) throw e;
  }
  await send(state, 'broadcast', { proposalId: proposal.id, txid: fin.txid });
  return fin.txid;
}

export const myArbiterBasePub = () => pubkeyOf(arbiterBaseKey(secretKey()));
