import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    /**
     * Pinned to 3020 because the backend's CORS allowlist names exactly this
     * origin. `strictPort` is the important half: without it Vite silently
     * moves to 3021 when 3020 is taken, and every API call then fails a CORS
     * preflight — a confusing browser-console error whose cause is a port
     * number. Failing to start is the better outcome, and widening
     * CORS_ORIGINS to make the error go away would be the wrong fix.
     */
    port: 3020,
    strictPort: true,
  },
  build: {
    // Named explicitly because turbo.json caches this path.
    outDir: 'dist',
    sourcemap: false,
  },
});
