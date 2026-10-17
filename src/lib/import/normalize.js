// Turns bookmarklet payloads, pasted JSON and CSV exports (eBay Seller Hub
// "active listings" report, or any sheet with title/price columns) into
// listing drafts.

const CONDITION_WORDS = [
  ['like-new', /very good|zeer goed|sehr gut|très bon|ottimo|like new|als nieuw|wie neu|comme neuf|refurbished/i],
  ['new', /new with tags|nieuw met|neu mit|neuf avec|nuovo con|new without|nieuw zonder|^new|nieuw|neu|neuf|nuovo|brand ?new|newcondition/i],
  ['good', /good|goed|gut|bon|buono|used|gebruikt|usedcondition/i],
  ['fair', /satisfactory|redelijk|zufriedenstellend|satisfaisant|discreto|acceptable|fair/i],
  ['for-parts', /parts|onderdelen|defect|damaged/i],
];

// Marktplaats categories (see categories.js). Marktplaats imports carry their
// own category; other shops are guessed from the title.
import { CATEGORIES, DEFAULT_CATEGORY, isSubcategorySlug } from '../categories.js';
const CATEGORY_WORDS = [
  ['kleding-heren', /\b(heren|men'?s|mannen)\b/i],
  ['kleding-dames', /shoe|sneaker|boot|schoen|laars|sandal|heel|shirt|jacket|jas|jeans|broek|dress|jurk|hoodie|sweater|trui|coat|skirt|rok|blouse|vest|pants|shorts/i],
  ['sieraden-tassen-en-uiterlijk', /bag|tas\b|tassen|backpack|rugzak|wallet|portemonnee|ketting|ring|oorbel|horloge|watch/i],
  ['telecommunicatie', /iphone|samsung galaxy|phone|telefoon|pixel/i],
  ['computers-en-software', /laptop|macbook|computer|monitor|keyboard|toetsenbord|gpu|cpu|ssd|bitcoin|coldcard|trezor|ledger|seedsigner|miner|asic|bitaxe|antminer|goldshell|raspberry/i],
  ['spelcomputers-en-games', /playstation|xbox|nintendo|switch|console|game/i],
  ['audio-tv-en-foto', /camera|headphone|koptelefoon|speaker|\btv\b|televisie|versterker/i],
  ['boeken', /book|boek|novel|roman/i],
  ['kinderen-en-baby-s', /lego|toy|speelgoed|puzzle|doll|kinder|baby/i],
  ['huis-en-inrichting', /lamp|chair|stoel|table|tafel|vase|vaas|kitchen|keuken|decor|cushion|kussen|gordijn|kast/i],
  ['fietsen-en-brommers', /bike|fiets|scooter|brommer/i],
  ['sport-en-fitness', /ski|tennis|golf|fitness|football|voetbal/i],
];

const guess = (list, text, fallback) => list.find(([, re]) => re.test(text))?.[0] || fallback;

function cleanText(s, max) {
  return String(s ?? '').replace(/\s+\n/g, '\n').trim().slice(0, max);
}

// A stable identity for a listing on its original platform, so a re-import
// recognises what is already here even if the URL slug or domain changed.
export function sourceKey(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    let m;
    if (/marktplaats\.|2dehands\.|2ememain\./.test(h) && (m = u.pathname.match(/\/(m\d{6,})/))) return 'mp:' + m[1];
    if (/vinted\./.test(h) && (m = u.pathname.match(/\/items\/(\d+)/))) return 'vinted:' + m[1];
    if (/ebay\./.test(h) && (m = u.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{6,})/))) return 'ebay:' + m[1];
    return h + u.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export const titleKey = (title, price) =>
  String(title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim() + '|' + Math.round(Number(price) || 0);

// 'mp:m123' -> 'mp'; 'shop.example/item/1' -> 'shop.example'
const platformOf = (key) => (/^[a-z]+:/.test(key) ? key.split(':')[0] : key.split('/')[0]);

// Compares imported items with the user's existing listings.
//   status: 'new' | 'same' | 'changed'   (+ match: the existing listing)
// gone: existing listings from the same platform missing from a complete import.
export function classifyImport(items, existing, { complete = false } = {}) {
  const live = existing.filter((l) => l.status !== 'deleted');
  const bySource = new Map();
  const byTitle = new Map();
  for (const l of live) {
    const k = sourceKey(l.source);
    if (k) bySource.set(k, l);
    byTitle.set(titleKey(l.title, l.price), l);
  }
  const matched = new Set();
  const out = items.map((it) => {
    const key = sourceKey(it.source);
    const match = (key && bySource.get(key)) || byTitle.get(titleKey(it.title, it.price));
    if (!match) return { ...it, key, status: 'new' };
    matched.add(match.coord);
    const changed = (it.price > 0 && Math.abs(match.price - it.price) > 0.001) || match.title !== it.title;
    return { ...it, key, status: changed ? 'changed' : 'same', match };
  });
  const platforms = new Set(out.map((i) => platformOf(i.key)).filter(Boolean));
  const gone = complete
    ? live.filter((l) => l.status === 'active' && !matched.has(l.coord) && platforms.has(platformOf(sourceKey(l.source))))
    : [];
  return { items: out, gone };
}

export function normalizeItem(raw, importedFrom = '') {
  const title = cleanText(raw.title ?? raw.name, 200);
  const price = Number(raw.price) > 0 ? Number(raw.price) : 0;
  if (!title) return null;
  const extras = [raw.brand && `Brand: ${raw.brand}`, raw.size && `Size: ${raw.size}`].filter(Boolean).join('\n');
  const description = cleanText([raw.description, extras].filter(Boolean).join('\n\n'), 8000);
  const images = [...new Set((raw.images || []).filter((u) => /^https?:\/\//.test(u)))].slice(0, 12);
  return {
    title,
    content: description,
    price: price ? Math.round(price * 100) / 100 : '',
    currency: String(raw.currency || 'EUR').toUpperCase().slice(0, 5),
    images,
    condition: guess(CONDITION_WORDS, String(raw.condition || ''), ''),
    category: CATEGORIES.includes(raw.category) ? raw.category : guess(CATEGORY_WORDS, `${title} ${raw.category || ''}`, DEFAULT_CATEGORY),
    source: /^https?:\/\//.test(raw.url || '') ? raw.url : '',
    importedFrom: importedFrom || raw.source || '',
    location: cleanText(raw.location, 100),
    subcategory: CATEGORIES.includes(raw.category) && isSubcategorySlug(raw.subcategory) ? raw.subcategory : '',
    reserved: !!raw.reserved,
  };
}

export function fromPayload(payload) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const items = Array.isArray(p) ? p : p.items;
  if (!Array.isArray(items)) throw new Error('No items in this data');
  const src = (p.source || '').replace(/^www\./, '');
  const list = items.map((i) => normalizeItem(i, src)).filter(Boolean);
  list.complete = !!p.complete;
  list.version = Number(p.v) || 1;
  return list;
}

// RFC 4180-ish CSV with auto-detected separator.
export function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

export function fromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV has no data rows');
  // eBay reports sometimes start with an info line; find the header row.
  const hi = rows.findIndex((r) => r.some((h) => /title|titel|name/i.test(h)) && r.some((h) => /price|prijs|preis|prix/i.test(h)));
  if (hi < 0) throw new Error('Could not find "Title" and "Price" columns');
  const head = rows[hi].map((h) => h.trim().toLowerCase());
  const col = (...res) => head.findIndex((h) => res.some((re) => re.test(h)));
  const ci = {
    title: col(/^title$/, /titel/, /title/, /name/),
    price: col(/current price/, /start price/, /buy it now/, /^price$/, /prijs/, /price/),
    currency: col(/currency/, /valuta/),
    desc: col(/description/, /beschrijving/),
    image: col(/picture url/, /image/, /photo/, /foto/),
    url: col(/^url$/, /item url/, /link/),
    cond: col(/condition/, /staat/),
    item: col(/item number/, /item id/),
  };
  const num = (t) => {
    let s = String(t || '').replace(/[^\d.,]/g, '');
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
    return parseFloat(s);
  };
  const get = (r, i) => (i >= 0 ? r[i] ?? '' : '');
  return rows.slice(hi + 1).map((r) => normalizeItem({
    title: get(r, ci.title),
    price: num(get(r, ci.price)),
    currency: get(r, ci.currency) || (/[£]/.test(get(r, ci.price)) ? 'GBP' : /\$/.test(get(r, ci.price)) ? 'USD' : 'EUR'),
    description: get(r, ci.desc).replace(/<[^>]+>/g, ' '),
    images: get(r, ci.image).split(/[|;\s]+/).filter(Boolean),
    url: get(r, ci.url) || (get(r, ci.item) ? `https://www.ebay.com/itm/${get(r, ci.item).trim()}` : ''),
    condition: get(r, ci.cond),
  }, 'csv')).filter(Boolean);
}
