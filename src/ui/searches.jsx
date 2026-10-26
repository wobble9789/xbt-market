// Saved searches (like "opgeslagen zoekopdrachten"): save a search on the
// Browse page, get a notification for new listings, and manage them under
// Account. They follow the account to every device (lib/nostr/private.js).

import { useEffect, useState } from 'preact/hooks';
import { useStore, loadJSON, saveJSON } from '../lib/store.js';
import { market } from '../lib/market.js';
import { account } from '../lib/nostr/account.js';
import { directory, sharedArbiters } from '../lib/nostr/directory.js';
import { privateData, setPrivate, liveEntries } from '../lib/nostr/private.js';
import { settings } from '../lib/settings.js';
import { apiEnabled } from '../lib/api.js';
import { cleanSearch, matchesSearch, searchHash } from '../lib/search.js';
import { pushSupported, notificationsAllowed, notificationsBlocked, enableNotifications, syncPush, showNotification } from '../lib/push.js';
import { T, CATEGORY_LABELS, CONDITION_LABELS, label, countryName, fmtDate } from './i18n.js';
import { Action, Empty, toast, useRates } from './components.jsx';

const now = () => Math.floor(Date.now() / 1000);

export const useSavedSearches = () => {
  const data = useStore(privateData);
  return liveEntries('searches', data).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
};

// A short name for a search, from what it looks for.
export function searchName(s) {
  const parts = [];
  if (s.q) parts.push(`“${s.q}”`);
  if (s.c) parts.push(label(CATEGORY_LABELS, s.c));
  if (s.min || s.max) parts.push(`${s.cur || ''} ${s.min || '0'}–${s.max || '…'}`.trim());
  if (s.country) parts.push(countryName(s.country));
  if (s.to) parts.push(T(`ships to ${countryName(s.to)}`, `envía a ${countryName(s.to)}`));
  if (s.cond) parts.push(label(CONDITION_LABELS, s.cond));
  if (s.del) parts.push(s.del === 'ship' ? T('shipped', 'con envío') : T('pick-up', 'recogida'));
  if (s.pay) parts.push(s.pay === 'escrow' ? 'Escrow' : s.pay === 'lightning' ? 'Lightning' : 'On-chain');
  if (s.arb) parts.push(T('shared arbiters', 'árbitros en común'));
  return parts.join(' · ') || T('All listings', 'Todos los anuncios');
}

export function saveSearch(query) {
  const q = cleanSearch(query);
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  setPrivate('searches', id, { name: searchName(q), query: q, notify: true, seen: now(), createdAt: now() });
  return id;
}

export const updateSearch = (s, patch) => setPrivate('searches', s.id, { name: s.name, query: s.query, notify: s.notify, seen: s.seen, createdAt: s.createdAt, ...patch });
export const removeSearch = (s) => setPrivate('searches', s.id, null);

// Everything needed to match listings the way the Browse page does.
export function useMatcher() {
  const { listings } = useStore(market);
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  const display = useStore(settings, (s) => s.currency);
  const saved = liveEntries('searches', useStore(privateData));
  const all = [...listings.values()].filter((l) => l.status === 'active' || l.status === 'reserved');
  const rates = useRates([...new Set([display, ...saved.map((s) => s.query.cur).filter(Boolean), ...all.map((l) => l.currency)])]);
  const priceIn = (cur) => (l) => {
    const to = cur || display;
    if (l.currency === to) return l.price;
    const coin = (c) => c === 'XBT' || c === 'BTCB2';
    const xbtIn = (c) => (coin(c) ? 1 : rates[c]);
    return xbtIn(l.currency) && xbtIn(to) ? (l.price / xbtIn(l.currency)) * xbtIn(to) : null;
  };
  return (s, since = 0) => all.filter((l) => l.pubkey !== me && l.createdAt > since && matchesSearch(l, s.query, { priceIn: priceIn(s.query.cur), sharedArbiters: (x) => sharedArbiters(x, dir, me) }));
}

// Notification settings of this device, with the one button that matters.
export function DeviceNotifications() {
  const [, redraw] = useState(0);
  if (!pushSupported() && typeof Notification === 'undefined') {
    return <p class="notice small">{T('This browser cannot show notifications. On an iPhone or iPad: add XBT Market to your home screen first, then open it from there.', 'Este navegador no puede mostrar notificaciones. En iPhone o iPad: añade antes XBT Market a tu pantalla de inicio y ábrelo desde allí.')}</p>;
  }
  if (notificationsBlocked()) return <p class="notice warn small">{T('Notifications are blocked for this site. Allow them in your browser\'s site settings.', 'Las notificaciones están bloqueadas para este sitio. Permítelas en los ajustes del sitio de tu navegador.')}</p>;
  if (!notificationsAllowed()) {
    return (
      <div class="row">
        <Action class="primary small" onClick={async () => { await enableNotifications(); redraw((n) => n + 1); await syncPush(liveEntries('searches')).catch(() => {}); toast(T('Notifications on', 'Notificaciones activadas'), 'ok'); }}>🔔 {T('Turn on notifications on this device', 'Activar notificaciones en este dispositivo')}</Action>
      </div>
    );
  }
  return <p class="small ok-text">✓ {apiEnabled() ? T('Notifications are on for this device, also when XBT Market is closed.', 'Las notificaciones están activadas en este dispositivo, también con XBT Market cerrado.') : T('Notifications are on for this device, while XBT Market is open.', 'Las notificaciones están activadas en este dispositivo, mientras XBT Market esté abierto.')}</p>;
}

// Account → Saved searches.
export function SavedSearches() {
  const list = useSavedSearches();
  const match = useMatcher();
  return (
    <>
      <p class="hint">{T('Save a search on the Browse page with "🔔 Save search". You get a notification when a new listing matches it.', 'Guarda una búsqueda en la página de anuncios con «🔔 Guardar búsqueda». Recibes una notificación cuando un anuncio nuevo coincide.')}</p>
      <DeviceNotifications />
      {!list.length ? <Empty>{T('No saved searches yet.', 'Aún no hay búsquedas guardadas.')} <a href="#/">{T('Search listings', 'Buscar anuncios')}</a></Empty> : (
        <div class="list saved-searches">
          {list.map((s) => {
            const fresh = match(s, s.seen).length;
            return (
              <div class="trade-row saved-search" key={s.id}>
                <div class="grow">
                  <a href={searchHash(s.query, { saved: s.id })}><b>{s.name}</b></a>
                  <div class="muted small">{T('Saved', 'Guardada')} {fmtDate(s.createdAt)}</div>
                  {fresh > 0 && <a class="badge ok" href={searchHash(s.query, { saved: s.id, new: 1 })}>{T(`${fresh} new`, `${fresh} nuevos`)}</a>}
                </div>
                <label class="choice small-choice"><input type="checkbox" checked={!!s.notify} onChange={() => updateSearch(s, { notify: !s.notify })} /><span>🔔 {T('Notify', 'Avisar')}</span></label>
                <Action class="small ghost" title={T('Delete', 'Borrar')} confirm={T(`Delete the saved search "${s.name}"?`, `¿Borrar la búsqueda guardada «${s.name}»?`)} onClick={async () => removeSearch(s)}>🗑</Action>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// Runs in the app: keeps the device's push subscription in step with the saved
// searches, and notifies about new matches while the app is open (also the
// only way without the XBT Market service). One notification per search.
export function SavedSearchWatcher() {
  const pk = useStore(account, (a) => a.pubkey);
  const data = useStore(privateData);
  const list = liveEntries('searches', data);
  const match = useMatcher();
  const key = JSON.stringify(list.map((s) => [s.id, s.notify, s.query]));
  useEffect(() => {
    if (!pk || !data.loaded) return;
    const t = setTimeout(() => syncPush(list).catch(() => {}), 2000);
    return () => clearTimeout(t);
  }, [pk, data.loaded, key]);
  useEffect(() => {
    if (!pk) return;
    for (const s of list.filter((x) => x.notify)) {
      const k = `xbt:notified:${pk}:${s.id}`;
      const since = Math.max(loadJSON(k, 0), s.seen || 0);
      const fresh = match(s, since);
      if (!fresh.length) continue;
      saveJSON(k, Math.max(...fresh.map((l) => l.createdAt)));
      const title = T(`New for “${s.name}”`, `Nuevo para «${s.name}»`);
      const body = fresh.length === 1 ? fresh[0].title : T(`${fresh.length} new listings`, `${fresh.length} anuncios nuevos`);
      const url = './' + searchHash(s.query, { saved: s.id, new: 1 });
      if (document.visibilityState === 'visible') toast(`🔔 ${title}: ${body}`, 'ok', 8000);
      else showNotification(title, { body, tag: s.id, url }).catch(() => {});
    }
  });
  return null;
}

// On the Browse page: save this search, or show that it is saved.
export function SaveSearchButton({ query }) {
  const me = useStore(account, (a) => a.pubkey);
  const list = useSavedSearches();
  const q = cleanSearch(query);
  if (!me || !Object.keys(q).filter((k) => k !== 'cur').length) return null;
  const same = list.find((s) => JSON.stringify(cleanSearch(s.query)) === JSON.stringify(q));
  if (same) return <a class="btn small ghost" href="#/settings?open=searches">✓ {T('Saved search', 'Búsqueda guardada')}</a>;
  return (
    <Action class="small" onClick={async () => {
      saveSearch(q);
      if (!notificationsAllowed() && !notificationsBlocked() && typeof Notification !== 'undefined') {
        await enableNotifications().catch(() => {});
      }
      toast(notificationsAllowed() ? T('Saved. You get a notification for new listings.', 'Guardada. Recibirás una notificación de anuncios nuevos.') : T('Saved. Turn on notifications under Account → Saved searches.', 'Guardada. Activa las notificaciones en Cuenta → Búsquedas guardadas.'), 'ok');
    }}>🔔 {T('Save search', 'Guardar búsqueda')}</Action>
  );
}

// On the Browse page, opened from a notification or from "N new": only the
// listings since the last look, then that look is remembered.
export function useNewSince(savedId, onlyNew) {
  const data = useStore(privateData);
  const s = savedId ? liveEntries('searches', data).find((x) => x.id === savedId) : null;
  const [since, setSince] = useState(null);
  useEffect(() => {
    if (!s || since != null) return;
    setSince(onlyNew ? s.seen || 0 : 0);
    updateSearch(s, { seen: now() });
  }, [s?.id, data.loaded]);
  return { search: s, since: onlyNew ? since : 0 };
}

export function NewSinceBanner({ search, since, count }) {
  if (!search) return null;
  return (
    <div class="notice ok saved-banner">
      🔔 <b>{search.name}</b>{since ? <> · {T(`${count} new since ${fmtDate(since)}`, `${count} nuevos desde el ${fmtDate(since)}`)} · <a href={searchHash(search.query, { saved: search.id })}>{T('Show all listings for this search', 'Ver todos los anuncios de esta búsqueda')}</a></> : <> · {T('saved search', 'búsqueda guardada')}</>}
      {' · '}<a href="#/settings?open=searches">{T('Manage', 'Gestionar')}</a>
    </div>
  );
}


// On the Browse page: saved searches with new listings since the last look.
export function NewForYou() {
  const list = useSavedSearches();
  const match = useMatcher();
  const fresh = list.map((s) => [s, match(s, s.seen).length]).filter(([, n]) => n > 0);
  if (!fresh.length) return null;
  return (
    <div class="row new-for-you">
      <span class="small">🔔 {T('New for your saved searches:', 'Nuevo para tus búsquedas guardadas:')}</span>
      {fresh.map(([s, n]) => <a key={s.id} class="chip" href={searchHash(s.query, { saved: s.id, new: 1 })}>{s.name} <span class="badge ok">{n}</span></a>)}
    </div>
  );
}
