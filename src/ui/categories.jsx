import { useEffect, useMemo, useState } from 'preact/hooks';
import { CATEGORY_LIST, loadCategoryTree } from '../lib/categories.js';
import { T, lang } from './i18n.js';

// The subcategory tree once loaded (null until then), with the models (third
// level) and the category search, which load with it.
let extras = null;
const loadExtras = () => (extras ||= Promise.all([import('../lib/category-models.js'), import('../lib/category-search.js'), import('../lib/category-synonyms/index.js')])
  .then(([m, s, syn]) => ({ MODELS: m.MODELS, searchCategories: (q, tree, l) => s.searchCategories(q, tree, l, syn.SYNONYMS) })));

export function useCategoryTree() {
  const [tree, setTree] = useState(null);
  useEffect(() => { let live = true; Promise.all([loadCategoryTree(), loadExtras()]).then(([t, x]) => { if (live) { t.extras = x; setTree(t); } }); return () => { live = false; }; }, []);
  return tree;
}

const pick = (row) => (lang() === 'es' ? row[3] || row[2] : row[2]);

export function subcategoryLabel(tree, category, sub) {
  const row = tree?.get(category)?.find((c) => c[0] === sub);
  return row ? pick(row) : '';
}

export const modelsFor = (tree, category, sub) => (sub && tree?.extras?.MODELS[`${category}/${sub}`]) || [];
export const modelLabel = (tree, category, sub, model) => modelsFor(tree, category, sub).find((m) => m[0] === model)?.[1] || '';

export function SubcategoryLabel({ category, sub, model }) {
  const tree = useCategoryTree();
  if (!sub) return null;
  const s = subcategoryLabel(tree, category, sub);
  const m = model && model !== 'other' ? modelLabel(tree, category, sub, model) : '';
  return s ? (m ? `${s} › ${m}` : s) : null;
}

// Type a few words, pick a category: for when you do not know where to look.
function CategorySearch({ tree, onPick }) {
  const [q, setQ] = useState('');
  const hits = useMemo(() => (q.trim().length >= 2 && tree?.extras ? tree.extras.searchCategories(q, tree, lang()) : []), [q, tree]);
  return (
    <div class="cat-search">
      <input type="search" value={q} onInput={(e) => setQ(e.target.value)} placeholder={T('🔎 Search a category, e.g. "ssd" or "winter coat"', '🔎 Busca una categoría, p. ej. «ssd» o «abrigo»')} aria-label={T('Search a category', 'Buscar una categoría')} />
      {q.trim().length >= 2 && (
        <div class="cat-hits">
          {hits.length ? hits.map((h) => (
            <button type="button" key={`${h.category}/${h.subcategory}/${h.model}`} class="cat-hit" onClick={() => { onPick(h); setQ(''); }}>{h.label.join(' › ')}</button>
          )) : <span class="muted small">{T('No category found. Try another word, or pick from the lists.', 'No se ha encontrado ninguna categoría. Prueba otra palabra o elige de las listas.')}</span>}
        </div>
      )}
    </div>
  );
}

// Category, subcategory and (for cars and motorbikes) model, Marktplaats style,
// in Marktplaats order. `any` adds "all" options (filters).
export function CategoryPicker({ category, subcategory, model, onChange, any = false }) {
  const tree = useCategoryTree();
  const subs = (category && tree?.get(category)) || [];
  const models = modelsFor(tree, category, subcategory);
  return (
    <>
      {!any && <CategorySearch tree={tree} onPick={(h) => onChange({ category: h.category, subcategory: h.subcategory, model: h.model })} />}
      <select value={category || ''} onChange={(e) => onChange({ category: e.target.value, subcategory: '', model: '' })} aria-label={T('Category', 'Categoría')}>
        {any && <option value="">{T('All categories', 'Todas las categorías')}</option>}
        {CATEGORY_LIST.map((row) => <option key={row[0]} value={row[0]}>{pick(row)}</option>)}
      </select>
      {category && (
        <select value={subcategory || ''} onChange={(e) => onChange({ category, subcategory: e.target.value, model: '' })} aria-label={T('Subcategory', 'Subcategoría')} disabled={!tree}>
          <option value="">{any ? T('All subcategories', 'Todas las subcategorías') : T('Choose a subcategory…', 'Elige una subcategoría…')}</option>
          {subs.map((row) => <option key={row[0]} value={row[0]}>{pick(row)}</option>)}
        </select>
      )}
      {models.length > 0 && (
        <select value={model || ''} onChange={(e) => onChange({ category, subcategory, model: e.target.value })} aria-label={T('Model', 'Modelo')}>
          <option value="">{any ? T('All models', 'Todos los modelos') : T('Choose a model…', 'Elige un modelo…')}</option>
          {models.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          <option value="other">{T('Other model', 'Otro modelo')}</option>
        </select>
      )}
    </>
  );
}
