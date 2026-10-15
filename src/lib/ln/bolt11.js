// Minimal BOLT11 invoice reader: network prefix, amount, payment hash,
// description and expiry. Enough to check that a payment request asks for the
// agreed amount and to verify a preimage as proof of payment. The node
// signature is not checked; the payment hash is what binds the proof.
//
// The prefix after "ln" names the network (lnbc = Bitcoin). Lightning on the
// BLAKE2b chain uses its own prefix, so any "ln…" prefix is accepted and shown
// to the user; config.js can pin the expected one.

import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '../btc/bytes.js';

// Millisatoshis per unit of each multiplier (1 coin = 1e11 msat).
const MULT = { m: 100_000_000n, u: 100_000n, n: 100n };

// Amount in millisatoshis from the human-readable part, or null when absent.
function parseAmount(s) {
  if (!s) return null;
  const m = /^(\d+)([munp]?)$/.exec(s);
  if (!m) throw new Error('bad invoice amount');
  const n = BigInt(m[1]);
  // 1 coin = 1e11 msat; the multiplier divides a whole coin.
  if (!m[2]) return n * 100_000_000_000n;
  if (m[2] === 'p') {
    if (n % 10n) throw new Error('sub-millisatoshi amount');
    return n / 10n;
  }
  return n * MULT[m[2]];
}

const wordsToBytes = (words) => Uint8Array.from(bech32.fromWords(words));

export function decodeInvoice(input) {
  const s = String(input || '').trim().toLowerCase().replace(/^lightning:/, '');
  const { prefix, words } = bech32.decode(s, Number.MAX_SAFE_INTEGER);
  const hrp = /^ln([a-z]+?)(\d+[munp]?)?$/.exec(prefix);
  if (!hrp) throw new Error('not a Lightning invoice');
  // Last 104 words (65 bytes) are the signature.
  const data = words.slice(0, -104);
  if (data.length < 7) throw new Error('invoice too short');
  const timestamp = data.slice(0, 7).reduce((a, w) => a * 32 + w, 0);
  const out = { invoice: s, network: hrp[1], amountMsat: parseAmount(hrp[2]), timestamp, expiry: 3600, paymentHash: null, description: '', descriptionHash: null };
  let i = 7;
  while (i + 3 <= data.length) {
    const type = data[i];
    const len = data[i + 1] * 32 + data[i + 2];
    const field = data.slice(i + 3, i + 3 + len);
    i += 3 + len;
    if (field.length !== len) throw new Error('truncated invoice');
    if (type === 1 && len === 52) out.paymentHash = bytesToHex(wordsToBytes(field).slice(0, 32));
    else if (type === 13) out.description = new TextDecoder().decode(wordsToBytes(field));
    else if (type === 23 && len === 52) out.descriptionHash = bytesToHex(wordsToBytes(field).slice(0, 32));
    else if (type === 6) out.expiry = field.reduce((a, w) => a * 32 + w, 0);
  }
  if (!out.paymentHash) throw new Error('invoice has no payment hash');
  out.expiresAt = out.timestamp + out.expiry;
  out.amountSats = out.amountMsat == null ? null : Number(out.amountMsat / 1000n);
  return out;
}

export function preimageMatches(preimageHex, paymentHash) {
  if (!/^[0-9a-f]{64}$/i.test(preimageHex || '')) return false;
  return bytesToHex(sha256(hexToBytes(preimageHex.toLowerCase()))) === paymentHash;
}
