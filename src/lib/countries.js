// Country codes (ISO 3166-1 alpha-2). Names come from Intl.DisplayNames in the
// UI, so only the codes live here.

export const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

export const COUNTRIES = [
  ...EU,
  'AD', 'AE', 'AL', 'AR', 'AU', 'BA', 'BR', 'BY', 'CA', 'CH', 'CL', 'CN', 'CO', 'CR', 'DO', 'DZ', 'EC', 'EG', 'GB', 'GE', 'GI', 'GT', 'HK',
  'ID', 'IL', 'IN', 'IS', 'JP', 'KE', 'KR', 'LI', 'MA', 'MC', 'MD', 'ME', 'MK', 'MX', 'MY', 'NG', 'NO', 'NZ', 'PA', 'PE', 'PH', 'PK', 'PY',
  'RS', 'SA', 'SG', 'SM', 'SV', 'TH', 'TN', 'TR', 'TW', 'UA', 'US', 'UY', 'VE', 'VN', 'XK', 'ZA',
];

export const isCountry = (c) => COUNTRIES.includes(c);

// "Ships to" values: EU, WORLD or country codes, exactly as the seller chose
// them. Without any (only pick-up was offered before), it ships within the
// seller's own country; an old listing without a country ships anywhere.
export function shipsToCountry(shipsTo, country, sellerCountry) {
  if (!country) return true;
  if (!shipsTo?.length) return !sellerCountry || country === sellerCountry;
  return shipsTo.some((s) => s === 'WORLD' || s === country || (s === 'EU' && EU.includes(country)));
}

// A guess from the browser language, e.g. es-ES -> ES, nl -> NL.
export function guessCountry() {
  const l = globalThis.navigator?.language || '';
  const region = l.split('-')[1]?.toUpperCase();
  if (region && isCountry(region)) return region;
  const byLang = { nl: 'NL', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', pt: 'PT', pl: 'PL', en: 'GB' }[l.slice(0, 2)];
  return byLang || '';
}

// Display currencies (any currency Coinbase gives a rate for works).
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'PLN', 'CZK', 'SEK', 'NOK', 'DKK', 'HUF', 'RON', 'BGN', 'TRY', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'HKD', 'SGD', 'INR', 'BRL', 'MXN', 'ARS', 'CLP', 'COP', 'PEN', 'ZAR', 'AED', 'ILS', 'KRW', 'THB'];
