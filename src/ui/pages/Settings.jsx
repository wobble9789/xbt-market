import { useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account, nsec, npub, setPassword, lock, logout, markBackedUp, toPubkey } from '../../lib/nostr/account.js';
import { settings, updateSettings } from '../../lib/settings.js';
import { loadDirectory } from '../../lib/nostr/directory.js';
import { exportTradeData, importTradeData } from '../../lib/nostr/inbox.js';
import { isValidAddress } from '../../lib/btc/address.js';
import { DEFAULTS } from '../../config.js';
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

export function Settings({ query }) {
  const acc = useStore(account);
  const s = useStore(settings);
  const [pw, setPw] = useState('');
  const [relays, setRelays] = useState(s.relays.join('\n'));
  const [arb, setArb] = useState('');
  const [payout, setPayout] = useState(s.payoutAddress || '');
  const set = (k) => (e) => updateSettings({ [k]: e.target.value });
  const esploraCur = s.esploraOverride?.[s.network] || s.esplora[s.network];

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
          <Field label={T('Esplora API', 'Esplora-API')} hint={T('Any Esplora/mempool API that follows the BLAKE2b chain, e.g. your own node.', 'Elke Esplora/mempool-API die de BLAKE2b-chain volgt, bijv. je eigen node.')}>
            <input value={esploraCur} onChange={(e) => updateSettings({ esploraOverride: { ...(s.esploraOverride || {}), [s.network]: e.target.value.trim() } })} />
          </Field>
        </div>
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
