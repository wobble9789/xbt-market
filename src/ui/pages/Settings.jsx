import { useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account, nsec, npub, setPassword, lock, logout, markBackedUp, toPubkey } from '../../lib/nostr/account.js';
import { settings, updateSettings } from '../../lib/settings.js';
import { loadDirectory } from '../../lib/nostr/directory.js';
import { exportTradeData, importTradeData } from '../../lib/nostr/inbox.js';
import { isValidAddress } from '../../lib/btc/address.js';
import { DEFAULTS, ESPLORA_PRESETS } from '../../config.js';
import { Esplora } from '../../lib/btc/esplora.js';
import { secretNames } from '../../lib/secrets.js';
import { connectWallet, disconnectWallet, walletConnected, walletBalance, walletLud16 } from '../../lib/ln/wallet.js';
import { aiConfigured, saveAiKey } from '../../lib/ai/listing.js';
import { T } from '../i18n.js';
import { Action, Field, Copy, toast, toastError } from '../components.jsx';

function Backup({ highlight }) {
  const acc = useStore(account);
  const [show, setShow] = useState(false);
  return (
    <div class={`card ${highlight && !acc.backedUp ? 'attention' : ''}`}>
      <h3>{T('Back up your key', 'Maak een back-up van je sleutel')}</h3>
      <p>{T('Your nsec is your account and the root of all your escrow keys. If you lose it and this browser\'s data, you cannot release or recover escrowed coins. Write it down and store it offline.', 'Je nsec is je account en de basis van al je escrow-sleutels. Verlies je hem én de gegevens van deze browser, dan kun je munten in escrow niet meer vrijgeven of terughalen. Schrijf hem op en bewaar hem offline.')}</p>
      {show ? <div class="secret"><code class="break">{nsec()}</code> <Copy text={nsec()} /></div>
        : <button class="btn" onClick={() => setShow(true)}>{T('Show my nsec', 'Toon mijn nsec')}</button>}
      {!acc.backedUp && <Action class="primary" onClick={async () => markBackedUp()}>{T('I have written it down', 'Ik heb hem opgeschreven')}</Action>}
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
    <div class="card form">
      <h3>⚡ {T('Lightning wallet', 'Lightning-wallet')}</h3>
      <p class="hint">{T('Connect your own wallet with Nostr Wallet Connect (NWC) to pay and create invoices from inside a trade. Alby Hub, Zeus, Primal, Coinos and others give you a connection string.', 'Koppel je eigen wallet met Nostr Wallet Connect (NWC) om binnen een trade te betalen en facturen te maken. Alby Hub, Zeus, Primal, Coinos en andere geven je een koppelcode.')}</p>
      <p class="notice small">{T('Create the connection with a spending budget (for example 50 € per month). Anyone with this string can spend up to that budget. It is stored encrypted with your key on this device only.', 'Maak de koppeling met een uitgavebudget (bijvoorbeeld 50 € per maand). Wie deze code heeft, kan tot dat budget uitgeven. Hij wordt versleuteld met jouw sleutel en alleen op dit apparaat bewaard.')}</p>
      {connected ? (
        <div class="row">
          <span class="badge ok">✓ {T('Connected', 'Gekoppeld')}{walletLud16() && ` · ${walletLud16()}`}</span>
          <Action class="small" onClick={async () => setBalance((await walletBalance()).balance)}>{T('Balance', 'Saldo')}</Action>
          {balance != null && <span>{Math.floor(balance / 1000).toLocaleString()} sats</span>}
          <Action class="small danger ghost" confirm={T('Disconnect this wallet?', 'Deze wallet ontkoppelen?')} onClick={async () => disconnectWallet()}>{T('Disconnect', 'Ontkoppelen')}</Action>
        </div>
      ) : (
        <div class="row">
          <input type="password" value={uri} onInput={(e) => setUri(e.target.value)} placeholder="nostr+walletconnect://…" autocomplete="off" />
          <Action class="primary" disabled={!uri.startsWith('nostr+walletconnect:')} onClick={async () => { const info = await connectWallet(uri); setUri(''); toast(`${T('Connected', 'Gekoppeld')}${info.alias ? ': ' + info.alias : ''}`, 'ok'); }}>{T('Connect', 'Koppelen')}</Action>
        </div>
      )}
      <Field label={T('Lightning address for receiving (optional)', 'Lightning-adres om te ontvangen (optioneel)')} hint={T('Used for payment requests when no wallet is connected.', 'Gebruikt voor betaalverzoeken als er geen wallet gekoppeld is.')}>
        <input value={s.lightningAddress || ''} onChange={(e) => updateSettings({ lightningAddress: e.target.value.trim() })} placeholder="naam@wallet.com" />
      </Field>
    </div>
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
    try { const h = await new Esplora(url).tipHeight(); setStatus(`✓ ${T('block', 'blok')} ${h.toLocaleString()}`); } catch (e) { setStatus(`✗ ${e.message}`); }
  };
  return (
    <Field label={T('Blockchain server', 'Blockchain-server')} hint={T('Like Sparrow: pick a known server or use your own node. It must speak the Esplora/mempool REST API (mempool or electrs on Umbrel, Start9, a VPS…) and follow the BLAKE2b chain. Browsers cannot talk to Electrum servers directly.', 'Net als bij Sparrow: kies een bekende server of gebruik je eigen node. Die moet de Esplora/mempool-REST-API spreken (mempool of electrs op Umbrel, Start9, een VPS…) en de BLAKE2b-chain volgen. Browsers kunnen niet rechtstreeks met Electrum-servers praten.')}>
      <div class="choices">
        {presets.map((p) => (
          <label key={p.url} class={`choice ${cur === p.url ? 'on' : ''}`}>
            <input type="radio" name="node" checked={cur === p.url} onChange={() => use(p.url)} /><span>{p.name}</span><span class="muted small">{p.url}</span>
          </label>
        ))}
        <label class={`choice ${!isPreset ? 'on' : ''}`}>
          <input type="radio" name="node" checked={!isPreset} onChange={() => custom && use(custom)} /><span>{T('My own node', 'Mijn eigen node')}</span>
        </label>
      </div>
      <div class="row">
        <input value={custom} onInput={(e) => setCustom(e.target.value)} placeholder="https://umbrel.local:3006/api" />
        <button type="button" class="btn" disabled={!/^https?:\/\//.test(custom)} onClick={() => { use(custom); test(custom); }}>{T('Use', 'Gebruiken')}</button>
        <button type="button" class="btn ghost" onClick={() => test(cur)}>{T('Test connection', 'Verbinding testen')}</button>
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
    <div class="card form">
      <h3>✨ {T('AI listing assistant', 'AI-advertentiehulp')}</h3>
      <p class="hint">{T('Writes a title, description, category and price suggestion from your photos, like Marktplaats does. It uses your own Anthropic API key, so you only pay for what you use (a few cents per listing).', 'Schrijft uit je foto\'s een titel, beschrijving, categorie en prijsvoorstel, zoals Marktplaats dat doet. Het gebruikt je eigen Anthropic-API-sleutel, dus je betaalt alleen wat je gebruikt (enkele centen per advertentie).')}</p>
      <ul class="small">
        <li>{T('Create a separate key in a separate workspace at console.anthropic.com and set a low monthly spend limit there. API keys cannot be limited to certain actions, so the spend limit is your safety net.', 'Maak op console.anthropic.com een aparte sleutel in een aparte workspace en stel daar een lage maandlimiet in. API-sleutels kun je niet beperken tot bepaalde acties, dus de uitgavelimiet is je vangnet.')}</li>
        <li>{T('The key is stored encrypted with your Nostr key on this device only and is sent only to api.anthropic.com. It is never published.', 'De sleutel wordt versleuteld met je Nostr-sleutel en alleen op dit apparaat bewaard, en gaat alleen naar api.anthropic.com. Hij wordt nooit gepubliceerd.')}</li>
        <li>{T('Your photos are sent to Anthropic to be described. You can revoke the key at any time in the console.', 'Je foto\'s worden naar Anthropic gestuurd om te beschrijven. Je kunt de sleutel altijd intrekken in de console.')}</li>
      </ul>
      {on ? (
        <div class="row"><span class="badge ok">✓ {T('Key saved', 'Sleutel opgeslagen')}</span><Action class="small danger ghost" onClick={async () => saveAiKey(null)}>{T('Remove', 'Verwijderen')}</Action></div>
      ) : (
        <div class="row">
          <input type="password" value={key} onInput={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autocomplete="off" />
          <Action class="primary" disabled={!key.startsWith('sk-ant-')} onClick={async () => { saveAiKey(key); setKey(''); toast(T('Saved', 'Opgeslagen'), 'ok'); }}>{T('Save', 'Opslaan')}</Action>
        </div>
      )}
    </div>
  );
}

export function Settings({ query }) {
  const acc = useStore(account);
  const s = useStore(settings);
  const [pw, setPw] = useState('');
  const [relays, setRelays] = useState(s.relays.join('\n'));
  const [arb, setArb] = useState('');
  const [payout, setPayout] = useState(s.payoutAddress || '');
  const set = (k) => (e) => updateSettings({ [k]: e.target.value });

  return (
    <div class="settings">
      <div class="card">
        <h2>{T('Account', 'Account')}</h2>
        <p><code class="break">{npub()}</code> <Copy text={npub()} label="npub" /></p>
        <div class="row">
          <a class="btn" href={`#/u/${npub()}`}>{T('My profile', 'Mijn profiel')}</a>
          {acc.encrypted && <button class="btn" onClick={lock}>{T('Lock', 'Vergrendelen')}</button>}
          <Action class="danger ghost" confirm={T('Remove this account from this device? Make sure you have your nsec backed up.', 'Dit account van dit apparaat verwijderen? Zorg dat je een back-up van je nsec hebt.')} onClick={async () => logout()}>{T('Log out', 'Uitloggen')}</Action>
        </div>
      </div>
      <Backup highlight={query.backup} />
      <div class="card">
        <h3>{T('Password', 'Wachtwoord')}</h3>
        <p class="hint">{acc.encrypted ? T('Your key is stored encrypted (NIP-49). Set a new password to change it.', 'Je sleutel is versleuteld opgeslagen (NIP-49). Stel een nieuw wachtwoord in om het te wijzigen.') : T('Encrypt the key stored in this browser with a password (recommended on shared devices).', 'Versleutel de sleutel in deze browser met een wachtwoord (aangeraden op gedeelde apparaten).')}</p>
        <div class="row">
          <input type="password" value={pw} onInput={(e) => setPw(e.target.value)} placeholder={T('New password', 'Nieuw wachtwoord')} />
          <Action disabled={pw.length < 8} onClick={async () => { setPassword(pw); setPw(''); toast(T('Key encrypted', 'Sleutel versleuteld'), 'ok'); }}>{T('Set', 'Instellen')}</Action>
        </div>
      </div>
      <div class="card form">
        <h3>{T('Trading', 'Handelen')}</h3>
        <Field label={T('Default payout / refund address', 'Standaard uitbetaal-/terugbetaaladres')}>
          <input value={payout} onInput={(e) => setPayout(e.target.value)} onBlur={() => (!payout || isValidAddress(payout, s.network)) ? updateSettings({ payoutAddress: payout.trim() }) : toast(T('Invalid address', 'Ongeldig adres'), 'error')} placeholder="bc1q…" />
        </Field>
        <div class="cols">
          <Field label={T('Display currency', 'Weergavevaluta')}>
            <select value={s.currency} onChange={set('currency')}>{['EUR', 'USD', 'GBP', 'CHF', 'PLN', 'CZK', 'SEK'].map((c) => <option key={c}>{c}</option>)}</select>
          </Field>
          <Field label={T('Manual rate (1 XBT in that currency)', 'Handmatige koers (1 XBT in die valuta)')} hint={T('Leave empty to use the SafeTrade market rate', 'Leeg laten voor de SafeTrade-marktkoers')}>
            <input inputmode="decimal" value={s.manualRate?.value || ''} onInput={(e) => updateSettings({ manualRate: e.target.value ? { value: Number(e.target.value.replace(',', '.')), currency: s.currency } : null })} />
          </Field>
          <Field label={T('Language', 'Taal')}>
            <select value={s.lang} onChange={set('lang')}><option value="en">English</option><option value="nl">Nederlands</option></select>
          </Field>
        </div>
        <Field label={T('Shipping address (pre-filled in offers)', 'Verzendadres (vooraf ingevuld bij biedingen)')}><textarea rows="2" value={s.shipTo || ''} onInput={set('shipTo')} /></Field>
        <Field label={T('Your location (pre-filled in imports)', 'Jouw locatie (vooraf ingevuld bij import)')}><input value={s.location || ''} onInput={set('location')} /></Field>
      </div>
      <LightningWallet />
      <AiKey />
      <div class="card form">
        <h3>{T('Trusted arbiters', 'Vertrouwde arbiters')}</h3>
        <p class="hint">{T('In addition to the community list. Only add people you know.', 'Naast de community-lijst. Voeg alleen mensen toe die je kent.')}</p>
        {(s.trustedArbiters || []).map((pk) => <div class="row" key={pk}><code class="small">{npub(pk).slice(0, 24)}…</code><button class="btn small ghost" onClick={() => { updateSettings({ trustedArbiters: s.trustedArbiters.filter((x) => x !== pk) }); loadDirectory(); }}>×</button></div>)}
        <div class="row">
          <input value={arb} onInput={(e) => setArb(e.target.value)} placeholder="npub1…" />
          <button class="btn" onClick={() => { try { const pk = toPubkey(arb); updateSettings({ trustedArbiters: [...new Set([...(s.trustedArbiters || []), pk])] }); setArb(''); loadDirectory(); } catch (e) { toastError(e); } }}>{T('Add', 'Toevoegen')}</button>
        </div>
      </div>
      <div class="card form">
        <h3>{T('Network', 'Netwerk')}</h3>
        <div class="cols">
          <Field label={T('Chain', 'Chain')}>
            <select value={s.network} onChange={set('network')}><option value="mainnet">BLAKE2b mainnet</option><option value="testnet4">BLAKE2b testnet4</option><option value="regtest">regtest</option></select>
          </Field>
        </div>
        <NodePicker />
        <Field label={T('Minimum confirmations before shipping', 'Minimaal aantal bevestigingen vóór verzending')}>
          <input type="number" min="1" max="100" value={s.minConfirmations} onInput={(e) => updateSettings({ minConfirmations: Math.max(1, Number(e.target.value) || 1) })} />
        </Field>
        <Field label={T('Nostr relays (one per line)', 'Nostr-relays (één per regel)')}>
          <textarea rows="4" value={relays} onInput={(e) => setRelays(e.target.value)} />
        </Field>
        <div class="row">
          <button class="btn" onClick={() => { const list = relays.split(/\s+/).filter((r) => /^wss?:\/\//.test(r)); if (list.length) updateSettings({ relays: list }); toast(T('Relays saved', 'Relays opgeslagen'), 'ok'); }}>{T('Save relays', 'Relays opslaan')}</button>
          <button class="btn ghost" onClick={() => { setRelays(DEFAULTS.relays.join('\n')); updateSettings({ relays: DEFAULTS.relays }); }}>{T('Defaults', 'Standaard')}</button>
        </div>
        <Field label={T('Photo server (Blossom)', 'Fotoserver (Blossom)')}><input value={s.blossom} onChange={set('blossom')} /></Field>
      </div>
      <div class="card">
        <h3>{T('Trade backup', 'Back-up van trades')}</h3>
        <p class="hint">{T('Your trade messages are stored on relays and in this browser. Download a copy in case relays drop them.', 'Je trade-berichten staan op relays en in deze browser. Download een kopie voor het geval relays ze verwijderen.')}</p>
        <div class="row">
          <button class="btn" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([exportTradeData()], { type: 'application/json' })); a.download = `xbt-market-trades-${new Date().toISOString().slice(0, 10)}.json`; a.click(); }}>{T('Download', 'Downloaden')}</button>
          <label class="btn ghost">{T('Restore…', 'Herstellen…')}<input type="file" accept="application/json" hidden onChange={async (e) => { try { const n = importTradeData(await e.target.files[0].text()); toast(`${n} ${T('messages restored', 'berichten hersteld')}`, 'ok'); } catch (err) { toastError(err); } }} /></label>
        </div>
      </div>
    </div>
  );
}
