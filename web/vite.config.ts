import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The app is a static bundle; everything it needs it reads from public RPCs at runtime.
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1600 },
  // deployments.json lives at the repo root and is the single source of truth for addresses,
  // shared by contracts, worker and this app. Allow reading it rather than duplicating it.
  server: { port: 5173, fs: { allow: ['..'] } },
});
