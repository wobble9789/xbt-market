// Runs on the user's own shop page (clicked as a bookmark). It reads the
// listings that page shows and hands them to the XBT Market import page with
// postMessage, falling back to the clipboard. Nothing is sent anywhere else.
// __XBT_APP__ is replaced with the app URL at runtime. Extraction logic lives
// in extract.js (unit tested); this file only does page I/O.
import {
  BOOKMARKLET_VERSION, mpResults, nextDataFromHtml, mpSellerPath, fromMp, fromVinted, vintedMemberId,
  flattenJsonLd, productsFromJsonLd, cardsFromDocument, dedupeItems, findMpListings, itemFromMeta,
  photosOfDocument, isLogo, priceOfDocument, adPhotosOfPage,
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
        const html = await r.text();
        const photos = adPhotosOfPage(html, new DOMParser().parseFromString(html, 'text/html'), it.id);
        // The ad's own page is the full set; the profile's thumbnail is one of them.
        if (photos.length >= (it.images || []).length) it.images = photos.slice(0, 24);
      } catch { /* keep the photo we have */ }
    }
  };
  await Promise.all([work(), work(), work(), work()]);
}

// The listings in the address of XBT Market's import page, compressed where
// the browser can (phones limit how long an address may be).
async function packed(payload) {
  const json = JSON.stringify(payload);
  if (typeof CompressionStream !== 'function') return 'data=' + encodeURIComponent(json);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return 'z=' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A note on the shop page while the listings are read (that can take a while).
function note(text) {
  let el = document.getElementById('xbt-import-note');
  if (!el) {
    el = document.createElement('div');
    el.id = 'xbt-import-note';
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;padding:14px 16px;border-radius:12px;background:#1d1a14;color:#f4d27a;font:16px/1.4 system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.4)';
    document.body.appendChild(el);
  }
  el.textContent = text;
}

(async () => {
  const APP = '__XBT_APP__';
  const host = location.hostname;
  const here = location.href;
  // Phones block or bury pop-ups: there XBT Market opens in this same tab.
  const phone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const goHere = async (payload) => { location.href = APP + '#/import?from=bookmarklet&' + await packed(payload); };
  note('XBT Market: reading your listings…');

  const win = phone ? null : window.open(APP + '#/import?from=bookmarklet', 'xbtmarket');
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
          const photos = adPhotosOfPage(document.documentElement.outerHTML, document, items[0].id);
          if (photos.length >= items[0].images.length) items[0].images = photos;
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
    document.getElementById('xbt-import-note')?.remove();
    alert('XBT Market: no listings found on this page. Open your public Marktplaats profile (marktplaats.nl/u/…), your Vinted profile (vinted.xx/member/…) or one ad, and tap the bookmark again. Or copy the link and paste it on the XBT Market import page.');
    return;
  }
  payload = { v: BOOKMARKLET_VERSION, source: host, platform: platform || host.replace(/^www\./, ''), complete, page: here, at: Date.now(), items: clean };
  note(`XBT Market: ${clean.length} listings found, opening XBT Market…`);
  // No pop-up (a phone, or one that was blocked): XBT Market opens in this
  // tab, with the listings in the address.
  if (!win || win.closed) {
    await goHere(payload);
    return;
  }
  send();
  try { await navigator.clipboard.writeText(JSON.stringify(payload)); } catch { /* not allowed without focus */ }
  // No answer from the XBT Market tab (blocked or not opened): go there in this tab.
  setTimeout(() => {
    if (ready) { document.getElementById('xbt-import-note')?.remove(); return; }
    try { win?.close(); } catch { /* ignore */ }
    goHere(payload);
  }, 6000);
})();
