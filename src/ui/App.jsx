import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { account, createAccount, importAccount, unlock, logout } from '../lib/nostr/account.js';
import { startInbox, stopInbox, inbox, tradeIds } from '../lib/nostr/inbox.js';
import { startMarket } from '../lib/market.js';
import { loadDirectory, refreshDirectory, directory } from '../lib/nostr/directory.js';
import { settings } from '../lib/settings.js';
import { APP_NAME } from '../config.js';
import { useRoute } from './router.js';
import { T } from './i18n.js';
import { Toasts, Action, Field, toastError } from './components.jsx';
import { Browse } from './pages/Browse.jsx';
import { ListingPage } from './pages/Listing.jsx';
import { Sell, EditListing } from './pages/Sell.jsx';
import { ImportPage } from './pages/Import.jsx';
import { Trades } from './pages/Trades.jsx';
import { TradePage } from './pages/Trade.jsx';
import { ArbiterPage } from './pages/Arbiter.jsx';
import { Profile } from './pages/Profile.jsx';
import { Settings } from './pages/Settings.jsx';
import { Admin } from './pages/Admin.jsx';
import { Help } from './pages/Help.jsx';

function Welcome({ reason }) {
  const [nsecIn, setNsecIn] = useState('');
  return (
    <div class="card narrow">
      <h1>{APP_NAME}</h1>
      <p class="lead">{T(
        'Buy and sell anything for Bitcoin BLAKE2b (XBT). Listings live on Nostr, payments go through a 2-of-3 escrow with a community arbiter, so neither side has to trust the other.',
        'Koop en verkoop alles voor Bitcoin BLAKE2b (XBT). Advertenties staan op Nostr, betalingen gaan via een 2-van-3 escrow met een arbiter uit de community, zodat geen van beide partijen de ander hoeft te vertrouwen.',
      )}</p>
      {reason && <p class="notice">{reason}</p>}
      <Action class="primary wide" onClick={async () => { createAccount(); location.hash = '#/settings?backup=1'; }}>
        {T('Create a new account', 'Nieuw account aanmaken')}
      </Action>
      <div class="or">{T('or use an existing Nostr key', 'of gebruik een bestaande Nostr-sleutel')}</div>
      <Field label="nsec" hint={T('Stays on this device. It also derives your escrow keys, so keep a backup.', 'Blijft op dit apparaat. Je escrow-sleutels worden ervan afgeleid, dus bewaar een back-up.')}>
        <input type="password" value={nsecIn} onInput={(e) => setNsecIn(e.target.value)} placeholder="nsec1…" autocomplete="off" />
      </Field>
      <Action class="wide" onClick={async () => { importAccount(nsecIn); setNsecIn(''); }} disabled={!nsecIn}>{T('Log in', 'Inloggen')}</Action>
      <p class="hint">{T('Browser extensions (NIP-07) are not supported: the app needs your key to sign escrow payouts.', 'Browserextensies (NIP-07) worden niet ondersteund: de app heeft je sleutel nodig om escrow-uitbetalingen te tekenen.')}</p>
    </div>
  );
}

function Unlock() {
  const [pw, setPw] = useState('');
  const go = async () => {
    try { unlock(pw); } catch (e) { throw new Error(/nsec/i.test(pw) ? e.message : T('Wrong password', 'Verkeerd wachtwoord')); }
  };
  return (
    <div class="card narrow">
      <h2>{T('Unlock', 'Ontgrendelen')}</h2>
      <form onSubmit={(e) => { e.preventDefault(); go().catch(toastError); }}>
        <Field label={T('Password', 'Wachtwoord')} hint={T('Forgot it? Your nsec works here too.', 'Vergeten? Je nsec werkt hier ook.')}>
          <input type="password" value={pw} onInput={(e) => setPw(e.target.value)} autofocus />
        </Field>
        <Action class="primary wide" onClick={go}>{T('Unlock', 'Ontgrendelen')}</Action>
      </form>
      <button class="btn ghost small" onClick={() => confirm(T('Remove this account from this device?', 'Account van dit apparaat verwijderen?')) && logout()}>{T('Use another account', 'Ander account gebruiken')}</button>
    </div>
  );
}

const NEEDS_ACCOUNT = new Set(['sell', 'import', 'trades', 'trade', 'arbiter', 'admin']);

function Page({ route }) {
  const [p0, p1, p2] = route.parts;
  switch (p0) {
    case undefined: return <Browse query={route.query} />;
    case 'l': return <ListingPage naddr={p1} />;
    case 'sell': return p1 ? <EditListing d={p1 === 'new' ? null : p1} /> : <Sell />;
    case 'import': return <ImportPage query={route.query} />;
    case 'trades': return <Trades />;
    case 'trade': return <TradePage tradeId={p1} />;
    case 'arbiter': return <ArbiterPage />;
    case 'u': return <Profile id={p1} tab={p2} />;
    case 'settings': return <Settings query={route.query} />;
    case 'admin': return <Admin />;
    case 'help': return <Help />;
    default: return <div class="card">{T('Page not found', 'Pagina niet gevonden')}</div>;
  }
}

export function App() {
  const route = useRoute();
  const acc = useStore(account);
  const lang = useStore(settings, (s) => s.lang);
  const relaysKey = useStore(settings, (s) => s.relays.join(','));
  const { rumors } = useStore(inbox);
  const dir = useStore(directory);

  useEffect(() => {
    startMarket();
    loadDirectory().catch(toastError);
    const t = setInterval(() => refreshDirectory().catch(() => {}), 5 * 60_000);
    return () => clearInterval(t);
  }, [relaysKey]);
  useEffect(() => {
    if (acc.pubkey && !acc.locked) startInbox();
    else stopInbox();
    return stopInbox;
  }, [acc.pubkey, acc.locked, relaysKey]);

  const needsAccount = NEEDS_ACCOUNT.has(route.parts[0]) || (route.parts[0] === 'settings' && !acc.pubkey);
  let body;
  if (acc.pubkey && acc.locked) body = <Unlock />;
  else if (needsAccount && !acc.pubkey) body = <Welcome reason={T('Log in to continue.', 'Log in om verder te gaan.')} />;
  else body = <Page route={route} />;

  const tradeCount = acc.pubkey ? tradeIds(rumors).length : 0;
  const isArbiter = acc.pubkey && (dir.announcements.has(acc.pubkey) || dir.arbiters.has(acc.pubkey));
  const isAdmin = acc.pubkey && dir.admin === acc.pubkey;
  const here = route.parts[0] || '';
  const nav = [
    ['', T('Browse', 'Zoeken'), '🔎'],
    ['sell', T('Sell', 'Verkopen'), '➕'],
    ['trades', T('Trades', 'Trades') + (tradeCount ? ` (${tradeCount})` : ''), '🤝'],
    ...(isArbiter ? [['arbiter', T('Arbiter', 'Arbiter'), '⚖️']] : []),
    ...(isAdmin ? [['admin', 'Admin', '🛠']] : []),
    ['settings', acc.pubkey ? T('Account', 'Account') : T('Log in', 'Inloggen'), '👤'],
  ];

  return (
    <div class="app" key={lang}>
      <header class="top">
        <a class="logo" href="#/"><span class="mark">₿²</span> {APP_NAME}</a>
        <nav class="links">
          {nav.map(([k, label]) => <a key={k} href={`#/${k}`} class={here === k || (k === 'trades' && here === 'trade') ? 'active' : ''}>{label}</a>)}
          <a href="#/help" class={here === 'help' ? 'active' : ''}>{T('How it works', 'Hoe werkt het')}</a>
        </nav>
      </header>
      <main>{body}</main>
      <nav class="bottom">
        {nav.map(([k, label, icon]) => (
          <a key={k} href={`#/${k}`} class={here === k || (k === 'trades' && here === 'trade') ? 'active' : ''}>
            <span class="icon">{icon}</span><span>{label}</span>
          </a>
        ))}
      </nav>
      <Toasts />
    </div>
  );
}
