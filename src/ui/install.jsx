import { useEffect, useState } from 'preact/hooks';
import { T } from './i18n.js';

// Which device and browser this is, to open the right install steps.
export function detectBrowser() {
  const ua = navigator.userAgent;
  const ipadOs = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || ipadOs) return { device: 'ios', browser: /CriOS/.test(ua) ? 'chrome' : /FxiOS/.test(ua) ? 'firefox' : 'safari' };
  if (/Android/.test(ua)) return { device: 'android', browser: /Firefox/.test(ua) ? 'firefox' : /SamsungBrowser/.test(ua) ? 'samsung' : 'chrome' };
  const browser = /Firefox/.test(ua) ? 'firefox' : /Edg\//.test(ua) ? 'edge' : /Safari/.test(ua) && !/Chrome|Chromium/.test(ua) ? 'safari' : 'chrome';
  if (/Mac OS X|Macintosh/.test(ua)) return { device: 'mac', browser };
  if (/Windows/.test(ua)) return { device: 'windows', browser };
  return { device: 'linux', browser };
}

const NO_INSTALL_FIREFOX = () => [T('Firefox on a computer cannot install web apps. Bookmark the page, or open it in Chrome or Edge to install it.', 'Firefox en el ordenador no puede instalar apps web. Guarda la página en marcadores o ábrela en Chrome o Edge para instalarla.')];
const CHROME_DESKTOP = () => [
  T('Click the install icon ⊕ at the right end of the address bar, then "Install".', 'Haz clic en el icono de instalar ⊕ al final de la barra de direcciones y luego en «Instalar».'),
  T('No icon? Menu ⋮ → "Cast, save and share" → "Install page as app".', '¿No hay icono? Menú ⋮ → «Enviar, guardar y compartir» → «Instalar página como aplicación».'),
];
const EDGE_DESKTOP = () => [
  T('Click the install icon ⊕ in the address bar, then "Install".', 'Haz clic en el icono de instalar ⊕ de la barra de direcciones y luego en «Instalar».'),
  T('No icon? Menu … → "Apps" → "Install this site as an app".', '¿No hay icono? Menú … → «Aplicaciones» → «Instalar este sitio como aplicación».'),
];

// Devices, most used first, each with its browsers, most used first.
const DEVICES = () => [
  ['ios', T('iPhone / iPad', 'iPhone / iPad'), [
    ['safari', 'Safari', [
      T('Tap the Share button □↑ (at the bottom on iPhone, at the top on iPad).', 'Toca el botón Compartir □↑ (abajo en el iPhone, arriba en el iPad).'),
      T('Scroll down and tap "Add to Home Screen", then "Add".', 'Desplázate y toca «Añadir a pantalla de inicio» y luego «Añadir».'),
    ]],
    ['chrome', 'Chrome', [
      T('Tap the Share button □↑ in the address bar.', 'Toca el botón Compartir □↑ de la barra de direcciones.'),
      T('Tap "Add to Home Screen", then "Add".', 'Toca «Añadir a pantalla de inicio» y luego «Añadir».'),
    ]],
    ['firefox', 'Firefox', [
      T('Tap the menu ≡ → Share → "Add to Home Screen".', 'Toca el menú ≡ → Compartir → «Añadir a pantalla de inicio».'),
      T('Does not work on an older iPhone? Use Safari.', '¿No funciona en un iPhone antiguo? Usa Safari.'),
    ]],
  ]],
  ['android', T('Android phone / tablet', 'Móvil / tableta Android'), [
    ['chrome', T('Chrome (also Vanadium, Brave)', 'Chrome (también Vanadium, Brave)'), [
      T('Tap the menu ⋮ at the top right.', 'Toca el menú ⋮ arriba a la derecha.'),
      T('Tap "Add to Home screen" or "Install app", then "Install".', 'Toca «Añadir a pantalla de inicio» o «Instalar aplicación» y luego «Instalar».'),
    ]],
    ['samsung', 'Samsung Internet', [
      T('Tap the menu ≡ at the bottom right.', 'Toca el menú ≡ abajo a la derecha.'),
      T('Tap "Add page to" → "Home screen".', 'Toca «Añadir página a» → «Pantalla de inicio».'),
    ]],
    ['firefox', 'Firefox', [
      T('Tap the menu ⋮.', 'Toca el menú ⋮.'),
      T('Tap "Add app to Home screen" or "Install".', 'Toca «Añadir app a la pantalla de inicio» o «Instalar».'),
    ]],
  ]],
  ['mac', 'Mac', [
    ['safari', 'Safari', [T('Menu File → "Add to Dock" → "Add".', 'Menú Archivo → «Añadir al Dock» → «Añadir».')]],
    ['chrome', 'Chrome', CHROME_DESKTOP()],
    ['edge', 'Edge', EDGE_DESKTOP()],
    ['firefox', 'Firefox', NO_INSTALL_FIREFOX()],
  ]],
  ['windows', T('Windows laptop / PC', 'Portátil / PC con Windows'), [
    ['chrome', 'Chrome', CHROME_DESKTOP()],
    ['edge', 'Edge', EDGE_DESKTOP()],
    ['firefox', 'Firefox', NO_INSTALL_FIREFOX()],
  ]],
  ['linux', 'Linux', [
    ['chrome', T('Chrome / Chromium', 'Chrome / Chromium'), CHROME_DESKTOP()],
    ['firefox', 'Firefox', NO_INSTALL_FIREFOX()],
  ]],
];

export function InstallGuide({ open }) {
  const [prompt, setPrompt] = useState(null);
  const standalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  const mine = detectBrowser();
  useEffect(() => {
    const f = (e) => { e.preventDefault(); setPrompt(e); };
    addEventListener('beforeinstallprompt', f);
    return () => removeEventListener('beforeinstallprompt', f);
  }, []);
  return (
    <details class="card collapsible install-guide" open={open}>
      <summary><h3>📲 {T('Install as an app', 'Instalar como app')}</h3>{standalone ? <span class="badge ok">✓ {T('installed', 'instalada')}</span> : <span class="muted small">{T('open it from your home screen', 'ábrela desde tu pantalla de inicio')}</span>}</summary>
      <p class="hint">{T('Opens full screen from your home screen, like a normal app. Nothing to download from an app store.', 'Se abre a pantalla completa desde tu pantalla de inicio, como una app normal. No hace falta ninguna tienda de apps.')}</p>
      {prompt && <button class="btn primary" onClick={() => { prompt.prompt(); setPrompt(null); }}>📲 {T('Install now', 'Instalar ahora')}</button>}
      {DEVICES().map(([dev, name, browsers]) => (
        <details key={dev} class="install-device" open={dev === mine.device}>
          <summary><b>{name}</b>{dev === mine.device && <span class="badge">{T('this device', 'este dispositivo')}</span>}</summary>
          {browsers.map(([b, bname, steps]) => (
            <details key={b} class="install-steps" open={dev === mine.device && b === mine.browser}>
              <summary>{bname}{dev === mine.device && b === mine.browser && <span class="badge">{T('your browser', 'tu navegador')}</span>}</summary>
              <ol>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </details>
          ))}
        </details>
      ))}
    </details>
  );
}
