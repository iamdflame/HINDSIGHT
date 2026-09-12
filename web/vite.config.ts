import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
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
    // /judge ships as its own document so any static host serves it without rewrites.
    rollupOptions: { input: { main: here('./index.html'), judge: here('./judge/index.html') } },
  },
  // deployments.json and CLAIMS.md live at the repo root and are the single source of truth,
  // shared by contracts, worker and this app. Allow reading them rather than duplicating them.
  server: { port: 5173, fs: { allow: ['..'] } },
});
