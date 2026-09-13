import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // The Merkle rebuild runs in a module worker (lib/proof.worker.ts), which needs ES output to share chunks.
  worker: { format: 'es' },
  resolve: {
    alias: [
      // See src/shared/usc-sdk-interop.ts — same SDK object in dev and build; lib/ is not modified.
      { find: /^@gluwa\/usc-sdk$/, replacement: here('./src/shared/usc-sdk-interop.ts') },
    ],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    // Every route is its own document, so any static host serves it without rewrites and each
    // page loads only its own entry.
    rollupOptions: {
      input: {
        main: here('./index.html'),
        verify: here('./verify/index.html'),
        record: here('./record/index.html'),
        watch: here('./watch/index.html'),
        assess: here('./assess/index.html'),
        order: here('./order/index.html'),
        judge: here('./judge/index.html'),
        claims: here('./claims/index.html'),
        enshrine: here('./enshrine/index.html'),
        integrate: here('./integrate/index.html'),
        independence: here('./independence/index.html'),
      },
    },
  },
  // deployments.json and CLAIMS.md live at the repo root and are the single source of truth,
  // shared by contracts, worker and this app. Allow reading them rather than duplicating them.
  server: { port: 5173, fs: { allow: ['..'] } },
});
