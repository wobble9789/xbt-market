import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { inbox, rumorsFor } from '../../lib/nostr/inbox.js';
import { account } from '../../lib/nostr/account.js';
import { directory, refreshDirectory } from '../../lib/nostr/directory.js';
import { publishReview, reviewsAbout, tradeLimitFor } from '../../lib/nostr/reviews.js';
import { settings, updateSettings } from '../../lib/settings.js';
import { reduceTrade, expectedTotal, presetAllocations, deadlines } from '../../lib/trade/protocol.js';
import {
  acceptOffer, rejectOffer, cancelTrade, markShipped, markReceived, openDispute, sendChat, sendFundedHint,
  loadFunding, proposePayout, signProposal, broadcastProposal, myEscrowKey, esploraFor,
} from '../../lib/trade/actions.js';
import { isValidAddress } from '../../lib/btc/address.js';
import { formatCoin, parseCoin } from '../../lib/btc/units.js';
import { explorerFor } from '../../config.js';
import { loadJSON, saveJSON } from '../../lib/store.js';
import { T, fmtDate, timeAgo } from '../i18n.js';
import { Action, Field, Name, Coin, QR, Copy, Img, Empty, Spinner, toast } from '../components.jsx';
import { Reputation } from './Listing.jsx';

const ROLE = { buyer: ['Buyer', 'Koper'], seller: ['Seller', 'Verkoper'], arbiter: ['Arbiter', 'Arbiter'], other: ['Unknown', 'Onbekend'] };
const roleLabel = (r) => T(...(ROLE[r] || ROLE.other));

export const STATUS = {
  offered: ['Offer sent', 'Bod verstuurd'], accepted: ['Waiting for payment', 'Wacht op betaling'], funded: ['Paid, waiting for shipment', 'Betaald, wacht op verzending'],
  shipped: ['Shipped', 'Verzonden'], disputed: ['In dispute', 'In geschil'], closed: ['Paid out', 'Uitbetaald'], rejected: ['Rejected', 'Afgewezen'],
  cancelled: ['Cancelled', 'Geannuleerd'], cancelling: ['Cancelling, refund needed', 'Wordt geannuleerd, terugbetaling nodig'], unknown: ['Unknown', 'Onbekend'],
};
export const statusLabel = (s) => T(...(STATUS[s] || STATUS.unknown));

export function useTrade(tradeId) {
  const { rumors } = useStore(inbox);
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  return useMemo(() => reduceTrade(tradeId, rumorsFor(tradeId, rumors), { arbiters: dir.arbiters, me }), [tradeId, rumors, dir, me]);
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
  const steps = [
    ['offer', T('Offer', 'Bod'), true],
    ['accept', T('Accepted', 'Geaccepteerd'), !!state.accept],
    ['fund', T('Paid into escrow', 'Betaald in escrow'), funded],
    ['ship', T('Shipped', 'Verzonden'), !!state.shipped],
    ['done', T('Paid out', 'Uitbetaald'), state.status === 'closed'],
  ];
  return <ol class="steps">{steps.map(([k, l, done]) => <li key={k} class={done ? 'done' : ''}>{l}</li>)}</ol>;
}

function EscrowBox({ state, funding, fundErr, refresh, role, done }) {
  const o = state.offer;
  const need = expectedTotal(state);
  const explorer = explorerFor(esploraFor(o.network).base);
  const [txid, setTxid] = useState('');
  const myPart = role === 'buyer' ? o.priceSats + o.buyerDepositSats : role === 'seller' ? o.sellerDepositSats : 0;
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
              <tr><td>{T('Buyer pays (price + deposit)', 'Koper betaalt (prijs + borg)')}</td><td><Coin sats={o.priceSats + o.buyerDepositSats} /></td></tr>
              <tr><td>{T('Seller pays (deposit)', 'Verkoper betaalt (borg)')}</td><td><Coin sats={o.sellerDepositSats} /></td></tr>
              <tr class="total"><td>{T('Total needed', 'Totaal nodig')}</td><td><Coin sats={need} /></td></tr>
              <tr><td>{T('In escrow now', 'Nu in escrow')}</td><td>
                {funding ? <><Coin sats={funding.total} fiat={false} />{funding.total !== funding.confirmedTotal && <span class="muted small"> ({formatCoin(funding.confirmedTotal)} {T(`with ${minConf}+ confirmations`, `met ${minConf}+ bevestigingen`)})</span>}</>
                  : fundErr ? <span class="error small">{fundErr}</span> : <Spinner />}
              </td></tr>
            </tbody>
          </table>
          {myPart > 0 && !done && <p class="notice">{T(`Your part: send ${formatCoin(myPart)} to the address above from a BLAKE2b wallet that signs with the unified sighash (Knots, Sparrow BLAKE2b, Shrike), so the payment cannot be replayed on the other chain.`, `Jouw deel: stuur ${formatCoin(myPart)} naar het adres hierboven vanuit een BLAKE2b-wallet die met de unified sighash tekent (Knots, Sparrow BLAKE2b, Shrike), zodat de betaling niet op de andere chain kan worden herhaald.`)}</p>}
          <div class="row">
            <button class="btn small" onClick={refresh}>{T('Refresh', 'Vernieuwen')}</button>
            <a class="btn small ghost" href={`${explorer}/address/${state.escrow.address}`} target="_blank" rel="noopener noreferrer">{T('View on explorer', 'Bekijk in explorer')}</a>
          </div>
          {myPart > 0 && !done && (
            <div class="row">
              <input value={txid} onInput={(e) => setTxid(e.target.value.trim())} placeholder={T('Payment txid (optional)', 'Betalings-txid (optioneel)')} />
              <Action class="small" disabled={!/^[0-9a-f]{64}$/.test(txid)} onClick={async () => { await sendFundedHint(state, txid); setTxid(''); toast(T('Sent', 'Verstuurd'), 'ok'); }}>{T('I paid', 'Ik heb betaald')}</Action>
            </div>
          )}
        </div>
      </div>
      <details class="small">
        <summary>{T('Recovery details', 'Herstelgegevens')}</summary>
        <p>{T('2-of-3 P2WSH multisig. Keys (sorted):', '2-van-3 P2WSH-multisig. Sleutels (gesorteerd):')}</p>
        <ul>{state.escrow.pubkeys.map((k) => <li key={k}><code>{k}</code> {Object.entries(state.escrowKeys).find(([, v]) => v === k)?.[0]}</li>)}</ul>
        <p>{T('Witness script', 'Witness script')}: <code class="break">{state.escrow.witnessScript}</code></p>
        <p class="hint">{T('Your escrow key is derived from your Nostr key and this trade id. Any two of the three parties can always move the coins, with or without this app.', 'Jouw escrow-sleutel wordt afgeleid van je Nostr-sleutel en dit trade-id. Twee van de drie partijen kunnen de munten altijd verplaatsen, met of zonder deze app.')}</p>
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
  const sellerSats = parseCoin(sellerText);
  const valid = sellerSats != null && sellerSats <= balance;
  const allocations = valid ? [
    { role: 'seller', address: state.accept.seller.payoutAddress, sats: sellerSats },
    { role: 'buyer', address: state.offer.buyer.payoutAddress, sats: balance - sellerSats },
  ].filter((a) => a.sats > 0) : [];
  const purposes = role === 'arbiter' ? ['ruling'] : ['release', 'refund', 'custom'];
  return (
    <div class="card">
      <h3>{T('Propose a payout', 'Stel een uitbetaling voor')}</h3>
      {purposes.length > 1 && (
        <div class="row">
          {purposes.map((p) => <button key={p} class={`btn small ${purpose === p ? 'primary' : 'ghost'}`} onClick={() => setPurpose(p)}>{{ release: T('Release to seller', 'Vrijgeven aan verkoper'), refund: T('Refund buyer', 'Koper terugbetalen'), custom: T('Custom split', 'Eigen verdeling') }[p]}</button>)}
        </div>
      )}
      <p class="muted small">{T('Escrow balance', 'Saldo escrow')}: <Coin sats={balance} /></p>
      <Field label={T('Seller receives (XBT)', 'Verkoper ontvangt (XBT)')}>
        <input inputmode="decimal" value={sellerText} onInput={(e) => setSellerText(e.target.value)} class={valid ? '' : 'invalid'} />
      </Field>
      {valid && <p>{T('Buyer receives', 'Koper ontvangt')}: <Coin sats={balance - sellerSats} /></p>}
      <p class="hint">{T('The network fee is shared in proportion to each amount.', 'De netwerkkosten worden naar verhouding van elk bedrag gedeeld.')}</p>
      <Field label={T('Note', 'Toelichting')}><textarea rows="2" value={note} onInput={(e) => setNote(e.target.value)} /></Field>
      <div class="row">
        <Action class="primary" disabled={!valid} onClick={async () => { await proposePayout(state, { purpose, allocations, note }); toast(T('Proposal signed and sent', 'Voorstel getekend en verstuurd'), 'ok'); onDone(); }}>
          {T('Sign and propose', 'Tekenen en voorstellen')}
        </Action>
        <button class="btn ghost" onClick={onDone}>{T('Cancel', 'Annuleren')}</button>
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
  const purpose = { release: T('Release to seller', 'Vrijgeven aan verkoper'), refund: T('Refund', 'Terugbetaling'), ruling: T('Arbiter ruling', 'Uitspraak arbiter'), custom: T('Custom split', 'Eigen verdeling') }[p.purpose] || p.purpose;
  const unknownOut = p.outputs.some((o) => o.role === 'other');
  return (
    <div class={`card proposal ${stale ? 'stale' : ''}`}>
      <div class="page-head">
        <h4>{purpose} <span class="muted small">{T('by', 'door')} {roleLabel(p.role)} · {timeAgo(p.at)}</span></h4>
        <span class="badge">{p.signedBy.map(roleLabel).join(' + ')} {T('signed', 'getekend')}</span>
      </div>
      {p.note && <p class="quote">{p.note}</p>}
      <table class="amounts"><tbody>
        {p.outputs.map((o, i) => <tr key={i}><td>{roleLabel(o.role)} <code class="small">{o.address.slice(0, 14)}…</code></td><td><Coin sats={o.sats} /></td></tr>)}
        <tr class="muted"><td>{T('Network fee', 'Netwerkkosten')}</td><td>{formatCoin(p.fee)}</td></tr>
      </tbody></table>
      {unknownOut && <p class="notice warn">{T('Pays to an address that is not the buyer\'s or seller\'s payout address. Check carefully.', 'Betaalt naar een adres dat niet het uitbetaaladres van koper of verkoper is. Controleer goed.')}</p>}
      {stale && <p class="muted small">{T('No longer valid: the escrow coins changed.', 'Niet meer geldig: de munten in escrow zijn veranderd.')}</p>}
      {broadcast ? (
        <p>✅ {T('Broadcast', 'Verzonden')}: <a href={`${explorer}/tx/${broadcast.txid}`} target="_blank" rel="noopener noreferrer"><code>{broadcast.txid.slice(0, 16)}…</code></a></p>
      ) : !stale && role && (
        <div class="row">
          {!iSigned && <Action class="primary" confirm={T('Sign this payout? With your signature it can be broadcast.', 'Deze uitbetaling tekenen? Met jouw handtekening kan hij worden verzonden.')} onClick={async () => { const t = await signProposal(state, p); toast(t ? T('Signed and broadcast', 'Getekend en verzonden') : T('Signed', 'Getekend'), 'ok'); }}>{T('Agree and sign', 'Akkoord en tekenen')}</Action>}
          {ready && <Action onClick={async () => { await broadcastProposal(state, p); toast(T('Broadcast', 'Verzonden'), 'ok'); }}>{T('Broadcast', 'Verzenden')}</Action>}
        </div>
      )}
    </div>
  );
}

function Chat({ state }) {
  const [text, setText] = useState('');
  const me = useStore(account, (a) => a.pubkey);
  const end = useRef();
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [state.chat.length]);
  return (
    <div class="card chat">
      <h3>{T('Messages', 'Berichten')} <span class="muted small">{T('end-to-end encrypted, visible to buyer, seller and arbiter', 'end-to-end versleuteld, zichtbaar voor koper, verkoper en arbiter')}</span></h3>
      <div class="messages">
        {state.chat.map((m) => (
          <div key={m.id} class={`msg ${m.from === me ? 'mine' : ''} ${m.role}`}>
            <div class="who"><Name pk={m.from} avatar={false} /> · {roleLabel(m.role)} · {timeAgo(m.at)}</div>
            <div class="text">{m.text}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form class="row" onSubmit={(e) => e.preventDefault()}>
        <input value={text} onInput={(e) => setText(e.target.value)} placeholder={T('Write a message…', 'Schrijf een bericht…')} />
        <Action class="primary" disabled={!text.trim()} onClick={async () => { await sendChat(state, text.trim()); setText(''); }}>{T('Send', 'Stuur')}</Action>
      </form>
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
  const txid = state.broadcasts[state.broadcasts.length - 1]?.txid;
  return (
    <div class="card">
      <h3>{T('Leave a review', 'Laat een review achter')}</h3>
      <div class="row stars-input">{[1, 2, 3, 4, 5].map((n) => <button key={n} class={`star ${n <= rating ? 'on' : ''}`} onClick={() => setRating(n)}>★</button>)}</div>
      <textarea rows="2" value={text} onInput={(e) => setText(e.target.value)} placeholder={T('How did it go?', 'Hoe ging het?')} />
      <Action class="primary" onClick={async () => { await publishReview({ about, tradeId: state.tradeId, txid, rating, text, role }); saveJSON(key, true); setDone(true); reviewsAbout(about, { fresh: true }); toast(T('Thanks!', 'Bedankt!'), 'ok'); }}>{T('Publish review', 'Review publiceren')}</Action>
    </div>
  );
}

function OfferReview({ state }) {
  const s = settings.get();
  const dir = useStore(directory);
  const [payout, setPayout] = useState(s.payoutAddress || '');
  const [reason, setReason] = useState('');
  const [limit, setLimit] = useState(null);
  const o = state.offer;
  useEffect(() => { reviewsAbout(state.participants.buyer).then((r) => setLimit(tradeLimitFor(r.verifiedTrades, s.tradeLimits))).catch(() => {}); }, []);
  // The arbiter may have announced after we loaded the directory.
  useEffect(() => { if (!state.checks.arbiterTrusted) refreshDirectory(0).catch(() => {}); }, [o.arbiter.pubkey]);
  const ok = isValidAddress(payout, o.network);
  const arb = dir.arbiters.get(o.arbiter.pubkey);
  return (
    <div class="card">
      <h3>{T('New offer', 'Nieuw bod')}</h3>
      <p><Name pk={state.participants.buyer} /> <Reputation pk={state.participants.buyer} /></p>
      <p>{T('offers', 'biedt')} <b><Coin sats={o.priceSats} /></b> {T('for', 'voor')} <b>{o.listing.title}</b> <span class="muted">({T('listed at', 'vraagprijs')} {o.listing.price} {o.listing.currency}{o.listing.shippingCost ? ` + ${o.listing.shippingCost}` : ''})</span></p>
      <p>{T('Your deposit', 'Jouw borg')}: <Coin sats={o.sellerDepositSats} /> · {T('buyer deposit', 'borg koper')}: <Coin sats={o.buyerDepositSats} /></p>
      <p>{T('Arbiter', 'Arbiter')}: <Name pk={o.arbiter.pubkey} /> {state.checks.arbiterTrusted ? <span class="badge ok">✓ {T('approved', 'goedgekeurd')}</span> : <span class="badge danger">{T('NOT an approved arbiter', 'GEEN goedgekeurde arbiter')}</span>}</p>
      {!state.checks.arbiterTrusted && <p class="notice danger">{T('Do not accept: the arbiter or its escrow key is not on your trusted list. A buyer who controls the arbiter key controls the escrow.', 'Niet accepteren: de arbiter of zijn escrow-sleutel staat niet op je vertrouwde lijst. Een koper die de arbitersleutel beheert, beheert de escrow.')}</p>}
      {limit != null && o.priceSats > limit && <p class="notice warn">{T(`This buyer has few verified trades; the community limit for them is ${formatCoin(limit)}.`, `Deze koper heeft weinig geverifieerde trades; de community-limiet voor hen is ${formatCoin(limit)}.`)}</p>}
      {o.note && <p class="quote">{o.note}</p>}
      {o.shipTo && <div><b>{T('Ship to', 'Verzenden naar')}:</b><pre class="address">{o.shipTo}</pre></div>}
      <Field label={T('Your XBT payout address', 'Jouw XBT-uitbetaaladres')}>
        <input value={payout} onInput={(e) => setPayout(e.target.value)} class={payout && !ok ? 'invalid' : ''} placeholder="bc1q…" />
      </Field>
      <div class="row">
        <Action class="primary" disabled={!ok || !arb || !state.checks.arbiterTrusted} onClick={async () => { updateSettings({ payoutAddress: payout.trim() }); await acceptOffer(state, payout); }}>{T('Accept', 'Accepteren')}</Action>
        <input value={reason} onInput={(e) => setReason(e.target.value)} placeholder={T('Reason (optional)', 'Reden (optioneel)')} />
        <Action class="danger" onClick={() => rejectOffer(state, reason)}>{T('Reject', 'Afwijzen')}</Action>
      </div>
    </div>
  );
}

function ShipForm({ state }) {
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [note, setNote] = useState('');
  return (
    <div class="card">
      <h3>{T('Ship the item', 'Verstuur het item')}</h3>
      <p class="hint">{T('Tip: film yourself packing it with the label visible. It makes any dispute easy to settle.', 'Tip: film het inpakken met het label in beeld. Dat maakt een eventueel geschil makkelijk op te lossen.')}</p>
      <pre class="address">{state.offer.shipTo || T('(no address given, ask in the chat)', '(geen adres opgegeven, vraag het in de chat)')}</pre>
      <div class="cols">
        <Field label={T('Carrier', 'Vervoerder')}><input value={carrier} onInput={(e) => setCarrier(e.target.value)} placeholder="PostNL, DHL, InPost…" /></Field>
        <Field label={T('Tracking code', 'Track & trace-code')}><input value={tracking} onInput={(e) => setTracking(e.target.value)} /></Field>
      </div>
      <Field label={T('Note', 'Toelichting')}><input value={note} onInput={(e) => setNote(e.target.value)} /></Field>
      <Action class="primary" disabled={!carrier} onClick={() => markShipped(state, { carrier, tracking, note })}>{T('Mark as shipped', 'Markeer als verzonden')}</Action>
    </div>
  );
}

function DisputeBox({ state, role }) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  if (!open) return <button class="btn ghost danger" onClick={() => setOpen(true)}>{T('Open a dispute', 'Open een geschil')}</button>;
  return (
    <div class="card">
      <h3>{T('Open a dispute', 'Open een geschil')}</h3>
      <p class="hint">{T('The arbiter will read the chat and may ask for photos or videos. Try to solve it together first: you can always propose a split yourselves.', 'De arbiter leest de chat en kan om foto\'s of video\'s vragen. Probeer het eerst samen op te lossen: jullie kunnen altijd zelf een verdeling voorstellen.')}</p>
      <textarea rows="3" value={reason} onInput={(e) => setReason(e.target.value)} placeholder={T('What went wrong?', 'Wat ging er mis?')} />
      <div class="row">
        <Action class="danger" disabled={!reason.trim()} onClick={async () => { await openDispute(state, reason.trim()); setOpen(false); }}>{T('Open dispute', 'Geschil openen')}</Action>
        <button class="btn ghost" onClick={() => setOpen(false)}>{T('Cancel', 'Annuleren')}</button>
      </div>
    </div>
  );
}

export function TradePage({ tradeId }) {
  const state = useTrade(tradeId);
  const { syncing } = useStore(inbox);
  const role = state.role;
  const { funding, error: fundErr, refresh } = useFunding(state);
  const [proposing, setProposing] = useState(null);

  if (!state.offer) return <Empty>{syncing ? <><Spinner /> {T('Loading messages…', 'Berichten laden…')}</> : T('Trade not found', 'Trade niet gevonden')}</Empty>;

  let keyError = null;
  try { if (role) myEscrowKey(state); } catch (e) { keyError = e.message; }

  const o = state.offer;
  const need = expectedTotal(state);
  const fullyFunded = !!funding && funding.confirmedTotal >= need;
  const balance = funding?.confirmedTotal || 0;
  const paidOut = state.accept && funding && funding.total === 0 && state.broadcasts.length > 0;
  const status = state.status === 'accepted' && fullyFunded ? 'funded' : state.status;
  const dl = deadlines(state);
  const now = Date.now() / 1000;
  const openProposals = state.proposalOrder.map((id) => state.proposals[id]).reverse();
  const canPropose = role && state.accept && balance > 0 && state.status !== 'closed';
  const counterpart = role === 'buyer' ? state.participants.seller : state.participants.buyer;

  return (
    <div class="trade">
      <div class="card trade-head">
        <Img src={o.listing.image} class="thumb-sm" />
        <div class="grow">
          <h2>{o.listing.title}</h2>
          <div class="muted small">{T('Trade', 'Trade')} {tradeId.slice(0, 10)} · {fmtDate(state.offerAt)} · {o.network}</div>
          <div>{role ? <>{T('You are the', 'Jij bent de')} <b>{roleLabel(role).toLowerCase()}</b>{role !== 'arbiter' && <> · {T('with', 'met')} <Name pk={counterpart} /></>}</> : T('You are not part of this trade', 'Je bent geen partij in deze trade')}</div>
        </div>
        <div class="right">
          <span class={`badge status ${status}`}>{statusLabel(status)}</span>
          <div><Coin sats={o.priceSats} /></div>
        </div>
      </div>
      {state.status !== 'rejected' && state.status !== 'cancelled' && <Steps state={state} funded={fullyFunded || state.status === 'closed'} />}
      {keyError && <p class="notice danger">{keyError}</p>}
      {state.errors.length > 0 && <details class="notice warn small"><summary>{T(`${state.errors.length} ignored messages`, `${state.errors.length} genegeerde berichten`)}</summary><ul>{state.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></details>}

      {state.rejected && <p class="notice">{T('The seller rejected this offer.', 'De verkoper heeft dit bod afgewezen.')} {state.rejected.reason}</p>}
      {state.cancelled && <p class="notice">{T('Cancelled by', 'Geannuleerd door')} {roleLabel(state.cancelled.by).toLowerCase()}. {state.cancelled.reason}</p>}
      {state.disputes.map((d, i) => <p key={i} class="notice danger">⚖️ {T('Dispute opened by', 'Geschil geopend door')} {roleLabel(d.by).toLowerCase()} ({timeAgo(d.at)}): {d.reason}</p>)}
      {state.shipped && <p class="notice ok">📦 {T('Shipped with', 'Verzonden met')} {state.shipped.carrier}{state.shipped.tracking && <> · <b>{state.shipped.tracking}</b> <Copy text={state.shipped.tracking} /></>} {state.shipped.note && `· ${state.shipped.note}`}</p>}
      {state.received && <p class="notice ok">✓ {T('Buyer confirmed receipt', 'Koper heeft ontvangst bevestigd')}</p>}
      {paidOut && <p class="notice ok">✅ {T('The escrow has been paid out.', 'De escrow is uitbetaald.')}</p>}

      {/* Offer stage */}
      {state.status === 'offered' && role === 'seller' && <OfferReview state={state} />}
      {state.status === 'offered' && role === 'buyer' && (
        <div class="card">
          <p>{T('Waiting for the seller to accept your offer. Nothing to pay yet.', 'Wacht tot de verkoper je bod accepteert. Je hoeft nog niets te betalen.')}</p>
          <Action class="ghost" onClick={() => cancelTrade(state, '')}>{T('Withdraw offer', 'Bod intrekken')}</Action>
        </div>
      )}

      {state.escrow && state.status !== 'rejected' && <EscrowBox state={state} funding={funding} fundErr={fundErr} refresh={refresh} role={role} done={fullyFunded || state.status === 'closed' || !!state.cancelled} />}

      {/* Funding stage */}
      {state.status === 'accepted' && !fullyFunded && role !== 'arbiter' && funding?.total === 0 && (
        <Action class="ghost" confirm={T('Cancel this trade?', 'Deze trade annuleren?')} onClick={() => cancelTrade(state, '')}>{T('Cancel trade (nothing paid yet)', 'Trade annuleren (nog niets betaald)')}</Action>
      )}
      {state.status === 'accepted' && fullyFunded && role === 'seller' && <ShipForm state={state} />}
      {state.status === 'accepted' && fullyFunded && role === 'buyer' && (
        <p class="notice">{T(`Fully paid. The seller should ship by ${fmtDate(dl.shipBy)}.`, `Volledig betaald. De verkoper moet verzenden voor ${fmtDate(dl.shipBy)}.`)}</p>
      )}

      {/* Shipped stage */}
      {['shipped', 'accepted', 'disputed'].includes(state.status) && role === 'buyer' && state.shipped && fullyFunded && !openProposals.some((p) => p.purpose === 'release' && p.signedBy.includes('buyer')) && (
        <div class="card">
          <h3>{T('Received the item?', 'Item ontvangen?')}</h3>
          <p>{T('If it is as described, release the payment. You get your deposit back in the same transaction.', 'Als het klopt met de beschrijving, geef dan de betaling vrij. Je krijgt je borg in dezelfde transactie terug.')}</p>
          <Action class="primary" confirm={T('Release the payment to the seller? This cannot be undone.', 'Betaling vrijgeven aan de verkoper? Dit kan niet ongedaan worden.')} onClick={async () => {
            await markReceived(state, '');
            await proposePayout(state, { purpose: 'release', allocations: presetAllocations(state, 'release', balance), note: '' });
            toast(T('Release signed. The seller will co-sign and broadcast.', 'Vrijgave getekend. De verkoper tekent mee en verzendt.'), 'ok');
          }}>{T('Everything OK: release payment', 'Alles in orde: betaling vrijgeven')}</Action>
        </div>
      )}
      {state.status === 'shipped' && role === 'seller' && !openProposals.length && (
        <p class="notice">{T(`Waiting for the buyer to confirm receipt. If they do not respond by ${fmtDate(dl.confirmBy)}, open a dispute.`, `Wacht tot de koper de ontvangst bevestigt. Reageert die niet voor ${fmtDate(dl.confirmBy)}, open dan een geschil.`)}</p>
      )}

      {/* Proposals */}
      {openProposals.length > 0 && <h3>{T('Payout proposals', 'Uitbetalingsvoorstellen')}</h3>}
      {openProposals.map((p) => <Proposal key={p.id} state={state} p={p} role={role} funding={funding} />)}

      {canPropose && fullyFunded !== null && (proposing
        ? <SplitEditor state={state} balance={balance} purpose={proposing} role={role} onDone={() => setProposing(null)} />
        : (
          <div class="row">
            {role === 'arbiter' && state.disputes.length > 0 && <button class="btn primary" onClick={() => setProposing('ruling')}>{T('Propose a ruling', 'Doe een uitspraak')}</button>}
            {role !== 'arbiter' && <button class="btn ghost" onClick={() => setProposing(state.cancelled ? 'refund' : 'custom')}>{T('Propose a payout or refund', 'Stel uitbetaling of terugbetaling voor')}</button>}
            {role !== 'arbiter' && state.accept && !state.disputes.some((d) => d.by === role) && state.status !== 'closed' && (now > dl.shipBy || state.shipped || fullyFunded) && <DisputeBox state={state} role={role} />}
          </div>
        ))}

      {state.status === 'closed' && <ReviewBox state={state} role={role} />}
      {role && <Chat state={state} />}
    </div>
  );
}
