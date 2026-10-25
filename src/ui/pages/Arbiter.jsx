import { useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account, npub } from '../../lib/nostr/account.js';
import { directory, announceArbiter, loadDirectory, myArbiterBase, arbiterFeePct, MAX_ARBITER_FEE_PCT } from '../../lib/nostr/directory.js';
import { settings } from '../../lib/settings.js';
import { secretNames } from '../../lib/secrets.js';
import { walletKeyConfigured } from '../../lib/payout.js';
import { T } from '../i18n.js';
import { Action, Field, Empty, Copy, toast } from '../components.jsx';
import { useMyTrades, TradeRow } from './Trades.jsx';

export function ArbiterPage() {
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  const ann = dir.announcements.get(me);
  const approved = dir.arbiters.has(me);
  const [f, setF] = useState({ name: ann?.name || '', about: ann?.about || '', languages: ann?.languages || '', feePct: ann ? String(arbiterFeePct(ann)) : '1' });
  const fixedPayout = useStore(settings, (s) => s.payoutAddress);
  useStore(secretNames);
  const payout = fixedPayout || walletKeyConfigured();
  const pct = Number(String(f.feePct).replace(',', '.'));
  const pctOk = pct >= 0 && pct <= MAX_ARBITER_FEE_PCT;
  const trades = useMyTrades().filter((t) => t.state.role === 'arbiter');
  const disputed = trades.filter((t) => t.state.disputes.length && t.state.status !== 'closed');
  const other = trades.filter((t) => !disputed.includes(t));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <div>
      <h2>{T('Arbiter', 'Árbitro')}</h2>
      {ann && !approved && <p class="notice warn">{T('Your announcement is published but you are not on the approved list yet. Send your npub to the community admin.', 'Tu presentación está publicada, pero aún no estás en la lista de aprobados. Envía tu npub al administrador de la comunidad.')} <Copy text={npub(me)} label="npub" /></p>}
      {approved && (
        <>
          <h3>{T('Open disputes', 'Disputas abiertas')}</h3>
          {disputed.length ? <div class="list">{disputed.map((t) => <TradeRow key={t.id} t={t} />)}</div> : <Empty>{T('No open disputes.', 'No hay disputas abiertas.')}</Empty>}
          {other.length > 0 && <><h3 class="muted">{T('Other trades you arbitrate', 'Otras compras en las que eres árbitro')}</h3><div class="list">{other.map((t) => <TradeRow key={t.id} t={t} />)}</div></>}
        </>
      )}
      <div class="card form">
        <h3>{ann ? T('Your arbiter profile', 'Tu perfil de árbitro') : T('Become an arbiter', 'Hazte árbitro')}</h3>
        <p class="hint">{T('Arbiters hold one of the three keys of every escrow they are picked for, and read the encrypted chat of those trades. They only sign when buyer and seller disagree. Your escrow key is derived from your Nostr key, so keep that backed up.', 'Los árbitros tienen una de las tres claves de cada escrow para el que se les elige y leen el chat cifrado de esas compras. Solo firman cuando comprador y vendedor no se ponen de acuerdo. Tu clave de escrow se deriva de tu clave Nostr, así que guarda una copia de ella.')}</p>
        <Field label={T('Name', 'Nombre')}><input value={f.name} onInput={set('name')} /></Field>
        <Field label={T('About you', 'Sobre ti')}><textarea rows="3" value={f.about} onInput={set('about')} /></Field>
        <Field label={T('Languages', 'Idiomas')}><input value={f.languages} onInput={set('languages')} placeholder="NL, EN, DE" /></Field>
        <Field label={T('Your fee (% of the escrow)', 'Tu comisión (% del escrow)')} hint={T(`Only when you rule in a dispute; 0 to ${MAX_ARBITER_FEE_PCT}%. Buyers see it when they pick an arbiter. When you propose a ruling, the app adds your fee as a separate output to a new address from your wallet (Account → Trading).`, `Solo cuando resuelves una disputa; de 0 a ${MAX_ARBITER_FEE_PCT}%. Los compradores la ven al elegir árbitro. Al proponer una resolución, la app añade tu comisión como salida aparte a una dirección nueva de tu cartera (Cuenta → Compraventa).`)}>
          <input inputmode="decimal" value={f.feePct} onInput={set('feePct')} class={pctOk ? '' : 'invalid'} />
        </Field>
        {pct > 0 && !payout && <p class="notice warn small">{T('Add your wallet key (or a payout address) under Account → Trading to receive your fee.', 'Añade la clave de tu cartera (o una dirección de cobro) en Cuenta → Compraventa para recibir tu comisión.')} <a href="#/settings?open=trading">→</a></p>}
        <p class="small muted">{T('Escrow base key', 'Clave base del escrow')}: <code class="break">{myArbiterBase()}</code></p>
        <div class="row">
          <Action class="primary" disabled={!pctOk || !f.name.trim()} onClick={async () => { await announceArbiter({ ...f, feePct: pct }); await loadDirectory(); toast(T('Published', 'Publicado'), 'ok'); }}>{ann ? T('Update', 'Actualizar') : T('Publish arbiter profile', 'Publicar perfil de árbitro')}</Action>
          {ann && <Action class="danger ghost" confirm={T('Stop being available as arbiter for new trades?', '¿Dejar de estar disponible como árbitro para nuevas compras?')} onClick={async () => { await announceArbiter({ ...f, feePct: pct, active: false }); await loadDirectory(); }}>{T('Retire', 'Retirarse')}</Action>}
        </div>
      </div>
    </div>
  );
}
