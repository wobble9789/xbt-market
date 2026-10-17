// Usernames, the Nostr way: a NIP-05 identifier (name@domain) in the kind 0
// profile, which the domain confirms at /.well-known/nostr.json. Like
// name@primal.net on Primal, XBT Market hands out name@<service domain>; the
// service keeps it unique (first come, first served). Any other verified
// NIP-05 a user already has is shown too.
import { useEffect, useState } from 'preact/hooks';
import { api, apiDomain, apiEnabled } from '../api.js';
import { useProfile, saveProfile } from './profiles.js';

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const cleanUsername = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();

const verified = new Map(); // nip05 -> Promise<pubkey|null>

export function verifyNip05(nip05) {
  const m = String(nip05 || '').toLowerCase().match(/^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,}|localhost|127\.0\.0\.1)(:\d+)?$/);
  if (!m) return Promise.resolve(null);
  const [, name, host, port = ''] = m;
  if (!verified.has(nip05)) {
    const proto = host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https';
    verified.set(nip05, fetch(`${proto}://${host}${port}/.well-known/nostr.json?name=${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => j.names?.[name] || null)
      .catch(() => null));
  }
  return verified.get(nip05);
}

// { handle: '@alice' (ours) or 'alice@primal.net', name } once verified, else null.
export function useUsername(pk) {
  const profile = useProfile(pk);
  const [res, setRes] = useState(null);
  const nip05 = profile.nip05;
  useEffect(() => {
    setRes(null);
    if (!pk || !nip05) return;
    let live = true;
    verifyNip05(nip05).then((owner) => {
      if (!live || owner !== pk) return;
      const [name, domain] = nip05.toLowerCase().split('@');
      setRes({ name, domain, ours: domain === apiDomain(), handle: domain === apiDomain() ? '@' + name : name === '_' ? domain : nip05 });
    });
    return () => { live = false; };
  }, [pk, nip05]);
  return res;
}

export const usernamesEnabled = apiEnabled;

export async function checkUsername(name) {
  return api(`/api/names/${encodeURIComponent(cleanUsername(name))}`);
}

export async function claimUsername(pk, name) {
  const n = cleanUsername(name);
  if (!USERNAME_RE.test(n)) throw new Error('3-20 characters: a-z, 0-9 and _');
  await api('/api/names', { method: 'POST', body: { name: n }, auth: true });
  const nip05 = `${n}@${apiDomain()}`;
  verified.delete(nip05);
  await saveProfile(pk, { nip05 });
  return nip05;
}

export const searchUsernames = (q) => api(`/api/names?q=${encodeURIComponent(cleanUsername(q))}`).then((r) => r.names || []);
