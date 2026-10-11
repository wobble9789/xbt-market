# XBT Market

A peer-to-peer marketplace paid in **Bitcoin BLAKE2b** (XBT / BTCB2), the chain that split from Bitcoin at block 961,640 (Bitcoin Knots `v29.4.1.knots20260508`).

- **No server, no app store.** It is a static web app (PWA) you can install on phone or desktop from any URL. Listings, profiles, reviews and encrypted trade chat live on **Nostr** relays.
- **Bisq-style escrow.** Every trade uses a **2-of-3 P2WSH multisig** between buyer, seller and a community **arbiter**. Both sides post a deposit. Buyer and seller release together; in a dispute the arbiter signs with one of them. Nobody can move the coins alone.
- **Replay-safe.** Every escrow spend is signed with `SIGHASH_ALL|SIGHASH_UNIFIED` (0x21), so it is valid on the BLAKE2b chain only.
- **Import from Marktplaats / 2dehands / Vinted / eBay.** A bookmark button reads your own listings from your profile page and copies them over. An eBay Seller Hub CSV works too. Re-importing recognises what is already here (by Marktplaats ad number, Vinted item id or eBay item number, falling back to title + price). It only adds what is new, updates listings whose price or title changed, and offers to mark listings as sold that disappeared from your profile there.
- **Ship however you like.** PostNL, DHL, InPost, Mondial Relay, Packlink, Sendcloud… The seller adds the tracking code.

> **Snel aan de slag (NL):** zet de app online (zie *Deploy*), maak in de app een account, zet jouw npub als `VITE_ADMIN_NPUB` en bouw opnieuw. Vraag een paar bekende community-leden om zich onder *Arbiter* aan te melden en keur ze goed onder *Admin*. Daarna kan iedereen handelen.

## How a trade works

1. **Offer.** The buyer offers an XBT amount (suggested from the SafeTrade XBT/USDT rate), picks an arbiter and sends the shipping address. Everything is NIP-17 encrypted to seller and arbiter.
2. **Accept.** The seller checks that the arbiter is approved and accepts. All three parties now derive the same escrow address.
3. **Fund.** The buyer pays price + deposit (default 15%); the seller pays a deposit (default 15%, set per listing). The app waits for the configured number of confirmations.
4. **Ship.** The seller ships and adds the carrier and tracking code.
5. **Release.** The buyer signs a payout (seller: price + deposit, buyer: deposit back). The seller co-signs and broadcasts. The network fee is shared in proportion.
6. **Dispute.** Either side opens a dispute. The arbiter reads the chat and proposes a split, and one party co-signs it. Buyer and seller can also agree on any split themselves at any time.
7. **Review.** Both parties publish a review that names the payout txid. Reviews from both sides with the same txid count as a *verified trade*. Trade limits for new accounts grow with verified trades.

### Keys

| Key | Derived from | Notes |
|---|---|---|
| Account | Nostr `nsec` | Back it up: it is the root of everything below |
| Buyer/seller escrow key | `HMAC-SHA256(nsec, "xbt-market/escrow/v1/" + tradeId)` | Fresh per trade |
| Arbiter base key | `HMAC-SHA256(nsec, "xbt-market/arbiter/v1")` | Published in the arbiter's announcement |
| Arbiter trade key | `P_base + H("xbt-market/arbiter-tweak", P_base ‖ tradeId)·G` | Buyers compute it without the arbiter online |

The escrow witness script and the three public keys are shown under *Recovery details* on every trade. Any two parties can move the coins with any wallet that supports P2WSH multisig and the unified sighash (Bitcoin Knots, Sparrow BLAKE2b build), even without this app.

### Trust model and safeguards

- **The arbiter list is the trust root.** The community admin (`VITE_ADMIN_NPUB`) publishes which arbiters are approved. A seller's app refuses to accept an offer whose arbiter, or arbiter escrow key, is not on that list. Otherwise a buyer could slip in a key they control. Users can add extra arbiters they trust under *Account*.
- **An arbiter colluding with one side can take the escrow.** That is inherent to 2-of-3, as in Bisq. Approve only well-known people.
- **The protocol log is authenticated.** Every message is a NIP-17 rumor inside a seal signed by its sender, and the trade state is a pure function of that log (`src/lib/trade/protocol.js`). Messages from non-participants are ignored. Proposal and co-sign signatures are verified against the escrow keys, and an accept can never be undone by a backdated cancel or reject.
- **Price risk.** The market is thin, so the XBT amount is fixed when the offer is made. Prices in EUR are only a reference.
- **Young chain.** Hashrate is small and rentable. Raise *minimum confirmations* for larger trades.

## Deploy

The build is a folder of static files (`dist/`) that works from any path.

**GitHub Pages (free, recommended):**
1. Create a GitHub repository and push this folder to `main`.
2. *Settings → Pages → Source: GitHub Actions.*
3. Open the deployed app, create an account, back up your nsec and copy your npub.
4. *Settings → Secrets and variables → Actions → Variables*: add `VITE_ADMIN_NPUB` = your npub, then re-run the workflow.

**Anything else:** run `npm ci && VITE_ADMIN_NPUB=npub1… npm run build`, then upload `dist/` to Netlify, Cloudflare Pages, your own web server or IPFS.

Users install it via the browser's *Add to Home screen* / *Install app*. No store is involved.

**Recommended later:** run a community Nostr relay (for example strfry or nostr-rs-relay) and add it to `DEFAULTS.relays` in `src/config.js`, so listings and messages do not depend on public relays only.

## Configuration

`src/config.js` holds the defaults: relays, Esplora API (`https://mempool.guide/api`), Blossom photo server, deposits, confirmations and trade limits. Users can override most of these under *Account*, including pointing the app at their own node's Esplora/mempool API.

## Develop

```sh
npm install          # on a shared folder without symlink support: npm install --no-bin-links
npm run dev          # http://localhost:5173
npm test             # unit tests (sighash vectors, escrow, protocol, import)
```

The browser console exposes `window.xbt` (stores and relay pool) for debugging.

## Testing

| Test | What it proves |
|---|---|
| `npm test` | All 166 Knots `unified_sighash.json` vectors; address encoding; 2-of-3 plan/sign/verify/finalize; the protocol reducer, including forged messages, a fake arbiter key, wrong-key signatures and backdated cancels/rejects; import parsing |
| `npm run test:regtest` | A real Knots BLAKE2b node accepts and mines escrow payouts signed buyer+seller, arbiter+seller and arbiter+buyer, all with sighash 0x21 |
| `npm run test:e2e` | The whole flow through the UI in Firefox: an arbiter announces, a seller lists, a buyer offers, the seller accepts, both fund on regtest, the seller ships, the buyer releases, the seller co-signs and broadcasts, the node confirms the payout, reviews become "verified". Then a dispute where the arbiter rules a refund and the buyer co-signs |
| `npm run test:import` | The bookmarklet against fake Vinted wardrobe, eBay list, JSON-LD product and paginated Marktplaats profile pages, through the real popup/postMessage handshake. Then a Marktplaats re-import (everything recognised) and a re-import after a price change and a removed ad |

Setup for the regtest and e2e tests:

```sh
bitcoind -regtest -testactivationheight=blake2b@1 -rpcuser=u -rpcpassword=p -fallbackfee=0.0001 -txindex=1 -daemon
npm run relay & npm run shim & npm run fixtures &
npm run build && npm run preview &
export KNOTS_CLI="bitcoin-cli -regtest -rpcuser=u -rpcpassword=p"
npm run test:regtest && npm run test:e2e && npm run test:import
```

The e2e tests use `puppeteer-core` with a local Firefox (`FIREFOX=/path/to/firefox`, `PROFILE_DIR` for the profile location). They open one browser context at a time, so every page rebuilds its trade state from the relay.

## Known limitations

- The Marktplaats import reads the Next.js data on your public seller page (`/u/<name>/<id>/`, paginated as `/p/2/`); it was tested against real saved Marktplaats pages (55 ads over two pages). Ads priced as "bieden" or "zie omschrijving" come in without a price for you to fill in. The Vinted import uses Vinted's internal wardrobe API (`/api/v2/wardrobe/{id}/items`) as the logged-in user, with a DOM fallback. It is tested against a mock, not the live site. If Vinted changes its site, the button may need an update (`src/bookmarklet/source.js`). eBay list scraping is similarly best-effort; single item pages use schema.org data and are the most robust.
- Imported photos stay hosted on Vinted/eBay. If you delete the item there, re-upload the photos.
- NIP-07 browser extensions are not supported, because the app needs the key to sign escrow payouts.
- Gift-wrapped messages rely on relays keeping them. Use *Account → Trade backup* for important trades.
- Not audited. Start with small amounts.

## Layout

```
src/lib/btc/       bytes, tx (de)serialization, addresses, unified sighash, escrow, Esplora client
src/lib/nostr/     account (NIP-49), relay pool, listings (NIP-99), inbox (NIP-17/59), arbiter directory,
                   reviews (NIP-32), profiles, Blossom uploads
src/lib/trade/     protocol reducer (pure) and actions (side effects)
src/lib/import/    Vinted/eBay/CSV normalisation
src/bookmarklet/   the import button
src/ui/            Preact UI, English + Dutch
dev/               local Nostr relay and Esplora shim for regtest
test/              unit, regtest and e2e tests
```

## License

MIT
