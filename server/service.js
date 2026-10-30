// The XBT Market service: the few things a static app cannot do by itself.
//   - usernames: unique name@<this domain> Nostr addresses (NIP-05)
//   - shipping: live prices and prepaid labels through Sendcloud (API v3),
//     paid by the seller over Lightning to the platform's Lightning address
//   - import: read a public Marktplaats / Vinted page from a pasted link
//   - bug reports: e-mailed to the maintainer (with screenshots or a video)
//   - push notifications for saved searches (new listings), see push.js
//   - a relay for AI services that refuse requests from websites, see ai.js
// It holds no user keys and no listings. Every request that acts for a user is
// signed with their Nostr key (NIP-98).
//
// Storage is a tiny key/value interface ({ get, put, delete, list({ prefix, limit }) })
// so the same code runs in a Cloudflare Durable Object (worker.js) and in Node
// (node.mjs, for development and tests).
//
// env: SENDCLOUD_PUBLIC_KEY, SENDCLOUD_SECRET_KEY, SENDCLOUD_BASE (optional),
//      PLATFORM_LN_ADDRESS (Lightning address with LUD-21 "verify", receives label payments),
//      LABEL_MARKUP_PCT (optional, default 0), XBT_RATE_EUR (optional fixed rate, for tests),
//      LABELS_FREE=1 (development only: skip the payment), ALLOWED_ORIGINS (optional, comma separated)
//      RESEND_API_KEY + BUG_REPORT_EMAIL (bug reports by e-mail, via resend.com), RESEND_BASE (optional),
//      BUG_REPORT_FROM (optional sender, default "XBT Market <onboarding@resend.dev>")
//      ISSUES_TOKEN + ISSUES_REPO ("owner/repo") + ADMIN_NPUB: the admin publishes a bug report as a
//      GitHub issue, GITHUB_API (optional, for tests)
//      RELAYS (optional, comma separated: where new listings are read for push notifications),
//      VAPID_SUBJECT (optional contact for push services), PUSH_HOSTS (optional extra push hosts, for tests)

import { verifyEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { lnurlpUrl } from '../src/lib/ln/lnurl.js';
import { decodeInvoice } from '../src/lib/ln/bolt11.js';
import { vapidKeys, subscribe as pushSubscribe, runPush } from './push.js';
import { relayAi } from './ai.js';
import { nextDataFromHtml, mpResults, fromMp, fromVinted, flattenJsonLd, productsFromJsonLd, findMpListings, dedupeItems, imagesFromHtml, isLogo, BOOKMARKLET_VERSION } from '../src/bookmarklet/extract.js';

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set(['admin', 'administrator', 'root', 'support', 'help', 'info', 'xbt', 'xbtmarket', 'xbt_market', 'market', 'marketplace', 'official', 'arbiter', 'moderator', 'mod', 'staff', 'team', 'security', 'abuse', 'postmaster', 'webmaster', 'nostr', 'bitcoin', 'satoshi', 'null', 'undefined']);

// Parcel sizes the seller picks, like Vinted: maximum weight and box.
export const SIZES = {
  S: { kg: 2, cm: [34, 25, 8] },
  M: { kg: 5, cm: [40, 30, 20] },
  L: { kg: 10, cm: [60, 40, 30] },
  XL: { kg: 20, cm: [80, 50, 40] },
};

// App carrier ids -> Sendcloud carrier code prefixes.
const CARRIER_CODES = {
  postnl: ['postnl'], dhl: ['dhl'], dpd: ['dpd'], gls: ['gls'], ups: ['ups'], budbee: ['budbee'], inpost: ['inpost'],
  mondialrelay: ['mondial_relay', 'mondialrelay'], bpost: ['bpost'], colissimo: ['colissimo'], correos: ['correos'],
  deutschepost: ['deutsche_post', 'deutschepost'], hermes: ['hermes', 'evri'], poste: ['poste_italiane', 'poste'],
};
export function appCarrierOf(code) {
  const c = String(code || '').toLowerCase();
  return Object.keys(CARRIER_CODES).find((id) => CARRIER_CODES[id].some((p) => c === p || c.startsWith(p + '_') || c.startsWith(p + ':') || c.startsWith(p))) || null;
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const fail = (status, error) => json({ error }, status);
const now = () => Math.floor(Date.now() / 1000);
const randomId = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)));

// ---- NIP-98 HTTP auth ---------------------------------------------------------

export async function authPubkey(request, bodyText) {
  const h = request.headers.get('authorization') || '';
  if (!h.startsWith('Nostr ')) throw Object.assign(new Error('Sign in required'), { status: 401 });
  let ev;
  try { ev = JSON.parse(atob(h.slice(6))); } catch { throw Object.assign(new Error('Bad auth header'), { status: 401 }); }
  const tag = (n) => ev.tags?.find((t) => t[0] === n)?.[1];
  const ok = ev.kind === 27235 && Math.abs(now() - ev.created_at) <= 120 && tag('u') === request.url && tag('method') === request.method
    && (!bodyText || tag('payload') === bytesToHex(sha256(new TextEncoder().encode(bodyText)))) && verifyEvent(ev);
  if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 });
  return ev.pubkey;
}

// ---- usernames ----------------------------------------------------------------

async function nostrJson(url, store) {
  const name = (url.searchParams.get('name') || '').toLowerCase();
  if (!name) return json({ names: {} });
  const pk = await store.get('name:' + name);
  return json({ names: pk ? { [name]: pk } : {} });
}

async function nameInfo(name, store) {
  const n = String(name || '').toLowerCase();
  if (!USERNAME_RE.test(n)) return json({ name: n, available: false, error: '3-20 characters: a-z, 0-9 and _' });
  const pk = await store.get('name:' + n);
  return json({ name: n, available: !pk && !RESERVED.has(n), pubkey: pk || null, reserved: RESERVED.has(n) });
}

async function searchNames(q, store) {
  const prefix = String(q || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!prefix) return json({ names: [] });
  const m = await store.list({ prefix: 'name:' + prefix, limit: 20 });
  return json({ names: [...m].map(([k, pubkey]) => ({ name: k.slice(5), pubkey })) });
}

async function claimName(pk, body, store) {
  const n = String(body.name || '').toLowerCase();
  const old = await store.get('pk:' + pk);
  if (!n) { // release
    if (old) { await store.delete('name:' + old); await store.delete('pk:' + pk); }
    return json({ ok: true, name: null });
  }
  if (!USERNAME_RE.test(n)) return fail(400, 'A username has 3-20 characters: a-z, 0-9 and _');
  if (RESERVED.has(n)) return fail(409, 'This username is reserved');
  const owner = await store.get('name:' + n);
  if (owner && owner !== pk) return fail(409, 'This username is already taken');
  if (old && old !== n) await store.delete('name:' + old);
  await store.put('name:' + n, pk);
  await store.put('pk:' + pk, n);
  return json({ ok: true, name: n });
}

// ---- exchange rate ------------------------------------------------------------

let rateCache = { at: 0, value: null };
export async function xbtEur(env, fetchImpl) {
  if (env.XBT_RATE_EUR) return Number(env.XBT_RATE_EUR);
  if (Date.now() - rateCache.at < 5 * 60_000 && rateCache.value) return rateCache.value;
  const [t, fx] = await Promise.all([
    fetchImpl('https://safetrade.com/api/v2/trade/public/tickers/xbtusdt').then((r) => r.json()),
    fetchImpl('https://api.coinbase.com/v2/exchange-rates?currency=USDT').then((r) => r.json()),
  ]);
  const usdt = Number(t.last ?? t.ticker?.last);
  const eur = Number(fx.data?.rates?.EUR);
  if (!(usdt > 0 && eur > 0)) throw new Error('No XBT exchange rate available');
  rateCache = { at: Date.now(), value: usdt * eur };
  return rateCache.value;
}

// ---- Sendcloud -----------------------------------------------------------------

function sendcloud(env, fetchImpl) {
  const base = (env.SENDCLOUD_BASE || 'https://panel.sendcloud.sc/api/v3').replace(/\/+$/, '');
  const auth = 'Basic ' + btoa(`${env.SENDCLOUD_PUBLIC_KEY}:${env.SENDCLOUD_SECRET_KEY}`);
  return async (path, { method = 'GET', body, accept = 'application/json', raw = false } = {}) => {
    const r = await fetchImpl(path.startsWith('http') ? path : base + path, {
      method, headers: { authorization: auth, accept, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) return r;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j.errors?.map?.((e) => e.detail || e.message).join('; ') || j.error?.message || j.message || `Sendcloud ${r.status}`;
      throw Object.assign(new Error(msg), { status: r.status === 409 ? 409 : 502, data: j });
    }
    return j;
  };
}

const parcelOf = (size) => {
  const s = SIZES[size] || SIZES.M;
  return { weight: { value: String(s.kg), unit: 'kg' }, dimensions: { length: String(s.cm[0]), width: String(s.cm[1]), height: String(s.cm[2]), unit: 'cm' } };
};
const needsServicePoint = (o) => o.functionalities?.last_mile === 'service_point' || !!o.requirements?.is_service_point_required;
const priceOf = (o) => o.quotes?.[0]?.price?.total;

async function quote(body, env, store, fetchImpl) {
  if (!env.SENDCLOUD_PUBLIC_KEY) return fail(503, 'Shipping labels are not set up on this server');
  const { from = {}, to = {}, size = 'M', carriers = [] } = body;
  if (!/^[A-Z]{2}$/.test(from.country || '') || !/^[A-Z]{2}$/.test(to.country || '')) return fail(400, 'Countries are required');
  const sc = sendcloud(env, fetchImpl);
  const res = await sc('/shipping-options', {
    method: 'POST',
    body: {
      from_country_code: from.country, to_country_code: to.country,
      ...(from.postalCode ? { from_postal_code: from.postalCode } : {}), ...(to.postalCode ? { to_postal_code: to.postalCode } : {}),
      parcels: [parcelOf(size)], calculate_quotes: true,
    },
  });
  const markup = 1 + (Number(env.LABEL_MARKUP_PCT) || 0) / 100;
  const best = new Map(); // cheapest per app carrier and delivery type
  for (const o of res.data || []) {
    const carrier = appCarrierOf(o.carrier?.code || o.code);
    const p = priceOf(o);
    if (!carrier || !p || !(Number(p.value) > 0)) continue;
    if (carriers.length && !carriers.includes(carrier)) continue;
    const point = needsServicePoint(o);
    const k = carrier + (point ? ':point' : ':home');
    const price = Math.round(Number(p.value) * markup * 100) / 100;
    if (!best.has(k) || best.get(k).price > price) {
      best.set(k, { carrier, code: o.code, name: o.name || o.product?.name || o.code, carrierName: o.carrier?.name || carrier, price, currency: p.currency || 'EUR', servicePoint: point, labelless: !!o.functionalities?.labelless });
    }
  }
  const options = [];
  for (const o of [...best.values()].sort((a, b) => a.price - b.price)) {
    const id = 'q' + randomId();
    await store.put('quote:' + id, JSON.stringify({ ...o, from, to, size, at: now() }));
    options.push({ id, ...o });
  }
  return json({ options, size });
}

async function servicePoints(url, env, fetchImpl) {
  if (!env.SENDCLOUD_PUBLIC_KEY) return fail(503, 'Shipping labels are not set up on this server');
  const p = url.searchParams;
  const q = new URLSearchParams({ country: p.get('country') || '', carrier: p.get('carrier') || '', address: p.get('postalCode') || '', radius: '5000' });
  const base = env.SENDCLOUD_POINTS_BASE || 'https://servicepoints.sendcloud.sc/api/v2';
  const r = await fetchImpl(`${base}/service-points?${q}`, { headers: { authorization: 'Basic ' + btoa(`${env.SENDCLOUD_PUBLIC_KEY}:${env.SENDCLOUD_SECRET_KEY}`), accept: 'application/json' } });
  const list = await r.json().catch(() => []);
  if (!r.ok) return fail(502, 'Could not load pick-up points');
  return json({ points: (Array.isArray(list) ? list : []).slice(0, 20).map((s) => ({ id: s.id, name: s.name, street: s.street, number: s.house_number, postalCode: s.postal_code, city: s.city, carrier: s.carrier, distance: s.distance })) });
}

const toAddress = (a = {}) => ({
  name: String(a.name || '').slice(0, 75), address_line_1: String(a.street || '').slice(0, 75), house_number: String(a.number || '').slice(0, 20),
  postal_code: String(a.postalCode || '').slice(0, 12), city: String(a.city || '').slice(0, 30), country_code: a.country,
  ...(a.email ? { email: String(a.email).slice(0, 100) } : {}), ...(a.phone ? { phone_number: String(a.phone).slice(0, 20) } : {}),
});
const addressOk = (a) => a && a.name && a.street && a.number && a.postalCode && a.city && /^[A-Z]{2}$/.test(a.country || '');

async function createLabel(pk, body, env, store, fetchImpl) {
  const q = JSON.parse((await store.get('quote:' + body.quoteId)) || 'null');
  if (!q) return fail(404, 'This price has expired. Ask for prices again.');
  if (!addressOk(body.from) || !addressOk(body.to)) return fail(400, 'Sender and recipient address need name, street, number, postcode, city and country');
  if (body.from.country !== q.from.country || body.to.country !== q.to.country) return fail(400, 'The addresses are in other countries than the price was for');
  if (q.servicePoint && !body.servicePointId) return fail(400, 'Choose a pick-up point');
  const id = 'lb' + randomId();
  const rec = { id, owner: pk, quote: q, from: body.from, to: body.to, servicePointId: body.servicePointId || null, tradeId: String(body.tradeId || '').slice(0, 64), status: 'unpaid', createdAt: now() };
  if (env.LABELS_FREE === '1') {
    rec.status = 'paid';
  } else {
    if (!env.PLATFORM_LN_ADDRESS) return fail(503, 'Label payments are not set up on this server');
    const rate = await xbtEur(env, fetchImpl);
    const sats = Math.ceil((q.price / rate) * 1e8);
    const meta = await fetchImpl(lnurlpUrl(env.PLATFORM_LN_ADDRESS)).then((r) => r.json());
    const callback = new URL(meta.callback);
    callback.searchParams.set('amount', String(sats * 1000));
    const res = await fetchImpl(callback.toString()).then((r) => r.json());
    if (!res.pr || !res.verify) return fail(502, 'The platform wallet did not return a payable invoice');
    const inv = decodeInvoice(res.pr);
    if (Number(inv.amountMsat) !== sats * 1000) return fail(502, 'The platform wallet returned an invoice for a different amount');
    rec.payment = { invoice: inv.invoice, sats, verify: res.verify, eur: q.price };
  }
  await store.put('label:' + id, JSON.stringify(rec));
  return json(publicLabel(rec));
}

function publicLabel(r) {
  return {
    id: r.id, status: r.status, price: r.quote.price, currency: r.quote.currency, carrier: r.quote.carrier, carrierName: r.quote.carrierName, service: r.quote.name,
    invoice: r.payment?.invoice || null, sats: r.payment?.sats || null,
    tracking: r.shipment?.tracking || null, trackingUrl: r.shipment?.trackingUrl || null,
    documents: r.shipment ? { label: `/api/shipping/labels/${r.id}/label.pdf`, qr: r.shipment.qr ? `/api/shipping/labels/${r.id}/qr` : null } : null,
    error: r.error || null,
  };
}

async function labelStatus(pk, id, env, store, fetchImpl) {
  const rec = JSON.parse((await store.get('label:' + id)) || 'null');
  if (!rec || rec.owner !== pk) return fail(404, 'Label not found');
  if (rec.status === 'unpaid') {
    const v = await fetchImpl(rec.payment.verify).then((r) => r.json()).catch(() => ({}));
    if (v.settled) { rec.status = 'paid'; rec.paidAt = now(); await store.put('label:' + id, JSON.stringify(rec)); }
  }
  if (rec.status === 'paid' || rec.status === 'failed') {
    try {
      const sc = sendcloud(env, fetchImpl);
      const s = rec.quote.size;
      const res = await sc('/shipments/announce', {
        method: 'POST',
        body: {
          ship_with: { type: 'shipping_option_code', properties: { shipping_option_code: rec.quote.code } },
          from_address: toAddress(rec.from), to_address: toAddress(rec.to),
          ...(rec.servicePointId ? { to_service_point: { id: rec.servicePointId } } : {}),
          parcels: [parcelOf(s)], external_reference_id: rec.id,
        },
      });
      const parcel = res.data?.parcels?.[0] || {};
      const docs = parcel.documents || [];
      rec.shipment = {
        shipmentId: res.data?.id, parcelId: parcel.id, tracking: parcel.tracking_number || '', trackingUrl: parcel.tracking_url || '',
        label: docs.find((d) => d.type === 'label')?.link || null, qr: docs.find((d) => d.type === 'qr')?.link || null,
      };
      rec.status = 'created';
      delete rec.error;
    } catch (e) {
      rec.status = 'failed';
      rec.error = e.message;
    }
    await store.put('label:' + id, JSON.stringify(rec));
  }
  return json(publicLabel(rec));
}

// Documents are fetched by their unguessable label id, so a QR code or PDF link
// opens in a new tab or <img> without signing; the id is only in the trade chat.
async function labelDocument(id, type, env, store, fetchImpl) {
  const rec = JSON.parse((await store.get('label:' + id)) || 'null');
  if (!rec?.shipment) return fail(404, 'No label yet');
  const sc = sendcloud(env, fetchImpl);
  const link = type === 'qr' ? rec.shipment.qr : rec.shipment.label || `/parcels/${rec.shipment.parcelId}/documents/label?paper_size=a6`;
  if (!link) return fail(404, 'This carrier has no QR code; print the label instead');
  const r = await sc(link, { accept: type === 'qr' ? 'image/png' : 'application/pdf', raw: true });
  if (!r.ok) return fail(502, 'Could not load the document');
  return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || (type === 'qr' ? 'image/png' : 'application/pdf'), 'cache-control': 'private, max-age=3600' } });
}

// ---- import from a link ----------------------------------------------------------

const BROWSER_HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', 'accept-language': 'nl-NL,nl;q=0.9,en;q=0.8', accept: 'text/html,application/json' };

export async function importFromUrl(input, fetchImpl) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw Object.assign(new Error('Paste a full link, starting with https://'), { status: 400 }); }
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('Not a web link'), { status: 400 });
  const host = url.hostname.replace(/^www\./, '');
  let r = await fetchImpl(url.toString(), { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!r.ok) throw Object.assign(new Error(`${host} answered ${r.status}. Try the import button in your browser instead.`), { status: 502 });
  const finalUrl = r.url || url.toString();
  const html = await r.text();
  const items = [];
  let platform = '';
  let complete = false;
  const next = nextDataFromHtml(html);
  const first = mpResults(next);
  if (first?.listings?.length) {
    platform = 'marktplaats';
    first.listings.forEach((l) => items.push(fromMp(l, finalUrl)));
    const seller = new URL(finalUrl).pathname.match(/^(\/u\/[^/]+\/\d+)/)?.[1];
    const total = first.totalResultCount || 0;
    if (seller) {
      for (let page = 2; items.length < total && page <= 40; page++) {
        r = await fetchImpl(new URL(`${seller}/p/${page}/`, finalUrl).toString(), { headers: BROWSER_HEADERS });
        if (!r.ok) break;
        const res = mpResults(nextDataFromHtml(await r.text()));
        if (!res?.listings?.length) break;
        res.listings.forEach((l) => items.push(fromMp(l, finalUrl)));
      }
      complete = items.length >= total;
    }
  } else if (next) {
    const found = findMpListings(next);
    if (found.length) { platform = 'marktplaats'; found.forEach((l) => items.push(fromMp(l, finalUrl))); }
  }
  if (!items.length) {
    const blocks = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } });
    items.push(...productsFromJsonLd(flattenJsonLd(blocks), finalUrl));
  }
  if (!items.length && /vinted\./.test(host)) {
    const member = new URL(finalUrl).pathname.match(/\/member\/(\d+)/)?.[1];
    if (member) {
      // Vinted's API wants the session cookie its homepage hands out.
      const home = await fetchImpl(`${url.origin}/`, { headers: BROWSER_HEADERS });
      const cookie = (home.headers.getSetCookie?.() || [home.headers.get('set-cookie') || '']).map((c) => c.split(';')[0]).filter(Boolean).join('; ');
      for (let page = 1; page <= 30; page++) {
        const a = await fetchImpl(`${url.origin}/api/v2/wardrobe/${member}/items?page=${page}&per_page=96&order=relevance`, { headers: { ...BROWSER_HEADERS, accept: 'application/json', cookie } });
        if (!a.ok) break;
        const j = await a.json();
        (j.items || []).forEach((it) => items.push(fromVinted(it, finalUrl)));
        platform = 'vinted';
        if (!j.pagination || page >= (j.pagination.total_pages || 1)) { complete = true; break; }
      }
    }
  }
  // Photos: a single ad has them all in its page; for a profile, read the
  // first ads' own pages (a Worker may only make ~50 requests per call).
  if (items.length === 1) {
    const found = imagesFromHtml(html).slice(0, 12);
    if (found.length) items[0].images = [...new Set([...found, ...(items[0].images || []).filter((u) => !isLogo(u))])];
  } else if (platform === 'marktplaats') {
    await Promise.all(items.slice(0, 25).map(async (it) => {
      try {
        const a = await fetchImpl(it.url, { headers: BROWSER_HEADERS });
        if (!a.ok) return;
        const found = imagesFromHtml(await a.text()).slice(0, 12);
        if (found.length) it.images = [...new Set([...found, ...(it.images || []).filter((u) => !isLogo(u))])];
      } catch { /* keep the first photo */ }
    }));
  }
  const clean = dedupeItems(items);
  if (!clean.length) throw Object.assign(new Error('No listings found at this link. Use the link of your public profile or of one ad.'), { status: 404 });
  return { v: BOOKMARKLET_VERSION, source: host, platform: platform || host, complete, page: finalUrl, at: Date.now(), items: clean };
}

// ---- bug reports ---------------------------------------------------------------------
// Sent by e-mail through Resend; the address lives only in the server's
// secrets, never in the app. At most 5 reports per account per hour.

const BUG_MAX_BYTES = 21 * 1024 * 1024; // 15 MB of files, base64-encoded
const BUG_TYPES = /^(image\/(png|jpe?g|gif|webp|heic)|video\/(mp4|quicktime|webm|3gpp))$/;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function bugReport(pk, body, env, store, fetchImpl) {
  if (!env.RESEND_API_KEY || !env.BUG_REPORT_EMAIL) return fail(503, 'Bug reports by e-mail are not set up on this server');
  const hour = Math.floor(now() / 3600);
  const key = `bug:${pk}:${hour}`;
  const n = (await store.get(key)) || 0;
  if (n >= 5) return fail(429, 'Too many bug reports, try again later');
  await store.put(key, n + 1);
  const files = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 5);
  for (const f of files) if (!BUG_TYPES.test(f.type || '') || typeof f.content !== 'string') return fail(400, 'Only images (jpg, png…) and videos (mp4, mov, webm) can be attached');
  const html = `<p><b>From:</b> ${esc(pk)}<br><b>Page:</b> ${esc(body.page)}<br><b>Browser:</b> ${esc(body.ua)}</p><pre style="white-space:pre-wrap">${esc(body.text)}</pre>`;
  const r = await fetchImpl(`${(env.RESEND_BASE || 'https://api.resend.com').replace(/\/+$/, '')}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.BUG_REPORT_FROM || 'XBT Market <onboarding@resend.dev>',
      to: [env.BUG_REPORT_EMAIL],
      subject: `XBT Market bug: ${String(body.text || '').split('\n')[0].slice(0, 70)}`,
      html,
      attachments: files.map((f) => ({ filename: String(f.filename || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 80), content: f.content })),
    }),
  });
  if (!r.ok) return fail(502, `E-mail not sent (${r.status})`);
  return json({ ok: true });
}

// ---- GitHub issues -------------------------------------------------------------------
// Only the community admin can publish (a bug report they reviewed) as a public issue.

function adminPubkey(env) {
  const v = String(env.ADMIN_NPUB || '').trim();
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  try { const d = nip19.decode(v); return d.type === 'npub' ? d.data : null; } catch { return null; }
}

async function publishIssue(pk, body, env, fetchImpl) {
  if (!env.ISSUES_TOKEN || !env.ISSUES_REPO) return fail(503, 'GitHub issues are not set up on this server');
  if (!adminPubkey(env) || pk !== adminPubkey(env)) return fail(403, 'Only the admin can publish issues');
  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) return fail(400, 'A title is required');
  const r = await fetchImpl(`${(env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '')}/repos/${env.ISSUES_REPO}/issues`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.ISSUES_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'xbt-market-service' },
    body: JSON.stringify({ title, body: String(body.body || '').slice(0, 60000), labels: ['bug-report'] }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return fail(502, `GitHub: ${data.message || r.status}`);
  return json({ number: data.number, url: data.html_url });
}

// ---- router -------------------------------------------------------------------------

export async function handle(request, env, store, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const url = new URL(request.url);
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const origin = request.headers.get('origin') || '';
  const cors = {
    'access-control-allow-origin': allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0],
    'access-control-allow-headers': 'authorization, content-type, accept',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let res;
  try {
    res = await route(request, url, env, store, fetchImpl);
  } catch (e) {
    res = fail(e.status || 500, e.message || 'Server error');
  }
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  // NIP-05 must be readable from any Nostr app.
  if (url.pathname === '/.well-known/nostr.json') h.set('access-control-allow-origin', '*');
  return new Response(res.body, { status: res.status, headers: h });
}

async function route(request, url, env, store, fetchImpl) {
  const p = url.pathname;
  const m = request.method;
  const body = async () => {
    const text = await request.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
    return { text, data };
  };
  if (p === '/' && m === 'GET') return json({ service: 'xbt-market', usernames: true, shipping: !!env.SENDCLOUD_PUBLIC_KEY, labelPayments: env.LABELS_FREE === '1' ? 'free' : !!env.PLATFORM_LN_ADDRESS, bugReports: !!(env.RESEND_API_KEY && env.BUG_REPORT_EMAIL), issues: !!(env.ISSUES_TOKEN && env.ISSUES_REPO), push: true, ai: true });
  if (p === '/api/issues' && m === 'POST') { const b = await body(); return publishIssue(await authPubkey(request, b.text), b.data, env, fetchImpl); }
  if (p === '/api/bug' && m === 'POST') {
    if (Number(request.headers.get('content-length') || 0) > BUG_MAX_BYTES) return fail(413, 'Attachments are too large (15 MB at most)');
    const b = await body();
    if (b.text.length > BUG_MAX_BYTES) return fail(413, 'Attachments are too large (15 MB at most)');
    return bugReport(await authPubkey(request, b.text), b.data, env, store, fetchImpl);
  }
  if (p === '/.well-known/nostr.json' && m === 'GET') return nostrJson(url, store);
  if (p === '/api/names' && m === 'GET') return searchNames(url.searchParams.get('q'), store);
  if (p.startsWith('/api/names/') && m === 'GET') return nameInfo(decodeURIComponent(p.slice(11)), store);
  if (p === '/api/names' && m === 'POST') { const b = await body(); return claimName(await authPubkey(request, b.text), b.data, store); }
  if (p === '/api/shipping/quote' && m === 'POST') { const b = await body(); return quote(b.data, env, store, fetchImpl); }
  if (p === '/api/shipping/points' && m === 'GET') return servicePoints(url, env, fetchImpl);
  if (p === '/api/shipping/labels' && m === 'POST') { const b = await body(); return createLabel(await authPubkey(request, b.text), b.data, env, store, fetchImpl); }
  let mm;
  if ((mm = p.match(/^\/api\/shipping\/labels\/(lb[0-9a-f]{32})$/)) && m === 'GET') return labelStatus(await authPubkey(request), mm[1], env, store, fetchImpl);
  if ((mm = p.match(/^\/api\/shipping\/labels\/(lb[0-9a-f]{32})\/(label\.pdf|qr)$/)) && m === 'GET') return labelDocument(mm[1], mm[2] === 'qr' ? 'qr' : 'label', env, store, fetchImpl);
  if (p === '/api/import' && m === 'POST') { const b = await body(); return json(await importFromUrl(b.data.url, fetchImpl)); }
  // AI services that refuse requests from websites go through here (server/ai.js).
  if (p === '/api/ai' && m === 'POST') { const b = await body(); return json(await relayAi(await authPubkey(request, b.text), b.data, store, fetchImpl, b.text.length)); }
  // Push notifications for saved searches (server/push.js).
  if (p === '/api/push/key' && m === 'GET') return json({ publicKey: (await vapidKeys(store)).publicKey });
  if (p === '/api/push/subscribe' && m === 'POST') { const b = await body(); return json(await pushSubscribe(b.data, env, store)); }
  // Only reachable from the worker's own cron trigger (worker.js blocks /internal/ from outside).
  if (p === '/internal/push-run' && m === 'POST') return json(await runPush(env, store, fetchImpl));
  return fail(404, 'Not found');
}
