// The bookmarklet's extraction logic, against data shaped exactly like what
// Marktplaats, Vinted and schema.org pages carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePrice, currencyOf, fromMp, mpResults, nextDataFromHtml, mpSellerPath, fromVinted, vintedMemberId,
  flattenJsonLd, productsFromJsonLd, dedupeItems, BOOKMARKLET_VERSION,
} from '../src/bookmarklet/extract.js';
import { BOOKMARKLET_VERSION as GENERATED } from '../src/generated/bookmarklet.js';

const BASE = 'https://www.marktplaats.nl/u/seller/48763914/';
const mp = (itemId, priceType, priceCents, extra = {}) => ({
  itemId, title: `Item ${itemId}`, description: 'kort', categorySpecificDescription: 'langere beschrijving',
  priceInfo: { priceCents, priceType, suppressZeroCents: false }, location: { cityName: 'Utrecht' },
  attributes: [{ key: 'condition', value: 'Zo goed als nieuw', values: ['Zo goed als nieuw'] }],
  pictures: [{ id: 0, url: 'https://images.marktplaats.com/api/v1/x/images/ab/abc?rule=ecg_mp_eps$_#.jpg' }],
  imageUrls: ['//images.marktplaats.com/api/v1/x/images/ab/abc?rule=ecg_mp_eps$_82.jpg'],
  vipUrl: `/v/huis-en-inrichting/gordijnen/${itemId}-item`, ...extra,
});

test('parsePrice handles European and English formats', () => {
  assert.equal(parsePrice('€ 1.150,00'), 1150);
  assert.equal(parsePrice('EUR 45,00'), 45);
  assert.equal(parsePrice('1,234.50'), 1234.5);
  assert.equal(parsePrice('€ 8,-'), 8);
  assert.equal(parsePrice(7.5), 7.5);
  assert.ok(Number.isNaN(parsePrice(null)));
  assert.equal(currencyOf('£ 3', 'EUR'), 'GBP');
  assert.equal(currencyOf('12', 'USD'), 'USD');
});

test('Marktplaats: every price type maps correctly (regression: profile with 7 ads)', () => {
  const cases = [
    ['m2441984630', 'FIXED', 800, 8],          // vaste prijs €8 (was imported as €1 by the v1 bookmark)
    ['m2441954808', 'MIN_BID', 1000, 10],      // bieden vanaf €10
    ['m2441950042', 'MIN_BID', 750, 7.5],
    ['m2441946972', 'FAST_BID', 0, 0],         // bieden, no amount -> user fills in
    ['m2434526901', 'MIN_BID', 84000, 840],
    ['m2000000001', 'SEE_DESCRIPTION', 0, 0],
    ['m2000000002', 'FIXED', 0, 0],            // "gratis"/0 is not a sale price
  ];
  for (const [id, type, cents, want] of cases) {
    const it = fromMp(mp(id, type, cents), BASE);
    assert.equal(it.price, want, `${id} ${type}`);
    assert.equal(it.id, id);
    assert.equal(it.url, `https://www.marktplaats.nl/v/huis-en-inrichting/gordijnen/${id}-item`);
    assert.equal(it.images[0], 'https://images.marktplaats.com/api/v1/x/images/ab/abc?rule=ecg_mp_eps$_85.jpg');
    assert.equal(it.condition, 'Zo goed als nieuw');
    assert.equal(it.description, 'langere beschrijving');
    assert.equal(it.location, 'Utrecht');
  }
  // without pictures[] the protocol-relative imageUrls are used
  assert.equal(fromMp(mp('m1234567', 'FIXED', 100, { pictures: [] }), BASE).images[0].slice(0, 8), 'https://');
});

test('Marktplaats: Next.js data, seller path and pagination helpers', () => {
  const data = { props: { pageProps: { searchRequestAndResponse: { listings: [mp('m2441984630', 'FIXED', 800)], totalResultCount: 7 } } } };
  const html = `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
  const r = mpResults(nextDataFromHtml(html));
  assert.equal(r.totalResultCount, 7);
  assert.equal(r.listings.length, 1);
  assert.equal(mpResults(nextDataFromHtml('<html>no data</html>')), null);
  assert.equal(mpSellerPath('/u/itw/48763914/'), '/u/itw/48763914');
  assert.equal(mpSellerPath('/u/020-fietsen-bv/19190757/p/2/'), '/u/020-fietsen-bv/19190757');
  assert.equal(mpSellerPath('/q/fiets/'), null);
});

test('Vinted wardrobe items', () => {
  const it = fromVinted({ id: 42, title: 'Jas', price: { amount: '25.0', currency_code: 'EUR' }, photos: [{ url: 't.jpg', full_size_url: 'https://i/f.jpg' }], brand_title: 'Nike', size_title: 'M', status: 'Zeer goed', path: '/items/42-jas' }, 'https://www.vinted.nl/member/1-x');
  assert.deepEqual([it.id, it.price, it.currency, it.images[0], it.url], ['42', 25, 'EUR', 'https://i/f.jpg', 'https://www.vinted.nl/items/42-jas']);
  assert.equal(vintedMemberId('/member/123-fred'), '123');
  assert.equal(vintedMemberId('/catalog'), null);
});

test('schema.org Product, including @graph and arrays', () => {
  const nodes = flattenJsonLd([
    { '@type': 'BreadcrumbList' },
    { '@graph': [{ '@type': 'Product', name: 'Coldcard', image: [{ url: '/a.jpg' }], offers: [{ price: '120.00', priceCurrency: 'EUR', itemCondition: 'https://schema.org/UsedCondition' }] }] },
    [{ '@type': ['Product'], name: 'Lamp', image: 'https://x/l.jpg', offers: { lowPrice: '9,95' } }],
  ]);
  const p = productsFromJsonLd(nodes, 'https://shop.example/p/1');
  assert.equal(p.length, 2);
  assert.deepEqual([p[0].title, p[0].price, p[0].images[0], p[0].condition], ['Coldcard', 120, 'https://shop.example/a.jpg', 'UsedCondition']);
  assert.equal(p[1].price, 9.95);
});

test('dedupe and version', () => {
  assert.equal(dedupeItems([{ title: 'a', url: 'u' }, { title: 'a', url: 'u' }, { title: '', url: 'v' }]).length, 1);
  assert.ok(BOOKMARKLET_VERSION >= 2);
  assert.equal(GENERATED, BOOKMARKLET_VERSION, 'generated bookmarklet is stale: run npm run build');
});
