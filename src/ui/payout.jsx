import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { settings } from '../lib/settings.js';
import { account } from '../lib/nostr/account.js';
import { secretNames } from '../lib/secrets.js';
import { isValidAddress } from '../lib/btc/address.js';
import { nextPayoutAddress, addressesInTrades, addressSeenBefore } from '../lib/payout.js';
import { useMyTrades } from './pages/Trades.jsx';
import { T } from './i18n.js';
import { Field, toastError } from './components.jsx';

// The address to suggest for a payout: a fresh one from the wallet key, or
// the fixed address from the settings. { address, index, fixed } or null.
export function usePayoutPick(active = true) {
  const trades = useMyTrades();
  const me = useStore(account, (a) => a.pubkey);
  const { names } = useStore(secretNames);
  const fixed = useStore(settings, (s) => s.payoutAddress);
  const known = useMemo(() => addressesInTrades(trades, me), [trades, me]);
  const knownKey = [...known].sort().join();
  const [pick, setPick] = useState(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    nextPayoutAddress(known)
      .then((p) => { if (live) setPick(p || (fixed ? { address: fixed, index: -1, fixed: true } : null)); })
      .catch((e) => { toastError(e); if (live) setPick(fixed ? { address: fixed, index: -1, fixed: true } : null); });
    return () => { live = false; };
  }, [active, knownKey, names.join(), fixed]);
  return pick;
}

// An XBT address field for a payout: pre-filled with a fresh address, with a
// warning when the address in it was used before.
export function PayoutInput({ pick, value, onChange, network, label, hint }) {
  const [seen, setSeen] = useState(false);
  useEffect(() => { if (pick && !value) onChange(pick.address); }, [pick?.address]);
  const ok = isValidAddress(value || '', network);
  useEffect(() => {
    setSeen(false);
    if (!ok) return;
    let live = true;
    const t = setTimeout(() => addressSeenBefore(value.trim()).then((u) => live && setSeen(u)), 400);
    return () => { live = false; clearTimeout(t); };
  }, [value, ok]);
  const fresh = pick && !pick.fixed && value?.trim() === pick.address;
  return (
    <Field label={label} hint={value && !ok ? T(`Not a valid address for ${network}`, `No es una dirección válida para ${network}`) : hint}>
      <input value={value} onInput={(e) => onChange(e.target.value)} placeholder="bc1q…" class={value && !ok ? 'invalid' : ''} />
      {fresh && <span class="small ok-text">✓ {T(`A new address from your wallet (#${pick.index}), used nowhere else.`, `Una dirección nueva de tu cartera (#${pick.index}), sin usar en ningún otro sitio.`)}</span>}
      {seen && <span class="small error">⚠ {T('This address has been used before. Others can then link your payments: use a new one from your wallet.', 'Esta dirección ya se ha usado. Así otros pueden relacionar tus pagos: usa una nueva de tu cartera.')}</span>}
      {!seen && pick?.fixed && value?.trim() === pick.address && <span class="small muted">{T('Your fixed address: every trade shows the same one. For a new address each time, add your wallet key under Account → Getting paid.', 'Tu dirección fija: cada compra muestra la misma. Para una nueva cada vez, añade la clave de tu cartera en Cuenta → Cobrar.')} <a href="#/settings?open=trading">→</a></span>}
    </Field>
  );
}
