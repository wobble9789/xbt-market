// Community-wide defaults. Everything except ADMIN can also be changed per user
// under Settings. Set VITE_ADMIN_NPUB when building (see README) so the app knows
// whose arbiter list to trust.

export const ADMIN_NPUB = import.meta.env?.VITE_ADMIN_NPUB || '';

export const APP_NAME = 'XBT Market';
export const MARKET_TAG = 'xbt-market';

export const DEFAULTS = {
  network: 'mainnet',
  esplora: {
    mainnet: 'https://mempool.guide/api',
    testnet4: 'https://mempool.guide/testnet4/api',
    regtest: 'http://127.0.0.1:3006/api',
  },
  relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
  blossom: 'https://blossom.primal.net',
  minConfirmations: 3,
  buyerDepositPct: 15,
  sellerDepositPct: 15,
  shipDays: 7,
  confirmDays: 21,
  // Highest trade value (price, in sats) allowed by number of completed trades.
  tradeLimits: [
    { minTrades: 0, maxSats: 20_000_000 },
    { minTrades: 3, maxSats: 100_000_000 },
    { minTrades: 10, maxSats: Infinity },
  ],
  currency: 'EUR',
  lang: (globalThis.navigator?.language || 'en').toLowerCase().startsWith('nl') ? 'nl' : 'en',
};

export const explorerFor = (esploraBase) => esploraBase.replace(/\/api\/?$/, '');
