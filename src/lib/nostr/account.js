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

// Forgiving about what phones do to a pasted key: a capital first letter from
// autocorrect, spaces or line breaks from wrapped text, a "nostr:" prefix.
// Clear messages for the usual mix-ups (npub instead of nsec, a typo).
export function parseSecret(input) {
  const s = String(input || '').replace(/\s+/g, '').replace(/^nostr:/i, '');
  const lower = s.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(lower)) return hexToBytes(lower);
  if (lower.startsWith('npub1')) throw new Error('This is an npub (your public address). Log in with your nsec, which starts with nsec1. / Dit is een npub (je openbare adres). Log in met je nsec, die begint met nsec1.');
  if (lower.startsWith('ncryptsec1')) throw new Error('This key is password-protected (ncryptsec). Use the nsec itself. / Deze sleutel is met een wachtwoord versleuteld (ncryptsec). Gebruik de nsec zelf.');
  if (!lower.startsWith('nsec1')) throw new Error('Enter your nsec: it starts with nsec1. / Vul je nsec in: die begint met nsec1.');
  if (s !== lower && s !== s.toUpperCase() && s.slice(1) !== lower.slice(1)) throw new Error('The nsec has capital letters in it; it should be all lower case. / Er staan hoofdletters in de nsec; die hoort helemaal in kleine letters.');
  try {
    const d = nip19.decode(lower);
    if (d.type === 'nsec') return d.data;
  } catch { /* reported below */ }
  throw new Error(`This nsec is not valid: ${lower.length} characters instead of 63, or a typo. Copy it again from your backup. / Deze nsec klopt niet: ${lower.length} tekens in plaats van 63, of een typefout. Kopieer hem opnieuw uit je back-up.`);
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

// Unlocks with the password, or with the account's own nsec when the
// password is forgotten.
export function unlock(password) {
  const { ncryptsec, pubkey } = loadJSON(KEY, {});
  let sk;
  if (/^\s*(nostr:)?nsec1/i.test(password)) {
    sk = parseSecret(password);
    if (getPublicKey(sk) !== pubkey) throw new Error('This nsec belongs to another account. / Deze nsec hoort bij een ander account.');
  } else {
    sk = nip49.decrypt(ncryptsec, password); // throws on a wrong password
  }
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
