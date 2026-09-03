import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export default defineConfig(() => ({
  // Vite's root otherwise defaults to the caller's cwd, not this config
  // file's directory — pin it explicitly since scripts/build.mjs invokes
  // `vite build --config` from the repo root.
  root: here,
  // Built and served from /app/ so it can sit alongside the static landing
  // page in apps/web — see scripts/build.mjs, which builds this app into
  // dist/app/ after copying the landing page into dist/.
  base: '/app/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': here,
    },
  },
  server: {
    // Allow importing packages/domain (the shared calculation engine) from
    // outside this app's own directory during `vite dev`.
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: path.join(repoRoot, 'dist/app'),
    emptyOutDir: true,
  },
}));
