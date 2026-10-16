// Shipping options. A seller lists which carriers they offer with a fixed
// price; the buyer picks one with the offer, and the seller later adds the
// tracking code. No carrier API is called: labels are bought on the carrier's
// or a label service's own site (Sendcloud, Packlink…), which works with any
// carrier and needs no account in this app.

export const CARRIERS = [
  { id: 'pickup', name: 'Ophalen / Pick-up', pickup: true },
  { id: 'postnl', name: 'PostNL', track: (c) => `https://postnl.nl/tracktrace/?B=${c}&D=NL&T=C`, label: 'https://www.postnl.nl/versturen/' },
  { id: 'dhl', name: 'DHL', track: (c) => `https://www.dhl.com/nl-nl/home/tracking.html?tracking-id=${c}`, label: 'https://www.dhlparcel.nl/nl/particulier/verzenden' },
  { id: 'dpd', name: 'DPD', track: (c) => `https://tracking.dpd.de/status/nl_NL/parcel/${c}`, label: 'https://www.dpd.com/nl/nl/verzenden/' },
  { id: 'gls', name: 'GLS', track: (c) => `https://gls-group.com/NL/nl/pakket-volgen?match=${c}` },
  { id: 'ups', name: 'UPS', track: (c) => `https://www.ups.com/track?tracknum=${c}` },
  { id: 'budbee', name: 'Budbee' },
  { id: 'inpost', name: 'InPost' },
  { id: 'mondialrelay', name: 'Mondial Relay' },
  { id: 'vintedgo', name: 'Vinted Go' },
  { id: 'bpost', name: 'bpost' },
  { id: 'other', name: 'Other / Anders' },
];

// Label services: cheaper labels for many carriers, bought on their site.
export const LABEL_SERVICES = [
  { name: 'Sendcloud', url: 'https://www.sendcloud.com/' },
  { name: 'Packlink', url: 'https://www.packlink.nl/' },
];

export const carrier = (id) => CARRIERS.find((c) => c.id === id) || { id, name: id || '?' };

// Carriers without a known tracking page fall back to a universal tracker.
export function trackingUrl(carrierIdOrName, code) {
  const c = String(code || '').trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(c)) return null;
  const k = String(carrierIdOrName || '').toLowerCase().replace(/\s+/g, '');
  const known = CARRIERS.find((x) => x.id === k || x.name.toLowerCase().replace(/\s+/g, '') === k);
  return known?.track ? known.track(encodeURIComponent(c)) : `https://parcelsapp.com/en/tracking/${encodeURIComponent(c)}`;
}

// Listing tag form: ["shipping_option", carrierId, price, currency].
export function parseShippingOptions(tags, currency) {
  return tags
    .filter((t) => t[0] === 'shipping_option' && t[1])
    .map((t) => ({ id: t[1], price: t[2] == null || t[2] === '' ? 0 : Number(t[2]), currency: (t[3] || currency || 'EUR').toUpperCase() }))
    .filter((o) => Number.isFinite(o.price) && o.price >= 0);
}

// Options a buyer can pick, including the older single shipping_cost field.
export function optionsFor(listing) {
  if (listing.shippingOptions?.length) return listing.shippingOptions;
  if (listing.shippingCost != null) return [{ id: 'other', price: listing.shippingCost, currency: listing.currency }];
  return [];
}
