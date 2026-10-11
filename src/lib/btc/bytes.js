// Byte helpers shared by the transaction, sighash and escrow code.

import { sha256 } from '@noble/hashes/sha2.js';

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export const reversed = (b) => Uint8Array.from(b).reverse();

export function u32le(n) {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

export function i64le(v) {
  const out = new Uint8Array(8);
  let t = BigInt.asUintN(64, BigInt(v));
  for (let i = 0; i < 8; i++) { out[i] = Number(t & 0xffn); t >>= 8n; }
  return out;
}

export function compactSize(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  if (n <= 0xffffffff) return concat(Uint8Array.of(0xfe), u32le(n));
  throw new Error('compactSize: value too large');
}

export const varBytes = (b) => concat(compactSize(b.length), b);

export const sha256d = (b) => sha256(sha256(b));

export function taggedHash(tag, msg) {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concat(t, t, msg));
}

export class Reader {
  constructor(bytes) { this.b = bytes; this.o = 0; }
  take(n) {
    if (this.o + n > this.b.length) throw new Error('truncated');
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  u8() { return this.take(1)[0]; }
  u32() { const b = this.take(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; }
  i64() {
    const b = this.take(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return BigInt.asIntN(64, v);
  }
  cs() {
    const first = this.u8();
    if (first < 0xfd) return first;
    const size = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    let v = 0n;
    const b = this.take(size);
    for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return Number(v);
  }
  varBytes() { return this.take(this.cs()); }
  get done() { return this.o === this.b.length; }
}
