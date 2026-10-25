// Shipping prices for a listing and labels, from the XBT Market service when it
// is configured, otherwise estimates (see shipping.js).
import { api, apiEnabled } from './api.js';
import { shipCarriers, estimatePrice } from './shipping.js';

// -> [{ carrier, price, currency, quoteId?, service?, servicePoint?, labelless?, estimate? }]
export async function shippingQuotes(listing, toCountry, toPostalCode = '') {
  const opts = shipCarriers(listing);
  if (!opts.length || !toCountry) return [];
  // Older listings: the seller set a price per carrier.
  if (opts.every((o) => o.price != null)) return opts.map((o) => ({ carrier: o.id, price: o.price, currency: o.currency, fixed: true }));
  const size = listing.packageSize || 'M';
  if (apiEnabled() && listing.country) {
    const res = await api('/api/shipping/quote', { method: 'POST', body: { from: { country: listing.country }, to: { country: toCountry, ...(toPostalCode ? { postalCode: toPostalCode } : {}) }, size, carriers: opts.map((o) => o.id) } });
    return res.options.map((o) => ({ carrier: o.carrier, price: o.price, currency: o.currency, quoteId: o.id, service: o.name, servicePoint: o.servicePoint, labelless: o.labelless }));
  }
  return opts.map((o) => ({ carrier: o.id, price: estimatePrice(size, listing.country, toCountry, o.id), currency: 'EUR', estimate: true }));
}

export const labelsEnabled = apiEnabled;

export const servicePoints = (carrier, country, postalCode) =>
  api(`/api/shipping/points?carrier=${encodeURIComponent(carrier)}&country=${country}&postalCode=${encodeURIComponent(postalCode || '')}`).then((r) => r.points);

// Fresh quote for the label (quotes expire), matching the carrier the buyer chose.
export async function labelQuote({ from, to, size, carrier, servicePoint }) {
  const res = await api('/api/shipping/quote', { method: 'POST', body: { from: { country: from.country, postalCode: from.postalCode }, to: { country: to.country, postalCode: to.postalCode }, size, carriers: [carrier] } });
  return res.options.find((o) => !!o.servicePoint === !!servicePoint) || res.options[0] || null;
}

export const createLabel = (body) => api('/api/shipping/labels', { method: 'POST', body, auth: true });
export const labelStatus = (id) => api(`/api/shipping/labels/${id}`, { auth: true });
