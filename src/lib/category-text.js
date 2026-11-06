// The words a listing's category stands for: the names of its main category
// and subcategory in Dutch, English and Spanish, plus the search synonyms for
// them. A search for "shoes" then also finds heels and boots listed under a
// shoe subcategory, even when the title does not say "shoes".
import { CATEGORY_LIST } from './categories.js';

const cache = new Map();

export function categoryText(l, tree, synonyms = {}) {
  const key = `${l.category}/${l.subcategory || ''}/${tree ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit != null) return hit;
  const l1 = CATEGORY_LIST.find((r) => r[0] === l.category);
  const parts = l1 ? [l1[1], l1[2], l1[3], ...(synonyms[l1[0]] || [])] : [];
  const l2 = l.subcategory && tree?.get(l.category)?.find((r) => r[0] === l.subcategory);
  if (l2) parts.push(l2[1], l2[2], l2[3], ...(synonyms[`${l.category}/${l.subcategory}`] || []));
  const text = parts.join(' ').toLowerCase();
  cache.set(key, text);
  return text;
}
