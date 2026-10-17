// When an arbiter joins a trade after the offer (version 2), each side sends
// the arbiter copies of its own earlier messages, so the arbiter can rebuild
// the whole trade. Runs in the background whenever the inbox changes.
import { tradeIds, rumorsFor, forwardOwnRumors } from '../nostr/inbox.js';
import { reduceTrade } from './protocol.js';

let running = false;
export async function autoForward(rumors, me) {
  if (running || !me) return;
  running = true;
  try {
    for (const { id } of tradeIds(rumors)) {
      const s = reduceTrade(id, rumorsFor(id, rumors), { me });
      const arbiter = s.participants?.arbiter;
      if (!arbiter || s.version !== 2 || !['buyer', 'seller'].includes(s.role)) continue;
      await forwardOwnRumors(id, arbiter).catch(() => {});
    }
  } finally {
    running = false;
  }
}
