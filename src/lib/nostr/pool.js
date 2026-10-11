import { SimplePool } from 'nostr-tools/pool';
import { settings } from '../settings.js';
import { sign } from './account.js';

export const pool = new SimplePool({ enableReconnect: true });

export const relays = () => settings.get().relays;

// Publishes to every configured relay; succeeds if at least one accepts.
export async function publishEvent(event, to = relays()) {
  const res = await Promise.allSettled(pool.publish(to, event));
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  if (!ok) throw new Error('No relay accepted the event: ' + res.map((r) => r.reason?.message || r.reason).join('; '));
  return { event, ok, total: to.length };
}

export const signAndPublish = (template) => publishEvent(sign(template));

export const query = (filter, maxWait = 4000) => pool.querySync(relays(), filter, { maxWait });

export function subscribe(filter, onevent, oneose) {
  return pool.subscribe(relays(), filter, { onevent, oneose });
}

// Latest replaceable event per (pubkey, d) from a list.
export function latestBy(events, keyFn) {
  const m = new Map();
  for (const e of events) {
    const k = keyFn(e);
    const cur = m.get(k);
    if (!cur || e.created_at > cur.created_at || (e.created_at === cur.created_at && e.id < cur.id)) m.set(k, e);
  }
  return [...m.values()];
}

export const tag = (e, name) => e.tags.find((t) => t[0] === name)?.[1];
export const tags = (e, name) => e.tags.filter((t) => t[0] === name).map((t) => t[1]);
