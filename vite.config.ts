import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  // The trailing slash is load-bearing: a bare '/api' prefix also matches the web client's own
  // /api.ts module, and the proxied view answers it with the server's index.html — the strict MIME
  // check then kills the module graph and the dev app never mounts. Every endpoint is under /api/.
  server: { proxy: { '/api/': 'http://localhost:4747' } },
});
