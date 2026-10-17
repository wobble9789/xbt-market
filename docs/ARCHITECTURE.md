# Architecture and safety net

This document covers how the code is split, which invariants each part keeps, and which test fails when one of them breaks. When you change a module, run the tests listed for it; CI runs all of them on every push and only deploys when they pass.

## Layers

```
UI (src/ui)                      Preact pages and components; no protocol logic
  │ calls
Actions (src/lib/trade/actions)  side effects: derive keys, read chain, send messages
  │ uses
Pure core                         no network, no DOM, fully unit tested
  src/lib/trade/protocol.js        rumors -> trade state (docs/PROTOCOL.md §5), escrow and direct trades
  src/lib/ln/bolt11.js             Lightning invoice reader, preimage check
  src/lib/shipping.js              carriers, delivery options, tracking links
  src/lib/btc/*                    tx, addresses, unified sighash, escrow
  src/lib/import/normalize.js      imported items -> drafts, duplicate classification
  src/bookmarklet/extract.js       shop page data -> items
I/O adapters
  src/lib/nostr/*                  relays, NIP-17 inbox, listings, directory, reviews, profiles, uploads
  src/lib/btc/esplora.js           chain API
  src/lib/ln/nwc.js, wallet.js     Nostr Wallet Connect (the user's Lightning wallet)
  src/lib/ln/lnurl.js              Lightning address -> invoice
  src/lib/secrets.js               wallet link and AI key, NIP-44 encrypted to the user's own key
  src/lib/ai/listing.js            listing draft from photos (Claude, user's own API key, loaded on demand)
  src/bookmarklet/source.js        page I/O for the import button
  src/lib/api.js                   the XBT Market service, NIP-98 signed requests
  src/lib/nostr/names.js           usernames (NIP-05), verified per profile
  src/lib/nostr/follows.js         following (NIP-02 contact list)
  src/lib/shipping-api.js          shipping prices and labels from the service
  src/lib/trade/forward.js         re-sends own earlier messages to a later-chosen arbiter
Service (server/, Cloudflare Worker or Node)
  server/service.js                usernames, Sendcloud v3 rates and labels, Lightning label
                                   payments (LUD-21 verify), import from a link
  server/worker.js, node.mjs       Durable Object storage / in-memory storage around it
```

Rules:
- Logic that decides about money or trust belongs in the pure core, never in the UI.
- The UI reads trade state only through `reduceTrade` (via `useTrade`).

## Invariants and their tests

| Invariant | Where | Guarded by |
|---|---|---|
| Unified sighash matches Knots byte for byte | `btc/unified.js` | `test/btc.test.js`: all 166 Knots vectors |
| Escrow payouts are accepted by a real BLAKE2b node | `btc/escrow.js` | `test/regtest.integration.mjs`: all three 2-of-3 signer pairs |
| Arbiter public tweak equals private tweak | `btc/escrow.js` | `test/btc.test.js` |
| Fee is shared proportionally; dust goes to the fee | `btc/escrow.js` `planPayout` | `test/btc.test.js` |
| Non-participants and wrong roles cannot change a trade | `trade/protocol.js` | `test/protocol.test.js` |
| A forged arbiter key is flagged untrusted | `trade/protocol.js` | `test/protocol.test.js` |
| A backdated cancel or reject cannot undo an accept | `trade/protocol.js` | `test/protocol.test.js` |
| A seller cannot reuse another party's key | `trade/protocol.js` | `test/protocol.test.js` |
| Proposals need valid signatures from the proposer | `trade/protocol.js` | `test/protocol.test.js` |
| A direct trade has no arbiter, deposits or escrow messages | `trade/protocol.js` | `test/payments.test.js` |
| A payment request is for exactly the agreed amount | `trade/protocol.js` | `test/payments.test.js` |
| A Lightning payment counts as verified only with a matching preimage | `ln/bolt11.js`, `trade/protocol.js` | `test/payments.test.js` (incl. the BOLT11 spec vector) |
| Wallet requests and answers are encrypted to the wallet (NIP-44, NIP-04 fallback) | `ln/nwc.js` | `test/payments.test.js`, `test:lightning` |
| Delivery options and payment methods round-trip through a listing | `nostr/listings.js`, `shipping.js` | `test/payments.test.js` |
| Tracking links only accept plain tracking codes | `shipping.js` | `test/payments.test.js` |
| The AI draft sends the photos and a strict schema, and handles refusals | `ai/listing.js` | `test/ai.test.js` |
| A direct Lightning purchase works in a browser with real wallet round trips | everything | `test:direct` (mock NWC wallets, local relay) |
| Marktplaats price types: FIXED/MIN_BID give a price, others none | `bookmarklet/extract.js` | `test/extract.test.js` |
| Re-import recognises listings by platform id, then title + price | `import/normalize.js` | `test/import.test.js`, `test:import` e2e |
| Only a *complete* profile import reports "gone" listings, and only for that platform | `import/normalize.js` | `test/import.test.js`, `test:import` e2e |
| The generated bookmarklet matches its source version | build | `test/extract.test.js` (fails when stale) |
| An outdated saved bookmark is warned about | `ui/pages/Import.jsx` | `test:import` e2e |
| The whole trade and dispute flow works in a browser | everything | `test:e2e` (Firefox, Knots regtest, local relay) |
| v2: a conversation has no offer; only its opener can order | `trade/protocol.js` | `test/protocol.test.js` |
| v2: the arbiter is fixed by the buyer's first details after the accept, never the buyer or seller | `trade/protocol.js` | `test/protocol.test.js`, `test:e2e` (arbiter rules a dispute after joining late) |
| A payment method changes only when the other side agrees, and never after paying | `trade/protocol.js` | `test/protocol.test.js`, `test:direct` |
| Labels come from the seller only, with http(s) links | `trade/protocol.js` | `test/protocol.test.js` |
| Usernames are unique and only claimable with a valid NIP-98 signature | `server/service.js` | `test/server.test.js`, test plan USR-1 |
| A label is announced only after its Lightning payment is verified | `server/service.js` | `test/server.test.js`, `test:direct` |
| A single ad (also /seller/view/m…) and reserved ads are read | `bookmarklet/extract.js`, `server/service.js` | `test/extract.test.js`, `test/server.test.js`, `test:import` |
| The app shows the page that matches the URL | `ui/router.js` | `test:e2e` (contexts reopen on a deep link) |

## Changing things safely

- **Protocol or escrow.** Update `docs/PROTOCOL.md` in the same commit. Never change derivation strings, the tag names or the message types without bumping the protocol version, because existing trades must stay recoverable.
- **Import extraction.** Bump `BOOKMARKLET_VERSION` in `src/bookmarklet/extract.js`, so users with an old saved bookmark see the "older version" note.
- **Service.** `server/service.js` runs unchanged in the Worker and in Node; test it with `test/server.test.js` and the e2e suites (which use `npm run service:dev` against `npm run sendcloud`).
- **UI text.** The e2e tests find buttons by their English label. If you rename a button, update the tests. Every string is `T('English', 'Español')`.
- **Relays and photo server.** `src/config.js`. Users can override them in Settings.

## Manual testing

`public/testplan.html`, served at `<app>/testplan.html`, is a checklist for real-world testing with real coins and real shop pages. That is the part automated tests cannot cover.
