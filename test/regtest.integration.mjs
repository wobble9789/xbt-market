// End-to-end check against a real Bitcoin Knots (BLAKE2b) regtest node:
// fund a 2-of-3 escrow, pay out with buyer+seller and with arbiter+seller,
// both signed with SIGHASH_ALL|UNIFIED, and have the node accept and mine them.
//
//   bitcoind -regtest -testactivationheight=blake2b@1 -rpcuser=u -rpcpassword=p -fallbackfee=0.0001
//   KNOTS_CLI="/path/bitcoin-cli -regtest -rpcuser=u -rpcpassword=p" node test/regtest.integration.mjs
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  deriveTradeKey, arbiterBaseKey, arbiterTradeKey, arbiterTradePubkey, pubkeyOf, escrowInfo,
  planPayout, signEscrow, finalizeEscrow,
} from '../src/lib/btc/escrow.js';

const CLI = process.env.KNOTS_CLI;
if (!CLI) { console.log('KNOTS_CLI not set, skipping'); process.exit(0); }
const cli = (...a) => execSync(`${CLI} ${a.map((x) => `'${x}'`).join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const json = (...a) => JSON.parse(cli(...a));

const info = json('getdeploymentinfo');
const dep = info.blake2b ?? info.deployments?.blake2b;
assert.ok(dep?.active, 'blake2b deployment must be active on this regtest node');
try { cli('loadwallet', 'w'); } catch {}
try { cli('createwallet', 'w'); } catch {}
const mine = (n = 1) => cli('generatetoaddress', String(n), cli('getnewaddress'));
if (Number(cli('getbalance')) < 10) mine(101);

async function run(label, signers) {
  const id = 'it-' + Date.now() + '-' + label;
  const nk = { buyer: secp256k1.utils.randomSecretKey(), seller: secp256k1.utils.randomSecretKey(), arbiter: secp256k1.utils.randomSecretKey() };
  const keys = { buyer: deriveTradeKey(nk.buyer, id), seller: deriveTradeKey(nk.seller, id), arbiter: arbiterTradeKey(nk.arbiter, id) };
  const esc = escrowInfo({
    buyer: pubkeyOf(keys.buyer), seller: pubkeyOf(keys.seller),
    arbiter: arbiterTradePubkey(pubkeyOf(arbiterBaseKey(nk.arbiter)), id),
  }, 'regtest');

  // buyer pays price + deposit, seller pays deposit, as two separate funding txs
  const f1 = cli('sendtoaddress', esc.address, '0.012');
  const f2 = cli('sendtoaddress', esc.address, '0.001');
  mine(1);
  const utxos = [f1, f2].map((t) => {
    const tx = json('getrawtransaction', t, 'true');
    const o = tx.vout.find((v) => v.scriptPubKey.address === esc.address);
    return { txid: t, vout: o.n, value: Math.round(o.value * 1e8) };
  });
  const sellerAddr = cli('getnewaddress', 'seller', 'bech32');
  const buyerAddr = cli('getnewaddress', 'buyer', 'bech32m');
  const plan = planPayout({
    utxos, feeRate: 2, witnessScript: esc.witnessScript, network: 'regtest',
    allocations: [{ role: 'seller', address: sellerAddr, sats: 1_100_000 }, { role: 'buyer', address: buyerAddr, sats: 200_000 }],
  });
  const sigs = Object.fromEntries(signers.map((r) => [pubkeyOf(keys[r]), signEscrow(plan.tx, utxos, esc.witnessScript, keys[r])]));
  const fin = finalizeEscrow(plan.tx, utxos, esc.witnessScript, sigs);
  const accept = json('testmempoolaccept', JSON.stringify([fin.hex]))[0];
  assert.ok(accept.allowed, `${label}: node rejected payout: ${accept['reject-reason']}`);
  assert.equal(cli('sendrawtransaction', fin.hex), fin.txid);
  mine(1);
  const tx = json('getrawtransaction', fin.txid, 'true');
  assert.ok(tx.confirmations >= 1);
  const decoded = json('decoderawtransaction', fin.hex);
  const ht = decoded.vin[0].txinwitness[1].slice(-2);
  console.log(`ok ${label}: ${esc.address} -> ${fin.txid} (vsize ${tx.vsize}, est ${plan.vsize}, fee ${plan.fee}, sighash byte 0x${ht})`);
  assert.equal(ht, '21');
}

await run('buyer+seller', ['buyer', 'seller']);
await run('arbiter+seller', ['arbiter', 'seller']);
await run('arbiter+buyer', ['buyer', 'arbiter']);
console.log('regtest integration passed');
