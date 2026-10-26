import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The server rejects foreign Host headers, hence changeOrigin. The app opens its WebSocket on
// location.host, so in dev it goes through this same proxy.
const backend = { target: 'http://127.0.0.1:4780', changeOrigin: true };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(['/info', '/file', '/tree', '/complete', '/attach', '/sources', '/git-status'].map((p) => [p, backend])),
      '/ws': { ...backend, ws: true },
    },
  },
});
