import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// base './' so the build works from any path (GitHub Pages, IPFS, a subfolder).
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: { target: 'es2022', sourcemap: true },
  server: { host: true },
});
