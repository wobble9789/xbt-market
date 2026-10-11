import { useMemo } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { inbox, tradeIds, rumorsFor } from '../../lib/nostr/inbox.js';
import { account } from '../../lib/nostr/account.js';
import { directory } from '../../lib/nostr/directory.js';
import { reduceTrade } from '../../lib/trade/protocol.js';
import { T, timeAgo } from '../i18n.js';
import { Coin, Img, Empty, Spinner, Name } from '../components.jsx';
import { statusLabel } from './Trade.jsx';

export function useMyTrades() {
  const { rumors } = useStore(inbox);
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  return useMemo(() => tradeIds(rumors).map((t) => ({ ...t, state: reduceTrade(t.id, rumorsFor(t.id, rumors), { arbiters: dir.arbiters, me }) })).filter((t) => t.state.offer), [rumors, me, dir]);
}

export function TradeRow({ t }) {
  const s = t.state;
  const other = s.role === 'buyer' ? s.participants.seller : s.participants.buyer;
  return (
    <a class="trade-row" href={`#/trade/${t.id}`}>
      <Img src={s.offer.listing.image} class="thumb-sm" />
      <div class="grow">
        <div class="title">{s.offer.listing.title}</div>
        <div class="muted small">{s.role === 'buyer' ? T('Buying from', 'Kopen van') : s.role === 'seller' ? T('Selling to', 'Verkopen aan') : T('Arbiter for', 'Arbiter voor')} <Name pk={other} link={false} avatar={false} /> · {timeAgo(t.last)}</div>
      </div>
      <div class="right">
        <span class={`badge status ${s.status}`}>{statusLabel(s.status)}</span>
        <div class="small"><Coin sats={s.offer.priceSats} fiat={false} /></div>
      </div>
    </a>
  );
}

export function Trades() {
  const trades = useMyTrades().filter((t) => t.state.role !== 'arbiter');
  const { syncing } = useStore(inbox);
  const active = trades.filter((t) => !['closed', 'rejected', 'cancelled'].includes(t.state.status));
  const done = trades.filter((t) => ['closed', 'rejected', 'cancelled'].includes(t.state.status));
  return (
    <div>
      <h2>{T('Your trades', 'Jouw trades')} {syncing && <Spinner />}</h2>
      {!trades.length && <Empty>{syncing ? T('Loading…', 'Laden…') : <>{T('No trades yet.', 'Nog geen trades.')} <a href="#/">{T('Find something to buy', 'Zoek iets om te kopen')}</a></>}</Empty>}
      {active.length > 0 && <div class="list">{active.map((t) => <TradeRow key={t.id} t={t} />)}</div>}
      {done.length > 0 && <><h3 class="muted">{T('Finished', 'Afgerond')}</h3><div class="list">{done.map((t) => <TradeRow key={t.id} t={t} />)}</div></>}
    </div>
  );
}
