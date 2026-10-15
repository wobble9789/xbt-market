import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// CSP_CONNECT_EXTRA (space-separated sources) lets the phone demo reach the
// relay, node and photo server on this computer's network address. Normal
// builds leave it empty, so the policy stays as strict as before.
const cspExtra = {
  name: 'csp-connect-extra',
  transformIndexHtml: (html) => html.replace('%CSP_CONNECT_EXTRA%', process.env.CSP_CONNECT_EXTRA ? ' ' + process.env.CSP_CONNECT_EXTRA : ''),
};

// base './' so the build works from any path (GitHub Pages, IPFS, a subfolder).
export default defineConfig({
  base: './',
  plugins: [preact(), cspExtra],
  build: { target: 'es2022', sourcemap: true },
  server: { host: true },
});
