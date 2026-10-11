// 2-of-3 P2WSH escrow between buyer, seller and arbiter.
//
// Keys:
//   buyer / seller: a fresh key per trade, HMAC(nostr secret, tradeId). Nothing
//     to back up beyond the Nostr key.
//   arbiter: a published base key plus a public per-trade tweak, so a buyer can
//     build the escrow address while the arbiter is offline:
//       P = P_base + t*G,  t = H("xbt-market/arbiter-tweak", P_base || tradeId)
//
// Every escrow spend is signed with SIGHASH_ALL|SIGHASH_UNIFIED (0x21) so it is
// valid on the BLAKE2b chain only and cannot be replayed onto the SHA256d chain.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, concat, compareBytes, taggedHash } from './bytes.js';
import { addressToScript, scriptToAddress } from './address.js';
import { unifiedSighash, SIGHASH_ALL_UNIFIED, SCRIPT_TYPE_WITNESS_V0 } from './unified.js';
import { serializeTx, txid as computeTxid, vsize } from './tx.js';

const { Point } = secp256k1;
const N = Point.Fn.ORDER;
const utf8 = (s) => new TextEncoder().encode(s);

export const DUST_LIMIT = 546;
export const RBF_SEQUENCE = 0xfffffffd;

const toBig = (b) => BigInt('0x' + (bytesToHex(b) || '0'));
const fromBig = (n) => hexToBytes(n.toString(16).padStart(64, '0'));

function scalarFrom(bytes) {
  const n = toBig(bytes) % N;
  if (n === 0n) throw new Error('derived key is zero');
  return n;
}

export const pubkeyOf = (sk) => bytesToHex(secp256k1.getPublicKey(sk, true));

export function deriveTradeKey(nostrSecret, tradeId) {
  return fromBig(scalarFrom(hmac(sha256, nostrSecret, utf8('xbt-market/escrow/v1/' + tradeId))));
}

export function arbiterBaseKey(nostrSecret) {
  return fromBig(scalarFrom(hmac(sha256, nostrSecret, utf8('xbt-market/arbiter/v1'))));
}

function arbiterTweak(basePubHex, tradeId) {
  return scalarFrom(taggedHash('xbt-market/arbiter-tweak', concat(hexToBytes(basePubHex), utf8(tradeId))));
}

export function arbiterTradePubkey(basePubHex, tradeId) {
  const p = Point.fromHex(basePubHex).add(Point.BASE.multiply(arbiterTweak(basePubHex, tradeId)));
  return bytesToHex(p.toBytes(true));
}

export function arbiterTradeKey(nostrSecret, tradeId) {
  const base = arbiterBaseKey(nostrSecret);
  const sk = (toBig(base) + arbiterTweak(pubkeyOf(base), tradeId)) % N;
  if (sk === 0n) throw new Error('derived key is zero');
  return fromBig(sk);
}

export function isValidPubkey(hex) {
  try { return hex.length === 66 && !!Point.fromHex(hex); } catch { return false; }
}

// ---- script and address ----------------------------------------------------

export function multisigScript(pubkeysHex) {
  if (pubkeysHex.length !== 3) throw new Error('need three pubkeys');
  const keys = pubkeysHex.map(hexToBytes).sort(compareBytes); // BIP67 order
  if (new Set(keys.map(bytesToHex)).size !== 3) throw new Error('duplicate escrow pubkey');
  for (const k of keys) if (!isValidPubkey(bytesToHex(k))) throw new Error('invalid escrow pubkey');
  return concat(Uint8Array.of(0x52), ...keys.map((k) => concat(Uint8Array.of(33), k)), Uint8Array.of(0x53, 0xae));
}

export function scriptPubkeys(witnessScript) {
  const keys = [];
  for (let o = 1; o < witnessScript.length - 2; o += 34) keys.push(bytesToHex(witnessScript.subarray(o + 1, o + 34)));
  return keys;
}

export const p2wsh = (witnessScript) => concat(Uint8Array.of(0x00, 0x20), sha256(witnessScript));

export function escrowInfo({ buyer, seller, arbiter }, network) {
  const ws = multisigScript([buyer, seller, arbiter]);
  const spk = p2wsh(ws);
  return {
    witnessScript: bytesToHex(ws),
    scriptPubKey: bytesToHex(spk),
    address: scriptToAddress(spk, network),
    pubkeys: scriptPubkeys(ws),
  };
}

// ---- payout ------------------------------------------------------------------

const DUMMY_SIG = new Uint8Array(73);

function unsignedTx(utxos, outputs, network) {
  return {
    version: 2,
    locktime: 0,
    inputs: utxos.map((u) => ({ txid: u.txid, vout: u.vout, sequence: RBF_SEQUENCE, witness: [] })),
    outputs: outputs.map((o) => ({ value: BigInt(o.sats), script: addressToScript(o.address, network) })),
  };
}

export function estimateVsize(utxos, outputs, witnessScript, network) {
  const tx = unsignedTx(utxos, outputs, network);
  for (const i of tx.inputs) i.witness = [new Uint8Array(), DUMMY_SIG, DUMMY_SIG, witnessScript];
  return vsize(tx);
}

// allocations: [{ address, sats, role? }] whose sats sum to the escrow balance.
// The network fee is taken from every output in proportion to its share; an
// output that would fall under the dust limit is dropped and goes to the fee.
export function planPayout({ utxos, allocations, feeRate, witnessScript, network }) {
  if (!utxos.length) throw new Error('escrow has no coins');
  const total = utxos.reduce((s, u) => s + u.value, 0);
  const allocated = allocations.reduce((s, a) => s + a.sats, 0);
  if (allocated !== total) throw new Error(`allocations (${allocated}) must equal escrow balance (${total})`);
  const ws = typeof witnessScript === 'string' ? hexToBytes(witnessScript) : witnessScript;

  let outs = allocations.filter((a) => a.sats > 0);
  let fee = 0;
  for (let round = 0; round < 3; round++) {
    fee = Math.ceil(estimateVsize(utxos, outs, ws, network) * feeRate);
    const avail = total - fee;
    if (avail <= 0) throw new Error('escrow balance does not cover the network fee');
    const shared = outs.map((a) => ({ ...a, sats: Math.floor((a.sats * avail) / total) }));
    const rest = avail - shared.reduce((s, a) => s + a.sats, 0);
    shared.reduce((m, a) => (a.sats > m.sats ? a : m)).sats += rest;
    const kept = shared.filter((a) => a.sats >= DUST_LIMIT);
    if (kept.length === shared.length) {
      outs = kept;
      fee = total - kept.reduce((s, a) => s + a.sats, 0);
      break;
    }
    // Recompute shares without the dust outputs; their amount ends up in the fee.
    const dropped = new Set(shared.filter((a) => a.sats < DUST_LIMIT).map((a) => a.address + a.role));
    outs = outs.filter((a) => !dropped.has(a.address + a.role));
    if (!outs.length) throw new Error('nothing left to pay out after fees');
  }
  const tx = unsignedTx(utxos, outs, network);
  return { tx, outputs: outs, fee, vsize: estimateVsize(utxos, outs, ws, network), txHex: bytesToHex(serializeTx(tx)) };
}

function spentOutputs(utxos, witnessScript) {
  const script = p2wsh(witnessScript);
  return utxos.map((u) => ({ value: BigInt(u.value), script }));
}

export function escrowSighash(tx, utxos, witnessScript, idx) {
  const ws = typeof witnessScript === 'string' ? hexToBytes(witnessScript) : witnessScript;
  return unifiedSighash(tx, idx, SIGHASH_ALL_UNIFIED, SCRIPT_TYPE_WITNESS_V0, spentOutputs(utxos, ws), { scriptCode: ws });
}

// Returns one hex signature (DER + 0x21) per input.
export function signEscrow(tx, utxos, witnessScript, secretKey) {
  return tx.inputs.map((_, i) => {
    const der = secp256k1.sign(escrowSighash(tx, utxos, witnessScript, i), secretKey, { prehash: false, format: 'der', lowS: true });
    return bytesToHex(concat(der, Uint8Array.of(SIGHASH_ALL_UNIFIED)));
  });
}

export function verifyEscrowSig(tx, utxos, witnessScript, idx, pubkeyHex, sigHex) {
  try {
    const sig = hexToBytes(sigHex);
    if (sig[sig.length - 1] !== SIGHASH_ALL_UNIFIED) return false;
    return secp256k1.verify(sig.subarray(0, -1), escrowSighash(tx, utxos, witnessScript, idx), hexToBytes(pubkeyHex), { prehash: false, format: 'der', lowS: true });
  } catch {
    return false;
  }
}

export function verifyEscrowSigs(tx, utxos, witnessScript, pubkeyHex, sigs) {
  return Array.isArray(sigs) && sigs.length === tx.inputs.length &&
    sigs.every((s, i) => verifyEscrowSig(tx, utxos, witnessScript, i, pubkeyHex, s));
}

// sigsByPubkey: { [pubkeyHex]: [sigHex per input] } with at least two signers.
export function finalizeEscrow(tx, utxos, witnessScript, sigsByPubkey) {
  const ws = typeof witnessScript === 'string' ? hexToBytes(witnessScript) : witnessScript;
  const signers = scriptPubkeys(ws).filter((pk) => sigsByPubkey[pk] && verifyEscrowSigs(tx, utxos, ws, pk, sigsByPubkey[pk]));
  if (signers.length < 2) throw new Error('need valid signatures from two of the three escrow keys');
  const use = signers.slice(0, 2); // already in script order
  const signed = {
    ...tx,
    inputs: tx.inputs.map((inp, i) => ({ ...inp, witness: [new Uint8Array(), ...use.map((pk) => hexToBytes(sigsByPubkey[pk][i])), ws] })),
  };
  return { hex: bytesToHex(serializeTx(signed)), txid: computeTxid(signed) };
}

// Checks that a tx only spends the given escrow coins, with nothing else mixed in.
export function txSpendsExactly(tx, utxos) {
  if (tx.inputs.length !== utxos.length) return false;
  return tx.inputs.every((inp, i) => inp.txid === utxos[i].txid && inp.vout === utxos[i].vout);
}

export function describeOutputs(tx, network) {
  return tx.outputs.map((o) => ({ address: scriptToAddress(o.script, network) ?? '(non-standard)', sats: Number(o.value) }));
}
