// XBT price: SafeTrade XBT/USDT last trade, converted with Coinbase's USDT
// rates. Both send CORS headers. A fixed rate (manualRate, only settable in stored settings, used by the tests) overrides it; users have no field for it.
// The market is thin, so the app always agrees the coin amount at offer time.

import { settings } from './settings.js';

let cache = { at: 0, usdt: null, fx: null };

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// Returns price of 1 XBT in `currency`, or null when unknown.
export async function xbtPrice(currency = settings.get().currency) {
  const manual = settings.get().manualRate;
  if (manual && manual.currency === currency && manual.value > 0) return { value: manual.value, source: 'manual' };
  if (Date.now() - cache.at > 5 * 60_000) {
    const [t, fx] = await Promise.allSettled([
      fetchJSON('https://safetrade.com/api/v2/trade/public/tickers/xbtusdt'),
      fetchJSON('https://api.coinbase.com/v2/exchange-rates?currency=USDT'),
    ]);
    cache = {
      at: Date.now(),
      usdt: t.status === 'fulfilled' ? Number(t.value.last ?? t.value.ticker?.last) || null : null,
      fx: fx.status === 'fulfilled' ? fx.value.data?.rates : null,
    };
  }
  if (!cache.usdt) return null;
  if (currency === 'USDT' || currency === 'USD') return { value: cache.usdt, source: 'SafeTrade XBT/USDT' };
  const rate = Number(cache.fx?.[currency]);
  return rate ? { value: cache.usdt * rate, source: 'SafeTrade XBT/USDT × Coinbase' } : null;
}

export async function fiatToSats(amount, currency) {
  if (currency === 'XBT' || currency === 'BTCB2') return Math.round(amount * 1e8);
  const p = await xbtPrice(currency);
  return p ? Math.round((amount / p.value) * 1e8) : null;
}
