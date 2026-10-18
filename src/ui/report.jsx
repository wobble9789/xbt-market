import { useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { account } from '../lib/nostr/account.js';
import { directory } from '../lib/nostr/directory.js';
import { blocks, block, unblock, reportUser, reportBug, REPORT_REASONS } from '../lib/nostr/moderation.js';
import { T } from './i18n.js';
import { Action, Field, toast } from './components.jsx';

export const REASON_LABELS = {
  scam: ['Scam or fraud', 'Estafa o fraude'],
  'no-delivery': ['Paid but nothing delivered', 'Pagado pero no entregado'],
  fake: ['Fake or counterfeit item', 'Artículo falso o imitación'],
  prohibited: ['Prohibited item', 'Artículo prohibido'],
  abuse: ['Abusive or threatening', 'Insultos o amenazas'],
  spam: ['Spam', 'Spam'],
  other: ['Something else', 'Otra cosa'],
};

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm,video/3gpp';

// A bug report with screenshots or a short video, sent to the maintainer.
export function BugReport() {
  const me = useStore(account, (a) => a.pubkey);
  const admin = useStore(directory, (d) => d.admin);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [sent, setSent] = useState(false);
  const size = files.reduce((n, f) => n + f.size, 0);
  const tooBig = size > 15 * 1024 * 1024;
  if (sent) return <p class="notice ok">✓ {T('Thank you! Your report was sent.', '¡Gracias! Tu informe se ha enviado.')} <button class="btn small ghost" onClick={() => { setSent(false); setText(''); setFiles([]); }}>{T('Report another', 'Informar de otro')}</button></p>;
  return (
    <div class="form">
      <Field label={T('What went wrong?', '¿Qué ha fallado?')} hint={T('What did you do, what did you expect, and what happened instead?', '¿Qué hiciste, qué esperabas y qué pasó en cambio?')}>
        <textarea rows="4" value={text} onInput={(e) => setText(e.target.value)} maxLength={5000} />
      </Field>
      <Field label={T('Screenshots or a video (optional)', 'Capturas o un vídeo (opcional)')} hint={T('jpg, png or a video (mp4, mov, webm); 15 MB at most in total.', 'jpg, png o un vídeo (mp4, mov, webm); 15 MB como máximo en total.')}>
        <input type="file" accept={ACCEPT} multiple onChange={(e) => setFiles([...e.target.files].slice(0, 5))} />
      </Field>
      {files.length > 0 && <p class={`small ${tooBig ? 'error' : 'muted'}`}>{files.map((f) => f.name).join(', ')} · {(size / 1024 / 1024).toFixed(1)} MB</p>}
      <Action class="primary" disabled={!me || text.trim().length < 5 || tooBig} onClick={async () => {
        const { emailed } = await reportBug(admin, { text, files, page: location.hash });
        if (!emailed && files.length) toast(T('Sent without the attachments: e-mail is not set up yet.', 'Enviado sin los adjuntos: el correo aún no está configurado.'), 'warn');
        setSent(true);
      }}>{T('Send report', 'Enviar informe')}</Action>
      {!me && <p class="hint">{T('Log in to send a report.', 'Inicia sesión para enviar un informe.')}</p>}
    </div>
  );
}

// Report a user to the admin, privately.
export function ReportUser({ pk, listing, onDone }) {
  const admin = useStore(directory, (d) => d.admin);
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  if (!admin) return <p class="notice warn">{T('Reports are not set up for this app (no admin).', 'Los informes no están configurados en esta app (no hay administrador).')}</p>;
  return (
    <div class="card form">
      <h3>🚩 {T('Report this user', 'Denunciar a este usuario')}</h3>
      <p class="hint">{T('Goes privately to the community admin. The user does not see who reported them.', 'Va en privado al administrador de la comunidad. El usuario no ve quién le ha denunciado.')}</p>
      <div class="choices">
        {REPORT_REASONS.map((r) => <label key={r} class={`choice ${reason === r ? 'on' : ''}`}><input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} /><span>{T(...REASON_LABELS[r])}</span></label>)}
      </div>
      <Field label={T('What happened? (optional)', '¿Qué pasó? (opcional)')}><textarea rows="3" value={text} onInput={(e) => setText(e.target.value)} maxLength={2000} /></Field>
      <div class="row">
        <Action class="primary" disabled={!reason} onClick={async () => { await reportUser(admin, pk, { reason, text, listing }); toast(T('Report sent. Thank you.', 'Denuncia enviada. Gracias.'), 'ok'); onDone?.(); }}>{T('Send report', 'Enviar denuncia')}</Action>
        <button class="btn ghost" onClick={onDone}>{T('Cancel', 'Cancelar')}</button>
      </div>
    </div>
  );
}

export function BlockButton({ pk }) {
  const me = useStore(account, (a) => a.pubkey);
  const b = useStore(blocks);
  if (!me || me === pk) return null;
  return b.set.has(pk)
    ? <Action class="small" onClick={() => unblock(pk)}>{T('Unblock', 'Desbloquear')}</Action>
    : <Action class="small ghost danger" confirm={T('Block this user? You no longer see their listings, and they cannot order from you.', '¿Bloquear a este usuario? Ya no verás sus anuncios y no podrá hacerte pedidos.')} onClick={() => block(pk)}>⛔ {T('Block', 'Bloquear')}</Action>;
}
