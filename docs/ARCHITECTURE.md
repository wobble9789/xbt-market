# Architecture and safety net

This document covers how the code is split, which invariants each part keeps, and which test fails when one of them breaks. When you change a module, run the tests listed for it; CI runs all of them on every push and only deploys when they pass.

## Layers

```
UI (src/ui)                      Preact pages and components; no protocol logic
  │ calls
Actions (src/lib/trade/actions)  side effects: derive keys, read chain, send messages
  │ uses
Pure core                         no network, no DOM, fully unit tested
  src/lib/trade/protocol.js        rumors -> trade state (docs/PROTOCOL.md §5)
  src/lib/btc/*                    tx, addresses, unified sighash, escrow
  src/lib/import/normalize.js      imported items -> drafts, duplicate classification
  src/bookmarklet/extract.js       shop page data -> items
I/O adapters
  src/lib/nostr/*                  relays, NIP-17 inbox, listings, directory, reviews, profiles, uploads
  src/lib/btc/esplora.js           chain API
  src/bookmarklet/source.js        page I/O for the import button
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
| Marktplaats price types: FIXED/MIN_BID give a price, others none | `bookmarklet/extract.js` | `test/extract.test.js` |
| Re-import recognises listings by platform id, then title + price | `import/normalize.js` | `test/import.test.js`, `test:import` e2e |
| Only a *complete* profile import reports "gone" listings, and only for that platform | `import/normalize.js` | `test/import.test.js`, `test:import` e2e |
| The generated bookmarklet matches its source version | build | `test/extract.test.js` (fails when stale) |
| An outdated saved bookmark is warned about | `ui/pages/Import.jsx` | `test:import` e2e |
| The whole trade and dispute flow works in a browser | everything | `test:e2e` (Firefox, Knots regtest, local relay) |
| The app shows the page that matches the URL | `ui/router.js` | `test:e2e` (contexts reopen on a deep link) |

## Changing things safely

- **Protocol or escrow.** Update `docs/PROTOCOL.md` in the same commit. Never change derivation strings, the tag names or the message types without bumping the protocol version, because existing trades must stay recoverable.
- **Import extraction.** Bump `BOOKMARKLET_VERSION` in `src/bookmarklet/extract.js`, so users with an old saved bookmark see the "out of date" warning.
- **UI text.** `test:e2e` finds buttons by their English label. If you rename a button, update the test.
- **Relays and photo server.** `src/config.js`. Users can override them in Settings.

## Manual testing

`public/testplan.html`, served at `<app>/testplan.html`, is a checklist for real-world testing with real coins and real shop pages. That is the part automated tests cannot cover.
