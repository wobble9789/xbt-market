import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { market } from '../../lib/market.js';
import { account } from '../../lib/nostr/account.js';
import { newListingId, CATEGORIES } from '../../lib/nostr/listings.js';
import { fromPayload, fromCsv } from '../../lib/import/normalize.js';
import { settings } from '../../lib/settings.js';
import { BOOKMARKLET_SOURCE } from '../../generated/bookmarklet.js';
import { T, CATEGORY_LABELS, label } from '../i18n.js';
import { Action, Field, Img, toast, toastError, Copy } from '../components.jsx';
import { publishListing } from './Sell.jsx';

const appUrl = () => location.origin + location.pathname;

export function ImportPage({ query }) {
  const { listings } = useStore(market);
  const me = useStore(account, (a) => a.pubkey);
  const [items, setItems] = useState([]);
  const [paste, setPaste] = useState('');
  const [progress, setProgress] = useState(null);
  const bookmarklet = useMemo(() => 'javascript:' + encodeURIComponent(BOOKMARKLET_SOURCE.replace('__XBT_APP__', appUrl())), []);

  const existingSources = useMemo(() => new Set([...listings.values()].filter((l) => l.pubkey === me && l.source && l.status !== 'deleted').map((l) => l.source)), [listings, me]);

  const load = (list) => {
    const fresh = list.map((i) => ({ ...i, selected: !existingSources.has(i.source), duplicate: existingSources.has(i.source) }));
    setItems(fresh);
    toast(T(`${list.length} listings ready to review`, `${list.length} advertenties klaar om te controleren`), 'ok');
  };

  // The bookmarklet opens this page and waits for "ready" before sending data.
  const received = useRef(new Set());
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let timer;
    const onMsg = (ev) => {
      if (ev.data?.type !== 'xbt-import') return;
      clearInterval(timer);
      const key = ev.data.payload?.at + ev.data.payload?.page;
      if (received.current.has(key)) return;
      received.current.add(key);
      try { loadRef.current(fromPayload(ev.data.payload)); } catch (e) { toastError(e); }
    };
    addEventListener('message', onMsg);
    if (query.from === 'bookmarklet' && window.opener) {
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

  const publishAll = async () => {
    const s = settings.get();
    let done = 0;
    setProgress({ done, total: selected.length });
    for (const it of selected) {
      await publishListing({
        d: newListingId(), title: it.title, content: it.content, price: Number(it.price), currency: it.currency, category: it.category,
        condition: it.condition, images: it.images, source: it.source, importedFrom: it.importedFrom, status: 'active',
        sellerDepositPct: s.sellerDepositPct, location: s.location || '',
      });
      setProgress({ done: ++done, total: selected.length });
    }
    toast(T(`Published ${done} listings`, `${done} advertenties gepubliceerd`), 'ok');
    setItems(items.filter((i) => !i.selected));
    setProgress(null);
  };

  return (
    <div>
      <h2>{T('Import your listings', 'Importeer je advertenties')}</h2>
      {!items.length && (
        <div class="card">
          <h3>1. {T('Install the import button (once)', 'Installeer de importknop (eenmalig)')}</h3>
          <p>{T('Drag this button to your bookmarks bar:', 'Sleep deze knop naar je bladwijzerbalk:')}</p>
          <p><a class="btn primary bookmarklet" href={bookmarklet} onClick={(e) => { e.preventDefault(); toast(T('Drag it to your bookmarks bar instead of clicking it here.', 'Sleep hem naar je bladwijzerbalk in plaats van hier te klikken.')); }}>⇪ {T('To XBT Market', 'Naar XBT Market')}</a></p>
          <details>
            <summary>{T('On a phone, or dragging does not work?', 'Op je telefoon, of slepen lukt niet?')}</summary>
            <p>{T('Bookmark any page, edit the bookmark, and replace its address with this code. Then open your Vinted page, type the bookmark name in the address bar and tap it.', 'Maak een bladwijzer van een willekeurige pagina, bewerk hem en vervang het adres door deze code. Open daarna je Vinted-pagina, typ de naam van de bladwijzer in de adresbalk en tik erop.')}</p>
            <Copy text={bookmarklet} label={T('Copy bookmark code', 'Kopieer bladwijzercode')} />
          </details>
          <h3>2. {T('Open your own shop page and click it', 'Open je eigen winkelpagina en klik erop')}</h3>
          <ul>
            <li><b>Vinted</b>: {T('your profile', 'je profiel')} (<code>vinted.nl/member/…</code>) — {T('all items in your wardrobe are read.', 'alle items in je kledingkast worden ingelezen.')}</li>
            <li><b>eBay</b>: {T('your seller page or "Items for sale" list, or any single item page.', 'je verkoperspagina of lijst "Te koop", of een losse itempagina.')}</li>
            <li>{T('Most other shops: any single product page.', 'De meeste andere winkels: een losse productpagina.')}</li>
          </ul>
          <p class="hint">{T('The button only reads what your browser already shows you; nothing is sent to Vinted or eBay, and your login stays in your browser.', 'De knop leest alleen wat je browser je al laat zien; er wordt niets naar Vinted of eBay gestuurd en je login blijft in je browser.')}</p>
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
      {items.length > 0 && (
        <div class="card">
          <div class="page-head">
            <h3>{T(`${items.length} found, ${selected.length} selected`, `${items.length} gevonden, ${selected.length} geselecteerd`)}</h3>
            <div class="row">
              <button class="btn small ghost" onClick={() => setItems(items.map((i) => ({ ...i, selected: true })))}>{T('All', 'Alles')}</button>
              <button class="btn small ghost" onClick={() => setItems(items.map((i) => ({ ...i, selected: false })))}>{T('None', 'Geen')}</button>
              <button class="btn small ghost" onClick={() => setItems([])}>{T('Start over', 'Opnieuw')}</button>
            </div>
          </div>
          <p class="hint">{T('Photos stay hosted where they are now. If you delete the item there, re-upload photos here.', 'Foto\'s blijven gehost waar ze nu staan. Verwijder je het item daar, upload de foto\'s dan hier opnieuw.')}</p>
          <div class="import-list">
            {items.map((it, i) => (
              <div class={`import-row ${it.selected ? '' : 'off'}`} key={i}>
                <input type="checkbox" checked={it.selected} onChange={(e) => update(i, { selected: e.target.checked })} />
                <Img src={it.images[0]} class="thumb-sm" />
                <div class="grow">
                  <input value={it.title} onInput={(e) => update(i, { title: e.target.value })} />
                  <div class="row">
                    <input class="price-in" inputmode="decimal" value={it.price} onInput={(e) => update(i, { price: e.target.value })} />
                    <span>{it.currency}</span>
                    <select value={it.category} onChange={(e) => update(i, { category: e.target.value })}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{label(CATEGORY_LABELS, c)}</option>)}
                    </select>
                    {it.duplicate && <span class="badge warn">{T('already imported', 'al geïmporteerd')}</span>}
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
