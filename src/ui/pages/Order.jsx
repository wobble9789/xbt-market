// The order a buyer makes from inside the chat: payment method, offer,
// delivery and an optional message. With escrow it also names the arbiter (one
// the seller accepts), so the escrow exists as soon as the seller accepts. The
// refund address and the delivery address from the account are chosen here
// too, but only sent once the seller accepts (privacy), by themselves.
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account, shortNpub } from '../../lib/nostr/account.js';
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
import { directory, arbiterDetails } from '../../lib/nostr/directory.js';
import { markPayoutUsed } from '../../lib/payout.js';
import { isValidAddress } from '../../lib/btc/address.js';
import { depositSats } from '../../config.js';
import { depositPctOf } from '../../lib/nostr/listings.js';
import { usePayoutPick, PayoutInput } from '../payout.jsx';
import { T, countryName } from '../i18n.js';
import { Action, Field, Coin, Spinner, Name, useRate, addressComplete, formatAddress } from '../components.jsx';
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
  // Escrow: one of the seller's arbiters that this buyer trusts too (older
  // listings name none: then any arbiter both may trust).
  const dir = useStore(directory);
  const candidates = [...dir.arbiters.keys()].filter((pk) => pk !== me && pk !== listing.pubkey && (!listing.arbiters?.length || listing.arbiters.includes(pk)));
  const [arbiter, setArbiter] = useState('');
  useEffect(() => { if (!candidates.includes(arbiter)) setArbiter(candidates[0] || ''); }, [candidates.join()]);
  const [refund, setRefund] = useState('');
  const refundPick = usePayoutPick(escrow);
  const shipAddress = s.address;
  const addressOk = delivery !== 'ship' || addressComplete(shipAddress);
  // What the buyer offers for the item; shipping is the carrier's rate on top.
  const itemSats = parseCoin(priceText);
  const shipSats = delivery === 'ship' ? suggested?.ship || 0 : 0;
  const sats = itemSats ? itemSats + shipSats : itemSats;
  // Both sides deposit the same share.
  // Buyer and seller put in the same deposit: the share the seller set on the listing.
  const pct = depositPctOf(listing);
  const bd = escrow && sats ? depositSats(sats, pct) : 0;
  const sd = bd;
  const overLimit = escrow && limit != null && sats > limit;
  const noArbiter = escrow && dir.loaded && !candidates.length;
  const ready = sats > 0 && pay && !overLimit && !noArbiter && (!escrow || (arbiter && isValidAddress(refund, s.network))) && addressOk && (delivery !== 'ship' || (country && reaches && pick));

  const submit = async () => {
    if (country) updateSettings({ country: s.country || country });
    const shipping = delivery === 'ship' ? { carrier: pick.carrier, country, price: pick.price, currency: pick.currency, size: listing.packageSize || 'M', ...(pick.servicePoint ? { servicePoint: true } : {}), ...(pick.estimate ? { estimate: true } : {}), ...(suggested?.ship ? { sats: suggested.ship } : {}) }
      : delivery === 'pickup' ? { carrier: 'pickup' } : null;
    await createOffer({
      tradeId: state.tradeId, listing, priceSats: sats, note, network: s.network, shipping,
      ...(delivery === 'ship' ? { shipTo: shipAddress } : {}),
      ...(escrow ? { payment: 'escrow', buyerDepositSats: bd, sellerDepositSats: sd, arbiter: dir.arbiters.get(arbiter), refundAddress: refund } : { payment: 'direct', method: pay }),
    });
    if (escrow) markPayoutUsed(refundPick, refund);
    onClose?.();
  };

  return (
    <div class="card offer order-form">
      <h3>🛒 {T('Order', 'Pedido')}</h3>
      {!service && (
        <Field group label={T('Delivery', 'Entrega')}>
          <div class="choices">
            {shipOk && <label class={`choice ${delivery === 'ship' ? 'on' : ''}`}><input type="radio" name="delivery" checked={delivery === 'ship'} onChange={() => setDelivery('ship')} /><span>📦 {T('Ship it to me', 'Envíamelo')}</span></label>}
            {pickupOk && <label class={`choice ${delivery === 'pickup' ? 'on' : ''}`}><input type="radio" name="delivery" checked={delivery === 'pickup'} onChange={() => setDelivery('pickup')} /><span>🤝 {T('Pick up', 'Recoger')}{listing.city || listing.country ? ` (${[listing.city, countryName(listing.country)].filter(Boolean).join(', ')})` : ''}</span></label>}
          </div>
        </Field>
      )}
      {delivery === 'ship' && <>
        <Field label={T('Ship to (country)', 'Enviar a (país)')}>
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

      {delivery === 'ship' && (addressOk
        ? <div class="field"><span class="label">{T('Ship to', 'Enviar a')}</span><pre class="address small">{formatAddress(shipAddress)}</pre><span class="hint">{T('From your account. Sent to the seller only after they accept your order, encrypted.', 'De tu cuenta. Se envía al vendedor solo después de que acepte tu pedido, cifrada.')} <a href="#/settings?open=address">{T('Change', 'Cambiar')}</a></span></div>
        : <p class="notice warn">{T('To have it shipped, first add your shipping address to your account. Or choose pick-up.', 'Para que te lo envíen, añade primero tu dirección de envío a tu cuenta. O elige recogida.')} <a href="#/settings?open=address">{T('Add my address', 'Añadir mi dirección')} →</a></p>)}
      <Field label={T('Your offer for the item (XBT)', 'Tu oferta por el artículo (XBT)')} hint={suggested ? `${rate ? `1 XBT ≈ ${formatFiat(rate.value, listing.currency)}. ` : ''}${T('You may offer less; the seller decides.', 'Puedes ofrecer menos; decide el vendedor.')}` : T('No exchange rate available; enter the amount you agreed in the chat.', 'No hay tipo de cambio; introduce el importe acordado en el chat.')}>
        <input inputmode="decimal" value={priceText} onInput={(e) => { setPriceText(e.target.value); setEdited(true); }} placeholder="0.001" />
      </Field>
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

      {escrow && !noArbiter && (
        <Field group label={T('Arbiter', 'Árbitro')} hint={T('Decides only if something goes wrong. You and the seller both trust these arbiters.', 'Solo decide si algo sale mal. Tú y el vendedor confiáis en estos árbitros.')}>
          <div class="choices arbiter-choices">
            {candidates.map((pk) => {
              const a = dir.arbiters.get(pk);
              return (
                <label key={pk} class={`choice ${arbiter === pk ? 'on' : ''}`}>
                  <input type="radio" name="arbiter" checked={arbiter === pk} onChange={() => setArbiter(pk)} />
                  <span><b>⚖️ {a?.name || shortNpub(pk)}</b> <span class="badge ok">✓ {T('trusted by you and the seller', 'de confianza para ti y el vendedor')}</span><span class="muted small">{arbiterDetails(a)}</span></span>
                </label>
              );
            })}
          </div>
        </Field>
      )}
      {escrow && <PayoutInput pick={refundPick} value={refund} onChange={setRefund} network={s.network} label={T('Your XBT address for refunds and your deposit', 'Tu dirección XBT para reembolsos y tu depósito')} hint={T('Sent only after the seller accepts your order.', 'Se envía solo después de que el vendedor acepte tu pedido.')} />}
      {noArbiter && <p class="notice warn">{listing.arbiters?.some((pk) => pk !== me && pk !== listing.pubkey)
        ? T('You trust none of the arbiters this seller accepts, so escrow is not possible here. Choose another payment method, ask the seller in the chat, or add one of their arbiters under Account → Trusted arbiters.', 'No confías en ninguno de los árbitros que acepta este vendedor, así que aquí no es posible el escrow. Elige otro método de pago, pregunta al vendedor en el chat o añade uno de sus árbitros en Cuenta → Árbitros de confianza.')
        : T('Escrow needs an arbiter who is not you or the seller, and there is none yet. Choose another payment method, or add an arbiter you trust under Account.', 'El escrow necesita un árbitro que no seas tú ni el vendedor, y aún no hay ninguno. Elige otro método de pago o añade un árbitro de confianza en Cuenta.')}</p>}
      {overLimit && <p class="notice warn">{T(`New accounts can trade up to ${formatCoin(limit)} per escrow trade. Complete a few smaller trades first.`, `Las cuentas nuevas pueden operar hasta ${formatCoin(limit)} por compra con escrow. Haz antes algunas compras más pequeñas.`)}</p>}
      <Field label={T('Message to the seller (optional)', 'Mensaje para el vendedor (opcional)')}>
        <textarea rows="2" value={note} onInput={(e) => setNote(e.target.value)} />
      </Field>
      {sats > 0 && (
        <div class="summary">
          <div><span>{T('Your offer for the item', 'Tu oferta por el artículo')}</span><b><Coin sats={itemSats} /></b></div>
          {shipSats > 0 && <div><span>{T('Shipping', 'Envío')} ({carrier(pick?.carrier).name})</span><b><Coin sats={shipSats} /></b></div>}
          {escrow ? <>
            <div><span>{T(`Your deposit (${pct}%), paid back when the trade completes`, `Tu depósito (${pct}%), se te devuelve al terminar la compra`)}</span><b><Coin sats={bd} /></b></div>
            <div class="total"><span>{T('You pay into escrow', 'Pagas al escrow')}</span><b><Coin sats={sats + bd} /></b></div>
            <div class="muted small"><span>{T(`The seller puts in the same deposit (${pct}%)`, `El vendedor pone el mismo depósito (${pct}%)`)}</span><span><Coin sats={sd} /></span></div>
          </> : <div class="total"><span>{T('You pay the seller', 'Pagas al vendedor')}</span><b><Coin sats={sats} /></b></div>}
          <div class="muted small">{T('First send the order, without any payment. If the seller accepts, you get a payment request in this chat.', 'Primero envía el pedido, sin pagar nada. Si el vendedor acepta, recibes una solicitud de pago en este chat.')}</div>
        </div>
      )}
      <div class="row">
        <Action class="primary" onClick={submit} disabled={!ready}>{T('Send order', 'Enviar pedido')}</Action>
        {onClose && <button class="btn ghost" onClick={onClose}>{T('Cancel', 'Cancelar')}</button>}
      </div>
    </div>
  );
}
