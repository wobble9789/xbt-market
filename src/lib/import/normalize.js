// Turns bookmarklet payloads, pasted JSON and CSV exports (eBay Seller Hub
// "active listings" report, or any sheet with title/price columns) into
// listing drafts.

const CONDITION_WORDS = [
  ['new', /new with tags|nieuw met|neu mit|neuf avec|nuovo con|new without|nieuw zonder|^new|nieuw|neu|neuf|nuovo|brand ?new|newcondition/i],
  ['like-new', /very good|zeer goed|sehr gut|très bon|ottimo|like new|als nieuw|refurbished/i],
  ['good', /good|goed|gut|bon|buono|used|gebruikt|usedcondition/i],
  ['fair', /satisfactory|redelijk|zufriedenstellend|satisfaisant|discreto|acceptable|fair/i],
  ['for-parts', /parts|onderdelen|defect|damaged/i],
];

const CATEGORY_WORDS = [
  ['shoes', /shoe|sneaker|boot|schoen|laars|sandal|heel/i],
  ['bags', /bag|tas|backpack|rugzak|wallet|portemonnee/i],
  ['clothing', /shirt|jacket|jas|jeans|broek|dress|jurk|hoodie|sweater|trui|coat|skirt|rok|top|blouse|vest|pants|shorts/i],
  ['phones', /iphone|samsung galaxy|phone|telefoon|pixel/i],
  ['computers', /laptop|macbook|computer|monitor|keyboard|toetsenbord|gpu|cpu|ssd/i],
  ['bitcoin-hardware', /bitcoin|coldcard|trezor|ledger|seedsigner|miner|asic|bitaxe|antminer|goldshell/i],
  ['electronics', /camera|headphone|koptelefoon|speaker|tv|console|playstation|xbox|nintendo|tablet|ipad|watch/i],
  ['books', /book|boek|novel|roman/i],
  ['toys', /lego|toy|speelgoed|puzzle|doll|pop/i],
  ['games', /game|spel/i],
  ['home', /lamp|chair|stoel|table|tafel|vase|kitchen|keuken|decor|cushion|kussen/i],
  ['sports', /bike|fiets|ski|tennis|golf|fitness|football|voetbal/i],
];

const guess = (list, text, fallback) => list.find(([, re]) => re.test(text))?.[0] || fallback;

function cleanText(s, max) {
  return String(s ?? '').replace(/\s+\n/g, '\n').trim().slice(0, max);
}

export function normalizeItem(raw, importedFrom = '') {
  const title = cleanText(raw.title ?? raw.name, 200);
  const price = Number(raw.price);
  if (!title || !(price > 0)) return null;
  const extras = [raw.brand && `Brand: ${raw.brand}`, raw.size && `Size: ${raw.size}`].filter(Boolean).join('\n');
  const description = cleanText([raw.description, extras].filter(Boolean).join('\n\n'), 8000);
  const images = [...new Set((raw.images || []).filter((u) => /^https?:\/\//.test(u)))].slice(0, 12);
  return {
    title,
    content: description,
    price: Math.round(price * 100) / 100,
    currency: String(raw.currency || 'EUR').toUpperCase().slice(0, 5),
    images,
    condition: guess(CONDITION_WORDS, String(raw.condition || ''), ''),
    category: guess(CATEGORY_WORDS, `${title} ${raw.category || ''}`, 'other'),
    source: /^https?:\/\//.test(raw.url || '') ? raw.url : '',
    importedFrom: importedFrom || raw.source || '',
  };
}

export function fromPayload(payload) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const items = Array.isArray(p) ? p : p.items;
  if (!Array.isArray(items)) throw new Error('No items in this data');
  const src = (p.source || '').replace(/^www\./, '');
  return items.map((i) => normalizeItem(i, src)).filter(Boolean);
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
