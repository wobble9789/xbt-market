import { useEffect, useState } from 'preact/hooks';

function parse() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = h.split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function useRoute() {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const f = () => { setR(parse()); window.scrollTo(0, 0); };
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return r;
}

export const navigate = (to) => { location.hash = to.startsWith('#') ? to : '#' + to; };
