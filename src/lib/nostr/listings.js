// Listings are NIP-99 classified listings (kind 30402), tagged `xbt-market`
// so any Nostr client can see them and this app can find them.

import * as nip19 from 'nostr-tools/nip19';
import { MARKET_TAG } from '../../config.js';
import { tag, tags } from './pool.js';
import { parseShippingOptions } from '../shipping.js';
import { normalizeCategory, PRICE_UNITS } from '../categories.js';

export const LISTING_KIND = 30402;

export { CATEGORIES } from '../categories.js';

export const CONDITIONS = ['new', 'like-new', 'good', 'fair', 'for-parts'];

// How a buyer may pay: through 2-of-3 escrow, or directly to the seller on
// chain or over Lightning. Listings without a `payment` tag accept escrow only.
export const PAYMENT_METHODS = ['escrow', 'onchain', 'lightning'];

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
  if (l.condition) t.push(['condition', l.condition]);
  if (l.location) t.push(['location', l.location]);
  if (l.shippingCost != null && l.shippingCost !== '') t.push(['shipping_cost', String(l.shippingCost), l.currency]);
  if (l.shipsTo) t.push(['ships_to', l.shipsTo]);
  for (const o of l.shippingOptions || []) t.push(['shipping_option', o.id, String(o.price), o.currency || l.currency]);
  for (const p of l.payments || []) if (PAYMENT_METHODS.includes(p)) t.push(['payment', p]);
  if (l.sellerDepositPct != null) t.push(['seller_deposit_pct', String(l.sellerDepositPct)]);
  for (const img of l.images || []) if (img) t.push(['image', img]);
  if (l.source) t.push(['r', l.source]);
  if (l.importedFrom) t.push(['imported_from', l.importedFrom]);
  return { kind: LISTING_KIND, tags: t, content: l.content || '' };
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
    priceUnit: PRICE_UNITS.includes(priceTag[3]) ? priceTag[3] || '' : '',
    condition: tag(e, 'condition') || '',
    location: tag(e, 'location') || '',
    shippingCost: tag(e, 'shipping_cost') != null ? Number(tag(e, 'shipping_cost')) : null,
    shipsTo: tag(e, 'ships_to') || '',
    shippingOptions: parseShippingOptions(e.tags, (priceTag[2] || 'EUR').toUpperCase()),
    payments: (() => { const p = tags(e, 'payment').filter((x) => PAYMENT_METHODS.includes(x)); return p.length ? [...new Set(p)] : ['escrow']; })(),
    sellerDepositPct: tag(e, 'seller_deposit_pct') != null ? Number(tag(e, 'seller_deposit_pct')) : null,
    status: tag(e, 'status') || 'active',
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
