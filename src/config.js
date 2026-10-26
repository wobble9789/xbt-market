// Community-wide defaults. Everything except ADMIN can also be changed per user
// under Settings. Set VITE_ADMIN_NPUB when building (see README) so the app knows
// whose arbiter list to trust.

export const ADMIN_NPUB = import.meta.env?.VITE_ADMIN_NPUB || '';

export const APP_NAME = 'XBT Market';

// The XBT Market service (server/worker.js): usernames, shipping quotes and
// labels, and importing from a shop link. Without it those features are hidden
// or fall back to doing it by hand.
export const API_URL = (import.meta.env?.VITE_API_URL || '').replace(/\/+$/, '');
export const MARKET_TAG = 'xbt-market';

// Model for drafting listings from photos (users bring their own API key).
export const AI_MODEL = 'claude-opus-5-5';

// Known Esplora/mempool servers per chain, offered as presets in Settings
// next to "your own node". Only list servers that follow the BLAKE2b chain.
export const ESPLORA_PRESETS = {
  mainnet: [{ name: 'mempool.guide', url: 'https://mempool.guide/api' }],
  testnet4: [{ name: 'mempool.guide testnet4', url: 'https://mempool.guide/testnet4/api' }],
  regtest: [{ name: 'Local (npm run shim)', url: import.meta.env?.VITE_REGTEST_ESPLORA || 'http://127.0.0.1:3006/api' }],
};

// Escrow deposit: the seller chooses the share of the price on the listing,
// and buyer and seller both put in that same share, returned when the trade
// completes. Never zero, so neither side can trade without risk.
export const DEFAULT_DEPOSIT_PCT = 15;
export const MIN_DEPOSIT_PCT = 5;
export const MAX_DEPOSIT_PCT = 50;
export const depositSats = (priceSats, pct) => Math.round((priceSats * pct) / 100);

// Arbiters every account trusts from the start (the project's own arbiter),
// until enough others with a track record are approved.
export const DEFAULT_ARBITERS = ['3d7147dd5081238129ebb7f68a2cb3b6ad0314168efa7ee8d7b3657a687dac84'];

export const DEFAULTS = {
  network: import.meta.env?.VITE_NETWORK || 'mainnet',
  esplora: {
    mainnet: 'https://mempool.guide/api',
    testnet4: 'https://mempool.guide/testnet4/api',
    regtest: import.meta.env?.VITE_REGTEST_ESPLORA || 'http://127.0.0.1:3006/api',
  },
  // VITE_RELAYS / VITE_NETWORK let `npm run demo` point a build at local services.
  relays: import.meta.env?.VITE_RELAYS ? import.meta.env.VITE_RELAYS.split(',') : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
  blossom: import.meta.env?.VITE_BLOSSOM || 'https://blossom.primal.net',
  // Lightning network prefix invoices must carry ("" = accept any and show it).
  lightningNetwork: '',
  // Above this value (in the display currency) the app recommends escrow.
  escrowAdviceAbove: 50,
  minConfirmations: 3,
  // Highest trade value (price, in sats) allowed by number of completed trades.
  tradeLimits: [
    { minTrades: 0, maxSats: 20_000_000 },
    { minTrades: 3, maxSats: 100_000_000 },
    { minTrades: 10, maxSats: Infinity },
  ],
  currency: 'EUR',
  lang: (globalThis.navigator?.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en',
};

export const explorerFor = (esploraBase) => esploraBase.replace(/\/api\/?$/, '');
