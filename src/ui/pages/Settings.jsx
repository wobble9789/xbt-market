import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account, nsec, npub, shortNpub, setPassword, removePassword, checkPassword, lock, logout, markBackedUp, toPubkey } from '../../lib/nostr/account.js';
import { settings, updateSettings } from '../../lib/settings.js';
import { directory, loadDirectory } from '../../lib/nostr/directory.js';
import { exportTradeData, importTradeData } from '../../lib/nostr/inbox.js';
import { useProfile } from '../../lib/nostr/profiles.js';
import { useUsername } from '../../lib/nostr/names.js';
import { isValidAddress } from '../../lib/btc/address.js';
import { CURRENCIES } from '../../lib/countries.js';
import { DEFAULTS, ESPLORA_PRESETS } from '../../config.js';
import { Esplora, normalizeNodeUrl } from '../../lib/btc/esplora.js';
import { secretNames } from '../../lib/secrets.js';
import { connectWallet, disconnectWallet, walletConnected, walletBalance, walletLud16 } from '../../lib/ln/wallet.js';
import { aiConfigured, saveAiKey } from '../../lib/ai/listing.js';
import { T, LANGS } from '../i18n.js';
import { Action, Field, Copy, Avatar, Name, AddressForm, toast, toastError } from '../components.jsx';
import { InstallGuide } from '../install.jsx';
import { ProfileForm } from './EditProfile.jsx';
import { blocks, unblock } from '../../lib/nostr/moderation.js';
import { BugReport } from '../report.jsx';
import { saveWalletKey, walletKeyConfigured, loadWallet } from '../../lib/payout.js';
import { deriveAddress } from '../../lib/btc/xpub.js';
import { usePayoutPick } from '../payout.jsx';

function AccountHead() {
  const acc = useStore(account);
  const profile = useProfile(acc.pubkey);
  const user = useUsername(acc.pubkey);
  const name = profile.display_name || profile.name;
  return (
    <div class="card account-head">
      <div class="row">
        <Avatar pk={acc.pubkey} size={56} />
        <div class="grow">
          <h2>{user?.ours ? user.handle : name ? '@' + name : T('Your account', 'Tu cuenta')}</h2>
          {user && !user.ours && <div class="handle">{user.handle}</div>}
          <div class="npub-line"><code class="muted small">{shortNpub(acc.pubkey)}</code> <Copy text={npub()} label={T('Copy npub', 'Copiar npub')} /></div>
        </div>
      </div>
    </div>
  );
}

// Shows the nsec, after the password when one is set: someone at an unlocked
// computer cannot just read it off.
function Backup() {
  const acc = useStore(account);
  const [show, setShow] = useState(false);
  const [pw, setPw] = useState('');
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState('');
  const reveal = () => { if (checkPassword(pw)) { setShow(true); setAsking(false); setPw(''); setErr(''); } else setErr(T('Wrong password', 'Contraseña incorrecta')); };
  return (
    <>
      <p>{T('Your nsec is your account and the root of all your escrow keys. If you lose it and this browser\'s data, you cannot release or recover escrowed coins. Write it down and store it offline.', 'Tu nsec es tu cuenta y la base de todas tus claves de escrow. Si lo pierdes junto con los datos de este navegador, no podrás liberar ni recuperar monedas en escrow. Apúntalo y guárdalo sin conexión.')}</p>
      {show ? (
        <>
          <div class="secret"><code class="break">{nsec()}</code> <Copy text={nsec()} /></div>
          <button class="btn small ghost" onClick={() => setShow(false)}>{T('Hide', 'Ocultar')}</button>
        </>
      ) : asking ? (
        <form class="row" onSubmit={(e) => { e.preventDefault(); reveal(); }}>
          <input type="password" value={pw} onInput={(e) => { setPw(e.target.value); setErr(''); }} placeholder={T('Your password', 'Tu contraseña')} autocomplete="current-password" autofocus class={err ? 'invalid' : ''} />
          <button class="btn primary" type="submit" disabled={!pw}>{T('Show', 'Mostrar')}</button>
          {err && <span class="hint error">{err}</span>}
        </form>
      ) : <button class="btn" onClick={() => (acc.encrypted ? setAsking(true) : setShow(true))}>{T('Show my nsec', 'Mostrar mi nsec')}</button>}
      {!acc.backedUp && <Action class="primary" onClick={async () => markBackedUp()}>{T('I have written it down', 'Ya lo he apuntado')}</Action>}
    </>
  );
}

function Password() {
  const acc = useStore(account);
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [done, setDone] = useState('');
  const [changing, setChanging] = useState(false);
  const type = show ? 'text' : 'password';
  const short = pw.length > 0 && pw.length < 8;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const ready = pw.length >= 8 && pw === pw2 && (!acc.encrypted || cur);
  const Eye = () => <button type="button" class="btn small ghost eye" onClick={() => setShow(!show)} aria-label={show ? T('Hide password', 'Ocultar contraseña') : T('Show password', 'Mostrar contraseña')}>{show ? '🙈' : '👁'}</button>;
  const form = !acc.encrypted || changing;
  return (
    <>
      <ul class="small explain">
        <li>{T('Optional. Like other Nostr apps, the app works without it: your phone\'s screen lock already protects it.', 'Opcional. Como otras apps de Nostr, la app funciona sin ella: el bloqueo de pantalla de tu móvil ya la protege.')}</li>
        <li>{T('Useful on a computer others can use: your key is then stored encrypted, the app asks for the password after the browser was closed, and before it shows your nsec.', 'Útil en un ordenador que usan otros: tu clave se guarda cifrada, la app pide la contraseña después de cerrar el navegador y antes de mostrar tu nsec.')}</li>
        <li>{T('Only for this device. Forgot it? Your nsec unlocks the app too.', 'Solo para este dispositivo. ¿La olvidaste? Tu nsec también desbloquea la app.')}</li>
      </ul>
      {done && <p class="notice ok small">✓ {done}</p>}
      {acc.encrypted && !changing && (
        <div class="row">
          <span class="badge ok">✓ {T('Password set on this device', 'Contraseña puesta en este dispositivo')}</span>
          <button class="btn" onClick={lock}>🔒 {T('Lock now', 'Bloquear ahora')}</button>
          <button class="btn ghost" onClick={() => { setChanging(true); setDone(''); }}>{T('Change or remove', 'Cambiar o quitar')}</button>
        </div>
      )}
      {form && <>
        {acc.encrypted && (
          <Field label={T('Current password', 'Contraseña actual')}>
            <div class="row nomargin"><input type={type} value={cur} onInput={(e) => setCur(e.target.value)} autocomplete="current-password" /><Eye /></div>
          </Field>
        )}
        <Field label={acc.encrypted ? T('New password', 'Nueva contraseña') : T('Password', 'Contraseña')} hint={short ? undefined : T('At least 8 characters.', 'Al menos 8 caracteres.')}>
          <div class="row nomargin"><input type={type} value={pw} onInput={(e) => { setPw(e.target.value); setDone(''); }} autocomplete="new-password" class={short ? 'invalid' : ''} />{!acc.encrypted && <Eye />}</div>
        </Field>
        {short && <span class="hint error">{T(`Too short: ${pw.length} of at least 8 characters.`, `Demasiado corta: ${pw.length} de al menos 8 caracteres.`)}</span>}
        <Field label={T('Repeat password', 'Repite la contraseña')}>
          <input type={type} value={pw2} onInput={(e) => setPw2(e.target.value)} autocomplete="new-password" class={mismatch ? 'invalid' : ''} />
        </Field>
        {mismatch && <span class="hint error">{T('The passwords are not the same.', 'Las contraseñas no coinciden.')}</span>}
        <div class="row">
          <Action class="primary" disabled={!ready} confirm={acc.encrypted ? T('Replace your password with the new one?', '¿Sustituir tu contraseña por la nueva?') : undefined} onClick={async () => {
            const was = acc.encrypted;
            setPassword(pw, cur);
            setCur(''); setPw(''); setPw2(''); setChanging(false);
            setDone(was ? T('Password changed. Use the new one next time.', 'Contraseña cambiada. Usa la nueva la próxima vez.') : T('Password set. The app asks for it after you close the browser.', 'Contraseña establecida. La app la pedirá cuando cierres el navegador.'));
          }}>{acc.encrypted ? T('Change password', 'Cambiar contraseña') : T('Set password', 'Establecer contraseña')}</Action>
          {acc.encrypted && <Action class="ghost danger" disabled={!cur} confirm={T('Remove the password? Your key is then stored unencrypted on this device.', '¿Quitar la contraseña? Tu clave quedará sin cifrar en este dispositivo.')} onClick={async () => { removePassword(cur); setCur(''); setChanging(false); setDone(T('Password removed.', 'Contraseña quitada.')); }}>{T('Remove password', 'Quitar contraseña')}</Action>}
          {changing && <button class="btn ghost" onClick={() => { setChanging(false); setCur(''); setPw(''); setPw2(''); }}>{T('Cancel', 'Cancelar')}</button>}
        </div>
      </>}
    </>
  );
}

function BlockedList() {
  const b = useStore(blocks);
  const list = [...b.set];
  if (!list.length) return <p class="hint">{T('You have not blocked anyone. Block someone from their profile.', 'No has bloqueado a nadie. Bloquea a alguien desde su perfil.')}</p>;
  return (
    <div class="list">
      {list.map((pk) => (
        <div class="trade-row" key={pk}>
          <div class="grow row-head"><Name pk={pk} /></div>
          <Action class="small" onClick={() => unblock(pk)}>{T('Unblock', 'Desbloquear')}</Action>
        </div>
      ))}
    </div>
  );
}

function Basics() {
  const s = useStore(settings);
  return (
    <div class="cols">
      <Field label={T('Language', 'Idioma')}>
        <select value={s.lang} onChange={(e) => updateSettings({ lang: e.target.value })}>{LANGS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
      </Field>
      <Field label={T('Show prices in', 'Mostrar precios en')} hint={T('Listings in other currencies are converted.', 'Los anuncios en otras monedas se convierten.')}>
        <select value={s.currency} onChange={(e) => updateSettings({ currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
      </Field>
    </div>
  );
}

function BecomeArbiter() {
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  const ann = dir.announcements.get(me);
  const approved = dir.arbiters.has(me);
  return (
    <>
      <p class="hint">{T('Arbiters settle disputes in escrow trades and can charge a fee for it. You apply here; the community admin approves you.', 'Los árbitros resuelven disputas en compras con escrow y pueden cobrar por ello. Te apuntas aquí; el administrador de la comunidad te aprueba.')}</p>
      <div class="row">
        <a class="btn" href="#/arbiter">{ann ? T('My arbiter page', 'Mi página de árbitro') : T('Apply as arbiter', 'Solicitar ser árbitro')}</a>
        {ann && <span class={`badge ${approved ? 'ok' : 'warn'}`}>{approved ? T('approved', 'aprobado') : T('waiting for approval', 'pendiente de aprobación')}</span>}
      </div>
    </>
  );
}

function LightningWallet() {
  useStore(secretNames);
  const s = useStore(settings);
  const [uri, setUri] = useState('');
  const [balance, setBalance] = useState(null);
  const connected = walletConnected();
  return (
    <>
      <p class="hint">{T('Connect your own Lightning wallet with Nostr Wallet Connect (NWC) to pay and create invoices from inside a trade. Your wallet gives you the connection string. For XBT it must run on the XBT Lightning network.', 'Conecta tu propia cartera Lightning con Nostr Wallet Connect (NWC) para pagar y crear facturas dentro de una compra. Tu cartera te da el código de conexión. Para XBT tiene que funcionar en la red Lightning de XBT.')}</p>
      <p class="notice small">{T('Create the connection with a spending budget (for example 50 € per month). Anyone with this string can spend up to that budget. It is stored encrypted with your key on this device only.', 'Crea la conexión con un límite de gasto (por ejemplo 50 € al mes). Quien tenga este código puede gastar hasta ese límite. Se guarda cifrado con tu clave y solo en este dispositivo.')}</p>
      {connected ? (
        <div class="row">
          <span class="badge ok">✓ {T('Connected', 'Conectada')}{walletLud16() && ` · ${walletLud16()}`}</span>
          <Action class="small" onClick={async () => setBalance((await walletBalance()).balance)}>{T('Balance', 'Saldo')}</Action>
          {balance != null && <span>{Math.floor(balance / 1000).toLocaleString()} sats</span>}
          <Action class="small danger ghost" confirm={T('Disconnect this wallet?', '¿Desconectar esta cartera?')} onClick={async () => disconnectWallet()}>{T('Disconnect', 'Desconectar')}</Action>
        </div>
      ) : (
        <div class="row">
          <input type="password" value={uri} onInput={(e) => setUri(e.target.value)} placeholder="nostr+walletconnect://…" autocomplete="off" />
          <Action class="primary" disabled={!uri.startsWith('nostr+walletconnect:')} onClick={async () => { const info = await connectWallet(uri); setUri(''); toast(`${T('Connected', 'Conectada')}${info.alias ? ': ' + info.alias : ''}`, 'ok'); }}>{T('Connect', 'Conectar')}</Action>
        </div>
      )}
      <Field label={T('Lightning address for receiving (optional)', 'Dirección Lightning para recibir (opcional)')} hint={T('Used for payment requests when no wallet is connected.', 'Se usa para las solicitudes de pago si no hay cartera conectada.')}>
        <input value={s.lightningAddress || ''} onChange={(e) => updateSettings({ lightningAddress: e.target.value.trim() })} placeholder="name@wallet.com" />
      </Field>
    </>
  );
}

// What a failed connection test most likely means, in words people can act on.
function nodeError(e, url) {
  const probe = `${url.replace(/\/+$/, '')}/blocks/tip/height`;
  if (e.notApi) return T('This address is a web page, not the API. Add /api at the end.', 'Esta dirección es una página web, no la API. Añade /api al final.');
  const status = Number(String(e.message).match(/: (\d{3})\b/)?.[1]);
  if (status === 404) return T('Not found (404): check the address; it usually ends in /api.', 'No encontrado (404): revisa la dirección; suele terminar en /api.');
  if (status >= 500) return T(`The server answered ${status}: it is still starting or indexing. Try again in a few minutes.`, `El servidor respondió ${status}: aún está arrancando o indexando. Prueba de nuevo en unos minutos.`);
  if (status) return `${status}: ${e.message}`;
  return T(`Could not reach it. Open ${probe} in this browser: a certificate warning means this browser does not trust your node yet (Start9: import its Root CA); a page that does not load means a wrong address, or you are not on your home network; a number means the server refuses other websites (CORS).`,
    `No se puede conectar. Abre ${probe} en este navegador: un aviso de certificado significa que este navegador aún no confía en tu nodo (Start9: importa su Root CA); si la página no carga, la dirección es incorrecta o no estás en tu red de casa; si ves un número, el servidor rechaza otros sitios web (CORS).`);
}

// The wallet's public key, so every trade gets a new payout address.
function WalletKey() {
  useStore(secretNames);
  const network = useStore(settings, (s) => s.network);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(null); // { first, assumed }
  const on = walletKeyConfigured();
  const pick = usePayoutPick(on);
  const wallet = on ? loadWallet() : null;
  const first = wallet ? deriveAddress(wallet, 0, network) : '';
  return (
    <Field group label={T('Your XBT wallet: a new address for every trade', 'Tu cartera XBT: una dirección nueva en cada compra')}>
      <p class="hint">{T('Using one address for every trade lets anyone who traded with you see all your payments. Paste your wallet\'s public key instead: the app then puts a new address from your wallet in every trade, and never one that was used before. The key can only make addresses, not spend; it stays encrypted in this browser and is never sent to anyone.', 'Usar una sola dirección en todas las compras deja que cualquiera con quien comerciaste vea todos tus pagos. Pega la clave pública de tu cartera: la app pondrá en cada compra una dirección nueva de tu cartera, nunca una ya usada. La clave solo crea direcciones, no puede gastar; queda cifrada en este navegador y no se envía a nadie.')}</p>
      <ol class="small hint">
        <li>{T('In Shrike or Sparrow, open the wallet account you use for this XBT Market account (one account per role, used only here).', 'En Shrike o Sparrow, abre la cuenta de la cartera que usas para esta cuenta de XBT Market (una cuenta por rol, usada solo aquí).')}</li>
        <li>{T('Settings (left) → Keystores: copy the xpub. Or Export… → Output descriptor.', 'Settings (izquierda) → Keystores: copia el xpub. O Export… → Output descriptor.')}</li>
        <li>{T('Paste it here and tap "Save wallet key". Check that the first address below is the first one under Addresses in your wallet.', 'Pégalo aquí y toca «Guardar clave de cartera». Comprueba que la primera dirección de abajo es la primera en Addresses de tu cartera.')}</li>
      </ol>
      {on ? (
        <>
          <p class="small">✓ {T('Wallet key saved (encrypted).', 'Clave de cartera guardada (cifrada).')}</p>
          <p class="small">{T('First address (#0)', 'Primera dirección (#0)')}: <code class="break">{first}</code></p>
          {saved?.assumed && <p class="notice warn small">{T('A plain xpub does not say which address type your wallet uses; native segwit (bc1q…) is assumed. If the first address does not match your wallet, paste the output descriptor instead.', 'Un xpub simple no dice qué tipo de dirección usa tu cartera; se supone segwit nativo (bc1q…). Si la primera dirección no coincide, pega el output descriptor.')}</p>}
          <p class="small">{T('Next trade gets', 'La próxima compra recibe')}: {pick?.address ? <code class="break">{pick.address}</code> : '…'} {pick && !pick.fixed && <span class="muted">(#{pick.index})</span>}</p>
          {pick && !pick.fixed && <p class="hint">{pick.index === 0
            ? T('That is address #0 itself: it has never been used, so it comes first. After a payment to it, the next trade gets #1, and so on.', 'Es la propia dirección #0: nunca se ha usado, así que va primero. Tras un pago a ella, la siguiente compra recibe la #1, y así sucesivamente.')
            : T(`Addresses #0 to #${pick.index - 1} were used already (on chain or in a trade), so the next one is #${pick.index}.`, `Las direcciones #0 a #${pick.index - 1} ya se usaron (en la cadena o en una compra), así que la siguiente es la #${pick.index}.`)}</p>}
          <Action class="small ghost" confirm={T('Unlink the wallet key from XBT Market in this browser? Your wallet and its coins are not touched. Trades then use the fixed address below, if any.', '¿Desvincular la clave de cartera de XBT Market en este navegador? Tu cartera y sus monedas no se tocan. Las compras usarán entonces la dirección fija de abajo, si la hay.')} onClick={async () => { saveWalletKey(''); setSaved(null); }}>{T('Unlink wallet key', 'Desvincular clave de cartera')}</Action>
        </>
      ) : (
        <>
          <textarea rows="3" value={text} onInput={(e) => setText(e.target.value)} placeholder="zpub… / xpub… / wpkh([…]xpub…/0/*)" />
          <Action class="small" disabled={!text.trim()} onClick={async () => {
            try { const r = saveWalletKey(text); setSaved({ first: r.first, assumed: r.wallet.assumed }); setText(''); toast(T('Wallet key saved', 'Clave de cartera guardada'), 'ok'); } catch (e) { toast(T('Cannot use this key: ', 'No se puede usar esta clave: ') + e.message, 'error', 9000); }
          }}>{T('Save wallet key', 'Guardar clave de cartera')}</Action>
        </>
      )}
      <p class="hint">{T('Shrike and Sparrow look 20 addresses ahead. Trades that never get paid leave gaps; after more than 20 in a row, raise the gap limit in your wallet (Settings → Advanced).', 'Shrike y Sparrow miran 20 direcciones por delante. Las compras que nunca se pagan dejan huecos; si hay más de 20 seguidos, sube el gap limit en tu cartera (Settings → Advanced).')}</p>
    </Field>
  );
}

function NodePicker() {
  const s = useStore(settings);
  const cur = s.esploraOverride?.[s.network] || s.esplora[s.network];
  const presets = ESPLORA_PRESETS[s.network] || [];
  const isPreset = presets.some((p) => p.url === cur);
  const [custom, setCustom] = useState(isPreset ? '' : cur);
  const [status, setStatus] = useState(null);
  const use = (url) => { updateSettings({ esploraOverride: { ...(s.esploraOverride || {}), [s.network]: url } }); setStatus(null); };
  const test = async (url) => {
    setStatus('…');
    try { const h = await new Esplora(url).tipHeight(); setStatus(`✓ ${T('block', 'bloque')} ${h.toLocaleString()}`); } catch (e) { setStatus(`✗ ${nodeError(e, url)}`); }
  };
  return (
    <Field group label={T('Blockchain server', 'Servidor de blockchain')} hint={T('Pick a known server or use your own node, which must follow the BLAKE2b chain.', 'Elige un servidor conocido o usa tu propio nodo, que debe seguir la cadena BLAKE2b.')}>
      <div class="choices">
        {presets.map((p) => (
          <label key={p.url} class={`choice ${cur === p.url ? 'on' : ''}`}>
            <input type="radio" name="node" checked={cur === p.url} onChange={() => use(p.url)} /><span>{p.name}</span><span class="muted small">{p.url}</span>
          </label>
        ))}
        <label class={`choice ${!isPreset ? 'on' : ''}`}>
          <input type="radio" name="node" checked={!isPreset} onChange={() => custom && use(custom)} /><span>{T('My own node', 'Mi propio nodo')}</span>
        </label>
      </div>
      <ol class="small hint">
        <li>{T('Your own node: install Mempool on it (on Start9 with a BLAKE2b node: Mempool Pruned, set to knots-blake2b and electrs-pruned). Electrs alone does not work: browsers cannot talk to Electrum servers.', 'Tu propio nodo: instala Mempool en él (en Start9 con un nodo BLAKE2b: Mempool Pruned, con knots-blake2b y electrs-pruned). Electrs solo no sirve: los navegadores no hablan con servidores Electrum.')}</li>
        <li>{T('Copy Mempool\'s address (Start9: Mempool → Interfaces → LAN, https://….local) and paste it below. The app adds /api itself.', 'Copia la dirección de Mempool (Start9: Mempool → Interfaces → LAN, https://….local) y pégala abajo. La app añade /api sola.')}</li>
        <li>{T('Start9: this browser must trust your Start9 certificate first (System → Root CA → download, then import it in the browser).', 'Start9: este navegador debe confiar antes en el certificado de tu Start9 (Sistema → Root CA → descargar, e importarlo en el navegador).')}</li>
        <li>{T('Use, then Test connection. Does the browser ask to "access other devices on your local network"? Allow it (always): that is your node. The block must match mempool.guide. A .local address only works at home; a .onion address only in Tor Browser.', 'Usar y luego Probar conexión. ¿El navegador pide «acceder a otros dispositivos de tu red local»? Permítelo (siempre): es tu nodo. El bloque debe coincidir con mempool.guide. Una dirección .local solo funciona en casa; una .onion solo en Tor Browser.')}</li>
      </ol>
      <div class="row">
        <input value={custom} onInput={(e) => setCustom(e.target.value)} placeholder="https://mempool-xxxx.local" />
        <button type="button" class="btn" disabled={!/^https?:\/\//.test(custom.trim())} onClick={() => { const url = normalizeNodeUrl(custom); setCustom(url); use(url); test(url); }}>{T('Use', 'Usar')}</button>
        <button type="button" class="btn ghost" onClick={() => test(cur)}>{T('Test connection', 'Probar conexión')}</button>
      </div>
      {status && <span class="small">{status}</span>}
    </Field>
  );
}

function AiKey() {
  useStore(secretNames);
  const [key, setKey] = useState('');
  const on = aiConfigured();
  return (
    <>
      <p class="hint">{T('Fills in the title, description, category, condition and a price suggestion from your photos, like Marktplaats does. You check and adjust before publishing. It uses your own API key from Anthropic (the maker of Claude); other AI providers are not supported. You pay Anthropic only for what you use, a few cents per listing.', 'Rellena el título, la descripción, la categoría, el estado y un precio sugerido a partir de tus fotos, como hace Marktplaats. Tú lo revisas antes de publicar. Usa tu propia clave de API de Anthropic (los creadores de Claude); otros proveedores de IA no son compatibles. Solo pagas a Anthropic lo que uses, unos céntimos por anuncio.')}</p>
      <ul class="small">
        <li>{T('Create a separate key in a separate workspace at console.anthropic.com and set a low monthly spend limit there. API keys cannot be limited to certain actions, so the spend limit is your safety net.', 'Crea una clave aparte en un espacio de trabajo aparte en console.anthropic.com y pon allí un límite de gasto mensual bajo. Las claves de API no se pueden limitar a ciertas acciones, así que el límite de gasto es tu red de seguridad.')}</li>
        <li>{T('The key is stored encrypted with your Nostr key on this device only and is sent only to api.anthropic.com. It is never published.', 'La clave se guarda cifrada con tu clave Nostr, solo en este dispositivo, y solo se envía a api.anthropic.com. Nunca se publica.')}</li>
        <li>{T('Your photos are sent to Anthropic to be described. You can revoke the key at any time in the console.', 'Tus fotos se envían a Anthropic para describirlas. Puedes revocar la clave cuando quieras en la consola.')}</li>
      </ul>
      {on ? (
        <div class="row"><span class="badge ok">✓ {T('Key saved', 'Clave guardada')}</span><Action class="small danger ghost" onClick={async () => saveAiKey(null)}>{T('Remove', 'Quitar')}</Action></div>
      ) : (
        <div class="row">
          <input type="password" value={key} onInput={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autocomplete="off" />
          <Action class="primary" disabled={!key.startsWith('sk-ant-')} onClick={async () => { saveAiKey(key); setKey(''); toast(T('Saved', 'Guardado'), 'ok'); }}>{T('Save', 'Guardar')}</Action>
        </div>
      )}
    </>
  );
}

// One optional section of the full setup, closed by default.
function Section({ icon, title, summary, open, children, attention }) {
  return (
    <details class={`card collapsible ${attention ? 'attention' : ''}`} open={open}>
      <summary><h3>{icon} {title}</h3>{summary && <span class="muted small">{summary}</span>}</summary>
      <div class="form">{children}</div>
    </details>
  );
}

export function Settings({ query }) {
  const openSet = new Set(String(query.open || '').split(','));
  const s = useStore(settings);
  const [relays, setRelays] = useState(s.relays.join('\n'));
  const [arb, setArb] = useState('');
  const [payout, setPayout] = useState(s.payoutAddress || '');
  const set = (k) => (e) => updateSettings({ [k]: e.target.value });
  const wallet = walletConnected();
  const acc = useStore(account);
  const profile = useProfile(acc.pubkey);
  const country = profile.xbt_market?.country;
  const blockedCount = useStore(blocks, (b) => b.set.size);
  const lang = LANGS.find(([k]) => k === s.lang)?.[1] || s.lang;
  useStore(secretNames);
  // The profile is open by default: it is the first thing to fill in.
  const openProfile = !query.open || openSet.has('profile');

  return (
    <div class="settings">
      <AccountHead />
      <Section icon="👤" title={T('Profile', 'Perfil')} summary={country ? T('username, country, photo', 'nombre de usuario, país, foto') : T('country required', 'país obligatorio')} open={openProfile} attention={!country}>
        <ProfileForm pk={acc.pubkey} profile={profile} />
      </Section>
      <Section icon="🔑" title={T('Back up your key', 'Guarda una copia de tu clave')} summary={acc.backedUp ? `✓ ${T('done', 'hecho')}` : T('not done yet', 'aún no')} open={!!query.backup || openSet.has('backup-key')} attention={!acc.backedUp}>
        <Backup />
      </Section>
      <Section icon="🔒" title={T('Password (optional)', 'Contraseña (opcional)')} summary={acc.encrypted ? `✓ ${T('on this device', 'en este dispositivo')}` : T('for shared computers', 'para ordenadores compartidos')} open={openSet.has('password')}>
        <Password />
      </Section>
      <Section icon="🌍" title={T('Language and currency', 'Idioma y moneda')} summary={`${lang} · ${s.currency}`} open={openSet.has('language')}>
        <Basics />
      </Section>
      <InstallGuide open={openSet.has('install')} />

      <h2 class="section-title">{T('Full setup (optional)', 'Configuración completa (opcional)')}</h2>
      <p class="hint">{T('You can buy and sell without any of this. Open a section when you need it.', 'Puedes comprar y vender sin nada de esto. Abre una sección cuando la necesites.')}</p>

      <Section icon="🤝" title={T('Trading', 'Compraventa')} summary={T('payout address, your address, exchange rate', 'dirección de cobro, tu dirección, tipo de cambio')} open={openSet.has('trading')}>
        <WalletKey />
        <Field label={T('Or one fixed XBT address (not recommended)', 'O una dirección XBT fija (no recomendado)')} hint={T('Only used without a wallet key above. Every trade then shows this same address.', 'Solo se usa sin la clave de cartera de arriba. Cada compra muestra entonces esta misma dirección.')}>
          <input value={payout} onInput={(e) => setPayout(e.target.value)} onBlur={() => (!payout || isValidAddress(payout, s.network)) ? updateSettings({ payoutAddress: payout.trim() }) : toast(T('Invalid address', 'Dirección no válida'), 'error')} placeholder="bc1q…" />
        </Field>
        <h4>{T('Your address', 'Tu dirección')}</h4>
        <p class="hint">{T('Used as sender on shipping labels and pre-filled as delivery address when you buy. Only shared, encrypted, with the other party of a trade.', 'Se usa como remitente en las etiquetas de envío y se rellena como dirección de entrega al comprar. Solo se comparte, cifrada, con la otra parte de una compra.')}</p>
        <AddressForm value={s.address} onChange={(address) => updateSettings({ address })} />
        <Field label={T(`Manual rate (1 XBT in ${s.currency})`, `Tipo manual (1 XBT en ${s.currency})`)} hint={T('Leave empty to use the SafeTrade market rate', 'Déjalo vacío para usar el tipo de mercado de SafeTrade')}>
          <input inputmode="decimal" value={s.manualRate?.currency === s.currency ? s.manualRate.value : ''} onInput={(e) => updateSettings({ manualRate: e.target.value ? { value: Number(e.target.value.replace(',', '.')), currency: s.currency } : null })} />
        </Field>
      </Section>

      <Section icon="⚡" title={T('Lightning wallet', 'Cartera Lightning')} summary={wallet ? `✓ ${T('connected', 'conectada')}` : T('pay and get paid in one tap', 'paga y cobra con un toque')} open={openSet.has('lightning')}>
        <LightningWallet />
      </Section>

      <Section icon="✨" title={T('AI listing assistant', 'Asistente de anuncios con IA')} summary={aiConfigured() ? `✓ ${T('key saved', 'clave guardada')}` : T('write listings from your photos', 'escribe anuncios a partir de tus fotos')} open={openSet.has('ai')}>
        <AiKey />
      </Section>

      <Section icon="🛡" title={T('Trusted arbiters', 'Árbitros de confianza')} summary={T('in addition to the community list', 'además de la lista de la comunidad')} open={openSet.has('arbiters')}>
        <p class="hint">{T('In addition to the community list. Only add people you know.', 'Además de la lista de la comunidad. Añade solo a personas que conozcas.')}</p>
        {(s.trustedArbiters || []).map((pk) => <div class="row" key={pk}><code class="small">{npub(pk).slice(0, 24)}…</code><button class="btn small ghost" onClick={() => { updateSettings({ trustedArbiters: s.trustedArbiters.filter((x) => x !== pk) }); loadDirectory(); }}>×</button></div>)}
        <div class="row">
          <input value={arb} onInput={(e) => setArb(e.target.value)} placeholder="npub1…" />
          <button class="btn" onClick={() => { try { const pk = toPubkey(arb); updateSettings({ trustedArbiters: [...new Set([...(s.trustedArbiters || []), pk])] }); setArb(''); loadDirectory(); } catch (e) { toastError(e); } }}>{T('Add', 'Añadir')}</button>
        </div>
      </Section>

      <Section icon="🌐" title={T('Network', 'Red')} summary={T('blockchain server, relays, photo server', 'servidor de blockchain, relays, servidor de fotos')} open={openSet.has('network')}>
        <Field label={T('Chain', 'Cadena')}>
          <select value={s.network} onChange={set('network')}><option value="mainnet">BLAKE2b mainnet</option><option value="testnet4">BLAKE2b testnet4</option><option value="regtest">regtest</option></select>
        </Field>
        <NodePicker />
        <Field label={T('Minimum confirmations before shipping', 'Confirmaciones mínimas antes de enviar')}>
          <input type="number" min="1" max="100" value={s.minConfirmations} onInput={(e) => updateSettings({ minConfirmations: Math.max(1, Number(e.target.value) || 1) })} />
        </Field>
        <Field label={T('Nostr relays (one per line)', 'Relays de Nostr (uno por línea)')}>
          <textarea rows="4" value={relays} onInput={(e) => setRelays(e.target.value)} />
        </Field>
        <div class="row">
          <button class="btn" onClick={() => { const list = relays.split(/\s+/).filter((r) => /^wss?:\/\//.test(r)); if (list.length) updateSettings({ relays: list }); toast(T('Relays saved', 'Relays guardados'), 'ok'); }}>{T('Save relays', 'Guardar relays')}</button>
          <button class="btn ghost" onClick={() => { setRelays(DEFAULTS.relays.join('\n')); updateSettings({ relays: DEFAULTS.relays }); }}>{T('Defaults', 'Predeterminados')}</button>
        </div>
        <Field label={T('Photo server (Blossom)', 'Servidor de fotos (Blossom)')}><input value={s.blossom} onChange={set('blossom')} /></Field>
      </Section>

      <Section icon="💾" title={T('Trade backup', 'Copia de las compras')} summary={T('download your trade messages', 'descarga tus mensajes de compras')} open={openSet.has('backup')}>
        <p class="hint">{T('Your trade messages are stored on relays and in this browser. Download a copy in case relays drop them.', 'Tus mensajes de compras se guardan en relays y en este navegador. Descarga una copia por si los relays los borran.')}</p>
        <div class="row">
          <button class="btn" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([exportTradeData()], { type: 'application/json' })); a.download = `xbt-market-trades-${new Date().toISOString().slice(0, 10)}.json`; a.click(); }}>{T('Download', 'Descargar')}</button>
          <label class="btn ghost">{T('Restore…', 'Restaurar…')}<input type="file" accept="application/json" hidden onChange={async (e) => { try { const n = importTradeData(await e.target.files[0].text()); toast(`${n} ${T('messages restored', 'mensajes restaurados')}`, 'ok'); } catch (err) { toastError(err); } }} /></label>
        </div>
      </Section>

      <Section icon="⚖️" title={T('Become an arbiter', 'Hazte árbitro')} summary={T('settle disputes for a fee', 'resuelve disputas a cambio de una comisión')} open={openSet.has('arbiter')}>
        <BecomeArbiter />
      </Section>

      <Section icon="⛔" title={T('Blocked people', 'Personas bloqueadas')} summary={blockedCount ? `${blockedCount}` : T('nobody', 'nadie')} open={openSet.has('blocked')}>
        <BlockedList />
      </Section>

      <Section icon="🐞" title={T('Report a problem', 'Informar de un problema')} summary={T('something not working? tell us', '¿algo no funciona? avísanos')} open={openSet.has('bug')}>
        <BugReport />
      </Section>

      <div class="card">
        <div class="row">
          <Action class="danger ghost" confirm={T('Remove this account from this device? Make sure you have your nsec backed up.', '¿Quitar esta cuenta de este dispositivo? Asegúrate de tener una copia de tu nsec.')} onClick={async () => logout()}>{T('Log out', 'Cerrar sesión')}</Action>
        </div>
      </div>
    </div>
  );
}
