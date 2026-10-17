import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account, nsec, npub, shortNpub, setPassword, removePassword, lock, logout, markBackedUp, toPubkey } from '../../lib/nostr/account.js';
import { settings, updateSettings } from '../../lib/settings.js';
import { directory, loadDirectory } from '../../lib/nostr/directory.js';
import { exportTradeData, importTradeData } from '../../lib/nostr/inbox.js';
import { useProfile } from '../../lib/nostr/profiles.js';
import { useUsername, usernamesEnabled, claimUsername, checkUsername, cleanUsername, USERNAME_RE } from '../../lib/nostr/names.js';
import { apiDomain } from '../../lib/api.js';
import { isValidAddress } from '../../lib/btc/address.js';
import { CURRENCIES } from '../../lib/countries.js';
import { DEFAULTS, ESPLORA_PRESETS } from '../../config.js';
import { Esplora } from '../../lib/btc/esplora.js';
import { secretNames } from '../../lib/secrets.js';
import { connectWallet, disconnectWallet, walletConnected, walletBalance, walletLud16 } from '../../lib/ln/wallet.js';
import { aiConfigured, saveAiKey } from '../../lib/ai/listing.js';
import { T, LANGS } from '../i18n.js';
import { Action, Field, Copy, Avatar, AddressForm, toast, toastError } from '../components.jsx';
import { InstallGuide } from '../install.jsx';
import { EditProfile } from './EditProfile.jsx';

function AccountHead() {
  const acc = useStore(account);
  const profile = useProfile(acc.pubkey);
  const user = useUsername(acc.pubkey);
  const [editing, setEditing] = useState(false);
  const name = profile.display_name || profile.name;
  const country = profile.xbt_market?.country;
  return (
    <>
      <div class="card account-head">
        <div class="row">
          <Avatar pk={acc.pubkey} size={56} />
          <div class="grow">
            <h2>{name || T('Your account', 'Tu cuenta')}</h2>
            {user && <div class="handle">{user.handle}</div>}
            <div class="npub-line"><code class="muted small">{shortNpub(acc.pubkey)}</code> <Copy text={npub()} label={T('Copy npub', 'Copiar npub')} /></div>
          </div>
        </div>
        {(!name || !country) && !editing && <p class="notice small">{T('Finish your profile: add your name and country so buyers know who you are.', 'Completa tu perfil: añade tu nombre y país para que los compradores sepan quién eres.')}</p>}
        <div class="row">
          <button class="btn primary" onClick={() => setEditing(!editing)}>✏️ {T('Edit profile', 'Editar perfil')}</button>
          <a class="btn" href={`#/u/${npub()}`}>{T('View my profile', 'Ver mi perfil')}</a>
        </div>
      </div>
      {editing && <EditProfile pk={acc.pubkey} profile={profile} onDone={() => setEditing(false)} />}
    </>
  );
}

function Username() {
  const pk = useStore(account, (a) => a.pubkey);
  const user = useUsername(pk);
  const [name, setName] = useState('');
  const [check, setCheck] = useState(null);
  const n = cleanUsername(name);
  const valid = USERNAME_RE.test(n);
  useEffect(() => {
    setCheck(null);
    if (!valid) return;
    const t = setTimeout(() => checkUsername(n).then(setCheck).catch((e) => setCheck({ error: e.message })), 350);
    return () => clearTimeout(t);
  }, [n]);
  if (!usernamesEnabled()) return null;
  const free = check && !check.error && (check.available || check.pubkey === pk);
  return (
    <div class="card form">
      <h3>@ {T('Username', 'Nombre de usuario')}</h3>
      <p class="hint">{T(`A unique @name people can find you by, like on Revolut. It is your Nostr address ${n || 'name'}@${apiDomain()}, so other Nostr apps show it too.`, `Un @nombre único con el que te pueden encontrar, como en Revolut. Es tu dirección Nostr ${n || 'nombre'}@${apiDomain()}, así que otras apps de Nostr también lo muestran.`)}</p>
      {user?.ours && <p>{T('Your username', 'Tu nombre de usuario')}: <b class="handle">{user.handle}</b></p>}
      <div class="row">
        <input value={name} onInput={(e) => setName(e.target.value)} placeholder={user?.ours ? T('New username', 'Nuevo nombre de usuario') : T('username', 'nombre')} autocapitalize="off" autocomplete="off" spellcheck={false} />
        <Action class="primary" disabled={!free} onClick={async () => { await claimUsername(pk, n); setName(''); toast(T(`You are now @${n}`, `Ahora eres @${n}`), 'ok'); }}>{user?.ours ? T('Change', 'Cambiar') : T('Claim', 'Reservar')}</Action>
      </div>
      {name && !valid && <span class="hint error">{T('3 to 20 characters: letters a-z, numbers and _', 'De 3 a 20 caracteres: letras a-z, números y _')}</span>}
      {check?.error && <span class="hint error">{check.error}</span>}
      {check && !check.error && (free ? <span class="hint ok-text">✓ @{n} {T('is available', 'está disponible')}</span> : <span class="hint error">✗ @{n} {T('is already taken', 'ya está en uso')}</span>)}
    </div>
  );
}

function Backup({ highlight }) {
  const acc = useStore(account);
  const [show, setShow] = useState(false);
  return (
    <div class={`card ${highlight && !acc.backedUp ? 'attention' : ''}`}>
      <h3>🔑 {T('Back up your key', 'Guarda una copia de tu clave')}</h3>
      <p>{T('Your nsec is your account and the root of all your escrow keys. If you lose it and this browser\'s data, you cannot release or recover escrowed coins. Write it down and store it offline.', 'Tu nsec es tu cuenta y la base de todas tus claves de escrow. Si lo pierdes junto con los datos de este navegador, no podrás liberar ni recuperar monedas en escrow. Apúntalo y guárdalo sin conexión.')}</p>
      {show ? <div class="secret"><code class="break">{nsec()}</code> <Copy text={nsec()} /></div>
        : <button class="btn" onClick={() => setShow(true)}>{T('Show my nsec', 'Mostrar mi nsec')}</button>}
      {!acc.backedUp && <Action class="primary" onClick={async () => markBackedUp()}>{T('I have written it down', 'Ya lo he apuntado')}</Action>}
    </div>
  );
}

function Password() {
  const acc = useStore(account);
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [done, setDone] = useState('');
  const type = show ? 'text' : 'password';
  const short = pw.length > 0 && pw.length < 8;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const ready = pw.length >= 8 && pw === pw2 && (!acc.encrypted || cur);
  const Eye = () => <button type="button" class="btn small ghost eye" onClick={() => setShow(!show)} aria-label={show ? T('Hide password', 'Ocultar contraseña') : T('Show password', 'Mostrar contraseña')}>{show ? '🙈' : '👁'}</button>;
  return (
    <div class="card form password">
      <h3>🔒 {T('Password', 'Contraseña')} {acc.encrypted ? <span class="badge ok">✓ {T('on', 'activada')}</span> : <span class="badge">{T('off', 'desactivada')}</span>}</h3>
      <details class="explain">
        <summary>{T('What does the password do?', '¿Para qué sirve la contraseña?')}</summary>
        <ul class="small">
          <li>{T('It encrypts your key on this device only. Without it, anyone who can open this browser can use your account.', 'Cifra tu clave solo en este dispositivo. Sin ella, cualquiera que pueda abrir este navegador puede usar tu cuenta.')}</li>
          <li>{T('With a password, the app asks for it every time it starts, and when you tap Lock.', 'Con contraseña, la app la pide cada vez que se abre y cuando tocas Bloquear.')}</li>
          <li>{T('Recommended on a shared computer or a phone without a screen lock. Not needed to log in on another device: that uses your nsec.', 'Recomendada en un ordenador compartido o un móvil sin bloqueo de pantalla. No hace falta para entrar en otro dispositivo: para eso usas tu nsec.')}</li>
          <li>{T('Forgot it? Your nsec unlocks the app too.', '¿La olvidaste? Tu nsec también desbloquea la app.')}</li>
        </ul>
      </details>
      {done && <p class="notice ok small">✓ {done}</p>}
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
          setCur(''); setPw(''); setPw2('');
          setDone(was ? T('Password changed. Use the new one next time.', 'Contraseña cambiada. Usa la nueva la próxima vez.') : T('Password set. The app now asks for it when it starts.', 'Contraseña establecida. La app la pedirá al abrirse.'));
        }}>{acc.encrypted ? T('Change password', 'Cambiar contraseña') : T('Set password', 'Establecer contraseña')}</Action>
        {acc.encrypted && <button class="btn" onClick={lock}>{T('Lock now', 'Bloquear ahora')}</button>}
        {acc.encrypted && <Action class="ghost danger" disabled={!cur} confirm={T('Remove the password? Your key is then stored unencrypted on this device.', '¿Quitar la contraseña? Tu clave quedará sin cifrar en este dispositivo.')} onClick={async () => { removePassword(cur); setCur(''); setDone(T('Password removed.', 'Contraseña quitada.')); }}>{T('Remove password', 'Quitar contraseña')}</Action>}
      </div>
    </div>
  );
}

function Basics() {
  const s = useStore(settings);
  return (
    <div class="card form">
      <h3>🌍 {T('Language and currency', 'Idioma y moneda')}</h3>
      <div class="cols">
        <Field label={T('Language', 'Idioma')}>
          <select value={s.lang} onChange={(e) => updateSettings({ lang: e.target.value })}>{LANGS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        </Field>
        <Field label={T('Show prices in', 'Mostrar precios en')} hint={T('Listings in other currencies are converted.', 'Los anuncios en otras monedas se convierten.')}>
          <select value={s.currency} onChange={(e) => updateSettings({ currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
        </Field>
      </div>
    </div>
  );
}

function BecomeArbiter() {
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  const ann = dir.announcements.get(me);
  const approved = dir.arbiters.has(me);
  return (
    <div class="card">
      <h3>⚖️ {T('Become an arbiter', 'Hazte árbitro')}</h3>
      <p class="hint">{T('Arbiters settle disputes in escrow trades and can charge a fee for it. You apply here; the community admin approves you.', 'Los árbitros resuelven disputas en compras con escrow y pueden cobrar por ello. Te apuntas aquí; el administrador de la comunidad te aprueba.')}</p>
      <div class="row">
        <a class="btn" href="#/arbiter">{ann ? T('My arbiter page', 'Mi página de árbitro') : T('Apply as arbiter', 'Solicitar ser árbitro')}</a>
        {ann && <span class={`badge ${approved ? 'ok' : 'warn'}`}>{approved ? T('approved', 'aprobado') : T('waiting for approval', 'pendiente de aprobación')}</span>}
      </div>
    </div>
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
      <p class="hint">{T('Connect your own wallet with Nostr Wallet Connect (NWC) to pay and create invoices from inside a trade. Alby Hub, Zeus, Primal, Coinos and others give you a connection string.', 'Conecta tu propia cartera con Nostr Wallet Connect (NWC) para pagar y crear facturas dentro de una compra. Alby Hub, Zeus, Primal, Coinos y otras te dan un código de conexión.')}</p>
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

function NodePicker() {
  const s = useStore(settings);
  const cur = s.esploraOverride?.[s.network] || s.esplora[s.network];
  const presets = ESPLORA_PRESETS[s.network] || [];
  const isPreset = presets.some((p) => p.url === cur);
  const [custom, setCustom] = useState(isPreset ? '' : cur);
  const [status, setStatus] = useState(null);
  const use = (url) => { updateSettings({ esploraOverride: { ...(s.esploraOverride || {}), [s.network]: url.trim() } }); setStatus(null); };
  const test = async (url) => {
    setStatus('…');
    try { const h = await new Esplora(url).tipHeight(); setStatus(`✓ ${T('block', 'bloque')} ${h.toLocaleString()}`); } catch (e) { setStatus(`✗ ${e.message}`); }
  };
  return (
    <Field label={T('Blockchain server', 'Servidor de blockchain')} hint={T('Like Sparrow: pick a known server or use your own node. It must speak the Esplora/mempool REST API (mempool or electrs on Umbrel, Start9, a VPS…) and follow the BLAKE2b chain. Browsers cannot talk to Electrum servers directly.', 'Como en Sparrow: elige un servidor conocido o usa tu propio nodo. Debe hablar la API REST de Esplora/mempool (mempool o electrs en Umbrel, Start9, un VPS…) y seguir la cadena BLAKE2b. Los navegadores no pueden hablar directamente con servidores Electrum.')}>
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
      <div class="row">
        <input value={custom} onInput={(e) => setCustom(e.target.value)} placeholder="https://umbrel.local:3006/api" />
        <button type="button" class="btn" disabled={!/^https?:\/\//.test(custom)} onClick={() => { use(custom); test(custom); }}>{T('Use', 'Usar')}</button>
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
function Section({ icon, title, summary, open, children }) {
  return (
    <details class="card collapsible" open={open}>
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
  useStore(secretNames);

  return (
    <div class="settings">
      <AccountHead />
      <Username />
      <Backup highlight={query.backup} />
      <Password />
      <Basics />
      <InstallGuide />
      <BecomeArbiter />

      <h2 class="section-title">{T('Full setup (optional)', 'Configuración completa (opcional)')}</h2>
      <p class="hint">{T('You can buy and sell without any of this. Open a section when you need it.', 'Puedes comprar y vender sin nada de esto. Abre una sección cuando la necesites.')}</p>

      <Section icon="🤝" title={T('Trading', 'Compraventa')} summary={T('payout address, your address, exchange rate', 'dirección de cobro, tu dirección, tipo de cambio')} open={openSet.has('trading')}>
        <Field label={T('Default XBT payout / refund address', 'Dirección XBT de cobro / reembolso por defecto')} hint={T('Used in escrow trades. A wallet that follows the BLAKE2b chain.', 'Se usa en compras con escrow. Una cartera que siga la cadena BLAKE2b.')}>
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

      <div class="card">
        <div class="row">
          <Action class="danger ghost" confirm={T('Remove this account from this device? Make sure you have your nsec backed up.', '¿Quitar esta cuenta de este dispositivo? Asegúrate de tener una copia de tu nsec.')} onClick={async () => logout()}>{T('Log out', 'Cerrar sesión')}</Action>
        </div>
      </div>
    </div>
  );
}
