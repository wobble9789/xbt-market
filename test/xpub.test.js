// Watch-only wallet keys: the BIP84/49/86 test vectors (from the seed
// "abandon … about"), descriptor forms, and refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWalletKey, deriveAddress } from '../src/lib/btc/xpub.js';

const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const XPUB84 = 'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
const YPUB = 'ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP';
const XPUB86 = 'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ';

test('BIP84: zpub, plain xpub and descriptor give the same native segwit addresses', () => {
  const want = ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'];
  for (const k of [ZPUB, XPUB84, `wpkh([73c5da0a/84h/0h/0h]${XPUB84}/0/*)`, `wpkh([73c5da0a/84'/0'/0']${XPUB84}/<0;1>/*)#abcdefgh`]) {
    const w = parseWalletKey(k, 'mainnet');
    assert.deepEqual([0, 1].map((i) => deriveAddress(w, i, 'mainnet')), want, k.slice(0, 20));
  }
  assert.equal(parseWalletKey(XPUB84, 'mainnet').assumed, true, 'a plain xpub does not name its address type');
  assert.equal(parseWalletKey(ZPUB, 'mainnet').assumed, false);
});

test('BIP49 (ypub) and BIP86 (tr descriptor)', () => {
  assert.equal(deriveAddress(parseWalletKey(YPUB, 'mainnet'), 0, 'mainnet'), '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
  assert.equal(deriveAddress(parseWalletKey(`tr(${XPUB86}/0/*)`, 'mainnet'), 0, 'mainnet'), 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
});

test('wrong network, private keys and other scripts are refused', () => {
  assert.throws(() => parseWalletKey(ZPUB, 'regtest'), /mainnet/);
  assert.throws(() => parseWalletKey('xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu', 'mainnet'), /not a public key/);
  assert.throws(() => parseWalletKey(`wsh(multi(2,${XPUB84}/0/*))`, 'mainnet'), /supported/);
  assert.throws(() => parseWalletKey('hello', 'mainnet'));
});
