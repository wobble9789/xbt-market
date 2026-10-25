// Pure extraction logic for the import bookmarklet: turns the data a shop page
// carries into plain items. No network, no globals, so it is unit tested in
// test/extract.test.js and bundled into the bookmarklet by
// scripts/build-bookmarklet.mjs.
//
// Bump BOOKMARKLET_VERSION whenever extraction changes: bookmarks never update
// themselves, and the version travels with every import.

export const BOOKMARKLET_VERSION = 8;

export const absUrl = (u, base) => { try { return new URL(u, base).href; } catch { return ''; } };

// "€ 1.150,00" -> 1150, "EUR 45,00" -> 45, "1,234.50" -> 1234.5
export function parsePrice(t) {
  if (t == null) return NaN;
  if (typeof t === 'number') return t;
  let s = String(t).replace(/[^\d.,]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  return parseFloat(s);
}

export const currencyOf = (t, fallback) =>
  (/€|eur/i.test(t) ? 'EUR' : /£|gbp/i.test(t) ? 'GBP' : /zł|pln/i.test(t) ? 'PLN' : /kč|czk/i.test(t) ? 'CZK' : /\$|usd/i.test(t) ? 'USD' : fallback);

// ---- Marktplaats / 2dehands (Adevinta Next.js pages) -------------------------

export function nextDataFromHtml(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}

export const mpResults = (nextData) => nextData?.props?.pageProps?.searchRequestAndResponse || null;

// Seller profile path, e.g. /u/itw/48763914/ -> /u/itw/48763914 (pages: /p/2/)
export const mpSellerPath = (pathname) => pathname.match(/^(\/u\/[^/]+\/\d+)/)?.[1] || null;

// Price types seen on Marktplaats: FIXED (vaste prijs), MIN_BID (bieden vanaf),
// FAST_BID (bieden, no amount), SEE_DESCRIPTION, and others without an amount.
// Only FIXED and MIN_BID carry a usable price.
export function fromMp(l, base) {
  const pt = l.priceInfo?.priceType || l.price?.priceType || (l.priceCents || l.price?.amount ? 'FIXED' : '');
  const cents = l.priceInfo?.priceCents || l.price?.priceCents || l.priceCents || (Number(l.price?.amount) > 0 ? Math.round(Number(l.price.amount) * 100) : 0);
  const attr = (k) => (l.attributes || []).find((a) => a.key === k)?.value || '';
  const pics = (l.pictures || []).map((p) => p.url && p.url.replace('$_#', '$_85')).filter(Boolean);
  return {
    id: l.itemId,
    title: l.title,
    price: (pt === 'FIXED' || pt === 'MIN_BID') && cents > 0 ? cents / 100 : 0,
    priceType: pt || '',
    currency: 'EUR',
    images: pics.length ? pics : (l.imageUrls || []).map((u) => (u.startsWith('//') ? 'https:' + u : u)),
    description: l.categorySpecificDescription || l.description || '',
    condition: attr('condition'),
    location: l.location?.cityName || '',
    url: absUrl(l.vipUrl || '', base),
    // Ad URLs are /v/<main category>/<subcategory>/m…; the app uses the same slugs.
    category: (l.vipUrl || '').match(/^\/v\/([a-z0-9-]+)\//)?.[1] || '',
    subcategory: (l.vipUrl || '').match(/^\/v\/[a-z0-9-]+\/([a-z0-9-]+)\//)?.[1] || '',
    // "Gereserveerd" on Marktplaats.
    reserved: !!(l.reserved || l.isReserved || /reserved|gereserveerd/i.test(l.priceInfo?.priceType || '') || (l.traits || []).some?.((t) => /reserved/i.test(t))),
  };
}

// Any Marktplaats page (a single ad, the seller's own ad view such as
// /seller/view/m…, a profile): find ad objects anywhere in its Next.js data.
export function findMpListings(data, max = 500) {
  const out = [];
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 12 || out.length >= max) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    const id = v.itemId || v.id;
    if (typeof id === 'string' && /^m\d{6,}$/.test(id) && typeof v.title === 'string' && (v.priceInfo || v.price || v.pictures || v.imageUrls) && !seen.has(id)) {
      seen.add(id);
      out.push(v.itemId ? v : { ...v, itemId: id, priceInfo: v.priceInfo || (v.price?.priceCents != null ? v.price : undefined) });
      return;
    }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(data, 0);
  return out;
}

// ---- photos from a page's HTML ---------------------------------------------------
// Ad pages keep their whole gallery in scripts and image tags; these find every
// listing photo in the raw HTML, at a large size, without logos or icons.

const IMG_PATTERNS = [
  // Marktplaats / 2dehands / 2ememain: any photo path on their image host
  [/(?:https?:)?\/\/images\.(?:marktplaats|2dehands|2ememain)\.(?:com|be|nl)\/api\/v\d+\/[a-z0-9-]+\/images\/[0-9a-zA-Z]{1,4}\/[0-9a-zA-Z_-]{8,}/g, (u) => `https:${u.replace(/^https?:/, '')}?rule=ecg_mp_eps$_85.jpg`],
  // eBay (and older Marktplaats ads); thumbnails as well
  [/https?:\/\/i\.ebayimg\.com\/(?:thumbs\/)?(?:images\/g\/[A-Za-z0-9~_-]+|00\/s\/[A-Za-z0-9=_-]+\/z\/[A-Za-z0-9~_-]+)\//g, (u) => `${u.replace('/thumbs/', '/')}s-l1600.jpg`],
  // Vinted
  [/https?:\/\/images\d*\.vinted\.net\/t\/[A-Za-z0-9_-]+\/f800\/[0-9]+\.(?:jpe?g|webp)(?:\?s=[0-9a-f]+)?/g, (u) => u],
];

export function imagesFromHtml(html) {
  const text = String(html || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  const out = [];
  for (const [re, norm] of IMG_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const u = norm(m[0]);
      if (!out.includes(u)) out.push(u);
    }
  }
  return out.slice(0, 24);
}

// A shop's own logo or an icon is no listing photo.
export const isLogo = (u) => /logo|icon|sprite|placeholder|\.svg(\?|$)/i.test(u || '');

// Adds the photos found on the item's own page (keeping the order, no logos).
export function withPagePhotos(item, html) {
  const own = (item.images || []).filter((u) => !isLogo(u));
  const found = imagesFromHtml(html);
  return { ...item, images: [...new Set([...found, ...own])].slice(0, 24) };
}

// The photos of the ad a page is about: its gallery when the page has one
// (so photos of "other ads" further down are left out), else the first
// listing photos in the page.
const GALLERY = '[class*="Gallery"], [class*="gallery"], [class*="Carousel"], [class*="carousel"], [data-testid*="gallery"], [data-testid*="carousel"]';
export function photosOfDocument(doc) {
  const parts = [...doc.querySelectorAll(GALLERY)].map((e) => e.outerHTML).join('\n');
  const gallery = parts ? imagesFromHtml(parts) : [];
  return gallery.length ? gallery : imagesFromHtml(doc.documentElement?.outerHTML || '').slice(0, 12);
}

// All photos of one Marktplaats ad from its page's HTML. A fetched ad page
// only renders the first photo of its gallery; the full list is in the
// page's Next.js data, next to "similar ads", so it is matched by the ad id.
export function mpAdPhotos(html, id) {
  const ad = findMpListings(nextDataFromHtml(html)).find((l) => l.itemId === id);
  if (!ad) return [];
  const own = fromMp(ad, 'https://www.marktplaats.nl/').images.filter((u) => u && !isLogo(u));
  return own.map((u) => imagesFromHtml(u)[0] || u).filter((u, i, a) => a.indexOf(u) === i).slice(0, 24);
}

// The photos of the ad on a fetched ad page: the longest of its own data
// (Marktplaats, by ad id), its schema.org Product images and its gallery.
export function adPhotosOfPage(html, doc, id) {
  const blocks = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((sc) => { try { blocks.push(JSON.parse(sc.textContent)); } catch { /* skip */ } });
  const ld = (productsFromJsonLd(flattenJsonLd(blocks), 'https://x/')[0]?.images || []).map((u) => imagesFromHtml(u)[0] || u).filter((u) => !isLogo(u));
  const options = [id ? mpAdPhotos(html, id) : [], ld, photosOfDocument(doc)];
  return options.reduce((best, o) => (o.length > best.length ? o : best), []);
}

// The price shown on an item page: meta tags first, then the visible price.
export function priceOfDocument(doc) {
  const meta = (n) => doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"], [itemprop="${n}"]`);
  const m = meta('product:price:amount') || meta('og:price:amount') || meta('price');
  const fromMeta = parsePrice(m?.getAttribute('content') || m?.textContent || '');
  if (fromMeta) return fromMeta;
  for (const el of doc.querySelectorAll('[class*="price" i], [data-testid*="price" i]')) {
    const t = el.textContent || '';
    if (/[€$£]\s*\d|\d\s*(?:€|EUR)/.test(t)) { const p = parsePrice(t); if (p) return p; }
  }
  return 0;
}

// Last resort for a single item page: Open Graph / product meta tags.
export function itemFromMeta(doc, pageUrl) {
  const meta = (n) => doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`)?.getAttribute('content') || '';
  const title = meta('og:title') || doc.title || '';
  const priceText = meta('product:price:amount') || meta('og:price:amount') || meta('price') || doc.querySelector('[itemprop="price"]')?.getAttribute('content') || '';
  const images = [...doc.querySelectorAll('meta[property="og:image"]')].map((m) => absUrl(m.getAttribute('content'), pageUrl)).filter(Boolean);
  if (!title || !images.length) return [];
  return [{ title: title.trim(), price: parsePrice(priceText), currency: meta('product:price:currency') || meta('og:price:currency') || 'EUR', images, description: meta('og:description'), url: meta('og:url') || pageUrl }];
}

// ---- Vinted wardrobe API -------------------------------------------------------

export function fromVinted(it, base) {
  return {
    id: String(it.id ?? ''),
    title: it.title,
    price: parsePrice(it.price?.amount ?? it.price_numeric ?? it.price),
    currency: it.price?.currency_code || it.currency || 'EUR',
    images: (it.photos?.length ? it.photos : [it.photo]).filter(Boolean).map((p) => p.full_size_url || p.url).filter(Boolean),
    description: it.description || '',
    brand: it.brand_title || it.brand || '',
    size: it.size_title || it.size || '',
    condition: it.status || '',
    url: absUrl(it.url || it.path || `/items/${it.id}`, base),
  };
}

export const vintedMemberId = (pathname) => pathname.match(/\/member\/(\d+)/)?.[1] || null;

// ---- schema.org Product (most single item pages) -------------------------------

export function flattenJsonLd(blocks) {
  const nodes = [];
  for (const j of blocks) {
    if (!j) continue;
    nodes.push(...(Array.isArray(j) ? j : j['@graph'] || [j]));
  }
  return nodes;
}

export function productsFromJsonLd(nodes, pageUrl) {
  const out = [];
  for (const n of nodes) {
    if (!n || !String(n['@type']).includes('Product')) continue;
    const offer = Array.isArray(n.offers) ? n.offers[0] : n.offers || {};
    const imgs = [].concat(n.image || []).map((i) => (typeof i === 'string' ? i : i.url || i.contentUrl)).filter(Boolean);
    out.push({
      title: n.name, description: n.description || '', price: parsePrice(offer.price ?? offer.lowPrice),
      currency: offer.priceCurrency || 'EUR', images: imgs.map((u) => absUrl(u, pageUrl)), brand: n.brand?.name || n.brand || '',
      condition: String(offer.itemCondition || '').split('/').pop(), url: pageUrl,
    });
  }
  return out;
}

// ---- listing grids in HTML (eBay search/seller pages, Vinted fallback) ---------

export const CARD_SELECTOR = 'li.s-item, li.s-card, .s-card, .str-item-card, [data-testid*="grid-item"], .feed-grid__item, .new-item-box__container';

export function cardsFromDocument(doc, pageUrl, host) {
  const out = [];
  doc.querySelectorAll(CARD_SELECTOR).forEach((c) => {
    const a = c.querySelector('a[href*="/itm/"], a[href*="/items/"]');
    const img = c.querySelector('img');
    const title = (c.querySelector('.s-item__title, .s-card__title, [data-testid$="--description-title"], h3, h2')?.textContent || img?.alt || '').replace(/^New listing/i, '').trim();
    const pt = c.querySelector('.s-item__price, .s-card__price, [data-testid$="price-text"], [data-testid*="price"]')?.textContent || '';
    if (!a || !title || /shop on ebay/i.test(title)) return;
    out.push({
      title, price: parsePrice(pt), currency: currencyOf(pt, /ebay\.com$/.test(host) ? 'USD' : 'EUR'),
      images: img ? [absUrl(img.getAttribute('data-src') || img.currentSrc || img.src, pageUrl)] : [],
      url: absUrl(a.getAttribute('href'), pageUrl), description: '',
    });
  });
  return out;
}

export function dedupeItems(items) {
  const seen = new Set();
  return items.filter((i) => i.title && !seen.has(i.url + i.title) && seen.add(i.url + i.title));
}
