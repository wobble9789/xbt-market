# XBT Market

A peer-to-peer marketplace paid in **Bitcoin BLAKE2b** (XBT / BTCB2), the chain that split from Bitcoin at block 961,640 (Bitcoin Knots `v29.4.1.knots20260508`).

- **No app store, almost no server.** It is a static web app (PWA) you can install on phone or desktop from any URL. Listings, profiles, follows, reviews and encrypted trade chat live on **Nostr** relays. A small optional service (a free Cloudflare Worker, see *Service*) adds @usernames, live shipping rates with prepaid labels, and importing from a pasted link.
- **Chat first, like Marktplaats and Vinted.** A buyer sends a no-obligation message, and orders from the chat when ready: only the payment method, the price and the delivery country and carrier. Address, arbiter and refund address are asked once the seller accepts. Either side can ask to switch the payment method (say Lightning → on chain) until something is paid.
- **Bisq-style escrow.** Every trade uses a **2-of-3 P2WSH multisig** between buyer, seller and a community **arbiter**. Both sides post a deposit. Buyer and seller release together; in a dispute the arbiter signs with one of them. Nobody can move the coins alone.
- **Or pay directly.** For smaller items the buyer can skip escrow and pay the seller straight away, on chain or over **Lightning**. The app recommends escrow above €50. The seller sends a payment request in the chat; with a connected wallet the buyer pays with one tap, and the Lightning preimage proves the payment to both sides.
- **Your own Lightning wallet.** Connect any wallet that supports **Nostr Wallet Connect** (NWC): Alby Hub, Zeus, Primal, Coinos and others. A Lightning address works too for receiving.
- **Replay-safe.** Every escrow spend is signed with `SIGHASH_ALL|SIGHASH_UNIFIED` (0x21), so it is valid on the BLAKE2b chain only.
- **Import from Marktplaats / 2dehands / Vinted / eBay.** A bookmark button reads your own listings from your profile page and copies them over. An eBay Seller Hub CSV works too. Re-importing recognises what is already here (by Marktplaats ad number, Vinted item id or eBay item number, falling back to title + price). It only adds what is new, updates listings whose price or title changed, and offers to mark listings as sold that disappeared from your profile there.
- **Shipping like Vinted.** The seller ticks the carriers they are willing to use (PostNL, DHL, Mondial Relay, InPost, DPD, GLS, Colissimo, Correos…) and a parcel size; no price. The buyer picks a carrier for their country and pays its rate on top. With the service, the seller then buys a prepaid label (Sendcloud) paid over Lightning, and gets a QR code to show at the drop-off point (or a PDF) in the chat; the tracking code becomes a tracking link.
- **Marktplaats categories.** All 36 main categories and 1,954 subcategories of Marktplaats, so imports keep theirs. Listings carry a country and where the seller ships to (EU, worldwide, countries); buyers filter on category, country, price, condition, delivery and payment, and sort by date or price.
- **People.** Unique @usernames (NIP-05, like name@primal.net), search by @name, follow sellers (the standard Nostr contact list) and a feed of only the people you follow. English and Spanish; prices shown in 30+ currencies.
- **AI listing assistant.** Upload photos and Claude writes the title, description, category, condition and a price suggestion, like Marktplaats does. Each user brings their own Anthropic API key (see *AI assistant* below).

> **Snel aan de slag (NL):** zet de app online (zie *Deploy*), maak in de app een account, zet jouw npub als `VITE_ADMIN_NPUB` en bouw opnieuw. Vraag een paar bekende community-leden om zich onder *Arbiter* aan te melden en keur ze goed onder *Admin*. Daarna kan iedereen handelen.

## Documentation

- [docs/PROTOCOL.md](docs/PROTOCOL.md): the wire protocol, keys, escrow and state rules (enough to write a compatible client)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): module layout, invariants and which test guards each one
- `<app>/testplan.html`: a checklist for manual testing with real coins and real shop pages; tick tests off and copy the results

## How a trade works

1. **Message and order.** The buyer starts a conversation about a listing, and orders from the chat: an XBT amount (suggested from the SafeTrade XBT/USDT rate, item + shipping), the payment method and the delivery. Everything is NIP-17 encrypted.
2. **Accept, then details.** The seller accepts. The buyer then sends the delivery address and, with escrow, picks an approved arbiter and a refund address. The arbiter receives the trade so far, and all three derive the same escrow address. The seller's app warns not to pay into an escrow whose arbiter is not approved.
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

### Payout addresses: a new one every trade

Using one address for every trade lets everyone you traded with see all your payments. Under *Account → Trading* you paste your wallet's public key: an xpub/ypub/zpub, or a `wpkh()`, `sh(wpkh())` or `tr()` descriptor (Shrike/Sparrow: the account's *Settings → Keystores*, or *Export → Output descriptor*). The key is stored encrypted in the browser and never published. Each payout address, refund address, on-chain payment request and arbiter fee output then gets the next receive address (`…/0/i`) that is neither used on chain (Esplora `/address/:a`) nor already in one of your trades on any device. An address typed by hand gets a warning when it was used before. `src/lib/btc/xpub.js` matches the BIP84/49/86 vectors and Knots' own `deriveaddresses`.

Silent payments (BIP352) cannot be used here: escrow payouts spend a P2WSH multisig, and P2WSH inputs are not eligible for silent-payment outputs. No BLAKE2b wallet can receive them yet either.

### Trust model and safeguards

- **The arbiter list is the trust root.** The community admin (`VITE_ADMIN_NPUB`) publishes which arbiters are approved. A seller's app refuses to accept an offer whose arbiter, or arbiter escrow key, is not on that list. Otherwise a buyer could slip in a key they control. Users can add extra arbiters they trust under *Account*.
- **An arbiter colluding with one side can take the escrow.** That is inherent to 2-of-3, as in Bisq. Approve only well-known people.
- **The protocol log is authenticated.** Every message is a NIP-17 rumor inside a seal signed by its sender, and the trade state is a pure function of that log (`src/lib/trade/protocol.js`). Messages from non-participants are ignored. Proposal and co-sign signatures are verified against the escrow keys, and an accept can never be undone by a backdated cancel or reject.
- **Price risk.** The market is thin, so the XBT amount is fixed when the offer is made. Prices in EUR are only a reference.
- **Young chain.** Hashrate is small and rentable. Raise *minimum confirmations* for larger trades.

### Direct payments (no escrow)

1. **Order.** The buyer picks "Direct, Lightning" or "Direct, on chain" and a delivery option.
2. **Accept.** The seller accepts.
3. **Payment request.** The seller sends an invoice for exactly the agreed amount: made by their connected wallet, fetched from their Lightning address, or pasted. On chain, it is an address.
4. **Pay.** The buyer pays with their connected wallet (one tap), or scans the QR code with any wallet. A Lightning payment through the app includes the preimage, which proves the payment. The seller can also confirm receipt.
5. **Ship, receive, review.** As with escrow. Reviews name the payment hash or txid.

There is no arbiter: if the item never arrives, the buyer depends on the seller. That is why the app recommends escrow above €50 (`escrowAdviceAbove` in `src/config.js`). Lightning on the BLAKE2b chain uses its own invoice prefix; the app shows the prefix of every invoice, and `lightningNetwork` in `src/config.js` can require one.

### AI assistant

Each user adds their own Anthropic API key under *Account → AI listing assistant*. The key is stored encrypted with the user's Nostr key, on that device only, and is sent only to `api.anthropic.com`. API keys cannot be limited to certain actions, so the advice in the app is: make a separate key in a separate workspace at console.anthropic.com with a low monthly spend limit, and revoke it if in doubt. Photos are sent to Anthropic to be described. The model is set in `src/config.js` (`AI_MODEL`).

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

## Service (usernames, shipping labels, import from a link)

`server/` holds a small service that runs as a **Cloudflare Worker** (free plan; no server to maintain) with a Durable Object as its only storage. It never sees keys or listings. It provides:

- `/.well-known/nostr.json` and `/api/names`: unique usernames (`name@<worker domain>`, NIP-05), first come, first served, claimed with a NIP-98 signed request;
- `/api/shipping/quote`, `/api/shipping/labels`: live rates and prepaid labels through **Sendcloud API v3**. The seller pays the label over Lightning to the platform's Lightning address (LUD-16 with LUD-21 *verify*); once paid, the Worker announces the shipment and serves the label PDF and, where the carrier supports it, a QR code;
- `/api/import`: reads a public Marktplaats or Vinted page from a pasted link (for phones and the Marktplaats/Vinted apps);
- `/api/issues`: the admin (and only the admin, checked against `ADMIN_NPUB`) publishes a reviewed bug report as a GitHub issue with the label `bug-report`;
- `/api/bug`: e-mails a bug report with screenshots or a video (images and mp4/mov/webm, 15 MB at most) through **Resend** to the address in the `BUG_REPORT_EMAIL` secret. The address never reaches the app. At most 5 reports per account per hour.

Without it, the app hides usernames and link import, shows estimated shipping prices and lets the seller buy labels on the carrier's site.

**Set it up (once, on a computer):**
1. Create a free account at cloudflare.com. *My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"* template. Copy the token, and your *Account ID* (right column of the Workers & Pages overview).
2. In GitHub: *Settings → Secrets and variables → Actions → New repository secret*: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. For shipping labels, also add: `SENDCLOUD_PUBLIC_KEY`, `SENDCLOUD_SECRET_KEY` (sendcloud.com → *Settings → Integrations → Sendcloud API*) and `PLATFORM_LN_ADDRESS` (a Lightning address whose provider supports LUD-21 *verify*, e.g. Alby, LNbits, BTCPay). Sendcloud bills postage to the platform's account; the label price the seller pays covers it (`LABEL_MARKUP_PCT` adds a margin).
4. For bug reports by e-mail: a free account at resend.com, registered with the address that should receive the reports (without your own domain Resend only delivers to that address). *API Keys → Create API Key*, then the secrets `RESEND_API_KEY` and `BUG_REPORT_EMAIL`. Without them, bug reports still reach the admin over Nostr, without attachments.
5. To publish bug reports as GitHub issues (Admin → Bug reports → *Publish as GitHub issue*): a fine-grained token at github.com → *Settings → Developer settings → Fine-grained tokens*, only this repository, permission *Issues: Read and write*. Save it as the secret `ISSUES_TOKEN`; the repository variable `VITE_ADMIN_NPUB` already says who the admin is. The admin edits the text first; the reporter's name and screenshots are never published. To let Claude pick up such an issue (it carries `@claude`) and open a pull request, add the secret `CLAUDE_CODE_OAUTH_TOKEN` (in Claude Code: `/install-github-app`); see `.github/workflows/claude.yml`.
6. Re-run the *Test and deploy* workflow. It deploys the Worker, then builds the app with its address (`VITE_API_URL`, or set that repository variable to use your own domain).

Locally: `npm run sendcloud` (a Sendcloud mock), `npm run wallets` (includes the platform's mock Lightning address) and `npm run service:dev`, then build with `VITE_API_URL=http://127.0.0.1:8787`.

## Configuration

`src/config.js` holds the defaults: relays, Esplora API (`https://mempool.guide/api`), the list of known servers per chain (`ESPLORA_PRESETS`), Blossom photo server, deposits, confirmations, trade limits, the escrow advice threshold and the AI model. Users can override most of these under *Account*. Like Sparrow, they pick a known server or enter their own node (any Esplora/mempool REST API that follows the BLAKE2b chain, e.g. mempool or electrs on Umbrel or Start9) and test the connection. Browsers cannot talk to Electrum servers directly, so an Electrum-only node needs an Esplora/mempool front end (on Start9 with a BLAKE2b node: Mempool Pruned). A pasted address without a path gets `/api` added, and a failed test says why: untrusted certificate, wrong address, server still starting, or CORS.

Build-time variables:

| Variable | Use |
|---|---|
| `VITE_ADMIN_NPUB` | the npub whose arbiter list the app trusts (required for escrow) |
| `VITE_RELAYS` | comma-separated default relays (used by `npm run demo`) |
| `VITE_NETWORK` | default chain: `mainnet`, `testnet4` or `regtest` |
| `VITE_API_URL` | the XBT Market service (set automatically by the workflow when it deploys the Worker) |

## Develop

```sh
npm install          # on a shared folder without symlink support: npm install --no-bin-links
npm run dev          # http://localhost:5173
npm test             # unit tests (sighash vectors, escrow, protocol, payments, import, AI request)
npm run demo         # local relay + pretend Lightning wallets + app, no real money (see below)
```

### Try it on your phone

**With pretend money (safe, about 10 minutes).** On a computer on the same Wi-Fi as your phone:

```sh
npm install
npm run demo -- --phone
```

The terminal shows a QR code. Scan it with your phone to open the **helper page**. That page has a QR code to open the app, the connection strings of three pretend Lightning wallets (10,000,000 sats each) to copy, and, if Bitcoin Knots is installed, buttons to send pretend XBT to any address and to mine blocks. Play the seller on the computer and the buyer on the phone (or use two phones).

- Lightning purchase: both connect a pretend wallet (Account → Lightning wallet), list an item with "Direct, Lightning", buy it on the phone, pay with one tap.
- Escrow: needs Bitcoin Knots (`bitcoind` on the PATH, or `KNOTS_DIR=/path/to/bin`). A third account announces itself as arbiter and both buyer and seller add its npub under Account → Trusted arbiters. Pay into the escrow address with the helper page, then press "Mine 3 blocks".
- Photos upload to a local pretend photo server; the AI assistant needs your own API key.
- Over plain http on the local network the phone cannot install the app to the home screen and copying to the clipboard falls back to a text box. Everything else works.

**For real (real coins, real wallet).** Deploy the app (see *Deploy*; with GitHub Pages it is `https://<user>.github.io/<repo>/`), open that address on the phone and use *Add to Home screen* / *Install app*. Use small amounts first, connect your own Lightning wallet with a spending budget, and work through `<app>/testplan.html`.

### Try it in five minutes (`npm run demo`)

`npm run demo` starts a local relay, three pretend Lightning wallets and the app at http://localhost:5173, and prints a connection string per wallet. Open the app in a normal and a private window, create an account in each, connect the "seller" and "buyer" wallets under *Account → Lightning wallet*, list an item in one window and buy it with "Direct, Lightning" in the other. Escrow and on-chain payments additionally need the regtest node from *Testing*.

The browser console exposes `window.xbt` (stores and relay pool) for debugging.

## Testing

| Test | What it proves |
|---|---|
| `npm test` | All 166 Knots `unified_sighash.json` vectors; address encoding; 2-of-3 plan/sign/verify/finalize; the protocol reducer, including forged messages, a fake arbiter key, wrong-key signatures and backdated cancels/rejects; import parsing |
| `npm run test:regtest` | A real Knots BLAKE2b node accepts and mines escrow payouts signed buyer+seller, arbiter+seller and arbiter+buyer, all with sighash 0x21 |
| `npm run test:e2e` | The whole flow through the UI in Firefox: an arbiter announces, a seller lists, a buyer offers, the seller accepts, both fund on regtest, the seller ships, the buyer releases, the seller co-signs and broadcasts, the node confirms the payout, reviews become "verified". Then a dispute where the arbiter rules a refund and the buyer co-signs |
| `npm run test:lightning` | The wallet link over a relay: the seller's wallet makes an invoice for the exact amount, the buyer's wallet pays it, the preimage matches, paying twice is refused |
| `npm run test:direct` | A direct Lightning purchase through the UI: both connect a wallet, the seller lists with two delivery options, the buyer orders, the seller's wallet invoices, the buyer's wallet pays, the seller ships with a tracking link, the buyer confirms, both reviews become "verified" |
| `npm run test:extras` | Through the UI: blockchain server picker with connection test, wallet link and AI key stored encrypted, the AI assistant filling in a listing (against an intercepted fake API), escrow preselected above €50 |
| `npm run test:plan` | Walks through every item of `public/testplan.html` with three people (admin/arbiter, seller, buyer): accounts and password lock, admin approval, listings with photos, search and sorting, an escrow trade with real confirmations, recovery from relays with only the nsec, disputes, cancels, Lightning and on-chain direct payments, the AI assistant, node choice, backup and restore. Items that need real coins, real shop pages or a real phone are reported as "manual" |
| `npm run test:import` | The bookmarklet against fake Vinted wardrobe, eBay list, JSON-LD product and paginated Marktplaats profile pages, through the real popup/postMessage handshake. Then a Marktplaats re-import (everything recognised) and a re-import after a price change and a removed ad |

CI (`.github/workflows/pages.yml`) runs all four on every push, against a checksum-verified Knots release in headless Firefox, and deploys only when they pass. Screenshots and logs are uploaded as the `e2e-output` artifact.

To run them locally:

```sh
bitcoind -regtest -testactivationheight=blake2b@1 -rpcuser=u -rpcpassword=p -fallbackfee=0.0001 -txindex=1 -daemon
npm run relay & npm run shim & npm run fixtures & npm run wallets &
npm run build && npm run preview &
export KNOTS_CLI="bitcoin-cli -regtest -rpcuser=u -rpcpassword=p"
npm run test:regtest && npm run test:e2e && npm run test:import && npm run test:lightning && npm run test:direct && npm run test:extras
```

With `SHOTS=<dir>` the browser tests save a captioned screenshot after each verified step; `node scripts/proof-report.mjs <dir>` turns them into one HTML page (CI uploads it with the `e2e-output` artifact). `test:direct` also covers a direct on-chain payment when `KNOTS_CLI` is set.

The e2e tests use `puppeteer-core` with a local Firefox (`FIREFOX=/path/to/firefox`, `PROFILE_DIR` for the profile location), or Chromium with `CHROME=/path/to/chrome`. `MOBILE=1` runs them as a phone (390×844 screen, touch, phone user agent). CI runs every browser test three times: Firefox desktop, Firefox on a phone-sized screen and Chrome emulating an Android phone. `test:plan` also needs `npm run blossom` and an app build with its admin key: `VITE_ADMIN_NPUB=$(node test/e2e/testplan.e2e.mjs --admin-npub) npx vite build --outDir dist-plan`, served on port 4174. `test:lightning` and `test:direct` need no node, only the relay, the wallets and the preview. They open one browser context at a time, so every page rebuilds its trade state from the relay.

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
