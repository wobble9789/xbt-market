import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account } from '../../lib/nostr/account.js';
import { query, latestBy } from '../../lib/nostr/pool.js';
import { newListingId, parseListing, CATEGORIES, LISTING_KIND } from '../../lib/nostr/listings.js';
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
  if (it.status === 'new') return <span class="badge ok">{T('New', 'Nieuw')}</span>;
  if (it.status === 'changed') {
    return <span class="badge warn">{T('Changed', 'Gewijzigd')}{it.match.price !== it.price && it.price ? ` (${T('was', 'was')} ${it.match.price})` : ''}</span>;
  }
  return <span class="badge">{it.match.status === 'sold' ? T('Already here (sold)', 'Staat er al (verkocht)') : T('Already on your profile', 'Staat al op je profiel')}</span>;
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
      .map((i) => ({ ...i, selected: i.status === 'new' && i.price > 0 }))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]));
    setGone(res.gone);
  }, [raw, mine]);

  const load = (list) => {
    setRaw({ items: list, complete: !!list.complete, version: list.version });
    toast(T(`${list.length} listings read`, `${list.length} advertenties ingelezen`), 'ok');
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

  const update = (i, patch) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const selected = items.filter((i) => i.selected);
  const counts = items.reduce((c, i) => ({ ...c, [i.status]: (c[i.status] || 0) + 1 }), {});
  const noPrice = items.filter((i) => !(Number(i.price) > 0)).length;

  const publishAll = async () => {
    const s = settings.get();
    const todo = selected.filter((i) => Number(i.price) > 0);
    if (todo.length < selected.length) toast(T('Listings without a price are skipped.', 'Advertenties zonder prijs worden overgeslagen.'), 'error');
    let done = 0;
    setProgress({ done, total: todo.length });
    for (const it of todo) {
      const common = { title: it.title, content: it.content, price: Number(it.price), currency: it.currency, category: it.category, images: it.images, source: it.source, importedFrom: it.importedFrom };
      if (it.status === 'changed' || it.status === 'same') {
        // Update the existing listing in place instead of creating a duplicate.
        await publishListing({ ...it.match, ...common, condition: it.condition || it.match.condition, status: it.match.status === 'sold' ? 'active' : it.match.status });
      } else {
        await publishListing({ d: newListingId(), ...common, condition: it.condition, status: 'active', sellerDepositPct: s.sellerDepositPct, location: it.location || s.location || '' });
      }
      setProgress({ done: ++done, total: todo.length });
    }
    toast(T(`Published ${done} listings`, `${done} advertenties gepubliceerd`), 'ok');
    setProgress(null);
    await refreshMine();
  };

  const markGoneSold = async () => {
    for (const l of gone) await publishListing({ ...l, status: 'sold' });
    toast(T(`${gone.length} marked as sold`, `${gone.length} als verkocht gemarkeerd`), 'ok');
    await refreshMine();
  };

  return (
    <div>
      <h2>{T('Import your listings', 'Importeer je advertenties')}</h2>
      {!raw && (
        <div class="card">
          <h3>1. {T('Install the import button (once)', 'Installeer de importknop (eenmalig)')}</h3>
          <p>{T('Drag this button to your bookmarks bar:', 'Sleep deze knop naar je bladwijzerbalk:')}</p>
          <p><a class="btn primary bookmarklet" href={bookmarklet} onClick={(e) => { e.preventDefault(); toast(T('Drag it to your bookmarks bar instead of clicking it here.', 'Sleep hem naar je bladwijzerbalk in plaats van hier te klikken.')); }}>⇪ {T('To XBT Market', 'Naar XBT Market')}</a></p>
          <details>
            <summary>{T('On a phone, or dragging does not work?', 'Op je telefoon, of slepen lukt niet?')}</summary>
            <p>{T('Bookmark any page, edit the bookmark, and replace its address with this code. Then open your shop page, type the bookmark name in the address bar and tap it.', 'Maak een bladwijzer van een willekeurige pagina, bewerk hem en vervang het adres door deze code. Open daarna je winkelpagina, typ de naam van de bladwijzer in de adresbalk en tik erop.')}</p>
            <Copy text={bookmarklet} label={T('Copy bookmark code', 'Kopieer bladwijzercode')} />
          </details>
          <h3>2. {T('Open your own shop page and click it', 'Open je eigen winkelpagina en klik erop')}</h3>
          <ul>
            <li><b>Marktplaats / 2dehands</b>: {T('your public profile with all your ads', 'je openbare profiel met al je advertenties')} (<code>marktplaats.nl/u/…</code>). {T('Click your name on one of your own ads to get there.', 'Klik op je naam bij een van je eigen advertenties om daar te komen.')}</li>
            <li><b>Vinted</b>: {T('your profile', 'je profiel')} (<code>vinted.nl/member/…</code>).</li>
            <li><b>eBay</b>: {T('your seller page or "Items for sale" list.', 'je verkoperspagina of lijst "Te koop".')}</li>
            <li>{T('Most other shops: any single product page.', 'De meeste andere winkels: een losse productpagina.')}</li>
          </ul>
          <p class="hint">{T('Run it again whenever you like: listings that are already here are recognised and not added twice.', 'Je kunt hem steeds opnieuw gebruiken: advertenties die hier al staan worden herkend en niet dubbel geplaatst.')}</p>
          <h3>{T('Or', 'Of')}</h3>
          <div class="cols">
            <Field label={T('eBay Seller Hub CSV (Reports → Downloads → Active listings)', 'eBay Seller Hub CSV (Rapporten → Downloads → Actieve advertenties)')}>
              <input type="file" accept=".csv,text/csv" onChange={onCsv} />
            </Field>
            <Field label={T('Paste copied data', 'Plak gekopieerde data')}>
              <textarea rows="3" value={paste} onInput={(e) => setPaste(e.target.value)} placeholder='{"items":[…]}' />
              <button class="btn small" disabled={!paste} onClick={() => { try { load(paste.trim().startsWith('{') || paste.trim().startsWith('[') ? fromPayload(paste) : fromCsv(paste)); setPaste(''); } catch (e) { toastError(e); } }}>{T('Read', 'Inlezen')}</button>
            </Field>
          </div>
        </div>
      )}
      {raw?.version && raw.version < BOOKMARKLET_VERSION && (
        <div class="notice danger">
          <b>{T('Your import button is out of date.', 'Je importknop is verouderd.')}</b>{' '}
          {T('Bookmarks never update themselves, so it may miss or misread listings. Delete the old bookmark and drag this one to your bookmarks bar, then click it again on your shop page:', 'Bladwijzers werken zichzelf nooit bij, dus hij kan advertenties missen of verkeerd lezen. Verwijder de oude bladwijzer, sleep deze naar je bladwijzerbalk en klik er opnieuw op op je winkelpagina:')}{' '}
          <a class="btn small primary bookmarklet" href={bookmarklet} onClick={(e) => e.preventDefault()}>⇪ {T('To XBT Market', 'Naar XBT Market')}</a>
        </div>
      )}
      {raw && !mine && <div class="card"><Spinner /> {T('Comparing with your listings…', 'Vergelijken met je advertenties…')}</div>}
      {raw && mine && (
        <div class="card">
          <div class="page-head">
            <h3>{T(`${items.length} found`, `${items.length} gevonden`)}</h3>
            <div class="row">
              <button class="btn small ghost" onClick={() => setItems(items.map((i) => ({ ...i, selected: i.status !== 'same' && Number(i.price) > 0 })))}>{T('All new + changed', 'Alle nieuwe + gewijzigde')}</button>
              <button class="btn small ghost" onClick={() => setItems(items.map((i) => ({ ...i, selected: false })))}>{T('None', 'Geen')}</button>
              <button class="btn small ghost" onClick={() => { setRaw(null); setItems([]); setGone([]); }}>{T('Start over', 'Opnieuw')}</button>
            </div>
          </div>
          <p class="import-summary">
            <span class="badge ok">{counts.new || 0} {T('new', 'nieuw')}</span>
            <span class="badge warn">{counts.changed || 0} {T('changed', 'gewijzigd')}</span>
            <span class="badge">{counts.same || 0} {T('already on your profile', 'staan al op je profiel')}</span>
            {noPrice > 0 && <span class="badge danger">{noPrice} {T('without price', 'zonder prijs')}</span>}
          </p>
          {gone.length > 0 && (
            <div class="notice warn">
              <p>{T(`${gone.length} of your listings here are no longer on that profile (sold or removed there?):`, `${gone.length} van je advertenties hier staan niet meer op dat profiel (daar verkocht of verwijderd?):`)} {gone.slice(0, 5).map((l) => l.title).join(', ')}{gone.length > 5 ? '…' : ''}</p>
              <Action class="small" confirm={T('Mark these as sold here?', 'Deze hier als verkocht markeren?')} onClick={markGoneSold}>{T('Mark as sold', 'Markeer als verkocht')}</Action>
            </div>
          )}
          <p class="hint">{T('Changed listings update the existing one instead of adding a copy. Photos stay hosted where they are now.', 'Gewijzigde advertenties werken de bestaande bij in plaats van een kopie te maken. Foto\'s blijven gehost waar ze nu staan.')}</p>
          <div class="import-list">
            {items.map((it, i) => (
              <div class={`import-row ${it.selected ? '' : 'off'}`} key={i}>
                <input type="checkbox" checked={it.selected} onChange={(e) => update(i, { selected: e.target.checked })} />
                <Img src={it.images[0]} class="thumb-sm" />
                <div class="grow">
                  <input value={it.title} onInput={(e) => update(i, { title: e.target.value })} />
                  <div class="row">
                    <input class={`price-in ${Number(it.price) > 0 ? '' : 'invalid'}`} inputmode="decimal" value={it.price} placeholder={T('price', 'prijs')} onInput={(e) => update(i, { price: e.target.value.replace(',', '.') })} />
                    <span>{it.currency}</span>
                    <select value={it.category} onChange={(e) => update(i, { category: e.target.value })}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{label(CATEGORY_LABELS, c)}</option>)}
                    </select>
                    <StatusBadge it={it} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Action class="primary" onClick={publishAll} disabled={!selected.length || !!progress}>
            {progress ? `${progress.done}/${progress.total}` : T(`Publish ${selected.length} listings`, `${selected.length} advertenties publiceren`)}
          </Action>
        </div>
      )}
    </div>
  );
}
