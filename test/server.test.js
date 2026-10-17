// The XBT Market service (server/service.js) with an in-memory store and fake
// Sendcloud, Lightning address and shop pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { handle, appCarrierOf } from '../server/service.js';
import { fakeInvoice } from '../dev/fake-invoice.mjs';

const BASE = 'https://svc.example';
function memStore() {
  const m = new Map();
  return {
    m,
    get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); },
    list: async ({ prefix = '', limit = 1000 }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().slice(0, limit)),
  };
}
const user = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };

async function call(store, env, fetchImpl, path, { method = 'GET', body, as } = {}) {
  const url = BASE + path;
  const text = body ? JSON.stringify(body) : undefined;
  const headers = { 'content-type': 'application/json' };
  if (as) {
    const tags = [['u', url], ['method', method], ...(text ? [['payload', bytesToHex(sha256(new TextEncoder().encode(text)))]] : [])];
    const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, as.sk);
    headers.authorization = 'Nostr ' + btoa(JSON.stringify(ev));
  }
  const res = await handle(new Request(url, { method, headers, body: text }), env, store, fetchImpl);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
}

test('usernames are unique, verifiable over NIP-05 and searchable', async () => {
  const store = memStore();
  const a = user();
  const b = user();
  const env = {};
  assert.equal((await call(store, env, fetch, '/api/names', { method: 'POST', body: { name: 'alice' } })).status, 401);
  assert.equal((await call(store, env, fetch, '/api/names', { method: 'POST', body: { name: 'alice' }, as: a })).status, 200);
  const taken = await call(store, env, fetch, '/api/names', { method: 'POST', body: { name: 'alice' }, as: b });
  assert.equal(taken.status, 409);
  assert.match(taken.data.error, /taken/);
  assert.equal((await call(store, env, fetch, '/api/names', { method: 'POST', body: { name: 'admin' }, as: b })).status, 409);
  assert.equal((await call(store, env, fetch, '/api/names', { method: 'POST', body: { name: 'A!' }, as: b })).status, 400);
  const nj = await call(store, env, fetch, '/.well-known/nostr.json?name=alice');
  assert.deepEqual(nj.data, { names: { alice: a.pk } });
  assert.equal(nj.headers.get('access-control-allow-origin'), '*');
  assert.equal((await call(store, env, fetch, '/api/names/alice')).data.available, false);
  assert.equal((await call(store, env, fetch, '/api/names/alicia')).data.available, true);
  // Changing your name frees the old one.
  await call(store, env, fetch, '/api/names', { method: 'POST', body: { name: 'alicia' }, as: a });
  assert.equal((await call(store, env, fetch, '/api/names/alice')).data.available, true);
  await call(store, env, fetch, '/api/names', { method: 'POST', body: { name: 'alina' }, as: b });
  const found = await call(store, env, fetch, '/api/names?q=ali');
  assert.deepEqual(found.data.names.map((n) => n.name), ['alicia', 'alina']);
});

test('a signature for another URL or body is refused', async () => {
  const store = memStore();
  const a = user();
  const url = BASE + '/api/names';
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', url], ['method', 'POST'], ['payload', 'ab'.repeat(32)]], content: '' }, a.sk);
  const res = await handle(new Request(url, { method: 'POST', headers: { authorization: 'Nostr ' + btoa(JSON.stringify(ev)) }, body: JSON.stringify({ name: 'bob' }) }), {}, store, fetch);
  assert.equal(res.status, 401);
});

test('carrier codes map to the app carriers', () => {
  assert.equal(appCarrierOf('mondial_relay'), 'mondialrelay');
  assert.equal(appCarrierOf('postnl'), 'postnl');
  assert.equal(appCarrierOf('gls_eu'), 'gls');
  assert.equal(appCarrierOf('deutsche_post'), 'deutschepost');
  assert.equal(appCarrierOf('unknown_carrier'), null);
});

// A fake Sendcloud and platform Lightning address.
function fakeWorld() {
  const invoices = new Map();
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: url.href, body, headers: init.headers });
    const ok = (o, type = 'application/json') => new Response(type === 'application/json' ? JSON.stringify(o) : o, { status: 200, headers: { 'content-type': type } });
    if (url.pathname === '/api/v3/shipping-options') {
      return ok({ data: [
        { code: 'postnl:standard', carrier: { code: 'postnl' }, functionalities: { labelless: true }, quotes: [{ price: { total: { value: '6.95', currency: 'EUR' } } }] },
        { code: 'postnl:signature', carrier: { code: 'postnl' }, quotes: [{ price: { total: { value: '8.10', currency: 'EUR' } } }] },
        { code: 'mondial_relay:service_point_qr', carrier: { code: 'mondial_relay' }, functionalities: { labelless: true, last_mile: 'service_point' }, quotes: [{ price: { total: { value: '3.95', currency: 'EUR' } } }] },
        { code: 'ups:standard', carrier: { code: 'ups' }, quotes: [{ price: { total: { value: '12.00', currency: 'EUR' } } }] },
      ] });
    }
    if (url.pathname === '/api/v3/shipments/announce') {
      return ok({ data: { id: 'sh1', parcels: [{ id: 77, tracking_number: '3SPOST123', tracking_url: 'https://track/3SPOST123', documents: [{ type: 'label', link: 'https://panel.sendcloud.sc/api/v3/parcels/77/documents/label' }, { type: 'qr', link: 'https://panel.sendcloud.sc/api/v3/parcels/77/documents/qr' }] }] } });
    }
    if (url.pathname === '/api/v3/parcels/77/documents/qr') return ok('PNG', 'image/png');
    if (url.pathname === '/.well-known/lnurlp/platform') return ok({ tag: 'payRequest', callback: 'https://ln.example/cb', minSendable: 1000, maxSendable: 1e14 });
    if (url.href.startsWith('https://ln.example/cb')) {
      const sats = Number(url.searchParams.get('amount')) / 1000;
      const inv = fakeInvoice({ sats, network: 'bcrt', preimage: crypto.getRandomValues(new Uint8Array(32)) });
      invoices.set(inv.paymentHash, { settled: false });
      return ok({ pr: inv.invoice, verify: `https://ln.example/verify/${inv.paymentHash}` });
    }
    if (url.href.startsWith('https://ln.example/verify/')) return ok(invoices.get(url.pathname.split('/').pop()));
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, invoices, calls };
}

const ADDR = (name, country, city) => ({ name, street: 'Hoofdstraat', number: '1', postalCode: '1234AB', city, country, email: 'x@example.com' });

test('shipping prices, then a label paid over Lightning, with a QR code', async () => {
  const store = memStore();
  const seller = user();
  const w = fakeWorld();
  const env = { SENDCLOUD_PUBLIC_KEY: 'pub', SENDCLOUD_SECRET_KEY: 'sec', PLATFORM_LN_ADDRESS: 'platform@ln.example', XBT_RATE_EUR: '50000' };
  const q = await call(store, env, w.fetchImpl, '/api/shipping/quote', { method: 'POST', body: { from: { country: 'NL' }, to: { country: 'DE' }, size: 'S', carriers: ['postnl', 'mondialrelay'] } });
  assert.equal(q.status, 200);
  // Cheapest per carrier and delivery type, only the seller's carriers, cheapest first.
  assert.deepEqual(q.data.options.map((o) => [o.carrier, o.price, o.servicePoint]), [['mondialrelay', 3.95, true], ['postnl', 6.95, false]]);
  assert.equal(w.calls[0].headers.authorization, 'Basic ' + btoa('pub:sec'));
  assert.equal(w.calls[0].body.parcels[0].weight.value, '2');
  const postnl = q.data.options.find((o) => o.carrier === 'postnl');

  // A point delivery needs a pick-up point.
  const mr = q.data.options.find((o) => o.carrier === 'mondialrelay');
  assert.equal((await call(store, env, w.fetchImpl, '/api/shipping/labels', { method: 'POST', as: seller, body: { quoteId: mr.id, from: ADDR('S', 'NL', 'Utrecht'), to: ADDR('B', 'DE', 'Berlin') } })).status, 400);
  // Wrong country for the price.
  assert.equal((await call(store, env, w.fetchImpl, '/api/shipping/labels', { method: 'POST', as: seller, body: { quoteId: postnl.id, from: ADDR('S', 'NL', 'Utrecht'), to: ADDR('B', 'FR', 'Paris') } })).status, 400);

  const created = await call(store, env, w.fetchImpl, '/api/shipping/labels', { method: 'POST', as: seller, body: { quoteId: postnl.id, from: ADDR('S', 'NL', 'Utrecht'), to: ADDR('B', 'DE', 'Berlin'), tradeId: 't1' } });
  assert.equal(created.status, 200);
  assert.equal(created.data.status, 'unpaid');
  assert.equal(created.data.sats, Math.ceil((6.95 / 50000) * 1e8));
  assert.match(created.data.invoice, /^lnbcrt/);

  const id = created.data.id;
  const other = user();
  assert.equal((await call(store, env, w.fetchImpl, `/api/shipping/labels/${id}`, { as: other })).status, 404);
  assert.equal((await call(store, env, w.fetchImpl, `/api/shipping/labels/${id}`, { as: seller })).data.status, 'unpaid');
  assert.ok(!w.calls.some((c) => c.url.includes('/shipments/announce')), 'no label before payment');

  [...w.invoices.values()][0].settled = true;
  const done = await call(store, env, w.fetchImpl, `/api/shipping/labels/${id}`, { as: seller });
  assert.equal(done.data.status, 'created');
  assert.equal(done.data.tracking, '3SPOST123');
  assert.equal(done.data.documents.qr, `/api/shipping/labels/${id}/qr`);
  const announce = w.calls.find((c) => c.url.includes('/shipments/announce')).body;
  assert.equal(announce.ship_with.properties.shipping_option_code, 'postnl:standard');
  assert.equal(announce.to_address.city, 'Berlin');
  assert.equal(announce.external_reference_id, id);
  const qr = await call(store, env, w.fetchImpl, `/api/shipping/labels/${id}/qr`);
  assert.equal(qr.status, 200);
  assert.equal(qr.data, 'PNG');
});

test('import from a pasted Marktplaats link, including a single ad page', async () => {
  const store = memStore();
  const ad = { itemId: 'm2454474184', title: 'Eiken salontafel', priceInfo: { priceCents: 4500, priceType: 'FIXED' }, pictures: [{ url: 'https://img/x$_#.jpg' }], vipUrl: '/v/huis-en-inrichting/tafels-salontafels/m2454474184-eiken', reserved: true };
  const page = (data) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
  const fetchImpl = async (u) => {
    const url = new URL(u);
    if (url.pathname === '/seller/view/m2454474184') return new Response(page({ props: { pageProps: { initialState: { ad: { listing: ad } } } } }), { status: 200 });
    if (url.pathname === '/u/piet/123/') return new Response(page({ props: { pageProps: { searchRequestAndResponse: { totalResultCount: 1, listings: [ad] } } } }), { status: 200 });
    return new Response('', { status: 404 });
  };
  const one = await call(store, {}, fetchImpl, '/api/import', { method: 'POST', body: { url: 'https://www.marktplaats.nl/seller/view/m2454474184' } });
  assert.equal(one.status, 200);
  assert.equal(one.data.items.length, 1);
  assert.equal(one.data.items[0].title, 'Eiken salontafel');
  assert.equal(one.data.items[0].price, 45);
  assert.equal(one.data.items[0].reserved, true);
  assert.equal(one.data.items[0].subcategory, 'tafels-salontafels');
  const profile = await call(store, {}, fetchImpl, '/api/import', { method: 'POST', body: { url: 'https://www.marktplaats.nl/u/piet/123/' } });
  assert.equal(profile.data.complete, true);
  const none = await call(store, {}, fetchImpl, '/api/import', { method: 'POST', body: { url: 'https://www.marktplaats.nl/nothing' } });
  assert.equal(none.status, 502);
  assert.equal((await call(store, {}, fetchImpl, '/api/import', { method: 'POST', body: { url: 'not a link' } })).status, 400);
});
