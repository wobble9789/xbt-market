// BOLT11-shaped invoices for tests and the mock wallet. The signature is left
// as zeros: this app reads amount and payment hash and never checks it.
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32 } from '@scure/base';

const hex = (b) => Buffer.from(b).toString('hex');

function toWords(n, len) {
  const w = [];
  for (let i = 0; i < len; i++) { w.unshift(n % 32); n = Math.floor(n / 32); }
  return w;
}
function field(type, bytes) {
  const words = bech32.toWords(bytes);
  return [type, ...toWords(words.length, 2), ...words];
}

// blake2b: mark it as a Lightning Fork (XBT) invoice, feature bit 512.
export function fakeInvoice({ sats, network = 'bc', preimage = new Uint8Array(32).fill(7), description = 'test', timestamp = Math.floor(Date.now() / 1000), expiry = 3600, blake2b = false }) {
  const amount = sats == null ? '' : `${sats * 10}n`; // 1 sat = 10 nano-coin
  const hash = sha256(preimage);
  const words = [
    ...toWords(timestamp, 7), ...field(1, hash), ...field(13, new TextEncoder().encode(description)),
    6, ...toWords(4, 2), ...toWords(expiry, 4),
    ...(blake2b ? [5, ...toWords(103, 2), 4, ...new Array(102).fill(0)] : []),
    ...new Array(104).fill(0),
  ];
  return { invoice: bech32.encode(`ln${network}${amount}`, words, 5000), paymentHash: hex(hash), preimage: hex(preimage) };
}
