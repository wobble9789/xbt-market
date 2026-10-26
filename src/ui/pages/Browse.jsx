import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { market } from '../../lib/market.js';
import { account, npub } from '../../lib/nostr/account.js';
import { follows } from '../../lib/nostr/follows.js';
import { usernamesEnabled, searchUsernames, cleanUsername } from '../../lib/nostr/names.js';
import { searchCachedProfiles } from '../../lib/nostr/profiles.js';
import { blocks, blockCounts, loadBlockCounts, suspension } from '../../lib/nostr/moderation.js';
import { directory, sharedArbiters } from '../../lib/nostr/directory.js';
import { CONDITIONS } from '../../lib/nostr/listings.js';
import { offersPickup, shipCarriers } from '../../lib/shipping.js';
import { shipsToCountry } from '../../lib/countries.js';
import { settings } from '../../lib/settings.js';
import { T, CONDITION_LABELS, label, timeAgo, countryName } from '../i18n.js';
import { ListingPrice, Name, Img, Empty, Spinner, Avatar, useRates } from '../components.jsx';
import { CountrySelect } from '../countries.jsx';
import { CategoryPicker } from '../categories.jsx';

export function ListingCard({ l }) {
  return (
    <a class={`listing-card ${l.status !== 'active' ? 'st-' + l.status : ''}`} href={`#/l/${l.naddr}`}>
      <Img src={l.images[0]} alt={l.title} class="thumb" />
      {l.status === 'sold' && <span class="ribbon">{T('Sold', 'Vendido')}</span>}
      {l.status === 'reserved' && <span class="ribbon">{T('Reserved', 'Reservado')}</span>}
      <div class="body">
        <div class="title">{l.title}</div>
        <ListingPrice listing={l} />
        <div class="meta"><Name pk={l.pubkey} link={false} /><span class="muted small">{l.city || (l.country ? countryName(l.country) : l.location) || timeAgo(l.createdAt)}</span></div>
      </div>
    </a>
  );
}

const SORTS = [['new', ['Newest first', 'Más recientes']], ['old', ['Oldest first', 'Más antiguos']], ['price', ['Price: low to high', 'Precio: de menor a mayor']], ['-price', ['Price: high to low', 'Precio: de mayor a menor']]];
const FILTER_KEYS = ['c', 'sub', 'model', 'country', 'to', 'min', 'max', 'cond', 'del', 'pay', 'arb'];

function UserResults({ q }) {
  const [list, setList] = useState(null);
  const n = cleanUsername(q);
  useEffect(() => {
    setList(null);
    if (n.length < 2) return;
    // The username service when it is set up, and everyone already loaded.
    const t = setTimeout(async () => {
      const remote = usernamesEnabled() ? await searchUsernames(n).catch(() => []) : [];
      const seen = new Set(remote.map((u) => u.pubkey));
      setList([...remote, ...searchCachedProfiles(n).filter((u) => !seen.has(u.pubkey))]);
    }, 300);
    return () => clearTimeout(t);
  }, [n]);
  if (n.length < 2) return <Empty>{T('Type at least 2 letters of a username after the @.', 'Escribe al menos 2 letras de un nombre de usuario después de la @.')}</Empty>;
  if (!list) return <Empty><Spinner /></Empty>;
  if (!list.length) return <Empty>{T(`Nobody called @${n}…`, `Nadie llamado @${n}…`)}</Empty>;
  return (
    <div class="list">
      {list.map((u) => <a key={u.pubkey} class="trade-row" href={`#/u/${npub(u.pubkey)}`}><Avatar pk={u.pubkey} size={36} /><div class="grow"><b>@{u.name}</b><div class="small"><Name pk={u.pubkey} link={false} avatar={false} /></div></div></a>)}
    </div>
  );
}

export function Browse({ query }) {
  const { listings, loading } = useStore(market);
  const me = useStore(account, (a) => a.pubkey);
  const f = useStore(follows);
  const display = useStore(settings, (s) => s.currency);
  const blocked = useStore(blocks, (b) => b.set);
  const dir = useStore(directory);
  const { counts } = useStore(blockCounts);
  const [q, setQ] = useState(query.q || '');
  const [flt, setFlt] = useState(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, query[k] || ''])));
  const [sort, setSort] = useState(query.sort || 'new');
  const [tab, setTab] = useState(query.tab || 'all');
  const [open, setOpen] = useState(false);
  const setF = (patch) => setFlt((cur) => ({ ...cur, ...patch }));
  const active = FILTER_KEYS.filter((k) => flt[k]).length;

  // Keep the filters in the address, so "back" from a listing restores them.
  useEffect(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    for (const k of FILTER_KEYS) if (flt[k]) p.set(k, flt[k]);
    if (sort !== 'new') p.set('sort', sort);
    if (tab !== 'all') p.set('tab', tab);
    const h = '#/' + (p.toString() ? '?' + p : '');
    if (location.hash !== h && (location.hash || '#/').startsWith('#/') && !location.hash.slice(2).split('?')[0]) history.replaceState(null, '', h);
  }, [q, flt, sort, tab]);

  const visible = [...listings.values()].filter((l) => l.status === 'active' || l.status === 'reserved');
  useEffect(() => { loadBlockCounts([...new Set(visible.map((l) => l.pubkey))]); }, [listings]);
  // Hidden: people I blocked, and accounts that are inactive.
  const all = visible.filter((l) => l.pubkey === me || (!blocked.has(l.pubkey) && !suspension(l.pubkey, dir, counts)));
  const rates = useRates([display, ...all.map((l) => l.currency)]);
  const inDisplay = (l) => {
    if (l.currency === display) return l.price;
    const coin = l.currency === 'XBT' || l.currency === 'BTCB2';
    if (coin) return rates[display] ? l.price * rates[display] : null;
    return rates[l.currency] && rates[display] ? (l.price / rates[l.currency]) * rates[display] : null;
  };

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = all;
    if (tab === 'following') list = list.filter((l) => f.set.has(l.pubkey));
    if (flt.c) list = list.filter((l) => l.category === flt.c);
    if (flt.sub) list = list.filter((l) => l.subcategory === flt.sub);
    if (flt.model) list = list.filter((l) => l.model === flt.model);
    if (flt.country) list = list.filter((l) => l.country === flt.country);
    if (flt.cond) list = list.filter((l) => l.condition === flt.cond);
    if (flt.del === 'pickup') list = list.filter((l) => offersPickup(l));
    if (flt.del === 'ship') list = list.filter((l) => shipCarriers(l).length);
    if (flt.pay) list = list.filter((l) => l.payments.includes(flt.pay));
    // Escrow with an arbiter both sides trust.
    if (flt.arb) list = list.filter((l) => l.payments.includes('escrow') && sharedArbiters(l, dir, me).length);
    if (flt.to) list = list.filter((l) => shipCarriers(l).length && shipsToCountry(l.shipsTo, flt.to, l.country));
    const min = Number(flt.min) || 0;
    const max = Number(flt.max) || 0;
    if (min || max) list = list.filter((l) => { const v = inDisplay(l); return v != null && (!min || v >= min) && (!max || v <= max); });
    if (words.length) {
      list = list.filter((l) => {
        const hay = `${l.title} ${l.summary} ${l.content} ${l.location}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const price = (l) => inDisplay(l) ?? Infinity;
    const cmp = { new: (a, b) => b.createdAt - a.createdAt, old: (a, b) => a.createdAt - b.createdAt, price: (a, b) => price(a) - price(b), '-price': (a, b) => price(b) - price(a) }[sort];
    return [...list].sort(cmp);
  }, [listings, q, flt, sort, tab, f, rates, blocked, dir, counts]);

  // "@name" searches people; anything else searches listings.
  const userSearch = q.trim().startsWith('@');

  return (
    <div class="browse">
      {me && (
        <div class="tabs">
          <button class={`tab ${tab === 'all' ? 'on' : ''}`} onClick={() => setTab('all')}>{T('All listings', 'Todos los anuncios')}</button>
          <button class={`tab ${tab === 'following' ? 'on' : ''}`} onClick={() => setTab('following')}>{T('Following', 'Siguiendo')} {f.set.size ? <span class="muted">({f.set.size})</span> : null}</button>
        </div>
      )}
      <div class="searchbar">
        <input type="search" placeholder={T('Search listings, or @username…', 'Busca anuncios o @usuario…')} value={q} onInput={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label={T('Sort', 'Ordenar')}>
          {SORTS.map(([k, l]) => <option key={k} value={k}>{T(...l)}</option>)}
        </select>
        <button class={`btn ${active ? 'primary' : ''}`} onClick={() => setOpen(!open)}>⚙ {T('Filters', 'Filtros')}{active ? ` (${active})` : ''}</button>
      </div>
      {open && (
        <div class="card filters">
          <div class="cols">
            <CategoryPicker any category={flt.c} subcategory={flt.sub} model={flt.model} onChange={({ category, subcategory, model }) => setF({ c: category, sub: subcategory, model: model || '' })} />
          </div>
          <div class="cols">
            <label class="field"><span class="label">{T('Ships to', 'Envía a')}</span><CountrySelect value={flt.to} onChange={(to) => setF({ to })} placeholder={T('Anywhere', 'Cualquier destino')} /></label>
            <label class="field"><span class="label">{T('Pick-up country', 'País de recogida')}</span><CountrySelect value={flt.country} onChange={(country) => setF({ country })} placeholder={T('All countries', 'Todos los países')} /></label>
            <label class="field"><span class="label">{T(`Price (${display})`, `Precio (${display})`)}</span>
              <div class="row nomargin price-range"><input inputmode="decimal" placeholder={T('from', 'desde')} value={flt.min} onInput={(e) => setF({ min: e.target.value.replace(',', '.') })} /><span>–</span><input inputmode="decimal" placeholder={T('to', 'hasta')} value={flt.max} onInput={(e) => setF({ max: e.target.value.replace(',', '.') })} /></div>
            </label>
            <label class="field"><span class="label">{T('Condition', 'Estado')}</span>
              <select value={flt.cond} onChange={(e) => setF({ cond: e.target.value })}><option value="">{T('Any', 'Cualquiera')}</option>{CONDITIONS.map((c) => <option key={c} value={c}>{label(CONDITION_LABELS, c)}</option>)}</select>
            </label>
            <label class="field"><span class="label">{T('Delivery', 'Entrega')}</span>
              <select value={flt.del} onChange={(e) => setF({ del: e.target.value })}><option value="">{T('Any', 'Cualquiera')}</option><option value="ship">{T('Can be shipped', 'Con envío')}</option><option value="pickup">{T('Pick-up', 'Recogida')}</option></select>
            </label>
            <label class="field"><span class="label">{T('Payment', 'Pago')}</span>
              <select value={flt.pay} onChange={(e) => setF({ pay: e.target.value })}><option value="">{T('Any', 'Cualquiera')}</option><option value="lightning">Lightning</option><option value="onchain">On-chain</option><option value="escrow">Escrow</option></select>
            </label>
          </div>
          <label class={`choice ${flt.arb ? 'on' : ''}`}><input type="checkbox" checked={!!flt.arb} onChange={() => setF({ arb: flt.arb ? '' : '1' })} /><span>🛡 {T('Only show listings with shared trusted arbiters', 'Solo anuncios con árbitros de confianza en común')}</span></label>
          <div class="row">
            <button class="btn ghost" onClick={() => setFlt(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])))}>{T('Clear filters', 'Quitar filtros')}</button>
            <button class="btn primary" onClick={() => setOpen(false)}>{T(`Show ${shown.length} results`, `Ver ${shown.length} resultados`)}</button>
          </div>
        </div>
      )}
      {userSearch ? <UserResults q={q} />
        : loading && !shown.length ? <Empty><Spinner /> {T('Loading listings from relays…', 'Cargando anuncios de los relays…')}</Empty>
        : !shown.length ? <Empty>{tab === 'following' && !f.set.size ? T('You do not follow anyone yet. Open a seller\'s profile and tap Follow.', 'Aún no sigues a nadie. Abre el perfil de un vendedor y toca Seguir.') : <>{T('No listings found.', 'No se han encontrado anuncios.')} <a href="#/sell/new">{T('Sell something', 'Vende algo')}</a></>}</Empty>
        : <>
          <p class="muted small">{T(`${shown.length} listings`, `${shown.length} anuncios`)}</p>
          <div class="grid">{shown.map((l) => <ListingCard key={l.coord} l={l} />)}</div>
        </>}
    </div>
  );
}
