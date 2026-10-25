// Watch-only wallet keys: a fresh receive address for every payout, so no
// address is ever used twice. The user pastes what their wallet shows
// (Shrike/Sparrow: Settings → the account's xpub, or Export → output
// descriptor); only the public key leaves the wallet, and only single
// addresses derived from it are ever sent to anyone.
//
// Accepted: wpkh(…), sh(wpkh(…)) and tr(…) descriptors with an optional key
// origin and /0/* or /<0;1>/* path, and bare xpub/ypub/zpub (tpub/upub/vpub
// for test networks). Addresses come from the receive chain: …/0/index.

import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { concat } from './bytes.js';
import { scriptToAddress } from './address.js';

const base58check = createBase58check(sha256);
const hash160 = (b) => ripemd160(sha256(b));

// SLIP-132 version bytes: which network and which address type a bare key implies.
const VERSIONS = {
  '0488b21e': { test: false, kind: 'wpkh', named: false }, // xpub (type unknown: native segwit assumed)
  '049d7cb2': { test: false, kind: 'sh-wpkh', named: true }, // ypub
  '04b24746': { test: false, kind: 'wpkh', named: true }, // zpub
  '043587cf': { test: true, kind: 'wpkh', named: false }, // tpub
  '044a5262': { test: true, kind: 'sh-wpkh', named: true }, // upub
  '045f1cf6': { test: true, kind: 'wpkh', named: true }, // vpub
};
const STANDARD = { false: '0488b21e', true: '043587cf' };

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

function hdFromString(key, network) {
  let raw;
  try { raw = base58check.decode(key); } catch { throw new Error('not a valid extended public key (xpub)'); }
  if (raw.length !== 78) throw new Error('not a valid extended public key (xpub)');
  const v = VERSIONS[hex(raw.subarray(0, 4))];
  if (!v) throw new Error('this is not a public key: paste the xpub, never a private key or seed');
  if (v.test !== (network !== 'mainnet')) throw new Error(network === 'mainnet' ? 'this key is for a test network' : 'this key is for mainnet');
  const std = Uint8Array.from(raw);
  std.set(Uint8Array.from(STANDARD[v.test].match(/../g).map((h) => parseInt(h, 16))), 0);
  const versions = v.test ? { private: 0x04358394, public: 0x043587cf } : { private: 0x0488ade4, public: 0x0488b21e };
  return { hd: HDKey.fromExtendedKey(base58check.encode(std), versions), ...v };
}

// { kind: 'wpkh' | 'sh-wpkh' | 'tr', hd, chainPath: [0] | [], assumed } or throws.
export function parseWalletKey(input, network = 'mainnet') {
  let s = String(input || '').trim().replace(/#[a-z0-9]{8}$/, '').replace(/\s+/g, '');
  if (!s) throw new Error('empty');
  let kind = null;
  const wrap = [['sh(wpkh(', 'sh-wpkh', '))'], ['wpkh(', 'wpkh', ')'], ['tr(', 'tr', ')']].find(([open, , close]) => s.startsWith(open) && s.endsWith(close));
  if (wrap) { kind = wrap[1]; s = s.slice(wrap[0].length, -wrap[2].length); } else if (/^[a-z]+\(/.test(s)) throw new Error('only wpkh(), sh(wpkh()) and tr() descriptors are supported');
  s = s.replace(/^\[[0-9a-fA-F]{8}(\/[0-9]+['hH]?)*\]/, ''); // key origin
  const m = s.match(/^([1-9A-HJ-NP-Za-km-z]+)((?:\/[0-9]+)*)(\/(?:\*|<0;1>\/\*|0\/\*))?$/);
  if (!m) throw new Error('could not read this key');
  const { hd, kind: implied, named } = hdFromString(m[1], network);
  let base = hd;
  for (const step of m[2].split('/').filter(Boolean)) base = base.deriveChild(Number(step));
  // A descriptor ending in /0/* or /<0;1>/* gives the receive chain; one
  // ending in a bare /* already points at it; a bare key is an account key.
  const chain = m[3] === '/*' ? [] : [0];
  return { kind: kind || implied, hd: base, chainPath: chain, assumed: !kind && !named };
}

const TAP_TWEAK = (x) => schnorr.utils.taggedHash('TapTweak', x);

export function deriveAddress(wallet, index, network = 'mainnet') {
  let node = wallet.hd;
  for (const c of wallet.chainPath) node = node.deriveChild(c);
  const pub = node.deriveChild(index).publicKey;
  if (wallet.kind === 'wpkh') return scriptToAddress(concat(Uint8Array.of(0x00, 0x14), hash160(pub)), network);
  if (wallet.kind === 'sh-wpkh') {
    const redeem = concat(Uint8Array.of(0x00, 0x14), hash160(pub));
    return scriptToAddress(concat(Uint8Array.of(0xa9, 0x14), hash160(redeem), Uint8Array.of(0x87)), network);
  }
  // Taproot key-path (BIP86): Q = P + H_TapTweak(P)·G, P with an even y.
  const P = secp256k1.Point.fromBytes(pub);
  const even = P.y % 2n === 0n ? P : P.negate();
  const x = even.toBytes(true).subarray(1);
  const t = BigInt('0x' + hex(TAP_TWEAK(x)));
  const Q = even.add(secp256k1.Point.BASE.multiply(t));
  return scriptToAddress(concat(Uint8Array.of(0x51, 0x20), Q.toBytes(true).subarray(1)), network);
}
