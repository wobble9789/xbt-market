import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { market, upsertLocal } from '../../lib/market.js';
import { decodeListingRef, parseListing, LISTING_KIND } from '../../lib/nostr/listings.js';
import { query, latestBy } from '../../lib/nostr/pool.js';
import { account } from '../../lib/nostr/account.js';
import { directory, refreshDirectory } from '../../lib/nostr/directory.js';
import { reviewsAbout, tradeLimitFor } from '../../lib/nostr/reviews.js';
import { settings, updateSettings } from '../../lib/settings.js';
import { isValidAddress } from '../../lib/btc/address.js';
import { formatCoin, parseCoin } from '../../lib/btc/units.js';
import { fiatToSats } from '../../lib/price.js';
import { createOffer } from '../../lib/trade/actions.js';
import { optionsFor, carrier } from '../../lib/shipping.js';
import { isService } from '../../lib/categories.js';
import { formatFiat } from '../../lib/btc/units.js';
import { navigate } from '../router.js';
import { T, CATEGORY_LABELS, CONDITION_LABELS, label, fmtDate } from '../i18n.js';
import { Action, Field, Name, ListingPrice, Img, Stars, Coin, Empty, Spinner, useRate } from '../components.jsx';

function Reputation({ pk }) {
  const [rep, setRep] = useState(null);
  useEffect(() => { reviewsAbout(pk).then(setRep).catch(() => setRep({ count: 0, verifiedTrades: 0 })); }, [pk]);
  if (!rep) return <span class="muted small"><Spinner /></span>;
  return (
    <a class="rep" href={`#/u/${pk}`}>
      {rep.count ? <><Stars value={rep.avg} /> <span class="muted small">{rep.verifiedTrades} {T('verified trades', 'geverifieerde trades')} · {rep.count} {T('reviews', 'reviews')}</span></>
        : <span class="muted small">{T('No trades yet', 'Nog geen trades')}</span>}
    </a>
  );
}
export { Reputation };

const PAY_LABEL = {
  escrow: ['With escrow (buyer protection)', 'Met escrow (kopersbescherming)'],
  onchain: ['Direct, on chain', 'Direct, on-chain'],
  lightning: ['Direct, Lightning', 'Direct, Lightning'],
};
export const payLabel = (p) => T(...(PAY_LABEL[p] || [p, p]));

function OfferForm({ listing, onClose }) {
  const s = settings.get();
  const dir = useStore(directory);
  const arbiters = [...dir.arbiters.values()];
  const shipOptions = optionsFor(listing);
  const [ship, setShip] = useState(shipOptions[0]?.id || '');
  const [pay, setPay] = useState(null);
  const [priceSats, setPriceSats] = useState(null);
  const [priceText, setPriceText] = useState('');
  const [arbiter, setArbiter] = useState(arbiters[0]?.pubkey || '');
  const [payout, setPayout] = useState(s.payoutAddress || '');
  const [shipTo, setShipTo] = useState(s.shipTo || '');
  const [note, setNote] = useState('');
  const [limit, setLimit] = useState(null);
  const rate = useRate(listing.currency);
  useEffect(() => { refreshDirectory().catch(() => {}); }, []);
  useEffect(() => { if (!arbiter && arbiters[0]) setArbiter(arbiters[0].pubkey); }, [arbiters.length]);

  const option = shipOptions.find((o) => o.id === ship);
  const fiatTotal = listing.price + (option?.price || 0);
  // Escrow is recommended above the threshold (compared in the listing's
  // currency; XBT prices via the display currency's rate).
  const displayRate = useRate(s.currency);
  const advise = listing.currency === 'XBT' ? !displayRate || fiatTotal * displayRate.value > s.escrowAdviceAbove : fiatTotal > s.escrowAdviceAbove;
  useEffect(() => {
    if (pay && listing.payments.includes(pay)) return;
    setPay(listing.payments.includes('escrow') && (advise || listing.payments.length === 1) ? 'escrow' : listing.payments.find((p) => p !== 'escrow') || listing.payments[0]);
  }, [listing.coord]);
  useEffect(() => {
    fiatToSats(fiatTotal, listing.currency).then((sats) => { if (sats) { setPriceSats(sats); setPriceText(formatCoin(sats, { unit: false })); } });
  }, [listing.coord, ship]);
  useEffect(() => {
    reviewsAbout(account.get().pubkey).then((r) => setLimit(tradeLimitFor(r.verifiedTrades, s.tradeLimits))).catch(() => setLimit(tradeLimitFor(0, s.tradeLimits)));
  }, []);

  const escrow = pay === 'escrow';
  const sats = parseCoin(priceText);
  const bd = escrow && sats ? Math.round((sats * s.buyerDepositPct) / 100) : 0;
  const sdPct = listing.sellerDepositPct ?? s.sellerDepositPct;
  const sd = escrow && sats ? Math.round((sats * sdPct) / 100) : 0;
  const addrOk = isValidAddress(payout, s.network);
  const overLimit = escrow && limit != null && sats > limit;
  const service = isService(listing.category);
  const pickup = carrier(ship).pickup || service;
  const ready = sats > 0 && pay && (!escrow || (arbiter && addrOk && !overLimit)) && (!shipOptions.length || option);

  const submit = async () => {
    updateSettings({ ...(escrow ? { payoutAddress: payout.trim() } : {}), shipTo });
    const shipping = option ? { id: option.id, price: option.price, currency: option.currency } : null;
    const common = { listing, priceSats: sats, shipTo: pickup ? '' : shipTo, note, network: s.network, shipping };
    const id = escrow
      ? await createOffer({ ...common, buyerDepositSats: bd, sellerDepositSats: sd, arbiter: dir.arbiters.get(arbiter), payoutAddress: payout })
      : await createOffer({ ...common, payment: 'direct', method: pay });
    navigate(`/trade/${id}`);
  };

  return (
    <div class="card offer">
      <h3>{T('Buy', 'Kopen')}</h3>
      {shipOptions.length > 0 && (
        <Field label={T('Delivery', 'Bezorging')}>
          <div class="choices">
            {shipOptions.map((o) => (
              <label key={o.id} class={`choice ${ship === o.id ? 'on' : ''}`}>
                <input type="radio" name="ship" checked={ship === o.id} onChange={() => setShip(o.id)} />
                <span>{carrier(o.id).name}</span><b>{o.price ? formatFiat(o.price, o.currency) : T('free', 'gratis')}</b>
              </label>
            ))}
          </div>
        </Field>
      )}
      <Field label={T('Payment', 'Betaling')}>
        <div class="choices">
          {listing.payments.map((p) => (
            <label key={p} class={`choice ${pay === p ? 'on' : ''}`}>
              <input type="radio" name="pay" checked={pay === p} onChange={() => setPay(p)} />
              <span>{payLabel(p)}{p === 'escrow' && advise && <span class="badge ok">{T('recommended', 'aanbevolen')}</span>}</span>
            </label>
          ))}
        </div>
      </Field>
      {escrow
        ? <p class="hint">{T(`Your coins wait in a 2-of-3 escrow until you confirm receipt. Recommended above ${formatFiat(s.escrowAdviceAbove, listing.currency)}.`, `Je munten wachten in een 2-van-3-escrow tot je de ontvangst bevestigt. Aanbevolen boven ${formatFiat(s.escrowAdviceAbove, listing.currency)}.`)}</p>
        : <p class={`notice ${advise ? 'warn' : ''}`}>{T('You pay the seller directly. Fast and without deposits, but there is no arbiter: if the item does not arrive, you depend on the seller.', 'Je betaalt de verkoper direct. Snel en zonder borg, maar er is geen arbiter: komt het item niet aan, dan ben je afhankelijk van de verkoper.')}{advise && ' ' + T(`For more than ${formatFiat(s.escrowAdviceAbove, listing.currency)} we recommend escrow.`, `Boven ${formatFiat(s.escrowAdviceAbove, listing.currency)} raden we escrow aan.`)}</p>}
      <Field label={service ? T('Agreed price in XBT (total)', 'Afgesproken prijs in XBT (totaal)') : T('Price in XBT (incl. delivery)', 'Prijs in XBT (incl. bezorging)')}
        hint={priceSats ? T(`Suggested from the current rate: ${formatCoin(priceSats)}${rate ? ` (1 XBT ≈ ${rate.value.toFixed(2)} ${listing.currency}, ${rate.source})` : ''}. The seller must agree to this amount.`,
          `Voorstel op basis van de huidige koers: ${formatCoin(priceSats)}${rate ? ` (1 XBT ≈ ${rate.value.toFixed(2)} ${listing.currency}, ${rate.source})` : ''}. De verkoper moet met dit bedrag akkoord gaan.`)
          : T('No exchange rate available; enter the amount you agreed with the seller.', 'Geen koers beschikbaar; vul het bedrag in dat je met de verkoper hebt afgesproken.')}>
        <input inputmode="decimal" value={priceText} onInput={(e) => setPriceText(e.target.value)} placeholder="0.001" />
      </Field>
      {overLimit && <p class="notice warn">{T(`New accounts can trade up to ${formatCoin(limit)} per escrow trade. Complete a few smaller trades first.`, `Nieuwe accounts kunnen tot ${formatCoin(limit)} per escrow-trade handelen. Doe eerst een paar kleinere trades.`)}</p>}
      {escrow && <>
        <Field label={T('Arbiter', 'Arbiter')} hint={T('Only steps in if you and the seller disagree. Holds one of the three escrow keys.', 'Komt alleen in actie als jij en de verkoper het oneens zijn. Heeft één van de drie escrow-sleutels.')}>
          {arbiters.length ? (
            <select value={arbiter} onChange={(e) => setArbiter(e.target.value)}>
              {arbiters.map((a) => <option key={a.pubkey} value={a.pubkey}>{a.name || a.pubkey.slice(0, 12)}{a.languages ? ` (${a.languages})` : ''}</option>)}
            </select>
          ) : <p class="notice warn">{dir.loaded ? T('No approved arbiters yet. Ask the community admin, or add one you trust under Account → Trusted arbiters.', 'Nog geen goedgekeurde arbiters. Vraag de community-beheerder, of voeg er een toe die je vertrouwt onder Account → Vertrouwde arbiters.') : <Spinner />}</p>}
        </Field>
        <Field label={T('Your XBT address for refunds and your deposit', 'Jouw XBT-adres voor terugbetaling en je borg')} hint={payout && !addrOk ? T('Not a valid address for ' + s.network, 'Geen geldig adres voor ' + s.network) : T('Use a wallet that follows the BLAKE2b chain (e.g. the Sparrow BLAKE2b build).', 'Gebruik een wallet die de BLAKE2b-chain volgt (bijv. de Sparrow BLAKE2b-build).')}>
          <input value={payout} onInput={(e) => setPayout(e.target.value)} placeholder="bc1q…" class={payout && !addrOk ? 'invalid' : ''} />
        </Field>
      </>}
      {!pickup && (
        <Field label={T('Shipping address', 'Verzendadres')} hint={T('Encrypted; only the seller (and the arbiter, with escrow) can read it.', 'Versleuteld; alleen de verkoper (en bij escrow de arbiter) kan het lezen.')}>
          <textarea rows="3" value={shipTo} onInput={(e) => setShipTo(e.target.value)} placeholder={T('Name, street, postcode, city, country', 'Naam, straat, postcode, plaats, land')} />
        </Field>
      )}
      <Field label={T('Message to the seller (optional)', 'Bericht aan de verkoper (optioneel)')}>
        <textarea rows="2" value={note} onInput={(e) => setNote(e.target.value)} />
      </Field>
      {sats > 0 && (
        <div class="summary">
          {escrow ? <>
            <div><span>{T('You pay into escrow', 'Jij betaalt in escrow')}</span><b><Coin sats={sats + bd} /></b></div>
            <div class="muted small">{T(`= price + ${s.buyerDepositPct}% deposit, which you get back when the trade completes`, `= prijs + ${s.buyerDepositPct}% borg, die je terugkrijgt als de trade klaar is`)}</div>
            <div><span>{T('Seller deposits', 'Verkoper stort als borg')}</span><b><Coin sats={sd} /></b></div>
          </> : <div><span>{T('You pay the seller', 'Jij betaalt de verkoper')}</span><b><Coin sats={sats} /></b></div>}
          <div class="muted small">{T('Nothing is paid yet: the seller first accepts, then sends a payment request in the chat.', 'Er wordt nog niets betaald: de verkoper accepteert eerst en stuurt dan een betaalverzoek in de chat.')}</div>
        </div>
      )}
      <div class="row">
        <Action class="primary" onClick={submit} disabled={!ready}>{T('Send order', 'Bestelling versturen')}</Action>
        <button class="btn ghost" onClick={onClose}>{T('Cancel', 'Annuleren')}</button>
      </div>
    </div>
  );
}

export function ListingPage({ naddr }) {
  const { listings } = useStore(market);
  const acc = useStore(account);
  const ref = useMemo(() => { try { return decodeListingRef(naddr); } catch { return null; } }, [naddr]);
  const coord = ref && `${LISTING_KIND}:${ref.pubkey}:${ref.identifier}`;
  const listing = coord && listings.get(coord);
  const [img, setImg] = useState(0);
  const [offering, setOffering] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!ref || listing) return;
    query({ kinds: [LISTING_KIND], authors: [ref.pubkey], '#d': [ref.identifier] }).then((evs) => {
      const l = parseListing(latestBy(evs, (e) => e.pubkey)[0] || { tags: [] });
      if (l) upsertLocal(l); else setMissing(true);
    }).catch(() => setMissing(true));
  }, [coord]);

  if (!ref) return <Empty>{T('Invalid link', 'Ongeldige link')}</Empty>;
  if (!listing) return <Empty>{missing ? T('Listing not found', 'Advertentie niet gevonden') : <Spinner />}</Empty>;
  const mine = acc.pubkey === listing.pubkey;

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
        {optionsFor(listing).length > 0 && <div class="muted">{T('Delivery', 'Bezorging')}: {optionsFor(listing).map((o) => `${carrier(o.id).name} ${o.price ? formatFiat(o.price, o.currency) : T('free', 'gratis')}`).join(' · ')}{listing.shipsTo && ` · ${T('ships to', 'verzendt naar')} ${listing.shipsTo}`}</div>}
        <div class="muted small">{T('Payment', 'Betaling')}: {listing.payments.map(payLabel).join(' · ')}</div>
        <div class="tags">
          <span class="badge">{label(CATEGORY_LABELS, listing.category)}</span>
          {listing.condition && <span class="badge">{label(CONDITION_LABELS, listing.condition)}</span>}
          {listing.location && <span class="badge">📍 {listing.location}</span>}
          {listing.status !== 'active' && <span class="badge warn">{listing.status}</span>}
        </div>
        <div class="seller"><Name pk={listing.pubkey} /> <Reputation pk={listing.pubkey} /></div>
        <p class="description">{listing.content}</p>
        {listing.source && <p class="muted small">{T('Also listed at', 'Ook te koop op')} <a href={listing.source} target="_blank" rel="noopener noreferrer">{listing.importedFrom || new URL(listing.source).hostname}</a></p>}
        <p class="muted small">{T('Updated', 'Bijgewerkt')} {fmtDate(listing.createdAt)}</p>
        {mine ? <a class="btn" href={`#/sell/${encodeURIComponent(listing.d)}`}>{T('Edit listing', 'Advertentie bewerken')}</a>
          : listing.status !== 'active' ? null
          : !acc.pubkey ? <a class="btn primary" href="#/settings">{T('Log in to buy', 'Log in om te kopen')}</a>
          : offering ? <OfferForm listing={listing} onClose={() => setOffering(false)} />
          : <button class="btn primary wide" onClick={() => setOffering(true)}>{T('Buy', 'Kopen')}</button>}
      </div>
    </div>
  );
}
