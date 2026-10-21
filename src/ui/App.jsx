import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { account, createAccount, importAccount, unlock, logout, shortNpub } from '../lib/nostr/account.js';
import { useProfile } from '../lib/nostr/profiles.js';
import { useUsername } from '../lib/nostr/names.js';
import { loadFollows } from '../lib/nostr/follows.js';
import { loadBlocks, loadBlockCounts, blockCounts, suspension } from '../lib/nostr/moderation.js';
import { autoForward } from '../lib/trade/forward.js';
import { startInbox, stopInbox, inbox, tradeIds } from '../lib/nostr/inbox.js';
import { startMarket } from '../lib/market.js';
import { loadDirectory, refreshDirectory, directory } from '../lib/nostr/directory.js';
import { settings } from '../lib/settings.js';
import { APP_NAME } from '../config.js';
import { useRoute } from './router.js';
import { T } from './i18n.js';
import { Toasts, Action, Field, Avatar, Spinner, toastError } from './components.jsx';
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
        'Compra y vende de todo por Bitcoin BLAKE2b (XBT). Los anuncios están en Nostr y los pagos pasan por un escrow 2 de 3 con un árbitro de la comunidad, así que ninguna de las partes tiene que fiarse de la otra.',
      )}</p>
      {reason && <p class="notice">{reason}</p>}
      <Action class="primary wide" onClick={async () => { createAccount(); location.hash = '#/settings?backup=1'; }}>
        {T('Create a new account', 'Crear una cuenta nueva')}
      </Action>
      <div class="or">{T('or use an existing Nostr key', 'o usa una clave Nostr existente')}</div>
      <Field label="nsec" hint={T('Stays on this device. It also derives your escrow keys, so keep a backup.', 'Se queda en este dispositivo. De ella también se derivan tus claves de escrow, así que guarda una copia.')}>
        <input type="password" value={nsecIn} onInput={(e) => setNsecIn(e.target.value)} placeholder="nsec1…" autocomplete="off" />
      </Field>
      <Action class="wide" onClick={async () => { importAccount(nsecIn); setNsecIn(''); }} disabled={!nsecIn}>{T('Log in', 'Iniciar sesión')}</Action>
      <p class="hint">{T('Browser extensions (NIP-07) are not supported: the app needs your key to sign escrow payouts.', 'Las extensiones del navegador (NIP-07) no son compatibles: la app necesita tu clave para firmar los pagos del escrow.')}</p>
    </div>
  );
}

function Unlock() {
  const pk = useStore(account, (a) => a.pubkey);
  const profile = useProfile(pk);
  const user = useUsername(pk);
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    try { unlock(pw); } catch (e) { setErr(/nsec/i.test(pw) ? e.message : T('Wrong password. Try again, or use your nsec.', 'Contraseña incorrecta. Inténtalo otra vez o usa tu nsec.')); }
  };
  return (
    <div class="card narrow unlock">
      <h2>🔒 {T('Unlock', 'Desbloquear')}</h2>
      <div class="unlock-who">
        <Avatar pk={pk} size={48} />
        <div>
          <b>{profile.display_name || profile.name || T('Your account', 'Tu cuenta')}</b>
          {user && <div class="handle">{user.handle}</div>}
          <code class="muted small">{shortNpub(pk)}</code>
        </div>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); go(); }}>
        <Field label={T('Password', 'Contraseña')} hint={T('The password you set for this account on this device. Forgot it? Your nsec works here too.', 'La contraseña que pusiste para esta cuenta en este dispositivo. ¿La olvidaste? Tu nsec también sirve.')}>
          <div class="row nomargin">
            <input type={show ? 'text' : 'password'} value={pw} onInput={(e) => { setPw(e.target.value); setErr(''); }} autofocus class={err ? 'invalid' : ''} autocomplete="current-password" />
            <button type="button" class="btn small ghost" onClick={() => setShow(!show)} aria-label={T('Show password', 'Mostrar contraseña')}>{show ? '🙈' : '👁'}</button>
          </div>
        </Field>
        {err && <p class="hint error">{err}</p>}
        <Action class="primary wide" onClick={go} disabled={!pw}>{T('Unlock', 'Desbloquear')}</Action>
      </form>
      <button class="btn ghost small" onClick={() => confirm(T('Remove this account from this device? You can log in again with its nsec.', '¿Quitar esta cuenta de este dispositivo? Puedes volver a entrar con su nsec.')) && logout()}>{T('Use another account', 'Usar otra cuenta')}</button>
    </div>
  );
}

// Tells the owner of an inactive or suspended account, who would otherwise
// not notice: their listings look normal to themselves.
function MyStatus({ me }) {
  const dir = useStore(directory);
  const { counts } = useStore(blockCounts);
  useEffect(() => { if (me) loadBlockCounts([me]); }, [me]);
  const why = me && suspension(me, dir, counts);
  if (!why) return null;
  return (
    <p class="notice rejected-box">
      <b>⛔ {why === 'admin' ? T('Your account is suspended by the community admin.', 'El administrador de la comunidad ha suspendido tu cuenta.') : T(`Your account is inactive: ${counts.get(me)} people blocked you.`, `Tu cuenta está inactiva: ${counts.get(me)} personas te han bloqueado.`)}</b>
      <br />{T('Your listings are hidden for others and nobody can order from you. Think this is a mistake? Account → Report a problem.', 'Tus anuncios están ocultos para los demás y nadie puede hacerte pedidos. ¿Crees que es un error? Cuenta → Informar de un problema.')}
    </p>
  );
}

// Detail pages get a back button: an installed app on a computer has no
// browser back button. Without history (a link opened directly) it goes to
// the page one level up.
const PARENT = { l: '#/', u: '#/', trade: '#/trades', sell: '#/sell', import: '#/sell', admin: '#/', arbiter: '#/', help: '#/' };
function BackBar({ route }) {
  const [p0, p1] = route.parts;
  if (!PARENT[p0] || (p0 === 'sell' && !p1)) return null;
  const back = () => { if (history.length > 1) history.back(); else location.hash = PARENT[p0]; };
  return <div class="backbar"><button class="btn small ghost" onClick={back}>← {T('Back', 'Atrás')}</button></div>;
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
    case 'trade': return <TradePage tradeId={p1} query={route.query} />;
    case 'arbiter': return <ArbiterPage />;
    case 'u': return <Profile id={p1} tab={p2} />;
    case 'settings': return <Settings query={route.query} />;
    case 'admin': return <Admin />;
    case 'help': return <Help />;
    default: return <div class="card">{T('Page not found', 'Página no encontrada')}</div>;
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
    loadFollows(acc.pubkey).catch(() => {});
    loadBlocks(acc.pubkey).catch(() => {});
    return stopInbox;
  }, [acc.pubkey, acc.locked, relaysKey]);

  const needsAccount = NEEDS_ACCOUNT.has(route.parts[0]) || (route.parts[0] === 'settings' && !acc.pubkey);
  let body;
  if (acc.pubkey && acc.locked && acc.restoring) body = <div class="card narrow"><Spinner /></div>;
  else if (acc.pubkey && acc.locked) body = <Unlock />;
  else if (needsAccount && !acc.pubkey) body = <Welcome reason={T('Log in to continue.', 'Inicia sesión para continuar.')} />;
  else body = <Page route={route} />;

  useEffect(() => {
    if (!acc.pubkey || acc.locked) return;
    const t = setTimeout(() => autoForward(rumors, acc.pubkey), 1500);
    return () => clearTimeout(t);
  }, [rumors, acc.pubkey, acc.locked]);

  const tradeCount = acc.pubkey ? tradeIds(rumors).length : 0;
  const isArbiter = acc.pubkey && (dir.announcements.has(acc.pubkey) || dir.arbiters.has(acc.pubkey));
  const isAdmin = acc.pubkey && dir.admin === acc.pubkey;
  const here = route.parts[0] || '';
  const nav = [
    ['', T('Browse', 'Buscar'), '🔎'],
    ['sell', T('Sell', 'Vender'), '➕'],
    ['trades', T('Messages', 'Mensajes') + (tradeCount ? ` (${tradeCount})` : ''), '💬'],
    ...(isArbiter ? [['arbiter', T('Arbiter', 'Árbitro'), '⚖️']] : []),
    ...(isAdmin ? [['admin', 'Admin', '🛠']] : []),
    ['settings', acc.pubkey ? T('Account', 'Cuenta') : T('Log in', 'Iniciar sesión'), '👤'],
  ];

  return (
    <div class="app" key={lang}>
      <header class="top">
        <a class="logo" href="#/"><span class="mark">₿²</span> {APP_NAME}</a>
        <nav class="links">
          {nav.map(([k, label]) => <a key={k} href={`#/${k}`} class={here === k || (k === 'trades' && here === 'trade') ? 'active' : ''}>{label}</a>)}
          <a href="#/help" class={here === 'help' ? 'active' : ''}>{T('How it works', 'Cómo funciona')}</a>
        </nav>
      </header>
      <main>{!acc.locked && <MyStatus me={acc.pubkey} />}<BackBar route={route} />{body}</main>
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
