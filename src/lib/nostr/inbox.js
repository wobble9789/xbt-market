// Encrypted trade messages over NIP-17 / NIP-59 gift wraps. Every protocol
// message goes to buyer, seller and arbiter (and a copy to the sender), so all
// three hold the same authenticated log. Rumors are cached locally per account.

import * as nip59 from 'nostr-tools/nip59';
import { getEventHash } from 'nostr-tools/pure';
import { account, secretKey } from './account.js';
import { pool, relays, publishEvent } from './pool.js';
import { createStore, loadJSON, saveJSON } from '../store.js';
import { TRADE_KIND, CHAT_KIND } from '../trade/protocol.js';

export const inbox = createStore({ rumors: {}, syncing: false, lastEvent: 0 });

let sub = null;
let resyncTimer = null;
let onFocus = null;
let seenWraps = new Set();
const cacheKey = (pk) => `xbt:inbox:${pk}`;

function persist() {
  const pk = account.get().pubkey;
  if (pk) saveJSON(cacheKey(pk), { rumors: inbox.get().rumors, syncedAt: Math.floor(Date.now() / 1000) });
}

let persistTimer = null;
const persistSoon = () => { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 500); };

function addRumors(list) {
  if (!list.length) return;
  inbox.set((s) => {
    const rumors = { ...s.rumors };
    for (const r of list) rumors[r.id] = r;
    return { rumors, lastEvent: Date.now() };
  });
  persistSoon();
}

function accept(rumor) {
  if (!rumor || typeof rumor.id !== 'string') return null;
  if (rumor.kind !== TRADE_KIND && rumor.kind !== CHAT_KIND) return null;
  if (!rumor.tags?.some((t) => t[0] === 'xbt-trade')) return null;
  if (getEventHash(rumor) !== rumor.id) return null;
  const { id, pubkey, created_at, kind, tags, content } = rumor;
  return { id, pubkey, created_at, kind, tags, content };
}

export function startInbox() {
  stopInbox();
  const { pubkey, locked } = account.get();
  if (!pubkey || locked) return;
  const cached = loadJSON(cacheKey(pubkey), { rumors: {}, syncedAt: 0 });
  inbox.set({ rumors: cached.rumors || {}, syncing: true });
  seenWraps = new Set();
  const sk = secretKey();
  let batch = [];
  let flushTimer = null;
  const flush = () => { addRumors(batch); batch = []; };
  const onWrap = (wrap) => {
    if (seenWraps.has(wrap.id)) return;
    seenWraps.add(wrap.id);
    try {
      const r = accept(nip59.unwrapEvent(wrap, sk));
      if (r) { batch.push(r); clearTimeout(flushTimer); flushTimer = setTimeout(flush, 150); }
    } catch { /* not for us or malformed */ }
  };
  // Gift wraps carry randomised timestamps up to two days in the past.
  const since = cached.syncedAt ? cached.syncedAt - 3 * 86400 : undefined;
  const filter = { kinds: [1059], '#p': [pubkey] };
  sub = pool.subscribe(relays(), { ...filter, ...(since ? { since } : {}) }, {
    onevent: onWrap,
    oneose() { flush(); inbox.set({ syncing: false }); persist(); },
  });
  // Catch anything a live subscription missed (dropped socket, sleeping tab).
  const resync = () => {
    pool.querySync(relays(), { ...filter, since: Math.floor(Date.now() / 1000) - 3 * 86400 }, { maxWait: 5000 })
      .then((events) => { events.forEach(onWrap); flush(); })
      .catch(() => {});
  };
  resyncTimer = setInterval(resync, 60_000);
  onFocus = () => { if (document.visibilityState !== 'hidden') resync(); };
  addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
}

export function stopInbox() {
  sub?.close();
  sub = null;
  clearInterval(resyncTimer);
  if (onFocus) {
    removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    onFocus = null;
  }
}

// Sends one trade message to every participant (deduplicated, excluding self;
// nip59 adds the sender's own copy).
export async function sendTradeMessage(tradeId, type, body, participants) {
  const sk = secretKey();
  const me = account.get().pubkey;
  const recipients = [...new Set(participants)].filter((p) => p && p !== me);
  const chat = type === 'chat';
  const rumorTemplate = {
    kind: chat ? CHAT_KIND : TRADE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: chat ? String(body.text) : JSON.stringify(body),
    tags: [...recipients.map((p) => ['p', p]), ['xbt-trade', tradeId], ['xbt-type', type], ...(chat ? [['subject', 'XBT Market trade ' + tradeId.slice(0, 8)]] : [])],
  };
  const wraps = nip59.wrapManyEvents(rumorTemplate, sk, recipients);
  // The first wrap is the sender's own copy; decrypting it yields the exact rumor.
  const own = accept(nip59.unwrapEvent(wraps[0], sk));
  const results = await Promise.allSettled(wraps.map((w) => publishEvent(w)));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === wraps.length) throw failed[0].reason;
  if (own) addRumors([own]);
  return { rumor: own, delivered: wraps.length - failed.length, total: wraps.length };
}

export function tradeIds(rumors = inbox.get().rumors) {
  const by = new Map();
  for (const r of Object.values(rumors)) {
    const id = r.tags.find((t) => t[0] === 'xbt-trade')?.[1];
    if (!id) continue;
    const prev = by.get(id) || { id, last: 0, count: 0 };
    prev.last = Math.max(prev.last, r.created_at);
    prev.count++;
    by.set(id, prev);
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}

export function rumorsFor(tradeId, rumors = inbox.get().rumors) {
  return Object.values(rumors).filter((r) => r.tags.some((t) => t[0] === 'xbt-trade' && t[1] === tradeId));
}

export function exportTradeData() {
  return JSON.stringify({ app: 'xbt-market', version: 1, pubkey: account.get().pubkey, rumors: inbox.get().rumors }, null, 1);
}

export function importTradeData(json) {
  const data = JSON.parse(json);
  const list = Object.values(data.rumors || {}).map(accept).filter(Boolean);
  addRumors(list);
  return list.length;
}
