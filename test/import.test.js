import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromPayload, fromCsv, sourceKey, classifyImport } from '../src/lib/import/normalize.js';

test('bookmarklet payload normalizes', () => {
  const items = fromPayload({ source: 'www.vinted.nl', items: [
    { title: 'Nike Air Max 90 sneakers', price: 45, currency: 'EUR', images: ['https://images1.vinted.net/a.jpg', 'javascript:x'], brand: 'Nike', size: '42', condition: 'Zeer goed', url: 'https://www.vinted.nl/items/1' },
    { title: '', price: 3 },
    { title: 'Free?', price: 0 },
  ] });
  assert.equal(items.length, 2); // the price-less one stays, for the user to price
  assert.equal(items[1].price, '');
  assert.equal(items[0].category, 'kleding-dames');
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
  assert.equal(items[0].category, 'computers-en-software');
  assert.equal(items[0].source, 'https://www.ebay.com/itm/123');
  assert.equal(items[1].condition, 'good');
});

test('source keys survive slug, domain and query changes', () => {
  assert.equal(sourceKey('https://www.marktplaats.nl/v/fietsen/dames/m2119107775-oma-fiets?c=1'), 'mp:m2119107775');
  assert.equal(sourceKey('https://www.2dehands.be/v/x/y/m2119107775-andere-slug'), 'mp:m2119107775');
  assert.equal(sourceKey('https://www.vinted.nl/items/123-jas'), sourceKey('https://www.vinted.de/items/123-jacke'));
  assert.equal(sourceKey('https://www.ebay.de/itm/Trezor-T/1234567890?hash=x'), 'ebay:1234567890');
  assert.equal(sourceKey('https://www.ebay.com/itm/1234567890'), 'ebay:1234567890');
});

test('classifyImport finds new, unchanged, changed and gone listings', () => {
  const mine = [
    { coord: 'a', title: 'Oma fiets', price: 99, status: 'active', source: 'https://www.marktplaats.nl/v/f/d/m2000000100-oma-fiets' },
    { coord: 'b', title: 'Lamp', price: 10, status: 'active', source: 'https://www.marktplaats.nl/v/w/l/m2000000200-lamp' },
    { coord: 'c', title: 'Bank', price: 50, status: 'active', source: 'https://www.marktplaats.nl/v/w/b/m2000000300-bank' },
    { coord: 'd', title: 'Boek', price: 5, status: 'active', source: '' },
    { coord: 'e', title: 'Old', price: 1, status: 'deleted', source: 'https://www.marktplaats.nl/v/x/y/m2000000400-old' },
    { coord: 'f', title: 'Vinted jas', price: 20, status: 'active', source: 'https://www.vinted.nl/items/9' },
  ];
  const imported = [
    { title: 'Oma fiets', price: 99, source: 'https://www.marktplaats.nl/v/f/d/m2000000100-oma-fiets-nieuwe-slug' },
    { title: 'Lamp', price: 8, source: 'https://www.marktplaats.nl/v/w/l/m2000000200-lamp' },
    { title: 'Boek', price: 5, source: 'https://www.marktplaats.nl/v/b/b/m2000000500-boek' },
    { title: 'Old', price: 1, source: 'https://www.marktplaats.nl/v/x/y/m2000000400-old' },
    { title: 'Stoel', price: 15, source: 'https://www.marktplaats.nl/v/w/s/m2000000600-stoel' },
  ];
  const { items, gone } = classifyImport(imported, mine, { complete: true });
  assert.deepEqual(items.map((i) => i.status), ['same', 'changed', 'same', 'new', 'new']);
  assert.equal(items[1].match.coord, 'b');
  assert.equal(items[2].match.coord, 'd'); // matched by title + price
  // only Marktplaats listings can be "gone" from a Marktplaats import
  assert.deepEqual(gone.map((l) => l.coord), ['c']);
  assert.deepEqual(classifyImport(imported, mine, { complete: false }).gone, []);
});
