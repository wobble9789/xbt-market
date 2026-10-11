// Address <-> scriptPubKey. The BLAKE2b chain kept Bitcoin's prefixes
// (1, 3, bc1 on mainnet; tb1 on testnet4), so these are Bitcoin's encodings.

import { bech32, bech32m, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat } from './bytes.js';

const base58check = createBase58check(sha256);

export const NETWORKS = {
  mainnet: { name: 'mainnet', hrp: 'bc', p2pkh: 0x00, p2sh: 0x05 },
  testnet4: { name: 'testnet4', hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4 },
  regtest: { name: 'regtest', hrp: 'bcrt', p2pkh: 0x6f, p2sh: 0xc4 },
};

const net = (n) => (typeof n === 'string' ? NETWORKS[n] : n) ?? NETWORKS.mainnet;

const OP_DUP = 0x76, OP_HASH160 = 0xa9, OP_EQUALVERIFY = 0x88, OP_CHECKSIG = 0xac, OP_EQUAL = 0x87;

function witnessScript(version, program) {
  return concat(Uint8Array.of(version === 0 ? 0 : 0x50 + version, program.length), program);
}

export function addressToScript(address, network) {
  const n = net(network);
  const a = address.trim();
  const lower = a.toLowerCase();
  if (lower.startsWith(n.hrp + '1')) {
    if (a !== lower && a !== a.toUpperCase()) throw new Error('mixed-case bech32 address');
    let dec, version;
    try {
      dec = bech32.decode(lower, 90);
      version = dec.words[0];
      if (version !== 0) throw new Error('v1+ must use bech32m');
    } catch {
      dec = bech32m.decode(lower, 90);
      version = dec.words[0];
      if (version === 0) throw new Error('v0 must use bech32');
    }
    if (dec.prefix !== n.hrp) throw new Error('wrong network');
    if (version > 16) throw new Error('invalid witness version');
    const program = Uint8Array.from(bech32.fromWords(dec.words.slice(1)));
    if (program.length < 2 || program.length > 40) throw new Error('invalid witness program');
    if (version === 0 && program.length !== 20 && program.length !== 32) throw new Error('invalid v0 program length');
    if (version === 1 && program.length !== 32) throw new Error('invalid taproot program length');
    return witnessScript(version, program);
  }
  const payload = base58check.decode(a);
  if (payload.length !== 21) throw new Error('invalid base58 address');
  const hash = payload.subarray(1);
  if (payload[0] === n.p2pkh) return concat(Uint8Array.of(OP_DUP, OP_HASH160, 20), hash, Uint8Array.of(OP_EQUALVERIFY, OP_CHECKSIG));
  if (payload[0] === n.p2sh) return concat(Uint8Array.of(OP_HASH160, 20), hash, Uint8Array.of(OP_EQUAL));
  throw new Error('wrong network');
}

export function isValidAddress(address, network) {
  try { addressToScript(address, network); return true; } catch { return false; }
}

export function scriptToAddress(script, network) {
  const n = net(network);
  const s = script;
  if (s.length === 25 && s[0] === OP_DUP && s[1] === OP_HASH160 && s[2] === 20 && s[23] === OP_EQUALVERIFY && s[24] === OP_CHECKSIG) {
    return base58check.encode(concat(Uint8Array.of(n.p2pkh), s.subarray(3, 23)));
  }
  if (s.length === 23 && s[0] === OP_HASH160 && s[1] === 20 && s[22] === OP_EQUAL) {
    return base58check.encode(concat(Uint8Array.of(n.p2sh), s.subarray(2, 22)));
  }
  if (s.length >= 4 && s.length <= 42 && (s[0] === 0 || (s[0] >= 0x51 && s[0] <= 0x60)) && s[1] === s.length - 2) {
    const version = s[0] === 0 ? 0 : s[0] - 0x50;
    const words = [version, ...bech32.toWords(s.subarray(2))];
    return (version === 0 ? bech32 : bech32m).encode(n.hrp, words, 90);
  }
  return null;
}
