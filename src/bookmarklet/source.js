// Runs on the user's own shop page (clicked as a bookmark). It reads the
// listings that page shows and hands them to the XBT Market import page with
// postMessage, falling back to the clipboard. Nothing is sent anywhere else.
// __XBT_APP__ is replaced with the app URL at runtime. Extraction logic lives
// in extract.js (unit tested); this file only does page I/O.
import {
  BOOKMARKLET_VERSION, mpResults, nextDataFromHtml, mpSellerPath, fromMp, fromVinted, vintedMemberId,
  flattenJsonLd, productsFromJsonLd, cardsFromDocument, dedupeItems, findMpListings, itemFromMeta,
} from './extract.js';

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
      if (found.length) { platform = 'marktplaats'; found.forEach((l) => items.push(fromMp(l, here))); }
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
  if (!items.length && !/marktplaats\.|2dehands\.|2ememain\./.test(host)) items.push(...cardsFromDocument(document, here, host));
  // A single item page without structured data: its share tags (og:title, og:image…).
  if (!items.length) items.push(...itemFromMeta(document, here));

  const clean = dedupeItems(items);
  if (!clean.length) {
    win?.close();
    alert('XBT Market: no listings found on this page. Open your public Marktplaats profile (marktplaats.nl/u/…), your Vinted profile (vinted.xx/member/…) or one ad, and tap the bookmark again. Or copy the link and paste it on the XBT Market import page.');
    return;
  }
  payload = { v: BOOKMARKLET_VERSION, source: host, platform: platform || host.replace(/^www\./, ''), complete, page: here, at: Date.now(), items: clean };
  send();
  try { await navigator.clipboard.writeText(JSON.stringify(payload)); } catch { /* not allowed without focus */ }
  setTimeout(() => {
    if (!ready) alert(`XBT Market: found ${clean.length} listings. If the import page did not open, allow pop-ups for this site and click the bookmark again, or paste on the Import page (they were copied to your clipboard if the browser allowed it).`);
  }, 6000);
})();
