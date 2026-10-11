import { useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { market, isVisible } from '../../lib/market.js';
import { CATEGORIES } from '../../lib/nostr/listings.js';
import { T, CATEGORY_LABELS, label, timeAgo } from '../i18n.js';
import { ListingPrice, Name, Img, Empty, Spinner } from '../components.jsx';

export function ListingCard({ l }) {
  return (
    <a class="listing-card" href={`#/l/${l.naddr}`}>
      <Img src={l.images[0]} alt={l.title} class="thumb" />
      <div class="body">
        <div class="title">{l.title}</div>
        <ListingPrice listing={l} />
        <div class="meta"><Name pk={l.pubkey} link={false} /><span class="muted small">{l.location || timeAgo(l.createdAt)}</span></div>
        {l.status !== 'active' && <span class="badge">{l.status}</span>}
      </div>
    </a>
  );
}

export function Browse({ query }) {
  const { listings, loading } = useStore(market);
  const [q, setQ] = useState(query.q || '');
  const [cat, setCat] = useState(query.c || '');
  const [sort, setSort] = useState('new');

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = [...listings.values()].filter(isVisible);
    if (cat) list = list.filter((l) => l.category === cat);
    if (words.length) {
      list = list.filter((l) => {
        const hay = `${l.title} ${l.summary} ${l.content} ${l.location}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    return list.sort(sort === 'new' ? (a, b) => b.createdAt - a.createdAt : (a, b) => a.price - b.price);
  }, [listings, q, cat, sort]);

  return (
    <div>
      <div class="searchbar">
        <input type="search" placeholder={T('Search listings…', 'Zoek advertenties…')} value={q} onInput={(e) => setQ(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">{T('All categories', 'Alle categorieën')}</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{label(CATEGORY_LABELS, c)}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="new">{T('Newest', 'Nieuwste')}</option>
          <option value="price">{T('Lowest price', 'Laagste prijs')}</option>
        </select>
      </div>
      {loading && !shown.length ? <Empty><Spinner /> {T('Loading listings from relays…', 'Advertenties laden van relays…')}</Empty>
        : !shown.length ? <Empty>{T('No listings found.', 'Geen advertenties gevonden.')} <a href="#/sell/new">{T('Be the first to sell something', 'Zet als eerste iets te koop')}</a></Empty>
        : <div class="grid">{shown.map((l) => <ListingCard key={l.coord} l={l} />)}</div>}
    </div>
  );
}
