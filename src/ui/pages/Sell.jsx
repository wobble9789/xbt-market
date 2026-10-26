import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { market, upsertLocal } from '../../lib/market.js';
import { account } from '../../lib/nostr/account.js';
import { signAndPublish } from '../../lib/nostr/pool.js';
import { useProfile } from '../../lib/nostr/profiles.js';
import { listingTemplate, parseListing, newListingId, CONDITIONS, PAYMENT_METHODS, DEFAULT_PAYMENTS, PACKAGE_SIZES } from '../../lib/nostr/listings.js';
import { SHIP_CARRIERS, DEFAULT_CARRIERS, optionsFor } from '../../lib/shipping.js';
import { isService, normalizeCategory, PRICE_UNITS, DEFAULT_CATEGORY, loadCategoryTree } from '../../lib/categories.js';
import { CURRENCIES } from '../../lib/countries.js';
import { MIN_DEPOSIT_PCT, MAX_DEPOSIT_PCT } from '../../config.js';
import { depositPctOf } from '../../lib/nostr/listings.js';
import { aiConfigured, draftListing } from '../../lib/ai/listing.js';
import { secretNames } from '../../lib/secrets.js';
import { payLabel } from './Listing.jsx';
import { uploadImage } from '../../lib/nostr/blossom.js';
import { settings } from '../../lib/settings.js';
import { directory, refreshDirectory, arbiterFeeLabel } from '../../lib/nostr/directory.js';
import { navigate } from '../router.js';
import { T, CONDITION_LABELS, PRICE_UNIT_LABELS, label } from '../i18n.js';
import { Action, Field, Img, Empty, toast, toastError, Spinner, Name } from '../components.jsx';
import { CountrySelect, ShipsToPicker } from '../countries.jsx';
import { CategoryPicker, useCategoryTree, modelsFor } from '../categories.jsx';
import { ListingCard } from './Browse.jsx';

export async function publishListing(data) {
  const res = await signAndPublish(listingTemplate(data));
  const l = parseListing(res.event);
  if (l) upsertLocal(l);
  return { listing: l, ...res };
}

const TABS = [['active', ['For sale', 'En venta']], ['reserved', ['Reserved', 'Reservados']], ['sold', ['Sold', 'Vendidos']]];

export function Sell() {
  const { listings } = useStore(market);
  const me = useStore(account, (a) => a.pubkey);
  const [tab, setTab] = useState('active');
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(null);
  const mine = useMemo(() => [...listings.values()].filter((l) => l.pubkey === me && l.status !== 'deleted').sort((a, b) => b.createdAt - a.createdAt), [listings, me]);
  const shown = mine.filter((l) => (l.status === tab));
  const counts = Object.fromEntries(TABS.map(([k]) => [k, mine.filter((l) => l.status === k).length]));
  const toggle = (coord) => { const n = new Set(picked); n.has(coord) ? n.delete(coord) : n.add(coord); setPicked(n); };
  const selected = shown.filter((l) => picked.has(l.coord));
  const bulk = async (status) => {
    let done = 0;
    setBusy({ done, total: selected.length });
    try {
      for (const l of selected) { await publishListing({ ...l, status }); setBusy({ done: ++done, total: selected.length }); }
      toast(status === 'deleted' ? T(`${done} deleted`, `${done} eliminados`) : status === 'sold' ? T(`${done} marked as sold`, `${done} marcados como vendidos`) : T(`${done} updated`, `${done} actualizados`), 'ok');
      setPicked(new Set());
    } finally { setBusy(null); }
  };
  return (
    <div>
      <div class="page-head">
        <h2>{T('Your listings', 'Tus anuncios')}</h2>
        <div class="row">
          <a class="btn primary" href="#/sell/new">+ {T('New listing', 'Nuevo anuncio')}</a>
          <a class="btn" href="#/import">⇪ {T('Import from Marktplaats, Vinted…', 'Importar de Marktplaats, Vinted…')}</a>
        </div>
      </div>
      <div class="tabs">
        {TABS.map(([k, l]) => <button key={k} class={`tab ${tab === k ? 'on' : ''}`} onClick={() => { setTab(k); setPicked(new Set()); }}>{T(...l)} <span class="muted">({counts[k]})</span></button>)}
      </div>
      {shown.length > 0 && (
        <div class="bulk-bar">
          <label class="row nomargin"><input type="checkbox" checked={selected.length === shown.length} onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((l) => l.coord)) : new Set())} /> {selected.length ? T(`${selected.length} selected`, `${selected.length} seleccionados`) : T('Select all', 'Seleccionar todo')}</label>
          {selected.length > 0 && (
            <div class="row nomargin">
              {busy ? <span><Spinner /> {busy.done}/{busy.total}</span> : <>
                {tab !== 'sold' && <Action class="small" confirm={T(`Mark ${selected.length} listings as sold?`, `¿Marcar ${selected.length} anuncios como vendidos?`)} onClick={() => bulk('sold')}>{T('Mark as sold', 'Marcar como vendidos')}</Action>}
                {tab !== 'active' && <Action class="small" onClick={() => bulk('active')}>{T('Put back on sale', 'Volver a poner en venta')}</Action>}
                <Action class="small danger" confirm={T(`Delete ${selected.length} listings?`, `¿Eliminar ${selected.length} anuncios?`)} onClick={() => bulk('deleted')}>{T('Delete', 'Eliminar')}</Action>
              </>}
            </div>
          )}
        </div>
      )}
      {shown.length ? (
        <div class="grid">
          {shown.map((l) => (
            <div key={l.coord} class={`pickable ${picked.has(l.coord) ? 'picked' : ''}`}>
              <input type="checkbox" class="pick" checked={picked.has(l.coord)} onChange={() => toggle(l.coord)} aria-label={T('Select', 'Seleccionar')} />
              <ListingCard l={l} />
              {!l.subcategory && <span class="badge warn small">⚠ {T('Incomplete: choose a subcategory', 'Incompleto: elige una subcategoría')}</span>}
              <a class="btn small ghost" href={`#/sell/${encodeURIComponent(l.d)}`}>✏️ {T('Edit', 'Editar')}</a>
            </div>
          ))}
        </div>
      ) : <Empty>{tab === 'active' ? T('You have nothing for sale yet.', 'Aún no tienes nada en venta.') : T('Nothing here.', 'Nada por aquí.')}</Empty>}
    </div>
  );
}

const SIZE_LABEL = {
  S: ['Small: up to 2 kg (a shoebox)', 'Pequeño: hasta 2 kg (una caja de zapatos)'],
  M: ['Medium: up to 5 kg (a moving box)', 'Mediano: hasta 5 kg (una caja de mudanza)'],
  L: ['Large: up to 10 kg', 'Grande: hasta 10 kg'],
  XL: ['Extra large: up to 20 kg', 'Muy grande: hasta 20 kg'],
};

export function EditListing({ d }) {
  const { listings } = useStore(market);
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  useEffect(() => { refreshDirectory().catch(() => {}); }, []);
  const profile = useProfile(me);
  const existing = d ? [...listings.values()].find((l) => l.pubkey === me && l.d === d) : null;
  const s = settings.get();
  const myCountry = s.country || profile.xbt_market?.country || '';
  const [f, setF] = useState(() => existing ? {
    ...existing, images: [...existing.images],
    carriers: optionsFor(existing).filter((o) => o.id !== 'pickup' && o.id !== 'other').map((o) => o.id),
    pickup: optionsFor(existing).some((o) => o.id === 'pickup'),
    packageSize: existing.packageSize || 'M',
  } : {
    d: newListingId(), title: '', content: '', price: '', currency: s.currency, category: DEFAULT_CATEGORY, subcategory: '', model: '', condition: 'good', priceUnit: '',
    country: myCountry, city: '', shipsTo: myCountry ? [myCountry] : [], images: [], status: 'active',
    carriers: [...DEFAULT_CARRIERS], pickup: true, packageSize: 'M', payments: [...DEFAULT_PAYMENTS],
  });
  const tree = useCategoryTree();
  useStore(secretNames);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const [uploading, setUploading] = useState(false);
  // Functional updates: quick successive edits must never overwrite each other.
  const set = (k) => (e) => { const v = e.target.value; setF((cur) => ({ ...cur, [k]: v })); };
  useEffect(() => { if (!f.country && myCountry) setF((cur) => ({ ...cur, country: cur.country || myCountry })); }, [myCountry]);

  if (d && !existing) return <Empty>{listings.size ? T('Listing not found', 'Anuncio no encontrado') : <Spinner />}</Empty>;

  const onFiles = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    setUploading(true);
    try {
      for (const file of files) { const url = await uploadImage(file); setF((cur) => ({ ...cur, images: [...cur.images, url].slice(0, 12) })); }
    } catch (err) { toastError(err); } finally { setUploading(false); }
  };

  const service = isService(f.category);
  const escrow = f.payments?.includes('escrow');
  // Escrow: the arbiters this seller accepts. Until chosen, all the seller trusts.
  const trusted = [...dir.arbiters.keys()].filter((pk) => pk !== me);
  const chosenArbiters = (f.arbiters?.length ? f.arbiters : trusted).filter((pk) => trusted.includes(pk));
  const subs = tree?.get(f.category) || [];
  const models = modelsFor(tree, f.category, f.subcategory);

  const save = async (status = f.status) => {
    const price = Number(String(f.price).replace(',', '.'));
    if (!f.title.trim()) throw new Error(T('Title is required', 'El título es obligatorio'));
    if (!(price > 0)) throw new Error(T('Enter a price', 'Introduce un precio'));
    if (subs.length && !f.subcategory) throw new Error(T('Choose a subcategory', 'Elige una subcategoría'));
    if (models.length && !f.model) throw new Error(T('Choose a model', 'Elige un modelo'));
    if (!service && f.carriers.length && !f.shipsTo?.length) throw new Error(T('Choose where you ship to', 'Elige adónde envías'));
    if (!f.country) throw new Error(T('Choose the country the item is in', 'Elige el país donde está el artículo'));
    if (!f.payments?.length) throw new Error(T('Choose at least one payment method', 'Elige al menos un método de pago'));
    if (!service && !f.pickup && !f.carriers.length) throw new Error(T('Offer pick-up or at least one carrier', 'Ofrece recogida o al menos un transportista'));
    if (escrow && !chosenArbiters.length) throw new Error(T('Escrow needs at least one arbiter you trust', 'El escrow necesita al menos un árbitro de tu confianza'));
    const dep = Number(f.depositPct ?? depositPctOf(f));
    if (escrow && !(Number.isInteger(dep) && dep >= MIN_DEPOSIT_PCT && dep <= MAX_DEPOSIT_PCT)) throw new Error(T(`The deposit must be a whole number from ${MIN_DEPOSIT_PCT} to ${MAX_DEPOSIT_PCT}%`, `El depósito debe ser un número entero de ${MIN_DEPOSIT_PCT} a ${MAX_DEPOSIT_PCT}%`));
    const shippingOptions = service ? [] : [...(f.pickup ? [{ id: 'pickup', price: 0 }] : []), ...f.carriers.map((id) => ({ id }))];
    await publishListing({
      ...f, title: f.title.trim(), price, shippingOptions, shippingCost: null, location: '', status,
      arbiters: escrow ? chosenArbiters : [], depositPct: escrow ? dep : null,
      // A service has no condition or delivery; goods have no price per hour.
      condition: service ? '' : f.condition, shipsTo: service || !f.carriers.length ? [] : f.shipsTo, packageSize: service || !f.carriers.length ? '' : f.packageSize,
      priceUnit: service ? f.priceUnit || '' : '',
    });
    toast(T('Published', 'Publicado'), 'ok');
    navigate('/sell');
  };

  const runAi = async () => {
    setAiBusy(true);
    try {
      const d = await draftListing({ images: f.images, lang: s.lang, currency: f.currency === 'XBT' ? 'EUR' : f.currency, hint: [f.title, f.content].filter(Boolean).join('\n'), tree: await loadCategoryTree() });
      setF((cur) => ({ ...cur, title: d.title, content: d.description, category: normalizeCategory(d.category), subcategory: d.subcategory || '', condition: d.condition, price: d.price > 0 && cur.currency !== 'XBT' ? String(d.price) : cur.price }));
      setAiNote(d.notes || '');
      toast(T('Draft filled in. Check it before publishing.', 'Borrador rellenado. Revísalo antes de publicar.'), 'ok');
    } catch (e) { toastError(e); } finally { setAiBusy(false); }
  };
  const toggle = (k, v) => setF((cur) => ({ ...cur, [k]: cur[k]?.includes(v) ? cur[k].filter((x) => x !== v) : [...(cur[k] || []), v] }));

  return (
    <div class="card form">
      <h2>{existing ? T('Edit listing', 'Editar anuncio') : T('New listing', 'Nuevo anuncio')}</h2>
      <p class="hint">{T('Start with the photos: the AI assistant can then write the listing for you.', 'Empieza por las fotos: el asistente de IA puede escribir el anuncio por ti.')}</p>
      <Field label={T('Photos', 'Fotos')}>
        <div class="photos">
          {f.images.map((u, i) => (
            <div class="photo" key={u}>
              <Img src={u} />
              <button type="button" class="x" aria-label={T('Remove photo', 'Quitar foto')} onClick={() => setF((cur) => ({ ...cur, images: cur.images.filter((_, j) => j !== i) }))}>×</button>
            </div>
          ))}
          <label class="photo add" aria-label={T('Add photos', 'Añadir fotos')}>{uploading ? <Spinner /> : '+'}<input type="file" accept="image/*" multiple onChange={onFiles} hidden /></label>
        </div>
      </Field>
      <div class="row">
        {aiConfigured()
          ? <button type="button" class="btn" disabled={aiBusy || !f.images.length} onClick={runAi}>{aiBusy ? <Spinner /> : '✨'} {T('Write listing from photos', 'Escribir anuncio a partir de las fotos')}</button>
          : <a class="btn ghost" href="#/settings">✨ {T('Set up the AI assistant', 'Configurar el asistente de IA')}</a>}
      </div>
      {aiNote && <p class="notice small">💡 {aiNote}</p>}
      <Field label={T('Title', 'Título')}><input value={f.title} onInput={set('title')} maxLength={200} /></Field>
      <Field label={T('Description', 'Descripción')}><textarea rows="6" value={f.content} onInput={set('content')} /></Field>
      <Field label={T('Category', 'Categoría')}>
        <div class="cols cat-pick"><CategoryPicker category={f.category} subcategory={f.subcategory} model={f.model} onChange={(c) => setF((cur) => ({ ...cur, ...c }))} /></div>
      </Field>
      {subs.length > 0 && !f.subcategory && <span class="hint error">{T('Choose a subcategory', 'Elige una subcategoría')}</span>}
      {models.length > 0 && !f.model && <span class="hint error">{T('Choose a model', 'Elige un modelo')}</span>}
      <div class="cols">
        {!service && (
          <Field label={T('Condition', 'Estado')}>
            <select value={f.condition} onChange={set('condition')}>{CONDITIONS.map((c) => <option key={c} value={c}>{label(CONDITION_LABELS, c)}</option>)}</select>
          </Field>
        )}
        <Field label={T('Price', 'Precio')}><input inputmode="decimal" value={f.price} onInput={set('price')} /></Field>
        <Field label={T('Currency', 'Moneda')}>
          <select value={f.currency} onChange={set('currency')}>{[...CURRENCIES, 'XBT'].map((c) => <option key={c}>{c}</option>)}</select>
        </Field>
        {service && (
          <Field label={T('Price per', 'Precio por')}>
            <select value={f.priceUnit || ''} onChange={set('priceUnit')}>{PRICE_UNITS.map((u) => <option key={u} value={u}>{u ? label(PRICE_UNIT_LABELS, u) : T('fixed price', 'precio fijo')}</option>)}</select>
          </Field>
        )}
      </div>
      <p class="hint">{T('Prices in fiat are converted to XBT when a buyer orders; you approve the amount.', 'Los precios en moneda normal se convierten a XBT cuando alguien pide; tú apruebas el importe.')}</p>
      <div class="cols">
        <Field label={T('Pick-up country', 'País de recogida')} hint={T('Where the item is. Parcels are sent from here too.', 'Dónde está el artículo. Los paquetes también salen de aquí.')}><CountrySelect value={f.country} onChange={(country) => setF((cur) => ({ ...cur, country }))} required /></Field>
        <Field label={T('Pick-up town (optional)', 'Ciudad de recogida (opcional)')}><input value={f.city || ''} onInput={set('city')} placeholder="Utrecht" /></Field>
      </div>
      {service ? <p class="hint">{T('A service: no delivery. The buyer pays the agreed amount; with escrow it is released once the job is done.', 'Un servicio: sin envío. El comprador paga el importe acordado; con escrow se libera cuando el trabajo está hecho.')}</p> : (
        <fieldset class="delivery">
          <legend>{T('Delivery', 'Entrega')}</legend>
          <label class={`choice ${f.pickup ? 'on' : ''}`}><input type="checkbox" checked={f.pickup} onChange={() => setF((cur) => ({ ...cur, pickup: !cur.pickup }))} /><span>🤝 {T('Pick-up', 'Recogida en persona')}</span></label>
          <Field group label={T('Carriers you are willing to use', 'Transportistas que aceptas')} hint={T('You set no price: the buyer picks one of these and pays the shipping on top. You then get a prepaid label in the chat.', 'No pones precio: el comprador elige uno de estos y paga el envío aparte. Luego recibes una etiqueta prepagada en el chat.')}>
            <div class="choices carriers">
              {SHIP_CARRIERS.map((c) => (
                <label key={c.id} class={`choice ${f.carriers.includes(c.id) ? 'on' : ''}`}><input type="checkbox" checked={f.carriers.includes(c.id)} onChange={() => toggle('carriers', c.id)} /><span>{c.name}{c.cheap && <span class="badge ok">{T('cheap abroad', 'barato al extranjero')}</span>}</span></label>
              ))}
            </div>
          </Field>
          {f.carriers.length > 0 && <>
            <Field group label={T('Parcel size', 'Tamaño del paquete')}>
              <div class="choices">
                {PACKAGE_SIZES.map((k) => <label key={k} class={`choice ${f.packageSize === k ? 'on' : ''}`}><input type="radio" name="size" checked={f.packageSize === k} onChange={() => setF((cur) => ({ ...cur, packageSize: k }))} /><span>{T(...SIZE_LABEL[k])}</span></label>)}
              </div>
            </Field>
            <Field group label={T('Ships to', 'Envía a')} hint={T('Exactly the countries you choose: add your own country too if you ship there. The EU and worldwide are options as well.', 'Exactamente los países que elijas: añade también tu país si envías allí. La UE y todo el mundo también son opciones.')}>
              <ShipsToPicker value={f.shipsTo || []} onChange={(shipsTo) => setF((cur) => ({ ...cur, shipsTo }))} />
            </Field>
          </>}
        </fieldset>
      )}
      <Field group label={T('Payment methods you accept', 'Métodos de pago que aceptas')} hint={T('Lightning is instant and free. Escrow protects both sides and is recommended above €50; it asks a deposit from both.', 'Lightning es instantáneo y gratis. El escrow protege a ambas partes y se recomienda por encima de 50 €; pide un depósito a los dos.')}>
        <div class="choices">
          {PAYMENT_METHODS.map((p) => (
            <label key={p} class={`choice ${f.payments?.includes(p) ? 'on' : ''}`}><input type="checkbox" checked={f.payments?.includes(p)} onChange={() => toggle('payments', p)} /><span>{payLabel(p)}</span></label>
          ))}
        </div>
      </Field>
      {escrow && (
        <>
        <Field label={T('Escrow deposit (%)', 'Depósito del escrow (%)')} hint={T(`You and the buyer both put this share of the price into the escrow (${MIN_DEPOSIT_PCT}–${MAX_DEPOSIT_PCT}%). Both get it back when the trade completes; whoever cheats can lose it.`, `Tú y el comprador ponéis los dos este porcentaje del precio en el escrow (${MIN_DEPOSIT_PCT}–${MAX_DEPOSIT_PCT}%). Ambos lo recuperáis al terminar la compra; quien haga trampa puede perderlo.`)}>
          <input type="number" min={MIN_DEPOSIT_PCT} max={MAX_DEPOSIT_PCT} step="1" inputMode="numeric" value={f.depositPct ?? depositPctOf(f)} onInput={set('depositPct')} />
        </Field>
        <Field group label={T('Select from your trusted arbiters', 'Elige entre tus árbitros de confianza')} hint={T('If something goes wrong, one of them decides. The buyer picks one from this list when ordering.', 'Si algo sale mal, uno de ellos decide. El comprador elige uno de esta lista al pedir.')}>
          {!dir.loaded ? <Spinner /> : !trusted.length ? <p class="notice warn small">{T('You trust no arbiters yet. Add one under Account → Trusted arbiters.', 'Aún no confías en ningún árbitro. Añade uno en Cuenta → Árbitros de confianza.')}</p> : (
            <div class="choices">
              {trusted.map((pk) => (
                <label key={pk} class={`choice ${chosenArbiters.includes(pk) ? 'on' : ''}`}>
                  <input type="checkbox" checked={chosenArbiters.includes(pk)} onChange={() => setF((cur) => { const now = cur.arbiters?.length ? cur.arbiters : trusted; return { ...cur, arbiters: now.includes(pk) ? now.filter((x) => x !== pk) : [...now, pk] }; })} />
                  <span><Name pk={pk} link={false} avatar={false} /> <span class="muted small">{arbiterFeeLabel(dir.announcements.get(pk))}</span></span>
                </label>
              ))}
            </div>
          )}
        </Field>
        </>
      )}
      <div class="row">
        <Action class="primary" onClick={() => save(existing && f.status !== 'deleted' ? f.status : 'active')}>{existing ? T('Save', 'Guardar') : T('Publish', 'Publicar')}</Action>
        {existing && f.status === 'active' && <Action onClick={() => save('reserved')}>{T('Mark as reserved', 'Marcar como reservado')}</Action>}
        {existing && f.status !== 'sold' && <Action onClick={() => save('sold')}>{T('Mark as sold', 'Marcar como vendido')}</Action>}
        {existing && f.status !== 'active' && <Action onClick={() => save('active')}>{T('Put back on sale', 'Volver a poner en venta')}</Action>}
        {existing && <Action class="danger" confirm={T('Delete this listing?', '¿Eliminar este anuncio?')} onClick={() => save('deleted')}>{T('Delete', 'Eliminar')}</Action>}
      </div>
    </div>
  );
}

