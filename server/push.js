// Push notifications for saved searches. A device registers its Web Push
// subscription with the searches that notify; every few minutes (a cron
// trigger in the worker, or POST /internal/push-run) the service reads the new
// listings from the relays and sends each device a notification per search
// with new matches. Standard Web Push: VAPID (RFC 8292) and an encrypted
// payload (RFC 8291), with WebCrypto only. The VAPID key pair is made on first
// use and kept in the service's storage; no setup needed.
//
// Stored: push:<sha256(endpoint)> -> { subscription, searches: [{ id, name, query, since, sent }] }.
// Nothing about who the user is.

import { verifyEvent } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parseListing, LISTING_KIND } from '../src/lib/nostr/listings.js';
import { cleanSearch, matchesSearch, searchHash } from '../src/lib/search.js';
import { DEFAULTS, MARKET_TAG } from '../src/config.js';

const enc = (s) => new TextEncoder().encode(s);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(s).length % 4)) % 4)), (c) => c.charCodeAt(0));
const now = () => Math.floor(Date.now() / 1000);

// Push services of the browsers; nothing else is ever called (no requests to
// arbitrary addresses). PUSH_HOSTS adds hosts, for tests.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
function allowedEndpoint(endpoint, env) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  const extra = String(env.PUSH_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.includes(u.host)) return true;
  return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

// ---- VAPID ---------------------------------------------------------------------

export async function vapidKeys(store) {
  const have = await store.get('vapid');
  if (have) return have;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = { publicKey: b64url(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  await store.put('vapid', keys);
  return keys;
}

async function vapidHeader(endpoint, keys, subject) {
  const header = b64url(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc(JSON.stringify({ aud: new URL(endpoint).origin, exp: now() + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

// ---- payload encryption (RFC 8291, aes128gcm) -------------------------------------

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

export async function encryptPayload(payload, p256dh, auth, { salt = crypto.getRandomValues(new Uint8Array(16)), serverKeys } = {}) {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const as = serverKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hmac(await hmac(authSecret, shared), concat(enc('WebPush: info\0'), uaPublic, asPublic, [1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc('Content-Encoding: nonce\0'), [1]))).slice(0, 12);
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc(payload), [2])));
  const head = new Uint8Array(21 + asPublic.length);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPublic.length;
  head.set(asPublic, 21);
  return concat(head, body);
}

async function sendPush(subscription, payload, keys, env, fetchImpl) {
  const body = await encryptPayload(JSON.stringify(payload), subscription.keys.p256dh, subscription.keys.auth);
  const subject = env.VAPID_SUBJECT || `https://github.com/${env.ISSUES_REPO || 'wobble9789/xbt-market'}`;
  return fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: { authorization: await vapidHeader(subscription.endpoint, keys, subject), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' },
    body,
  });
}

// ---- registration ----------------------------------------------------------------

const subKey = (endpoint) => 'push:' + bytesToHex(sha256(enc(endpoint)));

export async function subscribe(body, env, store) {
  const sub = body.subscription || {};
  if (!allowedEndpoint(sub.endpoint, env)) throw Object.assign(new Error('Not a browser push address'), { status: 400 });
  let p256dh;
  let auth;
  try { p256dh = fromB64url(sub.keys?.p256dh || ''); auth = fromB64url(sub.keys?.auth || ''); } catch { /* checked below */ }
  if (p256dh?.length !== 65 || auth?.length !== 16) throw Object.assign(new Error('Bad push keys'), { status: 400 });
  const key = subKey(sub.endpoint);
  const list = Array.isArray(body.searches) ? body.searches.slice(0, 20) : [];
  if (!list.length) { await store.delete(key); return { ok: true, searches: 0 }; }
  const old = (await store.get(key))?.searches || [];
  const searches = list.map((s) => ({
    id: String(s.id || '').slice(0, 40),
    name: String(s.name || '').slice(0, 120),
    query: cleanSearch(s.query || {}),
    since: Number(s.since) || now(),
    sent: old.find((o) => o.id === s.id)?.sent || 0,
  })).filter((s) => s.id);
  await store.put(key, { subscription: { endpoint: sub.endpoint, keys: sub.keys }, searches, lang: body.lang === 'es' ? 'es' : 'en', at: now() });
  return { ok: true, searches: searches.length };
}

// ---- reading new listings from the relays ---------------------------------------------

async function openSocket(url) {
  if (typeof WebSocketPair !== 'undefined') { // Cloudflare Workers: a WebSocket via fetch
    const res = await fetch(url.replace(/^ws/, 'http'), { headers: { upgrade: 'websocket' } });
    const ws = res.webSocket;
    if (!ws) throw new Error('relay refused');
    ws.accept();
    return ws;
  }
  const ws = new WebSocket(url);
  await new Promise((ok, bad) => { ws.addEventListener('open', ok); ws.addEventListener('error', bad); });
  return ws;
}

export async function queryRelay(url, filter, timeout = 8000) {
  const events = [];
  let ws;
  try {
    ws = await openSocket(url);
    await new Promise((done) => {
      const t = setTimeout(done, timeout);
      ws.addEventListener('message', (m) => {
        let msg;
        try { msg = JSON.parse(typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data)); } catch { return; }
        if (msg[0] === 'EVENT' && msg[1] === 'x') events.push(msg[2]);
        if ((msg[0] === 'EOSE' && msg[1] === 'x') || msg[0] === 'CLOSED') { clearTimeout(t); done(); }
      });
      ws.addEventListener('close', () => { clearTimeout(t); done(); });
      ws.send(JSON.stringify(['REQ', 'x', filter]));
    });
  } catch { /* an unreachable relay: the others still count */ }
  try { ws?.close(); } catch { /* already closed */ }
  return events;
}

export async function newListings(relays, since) {
  const filter = { kinds: [LISTING_KIND], '#t': [MARKET_TAG], since, limit: 500 };
  const all = (await Promise.all(relays.map((r) => queryRelay(r, filter)))).flat();
  const seen = new Map();
  for (const e of all) if (!seen.has(e.id) && e.created_at >= since && verifyEvent(e)) seen.set(e.id, e);
  return [...seen.values()].map(parseListing).filter((l) => l && l.status === 'active');
}

// ---- the run: match and notify ----------------------------------------------------------------

export async function runPush(env, store, fetchImpl = globalThis.fetch.bind(globalThis), { listings } = {}) {
  const subs = await store.list({ prefix: 'push:', limit: 5000 });
  const t = now();
  const last = (await store.get('push-last')) || t - 3600;
  await store.put('push-last', t);
  if (!subs.size) return { devices: 0, sent: 0 };
  const relays = String(env.RELAYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  // A few minutes of overlap: relays may receive a listing late. "sent" prevents doubles.
  const fresh = listings || await newListings(relays.length ? relays : DEFAULTS.relays, last - 600);
  if (!fresh.length) return { devices: subs.size, sent: 0 };
  const keys = await vapidKeys(store);
  let sent = 0;
  for (const [key, rec] of subs) {
    let changed = false;
    for (const s of rec.searches) {
      const from = Math.max(s.since || 0, s.sent || 0);
      // The service has no exchange rates: a price range only counts for listings in its currency.
      const priceIn = (l) => (l.currency === (s.query.cur || l.currency) ? l.price : null);
      const hits = fresh.filter((l) => l.createdAt > from && matchesSearch(l, s.query, { priceIn }));
      if (!hits.length) continue;
      const es = rec.lang === 'es';
      const payload = {
        title: es ? `Nuevo para «${s.name}»` : `New for “${s.name}”`,
        body: hits.length === 1 ? hits[0].title : es ? `${hits.length} anuncios nuevos` : `${hits.length} new listings`,
        tag: s.id,
        url: './' + searchHash(s.query, { saved: s.id, new: 1 }),
      };
      const res = await sendPush(rec.subscription, payload, keys, env, fetchImpl).catch(() => null);
      if (res && (res.status === 404 || res.status === 410)) { await store.delete(key); changed = false; break; }
      if (res?.ok) sent++;
      s.sent = Math.max(...hits.map((l) => l.createdAt));
      changed = true;
    }
    if (changed) await store.put(key, rec);
  }
  return { devices: subs.size, sent };
}
