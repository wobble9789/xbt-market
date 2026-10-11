import { useEffect, useState, useRef } from 'preact/hooks';
import qrcode from 'qrcode-generator';
import { createStore, useStore } from '../lib/store.js';
import { useProfile } from '../lib/nostr/profiles.js';
import { npub, shortNpub } from '../lib/nostr/account.js';
import { formatCoin, formatFiat } from '../lib/btc/units.js';
import { xbtPrice } from '../lib/price.js';
import { settings } from '../lib/settings.js';
import { T } from './i18n.js';

// ---- toasts ------------------------------------------------------------------

export const toasts = createStore({ list: [] });
let toastId = 0;
export function toast(text, kind = 'info', ms = 5000) {
  const id = ++toastId;
  toasts.set((s) => ({ list: [...s.list, { id, text: String(text), kind }] }));
  setTimeout(() => toasts.set((s) => ({ list: s.list.filter((t) => t.id !== id) })), ms);
}
export const toastError = (e) => { console.error(e); toast(e?.message || String(e), 'error', 9000); };

export function Toasts() {
  const { list } = useStore(toasts);
  return <div class="toasts">{list.map((t) => <div key={t.id} class={`toast ${t.kind}`}>{t.text}</div>)}</div>;
}

// ---- buttons -----------------------------------------------------------------

export function Action({ onClick, children, class: cls = '', confirm, disabled, title }) {
  const [busy, setBusy] = useState(false);
  const run = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    try { await onClick(); } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  return <button class={`btn ${cls}`} onClick={run} disabled={busy || disabled} title={title}>{busy ? <span class="spinner" /> : null}{children}</button>;
}

export function Copy({ text, label }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { window.prompt('Copy:', text); }
  };
  return <button class="btn small ghost" onClick={copy} type="button">{done ? '✓' : label || T('Copy', 'Kopieer')}</button>;
}

// ---- people ------------------------------------------------------------------

export function Avatar({ pk, size = 28 }) {
  const p = useProfile(pk);
  const hue = pk ? parseInt(pk.slice(0, 4), 16) % 360 : 0;
  return p.picture
    ? <img class="avatar" src={p.picture} width={size} height={size} alt="" loading="lazy" referrerpolicy="no-referrer" />
    : <span class="avatar" style={{ width: `${size}px`, height: `${size}px`, background: `hsl(${hue} 55% 55%)` }} />;
}

export function Name({ pk, link = true, avatar = true }) {
  const p = useProfile(pk);
  const name = p.display_name || p.name || shortNpub(pk);
  const inner = <>{avatar && <Avatar pk={pk} size={20} />}<span>{name}</span></>;
  return link ? <a class="name" href={`#/u/${npub(pk)}`}>{inner}</a> : <span class="name">{inner}</span>;
}

// ---- money -------------------------------------------------------------------

const priceCache = createStore({ rates: {} });
export function useRate(currency = settings.get().currency) {
  const { rates } = useStore(priceCache);
  useEffect(() => {
    if (rates[currency] !== undefined) return;
    priceCache.set((s) => ({ rates: { ...s.rates, [currency]: null } }));
    xbtPrice(currency).then((p) => priceCache.set((s) => ({ rates: { ...s.rates, [currency]: p } }))).catch(() => {});
  }, [currency]);
  return rates[currency] || null;
}

export function Coin({ sats, fiat = true }) {
  const cur = settings.get().currency;
  const rate = useRate(cur);
  return (
    <span class="coin">
      {formatCoin(sats)}
      {fiat && rate && <span class="muted"> ≈ {formatFiat((sats / 1e8) * rate.value, cur)}</span>}
    </span>
  );
}

// A listing price, shown in its own currency plus the XBT equivalent.
export function ListingPrice({ listing, big }) {
  const isCoin = listing.currency === 'XBT' || listing.currency === 'BTCB2';
  const rate = useRate(isCoin ? settings.get().currency : listing.currency);
  const sats = isCoin ? Math.round(listing.price * 1e8) : rate ? Math.round((listing.price / rate.value) * 1e8) : null;
  return (
    <span class={`price ${big ? 'big' : ''}`}>
      {isCoin ? formatCoin(sats) : formatFiat(listing.price, listing.currency)}
      {!isCoin && sats != null && <span class="muted small"> ≈ {formatCoin(sats)}</span>}
    </span>
  );
}

// ---- misc --------------------------------------------------------------------

export function QR({ text, size = 200 }) {
  const ref = useRef();
  useEffect(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    ref.current.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div class="qr" ref={ref} style={{ width: `${size}px`, height: `${size}px` }} />;
}

export function Stars({ value }) {
  const v = Math.round(value || 0);
  return <span class="stars" title={value ? value.toFixed(1) : ''}>{'★'.repeat(v)}{'☆'.repeat(5 - v)}</span>;
}

export function Empty({ children }) {
  return <div class="empty">{children}</div>;
}

export function Field({ label, hint, children }) {
  return (
    <label class="field">
      <span class="label">{label}</span>
      {children}
      {hint && <span class="hint">{hint}</span>}
    </label>
  );
}

export function Img({ src, alt = '', class: cls }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <div class={`img-placeholder ${cls || ''}`}>📦</div>;
  return <img class={cls} src={src} alt={alt} loading="lazy" referrerpolicy="no-referrer" onError={() => setBad(true)} />;
}

export function Spinner() {
  return <span class="spinner" />;
}
