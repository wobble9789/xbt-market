// Marktplaats categories, services and older category ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, normalizeCategory, isService } from '../src/lib/categories.js';
import { fromMp } from '../src/bookmarklet/extract.js';
import { normalizeItem } from '../src/lib/import/normalize.js';
import { listingTemplate, parseListing } from '../src/lib/nostr/listings.js';

const PK = 'ab'.repeat(32);
const listing = (over) => parseListing({ id: 'x', pubkey: PK, created_at: 1, ...listingTemplate({ d: 'l', title: 'x', content: '', price: 40, currency: 'EUR', ...over }) });

test('the Marktplaats main categories, with services among them', () => {
  assert.equal(CATEGORIES.length, 36);
  for (const c of ['diensten-en-vakmensen', 'huis-en-inrichting', 'auto-s', 'kleding-dames', 'kleding-heren', 'witgoed-en-apparatuur', 'diversen']) assert.ok(CATEGORIES.includes(c), c);
  assert.ok(isService('diensten-en-vakmensen'));
  assert.ok(!isService('huis-en-inrichting'));
});

test('older category ids map onto Marktplaats categories', () => {
  assert.equal(normalizeCategory('home'), 'huis-en-inrichting');
  assert.equal(normalizeCategory('bitcoin-hardware'), 'computers-en-software');
  assert.equal(normalizeCategory('something-else'), 'diversen');
  assert.equal(listing({ category: 'books' }).category, 'boeken');
});

test('a Marktplaats import keeps its category from the ad URL', () => {
  const raw = fromMp({ itemId: 'm1', title: 'Klusjesman', priceInfo: { priceType: 'FIXED', priceCents: 3500 }, vipUrl: '/v/diensten-en-vakmensen/klussers/m1-klusjesman' }, 'https://www.marktplaats.nl/');
  assert.equal(raw.category, 'diensten-en-vakmensen');
  assert.equal(normalizeItem(raw, 'marktplaats.nl').category, 'diensten-en-vakmensen');
  assert.equal(normalizeItem({ title: 'Heren winterjas', price: 20 }).category, 'kleding-heren');
});

test('a service listing carries its price unit (NIP-99 price frequency)', () => {
  const l = listing({ category: 'diensten-en-vakmensen', priceUnit: 'hour' });
  assert.equal(l.category, 'diensten-en-vakmensen');
  assert.equal(l.priceUnit, 'hour');
  assert.deepEqual(l.event.tags.find((t) => t[0] === 'price'), ['price', '40', 'EUR', 'hour']);
  assert.equal(listing({ category: 'boeken' }).priceUnit, '');
});

// ---- logging in with a pasted nsec (phones mangle pasted text) ----
import { parseSecret } from '../src/lib/nostr/account.js';
import * as nip19 from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

test('an nsec pasted on a phone still logs in; mix-ups get a clear message', () => {
  const sk = generateSecretKey();
  const nsec = nip19.nsecEncode(sk);
  const same = (x) => assert.equal(getPublicKey(parseSecret(x)), getPublicKey(sk));
  same(nsec);
  same('Nsec' + nsec.slice(4)); // autocorrect capital
  same(`  ${nsec.slice(0, 30)}\n${nsec.slice(30)} `); // wrapped text
  same('nostr:' + nsec);
  same(nsec.toUpperCase());
  assert.throws(() => parseSecret(nip19.npubEncode(getPublicKey(sk))), /npub/);
  assert.throws(() => parseSecret(nsec.slice(0, -1)), /62 characters instead of 63/);
  assert.throws(() => parseSecret(nsec.slice(0, -1) + (nsec.endsWith('q') ? 'p' : 'q')), /not valid/);
  assert.throws(() => parseSecret('hello'), /starts with nsec1/);
});
