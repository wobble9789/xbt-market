// Private app data that follows the account to every device: hidden
// conversations and saved searches. One replaceable event (kind 30078,
// d = xbt-market/private) whose content is NIP-44 encrypted to the account
// itself, so relays only see that the account has some private data.
//
// Every entry carries the time it was last changed; two devices merge entry by
// entry, the newer one wins. A removed entry stays as { at, gone: true }.

import * as nip44 from 'nostr-tools/nip44';
import { account, secretKey } from './account.js';
import { query, signAndPublish } from './pool.js';
import { createStore, loadJSON, saveJSON } from '../store.js';

export const PRIVATE_D = 'xbt-market/private';
const SECTIONS = ['hidden', 'searches'];
const empty = () => ({ hidden: {}, searches: {} });

export const privateData = createStore({ ...empty(), loaded: false });

const localKey = (pk) => `xbt:private:${pk}`;
const convKey = () => nip44.getConversationKey(secretKey(), account.get().pubkey);
const now = () => Math.floor(Date.now() / 1000);

// Entry by entry, the newer one wins.
export function mergePrivate(a, b) {
  const out = empty();
  for (const s of SECTIONS) {
    const keys = new Set([...Object.keys(a?.[s] || {}), ...Object.keys(b?.[s] || {})]);
    for (const k of keys) {
      const x = a?.[s]?.[k];
      const y = b?.[s]?.[k];
      out[s][k] = !x ? y : !y ? x : (y.at || 0) > (x.at || 0) ? y : x;
    }
  }
  return out;
}

const docOf = (s) => Object.fromEntries(SECTIONS.map((k) => [k, s[k] || {}]));
const same = (a, b) => JSON.stringify(docOf(a)) === JSON.stringify(docOf(b));

let loadedFor = null;
export async function loadPrivate() {
  const pk = account.get().pubkey;
  if (!pk) { privateData.set({ ...empty(), loaded: false }); return; }
  const local = loadJSON(localKey(pk), empty());
  privateData.set({ ...mergePrivate(local, empty()), loaded: false });
  loadedFor = pk;
  let remote = empty();
  try {
    const events = await query({ kinds: [30078], authors: [pk], '#d': [PRIVATE_D] });
    const latest = events.sort((x, y) => y.created_at - x.created_at)[0];
    if (latest) remote = JSON.parse(nip44.decrypt(latest.content, convKey()));
  } catch { /* relays unreachable or locked: local data only for now */ }
  if (loadedFor !== pk) return;
  const merged = mergePrivate(mergePrivate(local, remote), privateData.get());
  privateData.set({ ...merged, loaded: true });
  saveJSON(localKey(pk), merged);
  if (!same(merged, remote)) schedulePublish();
}

let timer = null;
function schedulePublish() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const content = nip44.encrypt(JSON.stringify(docOf(privateData.get())), convKey());
    signAndPublish({ kind: 30078, tags: [['d', PRIVATE_D]], content }).catch(() => {});
  }, 1500);
}

// Sets one entry (value null removes it), saves here and publishes.
export function setPrivate(section, id, value) {
  const pk = account.get().pubkey;
  if (!pk) throw new Error('Log in first');
  const cur = privateData.get();
  const entry = value ? { ...value, at: now() } : { at: now(), gone: true };
  const next = { ...docOf(cur), [section]: { ...cur[section], [id]: entry } };
  privateData.set({ ...next, loaded: cur.loaded });
  saveJSON(localKey(pk), next);
  schedulePublish();
}

// The live entries of a section, as { id, ...entry }.
export const liveEntries = (section, s = privateData.get()) =>
  Object.entries(s[section] || {}).filter(([, v]) => v && !v.gone).map(([id, v]) => ({ id, ...v }));
