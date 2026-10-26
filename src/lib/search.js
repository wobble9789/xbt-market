// What a search (or a saved search) matches. Used by the Browse page, the
// saved searches in the account, and the XBT Market service that sends push
// notifications for new listings, so all three agree.
//
// A search: { q, c, sub, model, country, to, min, max, cond, del, pay, arb, cur }
// (all strings; '' = any). min/max are in `cur`, the currency it was made in.

import { offersPickup, shipCarriers } from './shipping.js';
import { shipsToCountry } from './countries.js';

export const FILTER_KEYS = ['c', 'sub', 'model', 'country', 'to', 'min', 'max', 'cond', 'del', 'pay', 'arb'];
export const SEARCH_KEYS = ['q', ...FILTER_KEYS];

// Only the keys a search uses, so two equal searches compare equal.
export function cleanSearch(s = {}) {
  const out = {};
  for (const k of SEARCH_KEYS) if (s[k] != null && String(s[k]).trim() !== '') out[k] = String(s[k]).trim();
  if ((out.min || out.max) && s.cur) out.cur = String(s.cur);
  return out;
}

export const sameSearch = (a, b) => JSON.stringify(cleanSearch(a)) === JSON.stringify(cleanSearch(b));
export const isEmptySearch = (s) => !Object.keys(cleanSearch(s)).filter((k) => k !== 'cur').length;

// ctx.priceIn(listing): the price in the search's currency, or null if unknown
//   (unknown prices are left out when a price range is set).
// ctx.sharedArbiters(listing): arbiters both sides trust (for `arb`); without
//   it `arb` is not checked (the service cannot know whom the user trusts).
export function matchesSearch(l, s, ctx = {}) {
  if (s.c && l.category !== s.c) return false;
  if (s.sub && l.subcategory !== s.sub) return false;
  if (s.model && l.model !== s.model) return false;
  if (s.country && l.country !== s.country) return false;
  if (s.cond && l.condition !== s.cond) return false;
  if (s.del === 'pickup' && !offersPickup(l)) return false;
  if (s.del === 'ship' && !shipCarriers(l).length) return false;
  if (s.pay && !l.payments.includes(s.pay)) return false;
  if (s.arb && ctx.sharedArbiters && !(l.payments.includes('escrow') && ctx.sharedArbiters(l).length)) return false;
  if (s.to && !(shipCarriers(l).length && shipsToCountry(l.shipsTo, s.to, l.country))) return false;
  const min = Number(s.min) || 0;
  const max = Number(s.max) || 0;
  if (min || max) {
    const v = ctx.priceIn ? ctx.priceIn(l) : null;
    if (v == null || (min && v < min) || (max && v > max)) return false;
  }
  const words = String(s.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const hay = `${l.title} ${l.summary} ${l.content} ${l.location}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

// The address of the Browse page for a search (optionally only what is new).
export function searchHash(s, extra = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(cleanSearch(s))) if (k !== 'cur') p.set(k, v);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, String(v));
  const q = p.toString();
  return '#/' + (q ? '?' + q : '');
}
