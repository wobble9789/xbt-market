// Finds a category from a few words, in Dutch, English or Spanish, without a
// server. Dutch and other compound words are matched on shared word parts, so
// "warmtebeeldkijker" (thermal binoculars) still finds "Verrekijkers", and a
// few common words map to their category ("ssd" -> hard disks).

import { CATEGORY_LIST } from './categories.js';
import { MODELS } from './category-models.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);

// Words people search for that no category name contains: [word, l1, l2].
const SYNONYMS = [
  ['ssd', 'computers-en-software', 'harde-schijven'], ['hdd', 'computers-en-software', 'harde-schijven'], ['nvme', 'computers-en-software', 'harde-schijven'],
  ['gpu', 'computers-en-software', 'videokaarten'], ['grafische', 'computers-en-software', 'videokaarten'], ['cpu', 'computers-en-software', 'processors'],
  ['ram', 'computers-en-software', 'ram-geheugen'], ['laptop', 'computers-en-software', 'windows-laptops'], ['macbook', 'computers-en-software', 'apple-macbooks'],
  ['ipad', 'computers-en-software', 'apple-ipads'], ['iphone', 'telecommunicatie', 'mobiele-telefoons-apple-iphone'], ['samsung', 'telecommunicatie', 'mobiele-telefoons-samsung'],
  ['smartphone', 'telecommunicatie', 'mobiele-telefoons-overige-merken'], ['gsm', 'telecommunicatie', 'mobiele-telefoons-overige-merken'],
  ['playstation', 'spelcomputers-en-games', ''], ['ps5', 'spelcomputers-en-games', ''], ['xbox', 'spelcomputers-en-games', ''], ['nintendo', 'spelcomputers-en-games', ''],
  ['bitcoin', 'computers-en-software', ''], ['miner', 'computers-en-software', ''], ['asic', 'computers-en-software', ''], ['hardware wallet', 'computers-en-software', ''],
  ['bank', 'huis-en-inrichting', 'banken-bankstellen'], ['sofa', 'huis-en-inrichting', ''], ['tv', 'audio-tv-en-foto', ''], ['drone', 'audio-tv-en-foto', ''],
];

// Longest run of letters two words share (only worth it for longer words).
function common(a, b) {
  if (a.length < 4 || b.length < 4) return 0;
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (a[i + k] && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

// Length of the longest end of `q` (4+ letters, or 3 when it starts `w`) found in `w`.
function suffixIn(q, w) {
  for (let k = Math.min(q.length - 1, 12); k >= 3; k--) {
    const end = q.slice(-k);
    if (k >= 4 ? w.includes(end) : w.startsWith(end)) return k;
  }
  return 0;
}

function score(qWords, nameWords) {
  let total = 0;
  for (const q of qWords) {
    let best = 0;
    for (const w of nameWords) {
      let s = 0;
      if (w === q || w === q + 's' || q === w + 's' || w === q + 'en') s = 10;
      else if (w.startsWith(q) && q.length >= 3) s = 7;
      else if (q.length >= 4 && w.includes(q)) s = 6;
      else {
        // A compound's last part names the thing: "winterjas" is a jas (coat),
        // "warmtebeeldkijker" a kijker (binoculars).
        const head = suffixIn(q, w);
        if (head) s = 5 + head / 2;
        else {
          const c = common(q, w);
          if (c >= 5 || (c >= 4 && c >= Math.min(q.length, w.length) - 1)) s = 2 + c / 3;
        }
      }
      if (s > best) best = s;
    }
    // Both parts of a compound name a word each: "winterjas" -> "Jassen | Winter".
    if (best < 9 && q.length >= 7) {
      const starts = nameWords.some((w) => w.length >= 4 && q.startsWith(w));
      const ends = nameWords.some((w) => !q.startsWith(w) && suffixIn(q, w) >= 3 && w.startsWith(q.slice(-suffixIn(q, w))));
      if (starts && ends) best = 9;
    }
    total += best;
  }
  return total;
}

// [{ category, subcategory, model, label: [l1, l2, model?] names, score }] best first.
// `synonyms`: extra words per category ("l1" or "l1/l2" -> [words]), see
// category-synonyms/: what people type besides the category's own name.
export function searchCategories(query, tree, lang = 'nl', synonyms = {}) {
  const q = words(query);
  if (!q.length || !tree) return [];
  const nq0 = ` ${norm(query)} `;
  // A whole phrase from the synonyms ("thermal vision") counts extra.
  const phrase = (list) => (list || []).some((w) => w.includes(' ') && nq0.includes(` ${norm(w)} `)) ? 6 : 0;
  const li = lang === 'es' ? 3 : lang === 'en' ? 2 : 1;
  const pick = (row) => row[li] || row[2] || row[1];
  const out = [];
  for (const l1 of CATEGORY_LIST) {
    const syn1 = synonyms[l1[0]] || [];
    const s1 = score(q, words(`${l1[1]} ${l1[2]} ${l1[3]} ${syn1.join(' ')}`)) + phrase(syn1);
    if (s1 >= 6) out.push({ category: l1[0], subcategory: '', model: '', label: [pick(l1)], score: s1 - 1 });
    for (const l2 of tree.get(l1[0]) || []) {
      // Names like "Antiek | Bestek": the part after the bar is the subject.
      const syn2 = synonyms[`${l1[0]}/${l2[0]}`] || [];
      const s2 = score(q, words(`${l2[1]} ${l2[2]} ${l2[3]} ${syn2.join(' ')}`)) + phrase(syn2);
      if (s2 >= 4) out.push({ category: l1[0], subcategory: l2[0], model: '', label: [pick(l1), pick(l2)], score: s2 + (s1 >= 6 ? 2 : 0) });
      for (const [m, name] of MODELS[`${l1[0]}/${l2[0]}`] || []) {
        const sm = score(q, words(name));
        const sb = score(q, words(l2[1]));
        if (sm >= 7) out.push({ category: l1[0], subcategory: l2[0], model: m, label: [pick(l1), pick(l2), name], score: sm + sb + 1 });
      }
    }
  }
  const nq = norm(query);
  for (const [w, c, sub] of SYNONYMS) {
    if (!(` ${nq} `).includes(` ${w} `)) continue;
    const l1 = CATEGORY_LIST.find((r) => r[0] === c);
    const l2 = (tree.get(c) || []).find((r) => r[0] === sub);
    if (l1) out.push({ category: c, subcategory: l2 ? sub : '', model: '', label: l2 ? [pick(l1), pick(l2)] : [pick(l1)], score: 20 });
  }
  const best = new Map();
  for (const r of out) {
    const k = `${r.category}/${r.subcategory}/${r.model}`;
    if (!best.has(k) || best.get(k).score < r.score) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.label.length - b.label.length).slice(0, 8);
}
