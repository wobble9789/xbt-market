// Fake Vinted / eBay / product pages for the import e2e test (port 4300).
import http from 'node:http';
const pages = {
  '/member/123-fred': `<html><body><h1>Fred's wardrobe</h1></body></html>`,
  '/api/v2/wardrobe/123/items': JSON.stringify({ items: [
    { id: 1, title: 'Levi’s 501 jeans W32', price: { amount: '25.0', currency_code: 'EUR' }, photos: [{ url: 'https://images1.vinted.net/t/1.jpg', full_size_url: 'https://images1.vinted.net/f/1.jpg' }], brand_title: 'Levi’s', size_title: 'W32', status: 'Zeer goed', url: '/items/1-levis' },
    { id: 2, title: 'Nike hoodie', price: { amount: '18.5', currency_code: 'EUR' }, photos: [], brand_title: 'Nike', size_title: 'M', status: 'Goed', path: '/items/2-nike' },
  ], pagination: { total_pages: 1 } }),
  '/itm/999': `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Coldcard Mk4","description":"Used twice","image":["https://i.ebayimg.com/a.jpg"],"offers":{"@type":"Offer","price":"120.00","priceCurrency":"EUR","itemCondition":"https://schema.org/UsedCondition"}}</script></head><body>item</body></html>`,
  '/sch/i.html': `<html><body><ul>
    <li class="s-item"><a href="/itm/1"><img src="https://i.ebayimg.com/1.jpg"></a><div class="s-item__title">Raspberry Pi 4 4GB</div><span class="s-item__price">EUR 45,00</span></li>
    <li class="s-item"><a href="/itm/2"><img src="https://i.ebayimg.com/2.jpg"></a><div class="s-item__title">Shop on eBay</div><span class="s-item__price">€ 20,00</span></li>
    <li class="s-item"><a href="/itm/3"><img data-src="https://i.ebayimg.com/3.jpg"></a><div class="s-item__title">Bitaxe Gamma 601</div><span class="s-item__price">€ 1.150,00</span></li>
  </ul></body></html>`,
};
// Marktplaats-style seller profile: Next.js data, 3 + 2 listings over two pages.
// GET /__variant?v=2 removes one listing and changes a price, to test re-imports.
let variant = 1;
const mpListing = (n, price) => ({
  itemId: `m21000000${n}`, title: `MP item ${n}`, description: `Beschrijving ${n}`, priceInfo: { priceCents: price * 100, priceType: n === 5 ? 'FAST_BID' : n === 4 ? 'MIN_BID' : 'FIXED' },
  location: { cityName: 'Utrecht' }, attributes: [{ key: 'condition', value: n === 1 ? 'Zo goed als nieuw' : 'Gebruikt' }],
  pictures: [{ url: `https://images.marktplaats.com/api/v1/x/images/${n}?rule=ecg_mp_eps$_#.jpg` }], vipUrl: `/v/cat/sub/m21000000${n}-mp-item-${n}`,
});
function mpPage(page) {
  let all = [mpListing(1, 10), mpListing(2, 20), mpListing(3, 30), mpListing(4, 40), mpListing(5, 0)];
  if (variant === 2) all = all.filter((l) => l.itemId !== 'm210000003').map((l) => (l.itemId === 'm210000002' ? { ...l, priceInfo: { ...l.priceInfo, priceCents: 1500 } } : l));
  const slice = page === 1 ? all.slice(0, 3) : all.slice(3 * (page - 1), 3 * page);
  const data = { props: { pageProps: { searchRequestAndResponse: { listings: slice, totalResultCount: all.length } } } };
  return `<html><body><h1>Profiel</h1><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

// The seller's own view of one ad (marktplaats.nl/seller/view/m…): the ad sits
// deep in the page data, and it is reserved ("gereserveerd").
pages['/seller/view/m2454474184'] = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialState: { ad: { listing: {
  itemId: 'm2454474184', title: 'Eiken salontafel', priceInfo: { priceCents: 4500, priceType: 'FIXED' }, reserved: true, location: { cityName: 'Utrecht' },
  pictures: [{ url: 'https://images.marktplaats.com/api/v1/x/images/t?rule=ecg_mp_eps$_#.jpg' }], vipUrl: '/v/huis-en-inrichting/tafels-salontafels/m2454474184-eiken-salontafel',
} } } } } })}</script></body></html>`;

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/__variant') { variant = Number(new URL(req.url, 'http://x').searchParams.get('v')); return res.end('ok'); }
  const mp = p.match(/^\/u\/test-seller\/123456\/(?:p\/(\d+)\/)?$/);
  if (mp) { res.setHeader('Content-Type', 'text/html'); return res.end(mpPage(Number(mp[1] || 1))); }
  const body = pages[p];
  if (!body) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', p.startsWith('/api') ? 'application/json' : 'text/html');
  res.end(body);
}).listen(4300, '127.0.0.1');
console.log('fixtures on :4300');
