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
http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const body = pages[p];
  if (!body) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', p.startsWith('/api') ? 'application/json' : 'text/html');
  res.end(body);
}).listen(4300, '127.0.0.1');
console.log('fixtures on :4300');
