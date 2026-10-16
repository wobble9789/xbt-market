import { useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { market, upsertLocal } from '../../lib/market.js';
import { account } from '../../lib/nostr/account.js';
import { signAndPublish } from '../../lib/nostr/pool.js';
import { listingTemplate, parseListing, newListingId, CATEGORIES, CONDITIONS, PAYMENT_METHODS } from '../../lib/nostr/listings.js';
import { CARRIERS, optionsFor } from '../../lib/shipping.js';
import { aiConfigured, draftListing } from '../../lib/ai/listing.js';
import { secretNames } from '../../lib/secrets.js';
import { payLabel } from './Listing.jsx';
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
  // Older listings carry one shipping_cost; they are edited as options.
  const [f, setF] = useState(() => existing ? { ...existing, images: [...existing.images], shippingOptions: optionsFor(existing).map((o) => ({ ...o })) } : {
    d: newListingId(), title: '', content: '', price: '', currency: s.currency, category: 'other', condition: 'good',
    location: '', shipsTo: '', shippingCost: '', sellerDepositPct: s.sellerDepositPct, images: [], status: 'active',
    shippingOptions: [{ id: 'postnl', price: '' }], payments: [...PAYMENT_METHODS],
  });
  useStore(secretNames);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');
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
    const shippingOptions = (f.shippingOptions || []).filter((o) => o.id).map((o) => ({ id: o.id, price: Number(String(o.price || 0).replace(',', '.')), currency: f.currency }));
    if (shippingOptions.some((o) => !(o.price >= 0))) throw new Error(T('Check the delivery prices', 'Controleer de bezorgprijzen'));
    if (!f.payments?.length) throw new Error(T('Choose at least one payment method', 'Kies minstens één betaalmethode'));
    // Kept for older clients that only know one shipping cost.
    const paidShipping = shippingOptions.filter((o) => o.id !== 'pickup').map((o) => o.price);
    const shippingCost = paidShipping.length ? Math.min(...paidShipping) : null;
    await publishListing({ ...f, title: f.title.trim(), price, shippingCost, shippingOptions, sellerDepositPct: Number(f.sellerDepositPct) || 0, status });
    toast(T('Published', 'Gepubliceerd'), 'ok');
    navigate('/sell');
  };

  const runAi = async () => {
    setAiBusy(true);
    try {
      const d = await draftListing({ images: f.images, lang: s.lang, currency: f.currency === 'XBT' ? 'EUR' : f.currency, hint: [f.title, f.content].filter(Boolean).join('\n') });
      setF((cur) => ({ ...cur, title: d.title, content: d.description, category: d.category, condition: d.condition, price: d.price > 0 && cur.currency !== 'XBT' ? String(d.price) : cur.price }));
      setAiNote(d.notes || '');
      toast(T('Draft filled in. Check it before publishing.', 'Concept ingevuld. Controleer het voor je publiceert.'), 'ok');
    } catch (e) { toastError(e); } finally { setAiBusy(false); }
  };
  const setOpt = (i, patch) => setF({ ...f, shippingOptions: f.shippingOptions.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  const togglePay = (p) => setF({ ...f, payments: f.payments?.includes(p) ? f.payments.filter((x) => x !== p) : [...(f.payments || []), p] });

  return (
    <div class="card form">
      <h2>{existing ? T('Edit listing', 'Advertentie bewerken') : T('New listing', 'Nieuwe advertentie')}</h2>
      <p class="hint">{T('Start with the photos: the AI assistant can then write the listing for you.', 'Begin met de foto\'s: de AI-hulp kan dan de advertentie voor je schrijven.')}</p>
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
        {aiConfigured()
          ? <button type="button" class="btn" disabled={aiBusy || !f.images.length} onClick={runAi}>{aiBusy ? <Spinner /> : '✨'} {T('Write listing from photos', 'Schrijf advertentie op basis van foto\'s')}</button>
          : <a class="btn ghost" href="#/settings">✨ {T('Set up the AI assistant', 'AI-hulp instellen')}</a>}
      </div>
      {aiNote && <p class="notice small">💡 {aiNote}</p>}
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
      <Field label={T('Delivery options', 'Bezorgopties')} hint={T('The buyer picks one. Prices in the listing currency; 0 = free.', 'De koper kiest er één. Prijzen in de valuta van de advertentie; 0 = gratis.')}>
        {(f.shippingOptions || []).map((o, i) => (
          <div class="row ship-option" key={i}>
            <select value={o.id} onChange={(e) => setOpt(i, { id: e.target.value })}>{CARRIERS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <input inputmode="decimal" value={o.price} onInput={(e) => setOpt(i, { price: e.target.value })} placeholder={T('Price', 'Prijs')} aria-label={T('Delivery price', 'Bezorgprijs')} />
            <button type="button" class="btn small ghost" onClick={() => setF({ ...f, shippingOptions: f.shippingOptions.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        <button type="button" class="btn small" onClick={() => setF({ ...f, shippingOptions: [...(f.shippingOptions || []), { id: 'pickup', price: '0' }] })}>+ {T('Add option', 'Optie toevoegen')}</button>
      </Field>
      <div class="cols">
        <Field label={T('Your deposit (%)', 'Jouw borg (%)')} hint={T('Shows buyers you have skin in the game; returned when the trade completes.', 'Laat kopers zien dat jij ook iets inzet; je krijgt het terug als de trade klaar is.')}>
          <input type="number" min="0" max="100" value={f.sellerDepositPct} onInput={set('sellerDepositPct')} />
        </Field>
      </div>
      <Field label={T('Payment methods you accept', 'Betaalmethodes die je accepteert')} hint={T('Escrow protects both sides and is recommended above €50. Direct payments are faster and free of deposits.', 'Escrow beschermt beide kanten en is aanbevolen boven €50. Directe betalingen zijn sneller en zonder borg.')}>
        <div class="choices">
          {PAYMENT_METHODS.map((p) => (
            <label key={p} class={`choice ${f.payments?.includes(p) ? 'on' : ''}`}><input type="checkbox" checked={f.payments?.includes(p)} onChange={() => togglePay(p)} /><span>{payLabel(p)}</span></label>
          ))}
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
