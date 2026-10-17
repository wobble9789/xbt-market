import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account } from '../../lib/nostr/account.js';
import { query, latestBy } from '../../lib/nostr/pool.js';
import { newListingId, parseListing, CATEGORIES, LISTING_KIND, DEFAULT_PAYMENTS } from '../../lib/nostr/listings.js';
import { DEFAULT_CARRIERS } from '../../lib/shipping.js';
import { api, apiEnabled } from '../../lib/api.js';
import { detectBrowser } from '../install.jsx';
import { fromPayload, fromCsv, classifyImport } from '../../lib/import/normalize.js';
import { settings } from '../../lib/settings.js';
import { MARKET_TAG } from '../../config.js';
import { BOOKMARKLET_SOURCE, BOOKMARKLET_VERSION } from '../../generated/bookmarklet.js';
import { T, CATEGORY_LABELS, label } from '../i18n.js';
import { Action, Field, Img, toast, toastError, Copy, Spinner } from '../components.jsx';
import { publishListing } from './Sell.jsx';

const appUrl = () => location.origin + location.pathname;

// The user's own listings straight from the relays (not limited by the
// marketplace feed), including sold ones, so duplicates are recognised.
async function loadMine(pubkey) {
  const events = await query({ kinds: [LISTING_KIND], authors: [pubkey], '#t': [MARKET_TAG] }, 6000);
  return latestBy(events, (e) => e.tags.find((t) => t[0] === 'd')?.[1]).map(parseListing).filter(Boolean);
}

const STATUS_ORDER = { new: 0, changed: 1, same: 2 };

function StatusBadge({ it }) {
  if (it.reserved && it.status === 'new') return <span class="badge warn">{T('Reserved there', 'Reservado allí')}</span>;
  if (it.status === 'new') return <span class="badge ok">{T('New', 'Nuevo')}</span>;
  if (it.status === 'changed') {
    return <span class="badge warn">{T('Changed', 'Cambiado')}{it.match.price !== it.price && it.price ? ` (${T('was', 'antes')} ${it.match.price})` : ''}</span>;
  }
  return <span class="badge">{it.match.status === 'sold' ? T('Already here (sold)', 'Ya está aquí (vendido)') : T('Already on your profile', 'Ya está en tu perfil')}</span>;
}

export function ImportPage({ query: q }) {
  const me = useStore(account, (a) => a.pubkey);
  const [raw, setRaw] = useState(null); // { items, complete }
  const [mine, setMine] = useState(null);
  const [items, setItems] = useState([]);
  const [gone, setGone] = useState([]);
  const [paste, setPaste] = useState('');
  const [progress, setProgress] = useState(null);
  const bookmarklet = useMemo(() => 'javascript:' + encodeURIComponent(BOOKMARKLET_SOURCE.replace('__XBT_APP__', appUrl())), []);

  const refreshMine = () => loadMine(me).then(setMine).catch((e) => { toastError(e); setMine([]); });
  useEffect(() => { refreshMine(); }, [me]);

  // Classify once both the import and our own listings are known.
  useEffect(() => {
    if (!raw || !mine) return;
    const res = classifyImport(raw.items, mine, { complete: raw.complete });
    setItems(res.items
      .map((i) => ({ ...i, selected: i.status === 'new' && i.price > 0 && !i.reserved }))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]));
    setGone(res.gone);
  }, [raw, mine]);

  const load = (list) => {
    setRaw({ items: list, complete: !!list.complete, version: list.version });
    toast(T(`${list.length} listings read`, `${list.length} anuncios leídos`), 'ok');
  };

  // The bookmarklet opens this page and waits for "ready" before sending data.
  const received = useRef(new Set());
  useEffect(() => {
    let timer;
    const onMsg = (ev) => {
      if (ev.data?.type !== 'xbt-import') return;
      clearInterval(timer);
      const key = ev.data.payload?.at + ev.data.payload?.page;
      if (received.current.has(key)) return;
      received.current.add(key);
      try { load(fromPayload(ev.data.payload)); } catch (e) { toastError(e); }
    };
    addEventListener('message', onMsg);
    if (q.from === 'bookmarklet' && window.opener) {
      const ping = () => window.opener?.postMessage('xbt-import-ready', '*');
      ping();
      timer = setInterval(ping, 1000);
      setTimeout(() => clearInterval(timer), 60_000);
    }
    return () => { removeEventListener('message', onMsg); clearInterval(timer); };
  }, []);

  const onCsv = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { load(fromCsv(await file.text())); } catch (err) { toastError(err); }
  };

  const update = (i, patch) => setItems((cur) => cur.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const selected = items.filter((i) => i.selected);
  const counts = items.reduce((c, i) => ({ ...c, [i.status]: (c[i.status] || 0) + 1 }), {});
  const noPrice = items.filter((i) => !(Number(i.price) > 0)).length;

  const publishAll = async () => {
    const s = settings.get();
    const todo = selected.filter((i) => Number(i.price) > 0);
    if (todo.length < selected.length) toast(T('Listings without a price are skipped.', 'Los anuncios sin precio se omiten.'), 'error');
    let done = 0;
    setProgress({ done, total: todo.length });
    for (const it of todo) {
      const common = { title: it.title, content: it.content, price: Number(it.price), currency: it.currency, category: it.category, subcategory: it.subcategory || '', images: it.images, source: it.source, importedFrom: it.importedFrom };
      if (it.status === 'changed' || it.status === 'same') {
        // Update the existing listing in place instead of creating a duplicate.
        await publishListing({ ...it.match, ...common, subcategory: it.subcategory || it.match.subcategory, condition: it.condition || it.match.condition, status: it.reserved ? 'reserved' : it.match.status === 'sold' || it.match.status === 'reserved' ? 'active' : it.match.status });
      } else {
        await publishListing({
          d: newListingId(), ...common, condition: it.condition, status: it.reserved ? 'reserved' : 'active', payments: [...DEFAULT_PAYMENTS],
          country: s.country || '', city: it.location || '', shipsTo: ['EU'], packageSize: 'M',
          shippingOptions: [{ id: 'pickup', price: 0 }, ...DEFAULT_CARRIERS.map((id) => ({ id }))],
        });
      }
      setProgress({ done: ++done, total: todo.length });
    }
    toast(T(`Published ${done} listings`, `${done} anuncios publicados`), 'ok');
    setProgress(null);
    await refreshMine();
  };

  const markGoneSold = async () => {
    for (const l of gone) await publishListing({ ...l, status: 'sold' });
    toast(T(`${gone.length} marked as sold`, `${gone.length} marcados como vendidos`), 'ok');
    await refreshMine();
  };

  const [link, setLink] = useState('');
  const [showSame, setShowSame] = useState(false);
  const browser = detectBrowser();
  const phone = /android|ios|samsung/.test(browser);
  const fromLink = async () => {
    const payload = await api('/api/import', { method: 'POST', body: { url: link.trim() } });
    load(fromPayload(payload));
    setLink('');
  };
  const visible = items.map((it, i) => [it, i]).filter(([it]) => showSame || it.status !== 'same');
  const BookmarkButton = () => <a class="btn primary bookmarklet" href={bookmarklet} title={`v${BOOKMARKLET_VERSION}`} onClick={(e) => { e.preventDefault(); toast(T('Drag it to your bookmarks bar instead of clicking it here.', 'Arrástralo a tu barra de marcadores en vez de pulsarlo aquí.')); }}>⇪ {T('To XBT Market', 'A XBT Market')}</a>;

  return (
    <div>
      <h2>{T('Import your listings from Marktplaats, Vinted, eBay…', 'Importa tus anuncios de Marktplaats, Vinted, eBay…')}</h2>
      {!raw && (
        <>
          {apiEnabled() && (
            <div class="card">
              <h3>🔗 {T('Paste a link', 'Pega un enlace')} <span class="badge ok">{T('easiest, also on your phone', 'lo más fácil, también en el móvil')}</span></h3>
              <ol class="small">
                <li>{T('In the Marktplaats or Vinted app or website, open your own profile (all your ads) or one ad.', 'En la app o web de Marktplaats o Vinted, abre tu propio perfil (todos tus anuncios) o un anuncio.')}</li>
                <li>{T('Tap Share → Copy link.', 'Toca Compartir → Copiar enlace.')}</li>
                <li>{T('Paste it here.', 'Pégalo aquí.')}</li>
              </ol>
              <div class="row">
                <input value={link} onInput={(e) => setLink(e.target.value)} placeholder="https://www.marktplaats.nl/u/…" inputmode="url" />
                <Action class="primary" disabled={!/^https?:\/\//.test(link.trim())} onClick={fromLink}>{T('Read', 'Leer')}</Action>
              </div>
              <p class="hint">{T('Works with public pages: your profile, or a single ad (also links like marktplaats.nl/seller/view/m…). If a site blocks it, use the import button below.', 'Funciona con páginas públicas: tu perfil o un solo anuncio (también enlaces como marktplaats.nl/seller/view/m…). Si una web lo bloquea, usa el botón de importar de abajo.')}</p>
            </div>
          )}
          <details class="card collapsible" open={!apiEnabled() && !phone}>
            <summary><h3>⇪ {T('Import button for your browser', 'Botón de importar para tu navegador')}</h3><span class="muted small">{T('reads everything on your shop page, also items only you can see', 'lee todo lo de tu página, también lo que solo ves tú')}</span></summary>
            <p class="small">{T('A bookmark you tap on your own shop page. It only works in a browser (Chrome, Safari, Firefox), not inside the Marktplaats or Vinted app. Log in on the website once; with two-step login you get the code by text or email as usual.', 'Un marcador que pulsas en tu propia página de tienda. Solo funciona en un navegador (Chrome, Safari, Firefox), no dentro de la app de Marktplaats o Vinted. Inicia sesión en la web una vez; con verificación en dos pasos recibes el código por SMS o email como siempre.')}</p>
            <h4>{T('On a computer', 'En un ordenador')}</h4>
            <ol class="small">
              <li>{T('Delete any old "To XBT Market" bookmark.', 'Borra cualquier marcador antiguo «A XBT Market».')}</li>
              <li>{T('Drag this button to your bookmarks bar:', 'Arrastra este botón a tu barra de marcadores:')} <BookmarkButton /></li>
              <li>{T('Open your profile on Marktplaats (marktplaats.nl/u/…) or Vinted (vinted.nl/member/…), or a single ad, and click the bookmark.', 'Abre tu perfil en Marktplaats (marktplaats.nl/u/…) o Vinted (vinted.es/member/…), o un solo anuncio, y pulsa el marcador.')}</li>
            </ol>
            <h4>{T('On a phone', 'En el móvil')}</h4>
            <ol class="small">
              <li><Copy text={bookmarklet} label={T('1. Copy the bookmark code', '1. Copia el código del marcador')} /></li>
              <li>{browser === 'ios' ? T('In Safari, tap Share □↑ → "Add Bookmark" → Save. Then open Bookmarks, tap Edit, open the new bookmark and replace its address with the copied code.', 'En Safari, toca Compartir □↑ → «Añadir marcador» → Guardar. Luego abre Marcadores, toca Editar, abre el nuevo marcador y sustituye su dirección por el código copiado.')
                : T('In Chrome, tap ⋮ → ☆ to bookmark this page. Tap ⋮ → Bookmarks, hold the new bookmark → Edit, name it "xbt" and replace the URL with the copied code.', 'En Chrome, toca ⋮ → ☆ para guardar esta página. Toca ⋮ → Marcadores, mantén pulsado el nuevo marcador → Editar, llámalo «xbt» y sustituye la URL por el código copiado.')}</li>
              <li>{T('Open your Marktplaats or Vinted profile in the browser (not the app).', 'Abre tu perfil de Marktplaats o Vinted en el navegador (no en la app).')}</li>
              <li>{browser === 'ios' ? T('Tap the book icon and choose the bookmark.', 'Toca el icono del libro y elige el marcador.') : T('Type "xbt" in the address bar and tap the bookmark that appears (with the star).', 'Escribe «xbt» en la barra de direcciones y toca el marcador que aparece (con la estrella).')}</li>
            </ol>
            <p class="hint">{T('Run it again whenever you like: listings that are already here are recognised and not added twice.', 'Úsalo cuando quieras: los anuncios que ya están aquí se reconocen y no se duplican.')}</p>
          </details>
          <details class="card collapsible">
            <summary><h3>{T('Other ways', 'Otras formas')}</h3><span class="muted small">{T('eBay CSV, pasted data', 'CSV de eBay, datos pegados')}</span></summary>
            <div class="cols">
              <Field label={T('eBay Seller Hub CSV (Reports → Downloads → Active listings)', 'CSV de eBay Seller Hub (Informes → Descargas → Anuncios activos)')}>
                <input type="file" accept=".csv,text/csv" onChange={onCsv} />
              </Field>
              <Field label={T('Paste copied data', 'Pega los datos copiados')}>
                <textarea rows="3" value={paste} onInput={(e) => setPaste(e.target.value)} placeholder='{"items":[…]}' />
                <button class="btn small" disabled={!paste} onClick={() => { try { load(paste.trim().startsWith('{') || paste.trim().startsWith('[') ? fromPayload(paste) : fromCsv(paste)); setPaste(''); } catch (e) { toastError(e); } }}>{T('Read', 'Leer')}</button>
              </Field>
            </div>
          </details>
        </>
      )}
      {raw?.version && raw.version < BOOKMARKLET_VERSION && (
        <div class="notice warn">
          <b>{T(`Your import bookmark is an older version (v${raw.version}, now v${BOOKMARKLET_VERSION}).`, `Tu marcador de importar es una versión antigua (v${raw.version}, ahora v${BOOKMARKLET_VERSION}).`)}</b>{' '}
          {T('It still worked, but may miss things like "reserved". Bookmarks never update themselves: delete it and add the new one when convenient:', 'Ha funcionado, pero puede no detectar cosas como «reservado». Los marcadores no se actualizan solos: bórralo y añade el nuevo cuando puedas:')}{' '}
          <BookmarkButton />
        </div>
      )}
      {raw && !mine && <div class="card"><Spinner /> {T('Comparing with your listings…', 'Comparando con tus anuncios…')}</div>}
      {raw && mine && (
        <div class="card">
          <div class="page-head">
            <h3>{T(`${items.length} found`, `${items.length} encontrados`)}</h3>
            <div class="row">
              <button class="btn small ghost" onClick={() => setItems((cur) => cur.map((i) => ({ ...i, selected: i.status !== 'same' && Number(i.price) > 0 })))}>{T('All new + changed', 'Todos los nuevos + cambiados')}</button>
              <button class="btn small ghost" onClick={() => setItems((cur) => cur.map((i) => ({ ...i, selected: false })))}>{T('None', 'Ninguno')}</button>
              <button class="btn small ghost" onClick={() => { setRaw(null); setItems([]); setGone([]); }}>{T('Start over', 'Empezar de nuevo')}</button>
            </div>
          </div>
          <p class="import-summary">
            <span class="badge ok">{counts.new || 0} {T('new', 'nuevos')}</span>
            <span class="badge warn">{counts.changed || 0} {T('changed', 'cambiados')}</span>
            <span class="badge">{counts.same || 0} {T('already on XBT Market', 'ya en XBT Market')}</span>
            {noPrice > 0 && <span class="badge danger">{noPrice} {T('without price', 'sin precio')}</span>}
          </p>
          {gone.length > 0 && (
            <div class="notice warn">
              <p>{T(`${gone.length} of your listings here are no longer on that profile (sold or removed there?):`, `${gone.length} de tus anuncios aquí ya no están en ese perfil (¿vendidos o borrados allí?):`)} {gone.slice(0, 5).map((l) => l.title).join(', ')}{gone.length > 5 ? '…' : ''}</p>
              <Action class="small" confirm={T('Mark these as sold on XBT Market?', '¿Marcarlos como vendidos en XBT Market?')} onClick={markGoneSold}>{T('Mark as sold on XBT Market', 'Marcar como vendidos en XBT Market')}</Action>
            </div>
          )}
          <p class="hint">{T('Changed listings update the existing one instead of adding a copy. Photos stay hosted where they are now. Ads reserved there are imported as reserved.', 'Los anuncios cambiados actualizan el existente en vez de crear una copia. Las fotos siguen alojadas donde están. Los anuncios reservados allí se importan como reservados.')}</p>
          {!visible.length && <p class="notice ok small">✓ {T('Everything here is already on XBT Market.', 'Todo esto ya está en XBT Market.')}</p>}
          <div class="import-list">
            {visible.map(([it, i]) => (
              <div class={`import-row ${it.selected ? '' : 'off'}`} key={i}>
                <input type="checkbox" checked={it.selected} onChange={(e) => update(i, { selected: e.target.checked })} />
                <Img src={it.images[0]} class="thumb-sm" />
                <div class="grow">
                  <input value={it.title} onInput={(e) => update(i, { title: e.target.value })} />
                  <div class="row">
                    <input class={`price-in ${Number(it.price) > 0 ? '' : 'invalid'}`} inputmode="decimal" value={it.price} placeholder={T('price', 'precio')} onInput={(e) => update(i, { price: e.target.value.replace(',', '.') })} />
                    <span>{it.currency}</span>
                    <select value={it.category} onChange={(e) => update(i, { category: e.target.value, subcategory: '' })}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{label(CATEGORY_LABELS, c)}</option>)}
                    </select>
                    <StatusBadge it={it} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          {counts.same > 0 && <button class="btn small ghost" onClick={() => setShowSame(!showSame)}>{showSame ? T('Hide the ones already on XBT Market', 'Ocultar los que ya están en XBT Market') : T(`Show the ${counts.same} already on XBT Market`, `Mostrar los ${counts.same} que ya están en XBT Market`)}</button>}
          <Action class="primary" onClick={publishAll} disabled={!selected.length || !!progress}>
            {progress ? `${progress.done}/${progress.total}` : T(`Publish ${selected.length} listings`, `Publicar ${selected.length} anuncios`)}
          </Action>
        </div>
      )}
    </div>
  );
}
