// Inline two-language strings: T('English', 'Nederlands').
import { settings } from '../lib/settings.js';

export const T = (en, nl) => (settings.get().lang === 'nl' && nl ? nl : en);

export function timeAgo(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  const nl = settings.get().lang === 'nl';
  if (s < 60) return nl ? 'zojuist' : 'just now';
  const units = [[86400 * 30, nl ? 'mnd' : 'mo'], [86400, nl ? 'd' : 'd'], [3600, nl ? 'u' : 'h'], [60, 'm']];
  for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u} ${nl ? 'geleden' : 'ago'}`;
  return '';
}

export const fmtDate = (ts) => new Date(ts * 1000).toLocaleString(settings.get().lang === 'nl' ? 'nl-NL' : undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const CATEGORY_LABELS = {
  clothing: ['Clothing', 'Kleding'], shoes: ['Shoes', 'Schoenen'], bags: ['Bags', 'Tassen'], electronics: ['Electronics', 'Elektronica'],
  computers: ['Computers', 'Computers'], phones: ['Phones', 'Telefoons'], 'bitcoin-hardware': ['Bitcoin hardware', 'Bitcoin-hardware'],
  books: ['Books', 'Boeken'], music: ['Music', 'Muziek'], games: ['Games', 'Games'], toys: ['Toys', 'Speelgoed'], kids: ['Kids', 'Kinderen'],
  home: ['Home', 'Wonen'], garden: ['Garden', 'Tuin'], sports: ['Sports', 'Sport'], bikes: ['Bikes', 'Fietsen'], collectibles: ['Collectibles', 'Verzamelen'],
  art: ['Art', 'Kunst'], beauty: ['Beauty', 'Verzorging'], tools: ['Tools', 'Gereedschap'], auto: ['Auto & moto', 'Auto & motor'], other: ['Other', 'Overig'],
};
export const CONDITION_LABELS = {
  new: ['New', 'Nieuw'], 'like-new': ['Like new', 'Zo goed als nieuw'], good: ['Good', 'Goed'], fair: ['Fair', 'Redelijk'], 'for-parts': ['For parts', 'Voor onderdelen'],
};
export const label = (map, k) => (map[k] ? T(...map[k]) : k);
