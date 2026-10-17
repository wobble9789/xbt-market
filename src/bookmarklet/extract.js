// Pure extraction logic for the import bookmarklet: turns the data a shop page
// carries into plain items. No network, no globals, so it is unit tested in
// test/extract.test.js and bundled into the bookmarklet by
// scripts/build-bookmarklet.mjs.
//
// Bump BOOKMARKLET_VERSION whenever extraction changes: the import page warns
// users whose saved bookmark is older, because bookmarks never update themselves.

export const BOOKMARKLET_VERSION = 3;

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
  const pt = l.priceInfo?.priceType;
  const cents = l.priceInfo?.priceCents || 0;
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
  };
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
