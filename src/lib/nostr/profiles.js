// Kind 0 profiles, fetched in batches and cached in memory.
import { useEffect, useState } from 'preact/hooks';
import { query, latestBy, signAndPublish } from './pool.js';

const cache = new Map();
const listeners = new Map();
let pending = new Set();
let timer = null;

function flush() {
  const authors = [...pending];
  pending = new Set();
  if (!authors.length) return;
  query({ kinds: [0], authors }).then((events) => {
    for (const e of latestBy(events, (x) => x.pubkey)) {
      try { cache.set(e.pubkey, { ...JSON.parse(e.content), _event: e }); } catch { /* bad json */ }
    }
    for (const pk of authors) {
      if (!cache.has(pk)) cache.set(pk, {});
      listeners.get(pk)?.forEach((f) => f(cache.get(pk)));
    }
  }).catch(() => {});
}

export function getProfile(pk) {
  if (!cache.has(pk) && !pending.has(pk)) {
    pending.add(pk);
    clearTimeout(timer);
    timer = setTimeout(flush, 100);
  }
  return cache.get(pk);
}

export function useProfile(pk) {
  const [p, setP] = useState(() => (pk ? cache.get(pk) : null));
  useEffect(() => {
    if (!pk) return;
    const f = (v) => setP(v);
    if (!listeners.has(pk)) listeners.set(pk, new Set());
    listeners.get(pk).add(f);
    setP(getProfile(pk));
    return () => listeners.get(pk).delete(f);
  }, [pk]);
  return p || {};
}

export async function saveProfile(pk, fields) {
  const existing = await query({ kinds: [0], authors: [pk] });
  const latest = latestBy(existing, (e) => e.pubkey)[0];
  let base = {};
  try { base = latest ? JSON.parse(latest.content) : {}; } catch { /* keep empty */ }
  const content = { ...base, ...fields };
  const res = await signAndPublish({ kind: 0, tags: latest?.tags || [], content: JSON.stringify(content) });
  cache.set(pk, { ...content, _event: res.event });
  listeners.get(pk)?.forEach((f) => f(cache.get(pk)));
  return res;
}
