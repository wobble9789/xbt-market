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
      if (!edited) setPriceText(formatCoin(item + ship, { unit: false }));
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
  const sats = parseCoin(priceText);
  const bd = escrow && sats ? Math.round((sats * s.buyerDepositPct) / 100) : 0;
  const sdPct = listing.sellerDepositPct ?? s.sellerDepositPct;
  const sd = escrow && sats ? Math.round((sats * sdPct) / 100) : 0;
  const overLimit = escrow && limit != null && sats > limit;
  const ready = sats > 0 && pay && !overLimit && (delivery !== 'ship' || (country && reaches && pick));

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

      <Field label={T('Your price in XBT', 'Tu precio en XBT')} hint={suggested ? T(`Asking price ${formatCoin(suggested.item)}${suggested.ship ? ` + shipping ${formatCoin(suggested.ship)}` : ''}${rate ? ` (1 XBT ≈ ${formatFiat(rate.value, listing.currency)})` : ''}. You may offer less; the seller decides.`, `Precio pedido ${formatCoin(suggested.item)}${suggested.ship ? ` + envío ${formatCoin(suggested.ship)}` : ''}${rate ? ` (1 XBT ≈ ${formatFiat(rate.value, listing.currency)})` : ''}. Puedes ofrecer menos; decide el vendedor.`) : T('No exchange rate available; enter the amount you agreed in the chat.', 'No hay tipo de cambio; introduce el importe acordado en el chat.')}>
        <input inputmode="decimal" value={priceText} onInput={(e) => { setPriceText(e.target.value); setEdited(true); }} placeholder="0.001" />
      </Field>
      {overLimit && <p class="notice warn">{T(`New accounts can trade up to ${formatCoin(limit)} per escrow trade. Complete a few smaller trades first.`, `Las cuentas nuevas pueden operar hasta ${formatCoin(limit)} por compra con escrow. Haz antes algunas compras más pequeñas.`)}</p>}
      <Field label={T('Message to the seller (optional)', 'Mensaje para el vendedor (opcional)')}>
        <textarea rows="2" value={note} onInput={(e) => setNote(e.target.value)} />
      </Field>
      {sats > 0 && (
        <div class="summary">
          {escrow ? <>
            <div><span>{T('You pay into escrow', 'Pagas al escrow')}</span><b><Coin sats={sats + bd} /></b></div>
            <div class="muted small">{T(`= price + ${s.buyerDepositPct}% deposit, which you get back when the trade completes`, `= precio + ${s.buyerDepositPct}% de depósito, que recuperas al terminar la compra`)}</div>
            <div><span>{T('Seller deposits', 'Depósito del vendedor')}</span><b><Coin sats={sd} /></b></div>
          </> : <div><span>{T('You pay the seller', 'Pagas al vendedor')}</span><b><Coin sats={sats} /></b></div>}
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
