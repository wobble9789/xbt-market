// When an arbiter joins a trade after the offer (version 2), each side sends
// the arbiter copies of its own earlier messages, so the arbiter can rebuild
// the whole trade. And once the seller accepts, the buyer's addresses kept
// with the order go out. Runs in the background whenever the inbox changes.
import { inbox, tradeIds, rumorsFor, forwardOwnRumors } from '../nostr/inbox.js';
import { reduceTrade } from './protocol.js';
import { sendPendingDetails } from './actions.js';

let running = false;
let again = false;
export async function autoForward(rumors, me) {
  if (!me) return;
  if (running) { again = true; return; } // an accept that arrives meanwhile is handled right after
  running = true;
  try {
    for (const { id } of tradeIds(rumors)) {
      const s = reduceTrade(id, rumorsFor(id, rumors), { me });
      if (s.role === 'buyer') await sendPendingDetails(s).catch(() => {});
      const arbiter = s.participants?.arbiter;
      if (!arbiter || s.version !== 2 || !['buyer', 'seller'].includes(s.role)) continue;
      await forwardOwnRumors(id, arbiter).catch(() => {});
    }
  } finally {
    running = false;
  }
  if (again) { again = false; await autoForward(inbox.get().rumors, me); }
}
