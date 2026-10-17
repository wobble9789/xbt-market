// Following people: the standard Nostr contact list (NIP-02, kind 3), so the
// list is shared with every other Nostr app the user has (Primal, Damus…).
import { createStore } from '../store.js';
import { query, latestBy, signAndPublish } from './pool.js';

export const follows = createStore({ pubkey: null, set: new Set(), loaded: false, event: null });

export async function loadFollows(pk) {
  if (!pk) { follows.set({ pubkey: null, set: new Set(), loaded: false, event: null }); return; }
  const events = await query({ kinds: [3], authors: [pk] });
  const latest = latestBy(events, (e) => e.pubkey)[0] || null;
  follows.set({ pubkey: pk, event: latest, loaded: true, set: new Set((latest?.tags || []).filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1] || '')).map((t) => t[1])) });
}

async function update(pk, add) {
  const cur = follows.get();
  // Re-read first: another app may have changed the list in the meantime.
  if (cur.pubkey) await loadFollows(cur.pubkey).catch(() => {});
  const { event } = follows.get();
  const tags = (event?.tags || []).filter((t) => !(t[0] === 'p' && t[1] === pk));
  if (add) tags.push(['p', pk]);
  const res = await signAndPublish({ kind: 3, tags, content: event?.content || '' });
  follows.set({ event: res.event, set: new Set(tags.filter((t) => t[0] === 'p').map((t) => t[1])) });
}

export const follow = (pk) => update(pk, true);
export const unfollow = (pk) => update(pk, false);
