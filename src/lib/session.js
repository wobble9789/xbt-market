// One account per browser. The account lives in this browser's storage, which
// every tab shares: when another tab logs in with a different account, or
// logs out, this tab follows at once (it reloads), so two accounts never run
// side by side and mix their data. A second account needs a private window
// or another browser.
import { account } from './nostr/account.js';
import { loadAccountSettings } from './settings.js';
import { loadJSON } from './store.js';

const ACCOUNT_KEY = 'xbt:account';
export const SWITCHED = 'xbt:switched';

loadAccountSettings(account.get().pubkey);
let current = account.get().pubkey;
account.subscribe((a) => {
  if (a.pubkey === current) return;
  current = a.pubkey;
  loadAccountSettings(a.pubkey);
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== ACCOUNT_KEY && e.key !== null) return;
    const now = loadJSON(ACCOUNT_KEY, null)?.pubkey || null;
    if (now === account.get().pubkey) return;
    try { sessionStorage.setItem(SWITCHED, now ? 'other' : 'out'); } catch { /* ignore */ }
    location.reload();
  });
}
