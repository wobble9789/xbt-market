import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../../lib/store.js';
import { account } from '../../lib/nostr/account.js';
import { directory, publishConfig, loadDirectory } from '../../lib/nostr/directory.js';
import { T, timeAgo } from '../i18n.js';
import { Action, Name, Empty, toast } from '../components.jsx';

export function Admin() {
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  const [approved, setApproved] = useState(() => new Set(dir.config?.arbiters || []));
  useEffect(() => { setApproved(new Set(dir.config?.arbiters || [])); }, [dir.config]);
  if (!dir.admin) return <Empty>{T('No admin configured. Build with VITE_ADMIN_NPUB=npub… (see README).', 'Geen beheerder ingesteld. Build met VITE_ADMIN_NPUB=npub… (zie README).')}</Empty>;
  if (!dir.loaded) return <Empty>…</Empty>;
  if (dir.admin !== me) return <Empty>{T('Only the community admin can open this page.', 'Alleen de community-beheerder kan deze pagina openen.')}</Empty>;
  const anns = [...dir.announcements.values()].sort((a, b) => b.at - a.at);
  const toggle = (pk) => { const n = new Set(approved); n.has(pk) ? n.delete(pk) : n.add(pk); setApproved(n); };
  return (
    <div>
      <h2>{T('Approve arbiters', 'Arbiters goedkeuren')}</h2>
      <p class="hint">{T('Approve only people you trust and who are known in the community. An approved arbiter colluding with one side can take the escrow.', 'Keur alleen mensen goed die je vertrouwt en die bekend zijn in de community. Een goedgekeurde arbiter die samenspant met één partij kan de escrow meenemen.')}</p>
      {anns.length ? (
        <div class="list">
          {anns.map((a) => (
            <label class="trade-row" key={a.pubkey}>
              <input type="checkbox" checked={approved.has(a.pubkey)} onChange={() => toggle(a.pubkey)} />
              <div class="grow"><Name pk={a.pubkey} /> <b>{a.name}</b> <span class="muted small">{a.languages} · {timeAgo(a.at)}</span><div class="small">{a.about}</div></div>
            </label>
          ))}
        </div>
      ) : <Empty>{T('Nobody has announced themselves as arbiter yet.', 'Nog niemand heeft zich als arbiter aangemeld.')}</Empty>}
      <Action class="primary" onClick={async () => { await publishConfig({ arbiters: [...approved] }); await loadDirectory(); toast(T('Arbiter list published', 'Arbiterlijst gepubliceerd'), 'ok'); }}>{T('Publish list', 'Lijst publiceren')} ({approved.size})</Action>
    </div>
  );
}
