// Side-effecting trade operations used by the UI: they derive this user's
// escrow key, talk to the chain and send protocol messages.

import { account, secretKey } from '../nostr/account.js';
import { sendTradeMessage } from '../nostr/inbox.js';
import { deriveTradeKey, arbiterTradeKey, arbiterBaseKey, pubkeyOf, planPayout, signEscrow, finalizeEscrow } from '../btc/escrow.js';
import { escrowFunding, Esplora } from '../btc/esplora.js';
import { settings } from '../settings.js';
import { newTradeId, roleOf } from './protocol.js';

export const PROPOSAL_PURPOSES = ['release', 'refund', 'ruling', 'custom'];

export function esploraFor(network) {
  const s = settings.get();
  return new Esplora(s.esploraOverride?.[network] || s.esplora[network]);
}

const participants = (state) => [state.participants.buyer, state.participants.seller, state.participants.arbiter];
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

export async function createOffer({ listing, priceSats, buyerDepositSats, sellerDepositSats, arbiter, payoutAddress, shipTo, note, network }) {
  const tradeId = newTradeId();
  const me = account.get().pubkey;
  if (listing.pubkey === me) throw new Error('You cannot buy your own listing');
  const body = {
    v: 1,
    tradeId,
    network,
    listing: {
      coord: listing.coord, sellerPubkey: listing.pubkey, title: listing.title, image: listing.images[0] || '',
      price: listing.price, currency: listing.currency, shippingCost: listing.shippingCost,
    },
    priceSats, buyerDepositSats, sellerDepositSats,
    arbiter: { pubkey: arbiter.pubkey, escrowBase: arbiter.escrowBase },
    buyer: { escrowPubkey: pubkeyOf(deriveTradeKey(secretKey(), tradeId)), payoutAddress: payoutAddress.trim() },
    shipTo: shipTo || '', note: note || '',
    shipDays: settings.get().shipDays, confirmDays: settings.get().confirmDays,
  };
  await sendTradeMessage(tradeId, 'offer', body, [listing.pubkey, arbiter.pubkey]);
  return tradeId;
}

export function acceptOffer(state, payoutAddress) {
  const key = deriveTradeKey(secretKey(), state.tradeId);
  return send(state, 'accept', { seller: { escrowPubkey: pubkeyOf(key), payoutAddress: payoutAddress.trim() } });
}

export const rejectOffer = (state, reason) => send(state, 'reject', { reason });
export const cancelTrade = (state, reason) => send(state, 'cancel', { reason });
export const markShipped = (state, info) => send(state, 'shipped', info);
export const markReceived = (state, note) => send(state, 'received', { note });
export const openDispute = (state, reason) => send(state, 'dispute', { reason });
export const sendChat = (state, text) => send(state, 'chat', { text });
export const sendFundedHint = (state, txid) => send(state, 'funded', { txid });

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
