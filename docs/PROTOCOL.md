# XBT Market protocol, version 1

This document specifies everything XBT Market puts on Nostr and on chain. Another client that follows it can trade with this one. The reference implementation is `src/lib/trade/protocol.js` (pure) and `src/lib/btc/escrow.js`; where they disagree with this text, file a bug.

## 1. Chain

Bitcoin BLAKE2b: the chain that follows Bitcoin Knots `v29.4.1.knots20260508` and later from block 961,640. Addresses and scripts are Bitcoin's (`bc1…` mainnet, `tb1…` testnet4, `bcrt1…` regtest).

Every signature this protocol makes uses **`SIGHASH_ALL | SIGHASH_UNIFIED` = 0x21**, the unified opt-in sighash (Knots PR #357, spec `doc/unified-sighash.md` in that tag). For the P2WSH escrow that means:

- script type 1 (segwit v0);
- scriptCode = the witness script;
- message = `TaggedHash("UnifiedSighash", …)`, committing to every input's amount and scriptPubKey.

Nodes on the SHA256d chain reject such signatures, so escrow payouts cannot be replayed there.

## 2. Keys

Let `sk` be the user's Nostr secret key (32 bytes), and let `n` be the secp256k1 order.

| Name | Definition |
|---|---|
| trade escrow key (buyer or seller) | `HMAC-SHA256(key = sk, msg = "xbt-market/escrow/v1/" ‖ tradeId) mod n` |
| arbiter base key | `HMAC-SHA256(sk, "xbt-market/arbiter/v1") mod n`, public key `P_base` published (§4.2) |
| arbiter trade key | `P = P_base + t·G`, secret `sk_base + t mod n`, where `t = TaggedHash("xbt-market/arbiter-tweak", P_base(33 bytes compressed) ‖ utf8(tradeId)) mod n` |

A result of 0 is invalid. All public keys are 33-byte compressed hex.

## 3. Escrow

- **Witness script:** `OP_2 <k1> <k2> <k3> OP_3 OP_CHECKMULTISIG`, where `k1..k3` are the buyer, seller and arbiter trade keys sorted lexicographically (BIP67). The three keys must be distinct.
- **Address:** P2WSH of that script.
- **Witness of a spend:** `<empty> <sig_a> <sig_b> <witness script>`, with the two signatures in script key order. Each signature is DER + `0x21`, low-S.

**Payout transaction**

- version 2, locktime 0;
- inputs: exactly the escrow UTXOs, sequence `0xfffffffd`;
- outputs: the agreed split.

The fee (`ceil(vsize × feeRate)`, where vsize is estimated with 73-byte signatures) is taken from every output in proportion to its share. The rounding remainder goes to the largest output. Outputs below 546 sats are dropped and added to the fee.

**Standard splits.** `B` is the escrow balance; `price`, `bd` (buyer deposit) and `sd` (seller deposit) come from the offer.

| purpose | seller gets | buyer gets |
|---|---|---|
| `release` | `min(B, price + sd)` | rest |
| `refund` | `max(0, B − price − bd)` | rest |
| `ruling` / `custom` | as proposed | as proposed |

## 4. Nostr events

### 4.1 Listing — kind 30402 (NIP-99)

| tag | value |
|---|---|
| `d` | listing id |
| `title`, `summary`, `published_at` | as NIP-99 |
| `price` | `["price", "<amount>", "<EUR|USD|…|XBT>"]` |
| `t` | must include `xbt-market` and `btcb2`, plus one category |
| `status` | `active`, `sold` or `deleted` |
| `image` | one per photo (http(s) only) |
| `condition` | `new`, `like-new`, `good`, `fair` or `for-parts` |
| `location`, `ships_to` | free text |
| `shipping_cost` | `["shipping_cost", "<amount>", "<currency>"]` |
| `seller_deposit_pct` | number |
| `r` | source URL, if the listing was imported |
| `imported_from` | host of the source |

`content` is the description.

### 4.2 Arbiter announcement and community config — kind 30078

- `d = xbt-market/arbiter`, signed by the arbiter. Content JSON: `{ v: 1, escrowBase: <P_base hex>, name, about, languages, feeNote, active }`.
- `d = xbt-market/config`, signed by the community admin. Content JSON: `{ v: 1, arbiters: [<pubkey hex>, …] }`.

An arbiter is **trusted** when its pubkey is in the admin's list (or in the user's own list) **and** it has an announcement. Its `escrowBase` is taken from that announcement.

### 4.3 Review — kind 1985 (NIP-32)

Tags:
- `["L","xbt-market/review"]`
- `["l","positive|negative","xbt-market/review"]`
- `["p",<reviewed>]`
- `["xbt-trade",<tradeId>]`
- `["rating","1..5"]`
- `["role","buyer|seller"]`
- `["txid",<payout txid>]`

`content` is the text. A trade is **verified** when both parties reviewed each other with the same `xbt-trade` and `txid`.

### 4.4 Trade messages — NIP-17 / NIP-59 gift wraps

Every trade message is a rumor, sealed (kind 13) and gift-wrapped (kind 1059) to **each of buyer, seller and arbiter**, plus one copy to the sender. The rumor's `pubkey` must equal the seal's `pubkey`, and `id` must equal the rumor hash.

- **Protocol rumor:** kind **1714**, tags `["p",…]` for each recipient, `["xbt-trade",<tradeId>]`, `["xbt-type",<type>]`. `content` is JSON.
- **Chat rumor:** kind **14**, same `xbt-trade` tag, plain-text `content`.

`tradeId` is `"t"` followed by 24 hex characters, chosen by the buyer.

| type | from | body |
|---|---|---|
| `offer` | buyer | `{ v:1, tradeId, network, listing:{coord, sellerPubkey, title, image, price, currency, shippingCost}, priceSats, buyerDepositSats, sellerDepositSats, arbiter:{pubkey, escrowBase}, buyer:{escrowPubkey, payoutAddress}, shipTo, note, shipDays, confirmDays }` |
| `accept` | seller | `{ seller:{escrowPubkey, payoutAddress} }` |
| `reject` | seller | `{ reason }` |
| `cancel` | buyer or seller | `{ reason }` |
| `funded` | any party | `{ txid }` (a hint only; the chain is authoritative) |
| `shipped` | seller | `{ carrier, tracking, note }` |
| `received` | buyer | `{ note }` |
| `dispute` | buyer or seller | `{ reason }` |
| `proposal` | any of the three | `{ id, purpose, utxos:[{txid,vout,value}], txHex, sigs:[sig per input], note, feeRate }` |
| `sign` | any of the three | `{ proposalId, sigs }` |
| `broadcast` | any of the three | `{ proposalId, txid }` |

## 5. State rules

The state is a pure function of the set of rumors. Sort by `created_at`, then `id`. Then:

1. **Offer.** The first valid `offer` defines the trade. Buyer = its sender, seller = `listing.sellerPubkey`, arbiter = `arbiter.pubkey`; all three must be distinct. Rumors from anyone else are ignored.
2. **Seller decision.** If any valid `accept` exists, the first one is the decision, regardless of timestamps. Otherwise the first valid `reject` is. Senders choose their own timestamps, so a backdated cancel or reject must never hide an escrow that may already hold coins.
3. **Valid accept.** `escrowPubkey` is valid, `payoutAddress` is valid for `network`, and the three escrow keys are distinct.
4. **Cancel.** A `cancel` after an accept does not remove the escrow (status `cancelling`); a refund proposal is still needed.
5. **Restricted messages.** `shipped` and `dispute` require an accept. `shipped` and the decision come only from the seller, `received` only from the buyer, and the arbiter opens no disputes.
6. **Proposals.** A `proposal` is valid when:
   - the escrow exists;
   - `txHex` spends exactly `utxos`, in order;
   - outputs do not exceed inputs;
   - `sigs` verify (0x21 unified sighash, script type 1) for every input against the proposer's escrow key.

   A `sign` is valid when its signatures verify for the signer's key. Two valid signers make a proposal final.
7. **Status.** In order of precedence: `rejected`, `closed` (any `broadcast`), `cancelled` (cancel before accept), `cancelling`, `disputed`, `shipped`, `accepted`, `offered`. Whether the escrow is funded is read from the chain (Esplora UTXOs with at least N confirmations), not from messages.

**Before signing, a client must:**
- check that every proposal input is still an unspent escrow UTXO with the stated value;
- show every output to the user, labelled buyer, seller or **other**.

A seller's client must refuse to accept an offer whose arbiter is not trusted, or whose `arbiter.escrowBase` differs from the trusted announcement. Otherwise a buyer could supply a key they control and hold 2 of 3.
