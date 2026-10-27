import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

// The server rejects foreign Host headers, hence changeOrigin. The app opens its WebSocket on
// location.host, so in dev it goes through this same proxy.
const backend = { target: 'http://127.0.0.1:4780', changeOrigin: true };

/** How long a chunk of an earlier build stays in dist/assets. */
const KEEP_OLD_ASSETS_MS = 7 * 24 * 3600_000;

/**
 * Every window serves the one web/dist, and a page loaded before a rebuild still asks for its own lazy chunks (mermaid,
 * highlight.js languages) by their old hashed names. So a build does not empty dist/assets: the previous builds' files
 * stay, and only those older than KEEP_OLD_ASSETS_MS are pruned.
 */
function keepOldAssets(): Plugin {
  return {
    name: 'nota-bene:keep-old-assets',
    apply: 'build',
    writeBundle(opts, bundle) {
      const dir = path.join(opts.dir!, 'assets');
      const fresh = new Set(Object.keys(bundle).map((f) => path.join(opts.dir!, f)));
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { return; }
      const cutoff = Date.now() - KEEP_OLD_ASSETS_MS;
      for (const n of names) {
        const f = path.join(dir, n);
        if (!fresh.has(f) && fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f, { force: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), keepOldAssets()],
  build: { emptyOutDir: false },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(['/info', '/file', '/tree', '/complete', '/attach', '/sources', '/git-status', '/marks', '/sessions', '/restart-server', '/system', '/history'].map((p) => [p, backend])),
      '/ws': { ...backend, ws: true },
    },
  },
});
