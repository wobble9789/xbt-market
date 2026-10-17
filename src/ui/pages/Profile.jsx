import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { market } from '../../lib/market.js';
import { account, toPubkey, npub, shortNpub } from '../../lib/nostr/account.js';
import { useProfile } from '../../lib/nostr/profiles.js';
import { useUsername } from '../../lib/nostr/names.js';
import { follows, follow, unfollow } from '../../lib/nostr/follows.js';
import { reviewsAbout } from '../../lib/nostr/reviews.js';
import { T, timeAgo, countryName } from '../i18n.js';
import { Avatar, Name, Stars, Empty, Spinner, Copy, Action } from '../components.jsx';
import { ListingCard } from './Browse.jsx';
import { EditProfile } from './EditProfile.jsx';

export function FollowButton({ pk }) {
  const me = useStore(account, (a) => a.pubkey);
  const f = useStore(follows);
  if (!me || me === pk) return null;
  const on = f.set.has(pk);
  return on
    ? <Action class="small" onClick={() => unfollow(pk)}>✓ {T('Following', 'Siguiendo')}</Action>
    : <Action class="small primary" onClick={() => follow(pk)}>+ {T('Follow', 'Seguir')}</Action>;
}

export function Profile({ id }) {
  const pk = useMemo(() => { try { return toPubkey(id); } catch { return null; } }, [id]);
  const me = useStore(account, (a) => a.pubkey);
  const profile = useProfile(pk);
  const user = useUsername(pk);
  const { listings } = useStore(market);
  const [rep, setRep] = useState(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (pk) reviewsAbout(pk).then(setRep).catch(() => setRep({ reviews: [], count: 0 })); }, [pk]);
  if (!pk) return <Empty>{T('Unknown user', 'Usuario desconocido')}</Empty>;
  const theirs = [...listings.values()].filter((l) => l.pubkey === pk).sort((a, b) => b.createdAt - a.createdAt);
  const active = theirs.filter((l) => l.status === 'active' || l.status === 'reserved');
  const sold = theirs.filter((l) => l.status === 'sold');
  const links = profile.xbt_market || {};
  return (
    <div>
      <div class="card profile-head">
        <Avatar pk={pk} size={64} />
        <div class="grow">
          <h2>{profile.display_name || profile.name || T('Anonymous', 'Anónimo')}</h2>
          {user && <div class="handle">{user.handle}</div>}
          <div class="muted small"><code>{shortNpub(pk)}</code> <Copy text={npub(pk)} label={T('Copy npub', 'Copiar npub')} /></div>
          {profile.about && <p>{profile.about}</p>}
          <div class="row small">
            {links.country && <span class="badge">📍 {countryName(links.country)}</span>}
            {links.marktplaats && <span class="badge">Marktplaats: {links.marktplaats}</span>}
            {links.vinted && <span class="badge">Vinted: {links.vinted}</span>}
            {links.ebay && <a class="badge" href={`https://www.ebay.com/usr/${encodeURIComponent(links.ebay)}`} target="_blank" rel="noopener noreferrer">eBay: {links.ebay}</a>}
          </div>
          <div class="row">
            <FollowButton pk={pk} />
            {me === pk && <button class="btn small primary" onClick={() => setEditing(!editing)}>✏️ {T('Edit profile', 'Editar perfil')}</button>}
          </div>
        </div>
        <div class="right">
          {rep ? <><Stars value={rep.avg} /><div class="small">{rep.verifiedTrades} {T('verified trades', 'compras verificadas')}</div><div class="small muted">{rep.count} {T('reviews', 'valoraciones')}{rep.negative ? ` · ${rep.negative} ${T('negative', 'negativas')}` : ''}</div></> : <Spinner />}
        </div>
      </div>
      {editing && <EditProfile pk={pk} profile={profile} onDone={() => setEditing(false)} />}
      <h3>{T('Listings', 'Anuncios')} <span class="muted small">({active.length})</span></h3>
      {active.length ? <div class="grid">{active.map((l) => <ListingCard key={l.coord} l={l} />)}</div> : <Empty>{T('No active listings.', 'No hay anuncios activos.')}</Empty>}
      {sold.length > 0 && <>
        <h3>{T('Sold', 'Vendidos')} <span class="muted small">({sold.length})</span></h3>
        <div class="grid sold">{sold.map((l) => <ListingCard key={l.coord} l={l} />)}</div>
      </>}
      <h3>{T('Reviews', 'Valoraciones')}</h3>
      {rep?.reviews?.length ? (
        <div class="list">
          {rep.reviews.map((r) => (
            <div class="card review" key={r.id}>
              <div class="row"><Stars value={r.rating} /> <Name pk={r.from} /> <span class="muted small">{r.role === 'buyer' ? T('as buyer', 'como comprador') : T('as seller', 'como vendedor')} · {timeAgo(r.at)}</span>{r.verified && <span class="badge ok">✓ {T('verified trade', 'compra verificada')}</span>}</div>
              {r.text && <p>{r.text}</p>}
            </div>
          ))}
        </div>
      ) : <Empty>{T('No reviews yet.', 'Aún no hay valoraciones.')}</Empty>}
    </div>
  );
}
