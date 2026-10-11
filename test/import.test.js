import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromPayload, fromCsv } from '../src/lib/import/normalize.js';

test('bookmarklet payload normalizes', () => {
  const items = fromPayload({ source: 'www.vinted.nl', items: [
    { title: 'Nike Air Max 90 sneakers', price: 45, currency: 'EUR', images: ['https://images1.vinted.net/a.jpg', 'javascript:x'], brand: 'Nike', size: '42', condition: 'Zeer goed', url: 'https://www.vinted.nl/items/1' },
    { title: '', price: 3 },
    { title: 'Free?', price: 0 },
  ] });
  assert.equal(items.length, 1);
  assert.equal(items[0].category, 'shoes');
  assert.equal(items[0].condition, 'like-new');
  assert.deepEqual(items[0].images, ['https://images1.vinted.net/a.jpg']);
  assert.equal(items[0].importedFrom, 'vinted.nl');
  assert.match(items[0].content, /Brand: Nike/);
});

test('eBay-style CSV with info line and quoted fields', () => {
  const csv = 'Seller Hub report,,\nItem number,Title,Current price,Condition,Picture URL\n123,"Trezor Model T, sealed","€ 1.234,50",New,https://i.ebayimg.com/x.jpg\n124,Old lamp,12.00,Used,\n';
  const items = fromCsv(csv);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Trezor Model T, sealed');
  assert.equal(items[0].price, 1234.5);
  assert.equal(items[0].category, 'bitcoin-hardware');
  assert.equal(items[0].source, 'https://www.ebay.com/itm/123');
  assert.equal(items[1].condition, 'good');
});
