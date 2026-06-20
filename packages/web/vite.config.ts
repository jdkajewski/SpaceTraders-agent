import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The galaxy API (Fastify) has no CORS plugin, so in dev we proxy the
// `/galaxy` (and Swagger `/docs`) routes to it rather than touching the API.
// Override the upstream with VITE_API_PROXY_TARGET when the API runs elsewhere.
const apiTarget = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  resolve: {
    alias: {
      // Consume @st/shared from source so the web app needs no prebuilt dist.
      '@st/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/galaxy': { target: apiTarget, changeOrigin: true },
      '/docs': { target: apiTarget, changeOrigin: true },
    },
  },
});
