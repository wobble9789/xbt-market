// Listings are NIP-99 classified listings (kind 30402), tagged `xbt-market`
// so any Nostr client can see them and this app can find them.

import * as nip19 from 'nostr-tools/nip19';
import { MARKET_TAG, DEFAULT_DEPOSIT_PCT, MIN_DEPOSIT_PCT, MAX_DEPOSIT_PCT } from '../../config.js';
import { tag, tags } from './pool.js';
import { parseShippingOptions } from '../shipping.js';
import { normalizeCategory, PRICE_UNITS, isSubcategorySlug } from '../categories.js';

export const LISTING_KIND = 30402;

export { CATEGORIES } from '../categories.js';

export const CONDITIONS = ['new', 'like-new', 'good', 'fair', 'for-parts'];

// How a buyer may pay: through 2-of-3 escrow, or directly to the seller on
// chain or over Lightning. Listings without a `payment` tag accept escrow only.
// Shown in this order; new listings accept Lightning only by default.
export const PAYMENT_METHODS = ['lightning', 'onchain', 'escrow'];
export const DEFAULT_PAYMENTS = ['lightning'];

// active: for sale; reserved: visible, but not taking orders; sold; deleted.
export const STATUSES = ['active', 'reserved', 'sold', 'deleted'];
export const PACKAGE_SIZES = ['S', 'M', 'L', 'XL'];

export function listingTemplate(l) {
  const t = [
    ['d', l.d],
    ['title', l.title],
    ['summary', l.summary || l.content.slice(0, 140)],
    ['published_at', String(l.publishedAt || Math.floor(Date.now() / 1000))],
    ['price', String(l.price), l.currency, ...(l.priceUnit ? [l.priceUnit] : [])],
    ['t', MARKET_TAG],
    ['t', 'btcb2'],
    ['status', l.status || 'active'],
  ];
  if (l.category) t.push(['t', l.category]);
  if (l.subcategory) t.push(['subcategory', l.subcategory]);
  if (l.subcategory && l.model) t.push(['model', l.model]);
  if (l.condition) t.push(['condition', l.condition]);
  if (l.country) t.push(['country', l.country]);
  const place = [l.city, l.country].filter(Boolean).join(', ') || l.location;
  if (place) t.push(['location', place]);
  if (l.shippingCost != null && l.shippingCost !== '') t.push(['shipping_cost', String(l.shippingCost), l.currency]);
  for (const x of [].concat(l.shipsTo || [])) if (x) t.push(['ships_to', x]);
  // Without a price the buyer pays the carrier's rate for the chosen option.
  for (const o of l.shippingOptions || []) t.push(['shipping_option', o.id, ...(o.price != null && o.price !== '' ? [String(o.price), o.currency || l.currency] : [])]);
  if (l.packageSize) t.push(['package_size', l.packageSize]);
  for (const p of l.payments || []) if (PAYMENT_METHODS.includes(p)) t.push(['payment', p]);
  // The arbiters this seller accepts for escrow; the buyer picks one of them.
  for (const a of l.arbiters || []) if (/^[0-9a-f]{64}$/.test(a)) t.push(['arbiter', a]);
  // The escrow deposit both buyer and seller put in, as a share of the price.
  if (l.arbiters?.length && l.depositPct != null) t.push(['deposit_pct', String(depositPctOf(l))]);
  for (const img of l.images || []) if (img) t.push(['image', img]);
  if (l.source) t.push(['r', l.source]);
  if (l.importedFrom) t.push(['imported_from', l.importedFrom]);
  return { kind: LISTING_KIND, tags: t, content: l.content || '' };
}

// The escrow deposit of a listing in percent, within the allowed range.
export function depositPctOf(l) {
  const n = Math.round(Number(l?.depositPct));
  if (l?.depositPct == null || l.depositPct === '' || !Number.isFinite(n)) return DEFAULT_DEPOSIT_PCT;
  return Math.min(MAX_DEPOSIT_PCT, Math.max(MIN_DEPOSIT_PCT, n));
}

export function parseListing(e) {
  const d = tag(e, 'd');
  if (!d || !tags(e, 't').includes(MARKET_TAG)) return null;
  const priceTag = e.tags.find((x) => x[0] === 'price');
  const price = Number(priceTag?.[1]);
  if (!(price > 0)) return null;
  const known = new Set([MARKET_TAG, 'btcb2']);
  const httpUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(u || '') ? u : '');
  return {
    id: e.id,
    pubkey: e.pubkey,
    d,
    coord: `${LISTING_KIND}:${e.pubkey}:${d}`,
    naddr: nip19.naddrEncode({ kind: LISTING_KIND, pubkey: e.pubkey, identifier: d }),
    title: tag(e, 'title') || '(untitled)',
    summary: tag(e, 'summary') || '',
    content: e.content,
    price,
    currency: (priceTag[2] || 'EUR').toUpperCase(),
    images: tags(e, 'image').map(httpUrl).filter(Boolean),
    category: normalizeCategory(tags(e, 't').find((x) => !known.has(x))),
    subcategory: isSubcategorySlug(tag(e, 'subcategory')) ? tag(e, 'subcategory') : '',
    model: isSubcategorySlug(tag(e, 'subcategory')) && isSubcategorySlug(tag(e, 'model')) ? tag(e, 'model') : '',
    priceUnit: PRICE_UNITS.includes(priceTag[3]) ? priceTag[3] || '' : '',
    condition: tag(e, 'condition') || '',
    location: tag(e, 'location') || '',
    country: /^[A-Z]{2}$/.test(tag(e, 'country') || '') ? tag(e, 'country') : (tag(e, 'location') || '').match(/(?:^|,\s*)([A-Z]{2})$/)?.[1] || '',
    city: (() => { const loc = tag(e, 'location') || ''; const c = tag(e, 'country'); return c && loc.endsWith(', ' + c) ? loc.slice(0, -(c.length + 2)) : c && loc === c ? '' : loc; })(),
    shippingCost: tag(e, 'shipping_cost') != null ? Number(tag(e, 'shipping_cost')) : null,
    shipsTo: tags(e, 'ships_to').map((x) => String(x).trim().toUpperCase()).filter((x) => /^([A-Z]{2}|WORLD)$/.test(x)),
    packageSize: PACKAGE_SIZES.includes(tag(e, 'package_size')) ? tag(e, 'package_size') : '',
    shippingOptions: parseShippingOptions(e.tags, (priceTag[2] || 'EUR').toUpperCase()),
    payments: (() => { const p = tags(e, 'payment').filter((x) => PAYMENT_METHODS.includes(x)); return p.length ? PAYMENT_METHODS.filter((x) => p.includes(x)) : ['escrow']; })(),
    arbiters: [...new Set(tags(e, 'arbiter').filter((x) => /^[0-9a-f]{64}$/.test(x)))],
    depositPct: depositPctOf({ depositPct: tag(e, 'deposit_pct') }),
    status: STATUSES.includes(tag(e, 'status')) ? tag(e, 'status') : 'active',
    source: httpUrl(tag(e, 'r')),
    importedFrom: tag(e, 'imported_from') || '',
    createdAt: e.created_at,
    event: e,
  };
}

export function decodeListingRef(naddr) {
  const d = nip19.decode(naddr);
  if (d.type !== 'naddr' || d.data.kind !== LISTING_KIND) throw new Error('not a listing address');
  return d.data;
}

export const newListingId = () => 'l-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
