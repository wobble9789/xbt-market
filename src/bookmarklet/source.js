// Runs on the user's own Vinted / eBay page (clicked as a bookmark). It reads
// the listings that page shows to the logged-in user and hands them to the
// XBT Market import page with postMessage, falling back to the clipboard.
// Nothing is sent anywhere else. __XBT_APP__ is replaced with the app URL.
(async () => {
  const APP = '__XBT_APP__';
  const host = location.hostname;
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const num = (t) => {
    if (t == null) return NaN;
    if (typeof t === 'number') return t;
    let s = String(t).replace(/[^\d.,]/g, '');
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    return parseFloat(s);
  };
  const cur = (t, d) => (/€|eur/i.test(t) ? 'EUR' : /£|gbp/i.test(t) ? 'GBP' : /zł|pln/i.test(t) ? 'PLN' : /kč|czk/i.test(t) ? 'CZK' : /\$|usd/i.test(t) ? 'USD' : d);

  const win = window.open(APP + '#/import?from=bookmarklet', 'xbtmarket');
  let ready = false;
  let payload = null;
  const send = () => { if (ready && payload && win) win.postMessage({ type: 'xbt-import', payload }, new URL(APP).origin); };
  window.addEventListener('message', (ev) => { if (ev.data === 'xbt-import-ready') { ready = true; send(); } });

  const items = [];
  const fromVinted = (it) => ({
    title: it.title,
    price: num(it.price?.amount ?? it.price_numeric ?? it.price),
    currency: it.price?.currency_code || it.currency || 'EUR',
    images: (it.photos?.length ? it.photos : [it.photo]).filter(Boolean).map((p) => p.full_size_url || p.url).filter(Boolean),
    description: it.description || '',
    brand: it.brand_title || it.brand || '',
    size: it.size_title || it.size || '',
    condition: it.status || '',
    url: abs(it.url || it.path || `/items/${it.id}`),
  });
  try {
    const m = location.pathname.match(/\/member\/(\d+)/);
    if (m) {
      for (let page = 1; page <= 30; page++) {
        const r = await fetch(`/api/v2/wardrobe/${m[1]}/items?page=${page}&per_page=96&order=relevance`, { credentials: 'include', headers: { accept: 'application/json' } });
        if (!r.ok) break;
        const j = await r.json();
        (j.items || []).forEach((it) => items.push(fromVinted(it)));
        if (!j.pagination || page >= (j.pagination.total_pages || 1)) break;
      }
    }
  } catch (e) { console.warn('xbt import: vinted api', e); }

  if (!items.length) {
    // Any single item page that publishes schema.org Product data.
    const nodes = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { const j = JSON.parse(s.textContent); nodes.push(...(Array.isArray(j) ? j : j['@graph'] || [j])); } catch { /* skip */ }
    });
    for (const n of nodes) {
      if (!n || !String(n['@type']).includes('Product')) continue;
      const offer = Array.isArray(n.offers) ? n.offers[0] : n.offers || {};
      const imgs = [].concat(n.image || []).map((i) => (typeof i === 'string' ? i : i.url || i.contentUrl)).filter(Boolean);
      items.push({
        title: n.name, description: n.description || '', price: num(offer.price ?? offer.lowPrice),
        currency: offer.priceCurrency || 'EUR', images: imgs.map(abs), brand: n.brand?.name || n.brand || '',
        condition: String(offer.itemCondition || '').split('/').pop(), url: location.href,
      });
    }
  }

  if (!items.length) {
    // Listing grids: eBay search / seller pages, Vinted wardrobe as rendered HTML.
    const cards = document.querySelectorAll('li.s-item, li.s-card, .s-card, .str-item-card, [data-testid*="grid-item"], .feed-grid__item, .new-item-box__container');
    cards.forEach((c) => {
      const a = c.querySelector('a[href*="/itm/"], a[href*="/items/"]');
      const img = c.querySelector('img');
      const title = (c.querySelector('.s-item__title, .s-card__title, [data-testid$="--description-title"], h3, h2')?.textContent || img?.alt || '').replace(/^New listing/i, '').trim();
      const priceEl = c.querySelector('.s-item__price, .s-card__price, [data-testid$="price-text"], [data-testid*="price"]');
      const pt = priceEl?.textContent || '';
      if (!a || !title || /shop on ebay/i.test(title)) return;
      items.push({ title, price: num(pt), currency: cur(pt, /ebay\.(com)$/.test(host) ? 'USD' : 'EUR'), images: img ? [abs(img.getAttribute('data-src') || img.currentSrc || img.src)] : [], url: abs(a.getAttribute('href')), description: '' });
    });
  }

  const seen = new Set();
  const clean = items.filter((i) => i.title && i.price > 0 && !seen.has(i.url + i.title) && seen.add(i.url + i.title));
  if (!clean.length) {
    win?.close();
    alert('XBT Market: no listings found here. Open your own Vinted profile (vinted.xx/member/…), an eBay seller or search page, or a single item page, then click the bookmark again.');
    return;
  }
  payload = { v: 1, source: host, page: location.href, at: Date.now(), items: clean };
  send();
  try { await navigator.clipboard.writeText(JSON.stringify(payload)); } catch { /* not allowed without focus */ }
  setTimeout(() => {
    if (!ready) alert(`XBT Market: found ${clean.length} listings. If the import page did not open, allow pop-ups for this site and click the bookmark again, or paste on the Import page (they were copied to your clipboard if the browser allowed it).`);
  }, 6000);
})();
