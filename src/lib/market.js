// Live view of all marketplace listings on the configured relays.
import { createStore } from './store.js';
import { subscribe } from './nostr/pool.js';
import { parseListing, LISTING_KIND } from './nostr/listings.js';
import { MARKET_TAG } from '../config.js';

export const market = createStore({ listings: new Map(), loading: true, version: 0 });
let sub = null;

export function startMarket() {
  sub?.close();
  market.set({ listings: new Map(), loading: true });
  let pending = [];
  let t = null;
  const flush = () => {
    if (!pending.length) return;
    const listings = new Map(market.get().listings);
    for (const l of pending) {
      const cur = listings.get(l.coord);
      if (!cur || l.createdAt > cur.createdAt) listings.set(l.coord, l);
    }
    pending = [];
    market.set((s) => ({ listings, version: s.version + 1 }));
  };
  sub = subscribe({ kinds: [LISTING_KIND], '#t': [MARKET_TAG], limit: 2000 }, (e) => {
    const l = parseListing(e);
    if (l) { pending.push(l); clearTimeout(t); t = setTimeout(flush, 120); }
  }, () => { flush(); market.set({ loading: false }); });
  setTimeout(() => market.set({ loading: false }), 8000);
}

export function upsertLocal(listing) {
  const listings = new Map(market.get().listings);
  listings.set(listing.coord, listing);
  market.set((s) => ({ listings, version: s.version + 1 }));
}

export const isVisible = (l) => l.status === 'active';
