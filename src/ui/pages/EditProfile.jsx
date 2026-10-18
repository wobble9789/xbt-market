import { useEffect, useState } from 'preact/hooks';
import { saveProfile } from '../../lib/nostr/profiles.js';
import { uploadImage } from '../../lib/nostr/blossom.js';
import { useUsername, usernamesEnabled, claimUsername, checkUsername, cleanUsername, USERNAME_RE } from '../../lib/nostr/names.js';
import { apiDomain } from '../../lib/api.js';
import { updateSettings } from '../../lib/settings.js';
import { T } from '../i18n.js';
import { Action, Field, Avatar, Spinner, toast, toastError } from '../components.jsx';
import { CountrySelect } from '../countries.jsx';

// The name to start from: the claimed @username, else the profile name if it
// already is a valid username.
const startName = (profile, user) => user?.ours ? user.name : cleanUsername(profile.name || profile.display_name || '').replace(/[^a-z0-9_]/g, '').slice(0, 20);

// Your profile: photo, @username, country (required), about and your accounts
// on other marketplaces. The username is also your display name.
export function ProfileForm({ pk, profile, onDone }) {
  const m = profile.xbt_market || {};
  const user = useUsername(pk);
  const [f, setF] = useState(() => ({ username: startName(profile, user), about: profile.about || '', picture: profile.picture || '', vinted: m.vinted || '', ebay: m.ebay || '', marktplaats: m.marktplaats || '', other: m.other || '', country: m.country || '' }));
  const [touched, setTouched] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [check, setCheck] = useState(null);
  // The profile arrives from relays after the first render: fill in what is still empty.
  useEffect(() => {
    if (touched) return;
    const mm = profile.xbt_market || {};
    setF((cur) => ({ ...cur, username: user?.ours ? user.name : cur.username || startName(profile, user), about: cur.about || profile.about || '', picture: cur.picture || profile.picture || '', vinted: cur.vinted || mm.vinted || '', ebay: cur.ebay || mm.ebay || '', marktplaats: cur.marktplaats || mm.marktplaats || '', other: cur.other || mm.other || '', country: cur.country || mm.country || '' }));
  }, [profile, user]);
  const n = cleanUsername(f.username);
  const valid = USERNAME_RE.test(n);
  const claimed = user?.ours && user.name === n;
  const online = usernamesEnabled();
  useEffect(() => {
    setCheck(null);
    if (!online || !valid || claimed) return;
    const t = setTimeout(() => checkUsername(n).then(setCheck).catch((e) => setCheck({ error: e.message })), 350);
    return () => clearTimeout(t);
  }, [n, claimed]);
  const taken = check && !check.error && !check.available && check.pubkey !== pk;
  // Functional updates: quick successive edits must never overwrite each other.
  const set = (k) => (e) => { const v = e.target.value; setTouched(true); setF((cur) => ({ ...cur, [k]: v })); };
  const onFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try { const url = await uploadImage(file); setTouched(true); setF((cur) => ({ ...cur, picture: url })); } catch (err) { toastError(err); } finally { setUploading(false); }
  };
  return (
    <div class="form edit-profile">
      <div class="row">
        {f.picture ? <img class="avatar" src={f.picture} width="56" height="56" alt="" referrerpolicy="no-referrer" /> : <Avatar pk={pk} size={56} />}
        <label class="btn small">{uploading ? <Spinner /> : '📷'} {T('Change photo', 'Cambiar foto')}<input type="file" accept="image/*" hidden onChange={onFile} /></label>
      </div>
      <Field label={T('Username', 'Nombre de usuario')} hint={online
        ? T(`Unique: people find you with @${n || 'name'}. Also your Nostr address ${n || 'name'}@${apiDomain()}.`, `Único: te encuentran con @${n || 'nombre'}. También es tu dirección Nostr ${n || 'nombre'}@${apiDomain()}.`)
        : T('People find you with @name in the search. 3 to 20 characters: a-z, 0-9 and _.', 'Te encuentran con @nombre en la búsqueda. De 3 a 20 caracteres: a-z, 0-9 y _.')}>
        <div class="row nomargin username-input"><span class="at">@</span><input value={f.username} onInput={(e) => { setTouched(true); const v = cleanUsername(e.target.value); setF((cur) => ({ ...cur, username: v })); }} autocapitalize="off" autocomplete="off" spellcheck={false} maxLength={20} class={f.username && (!valid || taken) ? 'invalid' : ''} /></div>
      </Field>
      {f.username && !valid && <span class="hint error">{T('3 to 20 characters: letters a-z, numbers and _', 'De 3 a 20 caracteres: letras a-z, números y _')}</span>}
      {claimed && <span class="hint ok-text">✓ {T('Your username', 'Tu nombre de usuario')}</span>}
      {check?.error && <span class="hint error">{check.error}</span>}
      {valid && check && !check.error && (taken ? <span class="hint error">✗ @{n} {T('is already taken', 'ya está en uso')}</span> : <span class="hint ok-text">✓ @{n} {T('is available', 'está disponible')}</span>)}
      <Field label={T('Country', 'País')} hint={T('Required. Buyers filter on it and it sets where you ship from.', 'Obligatorio. Los compradores filtran por él y determina desde dónde envías.')}>
        <CountrySelect value={f.country} onChange={(country) => { setTouched(true); setF((cur) => ({ ...cur, country })); }} required />
      </Field>
      <Field label={T('About you (optional)', 'Sobre ti (opcional)')}><textarea rows="3" value={f.about} onInput={set('about')} /></Field>
      <details>
        <summary class="small">{T('Your other marketplace accounts (optional)', 'Tus otras cuentas de compraventa (opcional)')}</summary>
        <div class="cols">
          <Field label="Marktplaats"><input value={f.marktplaats} onInput={set('marktplaats')} /></Field>
          <Field label="Vinted"><input value={f.vinted} onInput={set('vinted')} /></Field>
          <Field label="eBay"><input value={f.ebay} onInput={set('ebay')} /></Field>
          <Field label={T('Other', 'Otra')}><input value={f.other} onInput={set('other')} placeholder={T('e.g. a link to your shop', 'p. ej. un enlace a tu tienda')} /></Field>
        </div>
        <p class="hint">{T('Lets buyers check your history there too.', 'Así los compradores también pueden ver tu historial allí.')}</p>
      </details>
      <div class="row">
        <Action class="primary" disabled={!f.country || !valid || taken || uploading} onClick={async () => {
          if (online && !claimed) await claimUsername(pk, n);
          await saveProfile(pk, { name: n, display_name: n, about: f.about, picture: f.picture, xbt_market: { ...m, vinted: f.vinted, ebay: f.ebay, marktplaats: f.marktplaats, other: f.other, country: f.country } });
          updateSettings({ country: f.country });
          setTouched(false);
          toast(T('Profile saved', 'Perfil guardado'), 'ok');
          onDone?.();
        }}>{T('Save profile', 'Guardar perfil')}</Action>
        <a class="btn ghost" href={`#/u/${pk}`}>{T('View my profile', 'Ver mi perfil')}</a>
      </div>
      {(!f.country || !valid) && <p class="hint error">{T('Choose a username and your country to save.', 'Elige un nombre de usuario y tu país para guardar.')}</p>}
    </div>
  );
}
