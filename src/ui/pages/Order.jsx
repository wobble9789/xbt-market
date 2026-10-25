// The order a buyer makes from inside the chat: payment method, price,
// delivery country and carrier, and an optional message. Addresses and the
// arbiter are asked only after the seller accepts (DetailsForm).
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account } from '../../lib/nostr/account.js';
import { useProfile } from '../../lib/nostr/profiles.js';
import { reviewsAbout, tradeLimitFor } from '../../lib/nostr/reviews.js';
import { settings, updateSettings } from '../../lib/settings.js';
import { formatCoin, parseCoin, formatFiat } from '../../lib/btc/units.js';
import { fiatToSats } from '../../lib/price.js';
import { createOffer } from '../../lib/trade/actions.js';
import { offersPickup, shipCarriers, carrier } from '../../lib/shipping.js';
import { shippingQuotes } from '../../lib/shipping-api.js';
import { shipsToCountry } from '../../lib/countries.js';
import { isService } from '../../lib/categories.js';
import { directory } from '../../lib/nostr/directory.js';
import { T, countryName } from '../i18n.js';
import { Action, Field, Coin, Spinner, useRate } from '../components.jsx';
import { CountrySelect } from '../countries.jsx';
import { payLabel } from './Listing.jsx';

export function OrderForm({ state, listing, onClose }) {
  const s = settings.get();
  const me = useStore(account, (a) => a.pubkey);
  const profile = useProfile(me);
  const service = isService(listing.category);
  const pickupOk = !service && offersPickup(listing);
  const shipOk = !service && shipCarriers(listing).length > 0;
  const [delivery, setDelivery] = useState(service ? 'none' : shipOk ? 'ship' : pickupOk ? 'pickup' : 'none');
  const [country, setCountry] = useState(s.country || profile.xbt_market?.country || s.address?.country || '');
  const [quotes, setQuotes] = useState(null);
  const [quoteErr, setQuoteErr] = useState('');
  const [pick, setPick] = useState(null);
  const [pay, setPay] = useState(null);
  const [suggested, setSuggested] = useState(null);
  const [priceText, setPriceText] = useState('');
  const [edited, setEdited] = useState(false);
  const [note, setNote] = useState('');
  const [limit, setLimit] = useState(null);
  const rate = useRate(listing.currency);
  const displayRate = useRate(s.currency);

  const reaches = delivery !== 'ship' || shipsToCountry(listing.shipsTo, country, listing.country);
  useEffect(() => {
    setQuotes(null); setPick(null); setQuoteErr('');
    if (delivery !== 'ship' || !country || !reaches) return;
    shippingQuotes(listing, country).then((q) => { setQuotes(q); setPick(q[0] || null); }).catch((e) => { setQuoteErr(e.message); setQuotes([]); });
  }, [delivery, country, listing.coord]);

  const shipPrice = delivery === 'ship' ? pick?.price || 0 : 0;
  const shipCur = pick?.currency || 'EUR';
  // The item and shipping, each converted to XBT, add up to the suggested price.
  useEffect(() => {
    let live = true;
    Promise.all([fiatToSats(listing.price, listing.currency), shipPrice ? fiatToSats(shipPrice, shipCur) : 0]).then(([item, ship]) => {
      if (!live || item == null || ship == null) return;
      setSuggested({ item, ship, total: item + ship });
      if (!edited) setPriceText(formatCoin(item, { unit: false }));
    });
    return () => { live = false; };
  }, [listing.coord, shipPrice, shipCur, rate?.value]);

  const fiatTotal = listing.price + (shipCur === listing.currency ? shipPrice : 0);
  const advise = listing.currency === 'XBT' ? !displayRate || fiatTotal * displayRate.value > s.escrowAdviceAbove : fiatTotal > s.escrowAdviceAbove;
  useEffect(() => {
    if (pay) return;
    setPay(listing.payments.includes('escrow') && (advise || listing.payments.length === 1) ? 'escrow' : listing.payments.find((p) => p !== 'escrow') || listing.payments[0]);
  }, [listing.coord, advise]);
  useEffect(() => {
    reviewsAbout(me).then((r) => setLimit(tradeLimitFor(r.verifiedTrades, s.tradeLimits))).catch(() => setLimit(tradeLimitFor(0, s.tradeLimits)));
  }, []);

  const escrow = pay === 'escrow';
  // What the buyer offers for the item; shipping is the carrier's rate on top.
  const itemSats = parseCoin(priceText);
  const shipSats = delivery === 'ship' ? suggested?.ship || 0 : 0;
  const sats = itemSats ? itemSats + shipSats : itemSats;
  const bd = escrow && sats ? Math.round((sats * s.buyerDepositPct) / 100) : 0;
  const sdPct = listing.sellerDepositPct ?? s.sellerDepositPct;
  const sd = escrow && sats ? Math.round((sats * sdPct) / 100) : 0;
  const overLimit = escrow && limit != null && sats > limit;
  // Escrow needs an arbiter who is neither buyer nor seller.
  const dir = useStore(directory);
  const noArbiter = escrow && dir.loaded && ![...dir.arbiters.keys()].some((pk) => pk !== me && pk !== listing.pubkey);
  const ready = sats > 0 && pay && !overLimit && !noArbiter && (delivery !== 'ship' || (country && reaches && pick));

  const submit = async () => {
    if (country) updateSettings({ country: s.country || country });
    const shipping = delivery === 'ship' ? { carrier: pick.carrier, country, price: pick.price, currency: pick.currency, size: listing.packageSize || 'M', ...(pick.servicePoint ? { servicePoint: true } : {}), ...(pick.estimate ? { estimate: true } : {}), ...(suggested?.ship ? { sats: suggested.ship } : {}) }
      : delivery === 'pickup' ? { carrier: 'pickup' } : null;
    await createOffer({
      tradeId: state.tradeId, listing, priceSats: sats, note, network: s.network, shipping,
      ...(escrow ? { payment: 'escrow', buyerDepositSats: bd, sellerDepositSats: sd } : { payment: 'direct', method: pay }),
    });
    onClose?.();
  };

  return (
    <div class="card offer order-form">
      <h3>🛒 {T('Order', 'Pedido')}</h3>
      <Field group label={T('How do you want to pay?', '¿Cómo quieres pagar?')}>
        <div class="choices">
          {listing.payments.map((p) => (
            <label key={p} class={`choice ${pay === p ? 'on' : ''}`}>
              <input type="radio" name="pay" checked={pay === p} onChange={() => setPay(p)} />
              <span>{payLabel(p)}{p === 'escrow' && advise && <span class="badge ok">{T('recommended', 'recomendado')}</span>}</span>
            </label>
          ))}
        </div>
      </Field>
      {escrow
        ? <p class="hint">{T(`Your coins wait in a 2-of-3 escrow until you confirm receipt. Recommended above ${formatFiat(s.escrowAdviceAbove, listing.currency)}.`, `Tus monedas esperan en un escrow 2 de 3 hasta que confirmes la recepción. Recomendado por encima de ${formatFiat(s.escrowAdviceAbove, listing.currency)}.`)}</p>
        : <p class={`notice small ${advise ? 'warn' : ''}`}>{T('You pay the seller directly: fast and without deposits, but without an arbiter.', 'Pagas directamente al vendedor: rápido y sin depósitos, pero sin árbitro.')}{advise && ' ' + T(`For more than ${formatFiat(s.escrowAdviceAbove, listing.currency)} we recommend escrow.`, `Para más de ${formatFiat(s.escrowAdviceAbove, listing.currency)} recomendamos escrow.`)}</p>}

      {!service && (
        <Field group label={T('Delivery', 'Entrega')}>
          <div class="choices">
            {shipOk && <label class={`choice ${delivery === 'ship' ? 'on' : ''}`}><input type="radio" name="delivery" checked={delivery === 'ship'} onChange={() => setDelivery('ship')} /><span>📦 {T('Ship it to me', 'Envíamelo')}</span></label>}
            {pickupOk && <label class={`choice ${delivery === 'pickup' ? 'on' : ''}`}><input type="radio" name="delivery" checked={delivery === 'pickup'} onChange={() => setDelivery('pickup')} /><span>🤝 {T('Pick up', 'Recoger')}{listing.city || listing.country ? ` (${[listing.city, countryName(listing.country)].filter(Boolean).join(', ')})` : ''}</span></label>}
          </div>
        </Field>
      )}
      {delivery === 'ship' && <>
        <Field label={T('Ship to (country)', 'Enviar a (país)')} hint={T('Your address is asked only after the seller accepts.', 'Tu dirección se pide solo cuando el vendedor acepte.')}>
          <CountrySelect value={country} onChange={setCountry} required />
        </Field>
        {country && !reaches && <p class="notice warn">{T(`The seller does not ship to ${countryName(country)}. Ask in the chat, or choose pick-up.`, `El vendedor no envía a ${countryName(country)}. Pregunta en el chat o elige recogida.`)}</p>}
        {country && reaches && (
          <Field label={T('Carrier', 'Transportista')} hint={quotes?.some((q) => q.estimate) ? T('Estimated price; the exact rate depends on the carrier.', 'Precio estimado; la tarifa exacta depende del transportista.') : T('You pay the shipping on top of the price.', 'Pagas el envío además del precio.')}>
            {!quotes ? <Spinner /> : quoteErr ? <p class="error small">{quoteErr}</p> : !quotes.length ? <p class="muted small">{T('None of the seller\'s carriers go there.', 'Ninguno de los transportistas del vendedor llega allí.')}</p> : (
              <div class="choices">
                {quotes.map((q) => (
                  <label key={q.carrier + (q.servicePoint ? 'p' : 'h')} class={`choice ${pick === q ? 'on' : ''}`}>
                    <input type="radio" name="carrier" checked={pick === q} onChange={() => setPick(q)} />
                    <span>{carrier(q.carrier).name}{q.servicePoint && <span class="muted small">{T('to a pick-up point', 'a un punto de recogida')}</span>}{q.labelless && <span class="badge">QR</span>}</span>
                    <b>{q.estimate ? '≈ ' : ''}{formatFiat(q.price, q.currency)}</b>
                  </label>
                ))}
              </div>
            )}
          </Field>
        )}
      </>}

      <Field label={T('Your offer for the item (XBT)', 'Tu oferta por el artículo (XBT)')} hint={suggested ? `${rate ? `1 XBT ≈ ${formatFiat(rate.value, listing.currency)}. ` : ''}${T('You may offer less; the seller decides.', 'Puedes ofrecer menos; decide el vendedor.')}` : T('No exchange rate available; enter the amount you agreed in the chat.', 'No hay tipo de cambio; introduce el importe acordado en el chat.')}>
        <input inputmode="decimal" value={priceText} onInput={(e) => { setPriceText(e.target.value); setEdited(true); }} placeholder="0.001" />
      </Field>
      {noArbiter && <p class="notice warn">{T('Escrow needs an arbiter who is not you or the seller, and there is none yet. Choose another payment method, or add an arbiter you trust under Account.', 'El escrow necesita un árbitro que no seas tú ni el vendedor, y aún no hay ninguno. Elige otro método de pago o añade un árbitro de confianza en Cuenta.')}</p>}
      {overLimit && <p class="notice warn">{T(`New accounts can trade up to ${formatCoin(limit)} per escrow trade. Complete a few smaller trades first.`, `Las cuentas nuevas pueden operar hasta ${formatCoin(limit)} por compra con escrow. Haz antes algunas compras más pequeñas.`)}</p>}
      <Field label={T('Message to the seller (optional)', 'Mensaje para el vendedor (opcional)')}>
        <textarea rows="2" value={note} onInput={(e) => setNote(e.target.value)} />
      </Field>
      {sats > 0 && (
        <div class="summary">
          <div><span>{T('Your offer for the item', 'Tu oferta por el artículo')}</span><b><Coin sats={itemSats} /></b></div>
          {shipSats > 0 && <div><span>{T('Shipping', 'Envío')} ({carrier(pick?.carrier).name})</span><b><Coin sats={shipSats} /></b></div>}
          {escrow ? <>
            <div><span>{T(`Your deposit (${s.buyerDepositPct}%), back when the trade completes`, `Tu depósito (${s.buyerDepositPct}%), lo recuperas al terminar`)}</span><b><Coin sats={bd} /></b></div>
            <div class="total"><span>{T('You pay into escrow', 'Pagas al escrow')}</span><b><Coin sats={sats + bd} /></b></div>
            <div class="muted small"><span>{T(`The seller also puts in a deposit (${sdPct}%)`, `El vendedor también deposita (${sdPct}%)`)}</span><span><Coin sats={sd} /></span></div>
          </> : <div class="total"><span>{T('You pay the seller', 'Pagas al vendedor')}</span><b><Coin sats={sats} /></b></div>}
          <div class="muted small">{T('Nothing is paid yet: the seller accepts first, then you get a payment request in this chat.', 'Aún no se paga nada: primero acepta el vendedor y luego recibes una solicitud de pago en este chat.')}</div>
        </div>
      )}
      <div class="row">
        <Action class="primary" onClick={submit} disabled={!ready}>{T('Send order', 'Enviar pedido')}</Action>
        {onClose && <button class="btn ghost" onClick={onClose}>{T('Cancel', 'Cancelar')}</button>}
      </div>
    </div>
  );
}
