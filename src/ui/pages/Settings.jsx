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
import { DEFAULTS, ESPLORA_PRESETS, DEFAULT_ARBITERS } from '../../config.js';
import { Esplora, normalizeNodeUrl } from '../../lib/btc/esplora.js';
import { secretNames } from '../../lib/secrets.js';
import { connectWallet, disconnectWallet, walletConnected, walletBalance, walletLud16 } from '../../lib/ln/wallet.js';
import { aiConfigured, loadAi, saveAi, aiHost, isAnthropicKey, validBase, listModels } from '../../lib/ai/listing.js';
import { T, LANGS } from '../i18n.js';
import { Action, Field, Copy, Avatar, Name, ArbiterName, AddressForm, addressComplete, toast, toastError } from '../components.jsx';
import { InstallGuide } from '../install.jsx';
import { ProfileForm } from './EditProfile.jsx';
import { blocks, unblock } from '../../lib/nostr/moderation.js';
import { BugReport } from '../report.jsx';
import { saveWalletKey, walletKeyConfigured, unusedOnChain } from '../../lib/payout.js';
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
// The wallet's public key, so every trade gets a new payout address.
function WalletKey() {
  useStore(secretNames);
  const network = useStore(settings, (s) => s.network);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(null); // { first, assumed }
  const on = walletKeyConfigured();
  const pick = usePayoutPick(on);
  // What the user's own wallet app should show as its next receiving addresses.
  const [unused, setUnused] = useState(null);
  const [checkErr, setCheckErr] = useState('');
  useEffect(() => { setUnused(null); setCheckErr(''); if (on) unusedOnChain(2).then(setUnused).catch((e) => { setUnused([]); setCheckErr(e.message); }); }, [on, network]);
  return (
    <Field group label={T('Your XBT wallet', 'Tu cartera XBT')}>
      <p class="hint">{T('Paste your wallet\'s public key. XBT Market then uses a new address from your wallet for every trade, so nobody can link your payments.', 'Pega la clave pública de tu cartera. XBT Market usará entonces una dirección nueva de tu cartera en cada compra, para que nadie pueda relacionar tus pagos.')}</p>
      {on ? (
        <>
          <p class="small ok-text">✓ {T('Wallet linked.', 'Cartera vinculada.')}</p>
          <p class="small">{T('We advise you to check this in your wallet app:', 'Te aconsejamos comprobar esto en tu app de cartera:')}</p>
          {checkErr ? <p class="notice warn small">{checkErr}</p> : <>
            <table class="amounts small wallet-check"><tbody>
              {[T('First unused receiving address', 'Primera dirección de recepción sin usar'), T('Second unused receiving address', 'Segunda dirección de recepción sin usar')].map((label, i) => (
                <tr key={i}><td>{label}{unused?.[i] ? <span class="muted"> (#{unused[i].index})</span> : ''}</td><td><code class="break">{unused?.[i]?.address || '…'}</code></td></tr>
              ))}
            </tbody></table>
            <p class="hint">{T('Unused means: never received anything, not even coins that were spent later. Does your wallet show one of these as used? Then your blockchain server is missing its history (for example a pruned node): choose a complete server under Account → Network.', 'Sin usar significa: nunca ha recibido nada, ni siquiera monedas gastadas después. ¿Tu cartera muestra una de estas como usada? Entonces a tu servidor de blockchain le falta su historial (por ejemplo, un nodo podado): elige un servidor completo en Cuenta → Red.')}</p>
          </>}
          {saved?.assumed && <p class="notice warn small">{T('Your key does not say which address type your wallet uses, so bc1q… addresses are assumed. Do these not match your wallet? Paste the "output descriptor" from your wallet instead.', 'Tu clave no dice qué tipo de dirección usa tu cartera, así que se suponen direcciones bc1q…. ¿No coinciden con tu cartera? Pega en su lugar el «output descriptor» de tu cartera.')}</p>}
          {pick && !pick.fixed && unused?.[0] && pick.address !== unused[0].address && <p class="hint">{T(`Your next trade gets ${pick.address}: the earlier unused ones are waiting in open trades.`, `Tu próxima compra recibe ${pick.address}: las anteriores sin usar esperan en compras abiertas.`)}</p>}
          <Action class="small ghost" confirm={T('Unlink your wallet from XBT Market in this browser? Your wallet and its coins are not touched.', '¿Desvincular tu cartera de XBT Market en este navegador? Tu cartera y sus monedas no se tocan.')} onClick={async () => { saveWalletKey(''); setSaved(null); }}>{T('Unlink wallet', 'Desvincular cartera')}</Action>
        </>
      ) : (
        <>
          <ol class="small hint">
            <li>{T('In your XBT wallet, look for its public key: a long code starting with xpub, ypub or zpub (sometimes called "extended public key", usually under the wallet\'s settings or export).', 'En tu cartera XBT, busca su clave pública: un código largo que empieza por xpub, ypub o zpub (a veces llamado «extended public key», normalmente en los ajustes o la exportación de la cartera).')}</li>
            <li>{T('Paste it here and tap "Save wallet key".', 'Pégala aquí y toca «Guardar clave de cartera».')}</li>
            <li>{T('Check that the address shown next is the first receiving address in your wallet.', 'Comprueba que la dirección que aparece es la primera dirección de recepción de tu cartera.')}</li>
          </ol>
          <textarea rows="3" value={text} onInput={(e) => setText(e.target.value)} placeholder="xpub… / ypub… / zpub…" aria-label={T('Public key', 'Clave pública')} />
          <Action class="small primary" disabled={!text.trim()} onClick={async () => {
            try { const r = saveWalletKey(text); setSaved({ first: r.first, assumed: r.wallet.assumed }); setText(''); toast(T('Wallet linked', 'Cartera vinculada'), 'ok'); } catch (e) { toast(T('Cannot use this key: ', 'No se puede usar esta clave: ') + e.message, 'error', 9000); }
          }}>{T('Save wallet key', 'Guardar clave de cartera')}</Action>
        </>
      )}
      <p class="hint">🔒 {T('The public key can only create addresses, never spend. It stays in this browser, encrypted, and is never sent to anyone.', 'La clave pública solo crea direcciones, nunca gasta. Se queda en este navegador, cifrada, y no se envía a nadie.')}</p>
      <details class="small">
        <summary>{T('How XBT Market picks addresses', 'Cómo elige XBT Market las direcciones')}</summary>
        <ul class="hint">
          <li>{T('Each trade gets the next address of your wallet that has never received anything and is not already in another of your trades.', 'Cada compra recibe la siguiente dirección de tu cartera que nunca ha recibido nada y que no está ya en otra de tus compras.')}</li>
          <li>{T('An address is given out when you accept an order, send your details or ask for a payment. If that trade is never paid, the address stays empty, and it is still never given to another trade.', 'Una dirección se entrega cuando aceptas un pedido, envías tus datos o pides un pago. Si esa compra nunca se paga, la dirección queda vacía, y aun así nunca se da a otra compra.')}</li>
          <li>{T('Wallets only look a limited number of empty addresses ahead, usually 20 (the "gap limit"). If more than 20 trades in a row are never paid, raise the gap limit in your wallet, so it still sees later payments.', 'Las carteras solo miran un número limitado de direcciones vacías por delante, normalmente 20 (el «gap limit»). Si más de 20 compras seguidas nunca se pagan, sube el gap limit en tu cartera, para que siga viendo los pagos posteriores.')}</li>
          <li>{T('Use this wallet (or account) for XBT Market only: your wallet does not know which addresses XBT Market gave out, and could give one of them to someone else.', 'Usa esta cartera (o cuenta) solo para XBT Market: tu cartera no sabe qué direcciones ha entregado XBT Market y podría dar una de ellas a otra persona.')}</li>
        </ul>
      </details>
    </Field>
  );
}

// One fixed address instead of a wallet key: hidden behind a warning.
function FixedAddress() {
  const s = useStore(settings);
  const [payout, setPayout] = useState(s.payoutAddress || '');
  const [show, setShow] = useState(!!s.payoutAddress);
  const save = () => {
    if (payout && !isValidAddress(payout, s.network)) return toast(T('Not a valid XBT address', 'No es una dirección XBT válida'), 'error');
    updateSettings({ payoutAddress: payout.trim() });
    toast(payout ? T('Saved', 'Guardado') : T('Removed', 'Eliminada'), 'ok');
  };
  if (!show) return <button type="button" class="btn small ghost" onClick={() => setShow(true)}>{T('No wallet key? Use one fixed address instead', '¿Sin clave de cartera? Usa una dirección fija')}</button>;
  return (
    <Field label={T('One fixed XBT address', 'Una dirección XBT fija')} hint={T('Only used when no wallet is linked above.', 'Solo se usa si no hay cartera vinculada arriba.')}>
      <p class="notice warn small">{T('Not private: everyone you trade with sees this same address, and with it every payment you ever received on it.', 'No es privado: todos con quienes comercias ven esta misma dirección y, con ella, todos los pagos que has recibido en ella.')}</p>
      <input value={payout} onInput={(e) => setPayout(e.target.value)} onBlur={save} placeholder="bc1q…" />
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
  const conn = loadAi();
  const [key, setKey] = useState('');
  const [base, setBase] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState(null);
  const anthropic = isAnthropicKey(key);
  const ready = anthropic || (validBase(base) && model.trim());
  return (
    <>
      <p class="hint">{T('Fills in the title, description, category, condition and a price suggestion from your photos. You check and adjust everything before publishing.', 'Rellena el título, la descripción, la categoría, el estado y un precio sugerido a partir de tus fotos. Tú lo revisas y ajustas todo antes de publicar.')}</p>
      {conn ? (
        <>
          <p><span class="badge ok">✓ {T('Connected', 'Conectado')}</span> <span class="small">{conn.model || T('default model', 'modelo por defecto')} · {aiHost(conn)}</span></p>
          <p class="hint">{T(`Your photos and the key go only to ${aiHost(conn)}, straight from this browser.`, `Tus fotos y la clave solo van a ${aiHost(conn)}, directamente desde este navegador.`)}</p>
          <Action class="small danger ghost" onClick={async () => saveAi(null)}>{T('Disconnect', 'Desconectar')}</Action>
        </>
      ) : (
        <>
          <p class="small">{T('Works with any AI service that can read photos: one you have an account with, or a model on your own computer. You pay your service directly, usually a few cents per listing.', 'Funciona con cualquier servicio de IA que pueda leer fotos: uno en el que tengas cuenta o un modelo en tu propio ordenador. Pagas directamente a tu servicio, normalmente unos céntimos por anuncio.')}</p>
          <ol class="small">
            <li>{T('In your AI service\'s account, create an API key. Set a low monthly spending limit there: a key cannot be limited otherwise.', 'En la cuenta de tu servicio de IA, crea una clave de API. Pon allí un límite de gasto mensual bajo: una clave no se puede limitar de otra forma.')}</li>
            <li>{T('Paste it below, with the API address and model your service gives (in its documentation, often under "OpenAI-compatible API").', 'Pégala abajo, con la dirección de la API y el modelo que indica tu servicio (en su documentación, a menudo en "API compatible con OpenAI").')}</li>
          </ol>
          <Field label={T('API key', 'Clave de API')} hint={anthropic ? T('✓ Recognised: everything else is filled in for you.', '✓ Reconocida: lo demás se rellena solo.') : T('Not needed for a model on your own computer.', 'No hace falta para un modelo en tu propio ordenador.')}>
            <input type="password" value={key} onInput={(e) => setKey(e.target.value)} autocomplete="off" aria-label={T('API key', 'Clave de API')} />
          </Field>
          {!anthropic && <>
            <Field label={T('API address', 'Dirección de la API')} hint={base && !validBase(base) ? T('Starts with https:// (or http://localhost for your own computer).', 'Empieza por https:// (o http://localhost para tu propio ordenador).') : T('Usually ends in /v1.', 'Suele terminar en /v1.')}>
              <input value={base} onInput={(e) => { setBase(e.target.value); setModels(null); }} placeholder="https://…/v1" class={base && !validBase(base) ? 'invalid' : ''} />
            </Field>
            <Field label={T('Model', 'Modelo')} hint={T('Pick one that can read photos (vision).', 'Elige uno que pueda leer fotos (visión).')}>
              {models?.length
                ? <select value={model} onChange={(e) => setModel(e.target.value)}><option value="">{T('Choose…', 'Elige…')}</option>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
                : <input value={model} onInput={(e) => setModel(e.target.value)} />}
            </Field>
            <Action class="small ghost" disabled={!validBase(base)} onClick={async () => { const list = await listModels({ base, key }); setModels(list); if (!list.length) toast(T('The service lists no models: type the name yourself.', 'El servicio no muestra modelos: escribe el nombre tú.')); }}>{T('Show the available models', 'Ver los modelos disponibles')}</Action>
          </>}
          <p class="hint">{T('Stored encrypted on this device only, never published. Your photos go only to the service you connect.', 'Se guarda cifrado solo en este dispositivo y nunca se publica. Tus fotos solo van al servicio que conectes.')}</p>
          <Action class="primary" disabled={!ready} onClick={async () => { saveAi({ key, base: anthropic ? '' : base, model: anthropic ? '' : model }); setKey(''); toast(T('Connected', 'Conectado'), 'ok'); }}>{T('Connect AI service', 'Conectar servicio de IA')}</Action>
        </>
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
      <p class="hint">{T('You can buy and sell without any of this. Open a section when you need it. Changes are saved as you make them, except where a Save button is shown.', 'Puedes comprar y vender sin nada de esto. Abre una sección cuando la necesites. Los cambios se guardan al hacerlos, salvo donde hay un botón de guardar.')}</p>

      <Section icon="💰" title={T('Getting paid', 'Cobrar')} summary={walletKeyConfigured() ? T('✓ wallet linked', '✓ cartera vinculada') : T('link your XBT wallet', 'vincula tu cartera XBT')} open={openSet.has('trading')}>
        <WalletKey />
        <FixedAddress />
      </Section>

      <Section icon="📦" title={T('Shipping address', 'Dirección de envío')} summary={addressComplete(s.address) ? T('✓ filled in', '✓ rellenada') : T('needed to have things shipped', 'necesaria para recibir envíos')} open={openSet.has('address')}>
        <p class="hint">{T('Where sellers ship your orders, and the sender address on your own shipping labels. It goes, encrypted, only to the other side of a trade.', 'Donde los vendedores envían tus pedidos, y el remitente de tus propias etiquetas. Solo va, cifrada, a la otra parte de una compra.')}</p>
        <AddressForm value={s.address} onChange={(address) => updateSettings({ address })} />
      </Section>

      <Section icon="⚡" title={T('Lightning wallet', 'Cartera Lightning')} summary={wallet ? `✓ ${T('connected', 'conectada')}` : T('pay and get paid in one tap', 'paga y cobra con un toque')} open={openSet.has('lightning')}>
        <LightningWallet />
      </Section>

      <Section icon="✨" title={T('AI listing assistant', 'Asistente de anuncios con IA')} summary={aiConfigured() ? `✓ ${T('connected', 'conectado')}` : T('write listings from your photos', 'escribe anuncios a partir de tus fotos')} open={openSet.has('ai')}>
        <AiKey />
      </Section>

      <Section icon="🛡" title={T('Trusted arbiters', 'Árbitros de confianza')} summary={T('in addition to the community list', 'además de la lista de la comunidad')} open={openSet.has('arbiters')}>
        <p class="hint">{T('In addition to the community list. Only add people you know.', 'Además de la lista de la comunidad. Añade solo a personas que conozcas.')}</p>
        {DEFAULT_ARBITERS.map((pk) => <div class="row" key={pk}><ArbiterName pk={pk} /> <span class="badge">{T('default', 'por defecto')}</span></div>)}
        {(s.trustedArbiters || []).filter((pk) => !DEFAULT_ARBITERS.includes(pk)).map((pk) => <div class="row" key={pk}><ArbiterName pk={pk} /> <code class="small muted">{npub(pk).slice(0, 16)}…</code><button class="btn small ghost" onClick={() => { updateSettings({ trustedArbiters: s.trustedArbiters.filter((x) => x !== pk) }); loadDirectory(); }}>×</button></div>)}
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
