// Push notifications for saved searches: the encrypted payload, the
// registration and which new listings lead to a notification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload, subscribe, runPush, b64url, fromB64url, vapidKeys } from '../server/push.js';
import { listingTemplate, parseListing } from '../src/lib/nostr/listings.js';
import { matchesSearch, cleanSearch, searchHash } from '../src/lib/search.js';
import { mergePrivate } from '../src/lib/nostr/private.js';

const memStore = () => {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
};
const enc = (s) => new TextEncoder().encode(s);
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function device() {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { ua, auth, keys: { p256dh: b64url(await crypto.subtle.exportKey('raw', ua.publicKey)), auth: b64url(auth) } };
}
// What the browser does with a push message (RFC 8291).
async function decrypt(body, d) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const uaPublic = fromB64url(d.keys.p256dh);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, d.ua.privateKey, 256));
  const ikm = await hmac(await hmac(d.auth, shared), new Uint8Array([...enc('WebPush: info\0'), ...uaPublic, ...asPublic, 1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, new Uint8Array([...enc('Content-Encoding: aes128gcm\0'), 1]))).slice(0, 16);
  const nonce = (await hmac(prk, new Uint8Array([...enc('Content-Encoding: nonce\0'), 1]))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)));
  assert.equal(plain[plain.length - 1], 2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

test('push: the payload decrypts on the device (RFC 8291)', async () => {
  const d = await device();
  const body = await encryptPayload('{"title":"Hi"}', d.keys.p256dh, d.keys.auth);
  assert.equal(await decrypt(body, d), '{"title":"Hi"}');
});

const listing = (d, extra, at) => parseListing({ id: d, pubkey: 'b'.repeat(64), created_at: at, ...listingTemplate({ d, content: '', currency: 'EUR', payments: ['lightning'], ...extra }) });

test('push: only browser push services; one notification per search with new matches, never twice', async () => {
  const store = memStore();
  const d = await device();
  const env = {};
  await assert.rejects(subscribe({ subscription: { endpoint: 'https://evil.example/x', keys: d.keys }, searches: [{ id: 's1', query: {} }] }, env, store), /push address/);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
  await subscribe({ subscription: { endpoint, keys: d.keys }, searches: [{ id: 's1', name: 'lamp', query: { q: 'lamp', max: '30', cur: 'EUR' }, since: 1000 }], lang: 'en' }, env, store);
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return new Response('', { status: 201 }); };
  const listings = [
    listing('a', { title: 'Brass lamp', price: 20 }, 2000),
    listing('b', { title: 'Old lamp', price: 50 }, 2000), // too expensive
    listing('c', { title: 'Brass lamp too early', price: 20 }, 900), // before the search
    listing('d', { title: 'Chair', price: 10 }, 2000),
  ];
  const r = await runPush(env, store, fetchImpl, { listings });
  assert.equal(r.sent, 1);
  assert.equal(sent[0].url, endpoint);
  const h = sent[0].init.headers;
  assert.match(h.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
  assert.equal(h['content-encoding'], 'aes128gcm');
  const msg = JSON.parse(await decrypt(sent[0].init.body, d));
  assert.equal(msg.title, 'New for “lamp”');
  assert.equal(msg.body, 'Brass lamp');
  assert.equal(msg.url, './' + searchHash({ q: 'lamp', max: '30' }, { saved: 's1', new: 1 }));
  // The VAPID signature checks out with the public key.
  const [, jwt, k] = h.authorization.match(/t=(\S+), k=(\S+)/);
  const [hd, cl, sig] = jwt.split('.');
  const pub = await crypto.subtle.importKey('raw', fromB64url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(sig), enc(`${hd}.${cl}`)));
  assert.equal(k, (await vapidKeys(store)).publicKey);
  // Same listings again: nothing new to tell.
  assert.equal((await runPush(env, store, fetchImpl, { listings })).sent, 0);
  // A device that is gone (410) is removed.
  await runPush(env, store, async () => new Response('', { status: 410 }), { listings: [listing('e', { title: 'New lamp', price: 5 }, 3000)] });
  assert.equal((await store.list({ prefix: 'push:' })).size, 0);
});

test('saved searches: same rules everywhere; private data merges entry by entry', () => {
  const l = listing('x', { title: 'Red bike', price: 100, category: 'fietsen-en-brommers' }, 1);
  assert.ok(matchesSearch(l, { q: 'bike', c: 'fietsen-en-brommers' }));
  assert.ok(!matchesSearch(l, { q: 'bike car' }));
  assert.ok(!matchesSearch(l, { min: '150' }, { priceIn: (x) => x.price }));
  assert.ok(!matchesSearch(l, { min: '50' }), 'unknown price is left out of a price range');
  assert.deepEqual(cleanSearch({ q: ' bike ', c: '', min: '', cur: 'EUR' }), { q: 'bike' });
  const a = { hidden: { t1: { at: 5 } }, searches: { s1: { at: 1, name: 'old' } } };
  const b = { hidden: { t2: { at: 3 } }, searches: { s1: { at: 2, name: 'new' }, s2: { at: 9, gone: true } } };
  const m = mergePrivate(a, b);
  assert.deepEqual(Object.keys(m.hidden).sort(), ['t1', 't2']);
  assert.equal(m.searches.s1.name, 'new');
  assert.equal(m.searches.s2.gone, true);
});
