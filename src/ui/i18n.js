// Inline two-language strings: T('English', 'Español').
import { settings } from '../lib/settings.js';
import { CATEGORY_LIST } from '../lib/categories.js';

export const LANGS = [['en', 'English'], ['es', 'Español']];
export const lang = () => (settings.get().lang === 'es' ? 'es' : 'en');
export const locale = () => (lang() === 'es' ? 'es-ES' : 'en-GB');

export const T = (en, es) => (lang() === 'es' && es ? es : en);

export function timeAgo(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  const es = lang() === 'es';
  if (s < 60) return es ? 'ahora' : 'just now';
  const units = [[86400 * 30, es ? 'mes' : 'mo'], [86400, 'd'], [3600, 'h'], [60, 'min']];
  for (const [n, u] of units) if (s >= n) return es ? `hace ${Math.floor(s / n)} ${u}` : `${Math.floor(s / n)}${u} ago`;
  return '';
}

export const fmtDate = (ts) => new Date(ts * 1000).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });

export const CATEGORY_LABELS = Object.fromEntries(CATEGORY_LIST.map(([id, , en, es]) => [id, [en, es]]));
export const PRICE_UNIT_LABELS = { hour: ['per hour', 'por hora'], day: ['per day', 'por día'], week: ['per week', 'por semana'], month: ['per month', 'al mes'] };
export const CONDITION_LABELS = {
  new: ['New', 'Nuevo'], 'like-new': ['Like new', 'Como nuevo'], good: ['Good', 'Bueno'], fair: ['Fair', 'Aceptable'], 'for-parts': ['For parts', 'Para piezas'],
};
export const label = (map, k) => (map[k] ? T(...map[k]) : k);

// Country names in the current language, from the browser's own data.
let regionNames = null;
let regionLang = '';
export function countryName(code) {
  if (!code) return '';
  if (code === 'EU') return T('European Union', 'Unión Europea');
  if (code === 'WORLD') return T('Worldwide', 'Todo el mundo');
  try {
    if (regionLang !== lang()) { regionNames = new Intl.DisplayNames([locale()], { type: 'region' }); regionLang = lang(); }
    return regionNames.of(code) || code;
  } catch { return code; }
}
