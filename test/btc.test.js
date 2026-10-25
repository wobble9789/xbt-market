import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes, bytesToHex } from '../src/lib/btc/bytes.js';
import { parseTx, serializeTx, txid } from '../src/lib/btc/tx.js';
import { unifiedSighash } from '../src/lib/btc/unified.js';
import { addressToScript, scriptToAddress, isValidAddress } from '../src/lib/btc/address.js';
import {
  deriveTradeKey, arbiterBaseKey, arbiterTradeKey, arbiterTradePubkey, pubkeyOf, escrowInfo,
  planPayout, signEscrow, verifyEscrowSigs, finalizeEscrow, DUST_LIMIT,
} from '../src/lib/btc/escrow.js';

test('unified sighash matches all Knots vectors', () => {
  const [header, ...rows] = JSON.parse(readFileSync(new URL('./data/unified_sighash.json', import.meta.url)));
  assert.equal(header.join(), 'scriptCode,rawTx,inIdx,hashType,scriptType,spentOutputs,sighash');
  assert.equal(rows.length, 166);
  for (const [sc, raw, inIdx, hashType, scriptType, spent, expected] of rows) {
    const tx = parseTx(raw);
    const spentOutputs = spent.map(([v, s]) => ({ value: BigInt(v), script: hexToBytes(s) }));
    const code = hexToBytes(sc);
    const opts = scriptType === 3 ? { leafScript: code } : { scriptCode: code };
    assert.equal(bytesToHex(unifiedSighash(tx, inIdx, hashType, scriptType, spentOutputs, opts)), expected,
      `type ${scriptType} hashType ${hashType} in ${inIdx}`);
  }
});

test('tx parse/serialize round trips', () => {
  const [, ...rows] = JSON.parse(readFileSync(new URL('./data/unified_sighash.json', import.meta.url)));
  for (const row of rows.slice(0, 40)) assert.equal(bytesToHex(serializeTx(parseTx(row[1]))), row[1]);
});

test('addresses', () => {
  const cases = [
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mainnet', '0014751e76e8199196d454941c45d1b3a323f1433bd6'],
    ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'mainnet', '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'],
    ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'mainnet', '76a91477bff20c60e522dfaa3350c39b030a5d004e839a88ac'],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'mainnet', 'a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87'],
  ];
  for (const [a, n, spk] of cases) {
    assert.equal(bytesToHex(addressToScript(a, n)), spk, a);
    assert.equal(scriptToAddress(hexToBytes(spk), n), a);
  }
  assert.equal(isValidAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'testnet4'), false);
  assert.equal(isValidAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'mainnet'), false);
  // bech32 (not bech32m) encoding of a v1 program must be refused
  assert.equal(isValidAddress('bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx', 'mainnet'), false);
});

const nostr = (s) => secp256k1.utils.randomSecretKey(new Uint8Array(48).fill(s));

test('arbiter tweak: public derivation equals private derivation', () => {
  const sk = nostr(7);
  const base = pubkeyOf(arbiterBaseKey(sk));
  for (const id of ['a', 'trade-123', 'ff'.repeat(16)]) {
    assert.equal(arbiterTradePubkey(base, id), pubkeyOf(arbiterTradeKey(sk, id)));
  }
  assert.notEqual(pubkeyOf(deriveTradeKey(sk, 'x')), pubkeyOf(deriveTradeKey(sk, 'y')));
});

function fixture() {
  const id = 'deadbeef';
  const [b, s, a] = [nostr(1), nostr(2), nostr(3)];
  const keys = { buyer: deriveTradeKey(b, id), seller: deriveTradeKey(s, id), arbiter: arbiterTradeKey(a, id) };
  const esc = escrowInfo({
    buyer: pubkeyOf(keys.buyer), seller: pubkeyOf(keys.seller),
    arbiter: arbiterTradePubkey(pubkeyOf(arbiterBaseKey(a)), id),
  }, 'mainnet');
  const utxos = [{ txid: 'aa'.repeat(32), vout: 0, value: 120_000 }, { txid: 'bb'.repeat(32), vout: 3, value: 30_000 }];
  return { keys, esc, utxos };
}

test('escrow 2-of-3: plan, sign, verify, finalize', () => {
  const { keys, esc, utxos } = fixture();
  assert.match(esc.address, /^bc1q[a-z0-9]{58}$/);
  const plan = planPayout({
    utxos, feeRate: 2, witnessScript: esc.witnessScript, network: 'mainnet',
    allocations: [
      { role: 'seller', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', sats: 135_000 },
      { role: 'buyer', address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', sats: 15_000 },
    ],
  });
  assert.equal(plan.outputs.reduce((s, o) => s + o.sats, 0) + plan.fee, 150_000);
  assert.ok(plan.fee >= plan.vsize * 2);
  const sigB = signEscrow(plan.tx, utxos, esc.witnessScript, keys.buyer);
  const sigS = signEscrow(plan.tx, utxos, esc.witnessScript, keys.seller);
  const pkB = pubkeyOf(keys.buyer), pkS = pubkeyOf(keys.seller), pkA = pubkeyOf(keys.arbiter);
  assert.ok(verifyEscrowSigs(plan.tx, utxos, esc.witnessScript, pkB, sigB));
  assert.ok(!verifyEscrowSigs(plan.tx, utxos, esc.witnessScript, pkS, sigB));
  // a different amount for any input changes the message (CVE-2020-14199 closed)
  const lied = utxos.map((u, i) => (i ? { ...u, value: u.value + 1 } : u));
  assert.ok(!verifyEscrowSigs(plan.tx, lied, esc.witnessScript, pkB, sigB));
  assert.throws(() => finalizeEscrow(plan.tx, utxos, esc.witnessScript, { [pkB]: sigB }));
  const fin = finalizeEscrow(plan.tx, utxos, esc.witnessScript, { [pkB]: sigB, [pkS]: sigS });
  const parsed = parseTx(fin.hex);
  assert.equal(parsed.inputs[0].witness.length, 4);
  assert.equal(txid(parsed), fin.txid);
  // arbiter + seller also works
  const sigA = signEscrow(plan.tx, utxos, esc.witnessScript, keys.arbiter);
  assert.ok(finalizeEscrow(plan.tx, utxos, esc.witnessScript, { [pkA]: sigA, [pkS]: sigS }).hex);
});

test('payout drops dust outputs into the fee', () => {
  const { esc, utxos } = fixture();
  const plan = planPayout({
    utxos, feeRate: 1, witnessScript: esc.witnessScript, network: 'mainnet',
    allocations: [
      { role: 'seller', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', sats: 149_700 },
      { role: 'buyer', address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', sats: 300 },
    ],
  });
  assert.equal(plan.outputs.length, 1);
  assert.ok(plan.outputs.every((o) => o.sats >= DUST_LIMIT));
  assert.equal(plan.outputs[0].sats + plan.fee, 150_000);
});

test('a pasted node address becomes its API address', async () => {
  const { normalizeNodeUrl } = await import('../src/lib/btc/esplora.js');
  assert.equal(normalizeNodeUrl(' https://mempool-abc.local/ '), 'https://mempool-abc.local/api');
  assert.equal(normalizeNodeUrl('https://mempool-abc.local'), 'https://mempool-abc.local/api');
  assert.equal(normalizeNodeUrl('https://mempool-abc.local/api/'), 'https://mempool-abc.local/api');
  assert.equal(normalizeNodeUrl('http://abc.onion/api'), 'http://abc.onion/api');
  assert.equal(normalizeNodeUrl('https://mempool.guide/testnet4/api'), 'https://mempool.guide/testnet4/api');
});
