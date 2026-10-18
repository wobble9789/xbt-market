import { useEffect, useState } from 'preact/hooks';
import { useStore, loadJSON, saveJSON } from '../../lib/store.js';
import { account, toPubkey, npub } from '../../lib/nostr/account.js';
import { directory, publishConfig, loadDirectory, arbiterFeeLabel } from '../../lib/nostr/directory.js';
import { inbox, reportsIn } from '../../lib/nostr/inbox.js';
import { market } from '../../lib/market.js';
import { blockCounts, loadBlockCounts, suspension, BLOCK_LIMIT } from '../../lib/nostr/moderation.js';
import { T, timeAgo } from '../i18n.js';
import { Action, Name, Empty, toast, toastError } from '../components.jsx';
import { REASON_LABELS } from '../report.jsx';

const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const uniq = (a) => [...new Set(a)];

// Publishes the whole config with one list changed, so nothing else is lost.
async function saveConfig(patch, msg) {
  const cfg = directory.get().config || {};
  await publishConfig({ arbiters: cfg.arbiters || [], rejected: cfg.rejected || [], suspended: cfg.suspended || [], cleared: cfg.cleared || [], ...patch });
  await loadDirectory();
  toast(msg, 'ok');
}

function Arbiters({ dir }) {
  const cfg = dir.config || {};
  const approved = new Set(cfg.arbiters || []);
  const rejected = new Set(cfg.rejected || []);
  const anns = [...dir.announcements.values()].sort((a, b) => b.at - a.at);
  const pending = anns.filter((a) => !approved.has(a.pubkey) && !rejected.has(a.pubkey));
  const approve = (pk) => saveConfig({ arbiters: uniq([...approved, pk]), rejected: [...rejected].filter((x) => x !== pk) }, T('Approved', 'Aprobado'));
  const reject = (pk) => saveConfig({ arbiters: [...approved].filter((x) => x !== pk), rejected: uniq([...rejected, pk]) }, T('Rejected', 'Rechazado'));
  const Row = ({ pk, children }) => {
    const a = dir.announcements.get(pk);
    return (
      <div class="trade-row">
        <div class="grow"><Name pk={pk} /> {a ? <><b>{a.name}</b> <span class="muted small">{a.languages} · {arbiterFeeLabel(a)} · {timeAgo(a.at)}</span><div class="small">{a.about}</div></> : <span class="muted small">{T('no longer announced', 'ya no se presenta')}</span>}</div>
        <div class="row nomargin">{children}</div>
      </div>
    );
  };
  return (
    <>
      <p class="hint">{T('Approve only people you trust and who are known in the community. An approved arbiter colluding with one side can take the escrow.', 'Aprueba solo a personas de confianza y conocidas en la comunidad. Un árbitro aprobado que se confabule con una de las partes puede quedarse con el escrow.')}</p>
      <h3>{T('Waiting for approval', 'Pendientes de aprobación')} <span class="muted small">({pending.length})</span></h3>
      {pending.length ? <div class="list">{pending.map((a) => <Row key={a.pubkey} pk={a.pubkey}>
        <Action class="small primary" onClick={() => approve(a.pubkey)}>✓ {T('Approve', 'Aprobar')}</Action>
        <Action class="small ghost danger" onClick={() => reject(a.pubkey)}>✗ {T('Reject', 'Rechazar')}</Action>
      </Row>)}</div> : <Empty>{T('No new requests.', 'No hay solicitudes nuevas.')}</Empty>}
      <h3>{T('Approved arbiters', 'Árbitros aprobados')} <span class="muted small">({approved.size})</span></h3>
      {approved.size ? <div class="list">{[...approved].map((pk) => <Row key={pk} pk={pk}>
        <Action class="small ghost danger" confirm={T('Withdraw the approval? Running trades keep this arbiter; new trades cannot pick them.', '¿Retirar la aprobación? Las compras en curso mantienen a este árbitro; las nuevas no pueden elegirlo.')} onClick={() => reject(pk)}>{T('Withdraw approval', 'Retirar aprobación')}</Action>
      </Row>)}</div> : <Empty>{T('Nobody approved yet.', 'Nadie aprobado aún.')}</Empty>}
      <h3>{T('Rejected', 'Rechazados')} <span class="muted small">({rejected.size})</span></h3>
      {rejected.size ? <div class="list">{[...rejected].map((pk) => <Row key={pk} pk={pk}>
        <Action class="small" onClick={() => approve(pk)}>{T('Approve after all', 'Aprobar de todos modos')}</Action>
      </Row>)}</div> : <Empty>{T('Nobody rejected.', 'Nadie rechazado.')}</Empty>}
    </>
  );
}

function Accounts({ dir, reported }) {
  const cfg = dir.config || {};
  const { counts } = useStore(blockCounts);
  const { listings } = useStore(market);
  const [input, setInput] = useState('');
  const sellers = uniq([...listings.values()].map((l) => l.pubkey));
  useEffect(() => { loadBlockCounts([...sellers, ...reported, ...(cfg.suspended || []), ...(cfg.cleared || [])]); }, [listings, reported.length]);
  const suspended = cfg.suspended || [];
  const cleared = cfg.cleared || [];
  const autoInactive = [...counts].filter(([pk, n]) => n >= BLOCK_LIMIT && !suspended.includes(pk) && !cleared.includes(pk)).map(([pk]) => pk);
  const mostBlocked = [...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const suspend = (pk) => saveConfig({ suspended: uniq([...suspended, pk]), cleared: cleared.filter((x) => x !== pk) }, T('Account suspended', 'Cuenta suspendida'));
  const restore = (pk) => saveConfig({ suspended: suspended.filter((x) => x !== pk), cleared: uniq([...cleared, pk]) }, T('Account active again', 'Cuenta activa de nuevo'));
  const Row = ({ pk, children }) => <div class="trade-row"><div class="grow"><Name pk={pk} /> <span class="muted small">{T(`blocked by ${counts.get(pk) || 0}`, `bloqueada por ${counts.get(pk) || 0}`)}</span></div><div class="row nomargin">{children}</div></div>;
  return (
    <>
      <p class="hint">{T(`An account blocked by ${BLOCK_LIMIT} or more different people becomes inactive by itself: its listings are hidden and nobody can order from it. You can make it active again, or suspend any account yourself.`, `Una cuenta bloqueada por ${BLOCK_LIMIT} o más personas distintas queda inactiva sola: sus anuncios se ocultan y nadie puede hacerle pedidos. Puedes reactivarla o suspender tú cualquier cuenta.`)}</p>
      <div class="row">
        <input value={input} onInput={(e) => setInput(e.target.value)} placeholder="npub1…" />
        <Action class="danger" disabled={!input} onClick={async () => { let pk; try { pk = toPubkey(input); } catch { return toastError(new Error('Not an npub')); } await suspend(pk); setInput(''); }}>{T('Suspend', 'Suspender')}</Action>
      </div>
      <h3>{T('Inactive: too many blocks', 'Inactivas: demasiados bloqueos')} <span class="muted small">({autoInactive.length})</span></h3>
      {autoInactive.length ? <div class="list">{autoInactive.map((pk) => <Row key={pk} pk={pk}>
        <Action class="small" onClick={() => restore(pk)}>{T('Make active again', 'Reactivar')}</Action>
        <Action class="small danger ghost" onClick={() => suspend(pk)}>{T('Suspend for good', 'Suspender del todo')}</Action>
      </Row>)}</div> : <Empty>{T('None.', 'Ninguna.')}</Empty>}
      <h3>{T('Suspended by you', 'Suspendidas por ti')} <span class="muted small">({suspended.length})</span></h3>
      {suspended.length ? <div class="list">{suspended.map((pk) => <Row key={pk} pk={pk}><Action class="small" onClick={() => restore(pk)}>{T('Make active again', 'Reactivar')}</Action></Row>)}</div> : <Empty>{T('None.', 'Ninguna.')}</Empty>}
      {cleared.length > 0 && <>
        <h3>{T('Made active by you', 'Reactivadas por ti')} <span class="muted small">({cleared.length})</span></h3>
        <div class="list">{cleared.map((pk) => <Row key={pk} pk={pk}><Action class="small danger ghost" onClick={() => suspend(pk)}>{T('Suspend', 'Suspender')}</Action></Row>)}</div>
      </>}
      <h3>{T('Most blocked', 'Más bloqueadas')}</h3>
      {mostBlocked.length ? <div class="list">{mostBlocked.map(([pk]) => <Row key={pk} pk={pk}>{suspension(pk, dir, counts) ? <span class="badge warn">{T('inactive', 'inactiva')}</span> : null}</Row>)}</div> : <Empty>{T('Nobody is blocked.', 'Nadie está bloqueado.')}</Empty>}
    </>
  );
}

function Reports({ dir, reports }) {
  const [hidden, setHidden] = useState(() => new Set(loadJSON('xbt:admin:done', [])));
  const { counts } = useStore(blockCounts);
  const [showDone, setShowDone] = useState(false);
  const list = reports.filter((r) => showDone || !hidden.has(r.id));
  const done = (id) => { const n = new Set(hidden); n.add(id); setHidden(n); saveJSON('xbt:admin:done', [...n]); };
  const suspended = dir.config?.suspended || [];
  return (
    <>
      <label class="choice"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /><span>{T('Show handled reports too', 'Mostrar también las ya tratadas')}</span></label>
      {list.length ? <div class="list">{list.map((r) => {
        const b = parse(r.content);
        return (
          <div class="card" key={r.id}>
            <div class="row"><b>{T(...(REASON_LABELS[b.reason] || REASON_LABELS.other))}</b><span class="muted small">{timeAgo(r.created_at)}</span>{hidden.has(r.id) && <span class="badge">{T('handled', 'tratada')}</span>}</div>
            <p class="small">{T('About', 'Sobre')}: <Name pk={b.pk} /> <span class="muted">· {T(`blocked by ${counts.get(b.pk) || 0}`, `bloqueada por ${counts.get(b.pk) || 0}`)}</span></p>
            <p class="small">{T('From', 'De')}: <Name pk={r.pubkey} /></p>
            {b.text && <p class="quote">{b.text}</p>}
            {b.listing && <p class="small"><a href={`#/l/${b.listing}`}>{T('Listing', 'Anuncio')} →</a></p>}
            <div class="row">
              {suspended.includes(b.pk) ? <span class="badge warn">{T('suspended', 'suspendida')}</span>
                : <Action class="small danger" confirm={T('Suspend this account?', '¿Suspender esta cuenta?')} onClick={async () => { await saveConfig({ suspended: uniq([...suspended, b.pk]) }, T('Account suspended', 'Cuenta suspendida')); done(r.id); }}>{T('Suspend account', 'Suspender cuenta')}</Action>}
              {!hidden.has(r.id) && <button class="btn small ghost" onClick={() => done(r.id)}>{T('Mark as handled', 'Marcar como tratada')}</button>}
            </div>
          </div>
        );
      })}</div> : <Empty>{T('No reports.', 'No hay denuncias.')}</Empty>}
    </>
  );
}

function Bugs({ bugs }) {
  return bugs.length ? (
    <div class="list">{bugs.map((r) => {
      const b = parse(r.content);
      return (
        <div class="card" key={r.id}>
          <div class="row"><Name pk={r.pubkey} /><span class="muted small">{timeAgo(r.created_at)} · {b.page || '#/'}</span>{b.emailed ? <span class="badge ok">✉ {T('e-mailed with attachments', 'enviado por correo con adjuntos')}</span> : b.files?.length ? <span class="badge warn">{T('attachments not sent', 'adjuntos no enviados')}</span> : null}</div>
          <p class="quote">{b.text}</p>
          {b.files?.length > 0 && <p class="small muted">📎 {b.files.join(', ')}</p>}
          <p class="small muted">{b.ua}</p>
        </div>
      );
    })}</div>
  ) : <Empty>{T('No bug reports.', 'No hay informes de errores.')}</Empty>;
}

export function Admin() {
  const me = useStore(account, (a) => a.pubkey);
  const dir = useStore(directory);
  const { rumors } = useStore(inbox);
  const [tab, setTab] = useState('arbiters');
  if (!dir.admin) return <Empty>{T('No admin configured. Build with VITE_ADMIN_NPUB=npub… (see README).', 'No hay administrador configurado. Compila con VITE_ADMIN_NPUB=npub… (ver README).')}</Empty>;
  if (!dir.loaded) return <Empty>…</Empty>;
  if (dir.admin !== me) return <Empty>{T('Only the community admin can open this page.', 'Solo el administrador de la comunidad puede abrir esta página.')}</Empty>;
  const all = reportsIn(rumors);
  const reports = all.filter((r) => r.tags.some((t) => t[0] === 'xbt-report'));
  const bugs = all.filter((r) => r.tags.some((t) => t[0] === 'xbt-bug'));
  const pending = [...dir.announcements.keys()].filter((pk) => !(dir.config?.arbiters || []).includes(pk) && !(dir.config?.rejected || []).includes(pk)).length;
  const tabs = [
    ['arbiters', T('Arbiters', 'Árbitros'), pending],
    ['reports', T('Reports', 'Denuncias'), reports.filter((r) => !loadJSON('xbt:admin:done', []).includes(r.id)).length],
    ['accounts', T('Accounts', 'Cuentas'), 0],
    ['bugs', T('Bug reports', 'Errores'), 0],
  ];
  return (
    <div class="admin">
      <h2>🛠 Admin</h2>
      <div class="tabs">
        {tabs.map(([k, label, n]) => <button key={k} class={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{label}{n ? <span class="badge warn">{n}</span> : null}</button>)}
      </div>
      {tab === 'arbiters' && <Arbiters dir={dir} />}
      {tab === 'reports' && <Reports dir={dir} reports={reports} />}
      {tab === 'accounts' && <Accounts dir={dir} reported={uniq(reports.map((r) => parse(r.content).pk).filter(Boolean))} />}
      {tab === 'bugs' && <Bugs bugs={bugs} />}
      <p class="muted small">{T('Your admin key', 'Tu clave de admin')}: <code>{npub(me).slice(0, 20)}…</code></p>
    </div>
  );
}
