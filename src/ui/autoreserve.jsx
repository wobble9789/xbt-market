import { useEffect } from 'preact/hooks';
import { useStore, loadJSON, saveJSON } from '../lib/store.js';
import { market } from '../lib/market.js';
import { account } from '../lib/nostr/account.js';
import { useMyTrades } from './pages/Trades.jsx';
import { publishListing } from './pages/Sell.jsx';
import { T } from './i18n.js';
import { toast } from './components.jsx';

// Paid = the buyer paid directly, or reported the escrow payment.
const isPaid = (s) => !!(s.paid || s.paymentConfirmed || s.shipped || s.fundingHints?.some((h) => h.by === 'buyer'));

// Once a buyer has paid, the seller's listing goes to "reserved" by itself, so
// nobody else orders it. Each trade does this once: a seller who has more of
// the item puts it back on sale and it stays that way.
export function AutoReserve() {
  const me = useStore(account, (a) => a.pubkey);
  const { listings } = useStore(market);
  const trades = useMyTrades();
  useEffect(() => {
    if (!me) return;
    const done = new Set(loadJSON(`xbt:autoreserved:${me}`, []));
    for (const t of trades) {
      const s = t.state;
      // Only fresh payments: not trades from before this existed, nor finished ones.
      const recent = Date.now() / 1000 - t.last < 7 * 86400;
      if (s.role !== 'seller' || done.has(t.id) || !recent || !isPaid(s) || s.cancelled || s.rejected || s.status === 'closed') continue;
      done.add(t.id);
      saveJSON(`xbt:autoreserved:${me}`, [...done]);
      const l = [...listings.values()].find((x) => x.coord === s.listing?.coord && x.pubkey === me);
      if (l && l.status === 'active') {
        publishListing({ ...l, status: 'reserved' })
          .then(() => toast(T(`"${l.title}" is paid and now reserved. Put it back on sale under Sell if you have more.`, `«${l.title}» está pagado y ahora reservado. Vuelve a ponerlo en venta en Vender si tienes más.`), 'ok', 9000))
          .catch(() => {});
      }
    }
  }, [trades, listings, me]);
  return null;
}
