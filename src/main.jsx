import { render } from 'preact';
import './lib/session.js';
import { App } from './ui/App.jsx';
import { settings } from './lib/settings.js';
import { inbox } from './lib/nostr/inbox.js';
import { account } from './lib/nostr/account.js';
import { market } from './lib/market.js';
import { directory } from './lib/nostr/directory.js';
import { pool } from './lib/nostr/pool.js';
import './styles.css';

document.documentElement.lang = settings.get().lang;
settings.subscribe((s) => { document.documentElement.lang = s.lang; });

// Handy from the browser console when something looks wrong.
window.xbt = { inbox, account, market, directory, settings, pool };

render(<App />, document.getElementById('app'));

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker', e));
}
