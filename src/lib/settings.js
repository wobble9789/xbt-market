import { DEFAULTS } from '../config.js';
import { createStore, loadJSON, saveJSON } from './store.js';
import { Esplora } from './btc/esplora.js';

const KEY = 'xbt:settings';

const saved = loadJSON(KEY, {});
// Only English and Spanish are offered; an older saved language falls back.
if (saved.lang && !['en', 'es'].includes(saved.lang)) delete saved.lang;
export const settings = createStore({ ...DEFAULTS, ...saved });

// Settings that belong to a person, not to the device: kept per account, so
// two accounts on one device (one after the other) never see each other's.
export const PERSONAL = ['address', 'country', 'lightningAddress', 'payoutAddress', 'trustedArbiters'];
const personalKey = (pk) => `${KEY}:${pk}`;
let personalPk = null;
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

export function updateSettings(patch) {
  settings.set(patch);
  const s = settings.get();
  const device = {};
  for (const k of Object.keys(s)) if (!PERSONAL.includes(k) && JSON.stringify(s[k]) !== JSON.stringify(DEFAULTS[k])) device[k] = s[k];
  saveJSON(KEY, device);
  if (personalPk) saveJSON(personalKey(personalPk), pick(s, PERSONAL));
}

// Called when the account changes (session.js): load that account's own settings.
export function loadAccountSettings(pk) {
  personalPk = pk || null;
  let mine = pk ? loadJSON(personalKey(pk), null) : {};
  if (pk && !mine) {
    // First time on this device with per-account settings: the ones stored
    // for the device until now go to this account, once.
    const old = loadJSON(KEY, {});
    mine = pick(old, PERSONAL);
    saveJSON(personalKey(pk), mine);
    saveJSON(KEY, Object.fromEntries(Object.entries(old).filter(([k]) => !PERSONAL.includes(k))));
  }
  settings.set({ ...Object.fromEntries(PERSONAL.map((k) => [k, DEFAULTS[k]])), ...mine });
}

export function esploraBase() {
  const s = settings.get();
  return s.esploraOverride?.[s.network] || s.esplora[s.network];
}

export const esplora = () => new Esplora(esploraBase());
