// Payout addresses without reuse. With the user's watch-only wallet key
// (see btc/xpub.js), every trade gets the next receive address that has never
// been seen: not on chain, and not handed out in any of the user's trades on
// any device (trade messages travel over relays, so all devices know them).
// Without a key, the one fixed address from the settings is the fallback.

import { settings, esplora } from './settings.js';
import { account } from './nostr/account.js';
import { loadJSON, saveJSON } from './store.js';
import { getSecret, setSecret, hasSecret } from './secrets.js';
import { parseWalletKey, deriveAddress } from './btc/xpub.js';

export const WALLET_KEY = 'payoutWalletKey';
const MAX_SCAN = 200;

const counterKey = () => `xbt:payout-index:${account.get().pubkey}:${settings.get().network}`;

export function walletKeyConfigured() { return hasSecret(WALLET_KEY); }

// Throws with a readable message when the key cannot be used.
export function saveWalletKey(text) {
  const net = settings.get().network;
  if (!text) { setSecret(WALLET_KEY, null); return null; }
  const wallet = parseWalletKey(text, net);
  setSecret(WALLET_KEY, text.trim());
  saveJSON(counterKey(), 0);
  return { wallet, first: deriveAddress(wallet, 0, net) };
}

export function loadWallet() {
  const text = getSecret(WALLET_KEY);
  if (!text) return null;
  try { return parseWalletKey(text, settings.get().network); } catch { return null; }
}

// Addresses that appear in my trades: payouts and payment requests I sent.
export function addressesInTrades(trades, me) {
  const out = new Set();
  for (const { state: s } of trades) {
    if (s.payout?.buyer && s.participants?.buyer === me) out.add(s.payout.buyer);
    if (s.payout?.seller && s.participants?.seller === me) out.add(s.payout.seller);
    for (const r of s.requests || []) if (r.address && s.participants?.seller === me) out.add(r.address);
    for (const id of s.proposalOrder || []) for (const o of s.proposals[id].outputs || []) if (o.role === 'other' && s.participants?.arbiter === me) out.add(o.address);
  }
  return out;
}

// Whether the address ever received anything, even if spent since. Throws
// when the blockchain server cannot tell: an address is never taken as
// unused without that check.
async function usedOnChain(address) {
  let a;
  try {
    a = await esplora().get(`/address/${address}`);
  } catch (e) {
    throw new Error(`Could not check your addresses on the blockchain server (${e.message}). Check Account → Network.`);
  }
  const s = (x) => (x?.tx_count || 0) + (x?.funded_txo_count || 0);
  return s(a.chain_stats) + s(a.mempool_stats) > 0;
}

// The next fresh address: { address, index } or null without a wallet key.
export async function nextPayoutAddress(known = new Set()) {
  const wallet = loadWallet();
  if (!wallet) return null;
  const net = settings.get().network;
  let i = loadJSON(counterKey(), 0);
  for (let n = 0; n < MAX_SCAN; n++, i++) {
    const address = deriveAddress(wallet, i, net);
    if (known.has(address)) continue;
    if (await usedOnChain(address)) continue;
    return { address, index: i };
  }
  throw new Error('No unused address found in the next 200 of your wallet');
}

// The first `count` receiving addresses without any payment on chain, as the
// user's own wallet shows them (it knows nothing of open trades).
export async function unusedOnChain(count = 2) {
  const wallet = loadWallet();
  if (!wallet) return [];
  const net = settings.get().network;
  const out = [];
  for (let i = 0; out.length < count && i < MAX_SCAN; i++) {
    const address = deriveAddress(wallet, i, net);
    if (!(await usedOnChain(address))) out.push({ address, index: i });
  }
  return out;
}

// Call once the address is actually sent in a trade.
export function markPayoutUsed(pick, sent) {
  if (!pick || sent.trim() !== pick.address) return;
  saveJSON(counterKey(), Math.max(loadJSON(counterKey(), 0), pick.index + 1));
}

// Whether an address someone typed has been used before (on chain); unknown counts as no.
export const addressSeenBefore = (address) => usedOnChain(address).catch(() => false);
