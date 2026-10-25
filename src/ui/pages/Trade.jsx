import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { inbox, rumorsFor } from '../../lib/nostr/inbox.js';
import { market } from '../../lib/market.js';
import { account } from '../../lib/nostr/account.js';
import { directory, refreshDirectory, arbiterFeePct, arbiterFeeLabel } from '../../lib/nostr/directory.js';
import { publishReview, reviewsAbout, tradeLimitFor } from '../../lib/nostr/reviews.js';
import { settings, updateSettings } from '../../lib/settings.js';
import { reduceTrade, expectedTotal, presetAllocations, deadlines, disputeClocks, paymentProof, methodOf, DAY, RESPOND_DAYS, CONFIRM_AFTER_DELIVERY_DAYS } from '../../lib/trade/protocol.js';
import {
  acceptOffer, rejectOffer, cancelTrade, markShipped, markDelivered, markReceived, openDispute, sendChat, sendFundedHint,
  loadFunding, proposePayout, signProposal, broadcastProposal, myEscrowKey, esploraFor,
  requestLightning, requestOnchain, payWithWallet, reportPaid, confirmPaid, checkOnchainPayment,
  sendDetails, requestChange, answerChange, sendLabel, openConversation,
} from '../../lib/trade/actions.js';
import { walletConnected, walletLud16, lookupInvoice, payInvoice } from '../../lib/ln/wallet.js';
import { secretNames } from '../../lib/secrets.js';
import { CARRIERS, carrier, trackingUrl } from '../../lib/shipping.js';
import { labelsEnabled, labelQuote, createLabel, labelStatus, servicePoints } from '../../lib/shipping-api.js';
import { API_URL } from '../../config.js';
import { isValidAddress } from '../../lib/btc/address.js';
import { formatCoin, parseCoin, formatFiat } from '../../lib/btc/units.js';
import { explorerFor } from '../../config.js';
import { loadJSON, saveJSON } from '../../lib/store.js';
import { navigate } from '../router.js';
import { T, fmtDate, timeAgo, countryName } from '../i18n.js';
import { Action, Field, Name, Coin, QR, Copy, Img, Empty, Spinner, AddressForm, addressComplete, formatAddress, toast } from '../components.jsx';
import { Reputation, payLabel, payShort, useListing } from './Listing.jsx';
import { OrderForm } from './Order.jsx';
import { useMyTrades } from './Trades.jsx';
import { publishListing } from './Sell.jsx';
import { usePayoutPick, PayoutInput } from '../payout.jsx';
import { markPayoutUsed } from '../../lib/payout.js';

const ROLE = { buyer: ['Buyer', 'Comprador'], seller: ['Seller', 'Vendedor'], arbiter: ['Arbiter', 'Árbitro'], other: ['Unknown', 'Desconocido'] };
// Below this an output would be dust (546 sats) once its share of the network fee is taken.
const MIN_FEE_OUTPUT = 1000;
const roleLabel = (r) => T(...(ROLE[r] || ROLE.other));

export const STATUS = {
  chat: ['Conversation', 'Conversación'], offered: ['Order sent', 'Pedido enviado'], accepted: ['Waiting for payment', 'Esperando el pago'], funded: ['Paid, waiting for shipment', 'Pagado, esperando el envío'],
  shipped: ['Shipped', 'Enviado'], disputed: ['In dispute', 'En disputa'], closed: ['Paid out', 'Pagado al vendedor'], rejected: ['Rejected', 'Rechazado'],
  cancelled: ['Cancelled', 'Cancelado'], paid: ['Paid, waiting for shipment', 'Pagado, esperando el envío'], completed: ['Completed', 'Completado'], cancelling: ['Cancelling, refund needed', 'Cancelando, hace falta un reembolso'], unknown: ['Unknown', 'Desconocido'],
};
export const statusLabel = (s) => T(...(STATUS[s] || STATUS.unknown));

// Services are carried out, not shipped.
const isServiceTrade = (state) => state.listing?.kind === 'service';
const shippedWord = (state) => (isServiceTrade(state) ? T('Done', 'Hecho') : T('Shipped', 'Enviado'));
const receivedQuestion = (state) => (isServiceTrade(state) ? T('Was the job done well?', '¿Se hizo bien el trabajo?') : T('Received the item?', '¿Has recibido el artículo?'));
const isPickup = (state) => state.offer?.shipping?.carrier === 'pickup' || state.offer?.shipping?.id === 'pickup';
const shipCarrierOf = (state) => state.offer?.shipping?.carrier || state.offer?.shipping?.id || '';
const needsAddress = (state) => !isServiceTrade(state) && !!state.offer?.shipping && !isPickup(state);

export function useTrade(tradeId) {
  const { rumors } = useStore(inbox);
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  const lightningNetwork = useStore(settings, (s) => s.lightningNetwork);
  return useMemo(() => reduceTrade(tradeId, rumorsFor(tradeId, rumors), { arbiters: dir.arbiters, me, lightningNetwork }), [tradeId, rumors, dir, me, lightningNetwork]);
}

function useFunding(state) {
  const [f, setF] = useState(null);
  const [err, setErr] = useState(null);
  const refresh = async () => {
    try { setF(await loadFunding(state)); setErr(null); } catch (e) { setErr(e.message); }
  };
  useEffect(() => {
    if (!state.escrow) return;
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [state.escrow?.address]);
  return { funding: f, error: err, refresh };
}

function Steps({ state, funded }) {
  const steps = state.payment === 'direct' ? [
    ['offer', T('Order', 'Pedido'), !!state.offer],
    ['accept', T('Accepted', 'Aceptado'), !!state.accept],
    ['paid', T('Paid', 'Pagado'), !!(state.paid || state.paymentConfirmed)],
    ['ship', shippedWord(state), !!state.shipped],
    ['done', T('Received', 'Recibido'), !!state.received],
  ] : [
    ['offer', T('Order', 'Pedido'), !!state.offer],
    ['accept', T('Accepted', 'Aceptado'), !!state.accept],
    ['fund', T('Paid into escrow', 'Pagado al escrow'), funded],
    ['ship', shippedWord(state), !!state.shipped],
    ['done', T('Paid out', 'Pagado'), state.status === 'closed'],
  ];
  return <ol class="steps">{steps.map(([k, l, done]) => <li key={k} class={done ? 'done' : ''}>{l}</li>)}</ol>;
}

function EscrowBox({ state, funding, fundErr, refresh, role, done }) {
  const o = state.offer;
  const tm = state.terms;
  const need = expectedTotal(state);
  const explorer = explorerFor(esploraFor(o.network).base);
  const [txid, setTxid] = useState('');
  const myPart = role === 'buyer' ? tm.priceSats + tm.buyerDepositSats : role === 'seller' ? tm.sellerDepositSats : 0;
  const minConf = settings.get().minConfirmations;
  return (
    <div class="card escrow">
      <h3>{T('Escrow', 'Escrow')}</h3>
      <div class={done ? '' : 'escrow-grid'}>
        {!done && <QR text={`bitcoin:${state.escrow.address}${myPart ? `?amount=${(myPart / 1e8).toFixed(8)}` : ''}`} size={170} />}
        <div>
          <div class="addr"><code>{state.escrow.address}</code> <Copy text={state.escrow.address} /></div>
          <table class="amounts">
            <tbody>
              <tr><td>{T('Buyer pays (price + deposit)', 'El comprador paga (precio + depósito)')}</td><td><Coin sats={tm.priceSats + tm.buyerDepositSats} /></td></tr>
              <tr><td>{T('Seller pays (deposit)', 'El vendedor paga (depósito)')}</td><td><Coin sats={tm.sellerDepositSats} /></td></tr>
              <tr class="total"><td>{T('Total needed', 'Total necesario')}</td><td><Coin sats={need} /></td></tr>
              <tr><td>{T('In escrow now', 'Ahora en el escrow')}</td><td>
                {funding ? <><Coin sats={funding.total} fiat={false} />{funding.total !== funding.confirmedTotal && <span class="muted small"> ({formatCoin(funding.confirmedTotal)} {T(`with ${minConf}+ confirmations`, `con ${minConf}+ confirmaciones`)})</span>}</>
                  : fundErr ? <span class="error small">{fundErr}</span> : <Spinner />}
              </td></tr>
            </tbody>
          </table>
          {myPart > 0 && !done && <p class="notice">{T(`Your part: send ${formatCoin(myPart)} to the address above from your own XBT wallet. Use coins received after the chain split, or a wallet that signs with the unified sighash, so the payment cannot be repeated on the other chain.`, `Tu parte: envía ${formatCoin(myPart)} a la dirección de arriba desde tu propia cartera XBT. Usa monedas recibidas después de la división de la cadena, o una cartera que firme con el sighash unificado, para que el pago no se pueda repetir en la otra cadena.`)}</p>}
          <div class="row">
            <button class="btn small" onClick={refresh}>{T('Refresh', 'Actualizar')}</button>
            <a class="btn small ghost" href={`${explorer}/address/${state.escrow.address}`} target="_blank" rel="noopener noreferrer">{T('View on explorer', 'Ver en el explorador')}</a>
          </div>
          {myPart > 0 && !done && (
            <div class="row">
              <input value={txid} onInput={(e) => setTxid(e.target.value.trim())} placeholder={T('Payment txid (optional)', 'Txid del pago (opcional)')} />
              <Action class="small" disabled={!/^[0-9a-f]{64}$/.test(txid)} onClick={async () => { await sendFundedHint(state, txid); setTxid(''); toast(T('Sent', 'Enviado'), 'ok'); }}>{T('I paid', 'He pagado')}</Action>
            </div>
          )}
        </div>
      </div>
      <details class="small">
        <summary>{T('Recovery details', 'Datos de recuperación')}</summary>
        <p>{T('2-of-3 P2WSH multisig. The three public keys (sorted), made for this trade only:', 'Multisig P2WSH 2 de 3. Las tres claves públicas (ordenadas), creadas solo para esta compra:')}</p>
        <ul>{state.escrow.pubkeys.map((k) => <li key={k}><code>{k}</code> {roleLabel(Object.entries(state.escrowKeys).find(([, v]) => v === k)?.[0]).toLowerCase()}</li>)}</ul>
        <p>{T('Witness script', 'Witness script')}: <code class="break">{state.escrow.witnessScript}</code></p>
        <ul class="hint">
          <li>{T('The escrow is a lock with three keys: buyer, seller and arbiter. Any two of them together can move the coins.', 'El escrow es un candado con tres llaves: comprador, vendedor y árbitro. Dos de ellas juntas pueden mover las monedas.')}</li>
          <li>{T('The public keys above belong to buyer, seller and arbiter. Each one is made from that person\'s nsec and this trade, so it differs per trade and your nsec backup is all you need.', 'Las claves públicas de arriba son del comprador, el vendedor y el árbitro. Cada una se crea a partir del nsec de esa persona y esta compra, así que cambia en cada compra y basta con tu copia del nsec.')}</li>
          <li>{T('The witness script is the exact lock. With it and two keys, the coins can be moved with another wallet too, should this app ever be gone.', 'El witness script es el candado exacto. Con él y dos llaves, las monedas también se pueden mover con otra cartera si esta app desapareciera.')}</li>
        </ul>
      </details>
    </div>
  );
}

function SplitEditor({ state, balance, purpose: initialPurpose, onDone, role }) {
  const [purpose, setPurpose] = useState(initialPurpose);
  const preset = useMemo(() => presetAllocations(state, purpose === 'ruling' ? 'release' : purpose, balance), [purpose, balance]);
  const [sellerText, setSellerText] = useState(formatCoin(preset.find((a) => a.role === 'seller')?.sats || 0, { unit: false }));
  const [note, setNote] = useState('');
  useEffect(() => { setSellerText(formatCoin(preset.find((a) => a.role === 'seller')?.sats || 0, { unit: false })); }, [preset]);
  // An arbiter's ruling includes the announced fee, to their payout address.
  const dir = useStore(directory);
  const feePick = usePayoutPick(role === 'arbiter');
  const feeAddress = role === 'arbiter' ? feePick?.address || '' : '';
  const feePct = role === 'arbiter' ? arbiterFeePct(dir.announcements.get(state.participants.arbiter)) : 0;
  // A fee too small for its own output would only be lost to the network fee.
  const feeSats = feePct && feeAddress ? Math.floor((balance * feePct) / 100) : 0;
  const fee = feeSats >= MIN_FEE_OUTPUT ? feeSats : 0;
  const rest = balance - fee;
  const sellerSats = parseCoin(sellerText);
  const valid = sellerSats != null && sellerSats <= rest;
  const allocations = valid ? [
    { role: 'seller', address: state.payout.seller, sats: sellerSats },
    { role: 'buyer', address: state.payout.buyer, sats: rest - sellerSats },
    { role: 'arbiter', address: feeAddress, sats: fee },
  ].filter((a) => a.sats > 0) : [];
  const purposes = role === 'arbiter' ? ['ruling'] : ['release', 'refund', 'custom'];
  // The arbiter's quick splits: the usual outcomes, and both deposits to the honest side.
  const setSeller = (sats) => setSellerText(formatCoin(Math.max(0, Math.min(rest, sats)), { unit: false }));
  const RULINGS = [
    ['seller-fault', T('Seller at fault: everything to the buyer', 'Culpa del vendedor: todo al comprador')],
    ['buyer-fault', T('Buyer at fault: everything to the seller', 'Culpa del comprador: todo al vendedor')],
    ['refund', T('Normal refund', 'Reembolso normal')],
    ['release', T('Normal release', 'Liberación normal')],
  ];
  return (
    <div class="card">
      <h3>{T('Propose a payout', 'Proponer un pago')}</h3>
      {role === 'arbiter' && (
        <>
          <div class="row wrap">{RULINGS.map(([k, l]) => <button key={k} type="button" class="btn small ghost" onClick={() => setSeller(presetAllocations(state, k, balance).find((a) => a.role === 'seller')?.sats || 0)}>{l}</button>)}</div>
          <p class="hint">{T('Whoever cheated loses their deposit to the other side. Normal refund and release give both deposits back.', 'Quien hizo trampa pierde su depósito en favor del otro. El reembolso y la liberación normales devuelven ambos depósitos.')}</p>
        </>
      )}
      {purposes.length > 1 && (
        <div class="row">
          {purposes.map((p) => <button key={p} class={`btn small ${purpose === p ? 'primary' : 'ghost'}`} onClick={() => setPurpose(p)}>{{ release: T('Release to seller', 'Liberar al vendedor'), refund: T('Refund buyer', 'Reembolsar al comprador'), custom: T('Custom split', 'Reparto personalizado') }[p]}</button>)}
        </div>
      )}
      <p class="muted small">{T('Escrow balance', 'Saldo del escrow')}: <Coin sats={balance} /></p>
      <Field label={T('Seller receives (XBT)', 'El vendedor recibe (XBT)')}>
        <input inputmode="decimal" value={sellerText} onInput={(e) => setSellerText(e.target.value)} class={valid ? '' : 'invalid'} />
      </Field>
      {valid && <p>{T('Buyer receives', 'El comprador recibe')}: <Coin sats={rest - sellerSats} /></p>}
      {fee > 0 && <p>{T(`Your fee (${feePct}%)`, `Tu comisión (${feePct}%)`)}: <Coin sats={fee} /></p>}
      {feeSats > 0 && !fee && <p class="hint">{T(`Your fee (${feePct}%, ${feeSats} sats) is too small to pay out on chain and is left out.`, `Tu comisión (${feePct}%, ${feeSats} sats) es demasiado pequeña para pagarla en cadena y se omite.`)}</p>}
      {feePct > 0 && !feeAddress && <p class="notice warn small">{T('No fee: add your wallet key (or a payout address) under Account → Trading first.', 'Sin comisión: primero añade la clave de tu cartera (o una dirección de cobro) en Cuenta → Compraventa.')}</p>}
      <p class="hint">{T('The network fee is shared in proportion to each amount.', 'La comisión de red se reparte en proporción a cada importe.')}</p>
      <Field label={T('Note', 'Nota')}><textarea rows="2" value={note} onInput={(e) => setNote(e.target.value)} /></Field>
      <div class="row">
        <Action class="primary" disabled={!valid} onClick={async () => { await proposePayout(state, { purpose, allocations, note }); if (fee) markPayoutUsed(feePick, feeAddress); toast(T('Proposal signed and sent', 'Propuesta firmada y enviada'), 'ok'); onDone(); }}>
          {T('Sign and propose', 'Firmar y proponer')}
        </Action>
        <button class="btn ghost" onClick={onDone}>{T('Cancel', 'Cancelar')}</button>
      </div>
    </div>
  );
}

function Proposal({ state, p, role, funding }) {
  const explorer = explorerFor(esploraFor(state.offer.network).base);
  const iSigned = p.signedBy.includes(role);
  const ready = p.signedBy.length >= 2;
  const broadcast = state.broadcasts.find((b) => b.proposalId === p.id);
  const live = funding && p.utxos.every((u) => funding.utxos.some((f) => f.txid === u.txid && f.vout === u.vout));
  const stale = funding && !live && !broadcast;
  const purpose = { release: T('Release to seller', 'Liberar al vendedor'), refund: T('Refund', 'Reembolso'), ruling: T('Arbiter ruling', 'Resolución del árbitro'), custom: T('Custom split', 'Reparto personalizado') }[p.purpose] || p.purpose;
  // In a ruling, one extra output is the arbiter's fee: fine up to the announced percentage.
  const dir = useStore(directory);
  const feePct = arbiterFeePct(dir.announcements.get(state.participants?.arbiter));
  const extra = p.outputs.filter((o) => o.role === 'other');
  const feeOut = p.purpose === 'ruling' && p.role === 'arbiter' && extra.length === 1 ? extra[0] : null;
  const feeOk = feeOut && feeOut.sats <= Math.floor((p.total * feePct) / 100) + 1;
  const unknownOut = extra.length > (feeOk ? 1 : 0);
  return (
    <div class={`card proposal ${stale ? 'stale' : ''}`}>
      <div class="page-head">
        <h4>{purpose} <span class="muted small">{T('by', 'por')} {roleLabel(p.role)} · {timeAgo(p.at)}</span></h4>
        <span class="badge">{p.signedBy.map(roleLabel).join(' + ')} {T('signed', 'firmado')}</span>
      </div>
      {p.note && <p class="quote">{p.note}</p>}
      <table class="amounts"><tbody>
        {p.outputs.map((o, i) => <tr key={i}><td>{o === feeOut && feeOk ? T(`Arbiter fee (${feePct}%)`, `Comisión del árbitro (${feePct}%)`) : roleLabel(o.role)} <code class="small">{o.address.slice(0, 14)}…</code></td><td><Coin sats={o.sats} /></td></tr>)}
        <tr class="muted"><td>{T('Network fee', 'Comisión de red')}</td><td>{formatCoin(p.fee)}</td></tr>
      </tbody></table>
      {unknownOut && <p class="notice warn">{T('Pays to an address that is not the buyer\'s or seller\'s payout address. Check carefully.', 'Paga a una dirección que no es la de cobro del comprador ni la del vendedor. Revísalo bien.')}</p>}
      {stale && <p class="muted small">{T('No longer valid: the escrow coins changed.', 'Ya no es válido: las monedas del escrow han cambiado.')}</p>}
      {broadcast ? (
        <p>✅ {T('Broadcast', 'Emitido')}: <a href={`${explorer}/tx/${broadcast.txid}`} target="_blank" rel="noopener noreferrer"><code>{broadcast.txid.slice(0, 16)}…</code></a></p>
      ) : !stale && role && (
        <div class="row">
          {!iSigned && <Action class="primary" confirm={T('Sign this payout? With your signature it can be broadcast.', '¿Firmar este pago? Con tu firma se puede emitir.')} onClick={async () => { const t = await signProposal(state, p); toast(t ? T('Signed and broadcast', 'Firmado y emitido') : T('Signed', 'Firmado'), 'ok'); }}>{T('Agree and sign', 'Aceptar y firmar')}</Action>}
          {ready && <Action onClick={async () => { await broadcastProposal(state, p); toast(T('Broadcast', 'Emitido'), 'ok'); }}>{T('Broadcast', 'Emitir')}</Action>}
        </div>
      )}
    </div>
  );
}

function ReviewBox({ state, role }) {
  const key = `xbt:reviewed:${state.tradeId}`;
  const [done, setDone] = useState(() => loadJSON(key, false));
  const [rating, setRating] = useState(5);
  const [text, setText] = useState('');
  if (done || role === 'arbiter') return null;
  const about = role === 'buyer' ? state.participants.seller : state.participants.buyer;
  const txid = paymentProof(state);
  return (
    <div class="card">
      <h3>{T('Leave a review', 'Deja una valoración')}</h3>
      <div class="row stars-input">{[1, 2, 3, 4, 5].map((n) => <button key={n} class={`star ${n <= rating ? 'on' : ''}`} onClick={() => setRating(n)}>★</button>)}</div>
      <textarea rows="2" value={text} onInput={(e) => setText(e.target.value)} placeholder={T('How did it go?', '¿Qué tal fue?')} />
      <Action class="primary" onClick={async () => { await publishReview({ about, tradeId: state.tradeId, txid, rating, text, role }); saveJSON(key, true); setDone(true); reviewsAbout(about, { fresh: true }); toast(T('Thanks!', '¡Gracias!'), 'ok'); }}>{T('Publish review', 'Publicar valoración')}</Action>
    </div>
  );
}

// Seller side of a direct trade: send the payment request into the chat.
function RequestForm({ state }) {
  const s = settings.get();
  useStore(secretNames);
  const o = state.offer;
  const [lnAddr, setLnAddr] = useState(s.lightningAddress || walletLud16());
  const [invoice, setInvoice] = useState('');
  const [address, setAddress] = useState('');
  const pick = usePayoutPick(state.method === 'onchain');
  const hasWallet = walletConnected();
  if (state.method === 'onchain') {
    const ok = isValidAddress(address, o.network);
    return (
      <div class="card">
        <h3>{T('Send a payment request', 'Envía una solicitud de pago')}</h3>
        <PayoutInput pick={pick} value={address} onChange={setAddress} network={o.network} label={T('Your XBT address', 'Tu dirección XBT')} />
        <Action class="primary" disabled={!ok} onClick={async () => { await requestOnchain(state, address); markPayoutUsed(pick, address); }}>{T('Request', 'Solicitar')} {formatCoin(state.terms.priceSats)}</Action>
      </div>
    );
  }
  return (
    <div class="card">
      <h3>{T('Send a payment request', 'Envía una solicitud de pago')}</h3>
      <p class="hint">{T(`An invoice for exactly ${formatCoin(state.terms.priceSats)} goes into the chat. The buyer pays it with one tap.`, `Una factura por exactamente ${formatCoin(state.terms.priceSats)} se envía al chat. El comprador la paga con un toque.`)}</p>
      {hasWallet && <Action class="primary" onClick={() => requestLightning(state, {})}>{T('Create invoice with my wallet', 'Crear factura con mi cartera')}</Action>}
      <Field label={T('…or your Lightning address', '…o tu dirección Lightning')}>
        <div class="row">
          <input value={lnAddr} onInput={(e) => setLnAddr(e.target.value)} placeholder="naam@wallet.com" />
          <Action disabled={!lnAddr.includes('@')} onClick={async () => { updateSettings({ lightningAddress: lnAddr.trim() }); await requestLightning(state, { lightningAddress: lnAddr }); }}>{T('Request', 'Solicitar')}</Action>
        </div>
      </Field>
      <Field label={T('…or paste an invoice', '…o pega una factura')}>
        <div class="row">
          <input value={invoice} onInput={(e) => setInvoice(e.target.value)} placeholder="ln…" />
          <Action disabled={!invoice.trim()} onClick={() => requestLightning(state, { invoice })}>{T('Send', 'Enviar')}</Action>
        </div>
      </Field>
      {!hasWallet && <p class="muted small">{T('Tip: connect your Lightning wallet under Account to create invoices and see payments automatically.', 'Consejo: conecta tu cartera Lightning en Cuenta para crear facturas y ver los pagos automáticamente.')}</p>}
    </div>
  );
}

// The current payment request, as both parties see it.
function PaymentBox({ state, role }) {
  useStore(secretNames);
  const req = state.request;
  const o = state.offer;
  const [proof, setProof] = useState('');
  const [check, setCheck] = useState(null);
  const paid = state.paid;
  const explorer = explorerFor(esploraFor(o.network).base);
  useEffect(() => {
    if (req?.method === 'onchain' && paid?.txid) checkOnchainPayment(state).then(setCheck).catch((e) => setCheck({ error: e.message }));
  }, [paid?.txid]);
  if (!req) return null;
  const expired = req.method === 'lightning' && req.expiresAt < Date.now() / 1000;
  const uri = req.method === 'lightning' ? `lightning:${req.invoice}` : `bitcoin:${req.address}?amount=${(req.amountSats / 1e8).toFixed(8)}`;
  return (
    <div class="card escrow">
      <h3>💳 {T('Payment request', 'Solicitud de pago')}: <Coin sats={state.terms.priceSats} /></h3>
      {paid?.verified ? <p class="notice ok">✅ {T('Paid. The Lightning preimage proves it.', 'Pagado. El preimage de Lightning lo demuestra.')}</p>
        : paid ? <p class="notice">{T('The buyer reports a payment', 'El comprador indica que ha pagado')}{paid.txid && <>: <a href={`${explorer}/tx/${paid.txid}`} target="_blank" rel="noopener noreferrer"><code>{paid.txid.slice(0, 16)}…</code></a></>}
            {check?.error && <> · <span class="error small">{T('Could not check this transaction', 'No se ha podido comprobar esta transacción')}: {check.error}</span></>}
            {check && !check.error && <> · {check.enough ? `✓ ${formatCoin(check.paid)}, ${check.confirmations} ${T('confirmations', 'confirmaciones')}` : `⚠ ${T('pays only', 'solo paga')} ${formatCoin(check.paid)}`}</>}</p>
        : null}
      {state.paymentConfirmed && <p class="notice ok">✅ {T('The seller confirmed receiving the payment.', 'El vendedor ha confirmado que ha recibido el pago.')}</p>}
      {!paid && !state.paymentConfirmed && (
        <div class="escrow-grid">
          <QR text={uri} size={170} />
          <div>
            <div class="addr"><code class="break small">{req.method === 'lightning' ? req.invoice : req.address}</code> <Copy text={req.method === 'lightning' ? req.invoice : req.address} /></div>
            {req.method === 'lightning' && <p class="muted small">{req.blake2b ? <span class="badge ok">⚡ XBT Lightning</span> : <span class="badge warn">⚠ {T('Bitcoin (BTC) Lightning, not XBT', 'Lightning de Bitcoin (BTC), no XBT')}</span>} · {expired ? <span class="error">{T('expired, ask for a new one', 'caducada, pide una nueva')}</span> : `${T('valid until', 'válida hasta')} ${fmtDate(req.expiresAt)}`}</p>}
            {role === 'buyer' && (
              <>
                <div class="row">
                  {req.method === 'lightning' && walletConnected() && !expired && <Action class="primary" confirm={T(`Pay ${formatCoin(state.terms.priceSats)} from your connected wallet?`, `¿Pagar ${formatCoin(state.terms.priceSats)} desde tu cartera conectada?`)} onClick={async () => { await payWithWallet(state); toast(T('Paid', 'Pagado'), 'ok'); }}>⚡ {T('Pay with my wallet', 'Pagar con mi cartera')}</Action>}
                  <a class="btn" href={uri}>{T('Open in wallet app', 'Abrir en la app de la cartera')}</a>
                </div>
                <div class="row">
                  <input value={proof} onInput={(e) => setProof(e.target.value.trim())} placeholder={req.method === 'lightning' ? T('Preimage (optional)', 'Preimage (opcional)') : T('Payment txid', 'Txid del pago')} />
                  <Action disabled={req.method === 'onchain' && !/^[0-9a-f]{64}$/i.test(proof)} onClick={() => reportPaid(state, req.method === 'lightning' ? { preimage: proof } : { txid: proof })}>{T('I paid', 'He pagado')}</Action>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {role === 'seller' && !state.paymentConfirmed && (
        <div class="row">
          {req.method === 'lightning' && walletConnected() && <Action onClick={async () => { const r = await lookupInvoice(req.paymentHash); if (r.settled_at || r.preimage) { await confirmPaid(state); toast(T('Payment received', 'Pago recibido'), 'ok'); } else toast(T('Not paid yet', 'Aún no pagado')); }}>{T('Check my wallet', 'Comprobar mi cartera')}</Action>}
          <Action confirm={T('Confirm the full amount is in your wallet?', '¿Confirmas que el importe completo está en tu cartera?')} onClick={() => confirmPaid(state)}>{T('I received the payment', 'He recibido el pago')}</Action>
        </div>
      )}
    </div>
  );
}

function DisputeBox({ state, role }) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  if (!open) return <button class="btn ghost danger" onClick={() => setOpen(true)}>{T('Open a dispute', 'Abrir una disputa')}</button>;
  return (
    <div class="card">
      <h3>{T('Open a dispute', 'Abrir una disputa')}</h3>
      <p class="hint">{T('The arbiter will read the chat and may ask for photos or videos. Try to solve it together first: you can always propose a split yourselves.', 'El árbitro leerá el chat y puede pedir fotos o vídeos. Intentad resolverlo juntos primero: siempre podéis proponer un reparto vosotros mismos.')}</p>
      <textarea rows="3" value={reason} onInput={(e) => setReason(e.target.value)} placeholder={T('What went wrong?', '¿Qué ha salido mal?')} />
      <div class="row">
        <Action class="danger" disabled={!reason.trim()} onClick={async () => { await openDispute(state, reason.trim()); setOpen(false); }}>{T('Open dispute', 'Abrir disputa')}</Action>
        <button class="btn ghost" onClick={() => setOpen(false)}>{T('Cancel', 'Cancelar')}</button>
      </div>
    </div>
  );
}

// Protocol steps shown as lines in the chat, Marktplaats-style.
function eventText(state, e) {
  const b = e.body || {};
  switch (e.type) {
    case 'open': return `💬 ${T('Conversation about', 'Conversación sobre')} “${state.listing?.title || ''}”`;
    case 'offer': return `🛒 ${T('Order', 'Pedido')}: ${formatCoin(b.priceSats)} · ${payShort(b.payment === 'direct' ? b.method : 'escrow')}${b.shipping?.carrier ? ` · ${carrier(b.shipping.carrier).name}` : ''}`;
    case 'accept': return `✅ ${T('Order accepted', 'Pedido aceptado')}`;
    case 'reject': return `✖ ${T('Order rejected', 'Pedido rechazado')}${b.reason ? ` · “${b.reason}”` : ''}`;
    case 'cancel': return `✖ ${T('Cancelled', 'Cancelado')}`;
    case 'details': return `📋 ${T('Details sent', 'Datos enviados')}${b.arbiter ? ` · ${T('arbiter chosen', 'árbitro elegido')}` : ''}`;
    case 'change': return `🔁 ${T('Asks to pay with', 'Pide pagar con')} ${payShort(b.method)}`;
    case 'change_ok': return `✅ ${T('Payment method changed', 'Método de pago cambiado')}`;
    case 'change_no': return `✖ ${T('Change of payment method declined', 'Cambio de método de pago rechazado')}`;
    case 'request': return `💳 ${T('Payment request', 'Solicitud de pago')}: ${formatCoin(state.terms?.priceSats)}`;
    case 'paid': return `💸 ${T('Buyer paid', 'El comprador ha pagado')}`;
    case 'confirm_paid': return `✅ ${T('Seller received the payment', 'El vendedor ha recibido el pago')}`;
    case 'funded': return `💸 ${T('Paid into escrow', 'Pagado al escrow')}`;
    case 'label': return `🏷 ${T('Shipping label ready', 'Etiqueta de envío lista')}: ${carrier(b.carrier).name}${b.tracking ? ` · ${b.tracking}` : ''}`;
    case 'shipped': return isServiceTrade(state) ? `✅ ${T('Job done', 'Trabajo hecho')}` : `📦 ${T('Shipped', 'Enviado')}`;
    case 'received': return `🎉 ${T('Received', 'Recibido')}`;
    case 'dispute': return `⚖️ ${T('Dispute opened', 'Disputa abierta')}`;
    case 'proposal': return `✍️ ${T('Payout proposed', 'Pago propuesto')}`;
    case 'broadcast': return `✅ ${T('Paid out', 'Pagado')}`;
    default: return null;
  }
}

function Chat({ state }) {
  const [text, setText] = useState('');
  const me = useStore(account, (a) => a.pubkey);
  const end = useRef();
  const items = useMemo(() => {
    const ev = state.log.filter((e) => !e.error && e.type !== 'chat' && e.type !== 'sign').map((e) => ({ ...e, system: eventText(state, e) })).filter((e) => e.system);
    return [...ev, ...state.chat].sort((a, b) => a.at - b.at);
  }, [state]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [items.length]);
  const who = state.participants.arbiter ? T('end-to-end encrypted, visible to buyer, seller and arbiter', 'cifrado de extremo a extremo, visible para comprador, vendedor y árbitro') : T('end-to-end encrypted, only you two can read it', 'cifrado de extremo a extremo, solo vosotros dos lo podéis leer');
  return (
    <div class="card chat">
      <h3>💬 {T('Messages', 'Mensajes')} <span class="muted small">{who}</span></h3>
      {state.open?.prev && <p class="small"><a href={`#/trade/${state.open.prev}`}>← {T('Earlier conversation', 'Conversación anterior')}</a></p>}
      <div class="messages">
        {items.map((m) => m.system ? (
          <div key={m.id} class="msg system"><span>{m.system}</span> <span class="muted small">· {m.from === me || m.role === state.role ? T('you', 'tú') : roleLabel(m.role)} · {timeAgo(m.at)}</span></div>
        ) : (
          <div key={m.id} class={`msg ${m.from === me ? 'mine' : ''} ${m.role}`}>
            <div class="who">{m.from === me ? T('You', 'Tú') : <><Name pk={m.from} avatar={false} /> · {roleLabel(m.role)}</>} · {timeAgo(m.at)}</div>
            <div class="text">{m.text}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form class="row" onSubmit={(e) => e.preventDefault()}>
        <input value={text} onInput={(e) => setText(e.target.value)} placeholder={T('Write a message…', 'Escribe un mensaje…')} />
        <Action class="primary" disabled={!text.trim()} onClick={async () => { await sendChat(state, text.trim()); setText(''); }}>{T('Send', 'Enviar')}</Action>
      </form>
    </div>
  );
}

function RoleBanner({ state }) {
  const p = state.participants;
  const role = state.role;
  if (role === 'buyer') return <div class="role-banner buyer">🛒 <span><b>{T('You are buying', 'Estás comprando')}</b> {T('from', 'a')} <Name pk={p.seller} /></span></div>;
  if (role === 'seller') return <div class="role-banner seller">🏷 <span><b>{T('You are selling', 'Estás vendiendo')}</b> {T('to', 'a')} <Name pk={p.buyer} /></span></div>;
  if (role === 'arbiter') return <div class="role-banner arbiter">⚖️ <span><b>{T('You are the arbiter', 'Eres el árbitro')}</b>: <Name pk={p.buyer} /> ({T('buyer', 'comprador')}) · <Name pk={p.seller} /> ({T('seller', 'vendedor')})</span></div>;
  return <div class="role-banner">{T('You are not part of this trade', 'No participas en esta compra')}</div>;
}

function ShippingLine({ state }) {
  const sh = state.offer?.shipping;
  if (!sh || isServiceTrade(state)) return null;
  if (isPickup(state)) return <div><span>{T('Delivery', 'Entrega')}</span><b>🤝 {T('pick-up', 'recogida')}</b></div>;
  return <div><span>{T('Shipping', 'Envío')}: {carrier(shipCarrierOf(state)).name} → {countryName(sh.country)}</span><b>{sh.estimate ? '≈ ' : ''}{sh.price != null ? formatFiat(sh.price, sh.currency || 'EUR') : ''}</b></div>;
}

// The order, as both sides see it, with the seller's accept / reject.
function OfferCard({ state, role }) {
  const s = settings.get();
  const dir = useStore(directory);
  const [payout, setPayout] = useState('');
  const pick = usePayoutPick(state.status === 'offered' && role === 'seller' && state.payment === 'escrow');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [limit, setLimit] = useState(null);
  const o = state.offer;
  const tm = state.terms;
  const escrow = state.payment === 'escrow';
  useEffect(() => { if (role === 'seller') reviewsAbout(state.participants.buyer).then((r) => setLimit(tradeLimitFor(r.verifiedTrades, s.tradeLimits))).catch(() => {}); }, []);
  // A version 1 offer names its arbiter up front.
  useEffect(() => { if (state.arbiter && !state.checks.arbiterTrusted) refreshDirectory(0).catch(() => {}); }, [state.arbiter?.pubkey]);
  const v1Arbiter = state.version === 1 && escrow ? state.arbiter : null;
  const { listings } = useStore(market);
  const listingNow = [...listings.values()].find((l) => l.coord === state.listing?.coord);
  // Other orders for the same listing this seller already accepted and that are still running.
  const busy = useMyTrades().filter((t) => t.id !== state.tradeId && t.state.role === 'seller' && t.state.listing?.coord && t.state.listing.coord === state.listing?.coord
    && t.state.accept && !['rejected', 'cancelled', 'closed', 'completed'].includes(t.state.status)).length;
  const ok = !escrow || isValidAddress(payout, o.network);
  const title = role === 'buyer' ? T('Your order', 'Tu pedido') : role === 'seller' ? <>{T('Order from', 'Pedido de')} <Name pk={state.participants.buyer} /> <span class="muted small">({T('the buyer', 'el comprador')})</span></> : T('Order', 'Pedido');
  return (
    <div class={`card offer-card ${state.status === 'offered' && role === 'seller' ? 'attention' : ''}`}>
      <h3>🛒 {title}</h3>
      {role === 'seller' && <p class="small"><Reputation pk={state.participants.buyer} /></p>}
      <div class="summary">
        <div><span>{T('Asking price', 'Precio pedido')}</span><b>{formatFiat(o.listing.price, o.listing.currency)}</b></div>
        <ShippingLine state={state} />
        <div><span>{T('Payment', 'Pago')}</span><b>{payShort(methodOf(state))}</b></div>
        {o.shipping?.sats > 0 && o.shipping.sats < tm.priceSats && <div><span>{role === 'seller' ? T('Offer for the item', 'Oferta por el artículo') : T('Your offer for the item', 'Tu oferta por el artículo')}</span><b><Coin sats={tm.priceSats - o.shipping.sats} /></b></div>}
        <div class="total"><span>{o.shipping?.sats > 0 ? T('Total with shipping', 'Total con envío') : role === 'seller' ? T('The buyer offers', 'El comprador ofrece') : T('You offer', 'Ofreces')}</span><b><Coin sats={tm.priceSats} /></b></div>
        {escrow && <div class="muted small"><span>{T('Deposits', 'Depósitos')}: {T('buyer', 'comprador')} {formatCoin(tm.buyerDepositSats)} · {T('seller', 'vendedor')} {formatCoin(tm.sellerDepositSats)}</span></div>}
      </div>
      {o.note && <p class="quote">{o.note}</p>}
      {v1Arbiter && <p>{T('Arbiter', 'Árbitro')}: <Name pk={v1Arbiter.pubkey} /> {state.checks.arbiterTrusted ? <span class="badge ok">✓ {T('approved', 'aprobado')}</span> : <span class="badge danger">{T('NOT an approved arbiter', 'NO es un árbitro aprobado')}</span>}</p>}
      {role === 'seller' && limit != null && escrow && tm.priceSats > limit && <p class="notice warn">{T(`This buyer has few verified trades; the community limit for them is ${formatCoin(limit)}.`, `Este comprador tiene pocas compras verificadas; el límite de la comunidad para él es ${formatCoin(limit)}.`)}</p>}
      {state.status === 'offered' && role === 'seller' && (
        <>
          {busy > 0 && <p class="notice warn">{T(`You already accepted ${busy === 1 ? 'another order' : `${busy} other orders`} for this listing. Only accept this one too if you have more than one: otherwise this buyer pays for nothing.`, `Ya aceptaste ${busy === 1 ? 'otro pedido' : `${busy} pedidos más`} de este anuncio. Acepta este también solo si tienes más de uno: si no, este comprador paga para nada.`)}</p>}
          {listingNow && listingNow.status !== 'active' && <p class="notice warn">{listingNow.status === 'reserved' ? T('You marked this item as reserved. Only accept if you have another one.', 'Marcaste este artículo como reservado. Acepta solo si tienes otro.') : T('This item is marked as sold. Only accept if you have another one.', 'Este artículo está marcado como vendido. Acepta solo si tienes otro.')}</p>}
          {escrow && (
            <PayoutInput pick={pick} value={payout} onChange={setPayout} network={o.network} label={T('Your XBT payout address', 'Tu dirección XBT de cobro')} hint={T('Where the escrow pays you. A wallet that follows the BLAKE2b chain.', 'Donde te paga el escrow. Una cartera que siga la cadena BLAKE2b.')} />
          )}
          {!escrow && <p class="hint">{T('No escrow: you ship once the payment has arrived in your wallet.', 'Sin escrow: envías cuando el pago esté en tu cartera.')}</p>}
          {rejecting ? (
            <div class="reject-box">
              <Field label={T('Why do you reject it? (optional)', '¿Por qué lo rechazas? (opcional)')}><input value={reason} onInput={(e) => setReason(e.target.value)} autofocus /></Field>
              <div class="row">
                <Action class="danger" onClick={() => rejectOffer(state, reason)}>{T('Reject order', 'Rechazar pedido')}</Action>
                <button class="btn ghost" onClick={() => setRejecting(false)}>{T('Back', 'Volver')}</button>
              </div>
            </div>
          ) : (
            <div class="row">
              <Action class="primary" disabled={!ok || (v1Arbiter && !state.checks.arbiterTrusted)} onClick={async () => { await acceptOffer(state, escrow ? payout : ''); if (escrow) markPayoutUsed(pick, payout); }}>✓ {T('Accept', 'Aceptar')}</Action>
              <button class="btn danger ghost" onClick={() => setRejecting(true)}>{T('Reject', 'Rechazar')}</button>
            </div>
          )}
        </>
      )}
      {state.status === 'offered' && role === 'buyer' && (
        <div class="row">
          <span class="muted small">{T('Waiting for the seller to accept. Nothing to pay yet.', 'Esperando a que el vendedor acepte. Aún no hay que pagar nada.')}</span>
          <Action class="ghost small" onClick={() => cancelTrade(state, '')}>{T('Withdraw order', 'Retirar pedido')}</Action>
        </div>
      )}
      {v1Arbiter && !state.checks.arbiterTrusted && role === 'seller' && <p class="notice danger">{T('Do not accept: the arbiter or its escrow key is not on your trusted list.', 'No aceptes: el árbitro o su clave de escrow no está en tu lista de confianza.')}</p>}
    </div>
  );
}

function ServicePointPicker({ state, value, onChange, postalCode }) {
  const [list, setList] = useState(null);
  const sh = state.offer.shipping;
  useEffect(() => {
    setList(null);
    if (!postalCode) return;
    const t = setTimeout(() => servicePoints(shipCarrierOf(state), sh.country, postalCode).then(setList).catch(() => setList([])), 400);
    return () => clearTimeout(t);
  }, [postalCode]);
  if (!postalCode) return <p class="hint">{T('Fill in your postcode to see pick-up points near you.', 'Introduce tu código postal para ver puntos de recogida cercanos.')}</p>;
  if (!list) return <Spinner />;
  if (!list.length) return <p class="hint error">{T('No pick-up points found near this postcode.', 'No hay puntos de recogida cerca de este código postal.')}</p>;
  return (
    <div class="choices">
      {list.map((p) => <label key={p.id} class={`choice ${String(value) === String(p.id) ? 'on' : ''}`}><input type="radio" name="point" checked={String(value) === String(p.id)} onChange={() => onChange(p.id)} /><span>{p.name}<span class="muted small">{p.street} {p.number}, {p.city}{p.distance ? ` · ${Math.round(p.distance)} m` : ''}</span></span></label>)}
    </div>
  );
}

// After the accept: what the other side needs now, and only that.
function DetailsForm({ state, role }) {
  const s = settings.get();
  const dir = useStore(directory);
  // Buyer and seller cannot be the arbiter of their own trade.
  const others = (a) => a.pubkey !== state.participants?.buyer && a.pubkey !== state.participants?.seller;
  const allArbiters = [...dir.arbiters.values()];
  const arbiters = allArbiters.filter(others);
  const escrow = state.payment === 'escrow';
  const sh = state.offer.shipping;
  const needShip = role === 'buyer' && needsAddress(state) && !state.shipTo;
  const needPoint = role === 'buyer' && sh?.servicePoint && labelsEnabled() && !state.servicePointId;
  const needArbiter = role === 'buyer' && escrow && !state.arbiter;
  const needPayout = escrow && (role === 'buyer' || role === 'seller') && !state.payout[role];
  const [address, setAddress] = useState(() => ({ ...(s.address || {}), country: sh?.country || s.address?.country || '' }));
  const [point, setPoint] = useState('');
  const [arbiter, setArbiter] = useState(arbiters[0]?.pubkey || '');
  const [payout, setPayout] = useState('');
  const pick = usePayoutPick(needPayout);
  useEffect(() => { refreshDirectory().catch(() => {}); }, []);
  useEffect(() => { if (!arbiter && arbiters[0]) setArbiter(arbiters[0].pubkey); }, [arbiters.length]);
  if (!state.accept || state.cancelled || state.rejected || !(needShip || needPoint || needArbiter || needPayout)) return null;
  const addrOk = !needShip || (addressComplete(address) && address.country === sh.country);
  const payoutOk = !needPayout || isValidAddress(payout, state.offer.network);
  const ready = addrOk && payoutOk && (!needArbiter || (dir.arbiters.has(arbiter) && arbiters.some((a) => a.pubkey === arbiter))) && (!needPoint || point);
  return (
    <div class="card form attention details-form">
      <h3>📋 {role === 'buyer' ? T('Accepted! A few details for the seller', '¡Aceptado! Unos datos para el vendedor') : T('Your payout address', 'Tu dirección de cobro')}</h3>
      {needShip && <>
        <h4>{T('Delivery address', 'Dirección de entrega')}</h4>
        <p class="hint">{T('Encrypted; only the seller (and with escrow the arbiter) can read it.', 'Cifrada; solo el vendedor (y con escrow el árbitro) la puede leer.')}</p>
        <AddressForm value={address} onChange={setAddress} />
        {address.country && address.country !== sh.country && <p class="hint error">{T(`The shipping price was for ${countryName(sh.country)}.`, `El precio de envío era para ${countryName(sh.country)}.`)}</p>}
      </>}
      {needPoint && <Field label={T('Pick-up point', 'Punto de recogida')}><ServicePointPicker state={state} value={point} onChange={setPoint} postalCode={address.postalCode} /></Field>}
      {needArbiter && (
        <Field label={T('Arbiter', 'Árbitro')} hint={T('Only steps in if you and the seller disagree. Holds one of the three escrow keys.', 'Solo interviene si el vendedor y tú no os ponéis de acuerdo. Tiene una de las tres claves del escrow.')}>
          {arbiters.length ? (
            <select value={arbiter} onChange={(e) => setArbiter(e.target.value)}>
              {arbiters.map((a) => <option key={a.pubkey} value={a.pubkey}>{a.name || a.pubkey.slice(0, 12)}{a.languages ? ` (${a.languages})` : ''} · {arbiterFeeLabel(a)}</option>)}
            </select>
          ) : <p class="notice warn">{dir.loaded && allArbiters.length ? T('You cannot be the arbiter of your own trade, and neither can the seller, and there is no other approved arbiter yet. Ask the seller to switch to Lightning, or add another arbiter you trust under Account.', 'No puedes ser el árbitro de tu propia compra, ni tampoco el vendedor, y aún no hay otro árbitro aprobado. Pide al vendedor cambiar a Lightning o añade otro árbitro de confianza en Cuenta.') : dir.loaded ? T('No approved arbiters yet. Ask the seller to switch to Lightning, or add an arbiter you trust under Account.', 'Aún no hay árbitros aprobados. Pide al vendedor cambiar a Lightning o añade un árbitro de confianza en Cuenta.') : <Spinner />}</p>}
        </Field>
      )}
      {needPayout && (
        <PayoutInput pick={pick} value={payout} onChange={setPayout} network={state.offer.network} label={role === 'buyer' ? T('Your XBT address for refunds and your deposit', 'Tu dirección XBT para reembolsos y tu depósito') : T('Your XBT payout address', 'Tu dirección XBT de cobro')} hint={T('An address from your own XBT wallet (BLAKE2b chain).', 'Una dirección de tu propia cartera XBT (cadena BLAKE2b).')} />
      )}
      <Action class="primary" disabled={!ready} onClick={async () => {
        if (needShip) updateSettings({ address });
        await sendDetails(state, { ...(needShip ? { shipTo: address } : {}), ...(needPoint ? { servicePointId: point } : {}), ...(needPayout ? { payoutAddress: payout } : {}), ...(needArbiter ? { arbiter: dir.arbiters.get(arbiter) } : {}) });
        if (needPayout) markPayoutUsed(pick, payout);
      }}>{T('Send details', 'Enviar datos')}</Action>
    </div>
  );
}

// Either side may ask to pay another way, until something is paid.
function ChangeBox({ state, role, funded }) {
  const s = settings.get();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState('');
  if (!state.offer || !['buyer', 'seller'].includes(role) || state.rejected || state.cancelled || state.paid || state.paymentConfirmed || state.escrow || funded) return null;
  const current = methodOf(state);
  const allowed = (state.offer.listing.payments?.length ? state.offer.listing.payments : ['lightning', 'onchain', 'escrow']).filter((m) => m !== current);
  const pending = state.changes.filter((c) => c.status === 'open');
  const theirs = pending.find((c) => c.role !== role);
  const mine = pending.find((c) => c.role === role);
  const canEscrow = !!state.escrowKeys?.buyer && (!state.accept || state.accept.seller?.escrowPubkey);
  const options = allowed.filter((m) => m !== 'escrow' || canEscrow);
  if (theirs) {
    return (
      <div class="card attention change-box">
        <h4>🔁 {role === 'buyer' ? T('The seller', 'El vendedor') : T('The buyer', 'El comprador')} {T('asks to pay with', 'pide pagar con')} <b>{payShort(theirs.method)}</b> {T('instead of', 'en vez de')} {payShort(current)}</h4>
        {theirs.method === 'escrow' && <p class="small">{T('Deposits', 'Depósitos')}: {T('buyer', 'comprador')} {formatCoin(theirs.buyerDepositSats)} · {T('seller', 'vendedor')} {formatCoin(theirs.sellerDepositSats)}</p>}
        {theirs.note && <p class="quote">{theirs.note}</p>}
        <div class="row">
          <Action class="primary" onClick={() => answerChange(state, theirs, true)}>✓ {T('Agree', 'Aceptar')}</Action>
          <Action class="ghost danger" onClick={() => answerChange(state, theirs, false)}>{T('Decline', 'Rechazar')}</Action>
        </div>
      </div>
    );
  }
  if (mine) return <p class="notice small">🔁 {T(`You asked to pay with ${payShort(mine.method)}. Waiting for an answer.`, `Pediste pagar con ${payShort(mine.method)}. Esperando respuesta.`)}</p>;
  if (!options.length) return null;
  if (!open) return <button class="btn ghost small" onClick={() => { setOpen(true); setMethod(options[0]); }}>🔁 {T('Change payment method', 'Cambiar método de pago')}</button>;
  const p = state.terms.priceSats;
  const sdPct = state.offer.listing.sellerDepositPct ?? s.sellerDepositPct;
  return (
    <div class="card change-box">
      <h4>🔁 {T('Ask to pay another way', 'Pedir pagar de otra forma')}</h4>
      <p class="small">{T('Now', 'Ahora')}: <b>{payShort(current)}</b>. {T('The other side has to agree.', 'La otra parte tiene que aceptar.')}</p>
      <div class="choices">{options.map((m) => <label key={m} class={`choice ${method === m ? 'on' : ''}`}><input type="radio" name="chg" checked={method === m} onChange={() => setMethod(m)} /><span>{payLabel(m)}</span></label>)}</div>
      <div class="row">
        <Action class="primary" disabled={!method} onClick={async () => { await requestChange(state, { method, buyerDepositSats: Math.round((p * s.buyerDepositPct) / 100), sellerDepositSats: Math.round((p * sdPct) / 100) }); setOpen(false); }}>{T('Ask', 'Pedir')}</Action>
        <button class="btn ghost" onClick={() => setOpen(false)}>{T('Cancel', 'Cancelar')}</button>
      </div>
    </div>
  );
}

function LabelCard({ label }) {
  const url = trackingUrl(label.carrier, label.tracking);
  return (
    <div class="card label-card">
      <h3>🏷 {T('Shipping label', 'Etiqueta de envío')} · {carrier(label.carrier).name}</h3>
      {label.qrUrl ? <>
        <img class="label-qr" src={label.qrUrl} alt="QR" />
        <p class="small">{T(`Show this QR code at a ${carrier(label.carrier).name} drop-off point: they print the label for you.`, `Enseña este código QR en un punto de ${carrier(label.carrier).name}: allí te imprimen la etiqueta.`)}</p>
      </> : null}
      <div class="row">
        {label.labelUrl && <a class="btn" href={label.labelUrl} target="_blank" rel="noopener">🖨 {T('Label (PDF)', 'Etiqueta (PDF)')}</a>}
        {label.tracking && <><code>{label.tracking}</code> <Copy text={label.tracking} /></>}
        {(label.trackingUrl || url) && <a class="btn small" href={label.trackingUrl || url} target="_blank" rel="noopener noreferrer">{T('Track', 'Seguir')}</a>}
      </div>
    </div>
  );
}

// Seller: buy a prepaid label, paid over Lightning, delivered as a QR code / PDF.
function LabelMaker({ state }) {
  useStore(secretNames);
  const s = useStore(settings);
  const key = `xbt:label:${state.tradeId}`;
  const [job, setJob] = useState(() => loadJSON(key, null)); // { id, invoice, sats, price, currency }
  const [quote, setQuote] = useState(null);
  const [addr, setAddr] = useState(s.address || {});
  const [err, setErr] = useState('');
  const sh = state.offer.shipping;
  const to = typeof state.shipTo === 'object' ? state.shipTo : null;
  const from = s.address;
  const size = sh.size || 'M';
  const save = (j) => { saveJSON(key, j); setJob(j); };
  const poll = async (j = job) => {
    const st = await labelStatus(j.id);
    if (st.status === 'created') {
      await sendLabel(state, { carrier: st.carrier, service: st.service, tracking: st.tracking, trackingUrl: st.trackingUrl, labelUrl: API_URL + st.documents.label, ...(st.documents.qr ? { qrUrl: API_URL + st.documents.qr } : {}) });
      save(null);
      toast(T('Label ready', 'Etiqueta lista'), 'ok');
    } else if (st.status === 'failed') {
      setErr(st.error || T('The carrier refused the label', 'El transportista rechazó la etiqueta'));
    }
    return st;
  };
  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => poll().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [job?.id]);
  if (!to) return <p class="notice small">{T('Waiting for the buyer\'s address.', 'Esperando la dirección del comprador.')}</p>;
  if (!addressComplete(from)) {
    return (
      <div class="card form">
        <h3>🏷 {T('Your address for the label', 'Tu dirección para la etiqueta')}</h3>
        <AddressForm value={addr} onChange={setAddr} />
        <button class="btn primary" disabled={!addressComplete(addr)} onClick={() => updateSettings({ address: addr })}>{T('Save', 'Guardar')}</button>
      </div>
    );
  }
  if (job) {
    return (
      <div class="card">
        <h3>🏷 {T('Shipping label', 'Etiqueta de envío')}: {formatFiat(job.price, job.currency)}</h3>
        {job.invoice ? <>
          <p class="small">{T('Pay the label over Lightning; it appears here right after.', 'Paga la etiqueta por Lightning; aparece aquí justo después.')}</p>
          <div class="escrow-grid"><QR text={`lightning:${job.invoice}`} size={170} /><div>
            <div class="addr"><code class="break small">{job.invoice}</code> <Copy text={job.invoice} /></div>
            <div class="row">
              {walletConnected() && <Action class="primary" confirm={T(`Pay ${formatCoin(job.sats)} for the label?`, `¿Pagar ${formatCoin(job.sats)} por la etiqueta?`)} onClick={async () => { await payInvoice(job.invoice); await poll(); }}>⚡ {T('Pay with my wallet', 'Pagar con mi cartera')}</Action>}
              <a class="btn" href={`lightning:${job.invoice}`}>{T('Open in wallet app', 'Abrir en la app de la cartera')}</a>
              <Action class="ghost" onClick={async () => { const st = await poll(); if (st.status === 'unpaid') toast(T('Not paid yet', 'Aún no pagada')); }}>{T('I paid', 'He pagado')}</Action>
            </div>
          </div></div>
        </> : <p><Spinner /> {T('Creating the label…', 'Creando la etiqueta…')}</p>}
        {err && <p class="notice danger small">{err}</p>}
        <button class="btn ghost small" onClick={() => { save(null); setErr(''); }}>{T('Start over', 'Empezar de nuevo')}</button>
      </div>
    );
  }
  return (
    <div class="card">
      <h3>🏷 {T('Prepaid shipping label', 'Etiqueta de envío prepagada')}</h3>
      <p class="small">{carrier(shipCarrierOf(state)).name} · {from.city} → {to.city}, {countryName(to.country)} · {T('size', 'tamaño')} {size}</p>
      {quote ? <p>{T('Price', 'Precio')}: <b>{formatFiat(quote.price, quote.currency)}</b> {T('(the buyer paid you the shipping)', '(el comprador te pagó el envío)')}</p> : null}
      {err && <p class="notice danger small">{err}</p>}
      <div class="row">
        {!quote ? <Action class="primary" onClick={async () => { setErr(''); const q = await labelQuote({ from, to, size, carrier: shipCarrierOf(state), servicePoint: !!sh.servicePoint }); if (!q) throw new Error(T('This carrier has no price for this route now', 'Este transportista no tiene precio para esta ruta ahora')); setQuote(q); }}>{T('Get the label price', 'Ver precio de la etiqueta')}</Action>
          : <Action class="primary" onClick={async () => { setErr(''); const res = await createLabel({ quoteId: quote.id, from, to, servicePointId: state.servicePointId || undefined, tradeId: state.tradeId }); const j = { id: res.id, invoice: res.invoice, sats: res.sats, price: res.price, currency: res.currency }; save(j); if (!res.invoice) await poll(j); }}>{T('Buy label', 'Comprar etiqueta')} {formatFiat(quote.price, quote.currency)}</Action>}
      </div>
    </div>
  );
}

function ShipForm({ state }) {
  const label = state.labels[state.labels.length - 1];
  const [carrierId, setCarrier] = useState(label?.carrier || shipCarrierOf(state) || '');
  const [tracking, setTracking] = useState(label?.tracking || '');
  const [note, setNote] = useState('');
  useEffect(() => { if (label) { setCarrier(label.carrier); setTracking(label.tracking); } }, [label?.id]);
  if (isServiceTrade(state)) {
    return (
      <div class="card">
        <h3>{T('Job done?', '¿Trabajo hecho?')}</h3>
        <p class="hint">{T('Let the buyer know when the work is finished. They then confirm and the payment is released.', 'Avisa al comprador cuando termines. Él lo confirma y se libera el pago.')}</p>
        <Field label={T('Note', 'Nota')}><input value={note} onInput={(e) => setNote(e.target.value)} /></Field>
        <Action class="primary" onClick={() => markShipped(state, { carrier: 'service', tracking: '', note })}>{T('Mark as done', 'Marcar como hecho')}</Action>
      </div>
    );
  }
  if (isPickup(state)) {
    return (
      <div class="card">
        <h3>🤝 {T('Pick-up', 'Recogida')}</h3>
        <p class="hint">{T('Agree a time in the chat. Mark it once the buyer has it.', 'Acordad una hora en el chat. Márcalo cuando el comprador lo tenga.')}</p>
        <Action class="primary" onClick={() => markShipped(state, { carrier: 'pickup', tracking: '', note })}>{T('Handed over', 'Entregado')}</Action>
      </div>
    );
  }
  const to = state.shipTo;
  return (
    <div class="card">
      <h3>📦 {T('Ship the item', 'Envía el artículo')}</h3>
      <p class="hint">{T('Tip: film yourself packing it with the label visible. It makes any dispute easy to settle.', 'Consejo: grábate empaquetándolo con la etiqueta visible. Así cualquier disputa se resuelve fácil.')}</p>
      {to ? <pre class="address">{formatAddress(to)}</pre> : <p class="notice small">{T('Waiting for the buyer\'s address.', 'Esperando la dirección del comprador.')}</p>}
      {state.servicePointId && <p class="small">{T('To pick-up point', 'Al punto de recogida')} #{state.servicePointId}</p>}
      {labelsEnabled() && !label && to && <LabelMaker state={state} />}
      {!labelsEnabled() && !label && carrier(carrierId).label && <p class="muted small">{T('Buy the label at', 'Compra la etiqueta en')} <a href={carrier(carrierId).label} target="_blank" rel="noopener noreferrer">{carrier(carrierId).name}</a></p>}
      <div class="cols">
        <Field label={T('Carrier', 'Transportista')}>
          <select value={carrierId} onChange={(e) => setCarrier(e.target.value)}>
            <option value="">…</option>
            {CARRIERS.filter((c) => !c.pickup).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label={T('Tracking code', 'Código de seguimiento')}><input value={tracking} onInput={(e) => setTracking(e.target.value)} /></Field>
      </div>
      <Field label={T('Note', 'Nota')}><input value={note} onInput={(e) => setNote(e.target.value)} /></Field>
      <Action class="primary" disabled={!carrierId} onClick={() => markShipped(state, { carrier: carrierId, tracking, note })}>{T('Mark as shipped', 'Marcar como enviado')}</Action>
    </div>
  );
}

function DirectFlow({ state, role }) {
  const paid = !!(state.paid || state.paymentConfirmed);
  if (!state.accept) return null;
  return (
    <>
      {!state.cancelled && !state.request && role === 'seller' && <RequestForm state={state} />}
      {!state.cancelled && !state.request && role === 'buyer' && <p class="notice">{T('Accepted. The seller sends a payment request in this chat.', 'Aceptado. El vendedor envía una solicitud de pago en este chat.')}</p>}
      {!state.cancelled && <PaymentBox state={state} role={role} />}
      {state.request && !paid && role === 'seller' && state.request.method === 'lightning' && state.request.expiresAt < Date.now() / 1000 && <RequestForm state={state} />}
      {paid && !state.shipped && role === 'seller' && <ShipForm state={state} />}
      {state.shipped && !state.received && role === 'buyer' && (
        <div class="card">
          <h3>{receivedQuestion(state)}</h3>
          <Action class="primary" onClick={() => markReceived(state, '')}>{isServiceTrade(state) ? T('Yes, done well', 'Sí, bien hecho') : T('Yes, received', 'Sí, recibido')}</Action>
        </div>
      )}
      {!paid && !state.cancelled && role && role !== 'arbiter' && (
        <Action class="ghost" confirm={T('Cancel this order?', '¿Cancelar este pedido?')} onClick={() => cancelTrade(state, '')}>{T('Cancel order (nothing paid yet)', 'Cancelar pedido (aún no se ha pagado)')}</Action>
      )}
    </>
  );
}

const inDays = (t, now) => {
  const d = Math.floor((t - now) / DAY);
  return d < 1 ? T('less than a day left', 'queda menos de un día') : d === 1 ? T('1 day left', 'queda 1 día') : T(`${d} days left`, `quedan ${d} días`);
};

// The block time at which the escrow held the full amount.
function fundedTime(funding, need) {
  if (!funding) return null;
  let sum = 0;
  for (const u of [...funding.confirmedUtxos].sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0))) {
    sum += u.value;
    if (sum >= need) return u.blockTime || null;
  }
  return null;
}

// What each side has to do by when (see deadlines() in the protocol), and
// what they may do once the other side is late.
function Deadlines({ state, role, dl, paid, balance, now }) {
  if (!role || role === 'arbiter' || state.cancelled || state.rejected || ['closed', 'completed'].includes(state.status)) return null;
  const direct = state.payment === 'direct';
  const disputed = state.disputes.length > 0;
  const date = (t) => fmtDate(t);
  if (paid && !state.shipped) {
    // Pick-up and services: the moment is agreed in the chat.
    if (!needsAddress(state)) return role === 'buyer' && !direct ? <p class="notice">{isServiceTrade(state) ? T('Fully paid. The seller can start the job.', 'Pagado del todo. El vendedor puede empezar el trabajo.') : T('Fully paid. Agree the hand-over in the chat.', 'Pagado del todo. Acordad la entrega en el chat.')}</p> : null;
    const late = now > dl.shipBy;
    if (role === 'seller') {
      return (
        <p class={`notice ${late ? 'danger' : now > dl.remindAt ? 'warn' : ''}`}>⏰ {late
          ? T(`The shipping deadline (${date(dl.shipBy)}) has passed. The buyer may now cancel and get a refund. Ship today, or explain in the chat.`, `El plazo de envío (${date(dl.shipBy)}) ha pasado. El comprador ya puede cancelar y recuperar su dinero. Envíalo hoy o explícalo en el chat.`)
          : now > dl.remindAt
            ? T(`Reminder: ship by ${date(dl.shipBy)} (${inDays(dl.shipBy, now)}). After that the buyer can cancel and get a refund.`, `Recordatorio: envíalo antes del ${date(dl.shipBy)} (${inDays(dl.shipBy, now)}). Después el comprador puede cancelar y recuperar su dinero.`)
            : T(`Paid. Ship by ${date(dl.shipBy)} (${inDays(dl.shipBy, now)}).`, `Pagado. Envíalo antes del ${date(dl.shipBy)} (${inDays(dl.shipBy, now)}).`)}
        </p>
      );
    }
    if (!late) return <p class="notice">⏰ {direct ? T('Paid.', 'Pagado.') : T('Fully paid.', 'Pagado del todo.')} {T(`The seller ships by ${date(dl.shipBy)} (${inDays(dl.shipBy, now)}).`, `El vendedor lo envía antes del ${date(dl.shipBy)} (${inDays(dl.shipBy, now)}).`)}</p>;
    if (disputed) return null;
    const reason = T(`The seller did not ship by ${date(dl.shipBy)}.`, `El vendedor no lo envió antes del ${date(dl.shipBy)}.`);
    return (
      <div class="card attention">
        <h3>⏰ {T('The seller did not ship in time', 'El vendedor no lo envió a tiempo')}</h3>
        {direct ? (
          <>
            <p>{T(`The deadline was ${date(dl.shipBy)}. You paid directly, without escrow, so the app cannot take the money back. Cancel the order, then ask the seller in the chat to pay you back. If they do not, report them.`, `El plazo era el ${date(dl.shipBy)}. Pagaste directamente, sin escrow, así que la app no puede devolver el dinero. Cancela el pedido y pide al vendedor en el chat que te lo devuelva. Si no lo hace, denúncialo.`)}</p>
            <Action class="danger" confirm={T('Cancel this order?', '¿Cancelar este pedido?')} onClick={() => cancelTrade(state, reason)}>{T('Cancel the order', 'Cancelar el pedido')}</Action>
          </>
        ) : (
          <>
            <p>{T(`The deadline was ${date(dl.shipBy)}. Ask for your money back: you sign a refund of the price and your deposit, and the seller or the arbiter co-signs it. The arbiter can also give you the seller's deposit.`, `El plazo era el ${date(dl.shipBy)}. Pide tu dinero: firmas un reembolso del precio y tu depósito, y el vendedor o el árbitro lo firma también. El árbitro también puede darte el depósito del vendedor.`)}</p>
            <Action class="danger" disabled={!balance} onClick={async () => {
              await openDispute(state, reason);
              await proposePayout(state, { purpose: 'refund', allocations: presetAllocations(state, 'refund', balance), note: reason });
              toast(T('Refund asked. The seller or the arbiter co-signs it.', 'Reembolso pedido. El vendedor o el árbitro lo firma.'), 'ok');
            }}>{T('Ask for a refund', 'Pedir el reembolso')}</Action>
          </>
        )}
      </div>
    );
  }
  if (!state.shipped || state.received) return null;
  const out = [];
  if (role === 'seller' && needsAddress(state) && !state.delivered && !disputed) {
    out.push(
      <div class="card" key="delivered">
        <p class="hint">{T(`Does the tracking show it was delivered? Let the buyer know: they then have ${CONFIRM_AFTER_DELIVERY_DAYS} days to confirm or complain.`, `¿El seguimiento dice que se ha entregado? Avisa al comprador: entonces tiene ${CONFIRM_AFTER_DELIVERY_DAYS} días para confirmar o reclamar.`)}</p>
        <Action class="small" onClick={() => markDelivered(state, '')}>📬 {T('Delivered, per the tracking', 'Entregado, según el seguimiento')}</Action>
      </div>,
    );
  }
  if (state.delivered && role === 'buyer') out.push(<p key="dlv" class="notice">📬 {T('The seller says the tracking shows it was delivered.', 'El vendedor dice que el seguimiento lo da por entregado.')}</p>);
  if (!direct && !disputed) {
    const over = now > dl.confirmBy;
    const buyerReleased = state.proposalOrder.some((id) => state.proposals[id].purpose === 'release' && state.proposals[id].signedBy.includes('buyer'));
    if (role === 'buyer') {
      out.push(<p key="cb" class={`notice ${over ? '' : 'warn'}`}>⏰ {over
        ? T(`The time to report a problem ended on ${date(dl.confirmBy)}. The seller can now ask the arbiter to pay out.`, `El plazo para reclamar terminó el ${date(dl.confirmBy)}. El vendedor ya puede pedir al árbitro que le pague.`)
        : T(`Check it and confirm below, or open a dispute, before ${date(dl.confirmBy)} (${inDays(dl.confirmBy, now)}). After that the seller can ask the arbiter to pay out.`, `Revísalo y confírmalo abajo, o abre una disputa, antes del ${date(dl.confirmBy)} (${inDays(dl.confirmBy, now)}). Después el vendedor puede pedir al árbitro que le pague.`)}</p>);
    } else if (!buyerReleased) {
      const reason = T(`The buyer did not confirm or complain by ${date(dl.confirmBy)}.`, `El comprador no confirmó ni reclamó antes del ${date(dl.confirmBy)}.`);
      out.push(over ? (
        <div class="card attention" key="cb">
          <h3>⏰ {T('The buyer did not confirm in time', 'El comprador no confirmó a tiempo')}</h3>
          <p>{T(`The deadline was ${date(dl.confirmBy)}. Ask the arbiter to pay you: you sign the normal release, and the arbiter co-signs it.`, `El plazo era el ${date(dl.confirmBy)}. Pide al árbitro que te pague: firmas la liberación normal y el árbitro la firma también.`)}</p>
          <Action class="primary" disabled={!balance} onClick={async () => {
            await openDispute(state, reason);
            await proposePayout(state, { purpose: 'release', allocations: presetAllocations(state, 'release', balance), note: reason });
            toast(T('Sent to the arbiter', 'Enviado al árbitro'), 'ok');
          }}>{T('Ask the arbiter to pay out', 'Pedir al árbitro que pague')}</Action>
        </div>
      ) : <p key="cb" class="notice">⏰ {T(`Waiting for the buyer to confirm, until ${date(dl.confirmBy)} (${inDays(dl.confirmBy, now)}). After that you can ask the arbiter to pay you.`, `Esperando a que el comprador confirme, hasta el ${date(dl.confirmBy)} (${inDays(dl.confirmBy, now)}). Después puedes pedir al árbitro que te pague.`)}</p>);
    }
  }
  return out.length ? <>{out}</> : null;
}

// A dispute, with how long the other side has to answer it.
function DisputeLine({ d, role, now }) {
  const by = roleLabel(d.by).toLowerCase();
  const other = roleLabel(d.other).toLowerCase();
  const until = fmtDate(d.respondBy);
  return (
    <div class="notice danger">
      ⚖️ {T('Dispute opened by the', 'Disputa abierta por el')} {by} ({timeAgo(d.at)}): {d.reason}
      {d.late && <div class="small">{T('Opened after the deadline to complain.', 'Abierta después del plazo para reclamar.')}</div>}
      {!d.answered && (
        <div class="small">{now < d.respondBy
          ? (role === d.other
            ? T(`Answer in the chat before ${until}, or the arbiter may decide without you.`, `Responde en el chat antes del ${until} o el árbitro puede decidir sin ti.`)
            : T(`The ${other} has until ${until} to answer.`, `El ${other} tiene hasta el ${until} para responder.`))
          : role === 'arbiter'
            ? T(`The ${other} did not answer within ${RESPOND_DAYS} days. You may rule for the ${by}.`, `El ${other} no respondió en ${RESPOND_DAYS} días. Puedes resolver a favor del ${by}.`)
            : T(`The ${other} did not answer within ${RESPOND_DAYS} days. The arbiter may now decide.`, `El ${other} no respondió en ${RESPOND_DAYS} días. El árbitro ya puede decidir.`)}
        </div>
      )}
    </div>
  );
}

// After a payment: a seller with only one may take the listing off the market.
function ReserveHint({ state }) {
  const { listings } = useStore(market);
  const me = useStore(account, (a) => a.pubkey);
  const l = [...listings.values()].find((x) => x.coord === state.listing?.coord && x.pubkey === me);
  if (!l || l.status !== 'active') return null;
  return (
    <div class="notice small">
      {T('Paid. Was this your only one? Mark the listing as reserved, so nobody else orders it.', 'Pagado. ¿Era el único? Marca el anuncio como reservado para que nadie más lo pida.')}{' '}
      <Action class="small" onClick={async () => { await publishListing({ ...l, status: 'reserved' }); toast(T('Marked as reserved', 'Marcado como reservado'), 'ok'); }}>{T('Mark as reserved', 'Marcar como reservado')}</Action>
    </div>
  );
}

function ConversationStart({ state, role, query }) {
  const { listing, missing } = useListing(state.listing?.coord);
  const [ordering, setOrdering] = useState(!!query?.order);
  if (role !== 'buyer') return <p class="notice small">{T('The buyer can order from this chat when ready. You then accept or reject.', 'El comprador puede pedir desde este chat cuando quiera. Tú aceptas o rechazas.')}</p>;
  if (!listing) return missing ? <p class="notice warn">{T('This listing is no longer available.', 'Este anuncio ya no está disponible.')}</p> : <Spinner />;
  if (listing.status !== 'active') return <p class="notice warn">{listing.status === 'reserved' ? T('Reserved: the seller is holding it for someone.', 'Reservado: el vendedor lo guarda para alguien.') : T('No longer for sale.', 'Ya no está en venta.')}</p>;
  return ordering ? <OrderForm state={state} listing={listing} onClose={() => setOrdering(false)} />
    : <button class="btn primary wide" onClick={() => setOrdering(true)}>🛒 {T('Order', 'Pedir')}</button>;
}

function NewOffer({ state }) {
  const { listing } = useListing(state.listing?.coord);
  if (!listing || listing.status !== 'active') return null;
  return <Action class="primary" onClick={async () => { const id = await openConversation({ listing, network: settings.get().network, prev: state.tradeId }); navigate(`/trade/${id}?order=1`); }}>🛒 {T('Make a new order', 'Hacer un nuevo pedido')}</Action>;
}

export function TradePage({ tradeId, query = {} }) {
  const state = useTrade(tradeId);
  const { syncing } = useStore(inbox);
  const role = state.role;
  const { funding, error: fundErr, refresh } = useFunding(state);
  const [proposing, setProposing] = useState(null);

  if (!state.participants) return <Empty>{syncing ? <><Spinner /> {T('Loading messages…', 'Cargando mensajes…')}</> : T('Trade not found', 'Compra no encontrada')}</Empty>;
  const L = state.listing;
  const o = state.offer;

  let keyError = null;
  try { if (role && state.escrow) myEscrowKey(state); } catch (e) { keyError = e.message; }
  const direct = state.payment === 'direct';
  const need = o ? expectedTotal(state) : 0;
  const fullyFunded = !!funding && funding.confirmedTotal >= need;
  const balance = funding?.confirmedTotal || 0;
  const paidOut = state.escrow && funding && funding.total === 0 && state.broadcasts.length > 0;
  const status = state.status === 'accepted' && fullyFunded ? 'funded' : state.status;
  const dl = o ? deadlines(state, { fundedAt: fundedTime(funding, need) }) : null;
  const now = Date.now() / 1000;
  const paid = direct ? !!(state.paid || state.paymentConfirmed) : fullyFunded;
  const openProposals = state.proposalOrder.map((id) => state.proposals[id]).reverse();
  const canPropose = !direct && role && state.escrow && balance > 0 && state.status !== 'closed';
  const label = state.labels[state.labels.length - 1];

  return (
    <div class="trade">
      <div class="card trade-head">
        <a href={L?.coord ? '#/' : undefined}><Img src={L?.image} class="thumb-sm" /></a>
        <div class="grow">
          <h2>{L?.title}</h2>
          <div class="muted small">{L && formatFiat(L.price, L.currency)} · {fmtDate(state.open?.at || state.offerAt)}</div>
        </div>
        <div class="right">
          <span class={`badge status ${status}`}>{status === 'shipped' && isServiceTrade(state) ? T('Job done', 'Trabajo hecho') : statusLabel(status)}</span>
          {o && <div><Coin sats={state.terms.priceSats} /></div>}
        </div>
      </div>
      <RoleBanner state={state} />
      {o && state.status !== 'rejected' && state.status !== 'cancelled' && <Steps state={state} funded={fullyFunded || state.status === 'closed'} />}
      {keyError && <p class="notice danger">{keyError}</p>}
      {state.errors.length > 0 && <details class="notice warn small"><summary>{T(`${state.errors.length} ignored messages`, `${state.errors.length} mensajes ignorados`)}</summary><ul>{state.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></details>}

      {state.status === 'chat' && <ConversationStart state={state} role={role} query={query} />}
      {o && <OfferCard state={state} role={role} />}
      {state.rejected && (
        <div class="notice rejected-box">
          <b>✖ {role === 'buyer' ? T('The seller rejected your order', 'El vendedor ha rechazado tu pedido') : T('You rejected this order', 'Rechazaste este pedido')}</b>
          {state.rejected.reason && <div class="small">{role === 'buyer' ? T('Message from the seller', 'Mensaje del vendedor') : T('Your reason', 'Tu motivo')}: <i>“{state.rejected.reason}”</i></div>}
          {role === 'buyer' && <div class="small">{T('Nothing was paid. You can make a new order below, or keep chatting.', 'No se ha pagado nada. Puedes hacer un pedido nuevo abajo o seguir chateando.')}</div>}
        </div>
      )}
      {state.cancelled && <p class="notice">{T('Cancelled by the', 'Cancelado por el')} {roleLabel(state.cancelled.by).toLowerCase()}. {state.cancelled.reason}</p>}
      {state.cancelled?.late && role === 'seller' && <p class="notice danger">{T('The buyer had already paid you. Pay them back, or agree something in the chat.', 'El comprador ya te había pagado. Devuélvele el dinero o acordad algo en el chat.')}</p>}
      {(state.rejected || (state.cancelled && !state.escrow)) && role === 'buyer' && <NewOffer state={state} />}
      {o && disputeClocks(state, { fundedAt: dl.paidAt }).map((d, i) => <DisputeLine key={i} d={d} role={role} now={now} />)}
      {o && <ChangeBox state={state} role={role} funded={fullyFunded} />}
      {o && <DetailsForm state={state} role={role} />}
      {state.arbiter && !state.checks.arbiterTrusted && role === 'seller' && !state.broadcasts.length && <p class="notice danger">{T('The buyer chose an arbiter who is not on your trusted list. Do not pay your deposit; cancel the trade or ask in the chat.', 'El comprador eligió un árbitro que no está en tu lista de confianza. No pagues tu depósito; cancela la compra o pregunta en el chat.')}</p>}
      {state.arbiter && <p class="small muted">{T('Arbiter', 'Árbitro')}: <Name pk={state.arbiter.pubkey} /> {state.checks.arbiterTrusted ? <span class="badge ok">✓ {T('approved', 'aprobado')}</span> : <span class="badge danger">{T('not approved', 'no aprobado')}</span>}</p>}
      {state.shipped && isServiceTrade(state) && <p class="notice ok">✅ {T('The seller marked the job as done.', 'El vendedor ha marcado el trabajo como hecho.')} {state.shipped.note}</p>}
      {state.shipped && !isServiceTrade(state) && <p class="notice ok">📦 {carrier(state.shipped.carrier).pickup ? T('Handed over', 'Entregado') : <>{T('Shipped with', 'Enviado con')} {carrier(state.shipped.carrier).name}</>}{state.shipped.tracking && <> · <b>{state.shipped.tracking}</b> <Copy text={state.shipped.tracking} />{trackingUrl(state.shipped.carrier, state.shipped.tracking) && <> <a class="btn small" href={trackingUrl(state.shipped.carrier, state.shipped.tracking)} target="_blank" rel="noopener noreferrer">{T('Track', 'Seguir')}</a></>}</>} {state.shipped.note && `· ${state.shipped.note}`}</p>}
      {label && role === 'seller' && !state.shipped && <LabelCard label={label} />}
      {state.received && <p class="notice ok">✓ {T('Buyer confirmed receipt', 'El comprador ha confirmado la recepción')}</p>}
      {paidOut && <p class="notice ok">✅ {T('The escrow has been paid out.', 'El escrow se ha pagado.')}</p>}
      {o && <Deadlines state={state} role={role} dl={dl} paid={paid} balance={balance} now={now} />}
      {o && role === 'seller' && paid && !state.cancelled && <ReserveHint state={state} />}

      {o && direct && <DirectFlow state={state} role={role} />}

      {state.escrow && state.status !== 'rejected' && <EscrowBox state={state} funding={funding} fundErr={fundErr} refresh={refresh} role={role} done={fullyFunded || state.status === 'closed' || !!state.cancelled} />}
      {!direct && o && state.accept && !state.escrow && !state.cancelled && role === 'seller' && <p class="notice small">{T('Waiting for the buyer to choose an arbiter; then the escrow address appears.', 'Esperando a que el comprador elija árbitro; luego aparece la dirección del escrow.')}</p>}

      {/* Funding stage */}
      {!direct && state.accept && state.status === 'accepted' && !fullyFunded && role && role !== 'arbiter' && (!funding || funding.total === 0) && (
        <Action class="ghost" confirm={T('Cancel this trade?', '¿Cancelar esta compra?')} onClick={() => cancelTrade(state, '')}>{T('Cancel trade (nothing paid yet)', 'Cancelar compra (aún no se ha pagado)')}</Action>
      )}
      {!direct && state.status === 'accepted' && fullyFunded && role === 'seller' && <ShipForm state={state} />}

      {/* Shipped stage */}
      {!direct && ['shipped', 'accepted', 'disputed'].includes(state.status) && role === 'buyer' && state.shipped && fullyFunded && !openProposals.some((p) => p.purpose === 'release' && p.signedBy.includes('buyer')) && (
        <div class="card">
          <h3>{receivedQuestion(state)}</h3>
          <p>{T('If it is as described, release the payment. You get your deposit back in the same transaction.', 'Si es como se describía, libera el pago. Recuperas tu depósito en la misma transacción.')}</p>
          <Action class="primary" confirm={T('Release the payment to the seller? This cannot be undone.', '¿Liberar el pago al vendedor? No se puede deshacer.')} onClick={async () => {
            await markReceived(state, '');
            await proposePayout(state, { purpose: 'release', allocations: presetAllocations(state, 'release', balance), note: '' });
            toast(T('Release signed. The seller will co-sign and broadcast.', 'Liberación firmada. El vendedor la firmará y la enviará.'), 'ok');
          }}>{T('Everything OK: release payment', 'Todo bien: liberar el pago')}</Action>
        </div>
      )}

      {/* Proposals */}
      {openProposals.length > 0 && <h3>{T('Payout proposals', 'Propuestas de pago')}</h3>}
      {openProposals.map((p) => <Proposal key={p.id} state={state} p={p} role={role} funding={funding} />)}

      {canPropose && (proposing
        ? <SplitEditor state={state} balance={balance} purpose={proposing} role={role} onDone={() => setProposing(null)} />
        : (
          <div class="row">
            {role === 'arbiter' && state.disputes.length > 0 && <button class="btn primary" onClick={() => setProposing('ruling')}>{T('Propose a ruling', 'Proponer una resolución')}</button>}
            {role !== 'arbiter' && <button class="btn ghost" onClick={() => setProposing(state.cancelled ? 'refund' : 'custom')}>{T('Propose a payout or refund', 'Proponer un pago o reembolso')}</button>}
            {role !== 'arbiter' && !state.disputes.some((d) => d.by === role) && state.status !== 'closed' && (now > dl.shipBy || state.shipped || fullyFunded) && !(role === 'buyer' && state.shipped && now > dl.confirmBy) && <DisputeBox state={state} role={role} />}
          </div>
        ))}

      {(state.status === 'closed' || state.status === 'completed') && <ReviewBox state={state} role={role} />}
      {role && <Chat state={state} />}
    </div>
  );
}
