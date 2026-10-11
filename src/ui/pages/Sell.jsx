import { useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { market, upsertLocal } from '../../lib/market.js';
import { account } from '../../lib/nostr/account.js';
import { signAndPublish } from '../../lib/nostr/pool.js';
import { listingTemplate, parseListing, newListingId, CATEGORIES, CONDITIONS } from '../../lib/nostr/listings.js';
import { uploadImage } from '../../lib/nostr/blossom.js';
import { settings } from '../../lib/settings.js';
import { navigate } from '../router.js';
import { T, CATEGORY_LABELS, CONDITION_LABELS, label } from '../i18n.js';
import { Action, Field, Img, Empty, toast, toastError, Spinner } from '../components.jsx';
import { ListingCard } from './Browse.jsx';

export async function publishListing(data) {
  const res = await signAndPublish(listingTemplate(data));
  const l = parseListing(res.event);
  if (l) upsertLocal(l);
  return { listing: l, ...res };
}

export function Sell() {
  const { listings } = useStore(market);
  const me = useStore(account, (a) => a.pubkey);
  const mine = useMemo(() => [...listings.values()].filter((l) => l.pubkey === me && l.status !== 'deleted').sort((a, b) => b.createdAt - a.createdAt), [listings, me]);
  return (
    <div>
      <div class="page-head">
        <h2>{T('Your listings', 'Jouw advertenties')}</h2>
        <div class="row">
          <a class="btn primary" href="#/sell/new">{T('New listing', 'Nieuwe advertentie')}</a>
          <a class="btn" href="#/import">{T('Import from Vinted / eBay', 'Importeren van Vinted / eBay')}</a>
        </div>
      </div>
      {mine.length ? <div class="grid">{mine.map((l) => <div key={l.coord}><ListingCard l={l} /><a class="btn small ghost" href={`#/sell/${encodeURIComponent(l.d)}`}>{T('Edit', 'Bewerken')}</a></div>)}</div>
        : <Empty>{T('You have no listings yet.', 'Je hebt nog geen advertenties.')}</Empty>}
    </div>
  );
}

export function EditListing({ d }) {
  const { listings } = useStore(market);
  const me = useStore(account, (a) => a.pubkey);
  const existing = d ? [...listings.values()].find((l) => l.pubkey === me && l.d === d) : null;
  const s = settings.get();
  const [f, setF] = useState(() => existing ? { ...existing, images: [...existing.images] } : {
    d: newListingId(), title: '', content: '', price: '', currency: s.currency, category: 'other', condition: 'good',
    location: '', shipsTo: '', shippingCost: '', sellerDepositPct: s.sellerDepositPct, images: [], status: 'active',
  });
  const [uploading, setUploading] = useState(false);
  const [imgUrl, setImgUrl] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  if (d && !existing) return <Empty>{listings.size ? T('Listing not found', 'Advertentie niet gevonden') : <Spinner />}</Empty>;

  const onFiles = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    setUploading(true);
    try {
      const urls = [];
      for (const file of files) urls.push(await uploadImage(file));
      setF((cur) => ({ ...cur, images: [...cur.images, ...urls].slice(0, 12) }));
    } catch (err) { toastError(err); } finally { setUploading(false); }
  };

  const save = async (status = f.status) => {
    const price = Number(String(f.price).replace(',', '.'));
    if (!f.title.trim()) throw new Error(T('Title is required', 'Titel is verplicht'));
    if (!(price > 0)) throw new Error(T('Enter a price', 'Vul een prijs in'));
    const shippingCost = f.shippingCost === '' || f.shippingCost == null ? null : Number(String(f.shippingCost).replace(',', '.'));
    await publishListing({ ...f, title: f.title.trim(), price, shippingCost, sellerDepositPct: Number(f.sellerDepositPct) || 0, status });
    toast(T('Published', 'Gepubliceerd'), 'ok');
    navigate('/sell');
  };

  return (
    <div class="card form">
      <h2>{existing ? T('Edit listing', 'Advertentie bewerken') : T('New listing', 'Nieuwe advertentie')}</h2>
      <Field label={T('Title', 'Titel')}><input value={f.title} onInput={set('title')} maxLength={200} /></Field>
      <Field label={T('Description', 'Beschrijving')}><textarea rows="6" value={f.content} onInput={set('content')} /></Field>
      <div class="cols">
        <Field label={T('Price', 'Prijs')}><input inputmode="decimal" value={f.price} onInput={set('price')} /></Field>
        <Field label={T('Currency', 'Valuta')}>
          <select value={f.currency} onChange={set('currency')}>{['EUR', 'USD', 'GBP', 'CHF', 'PLN', 'CZK', 'SEK', 'XBT'].map((c) => <option key={c}>{c}</option>)}</select>
        </Field>
      </div>
      <p class="hint">{T('Prices in fiat are converted to XBT when a buyer makes an offer; you approve the amount.', 'Prijzen in euro e.d. worden omgerekend naar XBT als een koper een bod doet; jij keurt het bedrag goed.')}</p>
      <div class="cols">
        <Field label={T('Category', 'Categorie')}>
          <select value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c} value={c}>{label(CATEGORY_LABELS, c)}</option>)}</select>
        </Field>
        <Field label={T('Condition', 'Staat')}>
          <select value={f.condition} onChange={set('condition')}>{CONDITIONS.map((c) => <option key={c} value={c}>{label(CONDITION_LABELS, c)}</option>)}</select>
        </Field>
      </div>
      <div class="cols">
        <Field label={T('Location', 'Locatie')}><input value={f.location} onInput={set('location')} placeholder="Utrecht, NL" /></Field>
        <Field label={T('Ships to', 'Verzendt naar')}><input value={f.shipsTo} onInput={set('shipsTo')} placeholder="EU" /></Field>
      </div>
      <div class="cols">
        <Field label={T('Shipping cost', 'Verzendkosten')} hint={T('Same currency as the price', 'Zelfde valuta als de prijs')}><input inputmode="decimal" value={f.shippingCost ?? ''} onInput={set('shippingCost')} /></Field>
        <Field label={T('Your deposit (%)', 'Jouw borg (%)')} hint={T('Shows buyers you have skin in the game; returned when the trade completes.', 'Laat kopers zien dat jij ook iets inzet; je krijgt het terug als de trade klaar is.')}>
          <input type="number" min="0" max="100" value={f.sellerDepositPct} onInput={set('sellerDepositPct')} />
        </Field>
      </div>
      <Field label={T('Photos', 'Foto\'s')}>
        <div class="photos">
          {f.images.map((u, i) => (
            <div class="photo" key={u}>
              <Img src={u} />
              <button type="button" class="x" onClick={() => setF({ ...f, images: f.images.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <label class="photo add">{uploading ? <Spinner /> : '+'}<input type="file" accept="image/*" multiple onChange={onFiles} hidden /></label>
        </div>
        <div class="row">
          <input value={imgUrl} onInput={(e) => setImgUrl(e.target.value)} placeholder={T('…or paste an image URL', '…of plak een afbeeldings-URL')} />
          <button class="btn" type="button" onClick={() => { if (/^https?:\/\//.test(imgUrl)) { setF({ ...f, images: [...f.images, imgUrl] }); setImgUrl(''); } }}>{T('Add', 'Toevoegen')}</button>
        </div>
      </Field>
      <div class="row">
        <Action class="primary" onClick={() => save('active')}>{existing ? T('Save', 'Opslaan') : T('Publish', 'Publiceren')}</Action>
        {existing && f.status === 'active' && <Action onClick={() => save('sold')}>{T('Mark as sold', 'Markeer als verkocht')}</Action>}
        {existing && f.status !== 'active' && <Action onClick={() => save('active')}>{T('Re-activate', 'Opnieuw activeren')}</Action>}
        {existing && <Action class="danger" confirm={T('Delete this listing?', 'Deze advertentie verwijderen?')} onClick={() => save('deleted')}>{T('Delete', 'Verwijderen')}</Action>}
      </div>
    </div>
  );
}
