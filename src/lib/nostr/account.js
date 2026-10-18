// The user's Nostr key. It is both identity and the root of every per-trade
// escrow key, so backing up the nsec backs up everything.
//
// Stored in localStorage, either plain or NIP-49 encrypted with a password.
// With a password, an unlocked key survives a page refresh but not closing the
// browser: it is kept in sessionStorage, encrypted with a non-extractable
// WebCrypto key held in IndexedDB, so neither storage ever holds it readable.

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import * as nip49 from 'nostr-tools/nip49';
import { bytesToHex, hexToBytes } from '../btc/bytes.js';
import { createStore, loadJSON, saveJSON } from '../store.js';
import { T } from '../../ui/i18n.js';

const KEY = 'xbt:account';

const stored = loadJSON(KEY, null);
let secret = stored?.sk ? hexToBytes(stored.sk) : null;

const SESSION = 'xbt:session';
const hasSession = () => { try { return !!sessionStorage.getItem(SESSION); } catch { return false; } };

export const account = createStore({
  pubkey: stored?.pubkey ?? null,
  locked: !!stored?.ncryptsec && !secret,
  // Unlocking from the session copy is async; the app waits instead of
  // flashing the unlock screen.
  restoring: !!stored?.ncryptsec && !secret && hasSession(),
  encrypted: !!stored?.ncryptsec,
  backedUp: !!stored?.backedUp,
});

function idbKey(create) {
  return new Promise((resolve) => {
    if (!globalThis.indexedDB || !globalThis.crypto?.subtle) return resolve(null);
    const req = indexedDB.open('xbt-session', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction('keys').objectStore('keys').get('k');
      get.onerror = () => resolve(null);
      get.onsuccess = async () => {
        if (get.result || !create) return resolve(get.result || null);
        try {
          const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
          const put = db.transaction('keys', 'readwrite').objectStore('keys').put(key, 'k');
          put.onsuccess = () => resolve(key);
          put.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
    };
  });
}

async function saveSession() {
  try {
    const key = await idbKey(true);
    if (!key || !secret) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret));
    sessionStorage.setItem(SESSION, JSON.stringify({ pubkey: account.get().pubkey, iv: bytesToHex(iv), ct: bytesToHex(ct) }));
  } catch { /* no session copy: the password is asked after a refresh */ }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION); } catch { /* ignore */ }
}

async function restoreSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION) || 'null');
    const key = s && s.pubkey === account.get().pubkey && await idbKey(false);
    if (key) {
      const sk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(s.iv) }, key, hexToBytes(s.ct)));
      if (getPublicKey(sk) === account.get().pubkey) { secret = sk; account.set({ locked: false, restoring: false }); return; }
    }
  } catch { /* fall through to the unlock screen */ }
  clearSession();
  account.set({ restoring: false });
}
if (account.get().restoring) restoreSession();
// Make the session key early, so saving the session copy after unlocking is quick.
else if (stored?.pubkey) idbKey(true);

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
  if (lower.startsWith('npub1')) throw new Error(T('This is an npub (your public address). Log in with your nsec, which starts with nsec1.', 'Esto es un npub (tu dirección pública). Inicia sesión con tu nsec, que empieza por nsec1.'));
  if (lower.startsWith('ncryptsec1')) throw new Error(T('This key is password-protected (ncryptsec). Use the nsec itself.', 'Esta clave está protegida con contraseña (ncryptsec). Usa el nsec.'));
  if (!lower.startsWith('nsec1')) throw new Error(T('Enter your nsec: it starts with nsec1.', 'Introduce tu nsec: empieza por nsec1.'));
  if (s !== lower && s !== s.toUpperCase() && s.slice(1) !== lower.slice(1)) throw new Error(T('The nsec has capital letters in it; it should be all lower case.', 'El nsec tiene mayúsculas; debe ir todo en minúsculas.'));
  try {
    const d = nip19.decode(lower);
    if (d.type === 'nsec') return d.data;
  } catch { /* reported below */ }
  throw new Error(T(`This nsec is not valid: ${lower.length} characters instead of 63, or a typo. Copy it again from your backup.`, `Este nsec no es válido: ${lower.length} caracteres en vez de 63, o una errata. Cópialo otra vez de tu copia de seguridad.`));
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

// Sets or changes the password. Changing or removing it needs the current one,
// so someone holding an unlocked phone cannot lock the owner out.
export function setPassword(password, current) {
  if (!secret) throw new Error(T('Unlock first', 'Desbloquea primero'));
  if (String(password).length < 8) throw new Error(T('Use at least 8 characters', 'Usa al menos 8 caracteres'));
  const prev = loadJSON(KEY, {});
  if (prev.ncryptsec) checkCurrent(prev.ncryptsec, current);
  const ncryptsec = nip49.encrypt(secret, password, 16, 0x01);
  saveJSON(KEY, { pubkey: prev.pubkey, ncryptsec, backedUp: prev.backedUp });
  account.set({ encrypted: true });
  saveSession();
}

// True when `password` is this device's password (or the account's nsec).
export function checkPassword(password) {
  const { ncryptsec, pubkey } = loadJSON(KEY, {});
  if (!ncryptsec) return true;
  try {
    if (/^\s*(nostr:)?nsec1/i.test(password)) return getPublicKey(parseSecret(password)) === pubkey;
    return getPublicKey(nip49.decrypt(ncryptsec, password || '')) === pubkey;
  } catch { return false; }
}

export function removePassword(current) {
  const prev = loadJSON(KEY, {});
  if (!prev.ncryptsec) return;
  checkCurrent(prev.ncryptsec, current);
  saveJSON(KEY, { pubkey: prev.pubkey, sk: bytesToHex(secret), backedUp: prev.backedUp });
  account.set({ encrypted: false });
  clearSession();
}

function checkCurrent(ncryptsec, current) {
  let ok = false;
  try { ok = bytesToHex(nip49.decrypt(ncryptsec, current || '')) === bytesToHex(secret); } catch { /* wrong */ }
  if (!ok) throw new Error(T('The current password is not correct', 'La contraseña actual no es correcta'));
}

// Unlocks with the password, or with the account's own nsec when the
// password is forgotten.
export function unlock(password) {
  const { ncryptsec, pubkey } = loadJSON(KEY, {});
  let sk;
  if (/^\s*(nostr:)?nsec1/i.test(password)) {
    sk = parseSecret(password);
    if (getPublicKey(sk) !== pubkey) throw new Error(T('This nsec belongs to another account.', 'Este nsec pertenece a otra cuenta.'));
  } else {
    sk = nip49.decrypt(ncryptsec, password); // throws on a wrong password
  }
  secret = sk;
  account.set({ locked: false });
  saveSession();
}

export function lock() {
  if (!account.get().encrypted) return;
  secret = null;
  clearSession();
  account.set({ locked: true });
}

export function logout() {
  secret = null;
  clearSession();
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
