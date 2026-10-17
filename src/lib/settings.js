import { DEFAULTS } from '../config.js';
import { createStore, loadJSON, saveJSON } from './store.js';
import { Esplora } from './btc/esplora.js';

const KEY = 'xbt:settings';

const saved = loadJSON(KEY, {});
// Only English and Spanish are offered; an older saved language falls back.
if (saved.lang && !['en', 'es'].includes(saved.lang)) delete saved.lang;
export const settings = createStore({ ...DEFAULTS, ...saved });

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
