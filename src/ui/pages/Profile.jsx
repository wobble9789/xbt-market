import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { market, isVisible } from '../../lib/market.js';
import { account, toPubkey, npub } from '../../lib/nostr/account.js';
import { useProfile, saveProfile } from '../../lib/nostr/profiles.js';
import { reviewsAbout } from '../../lib/nostr/reviews.js';
import { T, timeAgo } from '../i18n.js';
import { Avatar, Name, Stars, Empty, Spinner, Copy, Action, Field, toast } from '../components.jsx';
import { ListingCard } from './Browse.jsx';

function EditProfile({ pk, profile }) {
  const [f, setF] = useState({ name: profile.name || '', about: profile.about || '', picture: profile.picture || '', vinted: profile.xbt_market?.vinted || '', ebay: profile.xbt_market?.ebay || '', country: profile.xbt_market?.country || '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div class="card form">
      <h3>{T('Edit profile', 'Profiel bewerken')}</h3>
      <Field label={T('Name', 'Naam')}><input value={f.name} onInput={set('name')} /></Field>
      <Field label={T('About', 'Over jou')}><textarea rows="3" value={f.about} onInput={set('about')} /></Field>
      <Field label={T('Picture URL', 'Profielfoto-URL')}><input value={f.picture} onInput={set('picture')} /></Field>
      <div class="cols">
        <Field label={T('Vinted username', 'Vinted-gebruikersnaam')}><input value={f.vinted} onInput={set('vinted')} /></Field>
        <Field label={T('eBay username', 'eBay-gebruikersnaam')}><input value={f.ebay} onInput={set('ebay')} /></Field>
        <Field label={T('Country', 'Land')}><input value={f.country} onInput={set('country')} placeholder="NL" /></Field>
      </div>
      <p class="hint">{T('Linking other marketplace accounts lets buyers check your history there too.', 'Door andere marktplaatsaccounts te koppelen kunnen kopers ook je geschiedenis daar bekijken.')}</p>
      <Action class="primary" onClick={async () => {
        await saveProfile(pk, { name: f.name, display_name: f.name, about: f.about, picture: f.picture, xbt_market: { vinted: f.vinted, ebay: f.ebay, country: f.country } });
        toast(T('Saved', 'Opgeslagen'), 'ok');
      }}>{T('Save profile', 'Profiel opslaan')}</Action>
    </div>
  );
}

export function Profile({ id }) {
  const pk = useMemo(() => { try { return toPubkey(id); } catch { return null; } }, [id]);
  const me = useStore(account, (a) => a.pubkey);
  const profile = useProfile(pk);
  const { listings } = useStore(market);
  const [rep, setRep] = useState(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (pk) reviewsAbout(pk).then(setRep).catch(() => setRep({ reviews: [], count: 0 })); }, [pk]);
  if (!pk) return <Empty>{T('Unknown user', 'Onbekende gebruiker')}</Empty>;
  const theirs = [...listings.values()].filter((l) => l.pubkey === pk && isVisible(l));
  const links = profile.xbt_market || {};
  return (
    <div>
      <div class="card profile-head">
        <Avatar pk={pk} size={64} />
        <div class="grow">
          <h2>{profile.display_name || profile.name || T('Anonymous', 'Anoniem')}</h2>
          <div class="muted small"><code>{npub(pk).slice(0, 20)}…</code> <Copy text={npub(pk)} label="npub" /></div>
          {profile.about && <p>{profile.about}</p>}
          <div class="row small">
            {links.vinted && <span class="badge">Vinted: {links.vinted}</span>}
            {links.ebay && <a class="badge" href={`https://www.ebay.com/usr/${encodeURIComponent(links.ebay)}`} target="_blank" rel="noopener noreferrer">eBay: {links.ebay}</a>}
            {links.country && <span class="badge">📍 {links.country}</span>}
          </div>
        </div>
        <div class="right">
          {rep ? <><Stars value={rep.avg} /><div class="small">{rep.verifiedTrades} {T('verified trades', 'geverifieerde trades')}</div><div class="small muted">{rep.count} {T('reviews', 'reviews')}{rep.negative ? ` · ${rep.negative} ${T('negative', 'negatief')}` : ''}</div></> : <Spinner />}
          {me === pk && <button class="btn small" onClick={() => setEditing(!editing)}>{T('Edit', 'Bewerken')}</button>}
        </div>
      </div>
      {editing && <EditProfile pk={pk} profile={profile} />}
      <h3>{T('Listings', 'Advertenties')}</h3>
      {theirs.length ? <div class="grid">{theirs.map((l) => <ListingCard key={l.coord} l={l} />)}</div> : <Empty>{T('No active listings.', 'Geen actieve advertenties.')}</Empty>}
      <h3>{T('Reviews', 'Reviews')}</h3>
      {rep?.reviews?.length ? (
        <div class="list">
          {rep.reviews.map((r) => (
            <div class="card review" key={r.id}>
              <div class="row"><Stars value={r.rating} /> <Name pk={r.from} /> <span class="muted small">{r.role === 'buyer' ? T('as buyer', 'als koper') : T('as seller', 'als verkoper')} · {timeAgo(r.at)}</span>{r.verified && <span class="badge ok">✓ {T('verified trade', 'geverifieerde trade')}</span>}</div>
              {r.text && <p>{r.text}</p>}
            </div>
          ))}
        </div>
      ) : <Empty>{T('No reviews yet.', 'Nog geen reviews.')}</Empty>}
    </div>
  );
}
