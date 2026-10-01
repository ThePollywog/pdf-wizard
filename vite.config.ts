import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// PDF Wizard is a static site: `npm run build` writes dist/, which any static host (S3 + CloudFront,
// an intranet web server, a file share behind IIS…) can serve. There is no backend.
//
// Env knobs:
//   BASE_PATH      - URL path the site is served from (default '/'). GitHub Pages project sites live
//                    under '/<repo>/'; the deploy workflow sets it from actions/configure-pages.
//   PORT           - dev server port (default 5173)  (these three help run dev servers side by side)
//   VITE_CACHE_DIR - dependency pre-bundle cache dir (default node_modules/.vite)
//   VITE_NO_WATCH=1 - no file watcher / HMR (e2e runs: edits made during a run don't reload the page)
const base = `/${(process.env.BASE_PATH ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./client/src', import.meta.url)) },
  },
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    ...(process.env.VITE_NO_WATCH ? { hmr: false, watch: null } : {}),
  },
  preview: {
    port: Number(process.env.PORT) || 4173,
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
});
