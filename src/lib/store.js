// Tiny observable store with a Preact hook.
import { useEffect, useState } from 'preact/hooks';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      subs.forEach((f) => f(state));
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
}

export function useStore(store, select = (s) => s) {
  const [v, setV] = useState(() => select(store.get()));
  useEffect(() => {
    // The store may have changed between the first render and this effect;
    // pick that up, or the component would wait for the next change forever.
    setV(() => select(store.get()));
    return store.subscribe((s) => setV(() => select(s)));
  }, [store]);
  return v;
}

export function loadJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('storage', e); }
}
