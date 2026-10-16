// Per-account secrets (wallet connection, AI key) kept in localStorage,
// encrypted with NIP-44 to the account's own key. Whoever can read this
// browser's storage sees only ciphertext; unlocking the account (or the nsec)
// is needed to use them. They are never published to relays.

import * as nip44 from 'nostr-tools/nip44';
import { account, secretKey } from './nostr/account.js';
import { createStore, loadJSON, saveJSON } from './store.js';

const keyFor = (pk) => `xbt:secrets:${pk}`;
const convKey = () => nip44.getConversationKey(secretKey(), account.get().pubkey);

// Which secrets exist (names only), so the UI can show state while locked.
export const secretNames = createStore({ names: [] });

export function refreshSecretNames() {
  const pk = account.get().pubkey;
  secretNames.set({ names: pk ? Object.keys(loadJSON(keyFor(pk), {})) : [] });
}
refreshSecretNames();
account.subscribe(refreshSecretNames);

export function setSecret(name, value) {
  const pk = account.get().pubkey;
  if (!pk) throw new Error('Log in first');
  const all = loadJSON(keyFor(pk), {});
  if (value) all[name] = nip44.encrypt(String(value), convKey());
  else delete all[name];
  saveJSON(keyFor(pk), all);
  refreshSecretNames();
}

export function getSecret(name) {
  const pk = account.get().pubkey;
  const ct = pk && loadJSON(keyFor(pk), {})[name];
  if (!ct) return null;
  return nip44.decrypt(ct, convKey());
}

export const hasSecret = (name) => secretNames.get().names.includes(name);
