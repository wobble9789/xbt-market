import { useMemo } from 'preact/hooks';
import { settings } from '../../lib/settings.js';
import { useStore } from '../../lib/store.js';
import { inbox, tradeIds, rumorsFor } from '../../lib/nostr/inbox.js';
import { account } from '../../lib/nostr/account.js';
import { directory } from '../../lib/nostr/directory.js';
import { blocks } from '../../lib/nostr/moderation.js';
import { reduceTrade, deadlines } from '../../lib/trade/protocol.js';
import { T, timeAgo, fmtDate } from '../i18n.js';
import { Coin, Img, Empty, Spinner, Name } from '../components.jsx';
import { statusLabel } from './Trade.jsx';

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
  if (s.role === 'buyer' && s.payment === 'escrow' && s.shipped && !s.received && now < dl.confirmBy) return { text: T(`Confirm or complain by ${fmtDate(dl.confirmBy)}`, `Confirma o reclama antes del ${fmtDate(dl.confirmBy)}`), urgent: dl.confirmBy - now < 2 * 86400 };
  return null;
}

export function TradeRow({ t }) {
  const s = t.state;
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
        <span class={`badge status ${s.status}`}>{statusLabel(s.status)}</span>
        {s.terms && <div class="small"><Coin sats={s.terms.priceSats} fiat={false} /></div>}
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
  const DONE = ['closed', 'rejected', 'cancelled', 'completed'];
  const active = trades.filter((t) => !DONE.includes(t.state.status));
  const done = trades.filter((t) => DONE.includes(t.state.status));
  return (
    <div>
      <h2>{T('Messages and orders', 'Mensajes y pedidos')} {syncing && <Spinner />}</h2>
      {!trades.length && <Empty>{syncing ? T('Loading…', 'Cargando…') : <>{T('No conversations yet.', 'Aún no hay conversaciones.')} <a href="#/">{T('Find something to buy', 'Busca algo que comprar')}</a></>}</Empty>}
      {active.length > 0 && <div class="list">{active.map((t) => <TradeRow key={t.id} t={t} />)}</div>}
      {done.length > 0 && <><h3 class="muted">{T('Finished', 'Terminadas')}</h3><div class="list">{done.map((t) => <TradeRow key={t.id} t={t} />)}</div></>}
    </div>
  );
}
