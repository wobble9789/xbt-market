// Round 4: the admin publishes a bug report as a GitHub issue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { handle } from '../server/service.js';

const BASE = 'https://svc.example';
const store = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, list: async () => new Map() }; };
async function post(env, fetchImpl, path, body, sk) {
  const url = BASE + path;
  const text = JSON.stringify(body);
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', url], ['method', 'POST'], ['payload', bytesToHex(sha256(new TextEncoder().encode(text)))]], content: '' }, sk);
  const res = await handle(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Nostr ' + btoa(JSON.stringify(ev)) }, body: text }), env, store(), fetchImpl);
  return { status: res.status, data: await res.json() };
}

test('only the admin can publish an issue, with the bug-report label', async () => {
  const admin = generateSecretKey();
  const other = generateSecretKey();
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.authorization }); return new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/o/r/issues/7' }), { status: 201 }); };
  const env = { ISSUES_TOKEN: 'tok', ISSUES_REPO: 'o/r', ADMIN_NPUB: nip19.npubEncode(getPublicKey(admin)) };
  assert.equal((await post(env, fetchImpl, '/api/issues', { title: 'x', body: 'y' }, other)).status, 403);
  assert.equal(calls.length, 0);
  const ok = await post(env, fetchImpl, '/api/issues', { title: 'Button does nothing', body: 'steps' }, admin);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { number: 7, url: 'https://github.com/o/r/issues/7' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.deepEqual(calls[0].body.labels, ['bug-report']);
  assert.equal((await post({}, fetchImpl, '/api/issues', { title: 'x' }, admin)).status, 503);
});

import { imagesFromHtml, withPagePhotos, isLogo } from '../src/bookmarklet/extract.js';

test('all photos of an ad are found in its page, at a large size, without logos', () => {
  const html = `<script>window.__CONFIG__={"gallery":{"imageUrls":["//images.marktplaats.com/api/v1/listing-mp-p/images/ab/0f1c2d3e-1111-2222-3333-444455556666?rule=ecg_mp_eps$_83.jpg",
    "https:\\u002F\\u002Fimages.marktplaats.com\\u002Fapi\\u002Fv1\\u002Flisting-mp-p\\u002Fimages\\u002Fcd\\u002F99999999-1111-2222-3333-444455556666"]}}</script>
    <img src="//images.marktplaats.com/api/v1/listing-mp-p/images/ab/0f1c2d3e-1111-2222-3333-444455556666?rule=ecg_mp_eps$_14.jpg">
    <meta property="og:image" content="https://www.marktplaats.nl/static/logo-marktplaats.png">`;
  const found = imagesFromHtml(html);
  assert.equal(found.length, 2);
  assert.ok(found.every((u) => u.startsWith('https://images.marktplaats.com/') && u.endsWith('$_85.jpg')));
  const item = withPagePhotos({ title: 'x', images: ['https://www.marktplaats.nl/static/logo-marktplaats.png'] }, html);
  assert.deepEqual(item.images, found);
  assert.ok(isLogo('https://x/logo.png') && !isLogo(found[0]));
  assert.deepEqual(imagesFromHtml('<img src="https://i.ebayimg.com/images/g/AbC~dEf/s-l500.jpg">'), ['https://i.ebayimg.com/images/g/AbC~dEf/s-l1600.jpg']);
});

import { searchCategories } from '../src/lib/category-search.js';
import { CATEGORY_TREE } from '../src/lib/category-tree.js';
import { SYNONYMS } from '../src/lib/category-synonyms/index.js';

test('category search knows what people type, in English, Spanish and Dutch', () => {
  const tree = new Map(CATEGORY_TREE.map(([id, , , , c = []]) => [id, c]));
  const keys = new Set(CATEGORY_TREE.flatMap(([id, , , , c = []]) => [id, ...c.map((x) => `${id}/${x[0]}`)]));
  for (const k of Object.keys(SYNONYMS)) assert.ok(keys.has(k), k);
  const top = (q, lang) => searchCategories(q, tree, lang, SYNONYMS)[0];
  for (const [q, lang] of [['thermal', 'en'], ['thermal vision', 'en'], ['night vision', 'en'], ['prismaticos', 'es']]) {
    assert.equal(top(q, lang)?.subcategory, 'optische-apparatuur-verrekijkers', q);
  }
  assert.equal(top('ssd', 'en').subcategory, 'harde-schijven');
  assert.equal(top('sofa', 'en').category, 'huis-en-inrichting');
});
