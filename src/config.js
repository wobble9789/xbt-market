// Community-wide defaults. Everything except ADMIN can also be changed per user
// under Settings. Set VITE_ADMIN_NPUB when building (see README) so the app knows
// whose arbiter list to trust.

export const ADMIN_NPUB = import.meta.env?.VITE_ADMIN_NPUB || '';

export const APP_NAME = 'XBT Market';
export const MARKET_TAG = 'xbt-market';

// Model for drafting listings from photos (users bring their own API key).
export const AI_MODEL = 'claude-opus-5-5';

// Known Esplora/mempool servers per chain, offered as presets in Settings
// next to "your own node". Only list servers that follow the BLAKE2b chain.
export const ESPLORA_PRESETS = {
  mainnet: [{ name: 'mempool.guide', url: 'https://mempool.guide/api' }],
  testnet4: [{ name: 'mempool.guide testnet4', url: 'https://mempool.guide/testnet4/api' }],
  regtest: [{ name: 'Local (npm run shim)', url: 'http://127.0.0.1:3006/api' }],
};

export const DEFAULTS = {
  network: import.meta.env?.VITE_NETWORK || 'mainnet',
  esplora: {
    mainnet: 'https://mempool.guide/api',
    testnet4: 'https://mempool.guide/testnet4/api',
    regtest: 'http://127.0.0.1:3006/api',
  },
  // VITE_RELAYS / VITE_NETWORK let `npm run demo` point a build at local services.
  relays: import.meta.env?.VITE_RELAYS ? import.meta.env.VITE_RELAYS.split(',') : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
  blossom: 'https://blossom.primal.net',
  // Lightning network prefix invoices must carry ("" = accept any and show it).
  lightningNetwork: '',
  // Above this value (in the display currency) the app recommends escrow.
  escrowAdviceAbove: 50,
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
