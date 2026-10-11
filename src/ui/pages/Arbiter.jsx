import { useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account, npub } from '../../lib/nostr/account.js';
import { directory, announceArbiter, loadDirectory, myArbiterBase } from '../../lib/nostr/directory.js';
import { T } from '../i18n.js';
import { Action, Field, Empty, Copy, toast } from '../components.jsx';
import { useMyTrades, TradeRow } from './Trades.jsx';

export function ArbiterPage() {
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  const ann = dir.announcements.get(me);
  const approved = dir.arbiters.has(me);
  const [f, setF] = useState({ name: ann?.name || '', about: ann?.about || '', languages: ann?.languages || '', feeNote: ann?.feeNote || '' });
  const trades = useMyTrades().filter((t) => t.state.role === 'arbiter');
  const disputed = trades.filter((t) => t.state.disputes.length && t.state.status !== 'closed');
  const other = trades.filter((t) => !disputed.includes(t));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <div>
      <h2>{T('Arbiter', 'Arbiter')}</h2>
      {ann && !approved && <p class="notice warn">{T('Your announcement is published but you are not on the approved list yet. Send your npub to the community admin.', 'Je aankondiging staat online, maar je staat nog niet op de goedgekeurde lijst. Stuur je npub naar de community-beheerder.')} <Copy text={npub(me)} label="npub" /></p>}
      {approved && (
        <>
          <h3>{T('Open disputes', 'Open geschillen')}</h3>
          {disputed.length ? <div class="list">{disputed.map((t) => <TradeRow key={t.id} t={t} />)}</div> : <Empty>{T('No open disputes.', 'Geen open geschillen.')}</Empty>}
          {other.length > 0 && <><h3 class="muted">{T('Other trades you arbitrate', 'Andere trades waarvoor je arbiter bent')}</h3><div class="list">{other.map((t) => <TradeRow key={t.id} t={t} />)}</div></>}
        </>
      )}
      <div class="card form">
        <h3>{ann ? T('Your arbiter profile', 'Jouw arbiterprofiel') : T('Become an arbiter', 'Word arbiter')}</h3>
        <p class="hint">{T('Arbiters hold one of the three keys of every escrow they are picked for, and read the encrypted chat of those trades. They only sign when buyer and seller disagree. Your escrow key is derived from your Nostr key, so keep that backed up.', 'Arbiters hebben één van de drie sleutels van elke escrow waarvoor ze gekozen worden, en lezen de versleutelde chat van die trades. Ze tekenen alleen als koper en verkoper het oneens zijn. Je escrow-sleutel wordt afgeleid van je Nostr-sleutel, dus zorg voor een back-up.')}</p>
        <Field label={T('Name', 'Naam')}><input value={f.name} onInput={set('name')} /></Field>
        <Field label={T('About you', 'Over jou')}><textarea rows="3" value={f.about} onInput={set('about')} /></Field>
        <Field label={T('Languages', 'Talen')}><input value={f.languages} onInput={set('languages')} placeholder="NL, EN, DE" /></Field>
        <Field label={T('Fee policy', 'Vergoeding')}><input value={f.feeNote} onInput={set('feeNote')} placeholder={T('e.g. 2% of the escrow in disputes only', 'bijv. 2% van de escrow, alleen bij geschillen')} /></Field>
        <p class="small muted">{T('Escrow base key', 'Escrow-basissleutel')}: <code class="break">{myArbiterBase()}</code></p>
        <div class="row">
          <Action class="primary" onClick={async () => { await announceArbiter(f); await loadDirectory(); toast(T('Published', 'Gepubliceerd'), 'ok'); }}>{ann ? T('Update', 'Bijwerken') : T('Publish arbiter profile', 'Arbiterprofiel publiceren')}</Action>
          {ann && <Action class="danger ghost" confirm={T('Stop being available as arbiter for new trades?', 'Niet meer beschikbaar zijn als arbiter voor nieuwe trades?')} onClick={async () => { await announceArbiter({ ...f, active: false }); await loadDirectory(); }}>{T('Retire', 'Stoppen')}</Action>}
        </div>
      </div>
    </div>
  );
}
