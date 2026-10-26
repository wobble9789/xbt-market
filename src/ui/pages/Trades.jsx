import { useEffect, useMemo } from 'preact/hooks';
import { settings } from '../../lib/settings.js';
import { useStore } from '../../lib/store.js';
import { inbox, tradeIds, rumorsFor } from '../../lib/nostr/inbox.js';
import { account } from '../../lib/nostr/account.js';
import { directory } from '../../lib/nostr/directory.js';
import { blocks } from '../../lib/nostr/moderation.js';
import { reduceTrade, deadlines } from '../../lib/trade/protocol.js';
import { T, timeAgo, fmtDate } from '../i18n.js';
import { Coin, Img, Empty, Spinner, Name, Action } from '../components.jsx';
import { privateData, setPrivate } from '../../lib/nostr/private.js';
import { statusLabel, escrowTotals, shownStatus } from './Trade.jsx';
import { loadFunding } from '../../lib/trade/actions.js';

export function useMyTrades() {
  const { rumors } = useStore(inbox);
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  return useMemo(() => tradeIds(rumors).map((t) => ({ ...t, state: reduceTrade(t.id, rumorsFor(t.id, rumors), { arbiters: dir.arbiters, me, lightningNetwork: settings.get().lightningNetwork }) })).filter((t) => t.state.participants), [rumors, me, dir]);
}

// The next deadline for me in this trade, if any.
function dueLine(s) {
  if (!s.offer || s.cancelled || s.rejected || ['closed', 'completed', 'disputed'].includes(s.status)) return null;
  const dl = deadlines(s);
  const now = Date.now() / 1000;
  const sh = s.offer.shipping;
  const ships = sh && sh.carrier !== 'pickup' && sh.id !== 'pickup' && s.listing?.kind !== 'service';
  if (s.role === 'seller' && ships && dl.paidAt && !s.shipped) return { text: T(`Ship by ${fmtDate(dl.shipBy)}`, `Envíalo antes del ${fmtDate(dl.shipBy)}`), urgent: now > dl.remindAt };
  if (s.role === 'buyer' && s.payment === 'escrow' && s.shipped && !s.received && now < dl.confirmBy) {
    return now < dl.arriveBy
      ? { text: T(`Arrives by ${fmtDate(dl.arriveBy)}`, `Llega antes del ${fmtDate(dl.arriveBy)}`), urgent: false }
      : { text: T(`Confirm or open a dispute by ${fmtDate(dl.confirmBy)}`, `Confirma o abre una disputa antes del ${fmtDate(dl.confirmBy)}`), urgent: dl.confirmBy - now < 2 * 86400 };
  }
  return null;
}

// Conversations can be deleted from the list once nothing is at stake: no
// order, or an order that ended. The other side keeps theirs; a new message
// brings it back. Synced to the account's other devices.
const DELETABLE = ['chat', 'rejected', 'cancelled', 'closed', 'completed'];
export const canDelete = (status) => DELETABLE.includes(status);
export const hideTrade = (id) => setPrivate('hidden', id, {});
const DELETE_ASK = () => T('Delete this conversation from your list? The other side keeps their copy. It comes back if they write again.', '¿Borrar esta conversación de tu lista? La otra parte conserva la suya. Vuelve si te escribe de nuevo.');

// A cancelled escrow trade shows as cancelled once its escrow is known to be
// empty; the list checks the balance of those it has not seen yet.
const checking = new Set();
function useShownStatus(s) {
  const totals = useStore(escrowTotals);
  const addr = s.escrow?.address;
  useEffect(() => {
    if (s.status !== 'cancelling' || !addr || addr in totals || checking.has(addr)) return;
    checking.add(addr);
    loadFunding(s).then((f) => escrowTotals.set((x) => ({ ...x, [addr]: f.total }))).catch(() => {}).finally(() => checking.delete(addr));
  }, [s.status, addr]);
  return shownStatus(s, addr ? totals[addr] : undefined);
}

export function TradeRow({ t }) {
  const s = t.state;
  const status = useShownStatus(s);
  const due = dueLine(s);
  const other = s.role === 'buyer' ? s.participants.seller : s.participants.buyer;
  const last = s.chat[s.chat.length - 1]?.text?.slice(0, 80);
  return (
    <a class="trade-row" href={`#/trade/${t.id}`}>
      <Img src={s.listing?.image} class="thumb-sm" />
      <div class="grow">
        <div class="title">{s.listing?.title}</div>
        <div class="muted small">{s.role === 'buyer' ? T('Buying from', 'Compras a') : s.role === 'seller' ? T('Selling to', 'Vendes a') : T('Arbiter for', 'Árbitro de')} <Name pk={other} link={false} avatar={false} /> · {timeAgo(t.last)}</div>
        {due && <div class={`small ${due.urgent ? 'error' : 'muted'}`}>⏰ {due.text}</div>}
        {last && <div class="muted small last-msg">{last}</div>}
      </div>
      <div class="right">
        <span class={`badge status ${status}`}>{statusLabel(status)}</span>
        {s.terms && <div class="small"><Coin sats={s.terms.priceSats} fiat={false} /></div>}
        {canDelete(status) && <Action class="small ghost delete-trade" title={T('Delete', 'Borrar')} confirm={DELETE_ASK()} onClick={async () => hideTrade(t.id)}>🗑</Action>}
      </div>
    </a>
  );
}

export function Trades() {
  const blocked = useStore(blocks, (b) => b.set);
  // Messages and new orders from people I blocked are hidden; a trade with
  // money in it stays, so it can always be finished.
  const counterpart = (s) => (s.role === 'buyer' ? s.participants.seller : s.participants.buyer);
  const trades = useMyTrades().filter((t) => t.state.role !== 'arbiter' && !(['chat', 'offered'].includes(t.state.status) && blocked.has(counterpart(t.state))));
  const { syncing } = useStore(inbox);
  const { hidden } = useStore(privateData);
  const DONE = ['closed', 'rejected', 'cancelled', 'completed'];
  const totals = useStore(escrowTotals);
  const isDone = (t) => DONE.includes(shownStatus(t.state, totals[t.state.escrow?.address]));
  // Hidden until something new arrives after the delete.
  const shown = trades.filter((t) => { const h = hidden[t.id]; return !h || h.gone || t.last > h.at; });
  const active = shown.filter((t) => !isDone(t));
  const done = shown.filter(isDone);
  const deletable = done.filter((t) => canDelete(shownStatus(t.state, totals[t.state.escrow?.address])));
  return (
    <div>
      <h2>{T('Messages and orders', 'Mensajes y pedidos')} {syncing && <Spinner />}</h2>
      {!shown.length && <Empty>{syncing ? T('Loading…', 'Cargando…') : <>{T('No conversations yet.', 'Aún no hay conversaciones.')} <a href="#/">{T('Find something to buy', 'Busca algo que comprar')}</a></>}</Empty>}
      {active.length > 0 && <div class="list">{active.map((t) => <TradeRow key={t.id} t={t} />)}</div>}
      {done.length > 0 && <>
        <div class="row between"><h3 class="muted">{T('Finished', 'Terminadas')}</h3>{deletable.length > 1 && <Action class="small ghost" confirm={T(`Delete all ${deletable.length} finished conversations from your list?`, `¿Borrar de tu lista las ${deletable.length} conversaciones terminadas?`)} onClick={async () => deletable.forEach((t) => hideTrade(t.id))}>🗑 {T('Delete all finished', 'Borrar todas las terminadas')}</Action>}</div>
        <div class="list">{done.map((t) => <TradeRow key={t.id} t={t} />)}</div>
      </>}
    </div>
  );
}
