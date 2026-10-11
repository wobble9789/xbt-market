// Unified opt-in signature hash, Bitcoin Knots PR #357, shipped in
// v29.4.1.knots20260508 and active on the BLAKE2b chain from block 961,640.
// Spec: doc/unified-sighash.md in that tag. Checked against the 166 vectors in
// src/test/data/unified_sighash.json (copied to test/data).
//
// A signature opts in by setting SIGHASH_UNIFIED (0x20) in its hash type, so
// SIGHASH_ALL becomes 0x21. Nodes on the SHA256d chain compute the legacy
// message for that byte and reject the signature, which is the replay protection.

import { sha256 } from '@noble/hashes/sha2.js';
import { concat, u32le, i64le, varBytes, taggedHash, hexToBytes, reversed } from './bytes.js';

export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_UNIFIED = 0x20;
export const SIGHASH_ANYONECANPAY = 0x80;
export const SIGHASH_ALL_UNIFIED = SIGHASH_ALL | SIGHASH_UNIFIED;

export const SCRIPT_TYPE_BASE = 0;
export const SCRIPT_TYPE_WITNESS_V0 = 1;
export const SCRIPT_TYPE_TAPROOT = 2;
export const SCRIPT_TYPE_TAPSCRIPT = 3;

const outpoint = (inp) => concat(inp.txidLE ?? reversed(hexToBytes(inp.txid)), u32le(inp.vout));
const output = (o) => concat(i64le(o.value), varBytes(o.script));

export function tapleafHash(script, version = 0xc0) {
  return taggedHash('TapLeaf', concat(Uint8Array.of(version), varBytes(script)));
}

// tx: { version, locktime, inputs: [{ txid (display hex) | txidLE, vout, sequence }],
//       outputs: [{ value, script }] }
// spent: one { value, script } per input, in input order.
// opts.scriptCode for script types 0 and 1; opts.annex, opts.tapleafHash or
// opts.leafScript, opts.codeseparatorPos for taproot.
export function unifiedSighash(tx, inIdx, hashType, scriptType, spent, opts = {}) {
  if (!(hashType & SIGHASH_UNIFIED)) throw new Error('hash type does not set SIGHASH_UNIFIED');
  if (inIdx < 0 || inIdx >= tx.inputs.length) throw new Error('input index out of range');
  if (spent.length !== tx.inputs.length) throw new Error('need one spent output per input');
  const taproot = scriptType === SCRIPT_TYPE_TAPROOT || scriptType === SCRIPT_TYPE_TAPSCRIPT;
  const base = hashType & 0x1f;
  const acp = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  if (taproot && ((hashType & ~(0x1f | SIGHASH_ANYONECANPAY | SIGHASH_UNIFIED)) || base < 1 || base > 3)) {
    throw new Error('undefined hash type for taproot');
  }

  const m = [Uint8Array.of(0, hashType & 0xff), u32le(tx.version), u32le(tx.locktime), Uint8Array.of(0)];
  if (!acp) {
    m.push(sha256(concat(...tx.inputs.map(outpoint))));
    m.push(sha256(concat(...spent.map((s) => i64le(s.value)))));
    m.push(sha256(concat(...spent.map((s) => varBytes(s.script)))));
    m.push(sha256(concat(...tx.inputs.map((i) => u32le(i.sequence)))));
  }
  if (base !== SIGHASH_NONE && base !== SIGHASH_SINGLE) m.push(sha256(concat(...tx.outputs.map(output))));
  m.push(Uint8Array.of(scriptType));
  if (acp) {
    const inp = tx.inputs[inIdx];
    m.push(outpoint(inp), output(spent[inIdx]), u32le(inp.sequence));
  } else {
    m.push(u32le(inIdx));
  }
  if (!taproot) {
    if (!opts.scriptCode) throw new Error('scriptCode required for script types 0 and 1');
    m.push(varBytes(opts.scriptCode));
  } else if (opts.annex) {
    m.push(Uint8Array.of(1), sha256(varBytes(opts.annex)));
  } else {
    m.push(Uint8Array.of(0));
  }
  if (base === SIGHASH_SINGLE) {
    if (inIdx >= tx.outputs.length) throw new Error('SIGHASH_SINGLE with no output at this index');
    m.push(sha256(output(tx.outputs[inIdx])));
  }
  if (scriptType === SCRIPT_TYPE_TAPSCRIPT) {
    const leaf = opts.tapleafHash ?? (opts.leafScript && tapleafHash(opts.leafScript));
    if (!leaf) throw new Error('tapleaf hash required for tapscript');
    m.push(leaf, Uint8Array.of(0), u32le(opts.codeseparatorPos ?? 0xffffffff));
  }
  return taggedHash('UnifiedSighash', concat(...m));
}
