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
import { blocks, blockCounts, loadBlockCounts, suspension } from '../../lib/nostr/moderation.js';
import { directory } from '../../lib/nostr/directory.js';
import { ReportUser, BlockButton } from '../report.jsx';

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
  const [reporting, setReporting] = useState(false);
  const blocked = useStore(blocks, (b) => b.set.has(pk));
  const dir = useStore(directory);
  const { counts } = useStore(blockCounts);
  useEffect(() => { if (pk) { reviewsAbout(pk).then(setRep).catch(() => setRep({ reviews: [], count: 0 })); loadBlockCounts([pk]); } }, [pk]);
  const suspended = pk ? suspension(pk, dir, counts) : null;
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
            {links.other && (/^https?:\/\//.test(links.other) ? <a class="badge" href={links.other} target="_blank" rel="noopener noreferrer">{links.other.replace(/^https?:\/\//, '').slice(0, 40)}</a> : <span class="badge">{links.other}</span>)}
          </div>
          <div class="row">
            <FollowButton pk={pk} />
            {me === pk && <a class="btn small primary" href="#/settings?open=profile">✏️ {T('Edit profile', 'Editar perfil')}</a>}
            {me && me !== pk && <button class="btn small ghost" onClick={() => setReporting(!reporting)}>🚩 {T('Report', 'Denunciar')}</button>}
            <BlockButton pk={pk} />
          </div>
        </div>
        <div class="right">
          {rep ? <><Stars value={rep.avg} /><div class="small">{rep.verifiedTrades} {T('verified trades', 'compras verificadas')}</div><div class="small muted">{rep.count} {T('reviews', 'valoraciones')}{rep.negative ? ` · ${rep.negative} ${T('negative', 'negativas')}` : ''}</div></> : <Spinner />}
        </div>
      </div>
      {suspended && <p class="notice warn">⛔ {suspended === 'admin' ? T('This account has been suspended by the community admin.', 'El administrador de la comunidad ha suspendido esta cuenta.') : T('This account is inactive: too many people blocked it.', 'Esta cuenta está inactiva: demasiadas personas la han bloqueado.')}</p>}
      {blocked && <p class="notice small">{T('You blocked this user: their listings are hidden for you.', 'Has bloqueado a este usuario: sus anuncios están ocultos para ti.')}</p>}
      {reporting && <ReportUser pk={pk} onDone={() => setReporting(false)} />}
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
