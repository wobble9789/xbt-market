// Raw transaction parsing and serialization (legacy and segwit forms).
// Inputs carry `txid` in display (big-endian) hex; outputs carry value as BigInt.

import { Reader, concat, compactSize, u32le, i64le, varBytes, sha256d, bytesToHex, hexToBytes, reversed } from './bytes.js';

export function parseTx(bytes) {
  if (typeof bytes === 'string') bytes = hexToBytes(bytes);
  const r = new Reader(bytes);
  const version = r.u32();
  let segwit = false;
  if (bytes[r.o] === 0x00 && bytes[r.o + 1] === 0x01) { segwit = true; r.o += 2; }
  const inputs = [];
  for (let i = 0, n = r.cs(); i < n; i++) {
    const txidLE = r.take(32);
    inputs.push({ txid: bytesToHex(reversed(txidLE)), txidLE, vout: r.u32(), scriptSig: r.varBytes(), sequence: r.u32(), witness: [] });
  }
  const outputs = [];
  for (let i = 0, n = r.cs(); i < n; i++) outputs.push({ value: r.i64(), script: r.varBytes() });
  if (segwit) for (const inp of inputs) for (let j = 0, n = r.cs(); j < n; j++) inp.witness.push(r.varBytes());
  const locktime = r.u32();
  if (!r.done) throw new Error('trailing bytes after transaction');
  return { version, inputs, outputs, locktime };
}

export function serializeTx(tx, { witness = true } = {}) {
  const hasWitness = witness && tx.inputs.some((i) => i.witness && i.witness.length);
  const parts = [u32le(tx.version)];
  if (hasWitness) parts.push(Uint8Array.of(0, 1));
  parts.push(compactSize(tx.inputs.length));
  for (const i of tx.inputs) {
    parts.push(reversed(hexToBytes(i.txid)), u32le(i.vout), varBytes(i.scriptSig ?? new Uint8Array()), u32le(i.sequence));
  }
  parts.push(compactSize(tx.outputs.length));
  for (const o of tx.outputs) parts.push(i64le(o.value), varBytes(o.script));
  if (hasWitness) {
    for (const i of tx.inputs) {
      const w = i.witness ?? [];
      parts.push(compactSize(w.length), ...w.map(varBytes));
    }
  }
  parts.push(u32le(tx.locktime));
  return concat(...parts);
}

export const txid = (tx) => bytesToHex(reversed(sha256d(serializeTx(tx, { witness: false }))));

export function vsize(tx) {
  const base = serializeTx(tx, { witness: false }).length;
  const total = serializeTx(tx).length;
  return Math.ceil((base * 3 + total) / 4);
}
