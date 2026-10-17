import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { market, upsertLocal } from '../../lib/market.js';
import { decodeListingRef, parseListing, LISTING_KIND } from '../../lib/nostr/listings.js';
import { query, latestBy } from '../../lib/nostr/pool.js';
import { account } from '../../lib/nostr/account.js';
import { reviewsAbout } from '../../lib/nostr/reviews.js';
import { settings } from '../../lib/settings.js';
import { formatFiat } from '../../lib/btc/units.js';
import { openConversation } from '../../lib/trade/actions.js';
import { carrier, offersPickup, shipCarriers } from '../../lib/shipping.js';
import { navigate } from '../router.js';
import { T, CATEGORY_LABELS, CONDITION_LABELS, label, fmtDate, countryName } from '../i18n.js';
import { Action, Field, Name, ListingPrice, Img, Stars, Empty, Spinner } from '../components.jsx';
import { SubcategoryLabel } from '../categories.jsx';
import { FollowButton } from './Profile.jsx';
import { useMyTrades } from './Trades.jsx';

function Reputation({ pk }) {
  const [rep, setRep] = useState(null);
  useEffect(() => { reviewsAbout(pk).then(setRep).catch(() => setRep({ count: 0, verifiedTrades: 0 })); }, [pk]);
  if (!rep) return <span class="muted small"><Spinner /></span>;
  return (
    <a class="rep" href={`#/u/${pk}`}>
      {rep.count ? <><Stars value={rep.avg} /> <span class="muted small">{rep.verifiedTrades} {T('verified trades', 'compras verificadas')} · {rep.count} {T('reviews', 'valoraciones')}</span></>
        : <span class="muted small">{T('No trades yet', 'Sin compras todavía')}</span>}
    </a>
  );
}
export { Reputation };

const PAY_LABEL = {
  lightning: ['⚡ Lightning (instant, direct to the seller)', '⚡ Lightning (al instante, directo al vendedor)'],
  onchain: ['On-chain (direct to the seller)', 'On-chain (directo al vendedor)'],
  escrow: ['🛡 Escrow (buyer protection, with deposits)', '🛡 Escrow (protección al comprador, con depósitos)'],
};
export const payLabel = (p) => T(...(PAY_LABEL[p] || [p, p]));
const PAY_SHORT = { lightning: 'Lightning', onchain: 'On-chain', escrow: 'Escrow' };
export const payShort = (p) => PAY_SHORT[p] || p;

// A listing by its coordinate, from the feed or straight from the relays.
export function useListing(coord) {
  const { listings } = useStore(market);
  const listing = coord && listings.get(coord);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!coord || listing) return;
    const [, pubkey, d] = coord.split(':');
    query({ kinds: [LISTING_KIND], authors: [pubkey], '#d': [d] }).then((evs) => {
      const l = parseListing(latestBy(evs, (e) => e.pubkey)[0] || { tags: [] });
      if (l) upsertLocal(l); else setMissing(true);
    }).catch(() => setMissing(true));
  }, [coord]);
  return { listing, missing };
}

function ContactSeller({ listing }) {
  const acc = useStore(account);
  const trades = useMyTrades();
  const [text, setText] = useState(T('Hi! Is this still available?', '¡Hola! ¿Sigue disponible?'));
  const [writing, setWriting] = useState(false);
  // An unanswered conversation or order about this listing is continued, not duplicated.
  const existing = trades.find((t) => t.state.role === 'buyer' && t.state.listing?.coord === listing.coord && ['chat', 'offered'].includes(t.state.status));
  if (!acc.pubkey) return <a class="btn primary wide" href="#/settings">{T('Log in to message or buy', 'Inicia sesión para escribir o comprar')}</a>;
  if (existing) return <a class="btn primary wide" href={`#/trade/${existing.id}`}>💬 {T('Go to your conversation', 'Ir a tu conversación')}</a>;
  const start = async (order) => {
    const id = await openConversation({ listing, network: settings.get().network, text: order ? '' : text.trim() });
    navigate(`/trade/${id}${order ? '?order=1' : ''}`);
  };
  return (
    <div class="contact">
      {writing ? (
        <div class="card">
          <Field label={T('Message to the seller', 'Mensaje para el vendedor')}><textarea rows="3" value={text} onInput={(e) => setText(e.target.value)} autofocus /></Field>
          <div class="row">
            <Action class="primary" disabled={!text.trim()} onClick={() => start(false)}>{T('Send', 'Enviar')}</Action>
            <button class="btn ghost" onClick={() => setWriting(false)}>{T('Cancel', 'Cancelar')}</button>
          </div>
        </div>
      ) : (
        <button class="btn primary wide" onClick={() => setWriting(true)}>💬 {T('Message the seller', 'Escribir al vendedor')}</button>
      )}
      {listing.status === 'active' && !writing && <Action class="wide" onClick={() => start(true)}>🛒 {T('Order now', 'Pedir ahora')}</Action>}
      <p class="hint">{T('No obligation: ask your questions first. You order and pay from the chat.', 'Sin compromiso: pregunta primero. Pides y pagas desde el chat.')}</p>
    </div>
  );
}

export function ListingPage({ naddr }) {
  const acc = useStore(account);
  const ref = useMemo(() => { try { return decodeListingRef(naddr); } catch { return null; } }, [naddr]);
  const coord = ref && `${LISTING_KIND}:${ref.pubkey}:${ref.identifier}`;
  const { listing, missing } = useListing(coord);
  const [img, setImg] = useState(0);

  if (!ref) return <Empty>{T('Invalid link', 'Enlace no válido')}</Empty>;
  if (!listing) return <Empty>{missing ? T('Listing not found', 'Anuncio no encontrado') : <Spinner />}</Empty>;
  const mine = acc.pubkey === listing.pubkey;
  const carriers = shipCarriers(listing);
  const pickup = offersPickup(listing);

  return (
    <div class="listing-page">
      <div class="gallery">
        <Img src={listing.images[img]} alt={listing.title} class="main" />
        {listing.images.length > 1 && (
          <div class="thumbs">{listing.images.map((u, i) => <button key={u} class={i === img ? 'active' : ''} onClick={() => setImg(i)}><Img src={u} /></button>)}</div>
        )}
      </div>
      <div class="details">
        <h1>{listing.title}</h1>
        <ListingPrice listing={listing} big />
        {listing.status === 'reserved' && <p class="notice warn">{T('Reserved: the seller is holding this for someone.', 'Reservado: el vendedor lo guarda para alguien.')}</p>}
        {listing.status === 'sold' && <p class="notice">{T('Sold.', 'Vendido.')}</p>}
        <div class="tags">
          <span class="badge">{label(CATEGORY_LABELS, listing.category)}{listing.subcategory && <> › <SubcategoryLabel category={listing.category} sub={listing.subcategory} /></>}</span>
          {listing.condition && <span class="badge">{label(CONDITION_LABELS, listing.condition)}</span>}
          {(listing.city || listing.country || listing.location) && <span class="badge">📍 {[listing.city, listing.country && countryName(listing.country)].filter(Boolean).join(', ') || listing.location}</span>}
        </div>
        {(carriers.length > 0 || pickup) && (
          <div class="small delivery-info">
            <b>{T('Delivery', 'Entrega')}:</b> {[pickup && T('pick-up', 'recogida'), ...carriers.map((o) => carrier(o.id).name + (o.price != null ? ` ${formatFiat(o.price, o.currency)}` : ''))].filter(Boolean).join(' · ')}
            {carriers.length > 0 && <div class="muted">{T('Ships to', 'Envía a')}: {[listing.country && countryName(listing.country), ...listing.shipsTo.filter((x) => x !== listing.country).map(countryName)].filter(Boolean).join(', ') || T('ask the seller', 'pregunta al vendedor')}{carriers.some((o) => o.price == null) && ` · ${T('shipping paid by the buyer, at the carrier\'s rate', 'envío a cargo del comprador, a la tarifa del transportista')}`}</div>}
          </div>
        )}
        <div class="muted small">{T('Payment', 'Pago')}: {listing.payments.map(payShort).join(' · ')}</div>
        <div class="seller"><Name pk={listing.pubkey} /> <Reputation pk={listing.pubkey} /> <FollowButton pk={listing.pubkey} /></div>
        <p class="description">{listing.content}</p>
        {listing.source && <p class="muted small">{T('Also listed at', 'También anunciado en')} <a href={listing.source} target="_blank" rel="noopener noreferrer">{listing.importedFrom || new URL(listing.source).hostname}</a></p>}
        <p class="muted small">{T('Updated', 'Actualizado')} {fmtDate(listing.createdAt)}</p>
        {mine ? <a class="btn" href={`#/sell/${encodeURIComponent(listing.d)}`}>✏️ {T('Edit listing', 'Editar anuncio')}</a>
          : listing.status === 'sold' ? null
          : <ContactSeller listing={listing} />}
      </div>
    </div>
  );
}
