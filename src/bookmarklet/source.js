// Runs on the user's own shop page (clicked as a bookmark). It reads the
// listings that page shows and hands them to the XBT Market import page with
// postMessage, falling back to the clipboard. Nothing is sent anywhere else.
// __XBT_APP__ is replaced with the app URL at runtime. Extraction logic lives
// in extract.js (unit tested); this file only does page I/O.
import {
  BOOKMARKLET_VERSION, mpResults, nextDataFromHtml, mpSellerPath, fromMp, fromVinted, vintedMemberId,
  flattenJsonLd, productsFromJsonLd, cardsFromDocument, dedupeItems, findMpListings, itemFromMeta,
  photosOfDocument, isLogo, priceOfDocument,
} from './extract.js';

// All photos of each ad, from the ad's own page (a profile only lists the
// first one). Same site, a few at a time, at most ~40 s in total.
async function addAllPhotos(items) {
  const until = Date.now() + 40_000;
  const todo = items.filter((it) => it.url).slice(0, 150);
  const work = async () => {
    while (todo.length && Date.now() < until) {
      const it = todo.shift();
      try {
        const r = await fetch(it.url, { credentials: 'include' });
        if (!r.ok) continue;
        const photos = photosOfDocument(new DOMParser().parseFromString(await r.text(), 'text/html'));
        if (photos.length) it.images = [...new Set([...photos, ...(it.images || []).filter((u) => !isLogo(u))])].slice(0, 24);
      } catch { /* keep the photo we have */ }
    }
  };
  await Promise.all([work(), work(), work(), work()]);
}

(async () => {
  const APP = '__XBT_APP__';
  const host = location.hostname;
  const here = location.href;

  const win = window.open(APP + '#/import?from=bookmarklet', 'xbtmarket');
  let ready = false;
  let payload = null;
  const send = () => { if (ready && payload && win) win.postMessage({ type: 'xbt-import', payload }, new URL(APP).origin); };
  window.addEventListener('message', (ev) => { if (ev.data === 'xbt-import-ready') { ready = true; send(); } });

  const items = [];
  let platform = '';
  let complete = false;

  // Marktplaats / 2dehands: listings are in the page's Next.js data; a seller
  // profile paginates as /p/2/, /p/3/, ...
  try {
    let own = null;
    try { own = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null'); } catch { /* none */ }
    const first = mpResults(own);
    if (!first?.listings?.length && own) {
      // A single ad, or the seller's own view of one (/seller/view/m…).
      const found = findMpListings(own);
      if (found.length) {
        platform = 'marktplaats';
        found.forEach((l) => items.push(fromMp(l, here)));
        // One ad: its photos are on this very page.
        if (items.length === 1) {
          items[0].images = [...new Set([...photosOfDocument(document), ...items[0].images.filter((u) => !isLogo(u))])];
          if (!items[0].price) items[0].price = priceOfDocument(document);
        }
      }
    }
    if (first?.listings?.length) {
      platform = 'marktplaats';
      first.listings.forEach((l) => items.push(fromMp(l, here)));
      const seller = mpSellerPath(location.pathname);
      const total = first.totalResultCount || 0;
      if (seller) {
        for (let page = 2; items.length < total && page <= 40; page++) {
          const r = await fetch(`${seller}/p/${page}/`, { credentials: 'include' });
          if (!r.ok) break;
          const res = mpResults(nextDataFromHtml(await r.text()));
          if (!res?.listings?.length) break;
          res.listings.forEach((l) => items.push(fromMp(l, here)));
        }
        complete = items.length >= total;
      }
      await addAllPhotos(items);
    }
  } catch (e) { console.warn('xbt import: marktplaats', e); }

  // Vinted: the wardrobe API, as the logged-in user.
  try {
    const member = !items.length && vintedMemberId(location.pathname);
    if (member) {
      for (let page = 1; page <= 30; page++) {
        const r = await fetch(`/api/v2/wardrobe/${member}/items?page=${page}&per_page=96&order=relevance`, { credentials: 'include', headers: { accept: 'application/json' } });
        if (!r.ok) break;
        const j = await r.json();
        (j.items || []).forEach((it) => items.push(fromVinted(it, here)));
        platform = 'vinted';
        if (!j.pagination || page >= (j.pagination.total_pages || 1)) { complete = true; break; }
      }
    }
  } catch (e) { console.warn('xbt import: vinted api', e); }

  // Any single item page with schema.org Product data.
  if (!items.length) {
    const blocks = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { blocks.push(JSON.parse(s.textContent)); } catch { /* skip */ } });
    items.push(...productsFromJsonLd(flattenJsonLd(blocks), here));
  }

  // Listing grids (eBay), never on Marktplaats where the header would be misread.
  if (!items.length && !/marktplaats\.|2dehands\.|2ememain\./.test(host)) {
    items.push(...cardsFromDocument(document, here, host));
    // A seller's "items for sale" list or shop on eBay pages with _pgn: read
    // every page, so the import is complete (and sold items can be noticed).
    if (items.length && /ebay\./.test(host) && (/[?&]_ssn=/.test(location.search) || /^\/str\//.test(location.pathname))) {
      try {
        for (let page = 2; page <= 30; page++) {
          const u = new URL(here);
          u.searchParams.set('_pgn', String(page));
          const r = await fetch(u, { credentials: 'include' });
          if (!r.ok) break;
          const more = cardsFromDocument(new DOMParser().parseFromString(await r.text(), 'text/html'), here, host);
          const before = dedupeItems(items).length;
          items.push(...more);
          if (dedupeItems(items).length === before) { complete = true; break; }
        }
      } catch (e) { console.warn('xbt import: ebay pages', e); }
      platform = 'ebay';
    }
    if (/ebay\./.test(host) && items.length > 1) await addAllPhotos(items);
  }
  // A single item page without structured data: its share tags (og:title, og:image…).
  if (!items.length) items.push(...itemFromMeta(document, here));
  // One item from structured data or meta tags: all its photos, no logo.
  if (items.length === 1 && platform !== 'marktplaats') {
    items[0].images = [...new Set([...photosOfDocument(document), ...(items[0].images || []).filter((u) => !isLogo(u))])];
    if (!items[0].price) items[0].price = priceOfDocument(document);
  }

  const clean = dedupeItems(items);
  if (!clean.length) {
    win?.close();
    alert('XBT Market: no listings found on this page. Open your public Marktplaats profile (marktplaats.nl/u/…), your Vinted profile (vinted.xx/member/…) or one ad, and tap the bookmark again. Or copy the link and paste it on the XBT Market import page.');
    return;
  }
  payload = { v: BOOKMARKLET_VERSION, source: host, platform: platform || host.replace(/^www\./, ''), complete, page: here, at: Date.now(), items: clean };
  // Pop-up blocked (common on phones): open XBT Market in this tab instead,
  // with the listings in the address, so no pop-up permission is needed.
  if (!win || win.closed) {
    location.href = APP + '#/import?from=bookmarklet&data=' + encodeURIComponent(JSON.stringify(payload));
    return;
  }
  send();
  try { await navigator.clipboard.writeText(JSON.stringify(payload)); } catch { /* not allowed without focus */ }
  // No answer from the XBT Market tab (blocked or not opened): go there in this tab.
  setTimeout(() => {
    if (ready) return;
    try { win?.close(); } catch { /* ignore */ }
    location.href = APP + '#/import?from=bookmarklet&data=' + encodeURIComponent(JSON.stringify(payload));
  }, 6000);
})();
