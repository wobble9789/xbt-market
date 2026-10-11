// The user's Nostr key. It is both identity and the root of every per-trade
// escrow key, so backing up the nsec backs up everything.
//
// Stored in localStorage, either plain or NIP-49 encrypted with a password.

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import * as nip49 from 'nostr-tools/nip49';
import { bytesToHex, hexToBytes } from '../btc/bytes.js';
import { createStore, loadJSON, saveJSON } from '../store.js';

const KEY = 'xbt:account';

const stored = loadJSON(KEY, null);
let secret = stored?.sk ? hexToBytes(stored.sk) : null;

export const account = createStore({
  pubkey: stored?.pubkey ?? null,
  locked: !!stored?.ncryptsec && !secret,
  encrypted: !!stored?.ncryptsec,
  backedUp: !!stored?.backedUp,
});

function persist(extra = {}) {
  const prev = loadJSON(KEY, {}) ?? {};
  saveJSON(KEY, { ...prev, ...extra });
}

export function parseSecret(input) {
  const s = input.trim();
  if (s.startsWith('nsec1')) {
    const d = nip19.decode(s);
    if (d.type !== 'nsec') throw new Error('not an nsec');
    return d.data;
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return hexToBytes(s.toLowerCase());
  throw new Error('Enter an nsec1… key or 64 hex characters');
}

function setSecret(sk, { backedUp }) {
  secret = sk;
  const pubkey = getPublicKey(sk);
  localStorage.removeItem(KEY);
  persist({ pubkey, sk: bytesToHex(sk), backedUp });
  account.set({ pubkey, locked: false, encrypted: false, backedUp });
}

export const createAccount = () => setSecret(generateSecretKey(), { backedUp: false });
export const importAccount = (input) => setSecret(parseSecret(input), { backedUp: true });

export function markBackedUp() {
  persist({ backedUp: true });
  account.set({ backedUp: true });
}

export function setPassword(password) {
  if (!secret) throw new Error('unlock first');
  const ncryptsec = nip49.encrypt(secret, password, 16, 0x01);
  const prev = loadJSON(KEY, {});
  saveJSON(KEY, { pubkey: prev.pubkey, ncryptsec, backedUp: prev.backedUp });
  account.set({ encrypted: true });
}

export function unlock(password) {
  const { ncryptsec } = loadJSON(KEY, {});
  const sk = nip49.decrypt(ncryptsec, password); // throws on a wrong password
  secret = sk;
  account.set({ locked: false });
}

export function lock() {
  if (!account.get().encrypted) return;
  secret = null;
  account.set({ locked: true });
}

export function logout() {
  secret = null;
  localStorage.removeItem(KEY);
  account.set({ pubkey: null, locked: false, encrypted: false, backedUp: false });
}

export function secretKey() {
  if (!secret) throw new Error('Your key is locked');
  return secret;
}

export const nsec = () => nip19.nsecEncode(secretKey());
export const npub = (pk = account.get().pubkey) => (pk ? nip19.npubEncode(pk) : '');
export const shortNpub = (pk) => { const n = npub(pk); return n ? n.slice(0, 12) + '…' + n.slice(-4) : ''; };

export const sign = (template) => finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...template }, secretKey());

export function toPubkey(input) {
  const s = (input || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  const d = nip19.decode(s.replace(/^nostr:/, ''));
  if (d.type === 'npub') return d.data;
  if (d.type === 'nprofile') return d.data.pubkey;
  throw new Error('not an npub');
}
