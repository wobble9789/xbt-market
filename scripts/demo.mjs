// One command to try the app locally without real money:
//   npm run demo
// Starts a local Nostr relay, three pretend Lightning wallets (NWC) and the
// app on http://localhost:5173, pointed at them. Open it in two browser
// windows (e.g. a normal and a private one) to play buyer and seller.
// Escrow and on-chain payments additionally need a regtest node; see README.
import { spawn } from 'node:child_process';

const procs = [];
function run(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map((l) => `[${name}] ${l}\n`).join('')));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  return p;
}
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run('relay', process.execPath, ['dev/relay.mjs', '7777']);
await new Promise((r) => setTimeout(r, 800));
run('wallets', process.execPath, ['dev/nwc-mock.mjs', 'ws://127.0.0.1:7777', 'bcrt']);
await new Promise((r) => setTimeout(r, 800));
run('app', process.execPath, ['scripts/build-bookmarklet.mjs']).on('exit', () => {
  run('app', process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5173', '--strictPort'], { VITE_RELAYS: 'ws://127.0.0.1:7777', VITE_NETWORK: 'regtest' });
});
setTimeout(() => console.log(`
==========================================================================
 Demo running at http://localhost:5173  (Ctrl+C stops everything)

 1. Window A (seller): create an account, then Account -> Lightning wallet ->
    paste the "seller" connection string printed above. Sell -> new listing
    (tick "Direct, Lightning"), publish.
 2. Window B (buyer, private window): create an account, connect the "buyer"
    wallet, open the listing -> Buy -> "Direct, Lightning" -> Send order.
 3. A: Accept -> "Create invoice with my wallet". B: "Pay with my wallet".
    A: Mark as shipped. B: Yes, received. Both: leave a review.
 Prices: set a manual rate under Account if the live rate is unavailable.
==========================================================================
`), 4000);
