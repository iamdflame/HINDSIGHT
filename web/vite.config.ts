import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The public hostname lives in one place, deployments.json, so moving to a custom domain is one edit:
// every page's og:url and og:image are filled from it at build time.
const SITE: string = JSON.parse(readFileSync(new URL('../deployments.json', import.meta.url), 'utf8')).site;

export default defineConfig({
  plugins: [react(), { name: 'hindsight-site', transformIndexHtml: (html) => html.replaceAll('%HINDSIGHT_SITE%', SITE) }],
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
        status: here('./status/index.html'),
        // Mandate: the product face of the same runtime, its own masthead and its own vocabulary.
        mandate: here('./mandate/index.html'),
        versus: here('./versus/index.html'),
        files: here('./files/index.html'),
        hunt: here('./hunt/index.html'),
        cover: here('./cover/index.html'),
        ceip: here('./ceip/index.html'),
        aella: here('./aella/index.html'),
        // The same Mandate page, served as a Telegram Mini App (the bridge script is the only difference).
        tg: here('./tg/index.html'),
      },
    },
  },
  // deployments.json and CLAIMS.md live at the repo root and are the single source of truth,
  // shared by contracts, worker and this app. Allow reading them rather than duplicating them.
  server: { port: 5173, fs: { allow: ['..'] } },
});
