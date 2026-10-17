import { useEffect, useState } from 'preact/hooks';
import { CATEGORY_LIST, loadCategoryTree } from '../lib/categories.js';
import { T, lang } from './i18n.js';

// The subcategory tree once loaded (null until then).
export function useCategoryTree() {
  const [tree, setTree] = useState(null);
  useEffect(() => { let live = true; loadCategoryTree().then((t) => live && setTree(t)); return () => { live = false; }; }, []);
  return tree;
}

const pick = (row) => (lang() === 'es' ? row[3] || row[2] : row[2]);

export function subcategoryLabel(tree, category, sub) {
  const row = tree?.get(category)?.find((c) => c[0] === sub);
  return row ? pick(row) : '';
}

export function SubcategoryLabel({ category, sub }) {
  const tree = useCategoryTree();
  return sub ? subcategoryLabel(tree, category, sub) || null : null;
}

// Category and subcategory, Marktplaats style. `any` adds an "all" option (filters).
export function CategoryPicker({ category, subcategory, onChange, any = false }) {
  const tree = useCategoryTree();
  const subs = (category && tree?.get(category)) || [];
  const sorted = [...subs].sort((a, b) => pick(a).localeCompare(pick(b), lang()));
  return (
    <>
      <select value={category || ''} onChange={(e) => onChange({ category: e.target.value, subcategory: '' })} aria-label={T('Category', 'Categoría')}>
        {any && <option value="">{T('All categories', 'Todas las categorías')}</option>}
        {CATEGORY_LIST.map((row) => <option key={row[0]} value={row[0]}>{pick(row)}</option>)}
      </select>
      {category && (
        <select value={subcategory || ''} onChange={(e) => onChange({ category, subcategory: e.target.value })} aria-label={T('Subcategory', 'Subcategoría')} disabled={!tree}>
          <option value="">{any ? T('All subcategories', 'Todas las subcategorías') : T('Choose a subcategory…', 'Elige una subcategoría…')}</option>
          {sorted.map((row) => <option key={row[0]} value={row[0]}>{pick(row)}</option>)}
        </select>
      )}
    </>
  );
}
