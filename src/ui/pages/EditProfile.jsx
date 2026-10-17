import { useState } from 'preact/hooks';
import { saveProfile } from '../../lib/nostr/profiles.js';
import { uploadImage } from '../../lib/nostr/blossom.js';
import { updateSettings } from '../../lib/settings.js';
import { T } from '../i18n.js';
import { Action, Field, Avatar, Spinner, toast, toastError } from '../components.jsx';
import { CountrySelect } from '../countries.jsx';

export function EditProfile({ pk, profile, onDone }) {
  const m = profile.xbt_market || {};
  const [f, setF] = useState({ name: profile.display_name || profile.name || '', about: profile.about || '', picture: profile.picture || '', vinted: m.vinted || '', ebay: m.ebay || '', marktplaats: m.marktplaats || '', country: m.country || '' });
  const [uploading, setUploading] = useState(false);
  // Functional updates: quick successive edits must never overwrite each other.
  const set = (k) => (e) => { const v = e.target.value; setF((cur) => ({ ...cur, [k]: v })); };
  const onFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try { setF((cur) => ({ ...cur, picture: '' })); const url = await uploadImage(file); setF((cur) => ({ ...cur, picture: url })); } catch (err) { toastError(err); } finally { setUploading(false); }
  };
  return (
    <div class="card form edit-profile">
      <h3>{T('Edit profile', 'Editar perfil')}</h3>
      <div class="row">
        {f.picture ? <img class="avatar" src={f.picture} width="56" height="56" alt="" referrerpolicy="no-referrer" /> : <Avatar pk={pk} size={56} />}
        <label class="btn small">{uploading ? <Spinner /> : '📷'} {T('Change photo', 'Cambiar foto')}<input type="file" accept="image/*" hidden onChange={onFile} /></label>
      </div>
      <Field label={T('Name', 'Nombre')}><input value={f.name} onInput={set('name')} maxLength={60} /></Field>
      <Field label={T('Country', 'País')} hint={T('Required. Buyers filter on it and it sets where you ship from.', 'Obligatorio. Los compradores filtran por él y determina desde dónde envías.')}>
        <CountrySelect value={f.country} onChange={(country) => setF((cur) => ({ ...cur, country }))} required />
      </Field>
      <Field label={T('About you', 'Sobre ti')}><textarea rows="3" value={f.about} onInput={set('about')} /></Field>
      <details>
        <summary class="small">{T('Your other marketplace accounts (optional)', 'Tus otras cuentas de compraventa (opcional)')}</summary>
        <div class="cols">
          <Field label="Marktplaats"><input value={f.marktplaats} onInput={set('marktplaats')} /></Field>
          <Field label="Vinted"><input value={f.vinted} onInput={set('vinted')} /></Field>
          <Field label="eBay"><input value={f.ebay} onInput={set('ebay')} /></Field>
        </div>
        <p class="hint">{T('Lets buyers check your history there too.', 'Así los compradores también pueden ver tu historial allí.')}</p>
      </details>
      <div class="row">
        <Action class="primary" disabled={!f.country || !f.name.trim() || uploading} onClick={async () => {
          await saveProfile(pk, { name: f.name.trim(), display_name: f.name.trim(), about: f.about, picture: f.picture, xbt_market: { ...m, vinted: f.vinted, ebay: f.ebay, marktplaats: f.marktplaats, country: f.country } });
          updateSettings({ country: f.country });
          toast(T('Profile saved', 'Perfil guardado'), 'ok');
          onDone?.();
        }}>{T('Save profile', 'Guardar perfil')}</Action>
        {onDone && <button class="btn ghost" onClick={onDone}>{T('Cancel', 'Cancelar')}</button>}
      </div>
      {!f.country && <p class="hint error">{T('Choose your country to save.', 'Elige tu país para guardar.')}</p>}
    </div>
  );
}
