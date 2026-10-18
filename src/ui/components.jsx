import { useEffect, useState, useRef } from 'preact/hooks';
import qrcode from 'qrcode-generator';
import { createStore, useStore } from '../lib/store.js';
import { useProfile } from '../lib/nostr/profiles.js';
import { npub, shortNpub } from '../lib/nostr/account.js';
import { formatCoin, formatFiat } from '../lib/btc/units.js';
import { xbtPrice } from '../lib/price.js';
import { settings } from '../lib/settings.js';
import { T, PRICE_UNIT_LABELS, label } from './i18n.js';
import { CountrySelect } from './countries.jsx';

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
  return <button class="btn small ghost" onClick={copy} type="button">{done ? '✓' : label || T('Copy', 'Copiar')}</button>;
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

// Rates for several currencies at once: { EUR: 1 XBT in EUR, … } (missing until loaded).
export function useRates(currencies) {
  const { rates } = useStore(priceCache);
  const key = [...new Set(currencies)].sort().join(',');
  useEffect(() => {
    for (const c of key.split(',').filter(Boolean)) {
      if (c === 'XBT' || c === 'BTCB2' || rates[c] !== undefined) continue;
      priceCache.set((st) => ({ rates: { ...st.rates, [c]: null } }));
      xbtPrice(c).then((p) => priceCache.set((st) => ({ rates: { ...st.rates, [c]: p } }))).catch(() => {});
    }
  }, [key]);
  return Object.fromEntries(Object.entries(rates).filter(([, v]) => v).map(([k, v]) => [k, v.value]));
}

export function Coin({ sats, fiat = true }) {
  const cur = useStore(settings, (s) => s.currency);
  const rate = useRate(cur);
  return (
    <span class="coin">
      {formatCoin(sats)}
      {fiat && rate && <span class="muted"> ≈ {formatFiat((sats / 1e8) * rate.value, cur)}</span>}
    </span>
  );
}

// Converts an amount between two fiat currencies through the XBT rate of each.
export function useConvert(from, to) {
  const isCoin = (c) => c === 'XBT' || c === 'BTCB2';
  const a = useRate(isCoin(from) ? to : from);
  const b = useRate(to);
  if (from === to) return (x) => x;
  if (isCoin(from)) return b ? (x) => x * b.value : null;
  return a && b ? (x) => (x / a.value) * b.value : null;
}

// A listing price in the viewer's currency (converted when the listing uses
// another one), with the original price and the XBT equivalent.
export function ListingPrice({ listing, big }) {
  const display = useStore(settings, (s) => s.currency);
  const isCoin = listing.currency === 'XBT' || listing.currency === 'BTCB2';
  const rate = useRate(isCoin ? display : listing.currency);
  const convert = useConvert(listing.currency, display);
  const sats = isCoin ? Math.round(listing.price * 1e8) : rate ? Math.round((listing.price / rate.value) * 1e8) : null;
  const same = listing.currency === display;
  const unit = listing.priceUnit && <span> {label(PRICE_UNIT_LABELS, listing.priceUnit)}</span>;
  if (same || !convert) {
    return (
      <span class={`price ${big ? 'big' : ''}`}>
        {isCoin ? formatCoin(sats) : formatFiat(listing.price, listing.currency)}{unit}
        {!isCoin && sats != null && <span class="muted small"> ≈ {formatCoin(sats)}</span>}
      </span>
    );
  }
  return (
    <span class={`price ${big ? 'big' : ''}`}>
      ≈ {formatFiat(convert(listing.price), display)}{unit}
      <span class="muted small"> · {isCoin ? formatCoin(sats) : <>{formatFiat(listing.price, listing.currency)}{sats != null && <> ≈ {formatCoin(sats)}</>}</>}</span>
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

// `group`: several controls (chips, checkboxes) instead of one. A <label>
// would forward every click inside it to its first control.
export function Field({ label, hint, children, group = false }) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag class="field" role={group ? 'group' : undefined}>
      <span class="label">{label}</span>
      {children}
      {hint && <span class="hint">{hint}</span>}
    </Tag>
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

// ---- addresses ---------------------------------------------------------------

export const formatAddress = (a) => (typeof a === 'string' ? a : a ? [a.name, `${a.street || ''} ${a.number || ''}`.trim(), `${a.postalCode || ''} ${a.city || ''}`.trim(), a.country, a.phone, a.email].filter(Boolean).join('\n') : '');
export const addressComplete = (a) => !!(a && a.name && a.street && a.number && a.postalCode && a.city && a.country);

// A postal address, structured so a shipping label can be made from it.
export function AddressForm({ value, onChange, contact = true }) {
  const a = value || {};
  const set = (k) => (e) => onChange({ ...a, [k]: e.target.value });
  return (
    <div class="address-form">
      <Field label={T('Full name', 'Nombre completo')}><input value={a.name || ''} onInput={set('name')} autocomplete="name" /></Field>
      <div class="cols addr-street">
        <Field label={T('Street', 'Calle')}><input value={a.street || ''} onInput={set('street')} autocomplete="address-line1" /></Field>
        <Field label={T('Number', 'Número')}><input value={a.number || ''} onInput={set('number')} /></Field>
      </div>
      <div class="cols">
        <Field label={T('Postcode', 'Código postal')}><input value={a.postalCode || ''} onInput={set('postalCode')} autocomplete="postal-code" /></Field>
        <Field label={T('City', 'Ciudad')}><input value={a.city || ''} onInput={set('city')} autocomplete="address-level2" /></Field>
      </div>
      <Field label={T('Country', 'País')}><CountrySelect value={a.country} onChange={(country) => onChange({ ...a, country })} /></Field>
      {contact && (
        <div class="cols">
          <Field label={T('Phone (for the carrier)', 'Teléfono (para el transportista)')}><input type="tel" value={a.phone || ''} onInput={set('phone')} autocomplete="tel" /></Field>
          <Field label={T('Email (for tracking)', 'Email (para el seguimiento)')}><input type="email" value={a.email || ''} onInput={set('email')} autocomplete="email" /></Field>
        </div>
      )}
    </div>
  );
}
