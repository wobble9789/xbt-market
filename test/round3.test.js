// Round 3: category search and models, strict "ships to", XBT Lightning
// invoices, suspended accounts and bug reports by e-mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { searchCategories } from '../src/lib/category-search.js';
import { CATEGORY_TREE } from '../src/lib/category-tree.js';
import { MODELS } from '../src/lib/category-models.js';
import { shipsToCountry } from '../src/lib/countries.js';
import { decodeInvoice } from '../src/lib/ln/bolt11.js';
import { listingTemplate, parseListing } from '../src/lib/nostr/listings.js';
import { fakeInvoice } from '../dev/fake-invoice.mjs';
import { handle } from '../server/service.js';

const tree = new Map(CATEGORY_TREE.map(([id, , , , c = []]) => [id, c]));
const top = (q, lang = 'nl') => searchCategories(q, tree, lang)[0];

test('category search finds categories from everyday words, also in compounds', () => {
  assert.equal(top('ssd').subcategory, 'harde-schijven');
  assert.equal(top('warmtebeeldkijker').subcategory, 'optische-apparatuur-verrekijkers');
  assert.equal(top('thermal binoculars', 'en').subcategory, 'optische-apparatuur-verrekijkers');
  assert.equal(top('winterjas').subcategory, 'jassen-winter');
  assert.equal(top('lego').category, 'kinderen-en-baby-s');
  const ford = top('ford transit');
  assert.deepEqual([ford.category, ford.subcategory], ['auto-s', 'bestelauto-s']);
  assert.match(ford.model, /transit/);
  assert.deepEqual(searchCategories('', tree), []);
});

test('car and motorbike models: a third level under existing subcategories', () => {
  for (const key of Object.keys(MODELS)) {
    const [l1, l2] = key.split('/');
    assert.ok(tree.get(l1)?.some((r) => r[0] === l2), key);
  }
  assert.ok(MODELS['auto-s/ford'].some(([id]) => id === 'focus'));
  const PK = 'ab'.repeat(32);
  const ev = { id: 'x', pubkey: PK, created_at: 1, ...listingTemplate({ d: 'l', title: 'Ford Focus', content: '', price: 4000, currency: 'EUR', category: 'auto-s', subcategory: 'ford', model: 'focus' }) };
  const l = parseListing(ev);
  assert.deepEqual([l.subcategory, l.model], ['ford', 'focus']);
});

test('"ships to" is exactly what the seller chose', () => {
  assert.equal(shipsToCountry(['EG'], 'NL', 'NL'), false);
  assert.equal(shipsToCountry(['EG'], 'EG', 'NL'), true);
  assert.equal(shipsToCountry(['EU'], 'DE', 'NL'), true);
  assert.equal(shipsToCountry(['WORLD'], 'CN', 'NL'), true);
  assert.equal(shipsToCountry([], 'NL', 'NL'), true);
  assert.equal(shipsToCountry([], 'DE', 'NL'), false);
  assert.equal(shipsToCountry([], 'DE', ''), true);
});

test('XBT Lightning invoices are told apart from Bitcoin ones (feature bit 512)', () => {
  const xbt = decodeInvoice(fakeInvoice({ sats: 1000, blake2b: true }).invoice);
  const btc = decodeInvoice(fakeInvoice({ sats: 1000 }).invoice);
  assert.equal(xbt.blake2b, true);
  assert.equal(btc.blake2b, false);
  assert.equal(xbt.amountSats, 1000);
});

const BASE = 'https://svc.example';
const store = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, list: async () => new Map() }; };
async function bug(st, env, fetchImpl, body, sk) {
  const url = BASE + '/api/bug';
  const text = JSON.stringify(body);
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', url], ['method', 'POST'], ['payload', bytesToHex(sha256(new TextEncoder().encode(text)))]], content: '' }, sk);
  const res = await handle(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Nostr ' + btoa(JSON.stringify(ev)) }, body: text }), env, st, fetchImpl);
  return { status: res.status, data: await res.json() };
}

test('bug reports are e-mailed with attachments; the address stays on the server', async () => {
  const sk = generateSecretKey();
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body), auth: opts.headers.authorization }); return new Response('{"id":"e1"}', { status: 200 }); };
  const env = { RESEND_API_KEY: 're_test', BUG_REPORT_EMAIL: 'maintainer@example.com' };
  const st = store();
  const ok = await bug(st, env, fetchImpl, { text: 'Button does nothing\nsteps…', page: '#/sell', ua: 'test', attachments: [{ filename: 'shot.png', type: 'image/png', content: 'iVBORw0KGgo=' }] }, sk);
  assert.equal(ok.status, 200);
  assert.equal(sent[0].url, 'https://api.resend.com/emails');
  assert.deepEqual(sent[0].body.to, ['maintainer@example.com']);
  assert.equal(sent[0].auth, 'Bearer re_test');
  assert.equal(sent[0].body.attachments[0].filename, 'shot.png');
  assert.match(sent[0].body.html, new RegExp(getPublicKey(sk)));
  assert.equal(JSON.stringify(ok.data).includes('maintainer@'), false);
  // Only images and videos.
  assert.equal((await bug(st, env, fetchImpl, { text: 'x', attachments: [{ filename: 'a.exe', type: 'application/x-msdownload', content: 'AA' }] }, sk)).status, 400);
  // At most 5 an hour per account.
  for (let i = 0; i < 3; i++) await bug(st, env, fetchImpl, { text: 'again' }, sk);
  assert.equal((await bug(st, env, fetchImpl, { text: 'again' }, sk)).status, 429);
  // Not set up: a clear error.
  assert.equal((await bug(store(), {}, fetchImpl, { text: 'x' }, sk)).status, 503);
});
