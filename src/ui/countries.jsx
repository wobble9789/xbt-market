import { useMemo } from 'preact/hooks';
import { COUNTRIES } from '../lib/countries.js';
import { T, countryName, lang } from './i18n.js';

export function useSortedCountries() {
  const l = lang();
  return useMemo(() => COUNTRIES.map((c) => [c, countryName(c)]).sort((a, b) => a[1].localeCompare(b[1], l)), [l]);
}

export function CountrySelect({ value, onChange, required, placeholder, extra = [] }) {
  const list = useSortedCountries();
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} class={required && !value ? 'invalid' : ''}>
      <option value="">{placeholder || T('Choose a country…', 'Elige un país…')}</option>
      {extra.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      {list.map(([c, name]) => <option key={c} value={c}>{name} ({c})</option>)}
    </select>
  );
}

// "Ships to": EU, worldwide and/or single countries, as removable chips.
export function ShipsToPicker({ value = [], onChange }) {
  const add = (v) => { if (!v) return; onChange(v === 'WORLD' ? ['WORLD'] : [...new Set([...value.filter((x) => x !== 'WORLD'), v])]); };
  return (
    <div class="ships-to">
      <div class="chips">
        {value.map((v) => <span key={v} class="chip">{countryName(v)}<button type="button" aria-label={T('Remove', 'Quitar')} onClick={() => onChange(value.filter((x) => x !== v))}>×</button></span>)}
        {!value.length && <span class="muted small">{T('Only pick-up / your own country', 'Solo recogida / tu propio país')}</span>}
      </div>
      <CountrySelect value="" onChange={add} placeholder={T('+ Add EU, worldwide or a country…', '+ Añadir UE, todo el mundo o un país…')}
        extra={[['EU', T('European Union (all EU countries)', 'Unión Europea (todos los países de la UE)')], ['WORLD', T('Worldwide', 'Todo el mundo')]]} />
    </div>
  );
}
