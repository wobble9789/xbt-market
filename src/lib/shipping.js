// Shipping. A seller ticks the carriers they are willing to use and a parcel
// size; they set no price. The buyer picks a carrier for their country and pays
// that carrier's rate on top of the price. With the XBT Market service
// configured (server/), rates are live and the seller gets a prepaid label (a
// QR code to show at the drop-off point, or a PDF) in the chat. Without it the
// app shows an estimate and the seller buys the label on the carrier's site.

import { EU } from './countries.js';

export const CARRIERS = [
  { id: 'pickup', name: 'Pick-up', pickup: true },
  { id: 'postnl', name: 'PostNL', track: (c) => `https://postnl.nl/tracktrace/?B=${c}&D=NL&T=C`, label: 'https://www.postnl.nl/versturen/' },
  { id: 'dhl', name: 'DHL', track: (c) => `https://www.dhl.com/nl-nl/home/tracking.html?tracking-id=${c}`, label: 'https://www.dhlparcel.nl/nl/particulier/verzenden' },
  { id: 'mondialrelay', name: 'Mondial Relay', cheap: true, track: (c) => `https://www.mondialrelay.com/en-gb/parcel-tracking/?numeroExpedition=${c}`, label: 'https://www.mondialrelay.com/' },
  { id: 'inpost', name: 'InPost', cheap: true, track: (c) => `https://inpost.eu/track?number=${c}` },
  { id: 'dpd', name: 'DPD', track: (c) => `https://tracking.dpd.de/status/en_US/parcel/${c}`, label: 'https://www.dpd.com/nl/nl/verzenden/' },
  { id: 'gls', name: 'GLS', track: (c) => `https://gls-group.com/track/${c}` },
  { id: 'budbee', name: 'Budbee', track: (c) => `https://tracking.budbee.com/${c}` },
  { id: 'ups', name: 'UPS', track: (c) => `https://www.ups.com/track?tracknum=${c}` },
  { id: 'bpost', name: 'bpost', track: (c) => `https://track.bpost.cloud/btr/web/#/search?itemCode=${c}` },
  { id: 'colissimo', name: 'Colissimo', track: (c) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${c}` },
  { id: 'correos', name: 'Correos', track: (c) => `https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=${c}` },
  { id: 'deutschepost', name: 'Deutsche Post / DHL Paket', track: (c) => `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${c}` },
  { id: 'other', name: 'Other', legacy: true },
];
// Offered for new listings, the cheap international ones first.
export const SHIP_CARRIERS = CARRIERS.filter((c) => !c.pickup && !c.legacy);
export const DEFAULT_CARRIERS = ['postnl', 'dhl', 'mondialrelay'];

export const carrier = (id) => CARRIERS.find((c) => c.id === id) || { id, name: id || '?' };

// Parcel sizes, like Vinted.
export const SIZES = { S: { kg: 2 }, M: { kg: 5 }, L: { kg: 10 }, XL: { kg: 20 } };

// Rough consumer prices in EUR when no live rates are available.
const ESTIMATE = { S: [5, 10, 20], M: [7, 15, 30], L: [10, 25, 50], XL: [15, 40, 80] };
export function estimatePrice(size, from, to) {
  const zone = from && to && from === to ? 0 : EU.includes(from) && EU.includes(to) ? 1 : 2;
  return (ESTIMATE[size] || ESTIMATE.M)[zone];
}

// Carriers without a known tracking page fall back to a universal tracker.
export function trackingUrl(carrierIdOrName, code) {
  const c = String(code || '').trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(c)) return null;
  const k = String(carrierIdOrName || '').toLowerCase().replace(/\s+/g, '');
  const known = CARRIERS.find((x) => x.id === k || x.name.toLowerCase().replace(/\s+/g, '') === k);
  return known?.track ? known.track(encodeURIComponent(c)) : `https://parcelsapp.com/en/tracking/${encodeURIComponent(c)}`;
}

// Listing tag form: ["shipping_option", carrierId] or, in older listings,
// ["shipping_option", carrierId, price, currency]. price null = carrier rate.
export function parseShippingOptions(tags, currency) {
  return tags
    .filter((t) => t[0] === 'shipping_option' && t[1])
    .map((t) => ({ id: t[1], price: t[2] == null || t[2] === '' ? null : Number(t[2]), currency: (t[3] || currency || 'EUR').toUpperCase() }))
    .filter((o) => o.price === null || (Number.isFinite(o.price) && o.price >= 0))
    // Pick-up is free.
    .map((o) => (o.id === 'pickup' ? { ...o, price: 0 } : o));
}

// Options a buyer can pick, including the older single shipping_cost field.
export function optionsFor(listing) {
  if (listing.shippingOptions?.length) return listing.shippingOptions;
  if (listing.shippingCost != null) return [{ id: 'other', price: listing.shippingCost, currency: listing.currency }];
  return [];
}
export const offersPickup = (listing) => optionsFor(listing).some((o) => o.id === 'pickup');
export const shipCarriers = (listing) => optionsFor(listing).filter((o) => o.id !== 'pickup');
