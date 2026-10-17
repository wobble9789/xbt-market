import { useEffect, useState } from 'preact/hooks';
import { T } from './i18n.js';

// Which browser this is, to open the right install steps.
export function detectBrowser() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return /Firefox/.test(ua) ? 'android-firefox' : /SamsungBrowser/.test(ua) ? 'samsung' : 'android';
  if (/Firefox/.test(ua)) return 'desktop-firefox';
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return 'mac-safari';
  return 'desktop-chrome';
}

const STEPS = () => [
  ['android', 'Chrome (Android)', [
    T('Tap the menu ⋮ at the top right.', 'Toca el menú ⋮ arriba a la derecha.'),
    T('Tap "Add to Home screen" or "Install app".', 'Toca «Añadir a pantalla de inicio» o «Instalar aplicación».'),
    T('Confirm with "Install". The gold ₿² icon appears on your home screen.', 'Confirma con «Instalar». El icono dorado ₿² aparece en tu pantalla de inicio.'),
  ]],
  ['ios', 'Safari (iPhone / iPad)', [
    T('Open this page in Safari (not inside another app).', 'Abre esta página en Safari (no dentro de otra app).'),
    T('Tap the Share button □↑ at the bottom.', 'Toca el botón Compartir □↑ abajo.'),
    T('Scroll down and tap "Add to Home Screen", then "Add".', 'Desplázate y toca «Añadir a pantalla de inicio» y luego «Añadir».'),
  ]],
  ['samsung', 'Samsung Internet', [
    T('Tap the menu ≡ at the bottom right.', 'Toca el menú ≡ abajo a la derecha.'),
    T('Tap "Add page to" → "Home screen".', 'Toca «Añadir página a» → «Pantalla de inicio».'),
  ]],
  ['android-firefox', 'Firefox (Android)', [
    T('Tap the menu ⋮.', 'Toca el menú ⋮.'),
    T('Tap "Install" or "Add to Home screen".', 'Toca «Instalar» o «Añadir a pantalla de inicio».'),
  ]],
  ['desktop-chrome', 'Chrome / Edge (computer)', [
    T('Click the install icon ⊕ at the right end of the address bar.', 'Haz clic en el icono de instalar ⊕ al final de la barra de direcciones.'),
    T('Or open the menu ⋮ → "Cast, save and share" → "Install page as app".', 'O abre el menú ⋮ → «Enviar, guardar y compartir» → «Instalar página como aplicación».'),
  ]],
  ['mac-safari', 'Safari (Mac)', [
    T('Menu File → "Add to Dock".', 'Menú Archivo → «Añadir al Dock».'),
  ]],
  ['desktop-firefox', 'Firefox (computer)', [
    T('Firefox on a computer cannot install web apps. Bookmark the page, or use Chrome or Edge to install it.', 'Firefox en el ordenador no puede instalar apps web. Guarda la página en marcadores o usa Chrome o Edge para instalarla.'),
  ]],
];

export function InstallGuide() {
  const [prompt, setPrompt] = useState(null);
  const standalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  const mine = detectBrowser();
  useEffect(() => {
    const f = (e) => { e.preventDefault(); setPrompt(e); };
    addEventListener('beforeinstallprompt', f);
    return () => removeEventListener('beforeinstallprompt', f);
  }, []);
  const steps = STEPS();
  return (
    <details class="card collapsible install-guide">
      <summary><h3>📲 {T('Install as an app', 'Instalar como app')}</h3>{standalone && <span class="badge ok">✓ {T('installed', 'instalada')}</span>}</summary>
      <p class="hint">{T('Opens full screen from your home screen, like a normal app. Nothing to download from an app store.', 'Se abre a pantalla completa desde tu pantalla de inicio, como una app normal. No hace falta ninguna tienda de apps.')}</p>
      {prompt && <button class="btn primary" onClick={() => { prompt.prompt(); setPrompt(null); }}>📲 {T('Install now', 'Instalar ahora')}</button>}
      {[...steps.filter(([k]) => k === mine), ...steps.filter(([k]) => k !== mine)].map(([k, name, list]) => (
        <details key={k} class="install-steps" open={k === mine}>
          <summary>{name}{k === mine && <span class="badge">{T('your browser', 'tu navegador')}</span>}</summary>
          <ol>{list.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </details>
      ))}
    </details>
  );
}
