// Who may act as arbiter. The community admin (VITE_ADMIN_NPUB) publishes the
// list of approved arbiters; each arbiter publishes their own escrow base key.
// Users can add extra arbiters they personally trust under Settings.
//
// Both are kind 30078 (application data), d = xbt-market/config and
// d = xbt-market/arbiter.

import { ADMIN_NPUB } from '../../config.js';
import { settings } from '../settings.js';
import { createStore } from '../store.js';
import { query, signAndPublish, latestBy } from './pool.js';
import { secretKey, toPubkey } from './account.js';
import { arbiterBaseKey, pubkeyOf, isValidPubkey } from '../btc/escrow.js';

export const CONFIG_D = 'xbt-market/config';
export const ARBITER_D = 'xbt-market/arbiter';

export const directory = createStore({ loaded: false, admin: null, config: null, arbiters: new Map(), announcements: new Map() });

export function adminPubkey() {
  try { return ADMIN_NPUB ? toPubkey(ADMIN_NPUB) : null; } catch { return null; }
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

let inflight = null;
let lastLoad = 0;

// Reloads unless a load finished in the last `maxAge` ms.
export function refreshDirectory(maxAge = 15_000) {
  if (inflight) return inflight;
  if (Date.now() - lastLoad < maxAge) return Promise.resolve(directory.get());
  return loadDirectory();
}

export function loadDirectory() {
  inflight = load().finally(() => { inflight = null; lastLoad = Date.now(); });
  return inflight;
}

async function load() {
  const admin = adminPubkey();
  const [configs, anns] = await Promise.all([
    admin ? query({ kinds: [30078], authors: [admin], '#d': [CONFIG_D] }) : Promise.resolve([]),
    query({ kinds: [30078], '#d': [ARBITER_D] }),
  ]);
  const config = latestBy(configs, (e) => e.pubkey)[0];
  const cfg = config ? parse(config.content) : null;
  const announcements = new Map();
  for (const e of latestBy(anns, (e) => e.pubkey)) {
    const a = parse(e.content);
    if (a && isValidPubkey(a.escrowBase || '') && a.active !== false) announcements.set(e.pubkey, { ...a, pubkey: e.pubkey, at: e.created_at });
  }
  const approved = new Set([...(cfg?.arbiters || []), ...(settings.get().trustedArbiters || [])]);
  const arbiters = new Map();
  for (const pk of approved) if (announcements.has(pk)) arbiters.set(pk, announcements.get(pk));
  directory.set({ loaded: true, admin, config: cfg, arbiters, announcements });
  return directory.get();
}

export const myArbiterBase = () => pubkeyOf(arbiterBaseKey(secretKey()));

export function announceArbiter({ name, about, languages, feeNote, active = true }) {
  const content = { escrowBase: myArbiterBase(), name, about, languages, feeNote, active, v: 1 };
  return signAndPublish({ kind: 30078, tags: [['d', ARBITER_D], ['t', 'xbt-market']], content: JSON.stringify(content) });
}

export function publishConfig(cfg) {
  return signAndPublish({ kind: 30078, tags: [['d', CONFIG_D], ['t', 'xbt-market']], content: JSON.stringify({ v: 1, ...cfg }) });
}
