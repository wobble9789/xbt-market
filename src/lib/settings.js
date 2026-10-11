import { DEFAULTS } from '../config.js';
import { createStore, loadJSON, saveJSON } from './store.js';
import { Esplora } from './btc/esplora.js';

const KEY = 'xbt:settings';

export const settings = createStore({ ...DEFAULTS, ...loadJSON(KEY, {}) });

export function updateSettings(patch) {
  settings.set(patch);
  const s = settings.get();
  const saved = {};
  for (const k of Object.keys(s)) if (JSON.stringify(s[k]) !== JSON.stringify(DEFAULTS[k])) saved[k] = s[k];
  saveJSON(KEY, saved);
}

export function esploraBase() {
  const s = settings.get();
  return s.esploraOverride?.[s.network] || s.esplora[s.network];
}

export const esplora = () => new Esplora(esploraBase());
